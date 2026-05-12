/*
 * GRSPW2 (SpaceWire) round-trip demo for GR740 / RTEMS.
 *
 * Mirror of apps/06-grspw-echo, but built for -M gr740 and pointing at
 * the GR740 SpW0 register window (0xFF901000).
 *
 * Once a second, sends a 4-byte big-endian uint32 counter over SpW link
 * 0 and waits for the external Python peer (tools/spw-echo-peer.py) to
 * reply with the value incremented by one.  Result is printed to UART0:
 *
 *     sent=N recv=N+1 OK
 *
 * Run:
 *     # terminal A
 *     make run
 *     # terminal B
 *     make peer
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

#define GRSPW0_BASE 0xFF901000u   /* GR740: 8 ports at 0xFF901000..0xFF908000 */

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

/* ---- Descriptor rings (1 KiB aligned) ----------------------------------
 *
 * Volatile fields: the GRSPW2 device writes ctrl/len bits via DMA on RX
 * completion, so without `volatile` the compiler can hoist the load out
 * of the poll loop and miss the device's updates.  Bit me on GR740 where
 * -O2 + the BSP's call-graph led GCC to cache rx_ring[i].ctrl across
 * iterations of the polling loop.
 */

typedef struct {
    volatile uint32_t ctrl;
    volatile uint32_t haddr;
    volatile uint32_t dlen;
    volatile uint32_t daddr;
} txbd_t;

typedef struct {
    volatile uint32_t ctrl;
    volatile uint32_t addr;
} rxbd_t;

#define TX_RING_COUNT 4
#define RX_RING_COUNT 32

static txbd_t tx_ring[TX_RING_COUNT] __attribute__((aligned(1024)));
static rxbd_t rx_ring[RX_RING_COUNT] __attribute__((aligned(1024)));
static uint8_t rx_buf[RX_RING_COUNT][64] __attribute__((aligned(4)));

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

    for (i = 0; i < RX_RING_COUNT; i++) {
        rx_ring[i].addr = (uint32_t)&rx_buf[i][0];
        rx_ring[i].ctrl = RXBD_EN | (i == RX_RING_COUNT - 1 ? RXBD_WR : 0);
    }
}

static void grspw_init(void)
{
    grspw_regs_t *r = grspw0();

    grspw_reset_rings();

    r->status     = 0xFFFFFFFFu;
    r->ctrl       = CTRL_LS | CTRL_AS;
    r->clkdiv     = (9 << 0) | (9 << 8);
    r->dma_rxmax  = 4096;
    r->dma_txdesc = (uint32_t)&tx_ring[0];
    r->dma_rxdesc = (uint32_t)&rx_ring[0];
    r->dma_ctrl   = DMACTRL_TE | DMACTRL_RE | DMACTRL_PR | DMACTRL_PS;
}

static void grspw_send_counter(uint32_t counter)
{
    grspw_regs_t *r = grspw0();
    static int    head;
    txbd_t       *bd = &tx_ring[head];

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
    r->dma_ctrl |= DMACTRL_TE;
}

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

    printf("\n*** GR740 GRSPW2 echo demo ***\n");
    printf("Sending one counter per second on SpW0 (0x%08x).\n",
           (unsigned)GRSPW0_BASE);
    printf("Connect a peer to QEMU's spw0 chardev (default port 5101).\n\n");

    grspw_init();

    {
        uint32_t ls = (grspw0()->status >> 21) & 0x7;
        printf("SpW link state: %u (%s)\n",
               (unsigned)ls, ls == 5 ? "Run" : "not Run");
    }

    while (1) {
        int rx_idx;
        int drained = 0;
        rtems_interval tps = rtems_clock_get_ticks_per_second();

        grspw_send_counter(counter);
        rtems_task_wake_after(tps);

        /* Drain every BD that completed during the sleep window.  Each
         * received echo prints its own line; counter/recv pairing isn't
         * strict if QEMU's main loop delivers echoes in bursts. */
        while ((rx_idx = grspw_poll_rx()) >= 0) {
            uint32_t r = rxbd_payload_to_uint32_be(rx_idx);
            printf("sent=%u recv=%u %s\n",
                   (unsigned)counter, (unsigned)r,
                   r == counter + 1 ? "OK" : "(out of order)");
            rxbd_recycle(rx_idx);
            drained++;
        }
        if (drained == 0) {
            printf("sent=%u recv=- TIMEOUT\n", (unsigned)counter);
        }

        counter++;
    }
}
