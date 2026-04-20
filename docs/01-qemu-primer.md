# QEMU Primer for TSIM / TEMU / GRSIM Users

This document explains QEMU's internal architecture using the mental models
you already have from commercial SPARC emulators.  It focuses on the concepts
you will need to read, extend, and debug this codebase — not QEMU in general.

---

## 1. Execution engine

### What you already know

TSIM and GRSIM are pure **interpreted** emulators: for each target instruction
they decode the opcode, update an in-memory register file and memory model,
then move to the next PC.  The register file is a plain C struct.

TEMU adds a **JIT layer**: hot code paths are compiled to host machine code and
cached.  The resulting "compiled block" is replayed directly on the host CPU
until a branch leaves the block, at which point the dispatcher looks up or
compiles the next block.

### What QEMU does — TCG

QEMU uses a JIT called **TCG** (Tiny Code Generator).  The flow is:

```
Target binary → [Front-end: Disassembler] → TCG IR (target-independent ops)
                                                 ↓
                                         [Back-end: TCG] → Host machine code
                                                 ↓
                                         Execute on host CPU
```

The unit of work is a **Translation Block (TB)**: a linear sequence of target
instructions ending at a branch, trap, or other control-flow change.  Translated
blocks are cached; if the target code is not self-modifying, a block is
translated once and replayed thousands of times.

Key TCG terminology:

| TCG term | Rough analogy |
|----------|--------------|
| `TranslationBlock` (TB) | TEMU's compiled code segment |
| `DisasContext` | Disassembly state while building one TB |
| TCG IR ops (`tcg_gen_*`) | Host-independent "virtual instructions" |
| `TCGv` | Temporary variable in TCG IR |
| Translation cache | TEMU's code cache |

You will encounter this only if you need to fix or extend the CPU instruction
set.  For adding peripherals you can ignore TCG entirely.

### The CPU state struct

All architectural state (registers, PC, PSR, …) lives in `CPUSPARCState`
defined in `target/sparc/cpu.h`.  This is the equivalent of TSIM's internal
register file — a plain C struct that TCG-generated code reads and writes via
memory offsets.

---

## 2. The device model

This is where you will spend most of your time.

### QEMU Object Model (QOM) — the type system

QEMU has its own class system built in C.  If you have used TEMU's plugin
interface you will be familiar with registering a device type and providing
callbacks; QOM formalises this into an explicit class hierarchy.

Every device type is described by a `TypeInfo` struct registered at startup:

```c
static const TypeInfo my_device_info = {
    .name          = "my-device",       /* type name (string) */
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(MyDevice),  /* size of device object */
    .instance_init = my_device_init,    /* constructor — allocates I/O regions */
    .class_init    = my_device_class_init, /* registers reset, realize, props */
};

static void my_device_register_types(void)
{
    type_register_static(&my_device_info);
}

type_init(my_device_register_types)   /* called before main() */
```

The lifecycle of a device object is:

1. `instance_init` — called when `qdev_new("my-device")` is invoked.  Create
   memory regions, initialise GPIO lines.  Do **not** touch other devices here.
2. `realize` (set in `class_init`) — called when `sysbus_realize_and_unref()`
   is called.  Wire up backends (character devices, etc.).  Safe to reference
   other objects.
3. `reset` (set in `class_init`) — called on system reset and at startup.

The convenience macro `OBJECT_DECLARE_SIMPLE_TYPE(MyDevice, MY_DEVICE)` generates
the type-safe cast macro `MY_DEVICE(obj)` used everywhere.

### SysBusDevice — memory-mapped peripherals

Every memory-mapped peripheral inherits from `SysBusDevice`.  Its struct starts
with `SysBusDevice parent_obj` and adds the device-specific fields:

```c
struct MyDevice {
    SysBusDevice parent_obj;   /* must be first */

    MemoryRegion iomem;        /* one region per contiguous register block */
    qemu_irq     irq;          /* one IRq output per interrupt line */

    uint32_t reg_ctrl;         /* device registers */
    uint32_t reg_status;
};
```

This is the same pattern as a TEMU plugin struct with an opaque pointer, except
QEMU's QOM casts let you reach the parent via `SYS_BUS_DEVICE(obj)`.

---

## 3. Memory-mapped I/O — MemoryRegion and MemoryRegionOps

### Registering a register window

In TEMU you call something like:

```c
temu_registerIoReadCallback(base, size, my_read_cb, opaque);
temu_registerIoWriteCallback(base, size, my_write_cb, opaque);
```

In QEMU the equivalent is:

```c
static const MemoryRegionOps my_ops = {
    .read       = my_read,
    .write      = my_write,
    .endianness = DEVICE_NATIVE_ENDIAN,
    .valid = {
        .min_access_size = 4,
        .max_access_size = 4,
    },
};

/* In instance_init: */
memory_region_init_io(&dev->iomem, obj, &my_ops, dev, "my-device", SIZE);
sysbus_init_mmio(SYS_BUS_DEVICE(obj), &dev->iomem);
```

And in the machine init (`gr712rc_hw_init`), after `sysbus_realize_and_unref()`:

```c
sysbus_mmio_map(SYS_BUS_DEVICE(dev), 0, BASE_ADDRESS);
```

The `0` is the index of the MMIO region — a device can have more than one.

### Read and write callbacks

```c
static uint64_t my_read(void *opaque, hwaddr addr, unsigned size)
{
    MyDevice *s = MY_DEVICE(opaque);
    switch (addr) {
    case REG_CTRL:   return s->reg_ctrl;
    case REG_STATUS: return s->reg_status;
    default:         return 0;
    }
}

static void my_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    MyDevice *s = MY_DEVICE(opaque);
    switch (addr) {
    case REG_CTRL:
        s->reg_ctrl = value;
        my_update(s);
        break;
    }
}
```

`addr` is always relative to the base address registered with `sysbus_mmio_map`.
`size` is the access width in bytes (1, 2, or 4).

---

## 4. Interrupts — qemu_irq

### The TEMU analogy

In TEMU you call `temu_setIrq(line, level)` to raise or lower a line.  The
emulator then delivers the interrupt to the CPU model at a safe point.  In QEMU
the equivalent is `qemu_set_irq(irq_handle, level)`.

### Wiring in QEMU

QEMU models interrupt lines as **GPIO signals** (`qemu_irq`).  Each device that
can raise an interrupt declares an output GPIO:

```c
/* In instance_init: */
sysbus_init_irq(SYS_BUS_DEVICE(obj), &dev->irq);
```

The machine init connects it to the interrupt controller's input:

```c
sysbus_connect_irq(SYS_BUS_DEVICE(mydev), 0,
                   qdev_get_gpio_in(irqmp_dev, MY_IRQ_LINE));
```

To raise or clear the line at runtime:

```c
qemu_set_irq(dev->irq, 1);   /* assert */
qemu_set_irq(dev->irq, 0);   /* deassert */
```

The IRQMP model's `grlib_irqmp_set_irq` input callback receives this signal,
sets `state->pending`, and calls `grlib_irqmp_check_irqs` which re-evaluates
each CPU's effective interrupt level and calls `cpu_interrupt()`.

### Named GPIOs

The IRQMP also uses **named** GPIOs (`qdev_init_gpio_out_named`) for the
`"grlib-irq"` lines to each CPU and the `"cpu-start"` lines for secondary CPU
release.  Named GPIOs are the same mechanism as anonymous ones but addressable
by string when wiring in `gr712rc_hw_init`.

---

## 5. Timers and periodic events — QEMUTimer / ptimer

### The TEMU analogy

TEMU lets you schedule a callback at a future simulated time:

```c
temu_scheduleEvent(delay_ns, my_event_callback, opaque);
```

QEMU has two layers:

**QEMUTimer** (low level) — one-shot callback at a virtual clock tick:

```c
QEMUTimer *t = timer_new_ns(QEMU_CLOCK_VIRTUAL, my_callback, opaque);
timer_mod(t, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + delay_ns);
```

**ptimer** (higher level) — periodic countdown timer with configurable period
and frequency.  The GPTIMER device uses `ptimer`:

```c
timer->ptimer = ptimer_init(grlib_gptimer_hit, timer, PTIMER_POLICY_LEGACY);
ptimer_transaction_begin(timer->ptimer);
ptimer_set_freq(timer->ptimer, freq_hz);
ptimer_set_count(timer->ptimer, reload_value);
ptimer_run(timer->ptimer, 0);   /* 0 = periodic */
ptimer_transaction_commit(timer->ptimer);
```

When the counter reaches zero `grlib_gptimer_hit` fires, sets the interrupt
pending flag, and calls `qemu_set_irq`.

For simple event scheduling in a new peripheral, `QEMUTimer` is usually enough.

---

## 6. Big picture: how a bus cycle reaches a device

```
RTEMS writes to 0x80000300 (GPTIMER)
        │
        ▼
TCG-generated store instruction calls QEMU softmmu helper
        │
        ▼
MemoryRegion dispatch (address → region lookup)
        │
        ▼
grlib_gptimer_write(opaque, addr=0x14, value=0xFFFFFFFE, size=4)
        │
        ▼
Timer reload register updated; ptimer reprogrammed
        │
     (time passes in virtual clock)
        │
        ▼
ptimer fires → grlib_gptimer_hit()
        │
        ▼
qemu_set_irq(timer->irq, 1)  ← assert line
        │
        ▼
grlib_irqmp_set_irq() → state->pending |= (1<<8)
        │
        ▼
grlib_irqmp_check_irqs() → qemu_set_irq(irqmp->irq[0], level)
        │
        ▼
leon3_set_pil_in() → cpu_interrupt(cs, CPU_INTERRUPT_HARD)
        │
        ▼
SPARC CPU takes trap → RTEMS interrupt handler
```

This is the same chain you know from TEMU; the names just differ.

---

## 7. Practical differences from TSIM / TEMU

| Concept | TSIM / GRSIM | TEMU | QEMU |
|---------|-------------|------|------|
| Execution | Interpreted | JIT | TCG (JIT) |
| Peripheral registration | Built-in devices only | `temu_registerIo*Callback` | `MemoryRegionOps` + `TypeInfo` |
| Interrupt raising | Internal | `temu_setIrq()` | `qemu_set_irq()` |
| Event scheduling | `tsim_schedule_event` | `temu_scheduleEvent` | `QEMUTimer` / `ptimer` |
| Device object | N/A | opaque pointer | `SysBusDevice` subclass |
| CPU state | Opaque C API | `temu_getCpuState()` | Direct struct `CPUSPARCState` |
| Multi-CPU | No (TSIM) / Yes (TEMU) | Yes | Yes — one `CPUState` per vCPU thread |
| Build system | N/A | CMake plugin | Meson + Kconfig |
