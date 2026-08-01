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
| DM7 / DM3    | ✅ DM7, DM7 Compact, DM3 (unverified on hardware — see Known items) |
| Rivage PM    | ✅ PM (unverified on hardware — see Known items) |

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
  | CSD-R7 | 144 | 60 | 24 | PM7 |

  The DSP-RX-EX tree is large (~1600 values) — it takes a moment to build and makes
  Sync Now heavy.

Level / On / Name / Color use the same wire format across all models (DM name/color
`binary` values are quoted strings/names). Only scene recall varies, per the table above.

## Install

Copy this folder into your Chataigne modules directory:

```
<Documents>/Chataigne/modules/Yamaha-RCP-Chataigne-Module/
```

Then in Chataigne: add the **Yamaha RCP** module, set the connection **remote host**
to your console's IP (port defaults to `49280`), and pick your **Console Model**
(**CL1 / CL3 / CL5 / QL1 / QL5**). The channel-group tree is sized to that desk
automatically (e.g. QL1 = 32 input channels + 16 mix buses; CL5 = 72 + 24) and
resizes live if you change the model.

After editing the module files, use *File → Reload custom modules* (you may need to
delete and re-add the module instance).

## Commands

Each channel command takes a **Group** selector (Input Channels, Stereo In, Mix,
Matrix, Stereo Main, DCA — plus Mute Groups for On/Name) and a 1-based channel.

| Command | Notes |
|---|---|
| Set Fader Level | group, channel, level in dB (−138 = −∞, +10 max) |
| Set Channel On | group, channel, on/off |
| Set Channel Name | group, channel, string |
| Set Channel Color | group, channel, one of 8 colors + Off |
| Recall Scene / Scene Inc / Scene Dec | scene number 0–300 |
| Generic Set / Generic Get | raw RCP address + X/Y + value (escape hatch) |
| Sync Now | request all current values and (re)subscribe |

Feedback appears under **Values → `<group>` → NN** (e.g. `Input Channels → 01`,
`Mix → 03`, `DCA → 02`) with Level / On / Name / Color, plus **Values → Scene →
Current**.

## Offline testing (no console)

The `test/` folder lets you develop without hardware.

Unit-test the protocol helpers:

```
node test/rcp.test.js
```

Run the fake console and point the module's remote host at `127.0.0.1`:

```
node test/mock-console.js            # RCP on tcp/49280, control UI on :8080
```

The mock is a two-way test rig:

- It serves RCP (`get`/`set` → `OK`/`OKm`, `NOTIFY`) so you can watch the exact lines
  the module emits.
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
`moduleScript.js`.

> Note: the real Yamaha **CL/QL Editor cannot be used as a test target** — it speaks
> Yamaha's proprietary editor protocol on TCP **50000**, not RCP on 49280. RCP is served
> by the *console*; the Editor is just another client of it. To test against real
> hardware, point the module at the **console's** IP (the same one the Editor connects
> to when online).

## Known items to confirm on real hardware

These are isolated in the code so they're one-line fixes:

1. **NOTIFY subscription.** CL/QL is assumed to push change notifications on any
   open RCP session (so `subscribeAll()` in `moduleScript.js` is empty and we only
   prime state with `get`). If your desk needs an explicit subscribe, add it there.
   To learn the exact handshake, connect straight to the console and watch whether
   desk-side changes arrive as `NOTIFY` (set `DEBUG = true`); if not, Wireshark a
   known-good RCP client such as Bitfocus Companion talking to the console on
   port 49280. (Note: the CL/QL *Editor* won't help here - it uses the editor
   protocol on port 50000, not RCP.)
2. **Scene recall verbs.** Scene commands now use the forms the Bitfocus Companion
   module uses: CL/QL `ssrecall_ex MIXER:Lib/Scene <n>` and `event
   MIXER:Lib/Scene/RecallInc`; DM7 `ssrecallt_ex scene_a "<N.MM>"` and `event
   MIXER:Lib/Scene/RecallInc scene_a`. These are sourced from Companion but unverified
   here — confirm on a desk.
3. **DM7 / DM3 (whole models).** DM support is derived from the Companion source + the
   DM parameter tables but has **not** been tested on a DM console. Level/On/Name/Color
   reuse the same wire format as CL/QL (`binary` name/color are sent as quoted
   strings/names, exactly as Companion does). To verify:
   - **Scene recall** — DM7 `ssrecallt_ex scene_a "N.MM"`, DM3 `ssrecall_ex scene_a <n>`.
   - **DM7 palette** — 11 colours (…Green, **LtGreen**, **White**, Off); the wire
     spelling of LtGreen/White is from the editor display and unconfirmed.
   - **DM3 palette** — the DM series (DM3 & DM7) uses the 11-colour palette.
4. **Rivage PM (whole model).** Derived from the Rivage parameter table + Companion.
   Name/colour are `string` (names), scene recall is `ssrecallt_ex MIXER:Lib/Scene
   "N.MM"`. Unverified: the exact colour palette (assumed CL/QL's 9) and scene
   inc/dec (not in the parameter dump — the module still sends `event
   MIXER:Lib/Scene/RecallInc`, which may or may not work). Channel counts are the RCP
   maxima; a real system may expose fewer.

There is no scriptable connection-status flag exposed to modules, so the module
does not auto-sync on connect. **After connecting, run the `Sync Now` command**
to prime values from the console (it sends a `get` for every modeled parameter).

> Note: Chataigne's script engine is a restricted JS dialect. Avoid:
> `try/catch`, regex literals, the `delete` operator, and globals such as
> `isNaN`, `String()`, and `Math` (use `"" + x` to stringify and plain
> arithmetic/`parseInt` instead). Also: multi-file `scripts` do NOT share
> scope (keep everything in `moduleScript.js`); `local.send()` does not append
> the line delimiter (we add `"\n"`); and `getChild()` logs a warning for a
> missing child, so only call it for children you know exist.
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
