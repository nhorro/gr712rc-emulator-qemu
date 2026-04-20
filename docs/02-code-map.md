# Code Map

Where to find things in this repository.

---

## Repository root

```
qemu-gr712rc/
├── apps/                   RTEMS application sources
│   ├── 01-hello-rtems/     Single-core hello world
│   └── 02-dual-core-timer/ Dual-core SMP counter demo
├── docs/                   This documentation
├── qemu/                   QEMU 8.2.2 source tree (patched)
└── toolchain/
    └── rcc-1.3.2-gcc/      sparc-gaisler-rtems5-gcc cross-compiler
```

---

## QEMU source tree — files you will touch

The vast majority of the QEMU tree is upstream and unchanged.  The files
relevant to this project are:

### Machine and board

| File | Purpose |
|------|---------|
| `hw/sparc/gr712rc.c` | **GR712RC machine definition.**  Top-level init: instantiates all devices, wires IRQs, loads the ELF or PROM image.  Start here when adding a new peripheral. |
| `include/hw/sparc/gr712rc.h` | Memory map constants, device addresses, IRQ assignments, clock frequency. |
| `hw/sparc/Kconfig` | Enables `CONFIG_GR712RC` and selects `CONFIG_GRLIB`. |
| `hw/sparc/meson.build` | Adds `gr712rc.c` to the build when `CONFIG_GR712RC` is set. |
| `configs/devices/sparc-softmmu/default.mak` | Sets `CONFIG_GR712RC=y` for the SPARC softmmu target. |

### Implemented GRLIB peripherals

| File | Device | APB address | IRQ(s) |
|------|--------|-------------|--------|
| `hw/intc/grlib_irqmp.c` | IRQMP — interrupt controller | 0x80000200 | — (routes all) |
| `hw/timer/grlib_gptimer.c` | GPTIMER — 4 timers | 0x80000300 | 8–11 |
| `hw/char/grlib_apbuart.c` | APBUART-0 — serial console | 0x80000100 | 2 |
| `hw/misc/grlib_ahb_apb_pnp.c` | AHB/APB Plug&Play ROM | 0xFFFFF000 / 0x800FF000 | — |

### CPU

| File | Purpose |
|------|---------|
| `target/sparc/cpu.h` | `CPUSPARCState` — the full SPARC register file. Fields after `end_reset_fields` are preserved across CPU reset. |
| `target/sparc/cpu.c` | CPU lifecycle: `sparc_cpu_reset_hold`, `cpu_sparc_set_id` (sets per-CPU `%asr17` identity). |
| `target/sparc/translate.c` | TCG front-end: disassembly → TCG IR.  `do_rd_leon3_config` generates `%asr17` reads. |
| `target/sparc/win_helper.c` | SPARC window spill/fill and PSR helpers.  `cpu_put_psr_raw` controls PSR.EF. |
| `target/sparc/int_helper.c` | Trap delivery and interrupt helpers. |

### GRLIB shared header

| File | Purpose |
|------|---------|
| `include/hw/sparc/grlib.h` | Device type name strings, exported functions (`grlib_irqmp_ack`, `grlib_irqmp_ack_cpu`). |

---

## Memory map summary

Addresses used by the GR712RC machine (`gr712rc.h`):

```
0x00000000  PROM (8 MiB, ROM)          — boot SPARC code / MkProm image
0x40000000  SDRAM (64 MiB default)     — RTEMS application code and heap
0x80000000  FTMCTRL registers (256 B)  — absorbs MkProm MCFG1/MCFG2 writes
0x80000100  APBUART-0 (256 B)          — UART console, IRQ 2
0x80000200  IRQMP (256 B)              — interrupt multiplexer
0x80000300  GPTIMER (256 B)            — 4 timers, base IRQ 8
0x800FF000  APB-1 Plug&Play ROM
0xFFFFF000  AHB Plug&Play ROM
```

Gaps to fill for a complete GR712RC (APB bridge 2 at 0x80100000 has no devices):

```
0x80000400  GRCAN / OCCAN-0            not yet implemented
0x80000500  OCCAN-1                    not yet implemented
0x80100000  (APB bridge 2 devices)
    SpaceWire (GRSPW2), additional UARTs, etc.
```

---

## RTEMS / toolchain source files of interest

These are in `toolchain/rcc-1.3.2-gcc/src/rcc-1.3.2/` and are read-only
references — you build RTEMS through the RCC toolchain, not from this source
tree.  They are useful for understanding what the BSP expects from hardware.

| File | What it tells you |
|------|-------------------|
| `bsps/sparc/leon3/include/leon.h` | IRQMP register layout, `LEON3_IrqCtrl_Regs`, `LEON3_mp_irq = 14`, `LEON3_ASR17_PROCESSOR_INDEX_SHIFT = 28` |
| `bsps/sparc/leon3/start/bspstart.c` | LEON3 BSP startup: PnP scan, UART/timer init |
| `bsps/sparc/leon3/start/bspsmp.c` | SMP startup: `_CPU_SMP_Start_processor` writes MPSTATUS, `bsp_start_on_secondary_processor` unmasks IPI IRQ |
| `bsps/sparc/leon3/start/bspclean.c` | `bsp_fatal_extension`: polls MPSTATUS up to 1 234 567 times waiting for secondary CPUs to halt |
| `bsps/sparc/shared/start/start.S` | `hard_reset`: reads `%asr17` to detect CPU ID, sets PSR.EF=1 |
| `cpukit/score/cpu/sparc/cpu.c` | `_CPU_Context_Initialize`: task PSR setup.  PSR.EF is set **only** if `is_fp` is true (task created with `RTEMS_FLOATING_POINT`). |
| `cpukit/score/cpu/sparc/include/rtems/score/cpu.h` | `SPARC_USE_LAZY_FP_SWITCH` (uniprocessor) vs `SPARC_USE_SYNCHRONOUS_FP_SWITCH` (SMP). In SMP mode `fp_disabled` trap is fatal. |

---

## Kconfig / build system

Adding a new peripheral involves touching three build files:

1. **`hw/sparc/Kconfig`** — the peripheral is already selected via `CONFIG_GRLIB`
   (which `CONFIG_GR712RC` selects).  For a new non-GRLIB device, add a `select`
   line.

2. **`hw/<subsystem>/meson.build`** — add the new `.c` file under the
   `CONFIG_GRLIB` condition:
   ```meson
   system_ss.add(when: 'CONFIG_GRLIB', if_true: files('grlib_newdev.c'))
   ```

3. **`hw/sparc/gr712rc.c`** — instantiate and wire the device in `gr712rc_hw_init`.

No changes to `configs/devices/sparc-softmmu/default.mak` are needed as long as
the new device is gated on `CONFIG_GRLIB`.

---

## Build outputs

After `make -j$(nproc)` in `qemu/build/`:

```
qemu/build/qemu-system-sparc      — the emulator binary
qemu/build/trace/generated-*.h   — auto-generated trace event headers
```

Incremental rebuilds are fast; only files that changed are recompiled.
