# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

QEMU emulation of the **Cobham Gaisler GR712RC** dual-core LEON3FT SoC, targeting RTEMS 5 applications built with the RCC 1.3.2 toolchain. The emulation is implemented as a patch set on top of QEMU 8.2.2, carried as a git submodule at `qemu/` (fork: `nhorro/qemu-gr712rc-fork`, branch `gr712rc`).

## Repository structure

- `qemu/` — **git submodule** containing the patched QEMU 8.2.2 source tree. Changes here require a commit inside the submodule *and* a parent-repo commit updating the submodule pointer (see "QEMU submodule workflow" below).
- `apps/` — RTEMS sample applications (`01-hello-rtems`, `02-dual-core-timer`, `03-five-uarts`). Each has a self-contained Makefile.
- `toolchain/rcc-1.3.2-gcc/` — the Gaisler cross-compiler (`sparc-gaisler-rtems5-gcc`). Not stored in git; must be downloaded from Gaisler and extracted here. App Makefiles reference it by relative path.
- `docs/` — contributor guides (QEMU primer, code map, adding peripherals, debugging, UART sockets). Read these first when extending the emulation.

## Common commands

### Building QEMU (first time, or after QEMU source changes)

```bash
cd qemu && mkdir -p build && cd build
../configure --target-list=sparc-softmmu
make -j$(nproc)
```

Incremental rebuild only: `make -j$(nproc) qemu-system-sparc` inside `qemu/build/`. The binary lands at `qemu/build/qemu-system-sparc`.

### Building and running apps

Each app has `all`, `run`, and `clean` targets:

```bash
make -C apps/02-dual-core-timer run
```

Running directly:

```bash
./qemu/build/qemu-system-sparc -M gr712rc -nographic \
    -kernel apps/02-dual-core-timer/dual_core_timer.exe
```

Exit QEMU with **Ctrl-A X**; enter the QEMU monitor with **Ctrl-A C**.

### Debugging

Launch QEMU with `-s -S` for a GDB server on `:1234` paused at reset, then attach:

```bash
./toolchain/rcc-1.3.2-gcc/bin/sparc-gaisler-rtems5-gdb apps/<app>/<bin>.exe
(gdb) target remote :1234
```

Device tracing: `-trace grlib_irqmp_set_irq`, `-trace "grlib*"`, etc. `qemu-system-sparc -trace help | grep grlib` lists events.

Verify memory map from the monitor with `info mtree`.

## Architecture — what requires reading multiple files to understand

### GR712RC machine wiring lives in three coordinated places

Adding or modifying a peripheral touches all of these:

1. `qemu/hw/sparc/gr712rc.c` — `gr712rc_hw_init` instantiates devices, calls `sysbus_mmio_map`, and connects IRQs to IRQMP via `sysbus_connect_irq`. Also registers APB/AHB Plug&Play ROM entries so the RTEMS BSP auto-discovers the device.
2. `qemu/include/hw/sparc/gr712rc.h` — memory map constants and IRQ numbers.
3. `qemu/hw/<subsystem>/meson.build` — adds the `.c` file under `CONFIG_GRLIB` (which `CONFIG_GR712RC` already selects, so no Kconfig changes are needed for GRLIB peripherals).

The RTEMS BSP will not find a device unless it is in the PnP ROM — `sysbus_mmio_map` alone is not enough. `docs/03-adding-a-peripheral.md` is the canonical walkthrough.

### SMP startup is load-bearing and fragile

Several pieces must agree or the system silently hangs at boot:

- CPU 1 starts halted. RTEMS's `_CPU_SMP_Start_processor` writes a bitmask to the IRQMP MPSTATUS register (offset 0x10); the patched `hw/intc/grlib_irqmp.c` fires a named `"cpu-start"` GPIO for each set bit, which `gr712rc_cpu_start` uses to clear `cs->halted` and kick the vCPU thread. The `"cpu-start"` wiring in `gr712rc_hw_init` must be present.
- Per-CPU `%asr17` must return the correct CPU ID in bits [31:28]. This is threaded through `cpu_sparc_set_id` → `env->leon3_cpuid` (a reset-preserved field) → `do_rd_leon3_config` in `target/sparc/translate.c`. If either CPU reads 0, both take the primary boot path and corrupt shared state.
- `gr712rc_cpu_reset` sets `env->cache_control = CACHE_CTRL_DS` for both CPUs. RTEMS SMP BSP aborts at startup if bit 23 of the cache control register is not set.
- Silent hangs accompanied by ~1.2M repeated reads of 0x80000210 indicate `bsp_fatal_extension` polling MPSTATUS — a secondary CPU never reached ready state. See `docs/04-debugging.md` §5.

### FPU and SMP interaction

RTEMS 5 in SMP mode uses **synchronous** (not lazy) FP context switching, so a `fp_disabled` trap is always fatal. Any task that calls `printf` or otherwise emits FP instructions must be created with `RTEMS_FLOATING_POINT`; otherwise the system fatals with `INTERNAL_ERROR_ILLEGAL_USE_OF_FLOATING_POINT_UNIT` (code 38). This is a common footgun when adapting sample code.

### BSP selection per app

The app Makefile `BSP` variable picks between `gr712rc` (single-core, app 01) and `gr712rc_smp` (SMP, apps 02/03). The BSP is passed to the toolchain via `-qbsp=$(BSP)`.

### UART backends

APBUART-0 is always the `-serial` #0 console. APBUARTs 1–4 exist in the PnP ROM but have no backend unless `-serial` options are supplied (`tcp::<port>,server,nowait` is the standard pattern for co-simulation — see `docs/06-uart-socket-interface.md` and app 03's Makefile). QEMU maps `-serial` options to UARTs in order.

## QEMU submodule workflow (important)

The `qemu/` directory is a git submodule. Changes to QEMU source require **two commits**:

```bash
# 1. Inside the submodule
cd qemu
git add <files>
git commit -m "..."
git push origin gr712rc

# 2. Back in the parent repo — advances the submodule pointer
cd ..
git add qemu
git commit -m "Update QEMU submodule: ..."
git push origin main
```

Step 2 is easy to forget; without it, collaborators checking out `main` still see the old QEMU SHA. Fresh clones must use `git clone --recurse-submodules` (or `git submodule update --init` after the fact). Full workflow including upstream rebases is in `docs/05-contributing.md`.

## Where the patches live

All modifications relative to upstream QEMU 8.2.2 are listed in the README "QEMU patches" table. The key files are:

- `hw/sparc/gr712rc.c` + `include/hw/sparc/gr712rc.h` — new machine.
- `hw/sparc/gr740.c` + `include/hw/sparc/gr740.h` — second machine (LEON4 NGMP).
- `hw/intc/grlib_irqmp.c` — SMP extensions (MPSTATUS CPU release, per-CPU mask registers, `ncpu` property, `cpu-start` GPIO).
- `target/sparc/cpu.{h,c}` + `target/sparc/translate.c` — per-CPU `%asr17` via `leon3_cpuid`.
- `include/libqemu.h` + `include/sysemu/embed_api.h` + `include/sysemu/embed_machine_hooks.h` + `system/embed_api.{c,map}` — the embedding SDK (`libqemu-sparc.so`). See `docs/11-embedding-as-library.md` and `docs/12-host-side-peripherals.md`.

`docs/02-code-map.md` is the authoritative index of which files to touch for which concern.

## Adding peripherals — two paths

Two non-overlapping ways to put MMIO at a given address on the bus:

1. **Native (recommended for reusable / upstream-bound peripherals)** — write a QOM device under `qemu/hw/...`, wire it from `gr712rc.c`/`gr740.c`. Full walkthrough in `docs/03-adding-a-peripheral.md`. Required if the device must work in standalone `qemu-system-sparc`, persist across `savevm`/`loadvm`, or eventually go upstream.
2. **Host-side via SDK (recommended for project-specific / iterative work)** — implement the peripheral as plain host code in `embed/` or your own program, register it at runtime with `embed_register_peripheral(...)`. No QEMU rebuild per peripheral, no submodule commit. Full reference in `docs/12-host-side-peripherals.md`. Trades off PnP-ROM autodiscovery (which the SDK does support if you fill the `pnp_*` fields), `savevm` persistence, and standalone-binary compatibility.

Both paths share `address_space_memory` and coexist on the same machine binary.
