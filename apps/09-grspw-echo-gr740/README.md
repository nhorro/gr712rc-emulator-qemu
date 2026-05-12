# 09 — GRSPW2 echo demo (GR740)

GR740 variant of `apps/06-grspw-echo`.  Same RTEMS init task, same wire
framing, same Python peer — only the SpW0 register base address differs
(`0xFF901000` on `-M gr740`).

Closes the GR740 half of issue #10 (PR-B).

## Expected output and QEMU pacing note

Each iteration sends one counter, waits ~1 s, then drains every BD that
completed during the window.  A line that pairs `recv == counter + 1` is
flagged `OK`; other receives are tagged `(out of order)`.

On `-M gr740` the QEMU main loop tends to dispatch chardev events in
bursts: several seconds of `TIMEOUT` lines followed by a single
iteration that drains many echoes at once.  The data is correct — every
counter is round-tripped — but iteration pairing is bursty.  The
Makefile passes `-icount auto,sleep=on` to keep virtual time roughly
aligned with wall time; without it the burst window grows.  On
`-M gr712rc` the same code paces one OK per second cleanly without
needing `-icount`.

## Wire framing

4-byte big-endian length prefix on the TCP backend, then the raw
SpaceWire packet (2-byte SpW header `0xFE 0x00` + 4-byte big-endian
counter for this demo).

## Running

QEMU is the TCP **listener** (`server=on,wait=off` in the chardev), so
start it first and have the peer dial in.

Terminal A:

    make run

That uses the chardev configuration:

    -chardev socket,id=spw0,host=0.0.0.0,port=5101,server=on,wait=off

Terminal B:

    make peer
    # equivalent to:
    # python3 ../../tools/spw-echo-peer.py --port 5101 --connect -v

## Files

- `grspw_echo_gr740.c` — RTEMS init task, direct MMIO + descriptor walk
- `Makefile`           — build with `sparc-gaisler-rtems5-gcc -qbsp=gr740`
