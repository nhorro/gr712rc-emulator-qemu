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
 * 3-function API (init / step / cleanup) in exchange for managing
 * the iothread mutex, deadline timer, and runstate check internally.
 *
 * Operating point: 1 ms fixed step under QEMU_CLOCK_REALTIME, no
 * -icount. See ../NOTES.md for the granularity sweep that froze it.
 */

#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

#include <libqemu.h>

#include "embed_qemu.h"

/* ----- Implementation ------------------------------------------------- */

static QEMUTimer *step_timer;

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

static void step_deadline_cb(void *opaque)
{
    (void)opaque;
    vm_stop(RUN_STATE_PAUSED);
}

int embed_qemu_init(int argc, char **argv)
{
    int trap = setjmp(init_failure_jmp);
    if (trap != 0) {
        /* came back via longjmp from exit() inside QEMU */
        init_in_progress = 0;
        return trap;
    }
    init_in_progress = 1;
    qemu_init(argc, argv);
    init_in_progress = 0;

    assert(qemu_mutex_iothread_locked());
    step_timer = embed_timer_new_ns(QEMU_CLOCK_REALTIME, step_deadline_cb, NULL);
    return 0;
}

int embed_qemu_step(int64_t dt_ns, EmbedStepStats *out)
{
    assert(step_timer != NULL);

    int64_t t0 = qemu_clock_get_ns(QEMU_CLOCK_REALTIME);

    timer_mod_ns(step_timer, t0 + dt_ns);
    vm_start();
    while (runstate_is_running()) {
        main_loop_wait(false);
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

void embed_qemu_cleanup(void)
{
    if (step_timer) {
        embed_timer_free(step_timer);
        step_timer = NULL;
    }
    qemu_cleanup(0);
}
