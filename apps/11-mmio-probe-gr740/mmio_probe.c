/*
 * mmio-probe (GR740 variant) — drive accesses to a host-side fake
 * peripheral at 0xff900800 (free APB slot between GPTIMER at
 * 0xff900300 and GRSPW0 at 0xff901000).
 *
 * Pair with embed/examples/peripheral-test (run-gr740 target). See
 * apps/10-mmio-probe/mmio_probe.c for the same logic on GR712RC at
 * 0x80000800 -- both apps are kept in sync.
 *
 * BSP gr740 is SMP-capable (4 LEON4 cores); we still use it for a
 * single-task scenario. RTEMS_FLOATING_POINT on the Init task is
 * required because the SMP-aware BSP does synchronous FP context
 * switching and printf emits FP instructions in some libc paths.
 */

#define CONFIGURE_INIT
#include <rtems.h>
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

rtems_task Init(rtems_task_argument ignored)
{
    (void)ignored;
    volatile uint32_t *mmio = (volatile uint32_t *)PROBE_BASE;

    puts("mmio-probe-gr740: started"); fflush(stdout);

    mmio[0] = 0x11111111u;
    mmio[1] = 0x22222222u;
    mmio[2] = 0x33333333u;
    mmio[3] = 0x44444444u;

    (void)mmio[0];
    (void)mmio[1];
    (void)mmio[2];
    (void)mmio[3];

    puts("mmio-probe-gr740: 4w + 4r done"); fflush(stdout);
    exit(0);
}
