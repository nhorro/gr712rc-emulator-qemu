/*
 * embed-sampling — Model D demonstration (continuous-run + MMIO sampling).
 *
 * The reference for Model D is docs/14-co-simulation-scheduling.md
 * § "What Model D would be". In one sentence:
 *
 *     vm_start() is called ONCE, QEMU runs continuously under
 *     REALTIME pacing, and the host samples guest state via direct
 *     embed_mmio_read() from a host-registered peripheral.
 *
 * What this example measures:
 *
 *   - per-sample wall cost (BQL acquire + callback dispatch),
 *     compared head-on against Model A's pause/resume floor
 *     (~120-255 us on gr712rc/gr740 SMP, see docs/11);
 *   - sample rate sustained at sub-millisecond cadence;
 *   - guest virtual time progress (slip vs wall) under the
 *     sampling load.
 *
 * Loop pattern:
 *
 *   - A QEMUTimer on REALTIME fires every SAMPLE_DT and flips a
 *     flag. main_loop_wait(false) blocks on the iothread mutex;
 *     during the wait the BQL is dropped, so guest vCPUs can take
 *     it for IRQ delivery and MMIO. When the timer fires the
 *     callback flag is checked, a sample is taken, and the timer
 *     is rearmed.
 *   - embed_mmio_read() into our peripheral takes the BQL (held
 *     by us at that point), reads the offset-0 register, returns
 *     the current QEMU_CLOCK_VIRTUAL value.
 *
 * Per-machine details live in config_gr712rc.h / config_gr740.h
 * (PERIPH_BASE, MACHINE_NAME, UART_LOG, Model A floor reference).
 */

#define _GNU_SOURCE
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <libqemu.h>
#include "embed_qemu.h"

#ifndef CONFIG_HEADER
#  error "Compile with -DCONFIG_HEADER=\"config_gr712rc.h\" (or gr740)"
#endif
#include CONFIG_HEADER

#define PERIPH_BASE    CONFIG_PERIPH_BASE
#define PERIPH_SIZE    0x100

#define RUN_SECONDS    5
#define SAMPLE_DT_US   200                /* 5 kHz nominal */
#define SAMPLE_DT_NS   ((int64_t)SAMPLE_DT_US * 1000)
#define MAX_SAMPLES    (RUN_SECONDS * 1000000 / SAMPLE_DT_US + 256)

/* ----- host-side peripheral --------------------------------------------
 *
 * Single 32-bit register at offset 0: returns QEMU_CLOCK_VIRTUAL in
 * microseconds (truncated to 32 bits). Fits comfortably in 32 bits for
 * any run shorter than ~71 minutes (UINT32_MAX us). 32-bit access keeps
 * us within the APB native width and avoids the BE/64-bit wrinkle of an
 * 8-byte access that may get split into two callbacks by the framework.
 */

static uint64_t periph_read(void *opaque, uint64_t offset, unsigned size)
{
    (void)opaque; (void)offset; (void)size;
    int64_t ns = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    return (uint64_t)(uint32_t)(ns / 1000);  /* us, truncated to 32 bits */
}

/* ----- sample timer ---------------------------------------------------- */

static volatile int sample_due;

static void sample_timer_cb(void *opaque)
{
    (void)opaque;
    sample_due = 1;
}

/* ----- helpers --------------------------------------------------------- */

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

static int64_t now_monotonic_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static int cmp_i64(const void *a, const void *b)
{
    int64_t x = *(const int64_t *)a, y = *(const int64_t *)b;
    return (x > y) - (x < y);
}

/* ----- main ------------------------------------------------------------ */

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <kernel.{exe,bin}>\n", argv[0]);
        return 2;
    }

    char abs_binary[PATH_MAX];
    if (!realpath(argv[1], abs_binary)) {
        fprintf(stderr, "cannot resolve: %s\n", argv[1]);
        return 2;
    }
    int is_elf = file_is_elf(abs_binary);
    const char *load_flag = is_elf ? "-kernel" : "-bios";

    char *qargv[] = {
        argv[0],
        "-M",       CONFIG_MACHINE_NAME,
        "-display", "none",
        "-monitor", "none",
        (char *)load_flag, abs_binary,
        "-serial",  "file:" CONFIG_UART_LOG,
        "-S",
        NULL
    };
    int qargc = (int)(sizeof(qargv) / sizeof(qargv[0])) - 1;

    printf("=== embed-sampling (Model D) on -M %s ===\n", CONFIG_MACHINE_NAME);
    printf("Binary       : %s\n", abs_binary);
    printf("Format       : %s\n", is_elf ? "ELF (-kernel)" : "raw (-bios)");
    printf("Periph base  : 0x%llx (host-side, read-only)\n",
           (unsigned long long)PERIPH_BASE);
    printf("Run length   : %d s\n", RUN_SECONDS);
    printf("Sample period: %d us  (%.1f kHz nominal)\n",
           SAMPLE_DT_US, 1000.0 / SAMPLE_DT_US);
    printf("Model A floor: %s\n\n", CONFIG_MODEL_A_FLOOR);

    int rc = embed_qemu_init(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr, "embed_qemu_init failed: rc=%d\n", rc);
        return rc;
    }

    EmbedPeripheralOps ops = {
        .read = periph_read,
        .write = NULL,
        .endian = EMBED_ENDIAN_BIG,
        .min_access = 4,
        .max_access = 4,
    };
    embed_register_peripheral(PERIPH_BASE, PERIPH_SIZE, &ops, NULL);

    QEMUTimer *sample_timer =
        embed_timer_new_ns(QEMU_CLOCK_REALTIME, sample_timer_cb, NULL);

    int64_t *cost_ns = calloc(MAX_SAMPLES, sizeof(int64_t));
    if (!cost_ns) { perror("calloc"); return 1; }

    /* Model D: one-shot vm_start, then sample loop. */
    vm_start();

    int64_t wall_start = now_monotonic_ns();
    int64_t wall_deadline = wall_start + (int64_t)RUN_SECONDS * 1000000000LL;

    timer_mod_ns(sample_timer,
                 qemu_clock_get_ns(QEMU_CLOCK_REALTIME) + SAMPLE_DT_NS);

    uint32_t vt_first_us = (uint32_t)(qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) / 1000);
    uint32_t vt_last_us  = vt_first_us;
    int n_samples = 0;

    while (n_samples < MAX_SAMPLES) {
        /* Drops BQL during ppoll; vCPUs can take BQL for their MMIO/IRQ work. */
        main_loop_wait(false);

        if (sample_due) {
            sample_due = 0;

            int64_t t0 = now_monotonic_ns();
            uint32_t vt = (uint32_t)embed_mmio_read(PERIPH_BASE, 4);
            int64_t t1 = now_monotonic_ns();

            cost_ns[n_samples] = t1 - t0;
            vt_last_us = vt;
            n_samples++;

            if (now_monotonic_ns() >= wall_deadline) break;

            timer_mod_ns(sample_timer,
                         qemu_clock_get_ns(QEMU_CLOCK_REALTIME) + SAMPLE_DT_NS);
        }

        if (!runstate_is_running()) break;
    }

    int64_t wall_end = now_monotonic_ns();
    int64_t wall_elapsed_ns = wall_end - wall_start;
    int64_t virt_elapsed_ns = (int64_t)(vt_last_us - vt_first_us) * 1000;

    vm_stop(RUN_STATE_PAUSED);
    embed_timer_free(sample_timer);

    /* ----- summary ------------------------------------------------------- */
    qsort(cost_ns, n_samples, sizeof(int64_t), cmp_i64);
    int64_t cmin  = cost_ns[0];
    int64_t cp50  = cost_ns[n_samples / 2];
    int64_t cp99  = cost_ns[(n_samples * 99) / 100];
    int64_t cmax  = cost_ns[n_samples - 1];
    int64_t csum  = 0;
    for (int i = 0; i < n_samples; i++) csum += cost_ns[i];
    int64_t cmean = csum / n_samples;

    printf("\n=== Results ===\n");
    printf("Samples taken    : %d  (target ~%d at requested rate)\n",
           n_samples, RUN_SECONDS * 1000000 / SAMPLE_DT_US);
    printf("Wall elapsed     : %.3f s\n", wall_elapsed_ns / 1e9);
    printf("Virtual elapsed  : %.3f s\n", virt_elapsed_ns / 1e9);
    printf("Slip (virt-wall) : %+.2f%%\n",
           100.0 * (double)(virt_elapsed_ns - wall_elapsed_ns) /
                   (double)wall_elapsed_ns);

    printf("\nPer-sample wall cost (BQL acquire + MMIO callback dispatch):\n");
    printf("  min   : %6lld ns\n", (long long)cmin);
    printf("  mean  : %6lld ns\n", (long long)cmean);
    printf("  p50   : %6lld ns\n", (long long)cp50);
    printf("  p99   : %6lld ns\n", (long long)cp99);
    printf("  max   : %6lld ns\n", (long long)cmax);
    printf("\nCompare: Model A pause/resume floor is %s\n",
           CONFIG_MODEL_A_FLOOR);

    free(cost_ns);

    printf("\nGuest UART (last 10 lines of %s):\n", CONFIG_UART_LOG);
    FILE *uart = fopen(CONFIG_UART_LOG, "r");
    if (uart) {
        char lines[10][256] = {{0}};
        char buf[256];
        int n = 0;
        while (fgets(buf, sizeof(buf), uart)) {
            size_t len = strlen(buf);
            if (len >= sizeof(lines[0])) len = sizeof(lines[0]) - 1;
            memcpy(lines[n % 10], buf, len);
            lines[n % 10][len] = '\0';
            n++;
        }
        fclose(uart);
        int total = n < 10 ? n : 10;
        int start = n < 10 ? 0 : n % 10;
        for (int i = 0; i < total; i++) {
            printf("  %s", lines[(start + i) % 10]);
        }
    }

    embed_qemu_cleanup();
    return 0;
}
