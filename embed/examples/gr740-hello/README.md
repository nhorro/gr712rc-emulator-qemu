# GR740 hello-world embedding example

Demonstrates the QEMU-as-library embedding model with the GR740 LEON4
machine. A custom `main()` (in
[`qemu/examples/embed-gr740/main.c`](../../../qemu/examples/embed-gr740/main.c))
calls `qemu_init()`, drives the GR740 forward in 1 ms wall-clock
slices, captures UART output, and tears down with `qemu_cleanup()`.
There are no flags on `qemu-system-sparc`: this is a separate binary
(`embed-gr740`) linked against the same QEMU static library.

The guest is the GR740 RTEMS hello-world application from
[`apps/07-hello-gr740`](../../../apps/07-hello-gr740) — single core,
prints three lines, calls `exit(0)`.

## Build

The example binary is built by the QEMU build system because it
shares object files with `qemu-system-sparc`. First-time build:

```bash
cd qemu && mkdir -p build && cd build
../configure --target-list=sparc-softmmu
ninja embed-gr740
```

If `qemu/build/` already exists, just:

```bash
cd qemu/build && ninja embed-gr740
```

The GR740 kernel is built on demand by the example Makefile.

## Run

From the repo root:

```bash
make -C embed/examples/gr740-hello run
```

Expected output (UART tail, abbreviated):

```
*** GR740 RTEMS Hello World ***
Running on QEMU
*** END OF TEST ***
```

The `embed-gr740` summary on stderr shows the step-loop telemetry:

```
steps completed:  2000 / 2000
terminated by:    step budget
total wall:       ~2240 ms
mean wall/step:   ~1120000 ns
```

Mean wall/step ≈ 1.12 ms is the expected operating point (p50 ≈ 1.10×
of the requested 1 ms `dt`). See [`NOTES.md`](../../../NOTES.md) for
the granularity sweep that established this.

## Variables

| Variable  | Default | Meaning                          |
|---        |---      |---                               |
| `DT_US`   | 1000    | Step size in microseconds        |
| `N_STEPS` | 2000    | Total number of steps to run     |

```bash
make -C embed/examples/gr740-hello run DT_US=500 N_STEPS=4000
```

## Architecture

```
embed/examples/gr740-hello/   (this dir — consumer-side glue)
    Makefile                  orchestration + invocation
    README.md                 this file

qemu/examples/embed-gr740/    (host driver source, inside submodule)
    main.c                    own int main(), calls qemu_init/cleanup
                              and drives the step loop

qemu/build/embed-gr740        produced binary; links against
                              libqemu-sparc-softmmu.fa
```

The host driver C source lives inside the QEMU submodule today
because that is where `meson.build` lives — meson aggregates QEMU's
internal object files into a single static library and the driver
must be linked against it from inside the same build tree.

When `libqemu-system-sparc.so` is available (deuda #1 of
`NOTES.md`'s "Open technical issues"), the driver source can move out
of the submodule into this directory and link against the `.so` from
a standalone Makefile. The Makefile target stays the same; only the
build steps change.

## Caveats

- `embed-gr740` is built only when the host configures QEMU for the
  `sparc-softmmu` target. Other target configurations skip it.
- The UART log path is hardcoded to `/tmp/embed-gr740-uart.log` in
  the driver. Adjust the C source if you need a different location.
- The example uses `QEMU_CLOCK_REALTIME`. For deterministic replay
  you would need `QEMU_CLOCK_VIRTUAL` + `-icount`, currently blocked
  by two GR712RC/GR740-model issues documented in `NOTES.md`.
- The hello guest reaches `exit(0)` but RTEMS does not shut down
  QEMU's runstate — vCPUs simply halt. The example keeps stepping
  past the guest exit (idle vCPUs, wall clock keeps ticking) until
  the step budget is exhausted. The captured UART log shows the
  guest finished before the loop did.
