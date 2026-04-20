/*
 * Five-UART traffic demo for GR712RC / RTEMS SMP
 *
 * Sends a periodic counter message on each of the five APBUARTs.
 * UART-0 uses printf (console).  UARTs 1-4 write directly to the
 * APBUART TX register, making the test independent of termios setup.
 *
 * Connect external receivers with:
 *   -serial mon:stdio \
 *   -serial tcp::5001,server,nowait \
 *   -serial tcp::5002,server,nowait \
 *   -serial tcp::5003,server,nowait \
 *   -serial tcp::5004,server,nowait
 *
 * Build:
 *   sparc-gaisler-rtems5-gcc -qbsp=gr712rc_smp five_uarts.c -o five_uarts.exe
 */

#define CONFIGURE_INIT

#include <rtems.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

/* ---- RTEMS configuration ------------------------------------------------ */

#define CONFIGURE_MAXIMUM_PROCESSORS        2
#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER
#define CONFIGURE_MAXIMUM_TASKS             2   /* Init + uart_task */
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE

#include <rtems/confdefs.h>

/* ---- APBUART register layout ------------------------------------------- */

typedef struct {
    volatile uint32_t data;     /* 0x00 RX/TX data */
    volatile uint32_t status;   /* 0x04 status      */
    volatile uint32_t ctrl;     /* 0x08 control     */
    volatile uint32_t scaler;   /* 0x0C baud scaler */
} apbuart_regs_t;

#define UART_STATUS_TE   (1u << 2)   /* TX shift register empty */
#define UART_STATUS_TF   (1u << 9)   /* TX FIFO full            */
#define UART_CTRL_TE     (1u << 1)   /* TX enable               */
#define UART_CTRL_RE     (1u << 0)   /* RX enable               */

/* APB addresses from GR712RC User's Manual v2.17 */
static apbuart_regs_t * const uart_base[5] = {
    (apbuart_regs_t *)0x80000100u,   /* UART-0 (console) */
    (apbuart_regs_t *)0x80100100u,   /* UART-1           */
    (apbuart_regs_t *)0x80100200u,   /* UART-2           */
    (apbuart_regs_t *)0x80100300u,   /* UART-3           */
    (apbuart_regs_t *)0x80100400u,   /* UART-4           */
};

/* ---- Low-level UART helpers -------------------------------------------- */

static void uart_init(int n)
{
    /* Enable TX and RX; leave scaler at reset value (set by bootloader). */
    uart_base[n]->ctrl = UART_CTRL_TE | UART_CTRL_RE;
}

static void uart_putc(int n, char c)
{
    /* Spin until TX shift register is empty. */
    while (!(uart_base[n]->status & UART_STATUS_TE)) {
        ;
    }
    uart_base[n]->data = (uint32_t)(unsigned char)c;
}

static void uart_puts(int n, const char *s)
{
    while (*s) {
        uart_putc(n, *s++);
    }
}

static void uart_put_uint(int n, uint32_t v)
{
    char buf[12];
    int  i = sizeof(buf) - 1;
    buf[i] = '\0';
    if (v == 0) {
        buf[--i] = '0';
    } else {
        while (v && i > 0) {
            buf[--i] = '0' + (v % 10);
            v /= 10;
        }
    }
    uart_puts(n, &buf[i]);
}

/* ---- UART traffic task -------------------------------------------------- */

rtems_task uart_task(rtems_task_argument ignored)
{
    uint32_t counter[5] = { 0, 100, 200, 300, 400 };
    rtems_interval ticks = rtems_clock_get_ticks_per_second();
    int n;

    /* Initialise UARTs 1-4 (UART-0 is already set up by the BSP). */
    for (n = 1; n < 5; n++) {
        uart_init(n);
    }

    while (1) {
        /* UART-0: use printf so the console driver formats the string. */
        printf("UART0: %lu\n", (unsigned long)counter[0]);

        /* UARTs 1-4: write directly to the TX register. */
        for (n = 1; n < 5; n++) {
            uart_puts(n, "UART");
            uart_putc(n, '0' + n);
            uart_puts(n, ": ");
            uart_put_uint(n, counter[n]);
            uart_puts(n, "\r\n");
        }

        for (n = 0; n < 5; n++) {
            counter[n]++;
        }

        rtems_task_wake_after(ticks);
    }
}

/* ---- Init task ---------------------------------------------------------- */

rtems_task Init(rtems_task_argument ignored)
{
    rtems_id   tid;
    rtems_name name = rtems_build_name('U', 'A', 'R', 'T');

    rtems_task_create(name, 1, RTEMS_MINIMUM_STACK_SIZE,
                      RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
    rtems_task_start(tid, uart_task, 0);
    rtems_task_exit();
}
