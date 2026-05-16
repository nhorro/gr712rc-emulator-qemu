# `-icount` + VIRTUAL-clock step pacing (Option 3)

**Status**: implemented and measured (May 2026, second pass).
**Sub-millisecond goal NOT achieved**; icount-mode opt-in
SHIPPED as a side benefit.

**Original goal**: lower the `embed_qemu_step(dt)` per-step
wall-clock floor from ~130 µs (gr712rc SMP) / ~230 µs (gr740 SMP)
to ~5–20 µs at dt = 1 ms, **and** decouple guest time from
wall-clock to enable deterministic replay. Preserves the
host-as-time-master semantics of the SDK API.

**Actual outcome (see Results section below)**: the per-step floor
under `-icount` + VIRTUAL deadline is **structurally identical to
REALTIME** — the floor is `pause_all_vcpus` cross-thread
coordination cost, not the deadline-firing mechanism. icount does
not deliver the sub-1 ms target. What it does deliver:
- functional VIRTUAL-clock-paced stepping (Bug A turned out to be
  in the SDK wrapper, not in QEMU; fix shipped);
- guest virtual time advances faster than wall when CPUs idle
  (`sleep=on` warp), useful for "skip idle periods" HIL flows;
- foundation for deterministic replay (still needs host-side
  peripherals to be virtual-time-paced).

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

## Results (May 2026, second pass)

### Blocker A was NOT a QEMU bug — it was in the SDK wrapper

The hang traces as follows:

1. Step timer (on `QEMU_CLOCK_VIRTUAL`) expires; under `-icount`
   this happens inside `icount_handle_deadline`, which runs in
   the **vCPU (rr_cpu_thread_fn) thread**.
2. Wrapper's `step_deadline_cb` calls `vm_stop(RUN_STATE_PAUSED)`.
3. `vm_stop` checks `qemu_in_vcpu_thread() == true`, so it does
   NOT call `do_vm_stop`. Instead it queues
   `vmstop_requested = PAUSED` and calls `qemu_notify_event()`.
4. **Runstate stays RUNNING.** The actual transition would only
   happen if someone (e.g. `qemu_main_loop` →
   `main_loop_should_exit`) processed the queued request. The
   embed wrapper uses its own `while (runstate_is_running())`
   loop and never processes the queue. Hence: infinite spin in
   `main_loop_wait`.

The wrapper-side fix:

- Step callback no longer calls `vm_stop`. It atomically sets a
  `step_deadline_hit` flag and calls `qemu_notify_event()` to
  ensure the host thread's `ppoll` wakes.
- The wrapper's step loop exits on `step_deadline_hit` (in
  addition to `!runstate_is_running()`), and calls `vm_stop`
  **synchronously from the iothread context**. There `vm_stop`
  takes the `do_vm_stop` path, transitions runstate, pauses
  vCPUs.
- This works identically for REALTIME and VIRTUAL deadlines —
  the flag pattern is thread-context-agnostic.

This required exposing `qemu_notify_event` in the SDK
(`qemu/include/libqemu.h` + `qemu/system/embed_api.map`), 1 new
export.

### Per-step floor under icount: structurally unchanged

Measured slip with the fixed wrapper + `-icount shift=10,sleep=on`
+ VIRTUAL-clock deadline on `gr712rc SMP / dual_core_timer`:

| dt      | Slip (icount + VIRTUAL) | Slip (REALTIME baseline) |
| ---     | ---                     | ---                      |
| 5 ms    | **−21.2%** (warp wins)  | +3.2%                    |
| 1 ms    | +10.3%                  | +12.1%                   |
| 100 µs  | **+150%**               | (~comparable)            |

At dt = 5 ms the icount path runs *faster than real-time*
because the guest spends most of its time idle waiting for clock
ticks, and `sleep=on` warps virtual time forward over those
idle gaps.

At dt = 1 ms the warp benefit shrinks (less idle per step) and
the per-step floor dominates again. At dt = 100 µs the floor
COMPLETELY dominates: 1 s of sim takes 2.5 s of wall, i.e.
~250 µs per step — same order of magnitude as the REALTIME path.

**Conclusion**: icount changes the deadline trigger but does NOT
remove `pause_all_vcpus` from each step. The cross-thread
coordination cost (~120–200 µs on this hardware) is the
structural floor, and is the same regardless of which clock the
deadline is on.

### Blocker B — gr740 SMP under `-icount` still hangs

NOT investigated in this pass. With all four LEON4 cores active
(e.g. `apps/08-gr740-smp/quad_core_timer.exe`), the guest hangs
once cores enter the idle loop. gr712rc SMP (2 cores) works with
the same configuration. Single-core gr740 with the other three
cores halted-at-reset works.

Suspected cause: `accel/tcg/tcg-accel-ops-rr.c`
`icount_percpu_budget(cpu_count)` / `icount_handle_deadline`
interaction when 4 vCPUs share the round-robin budget. Deeper
investigation deferred — the original motivation for tackling it
was sub-1 ms stepping, which icount cannot provide. Revisit if
a determinism or "skip-idle" use case for gr740 SMP appears.

## What shipped

- **`qemu_notify_event` exported in the SDK**
  (`qemu/include/libqemu.h` prototype +
  `qemu/system/embed_api.map` export). 1 new public symbol on
  the .so, documented as "safe to call from any thread; wakes
  any pending `main_loop_wait`'s ppoll." This unlocks the
  flag-based pattern in any external host that wants to do
  cross-thread signalling without taking the BQL.
- **Wrapper rewrite**: `embed/embed_qemu.c` step callback uses
  an atomic flag + `qemu_notify_event` instead of calling
  `vm_stop` directly. The wrapper's step loop exits on the flag
  and invokes `vm_stop` synchronously from the iothread context.
  Works for REALTIME (current default) and VIRTUAL (icount mode,
  opt-in).
- **Small REALTIME regression** of ~0.5 pp on gr712rc and ~1.5 pp
  on gr740 measured (~+3.7% vs +3.2% at dt = 5 ms on gr712rc
  SMP). The extra cost is one additional `vm_stop` call from the
  iothread context after `main_loop_wait` returns; on the old
  path that work happened inline in the callback. Acceptable
  trade-off for unblocking the VIRTUAL path.

## What did NOT ship

- **Sub-1 ms operating point**. The pause/resume floor is
  structural; neither Option 2 nor Option 3 moves it materially.
- **icount mode as a first-class SDK feature**. The wrapper
  still defaults to REALTIME. A consumer that wants icount-paced
  stepping needs to instantiate the timer on `QEMU_CLOCK_VIRTUAL`
  and add `-icount shift=10,sleep=on` to the qargv. That is
  doable with the now-exposed API but is not packaged as a
  one-liner.
- **gr740 SMP under icount**. Blocker B is unchanged; gr740 SMP
  still hangs at all shifts.

## Future work (only if motivated by a concrete use case)

If a consumer of the SDK appears that needs either deterministic
replay or "skip idle time" semantics, the path forward is:

1. **Package icount mode as an SDK option**. Add a flag or
   alternate init function (e.g. `embed_qemu_init_icount`) that
   sets up `-icount shift=10,sleep=on` and a VIRTUAL-clock
   deadline. Trivial wrapper work; the underlying mechanism is
   already proven on gr712rc.
2. **Fix Blocker B for full machine parity**. Required so the
   icount mode works on gr740 SMP. Estimated 5–10 days of
   instrumentation + patching in
   `accel/tcg/tcg-accel-ops-rr.c`. May turn out to be an
   upstream QEMU issue; investigation needed first.
3. **Determinism-aware host-side peripherals**. The host-side
   peripheral SDK (`docs/12-host-side-peripherals.md`) fires MMIO
   at wall-clock-driven moments today. For bit-exact replay
   under icount, peripherals must inject events at virtual-time
   moments. Not in scope here; would need its own design pass.

The sub-1 ms goal that motivated this exploration is closed: the
data shows it is not achievable in the current pause/resume
architecture on Linux + MTTCG. The HIL use cases targeted by the
SDK are well served by the 5 ms REALTIME operating point already
documented in `docs/11-embedding-as-library.md`.

## Known constraints if/when icount mode is packaged

If a future iteration ships `embed_qemu_init_icount` (point 1 of
future work):

- **Use a fixed `shift=10`**. `shift=auto` accumulates an
  unrecoverable `qemu_icount_bias` state and ends up with the
  warp timer effectively unreachable in wall-clock terms. Audit
  data is in `docs/11-embedding-as-library.md` § Determinism /
  icount.
- **Wall-clock-paced host-side peripherals break determinism**.
  The host-side peripheral SDK (`docs/12-host-side-peripherals.md`)
  fires MMIO at wall-clock-driven moments; under icount, this
  breaks bit-exact replay. Determinism would require
  virtual-time-paced injection — another design pass.
- **gr740 SMP is blocked**. The Blocker B issue means quad-core
  gr740 guests cannot use icount mode. Document this clearly in
  the SDK API if/when it's packaged.

## Notes on Option 2

Option 2 (atomic-spin redesign of `pause_all_vcpus`) is shelved.
Three variants were implemented and measured; the floor moved
5–10 µs (within noise). Even with halted CPUs the per-step cost
is ~105 µs dominated by cross-thread futex / BQL handover —
structural Linux pthread + MTTCG behaviour, not addressable by
patching `pause_all_vcpus`. The instrumentation work that
established this is documented here so a future investigation
does not repeat it.
