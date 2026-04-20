# Adding a GRLIB APB Peripheral

This guide walks through adding a new memory-mapped peripheral to the GR712RC
machine, using a minimal **OCCAN** (CAN controller) stub as the running example.
The same pattern applies to any GRLIB APB device: GRSPW2, GRCAN, GRTC, GRTM,
additional UARTs, etc.

The approach mirrors what you would do in a TEMU plugin: define a register set,
provide read/write callbacks, and optionally schedule timer events or raise IRQs.
The additional step in QEMU is fitting the device into the QOM type system.

---

## Overview of steps

1. Create `hw/can/grlib_occan.c`
2. Add it to `hw/can/meson.build`
3. Declare the APB address and IRQ in `include/hw/sparc/gr712rc.h`
4. Instantiate and wire it in `hw/sparc/gr712rc.c`

No changes to `Kconfig` or `default.mak` are needed — the device will be gated
on `CONFIG_GRLIB` which is already selected by `CONFIG_GR712RC`.

---

## Step 1 — Create the device source file

Create `qemu/hw/can/grlib_occan.c`.  The skeleton below implements a minimal
stub: registers can be read and written, and a single IRQ line is declared.
Extend the `_write` handler to add real behaviour.

```c
#include "qemu/osdep.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "qemu/module.h"
#include "qom/object.h"

/* ---- Register offsets (OCCAN APB register map) ---- */
#define OCCAN_MODE_OFFSET    0x00
#define OCCAN_CMD_OFFSET     0x01
#define OCCAN_STATUS_OFFSET  0x02
#define OCCAN_INT_OFFSET     0x03
/* ... add more as needed ... */
#define OCCAN_REG_SIZE       128

#define TYPE_GRLIB_OCCAN "grlib-occan"
OBJECT_DECLARE_SIMPLE_TYPE(GRLIB_OCCAN, GRLIB_OCCAN)

/* ---- Device object ---- */
struct GRLIB_OCCAN {
    SysBusDevice parent_obj;

    MemoryRegion iomem;
    qemu_irq     irq;

    /* Mirror of the OCCAN register file */
    uint8_t regs[OCCAN_REG_SIZE];
};

/* ---- I/O callbacks ---- */

static uint64_t grlib_occan_read(void *opaque, hwaddr addr, unsigned size)
{
    GRLIB_OCCAN *s = GRLIB_OCCAN(opaque);

    if (addr < OCCAN_REG_SIZE) {
        return s->regs[addr];
    }
    return 0;
}

static void grlib_occan_write(void *opaque, hwaddr addr,
                              uint64_t value, unsigned size)
{
    GRLIB_OCCAN *s = GRLIB_OCCAN(opaque);

    if (addr >= OCCAN_REG_SIZE) {
        return;
    }
    s->regs[addr] = (uint8_t)value;

    /*
     * TODO: react to register writes here — e.g., start a transmission,
     * raise an IRQ, schedule a timer event.
     *
     * To raise the interrupt line:
     *     qemu_set_irq(s->irq, 1);
     * To clear it:
     *     qemu_set_irq(s->irq, 0);
     */
}

static const MemoryRegionOps grlib_occan_ops = {
    .read       = grlib_occan_read,
    .write      = grlib_occan_write,
    .endianness = DEVICE_BIG_ENDIAN,   /* SPARC bus is big-endian */
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

/* ---- Lifecycle ---- */

static void grlib_occan_reset(DeviceState *d)
{
    GRLIB_OCCAN *s = GRLIB_OCCAN(d);
    memset(s->regs, 0, sizeof(s->regs));
    /* OCCAN status register has "bus-off" and "transmit buffer free" set at reset */
    s->regs[OCCAN_STATUS_OFFSET] = 0x0C;
}

static void grlib_occan_init(Object *obj)
{
    GRLIB_OCCAN  *s   = GRLIB_OCCAN(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    memory_region_init_io(&s->iomem, obj, &grlib_occan_ops, s,
                          "grlib-occan", OCCAN_REG_SIZE);
    sysbus_init_mmio(sbd, &s->iomem);
    sysbus_init_irq(sbd, &s->irq);
}

/* ---- Type registration ---- */

static void grlib_occan_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    dc->reset = grlib_occan_reset;
}

static const TypeInfo grlib_occan_info = {
    .name          = TYPE_GRLIB_OCCAN,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(GRLIB_OCCAN),
    .instance_init = grlib_occan_init,
    .class_init    = grlib_occan_class_init,
};

static void grlib_occan_register_types(void)
{
    type_register_static(&grlib_occan_info);
}

type_init(grlib_occan_register_types)
```

### Key decisions in this skeleton

- **Endianness**: `DEVICE_BIG_ENDIAN` is correct for SPARC APB devices.  The
  APBUART and GPTIMER use `DEVICE_NATIVE_ENDIAN` but that works only because
  QEMU is running on a little-endian host and those drivers happen to be tested
  there.  `DEVICE_BIG_ENDIAN` is safer for a new device.
- **Access size**: OCCAN registers are byte-wide.  Setting `min_access_size = 1`
  allows byte reads/writes; RTEMS BSP drivers for OCCAN use byte accesses.
- **IRQ**: a single `sysbus_init_irq` call allocates one line.  For multiple
  lines (e.g., GRSPW has separate TX/RX IRQs) call it multiple times.

---

## Step 2 — Add to the build system

Open `qemu/hw/can/meson.build` (create it if it does not exist) and add:

```meson
system_ss.add(when: 'CONFIG_GRLIB', if_true: files('grlib_occan.c'))
```

If the `hw/can/` subdirectory is new, also add it to `qemu/hw/meson.build`:

```meson
subdir('can')
```

---

## Step 3 — Declare the address and IRQ

In `qemu/include/hw/sparc/gr712rc.h`, add:

```c
/* OCCAN-0 */
#define GR712RC_OCCAN0_BASE   0x80000400
#define GR712RC_OCCAN0_IRQ    11   /* check GR712RC UG for the real assignment */
```

For devices on APB bridge 2 (0x80100000) use that base instead.

---

## Step 4 — Instantiate and wire in gr712rc_hw_init

In `qemu/hw/sparc/gr712rc.c`, inside `gr712rc_hw_init`:

```c
/* OCCAN-0 */
dev = qdev_new(TYPE_GRLIB_OCCAN);
sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
sysbus_mmio_map(SYS_BUS_DEVICE(dev), 0, GR712RC_OCCAN0_BASE);
sysbus_connect_irq(SYS_BUS_DEVICE(dev), 0,
                   qdev_get_gpio_in(irqmpdev, GR712RC_OCCAN0_IRQ));
```

And add an APB Plug&Play entry so the RTEMS BSP auto-discovery finds it:

```c
grlib_apb_pnp_add_entry(apb_pnp1, GR712RC_OCCAN0_BASE, 0xFFF,
                        GRLIB_VENDOR_GAISLER, GRLIB_OCCAN_DEV,
                        1, GR712RC_OCCAN0_IRQ, GRLIB_APBIO_AREA);
```

The `GRLIB_OCCAN_DEV` vendor/device ID constant should be added to
`include/hw/misc/grlib_ahb_apb_pnp.h` (or check what value the RTEMS PnP
scanner expects from the GR712RC User's Guide).

---

## Adding a timer-driven device (e.g., GRSPW2 link state machine)

If the device needs to generate events at a rate independent of register writes
(e.g., to simulate a SpaceWire link coming up after a delay, or periodic DMA
completion), use `QEMUTimer`:

```c
#include "qemu/timer.h"

struct GRLIB_GRSPW {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    qemu_irq     irq;
    QEMUTimer   *link_timer;
    /* ... registers ... */
};

static void grspw_link_event(void *opaque)
{
    GRLIB_GRSPW *s = opaque;
    /* Simulate link-up: set status bit and raise IRQ */
    s->status |= GRSPW_STATUS_LS_RUN;
    qemu_set_irq(s->irq, 1);
}

/* In _write, when software starts the link: */
static void grspw_start_link(GRLIB_GRSPW *s)
{
    /* Fire "link up" event 1 ms of virtual time from now */
    timer_mod(s->link_timer,
              qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + 1000000LL);
}

/* In _init: */
s->link_timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, grspw_link_event, s);
```

`QEMU_CLOCK_VIRTUAL` advances with the simulated CPU — it does not use wall
time, so the callback fires at the right simulated moment regardless of host
speed.

---

## Checklist

- [ ] Device `.c` file created under `hw/<subsystem>/`
- [ ] Added to `hw/<subsystem>/meson.build` under `CONFIG_GRLIB`
- [ ] If new subsystem: `subdir('<subsystem>')` added to `hw/meson.build`
- [ ] Base address and IRQ defined in `gr712rc.h`
- [ ] Device instantiated in `gr712rc_hw_init`
- [ ] `sysbus_mmio_map` called with the correct base address
- [ ] `sysbus_connect_irq` wires the IRQ to IRQMP
- [ ] APB PnP entry added with correct vendor/device IDs
- [ ] Rebuild: `make -j$(nproc)` in `qemu/build/`
- [ ] Boot RTEMS and check PnP scan finds the new device
