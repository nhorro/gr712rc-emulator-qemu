/*
 * Per-machine config for the Model D sampling example (GR712RC).
 *
 * Same APB1 free slot as the peripheral-test example (between
 * GPTIMER at 0x80000300 and APB1_PNP at 0x800ff000). No PnP
 * declaration — the guest does not need to discover this peripheral;
 * only the host reads it via embed_mmio_read.
 */

#ifndef SAMPLING_CONFIG_H
#define SAMPLING_CONFIG_H

#define CONFIG_MACHINE_NAME   "gr712rc"
#define CONFIG_PERIPH_BASE    0x80000800ull
#define CONFIG_UART_LOG       "/tmp/embed-sampling-gr712rc.uart.log"
#define CONFIG_MODEL_A_FLOOR  "~120-160 us (gr712rc SMP, see docs/11)"

#endif
