/*
 * Mock Yamaha console for offline testing (no desk, no dependencies).
 *
 *   node test/mock-console.js [rcpPort] [httpPort]   (defaults 49280 / 8080)
 *
 * Why: the real CL/QL Editor cannot stand in for a console here - it speaks
 * Yamaha's proprietary editor protocol on port 50000, NOT RCP on 49280. So to
 * test the Chataigne module's two-way sync without hardware, this mock:
 *
 *   - serves RCP over TCP (get/set, OK/OKm/NOTIFY/ERROR), and
 *   - lets you inject "desk-side" changes (as if someone touched the console)
 *     that get pushed to the connected module as NOTIFY - via a tiny web UI
 *     at http://localhost:8080 or a stdin REPL.
 *
 * Realistic console behaviour: a `set` from a client gets an `OK` back, and a
 * `NOTIFY` is sent to the OTHER clients (a desk does not notify the connection
 * that made the change). Flip NOTIFY_SENDER to true for the older echo-to-
 * sender behaviour. With it false, firing a module *command* will not update
 * the module's own value tree (this matches real hardware) - drive feedback
 * from the UI/REPL instead.
 */
var net = require("net");
var http = require("http");
var readline = require("readline");

var RCP_PORT = parseInt(process.argv[2], 10) || 49280;
var HTTP_PORT = parseInt(process.argv[3], 10) || 8080;
var UI_CHANNELS = 8;           // channels shown in the web UI
var NOTIFY_SENDER = false;     // true = also NOTIFY the client that sent the set

var MINUS_INF = -32768;        // raw fader value meaning -inf
var COLORS = ["Blue", "Orange", "Yellow", "Purple", "Cyan", "Magenta", "Red", "Green", "LtGreen", "White", "Off"];

var A_LEVEL = "MIXER:Current/InCh/Fader/Level";
var A_ON = "MIXER:Current/InCh/Fader/On";
var A_NAME = "MIXER:Current/InCh/Label/Name";
var A_COLOR = "MIXER:Current/InCh/Label/Color";
var A_SCENE = "MIXER:Lib/Scene/Recall";

// ---- state store ---------------------------------------------------------

var store = {}; // "addr#x#y" -> raw wire value (string form, quoted for strings)
var clients = []; // connected TCP sockets

function keyOf(addr, x, y) { return addr + "#" + x + "#" + y; }

function getVal(addr, x, y) {
  var k = keyOf(addr, x, y);
  if (store.hasOwnProperty(k)) return store[k];
  return defaultFor(addr, x);
}

function defaultFor(addr, x) {
  // suffix-based so every channel group (InCh, Mix, DCA, MuteMaster, ...) works
  if (/\/Fader\/Level$/.test(addr)) return "" + MINUS_INF;
  if (/\/On$/.test(addr)) return "1"; // Fader/On, MuteMaster/On, MuteGrpCtrl/On
  if (/\/Label\/Name$/.test(addr)) return '"ch ' + (parseInt(x, 10) + 1) + '"';
  if (/\/Label\/Color$/.test(addr)) return '"Blue"';
  return "0";
}

// Apply a change to the store and NOTIFY clients. `exceptSock` is skipped
// (used so a set's originator gets OK but not its own NOTIFY).
function applyChange(addr, x, y, rawVal, exceptSock) {
  store[keyOf(addr, x, y)] = rawVal;
  broadcast("NOTIFY set " + addr + " " + x + " " + y + " " + rawVal, exceptSock);
}

function broadcast(line, exceptSock) {
  for (var i = 0; i < clients.length; i++) {
    if (clients[i] !== exceptSock && !clients[i].destroyed) {
      clients[i].write(line + "\n");
    }
  }
  console.log(">> (notify) " + line);
}

// ---- dB <-> raw (mirrors the module) -------------------------------------

function dbToRaw(db) {
  if (db <= -138) return MINUS_INF;
  var n = db * 100;
  return (n >= 0) ? Math.round(n) : -Math.round(-n);
}
function rawToDb(raw) {
  raw = parseInt(raw, 10);
  if (raw === MINUS_INF) return -138;
  return raw / 100;
}

// ---- RCP TCP server ------------------------------------------------------

function tokenize(line) {
  var out = [], i = 0, n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    if (line[i] === '"') {
      i++; var s = '"';
      while (i < n && line[i] !== '"') { s += line[i]; i++; }
      s += '"'; i++;
      out.push(s);
    } else {
      var start = i;
      while (i < n && !/\s/.test(line[i])) i++;
      out.push(line.substring(start, i));
    }
  }
  return out;
}

function handleLine(sock, line) {
  console.log("<< " + line);
  var t = tokenize(line);
  var cmd = t[0], addr = t[1], x = t[2], y = t[3];

  if (cmd === "get" && addr) {
    reply(sock, "OKm get " + addr + " " + x + " " + y + " " + getVal(addr, x, y));
    return;
  }
  if (cmd === "set" && addr) {
    var val = t.slice(4).join(" ");
    store[keyOf(addr, x, y)] = val;
    reply(sock, "OK set " + addr + " " + x + " " + y + " " + val);
    broadcast("NOTIFY set " + addr + " " + x + " " + y + " " + val, NOTIFY_SENDER ? null : sock);
    return;
  }
  reply(sock, "ERROR " + line);
}

function reply(sock, line) {
  console.log(">> " + line);
  sock.write(line + "\n");
}

var tcpServer = net.createServer(function (sock) {
  clients.push(sock);
  console.log("client connected: " + sock.remoteAddress + ":" + sock.remotePort +
              "  (" + clients.length + " total)");
  var buf = "";
  sock.on("data", function (chunk) {
    buf += chunk.toString("utf8");
    var idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      var line = buf.substring(0, idx).replace(/\r$/, "");
      buf = buf.substring(idx + 1);
      if (line.length) handleLine(sock, line);
    }
  });
  sock.on("error", function (e) { console.log("socket error: " + e.message); });
  sock.on("close", function () {
    var i = clients.indexOf(sock);
    if (i >= 0) clients.splice(i, 1);
    console.log("client disconnected  (" + clients.length + " total)");
  });
});

// ---- desk-side injection helpers (used by UI + REPL) ---------------------

function injectFader(ch, db) { applyChange(A_LEVEL, ch - 1, 0, "" + dbToRaw(db), null); }
function injectOn(ch, on) { applyChange(A_ON, ch - 1, 0, on ? "1" : "0", null); }
function injectName(ch, name) { applyChange(A_NAME, ch - 1, 0, '"' + name + '"', null); }
function injectColor(ch, color) { applyChange(A_COLOR, ch - 1, 0, '"' + color + '"', null); }
function injectScene(n) { applyChange(A_SCENE, 0, 0, "" + n, null); }

// ---- HTTP control UI -----------------------------------------------------

function stripQuotes(s) {
  s = "" + s;
  if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') return s.substring(1, s.length - 1);
  return s;
}

function stateJson() {
  var chs = [];
  for (var ch = 1; ch <= UI_CHANNELS; ch++) {
    var x = ch - 1;
    chs.push({
      ch: ch,
      db: rawToDb(getVal(A_LEVEL, x, 0)),
      on: getVal(A_ON, x, 0) === "1",
      name: stripQuotes(getVal(A_NAME, x, 0)),
      color: stripQuotes(getVal(A_COLOR, x, 0))
    });
  }
  return JSON.stringify({ channels: chs, colors: COLORS });
}

function readBody(req, cb) {
  var b = "";
  req.on("data", function (d) { b += d; });
  req.on("end", function () { cb(b); });
}

var httpServer = http.createServer(function (req, res) {
  if (req.url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(stateJson());
    return;
  }
  if (req.url === "/change" && req.method === "POST") {
    readBody(req, function (body) {
      var p;
      try { p = JSON.parse(body); } catch (e) { p = null; }
      if (p) {
        if (p.type === "fader") injectFader(p.ch, p.value);
        else if (p.type === "on") injectOn(p.ch, p.value);
        else if (p.type === "name") injectName(p.ch, p.value);
        else if (p.type === "color") injectColor(p.ch, p.value);
        else if (p.type === "scene") injectScene(p.value);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});

var PAGE = [
"<!doctype html><html><head><meta charset='utf-8'><title>Mock Yamaha CL/QL</title>",
"<style>",
"body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#1a1c20;color:#e6e6e6;margin:0;padding:16px}",
"h1{font-size:16px;font-weight:600;margin:0 0 4px}.sub{color:#8a8f98;font-size:12px;margin-bottom:16px}",
".grid{display:flex;flex-wrap:wrap;gap:10px}",
".ch{background:#24272e;border:1px solid #31353d;border-radius:8px;padding:10px;width:150px}",
".ch h2{font-size:12px;margin:0 0 8px;color:#9aa0aa;font-weight:600}",
"input[type=range]{width:100%}.row{display:flex;align-items:center;justify-content:space-between;margin:6px 0;font-size:12px}",
"input[type=text]{width:96px;background:#15171b;border:1px solid #31353d;color:#e6e6e6;border-radius:4px;padding:3px}",
"select{background:#15171b;border:1px solid #31353d;color:#e6e6e6;border-radius:4px;padding:2px}",
".db{font-variant-numeric:tabular-nums;color:#7fd1ff}.dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-left:6px}",
"</style></head><body>",
"<h1>Mock Yamaha CL/QL console</h1>",
"<div class='sub'>Move a control here to simulate a desk-side change &rarr; the module receives a NOTIFY. Module changes appear here within ~1s.</div>",
"<div class='grid' id='grid'></div>",
"<script>",
"var COLMAP={Blue:'#3b82f6',Orange:'#f97316',Yellow:'#eab308',Purple:'#a855f7',Cyan:'#06b6d4',Magenta:'#d946ef',Red:'#ef4444',Green:'#22c55e'};",
"var st=null,dragging={};",
"function post(o){fetch('/change',{method:'POST',body:JSON.stringify(o)});}",
"function build(s){var g=document.getElementById('grid');g.innerHTML='';s.channels.forEach(function(c){",
"var d=document.createElement('div');d.className='ch';",
"var opts=s.colors.map(function(k){return \"<option\"+(k===c.color?' selected':'')+\">\"+k+\"</option>\";}).join('');",
"d.innerHTML=\"<h2>Ch \"+c.ch+\"</h2>\"+",
"\"<input type=range min=-138 max=10 step=0.5 value='\"+c.db+\"' id='f\"+c.ch+\"'>\"+",
"\"<div class=row><span>Level</span><span class=db id='d\"+c.ch+\"'>\"+c.db+\" dB</span></div>\"+",
"\"<div class=row><span>On</span><input type=checkbox id='o\"+c.ch+\"' \"+(c.on?'checked':'')+\"></div>\"+",
"\"<div class=row><span>Name</span><input type=text id='n\"+c.ch+\"' value='\"+c.name+\"'></div>\"+",
"\"<div class=row><span>Color</span><span><select id='c\"+c.ch+\"'>\"+opts+\"</select><span class=dot id='k\"+c.ch+\"' style='background:\"+(COLMAP[c.color]||'#888')+\"'></span></span></div>\";",
"g.appendChild(d);var ch=c.ch;",
"var f=d.querySelector('#f'+ch);f.oninput=function(){document.getElementById('d'+ch).textContent=f.value+' dB';dragging['f'+ch]=1;};",
"f.onchange=function(){post({type:'fader',ch:ch,value:parseFloat(f.value)});dragging['f'+ch]=0;};",
"d.querySelector('#o'+ch).onchange=function(e){post({type:'on',ch:ch,value:e.target.checked});};",
"d.querySelector('#n'+ch).onchange=function(e){post({type:'name',ch:ch,value:e.target.value});};",
"d.querySelector('#c'+ch).onchange=function(e){post({type:'color',ch:ch,value:e.target.value});document.getElementById('k'+ch).style.background=COLMAP[e.target.value]||'#888';};",
"});st=s;}",
"function refresh(s){s.channels.forEach(function(c){var ch=c.ch;",
"if(!dragging['f'+ch]){var f=document.getElementById('f'+ch);if(f&&document.activeElement!==f){f.value=c.db;document.getElementById('d'+ch).textContent=c.db+' dB';}}",
"var o=document.getElementById('o'+ch);if(o&&document.activeElement!==o)o.checked=c.on;",
"var n=document.getElementById('n'+ch);if(n&&document.activeElement!==n)n.value=c.name;",
"var cc=document.getElementById('c'+ch);if(cc&&document.activeElement!==cc){cc.value=c.color;document.getElementById('k'+ch).style.background=COLMAP[c.color]||'#888';}",
"});}",
"function poll(){fetch('/state').then(function(r){return r.json();}).then(function(s){if(!st)build(s);else refresh(s);});}",
"poll();setInterval(poll,1000);",
"</script></body></html>"
].join("\n");

// ---- stdin REPL ----------------------------------------------------------

function startRepl() {
  var rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
  rl.on("line", function (raw) {
    var t = raw.trim().split(/\s+/);
    var cmd = t[0];
    if (cmd === "fader") injectFader(parseInt(t[1], 10), parseFloat(t[2]));
    else if (cmd === "on") injectOn(parseInt(t[1], 10), t[2] === "1" || t[2] === "true");
    else if (cmd === "name") injectName(parseInt(t[1], 10), t.slice(2).join(" "));
    else if (cmd === "color") injectColor(parseInt(t[1], 10), t[2]);
    else if (cmd === "scene") injectScene(parseInt(t[1], 10));
    else if (cmd === "dump") console.log(JSON.stringify(store, null, 2));
    else if (cmd === "help") printHelp();
    else if (cmd.length) console.log("? unknown - type 'help'");
  });
}

function printHelp() {
  console.log([
    "desk-side injection commands:",
    "  fader <ch> <dB>     e.g. fader 1 -10   (-138 = -inf)",
    "  on <ch> <0|1>       e.g. on 1 0",
    "  name <ch> <text>    e.g. name 1 Kick In",
    "  color <ch> <name>   e.g. color 1 Red   (" + COLORS.join(", ") + ")",
    "  scene <n>           e.g. scene 5",
    "  dump                print the store",
    "  help                this list"
  ].join("\n"));
}

// ---- start ---------------------------------------------------------------

tcpServer.listen(RCP_PORT, function () {
  console.log("mock Yamaha console (RCP) listening on tcp/" + RCP_PORT);
});
httpServer.listen(HTTP_PORT, function () {
  console.log("control UI: http://localhost:" + HTTP_PORT + "   (" + UI_CHANNELS + " channels)");
  console.log("stdin REPL ready - type 'help'. NOTIFY_SENDER=" + NOTIFY_SENDER);
});
startRepl();
