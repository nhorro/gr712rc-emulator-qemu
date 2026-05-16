# Embedding QEMU under an external scheduler

**Status**: design evaluation, May 2026.

Use this document when planning to co-simulate the embedded
QEMU emulator alongside an external scheduler — a HIL test
harness, a physics simulator, a co-simulation orchestrator. It
catalogues the available coupling models, the empirical cost of
each, and which fits which use case. It does NOT prescribe a
single answer — the right choice depends on what the external
scheduler is and what timing guarantees are required.

## Problem statement

There are two schedulers in the loop:

- **External scheduler**: the consumer of the SDK. Advances some
  notion of time by `dt` per cycle. Examples: a Simulink
  Real-Time host running at 1 kHz, a SystemC TLM kernel running
  as-fast-as-possible, a custom Python test harness running
  ad-hoc.
- **QEMU's internal scheduler**: vCPU threads under MTTCG, the
  iothread, the GLib main loop. Advances guest time as it
  executes guest instructions and processes virtual devices.

For the co-simulation to be useful, the two schedulers must
**agree on time** when they synchronise. The questions are:

1. What does "agree on time" mean in this deployment? (Virtual
   time only? Wall clock too?)
2. How fine can `dt` get before the coupling overhead eats the
   step?
3. Is drift between the two clocks bounded, or does it
   accumulate?

## What this session established (empirical, May 2026)

Measured on a contemporary Linux host (no special tuning) with
the SDK's REALTIME pacing model:

| Machine          | Per-step floor | Slip at dt = 1 ms | Slip at dt = 5 ms |
| ---              | ---            | ---               | ---               |
| gr712rc SMP (2c) | ~120 µs        | +12 %             | +3 %              |
| gr740   SMP (4c) | ~220 µs        | +22 %             | +5 %              |

**The per-step floor is structural** — it is the wall-clock cost
of `vm_start` + `main_loop_wait` + `vm_stop` cycling, dominated
by cross-thread futex / BQL handover. It is independent of
guest workload, independent of which clock (REALTIME vs
VIRTUAL) drives the deadline, and not addressable by patching
`pause_all_vcpus` (three variants attempted, none moved the
floor more than ~10 µs).

See `docs/13-icount-step-pacing.md` for the detailed measurement
data and the Option 2 / Option 3 investigation.

## Restating the constraint

The previous summary one might infer — *"having two schedulers
is too expensive"* — is half right.

- **Right**: the per-step coordination cost is real and not
  removable. At `dt = 100 µs` the floor exceeds the requested
  step (~250 µs floor vs 100 µs target), so the coupling can't
  go finer than ~ms scale.
- **Wrong**: that sync between the two schedulers is
  fundamentally broken. Sync is solvable cleanly when the
  external scheduler's clock is virtual; what cannot be made
  cheaper is the per-step **wall** cost.

The decision then becomes: pick the coupling model whose timing
guarantees match the external scheduler's, and budget around
the ~150 µs per-step floor.

## Solution catalogue

Five models, each evaluated on the same axes: how it couples,
what kind of drift it has, what kind of real-time semantics it
provides, and what work remains in the SDK to use it.

### Model A — REALTIME pacing (current default)

```
external      QEMU
+---------+   +-------+
| step dt |---| arm REALTIME timer at wall+dt
|         |   | vm_start vCPUs
|         |   | wait timer
|         |---| vm_stop @ wall ~= old+dt+floor
+---------+   +-------+
```

- **Mechanism**: deadline timer on `QEMU_CLOCK_REALTIME`, fires
  when wall clock crosses `now + dt`. vm_stop runs from the
  iothread context.
- **Drift between clocks**: guest virtual time and the external
  clock both track wall clock. The QEMU step takes
  `dt + ~150 µs` of wall. The external scheduler thinks it
  advanced `dt`; QEMU's wall clock advanced `dt + 150 µs`. After
  N steps, guest is N×150 µs *ahead* of the external scheduler.
  At dt = 1 ms this is 15 % cumulative drift over 100 steps.
- **Real-time matching**: by construction wall ≈ guest.
- **Effort to use**: zero. This is what `embed_qemu_step(dt)`
  does today.
- **Fit for**: HIL demos, single-cycle smoke tests, anything
  where ±10 % timing is acceptable. Most "I just want a guest
  running" use cases.
- **Doesn't fit**: lockstep co-simulation, regression testing
  with bit-exact replay, any workflow that does many steps and
  cares that they don't drift.

### Model B — `-icount` + absolute virtual deadlines (lockstep)

```
external      QEMU
+---------+   +-------+
| step i  |---| arm VIRTUAL timer at t_epoch + i*dt
| of dt   |   | vm_start
|         |   | wait icount budget exhaust virtual time
|         |---| vm_stop @ virtual = i*dt + chunk_remainder
+---------+   +-------+
```

- **Mechanism**: QEMU runs with `-icount shift=10,sleep=on`.
  Each step's deadline is absolute (epoch + i*dt) on
  `QEMU_CLOCK_VIRTUAL`, not relative. Per-step overshoot from
  icount chunk boundary is absorbed by the next step's absolute
  target.
- **Drift between clocks**: zero cumulative. Per-step error is
  bounded by `icount_percpu_budget` ≈ 50-100 µs in virtual
  time. After N steps, guest virtual time is at
  `t_epoch + N*dt ± chunk`, regardless of how many steps.
- **Real-time matching**: NOT matched. QEMU runs as fast as
  TCG manages, plus warps virtual time forward when all vCPUs
  idle (sleep=on). May be faster OR slower than wall.
- **Effort to use**: ~1-2 days. Bug A (the VIRTUAL-timer wake
  bug) was fixed in commit 16f8dc3. What remains: package as
  `embed_qemu_init_icount` + `embed_qemu_step_locked` API
  variants that handle absolute deadlines internally.
  **Blocker**: gr740 SMP under `-icount` still hangs at every
  shift (Blocker B from docs/13). Currently gr712rc-only.
- **Fit for**: co-simulation with an external scheduler whose
  clock is also virtual (SystemC TLM as-fast-as-possible, FMI
  co-sim, Python test harness with explicit step). Regression
  tests where bit-exact replay matters (additional work needed
  on peripherals — see docs/12).
- **Doesn't fit**: real-time HIL with physical hardware where
  the wall clock IS the requirement.

### Model C — Model B + external wall-clock rate limiter

```
external                 QEMU
+----------------+       +-------+
| step i of dt   |-------| advance VIRTUAL i*dt (Model B)
| if wall < dt:  |       |
|   sleep        |       |
+----------------+       +-------+
```

- **Mechanism**: Model B internally, plus the external
  scheduler sleeps to consume any wall-clock slack. If the
  step's wall completion was 700 µs and `dt = 1 ms`, sleep
  300 µs externally before the next step. If wall was 1.2 ms
  (over budget), don't sleep (best-effort match).
- **Drift between clocks**: zero in virtual; bounded in wall by
  the worst-case per-step wall time (≈ TCG cost + 200 µs floor).
- **Real-time matching**: matched on average if `dt` is larger
  than the worst-case wall per step (typically `dt ≥ 5 ms`
  works comfortably; `dt = 1 ms` works with bounded jitter).
- **Effort to use**: Model B's work plus a rate-limiter loop in
  the external scheduler. Trivial on the SDK side.
- **Fit for**: real-time HIL with strict timing AND
  scheduler-to-scheduler sync. The "best of both" position.
- **Doesn't fit**: `dt < 1 ms`. The wall-clock floor of the
  step itself can exceed sub-millisecond budgets, so the
  sleep-to-match approach loses meaning.

### Model D — Continuous-run with virtual-time sync points

```
external                 QEMU
+-------------+          +-------+
| start QEMU  |--------->| vm_start (one shot)
|             |          | runs continuously under REALTIME
| host loop:  |          |
|   sleep dt  |          |
|   read state|<-MMIO----| host MMIO read takes BQL,
|             |          |   synchronously serialised with vCPUs
|   write evt |--MMIO--->|
+-------------+          +-------+
```

- **Mechanism**: QEMU runs continuously under REALTIME pacing
  after a single `vm_start`. No per-step pause. The host
  observes / drives state via the host-side peripheral SDK
  (`docs/12-host-side-peripherals.md`). Each MMIO transaction
  from the host takes the BQL, which naturally synchronises
  with the vCPU thread for the duration of the transaction.
- **Drift between clocks**: depends on the sync point cadence.
  If the host samples at wall-clock `dt` intervals, guest
  virtual time advances roughly `dt` between samples, with
  small variance from TCG throughput.
- **Real-time matching**: by construction wall ≈ guest (it's
  REALTIME mode internally).
- **Per-sync-point cost**: ~10 µs (single MMIO transaction +
  BQL acquire), versus ~150 µs for a full pause/resume cycle.
  **An order of magnitude lower than Models A/B/C.**
- **Effort to use**: medium. The mechanism is already in place
  (host-side peripherals), but the SDK doesn't yet package it
  as a "step-equivalent" API. The host has to design its loop
  around MMIO reads, not `embed_qemu_step` calls.
- **Fit for**: high-rate sampling (sub-millisecond effective
  rate is achievable), HIL where the host doesn't need
  stop-the-world atomic state snapshots.
- **Doesn't fit**: workflows that require the guest to be
  paused while the host inspects multiple state items
  atomically. Continuous-run gives a "rolling view" of the
  guest, not a frozen snapshot.

### Model E — Process separation + IPC (acknowledged, not recommended)

QEMU as a separate process with the external scheduler driving
it via IPC (Unix socket, shared memory). Adds a process
boundary and IPC marshalling cost on top of everything Model
A/B does. The SDK explicitly exists to avoid this. Listed for
completeness — only relevant if libqemu turns out to be
fundamentally unfit for some unforeseen reason.

## Recommendation matrix

| External scheduler shape                            | Timing requirement   | Recommended model | Effort beyond current SDK |
| ---                                                 | ---                  | ---               | ---                       |
| Wall-clock-driven, ±10 % timing OK                  | Real-time            | **A** (current)   | Zero                      |
| Wall-clock-driven, strict timing                    | Hard real-time, dt ≥ 5 ms | **C**         | 1-2 d (Model B work + host rate limiter pattern documented) |
| Virtual-time, as-fast-as-possible                   | Lockstep, no drift   | **B**             | 1-2 d (icount opt-in API) |
| Virtual-time, sub-ms sampling                       | Lockstep, sub-ms     | **D**             | 3-5 d (loop pattern + examples) |
| Mixed / unclear                                     | Mixed                | Start at **A**, escalate when a use case forces it | — |

## What is and isn't shipped today

| Building block                                       | Status                                  |
| ---                                                  | ---                                     |
| REALTIME `embed_qemu_step(dt)` (Model A)             | Shipped, current default                |
| `qemu_notify_event` exported for cross-thread wake   | Shipped (1d32a74, 16f8dc3)              |
| Flag-based step deadline callback                    | Shipped (16f8dc3)                       |
| icount mode opt-in API (Models B/C)                  | **Not shipped** — wrapper changes only, 1-2 days |
| Absolute virtual deadlines in step API               | **Not shipped** — required for Model B  |
| gr740 SMP under `-icount` (Blocker B)                | **Not investigated** — needed for parity if Model B/C is offered |
| Host-side peripheral SDK (Model D substrate)         | Shipped (`docs/12-host-side-peripherals.md`) |
| Documented "sampling loop" host pattern (Model D)    | **Not shipped** — would need example + doc |
| Determinism via virtual-time-paced peripherals       | **Not shipped** — design pass required, depends on Model B |

## What this evaluation deliberately does NOT prescribe

- **A single recommended model.** Each model trades different
  axes (real-time accuracy vs. determinism vs. per-step
  cost). The right pick depends on what the external
  scheduler is, and that is a deployment decision.
- **A schedule.** The "effort beyond current SDK" column gives
  order-of-magnitude estimates assuming the use case is clear.
  None of these is shipped today; the order in which they get
  built should follow concrete user demand, not speculation.
- **A claim of "this is fast enough".** ~150 µs per step is the
  wall-clock floor for Models A/B/C; whether that's tolerable
  is a property of the external scheduler's requirements, not
  of the SDK.

## Queued next steps (2026-05-16)

The path forward decided at the end of the May 2026
investigation is to ship Model B's plumbing speculatively
(without waiting for a specific consumer), then investigate
Blocker B for gr740 SMP parity. Order:

1. **Ship Model B opt-in API** (~1-2 days, in
   `embed/embed_qemu.{h,c}`):
   - `embed_qemu_init_icount(argc, argv)` — adds
     `-icount shift=10,sleep=on` to qargv internally and arms
     the step timer on `QEMU_CLOCK_VIRTUAL`.
   - `embed_qemu_step_locked(dt_ns)` — uses an absolute virtual
     deadline `t_epoch_virt + step_count*dt_ns` so per-step
     overshoot does not accumulate.
   - New example under `embed/examples/gr712rc-lockstep/`.
   - Update `docs/11-embedding-as-library.md` with the new mode.
   - Document the gr740 SMP limitation explicitly (gated by
     Blocker B).
2. **Investigate Blocker B** (~5-10 days, uncertain) — only
   after step 1 lands. Instrumentation of
   `accel/tcg/tcg-accel-ops-rr.c` to identify the
   `icount_percpu_budget` / `icount_handle_deadline` failure
   mode with 4 active vCPUs.

Step 1 is low-risk modest-scope and provides immediate
building-block value for any future consumer needing
lockstep sync. Step 2 is gating for full machine parity on
the icount mode.

## Closing

The two-scheduler architecture is workable. Per-step coupling
overhead (~120-220 µs) is a budget item, not a defect — it
limits the smallest viable `dt` to roughly ms-scale for Models
A/B/C, and pushes higher-rate workflows toward Model D
(continuous-run with sampling). Sync correctness between the
two schedulers, in contrast, is a solved problem under Model B
once packaged.

The next concrete step is to wait for a real consumer use case
and pick the model accordingly. The SDK's current default
(Model A) covers the broadest swath of HIL workflows; the
upgrade paths (B, C, D) are scoped, the technical risk has been
characterised, and the work is bounded.
