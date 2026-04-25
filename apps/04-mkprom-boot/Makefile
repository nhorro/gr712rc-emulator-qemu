APP        := mkprom_boot
TARGET_ELF := $(APP).exe
TARGET_PROM_ELF := gr712rc-prom.elf
TARGET_BIN := gr712rc-prom.bin

# RCC toolchain — compiles the RTEMS application; objcopy flattens the
# mkprom2 ELF output into a raw PROM image that QEMU's -bios path can load.
TOOLCHAIN  ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/rcc-1.3.2-gcc/bin
CC         := $(TOOLCHAIN)/sparc-gaisler-rtems5-gcc
OBJCOPY    := $(TOOLCHAIN)/sparc-gaisler-rtems5-objcopy

# mkprom2 — packaged separately from RCC. Falls back to PATH if not present.
MKPROM_DIR ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../toolchain/mkprom2-2.0.69/mkprom2
MKPROM     ?= $(if $(wildcard $(MKPROM_DIR)/mkprom2),$(MKPROM_DIR)/mkprom2,mkprom2)

BSP        ?= gr712rc_smp
CFLAGS     := -qbsp=$(BSP) -O2 -g

# mkprom2 flags chosen for the GR712RC machine emulated by this QEMU:
#   -ccprefix       toolchain prefix; mkprom2 appends "-gcc" internally
#   -leon3          LEON3 family (matches gr712rc CPU)
#   -freq 50        50 MHz system clock (matches GPTIMER scaler in QEMU)
#   -baud 38400     console baud (cosmetic in QEMU; matches RCC default)
#   -msoft-float    keep the mkprom2 runtime integer-only
#   -romsize 8192   PROM size in KiB (8 MiB, matches GR712RC_PROM_SIZE)
#   -ramsize 65536  SDRAM size in KiB (64 MiB, matches default GR712RC_RAM_SIZE)
# Note: mkprom2 v2.0.69 has a stringtable typo for sparc-gaisler-rtems5-gcc, so
# auto-detection from PATH does not work and -ccprefix is required.
CCPREFIX     ?= sparc-gaisler-rtems5
MKPROM_FLAGS ?= -ccprefix $(CCPREFIX) -leon3 -freq 50 -baud 38400 -msoft-float \
                -romsize 8192 -ramsize 65536

QEMU       ?= $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../qemu/build/qemu-system-sparc
QFLAGS     := -M gr712rc -nographic -serial mon:stdio

.PHONY: all run clean

all: $(TARGET_BIN)

$(TARGET_ELF): $(APP).c
	$(CC) $(CFLAGS) $< -o $@

# mkprom2 emits an ELF; QEMU's -bios path loads the file verbatim into PROM,
# so we strip the ELF wrapper with objcopy to produce a flat binary.
$(TARGET_PROM_ELF): $(TARGET_ELF)
	PATH=$(TOOLCHAIN):$$PATH $(MKPROM) $(MKPROM_FLAGS) -o $@ $<

$(TARGET_BIN): $(TARGET_PROM_ELF)
	$(OBJCOPY) -O binary $< $@

run: $(TARGET_BIN)
	$(QEMU) $(QFLAGS) -bios ./$(TARGET_BIN)

clean:
	rm -f $(TARGET_ELF) $(TARGET_PROM_ELF) $(TARGET_BIN)
