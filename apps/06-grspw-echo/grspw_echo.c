/*
 * GRSPW2 (SpaceWire) round-trip demo for GR712RC / RTEMS.
 *
 * Once a second, this app sends a 4-byte big-endian uint32 counter over
 * SpW link 0 (port at 0x80100500) and waits for the external echo peer
 * to reply with the value incremented by one.  Result is printed to the
 * console (UART0) as
 *     sent=N recv=N+1 OK
 *
 * The QEMU GRSPW2 model uses a CharBackend with the chardev id "spw0".
 * Connect an external peer with:
 *
 *   -chardev socket,id=spw0,host=0.0.0.0,port=5101,server=on,wait=off
 *
 * The peer (tools/spw-echo-peer.py) reads framed packets — 4-byte BE
 * length, then payload — increments the trailing uint32, and writes the
 * frame back.
 *
 * Build:
 *   sparc-gaisler-rtems5-gcc -qbsp=gr712rc grspw_echo.c -o grspw_echo.exe
 */

#define CONFIGURE_INIT

#include <rtems.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* ---- RTEMS configuration ------------------------------------------------ */

#define CONFIGURE_APPLICATION_NEEDS_CLOCK_DRIVER
#define CONFIGURE_APPLICATION_NEEDS_CONSOLE_DRIVER
#define CONFIGURE_INIT_TASK_ATTRIBUTES      RTEMS_FLOATING_POINT
#define CONFIGURE_MAXIMUM_TASKS             2
#define CONFIGURE_RTEMS_INIT_TASKS_TABLE
#define CONFIGURE_MICROSECONDS_PER_TICK     10000   /* 10 ms — 100 Hz */

#include <rtems/confdefs.h>

/* ---- GRSPW2 register layout (subset used here) -------------------------- */

#define GRSPW0_BASE 0x80100500u

typedef struct {
    volatile uint32_t ctrl;       /* 0x00 */
    volatile uint32_t status;     /* 0x04 */
    volatile uint32_t nodeaddr;   /* 0x08 */
    volatile uint32_t clkdiv;     /* 0x0c */
    volatile uint32_t destkey;    /* 0x10 */
    volatile uint32_t time;       /* 0x14 */
    volatile uint32_t pad_18;
    volatile uint32_t pad_1c;
    volatile uint32_t dma_ctrl;   /* 0x20 */
    volatile uint32_t dma_rxmax;  /* 0x24 */
    volatile uint32_t dma_txdesc; /* 0x28 */
    volatile uint32_t dma_rxdesc; /* 0x2c */
    volatile uint32_t dma_addr;   /* 0x30 */
} grspw_regs_t;

#define CTRL_LS         (1u << 1)
#define CTRL_AS         (1u << 2)

#define DMACTRL_TE      (1u << 0)
#define DMACTRL_RE      (1u << 1)
#define DMACTRL_PR      (1u << 6)
#define DMACTRL_PS      (1u << 5)

#define TXBD_HLEN_MASK  0xFFu
#define TXBD_EN         (1u << 12)
#define TXBD_WR         (1u << 13)

#define RXBD_LEN_MASK   0x01FFFFFFu
#define RXBD_EN         (1u << 25)
#define RXBD_WR         (1u << 26)
#define RXBD_TR         (1u << 31)

/* ---- Descriptor rings (1 KiB aligned) ---------------------------------- */

typedef struct {
    uint32_t ctrl;
    uint32_t haddr;
    uint32_t dlen;
    uint32_t daddr;
} txbd_t;

typedef struct {
    uint32_t ctrl;
    uint32_t addr;
} rxbd_t;

#define TX_RING_COUNT 4
#define RX_RING_COUNT 4

static txbd_t tx_ring[TX_RING_COUNT] __attribute__((aligned(1024)));
static rxbd_t rx_ring[RX_RING_COUNT] __attribute__((aligned(1024)));

/* RX scratch buffers (one per RX BD).  Size matches the 4-byte payload
 * plus margin so the peer can reply with arbitrary small frames. */
static uint8_t rx_buf[RX_RING_COUNT][64] __attribute__((aligned(4)));

/* Header buffer used by every TX (2 bytes: SpW destination addr +
 * protocol id).  Real SpaceWire frames need at least these two bytes
 * before payload — we leave them as zeros for the loopback demo. */
static uint8_t tx_hdr[2] = { 0xFE, 0x00 };
static uint8_t tx_payload[4];

/* ---- Helpers ----------------------------------------------------------- */

static inline grspw_regs_t *grspw0(void)
{
    return (grspw_regs_t *)GRSPW0_BASE;
}

static void grspw_reset_rings(void)
{
    int i;

    memset(tx_ring, 0, sizeof tx_ring);
    memset(rx_ring, 0, sizeof rx_ring);

    /* Pre-post all RX BDs: enable, point at scratch buffer, last one
     * gets WR so the device wraps back to ring base. */
    for (i = 0; i < RX_RING_COUNT; i++) {
        rx_ring[i].addr = (uint32_t)&rx_buf[i][0];
        rx_ring[i].ctrl = RXBD_EN | (i == RX_RING_COUNT - 1 ? RXBD_WR : 0);
    }
}

static void grspw_init(void)
{
    grspw_regs_t *r = grspw0();

    grspw_reset_rings();

    /* Soft-init: clear sticky status, set link-start (we don't model SpW
     * timing — the QEMU device transitions straight to Run state). */
    r->status   = 0xFFFFFFFFu;
    r->ctrl     = CTRL_LS | CTRL_AS;
    r->clkdiv   = (9 << 0) | (9 << 8);   /* harmless; QEMU ignores */
    r->dma_rxmax = 4096;

    /* Ring base addresses — index field starts at 0. */
    r->dma_txdesc = (uint32_t)&tx_ring[0];
    r->dma_rxdesc = (uint32_t)&rx_ring[0];

    /* Enable RX and TX; clear all sticky bits. */
    r->dma_ctrl = DMACTRL_TE | DMACTRL_RE | DMACTRL_PR | DMACTRL_PS;
}

static void grspw_send_counter(uint32_t counter)
{
    grspw_regs_t *r = grspw0();
    static int    head;
    txbd_t       *bd = &tx_ring[head];

    /* Encode counter big-endian into payload. */
    tx_payload[0] = (counter >> 24) & 0xFF;
    tx_payload[1] = (counter >> 16) & 0xFF;
    tx_payload[2] = (counter >>  8) & 0xFF;
    tx_payload[3] =  counter        & 0xFF;

    bd->haddr = (uint32_t)tx_hdr;
    bd->dlen  = sizeof tx_payload;
    bd->daddr = (uint32_t)tx_payload;
    bd->ctrl  = TXBD_EN | (head == TX_RING_COUNT - 1 ? TXBD_WR : 0) |
                (sizeof tx_hdr & TXBD_HLEN_MASK);

    head = (head + 1) % TX_RING_COUNT;

    /* Re-arm TX (idempotent). */
    r->dma_ctrl |= DMACTRL_TE;
}

/* Poll RX ring for a completed packet.  Returns the BD index, or -1. */
static int grspw_poll_rx(void)
{
    static int tail;
    int        start = tail;

    do {
        rxbd_t *bd = &rx_ring[tail];
        if ((bd->ctrl & RXBD_EN) == 0) {
            int idx = tail;
            tail = (tail + 1) % RX_RING_COUNT;
            return idx;
        }
        tail = (tail + 1) % RX_RING_COUNT;
    } while (tail != start);

    return -1;
}

static uint32_t rxbd_payload_to_uint32_be(int idx)
{
    rxbd_t        *bd  = &rx_ring[idx];
    uint32_t       len = bd->ctrl & RXBD_LEN_MASK;
    const uint8_t *p;

    if (len < 4) {
        return 0;
    }
    /* The peer echoes back exactly the frame we sent: 2-byte SpW header
     * + 4-byte counter.  Last 4 bytes are the value. */
    p = &rx_buf[idx][len - 4];
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] <<  8) |  (uint32_t)p[3];
}

static void rxbd_recycle(int idx)
{
    rx_ring[idx].ctrl = RXBD_EN |
                        (idx == RX_RING_COUNT - 1 ? RXBD_WR : 0);
    grspw0()->dma_ctrl |= DMACTRL_RE;
}

/* ---- RTEMS Init task --------------------------------------------------- */

rtems_task Init(rtems_task_argument arg)
{
    uint32_t counter = 0;

    (void)arg;

    printf("\n*** GR712RC GRSPW2 echo demo ***\n");
    printf("Sending one counter per second on SpW0 (0x%08x).\n",
           (unsigned)GRSPW0_BASE);
    printf("Connect a peer to QEMU's spw0 chardev (default port 5101).\n\n");

    grspw_init();

    /* Quick sanity check: status register link-state field should be Run
     * (5) after we asserted LS|AS in grspw_init(). */
    {
        uint32_t ls = (grspw0()->status >> 21) & 0x7;
        printf("SpW link state: %u (%s)\n",
               (unsigned)ls, ls == 5 ? "Run" : "not Run");
    }

    while (1) {
        int      rx_idx;
        rtems_interval ticks_per_s = rtems_clock_get_ticks_per_second();
        rtems_interval deadline    = rtems_clock_get_ticks_since_boot()
                                     + ticks_per_s;

        grspw_send_counter(counter);

        /* Poll for echo with a 1 s timeout.  The peer should respond
         * within microseconds when present. */
        do {
            rx_idx = grspw_poll_rx();
            if (rx_idx >= 0) {
                uint32_t r = rxbd_payload_to_uint32_be(rx_idx);
                printf("sent=%u recv=%u %s\n",
                       (unsigned)counter, (unsigned)r,
                       r == counter + 1 ? "OK" : "MISMATCH");
                rxbd_recycle(rx_idx);
                break;
            }
            rtems_task_wake_after(1);
        } while (rtems_clock_get_ticks_since_boot() < deadline);

        if (rx_idx < 0) {
            printf("sent=%u recv=- TIMEOUT\n", (unsigned)counter);
        }

        /* Sleep until 1 s after the start of this iteration. */
        {
            rtems_interval now = rtems_clock_get_ticks_since_boot();
            if (now < deadline) {
                rtems_task_wake_after(deadline - now);
            }
        }

        counter++;
    }
}
