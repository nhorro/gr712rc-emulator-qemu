TOOLCHAIN ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC        := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
BSP       ?= gr712rc

CFLAGS    := -qbsp=$(BSP)
TARGET    := hello.exe

QEMU      ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS    := -M gr712rc -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET)

$(TARGET): hello.c
	$(CC) $(CFLAGS) $< -o $@

run: $(TARGET)
	$(QEMU) $(QFLAGS) -kernel $(TARGET)

clean:
	rm -f $(TARGET)
