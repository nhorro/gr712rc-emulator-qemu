/*
 * RTEMS Hello World for GR740 / LEON4 (Phase 0 spike).
 *
 * Built with RCC 1.3.2 -qbsp=gr740. Initially run against -M gr712rc to
 * capture the list of unmapped accesses RTEMS makes during BSP startup;
 * those accesses are the to-do list for the GR740 machine model.
 */

#define CONFIGURE_INIT
#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS             1
#define CONFIGURE_INIT_TASK_ATTRIBUTES      RTEMS_FLOATING_POINT
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

rtems_task Init(rtems_task_argument ignored)
{
    printf("\n*** GR740 RTEMS Hello World ***\n");
    printf("Running on QEMU\n");
    printf("*** END OF TEST ***\n");
    exit(0);
}
