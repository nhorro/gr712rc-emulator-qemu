# Co-simulation scheduling — design FAQ

**Status**: design reference, May 2026. Answers "why isn't X
shipped?" without requiring readers to re-derive abandoned
investigations.

The SDK ships exactly one coupling model between an external
scheduler and QEMU: **Model A — REALTIME pacing at dt = 5 ms**.
The operating point and its empirical justification live in
`docs/11-embedding-as-library.md § Operating point and timing`.
This document records what else was considered, why it was
rejected, and what would be required if a future consumer
forces the question.

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

## What Model D would be (if sub-ms sampling is ever required)

The escape hatch from the per-step floor is to **stop stepping
per dt entirely**. Run QEMU continuously under REALTIME after a
single `vm_start`, and sample state via host-side MMIO from
peripherals registered through the SDK in
`docs/12-host-side-peripherals.md`. Each MMIO transaction costs
~10 µs (single BQL acquire) — an order of magnitude lower than
pause/resume.

```
external                 QEMU
+-------------+          +-------+
| start QEMU  |--------->| vm_start (one shot)
|             |          |
| host loop:  |          | runs continuously under REALTIME
|   sleep dt  |          |
|   read MMIO |<-MMIO----| ~10 µs per transaction
|   write evt |--MMIO--->|
+-------------+          +-------+
```

**Tradeoff**: the guest does not freeze between transactions —
the host gets a rolling view of state, not an atomic snapshot.
Adequate for sampling-style HIL; inadequate for workflows that
need "all registers at instant T."

**Status**: substrate shipped (host-side peripheral SDK,
`embed_register_peripheral` + `embed_mmio_read/write`); a
documented loop pattern and worked example are not. Building
both is ~3–5 days when a concrete consumer appears with a
sub-ms sampling requirement.

## Closing principle

Pick the coupling model when a real consumer use case forces the
choice. Speculative shipping of Models B/C/D leaves the SDK with
APIs nobody uses, drift between docs and reality, and confusion
about which path is "supported." The current default (Model A,
5 ms) covers the broadest swath of HIL workflows; the upgrade
paths are scoped above, the technical risk is characterised, and
the work is bounded.
