/*
 * MkProm self-bootable demo for GR712RC / RTEMS SMP
 *
 * Same dual-core counter as 02-dual-core-timer, but the ELF is wrapped by
 * mkprom2 into a self-bootable PROM image that QEMU loads via -bios.
 * No -kernel trampoline is involved; the firmware in PROM does the
 * memory-controller setup, copies the app to SDRAM, releases CPU 1 and
 * jumps to the entry point.
 *
 * Build:  see Makefile (sparc-gaisler-rtems5-gcc + mkprom2)
 * Run:    qemu-system-sparc -M gr712rc -nographic -bios gr712rc-prom.bin
 */

#define CONFIGURE_INIT

#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>

#define CONFIGURE_MAXIMUM_PROCESSORS        2

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS             3

#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

typedef struct {
    int  core;
    int  start;
} counter_arg_t;

static counter_arg_t core0_arg = { .core = 0, .start = 100 };
static counter_arg_t core1_arg = { .core = 1, .start = 200 };

rtems_task counter_task(rtems_task_argument arg)
{
    const counter_arg_t *a       = (const counter_arg_t *)arg;
    int                  counter = a->start;
    rtems_interval       ticks   = rtems_clock_get_ticks_per_second();

    while (1) {
        printf("[mkprom-boot] CPU %d: %d\n", a->core, counter++);
        rtems_task_wake_after(ticks);
    }
}

rtems_task Init(rtems_task_argument ignored)
{
    rtems_id   tid;
    rtems_name name;
    cpu_set_t  affinity;

    printf("[mkprom-boot] RTEMS booted from MkProm PROM image\n");

    name = rtems_build_name('C', 'N', 'T', '0');
    rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                      RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
    CPU_ZERO(&affinity);
    CPU_SET(0, &affinity);
    rtems_task_set_affinity(tid, sizeof(affinity), &affinity);
    rtems_task_start(tid, counter_task, (rtems_task_argument)&core0_arg);

    name = rtems_build_name('C', 'N', 'T', '1');
    rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                      RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
    CPU_ZERO(&affinity);
    CPU_SET(1, &affinity);
    rtems_task_set_affinity(tid, sizeof(affinity), &affinity);
    rtems_task_start(tid, counter_task, (rtems_task_argument)&core1_arg);

    rtems_task_exit();
}
