/*
 * embed_qemu — example wrapper around libqemu-<target>.so.
 *
 * Lives outside the QEMU source tree and links against the .so at
 * runtime. Uses only:
 *   - libqemu.h (the .so's public SDK header — types, enums, function
 *     prototypes; ships with the .so)
 *   - embed_qemu.h (this wrapper's own public API for hosts)
 *   - the C standard library
 *
 * No QEMU internal headers. The wrapper exists to give hosts a
 * small init/step/cleanup API in exchange for managing the iothread
 * mutex, deadline timer, and runstate check internally.
 *
 * Two modes, picked at init time:
 *   - Model A: REALTIME deadlines, no -icount. See dt-sweep in
 *     ../docs/11-embedding-as-library.md.
 *   - Model B: VIRTUAL deadlines at an absolute epoch, with
 *     -icount injected. See ../docs/14-co-simulation-scheduling.md.
 */

#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <libqemu.h>

#include "embed_qemu.h"

/* ----- Implementation ------------------------------------------------- */

typedef enum {
    MODE_UNINITIALIZED = 0,
    MODE_REALTIME,
    MODE_ICOUNT,
} StepMode;

static StepMode     step_mode;
static QEMUTimer   *step_timer;
static volatile int step_deadline_hit;

/* Model B lockstep state — absolute virtual deadline epoch. */
static int64_t      t_epoch_virt;
static int64_t      step_count;

/*
 * exit() interception. QEMU has hundreds of error paths that route
 * through &error_fatal, which ultimately calls exit(1). For an
 * embedder that breaks the host process. We override exit() in this
 * translation unit; because embed_qemu.c is linked into the host
 * executable, the dynamic linker prefers our definition over libc's
 * for all calls made by libqemu-<target>.so.
 *
 * Behaviour:
 *   - When embed_qemu_init() has armed the trap (via setjmp), an
 *     exit() call inside QEMU longjmps back so init() can return
 *     the exit code.
 *   - Outside init(), our exit() forwards to _exit() so normal
 *     host shutdown paths still terminate the process. We deliberately
 *     skip atexit handlers to avoid re-entering QEMU code after a
 *     longjmp left it in an indeterminate state.
 */
static jmp_buf init_failure_jmp;
static int     init_in_progress;

void exit(int code)
{
    if (init_in_progress) {
        /* normalize zero codes to 1 so the caller distinguishes
         * success (return 0) from "QEMU asked to exit cleanly with 0". */
        longjmp(init_failure_jmp, code == 0 ? 1 : code);
    }
    _exit(code);
}

/*
 * Step deadline fired.  Two cases for the calling thread context:
 *   - QEMU_CLOCK_REALTIME timer: callback runs in the main thread
 *     (qemu_clock_run_all_timers in main_loop_wait).
 *   - QEMU_CLOCK_VIRTUAL timer under -icount: callback runs in the
 *     vCPU thread (icount_handle_deadline). Calling vm_stop directly
 *     here would only QUEUE a vmstop_requested without changing the
 *     runstate, leaving the wrapper's main_loop_wait loop spinning.
 *
 * To unify both cases: just flag and notify. The wrapper's loop
 * picks up the flag and calls vm_stop synchronously from the
 * iothread context, where do_vm_stop transitions the runstate
 * correctly.
 */
static void step_deadline_cb(void *opaque)
{
    (void)opaque;
    step_deadline_hit = 1;
    qemu_notify_event();
}

/*
 * Shared bring-up: wraps qemu_init() in the setjmp/exit() trap so
 * an &error_fatal path during init() returns a positive exit code
 * to the caller instead of tearing the host process down.
 *
 * Returns 0 on success (with the iothread mutex held), or the
 * QEMU-attempted exit code on failure (mutex state undefined; the
 * caller must terminate the process, see embed_qemu_init notes).
 */
static int do_qemu_init_trapped(int argc, char **argv)
{
    int trap = setjmp(init_failure_jmp);
    if (trap != 0) {
        init_in_progress = 0;
        return trap;
    }
    init_in_progress = 1;
    qemu_init(argc, argv);
    init_in_progress = 0;
    return 0;
}

int embed_qemu_init(int argc, char **argv)
{
    int rc = do_qemu_init_trapped(argc, argv);
    if (rc != 0) return rc;

    assert(qemu_mutex_iothread_locked());
    step_timer = embed_timer_new_ns(QEMU_CLOCK_REALTIME, step_deadline_cb, NULL);
    step_mode  = MODE_REALTIME;
    return 0;
}

int embed_qemu_init_icount(int argc, char **argv)
{
    /*
     * Inject `-icount auto,sleep=on` at the end of argv. We
     * allocate a new array sized argc+2 and copy pointers; the
     * original argv strings are reused (qemu_init does not retain
     * the array past the call, but it does dereference the strings,
     * which already outlive init).
     *
     * shift=auto lets QEMU calibrate the icount shift dynamically.
     * The lockstep guarantee (absolute virtual deadlines) is
     * independent of the shift value — only the absolute rate at
     * which virtual time advances changes. A fixed shift=10 was
     * the original docs/13 operating point on gr712rc but hangs
     * gr740 BSP boot, so auto is the portable default; callers
     * that need a deterministic shift can pass it themselves.
     * sleep=on lets QEMU yield CPU when the guest halts instead
     * of busy-spinning.
     */
    char **new_argv = calloc((size_t)argc + 3, sizeof(char *));
    if (!new_argv) return 1;
    for (int i = 0; i < argc; i++) new_argv[i] = argv[i];
    new_argv[argc + 0] = (char *)"-icount";
    new_argv[argc + 1] = (char *)"auto,sleep=on";
    new_argv[argc + 2] = NULL;

    int rc = do_qemu_init_trapped(argc + 2, new_argv);
    free(new_argv);
    if (rc != 0) return rc;

    assert(qemu_mutex_iothread_locked());
    step_timer = embed_timer_new_ns(QEMU_CLOCK_VIRTUAL, step_deadline_cb, NULL);
    step_mode  = MODE_ICOUNT;

    /* Epoch for the absolute-deadline schedule. step_locked
     * advances step_count first, so the first deadline lands at
     * t_epoch_virt + dt_ns — exactly one dt of guest time. */
    t_epoch_virt = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    step_count   = 0;
    return 0;
}

int embed_qemu_step(int64_t dt_ns, EmbedStepStats *out)
{
    assert(step_timer != NULL);
    assert(step_mode == MODE_REALTIME);

    int64_t t0 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);

    step_deadline_hit = 0;
    timer_mod_ns(step_timer, t0 + dt_ns);
    vm_start();
    /*
     * Exit when either the step deadline fires (typical case) or
     * the guest leaves the running state on its own (halted, exit,
     * shutdown). Without the deadline_hit check, the VIRTUAL-clock
     * + -icount path would spin forever: vm_stop from a vCPU-thread
     * callback only queues a vmstop_requested and doesn't flip the
     * runstate.
     */
    while (!step_deadline_hit && runstate_is_running()) {
        main_loop_wait(false);
    }
    if (step_deadline_hit) {
        vm_stop(RUN_STATE_PAUSED);
    }

    int64_t t1 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);
    int64_t elapsed = t1 - t0;

    if (out) {
        out->requested_dt_ns = dt_ns;
        out->actual_wall_ns  = elapsed;
        out->actual_virt_ns  = elapsed;
        out->guest_left_running_state = !runstate_check(RUN_STATE_PAUSED);
    }
    return 0;
}

int embed_qemu_step_locked(int64_t dt_ns, EmbedStepStats *out)
{
    assert(step_timer != NULL);
    assert(step_mode == MODE_ICOUNT);

    /*
     * Absolute deadline against a fixed virtual epoch: a slow step
     * does not push the next one out. Drift is bounded by one step,
     * not accumulated. step_count is advanced first so the deadline
     * lands at exactly t_epoch_virt + step_count*dt_ns.
     */
    step_count += 1;
    int64_t deadline_virt = t_epoch_virt + step_count * dt_ns;
    int64_t v0 = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    int64_t w0 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);

    step_deadline_hit = 0;
    timer_mod_ns(step_timer, deadline_virt);
    vm_start();
    while (!step_deadline_hit && runstate_is_running()) {
        main_loop_wait(false);
    }
    if (step_deadline_hit) {
        vm_stop(RUN_STATE_PAUSED);
    }

    int64_t v1 = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    int64_t w1 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);

    if (out) {
        out->requested_dt_ns = dt_ns;
        out->actual_wall_ns  = w1 - w0;
        out->actual_virt_ns  = v1 - v0;
        out->guest_left_running_state = !runstate_check(RUN_STATE_PAUSED);
    }
    return 0;
}

void embed_qemu_cleanup(void)
{
    if (step_timer) {
        embed_timer_free(step_timer);
        step_timer = NULL;
    }
    qemu_cleanup(0);
}
