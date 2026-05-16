/*
 * timing-gr712rc-lockstep — Model B (icount + VIRTUAL lockstep) demo.
 *
 * Runs 5000 steps of 1 ms of GUEST virtual time on -M gr712rc using
 * embed_qemu_init_icount + embed_qemu_step_locked. The point of this
 * example is to make the lockstep guarantee visible:
 *
 *   - Each step advances virtual time by exactly dt (modulo at most
 *     one step's overshoot at the end of the run).
 *   - Wall time may be faster OR slower than virtual time (sleep=on
 *     skips over guest-idle intervals; CPU-bound guests can lag).
 *     That decoupling is the whole point — Model B is for external
 *     schedulers that want deterministic virtual-time alignment, not
 *     real-time pacing.
 *
 * Reading the heartbeats — boot transient is expected:
 *   During RTEMS boot the guest is CPU-bound, so each step overshoots
 *   its deadline slightly. With absolute deadlines (t_epoch + n*dt),
 *   overshoot does NOT compound: it accumulates over a few steps,
 *   then the next deadlines land "in the past" relative to virtual
 *   time and fire immediately (actual_virt_ns ~ 0), pulling the
 *   schedule back into alignment. Expect to see virt_drift climb
 *   into the hundreds-of-ms during the first ~3 s of sim, then
 *   collapse back to ~µs by the end of the run. The FINAL drift —
 *   not the intermediate peaks — is the lockstep guarantee: bounded
 *   by one step's overshoot regardless of N, vs Model A where drift
 *   compounds linearly with N.
 *
 * Compare with ../gr712rc/main.c (Model A): same total guest time,
 * but Model A measures wall slip relative to real time while Model B
 * measures virtual-time drift relative to the step schedule.
 *
 * Usage:
 *   timing-gr712rc-lockstep <binary>
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
#define HEARTBEAT_EVERY  1000       /* 5 heartbeats over the run */

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
        "-M", "gr712rc",
        "-display", "none",
        "-monitor", "none",
        (char *)load_flag, abs_binary,
        "-serial", "file:/tmp/timing-gr712rc-lockstep.log",
        "-S",
        NULL
    };
    int qargc = sizeof(qargv) / sizeof(qargv[0]) - 1;

    printf("=== timing-gr712rc-lockstep (Model B) ===\n");
    printf("Binary:   %s\n", abs_binary);
    printf("Format:   %s\n", is_elf ? "ELF (-kernel)" : "raw (-bios)");
    printf("Steps:    %d x %lld ms = %.3f s sim time\n",
           N_STEPS, (long long)(DT_NS / 1000000), N_STEPS * DT_NS / 1e9);
    printf("Mode:     -icount auto,sleep=on (injected by init_icount)\n");
    printf("Pacing:   absolute VIRTUAL deadlines (t_epoch + n*dt)\n");
    printf("\n");

    int rc = embed_qemu_init_icount(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr, "embed_qemu_init_icount failed: rc=%d\n", rc);
        return rc;
    }

    int64_t total_wall = 0;
    int64_t total_virt = 0;
    for (int i = 1; i <= N_STEPS; i++) {
        EmbedStepStats st;
        embed_qemu_step_locked(DT_NS, &st);
        total_wall += st.actual_wall_ns;
        total_virt += st.actual_virt_ns;

        if (i % HEARTBEAT_EVERY == 0) {
            double virt_s = total_virt / 1e9;
            double wall_s = total_wall / 1e9;
            int64_t expected_virt = (int64_t)i * DT_NS;
            int64_t virt_drift_ns = total_virt - expected_virt;
            printf("  step %4d / %d   virt=%.3f s   wall=%.3f s   "
                   "virt_drift=%+lld ns\n",
                   i, N_STEPS, virt_s, wall_s, (long long)virt_drift_ns);
        }
    }
    embed_qemu_cleanup();

    double virt_s = total_virt / 1e9;
    double wall_s = total_wall / 1e9;
    int64_t expected_virt = (int64_t)N_STEPS * DT_NS;
    int64_t virt_drift_ns = total_virt - expected_virt;
    printf("\n");
    printf("Total sim (target): %.3f s\n", expected_virt / 1e9);
    printf("Total virt (actual): %.3f s\n", virt_s);
    printf("Total wall:          %.3f s\n", wall_s);
    printf("Virt drift:          %+lld ns  "
           "(lockstep guarantee: bounded by one step, not accumulated)\n",
           (long long)virt_drift_ns);
    printf("\n");
    printf("Guest UART output (/tmp/timing-gr712rc-lockstep.log):\n");
    FILE *uart = fopen("/tmp/timing-gr712rc-lockstep.log", "r");
    if (uart) {
        char buf[256];
        while (fgets(buf, sizeof(buf), uart)) printf("  %s", buf);
        fclose(uart);
    }
    return 0;
}
