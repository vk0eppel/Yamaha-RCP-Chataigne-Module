# DM7 RCP/SCP parameters — from firmware

Extracted from **DM7 firmware V1.75** (`app_console_main`, ARM64) via Ghidra/
`strings`, 2026-08-05. First-party evidence for the DM7's RCP surface: the exact
parameter addresses, the command set, and the alternative YOSC (OSC) transport.
RCP = Yamaha Remote Control Protocol (internal name **SCP**).

> Provenance: static extraction from firmware, **not** a live-hardware capture.
> Addresses are the templates the desk accepts; RCP still needs the x/y indices
> (`get "<addr>" <x> <y>`). Sends (`ToMix`/`ToMtrx`) are 2-D (channel × bus).

> **Offline testing without a desk:** this repo already ships that harness —
> [`test/mock-console.js`](../test/mock-console.js) serves RCP over TCP 49280,
> answers `get`/`set` with `OK …`, replies to the identity/session verbs
> (`devinfo`, `devstatus`, `ssrecall(t)_ex`, `sscurrent…`), and emits `NOTIFY …`
> to the other clients, driven from a small web UI on :8080. The reply grammar
> the module's parser expects (`OK devinfo productname "…"`,
> `NOTIFY ssrecallt_ex MIXER:Lib/Scene "8.00"`, `OK get …`) is the mock's spec.
> The address surface below is the reference for extending that mock's store.

## Transport

- **TCP port 49280** (confirmed — the port literal is loaded once in the binary).
- Text protocol: `get "<addr>" <x> <y>` / `set "<addr>" <x> <y> <val>`;
  replies `OK <cmd> …`, unsolicited `NOTIFY <cmd> …`, errors `ERROR …`.
- DM7 scene verbs use the `T_EX` string variants (`ssrecallt_ex` on `bank`).

## Command set (45 verbs, `N3SCP::ScpServerCommand*`)

`APPLYUPDATE` `DEVINFO` `DEVMODE` `DEVSTATUS` `EVENT` `GET` `GETN` `GETT` `IDENTIFY` `INITIALIZE` `LISTITEM` `LISTITEMNUM` `MTRINFO` `MTRNUM` `MTRSTART` `MTRSTOP` `PRMINFO` `PRMNUM` `REBOOT` `SCPMODE` `SET` `SETN` `SETR` `SETT` `SSCURRENT` `SSCURRENT_EX` `SSCURRENTT_EX` `SSINFO` `SSINFO_EX` `SSINFOT_EX` `SSNUM` `SSNUM_EX` `SSRECALL` `SSRECALL_EX` `SSRECALLT_EX` `SSUPDATE` `SSUPDATE_EX` `SSUPDATET_EX` `TIMESYNC` `FOPENR` `FOPENW` `FREAD` `FWRITE` `FCLOSE` `FABORT`

## Decompiled server internals (Ghidra, 2026-08-06)

Beyond `strings`, the SCP server's C++ classes were decompiled from
`app_console_main` V1.75 (vtables resolved from Itanium RTTI type-names; scripts
`firmware/DecompScp.java` + `firmware/DecompVtbl.java` in the YamDeskEmu repo).
This upgrades several items from "assumed" to "firmware-verified":

- **Command set = dispatch classes**, not just strings: `N3SCP::ScpClientCommandFactory{DEVINFO,
  DEVMODE, DEVSTATUS, EVENT, GET, GETN, GETT, MTR, MTRINFO, MTRNUM, MTRSTART, MTRSTOP,
  PRMINFO, PRMNUM, SCPMODE, SET, SETN, SETR, SETT, SSCURRENT, SSCURRENT_EX, SSINFO_EX,
  SSNUM_EX, SSRECALL_EX, SSUPDATE_EX, LISTITEM, LISTITEMNUM, IDENTIFY}`.
- **No `SUBSCRIBE` on RCP** — the OSC server has one; the RCP server does not. An empty
  subscribe step is therefore correct; the desk pushes unsolicited `NOTIFY`.
- **NOTIFY is a first-class push path**: `N3SCP::ScpClientNotificationSET` / `…SETN` classes
  build `NOTIFY set …` on parameter change. (What the binary does *not* settle: whether the
  client that issued the `set` also receives its own `NOTIFY` — that lives in the
  SET-apply→observer subsystem, not the notification class.)
- **`devinfo` sub-key table** (from the handler's init): `protocolver, paramsetver, version,
  productname, manufacturer, serialno, category, deviceid, devicename, inputport, outputport,
  interface`. `devinfo` requests dispatch on the request byte — `0x20` (space) = one-shot
  read, `0x40` (`@`) = notify-request form.
- **GET reply is type-tagged with a Res/Mem pair**: the handler reads `addr`/`x`/`y`, then
  serializes each value as **string (`%s`, quoted)** or **integer (`%d`, bare)**, and carries
  both a *Res* (live) and *Mem* (scene-stored) value per `(x, y)`. This is why the parser
  must treat quoted-string vs bare-integer values distinctly; `productname` is a string type
  → returned quoted (`OK devinfo productname "DM7"`).

- **SET has separate reply-vs-notify code paths.** The incoming-`set` handler
  (`ScpClientCommandSET`) has two distinct methods, chosen by a request-marker/flag bit
  (mirroring GET's `0x20`-reply / `0x80`-notify split): one applies the value and **replies to
  the sender**, the other is the **NOTIFY** path (logs a typo'd `[NOFITY SET]`, which is why a
  `[NOTIFY SET]` string search comes up empty). So the desk does *not* echo-to-all from one
  path — sender-reply and observer-NOTIFY are separate. NOTIFYs are dispatched **per session**,
  each gated on the session being fully synchronized (state ≥ 2). The explicit
  "skip the originating session" test sits in a virtual observer callback that static
  decompilation can't isolate, but the split strongly implies the originator gets its `OK`
  reply and *other* sessions get `NOTIFY` (standard SCP behaviour). Practically moot for this
  module, which suppresses its own echoes by value regardless.
- **SET wire field schema** (from the command's field template): `result, address, x, y, param`
  — i.e. `set "<addr>" <x> <y> <val>`.

Still needing a live desk (not recoverable from static code): the exact quote bytes emitted
by the low-level response serializer, and the definitive originator-exclusion on NOTIFY.

### `scpmode` — per-connection session options

`scpmode <key> <value>` tunes how *this* RCP session behaves (decompiled from
`ScpClientCommandSCPMODE` / `FUN_017e6890`; the desk echoes `OK scpmode <key> <value>`):

| Command | Values | Effect |
|---|---|---|
| `scpmode keepalive <ms>` | int **≥ 1000** | Idle-timeout window; the server drops the connection if it sees no traffic within it (firmware `KEEPALIVE_TIMEOUT(%dmsec)`). Stores **half** the value internally (expected ping interval). |
| `scpmode format` | `raw` \| `json` | Reply/body format — plain RCP text vs JSON. |
| `scpmode encoding` | `ascii` \| `utf8` | String encoding for text values. |
| `scpmode valuetype` | `raw` \| `normalized` | Values as raw/absolute ints vs normalized 0–1. |
| `scpmode resolution <n>` | int **≥ 100** | Numeric value resolution. |

Only `keepalive` matters to this module (stops the desk closing an idle socket, which would
kill NOTIFY feedback). Note: the Bitfocus Companion module sends `scpmode sstype "text"`, but
**`sstype` is not a DM7 key** — it errors on a DM7 (which uses text `"N.MM"` scenes by default),
so don't copy it.

### Scene / snapshot argument syntax

From the firmware's built-in debug CLI — shows the argument shapes (`[category]`,
`[index]`, `[ssno]`) behind the scene verbs. The `_scp`/`_acn`/`_rio` forms are the
DM7's **internal** session/rack commands (not the public RCP wire form), included
for the argument semantics.

```
sscurrent [category]        : Get the current scene number of [category]/[index].
ssnum     [category]        : Get the number of scenes in [category].
ssinfo    [category] [index]: Get the scene information of [category]/[index].
ssrecall  [category] [index]: Recall the scene of [category]/[index].
ssupdate  [category] [index]: Store the scene of [category]/[index].
-- internal session/rack forms (not public RCP) --
get_scp  [no] [id] [x] [y]        : Get param [id] (x,y) from session [no].
set_scp  [no] [id] [x] [y] [val]  : Set [val] for param [id] (x,y) in session [no] (direct).
setc_scp [no] [id] [x] [y] [val]  : Set [val] for param [id] (x,y) in session [no] (via cache).
get_rio/set_rio [no] [id] [start] [num] [val] : range get/set.
get_acn/set_acn [no] [id] [x] [y] [val]       : rack (ACN) get/set.
event_scp [no] [id]               : Execute event [id] of session [no].
```

## Module coverage (DM7 table)

The module generates the Fader Level/On + Label Name/Color addresses for
InCh/Mix/Mtrx/St/DCA and On/Name for MuteGrpCtrl (22 addresses), **plus
`InCh/Port/HA/Gain`** (head-amp gain, see below). All exist in firmware; 0 wrong.
✓ = covered by the module below; the rest are the expansion menu.

## Parameter metadata (from `prminfo`)

Value ranges/scale/dimensionality come from a real-desk `prminfo` dump
(`OK prminfo <index> "<addr>" <Xmax> <Ymax> <min> <max> <default> "<unit>" <type> <ui> <rw> <scale>`).
Two expansion params explored in detail:

- **head-amp (preamp) gain** — DM7 `MIXER:Current/InCh/Port/HA/Gain`, `Xmax=120` (per input
  channel, `y=0`), **`min=-6 max=66 default=0` dB, `scale=1`** → the wire value *is* the dB
  (1 dB steps), unlike Fader/Level (`scale=100`). **Implemented** as a per-input-channel value
  + a `Set HA Gain` command, wired per model from each one's `prminfo` (the module stores a
  per-table descriptor):
    - **DM7** — `MIXER:Current/InCh/Port/HA/Gain`, −6…66 dB, scale 1.
    - **CL/QL** — same address, −6…66 dB, **scale 100** (wire = dB×100).
    - **DM3** — **`IO:Current/InCh/HAGain`** (note the `IO:` namespace, not `MIXER:`), 0…64 dB, scale 1.
    - **Rivage** — `Port/HA/Gain` exists but `Xmax=6` (engine-local inputs; HA is on RPio racks), so **not wired**.
- **`MIXER:Current/InCh/PatchSelect`** — **not** input-source patching. `min=0 max=1`,
  Rivage UI type `latchsw`: it is the input channel's **SEL / select state** (write `1` to make
  it the desk's *selected channel*; it feeds the firmware's `SelectedCH` focus —
  `ChangeSelectedCH`/`RequestSelectedCH`/`SelectedChView`). Actual source patching (DANTE/SLOT)
  is a separate string/`listitem` parameter. Not implemented.

## All 220 `MIXER:` addresses (grouped)

### MIXER:Current/Cue  (14)

```
MIXER:Current/Cue/ActiveCue
MIXER:Current/Cue/CueMode
MIXER:Current/Cue/DCA/On
MIXER:Current/Cue/DCA/Point
MIXER:Current/Cue/DCA/Unity
MIXER:Current/Cue/InCh/On
MIXER:Current/Cue/InCh/Point
MIXER:Current/Cue/Mix/On
MIXER:Current/Cue/Mtrx/On
MIXER:Current/Cue/Out/Level
MIXER:Current/Cue/Out/On
MIXER:Current/Cue/OutCh/Point
MIXER:Current/Cue/St/On
MIXER:Current/Cue/Surr/CueMode
```

### MIXER:Current/DCA  (5)

```
MIXER:Current/DCA/Fader/Level  <- module
MIXER:Current/DCA/Fader/On  <- module
MIXER:Current/DCA/Label/Color  <- module
MIXER:Current/DCA/Label/Icon
MIXER:Current/DCA/Label/Name  <- module
```

### MIXER:Current/InCh  (45)

```
MIXER:Current/InCh/DCA/Assign
MIXER:Current/InCh/Fader/Level  <- module
MIXER:Current/InCh/Fader/On  <- module
MIXER:Current/InCh/HPF/Freq
MIXER:Current/InCh/HPF/On
MIXER:Current/InCh/HPF/Slope
MIXER:Current/InCh/LPF/Freq
MIXER:Current/InCh/LPF/On
MIXER:Current/InCh/LPF/Slope
MIXER:Current/InCh/Label/Color  <- module
MIXER:Current/InCh/Label/Icon
MIXER:Current/InCh/Label/Name  <- module
MIXER:Current/InCh/PEQ/Band/Bypass
MIXER:Current/InCh/PEQ/Band/Freq
MIXER:Current/InCh/PEQ/Band/Gain
MIXER:Current/InCh/PEQ/Band/Q
MIXER:Current/InCh/PEQ/BankSelect
MIXER:Current/InCh/PEQ/HighShelving/On
MIXER:Current/InCh/PEQ/LowShelving/On
MIXER:Current/InCh/PEQ/On
MIXER:Current/InCh/PEQ/Type
MIXER:Current/InCh/PanMode
MIXER:Current/InCh/PatchSelect
MIXER:Current/InCh/Port/HA/Gain  <- module
MIXER:Current/InCh/Role
MIXER:Current/InCh/Surr/COn
MIXER:Current/InCh/Surr/Div
MIXER:Current/InCh/Surr/FRPan
MIXER:Current/InCh/Surr/LFELevel
MIXER:Current/InCh/Surr/LFEOn
MIXER:Current/InCh/Surr/LOn
MIXER:Current/InCh/Surr/LRPan
MIXER:Current/InCh/Surr/LsOn
MIXER:Current/InCh/Surr/ROn
MIXER:Current/InCh/Surr/RsOn
MIXER:Current/InCh/ToMix/Level
MIXER:Current/InCh/ToMix/On
MIXER:Current/InCh/ToMix/Pan
MIXER:Current/InCh/ToMix/PrePost
MIXER:Current/InCh/ToMtrx/Level
MIXER:Current/InCh/ToMtrx/On
MIXER:Current/InCh/ToMtrx/Pan
MIXER:Current/InCh/ToMtrx/PrePost
MIXER:Current/InCh/ToSt/On
MIXER:Current/InCh/ToSt/Pan
```

### MIXER:Current/InputChLink  (21)

```
MIXER:Current/InputChLink/InCh/Assign
MIXER:Current/InputChLink/LinkParams/ChOn
MIXER:Current/InputChLink/LinkParams/DCA
MIXER:Current/InputChLink/LinkParams/Delay
MIXER:Current/InputChLink/LinkParams/DigitalGain
MIXER:Current/InputChLink/LinkParams/DirectOut
MIXER:Current/InputChLink/LinkParams/Dyna1
MIXER:Current/InputChLink/LinkParams/Dyna2
MIXER:Current/InputChLink/LinkParams/EQ
MIXER:Current/InputChLink/LinkParams/Fader
MIXER:Current/InputChLink/LinkParams/HA
MIXER:Current/InputChLink/LinkParams/HPF
MIXER:Current/InputChLink/LinkParams/Insert
MIXER:Current/InputChLink/LinkParams/MixSend
MIXER:Current/InputChLink/LinkParams/MixSendOn
MIXER:Current/InputChLink/LinkParams/MtrxSend
MIXER:Current/InputChLink/LinkParams/MtrxSendOn
MIXER:Current/InputChLink/LinkParams/Mute
MIXER:Current/InputChLink/LinkParams/ToSt
MIXER:Current/InputChLink/SendParams/ToMix
MIXER:Current/InputChLink/SendParams/ToMtrx
```

### MIXER:Current/Mix  (33)

```
MIXER:Current/Mix/BusType
MIXER:Current/Mix/DCA/Assign
MIXER:Current/Mix/Fader/Level  <- module
MIXER:Current/Mix/Fader/On  <- module
MIXER:Current/Mix/HPF/Freq
MIXER:Current/Mix/HPF/On
MIXER:Current/Mix/HPF/Slope
MIXER:Current/Mix/LPF/Freq
MIXER:Current/Mix/LPF/On
MIXER:Current/Mix/LPF/Slope
MIXER:Current/Mix/Label/Color  <- module
MIXER:Current/Mix/Label/Icon
MIXER:Current/Mix/Label/Name  <- module
MIXER:Current/Mix/MixMinus/Owner/InputChannel
MIXER:Current/Mix/Out/Balance
MIXER:Current/Mix/PEQ/Band/Bypass
MIXER:Current/Mix/PEQ/Band/Freq
MIXER:Current/Mix/PEQ/Band/Gain
MIXER:Current/Mix/PEQ/Band/Q
MIXER:Current/Mix/PEQ/BankSelect
MIXER:Current/Mix/PEQ/HighShelving/On
MIXER:Current/Mix/PEQ/LowShelving/On
MIXER:Current/Mix/PEQ/On
MIXER:Current/Mix/PEQ/Type
MIXER:Current/Mix/PanLink
MIXER:Current/Mix/PanMode
MIXER:Current/Mix/Role
MIXER:Current/Mix/ToMtrx/Level
MIXER:Current/Mix/ToMtrx/On
MIXER:Current/Mix/ToMtrx/Pan
MIXER:Current/Mix/ToMtrx/PrePost
MIXER:Current/Mix/ToSt/On
MIXER:Current/Mix/ToSt/Pan
```

### MIXER:Current/Monitor  (34)

```
MIXER:Current/Monitor/CueInterruption
MIXER:Current/Monitor/DimmerOn
MIXER:Current/Monitor/DownMix/CToLOn
MIXER:Current/Monitor/DownMix/CToLRLevel
MIXER:Current/Monitor/DownMix/CToROn
MIXER:Current/Monitor/DownMix/LFEToLOn
MIXER:Current/Monitor/DownMix/LFEToLRLevel
MIXER:Current/Monitor/DownMix/LFEToROn
MIXER:Current/Monitor/DownMix/LToLOn
MIXER:Current/Monitor/DownMix/LToLRLevel
MIXER:Current/Monitor/DownMix/LToROn
MIXER:Current/Monitor/DownMix/LsToLOn
MIXER:Current/Monitor/DownMix/LsToLRLevel
MIXER:Current/Monitor/DownMix/LsToROn
MIXER:Current/Monitor/DownMix/MainLevel
MIXER:Current/Monitor/DownMix/RToLOn
MIXER:Current/Monitor/DownMix/RToLRLevel
MIXER:Current/Monitor/DownMix/RToROn
MIXER:Current/Monitor/DownMix/RsToLOn
MIXER:Current/Monitor/DownMix/RsToLRLevel
MIXER:Current/Monitor/DownMix/RsToROn
MIXER:Current/Monitor/DownMix/Type
MIXER:Current/Monitor/Fader/Level
MIXER:Current/Monitor/On
MIXER:Current/Monitor/PhonesLevelLink
MIXER:Current/Monitor/St/SourceSelect
MIXER:Current/Monitor/Surr/COn
MIXER:Current/Monitor/Surr/LFEOn
MIXER:Current/Monitor/Surr/LOn
MIXER:Current/Monitor/Surr/LsOn
MIXER:Current/Monitor/Surr/ROn
MIXER:Current/Monitor/Surr/RsOn
MIXER:Current/Monitor/Surr/SoloMode
MIXER:Current/Monitor/Surr/SourceSelect
```

### MIXER:Current/Mtrx  (25)

```
MIXER:Current/Mtrx/BusType
MIXER:Current/Mtrx/DCA/Assign
MIXER:Current/Mtrx/Fader/Level  <- module
MIXER:Current/Mtrx/Fader/On  <- module
MIXER:Current/Mtrx/HPF/Freq
MIXER:Current/Mtrx/HPF/On
MIXER:Current/Mtrx/HPF/Slope
MIXER:Current/Mtrx/LPF/Freq
MIXER:Current/Mtrx/LPF/On
MIXER:Current/Mtrx/LPF/Slope
MIXER:Current/Mtrx/Label/Color  <- module
MIXER:Current/Mtrx/Label/Icon
MIXER:Current/Mtrx/Label/Name  <- module
MIXER:Current/Mtrx/Out/Balance
MIXER:Current/Mtrx/PEQ/Band/Bypass
MIXER:Current/Mtrx/PEQ/Band/Freq
MIXER:Current/Mtrx/PEQ/Band/Gain
MIXER:Current/Mtrx/PEQ/Band/Q
MIXER:Current/Mtrx/PEQ/BankSelect
MIXER:Current/Mtrx/PEQ/HighShelving/On
MIXER:Current/Mtrx/PEQ/LowShelving/On
MIXER:Current/Mtrx/PEQ/On
MIXER:Current/Mtrx/PEQ/Type
MIXER:Current/Mtrx/PanLink
MIXER:Current/Mtrx/Role
```

### MIXER:Current/MuteGrpCtrl  (2)

```
MIXER:Current/MuteGrpCtrl/Label/Name  <- module
MIXER:Current/MuteGrpCtrl/On  <- module
```

### MIXER:Current/OutputChLink  (13)

```
MIXER:Current/OutputChLink/LinkParams/ChOn
MIXER:Current/OutputChLink/LinkParams/DCA
MIXER:Current/OutputChLink/LinkParams/Dyna1
MIXER:Current/OutputChLink/LinkParams/EQ
MIXER:Current/OutputChLink/LinkParams/Fader
MIXER:Current/OutputChLink/LinkParams/Insert
MIXER:Current/OutputChLink/LinkParams/MtrxSend
MIXER:Current/OutputChLink/LinkParams/MtrxSendOn
MIXER:Current/OutputChLink/LinkParams/Mute
MIXER:Current/OutputChLink/LinkParams/ToSt
MIXER:Current/OutputChLink/Mix/Assign
MIXER:Current/OutputChLink/Mtrx/Assign
MIXER:Current/OutputChLink/SendParams/ToMtrx
```

### MIXER:Current/St  (13)

```
MIXER:Current/St/DCA/Assign
MIXER:Current/St/Fader/Level  <- module
MIXER:Current/St/Fader/On  <- module
MIXER:Current/St/Label/Color  <- module
MIXER:Current/St/Label/Icon
MIXER:Current/St/Label/Name  <- module
MIXER:Current/St/Out/Balance
MIXER:Current/St/PanMode
MIXER:Current/St/Role
MIXER:Current/St/ToMtrx/Level
MIXER:Current/St/ToMtrx/On
MIXER:Current/St/ToMtrx/Pan
MIXER:Current/St/ToMtrx/PrePost
```

### MIXER:Current/SurrMode  (1)

```
MIXER:Current/SurrMode
```

### MIXER:Lib/Scene  (2)

```
MIXER:Lib/Scene
MIXER:Lib/Scene/ClearMixData
```

### MIXER:Setup/Mix  (1)

```
MIXER:Setup/Mix/Availability
```

### MIXER:Setup/MonitorMix  (1)

```
MIXER:Setup/MonitorMix/Password
```

### MIXER:Setup/Mtrx  (1)

```
MIXER:Setup/Mtrx/Availability
```

### MIXER:Setup/Unit  (9)

```
MIXER:Setup/Unit/Split/DCA/Num
MIXER:Setup/Unit/Split/DCA/StartCh
MIXER:Setup/Unit/Split/InCh/Num
MIXER:Setup/Unit/Split/InCh/StartCh
MIXER:Setup/Unit/Split/Mix/Num
MIXER:Setup/Unit/Split/Mix/StartCh
MIXER:Setup/Unit/Split/Mute/Num
MIXER:Setup/Unit/Split/Mute/StartCh
MIXER:Setup/Unit/Split/On
```

## YOSC — Yamaha OSC server (alternative transport, push feedback)

Same command set over OSC, plus `SUBSCRIBE`/`UNSUBSCRIBE`/`KEEPALIVE` (no polling).

```
# YOSC (Yamaha OSC) — from app_console_main

## Command set (N4YOSC::OscServerCommand*):
DEVINFO DEVMODE DEVSTATUS EVENT GET GETN GETT IDENTIFY KEEPALIVE LISTITEM LISTITEMNUM MTRINFO MTRNUM MTRSTART MTRSTOP PRMINFO PRMNUM SCPMODE SET SETN SETR SETT SSCURRENT_EX SSCURRENTT_EX SSINFO_EX SSINFOT_EX SSNUM_EX SSRECALL_EX SSRECALLT_EX SSUPDATE_EX SSUPDATET_EX SUBSCRIBE UNSUBSCRIBE

## /yosc address format strings:
/yosc:
/yosc:%s/%s/ts:3DRev/MasterFader/Level
/yosc:%s/%s/ts:OBA/Label/Color/%u
/yosc:%s/%s/ts:OBA/Label/Icon/%u
/yosc:%s/%s/ts:OBA/Label/Name/%u
/yosc:%s/%s/ts:OBA/MasterFader/Level
/yosc:%s/%s/ts:OBA/Object/AuxSend/Level/%u
/yosc:%s/%s/ts:OBA/Object/AuxSend/On/%u
/yosc:%s/%s/ts:OBA/Object/LogicalPosition/%u
/yosc:%s/%s/ts:OBA/Object/Pair/%u
/yosc:%s/%s/ts:OBA/Object/RevSend/Level/%u
/yosc:%s/%s/ts:OBA/Object/RevSend/On/%u
/yosc:%s/%s/ts:OBA/Object/SizeH/%u
/yosc:%s/%s/ts:OBA/Object/SizeV/%u
/yosc:%s/%s/ts:OBA/Solo/On/%u
/yosc:%s/%s/ts:Scene/Status/EnableSceneView
/yosc:%s/%s/ts:Show/On
/yosc:%s/devinfo
/yosc:%s/scpmode
/yosc:%s/subscribe/ts:@LogicalPositionControl
/yosc:%s/subscribe/ts:3DRev/MasterFader/Level
/yosc:%s/subscribe/ts:Scene/Status/EnableSceneView
/yosc:%s/subscribe/ts:Show/On
/yosc:error/
/yosc:notify/set
/yosc:ok/
/yosc:ok/get/
/yosc:ok/keepalive
/yosc:okm/
/yosc:okm/set
/yosc:req/event
/yosc:req/get/
/yosc:req/keepalive
/yosc:req/set/
/yosc:req/ssrecallt_ex
```
