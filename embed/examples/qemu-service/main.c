/*
 * qemu-system-sparc-embed -- drop-in replacement for qemu-system-sparc
 * built on top of libqemu-sparc.so.
 *
 * Accepts the SAME argv as qemu-system-sparc (-M, -smp, -m, -kernel,
 * -bios, -qmp, -monitor, -chardev, -serial, -nographic, -S, ...) so
 * the FastAPI service (service/adapter/qemu.py) can swap binaries by
 * just changing the path. QMP, UART sockets, SpW taps all keep
 * working transparently because they are native QEMU 8.2.2 plumbing.
 *
 * Goes beyond the standalone in one way: between qemu_init() and
 * vm_start(), we register a host-side "info" peripheral via the
 * embedding SDK. The peripheral has no analog in plain
 * qemu-system-sparc and is the visible marker that the simulation
 * is now running inside this process rather than as a subprocess.
 *
 * Layout of the host-info peripheral (read-only, 16 bytes):
 *   offset 0x00 (4B):  magic 0x4C49424F ("LIBO" -- libqemu host)
 *   offset 0x04 (4B):  host PID
 *   offset 0x08 (4B):  wall-clock seconds since this process started
 *   offset 0x0C (4B):  machine code: 0x67723730 for gr712rc, +1 for gr740
 *
 * Base address differs per machine (chosen from a free APB slot):
 *   gr712rc: 0x80000a00
 *   gr740:   0xff900a00
 *
 * Visible from the UI's Memory pane (or QMP "xp" through the service).
 */

#define _GNU_SOURCE
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <libqemu.h>
#include "embed_qemu.h"

#define HOST_INFO_MAGIC 0x4C49424Fu      /* "LIBO" */
#define HOST_INFO_SIZE  0x100u

#define BASE_GR712RC    0x80000a00ull
#define BASE_GR740      0xff900a00ull

#define MACHINE_CODE_GR712RC 0x67723730u  /* "gr70" */
#define MACHINE_CODE_GR740   0x67723731u  /* "gr71" -- one off, but unique */

static volatile sig_atomic_t signal_stop = 0;
static uint64_t g_periph_base;
static uint32_t g_machine_code;
static time_t   g_start_time;

static void on_signal(int sig)
{
    (void)sig;
    signal_stop = 1;
}

static uint64_t host_info_read(void *opaque, uint64_t off, unsigned size)
{
    (void)opaque;
    (void)size;
    switch (off & 0xFCu) {
    case 0x00: return HOST_INFO_MAGIC;
    case 0x04: return (uint32_t)getpid();
    case 0x08: return (uint32_t)(time(NULL) - g_start_time);
    case 0x0C: return g_machine_code;
    default:   return 0;
    }
}

/*
 * embed_register_peripheral() requires RUN_STATE_PRELAUNCH. Without
 * `-S` in the original argv, qemu_init() transitions out of PRELAUNCH
 * (the implicit auto-start of qemu-system-sparc), and the assertion
 * fires. We work around it transparently: inject `-S` here if absent,
 * then call vm_start() ourselves after register so the caller still
 * sees auto-start behavior. Callers who *did* pass -S keep their
 * paused-at-boot semantics.
 */
static char **ensure_minus_S(int argc, char **argv,
                             int *out_argc, bool *was_present)
{
    *was_present = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-S") == 0) {
            *was_present = true;
            *out_argc = argc;
            return argv;
        }
    }
    char **out = calloc((size_t)(argc + 2), sizeof(char *));
    if (!out) {
        return NULL;
    }
    out[0] = argv[0];
    out[1] = (char *)"-S";
    for (int i = 1; i < argc; i++) {
        out[i + 1] = argv[i];
    }
    *out_argc = argc + 1;
    return out;
}

static int parse_machine(int argc, char **argv, char *out, size_t outsz)
{
    for (int i = 1; i < argc - 1; i++) {
        if (strcmp(argv[i], "-M") == 0 || strcmp(argv[i], "-machine") == 0) {
            strncpy(out, argv[i + 1], outsz - 1);
            out[outsz - 1] = '\0';
            /* QEMU's -M accepts comma-separated options ("gr712rc,foo=bar");
             * keep just the machine type. */
            char *p = strchr(out, ',');
            if (p) {
                *p = '\0';
            }
            return 0;
        }
    }
    return -1;
}

int main(int argc, char **argv)
{
    signal(SIGINT,  on_signal);
    signal(SIGTERM, on_signal);

    char machine[32] = {0};
    if (parse_machine(argc, argv, machine, sizeof(machine)) != 0) {
        fprintf(stderr,
                "qemu-system-sparc-embed: missing -M <machine> in argv\n"
                "  (this wrapper supports -M gr712rc and -M gr740)\n");
        return 2;
    }
    if (strcmp(machine, "gr712rc") == 0) {
        g_periph_base  = BASE_GR712RC;
        g_machine_code = MACHINE_CODE_GR712RC;
    } else if (strcmp(machine, "gr740") == 0) {
        g_periph_base  = BASE_GR740;
        g_machine_code = MACHINE_CODE_GR740;
    } else {
        fprintf(stderr,
                "qemu-system-sparc-embed: unsupported machine '%s'\n"
                "  (supported: gr712rc, gr740)\n",
                machine);
        return 2;
    }

    fprintf(stderr, "qemu-system-sparc-embed: %s, machine=%s, host-info@0x%llx\n",
            libqemu_embed_version, machine,
            (unsigned long long)g_periph_base);

    int   eff_argc;
    bool  caller_had_S;
    char **eff_argv = ensure_minus_S(argc, argv, &eff_argc, &caller_had_S);
    if (!eff_argv) {
        fprintf(stderr, "qemu-system-sparc-embed: out of memory\n");
        return 1;
    }

    int rc = embed_qemu_init(eff_argc, eff_argv);
    if (rc != 0) {
        fprintf(stderr,
                "qemu-system-sparc-embed: embed_qemu_init failed rc=%d\n",
                rc);
        return rc;
    }

    /* PRELAUNCH state right now (guaranteed by ensure_minus_S). */
    EmbedPeripheralOps ops = {
        .read       = host_info_read,
        .write      = NULL,
        .endian     = EMBED_ENDIAN_BIG,
        .min_access = 1,
        .max_access = 4,
    };
    g_start_time = time(NULL);
    embed_register_peripheral(g_periph_base, HOST_INFO_SIZE, &ops, NULL);

    /* If the caller did NOT originally pass -S, kick the VM now so the
     * observable behavior matches qemu-system-sparc's auto-start. The
     * FastAPI service does pass -S and will issue QMP "cont" itself --
     * in that case we stay paused as the caller expects. */
    if (!caller_had_S) {
        vm_start();
    }

    /* Main loop. Patterned after qemu_main_loop() in QEMU's runstate.c:
     * pump events forever, exit when the runstate transitions to
     * SHUTDOWN (QMP "quit", guest power-down, etc.) or we got a
     * SIGINT/SIGTERM. */
    while (!signal_stop) {
        main_loop_wait(false);
        if (runstate_check(RUN_STATE_SHUTDOWN)) {
            break;
        }
    }

    fprintf(stderr, "qemu-system-sparc-embed: shutting down (signal_stop=%d)\n",
            signal_stop);
    embed_qemu_cleanup();
    return 0;
}
