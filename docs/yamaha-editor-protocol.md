# Yamaha DM7 Editor — network reconnaissance notes

Observations of how the **DM7 Editor** app looks for a console on the network, captured
on macOS with `lsof`/`tcpdump` while the editor was open and attempting to go online.
This is **reconnaissance, not a spec** — it documents what was seen on the wire so we
don't have to re-derive it. Nothing here is confirmed against Yamaha documentation, and
some fields are guesses. See the [caveats](#caveats).

Relevant because the mock console (`test/mock-console.js`) speaks **RCP** (tcp/49280) —
the protocol *third-party controllers* use — but the Editor does **not** use RCP. This
note records what the Editor uses instead, and why making the mock discoverable by the
Editor is a much larger job than the RCP identity layer already built.

## TL;DR

- The Editor **idle** opens **no** network sockets — it only reaches out when you trigger
  connect / device-select.
- Discovery is **UDP**, in two forms (below). No TCP is attempted until a console answers.
- Because no console answered, the **TCP control protocol was never observed in this
  capture** — the Editor never got past discovery here. (It has since been captured and
  decoded in companion DM7 Editor-emulator work: the control port is **tcp/50368** — *not*
  50000 as earlier assumed — carrying framed `MPRO`/`EEVT` messages with a nested TLV body.
  See [update](#update-editor-transport-since-decoded).)

## 1. "LNK" multicast probe

Sent roughly once per second, on every interface (loopback + LAN):

```
<local-ip>:20909  →  224.76.78.75:20909    UDP, 17 bytes
payload (ASCII-ish): "LNK" Q ........ ablsd_v ...
```

- Multicast group **`224.76.78.75`**, UDP port **`20909`** (source and destination).
- The group address encodes the payload magic: `76.78.75` = ASCII **`L N K`**
  (0x4C 0x4E 0x4B). So this is Yamaha's `LNK` link/presence probe.
- 17-byte binary body after the magic (session token / query id — not decoded).

## 2. "SDP" subnet-broadcast beacon

```
<local-ip>:54330  →  <subnet-broadcast>.255:54330    UDP, 64 bytes
payload: "SDP" .... "_ypax-dm" .... "Yamaha DM7"  "Yamaha DM7"
```

- Subnet broadcast, UDP port **`54330`** (source and destination).
- Header magic read here as **`SDP`** — the companion emulator work decoded the full 4-char
  magic as **`YSDP`** (the leading byte was clipped in this ASCII dump). A service token
  **`_ypax-dm`**, and the model/friendly name **`Yamaha DM7`** (appears twice — likely model
  id + display name).
- This is the identity beacon; `54330` is the socket `lsof` first flagged on the Editor.

## 3. Loopback IPC (not discovery)

```
127.0.0.1:<ephemeral>  →  127.0.0.1:38900    UDP, 44 bytes
payload: "dvs" ....
```

- Localhost-only, app↔helper chatter (magic `dvs`). Not network discovery — ignore.

## What it would take to be discovered by the Editor

To make the mock appear in the DM7 Editor you would need, in order:

1. **Join `224.76.78.75:20909`** and answer the `LNK` multicast probe.
2. **Emit / reply to the `YSDP` beacon** on udp/`54330`, advertising a model string
   (e.g. `Yamaha DM7`).
3. **Accept and speak the TCP control protocol** (tcp/**50368**, `MPRO`/`EEVT` framing) once
   the Editor tries to go online.

Steps 1–2 are reverse-engineerable from captures (done in the companion work). **Step 3 is
the wall**: the *transport + framing* have since been decoded (byte-exact frame/TLV codec),
but the *application-level online handshake* — the exact property-tree + command field-map
responses — still needs a capture of a **real** console finishing an editor sync (an emulator
alone can't produce it). Reproducing it is a project in its own right, out of proportion to a
test harness. **Recommendation: do not pursue for the mock.** The mock stays an RCP target;
the Editor is not a supported client of it.

## Update: Editor transport since decoded

Companion DM7 Editor-**emulator** reverse-engineering (separate project) has since taken this
past discovery:

- **Control port is tcp/50368** (correcting the earlier tcp/50000 assumption), carrying
  framed **`MPRO`** (property) / **`EEVT`** (event) messages with a nested TLV body; the
  frame/TLV codec is verified **byte-exact** against real captured frames.
- Discovery is **`YSDP`** over UDP 54330 (beacon, both sides announce).
- The handshake has **no crypto/auth** — it's a plain text `CommandName` switch; session IDs
  just map a client to a slot.
- Still **shelved**: the full "go online" reply encoding needs a real console↔editor capture.

None of this changes the recommendation above — it only sharpens *why* Editor support is a
separate project. This module remains RCP-only (tcp/49280).

## Caveats

- Single capture, one app version, one host. Ports/addresses/magics are as-observed.
- Payload internals (the bytes after each magic) are **not** decoded.
- The control protocol was **not observed in this capture**; the tcp/**50368** + `MPRO`/`EEVT`
  facts come from the companion emulator captures (see the update section above). The old
  tcp/50000 guess was wrong.
- Multicast `224.76.78.75` and broadcast `.255` were seen on both loopback and the LAN
  interface; on-desk behaviour may differ.

## How this was captured

```
# process + sockets (no root)
ps axo pid,comm | grep -i dm7
lsof -nP -p <pid> -a -i          # empty when idle; a UDP socket appears on connect

# payloads (needs root, real terminal for the sudo prompt)
sudo tcpdump -i any -n -vv -A 'udp and not port 5353 and not port 1900 \
  and not port 137 and not port 138 and not port 67 and not port 68 and not port 123'
# then trigger device-select / go-online in the Editor
```
