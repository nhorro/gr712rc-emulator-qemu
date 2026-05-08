/*
 * Quad-core counter demo for GR740 / RTEMS SMP
 *
 * One affinity-pinned task per core; each prints its core index and a
 * monotonically-increasing counter once per second. Counter start values
 * are spread by core (10/20/30/40) so the per-core stream is recognizable
 * in the interleaved output.
 *
 * Build:  sparc-gaisler-rtems5-gcc -qbsp=gr740_smp quad_core_timer.c
 *                                  -o quad_core_timer.exe
 * Run:    qemu-system-sparc -M gr740 -nographic -kernel quad_core_timer.exe
 */

#define CONFIGURE_INIT

#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>

#define CONFIGURE_MAXIMUM_PROCESSORS        4

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS             5   /* Init + 4 counter tasks */

#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

typedef struct {
    int core;
    int start;
} counter_arg_t;

static counter_arg_t counter_args[4] = {
    { .core = 0, .start = 10 },
    { .core = 1, .start = 20 },
    { .core = 2, .start = 30 },
    { .core = 3, .start = 40 },
};

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

rtems_task Init(rtems_task_argument ignored)
{
    rtems_id   tid;
    rtems_name name;
    cpu_set_t  affinity;
    int        i;
    char       names[4][4] = { "CNT0", "CNT1", "CNT2", "CNT3" };

    for (i = 0; i < 4; i++) {
        name = rtems_build_name(names[i][0], names[i][1],
                                names[i][2], names[i][3]);
        rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                          RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
        CPU_ZERO(&affinity);
        CPU_SET(i, &affinity);
        rtems_task_set_affinity(tid, sizeof(affinity), &affinity);
        rtems_task_start(tid, counter_task,
                         (rtems_task_argument)&counter_args[i]);
    }

    rtems_task_exit();
}
