TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc_smp

CFLAGS    := -qbsp=$(BSP)
TARGET    := five_uarts.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr712rc -nographic \
             -serial mon:stdio \
             -serial tcp::5001,server,nowait \
             -serial tcp::5002,server,nowait \
             -serial tcp::5003,server,nowait \
             -serial tcp::5004,server,nowait

.PHONY: all run clean

all: $(TARGET)

$(TARGET): five_uarts.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
