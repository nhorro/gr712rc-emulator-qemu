# QEMU GR712RC — LEON3FT SMP Emulation

QEMU emulation of the **Cobham Gaisler GR712RC** dual-core LEON3FT SoC, targeting [RTEMS](https://www.rtems.org/) 5 applications built with the [RCC 1.3.2](https://www.gaisler.com/index.php/downloads/compilers) (RTEMS Compiler Collection) toolchain.

The QEMU machine type (`-M gr712rc`) is implemented as a patch on top of QEMU 8.2.2. It includes:

- Two LEON3FT cores, CPU 1 halted at reset and released by the IRQMP MPSTATUS register
- IRQMP interrupt controller with SMP CPU-release support (`cpu-start` GPIO)
- GPTIMER with 4 timers at 50 MHz
- APBUART-0 mapped to the QEMU serial port
- FTMCTRL register stub for MkProm compatibility
- AHB/APB Plug&Play ROM required by the RTEMS BSP auto-discovery
- Per-CPU `%asr17` returning the correct CPU ID in bits [31:28]

## Repository layout

```
qemu-gr712rc/
├── apps/
│   ├── 01-hello-rtems/       Single-core RTEMS hello world
│   ├── 02-dual-core-timer/   Dual-core SMP counter demo
│   ├── 03-five-uarts/        Five-UART traffic demo with TCP socket backends
│   └── 04-mkprom-boot/       Self-bootable PROM image built with mkprom2
├── qemu/                     QEMU 8.2.2 source tree (patched)
└── toolchain/                Gaisler tools (RCC, BCC2, mkprom2 — not in git)
```

## Prerequisites

- Linux host with standard build tools (`gcc`, `make`, `pkg-config`, `ninja`)
- QEMU build dependencies — on Debian/Ubuntu:

  ```
  sudo apt install git python3-pip libglib2.0-dev libpixman-1-dev \
      libslirp-dev ninja-build
  ```

- The RCC 1.3.2 toolchain is included under `toolchain/rcc-1.3.2-gcc/`. No separate installation is needed; the app Makefiles reference it by relative path.

## Building QEMU

Configure for the SPARC soft-MMU target only, then build:

```bash
cd qemu
mkdir -p build && cd build
../configure --target-list=sparc-softmmu
make -j$(nproc)
```

The emulator binary is at `qemu/build/qemu-system-sparc`.

## Building and running the applications

Each app has a `Makefile` with three targets: `all` (build), `run` (build + launch in QEMU), and `clean`.

### 01 — Hello RTEMS (single-core)

```bash
cd apps/01-hello-rtems
make run
```

Expected output:

```
*** GR712RC RTEMS Hello World ***
Running on QEMU gr712rc machine
*** END OF TEST ***
```

### 02 — Dual-core timer (SMP)

```bash
cd apps/02-dual-core-timer
make run
```

Expected output (counters from both cores interleaved):

```
Core 0: 10
Core 1: 20
Core 0: 11
Core 1: 21
...
```

Press **Ctrl-A X** to exit QEMU.

You can also run either binary directly:

```bash
./qemu/build/qemu-system-sparc -M gr712rc -nographic -kernel apps/02-dual-core-timer/dual_core_timer.exe
```

### 04 — MkProm self-bootable image

Same dual-core counter as example 02, but the ELF is wrapped by `mkprom2` into
a flat PROM image and booted via `-bios` (no `-kernel`, no QEMU-generated
trampoline). Requires `mkprom2` available at
`toolchain/mkprom2-2.0.69/mkprom2/mkprom2` (or pass `MKPROM=/path/to/mkprom2`):

```bash
cd apps/04-mkprom-boot
make run
```

See [`apps/04-mkprom-boot/README.md`](apps/04-mkprom-boot/README.md) for
details on the boot flow and `mkprom2` flags.

## QEMU patches

The following files in the QEMU tree are modified or added relative to the upstream 8.2.2 tag:

| File | Change |
|------|--------|
| `hw/sparc/gr712rc.c` | New — GR712RC machine definition |
| `include/hw/sparc/gr712rc.h` | New — GR712RC memory map constants |
| `hw/sparc/Kconfig` | Registers `gr712rc` machine |
| `hw/sparc/meson.build` | Adds `gr712rc.c` to the build |
| `configs/devices/sparc-softmmu/default.mak` | Enables `GR712RC` config symbol |
| `hw/intc/grlib_irqmp.c` | SMP: MPSTATUS CPU-release, per-CPU mask registers, `ncpu` property |
| `include/hw/sparc/grlib.h` | Adds `grlib_irqmp_ack_cpu` declaration |
| `target/sparc/cpu.h` | Adds `leon3_cpuid` field (preserved across CPU reset) |
| `target/sparc/cpu.c` | `cpu_sparc_set_id` stores CPU ID in `leon3_cpuid` |
| `target/sparc/translate.c` | `do_rd_leon3_config` reads `leon3_cpuid` for per-CPU `%asr17` |

## Development workflow

`qemu/` is a git submodule pointing to the patched QEMU fork
([nhorro/qemu-gr712rc-fork](https://github.com/nhorro/qemu-gr712rc-fork), branch `gr712rc`).
Clone everything with:

```bash
git clone --recurse-submodules git@github.com:nhorro/qemu-gr712rc.git
```

When you edit QEMU source files, commit and push **inside** `qemu/` first,
then update the submodule pointer in the parent repo:

```bash
# Inside qemu/
git add <changed files>
git commit -m "Description of QEMU change"
git push origin gr712rc

# Back in the parent repo
git add qemu
git commit -m "Update QEMU submodule: <same description>"
git push origin main
```

See [docs/05-contributing.md](docs/05-contributing.md) for the full workflow including
toolchain setup, fresh QEMU builds, and rebasing on upstream releases.

## Developer documentation

See the [`docs/`](docs/) directory for guides aimed at contributors who are
familiar with SPARC / GR712RC development but new to QEMU internals:

- [QEMU primer for TSIM/TEMU users](docs/01-qemu-primer.md) — TCG, device model, IRQ wiring
- [Code map](docs/02-code-map.md) — where to find things in the source tree
- [Adding a peripheral](docs/03-adding-a-peripheral.md) — step-by-step walkthrough
- [Debugging guide](docs/04-debugging.md) — GDB, QEMU monitor, tracing, common failures

## Notes

- **Debugging unmodeled peripherals**: Run QEMU with `-d guest_errors,unimp` to see `[gr712rc-diag]` log lines for any access to an unmodeled peripheral address. Each line includes the CPU index, PC, address, size, direction, and (for writes) the value. Add `-d int` to also log every SPARC trap entry. See [docs/04-debugging.md §7](docs/04-debugging.md) for details.

- **FPU and SMP**: RTEMS 5 in SMP mode uses synchronous (not lazy) FP context switching. Tasks that call `printf` or any function generating FP instructions must be created with the `RTEMS_FLOATING_POINT` attribute; otherwise a `fp_disabled` trap fires a fatal error at runtime.

- **Cache snooping**: The RTEMS LEON3 SMP BSP checks `CACHE_CTRL_DS` (bit 23 of the cache control register) on startup and aborts if it is not set. `gr712rc_cpu_reset` sets `env->cache_control = CACHE_CTRL_DS` for both CPUs to satisfy this check.

- **Secondary CPU startup**: CPU 1 starts halted. RTEMS's `_CPU_SMP_Start_processor` writes a bitmask to the IRQMP MPSTATUS register (offset 0x10); each set bit releases the corresponding CPU. The QEMU IRQMP model fires the `cpu-start` GPIO, which clears `cs->halted` and kicks the vCPU thread.
