# standalone-host: a host program that lives entirely outside the
# QEMU source tree and links against libqemu-sparc.so to embed a
# GR712RC or GR740 machine in-process.
#
# Build flow:
#   1. Compile embed_qemu.c (the consumer-side wrapper, in ../..).
#   2. Compile main.c (this example's main()).
#   3. Link both with libqemu-sparc.so from qemu/build/.
#
# No QEMU headers, no QEMU build system. Pure gcc + Makefile.

REPO       := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBED_DIR  := $(REPO)/embed
QEMU_SDK   := $(REPO)/qemu/include
QEMU_BUILD := $(REPO)/qemu/build
LIBQEMU    := $(QEMU_BUILD)/libqemu-sparc.so

# QEMU_SDK is where libqemu.h lives — the .so's public header.
# embed/embed_qemu.c #includes <libqemu.h>; main.c only needs
# embed_qemu.h from the wrapper.
CC      := gcc
CFLAGS  := -Wall -Wextra -O2 -g -I$(EMBED_DIR) -I$(QEMU_SDK)
LDFLAGS := -L$(QEMU_BUILD) -lqemu-sparc -Wl,-rpath,$(QEMU_BUILD)

TARGET  := standalone-host
OBJS    := main.o embed_qemu.o

DT_US   ?= 1000
N_STEPS ?= 2000

GR740_KERNEL   := $(REPO)/apps/07-hello-gr740/hello.exe
GR712RC_KERNEL := $(REPO)/apps/02-dual-core-timer/dual_core_timer.exe

.PHONY: all run-gr740 run-gr712rc check-lib qemu-lib qemu-lib-setup clean

all: $(TARGET)

# One-time configuration of the QEMU build tree for embedding. Runs
# configure (if needed), enables b_staticpic (required so the static
# libraries the .so pulls objects from are PIC-compatible), and
# builds libqemu-sparc.so. Idempotent: safe to re-run.
qemu-lib-setup:
	@if [ ! -d $(REPO)/qemu/build ]; then \
		echo ">>> Configuring qemu/build for sparc-softmmu"; \
		cd $(REPO)/qemu && mkdir build && cd build \
		    && ../configure --target-list=sparc-softmmu; \
	fi
	@echo ">>> Enabling b_staticpic for shared-library build"
	@$(REPO)/qemu/build/pyvenv/bin/meson configure \
	    $(REPO)/qemu/build -Db_staticpic=true 2>/dev/null || true
	@echo ">>> Building libqemu-sparc.so"
	@cd $(REPO)/qemu/build && ninja libqemu-sparc.so

# Quick incremental rebuild of just the .so (assumes qemu/build is
# already configured).
qemu-lib:
	@cd $(REPO)/qemu/build && ninja libqemu-sparc.so

main.o: main.c $(EMBED_DIR)/embed_qemu.h
	$(CC) $(CFLAGS) -c main.c -o main.o

embed_qemu.o: $(EMBED_DIR)/embed_qemu.c $(EMBED_DIR)/embed_qemu.h
	$(CC) $(CFLAGS) -c $(EMBED_DIR)/embed_qemu.c -o embed_qemu.o

$(TARGET): $(OBJS) check-lib
	$(CC) $(OBJS) $(LDFLAGS) -o $(TARGET)

check-lib:
	@if [ ! -f "$(LIBQEMU)" ]; then \
		echo "ERROR: $(LIBQEMU) not found."; \
		echo ""; \
		echo "Build it from the QEMU build tree (one time):"; \
		echo "  cd $(REPO)/qemu && mkdir -p build && cd build \\"; \
		echo "      && ../configure --target-list=sparc-softmmu \\"; \
		echo "      && \$$(pwd)/pyvenv/bin/meson configure -Db_staticpic=true \\"; \
		echo "      && ninja libqemu-sparc.so"; \
		echo ""; \
		echo "(b_staticpic=true is required so the static libs that the"; \
		echo " .so pulls objects from are marked PIC-compatible.)"; \
		exit 1; \
	fi

run-gr740: $(TARGET)
	@if [ ! -x "$(GR740_KERNEL)" ]; then $(MAKE) -C $(REPO)/apps/07-hello-gr740; fi
	@echo ""
	@echo ">>> standalone-host: gr740 + hello"
	./$(TARGET) gr740 $(GR740_KERNEL) $(DT_US) $(N_STEPS)
	@echo ""
	@echo "----- UART output -----"
	@cat /tmp/standalone-host-gr740-uart.log 2>/dev/null || echo "(no log)"
	@echo "------------------------"

run-gr712rc: $(TARGET)
	@if [ ! -x "$(GR712RC_KERNEL)" ]; then $(MAKE) -C $(REPO)/apps/02-dual-core-timer; fi
	@echo ""
	@echo ">>> standalone-host: gr712rc + dual_core_timer"
	./$(TARGET) gr712rc $(GR712RC_KERNEL) $(DT_US) 3000
	@echo ""
	@echo "----- UART output -----"
	@cat /tmp/standalone-host-gr712rc-uart.log 2>/dev/null || echo "(no log)"
	@echo "------------------------"

clean:
	rm -f $(TARGET) $(OBJS) /tmp/standalone-host-*-uart.log
