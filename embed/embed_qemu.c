/*
 * embed_qemu — wrapper implementation. Lives outside the QEMU source
 * tree; links against libqemu-<target>.so at runtime for the symbols
 * it needs.
 *
 * Deliberately includes NO QEMU headers — instead we forward-declare
 * the minimal subset of QEMU's API that the wrapper uses, and the
 * enum values we depend on (RUN_STATE_PAUSED, QEMU_CLOCK_REALTIME).
 * Pinned to QEMU 8.2.2 (this fork). Canonical sources:
 *
 *   QEMUTimer / QEMUClockType : qemu/include/qemu/timer.h
 *   RunState                  : qemu/build/qapi/qapi-types-run-state.h
 *   qemu_init / qemu_cleanup  : qemu/include/sysemu/sysemu.h
 *   vm_start / vm_stop        : qemu/include/sysemu/runstate.h
 *   main_loop_wait            : qemu/include/qemu/main-loop.h
 *
 * If QEMU's API or enum ordering ever changes upstream, the values
 * below must be re-synced. The 3-function public API
 * (embed_qemu_init/step/cleanup) absorbs that drift so the host's
 * main.c never has to.
 */

#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>

#include "embed_qemu.h"

/* ----- Forward-declared QEMU surface ---------------------------------- */

typedef struct QEMUTimer QEMUTimer;
typedef void QEMUTimerCB(void *opaque);

#define QEMU_CLOCK_REALTIME 0   /* QEMUClockType enum, value 0 in QEMU 8.2.2 */
#define RUN_STATE_PAUSED    4   /* RunState enum,      value 4 in QEMU 8.2.2 */

extern void       qemu_init(int argc, char **argv);
extern void       qemu_cleanup(int status);

extern void       vm_start(void);
extern void       vm_stop(int state);

extern bool       main_loop_wait(bool nonblocking);
extern bool       runstate_is_running(void);
extern bool       runstate_check(int state);
extern bool       qemu_mutex_iothread_locked(void);

/*
 * timer_new_ns / timer_free are static inline in qemu/include/qemu/timer.h
 * and therefore have no ELF symbol. The fork's libqemu-<target>.so adds
 * paper-thin forwarders (embed_timer_new_ns / embed_timer_free) that we
 * link against here. timer_mod_ns is a real (non-inline) export.
 */
extern QEMUTimer *embed_timer_new_ns(int type, QEMUTimerCB *cb, void *opaque);
extern void       embed_timer_free(QEMUTimer *t);
extern void       timer_mod_ns(QEMUTimer *t, int64_t expire_time);

extern int64_t    qemu_clock_get_ns(int type);

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
