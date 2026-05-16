# Design: `-icount` + VIRTUAL-clock step pacing (Option 3)

**Status**: design proposal, partial empirical baseline available.

**Goal**: lower the `embed_qemu_step(dt)` per-step wall-clock floor
from ~130 µs (gr712rc SMP) / ~230 µs (gr740 SMP) to ~5–20 µs at
dt = 1 ms, **and** decouple guest time from wall-clock to enable
deterministic replay. Preserves the host-as-time-master semantics
of the SDK API: the host still says "advance N µs of guest time,
return when done."

## What this replaces and why

A first attempt — Option 2 — proposed cutting the floor by
reducing the cost of `vm_start` / `vm_stop` thread coordination
(replacing `qemu_cond_wait` round-trips in `pause_all_vcpus` with
an atomic spin). The attempt was implemented and measured in May
2026; the data invalidated the premise:

| Variant in `pause_all_vcpus` | `vm_stop` mean (gr712rc SMP) |
| ---                          | ---                          |
| Original (cond_wait)         | 133 µs                       |
| BQL-held atomic spin         | 128 µs                       |
| Broadcast-only-when-all      | 131 µs                       |
| BQL-released atomic spin     | 126 µs                       |

Variants moved the floor by 5–10 µs (within noise). Deep
instrumentation showed that even with halted CPUs (no in-flight
MMIO, idle guest), `pause_all_vcpus` itself costs ~105 µs
dominated by the cross-thread futex / BQL handover between
iothread and N vCPU threads. That cost is structural to the
"pause every vCPU at a wall-clock deadline" model under Linux
pthread + MTTCG, and is not addressable by changing where the
broadcast happens or how the iothread waits.

Conclusion: the only way to lower the floor materially is to
stop using wall-clock-deadline pausing. Option 3 does that.

## Why `-icount` + VIRTUAL deadline works (when unblocked)

With `-icount shift=10,sleep=on` enabled:

- The vCPU instruction count drives virtual time. One instruction
  contributes `2^shift` ns of virtual time.
- A `QEMUTimer` armed on `QEMU_CLOCK_VIRTUAL` fires when virtual
  time crosses its expiry — which can happen at a TB exit
  boundary or, with `sleep=on`, by warping when all vCPUs go
  idle (WFI / power_down).
- The step deadline is virtual, not wall. The host no longer
  needs to forcibly pause the world at an arbitrary wall-clock
  instant — the VM voluntarily stops at the icount budget
  boundary, which is a TB exit. No mid-helper interruption, no
  cross-thread "did everyone ack?" round-trip.

Expected per-step wall cost under icount: dominated by TCG
execution time for the budget plus a single notify back to the
main thread. Per-step floor estimated at < 20 µs (no data yet —
see acceptance criteria).

## Two known blockers

The May 2026 audit (see `docs/11-embedding-as-library.md`
§ Determinism / icount) characterised what works and what
doesn't:

### Blocker A — VIRTUAL-clock timer doesn't wake `main_loop_wait`

The intended pattern is:

```c
step_timer = embed_timer_new_ns(QEMU_CLOCK_VIRTUAL, deadline_cb, NULL);
...
timer_mod_ns(step_timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + dt);
vm_start();
while (runstate_is_running()) {
    main_loop_wait(false);
}
```

Empirically the timer callback DOES fire (in the
`rr_cpu_thread_fn` context, via `icount_handle_deadline`) and
`vm_stop` runs. But the host thread blocked in
`main_loop_wait` → `ppoll` is never woken — no notify writes the
main-loop eventfd. Result: indefinite hang.

This is the more tractable blocker. Suspected fix locations:

- `accel/tcg/icount-common.c` (deadline handling for virtual
  timers).
- Possibly add a `qemu_notify_event()` after virtual-timer
  callback dispatch from `rr_cpu_thread_fn`.

### Blocker B — gr740 SMP hangs under `-icount` at every shift

With all four LEON4 cores active (e.g.
`apps/08-gr740-smp/quad_core_timer.exe`), boot completes but
the guest hangs once cores enter the idle loop. gr712rc SMP (2
cores) works with the same configuration. Single-core gr740 with
the other three cores halted-at-reset works.

Suspected cause: `accel/tcg/tcg-accel-ops-rr.c`
`icount_percpu_budget(cpu_count)` / `icount_handle_deadline`
interaction when 4 vCPUs share the round-robin budget. Deeper
than blocker A; needs instrumentation to identify the failure
mode.

## Plan

Tackle in order, lowest-risk first:

1. **Blocker A — investigate and fix the VIRTUAL-timer wake-up
   path** (estimate: 3–5 days).
   - Reproduce with a minimal host that arms a VIRTUAL timer and
     waits in `main_loop_wait`.
   - Trace whether `icount_handle_deadline` actually fires our
     callback. If yes, instrument what's missing on the
     notify-back path.
   - Likely fix: `qemu_notify_event()` after virtual timers are
     processed in `rr_cpu_thread_fn`, mirroring the existing
     `all_cpu_threads_idle` path.

2. **SDK plumbing on top of A** (estimate: 1–2 days).
   - Add an opt-in `embed_qemu_init_icount(...)` or a flag on
     `embed_qemu_init` that enables `-icount shift=10,sleep=on`
     in the qargv and switches the step deadline from REALTIME
     to VIRTUAL.
   - Measure the floor on gr712rc SMP at dt = 1 ms, 500 µs, 100 µs.
   - Acceptance: per-step wall < 20 µs at dt = 1 ms.

3. **Blocker B — investigate gr740 SMP icount budget** (estimate:
   5–10 days, higher uncertainty).
   - Reproduce in isolation (without our wrapper). Already
     known: plain `qemu-system-sparc -M gr740 -icount shift=X,sleep=on`
     hangs for X ∈ {0, 4, 8, 10, 12, auto} with quad_core_timer.
   - Instrument `icount_percpu_budget`, `icount_handle_deadline`,
     and `rr_cpu_thread_fn`'s main loop to identify the failure
     mode. Likely candidates: budget underflow, deadline race
     specific to 4-vCPU dispatch, or interaction with sleep=on
     warp when 4 CPUs idle simultaneously.
   - Risk: this may be an upstream QEMU bug not specific to our
     fork. If so, the path forward becomes either a fork-local
     patch or upstream contribution.

4. **Ship parity** (estimate: 1–2 days).
   - With both blockers fixed, exercise the SDK API on gr712rc
     SMP, gr740 single-core, and gr740 SMP. Make sure the bundled
     examples can switch between REALTIME and icount modes.

## Acceptance criteria

The combined effort passes when:

- gr712rc SMP and gr740 SMP both boot, clock-tick, and exit
  cleanly under the icount-paced step path (4 SMP samples — the
  same correctness gate Option 2 used).
- `embed_qemu_step(dt = 1 ms)` mean wall < 30 µs on gr712rc SMP
  and < 50 µs on gr740 SMP.
- The example dt-sweep (1 ms / 500 µs / 100 µs / 10 µs) shows
  near-flat wall per step until the sub-microsecond regime
  where TCG execution itself starts to dominate.

If only Blocker A is unblocked but Blocker B remains, the SDK
ships with a documented limitation: icount mode supported on
gr712rc only, gr740 stays on the 5 ms REALTIME default. That is
acceptable as a partial deliverable per the machine-parity rule
in CLAUDE.md (the SDK feature exists for both machines; for
gr740 the feature is gated as "limited to REALTIME pacing").

## Risks

1. **Blocker A might be more than one missing notify.** If the
   icount deadline handler in QEMU 8.2.2 has structural reasons
   for not waking the main loop (e.g. main loop polls icount
   state separately), the fix may require reorganising the
   wake-up path. Mitigation: tracing first, patch second.

2. **Blocker B might be upstream.** If so, the resolution depends
   on how the upstream QEMU maintainers respond. Mitigation:
   keep the fork-local patch path open as the fallback.

3. **`-icount` introduces non-determinism due to host-side
   peripheral injection.** Host-side peripherals registered via
   the SDK (see `docs/12-host-side-peripherals.md`) fire MMIO at
   wall-clock-driven moments; under icount this breaks bit-exact
   replay. Mitigation: document that determinism requires either
   no host-side peripherals or that the host inject events at
   virtual-time-defined moments. Wall-clock-paced step mode
   remains available for HIL use cases.

4. **Cache invalidation on shift change.** When `shift=auto`
   adapts, the bias recomputation has a known race path that
   left `qemu_icount_bias` in an unrecoverable state in our
   audit. We will use a fixed shift (10) to side-step this.

## Notes on Option 2

Option 2 (atomic-spin redesign of `pause_all_vcpus`) is shelved
with the data above. Reviving it would require either a
compute-only workload where the vCPUs ack quickly (rare for
real guests) or a different threading model. Neither is in
scope. The instrumentation work that exposed the structural
floor is left documented here so a future investigation does
not repeat it.
