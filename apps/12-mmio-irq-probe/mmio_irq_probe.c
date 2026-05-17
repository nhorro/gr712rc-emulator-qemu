/*
 * mmio-irq-probe (GR712RC) -- end-to-end test of the SDK IRQ path.
 *
 * Sequence:
 *   1. Install an ISR on IRQ 7 via rtems_interrupt_handler_install
 *      (the BSP enables the line in the IRQMP mask register).
 *   2. Do the standard 4w+4r pattern at PROBE_BASE for backward
 *      compatibility with the existing peripheral-test TEST #6.
 *   3. Write 0xA1A1A1A1 to PROBE_BASE+0x10 ("trigger").
 *      The host fake_write callback recognizes this value, calls
 *      embed_irq_pulse(7) from inside the callback. The IRQMP latches
 *      the pending bit; on the next instruction boundary the SPARC CPU
 *      takes trap 0x17 (IRQ 7), the BSP dispatches to our ISR.
 *   4. The ISR writes 0xB2B2B2B2 to PROBE_BASE+0x14 ("ISR fired") and
 *      sets a volatile flag.
 *   5. Init task spins waiting for the flag (up to ~500 ms), prints
 *      the outcome, exits.
 *
 * Pair: apps/13-mmio-irq-probe-gr740/ -- same logic, gr740 BSP, base
 * 0xff900800, same IRQ line 7.
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
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE
#include <rtems/confdefs.h>

#define PROBE_BASE 0x80000800u
#define IRQ_LINE   7

static volatile uint32_t g_isr_fired;

static void my_isr(void *arg)
{
    (void)arg;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;
    mmio[5] = 0xB2B2B2B2u;       /* offset 0x14 -- "ISR ran" */
    g_isr_fired = 1;
}

rtems_task Init(rtems_task_argument ignored)
{
    (void)ignored;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;

    puts("mmio-irq-probe: started"); fflush(stdout);

    rtems_status_code sc = rtems_interrupt_handler_install(
        IRQ_LINE, "fake-periph", RTEMS_INTERRUPT_UNIQUE,
        my_isr, NULL);
    if (sc != RTEMS_SUCCESSFUL) {
        printf("mmio-irq-probe: handler_install FAILED sc=%d\n", (int)sc);
        fflush(stdout);
        exit(1);
    }
    puts("mmio-irq-probe: ISR installed"); fflush(stdout);

    /* Same 4w + 4r pattern the host's TEST #6 expects. */
    mmio[0] = 0x11111111u;
    mmio[1] = 0x22222222u;
    mmio[2] = 0x33333333u;
    mmio[3] = 0x44444444u;
    (void)mmio[0]; (void)mmio[1]; (void)mmio[2]; (void)mmio[3];

    /* Trigger marker: host's fake_write detects 0xA1A1A1A1 and pulses
     * IRQ_LINE. By the time the store returns the IRQ is pending in
     * the IRQMP; the CPU takes the trap on its next instruction. */
    mmio[4] = 0xA1A1A1A1u;       /* offset 0x10 */

    /* Wait up to ~500 ms for the ISR. With default 10 ms tick that is
     * 50 iterations; in practice the IRQ delivers within microseconds
     * so we usually break out on the first tick. */
    for (int i = 0; i < 50; i++) {
        if (g_isr_fired) break;
        rtems_task_wake_after(1);
    }

    if (g_isr_fired) {
        puts("mmio-irq-probe: ISR fired");
    } else {
        puts("mmio-irq-probe: ISR did NOT fire (timeout)");
    }
    fflush(stdout);
    exit(0);
}
