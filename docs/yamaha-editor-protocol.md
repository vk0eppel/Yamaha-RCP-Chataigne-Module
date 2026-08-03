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
- Because no console answered, the **TCP control protocol was never observed** — the
  Editor never got past discovery. (Yamaha's editor control port is believed to be
  **tcp/50000**; not seen in this capture.)

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
- Header magic **`SDP`**, a service token **`_ypax-dm`**, and the model/friendly name
  **`Yamaha DM7`** (appears twice — likely model id + display name).
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
2. **Emit / reply to the `SDP` beacon** on udp/`54330`, advertising a model string
   (e.g. `Yamaha DM7`).
3. **Accept and speak the TCP control protocol** (believed tcp/**50000**) once the Editor
   tries to go online.

Steps 1–2 are reverse-engineerable from more captures. **Step 3 is the wall**: we have
**zero bytes** of it, because it only begins after a successful discovery handshake, and
there is no public spec. Reproducing it is a project in its own right, out of proportion
to a test harness. **Recommendation: do not pursue for the mock.** The mock stays an RCP
target; the Editor is not a supported client of it.

## Caveats

- Single capture, one app version, one host. Ports/addresses/magics are as-observed.
- Payload internals (the bytes after each magic) are **not** decoded.
- tcp/50000 for the control protocol is **assumed from prior notes, not observed here**.
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
