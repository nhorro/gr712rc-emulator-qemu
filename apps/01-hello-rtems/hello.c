/*
 * RTEMS Hello World for GR712RC / LEON3
 *
 * Build with RCC 1.3.2:
 *   sparc-rtems5-gcc -qbsp=gr712rc hello.c -o hello.exe
 *
 * Run on QEMU:
 *   qemu-system-sparc -M gr712rc -nographic -kernel hello.exe
 */

#define CONFIGURE_INIT
#include <rtems.h>
#include <stdio.h>
#include <stdlib.h>

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER

#define CONFIGURE_MAXIMUM_TASKS             1
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

rtems_task Init(rtems_task_argument ignored)
{
    printf("\n*** GR712RC RTEMS Hello World ***\n");
    printf("Running on QEMU gr712rc machine\n");
    printf("*** END OF TEST ***\n");
    exit(0);
}
