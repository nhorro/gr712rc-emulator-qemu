# QEMU GR712RC / GR740 — LEON3/LEON4 SMP Emulation

QEMU emulation of two Cobham Gaisler space-grade SoCs, targeting [RTEMS](https://www.rtems.org/) 5 applications built with the [RCC 1.3.2](https://www.gaisler.com/index.php/downloads/compilers) (RTEMS Compiler Collection) toolchain:

- **`-M gr712rc`** — dual-core LEON3FT
- **`-M gr740`** — quad-core LEON4 (NGMP)

![Screenshot](./docs/assets/screenshot.png)

Both machine types are implemented as patches on top of QEMU 8.2.2.

`-M gr712rc` includes:

- Two LEON3FT cores, CPU 1 halted at reset and released by the IRQMP MPSTATUS register
- IRQMP interrupt controller with SMP CPU-release support (`cpu-start` GPIO)
- GPTIMER with 4 timers at 50 MHz
- APBUART-0 mapped to the QEMU serial port (UARTs 1–4 available with `-serial tcp::PORT`)
- FTMCTRL register stub for MkProm compatibility
- AHB/APB Plug&Play ROM required by the RTEMS BSP auto-discovery
- Per-CPU `%asr17` returning the correct CPU ID in bits [31:28]
- Scriptable AMBA devices (Lua + YAML) for prototyping

`-M gr740` includes:

- Four LEON4 cores (modeled as LEON3 — the LEON4 ISA is SPARC V8 + same ASIs); CPUs 1–3 halted at reset and released individually via IRQMP MPSTATUS
- NGMP memory map: SDRAM at `0x00000000` (via L2C), PROM at `0xC0000000`, L2C registers at `0xF0000000`, single APB bridge at `0xFF900000`, AHB PnP at `0xFFFFF000`
- IRQMP, GPTIMER (4 timers), APBUART-0 — all PnP-discoverable
- L2 cache controller register-storage stub at `0xF0000000`
- Per-CPU `%asr17` for CPU IDs 0–3

## Repository layout

```
qemu-gr712rc/
├── apps/
│   ├── 01-hello-rtems/       Single-core RTEMS hello world (gr712rc)
│   ├── 02-dual-core-timer/   Dual-core SMP counter demo (gr712rc)
│   ├── 03-five-uarts/        Five-UART traffic demo with TCP socket backends
│   ├── 04-mkprom-boot/       Self-bootable PROM image built with mkprom2
│   ├── 05-scriptable-stub/   Scriptable AMBA device (Lua + YAML)
│   ├── 07-hello-gr740/       Single-core RTEMS hello world (gr740)
│   └── 08-gr740-smp/         Quad-core SMP counter demo (gr740)
├── embed/                    Consumer code for QEMU-as-library embedding
│   ├── embed_qemu.{h,c}      Example wrapper over libqemu.h (init/step/cleanup)
│   └── examples/
│       ├── gr740/            Minimal 5 s × 5 ms timing demo on -M gr740
│       └── gr712rc/          Minimal 5 s × 5 ms timing demo on -M gr712rc
├── qemu/                     QEMU 8.2.2 source tree (patched)
│   ├── include/libqemu.h     Public SDK header for libqemu-sparc.so
│   └── system/embed_api.c    Fork-only helpers exported by the .so
└── toolchain/                Gaisler tools (RCC, BCC2, mkprom2 — not in git)
```

## Embedding the emulator as a library

The `embed/` subtree and the `qemu/include/libqemu.h` SDK header
support running QEMU **inside another program** instead of as a
separate `qemu-system-sparc` process. A host links against
`libqemu-sparc.so` (produced by `make -C embed/examples/gr740
qemu-lib`) and drives the emulator forward in fixed wall-clock
slices via three functions (`embed_qemu_init` / `embed_qemu_step`
/ `embed_qemu_cleanup`) or directly against the SDK header.

See [docs/11-embedding-as-library.md](docs/11-embedding-as-library.md)
for the operator reference: build setup, API description, the
operating point (5 ms REALTIME) chosen from a multi-core dt-sweep,
the bundled timing examples, error handling discipline, and
limitations.

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

## Running as a service (Docker + HTTP/WebSocket API)

For demos and UI integration, the emulator is also wrapped in a Python
adapter service that exposes load / start / pause / resume / reset and
UART streaming over HTTP + WebSocket. Bring it up with:

```bash
docker compose up --build
# → service is listening on http://localhost:8080
# → Swagger UI at http://localhost:8080/docs
```

ELFs built locally with the FSW toolchain are uploaded via
`POST /uploads`, then driven through `POST /session` and
`POST /session/start`. UART output streams over `WS /ws/uart/{n}`.

See [`docs/07-adapter-api.md`](docs/07-adapter-api.md) for the full
API contract and [`docs/08-running-the-service.md`](docs/08-running-the-service.md)
for a worked walkthrough.

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

### 03 — Five UARTs with TCP socket backends

Sends a periodic counter on every APBUART. UART-0 uses the console
(`printf`); UARTs 1–4 write directly to their APBUART TX register and are
exposed by QEMU as TCP listeners on ports 5001–5004:

```bash
cd apps/03-five-uarts
make run
```

Connect to any of the side UARTs from another terminal with `nc`:

```bash
nc localhost 5001
```

See [`docs/06-uart-socket-interface.md`](docs/06-uart-socket-interface.md)
for the QEMU `-serial tcp::PORT,server,nowait` flags and the AMBA PnP
discovery flow that lets RTEMS find UARTs 1–4 without hardcoded addresses.

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

### 05 — Scriptable AMBA device (Lua + YAML)

Demonstrates the scriptable-device infrastructure: a Lua script implements
a tiny MMIO peripheral (a register file, an IRQ-pulse trigger), the device
is wired into the AMBA map by a YAML config, and an RTEMS app exercises
each behaviour. Requires `liblua5.4-dev` and `libyaml-dev`:

```bash
sudo apt install -y liblua5.4-dev libyaml-dev
cd apps/05-scriptable-stub
make run
```

Expected output (all checks PASS):

```
status[0x4]          got=0xcafe0000 want=0xcafe0000 PASS
scratch r/w          got=0xdeadbeef want=0xdeadbeef PASS
unmapped[0x8]        got=0x00000000 want=0x00000000 PASS
irq pending before   got=0x00000000 want=0x00000000 PASS
irq pending after    got=0x00001000 want=0x00001000 PASS
irq pending cleared  got=0x00000000 want=0x00000000 PASS
*** END OF TEST ***
```

QEMU loads `gr712rc-scriptable.yaml` from the working directory (absent
file → no scripted devices). The script's `read` / `write` callbacks
have access to a `sim` table for logging, virtual time, and IRQ control.
See [`docs/04-debugging.md §7`](docs/04-debugging.md) for the
`gr712rc-diag` log format that catches accesses to unmodeled peripherals.

### 07 — Hello world on GR740 (single-core)

```bash
cd apps/07-hello-gr740
make run
```

Expected output:

```
*** GR740 RTEMS Hello World ***
Running on QEMU
*** END OF TEST ***
```

Built with `-qbsp=gr740`; runs on `-M gr740`. CPUs 1–3 stay halted; only
CPU 0 executes the Init task. The kernel ELF is linked at physical
`0x00000000` (NGMP SDRAM via L2C); a 5-instruction trampoline in PROM at
`0xC0000000` jumps to the kernel entry on reset.

### 08 — Quad-core timer on GR740 (SMP)

```bash
cd apps/08-gr740-smp
make run
```

Expected output (counters from all four cores interleaved):

```
Core 0: 10
Core 1: 20
Core 2: 30
Core 3: 40
Core 0: 11
Core 1: 21
...
```

Built with `-qbsp=gr740_smp`; runs on `-M gr740 -smp 4`. One affinity-pinned
counter task per CPU. Each per-CPU clock interrupt is dispatched through
IRQMP, confirming the `cpu-start` MPSTATUS-release path works for all
three secondary CPUs.

## QEMU patches

The following files in the QEMU tree are modified or added relative to the upstream 8.2.2 tag:

| File | Change |
|------|--------|
| `hw/sparc/gr712rc.c` | New — GR712RC machine definition |
| `hw/sparc/gr712rc.h` | New — GR712RC memory map constants |
| `hw/sparc/gr740.c` | New — GR740 machine definition |
| `hw/sparc/gr740.h` | New — GR740 memory map constants |
| `hw/sparc/Kconfig` | Registers `gr712rc` and `gr740` machines |
| `hw/sparc/meson.build` | Adds `gr712rc.c` and `gr740.c` to the build |
| `configs/devices/sparc-softmmu/default.mak` | Enables `GR712RC` and `GR740` config symbols |
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
- [Adapter service & API specification](docs/07-adapter-api.md) — v0 contract for the HTTP/WebSocket service
- [Running the service](docs/08-running-the-service.md) — Docker walkthrough, sample curl/wscat invocations

## Notes

- **Debugging unmodeled peripherals**: Run QEMU with `-d guest_errors,unimp` to see `[gr712rc-diag]` log lines for any access to an unmodeled peripheral address. Each line includes the CPU index, PC, address, size, direction, and (for writes) the value. Add `-d int` to also log every SPARC trap entry. See [docs/04-debugging.md §7](docs/04-debugging.md) for details.

- **FPU and SMP**: RTEMS 5 in SMP mode uses synchronous (not lazy) FP context switching. Tasks that call `printf` or any function generating FP instructions must be created with the `RTEMS_FLOATING_POINT` attribute; otherwise a `fp_disabled` trap fires a fatal error at runtime.

- **Cache snooping**: The RTEMS LEON3 SMP BSP checks `CACHE_CTRL_DS` (bit 23 of the cache control register) on startup and aborts if it is not set. `gr712rc_cpu_reset` sets `env->cache_control = CACHE_CTRL_DS` for both CPUs to satisfy this check.

- **Secondary CPU startup**: CPU 1 starts halted. RTEMS's `_CPU_SMP_Start_processor` writes a bitmask to the IRQMP MPSTATUS register (offset 0x10); each set bit releases the corresponding CPU. The QEMU IRQMP model fires the `cpu-start` GPIO, which clears `cs->halted` and kicks the vCPU thread.
