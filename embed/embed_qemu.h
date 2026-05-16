/*
 * embed_qemu — minimal consumer-side wrapper around QEMU's embedding
 * entry points, for hosts that link against libqemu-<target>.so.
 *
 * This header has no QEMU includes; it describes only the public
 * API that the wrapper exposes to the host. The host's main() needs
 * only this header plus the .so at link time.
 *
 * Two operating modes — pick one at init time, do not mix:
 *
 *   Model A (default, REALTIME):
 *     embed_qemu_init(argc, argv);
 *     for (...) {
 *         EmbedStepStats st;
 *         embed_qemu_step(dt_ns, &st);
 *         if (st.guest_left_running_state) break;
 *     }
 *     embed_qemu_cleanup();
 *
 *   Model B (opt-in, icount + VIRTUAL lockstep):
 *     embed_qemu_init_icount(argc, argv);
 *     for (...) {
 *         EmbedStepStats st;
 *         embed_qemu_step_locked(dt_ns, &st);
 *         if (st.guest_left_running_state) break;
 *     }
 *     embed_qemu_cleanup();
 *
 * Threading: all calls must be made from the same thread.
 * qemu_init() returns with the iothread mutex held by that thread;
 * the step calls run under it; embed_qemu_cleanup() releases it.
 *
 * Clock & pacing:
 *   - Model A pins deadlines to QEMU_CLOCK_REALTIME, dt-relative.
 *     Validated by the granularity sweep in
 *     ../docs/11-embedding-as-library.md.
 *   - Model B pins deadlines to QEMU_CLOCK_VIRTUAL with an absolute
 *     epoch (t_epoch + n*dt), so per-step overshoot does not
 *     accumulate. Requires -icount; the wrapper injects
 *     `-icount auto,sleep=on` into argv internally (auto chosen as
 *     the portable default; fixed shift=10 hangs gr740 BSP boot).
 */

#ifndef EMBED_QEMU_H
#define EMBED_QEMU_H

#include <stdint.h>

typedef struct EmbedStepStats {
    int64_t requested_dt_ns;
    int64_t actual_wall_ns;
    int64_t actual_virt_ns;
    int     guest_left_running_state;
} EmbedStepStats;

/*
 * Bring up an in-process QEMU machine.
 *
 * Returns 0 on success. Returns a *positive* code on failure: that
 * code is the exit value QEMU attempted to pass to exit() (typically
 * 1) when an &error_fatal path tripped during initialization
 * (e.g. bad kernel path, unknown machine, missing dependency).
 *
 * IMPORTANT: after a non-zero return, QEMU's internal state is
 * inconsistent (the longjmp out of qemu_init() leaves locks, fds,
 * and threads in an indeterminate state). The host MUST NOT call
 * any other embed_qemu_* function in that process — terminate
 * cleanly and start fresh if a retry is needed.
 */
int  embed_qemu_init(int argc, char **argv);

int  embed_qemu_step(int64_t dt_ns, EmbedStepStats *out);
void embed_qemu_cleanup(void);

/*
 * Model B — opt-in lockstep init.
 *
 * Same contract as embed_qemu_init: returns 0 on success or a
 * positive exit code if QEMU's init path tripped. On non-zero
 * return the process must terminate (see embed_qemu_init notes).
 *
 * Internally appends `-icount shift=10,sleep=on` to the argv passed
 * to qemu_init(), and arms the step timer on QEMU_CLOCK_VIRTUAL.
 *
 * Limitation: -M gr740 in SMP mode (4 vCPUs) hangs under -icount
 * (Blocker B, see docs/14-co-simulation-scheduling.md). Single-core
 * gr740 and SMP gr712rc both work.
 */
int  embed_qemu_init_icount(int argc, char **argv);

/*
 * Model B step — fires at an absolute virtual deadline computed as
 * `t_epoch_virt + step_count * dt_ns`, where t_epoch_virt is the
 * VIRTUAL-clock reading at init time. Per-step overshoot does not
 * accumulate: a slow step does not push the next deadline out.
 *
 * Must be paired with embed_qemu_init_icount(); aborts if called
 * after embed_qemu_init().
 *
 * EmbedStepStats: in this mode actual_virt_ns is dt_ns by
 * construction (that is the lockstep guarantee), while
 * actual_wall_ns measures the real cost of advancing the guest by
 * dt_ns of virtual time.
 */
int  embed_qemu_step_locked(int64_t dt_ns, EmbedStepStats *out);

#endif /* EMBED_QEMU_H */
