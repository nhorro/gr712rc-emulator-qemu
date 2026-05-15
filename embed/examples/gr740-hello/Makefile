# GR740 hello-world example: drives a QEMU GR740 RTEMS guest from a
# custom main() that links against QEMU as a library.
#
# The host driver C source lives in the submodule at
# qemu/examples/embed-gr740/main.c and is built by qemu/meson.build as
# a separate binary (embed-gr740) alongside qemu-system-sparc, sharing
# the same static library libqemu-sparc-softmmu.fa.
#
# This Makefile only orchestrates: build the GR740 kernel (delegated
# to apps/07-hello-gr740), confirm the embed-gr740 binary exists,
# invoke it, and surface the captured UART output.

REPO     := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBEDDER := $(REPO)/qemu/build/embed-gr740
APP_DIR  := $(REPO)/apps/07-hello-gr740
KERNEL   := $(APP_DIR)/hello.exe

DT_US    ?= 1000
N_STEPS  ?= 2000
UART_LOG := /tmp/embed-gr740-uart.log
RUN_LOG  := /tmp/embed-gr740-run.log

.PHONY: all run kernel check-embedder clean show

all: run

kernel: $(KERNEL)

$(KERNEL):
	$(MAKE) -C $(APP_DIR)

check-embedder:
	@if [ ! -x "$(EMBEDDER)" ]; then \
		echo "ERROR: $(EMBEDDER) not found."; \
		echo ""; \
		echo "Build QEMU first:"; \
		echo "  cd $(REPO)/qemu/build && ninja embed-gr740"; \
		echo ""; \
		echo "If qemu/build does not exist, configure it:"; \
		echo "  cd $(REPO)/qemu && mkdir -p build && cd build \\"; \
		echo "      && ../configure --target-list=sparc-softmmu \\"; \
		echo "      && ninja embed-gr740"; \
		exit 1; \
	fi

run: $(KERNEL) check-embedder
	@echo ">>> embed-gr740 example"
	@echo "    kernel : $(KERNEL)"
	@echo "    dt     : $(DT_US) us"
	@echo "    n_steps: $(N_STEPS)"
	@echo "    UART   : $(UART_LOG)"
	@echo ""
	@rm -f $(UART_LOG) $(RUN_LOG)
	$(EMBEDDER) $(KERNEL) $(DT_US) $(N_STEPS) 2>&1 | tee $(RUN_LOG)
	@echo ""
	@echo "----- UART output captured -----"
	@cat $(UART_LOG) 2>/dev/null || echo "(no UART output)"
	@echo "--------------------------------"

show:
	@cat $(UART_LOG) 2>/dev/null || echo "(no log; run 'make run' first)"

clean:
	$(MAKE) -C $(APP_DIR) clean
	rm -f $(UART_LOG) $(RUN_LOG)
