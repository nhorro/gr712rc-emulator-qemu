TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr740

CFLAGS    := -qbsp=$(BSP) -Wall -Wextra
TARGET    := mmio_probe.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr740 -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): mmio_probe.c
	$(CC) $(CFLAGS) $< -o $@

# Standalone run hits empty APB space (gr740 has no diag catch-all) --
# the E2E path is via embed/examples/peripheral-test (run-gr740).
run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
