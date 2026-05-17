# Co-simulation scheduling — design FAQ

**Status**: design reference, May 2026. Answers "why isn't X
shipped?" without requiring readers to re-derive abandoned
investigations.

The SDK ships two coupling models:

- **Model A — REALTIME pacing at dt = 5 ms** (default). The host
  steps QEMU forward in discrete dt slices via
  `embed_qemu_step`. Operating point and empirical justification
  in `docs/11-embedding-as-library.md § Operating point and timing`.
- **Model D — continuous-run with MMIO sampling**. QEMU runs
  continuously after one `vm_start`; the host samples state via
  `embed_mmio_read` from a host-registered peripheral. Worked
  example at `embed/examples/sampling/`.

This document records both, plus what was considered and
rejected (Models B and C), to spare future readers from
re-deriving abandoned investigations.

## Why not lockstep / deterministic stepping (Model B, `-icount`)

A lockstep API (`embed_qemu_init_icount` + `embed_qemu_step_locked`,
absolute virtual deadlines, bit-exact reproducibility) was
prototyped in commit `b8899a4` and reverted in `3041aee`.

**Why it doesn't work for this project**: the primary apps are
SMP RTEMS (`apps/02-dual-core-timer`, `apps/08-gr740-smp`). Under
`-icount` + round-robin TCG, the RTEMS SMP ticket-lock pattern
(`_SMP_lock_ISR_disable_and_acquire`, paired `ta 0x9` / `ta 0xA`
software traps) keeps `PSR.PIL=15` for >99% of execution. External
IRQs (timer ticks, IPIs) are masked during that window; the brief
PIL-low windows between `rett` and the next `ta 0x9` are too short
for the rr scheduler to land an IRQ before the next critical
section starts.

**Empirical evidence** (preserved in commit `b8e8008`):

- gr740 SMP under `-icount auto,sleep=on`: 228,997 software traps
  and **0 external interrupts** in 3 seconds wall. Complete hang.
- gr712rc SMP under the same config: boots and runs, but
  ~10× slower than Model A (~10 lines of UART vs ~100+ in the
  same wall budget).
- Refuted: per-cpu icount budget saturation (`-smp 2` also hangs),
  `qemu_cpu_kick` failure (CPUs confirmed running), `ldstub`/`casa`
  atomicity (uses `tcg_gen_atomic_xchg_tl`), higher icount shifts
  (full 0–10 sweep + `align=on` + `sleep=off` all hang).

**When to reconsider**: only if (a) a consumer needs lockstep AND
can use single-core guests exclusively, or (b) upstream QEMU
addresses the rr+icount+PIL-spin interaction. Re-cherry-pick from
`b8899a4` minus the SMP examples.

## Why not sub-millisecond stepping

The wall-clock floor of one `vm_start → main_loop_wait → vm_stop`
cycle on Linux + MTTCG is ~120 µs (gr712rc SMP) to ~220 µs
(gr740 SMP). Three variants of `pause_all_vcpus` were measured;
the floor moved < 10 µs across all of them. The cost is structural
cross-thread futex / BQL handover, not addressable at the
deadline-firing layer.

Consequence: any `dt` below ~1 ms makes the floor dominate
(>20% slip on gr740 SMP at dt = 1 ms, see the dt-sweep in
`docs/11`). The recommended 5 ms point sits comfortably above
the floor.

## Model D — continuous-run with MMIO sampling (shipped)

The escape hatch from the per-step floor is to **stop stepping
per dt entirely**. Run QEMU continuously under REALTIME after a
single `vm_start`, and sample state via host-side MMIO from
peripherals registered through the SDK in
`docs/12-host-side-peripherals.md`. Each MMIO transaction costs
sub-microsecond when the iothread already holds the BQL — two
orders of magnitude lower than pause/resume.

```
external                 QEMU
+-------------+          +-------+
| start QEMU  |--------->| vm_start (one shot)
|             |          |
| host loop:  |          | runs continuously under REALTIME
|   sleep dt  |          |
|   read MMIO |<-MMIO----| <1 µs p50, ~5 µs p99 per transaction
|   write evt |--MMIO--->|
+-------------+          +-------+
```

**Loop pattern**: a QEMUTimer on REALTIME fires every sample
period and flips a flag. `main_loop_wait(false)` drops the BQL
during ppoll so guest vCPUs can take it for IRQ delivery and
MMIO; when the timer fires the callback flag is checked, a
sample is taken via `embed_mmio_read`, and the timer is rearmed.
The worked example is `embed/examples/sampling/main.c`.

**Empirical**: 5-second runs at 200 µs sample period (5 kHz
nominal) sustain ~4.4 kHz actual rate:

| Machine          | Wall vs virt | Per-sample p50 | p99      | vs Model A floor |
| ---              | ---          | ---            | ---      | ---              |
| gr712rc SMP (2c) | slip 0.00%   | 755 ns         | 4.9 µs   | ~160× cheaper    |
| gr740 SMP (4c)   | slip 0.00%   | 774 ns         | 3.9 µs   | ~280× cheaper    |

Both machines achieve zero slip because QEMU runs continuously
under REALTIME — observing does not perturb the observed.
gr740 SMP does not pay the per-vCPU coordination cost that
penalises it under Model A: Model D never pauses any vCPU.

**Tradeoff**: the guest does not freeze between transactions —
the host gets a rolling view of state, not an atomic snapshot.
Adequate for sampling-style HIL; inadequate for workflows that
need "all registers at instant T."

**When to use Model D over Model A**:

- need sample rate above ~200 Hz (Model A's natural ceiling at
  dt = 5 ms);
- host is essentially an observer plus occasional writer (read
  sensors via MMIO, occasionally inject events);
- atomic snapshot of guest state across multiple registers is
  not required.

**When NOT to use Model D**:

- guest must be frozen between operations (debugger, atomic
  multi-register inspection) — use Model A's `embed_qemu_step`;
- lockstep / deterministic replay needed — Model B was
  abandoned, no current path;
- workload is already discrete-time at ms scale (a physics
  solver running at 200 Hz) — Model A is the natural fit.

## Closing principle

Models A and D cover the practical envelope (discrete-time
stepping at ms scale, and continuous-run sampling at sub-ms).
Model B (lockstep / determinism) stays unshipped because no
viable path exists for SMP RTEMS — re-attempt only if upstream
QEMU addresses the rr+icount+PIL-spin interaction. Adding
anything beyond Models A and D should wait for a concrete
consumer use case that exposes a gap neither covers.
