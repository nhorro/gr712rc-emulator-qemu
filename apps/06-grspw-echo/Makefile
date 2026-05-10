TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc

CFLAGS    := -qbsp=$(BSP) -O2 -Wall
TARGET    := grspw_echo.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
PEER_PORT ?= 5101
QFLAGS    := -M gr712rc -nographic \
             -serial mon:stdio \
             -chardev socket,id=spw0,host=0.0.0.0,port=$(PEER_PORT),server=on,wait=off

.PHONY: all run peer clean

all: $(TARGET)

$(TARGET): grspw_echo.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

# Convenience: run the echo peer in the foreground.  Use a separate
# terminal — this blocks.
peer:
	python3 $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../tools/spw-echo-peer.py --port $(PEER_PORT) -v

clean:
	rm -f $(TARGET)
