/*
 * embed-peripheral-test — exercise embed_register_peripheral end-to-end.
 *
 * Boots an -M gr712rc machine but keeps the VM in RUN_STATE_PRELAUNCH
 * (we never call vm_start, so the guest CPUs never run). Between
 * qemu_init() and tear-down we:
 *
 *   1. Register a host-side fake peripheral at 0x80000800 that
 *      increments per-direction counters and logs each access.
 *   2. Connect to QEMU's HMP monitor over a Unix socket and issue:
 *
 *        info mtree            -- TEST #5: tree must contain
 *                                 "embed-peripheral-0".
 *        xp /4xw 0x80000800    -- TEST #2: 4 word reads inside the
 *                                 registered region must invoke the
 *                                 fake_read callback (counter ++).
 *        xp /1xw 0x80000900    -- TEST #2b (priority guard):
 *                                 address is INSIDE the GR712RC diag
 *                                 catch-all (-1) but OUTSIDE our
 *                                 region; the callback must NOT fire.
 *
 *   3. Inject host-side MMIO via the SDK's embed_mmio_write /
 *      embed_mmio_read entry points. Bypasses both the monitor and
 *      the guest CPU -- the host process talks directly to
 *      address_space_memory.
 *
 *        TEST #4  -- write 0xdeadbeef at PERIPH_BASE: fake_write fires
 *                    with the exact value.
 *        TEST #4b -- read at PERIPH_BASE+4 returns 0xcafe0004 (the
 *                    fake_read pattern), proving the round-trip.
 *
 *   4. Close the monitor, run the guest via embed_qemu_step() for a
 *      few seconds. If the kernel is apps/10-mmio-probe/mmio_probe.exe,
 *      the Init task does 4 word writes and 4 word reads at
 *      PERIPH_BASE and exits.
 *
 *        TEST #6  -- g_fake_writes increased by >= 4 after the step
 *        TEST #6b -- g_fake_reads  increased by >= 4 after the step
 *
 *      This is the full end-to-end path: guest CPU -> SPARC bus ->
 *      MemoryRegion ops -> our trampoline -> EmbedPeripheralOps
 *      callbacks. HMP-based write coverage is impossible in QEMU 8.2.2
 *      (no write-physical command); embed_mmio_write covers the host-
 *      injected variant, and this one covers the realistic guest path.
 *
 * The monitor processes commands in the iothread, which is the same
 * thread that holds the BQL after qemu_init() — so the test pumps
 * main_loop_wait() between socket I/O operations and needs no extra
 * threads.
 *
 * Exits 0 if all assertions hold, 1 otherwise.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <libqemu.h>
#include "embed_qemu.h"

/*
 * The Makefile selects the machine via -DCONFIG_HEADER=\"config_*.h\".
 * The included header defines CONFIG_MACHINE_NAME, CONFIG_PERIPH_BASE,
 * CONFIG_OUTSIDE_ADDR, CONFIG_HAS_DIAG_CATCH_ALL, CONFIG_MONITOR_SOCK,
 * CONFIG_UART_LOG. See config_gr712rc.h / config_gr740.h.
 */
#ifndef CONFIG_HEADER
#  error "Compile with -DCONFIG_HEADER=\"config_gr712rc.h\" (or gr740)"
#endif
#include CONFIG_HEADER

#define MONITOR_SOCK   CONFIG_MONITOR_SOCK
#define UART_LOG       CONFIG_UART_LOG
#define PERIPH_BASE    CONFIG_PERIPH_BASE
#define PERIPH_SIZE    0x100u
#define OUTSIDE_ADDR   CONFIG_OUTSIDE_ADDR
#define STEP_BUDGET_NS (3 * 1000000000LL)  /* 3 s of guest wall-time */

static int g_fake_reads;
static int g_fake_writes;
static int g_isr_marker_seen;   /* writes with value 0xB2B2B2B2 */
static int g_irq_triggers_sent; /* embed_irq_pulse calls we issued */

/*
 * Magic values exchanged with apps/12-mmio-irq-probe (and gr740
 * mirror): the guest writes TRIGGER, our callback pulses IRQ_LINE,
 * the guest's ISR writes ISR_MARK to a different offset which we
 * observe here.
 */
#define IRQ_TRIGGER_VAL 0xA1A1A1A1u
#define ISR_MARK_VAL    0xB2B2B2B2u

static uint64_t fake_read(void *opaque, uint64_t off, unsigned size)
{
    (void)opaque;
    g_fake_reads++;
    fprintf(stderr, "  [FAKE-PERIPH] read  off=0x%llx size=%u\n",
            (unsigned long long)off, size);
    return 0xCAFE0000ull | (off & 0xFFFFu);
}

static void fake_write(void *opaque, uint64_t off, uint64_t val, unsigned size)
{
    (void)opaque;
    g_fake_writes++;
    fprintf(stderr, "  [FAKE-PERIPH] write off=0x%llx size=%u val=0x%llx\n",
            (unsigned long long)off, size, (unsigned long long)val);

    /* Recognize the IRQ-handshake protocol values. The callback runs
     * on the iothread under BQL, so calling embed_irq_pulse() from
     * here is safe and natural -- no extra locking. */
    if ((uint32_t)val == IRQ_TRIGGER_VAL) {
        embed_irq_pulse(CONFIG_IRQ_LINE);
        g_irq_triggers_sent++;
    } else if ((uint32_t)val == ISR_MARK_VAL) {
        g_isr_marker_seen++;
    }
}

/* ----- Unix-socket monitor client ------------------------------------- */

static int connect_monitor(const char *path)
{
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        perror("socket");
        return -1;
    }
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect");
        close(fd);
        return -1;
    }
    int fl = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    return fd;
}

/*
 * Pump QEMU's main loop and drain the monitor socket into `buf`. The
 * iothread runs the monitor, so we need to give it CPU time before
 * the response materializes. Iters bounds the wait at ~iters * 1 ms.
 */
static int pump_and_drain(int fd, char *buf, size_t cap, int iters)
{
    size_t total = 0;
    if (cap == 0) {
        return 0;
    }
    for (int i = 0; i < iters; i++) {
        main_loop_wait(true);  /* nonblocking — processes pending events */
        for (;;) {
            if (total + 1 >= cap) {
                goto done;
            }
            ssize_t n = recv(fd, buf + total, cap - total - 1, MSG_DONTWAIT);
            if (n > 0) {
                total += (size_t)n;
            } else if (n == 0) {
                goto done;  /* peer closed */
            } else {
                if (errno != EAGAIN && errno != EWOULDBLOCK) {
                    goto done;
                }
                break;
            }
        }
        usleep(1000);  /* 1 ms backoff */
    }
done:
    buf[total] = '\0';
    return (int)total;
}

static int hmp(int fd, const char *cmd, char *out, size_t cap)
{
    /* Drain anything pending (welcome banner, trailing prompt of a
     * prior command). */
    char trash[4096];
    pump_and_drain(fd, trash, sizeof(trash), 5);

    size_t len = strlen(cmd);
    if (write(fd, cmd, len) != (ssize_t)len) {
        return -1;
    }
    if (write(fd, "\n", 1) != 1) {
        return -1;
    }
    return pump_and_drain(fd, out, cap, 40);
}

/* ----- main ----------------------------------------------------------- */

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr,
                "Usage: %s <kernel.exe>\n"
                "       The GR712RC machine needs *some* kernel or BIOS\n"
                "       to initialize, even though this test never starts\n"
                "       the VM. Any RTEMS .exe will do.\n",
                argv[0]);
        return 2;
    }

    unlink(MONITOR_SOCK);

    char monitor_arg[256];
    snprintf(monitor_arg, sizeof(monitor_arg),
             "unix:%s,server,nowait", MONITOR_SOCK);

    char *qargv[] = {
        argv[0],
        "-M",       CONFIG_MACHINE_NAME,
        "-display", "none",
        "-monitor", monitor_arg,
        "-serial",  "file:" UART_LOG,
        "-d",       "guest_errors,unimp",  /* let diag messages print  */
        "-kernel",  argv[1],                /* satisfy machine init     */
        "-S",                               /* do not auto-start CPUs   */
        NULL
    };
    int qargc = (int)(sizeof(qargv) / sizeof(qargv[0])) - 1;

    printf("=== embed-peripheral-test (%s) ===\n", CONFIG_MACHINE_NAME);
    printf("Machine        : -M %s\n", CONFIG_MACHINE_NAME);
    printf("Monitor socket : %s\n", MONITOR_SOCK);
    printf("Kernel         : %s\n", argv[1]);
    printf("Peripheral base: 0x%llx  size: 0x%x\n",
           (unsigned long long)PERIPH_BASE, PERIPH_SIZE);
    printf("Diag catch-all : %s\n\n",
           CONFIG_HAS_DIAG_CATCH_ALL ? "yes (TEST #2b expects diag log)"
                                     : "no  (TEST #2b checks empty space)");

    int rc = embed_qemu_init(qargc, qargv);
    if (rc != 0) {
        fprintf(stderr, "embed_qemu_init failed: rc=%d\n", rc);
        return rc;
    }

    EmbedPeripheralOps ops = {
        .read       = fake_read,
        .write      = fake_write,
        .endian     = EMBED_ENDIAN_BIG,
        .min_access = 1,
        .max_access = 4,
    };
    embed_register_peripheral(PERIPH_BASE, PERIPH_SIZE, &ops, NULL);
    printf("Registered fake peripheral.\n\n");

    int mon = connect_monitor(MONITOR_SOCK);
    if (mon < 0) {
        fprintf(stderr, "could not connect to monitor\n");
        embed_qemu_cleanup();
        return 1;
    }

    char buf[16384];
    int pass = 0, fail = 0;

    /* ----- TEST #5: info mtree must show our region ----- */
    printf("--- TEST #5: info mtree shows 'embed-peripheral-0' ---\n");
    hmp(mon, "info mtree", buf, sizeof(buf));
    char *hit = strstr(buf, "embed-peripheral-0");
    if (hit) {
        const char *bol = hit;
        while (bol > buf && *(bol - 1) != '\n') {
            bol--;
        }
        const char *eol = strchr(hit, '\n');
        size_t llen = eol ? (size_t)(eol - bol) : strlen(bol);
        printf("  PASS  mtree line: %.*s\n", (int)llen, bol);
        pass++;
    } else {
        printf("  FAIL  'embed-peripheral-0' not found in info mtree\n");
        printf("  ----- monitor output begin -----\n%s\n  ----- end -----\n",
               buf);
        fail++;
    }

    /* ----- TEST #2: xp at PERIPH_BASE triggers our read callback ----- */
    printf("\n--- TEST #2: xp /4xw 0x%llx invokes fake_read ---\n",
           (unsigned long long)PERIPH_BASE);
    int reads_before = g_fake_reads;
    {
        char cmd[64];
        snprintf(cmd, sizeof(cmd), "xp /4xw 0x%llx",
                 (unsigned long long)PERIPH_BASE);
        hmp(mon, cmd, buf, sizeof(buf));
    }
    int fired = g_fake_reads - reads_before;
    if (fired > 0) {
        printf("  PASS  read callback fired %d time(s)\n", fired);
        printf("  monitor reply:\n");
        for (char *p = buf, *e; p && *p; p = e ? e + 1 : NULL) {
            e = strchr(p, '\n');
            if (e) {
                *e = '\0';
            }
            if (*p) {
                printf("    %s\n", p);
            }
            if (!e) {
                break;
            }
        }
        pass++;
    } else {
        printf("  FAIL  read callback did NOT fire (counter unchanged)\n");
        printf("  ----- monitor output begin -----\n%s\n  ----- end -----\n",
               buf);
        fail++;
    }

    /* ----- TEST #2b: out-of-region read must not invoke fake_read -----
     *
     * On GR712RC the address falls inside the diag catch-all region
     * (priority -1) and you'll see a [gr712rc-diag] log on stderr.
     * On GR740 there is no catch-all, so the address falls into empty
     * APB space. Either way, the assertion is the same: our callback
     * must NOT fire. */
    printf("\n--- TEST #2b: xp /1xw 0x%llx (outside region) must NOT "
           "invoke fake_read ---\n", (unsigned long long)OUTSIDE_ADDR);
    reads_before = g_fake_reads;
    {
        char cmd[64];
        snprintf(cmd, sizeof(cmd), "xp /1xw 0x%llx",
                 (unsigned long long)OUTSIDE_ADDR);
        hmp(mon, cmd, buf, sizeof(buf));
    }
    int leaked = g_fake_reads - reads_before;
    if (leaked == 0) {
        printf("  PASS  callback did not fire%s\n",
               CONFIG_HAS_DIAG_CATCH_ALL
                   ? " (diag catch-all owns the address)"
                   : " (empty APB space, no competing handler)");
        pass++;
    } else {
        printf("  FAIL  callback unexpectedly fired %d time(s)\n", leaked);
        fail++;
    }

    /* HMP is done. Close the socket so subsequent guest traffic does
     * not have to share the iothread with idle monitor I/O. */
    close(mon);
    unlink(MONITOR_SOCK);

    /* ----- TEST #4 / #4b: host-injected MMIO via SDK -----
     *
     * Same address_space_write/read path the guest CPU would use, but
     * driven directly from this host thread under the BQL. No monitor,
     * no guest. Useful for regression tests that want to assert
     * "given input X to the peripheral, observe output Y" without
     * orchestrating a kernel.
     */
    printf("\n--- TEST #4: embed_mmio_write(0x%llx, 4, 0xdeadbeef) "
           "invokes fake_write ---\n", (unsigned long long)PERIPH_BASE);
    int writes_before = g_fake_writes;
    embed_mmio_write(PERIPH_BASE, 4, 0xdeadbeefull);
    int fired_w = g_fake_writes - writes_before;
    if (fired_w == 1) {
        printf("  PASS  write callback fired exactly once with the SDK call\n");
        pass++;
    } else {
        printf("  FAIL  write callback fired %d times (expected 1)\n", fired_w);
        fail++;
    }

    printf("\n--- TEST #4b: embed_mmio_read(0x%llx, 4) returns 0xcafe0004 "
           "(fake_read pattern) ---\n", (unsigned long long)(PERIPH_BASE + 4));
    int reads_before2 = g_fake_reads;
    uint64_t got = embed_mmio_read(PERIPH_BASE + 4, 4);
    int fired_r = g_fake_reads - reads_before2;
    /* fake_read returns 0xCAFE0000 | (off & 0xFFFF). For off=4 -> 0xcafe0004. */
    if (fired_r == 1 && got == 0xcafe0004ull) {
        printf("  PASS  read callback fired once, returned 0x%llx\n",
               (unsigned long long)got);
        pass++;
    } else {
        printf("  FAIL  fired=%d got=0x%llx (expected fired=1 got=0xcafe0004)\n",
               fired_r, (unsigned long long)got);
        fail++;
    }

    /* ----- TEST #6 / #6b: guest-driven MMIO via embed_qemu_step ----- */
    printf("\n--- TEST #6/#6b: run guest for %.1fs, expect >= 4 writes "
           "and >= 4 reads from kernel ---\n",
           STEP_BUDGET_NS / 1e9);

    int reads_pre  = g_fake_reads;
    int writes_pre = g_fake_writes;

    EmbedStepStats st = {0};
    embed_qemu_step(STEP_BUDGET_NS, &st);
    printf("  step: requested=%.3fs  actual_wall=%.3fs  guest_left_running=%d\n",
           st.requested_dt_ns / 1e9, st.actual_wall_ns / 1e9,
           st.guest_left_running_state);

    int writes_from_guest = g_fake_writes - writes_pre;
    int reads_from_guest  = g_fake_reads  - reads_pre;

    if (writes_from_guest >= 4) {
        printf("  PASS  TEST #6  guest produced %d write(s) (>= 4)\n",
               writes_from_guest);
        pass++;
    } else {
        printf("  FAIL  TEST #6  guest produced %d write(s) (expected >= 4)\n",
               writes_from_guest);
        printf("        Did the kernel actually do the writes? Standalone:\n"
               "        make -C apps/10-mmio-probe run\n");
        fail++;
    }
    if (reads_from_guest >= 4) {
        printf("  PASS  TEST #6b guest produced %d read(s) (>= 4)\n",
               reads_from_guest);
        pass++;
    } else {
        printf("  FAIL  TEST #6b guest produced %d read(s) (expected >= 4)\n",
               reads_from_guest);
        fail++;
    }

    /* ----- TEST #7 / #7b: IRQ end-to-end -----
     *
     * If the kernel is mmio_irq_probe.exe, it does the standard 4w+4r
     * AND then writes IRQ_TRIGGER_VAL to the trigger offset. Our
     * fake_write detects the magic value and calls embed_irq_pulse(N)
     * from inside the callback, which marks IRQ N pending in the
     * IRQMP. The CPU takes the trap on the next instruction boundary;
     * the guest's installed ISR writes ISR_MARK_VAL, which we then
     * see come back through fake_write again.
     *
     * If the kernel is the plain mmio_probe.exe (no IRQ phase), these
     * counters stay zero and the test reports SKIP -- legitimate use
     * of the test against the simpler kernel.
     */
    printf("\n--- TEST #7/#7b: IRQ round-trip via embed_irq_pulse(line=%d) ---\n",
           CONFIG_IRQ_LINE);
    if (g_irq_triggers_sent > 0) {
        printf("  PASS  TEST #7  host pulsed IRQ %d times (saw trigger marker)\n",
               g_irq_triggers_sent);
        pass++;
        if (g_isr_marker_seen > 0) {
            printf("  PASS  TEST #7b guest ISR ran %d times (saw ISR marker)\n",
                   g_isr_marker_seen);
            pass++;
        } else {
            printf("  FAIL  TEST #7b guest ISR never ran (no 0xB2B2B2B2 seen)\n"
                   "        IRQMP mask config? IRQ line %d busy? ISR install?\n",
                   CONFIG_IRQ_LINE);
            fail++;
        }
    } else {
        printf("  SKIP  TEST #7/#7b: kernel did not write the trigger marker.\n"
               "        Use apps/12-mmio-irq-probe (gr712rc) or apps/13-... (gr740).\n");
    }

    /* ----- Summary ----- */
    printf("\n=== Summary: %d/%d tests passed ===\n", pass, pass + fail);
    printf("Total host-side counters: reads=%d  writes=%d\n",
           g_fake_reads, g_fake_writes);

    printf("\nGuest UART (%s):\n", UART_LOG);
    FILE *uart = fopen(UART_LOG, "r");
    if (uart) {
        char line[256];
        while (fgets(line, sizeof(line), uart)) {
            printf("  %s", line);
        }
        fclose(uart);
    } else {
        printf("  (no log)\n");
    }

    embed_qemu_cleanup();
    return (fail == 0) ? 0 : 1;
}
