TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc

CFLAGS    := -qbsp=$(BSP) -Wall -Wextra
TARGET    := mmio_irq_probe.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr712rc -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): mmio_irq_probe.c
	$(CC) $(CFLAGS) $< -o $@

# Standalone run will time out at "ISR did NOT fire" because no host
# is registered to pulse IRQ 7. The E2E path is via
# embed/examples/peripheral-test (run-gr712rc, with the IRQ kernel).
run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
