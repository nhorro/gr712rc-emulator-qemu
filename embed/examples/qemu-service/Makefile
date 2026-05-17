# qemu-system-sparc-embed -- drop-in replacement for qemu-system-sparc
# built on top of libqemu-sparc.so. Used by the FastAPI service when
# QEMU_BINARY=qemu-system-sparc-embed (and the binary is in PATH or its
# absolute path is given).
#
# Targets:
#   make                        -- build the wrapper binary
#   make run-gr712rc            -- standalone smoke-run with hello-rtems
#   make run-gr740              -- same for gr740
#   make qemu-lib               -- build libqemu-sparc.so if missing

REPO       := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBED_DIR  := $(REPO)/embed
QEMU_SDK   := $(REPO)/qemu/include
QEMU_BUILD := $(REPO)/qemu/build
LIBQEMU    := $(QEMU_BUILD)/libqemu-sparc.so

CC      := gcc
CFLAGS  := -Wall -Wextra -O2 -g -I$(EMBED_DIR) -I$(QEMU_SDK)
LDFLAGS := -L$(QEMU_BUILD) -lqemu-sparc -Wl,-rpath,$(QEMU_BUILD)

TARGET  := qemu-system-sparc-embed
SRCS    := main.c $(EMBED_DIR)/embed_qemu.c

.PHONY: all run-gr712rc run-gr740 qemu-lib install clean

all: $(TARGET)

$(TARGET): $(SRCS) $(EMBED_DIR)/embed_qemu.h
	$(CC) $(CFLAGS) $(SRCS) -o $@ $(LDFLAGS)

qemu-lib:
	@if [ ! -f "$(LIBQEMU)" ]; then \
		if [ ! -d "$(REPO)/qemu/build" ]; then \
			cd $(REPO)/qemu && mkdir build && cd build \
			    && ../configure --target-list=sparc-softmmu; \
		fi; \
		cd $(REPO)/qemu/build && ninja libqemu-sparc.so; \
	fi

run-gr712rc: qemu-lib $(TARGET)
	./$(TARGET) -M gr712rc -nographic -serial mon:stdio \
	    -kernel $(REPO)/apps/01-hello-rtems/hello.exe

run-gr740: qemu-lib $(TARGET)
	./$(TARGET) -M gr740 -nographic -serial mon:stdio \
	    -kernel $(REPO)/apps/07-hello-gr740/hello.exe

# Install to /usr/local/bin so the service finds it on PATH. Skip if
# you'd rather point the service at the build directory via env var:
#   QEMU_BINARY=$(REPO)/embed/examples/qemu-service/qemu-system-sparc-embed
install: $(TARGET)
	install -m 0755 $(TARGET) /usr/local/bin/$(TARGET)

clean:
	rm -f $(TARGET)
