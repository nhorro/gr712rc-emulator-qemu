/*
 * mmio-irq-probe (GR740 variant) -- end-to-end test of the SDK IRQ
 * path. Mirror of apps/12-mmio-irq-probe for the GR712RC machine.
 * See that file for the protocol description.
 *
 * Differences: base 0xff900800 (single APB bridge of GR740), gr740 BSP
 * which is SMP-capable so the Init task uses RTEMS_FLOATING_POINT.
 * Same IRQ line (7) -- free in both machines.
 */

#define CONFIGURE_INIT
#include <rtems.h>
#include <rtems/irq-extension.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER
#define CONFIGURE_MAXIMUM_TASKS             1
#define CONFIGURE_INIT_TASK_ATTRIBUTES      RTEMS_FLOATING_POINT
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE
#include <rtems/confdefs.h>

#define PROBE_BASE 0xff900800u
#define IRQ_LINE   7

static volatile uint32_t g_isr_fired;

static void my_isr(void *arg)
{
    (void)arg;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;
    mmio[5] = 0xB2B2B2B2u;
    g_isr_fired = 1;
}

rtems_task Init(rtems_task_argument ignored)
{
    (void)ignored;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;

    puts("mmio-irq-probe-gr740: started"); fflush(stdout);

    rtems_status_code sc = rtems_interrupt_handler_install(
        IRQ_LINE, "fake-periph", RTEMS_INTERRUPT_UNIQUE,
        my_isr, NULL);
    if (sc != RTEMS_SUCCESSFUL) {
        printf("mmio-irq-probe-gr740: handler_install FAILED sc=%d\n",
               (int)sc);
        fflush(stdout);
        exit(1);
    }
    puts("mmio-irq-probe-gr740: ISR installed"); fflush(stdout);

    mmio[0] = 0x11111111u;
    mmio[1] = 0x22222222u;
    mmio[2] = 0x33333333u;
    mmio[3] = 0x44444444u;
    (void)mmio[0]; (void)mmio[1]; (void)mmio[2]; (void)mmio[3];

    mmio[4] = 0xA1A1A1A1u;

    for (int i = 0; i < 50; i++) {
        if (g_isr_fired) break;
        rtems_task_wake_after(1);
    }

    if (g_isr_fired) {
        puts("mmio-irq-probe-gr740: ISR fired");
    } else {
        puts("mmio-irq-probe-gr740: ISR did NOT fire (timeout)");
    }
    fflush(stdout);
    exit(0);
}
