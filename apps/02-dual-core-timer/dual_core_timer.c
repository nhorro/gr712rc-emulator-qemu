/*
 * Dual-core counter demo for GR712RC / RTEMS SMP
 *
 * Core 0 prints "Core 0: <counter>" starting from 10, every second.
 * Core 1 prints "Core 1: <counter>" starting from 20, every second.
 *
 * Build:  sparc-gaisler-rtems5-gcc -qbsp=gr712rc_smp dual_core_timer.c -o dual_core_timer.exe
 * Run:    qemu-system-sparc -M gr712rc -nographic -kernel dual_core_timer.exe
 */

#define CONFIGURE_INIT

#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>

/* ---------- RTEMS configuration ----------------------------------------- */

#define CONFIGURE_MAXIMUM_PROCESSORS        2

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS             3   /* Init + 2 counter tasks */

#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

/* ---------- Counter task ------------------------------------------------- */

typedef struct {
    int  core;
    int  start;
} counter_arg_t;

static counter_arg_t core0_arg = { .core = 0, .start = 10 };
static counter_arg_t core1_arg = { .core = 1, .start = 20 };

rtems_task counter_task(rtems_task_argument arg)
{
    const counter_arg_t *a       = (const counter_arg_t *)arg;
    int                  counter = a->start;
    rtems_interval       ticks   = rtems_clock_get_ticks_per_second();

    while (1) {
        printf("Core %d: %d\n", a->core, counter++);
        rtems_task_wake_after(ticks);
    }
}

/* ---------- Init task ---------------------------------------------------- */

rtems_task Init(rtems_task_argument ignored)
{
    rtems_id   tid;
    rtems_name name;

    cpu_set_t affinity;

    /* Task for core 0 */
    name = rtems_build_name('C', 'N', 'T', '0');
    rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                      RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
    CPU_ZERO(&affinity);
    CPU_SET(0, &affinity);
    rtems_task_set_affinity(tid, sizeof(affinity), &affinity);
    rtems_task_start(tid, counter_task, (rtems_task_argument)&core0_arg);

    /* Task for core 1 */
    name = rtems_build_name('C', 'N', 'T', '1');
    rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                      RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
    CPU_ZERO(&affinity);
    CPU_SET(1, &affinity);
    rtems_task_set_affinity(tid, sizeof(affinity), &affinity);
    rtems_task_start(tid, counter_task, (rtems_task_argument)&core1_arg);

    rtems_task_exit();
}
