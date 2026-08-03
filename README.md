# Yamaha RCP — Chataigne Module

A [Chataigne](https://benjamin.kuperberg.fr/chataigne) custom module to control
Yamaha digital consoles over the **Remote Control Protocol (RCP)** — a plain-text,
newline-delimited TCP protocol on **port 49280**.

- **Two-way:** sends commands to the desk *and* reflects console-side changes back
  into Chataigne values via `NOTIFY` messages.
- **Table-driven:** each console family is one parameter table, so support grows
  by adding a table rather than rewriting logic.

## Status

| Console      | Status                          |
|--------------|---------------------------------|
| CL / QL      | ✅ CL1 / CL3 / CL5 / QL1 / QL5    |
| DM7 / DM3    | ✅ DM7, DM7 Compact, DM3 — verified against the official Yamaha OSC specs (DM3 v1.0.0, DM7 v1.1.0) and desk editors; see Known items for what's still open |
| Rivage PM    | ✅ DSP-RX / DSP-RX-EX / DSP-R10 / CSD-R7 — verified against the Rivage PM OSC spec (v1.0.2) and editor; see Known items |

**Scope:** fader level, on/mute, name, and color across **all channel groups**,
plus scene recall (+ inc/dec) and generic `Get`/`Set`. Pick your **Console Model**
and the tree is sized to it:

- **CL/QL** (CL1/CL3/CL5/QL1/QL5): Input Channels, Stereo In, Mix, Matrix, Stereo
  Main, DCA, Mute Groups.
- **DM7 / DM7 Compact**: Input Channels (120 / 72), Mix (48), Matrix (12), Stereo
  Main (4), DCA (24), Mute Groups (12). Scene recall: `ssrecallt_ex scene_a/b "N.MM"`
  (Bank A/B, `N.MM` scene number like `1.00`).
- **DM3**: Input Channels (16), Stereo In (2), Mix (6), Matrix (2), Stereo Main (2),
  Mute Groups (6) — no DCA. Scene recall: `ssrecall_ex scene_a/b <n>` (Bank A/B,
  integer scene number).
- **Rivage PM**: sized by **DSP engine** (capacity is set by the engine, not the
  surface). Groups: Input Channels, Mix, Matrix, Stereo Main (4), DCA (24), Mute
  Groups (12) — no Stereo In. Name/color are strings (not binary). Scene recall:
  `ssrecallt_ex MIXER:Lib/Scene "N.MM"` (no bank). Pick the engine your desk runs:

  | Model (engine) | Inputs | Mix | Matrix | Used by |
  |---|---|---|---|---|
  | DSP-RX | 120 | 48 | 24 | PM3 / PM5 |
  | DSP-RX-EX | 288 | 72 | 36 | PM3 / PM5 |
  | DSP-R10 | 144 | 72 | 36 | PM10 |
  | CSD-R7 | 144 | 60 | 36 | PM7 |

  The DSP-RX-EX tree is large (~1600 values) — it takes a moment to build and makes
  Sync Now heavy.

Level / On / Name / Color use the same wire format across all models (DM name/color
`binary` values are sent as quoted strings/names, just like CL/QL). What varies is the
scene-recall verb (per the lists above) and the colour palette (colour name sent quoted;
`Off` clears the colour everywhere):

- **CL/QL**: Blue, Orange, Yellow, Purple, Cyan, Magenta, Red, Green, Off (9).
- **DM3**: the same 8-colour set as CL/QL, Off (9).
- **DM7**: the CL/QL set plus LtGreen & White → 11.
- **Rivage**: identical to DM7's 11-colour palette.

The single **Set Channel Color** command lists the union of all names; a desk ignores any
it doesn't recognise. The value tree is **collapsed by default**.

## Install

Copy this folder into your Chataigne modules directory:

```
<Documents>/Chataigne/modules/Yamaha-RCP-Chataigne-Module/
```

Then in Chataigne: add the **Yamaha RCP** module, set the connection **remote host**
to your console's IP (port defaults to `49280`), and pick your **Console Model** —
CL1/CL3/CL5/QL1/QL5, DM3, DM7, DM7 Compact, or a Rivage DSP engine (see Status). The
channel-group tree is sized to that desk automatically (e.g. QL1 = 32 input channels +
16 mix buses; CL5 = 72 + 24) and resizes live if you change the model.

After editing the module files, use *File → Reload custom modules* (you may need to
delete and re-add the module instance).

## Commands

Each channel command takes a **Group** selector (Input Channels, Stereo In, Mix,
Matrix, Stereo Main, DCA — plus Mute Groups for On/Name; not every group exists on
every model — an unsupported group/channel is simply ignored) and a 1-based channel.

| Command | Notes |
|---|---|
| Set Fader Level | group, channel, level in dB (−138 = −∞, +10 max) |
| Set Channel On | group, channel, on/off |
| Set Channel Name | group, channel, string |
| Set Channel Color | group, channel, colour name (per-model palette: CL/QL & DM3 = 9, DM7 & Rivage = 11) |
| Recall Scene | scene number (string) + Bank A/B; CL/QL & DM3 use an integer, DM7 & Rivage use `N.MM` |
| Scene Inc / Scene Dec | step the current scene up/down (+ Bank A/B for DM) |
| Generic Set / Generic Get | raw RCP address + X/Y + value (escape hatch) |
| Sync Now | request all current values from the console |

Feedback appears under **Values → `<group>` → NN** (e.g. `Input Channels → 01`,
`Mix → 03`, `DCA → 02`) with Level / On / Name / Color. **Values → Scene → Current**
reflects the desk's current scene (from `ssrecall`/`sscurrent` notifications — a string,
so `"8"` on CL/QL and `"8.00"` on DM7/Rivage); **Values → Device** shows the model the
console reports. (Scene *name* and inc/dec confirmation are still open — see below.)

## Offline testing (no console)

The `test/` folder lets you develop without hardware.

Unit-test the protocol helpers:

```
node test/rcp.test.js
```

Run the fake console and point the module's remote host at `127.0.0.1`:

```
node test/mock-console.js            # RCP on tcp/49280, control UI on :8080
MOCK_MODEL=DM7 node test/mock-console.js   # report a specific model (default CL5)
```

The mock is a two-way test rig:

- It serves RCP (`get`/`set` → `OK`/`OKm`, `NOTIFY`) so you can watch the exact lines
  the module emits.
- It answers the identity/session verbs a real desk does — `devinfo productname`
  (driven by `MOCK_MODEL`), `devinfo deviceid`/`devicename`/`serialno`/`version`,
  `devstatus runmode`, and `scpmode keepalive` — so RCP controllers (Companion, QLab,
  this module) recognise it as hardware and keep the connection open. It still does
  **not** emulate Yamaha's own apps (StageMix, Editor); those use the proprietary
  protocols noted below, not RCP.
- It lets you **simulate desk-side changes** — as if someone touched the console — which
  are pushed to the module as `NOTIFY`. Two ways:
  - **Web UI** at <http://localhost:8080>: move a fader / toggle On / edit Name / pick a
    Color and the connected module's values update live. Module-side changes are polled
    back into the UI (~1 s) so the loop is visible both directions.
  - **stdin REPL** in the mock's terminal: `fader 1 -10`, `on 1 0`, `name 1 Kick`,
    `color 1 Red`, `scene 5`, `dump`, `help`.

Realistic console behaviour: a `set` gets an `OK` back but the `NOTIFY` goes to the
*other* clients only (a desk doesn't notify the connection that made the change). So
firing a module *command* won't update the module's own value tree — drive feedback from
the UI/REPL. Flip `NOTIFY_SENDER = true` at the top of `test/mock-console.js` for the old
echo-to-sender behaviour.

To see line-by-line traffic inside Chataigne, set `DEBUG = true` at the top of
`Yam-RCP.js`.

> Note: the real Yamaha **Editor cannot be used as a test target** — it speaks
> Yamaha's proprietary editor protocol on TCP **50000**, not RCP on 49280, and finds
> consoles via its own UDP discovery. RCP is served by the *console*; the Editor is just
> another client of it. To test against real hardware, point the module at the
> **console's** IP (the same one the Editor connects to when online). See
> [`docs/yamaha-editor-protocol.md`](docs/yamaha-editor-protocol.md) for reconnaissance
> notes on the Editor's discovery (LNK multicast / SDP broadcast) and why the mock
> deliberately doesn't emulate it.

## Verified against the official OSC specs

DM3 / DM7 / Rivage were cross-checked against Yamaha's own OSC specifications (DM3
v1.0.0, DM7 v1.1.0, Rivage PM v1.0.2). OSC uses the **same `MIXER:Current/...` address
tree** as RCP, so the specs authoritatively confirm, for those models:

- **Addresses** — `Fader/Level`, `Fader/On`, `Label/Name`, `Label/Color`; mute is
  `MuteMaster/On` (CL/QL & Rivage) vs `MuteGrpCtrl/On` (DM).
- **Fader scaling** — integer, ×100, `-32768` = −∞, max `1000` (+10 dB).
- **Channel counts** — DM3, DM7/DM7 Compact, and all four Rivage DSP engines.
- **Scene recall** — DM3 `ssrecall_ex scene_a <0-99>`, DM7 `ssrecallt_ex scene_a
  "N.MM"` (1.00–499.99), Rivage `ssrecallt_ex MIXER:Lib/Scene "N.MM"`. The **Rivage**
  form is additionally **confirmed on real hardware** (DSP-RX-EX capture) — see
  [`docs/rivage-scene-protocol.md`](docs/rivage-scene-protocol.md), which also documents
  the scene *feedback* verbs (`sscurrentt_ex`, `ssupdatet_ex`, `ssinfot_ex`) not yet used
  by the module.
- **DM7 scene inc/dec** — `event MIXER:Lib/Scene/RecallInc scene_a` (with bank suffix).
- **Colour palettes** — confirmed on the DM7 / DM3 / Rivage editors (see the palettes
  above; DM7 and Rivage share the same 11-colour set, DM3 uses the CL/QL 8-colour set).
  Note the DM3 OSC spec's 11-colour Table 3 is *wrong* — the DM3 editor exposes only the
  CL/QL 8-colour set.

## Still to confirm on real hardware

These are isolated in the code so they're one-line fixes:

1. **NOTIFY subscription.** CL/QL is assumed to push change notifications on any
   open RCP session (so `subscribeAll()` in `Yam-RCP.js` is empty and we only
   prime state with `get`). The OSC specs don't help here — OSC is a separate
   transport and says nothing about RCP's push behaviour. If your desk needs an
   explicit subscribe, add it there. **Corroborated** by the Bitfocus Companion module,
   which likewise sends **no** subscribe command and just listens for `NOTIFY` — so an
   empty subscribe is expected to be correct; a hardware check would make it certain. To
   verify, connect straight to the console and watch whether desk-side changes arrive as
   `NOTIFY` (set `DEBUG = true`); if not, Wireshark Companion talking to the console on
   port 49280. (Note: the CL/QL *Editor* won't help — it uses the editor protocol on port
   50000, not RCP.)
2. **Scene inc/dec for DM3 & Rivage.** Neither the DM3 nor the Rivage OSC spec documents
   scene inc/dec (only DM7 does). The module still sends `event MIXER:Lib/Scene/RecallInc`
   / `RecallDec` for them (no bank suffix), which may or may not work — confirm on a desk.
   (Rivage scene *recall* is now hardware-confirmed — see the scene-recall bullet above —
   but this inc/dec path is still unverified.)
3. **CL/QL.** No Yamaha OSC spec was available for CL/QL, so its addresses, scene verbs
   (`ssrecall_ex MIXER:Lib/Scene <n>`), and 9-colour palette remain sourced from the
   Bitfocus Companion module rather than a first-party spec.
4. **`devinfo productname` wire format.** The **Device** container and the model-mismatch
   warning depend on the exact reply shape — `OK devinfo productname "CL5"` (prefix `OK`,
   verb echoed, value quoted). Capture a real desk's reply and confirm it matches
   `parseLine()` in `Yam-RCP.js` and the mock's `okQuoted()`.
5. **DM7C & Rivage product-name strings.** `PRODUCTNAME` in `test/mock-console.js` uses
   placeholders (`DM7C → "DM7"`, all Rivage engines → `"RIVAGE PM"`), and
   `EXPECTED_PRODUCT` in `Yam-RCP.js` deliberately **omits** DM7C/Rivage so no mismatch
   warning fires for them. Once seen on a desk, set the real strings and add the
   `EXPECTED_PRODUCT` entries.
6. **Other `devinfo` subcommands (low priority).** Whether real desks answer `deviceid`,
   `serialno`, and `version` — the module displays them; the mock returns constants.
7. **CL1 input count = 48 (low risk).** Corrected from Yamaha's Script Template
   `command_list.pdf` (CL1 range `0–47`); confident but not yet confirmed on a CL1.
8. **Scene re-sync on recall.** On a `sscurrent*` NOTIFY the module now re-`get`s the whole
   tree (a scene changes many values at once — mirrors Companion). Two assumptions to
   confirm on a desk: (a) whether the console withholds `sscurrent` from the client that
   *recalled* (if so, our own **Recall Scene** won't auto-refresh — a follow-up), and
   (b) whether `get`s issued right after a recall read settled (not mid-fade) values.

_See also_ [`docs/yamaha-editor-protocol.md`](docs/yamaha-editor-protocol.md) for the
Editor's discovery/control protocol — reconnaissance only, intentionally **not**
implemented, so not a module verification item.

There is no scriptable connection-status flag exposed to modules, so the module
does not auto-sync on connect. **After connecting, run the `Sync Now` command**
to prime values from the console (it sends a `get` for every modeled parameter).

> Note: Chataigne's script engine (JUCE's `JavascriptEngine`) is a restricted,
> ES5-ish dialect. Avoid: `try/catch`, regex literals, the `delete` operator,
> and globals such as `isNaN` and `String()` (use `"" + x` to stringify;
> `parseInt`/`parseFloat`/plain arithmetic are available).
>
> `Math` **is** available, but as JUCE's subset — not full ECMAScript. Present:
> `abs round floor ceil sqrt sqr pow exp log log10 min max sign hypot random`,
> `sin/asin cos/acos tan/atan` (+ `h` variants), `toDegrees/toRadians`, and the
> usual constants (`PI`, `E`, `SQRT2`, …). Gotchas: **no `Math.atan2`** (nor
> `trunc`/`cbrt`/`log2`), and `Math.min`/`Math.max` take **exactly two** args.
> (Verified against benkuper's JUCE fork, `modules/juce_core/javascript/juce_Javascript.cpp`.)
>
> On files: keep all *executable* module code in `Yam-RCP.js` — each entry in the
> `scripts` array runs in its own scope, so a second script can't see this one's
> functions. What you _can_ split out: large static data into a `.json` loaded at
> runtime via `util.readFile("foo.json", true, true)` (as the CL/QL reference
> module does for its parameter tables), and mapping/filter scripts — a standalone
> `filter(values, min, max)` file attached in the UI — which run in their own scope
> anyway (as the ADM-OSC module does). `local.send()` does not append the line
> delimiter (we add `"\n"`); and `getChild()` logs a warning for a missing child,
> so only call it for children you know exist.
>
> Landmine: the engine coerces `undefined` to `0` in loose comparisons, so
> `0 != undefined` is **false** and `0 == undefined` is **true**. Never write
> `someNumber != undefined` as a guard - compare stringified values instead
> (`("" + x) == ("" + y)`). This caused the fader/On echo bug during bring-up.
> `moduleValueChanged` can also fire asynchronously, so echo suppression must be
> value-based, not flag/timing-based.

## Credits / references

- Protocol addresses adapted from
  [bitfocus/companion-module-yamaha-rcp](https://github.com/bitfocus/companion-module-yamaha-rcp)
- [BrenekH/yamaha-rcp-docs](https://github.com/BrenekH/yamaha-rcp-docs)
- Built on the [Chataigne custom module](https://benjamin.kuperberg.fr/chataigne) system
