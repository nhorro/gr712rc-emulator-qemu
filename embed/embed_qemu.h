/*
 * embed_qemu — minimal consumer-side wrapper around QEMU's embedding
 * entry points, for hosts that link against libqemu-<target>.so.
 *
 * This header has no QEMU includes; it describes only the public
 * API that the wrapper exposes to the host. The host's main() needs
 * only this header plus the .so at link time.
 *
 * Lifecycle:
 *
 *   embed_qemu_init(argc, argv);
 *   for (...) {
 *       EmbedStepStats st;
 *       embed_qemu_step(dt_ns, &st);
 *       if (st.guest_left_running_state) break;
 *   }
 *   embed_qemu_cleanup();
 *
 * Threading: all three calls must be made from the same thread.
 * qemu_init() returns with the iothread mutex held by that thread;
 * embed_qemu_step() runs under it; embed_qemu_cleanup() releases it.
 *
 * Clock: today the step runs against QEMU_CLOCK_REALTIME, no
 * -icount. That is the only mode validated by the granularity
 * sweep in ../NOTES.md.
 */

#ifndef EMBED_QEMU_H
#define EMBED_QEMU_H

#include <stdint.h>

typedef struct EmbedStepStats {
    int64_t requested_dt_ns;
    int64_t actual_wall_ns;
    int64_t actual_virt_ns;
    int     guest_left_running_state;
} EmbedStepStats;

int  embed_qemu_init(int argc, char **argv);
int  embed_qemu_step(int64_t dt_ns, EmbedStepStats *out);
void embed_qemu_cleanup(void);

#endif /* EMBED_QEMU_H */
