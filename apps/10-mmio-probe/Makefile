TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc

CFLAGS    := -qbsp=$(BSP) -Wall -Wextra
TARGET    := mmio_probe.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr712rc -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): mmio_probe.c
	$(CC) $(CFLAGS) $< -o $@

# Standalone run will not see the host-side fake peripheral, so reads
# fall through the AMBA diag catch-all (-> 0). Useful for sanity-
# checking the binary boots; the E2E path is via the peripheral-test
# host in embed/examples/peripheral-test/.
run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
