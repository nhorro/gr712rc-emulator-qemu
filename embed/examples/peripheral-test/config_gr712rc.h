/*
 * Per-machine config for the peripheral-test (GR712RC).
 *
 * GR712RC has an AMBA diag catch-all (priority -1) covering APB1+APB2
 * (0x80000000-0x801fffff). Our embed peripheral lives at 0x80000800
 * (free APB1 slot between GPTIMER at 0x80000300 and APB1_PNP at
 * 0x800ff000). TEST #2b reads at OUTSIDE_ADDR expecting the diag log,
 * not our callback -- the priority guarantee.
 */

#ifndef PERIPHERAL_TEST_CONFIG_H
#define PERIPHERAL_TEST_CONFIG_H

#define CONFIG_MACHINE_NAME       "gr712rc"
#define CONFIG_PERIPH_BASE        0x80000800ull
#define CONFIG_OUTSIDE_ADDR       0x80000900ull
#define CONFIG_HAS_DIAG_CATCH_ALL 1
#define CONFIG_IRQ_LINE           7   /* free in GR712RC IRQ map */
#define CONFIG_MONITOR_SOCK       "/tmp/embed-peripheral-test-gr712rc.qmon"
#define CONFIG_UART_LOG           "/tmp/embed-peripheral-test-gr712rc.uart.log"

#endif
