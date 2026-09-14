/*
 * Behavioural tests for Yam-RCP.js — the end-to-end paths the pure-helper suite
 * (rcp.test.js) can't reach: scene tracking, the DM7 re-query chain, echo
 * suppression, and error quieting. These lock in the "Priority 3" field-test
 * fixes so they can't silently regress before we confirm them on a desk.
 *
 * How: the whole module is eval'd against a small Chataigne API shim (local /
 * script / value tree) so we drive the REAL dataReceived()/moduleValueChanged()
 * and assert on what gets sent and what the value tree holds. Wire lines used
 * here are the hardware-accurate shapes (see docs/dm7-rcp-parameters.md and the
 * dm7-rcp2.pcapng capture referenced in applyScene()).
 *
 * Run: node test/rcp.behavior.test.js
 */
var fs = require("fs");
var path = require("path");

var SRC = fs.readFileSync(path.join(__dirname, "..", "Yam-RCP.js"), "utf8");

var failures = 0, count = 0;
function ok(cond, msg) {
  count++;
  if (cond) console.log("ok: " + msg);
  else { failures++; console.error("FAIL: " + msg); }
}
function eq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected),
     msg + "  (expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual) + ")");
}

// ---------------------------------------------------------------------------
// A fresh module instance with a shimmed Chataigne runtime.
// ---------------------------------------------------------------------------
function makeModule(model) {
  var sent = [], warnings = [], logs = [];
  var MVC = null; // module's moduleValueChanged, wired after eval

  // --- Chataigne value/param shim ---
  function Param(niceName, type, val) {
    this.niceName = niceName; this.name = niceName; this._t = type; this._v = val; this._parent = null;
  }
  Param.prototype.set = function (v) { this._v = v; if (MVC) MVC(this); }; // param.set() fires the module callback, like Chataigne
  Param.prototype.get = function () { return this._v; };
  Param.prototype.getParent = function () { return this._parent; };
  Param.prototype.isParameter = function () { return true; };
  Param.prototype.setAttribute = function () {};

  function Container(name) { this.name = name; this.niceName = name; this._kids = {}; this._parent = null; }
  Container.prototype.setCollapsed = function () {};
  Container.prototype.isParameter = function () { return false; };
  Container.prototype.getParent = function () { return this._parent; };
  Container.prototype.getChild = function (n) { return this._kids[n]; };
  Container.prototype._add = function (k, child) { child._parent = this; this._kids[k] = child; return child; };
  Container.prototype.addContainer = function (label) { return this._add(label, new Container(label)); };
  Container.prototype.removeContainer = function (arg) {
    if (typeof arg === "string") { delete this._kids[arg]; return; }
    for (var k in this._kids) { if (this._kids[k] === arg) { delete this._kids[k]; return; } }
  };
  Container.prototype.addStringParameter = function (nm, d, def) { return this._add(nm, new Param(nm, "string", def == null ? "" : def)); };
  Container.prototype.addFloatParameter  = function (nm, d, def) { return this._add(nm, new Param(nm, "float", def)); };
  Container.prototype.addBoolParameter   = function (nm, d, def) { return this._add(nm, new Param(nm, "bool", !!def)); };
  Container.prototype.addIntParameter    = function (nm, d, def) { return this._add(nm, new Param(nm, "int", def)); };

  var moduleParams = {
    consoleModel: new Param("consoleModel", "enum", model),
    keepAliveInterval: new Param("keepAliveInterval", "int", 0)
  };
  var local = {
    values: new Container("root"),
    parameters: { getChild: function (n) { return moduleParams[n]; } },
    send: function (line) { sent.push(("" + line).replace(/\n+$/, "")); }
  };
  var script = {
    log: function (m) { logs.push("" + m); },
    logWarning: function (m) { warnings.push("" + m); },
    setUpdateRate: function () {}
  };
  var util = { getTime: function () { return 0; } };

  // eval the real module in this scope; its declarations become locals here.
  eval(SRC);
  MVC = moduleValueChanged;
  init(); // builds the value tree via the shim

  return {
    sent: sent, warnings: warnings, logs: logs,
    rx: function (line) { dataReceived(line); },
    mvc: function (p) { moduleValueChanged(p); },
    findVal: function (groupLabel, ch, label) {
      var g = local.values.getChild(groupLabel); if (!g) return null;
      var c = g.getChild(ch); if (!c) return null;
      return c.getChild(label);
    },
    scene: function (sub) { return local.values.getChild("Scene").getChild(sub); },
    clear: function () { sent.length = 0; warnings.length = 0; logs.length = 0; },
    sentHas: function (s) { for (var i = 0; i < sent.length; i++) if (sent[i].indexOf(s) >= 0) return true; return false; },
    sentSets: function () { var r = []; for (var i = 0; i < sent.length; i++) if (sent[i].indexOf("set ") === 0) r.push(sent[i]); return r; }
  };
}

// ===========================================================================
// Sanity: the tree builds for each family.
// ===========================================================================
(function () {
  var m = makeModule("CL5");
  ok(m.findVal("Input Channels", "01", "Level") != null, "CL5: tree has InCh 01 Level");
  ok(m.scene("Current") != null, "CL5: tree has Scene/Current");
  var d = makeModule("DM7");
  ok(d.findVal("Input Channels", "01", "HA Gain") != null, "DM7: tree has InCh 01 HA Gain");
})();

// ===========================================================================
// Priority 3.1 — Scene recall + Scene/Current tracks desk-side recalls (CL/QL).
// ===========================================================================
(function () {
  var m = makeModule("CL5");
  m.clear();
  m.rx("NOTIFY ssrecall_ex MIXER:Lib/Scene 5"); // desk recalled scene 5
  eq(m.scene("Current").get(), "5", "CL/QL: Scene/Current follows ssrecall NOTIFY");
  ok(m.sentHas("ssinfo_ex MIXER:Lib/Scene 5"), "CL/QL: recall chains a scene-name query (ssinfo_ex)");

  m.clear();
  m.rx("NOTIFY sscurrent_ex MIXER:Lib/Scene 7"); // desk reports current = 7
  eq(m.scene("Current").get(), "7", "CL/QL: Scene/Current follows sscurrent NOTIFY");
  ok(m.sentHas("get MIXER:Current/InCh/Fader/Level 0 0"),
     "CL/QL: a sscurrent NOTIFY re-reads the value tree (recall changed many values)");
})();

// ===========================================================================
// Priority 3.3 — CL/QL scene NAME fills from the ssinfo_ex reply.
// ===========================================================================
(function () {
  var m = makeModule("CL5");
  m.rx("NOTIFY ssrecall_ex MIXER:Lib/Scene 5");
  m.rx('OK ssinfo_ex MIXER:Lib/Scene 5 5 "Intro" "" user');
  eq(m.scene("Name").get(), "Intro", "CL/QL: Scene/Name fills from ssinfo_ex reply");
})();

// ===========================================================================
// Priority 3.1/3.2 — DM7 scene number + name via the re-query chain.
//
// Real DM7 pushes the current scene as a NON-t_ex verb carrying a 0-based INDEX
// (scene 1.00 -> 0), which is wrong for display and rejected by ssinfot_ex. The
// module must ignore the index, re-query sscurrentt_ex for the real "N.MM", then
// chain ssinfot_ex for the name. (dm7-rcp2.pcapng)
// ===========================================================================
(function () {
  var m = makeModule("DM7");

  // A quoted t_ex reply sets Current directly (no re-query needed).
  m.clear();
  m.rx('OK sscurrentt_ex scene_a "3.00"');
  eq(m.scene("Current").get(), "3.00", "DM7: quoted sscurrentt_ex sets Scene/Current directly");
  ok(m.sentHas('ssinfot_ex scene_a "3.00"'), "DM7: sets chain a t_ex name query");

  // The problematic spontaneous NOTIFY: non-t_ex verb, unquoted 0-based index.
  var d = makeModule("DM7");
  d.clear();
  d.rx("NOTIFY sscurrent_ex scene_a 0"); // index form (== scene 1.00)
  eq(d.scene("Current").get(), "", "DM7: the bogus index is NOT written to Scene/Current");
  ok(d.sentHas("sscurrentt_ex scene_a"), "DM7: index NOTIFY triggers a sscurrentt_ex re-query");
  ok(!d.sentHas('ssinfot_ex scene_a 0'), "DM7: does NOT query ssinfot with the bad index");

  // The re-query reply carries the real "N.MM" -> Current + a t_ex name query.
  d.clear();
  d.rx('OK sscurrentt_ex scene_a "1.00"');
  eq(d.scene("Current").get(), "1.00", "DM7: re-query reply sets Scene/Current to the real N.MM");
  ok(d.sentHas('ssinfot_ex scene_a "1.00"'), "DM7: real number chains a t_ex name query");

  // The name reply fills Scene/Name.
  d.rx('OK ssinfot_ex scene_a "1.00" 7 "Opening" "" user');
  eq(d.scene("Name").get(), "Opening", "DM7: Scene/Name fills from ssinfot_ex reply");
})();

// ===========================================================================
// Priority 3.4 — On-echo gone: an incoming change must NOT bounce a set back,
// but a genuine user edit MUST send.
// ===========================================================================
(function () {
  var m = makeModule("CL5");
  m.clear();
  // Desk turns Ch1 On off; note the decorative "OFF" label the real desk appends.
  m.rx('NOTIFY set MIXER:Current/InCh/Fader/On 0 0 0 "OFF"');
  eq(m.sentSets(), [], "On: incoming NOTIFY set is not echoed back (locked guard)");

  // Simulate the callback firing async/coalesced (locked already cleared): the
  // synced-value guard must still suppress it.
  m.clear();
  m.mvc(m.findVal("Input Channels", "01", "On"));
  eq(m.sentSets(), [], "On: async re-fire of the same value is suppressed (synced guard)");

  // A genuine user edit differs from synced -> it IS sent.
  m.clear();
  m.findVal("Input Channels", "01", "On").set(true);
  ok(m.sentHas("set MIXER:Current/InCh/Fader/On 0 0 1"), "On: a real user change is sent");

  // Same for a fader level (the original CL5 crash/echo line shape).
  var f = makeModule("CL5");
  f.clear();
  f.rx('NOTIFY set MIXER:Current/InCh/Fader/Level 0 0 -600 "-6.00"');
  eq(f.sentSets(), [], "Level: incoming NOTIFY set is not echoed back");
  f.clear();
  f.mvc(f.findVal("Input Channels", "01", "Level"));
  eq(f.sentSets(), [], "Level: async re-fire of the same value is suppressed");
})();

// ===========================================================================
// Priority 3.5 — InvalidArgument spam is quiet (DEBUG-only); real errors warn.
// ===========================================================================
(function () {
  var m = makeModule("DM7");
  m.clear();
  m.rx("ERROR get MIXER:Current/InCh/Port/HA/Gain 6 0 InvalidArgument");
  m.rx("ERROR get InvalidArgument");
  eq(m.warnings.length, 0, "InvalidArgument errors do not warn (expected bulk-poll noise)");

  m.rx("ERROR set MIXER:Current/Bogus 0 0 0");
  eq(m.warnings.length, 1, "a real error still surfaces as a warning");
  ok(m.warnings[0].indexOf("MIXER:Current/Bogus") >= 0, "the real error carries its raw line");
})();

if (failures) { console.error("\n" + failures + "/" + count + " behavioural test(s) failed"); process.exit(1); }
else console.log("\nAll " + count + " behavioural tests passed");
