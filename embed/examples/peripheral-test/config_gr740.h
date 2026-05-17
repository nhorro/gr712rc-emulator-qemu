/*
 * Per-machine config for the peripheral-test (GR740).
 *
 * GR740 has a single APB bridge at 0xff900000-0xff9fffff. Our embed
 * peripheral lives at 0xff900800 (free APB slot between GPTIMER at
 * 0xff900300 and GRSPW0 at 0xff901000) -- direct mirror of the
 * GR712RC layout.
 *
 * GR740 has NO diag catch-all installed (gr712rc_install_amba_diag
 * is GR712RC-only). So TEST #2b's "priority over diag" angle does
 * not apply -- the test still asserts "callback does NOT fire for
 * an outside-region address", but the address falls into empty space
 * rather than a competing catch-all.
 */

#ifndef PERIPHERAL_TEST_CONFIG_H
#define PERIPHERAL_TEST_CONFIG_H

#define CONFIG_MACHINE_NAME       "gr740"
#define CONFIG_PERIPH_BASE        0xff900800ull
#define CONFIG_OUTSIDE_ADDR       0xff900900ull
#define CONFIG_HAS_DIAG_CATCH_ALL 0
#define CONFIG_IRQ_LINE           7   /* free in GR740 IRQ map */
#define CONFIG_MONITOR_SOCK       "/tmp/embed-peripheral-test-gr740.qmon"
#define CONFIG_UART_LOG           "/tmp/embed-peripheral-test-gr740.uart.log"

#endif
