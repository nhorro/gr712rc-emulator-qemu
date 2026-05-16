# timing-gr740-lockstep — Model B embed example: up to 5000 x 1 ms on
# -M gr740 (single-core BSP) under -icount with absolute VIRTUAL deadlines.
#
# Uses a single-core gr740 BSP build because gr740 SMP under -icount is
# blocked (Blocker B, docs/14). To run SMP gr740 under Model B, resolve
# Blocker B first.

REPO       := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBED_DIR  := $(REPO)/embed
QEMU_SDK   := $(REPO)/qemu/include
QEMU_BUILD := $(REPO)/qemu/build
LIBQEMU    := $(QEMU_BUILD)/libqemu-sparc.so

CC      := gcc
CFLAGS  := -Wall -Wextra -O2 -g -I$(EMBED_DIR) -I$(QEMU_SDK)
LDFLAGS := -L$(QEMU_BUILD) -lqemu-sparc -Wl,-rpath,$(QEMU_BUILD)

TARGET  := timing-gr740-lockstep
SRCS    := main.c $(EMBED_DIR)/embed_qemu.c

DEFAULT_BIN := $(REPO)/apps/07-hello-gr740/hello.exe

.PHONY: all run kernel check-lib qemu-lib clean

all: $(TARGET)

$(TARGET): $(SRCS) $(EMBED_DIR)/embed_qemu.h
	$(CC) $(CFLAGS) $(SRCS) -o $@ $(LDFLAGS)

# Build the .so if missing. Idempotent.
qemu-lib:
	@if [ ! -f "$(LIBQEMU)" ]; then \
		if [ ! -d "$(REPO)/qemu/build" ]; then \
			cd $(REPO)/qemu && mkdir build && cd build \
			    && ../configure --target-list=sparc-softmmu; \
		fi; \
		$(REPO)/qemu/build/pyvenv/bin/meson configure \
		    $(REPO)/qemu/build -Db_staticpic=true 2>/dev/null || true; \
		cd $(REPO)/qemu/build && ninja libqemu-sparc.so; \
	fi

kernel:
	@$(MAKE) -C $(REPO)/apps/07-hello-gr740 -s

# Default run uses the single-core hello-gr740 ELF. Override with
# BIN=/path/to/x.bin (or any .exe) for a different binary — but it
# MUST be a single-core BSP build until Blocker B is resolved.
BIN ?= $(DEFAULT_BIN)
run: qemu-lib kernel $(TARGET)
	./$(TARGET) $(BIN)

clean:
	rm -f $(TARGET) /tmp/timing-gr740-lockstep.log
