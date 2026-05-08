TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr740

CFLAGS    := -qbsp=$(BSP)
TARGET    := hello.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc

# Phase 0: run against the existing -M gr712rc to capture the trace of
# unmapped accesses made by the gr740 BSP. -d guest_errors,unimp prints
# every load/store that hits no mapped region.
QFLAGS    := -M gr712rc -nographic -serial mon:stdio -d guest_errors,unimp

.PHONY: all run probe clean

all: $(TARGET)

$(TARGET): hello.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

# Capture the unmapped-access trace to a log for analysis. Bounded by a
# 5-second timeout because the BSP will keep spinning on missing devices.
probe: $(TARGET)
	-timeout 5 $(QEMU) $(QFLAGS) -kernel $(TARGET) 2>&1 | tee probe.log
	@echo "--- unique unmapped accesses ---"
	@grep -E "Invalid|unimp|guest" probe.log | sort -u || true

clean:
	rm -f $(TARGET) probe.log
