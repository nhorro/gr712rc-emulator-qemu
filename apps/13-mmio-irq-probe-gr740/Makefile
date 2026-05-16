TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr740

CFLAGS    := -qbsp=$(BSP) -Wall -Wextra
TARGET    := mmio_irq_probe.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr740 -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): mmio_irq_probe.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
