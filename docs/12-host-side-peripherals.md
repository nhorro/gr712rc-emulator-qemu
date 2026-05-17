# Host-side peripherals via the SDK

This guide is the parallel of [Adding a GRLIB APB peripheral](03-adding-a-peripheral.md)
for embedders. Instead of writing a QOM device inside `qemu/hw/...` and
rebuilding the emulator, you write the peripheral as **plain host code**
in your own program, register it at runtime via `embed_register_peripheral()`,
and never touch QEMU sources.

The same machine binary works for both paths — they coexist on the same
`address_space_memory`. Real GRLIB peripherals respond as before; your
host-side peripheral appears as an additional `MemoryRegion` overlaid on
the bus.

When to use which path:

| Use the native path ([docs/03](03-adding-a-peripheral.md)) when... | Use this SDK path when... |
| --- | --- |
| The peripheral is reusable across projects | The peripheral is project-specific |
| You want it upstreamed eventually | You iterate on the model frequently |
| It needs save/restore (`savevm`/`loadvm`) | The host orchestrates the simulation lifecycle anyway |
| It has complex dependencies (DMA, bus mastering) | The model is plain MMIO + IRQ |
| It must work inside `qemu-system-sparc` standalone | The host provides resources the model needs (sockets, files, host threads) |

For the lifecycle and threading model of the SDK itself, see
[Embedding as library](11-embedding-as-library.md).

---

## SDK surface for peripherals

Five entry points, all declared in [`qemu/include/libqemu.h`](../qemu/include/libqemu.h):

```c
/* Register an MMIO region + optional PnP entry. PRELAUNCH only. */
void embed_register_peripheral(uint64_t base, uint64_t size,
                               const EmbedPeripheralOps *ops,
                               void *opaque);

/* Drive a bus transaction from the host (no guest CPU involved). */
void     embed_mmio_write(uint64_t addr, unsigned size, uint64_t value);
uint64_t embed_mmio_read (uint64_t addr, unsigned size);

/* Drive an IRQMP input line. Same line numbers as PnP irq. */
void embed_irq_raise(unsigned line);
void embed_irq_lower(unsigned line);
void embed_irq_pulse(unsigned line);

/* Big QEMU Lock for host worker threads. */
void embed_bql_lock  (void);
void embed_bql_unlock(void);
```

The `EmbedPeripheralOps` struct collects the callbacks plus optional PnP
metadata:

```c
typedef struct {
    EmbedMmioReadFn  read;      /* may be NULL  */
    EmbedMmioWriteFn write;     /* may be NULL  */
    EmbedEndian      endian;    /* default BIG  */
    unsigned         min_access;
    unsigned         max_access;

    /* If pnp_vendor != 0, also add an APB PnP entry so the RTEMS BSP's
     * driver-manager scan discovers the device at boot. */
    uint8_t  pnp_vendor;
    uint16_t pnp_device;
    uint8_t  pnp_version;
    uint8_t  pnp_irq;
    uint16_t pnp_mask;
} EmbedPeripheralOps;
```

Both machines (`gr712rc` and `gr740`) auto-register their APB bridges and
IRQMP with the SDK during machine init; the host code is the same shape on
either target.

---

## Minimal example — counters peripheral

A 16-byte peripheral at `0x80000800` (GR712RC) that counts reads and writes.

```c
#include <libqemu.h>
#include "embed_qemu.h"   /* the example wrapper around qemu_init/step/cleanup */

#define BASE 0x80000800ull
#define SIZE 0x10u

static unsigned g_reads, g_writes;

static uint64_t my_read(void *opaque, uint64_t off, unsigned size) {
    (void)opaque; (void)off; (void)size;
    return ++g_reads;
}
static void my_write(void *opaque, uint64_t off, uint64_t val, unsigned size) {
    (void)opaque; (void)off; (void)val; (void)size;
    g_writes++;
}

int main(int argc, char **argv) {
    char *qargv[] = { argv[0], "-M", "gr712rc", "-display", "none",
                      "-kernel", argv[1], NULL };
    embed_qemu_init(7, qargv);

    EmbedPeripheralOps ops = {
        .read = my_read, .write = my_write,
        .endian = EMBED_ENDIAN_BIG,
    };
    embed_register_peripheral(BASE, SIZE, &ops, NULL);

    /* Run for 1 second of guest time. */
    EmbedStepStats st;
    embed_qemu_step(1000000000LL, &st);

    printf("After step: %u reads, %u writes\n", g_reads, g_writes);
    embed_qemu_cleanup();
    return 0;
}
```

A guest doing `*(volatile uint32_t*)0x80000800 = 42;` will land in
`my_write` synchronously. Reading the same address gets the current
counter value back, byte-swapped according to the endian setting.

---

## Lifecycle constraints

| Function | When callable | Thread |
| --- | --- | --- |
| `embed_register_peripheral` | After `qemu_init()`, before `vm_start()` (state = `PRELAUNCH`). Asserts otherwise. | BQL-holding thread |
| `embed_mmio_write` / `_read` | Any time after `qemu_init()`. | BQL-holding thread |
| `embed_irq_raise` / `_lower` / `_pulse` | After machine init has registered an IRQMP (always true post-`qemu_init`). | BQL-holding thread (often the callback itself) |
| `embed_bql_lock` / `_unlock` | Any time after `qemu_init()`. | Any host thread |

In practice the embedding wrapper (`embed/embed_qemu.c`) holds the BQL
continuously between `embed_qemu_init()` and `embed_qemu_cleanup()`,
including across `embed_qemu_step()` calls. Code running on that thread
satisfies the BQL requirement automatically.

---

## Three ways to drive traffic to your peripheral

Once registered, three independent paths reach the same `read`/`write`
callbacks. The peripheral does not know which.

### 1. Guest CPU MMIO

The classical case. RTEMS does `*(volatile uint32_t*)BASE = X`. The store
instruction dispatches through QEMU's `address_space_write`, hits the
`MemoryRegion` we installed, and your `write` callback runs synchronously
in the CPU thread (under BQL).

### 2. HMP monitor `xp`

Manual inspection from the QEMU monitor:

```
(qemu) xp /4xw 0x80000800
```

Reads through `address_space_read` — same dispatch path, your `read`
callback fires four times. Useful for debugging.

> HMP in QEMU 8.2.2 has no write-physical-memory command (`xp` reads only,
> `o` is x86 PIO, not the memory bus). For host-driven writes use
> `embed_mmio_write` instead.

### 3. Host-injected via `embed_mmio_write` / `_read`

```c
embed_mmio_write(BASE, 4, 0xdeadbeef);          /* fires write callback */
uint64_t v = embed_mmio_read(BASE + 4, 4);      /* fires read callback */
```

Same `address_space_write/read` path. Useful for host-side regression
tests that want to assert "given input X to the peripheral, the
peripheral responds with Y" without orchestrating a kernel.

---

## Raising interrupts

Two ways to declare the IRQ line; pick one or both:

1. **`pnp_irq` in `EmbedPeripheralOps`** — the IRQ number is published in
   the APB PnP ROM so a driver-manager-aware RTEMS app discovers it
   automatically. Useful when the guest app does `drvmgr_dev_init` and
   expects to find drivers by PnP scan.

2. **Hardcoded line number in the host** — the host always knows the
   IRQ line it intends to drive (`#define IRQ_LINE 7`), regardless of
   whether the guest uses PnP or `rtems_interrupt_handler_install(7, ...)`
   directly.

To fire an IRQ from a host callback:

```c
static void my_write(void *opaque, uint64_t off, uint64_t val, unsigned sz) {
    /* ...update internal state... */
    if (some_condition) {
        embed_irq_pulse(7);   /* IRQ 7 -> IRQMP -> CPU trap 0x17 */
    }
}
```

The callback runs on the iothread under the BQL, so the call is safe
without extra locking. After the callback returns, the guest CPU's
TCG execution checks pending interrupts at the next instruction
boundary and dispatches to the trap handler — typically within
microseconds of wall time.

`raise` / `lower` keep the line at level 1 or 0 (for level-triggered
delivery). `pulse` is `raise; lower` in one call — appropriate for
edge-triggered interrupts where the IRQMP only needs to see the
rising edge to latch the pending bit.

### IRQ line allocations

Lines used by real peripherals (treat as reserved):

| Line | GR712RC | GR740 |
| --- | --- | --- |
| 2 | UART0 | UART0 |
| 3–6 | UART1–4 | _free_ |
| 7 | _free_ | _free_ |
| 8–11 | GPTIMER 0–3 | GPTIMER 0–3 |
| 12 | EIRQ (extended IRQ) | EIRQ |
| 22–27 | GRSPW 0–5 | GRSPW 0–5 (+ more) |

Line 7 is the canonical "test IRQ" — free in both machines.

---

## Calling QEMU from a host worker thread

The most common pattern in this category: a host thread is waiting on a
socket / hardware event, and when it fires you want to deliver it as an
IRQ to the guest. The thread does not own the BQL — it is a regular
pthread — so it needs to acquire it before touching QEMU state.

```c
/* Worker thread (NOT the iothread): */
static void *socket_reader(void *arg) {
    for (;;) {
        uint8_t buf[64];
        ssize_t n = recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) break;

        /* Hand off to QEMU under the BQL. */
        embed_bql_lock();
        enqueue_into_peripheral_fifo(buf, n);   /* update host-side state */
        embed_irq_raise(MY_IRQ_LINE);           /* notify guest */
        embed_bql_unlock();
    }
    return NULL;
}
```

The BQL is re-entrant from the same thread, so even if your host code
ends up calling `embed_bql_lock` recursively via library code, the
counts balance and the lock releases correctly on the matching
`embed_bql_unlock` count.

---

## Worked example — the `peripheral-test` suite

`embed/examples/peripheral-test/` is a 9-assertion test harness that
exercises every entry point of the SDK against both machines.

```bash
make -C embed/examples/peripheral-test                # build both binaries
make -C embed/examples/peripheral-test run-gr712rc    # 9/9 on GR712RC
make -C embed/examples/peripheral-test run-gr740      # 9/9 on GR740
```

The structure (one `main.c`, two binaries via `-DCONFIG_HEADER=...`):

```
embed/examples/peripheral-test/
├── main.c                  # machine-agnostic test logic
├── config_gr712rc.h        # base 0x80000800, IRQ 7, has diag catch-all
├── config_gr740.h          # base 0xff900800, IRQ 7, no diag catch-all
└── Makefile                # run-gr712rc / run-gr740 targets
```

The kernels it drives are paired across machines:

| Kernel | Path | Behavior |
| --- | --- | --- |
| `mmio_probe.exe` | `apps/10-mmio-probe/` | 4 writes + 4 reads, exit |
| `mmio_probe.exe` | `apps/11-mmio-probe-gr740/` | Same, gr740 base |
| `mmio_irq_probe.exe` | `apps/12-mmio-irq-probe/` | The above + IRQ handshake |
| `mmio_irq_probe.exe` | `apps/13-mmio-irq-probe-gr740/` | Same, gr740 base |

### The 9 tests

| # | What it asserts | How |
| --- | --- | --- |
| 5 | `info mtree` shows the registered region | HMP monitor |
| 2 | `xp /4xw <base>` invokes `fake_read` four times | HMP monitor |
| 2b | `xp` at an outside address does NOT invoke the callback | HMP monitor |
| 4 | `embed_mmio_write` fires the write callback with the exact value | SDK direct |
| 4b | `embed_mmio_read` fires the read callback and returns the expected value | SDK direct |
| 6 | After `embed_qemu_step`, guest writes ≥4 (the 4w pattern) | Guest CPU |
| 6b | After `embed_qemu_step`, guest reads ≥4 (the 4r pattern) | Guest CPU |
| 7 | Host pulsed IRQ ≥1 times (saw the trigger marker) | Host detection |
| 7b | Guest ISR ran ≥1 times (saw the ISR marker) | Host detection |

### The IRQ handshake protocol (TEST #7)

The kernel does the standard 4w+4r pattern, then writes a magic
"trigger" value `0xA1A1A1A1` to a specific offset. The host's
`fake_write` callback recognizes the value and pulses the IRQ. The
guest's installed ISR writes back `0xB2B2B2B2` to a different offset,
which the host then observes through `fake_write`.

```
guest CPU                            host (callback)
---------                            ---------------
write 0xA1A1A1A1 @ +0x10  -------->  see 0xA1A1A1A1 -> embed_irq_pulse(7)
                                     [IRQMP latches pending bit]
                  (next inst)
trap 0x17 (IRQ 7) -> ISR
   write 0xB2B2B2B2 @ +0x14 ----->   see 0xB2B2B2B2 -> count ISR fired
   ack IRQ, return
```

This is the strongest validation of the IRQ subsystem: the host
counters prove that the round trip closed, the guest UART log prints
"ISR fired" as independent textual confirmation.

---

## How the SDK finds the machine's IRQMP and APB PnP

The SDK is target-agnostic. It does not hardcode where the IRQMP or APB
PnP devices live. Instead, each machine pushes its instance pointers
into a small in-memory table at the end of `<machine>_hw_init`:

```c
/* in hw/sparc/gr712rc.c, after creating apb_pnp1, apb_pnp2, irqmpdev: */
embed_internal_register_apb_pnp(apb_pnp1, GR712RC_APB1_BASE, GR712RC_APB1_SIZE);
embed_internal_register_apb_pnp(apb_pnp2, GR712RC_APB2_BASE, GR712RC_APB2_SIZE);
embed_internal_register_irqmp (irqmpdev);

/* in hw/sparc/gr740.c, after the same instances: */
embed_internal_register_apb_pnp(apb_pnp, GR740_APB_BASE, GR740_APB_SIZE);
embed_internal_register_irqmp (irqmpdev);
```

`embed_internal_register_apb_pnp` is in
`qemu/include/sysemu/embed_machine_hooks.h` (internal to the .so build;
not exposed to consumers). When `embed_register_peripheral(base, ...)`
runs and the caller set a `pnp_vendor`, the SDK looks up the table for
the bridge whose `[base, base+size)` window contains `base`, and calls
`grlib_apb_pnp_add_entry` on it.

If a machine forgets to call `embed_internal_register_apb_pnp` or
`_register_irqmp`, the corresponding SDK functions assert at first use.

---

## What this SDK does NOT do

| Feature | Status | Workaround |
| --- | --- | --- |
| `savevm`/`loadvm` persistence | Out of scope | None — peripheral state must live in the host process |
| Output IRQ pins from the peripheral (peripheral as IRQ source via QOM connect) | Use `embed_irq_raise/_lower/_pulse` instead | Same effect, different mechanism |
| Multiple `MemoryRegion`s per peripheral | Use one region per call | Register each region separately |
| AHB bus peripherals | Not exposed yet | The peripheral lands on `address_space_memory` regardless of bus name |
| Removing a peripheral at runtime | No `embed_unregister_peripheral` | Tear down via `qemu_cleanup` |

---

## Files of interest

```
qemu/include/libqemu.h                       # public API (consumers' SDK)
qemu/include/sysemu/embed_api.h              # internal mirror, with QEMU types
qemu/include/sysemu/embed_machine_hooks.h    # machine-side registration API
qemu/system/embed_api.c                      # implementation (~250 LOC)
qemu/system/embed_api.map                    # linker version script (symbol allowlist)
qemu/hw/sparc/gr712rc.c                      # calls embed_internal_register_*
qemu/hw/sparc/gr740.c                        # calls embed_internal_register_*

embed/embed_qemu.{h,c}                       # convenience wrapper (init/step/cleanup)
embed/examples/peripheral-test/              # the 9-test suite
embed/examples/qemu-service/                 # drop-in replacement for
                                             # qemu-system-sparc, used by
                                             # the FastAPI service via
                                             # QEMU_BINARY=qemu-system-sparc-embed
apps/10-mmio-probe/                          # gr712rc kernel: 4w + 4r
apps/11-mmio-probe-gr740/                    # gr740 kernel: 4w + 4r
apps/12-mmio-irq-probe/                      # gr712rc kernel: above + IRQ handshake
apps/13-mmio-irq-probe-gr740/                # gr740 kernel: above + IRQ handshake
```

## Driving the UI with the embedded backend

The FastAPI service + React UI (see [docs/08](08-running-the-service.md))
defaults to spawning `qemu-system-sparc` as a subprocess. With one env
var, you can swap that for `qemu-system-sparc-embed` — same image, same
UI, but the emulator now runs in-process and exposes a host-info
peripheral as proof. See the
[Switching the emulator backend](08-running-the-service.md#switching-the-emulator-backend-standalone--embedded-sdk)
section there for the walkthrough.
