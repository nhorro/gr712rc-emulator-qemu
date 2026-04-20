# Developer Documentation

| Document | Contents |
|----------|---------|
| [01-qemu-primer.md](01-qemu-primer.md) | QEMU architecture explained for TSIM / TEMU / GRSIM users: TCG, QOM type system, MemoryRegion, qemu_irq, timers, and how a bus cycle travels from RTEMS to a device and back. |
| [02-code-map.md](02-code-map.md) | Where to find things: relevant files in the QEMU tree, the GR712RC memory map, RTEMS BSP source files worth reading, and the Kconfig / Meson build wiring. |
| [03-adding-a-peripheral.md](03-adding-a-peripheral.md) | Step-by-step walkthrough for adding a new GRLIB APB device (OCCAN stub as example), including build system integration, APB PnP registration, IRQ wiring, and timer-driven devices. |
| [04-debugging.md](04-debugging.md) | GDB remote debugging, QEMU monitor commands, the trace subsystem, quick fprintf instrumentation, and a catalogue of common failure modes with root causes and fixes. |
| [05-contributing.md](05-contributing.md) | Git workflow for this repo: cloning with submodules, editing QEMU source and committing to the fork, updating the submodule pointer, toolchain setup, and rebasing on upstream QEMU releases. |
