# UART Socket Interface

This document describes how to connect external simulators or test harnesses
to APBUARTs 1–4 on the emulated GR712RC.

---

## Overview

APBUART-0 is always wired to QEMU's first serial port (the host terminal in
`-nographic` mode).  APBUARTs 1–4 are present in the AMBA PnP ROM and fully
functional as GRLIB register models, but they have no I/O backend by default —
transmitted bytes are discarded and nothing arrives in the receive FIFO.

To attach a backend, pass one `-serial` option per UART on the QEMU command
line.  QEMU maps them in order: `-serial` #0 → UART-0, #1 → UART-1, and so on.

---

## Connecting a TCP socket backend

The most useful backend for co-simulation is a TCP server socket.  QEMU
listens on a port; your external process connects and exchanges raw bytes.

```bash
./qemu/build/qemu-system-sparc -M gr712rc -nographic \
    -serial mon:stdio \
    -serial tcp::5001,server,nowait \
    -serial tcp::5002,server,nowait \
    -serial tcp::5003,server,nowait \
    -serial tcp::5004,server,nowait \
    -kernel apps/03-five-uarts/five_uarts.exe
```

| `-serial` index | UART | Port |
|----------------|------|------|
| 0 (`mon:stdio`) | UART-0 | host terminal + QEMU monitor |
| 1 | UART-1 | TCP 5001 |
| 2 | UART-2 | TCP 5002 |
| 3 | UART-3 | TCP 5003 |
| 4 | UART-4 | TCP 5004 |

`server,nowait` makes QEMU open the socket immediately and accept a connection
later — the emulation does not pause waiting for clients.

To connect a simple test client:

```bash
# In another terminal — receives bytes from RTEMS on UART-1
nc localhost 5001
```

---

## Protocol

The interface is a **raw byte stream**.  QEMU performs no framing.  Bytes
written by the RTEMS application to the UART transmit register appear verbatim
on the socket; bytes sent to the socket appear verbatim in the UART receive
FIFO and generate a receive-data-ready interrupt if enabled.

For point-to-point simulation (e.g. a GPS receiver attached to UART-2):

```
RTEMS task ──write──▶ APBUART-2 TX reg ──▶ QEMU chardev ──▶ TCP socket ──▶ simulator
RTEMS ISR  ◀──read── APBUART-2 RX FIFO ◀── QEMU chardev ◀── TCP socket ◀── simulator
```

If you need structured messages (packets, framing, length prefixes), implement
that at the application layer — both sides agree on a convention and the raw
byte stream carries it transparently.

---

## Other useful backends

| Use case | QEMU chardev string |
|----------|-------------------|
| Discard all output | `-serial null` |
| Pseudo-terminal (PTY) | `-serial pty` — QEMU prints the PTY path on startup |
| Named pipe | `-serial pipe:/tmp/uart1` |
| TCP client (connect to remote) | `-serial tcp:host:port` |
| File (capture output) | `-serial file:/tmp/uart1.log` |

---

## Extending to other interface types (CAN, SpaceWire)

When OCCAN or GRSPW2 peripherals are added, the same socket-backend pattern
applies but the framing layer becomes non-trivial:

- **CAN**: frames have an 11/29-bit ID and up to 8 bytes of data.  A natural
  framing for the socket stream is the SocketCAN `can_frame` struct (8+8 bytes)
  or a simple TLV: `[1 byte type][4 byte ID][1 byte len][0..8 bytes data]`.
- **SpaceWire**: packets are variable length with EOP/EEP markers.  A socket
  framing could be `[2 byte length][N bytes][1 byte marker]`.

Define the framing convention in this document when the peripheral is
implemented, so all external simulators use the same encoding.
