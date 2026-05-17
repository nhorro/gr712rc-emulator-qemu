/*
 * Per-machine config for the Model D sampling example (GR740).
 *
 * Free APB slot (between GPTIMER at 0xff900300 and GRSPW0 at
 * 0xff901000), mirroring the peripheral-test layout. No PnP entry.
 */

#ifndef SAMPLING_CONFIG_H
#define SAMPLING_CONFIG_H

#define CONFIG_MACHINE_NAME   "gr740"
#define CONFIG_PERIPH_BASE    0xff900800ull
#define CONFIG_UART_LOG       "/tmp/embed-sampling-gr740.uart.log"
#define CONFIG_MODEL_A_FLOOR  "~200-255 us (gr740 SMP, see docs/11)"

#endif
