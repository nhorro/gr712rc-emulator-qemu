# Embedding QEMU as a library

Run the GR712RC / GR740 emulator **inside another program** — a
proprietary simulator, a HIL test harness, a co-simulation
scheduler — instead of as a separate `qemu-system-sparc` process.
The fork produces a shared library (`libqemu-sparc.so`) and a
public C header (`libqemu.h`) that together form a self-contained
SDK; an external host links against them and drives QEMU
step-by-step in wall-clock slices.

This document is the operator reference. For the day-by-day
narrative of how the design got here, see the "Design journey"
section at the end.

## Overview

```
+-------------------------+      +-------------------+
| your host application   |      |  libqemu-sparc.so |
|  (.c + your own main)   | ---> |  - 20 exported    |
|  #include <libqemu.h>   |      |    symbols        |
|  -L .../qemu/build      |      |  - supports both  |
|  -lqemu-sparc           |      |    -M gr712rc and |
+-------------------------+      |    -M gr740       |
                                 +-------------------+
```

This document covers the *lifecycle and timing* surface: getting the
emulator running, stepping it, and tearing it down. For
**registering peripherals**, **driving MMIO**, and **raising
interrupts** from host code, see
[Host-side peripherals via the SDK](12-host-side-peripherals.md).

The host calls `qemu_init(argc, argv)` with an argv that selects
machine, kernel, peripherals, etc. — the same shape
`qemu-system-sparc` accepts on the command line. It then drives the
emulator forward with `vm_start()` + `main_loop_wait()` + `vm_stop()`,
and tears down with `qemu_cleanup(0)`.

The SDK is a **pair of files**: the `.so` and the header. Everything
else in this repo is either build infrastructure or example code.

## Quick start

From the repo root, on a Linux box with the usual QEMU build deps:

```bash
# 1. Build the library (~10 min first time, idempotent re-run).
make -C embed/examples/gr740 qemu-lib

# 2. Build and run the gr740 timing example.
make -C embed/examples/gr740 run

# 3. Same for gr712rc.
make -C embed/examples/gr712rc run
```

Each example runs 1000 steps of 5 ms (= 5 seconds of guest time),
prints a heartbeat every second showing the wall clock keeping
pace, and tails the guest UART output. See [The bundled examples](#the-bundled-examples)
below for what to expect.

## What the SDK distributes

Two files. Nothing else.

| File                              | Role                                      |
| ---                               | ---                                       |
| `qemu/build/libqemu-sparc.so`     | The shared library (≈36 MB, debug build). |
| `qemu/include/libqemu.h`          | The public C API header.                  |

The host's link line is:

```
gcc your_main.c -I qemu/include -L qemu/build -lqemu-sparc \
    -Wl,-rpath,qemu/build -o your_host
```

`-Wl,-rpath` is for development convenience; in production deploy
the `.so` to a system library path or set `LD_LIBRARY_PATH`.

The library exports **20 symbols** plus a version tag (see
`qemu/system/embed_api.map`):

- 10 native QEMU symbols for lifecycle, run-state, main loop, and timers
  (documented in this file).
- 8 fork-specific `embed_*` symbols for peripheral registration, MMIO
  injection, IRQ control, and BQL acquisition (documented in
  [docs/12-host-side-peripherals.md](12-host-side-peripherals.md)).
- 2 fork-specific timer forwarders (`embed_timer_new_ns`,
  `embed_timer_free` — paper-thin wrappers around QEMU's `static
  inline` timer helpers).

Everything else QEMU contains internally is hidden by the linker
version script.

## Building `libqemu-sparc.so`

The library is not produced by QEMU's default configure. It needs
`b_staticpic=true` so the internal static libraries it pulls
objects from are PIC-compatible.

The `qemu-lib` Makefile target in each example does the right thing:

```bash
make -C embed/examples/gr740 qemu-lib
```

What it does (idempotent):

1. Runs `qemu/configure --target-list=sparc-softmmu` if `qemu/build/`
   does not yet exist.
2. Tells meson to flip `b_staticpic=true`.
3. Runs `ninja libqemu-sparc.so`.

Subsequent fast incremental rebuilds: `make -C embed/examples/gr740
qemu-lib` again, or directly `ninja libqemu-sparc.so` in
`qemu/build/`.

### Why `b_staticpic=true` is needed

QEMU's executables are built `-fPIE`, which on x86_64 is
essentially equivalent to `-fPIC`. But meson's bookkeeping tracks
static libraries as non-PIC unless either `b_staticpic` is set or
each library declares `pic: true`. Without that flag, meson refuses
to link static libs (`libqemuutil`, etc.) into a shared library —
even though the generated objects are byte-identical.

Flipping `b_staticpic=true` only changes the bookkeeping; it does
not change the produced objects.

## The `libqemu.h` API

Three groups of declarations: types, mirrored enum values, and the
13 function prototypes.

### Opaque types

```c
typedef struct QEMUTimer QEMUTimer;
typedef void QEMUTimerCB(void *opaque);
```

QEMUTimer is opaque — managed entirely by the library.

### Enum values

```c
typedef enum {
    QEMU_CLOCK_REALTIME   = 0,
    QEMU_CLOCK_VIRTUAL    = 1,
    QEMU_CLOCK_HOST       = 2,
    QEMU_CLOCK_VIRTUAL_RT = 3,
} QEMUClockType;

typedef enum {
    RUN_STATE_DEBUG           = 0,
    RUN_STATE_INMIGRATE       = 1,
    /* ... */
    RUN_STATE_PAUSED          = 4,
    /* ... */
    RUN_STATE_COLO            = 15,
} RunState;
```

These are **mirrors** of QEMU's internal enums. The literal values
are verified at .so build time via `_Static_assert` in
`qemu/system/embed_api.c`. If a future QEMU upstream renumbers
these, the `.so` build fails with a `"libqemu.h: <FOO> drifted"`
message that points straight at the lie.

### Function prototypes

```c
void qemu_init(int argc, char **argv);
void qemu_cleanup(int status);

void vm_start(void);
void vm_stop(int state);  /* takes RunState */

bool runstate_is_running(void);
bool runstate_check(int state);

bool qemu_mutex_iothread_locked(void);

bool main_loop_wait(bool nonblocking);

QEMUTimer *embed_timer_new_ns(int clock_type, QEMUTimerCB *cb, void *opaque);
void       embed_timer_free(QEMUTimer *t);
void       timer_mod_ns(QEMUTimer *t, int64_t expire_time);
int64_t    qemu_clock_get_ns(int clock_type);

extern const char libqemu_embed_version[];
```

Note that `embed_timer_new_ns` and `embed_timer_free` are fork-only
forwarders. QEMU's own `timer_new_ns` and `timer_free` are
`static inline` in `qemu/include/qemu/timer.h` and have no ELF
symbol; the fork adds paper-thin wrappers in
`qemu/system/embed_api.c` to make them externally linkable.

### Threading

All calls into the library **must be made from the same thread**.
`qemu_init()` returns with the iothread mutex held by that thread,
and the caller inherits it for the whole lifecycle — every
subsequent call (including `vm_start`, `main_loop_wait`,
`timer_*`, `qemu_cleanup`) runs under that mutex.

## Writing your own host

A minimal step-driving host is ≈50 lines of C. Here is the shape
(without error handling for brevity):

```c
#include <libqemu.h>

static QEMUTimer *step_timer;

static void deadline_cb(void *opaque) {
    (void)opaque;
    vm_stop(RUN_STATE_PAUSED);
}

int main(int argc, char **argv) {
    char *qargv[] = {
        argv[0],
        "-M", "gr740", "-display", "none", "-monitor", "none",
        "-kernel", "apps/07-hello-gr740/hello.exe",
        "-serial", "file:/tmp/uart.log", "-S",
        NULL
    };
    int qargc = sizeof(qargv) / sizeof(qargv[0]) - 1;

    qemu_init(qargc, qargv);
    step_timer = embed_timer_new_ns(QEMU_CLOCK_REALTIME, deadline_cb, NULL);

    int64_t dt_ns = 5 * 1000 * 1000;  /* 5 ms (recommended operating point) */
    for (int i = 0; i < 1000; i++) {
        int64_t t0 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);
        timer_mod_ns(step_timer, t0 + dt_ns);
        vm_start();
        while (runstate_is_running()) {
            main_loop_wait(false);
        }
        if (!runstate_check(RUN_STATE_PAUSED)) break;  /* guest halted */
    }

    embed_timer_free(step_timer);
    qemu_cleanup(0);
    return 0;
}
```

Step lifecycle:

1. Sample the realtime clock.
2. Arm a timer for `t0 + dt_ns`.
3. `vm_start()` releases the vCPUs.
4. `main_loop_wait(false)` services I/O and dispatches timer
   callbacks. Returns when the timer fires (callback called
   `vm_stop`) or when the guest leaves the running state on its own.
5. `runstate_check(RUN_STATE_PAUSED)` tells you which it was.

## The example wrapper: `embed_qemu`

The repo ships an *example* C wrapper around the SDK:

```
embed/embed_qemu.h
embed/embed_qemu.c
```

It exposes a 3-function API — `embed_qemu_init`, `embed_qemu_step`,
`embed_qemu_cleanup` — plus an `EmbedStepStats` struct that
captures per-step timing. The wrapper hides the iothread / timer /
runstate mechanics behind:

```c
embed_qemu_init(qargc, qargv);
for (...) {
    EmbedStepStats st;
    embed_qemu_step(dt_ns, &st);
    if (st.guest_left_running_state) break;
}
embed_qemu_cleanup();
```

It also intercepts `exit()` so that a `&error_fatal` path inside
QEMU returns an error code from `embed_qemu_init()` instead of
killing the host process. See [Error handling](#error-handling).

The wrapper is **not part of the SDK**. It is one example of how to
consume `libqemu.h`. A host that needs different semantics
(event-driven steps, virtual clock, custom error policy, RAII
wrapper for C++) is expected to write its own wrapper against
`libqemu.h` directly. The example exists to:

1. demonstrate a working consumer end-to-end, and
2. provide a reference implementation that hosts can copy and
   modify.

## The bundled examples

Two minimal example programs live under `embed/examples/`. Each
takes exactly one argument — the guest binary — and runs 1000
steps of 5 ms (= 5 seconds of guest time) so that you can SEE the
wall-clock keeping pace with simulated time.

| Path                          | Machine     | Default guest                              |
| ---                           | ---         | ---                                        |
| `embed/examples/gr740/`       | `-M gr740`  | `apps/07-hello-gr740/hello.exe`            |
| `embed/examples/gr712rc/`     | `-M gr712rc`| `apps/02-dual-core-timer/dual_core_timer.exe` |

The guest binary is auto-detected as either ELF (loaded with
`-kernel`) or a raw ROM image (loaded with `-bios`) by sniffing
the first 4 bytes for the ELF magic.

### Running

```bash
make -C embed/examples/gr740 run
```

or with a different binary:

```bash
make -C embed/examples/gr740 run BIN=/abs/path/to/something.exe
./embed/examples/gr740/timing-gr740 /abs/path/to/prom.bin   # auto -> -bios
```

### Expected output (gr740 with hello)

```
=== timing-gr740 ===
Binary:   .../apps/07-hello-gr740/hello.exe
Format:   ELF (-kernel)
Steps:    1000 x 5 ms = 5.000 s sim time
Expected: SMP guest, 4 cores — slip ~+5%

  step  200 / 1000   sim=1.000 s   wall=1.052 s   slip=+5.2%
  step  400 / 1000   sim=2.000 s   wall=2.103 s   slip=+5.1%
  step  600 / 1000   sim=3.000 s   wall=3.156 s   slip=+5.2%
  step  800 / 1000   sim=4.000 s   wall=4.208 s   slip=+5.2%
  step 1000 / 1000   sim=5.000 s   wall=5.256 s   slip=+5.1%

Total sim:  5.000 s
Total wall: 5.256 s
Slip:       +5.1%

Guest UART output:
  *** GR740 RTEMS Hello World ***
  Running on QEMU
  *** END OF TEST ***
```

### Expected output (gr712rc with dual-core-timer)

```
=== timing-gr712rc ===
Binary:   .../apps/02-dual-core-timer/dual_core_timer.exe
Format:   ELF (-kernel)
Steps:    1000 x 5 ms = 5.000 s sim time
Expected: SMP guest, 2 cores — slip ~+3%

  step  200 / 1000   sim=1.000 s   wall=1.032 s   slip=+3.2%
  step  400 / 1000   sim=2.000 s   wall=2.062 s   slip=+3.1%
  step  600 / 1000   sim=3.000 s   wall=3.092 s   slip=+3.1%
  step  800 / 1000   sim=4.000 s   wall=4.125 s   slip=+3.1%
  step 1000 / 1000   sim=5.000 s   wall=5.158 s   slip=+3.2%

Total sim:  5.000 s
Total wall: 5.158 s
Slip:       +3.2%

Guest UART output:
  Core 0: 10
  Core 1: 20
  Core 1: 21
  Core 0: 11
  ...
```

Both runs demonstrate the operating point fidelity in real time —
each heartbeat shows sim and wall advancing together with a stable
slip across the whole 5 seconds, not drifting.

## Operating point and timing

The library targets one operating point: **5 ms fixed step under
`QEMU_CLOCK_REALTIME`, no `-icount`**. This was raised from an
earlier 1 ms candidate after a multi-core dt-sweep showed the
per-step floor of the embed wrapper dominates the slip well above
the noise of TCG execution itself. See [Multi-core dt-sweep](#multi-core-dt-sweep)
below for the numbers.

### Multi-core dt-sweep

Mean slip over 5 s of guest time across `dt` ∈ {1, 2, 5} ms,
running the SMP guest on each machine (gr712rc dual-core, gr740
quad-core). 3 trials per cell, median reported.

| `dt`  | gr712rc SMP (2c) slip | gr740 SMP (4c) slip |
| ---   | ---                   | ---                 |
| 1 ms  | +12.1%                | +21.6%              |
| 2 ms  |  +6.7%                | +12.0%              |
| 5 ms  |  +3.2%                |  +5.1%              |

The slip is dominated by a fixed per-step cost of the embed wrapper
(`vm_start → main_loop_wait → vm_stop`), not by TCG execution
itself. Decomposing `(wall − sim) / N_steps`:

| `dt`  | gr712rc (2c) per-step | gr740 (4c) per-step |
| ---   | ---                   | ---                 |
| 1 ms  | 121 µs                | 216 µs              |
| 2 ms  | 134 µs                | 240 µs              |
| 5 ms  | 160 µs                | 255 µs              |

Two observations:

1. The per-step floor grows with `dt` (more TCG executed = more
   BQL acquisitions for incidental IRQ acks / MMIO inside the
   step) but only mildly compared with the linear `dt` itself, so
   slip% falls as `dt` rises.
2. The per-step floor scales roughly with vCPU count: gr740 (4
   vCPUs) sits ~1.7-1.8× the gr712rc (2 vCPUs) floor. Consistent
   with each core contributing its own clock-tick IRQ, IRQMP
   ack, and BQL acquisition per step.

5 ms is the smallest `dt` at which both machines stay below 6 %
slip under MTTCG with no host tuning (no CPU pinning, no
`SCHED_FIFO`). Above ~5 ms the marginal improvement flattens; below
~5 ms the floor dominates fast.

### Original single-core sweep (historical)

The first PoC swept `dt` from 1 ms down to 5 µs on a single-core
guest (`apps/01-hello-rtems/hello.exe`). Numbers below are
`wall_dt` in microseconds. These confirmed the two-floor model
below but did not surface the per-vCPU scaling that the
multi-core sweep exposed.

Single-core (`apps/01-hello-rtems/hello.exe`):

| dt req. | n     | min  | p50  | p90  | p99  | p99.9 | max  | p50/dt | p99/dt |
| ---     | ---   | ---  | ---  | ---  | ---  | ---   | ---  | ---    | ---    |
| 1000 µs | 200   | 1022 | 1101 | 1160 | 1224 | 1263  | 1363 | 1.10×  | 1.22×  |
| 500 µs  | 400   | 520  | 548  | 599  | 649  | 764   | 1586 | 1.10×  | 1.30×  |
| 250 µs  | 800   | 269  | 290  | 341  | 418  | 679   | 1060 | 1.16×  | 1.67×  |
| 100 µs  | 2000  | 118  | 141  | 164  | 224  | 532   | 2582 | 1.41×  | 2.24×  |
| 10 µs   | 20000 | 23   | 37   | 50   | 89   | 200   | 526  | 3.70×  | 8.90×  |
| 5 µs    | 40000 | 23   | 35   | 46   | 75   | 171   | 555  | 7.00×  | 15.0×  |

SMP (`apps/02-dual-core-timer/dual_core_timer.exe`):

| dt req. | n   | min | p50 | p90 | p99 | p99.9 | max  | p50/dt | p99/dt |
| ---     | --- | --- | --- | --- | --- | ---   | ---  | ---    | ---    |
| 500 µs  | 400 | 528 | 596 | 696 | 825 | 999   | 1600 | 1.19×  | 1.65×  |

### Two-floor model

The data fits a simple model: each step costs the requested `dt`
plus a fixed amount of overhead, with two distinct floors — one
for typical-case latency and a larger one for tail latency.

| dt   | p50 obs | dt + 50 µs | p99 obs | dt + 150 µs |
| ---  | ---     | ---        | ---     | ---         |
| 1000 | 1101 µs | 1050 µs    | 1224 µs | 1150 µs     |
| 500  | 548 µs  | 550 µs     | 649 µs  | 650 µs      |
| 250  | 290 µs  | 300 µs     | 418 µs  | 400 µs      |
| 100  | 141 µs  | 150 µs     | 224 µs  | 250 µs      |

The ≈50 µs p50 floor is the cost of one `vm_start → arm timer →
main_loop_wait → vm_stop` cycle plus an `epoll_wait`. The ≈150 µs
p99 floor is host-scheduler jitter — GLib timer expiry and kernel
wakeup noise. CPU pinning + `SCHED_FIFO` would compress the p99
floor but cannot push the p50 floor below the cycle cost.

Three consequences fall out:

1. **Below `dt ≈ 25 µs`** the median floor dominates (p50/dt > 3.7×).
   Asking for a finer slice no longer buys finer time resolution,
   only more CPU spent in the stepping machinery.
2. **Below `dt ≈ 150 µs`** the tail floor dominates (p99/dt > 2×).
   Median may still look acceptable but the worst case roughly
   doubles the requested slice.
3. **SMP widens the tail more than it shifts the median.** Going
   single-core → SMP at 500 µs added ≈50 µs to p50 (+9%) but
   ≈180 µs to p99 (+27%). Two vCPUs bring TCG-lock contention and
   more `main_loop_wait` reasons-to-wake.

### Recommended operating point: 5 ms REALTIME

5 ms gives the best mean slip on both machines under MTTCG with
no host tuning:

- gr712rc SMP (2 cores): +3.2% slip.
- gr740 SMP (4 cores): +5.1% slip.

The host-side tick rate is 200 Hz at this `dt`. If your consumer
of the SDK does not need to react to guest events faster than
~5 ms, this is the recommended default — and is what the bundled
`embed/examples/{gr712rc,gr740}/` programs use.

If you need a faster tick rate, the dt-sweep above quantifies the
tradeoff:

| Need                                      | `dt` | gr712rc SMP slip | gr740 SMP slip |
| ---                                       | ---  | ---              | ---            |
| 200 Hz tick (recommended default)         | 5 ms |  +3.2%           |  +5.1%         |
| 500 Hz tick                               | 2 ms |  +6.7%           | +12.0%         |
| 1 kHz tick (original PoC operating point) | 1 ms | +12.1%           | +21.6%         |

#### History: why 1 ms was the original frozen point

The first version of this library targeted **1 ms** based on a
single-core granularity sweep (see below). At that workload the
slip was a clean +10–12% with comfortable p99 cushion. The
multi-core sweep added later showed that the per-step floor scales
with vCPU count, so the same 1 ms `dt` produces +20% slip on
gr740 SMP — outside the originally-frozen envelope. Rather than
keep the 1 ms point and absorb the worse SMP numbers, the
operating point was raised to 5 ms which restores the envelope
across both machines.

### Escalation triggers

Revisit the operating-point decision if any of these occur:

- A real workload pushes sustained slip above the dt-sweep table
  values at the same `dt`. Indicates the loaded-guest assumption
  is worse than predicted.
- The host application needs a tick rate above 200 Hz and the
  slip at lower `dt` (see table above) is unacceptable. The
  structural fix is then to redesign the step API so QEMU runs
  continuously instead of `vm_start`/`vm_stop` per tick (the
  per-step floor would drop from ~100-250 µs to <10 µs).
- Determinism becomes a hard requirement → an icount-paced
  step API was prototyped and reverted (see
  [Determinism / icount](#determinism--icount) for the
  empirical reason). Reintroducing it requires a consumer
  that can work with single-core guests only, or an upstream
  QEMU fix for the rr+icount+PIL-spin interaction.
- Deployment moves to a preempt-RT kernel with CPU isolation →
  re-run the sweep; the per-step floor likely drops and finer
  `dt` becomes viable.

### Reproducing the sweep

The PoC instrumentation flags on the original `qemu-system-sparc`
binary are gone (the .so + standalone host replaced them).
Re-running the sweep against the current SDK is a small project of
its own: write a host that varies `dt_us` and records per-step
wall times to CSV, then run it for each grid point. The pattern is
exactly what `embed/examples/gr740/main.c` does, with the print
loop replaced by a CSV writer.

## Error handling

QEMU has hundreds of error paths that route through `&error_fatal`,
which calls `exit(1)`. For an embedded library that would take the
host process down.

The example wrapper `embed/embed_qemu.c` intercepts `exit()` by
defining its own `exit(int)`; the dynamic linker prefers the
host-executable definition over libc's for calls made by
`libqemu-sparc.so`. When `embed_qemu_init()` has armed the trap
(via `setjmp`), an interception `longjmp`s back so init returns the
exit code instead of dying. Outside of init, the interception
forwards to `_exit()` so normal host shutdown still works (skipping
`atexit` handlers to avoid re-entering QEMU code with corrupt
state).

```c
int rc = embed_qemu_init(qargc, qargv);
if (rc != 0) {
    fprintf(stderr, "QEMU init failed: rc=%d\n", rc);
    return rc;  /* do NOT call embed_qemu_* again — state is corrupt */
}
```

After a non-zero return, **the host MUST terminate cleanly and
not retry within the same process**. The `longjmp` leaves QEMU
locks, fds, and threads in an indeterminate state; calling any
embed_qemu function after a failure crashes immediately. This is
demonstrated by a test that calls `embed_qemu_init()` twice in a
row: the second call dies with `"ran out of space in
drive_config_groups"`.

A host that writes against `libqemu.h` directly (without the
wrapper) does **not** get this protection — any `&error_fatal`
inside QEMU kills its process. Hosts that need init-time error
recovery should use the wrapper, or copy its `exit()` interception
pattern.

## Limitations

### Determinism / icount

Bit-exact reproducibility and decoupled virtual time require
`-icount`. The SDK does **not** expose an icount-based step API;
the only shipped operating mode is REALTIME pacing via
`embed_qemu_step(dt)`. This section explains why.

**What works under `-icount`** (CLI side, plain `qemu-system-sparc`):

- **Single-core guests** on either machine work under all
  tested shifts (0, 4, 8, 10) plus `auto`.
- **gr712rc SMP** boots and runs at the CLI under
  `-icount shift=10,sleep=on` (verified with
  `apps/02-dual-core-timer/dual_core_timer.exe`) but runs in a
  **degraded mode**: the timer-tick IRQ fires infrequently
  because virtual time advances slowly during RTEMS's SMP
  ticket-lock spin (≈10 lines of UART over 5 s sim vs ≈100+
  under non-icount).

**What does not work under `-icount`**:

- **gr740 SMP** hangs at every valid shift (0–10), `auto`,
  with or without `sleep=on`, with or without `align=on`.
  Diagnosed May 2026: under rr-mode TCG, the RTEMS SMP boot
  keeps `PSR.PIL=15` for >99% of execution (tight `ta 0x9` /
  `ta 0xA` software-trap spin), so IRQs are masked almost
  always. A 3-second trap log on a representative hang
  captured **228,997 software traps and 0 external
  interrupts**. The IRQMP correctly raises the IPI line; the
  CPU never takes it because of the PIL spin. This interaction
  is structural across three layers (RTEMS critical-section
  pattern + SPARC PIL semantics + rr+icount scheduling) and
  was not addressable by any single-side change attempted.

**Why the SDK does not expose an icount-based API**: the
project's primary apps are SMP RTEMS. An icount-paced step
function (`embed_qemu_init_icount` + `embed_qemu_step_locked`)
was prototyped and shipped in commit `b8899a4`, then reverted
in `3041aee` because gr740 SMP hangs and gr712rc SMP runs
degraded — covering only single-core guests and demos, not the
real workloads this project targets. The full implementation
and the empirical diagnosis are preserved in git history at
`b8899a4` and `b8e8008` if a future consumer with single-core
constraints justifies revisiting.

`docs/13-icount-step-pacing.md` documents the earlier
investigation of sub-millisecond stepping under `-icount` +
VIRTUAL deadlines. Short version: the per-step floor of
~120–220 µs is structural cross-thread coordination cost on
Linux pthread + MTTCG and is not addressable by icount.

### `abort()` not intercepted

The wrapper intercepts `exit()` only. A small number of QEMU paths
use `&error_abort`, which calls `abort()` and ignores any
interception attempt (`abort()` is required by POSIX not to
return). Those errors will still kill the host. Mitigation
requires patching QEMU upstream to convert `error_abort` sites to
`error_fatal` where appropriate.

### Wide runtime dependency surface

The `.so` pulls in glib, pixman, lua, zlib, and others (see `ldd
your_host`). These are loaded into the host process whether or not
it uses them directly. A host with its own glib version that
differs from the system glib could see symbol-resolution surprises.

### Drift between `libqemu.h` and QEMU enums

`libqemu.h` hardcodes numeric values for `QEMUClockType` and
`RunState`. If a future QEMU upstream renumbers either enum,
`libqemu.h` becomes a lie. The `.so` build catches this
automatically via `_Static_assert` checks in
`qemu/system/embed_api.c` — the build fails with a `"libqemu.h:
<FOO> drifted"` message that points at the constant to update.

### License — GPLv2 derivation

Linking `libqemu-sparc.so` into a proprietary host binary creates
a derivative work under GPLv2 in most interpretations. Mitigation
options:

- Keep the host code open-source.
- Use a separate process + IPC instead of in-process linking — at
  the cost of much higher per-step latency.
- Consult legal before deploying.

The repo does not take a position on this; it is the embedder's
responsibility.

## Design journey

A brief record of how the architecture got to its current shape,
useful when a future iteration needs context.

The work proceeded in four iterations, each driven by what the
previous revealed about what "embedding" actually meant in
practice.

### Iteration 1 — flags on `qemu-system-sparc`

The first PoC added `--embed-poc` and `--embed-poc-step <kernel>
<dt_us> <n_steps>` flags to `qemu/system/main.c`. The "embedder"
was the QEMU binary itself with extra command-line arguments.
This proved that `qemu_init()` / step / `qemu_cleanup()` was a
viable lifecycle inside a custom `main()`, and produced the
granularity sweep data above.

It also exposed three concrete findings that overrode the original
NOTES sketch:

- `qemu_init()` returns with the iothread mutex held; double-locking
  trips an assertion.
- `QEMU_CLOCK_VIRTUAL` timers do not wake `main_loop_wait` without
  `-icount`. Use `QEMU_CLOCK_REALTIME` for non-deterministic mode.
- `-nographic` auto-cables serial+monitor to stdio; use
  `-display none -monitor none -serial file:...` when stdout is
  reserved for measurement output.

### Iteration 2 — in-tree separate binaries

The flags-on-qemu-system-sparc model fudged the embedding question:
the "host" was still QEMU itself. Iteration 2 produced two
separate binaries — `embed-gr740` and `embed-gr712rc-smp` — built
by QEMU's meson alongside `qemu-system-sparc`, each with its own
`main()` linking the same `libqemu-sparc-softmmu.fa` static
archive. A reusable wrapper API (`embed_qemu_init/step/cleanup`)
emerged from comparing the two examples.

Still inside the QEMU submodule. Still tied to QEMU's build
system. The "external host" was theoretical.

### Iteration 3 — true shared library, host outside the tree

Iteration 3 added a `shared_library('qemu-sparc', ...)` target to
QEMU's meson that produces `libqemu-sparc.so` by extracting the
same objects from the static archive. A standalone host program
moved into `embed/examples/` (parent repo), compiled by plain `gcc
+ Makefile`, linking against the `.so` via `-lqemu-sparc -Wl,-rpath`.

This iteration solved the real embedding question. It also surfaced:

- The need for `b_staticpic=true` to allow the link.
- The fact that `timer_new_ns` / `timer_free` are `static inline`
  in QEMU's public headers, so an external linker cannot resolve
  them. Solved by adding paper-thin forwarders
  (`embed_timer_new_ns` / `embed_timer_free`) in
  `qemu/system/embed_api.c`.
- The wrapper's `embed_qemu.c` still depended on QEMU's internal
  headers, which leaked QEMU into the consumer build.

### Iteration 4 — SDK header and hardening

The final iteration produced `qemu/include/libqemu.h` — a
hand-curated public ABI header with no QEMU includes — and
rewrote `embed/embed_qemu.c` to use it. The .so was tightened with
a linker version script restricting exports from ≈30000 symbols to
14, `exit()` interception was added so `error_fatal` returns
instead of killing the host, and `_Static_assert` drift guards
make the .so build fail if QEMU's enums diverge from the header.

Two simple per-machine examples (`embed/examples/gr740/` and
`embed/examples/gr712rc/`) replaced the earlier generic
parameterized host, focusing the demonstration on the timing
fidelity question: do 5 seconds at 1 ms steps actually meet the
operating point?

### Lessons that generalise

A few things worth carrying into future similar projects:

- **The "real" embedding question is whether the consumer can
  build without QEMU's source tree.** Once the answer becomes
  "yes, with these two files," every architectural question gets a
  clear yes/no answer.
- **Static-inline functions in public headers are an embedding
  trap.** They look fine when you're compiling against the headers
  but vanish from the ELF symbol table at link time. Forward them
  explicitly.
- **Pin enum values in the SDK header and assert at lib build
  time, don't `#include` upstream headers.** That keeps the SDK
  self-contained at the cost of a small drift-guard maintenance
  burden, which is a far smaller cost than dragging in QEMU's
  whole header tree.
- **Intercept `exit()` rather than refactor `error_fatal`**: 10
  lines of `setjmp/longjmp + exit()` override beats touching the
  200+ `&error_fatal` call sites upstream. Document the
  one-shot-only semantics clearly and move on.
- **Two basic examples beat one parametric one.** When the
  question is "does timing fidelity hold?" the parametric host
  obscured the answer; per-machine programs that hardcode the
  scenario and SHOW the heartbeat live make the answer obvious.
