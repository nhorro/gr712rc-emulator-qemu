# GR712RC dual-core embedding example: drives a QEMU GR712RC SMP
# RTEMS guest from a custom main() that links against QEMU as a
# library.
#
# Mirrors gr740-hello/Makefile; only the binary name and the kernel
# differ. The embedding API (embed_qemu_*) is shared via
# qemu/examples/embed-common/.

REPO     := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../..)
EMBEDDER := $(REPO)/qemu/build/embed-gr712rc-smp
APP_DIR  := $(REPO)/apps/02-dual-core-timer
KERNEL   := $(APP_DIR)/dual_core_timer.exe

DT_US    ?= 1000
N_STEPS  ?= 3000
UART_LOG := /tmp/embed-gr712rc-smp-uart.log
RUN_LOG  := /tmp/embed-gr712rc-smp-run.log

.PHONY: all run kernel check-embedder clean show

all: run

kernel: $(KERNEL)

$(KERNEL):
	$(MAKE) -C $(APP_DIR)

check-embedder:
	@if [ ! -x "$(EMBEDDER)" ]; then \
		echo "ERROR: $(EMBEDDER) not found."; \
		echo ""; \
		echo "Build it from the qemu/build tree:"; \
		echo "  cd $(REPO)/qemu/build && ninja embed-gr712rc-smp"; \
		echo ""; \
		echo "If qemu/build does not exist, configure it:"; \
		echo "  cd $(REPO)/qemu && mkdir -p build && cd build \\"; \
		echo "      && ../configure --target-list=sparc-softmmu \\"; \
		echo "      && ninja embed-gr712rc-smp"; \
		exit 1; \
	fi

run: $(KERNEL) check-embedder
	@echo ">>> embed-gr712rc-smp example"
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
