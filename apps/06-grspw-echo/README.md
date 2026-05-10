# 06 — GRSPW2 echo demo

Demonstrates the QEMU GRLIB GRSPW2 (SpaceWire) device on `-M gr712rc`
(issue #10).  The RTEMS application transmits a 4-byte big-endian
counter once per second on SpW link 0; an external Python peer reads
the framed packet, adds 1, and echoes it back.  The application prints
each round-trip:

    sent=0 recv=1 OK
    sent=1 recv=2 OK
    sent=2 recv=3 OK
    ...

## Wire framing

Each SpW packet is wrapped on the TCP backend with a 4-byte big-endian
length prefix followed by the raw packet bytes (header + payload as
assembled from the GRSPW2 TX descriptor's `haddr`/`daddr`).

The application sends packets of 6 bytes: a 2-byte SpW header
(destination address `0xFE`, protocol id `0x00`) followed by the 4-byte
big-endian counter.

## Running

QEMU is the TCP **listener** (`server=on,wait=off` in the chardev),
so start it first and have the peer dial in.

In one terminal, start QEMU:

    make run

That uses the chardev configuration:

    -chardev socket,id=spw0,host=0.0.0.0,port=5101,server=on,wait=off

In another terminal, start the echo peer in client mode:

    make peer
    # equivalent to:
    # python3 ../../tools/spw-echo-peer.py --port 5101 --connect -v

If you prefer the peer as the listener and QEMU as the client, swap
`server=on` to `server=off` in the Makefile's `QFLAGS` and drop
`--connect` from the peer invocation.  In that case start the peer
first.

## Files

- `grspw_echo.c` — RTEMS init task, direct MMIO + descriptor walk
- `Makefile`     — build with `sparc-gaisler-rtems5-gcc -qbsp=gr712rc`
