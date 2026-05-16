/*
 * standalone-host: a host program that lives entirely outside the
 * QEMU source tree and links against libqemu-sparc.so to embed a
 * GR712RC or GR740 machine in-process.
 *
 * Compared to the in-tree examples (qemu/examples/embed-gr740 and
 * qemu/examples/embed-gr712rc-smp), this binary:
 *   - does not require QEMU's build system,
 *   - includes only embed_qemu.h (the 3-function public ABI),
 *   - is built by a plain gcc + Makefile invocation, and
 *   - links libqemu-sparc.so dynamically at runtime.
 *
 * This is the "real" embedding model: a proprietary host (e.g. an
 * SMP2 IModel) drops libqemu-sparc.so next to its own binary, copies
 * embed_qemu.h into its include path, and calls three functions.
 *
 *   Usage:
 *     standalone-host <gr712rc|gr740> <kernel.exe> [dt_us=1000] [n_steps=2000]
 *
 *   Examples:
 *     standalone-host gr740    apps/07-hello-gr740/hello.exe
 *     standalone-host gr712rc  apps/02-dual-core-timer/dual_core_timer.exe
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "embed_qemu.h"

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr,
            "Usage: %s <gr712rc|gr740> <kernel.exe> [dt_us=1000] [n_steps=2000]\n",
            argv[0]);
        return 2;
    }

    const char *machine = argv[1];
    const char *kernel  = argv[2];
    int64_t     dt_us   = (argc >= 4) ? atoll(argv[3]) : 1000;
    int         n_steps = (argc >= 5) ? atoi(argv[4])  : 2000;

    if (strcmp(machine, "gr712rc") != 0 && strcmp(machine, "gr740") != 0) {
        fprintf(stderr, "Unknown machine '%s' (expected gr712rc or gr740)\n",
                machine);
        return 2;
    }

    char uart_log[64];
    snprintf(uart_log, sizeof(uart_log),
             "/tmp/standalone-host-%s-uart.log", machine);

    fprintf(stderr,
        "[standalone-host] machine=%s kernel=%s dt_us=%lld n_steps=%d\n"
        "[standalone-host] uart_log=%s\n",
        machine, kernel, (long long)dt_us, n_steps, uart_log);

    char serial_arg[256];
    snprintf(serial_arg, sizeof(serial_arg), "file:%s", uart_log);

    /*
     * Argv handed to qemu_init() inside the .so. Constructed by the
     * host; nothing here is hardcoded inside QEMU. To switch machines,
     * just pass a different -M.
     */
    char *qargv[] = {
        argv[0],
        (char *)"-M",       (char *)machine,
        (char *)"-display", (char *)"none",
        (char *)"-monitor", (char *)"none",
        (char *)"-kernel",  (char *)kernel,
        (char *)"-serial",  serial_arg,
        (char *)"-S",
        NULL,
    };
    int qargc = (int)(sizeof(qargv) / sizeof(qargv[0])) - 1;

    int rc = embed_qemu_init(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr,
            "[standalone-host] embed_qemu_init failed: code=%d (QEMU tried to exit)\n",
            rc);
        return rc;
    }
    fprintf(stderr,
        "[standalone-host] embed_qemu_init OK; starting step loop\n");

    int64_t dt_ns = dt_us * 1000;
    int64_t total_wall = 0;
    int completed = 0;
    int guest_halted = 0;

    for (int i = 0; i < n_steps; i++) {
        EmbedStepStats st;
        embed_qemu_step(dt_ns, &st);
        total_wall += st.actual_wall_ns;
        completed++;

        if (st.guest_left_running_state) {
            guest_halted = 1;
            fprintf(stderr,
                "[standalone-host] guest left running state at step %d\n", i);
            break;
        }
    }

    fprintf(stderr, "\n[standalone-host] summary:\n");
    fprintf(stderr, "  machine:          %s\n", machine);
    fprintf(stderr, "  steps completed:  %d / %d\n", completed, n_steps);
    fprintf(stderr, "  terminated by:    %s\n",
            guest_halted ? "guest leaving running state"
                         : "step budget");
    if (completed > 0) {
        fprintf(stderr, "  total wall:       %.3f ms\n",
                total_wall / 1.0e6);
        fprintf(stderr, "  mean wall/step:   %lld ns\n",
                (long long)(total_wall / completed));
    }
    fprintf(stderr, "  UART output saved:  %s\n", uart_log);

    embed_qemu_cleanup();
    return 0;
}
