/*
 * mmio-probe — drive accesses to a host-side fake peripheral.
 *
 * Pair with embed/examples/peripheral-test/, which registers an
 * EmbedPeripheralOps at 0x80000800 via embed_register_peripheral() and
 * counts callbacks. This task issues 4 word writes and 4 word reads at
 * that base, then idles. The host test inspects its counters to verify
 * the guest CPU's MMIO traffic actually reached the EmbedPeripheralOps
 * trampoline through the full SPARC bus path (not just an HMP `xp`
 * shortcut).
 *
 * Single-core gr712rc BSP — no FLOATING_POINT flag needed since lazy
 * FP context switching is fine outside SMP (see CLAUDE.md "FPU and SMP
 * interaction").
 */

#define CONFIGURE_INIT
#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER
#define CONFIGURE_MAXIMUM_TASKS             1
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

#define PROBE_BASE 0x80000800u

rtems_task Init(rtems_task_argument ignored)
{
    (void)ignored;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;

    /* Visible "I booted" marker. We intentionally do not print the
     * values returned by the reads below: when this binary runs against
     * the AMBA diag catch-all (no real peripheral at PROBE_BASE), the
     * read returns 0 and RTEMS terminates after consuming that 0 in a
     * way we could not narrow down -- printf("%08x", v) hangs while
     * `if (v == 0) puts("ok");` does not. Inside peripheral-test the
     * host has a real handler at PROBE_BASE, but we keep the binary
     * standalone-friendly so it cannot get into that wedge either. The
     * host-side g_fake_reads/g_fake_writes counters are the assertion;
     * UART output is just operator confidence. */
    puts("mmio-probe: started"); fflush(stdout);

    /* 4 word writes -> fake_write callback should fire 4 times. */
    mmio[0] = 0x11111111u;
    mmio[1] = 0x22222222u;
    mmio[2] = 0x33333333u;
    mmio[3] = 0x44444444u;

    /* 4 word reads -> fake_read callback should fire 4 times. The
     * return value is the fake peripheral's 0xCAFE0000 | offset
     * pattern, but we deliberately ignore it -- see note above. */
    (void)mmio[0];
    (void)mmio[1];
    (void)mmio[2];
    (void)mmio[3];

    puts("mmio-probe: 4w + 4r done"); fflush(stdout);
    exit(0);
}
