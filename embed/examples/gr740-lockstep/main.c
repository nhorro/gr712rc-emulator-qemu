/*
 * timing-gr740-lockstep — Model B (icount + VIRTUAL lockstep) demo on gr740.
 *
 * Same shape as ../gr712rc-lockstep/main.c, but runs on -M gr740 with
 * a single-core RTEMS BSP (apps/07-hello-gr740/hello.exe).
 *
 * IMPORTANT — gr740 SMP under -icount is BLOCKED.
 *   The gr740 machine has 4 vCPUs but -icount currently hangs when
 *   all four make active progress (Blocker B in
 *   ../../../docs/14-co-simulation-scheduling.md). This example
 *   sidesteps the block by using a single-core BSP build (BSP=gr740,
 *   not gr740_smp): cores 1-3 stay halted at reset, only CPU 0 runs,
 *   round-robin TCG never has to interleave four active vCPUs under
 *   icount. To run an SMP gr740 guest under Model B, Blocker B has
 *   to be resolved first (Camino C in docs/14 "Queued next steps").
 *
 * The guest is hello.exe — prints three lines and calls exit(0).
 * That makes the run a useful demo of the SDK lifecycle contract:
 * the loop watches EmbedStepStats.guest_left_running_state and exits
 * as soon as the guest stops being "running". You will typically see
 * far fewer than N_STEPS actual iterations.
 *
 * Reading the heartbeats — boot transient is expected:
 *   Same shape as the gr712rc-lockstep example: drift climbs during
 *   the CPU-bound boot, then collapses back as deadlines start
 *   landing "in the past" relative to virtual time. The FINAL drift
 *   is the lockstep guarantee — bounded by one step's overshoot
 *   regardless of how many steps actually ran.
 *
 * Usage:
 *   timing-gr740-lockstep <binary>
 *
 *   <binary> is either an RTEMS .exe (ELF — loaded with -kernel)
 *   or a raw ROM image .bin (loaded with -bios). The format is
 *   auto-detected from the file's first 4 bytes (ELF magic).
 */

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

#include "embed_qemu.h"

#define N_STEPS          5000
#define DT_NS            1000000LL  /* 1 ms */
#define HEARTBEAT_EVERY  1000

static int file_is_elf(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    unsigned char m[4] = {0};
    size_t n = fread(m, 1, 4, f);
    fclose(f);
    if (n < 4) return 0;
    return m[0] == 0x7F && m[1] == 'E' && m[2] == 'L' && m[3] == 'F';
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <binary.{exe,bin}>\n", argv[0]);
        return 2;
    }

    char abs_binary[PATH_MAX];
    if (!realpath(argv[1], abs_binary)) {
        fprintf(stderr, "cannot resolve path: %s\n", argv[1]);
        return 2;
    }

    int is_elf = file_is_elf(abs_binary);
    const char *load_flag = is_elf ? "-kernel" : "-bios";

    char *qargv[] = {
        argv[0],
        "-M", "gr740",
        "-display", "none",
        "-monitor", "none",
        (char *)load_flag, abs_binary,
        "-serial", "file:/tmp/timing-gr740-lockstep.log",
        "-S",
        NULL
    };
    int qargc = sizeof(qargv) / sizeof(qargv[0]) - 1;

    printf("=== timing-gr740-lockstep (Model B) ===\n");
    printf("Binary:   %s\n", abs_binary);
    printf("Format:   %s\n", is_elf ? "ELF (-kernel)" : "raw (-bios)");
    printf("Steps:    up to %d x %lld ms = %.3f s sim time (or guest halt)\n",
           N_STEPS, (long long)(DT_NS / 1000000), N_STEPS * DT_NS / 1e9);
    printf("Mode:     -icount auto,sleep=on (injected by init_icount)\n");
    printf("Pacing:   absolute VIRTUAL deadlines (t_epoch + n*dt)\n");
    printf("Cores:    single-core BSP — cores 1-3 stay halted (Blocker B)\n");
    printf("\n");

    int rc = embed_qemu_init_icount(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr, "embed_qemu_init_icount failed: rc=%d\n", rc);
        return rc;
    }

    int64_t total_wall = 0;
    int64_t total_virt = 0;
    int steps_run = 0;
    for (int i = 1; i <= N_STEPS; i++) {
        EmbedStepStats st;
        embed_qemu_step_locked(DT_NS, &st);
        total_wall += st.actual_wall_ns;
        total_virt += st.actual_virt_ns;
        steps_run = i;

        if (i % HEARTBEAT_EVERY == 0) {
            double virt_s = total_virt / 1e9;
            double wall_s = total_wall / 1e9;
            int64_t expected_virt = (int64_t)i * DT_NS;
            int64_t virt_drift_ns = total_virt - expected_virt;
            printf("  step %4d / %d   virt=%.3f s   wall=%.3f s   "
                   "virt_drift=%+lld ns\n",
                   i, N_STEPS, virt_s, wall_s, (long long)virt_drift_ns);
        }

        if (st.guest_left_running_state) {
            printf("  guest left running state at step %d — stopping loop\n", i);
            break;
        }
    }
    embed_qemu_cleanup();

    double virt_s = total_virt / 1e9;
    double wall_s = total_wall / 1e9;
    int64_t expected_virt = (int64_t)steps_run * DT_NS;
    int64_t virt_drift_ns = total_virt - expected_virt;
    printf("\n");
    printf("Steps run:           %d / %d\n", steps_run, N_STEPS);
    printf("Total sim (target):  %.3f s\n", expected_virt / 1e9);
    printf("Total virt (actual): %.3f s\n", virt_s);
    printf("Total wall:          %.3f s\n", wall_s);
    printf("Virt drift:          %+lld ns  "
           "(lockstep guarantee: bounded by one step, not accumulated)\n",
           (long long)virt_drift_ns);
    printf("\n");
    printf("Guest UART output (/tmp/timing-gr740-lockstep.log):\n");
    FILE *uart = fopen("/tmp/timing-gr740-lockstep.log", "r");
    if (uart) {
        char buf[256];
        while (fgets(buf, sizeof(buf), uart)) printf("  %s", buf);
        fclose(uart);
    }
    return 0;
}
