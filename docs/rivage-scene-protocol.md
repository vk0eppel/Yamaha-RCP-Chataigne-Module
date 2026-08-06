# Rivage PM scene protocol — real-hardware capture

Captured from a **Rivage DSP-RX-EX** engine (`192.168.1.130`) via Bitfocus Companion's
action recorder, 2026-07-08. First-party hardware evidence for the Rivage scene verbs —
confirms what the module already sends and reveals the scene *feedback* verbs it doesn't
yet use.

## Raw log (verbatim, quotes normalised to straight `"`)

```
NOTIFY ssrecallt_ex  MIXER:Lib/Scene "8.00"
NOTIFY sscurrentt_ex MIXER:Lib/Scene "8.00"
    -> ssinfot_ex    MIXER:Lib/Scene "8.00"                 (Companion queries)
OK     ssinfot_ex    MIXER:Lib/Scene "8.00" 7 "Blank" "" user
NOTIFY ssupdatet_ex  MIXER:Lib/Scene "8.00"
NOTIFY sscurrentt_ex MIXER:Lib/Scene "9.00"
    -> ssinfot_ex    MIXER:Lib/Scene "9.00"
OK     ssinfot_ex    MIXER:Lib/Scene "9.00" 8 "Blank" "" user
```

(The recorder rendered curly quotes; the wire uses straight `"`.)

## Verbs (scene value is a quoted `"N.MM"` string, e.g. `"8.00"`)

| Verb | Direction | Meaning | Form |
|---|---|---|---|
| `ssrecallt_ex`  | NOTIFY | a scene was **recalled** | `<verb> MIXER:Lib/Scene "N.MM"` |
| `sscurrentt_ex` | NOTIFY | the **current scene** changed | `<verb> MIXER:Lib/Scene "N.MM"` |
| `ssupdatet_ex`  | NOTIFY | a scene was **stored/updated** | `<verb> MIXER:Lib/Scene "N.MM"` |
| `ssinfot_ex`    | client→desk / `OK` | **query scene metadata** | reply: `OK ssinfot_ex MIXER:Lib/Scene "N.MM" <index> "<name>" "<comment>" <type>` |

`ssinfot_ex "8.00"` → index `7`, name `"Blank"`, comment `""`, type `user`. The `…t_ex`
("text") family is the DM7/Rivage string-scene variant; CL/QL uses the integer `ssrecall_ex`.

## Confirmed in this module

`RIVAGE_SCENE` in `Yam-RCP.js` — `{ verb: "ssrecallt_ex", target: "MIXER:Lib/Scene",
quote: true, incBank: false }` — is **correct, now hardware-verified**: the `ssrecallt_ex`
verb, the `MIXER:Lib/Scene` target (no `scene_a`/`scene_b` bank), and the quoted `"N.MM"`
format all match. `RXEX` is a real engine.

## Newly revealed

- **`sscurrentt_ex`** / **`ssrecallt_ex`** — the current-scene feedback verbs. **Now used:**
  `parseLine()`/`applyScene()` in `Yam-RCP.js` reflect them into `Scene/Current` (changed
  to a **String** so it holds both `"8.00"` and CL/QL integers). The mock now emits these
  real verbs (`injectScene()`), so the path is testable — replacing the old fabricated
  `MIXER:Lib/Scene/Recall` line.
- **`ssupdatet_ex`** (store) and **`ssinfot_ex`** (names/indices) — still **unused**; they
  would enable scene-*name* display, deferred for now.

## Still open

- **Scene inc/dec on Rivage** (README "Still to confirm" #2): not in this capture. The
  8.00→9.00 change shows only `sscurrentt_ex`, no `event MIXER:Lib/Scene/RecallInc`, so
  whether the module's inc/dec works on Rivage is still unverified.

## Caveats

- One capture, one engine (DSP-RX-EX), unknown firmware. Verbs/format as-observed.
- DM7 is expected to behave the same (same `…t_ex` family) but was not captured here. The
  DM7 firmware **confirms the verb family exists** — `ssrecallt_ex`, `sscurrentt_ex`,
  `ssinfot_ex`, `ssupdatet_ex` are all present as server dispatch classes (see
  [`dm7-rcp-parameters.md`](dm7-rcp-parameters.md)) — though the exact wire *values* on DM7
  are still inferred, not captured.
