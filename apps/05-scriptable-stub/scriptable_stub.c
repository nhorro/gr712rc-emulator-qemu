/*
 * Scriptable-device exerciser (issue #4, Part 1)
 *
 * Verifies the Lua-driven stub behaviour defined in grspw0.lua:
 *   - status register at offset 4 reads as 0xCAFE0000
 *   - scratch register at offset 0 round-trips a written value
 *   - other offsets read as 0
 */

#define CONFIGURE_INIT
#include <rtems.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS                 1
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE
#define CONFIGURE_INIT_TASK_ATTRIBUTES          RTEMS_FLOATING_POINT

#include <rtems/confdefs.h>

#define GRSPW0_BASE     0x80100800u
#define STATUS_EXPECTED 0xCAFE0000u
#define SCRATCH_VALUE   0xDEADBEEFu

/* Trigger register inside the scripted device — write to pulse IRQ 12. */
#define TRIGGER_OFFSET  0x010u
#define IRQ_LINE        12

/* IRQMP register window (see GR712RC user's manual). */
#define IRQMP_PENDING   0x80000204u
#define IRQMP_CLEAR     0x8000020Cu

/* Address inside APB1 with no modeled or scripted device (CAN slot). */
#define UNMAPPED_APB    0x80000A00u

static int check_eq(const char *name, uint32_t got, uint32_t want)
{
    int ok = (got == want);
    printf("%-20s got=0x%08lx want=0x%08lx %s\n",
           name, (unsigned long)got, (unsigned long)want,
           ok ? "PASS" : "FAIL");
    return ok;
}

rtems_task Init(rtems_task_argument ignored)
{
    volatile uint32_t *regs = (volatile uint32_t *)GRSPW0_BASE;
    int fails = 0;

    printf("\n*** GR712RC scriptable-device exerciser (Lua) ***\n");

    fails += !check_eq("status[0x4]",   regs[1], STATUS_EXPECTED);

    regs[0] = SCRATCH_VALUE;
    fails += !check_eq("scratch r/w",   regs[0], SCRATCH_VALUE);

    fails += !check_eq("unmapped[0x8]", regs[2], 0u);

    /*
     * IRQ test — the Lua script pulses IRQ 12 when we write to
     * GRSPW0_BASE + TRIGGER_OFFSET. Verify by reading the IRQMP pending
     * register before/after, with interrupts disabled so we can observe
     * the latched bit before any handler runs. Then ack via IRQMP clear.
     */
    {
        volatile uint32_t *trigger = (volatile uint32_t *)
                                     (GRSPW0_BASE + TRIGGER_OFFSET);
        volatile uint32_t *pending = (volatile uint32_t *)IRQMP_PENDING;
        volatile uint32_t *clr     = (volatile uint32_t *)IRQMP_CLEAR;
        const uint32_t bit = 1u << IRQ_LINE;

        rtems_interrupt_level lvl;
        rtems_interrupt_disable(lvl);

        uint32_t before  = *pending & bit;
        *trigger = 1;                              /* fires sim.irq_raise/lower */
        uint32_t after   = *pending & bit;
        *clr = bit;                                /* ack */
        uint32_t cleared = *pending & bit;

        rtems_interrupt_enable(lvl);

        fails += !check_eq("irq pending before", before,  0u);
        fails += !check_eq("irq pending after",  after,   bit);
        fails += !check_eq("irq pending cleared",cleared, 0u);
    }

    /*
     * Poke an unmapped APB address to demonstrate the gr712rc-diag catcher.
     * Run with `-d guest_errors,unimp` to see the diagnostic log entries.
     * These reads/writes do not affect pass/fail.
     */
    {
        volatile uint32_t *un = (volatile uint32_t *)UNMAPPED_APB;
        printf("[diag-demo] writing 0x12345678 to 0x%08lx\n",
               (unsigned long)UNMAPPED_APB);
        *un = 0x12345678u;
        uint32_t v = *un;
        printf("[diag-demo] read 0x%08lx -> 0x%08lx\n",
               (unsigned long)UNMAPPED_APB, (unsigned long)v);
    }

    printf("*** %s ***\n", fails ? "FAILED" : "END OF TEST");
    exit(fails);
}
