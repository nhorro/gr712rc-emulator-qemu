# peripheral-test -- exercises embed_register_peripheral against both
# GR712RC and GR740 machines.
#
# One main.c, two binaries:
#   embed-peripheral-test-gr712rc -- compiled with config_gr712rc.h
#   embed-peripheral-test-gr740   -- compiled with config_gr740.h
#
# Targets:
#   make                    -- build both binaries (gr712rc + gr740)
#   make run                -- build everything and run gr712rc variant
#   make run-gr712rc        -- run gr712rc variant
#   make run-gr740          -- run gr740 variant

REPO       := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBED_DIR  := $(REPO)/embed
QEMU_SDK   := $(REPO)/qemu/include
QEMU_BUILD := $(REPO)/qemu/build
LIBQEMU    := $(QEMU_BUILD)/libqemu-sparc.so

CC      := gcc
CFLAGS  := -Wall -Wextra -O2 -g -I$(EMBED_DIR) -I$(QEMU_SDK)
LDFLAGS := -L$(QEMU_BUILD) -lqemu-sparc -Wl,-rpath,$(QEMU_BUILD)

SRCS := main.c $(EMBED_DIR)/embed_qemu.c
HDRS := config_gr712rc.h config_gr740.h $(EMBED_DIR)/embed_qemu.h

TARGET_GR712RC := embed-peripheral-test-gr712rc
TARGET_GR740   := embed-peripheral-test-gr740

# By default we use the IRQ-aware probe so all 9 tests run (including
# TEST #7/#7b). Pass BIN=... to swap in the simpler mmio_probe.exe
# (TEST #7 then reports SKIP, the other 7 still pass).
KERNEL_GR712RC := $(REPO)/apps/12-mmio-irq-probe/mmio_irq_probe.exe
KERNEL_GR740   := $(REPO)/apps/13-mmio-irq-probe-gr740/mmio_irq_probe.exe

.PHONY: all run run-gr712rc run-gr740 kernel-gr712rc kernel-gr740 \
        qemu-lib clean

all: $(TARGET_GR712RC) $(TARGET_GR740)

$(TARGET_GR712RC): $(SRCS) $(HDRS)
	$(CC) $(CFLAGS) -DCONFIG_HEADER='"config_gr712rc.h"' \
	    $(SRCS) -o $@ $(LDFLAGS)

$(TARGET_GR740): $(SRCS) $(HDRS)
	$(CC) $(CFLAGS) -DCONFIG_HEADER='"config_gr740.h"' \
	    $(SRCS) -o $@ $(LDFLAGS)

# Build the .so if missing. Idempotent.
qemu-lib:
	@if [ ! -f "$(LIBQEMU)" ]; then \
		if [ ! -d "$(REPO)/qemu/build" ]; then \
			cd $(REPO)/qemu && mkdir build && cd build \
			    && ../configure --target-list=sparc-softmmu; \
		fi; \
		cd $(REPO)/qemu/build && ninja libqemu-sparc.so; \
	fi

kernel-gr712rc:
	@$(MAKE) -C $(REPO)/apps/12-mmio-irq-probe -s

kernel-gr740:
	@$(MAKE) -C $(REPO)/apps/13-mmio-irq-probe-gr740 -s

run: run-gr712rc

run-gr712rc: qemu-lib kernel-gr712rc $(TARGET_GR712RC)
	./$(TARGET_GR712RC) $(KERNEL_GR712RC)

run-gr740: qemu-lib kernel-gr740 $(TARGET_GR740)
	./$(TARGET_GR740) $(KERNEL_GR740)

clean:
	rm -f $(TARGET_GR712RC) $(TARGET_GR740) \
	    /tmp/embed-peripheral-test-gr712rc.qmon \
	    /tmp/embed-peripheral-test-gr712rc.uart.log \
	    /tmp/embed-peripheral-test-gr740.qmon \
	    /tmp/embed-peripheral-test-gr740.uart.log
