/*
 * Yamaha RCP - Chataigne custom module.
 *
 * @author Victor Koeppel
 * 
 * SINGLE FILE ON PURPOSE. Chataigne loads each entry in module.json "scripts"
 * in its own isolated scope, so helpers in separate files are NOT visible here.
 * Everything the module needs lives in this one file.
 *
 * Chataigne's script engine is a restricted JS dialect:
 *   - NO try/catch      (use `x == undefined` null checks)
 *   - NO regex literals
 *   - NO `delete` operator
 *   - don't assume globals like isNaN
 *   - local.send() does NOT append the line delimiter (we add "\n")
 *   - getChild() logs a warning for a missing child (only call for known ones)
 *
 * Two-way: sends RCP commands to the console AND reflects console-side changes
 * (NOTIFY / OK get) back into Chataigne values.
 */

var DEBUG = false; // flip to true during bring-up to log every line in/out

// =========================================================================
// PARAMETER TABLE (CL/QL)
// Adapted from the community "CLQL Parameters" table (companion-module-yamaha-rcp).
// DM / Rivage later = add a sibling table object and select it by "Console Model".
//   scale: raw = value * scale (dB uses 100; raw -32768 == -inf)
//   Colours: the 8 named colours plus "Off" (uncolored), sent verbatim as quoted strings.
// =========================================================================

// Colour palettes, verified on the console editors. The wire value is the colour name,
// quoted; "Off" clears the colour on every model.
//   CL/QL  : 8 colours + Off.
//   DM3    : same 8-colour set as CL/QL (the DM3 OSC spec's 11-colour Table 3 is wrong
//            per the editor).
//   DM7    : 11 - the CL/QL set plus LtGreen & White.
//   Rivage : identical to DM7's 11-colour palette.
var CLQL_COLORS   = ["Blue", "Orange", "Yellow", "Purple", "Cyan", "Magenta", "Red", "Green", "Off"];
var DM3_COLORS    = ["Purple", "Magenta", "Red", "Orange", "Yellow", "Blue", "Cyan", "Green", "Off"];
var DM7_COLORS    = ["Blue", "Orange", "Yellow", "Purple", "Cyan", "Magenta", "Red", "Green", "LtGreen", "White", "Off"];
var RIVAGE_COLORS = DM7_COLORS;

// Channel groups. The fader groups share the same address shape
// (Fader/Level, Fader/On, Label/Name, Label/Color). The mute group is special:
// its On lives at .../<key>/On and it has no Level or Color. Level/On/Name/Color
// are handled identically for CL/QL and DM7 (DM7's "binary" name/color are just
// quoted strings/names on the wire). Channel COUNTS are per-model.
var CLQL_GROUPS = [
  { key: "InCh",       label: "Input Channels" },
  { key: "StInCh",     label: "Stereo In"      },
  { key: "Mix",        label: "Mix"            },
  { key: "Mtrx",       label: "Matrix"         },
  { key: "St",         label: "Stereo Main"    },
  { key: "DCA",        label: "DCA"            },
  { key: "MuteMaster", label: "Mute Groups", mute: true }
];

var DM7_GROUPS = [
  { key: "InCh",        label: "Input Channels" },
  { key: "Mix",         label: "Mix"            },
  { key: "Mtrx",        label: "Matrix"         },
  { key: "St",          label: "Stereo Main"    },
  { key: "DCA",         label: "DCA"            },
  { key: "MuteGrpCtrl", label: "Mute Groups", mute: true }
];

// DM3 has Stereo In (like CL/QL) but no DCA.
var DM3_GROUPS = [
  { key: "InCh",        label: "Input Channels" },
  { key: "StInCh",      label: "Stereo In"      },
  { key: "Mix",         label: "Mix"            },
  { key: "Mtrx",        label: "Matrix"         },
  { key: "St",          label: "Stereo Main"    },
  { key: "MuteGrpCtrl", label: "Mute Groups", mute: true }
];

// Rivage PM: large frame, string (not binary) name/color, no Stereo In group.
var RIVAGE_GROUPS = [
  { key: "InCh",       label: "Input Channels" },
  { key: "Mix",        label: "Mix"            },
  { key: "Mtrx",       label: "Matrix"         },
  { key: "St",         label: "Stereo Main"    },
  { key: "DCA",        label: "DCA"            },
  { key: "MuteMaster", label: "Mute Groups", mute: true }
];

// Per-model channel counts.
// CL/QL: from l-r-r/Yamaha-CLQL-Chataigne-Module models.json (Stereo In is the
// real 8, not the RCP table's max of 16), with CL1 InCh corrected to 48 per
// Yamaha's official Script Template command_list.pdf (CL1 0-47, CL3 0-63,
// CL5 0-71, QL1 0-31, QL5 0-63). DM7: from DM7 Parameters-2.txt.
var CLQL_MODELS = {
  CL1: { InCh: 48, StInCh: 8, Mix: 24, Mtrx: 8, St: 3, DCA: 16, MuteMaster: 8 },
  CL3: { InCh: 64, StInCh: 8, Mix: 24, Mtrx: 8, St: 3, DCA: 16, MuteMaster: 8 },
  CL5: { InCh: 72, StInCh: 8, Mix: 24, Mtrx: 8, St: 3, DCA: 16, MuteMaster: 8 },
  QL1: { InCh: 32, StInCh: 8, Mix: 16, Mtrx: 8, St: 3, DCA: 16, MuteMaster: 8 },
  QL5: { InCh: 64, StInCh: 8, Mix: 16, Mtrx: 8, St: 3, DCA: 16, MuteMaster: 8 }
};
var DM7_MODELS = {
  DM7:  { InCh: 120, Mix: 48, Mtrx: 12, St: 4, DCA: 24, MuteGrpCtrl: 12 },
  DM7C: { InCh: 72,  Mix: 48, Mtrx: 12, St: 4, DCA: 24, MuteGrpCtrl: 12 } // DM7 Compact
};
var DM3_MODELS = {
  DM3: { InCh: 16, StInCh: 2, Mix: 6, Mtrx: 2, St: 2, MuteGrpCtrl: 6 }
};
// Rivage capacity is set by the DSP engine, not the control surface, so the
// models are named by engine. PM3/PM5 run DSP-RX or DSP-RX-EX; PM10 runs DSP-R10;
// PM7 has its own integrated DSP (CSD-R7). St/DCA/Mute are constant per the table.
var RIVAGE_MODELS = {
  RX:   { InCh: 120, Mix: 48, Mtrx: 24, St: 4, DCA: 24, MuteMaster: 12 },
  RXEX: { InCh: 288, Mix: 72, Mtrx: 36, St: 4, DCA: 24, MuteMaster: 12 },
  R10:  { InCh: 144, Mix: 72, Mtrx: 36, St: 4, DCA: 24, MuteMaster: 12 },
  PM7:  { InCh: 144, Mix: 60, Mtrx: 36, St: 4, DCA: 24, MuteMaster: 12 }
};

// Build the parameter specs for a group from its address prefix.
function specsForGroup(g, colors) {
  if (g.mute) {
    return [
      { id: "on",   label: "On",   address: "MIXER:Current/" + g.key + "/On",        type: "int",    scale: 1, min: 0, max: 1 },
      { id: "name", label: "Name", address: "MIXER:Current/" + g.key + "/Label/Name", type: "string", scale: 1 }
    ];
  }
  return [
    { id: "level", label: "Level", address: "MIXER:Current/" + g.key + "/Fader/Level", type: "int",    scale: 100, min: -32768, max: 1000 },
    { id: "on",    label: "On",    address: "MIXER:Current/" + g.key + "/Fader/On",    type: "int",    scale: 1, min: 0, max: 1 },
    { id: "name",  label: "Name",  address: "MIXER:Current/" + g.key + "/Label/Name",  type: "string", scale: 1 },
    { id: "color", label: "Color", address: "MIXER:Current/" + g.key + "/Label/Color", type: "enum",   scale: 1, options: colors }
  ];
}
function attachSpecs(groups, colors) { for (var i = 0; i < groups.length; i++) groups[i].params = specsForGroup(groups[i], colors); }
attachSpecs(CLQL_GROUPS, CLQL_COLORS);
attachSpecs(DM7_GROUPS, DM7_COLORS);
attachSpecs(DM3_GROUPS, DM3_COLORS);      // DM3 uses the CL/QL 8-colour set (not DM7's)
attachSpecs(RIVAGE_GROUPS, RIVAGE_COLORS);

// Scene-recall descriptors (verbs/format differ per console, from Companion):
//   verb    "ssrecall_ex" (CL/QL, DM3) | "ssrecallt_ex" (DM7)
//   target  "MIXER:Lib/Scene" (CL/QL) | "bank" -> scene_a / scene_b (DM3, DM7)
//   quote   quote the scene value? (DM7 uses "N.MM" strings; others integers)
//   incBank append scene_a/b to RecallInc/Dec? (DM7 only)
var CLQL_SCENE   = { verb: "ssrecall_ex",  target: "MIXER:Lib/Scene", quote: false, incBank: false };
var DM7_SCENE    = { verb: "ssrecallt_ex", target: "bank",            quote: true,  incBank: true  };
var DM3_SCENE    = { verb: "ssrecall_ex",  target: "bank",            quote: false, incBank: false };
var RIVAGE_SCENE = { verb: "ssrecallt_ex", target: "MIXER:Lib/Scene", quote: true,  incBank: false };

var PARAM_TABLES = {
  clql:   { label: "CL / QL",   groups: CLQL_GROUPS,   models: CLQL_MODELS,   defaultModel: "CL5", scene: CLQL_SCENE,   colors: CLQL_COLORS },
  dm7:    { label: "DM7",       groups: DM7_GROUPS,    models: DM7_MODELS,    defaultModel: "DM7", scene: DM7_SCENE,    colors: DM7_COLORS },
  dm3:    { label: "DM3",       groups: DM3_GROUPS,    models: DM3_MODELS,    defaultModel: "DM3", scene: DM3_SCENE,    colors: DM3_COLORS },
  rivage: { label: "Rivage PM", groups: RIVAGE_GROUPS, models: RIVAGE_MODELS, defaultModel: "R10", scene: RIVAGE_SCENE, colors: RIVAGE_COLORS }
};

// Which parameter table each console model uses.
var MODEL_TABLE = {
  CL1: "clql", CL3: "clql", CL5: "clql", QL1: "clql", QL5: "clql",
  DM7: "dm7", DM7C: "dm7",
  DM3: "dm3",
  RX: "rivage", RXEX: "rivage", R10: "rivage", PM7: "rivage"
};

// =========================================================================
// RCP-PROTOCOL-START
// Pure helpers (no Chataigne API). Unit-tested by test/rcp.test.js, which
// extracts everything between the START/END markers and runs it in Node.
// Keep this block free of `local`, `script`, etc.
// =========================================================================

var RCP_MINUS_INF = -32768; // raw sentinel for -inf on dB faders
var RCP_DB_FLOOR = -138.0;  // display floor we map -inf to (Chataigne Float)

// Round to nearest integer without Math or bitwise (restricted engine).
function roundInt(n) {
  if (n >= 0) return parseInt("" + (n + 0.5), 10);
  return -parseInt("" + (0.5 - n), 10);
}

// dB (float) -> raw integer for a param with the given scale (usually 100).
function dbToRaw(db, min, max, scale) {
  if (scale === 100 && db <= RCP_DB_FLOOR) return RCP_MINUS_INF;
  var raw = roundInt(db * scale);
  if (raw < min) raw = min;
  if (raw > max) raw = max;
  return raw;
}

// raw integer -> dB (float). -inf becomes RCP_DB_FLOOR for display.
function rawToDb(raw, scale) {
  if (scale === 100 && raw === RCP_MINUS_INF) return RCP_DB_FLOOR;
  return raw / scale;
}

// Double-quote and escape a string value for RCP (no regex literals).
function quote(str) {
  if (str === null || str === undefined) str = "";
  str = "" + str;
  var out = "";
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === "\\" || c === '"') out += "\\";
    out += c;
  }
  return '"' + out + '"';
}

// Trim leading/trailing whitespace and CR without regex.
function stripEnds(s) {
  s = "" + s;
  var a = 0, b = s.length;
  while (a < b) { var c = s.charAt(a); if (c === " " || c === "\t" || c === "\r" || c === "\n") a++; else break; }
  while (b > a) { var d = s.charAt(b - 1); if (d === " " || d === "\t" || d === "\r" || d === "\n") b--; else break; }
  return s.substring(a, b);
}

// Build a "set" line. `value` is already the raw wire value (int or string).
function buildSet(address, x, y, value, isString) {
  var v = isString ? quote(value) : ("" + value);
  return "set " + address + " " + x + " " + y + " " + v;
}

// Build a "get" line.
function buildGet(address, x, y) {
  return "get " + address + " " + x + " " + y;
}

// Split a line into tokens, honoring double-quoted substrings.
// Returns array of { value, quoted }.
function tokenize(line) {
  var tokens = [];
  var i = 0, n = line.length;
  while (i < n) {
    while (i < n && (line.charAt(i) === " " || line.charAt(i) === "\t")) i++;
    if (i >= n) break;
    if (line.charAt(i) === '"') {
      i++;
      var s = "";
      while (i < n) {
        var c = line.charAt(i);
        if (c === "\\" && i + 1 < n) { s += line.charAt(i + 1); i += 2; continue; }
        if (c === '"') { i++; break; }
        s += c; i++;
      }
      tokens.push({ value: s, quoted: true });
    } else {
      var start = i;
      while (i < n && line.charAt(i) !== " " && line.charAt(i) !== "\t") i++;
      tokens.push({ value: line.substring(start, i), quoted: false });
    }
  }
  return tokens;
}

// Parse one reply line into { status, action, address, x, y, val, isString, raw }
// or null if it isn't a value-bearing reply we understand.
function parseLine(line) {
  if (!line) return null;
  line = stripEnds(line);
  if (line.length === 0) return null;

  var tokens = tokenize(line);
  if (tokens.length === 0) return null;

  var status = tokens[0].value;
  if (status !== "OK" && status !== "OKm" && status !== "NOTIFY" && status !== "ERROR") return null;
  if (status === "ERROR") {
    return { status: status, action: null, address: null, x: 0, y: 0, val: null, isString: false, raw: line };
  }

  if (tokens.length < 6) return null;
  var action = tokens[1].value;
  var address = tokens[2].value;
  var x = parseInt(tokens[3].value, 10);
  var y = parseInt(tokens[4].value, 10);
  if (x != x) x = 0; // NaN self-inequality (avoids isNaN dependency)
  if (y != y) y = 0;
  var last = tokens[tokens.length - 1];

  var out = {
    status: status, action: action, address: address,
    x: x, y: y, isString: last.quoted, raw: line
  };
  out.val = last.quoted ? last.value : parseInt(last.value, 10);
  return out;
}

// =========================================================================
// RCP-PROTOCOL-END
// =========================================================================

// ---- module state --------------------------------------------------------

var currentTable = null;   // PARAM_TABLES entry in use
var valueByAddrX = {};     // "address#x" -> { param, spec, x, synced }  (incoming)
var revByKey = {};         // "groupName|chName|label" -> { spec, x }    (outgoing)
var locked = false;        // guard: don't echo network updates back out
var built = false;         // group containers created yet?
var builtTableKey = null;  // which table (family) the tree was built for
var groupContainers = {};  // groupKey -> Chataigne container
var groupCounts = {};      // groupKey -> channels currently in the tree

// ---- lifecycle -----------------------------------------------------------

function init() {
  buildValues();
}

// Resize the value tree when the console model changes.
function moduleParameterChanged(param) {
  if (param.isParameter() && param.name == "consoleModel") buildValues();
}

// ---- value tree ----------------------------------------------------------

// Group containers (and Scene) are created once, in order, so Scene stays last.
// On each call we grow/shrink each group's channel count to match the model -
// this handles the initial build AND live model changes without a teardown.
function buildValues() {
  locked = true; // adding params must not trigger outgoing sets

  var modelKey = readModuleParam("consoleModel", "CL5");
  var tableKey = MODEL_TABLE[modelKey];
  if (tableKey == undefined) tableKey = "clql";

  // Switching console families (CL/QL <-> DM7) has a different group set, so
  // tear the tree down and rebuild it fresh. Same-family model changes just
  // resize channel counts below.
  if (built && tableKey != builtTableKey) teardownTree();

  currentTable = PARAM_TABLES[tableKey];
  builtTableKey = tableKey;
  var model = currentTable.models[modelKey];
  if (model == undefined) model = currentTable.models[currentTable.defaultModel];

  var groups = currentTable.groups;
  if (!built) {
    valueByAddrX = {};
    revByKey = {};
    for (var gi = 0; gi < groups.length; gi++) {
      var gCont = local.values.addContainer(groups[gi].label);
      gCont.setCollapsed(true); // groups collapsed by default (tidy tree)
      groupContainers[groups[gi].key] = gCont;
      groupCounts[groups[gi].key] = 0;
    }
    var scene = local.values.addContainer("Scene");
    scene.addIntParameter("Current", "Last recalled scene", 0, 0, 300);
    built = true;
  }

  for (var gj = 0; gj < groups.length; gj++) setGroupCount(groups[gj], model[groups[gj].key]);

  script.log("Yamaha RCP: model " + modelKey + " (" + currentTable.label + ")");
  locked = false;
}

// Remove the whole value tree (used when switching console families).
// Remove by the stored container reference (not the label): a container's
// sanitized .name can differ from its label, so removeContainer(label) is not
// guaranteed to match.
function teardownTree() {
  var oldGroups = PARAM_TABLES[builtTableKey].groups;
  for (var i = 0; i < oldGroups.length; i++) {
    var cont = groupContainers[oldGroups[i].key];
    if (cont != undefined) local.values.removeContainer(cont);
  }
  var scene = local.values.getChild("Scene");
  if (scene != undefined) local.values.removeContainer(scene);
  built = false;
  groupContainers = {};
  groupCounts = {};
  valueByAddrX = {};
  revByKey = {};
}

// Grow or shrink one group's channel sub-containers to `target`.
function setGroupCount(g, target) {
  var cur = groupCounts[g.key];
  var cont = groupContainers[g.key];
  if (target > cur) {
    for (var ch = cur; ch < target; ch++) addChannel(g, cont, ch);
  } else if (target < cur) {
    for (var ch2 = target; ch2 < cur; ch2++) removeChannel(g, cont, ch2);
  }
  groupCounts[g.key] = target;
}

function addChannel(g, cont, ch) {
  var gName = cont.name;
  var chCont = cont.addContainer(pad2(ch + 1));
  chCont.setCollapsed(true); // channels collapsed by default too
  var chName = chCont.name;
  for (var p = 0; p < g.params.length; p++) {
    var spec = g.params[p];
    var param = addChannelParam(chCont, spec);
    // valueByAddrX: incoming NOTIFY/OK (keyed by wire address + channel index).
    valueByAddrX[spec.address + "#" + ch] = { param: param, spec: spec, x: ch, synced: undefined };
    // revByKey: outgoing user edits, keyed by the value's place in the tree.
    revByKey[gName + "|" + chName + "|" + param.niceName] = { spec: spec, x: ch };
  }
}

function removeChannel(g, cont, ch) {
  var chName = pad2(ch + 1);
  for (var p = 0; p < g.params.length; p++) {
    valueByAddrX[g.params[p].address + "#" + ch] = undefined;
    revByKey[cont.name + "|" + chName + "|" + g.params[p].label] = undefined;
  }
  cont.removeContainer(chName);
}

function addChannelParam(container, spec) {
  if (spec.id == "level") {
    return container.addFloatParameter(spec.label, spec.address, 0, RCP_DB_FLOOR, spec.max / spec.scale);
  }
  if (spec.id == "on") {
    return container.addBoolParameter(spec.label, spec.address, true);
  }
  // name / color are exposed as strings (enum values are just their names)
  return container.addStringParameter(spec.label, spec.address, "");
}

// ---- sending / subscribing ----------------------------------------------

// The "Lines" protocol does NOT append the delimiter, so we add "\n".
function sendLine(line) {
  if (DEBUG) script.log(">> " + line);
  local.send(line + "\n");
}

// Prime all modeled values and (re)establish notifications.
function syncAll() {
  subscribeAll();
  var groups = currentTable.groups;
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    var n = groupCounts[g.key];
    for (var p = 0; p < g.params.length; p++) {
      for (var ch = 0; ch < n; ch++) sendLine(buildGet(g.params[p].address, ch, 0));
    }
  }
}

/*
 * VERIFY ON HARDWARE: CL/QL is assumed to push NOTIFY for every change on any
 * open RCP session, so no explicit subscribe line is sent (the get()s in
 * syncAll prime initial state). If your desk needs an explicit subscribe, add
 * it here - this is the single place to change.
 */
function subscribeAll() {
  // intentionally empty for the auto-notify assumption
}

// ---- command callbacks (see module.json) --------------------------------

function cmdSetFaderLevel(group, channel, levelDb) {
  var spec = groupParamSpec(group, "level");
  if (spec == undefined) return;
  sendLine(buildSet(spec.address, channel - 1, 0, dbToRaw(levelDb, spec.min, spec.max, spec.scale), false));
}

function cmdSetChannelOn(group, channel, on) {
  var spec = groupParamSpec(group, "on");
  if (spec == undefined) return;
  sendLine(buildSet(spec.address, channel - 1, 0, on ? 1 : 0, false));
}

function cmdSetChannelName(group, channel, name) {
  var spec = groupParamSpec(group, "name");
  if (spec == undefined) return;
  sendLine(buildSet(spec.address, channel - 1, 0, name, true));
}

function cmdSetChannelColor(group, channel, color) {
  var spec = groupParamSpec(group, "color");
  if (spec == undefined) return;
  // The command enum is static (it lists every model's colours). Skip colours
  // the active console doesn't have, else the desk answers ERROR.
  if (!contains(currentTable.colors, color)) {
    script.logWarning("Yamaha RCP: colour '" + color + "' not valid for " + currentTable.label + " - ignored");
    return;
  }
  sendLine(buildSet(spec.address, channel - 1, 0, color, true));
}

// Scene commands use console-specific verbs/targets (see the scene descriptors).
//   CL/QL : ssrecall_ex MIXER:Lib/Scene <n>   ; event MIXER:Lib/Scene/RecallInc
//   DM3   : ssrecall_ex scene_a <n>           ; event MIXER:Lib/Scene/RecallInc
//   DM7   : ssrecallt_ex scene_a "<N.MM>"     ; event MIXER:Lib/Scene/RecallInc scene_a
// `bank` is "A"/"B" and only applies to the DM consoles' two scene lists.
function sceneBank(bank) { return "scene_" + (bank == "B" ? "b" : "a"); }

function cmdRecallScene(scene, bank) {
  var s = currentTable.scene;
  var target = (s.target == "bank") ? sceneBank(bank) : s.target;
  var val = s.quote ? quote("" + scene) : ("" + scene);
  sendLine(s.verb + " " + target + " " + val);
}

function cmdSceneInc(bank) {
  var s = currentTable.scene;
  sendLine("event MIXER:Lib/Scene/RecallInc" + (s.incBank ? (" " + sceneBank(bank)) : ""));
}

function cmdSceneDec(bank) {
  var s = currentTable.scene;
  sendLine("event MIXER:Lib/Scene/RecallDec" + (s.incBank ? (" " + sceneBank(bank)) : ""));
}

function cmdGenericSet(address, x, y, value, quoteValue) {
  sendLine(buildSet(address, x, y, value, quoteValue));
}

function cmdGenericGet(address, x, y) {
  sendLine(buildGet(address, x, y));
}

function cmdSyncNow() {
  syncAll();
}

// ---- receiving -----------------------------------------------------------

// Chataigne calls this for each incoming line (Lines protocol).
function dataReceived(data) {
  if (DEBUG) script.log("<< " + data);
  var msg = parseLine(data);
  if (msg == null) return;
  if (msg.status == "ERROR") {
    script.logWarning("Yamaha RCP error: " + msg.raw);
    return;
  }
  applyIncoming(msg);
}

function applyIncoming(msg) {
  var entry = valueByAddrX[msg.address + "#" + msg.x];
  if (entry != undefined) {
    var spec = entry.spec;
    var v;
    if (spec.id == "level") v = rawToDb(msg.val, spec.scale);
    else if (spec.id == "on") v = (msg.val == 1);
    else v = msg.val; // name / color strings
    // Record the console's value BEFORE applying it, so the value change it
    // triggers (which may fire asynchronously) is recognised as an echo.
    entry.synced = msg.val;
    setGuarded(entry.param, v);
  }
}

function setGuarded(param, value) {
  locked = true;
  param.set(value);
  locked = false;
}

// ---- reverse sync: user edits a value ------------------------------------

function moduleValueChanged(value) {
  if (locked) return;
  if (!value.isParameter()) return;

  // Locate the value in the tree: value -> channel container -> group container.
  var parent = value.getParent();
  if (parent == undefined) return;
  var grand = parent.getParent();
  if (grand == undefined) return;

  var meta = revByKey[grand.name + "|" + parent.name + "|" + value.niceName];
  if (meta == undefined) return; // not a channel value (e.g. Scene/Current)

  var spec = meta.spec;
  var x = meta.x;
  var wire = wireValueOf(spec, value);

  var entry = valueByAddrX[spec.address + "#" + x];

  // Echo suppression: `entry.synced` tracks the value currently in sync with the
  // console. If this change already matches it, the change came FROM the console
  // (applyIncoming set `synced` just before triggering it, even if the callback
  // fires asynchronously/coalesced) - don't bounce it back. A genuine user change
  // differs from `synced`, so it's sent and becomes the new synced value.
  // NB: compare stringified values only - do NOT add `entry.synced != undefined`,
  // as this engine treats `0 != undefined` as false (it coerces undefined to 0).
  // An unset `synced` stringifies to "undefined", which won't match a wire value.
  if (entry != undefined && ("" + entry.synced) == ("" + wire)) {
    return;
  }
  if (entry != undefined) entry.synced = wire; // we're pushing this; console will hold it

  sendLine(buildSet(spec.address, x, 0, wire, isStringSpec(spec)));
}

// The RCP wire value for a given value parameter (raw int or string).
function wireValueOf(spec, value) {
  if (spec.id == "level") return dbToRaw(value.get(), spec.min, spec.max, spec.scale);
  if (spec.id == "on") return value.get() ? 1 : 0;
  return value.get();
}

function isStringSpec(spec) {
  return spec.type == "string" || spec.type == "enum";
}

// ---- helpers -------------------------------------------------------------

// Find a group's param spec by group key + param id, or undefined.
function groupParamSpec(groupKey, id) {
  var groups = currentTable.groups;
  for (var gi = 0; gi < groups.length; gi++) {
    if (groups[gi].key == groupKey) {
      var ps = groups[gi].params;
      for (var p = 0; p < ps.length; p++) if (ps[p].id == id) return ps[p];
    }
  }
  return undefined;
}

// Read a module parameter by its sanitized name, with a fallback default.
function readModuleParam(name, fallback) {
  var p = local.parameters.getChild(name);
  if (p == undefined) return fallback;
  return p.get();
}

// 2-character zero-padded string from an integer (matches value tree naming).
function pad2(n) {
  return (n < 10) ? ("0" + n) : ("" + n);
}

// True if `arr` contains `val` (no Array.indexOf assumption in the engine).
function contains(arr, val) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === val) return true;
  return false;
}
