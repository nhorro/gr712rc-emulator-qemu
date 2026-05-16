# Design: lower the per-step coordination floor (Option 2)

**Status**: design proposal, not implemented.

**Goal**: reduce the per-step wall-clock floor of
`embed_qemu_step(dt)` from ~120 µs (gr712rc SMP) / ~220 µs (gr740
SMP) to ~30–60 µs, **without** changing the SDK API surface or the
host-as-time-master semantics.

**Non-goal**: this doc does not propose adding `-icount` /
VIRTUAL-clock pacing. That is Option 3, kept as a follow-up if
Option 2 doesn't lower the floor enough. See the "Option 3 as
follow-up" section at the end and `docs/11-embedding-as-library.md`
§ Determinism / icount.

## Why this is worth it

Measured slip with the current REALTIME step loop at dt = 1 ms
(see `docs/11-embedding-as-library.md` § Multi-core dt-sweep):

| Machine | Slip | Per-step floor |
| ---     | ---  | ---            |
| gr712rc SMP (2c) | +12.1% | 121 µs |
| gr740   SMP (4c) | +21.6% | 216 µs |

Decomposition: the floor is **not** TCG (we verified TCG runs
faster than wall at all tested loads). It is **not** WRPSR /
target BQL (instrumentation showed ~1500 WRPSRs/s in steady state,
<0.2% of slip). It is the iothread ↔ vCPU coordination cost of
`vm_start` + `main_loop_wait` + `vm_stop` per step.

Moving the operating point to dt = 5 ms hid the cost (5 ms × 1000
amortizes 60 µs to 1.2%) and is the current recommended default.
This design re-attacks dt = 1 ms by lowering the floor itself,
which `dt = 5 ms` also benefits from.

## Where the cost actually is

Current `pause_all_vcpus()` in `qemu/system/cpus.c:554-583`:

```c
CPU_FOREACH(cpu) {
    if (self)   qemu_cpu_stop(cpu, true);
    else      { cpu->stop = true; qemu_cpu_kick(cpu); }
}
while (!all_vcpus_paused()) {
    qemu_cond_wait(&qemu_pause_cond, &qemu_global_mutex);
    CPU_FOREACH(cpu) qemu_cpu_kick(cpu);  /* re-kick if missed */
}
```

Under MTTCG, `qemu_cpu_kick` resolves to `cpu_exit` — atomic
`qatomic_set(&cpu->exit_request, 1)` plus an icount-decr poke.
**That part is already lockless.** The expensive piece is the
`qemu_cond_wait(&qemu_pause_cond, ...)` round-trip while the
iothread waits for the vCPU thread to acknowledge by setting
`cpu->stopped = true` and signalling the cond. Futex round-trips
on Linux measure 5–20 µs each, and the loop re-kicks then re-waits
if any vCPU hasn't acked yet. With 2 vCPUs this is one or two
iterations of the cond wait, ~30–50 µs total per `pause_all_vcpus`.
`vm_start` (via `resume_all_vcpus`) has a smaller analogous cost,
~10–20 µs.

So **~50 µs of the ~120 µs floor is futex traffic between iothread
and vCPU threads** for the pause acknowledgement. The rest is
`main_loop_wait` (epoll + dispatch), `qemu_clock_get_ns` syscalls,
and per-step bookkeeping — those are not addressed here.

## Design

Replace the cond-based "wait for ack" with an atomic-polling
shutdown:

1. **`cpu->stop` already exists as a flag.** vCPU threads already
   check it via `cpu_thread_is_idle` / `cpu_can_run`. No new field
   needed for the request side.

2. **`cpu->stopped` already exists as the ack flag.** vCPU sets
   it true when it has actually paused, in `qemu_wait_io_event`.
   No new field needed for the ack side.

3. **What changes is how the iothread waits**. Replace:

   ```c
   while (!all_vcpus_paused()) {
       qemu_cond_wait(&qemu_pause_cond, &qemu_global_mutex);
       ...
   }
   ```

   with a short adaptive spin that uses `qatomic_read(&cpu->stopped)`
   for each cpu and only falls back to a brief futex wait if any
   vCPU hasn't acked within ~50 instructions of host spinning.

   The vCPU, having seen `cpu->stop` and being interrupted by
   `cpu_exit`, will exit its current TB within a few hundred guest
   instructions ≈ 1 µs of wall time. The iothread doesn't need a
   round-trip wakeup — it can poll.

4. **`vm_start` / `resume_all_vcpus` symmetrically**: instead of
   `qemu_cpu_kick(cpu)` (which on MTTCG-running CPUs is a no-op,
   on halted CPUs sends a futex wake to release the halt_cond
   wait), test for the halted case explicitly and only do the
   cond_signal when needed. For non-halted vCPUs, atomic clear of
   `stop`/`stopped` is enough — the vCPU will start the next TB
   on next iteration.

Net: replace one futex round-trip (~10–30 µs) per pause with a
short atomic spin (<1 µs typical). vCPU TB-exit cost is unchanged
(the existing `exit_request` mechanism is reused).

### Halted vCPUs are not affected

A vCPU in `wfi` / `helper_power_down` sleeps on `halt_cond` via
`qemu_wait_io_event`. That path still needs a `qemu_cond_signal`
to wake. The atomic-spin redesign only covers the
running-then-paused transition; halted vCPUs continue to use the
cond mechanism as today. This means the patch does NOT regress
the halted-vCPU wake latency, which is on the IRQ-delivery
critical path.

Concretely: `cpu_exit` (atomic) is for running vCPUs; cond_signal
is for halted vCPUs. The path that decides which to use is in
`qemu_cpu_kick` and accel-specific kick implementations — those
are already structured this way, no change needed.

## Files touched (estimate)

| File | What changes | LoC |
| ---  | ---          | --- |
| `qemu/system/cpus.c` | `pause_all_vcpus`, `resume_all_vcpus` switch to atomic-poll path | ~80 |
| `qemu/accel/tcg/tcg-accel-ops-mttcg.c` | possibly tighten the vCPU thread's wait predicate so it sets `stopped` immediately on seeing `stop` | ~20 |
| `qemu/accel/tcg/tcg-accel-ops-rr.c` | same, for round-robin | ~20 |
| `qemu/include/hw/core/cpu.h` | no new field; possibly add a documented atomic-access contract comment on `stop`/`stopped` | ~10 |

Total: ~130 LoC patch. No new types, no API surface change in
`libqemu.h` / `embed_qemu.h`.

## Measurement plan

Before / after, on the bundled `embed/examples/{gr712rc,gr740}/`
binaries:

| Configuration | Metric |
| ---           | ---    |
| gr712rc SMP, dt = 1 ms, 5000 steps | mean per-step wall (µs), slip (%) |
| gr712rc SMP, dt = 500 µs, 10000 steps | mean per-step wall, slip |
| gr740 SMP, dt = 1 ms, 5000 steps | mean per-step wall, slip |
| gr740 SMP, dt = 5 ms, 1000 steps | mean per-step wall, slip (operating point check) |

Each cell: 3 trials, median reported. Pass criterion: per-step
floor drops by ≥ 2× on at least gr712rc SMP at dt = 1 ms. If the
floor drops by ≥ 3×, the recommended operating point in
`docs/11-embedding-as-library.md` can revisit moving back to 1 ms.

**Correctness gate** (must pass before any perf measurement
counts):

- `apps/01-hello-rtems/hello.exe` → "END OF TEST" on gr712rc.
- `apps/02-dual-core-timer/dual_core_timer.exe` → both cores
  interleave counters on gr712rc SMP for ≥ 4 s.
- `apps/07-hello-gr740/hello.exe` → "END OF TEST" on gr740.
- `apps/08-gr740-smp/quad_core_timer.exe` → all four cores
  interleave counters on gr740 SMP for ≥ 4 s.

Any regression here aborts the patch — the pause/resume path is
in the SMP boot critical section and a race here would surface as
a silent hang or a missed IRQ.

## Risks

1. **Race between iothread atomic-spin and vCPU TB-exit**. The
   iothread reads `cpu->stopped`; the vCPU writes it. Without a
   memory barrier on the vCPU side, the iothread could see the
   write reordered. Mitigation: `qatomic_set_release` on the
   vCPU side, `qatomic_load_acquire` on the iothread side.
   QEMU's atomic primitives provide both.

2. **Spin too long under host load**. If the host is heavily
   loaded and the vCPU thread doesn't get scheduled within the
   spin window, the iothread wastes CPU cycles spinning before
   falling back to cond_wait. Mitigation: bound the spin (e.g.
   `< 64 pause-instructions` ≈ < 1 µs) and fall back to
   `qemu_cond_wait` after that. The fallback is the same cost as
   today, so worst-case is current behavior.

3. **vCPU never exits TB**. If a single TB runs for an unbounded
   number of instructions (e.g. a tight idle spin in the guest),
   `cpu_exit` only takes effect at the next TB boundary. With
   default TB chaining limits (~1000 insns / 100 ns), this is not
   a real concern, but worth a comment in the code.

4. **MTTCG ↔ RR divergence**. The patch must work identically
   under both. Round-robin TCG also calls `pause_all_vcpus` and
   relies on the same mechanism, but in RR there's only one
   thread, so the spin window is tighter. Manageable; the test
   plan exercises only MTTCG (the default for sparc-softmmu).

5. **Interaction with `qemu_pause_cond`**. Other paths in
   `qemu/system/cpus.c` use this cond (migration, snapshots,
   `cpu_remove_sync`). The patch must keep the cond functional —
   the change is to bypass it on the fast path, not remove it.

## Option 3 as follow-up (if Option 2 is not enough)

If Option 2's measured floor lands at, say, ~60 µs and that's
still not low enough for a real consumer's needs (≥ 1 kHz host
tick with < 1% slip), the next escalation is Option 3: `-icount`
+ VIRTUAL-clock step deadline. It changes the pacing model
(virtual time advance, not wall-clock deadline) and gives
determinism as a bonus.

Status of Option 3:

- **gr712rc SMP works** under plain `-icount shift=10,sleep=on`
  with `qemu-system-sparc` (confirmed during the May 2026 audit).
- **gr740 SMP is blocked**: 4-core round-robin under `-icount`
  hangs at every shift. Suspected in
  `accel/tcg/tcg-accel-ops-rr.c` `icount_percpu_budget` /
  `icount_handle_deadline`. Needs deeper instrumentation.
- **VIRTUAL-clock step deadline in the wrapper is blocked**: the
  timer callback fires in the rr-thread context, `vm_stop` runs,
  but the host's `main_loop_wait` is not woken. Needs an explicit
  `qemu_notify_event()` exposed in the SDK and called by the
  wrapper after `vm_stop`, or a fix in the icount deadline path
  that emits the notify itself.

Option 2 does not block Option 3 and in fact compounds with it:
when Option 3 is unblocked, every step still benefits from the
cheaper coordination.

Reference: `docs/11-embedding-as-library.md` § Determinism /
icount has the empirical sweep data and current findings.
