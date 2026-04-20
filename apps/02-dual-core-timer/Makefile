TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc_smp

CFLAGS    := -qbsp=$(BSP)
TARGET    := dual_core_timer.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr712rc -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): dual_core_timer.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
