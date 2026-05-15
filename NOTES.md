# QEMU as Library — Design Notes

This branch holds work to make QEMU embeddable as a library inside a larger
proprietary simulator (SMP2-based, in our case), so that an external scheduler
can drive QEMU step-by-step in virtual time.

## Goal

Embed `libqemu-system-sparc` inside a host simulator. The host's scheduler
calls something like `qemu_step(dt)` each tick; QEMU advances virtual time
by `dt`, processes any I/O at well-defined synchronization points, and returns
control. No `qemu-system-sparc` binary running as a separate process.

## Why this approach (and not SystemC/TLM)

Three strategies were considered:

1. **QEMU as separate process + IPC** (qtest, custom socket protocol).
   Lowest invasiveness, but high per-step latency. Hard to reach step rates
   >10 kHz needed for HIL-class work.

2. **QEMU as `.so` linked into the host** (this branch). Direct C API. Lower
   latency, more invasive in QEMU itself — but the invasive parts already
   exist upstream (see below).

3. **QEMU + SystemC/TLM-2.0 bridge** (QBox-style). Standard in some commercial
   integrations (EuroSim, Simulus). For us, adds a third time-keeping kernel
   without benefit: the host SMP2 scheduler already plays that role, and we
   have no SystemC ecosystem to interoperate with.

Decision: **Strategy 2**, wrapped as a single SMP2 `IModel`. No SystemC.

## Key upstream finding

QEMU 8.2.2 already exposes the embedding hooks needed:

- `include/sysemu/sysemu.h:102-104`:

  ```c
  void qemu_init(int argc, char **argv);
  int  qemu_main_loop(void);
  void qemu_cleanup(int);
  ```

- `system/main.c` is **50 lines**: `main()` calls `qemu_init`, then `qemu_main`
  (a function pointer, replaceable), then `qemu_cleanup`. The function-pointer
  design is the upstream-blessed extension point.

The embedding API is mostly already there. We don't have to fight QEMU's main
loop — we just don't use it.

## Sketch of integration

In the SMP2 model's `Publish()` / `Configure()`:

```c
const char *argv[] = {
    "qemu-system-sparc",
    "-M", "gr712rc", "-nographic",
    "-kernel", kernel_path,
    "-icount", "shift=auto,sleep=off",
    "-S",                              // paused at reset
    NULL,
};
qemu_init(argc, (char **)argv);
// do NOT call qemu_main(); we own the loop
```

In `IEntryPoint::Execute(dt)`:

```c
qemu_mutex_lock_iothread();
schedule_vm_stop_in_ns(dt);            // QEMUTimer on QEMU_CLOCK_VIRTUAL
vm_start();
while (runstate_is_running()) {
    main_loop_wait(false);
}
qemu_mutex_unlock_iothread();
```

In destruction:

```c
qemu_cleanup(0);
```

## Open technical issues

- **Build as `.so`**. `meson.build` needs changes to emit
  `libqemu-system-sparc.so` (or `.a`) in addition to the executable.
  `--disable-pie` and similar flags may be needed.
- **`exit()` in error paths**. Many sites use `&error_fatal`, which calls
  `exit(1)` — unacceptable in an embedded process. Audit and patch the
  critical paths so they propagate errors back to the host.
- **GLib main loop coordination**. QEMU uses `GMainContext`. If the host uses
  GLib (e.g. Qt), need to share or proxy the context. If not, no issue.
- **iothread mutex discipline**. Every call into QEMU from outside must hold
  `qemu_mutex_lock_iothread()`. Violations produce silent races.
- **Determinism for SMP**. Disable MTTCG (`-accel tcg,thread=single`) for
  reproducible CPU0/CPU1 ordering. Validate with `02-dual-core-timer` under
  `-icount shift=auto`.
- **`-icount` interaction with SMP startup**. Untested. The MPSTATUS handoff
  between CPU0 and CPU1 may be sensitive to icount timing.
- **Chardev rerouting**. TCP / socket chardevs are non-deterministic. Need a
  new chardev backend that calls into a host-registered callback, so SMP2
  ports drive UARTs synchronously to the step.

## Determinism considerations

- `-icount shift=N` makes QEMU use a virtual clock driven by translated
  instruction count, decoupling from wall-clock. Required for reproducibility.
- `record/replay` (`-icount shift=N,rr=record,rrfile=...`) is the only fully
  reproducible mode; useful for regression baselines.
- All peripherals must use `QEMU_CLOCK_VIRTUAL`, not `QEMU_CLOCK_REALTIME`.
  Audit pending: `grep -rn QEMU_CLOCK_ qemu/hw/{timer,intc,char}/grlib_*`.

## License analysis

Linking `libqemu` into a proprietary simulator binary creates a derivative
work under GPLv2 (most interpretations). Mitigations:

- Keep the SMP2 wrapper code small and consider releasing it open-source.
- If the host simulator must remain proprietary, use Strategy 1 (separate
  process + IPC) instead — but that imposes the latency cost noted above.
- Consult legal before committing to architecture.

## First PoC milestone

1. Add `embed/main.c` that hardcodes argv for
   `-M gr712rc -kernel apps/01-hello-rtems/hello.exe`, calls `qemu_init`,
   prints "Hello from embedder", and exits without running `qemu_main`.
   Verifies linking works.
2. Modify `qemu/meson.build` to also produce `libqemu-system-sparc.{a,so}`.
3. Extend `embed/main.c` to drive 100 ms of virtual execution via
   `QEMUTimer` + `vm_stop`, capturing RTEMS console output via a callback
   chardev.

Estimated: 1–2 weeks for steps 1–2, another 2–3 weeks for step 3.

## PoC results (steps 1 & 1.5, May 2026)

The PoC entry points live in `qemu/system/main.c` (no separate binary;
two flags on the existing `qemu-system-sparc`):

- `--embed-poc [kernel]` — calls `qemu_init` with a hardcoded argv for
  `-M gr712rc -kernel <kernel> -S`, then `qemu_cleanup(0)`, then returns.
  Verifies the linking premise: init and cleanup are drivable from a
  custom main without entering `qemu_main_loop`.
- `--embed-poc-step <kernel> <dt_us> <n_steps> [clock]` — step-drives
  QEMU in fixed-size slices and prints per-step CSV on stdout, summary
  on stderr. `clock=0` uses `QEMU_CLOCK_REALTIME`, `clock=1` uses
  `QEMU_CLOCK_VIRTUAL` with auto-injected `-icount shift=auto,sleep=off`.

### Findings that override the earlier sketch above

- **`qemu_init` returns with the iothread mutex held by the caller**.
  The sketch at lines 71–79 calls `qemu_mutex_lock_iothread()` before
  `vm_start()` — that double-locks and trips an assertion in
  `system/cpus.c:504`. Correct discipline: inherit the mutex from
  `qemu_init`, hold it across the step lifecycle, release it only when
  the surrounding host needs to free it between steps.

- **`QEMU_CLOCK_VIRTUAL` timers do not wake `main_loop_wait` without
  `-icount`**. The main loop's timer list group (`main_loop_tlg`) only
  carries `QEMU_CLOCK_REALTIME` and `QEMU_CLOCK_HOST` timers. Virtual-
  clock timers are dispatched by vCPU/AIO contexts; without the
  `-icount` warp-timer machinery, the main thread has no reliable wake
  path when a virtual-clock timer fires. A timer on
  `QEMU_CLOCK_REALTIME` works without icount but binds virtual time to
  wall-clock.

- **`-nographic` auto-cables monitor+serial to stdio**. Use explicit
  `-display none -monitor none -serial file:...` when stdout must be
  reserved for application output (we use stdout for the CSV).

### Measured behaviour at 1 ms steps

| Configuration | Steps | Mean step (wall) | Median overshoot | Status |
|---|---|---|---|---|
| REALTIME, single-core (hello) | 200/200 | 1.098 ms | 90 µs (9%) | OK |
| REALTIME, SMP (dual-core-timer) | 500/500 | 1.168 ms | ~170 µs (17%) | OK |
| VIRTUAL+icount, single-core (hello) | 0/200 | — | — | step loop stalls after guest exits (virtual clock freezes when vCPU halts) |
| VIRTUAL+icount, SMP (dual-core-timer) | 0/200 | — | — | hangs during BSP boot (MPSTATUS handoff incompatible with icount; matches the "untested" warning in CLAUDE.md) |

REALTIME at 1 ms is the viable path for the next milestone. Sim/wall is
1.0× by construction (the clock *is* wall-clock); for HIL or
wall-clock-paced SMP2 schedulers that is the desired semantics.

### Granularity sweep (REALTIME, May 2026)

To find the practical lower bound of the fixed-`dt` stepping discipline,
we swept `dt` from 1 ms down to 5 µs while holding the workload
constant. All numbers are `wall_dt` (= `virt_dt` under REALTIME) in
microseconds. Each run advances the guest by roughly the same amount of
virtual time so totals are comparable.

Single-core (`apps/01-hello-rtems/hello.exe`):

| dt req. | n     | min  | p50  | p90  | p99  | p99.9 | max  | p50/dt | p99/dt |
|---      |---    |---   |---   |---   |---   |---    |---   |---     |---     |
| 1000 µs | 200   | 1022 | 1101 | 1160 | 1224 | 1263  | 1363 | 1.10×  | 1.22×  |
| 500 µs  | 400   | 520  | 548  | 599  | 649  | 764   | 1586 | 1.10×  | 1.30×  |
| 250 µs  | 800   | 269  | 290  | 341  | 418  | 679   | 1060 | 1.16×  | 1.67×  |
| 100 µs  | 2000  | 118  | 141  | 164  | 224  | 532   | 2582 | 1.41×  | 2.24×  |
| 10 µs   | 20000 | 23   | 37   | 50   | 89   | 200   | 526  | 3.70×  | 8.90×  |
| 5 µs    | 40000 | 23   | 35   | 46   | 75   | 171   | 555  | 7.00×  | 15.0×  |

SMP (`apps/02-dual-core-timer/dual_core_timer.exe`) at the operating
point of interest:

| dt req. | n   | min | p50 | p90 | p99 | p99.9 | max  | p50/dt | p99/dt |
|---      |---  |---  |---  |---  |---  |---    |---   |---     |---     |
| 500 µs  | 400 | 528 | 596 | 696 | 825 | 999   | 1600 | 1.19×  | 1.65×  |

**Two-floor model.** The data fits a simple model: each step costs the
requested `dt` plus a fixed amount of overhead, with two distinct
floors — one for typical-case latency and a larger one for tail
latency.

| dt   | p50 obs | dt + 50 µs | p99 obs | dt + 150 µs |
|---   |---      |---         |---      |---          |
| 1000 | 1101 µs | 1050 µs    | 1224 µs | 1150 µs     |
| 500  | 548 µs  | 550 µs     | 649 µs  | 650 µs      |
| 250  | 290 µs  | 300 µs     | 418 µs  | 400 µs      |
| 100  | 141 µs  | 150 µs     | 224 µs  | 250 µs      |

The ~50 µs p50 floor is the cost of one `vm_start → arm timer →
main_loop_wait → vm_stop` cycle plus an `epoll_wait`. The ~150 µs p99
floor is host-scheduler jitter: GLib timer expiry and kernel wakeup
noise. CPU pinning + `SCHED_FIFO` would compress the p99 floor but
cannot push the p50 floor below the cycle cost.

Three consequences fall out:

1. **Below `dt` ≈ 25 µs the median floor dominates** (p50/dt > 3.7×) —
   asking for a finer slice no longer buys finer time resolution, only
   more CPU spent in the stepping machinery.
2. **Below `dt` ≈ 150 µs the tail floor dominates** (p99/dt > 2×) —
   median may still look acceptable but the worst case roughly doubles
   the requested slice.
3. **SMP widens the tail more than it shifts the median.** Going from
   single-core to dual-core-timer at 500 µs added ~50 µs to p50 (+9%)
   but ~180 µs to p99 (+27%) and ~235 µs to p99.9 (+31%). Two vCPUs
   bring TCG-lock contention and more `main_loop_wait` reasons-to-wake.

### Operating point: **1 ms REALTIME, validated for SMP**

Frozen decision (2026-05-15): the embedding API will be exercised at a
**1 ms fixed step under `QEMU_CLOCK_REALTIME`**, no `-icount`.

Numbers at the operating point:

- Single-core: p50 = 1.10×, p99 = 1.22×, p99.9 = 1.26× of `dt`.
- SMP (extrapolated from the 500 µs delta, +27% to p99 vs single-core
  for the same dt): p50 ≈ 1.17×, p99 ≈ 1.35×, p99.9 ≈ 1.40×.

That leaves a working margin of ~65% on p99 before the slack runs out,
which absorbs the unmeasured cost of a loaded guest (active IRQs,
sustained UART/GRSPW2 traffic) and any additional SMP penalty under
realistic workloads.

500 µs was the original candidate ("we have plenty of headroom") and
single-core measurements supported that. SMP narrowed the cushion to
p99 = 1.65× (35% slack remaining, p99.9 hitting 2.00×), comparable to
single-core at 250 µs — the same regime we rejected for tail behaviour.
1 ms re-establishes a comfortable cushion at the cost of 1 kHz tick
rate vs 2 kHz.

**Escalation triggers** — revisit this decision if any of these occur:

- A real workload pushes sustained p99 above ~1.4 ms at 1 ms `dt` (i.e.
  > 40% slip in the tail). Indicates the loaded-guest assumption is
  worse than predicted.
- The SMP2 host scheduler requires a tick rate above 1 kHz.
- Determinism becomes a hard requirement → switch to
  `QEMU_CLOCK_VIRTUAL` + `-icount`, blocked today by the two issues in
  the next subsection.
- Deployment moves to a preempt-RT kernel with CPU isolation → re-run
  the sweep; the p99 floor likely drops and finer `dt` becomes viable.

### Reproducing the sweep

CSVs and summary outputs land in `/tmp/embed-sweep/` (gitignored).

```bash
mkdir -p /tmp/embed-sweep
# Single-core sweep:
for dt_n in "1000 200" "500 400" "250 800" "100 2000" "10 20000" "5 40000"; do
    set -- $dt_n
    ./qemu/build/qemu-system-sparc --embed-poc-step \
        apps/01-hello-rtems/hello.exe $1 $2 0 \
        >/tmp/embed-sweep/hello-${1}us.csv \
        2>/tmp/embed-sweep/hello-${1}us.summary
done
# SMP validation at 500 µs (and any other point of interest):
./qemu/build/qemu-system-sparc --embed-poc-step \
    apps/02-dual-core-timer/dual_core_timer.exe 500 400 0 \
    >/tmp/embed-sweep/smp-500us.csv \
    2>/tmp/embed-sweep/smp-500us.summary
# Percentiles from any CSV (wall_dt column):
awk -F, 'NR>1 {print $4}' /tmp/embed-sweep/<file>.csv | sort -n | awk '
    {a[NR]=$1}
    END {
        n=NR
        printf "n=%d min=%d max=%d\n", n, a[1], a[n]
        printf "p50=%d p90=%d p95=%d p99=%d p99.9=%d\n",
            a[int(n*0.50)], a[int(n*0.90)], a[int(n*0.95)],
            a[int(n*0.99)], a[int(n*0.999)]
    }'
```

### Open work for deterministic replay

Bit-exact reproducibility requires `QEMU_CLOCK_VIRTUAL` + `-icount`,
currently blocked by two issues in the gr712rc model (not in our
embedding wrapper):

1. **SMP startup under `-icount`**: the IRQMP MPSTATUS CPU-release
   handshake needs auditing. CPU0/CPU1 ordering under
   instruction-quantized time appears to deadlock during BSP init.
2. **Halted vCPUs under `-icount`**: when guests reach `wfi` or call
   `exit()`, the virtual clock stops advancing and a step-loop timer at
   `now + dt` is unreachable. Needs either `sleep=on` semantics (warp
   to next deadline) or an explicit "advance virtual time" helper.

## Related branch

- `feat/configurable-peripherals` — orthogonal work on a JSON-driven machine
  and plug-in `.so` peripherals. The two efforts compose: a fully embedded
  QEMU using configurable peripherals would be the target end state.
