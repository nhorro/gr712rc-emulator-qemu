TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr740

CFLAGS    := -qbsp=$(BSP) -O2 -Wall
TARGET    := grspw_echo_gr740.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
PEER_PORT ?= 5101
# -icount auto,sleep=on aligns virtual time with wall time so the app's
# "1 second between iterations" is actually ~1 wall second.  Without it
# the gr740 BSP's idle handling lets QEMU's vm_clock race ahead of wall
# time and the echo pacing becomes bursty.
QFLAGS    := -M gr740 -m 256M -nographic \
             -icount auto,sleep=on \
             -serial mon:stdio \
             -chardev socket,id=spw0,host=0.0.0.0,port=$(PEER_PORT),server=on,wait=off

.PHONY: all run peer clean

all: $(TARGET)

$(TARGET): grspw_echo_gr740.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

# Convenience: run the echo peer in the foreground.  Use a separate
# terminal — this blocks.  QEMU is the TCP listener (see QFLAGS), so
# the peer dials in with --connect.  Start `make run` first.
peer:
	python3 $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../tools/spw-echo-peer.py --port $(PEER_PORT) --connect -v

clean:
	rm -f $(TARGET)
