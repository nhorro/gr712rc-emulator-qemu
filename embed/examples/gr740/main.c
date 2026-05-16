/*
 * timing-gr740 — minimal embed example.
 *
 * Runs 5000 steps of 1 ms (= 5 seconds of guest time) on -M gr740
 * and prints a heartbeat every 1000 steps so you can SEE the
 * wall-clock keeping pace with simulated time, plus a final summary.
 *
 * Expected per the operating point frozen in
 * ../../../docs/11-embedding-as-library.md:
 *   wall ~5.5 s,  slip ~+10% (p50 = 1.10x dt single-core).
 *
 * Usage:
 *   timing-gr740 <binary>
 *
 *   <binary> is either an RTEMS .exe (ELF — loaded with -kernel)
 *   or a raw ROM image .bin (loaded with -bios). The format is
 *   auto-detected from the file's first 4 bytes (ELF magic).
 */

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

#include "embed_qemu.h"

#define N_STEPS 5000
#define DT_NS   1000000LL  /* 1 ms */

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
        "-serial", "file:/tmp/timing-gr740.log",
        "-S",
        NULL
    };
    int qargc = sizeof(qargv) / sizeof(qargv[0]) - 1;

    printf("=== timing-gr740 ===\n");
    printf("Binary:   %s\n", abs_binary);
    printf("Format:   %s\n", is_elf ? "ELF (-kernel)" : "raw (-bios)");
    printf("Steps:    %d x 1 ms = %.3f s sim time\n",
           N_STEPS, N_STEPS * DT_NS / 1e9);
    printf("Expected: wall ~5.5 s, slip ~+10%% (see docs/11-embedding-as-library.md)\n");
    printf("\n");

    int rc = embed_qemu_init(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr, "embed_qemu_init failed: rc=%d\n", rc);
        return rc;
    }

    int64_t total_wall = 0;
    for (int i = 1; i <= N_STEPS; i++) {
        EmbedStepStats st;
        embed_qemu_step(DT_NS, &st);
        total_wall += st.actual_wall_ns;

        if (i % 1000 == 0) {
            double sim_s  = (double)i * DT_NS / 1e9;
            double wall_s = total_wall / 1e9;
            printf("  step %4d / %d   sim=%.3f s   wall=%.3f s   slip=%+5.1f%%\n",
                   i, N_STEPS, sim_s, wall_s,
                   100.0 * (wall_s - sim_s) / sim_s);
        }
    }
    embed_qemu_cleanup();

    double sim_s  = (double)N_STEPS * DT_NS / 1e9;
    double wall_s = total_wall / 1e9;
    printf("\n");
    printf("Total sim:  %.3f s\n", sim_s);
    printf("Total wall: %.3f s\n", wall_s);
    printf("Slip:       %+.1f%% (expected ~+10%%)\n",
           100.0 * (wall_s - sim_s) / sim_s);
    printf("\n");
    printf("Guest UART output (/tmp/timing-gr740.log):\n");
    FILE *uart = fopen("/tmp/timing-gr740.log", "r");
    if (uart) {
        char buf[256];
        while (fgets(buf, sizeof(buf), uart)) printf("  %s", buf);
        fclose(uart);
    }
    return 0;
}
