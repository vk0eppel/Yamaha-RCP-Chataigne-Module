/*
 * Plain-Node unit tests for the RCP protocol helpers.
 *
 * The module ships as a single Yam-RCP.js (Chataigne loads each script in
 * its own scope, so no separate lib file). To avoid a drifting copy, this test
 * extracts the code between the RCP-PROTOCOL-START / RCP-PROTOCOL-END markers in
 * Yam-RCP.js and evaluates it here, so we test exactly what ships.
 *
 * Run: node test/rcp.test.js
 */
var fs = require("fs");
var path = require("path");

var src = fs.readFileSync(path.join(__dirname, "..", "Yam-RCP.js"), "utf8");
var startMark = "RCP-PROTOCOL-START";
var endMark = "RCP-PROTOCOL-END";
var s = src.indexOf(startMark);
var e = src.indexOf(endMark);
if (s < 0 || e < 0) {
  console.error("FAIL: could not find protocol markers in Yam-RCP.js");
  process.exit(1);
}
// Start just after the START marker line; end at the END marker.
s = src.indexOf("\n", s) + 1;
var code = src.substring(s, e);

// Evaluate the extracted block; direct eval defines its vars/functions in this
// function-ish scope so they're callable below.
eval(code);

var failures = 0;
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), x = JSON.stringify(expected);
  if (a !== x) { failures++; console.error("FAIL: " + msg + "\n  expected " + x + "\n  got      " + a); }
  else console.log("ok: " + msg);
}

// dB scaling
eq(dbToRaw(0, -32768, 1000, 100), 0, "0 dB -> 0");
eq(dbToRaw(10, -32768, 1000, 100), 1000, "+10 dB -> 1000");
eq(dbToRaw(-6, -32768, 1000, 100), -600, "-6 dB -> -600");
eq(dbToRaw(20, -32768, 1000, 100), 1000, "clamps to max");
eq(dbToRaw(-138, -32768, 1000, 100), RCP_MINUS_INF, "-138 dB -> -inf sentinel");
eq(dbToRaw(-200, -32768, 1000, 100), RCP_MINUS_INF, "below floor -> -inf sentinel");
eq(rawToDb(-600, 100), -6, "-600 -> -6 dB");
eq(rawToDb(RCP_MINUS_INF, 100), RCP_DB_FLOOR, "-inf -> floor");

// building lines
eq(buildSet("MIXER:Current/InCh/Fader/Level", 0, 0, -600, false),
   "set MIXER:Current/InCh/Fader/Level 0 0 -600", "buildSet int");
eq(buildSet("MIXER:Current/InCh/Label/Name", 15, 0, "Kick In", true),
   'set MIXER:Current/InCh/Label/Name 15 0 "Kick In"', "buildSet quoted string");
eq(buildGet("MIXER:Current/InCh/Fader/On", 3, 0),
   "get MIXER:Current/InCh/Fader/On 3 0", "buildGet");
eq(quote('a "b" c'), '"a \\"b\\" c"', "quote escapes inner quotes");

// parsing replies
eq(parseLine("OK set MIXER:Current/InCh/Fader/Level 0 0 -600"),
   { status: "OK", action: "set", address: "MIXER:Current/InCh/Fader/Level", x: 0, y: 0, isString: false, raw: "OK set MIXER:Current/InCh/Fader/Level 0 0 -600", val: -600 },
   "parse numeric set reply");
eq(parseLine('NOTIFY set MIXER:Current/InCh/Label/Name 15 0 "Kick In"'),
   { status: "NOTIFY", action: "set", address: "MIXER:Current/InCh/Label/Name", x: 15, y: 0, isString: true, raw: 'NOTIFY set MIXER:Current/InCh/Label/Name 15 0 "Kick In"', val: "Kick In" },
   "parse quoted string notify with space");
eq(parseLine('OKm get MIXER:Current/InCh/Label/Color 2 0 "Blue"').val, "Blue", "parse OKm color value");
eq(parseLine('OK devinfo productname "CL5"'),
   { status: "OK", action: "devinfo", sub: "productname", val: "CL5", isString: true, raw: 'OK devinfo productname "CL5"' },
   "parse devinfo productname reply");
eq(parseLine('OK devstatus runmode "normal"').val, "normal", "parse devstatus runmode value");

// scene feedback
eq(parseLine('NOTIFY ssrecallt_ex MIXER:Lib/Scene "8.00"'),
   { status: "NOTIFY", action: "ssrecallt_ex", target: "MIXER:Lib/Scene", val: "8.00", isString: true, raw: 'NOTIFY ssrecallt_ex MIXER:Lib/Scene "8.00"' },
   "parse Rivage scene recall notify");
eq(parseLine('NOTIFY sscurrentt_ex MIXER:Lib/Scene "9.00"').val, "9.00", "parse current-scene value");
eq(parseLine("NOTIFY ssrecall_ex MIXER:Lib/Scene 5").val, "5", "parse CL/QL integer scene recall");
eq(parseLine("NOTIFY ssrecall_ex MIXER:Lib/Scene 5").isString, false, "integer scene is not a string");
eq(parseLine('OK ssinfot_ex MIXER:Lib/Scene "8.00" 7 "Blank" "" user').sceneName, "Blank", "parse scene-info name");
eq(parseLine('OK ssinfot_ex MIXER:Lib/Scene "8.00" 7 "Vocal Mix" "note" user').sceneComment, "note", "parse scene-info comment");
eq(parseLine("OK ssinfo_ex MIXER:Lib/Scene 5 5 \"Intro\" \"\" user").sceneName, "Intro", "parse CL/QL scene-info name");
eq(parseLine("random noise"), null, "non-reply -> null");
eq(parseLine(""), null, "empty -> null");
eq(parseLine("ERROR set Foo 0 0 0").status, "ERROR", "error status recognized");

// round-trip
var raw = dbToRaw(-6, -32768, 1000, 100);
eq(rawToDb(parseLine("NOTIFY set MIXER:Current/InCh/Fader/Level 4 0 " + raw).val, 100), -6, "round-trip -6 dB fader");

if (failures) { console.error("\n" + failures + " test(s) failed"); process.exit(1); }
else console.log("\nAll tests passed");
