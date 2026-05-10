# GR740 IP Cores — Emulation Status and Strategy

This document tracks every IP core listed in the GR740 datasheet (vendor IDs as
published by Gaisler) along with how it is emulated today and how it could be
emulated to a "good enough for FSW" level.

**Scope reminder.** Our goal is *not* a cycle-accurate hardware model. RTEMS-based
flight software must believe it is running on real hardware: probe Plug & Play,
configure peripherals, take interrupts roughly when expected, and exchange data
with external models over CAN, SpaceWire, MIL-1553, etc. We deliberately do
**not** model cache behaviour, ECC/EDAC, or detailed pipeline timing.

## Summary table

| IP Core | Vendor ID | Description | Current emulation | Difficulty |
|---|---|---|---|---|
| [AHB2AHB](#ahb2ahb-0x020) | 0x020 | AHB-to-AHB bridge | N/A — single flat AHB in QEMU memory map | Low |
| [AHBSTAT](#ahbstat-0x052) | 0x052 | AHB statistics / error capture | N/A | Low |
| [APBCTRL](#apbctrl-0x006) | 0x006 | APB bridge | Implemented (PnP-discoverable) on both machines | **Done** |
| [DSU4](#dsu4-0x049) | 0x049 | Debug Support Unit | N/A — replaced by QEMU GDB stub | Medium |
| [GRPCI2](#grpci2-0x07c) | 0x07C | PCI host controller | N/A | High |
| [GRSPW2](#grspw2-0x029) | 0x029 | SpaceWire link | N/A — issue #10 | High |
| [GRSPWROUTER](#grspwrouter-0x098) | 0x098 | SpaceWire router | N/A | High |
| [FTMCTRL](#ftmctrl-0x048) | 0x048 | PROM / NOR-flash controller | Register stub on GR712RC; absent on GR740 by design | Low |
| [L2CACHE](#l2cache-0x057) | 0x057 | L2 cache controller | Storage-only register stub on GR740 — issue #11 | Medium |
| [L4STAT](#l4stat-0x047) | 0x047 | Performance / event statistics | N/A | Low |
| [GR1553B](#gr1553b-0x04d) | 0x04D | MIL-STD-1553 BC/RT/MT | N/A | High |
| [GRCAN](#grcan-0x03d) | 0x03D | CAN controller | N/A | Medium |
| [IRQ(A)MP](#irqamp-0x00d) | 0x00D | Multiprocessor IRQ controller | Implemented (SMP, MPSTATUS, broadcast); extended-IRQ block missing — issue #12 | **Done** (extended IRQs Low) |
| [APBUART](#apbuart-0x00c) | 0x00C | UART | Implemented (5 on GR712RC, 1 on GR740, TCP backends) | **Done** |
| [MMCCTRL](#mmcctrl-0x05d) | 0x05D | SDRAM/SRAM memory controller | N/A — RAM is plain QEMU RAM | Low |
| [GPTIMER](#gptimer-0x011) | 0x011 | General-purpose timers + watchdog | Implemented on both machines | **Done** |
| [GRCLKGATE](#grclkgate-0x03c) | 0x03C | Clock gating unit | N/A | Low |
| [GRGPIO](#grgpio-0x01a) | 0x01A | GPIO controller | N/A — UI mockup only | Low |
| [GRPGBANK](#grpgbank-0x09e) | 0x09E | Programmable register bank | N/A | Low |
| [GRPREG](#grpreg-0x087) | 0x087 | System registers / chip ID | N/A | Low |
| [GRIOMMU](#griommu-0x04f) | 0x04F | IOMMU | N/A | High (full) / Low (pass-through) |
| [MEMSCRUB](#memscrub-0x02d-or-0x05f) | 0x02D* | Memory scrubber (EDAC) | N/A — issue #13 | Low |
| [SPICONTROL](#spicontrol-0x02d) | 0x02D | SPI master/slave controller | N/A | Medium |
| [LEON4](#leon4-0x01e) | 0x01E | SPARC V8 quad-core CPU | Reusing LEON3 core (same SPARC V8 ISA + ASIs); 4 instances on GR740 | **Done** (with caveats) |

> \* The pasted Gaisler list shows the same vendor ID (0x02D) for MEMSCRUB and
> SPICONTROL. This is almost certainly a transcription artefact — verify
> against the current GRLIB IP database before relying on it for PnP matching.

Difficulty rubric: **Low** = register stub or trivial wiring (hours/day);
**Medium** = real register set + DMA descriptors + a backend (days/week);
**High** = non-trivial protocol/state machine, timing-sensitive, or large
register surface (week+).

---

## AHB2AHB (0x020)

AHB-to-AHB bridge for connecting multiple bus segments, handling transfers and
arbitration.

- **Now.** Not modelled. The GR712RC machine exposes two APB bridges and the
  GR740 machine a single one, but under the hood QEMU sees a single flat
  address space — the bridge is purely a memory-map artefact.
- **Could be.** Add a dummy device that publishes the AHB2AHB PnP entry so any
  FSW probing the bus sees the bridge. Behaviourally there is nothing to
  emulate: transfers already cross "segments" transparently in the QEMU
  memory map.
- **Difficulty: Low.** PnP entry only. No state machine, no IRQs.

## AHBSTAT (0x052)

Statistics module providing monitoring and performance counters for AHB bus
activity.

- **Now.** Not modelled.
- **Could be.** Register stub: status/failing-address/control registers
  return zero unless the FSW writes; trap on configurable accesses is out of
  scope. If FSW polls AHBSTAT for bus-error capture, we can leave it pinned
  at "no error" since emulated AMBA never errors.
- **Difficulty: Low.** A few registers, no real telemetry.

## APBCTRL (0x006)

APB bridge to connect slower peripheral bus devices to the main AHB system.

- **Now.** Implemented. GR712RC has two APB bridges (per GR712RC UG); GR740
  has one (per NGMP map). Each publishes its PnP ROM and RTEMS BSP
  auto-discovers all child peripherals.
- **Could be.** N/A — already done.
- **Difficulty: Done.**

## DSU4 (0x049)

Debug Support Unit for run-control debugging and system inspection.

- **Now.** Not modelled. Debugging is provided through QEMU's built-in GDB
  stub instead, which is fine for development workflows.
- **Could be.** A minimal register stub is enough if any FSW unit-test reads
  DSU control/status. A real DSU model (trace buffer, AHB master access,
  break-on-watchpoint) is large and offers no value over QEMU's GDB stub.
- **Difficulty: Medium.** The register surface is wide; full semantics are
  out of scope but feasibility-stubs are easy.

## GRPCI2 (0x07C)

PCI interface controller for communication with external PCI devices.

- **Now.** Not modelled.
- **Could be.** QEMU has a rich PCI infrastructure that could be wrapped
  behind GRPCI2's register window (PCI command/status, BAR mapping, IRQ
  routing). Useful only if FSW actually drives a PCI device — typically not
  the case in the target avionics workloads.
- **Difficulty: High.** PCI is not optional once started: configuration
  space, MSI, DMA windows. Defer until a concrete FSW need appears.

## GRSPW2 (0x029)

SpaceWire interface core with support for high-speed serial communication.

- **Now.** Not modelled. Tracked as issue #10 (GRSPW2 on GR712RC + GR740).
- **Could be.** Three layers:
  1. Register file (control/status/DMA channel base/etc.).
  2. DMA engine reading TX descriptors and writing RX descriptors against
     guest memory (`address_space_*`).
  3. A backend that exchanges packets with external models. Two reasonable
     choices: a TCP/UDP socket per port (simple, good for test rigs), or a
     [scriptable Lua device](../apps/05-scriptable-stub/) for
     deterministic regression tests. RMAP and time-codes are needed only if
     FSW uses them.
- **Difficulty: High.** DMA descriptor handling plus packet-level semantics
  is the bulk of the work; matches the effort of a small QEMU NIC model.

## GRSPWROUTER (0x098)

SpaceWire router IP supporting routing between multiple SpaceWire links.

- **Now.** Not modelled.
- **Could be.** Only meaningful once GRSPW2 exists. The router itself is
  table-driven (logical/path addressing, port masks). If FSW only configures
  it once at boot, a register stub plus a static routing table read by the
  GRSPW2 backend is enough.
- **Difficulty: High.** Combinatorial port forwarding plus the GRSPW2
  prerequisite. Defer until at least two GRSPW2 endpoints are needed.

## FTMCTRL (0x048)

Flash/ROM memory controller supporting PROM and parallel NOR flash devices.

- **Now.** GR712RC: register stub only — `MCFG1` returns its reset value and
  writes are accepted but ignored. GR740: not present (NGMP replaces it with
  L2C + MEMSCRUB).
- **Could be.** The current stub is sufficient for FSW that only configures
  wait-states. A more complete model would also expose ECC status registers,
  but with no error injection there is nothing for FSW to observe.
- **Difficulty: Low.** Largely done already.

## L2CACHE (0x057)

Level-2 cache controller for improving memory access performance.

- **Now.** Storage-only register stub on GR740 (writes persist, reads return
  what was written; no cache effect). Tracked as issue #11.
- **Could be.** Promote to a behavioural stub: model "enable", "flush", and
  "lock" bits so the FSW state machine progresses correctly, and treat
  flush/invalidate as no-ops since QEMU has no L2 cache to flush. The one
  case to be careful about is DMA-coherency: if FSW relies on a flush before
  a DMA buffer is reused, the no-op is still correct because guest memory
  is always coherent in our model.
- **Difficulty: Medium.** The register set is wide and some bits are
  self-clearing — corner cases, but no real algorithm.

## L4STAT (0x047)

Performance monitoring and statistics module for system events.

- **Now.** Not modelled.
- **Could be.** Stub returning zero or a free-running counter on each event
  register. Real per-event counters (cache misses, branch mispredicts) are
  out of scope and FSW typically only uses L4STAT during bring-up
  benchmarking.
- **Difficulty: Low.** Pure register stub.

## GR1553B (0x04D)

MIL-STD-1553 bus controller / remote terminal interface for avionics
communication.

- **Now.** Not modelled.
- **Could be.** Register file + DMA descriptor processing + a backend that
  pushes/pulls 1553 transfers. The natural backend is a TCP socket or named
  pipe carrying framed messages so an external bus-model can act as the bus
  controller, remote terminal, or monitor counterpart. BC mode is the most
  common FSW use-case; RT and MT add register surface but little extra
  conceptually.
- **Difficulty: High.** Three role-modes (BC/RT/MT), command/status word
  parsing, and message timing. Realistic effort is comparable to GRSPW2.

## GRCAN (0x03D)

CAN bus controller supporting OCCAN/PeliCAN modes.

- **Now.** Not modelled.
- **Could be.** QEMU already ships a CAN bus subsystem (`hw/net/can/`) with
  SocketCAN, ctucan, and KVASER backends. The GRCAN register layout +
  descriptor format would sit on top, translating between the GRCAN DMA
  ring and `qemu_can_frame`. This gives us essentially-free integration
  with host SocketCAN and the existing tooling.
- **Difficulty: Medium.** Bounded: one transmit ring, one receive ring,
  filter registers, plus the register file. The transport piece is already
  there.

## IRQ(A)MP (0x00D)

Interrupt controller supporting multiple interrupt sources and distribution
to LEON cores.

- **Now.** Implemented on both machines via `grlib_irqmp.c`: per-CPU
  mask/force, MPSTATUS for SMP startup, broadcast support, `cpu-start` GPIO
  out. Extended IRQ register block (IRQs 16–31) is the open gap on GR740 and
  is also responsible for the cosmetic `[IRQMP] read unknown` at offset
  0x20 (issue #12).
- **Could be.** Add the extended-IRQ register at offset 0x20 + the
  extended-mask/force/clear/status group; extend the line count from 16 to
  32. No semantic redesign needed.
- **Difficulty: Low** for the extended block. Core controller already
  **Done**.

## APBUART (0x00C)

UART serial communication controller with FIFO buffering and interrupt
support.

- **Now.** Implemented in `grlib_apbuart.c`. GR712RC has 5 instances
  (UART-0 on stdio, UART-1..4 on TCP ports 5001–5004). GR740 has 1 instance
  (UART-0).
- **Could be.** N/A — already done. FIFO depth, baud divisor, modem signals
  are stubbed but FSW does not depend on them.
- **Difficulty: Done.**

## MMCCTRL (0x05D)

Memory controller interface for external memory devices such as SDRAM or
SRAM.

- **Now.** Not modelled. Guest RAM is plain QEMU RAM, mapped at the
  configured base.
- **Could be.** Register stub returning sensible reset values is enough.
  FSW that times memory or programs ECC will not observe real effects but
  also will not see errors.
- **Difficulty: Low.**

## GPTIMER (0x011)

General-purpose timer unit providing multiple timers and watchdog
functionality.

- **Now.** Implemented in `grlib_gptimer.c`. Both machines expose 4 timers,
  IRQs 8–11, with the configured bus clock (50 MHz on GR712RC, 250 MHz on
  GR740).
- **Could be.** The watchdog bit and additional timer blocks (the GR712RC
  also exposes secondary GPTIMER blocks) are gaps if any FSW component
  uses them.
- **Difficulty: Done** (additional timer blocks Low).

## GRCLKGATE (0x03C)

Clock gating unit for power management of IP cores.

- **Now.** Not modelled.
- **Could be.** Pure register stub: accept enable/disable writes, read back
  what was written. There is no power model to drive, and disabling clock
  to a peripheral has no effect on a software-modelled peripheral. If
  realism matters, we can optionally treat the clock gate as a per-device
  "respond / NACK" toggle, but that is rarely worth it.
- **Difficulty: Low.**

## GRGPIO (0x01A)

General-purpose I/O controller with interrupt and configuration support.

- **Now.** Not modelled in QEMU. The adapter UI has a GPIO panel mockup but
  it is not yet wired to a real GRGPIO device.
- **Could be.** Standard pattern: data/direction/interrupt-enable/edge-sense
  registers. Wire output bits to the adapter (so the UI can light up LEDs)
  and accept input bits from the adapter (so the UI can simulate button
  presses). Hooking IRQ generation through IRQMP is straightforward.
- **Difficulty: Low** (Medium if the UI integration is bidirectional and
  needs scripting hooks).

## GRPGBANK (0x09E)

Programmable register bank for system configuration.

- **Now.** Not modelled.
- **Could be.** Generic register file (read/write storage). The block is
  used by FSW only as a scratchpad / configuration latch — no behaviour to
  emulate.
- **Difficulty: Low.**

## GRPREG (0x087)

System registers block providing configuration and identification.

- **Now.** Not modelled.
- **Could be.** Register stub returning fixed identification values that
  match a real GR740 (chip ID, revision). This is the natural place to make
  FSW reliably detect "I am on a GR740 silicon variant X".
- **Difficulty: Low.** The challenge is sourcing the right magic numbers
  from the datasheet, not the implementation.

## GRIOMMU (0x04F)

IOMMU providing memory protection and address translation for bus masters.

- **Now.** Not modelled.
- **Could be.** Two tiers:
  - **Pass-through stub.** Register stub that always reports "translation
    disabled". Good enough if FSW initialises the IOMMU and then expects
    bus masters to issue physical addresses.
  - **Real translation.** Implemented on top of QEMU's `IOMMUMemoryRegion`
    plumbing — TLB-style page table walks for DMA-capable peripherals.
    Only worth the effort if FSW relies on memory-protection isolation
    between bus masters.
- **Difficulty: Low** for pass-through, **High** for real translation.

## MEMSCRUB (0x02D or 0x05F)

Memory scrubber for detecting and correcting single-bit memory errors
(EDAC). Tracked as issue #13.

- **Now.** Not modelled.
- **Could be.** Register stub: configuration / range / status registers
  accept writes and "scrub completed" status bits self-set after a
  configurable delay. Since we do not inject memory errors, the scrubber
  legitimately has nothing to report — that matches the real-hardware
  behaviour on a healthy system.
- **Difficulty: Low.**

## SPICONTROL (0x02D)

SPI bus controller supporting master/slave operation with interrupts and
DMA.

- **Now.** Not modelled.
- **Could be.** Register file + a transmit/receive shift-register model.
  The backend is most naturally a [scriptable Lua device](../apps/05-scriptable-stub/)
  that responds to per-byte transfers — this matches typical SPI peripherals
  (sensors, EEPROM) where each chip has its own protocol on top of raw SPI.
- **Difficulty: Medium.** The SPI core itself is bounded; the per-slave
  protocols are user-supplied via Lua scripts.

## LEON4 (0x01E)

Quad-core SPARC V8 processor, supporting SMP operation with RTEMS and other
RTOS.

- **Now.** Reusing the LEON3 CPU model (`leon3-cpu`) for all four cores on
  the GR740 machine — LEON4 and LEON3 share the SPARC V8 ISA and the same
  set of LEON-specific ASIs, so RTEMS BSPs and the GCC `-mcpu=leon3` /
  `-mcpu=leon4` outputs run interchangeably for our purposes. Per-CPU
  `%asr17` returns the correct CPU index and CPU0 boots while CPUs 1–3 are
  released through IRQMP MPSTATUS.
- **Could be.** Real LEON4-only differences are micro-architectural (cache
  hierarchy, pipeline width, branch prediction) and do not matter here.
  The drift risks for FSW are: code that probes CPU revision through
  `%asr17` low bits, code that depends on LEON4-specific ASI ranges, and
  any benchmark that measures cycles. None of those is currently observed.
- **Difficulty: Done** for the functional CPU. A native LEON4 CPU class is
  not on the roadmap.
