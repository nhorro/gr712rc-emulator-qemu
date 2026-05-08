/* global React, useStore, api, MACHINES, Icon */
const { useState, useMemo } = React;

// ── SoC topology data ────────────────────────────────────
// Block-diagram nodes laid out on a manually-tuned grid.
// kind: cpu | bridge | mem | periph | iface | bus
const TOPOLOGY = {
  gr740: {
    label: "GR740 — Quad-core LEON4FT NGMP",
    busColor: { proc: "#e0a64c", ahb_s: "#3aa5c7", ahb_m: "#c66c8e", apb: "#7da7d9" },
    irqBase: "0xFF904000",
    cpus: [
      { id: "cpu0", label: "LEON4 #0", x: 270, y: 38 },
      { id: "cpu1", label: "LEON4 #1", x: 360, y: 38 },
      { id: "cpu2", label: "LEON4 #2", x: 450, y: 38 },
      { id: "cpu3", label: "LEON4 #3", x: 540, y: 38 },
    ],
    blocks: [
      { id: "irqamp",  label: "IRQ(A)MP",      kind: "periph",  x: 184, y: 38, w: 70, h: 38 },
      { id: "stat",    label: "STAT-UNIT",     kind: "periph",  x: 184, y: 84, w: 70, h: 24 },
      { id: "fpu",     label: "FPU",           kind: "periph",  x: 270, y: 88, w: 80, h: 24 },
      { id: "scrub",   label: "Memory Scrubber", kind: "periph", x: 80, y: 116, w: 96, h: 28 },
      { id: "l2",      label: "L2 Cache",      kind: "mem",     x: 200, y: 116, w: 96, h: 28 },
      { id: "ahbmx",   label: "AHB / AHB Bridges", kind: "bridge", x: 320, y: 116, w: 124, h: 28 },
      { id: "dsu",     label: "DSU4",          kind: "periph",  x: 460, y: 88, w: 70, h: 24 },
      { id: "dbgbr",   label: "Debug Bridge",  kind: "bridge",  x: 460, y: 116, w: 90, h: 28 },
      { id: "rmap",    label: "AHB/APB Bridge",kind: "bridge",  x: 560, y: 116, w: 96, h: 28 },
      { id: "spwrmap", label: "SpW RMAP DCL",  kind: "iface",   x: 560, y: 84, w: 96, h: 24 },

      { id: "sdram",   label: "SDRAM CTRL\nw/ EDAC", kind: "mem", x: 80, y: 168, w: 96, h: 44 },
      { id: "prom",    label: "PROM I/O CTRL\nw/ EDAC", kind: "mem", x: 80, y: 222, w: 96, h: 44 },

      { id: "ahbio",   label: "AHB Bus  ·  Slave I/O", kind: "bus", x: 200, y: 168, w: 460, h: 18 },
      { id: "ahbst",   label: "AHB Status",    kind: "periph",  x: 200, y: 196, w: 80, h: 24 },
      { id: "tmu14",   label: "Timer units 1–4", kind: "periph", x: 290, y: 196, w: 100, h: 24 },
      { id: "pcim",    label: "PCI Master",    kind: "iface",   x: 400, y: 196, w: 70, h: 24 },
      { id: "pcid",    label: "PCI DMA",       kind: "iface",   x: 480, y: 196, w: 70, h: 24 },
      { id: "spwrtr",  label: "SpW Router",    kind: "iface",   x: 560, y: 196, w: 96, h: 24 },

      { id: "padpll",  label: "Pad / PLL ctrl",kind: "periph",  x: 80, y: 274, w: 96, h: 24 },
      { id: "clkgate", label: "Clock gating",  kind: "periph",  x: 80, y: 302, w: 96, h: 24 },
      { id: "tempsens",label: "Temperature sensor", kind: "periph", x: 80, y: 330, w: 96, h: 24 },

      { id: "ahbst2",  label: "AHB Status",    kind: "periph",  x: 200, y: 274, w: 80, h: 24 },
      { id: "tu0wd",   label: "Timer 0 + WDOG",kind: "periph",  x: 200, y: 302, w: 100, h: 24 },
      { id: "uart",    label: "UART",          kind: "iface",   x: 200, y: 330, w: 50, h: 24 },
      { id: "gpio",    label: "GPIO 0..1",     kind: "iface",   x: 256, y: 330, w: 76, h: 24 },
      { id: "btstr",   label: "Bootstrap GP reg", kind: "periph", x: 310, y: 274, w: 96, h: 24 },
      { id: "tdp",     label: "TDP ctrl",      kind: "periph",  x: 340, y: 330, w: 70, h: 24 },
      { id: "spi",     label: "SPI ctrl",      kind: "iface",   x: 416, y: 330, w: 70, h: 24 },
      { id: "pcit",    label: "PCI Target",    kind: "iface",   x: 416, y: 274, w: 70, h: 24 },

      { id: "apbm",    label: "APB Master",    kind: "bus",     x: 200, y: 254, w: 460, h: 14 },
      { id: "ahbom",   label: "AHB Bus  ·  Master I/O", kind: "bus", x: 200, y: 360, w: 460, h: 18 },

      { id: "cancore", label: "CAN Controller",kind: "iface",   x: 492, y: 274, w: 110, h: 24 },
      { id: "mil",     label: "MIL-STD-1553B", kind: "iface",   x: 492, y: 330, w: 110, h: 24 },
      { id: "eth",     label: "Ethernet",      kind: "iface",   x: 612, y: 274, w: 70, h: 24 },
      { id: "trace",   label: "AHBTRACE",      kind: "periph",  x: 612, y: 330, w: 70, h: 24 },

      { id: "sdramext",  label: "96-bit\nPC100 SDRAM", kind: "iface", x: -10, y: 168, w: 80, h: 44, ext: true },
      { id: "promext",   label: "PROM I/O\n8/16-bit", kind: "iface", x: -10, y: 222, w: 80, h: 44, ext: true },
      { id: "promgpio",  label: "PROMIO/GPIO2\nMUX",  kind: "iface", x: -10, y: 290, w: 80, h: 36, ext: true },
      { id: "sdrameth",  label: "SDRAM/ETH/PCI\nMUX", kind: "iface", x: -10, y: 332, w: 80, h: 36, ext: true },
      { id: "jtag",      label: "JTAG DCL", kind: "iface", x: 700, y: 116, w: 70, h: 28, ext: true },
    ],
  },

  gr712rc: {
    label: "GR712RC — Dual-core LEON3FT",
    busColor: { proc: "#e0a64c", ahb_s: "#3aa5c7", ahb_m: "#c66c8e", apb: "#7da7d9" },
    irqBase: "0x80000200",
    cpus: [
      { id: "cpu0", label: "LEON3FT #0", x: 280, y: 38 },
      { id: "cpu1", label: "LEON3FT #1", x: 380, y: 38 },
    ],
    blocks: [
      { id: "irqmp",  label: "IRQ(A)MP",     kind: "periph",  x: 184, y: 38, w: 70, h: 38 },
      { id: "stat",   label: "L3STAT",       kind: "periph",  x: 184, y: 84, w: 70, h: 24 },
      { id: "fpu",    label: "GRFPU",        kind: "periph",  x: 280, y: 88, w: 90, h: 24 },
      { id: "dsu",    label: "DSU3",         kind: "periph",  x: 480, y: 88, w: 70, h: 24 },

      { id: "ahbmx",  label: "AHB Bus  ·  Processor 32-bit", kind: "bus", x: 200, y: 130, w: 380, h: 18 },
      { id: "ftmctrl",label: "FTMCTRL\nMemory CTRL", kind: "mem", x: 80, y: 130, w: 100, h: 44 },
      { id: "promext",label: "PROM / SRAM\n/ SDRAM",  kind: "iface", x: -10, y: 130, w: 80, h: 44, ext: true },

      { id: "dma",    label: "AHB/AHB Bridge",  kind: "bridge", x: 200, y: 160, w: 100, h: 24 },
      { id: "apbbr",  label: "AHB/APB Bridge",  kind: "bridge", x: 320, y: 160, w: 100, h: 24 },
      { id: "spwbr",  label: "SpW Bridge",      kind: "bridge", x: 440, y: 160, w: 100, h: 24 },

      { id: "apb",    label: "APB Bus  ·  32-bit", kind: "bus", x: 200, y: 196, w: 380, h: 16 },

      { id: "uart0",  label: "APBUART 0",     kind: "iface",   x: 200, y: 220, w: 90, h: 24 },
      { id: "uart1",  label: "APBUART 1..5",  kind: "iface",   x: 296, y: 220, w: 110, h: 24 },
      { id: "gpio",   label: "GRGPIO",        kind: "iface",   x: 412, y: 220, w: 60, h: 24 },
      { id: "tim",    label: "GPTIMER",       kind: "periph",  x: 478, y: 220, w: 70, h: 24 },
      { id: "wdog",   label: "Watchdog",      kind: "periph",  x: 554, y: 220, w: 70, h: 24 },

      { id: "spw",    label: "SpW × 8",       kind: "iface",   x: 200, y: 252, w: 90, h: 24 },
      { id: "can",    label: "OC-CAN × 2",    kind: "iface",   x: 296, y: 252, w: 90, h: 24 },
      { id: "mil",    label: "MIL-STD-1553B", kind: "iface",   x: 392, y: 252, w: 110, h: 24 },
      { id: "i2c",    label: "I²C",           kind: "iface",   x: 508, y: 252, w: 50, h: 24 },
      { id: "spi",    label: "SPI",           kind: "iface",   x: 564, y: 252, w: 50, h: 24 },

      { id: "ascs",   label: "ASCS / SLINK",  kind: "iface",   x: 200, y: 284, w: 110, h: 24 },
      { id: "ccsds",  label: "CCSDS TM/TC",   kind: "iface",   x: 316, y: 284, w: 110, h: 24 },
      { id: "occan2", label: "Time distrib.", kind: "periph",  x: 432, y: 284, w: 100, h: 24 },

      { id: "jtag",   label: "JTAG DCL",      kind: "iface",   x: 600, y: 88, w: 80, h: 28, ext: true },
    ],
  },
};

// ── Memory map data (representative) ─────────────────────
const MEMORY_MAPS = {
  gr712rc: [
    { base: "0x00000000", end: "0x1FFFFFFF", size: "512 MiB", region: "PROM",       cached: false, perms: "R-X",  attrs: "FTMCTRL · 8/16-bit · EDAC" },
    { base: "0x20000000", end: "0x3FFFFFFF", size: "512 MiB", region: "I/O",        cached: false, perms: "R/W",  attrs: "Memory-mapped peripherals (FTMCTRL bus 1)" },
    { base: "0x40000000", end: "0x7FFFFFFF", size: "1 GiB",   region: "RAM",        cached: true,  perms: "R/WX", attrs: "SDRAM/SRAM via FTMCTRL · MMU mapped" },
    { base: "0x80000000", end: "0x800FFFFF", size: "1 MiB",   region: "APB Slaves", cached: false, perms: "R/W",  attrs: "APBUART, GRGPIO, GPTIMER, IRQMP, …" },
    { base: "0x80100000", end: "0xFFFFFFFF", size: "≈ 2 GiB", region: "AHB Slaves", cached: false, perms: "R/W",  attrs: "GRSPW × 8, OC-CAN × 2, MIL-STD-1553B" },
  ],
  gr740: [
    { base: "0x00000000", end: "0x07FFFFFF", size: "128 MiB", region: "PROM",         cached: false, perms: "R-X",  attrs: "8/16-bit + EDAC" },
    { base: "0x00100000", end: "0x001FFFFF", size: "1 MiB",   region: "Boot ROM",     cached: false, perms: "R-X",  attrs: "Built-in PROM image" },
    { base: "0x40000000", end: "0x7FFFFFFF", size: "1 GiB",   region: "Cached SDRAM", cached: true,  perms: "R/WX", attrs: "PC100 96-bit SDRAM, 64–2048 MiB" },
    { base: "0xC0000000", end: "0xCFFFFFFF", size: "256 MiB", region: "Uncached RAM", cached: false, perms: "R/WX", attrs: "Same DRAM, MMU bypass alias" },
    { base: "0xFC000000", end: "0xFC0FFFFF", size: "1 MiB",   region: "AHB I/O",      cached: false, perms: "R/W",  attrs: "PCI, SpW Router, Ethernet" },
    { base: "0xFF800000", end: "0xFFFFFFFF", size: "8 MiB",   region: "APB / IO",     cached: false, perms: "R/W",  attrs: "APBUART, GPIO, Timers, GRCAN × 2, …" },
  ],
};

// ── Register catalogs ────────────────────────────────────
// Format: { offset, name, access, reset, desc, bits: [{ hi, lo, name, desc }] }
// Sourced from GRLIB IP Core User's Manual (GRSPW2, APBUART, OC-CAN, IRQ(A)MP).
const REG_CATALOGS = {
  apbuart: {
    name: "APBUART · UART Controller",
    width: 32,
    regs: [
      { offset: "0x00", name: "DATA",    access: "R/W", reset: "0x00000000", desc: "UART data register · TX/RX FIFO access",
        bits: [{ hi: 7, lo: 0, name: "DATA", desc: "Byte to transmit / received byte (8-bit)" }] },
      { offset: "0x04", name: "STATUS",  access: "R/W", reset: "0x00000086", desc: "UART status register",
        bits: [
          { hi: 31, lo: 26, name: "RCNT", desc: "Receive FIFO count" },
          { hi: 25, lo: 20, name: "TCNT", desc: "Transmit FIFO count" },
          { hi: 10, lo: 10, name: "RF",   desc: "Receive FIFO full" },
          { hi: 9,  lo: 9,  name: "TF",   desc: "Transmit FIFO full" },
          { hi: 8,  lo: 8,  name: "RH",   desc: "Receive FIFO half-full" },
          { hi: 7,  lo: 7,  name: "TH",   desc: "Transmit FIFO half-full" },
          { hi: 6,  lo: 6,  name: "FE",   desc: "Framing error" },
          { hi: 5,  lo: 5,  name: "PE",   desc: "Parity error" },
          { hi: 4,  lo: 4,  name: "OV",   desc: "Overrun" },
          { hi: 3,  lo: 3,  name: "BR",   desc: "Break received" },
          { hi: 2,  lo: 2,  name: "TE",   desc: "Transmitter empty" },
          { hi: 1,  lo: 1,  name: "TS",   desc: "Transmitter shift register empty" },
          { hi: 0,  lo: 0,  name: "DR",   desc: "Data ready (RX FIFO non-empty)" },
        ] },
      { offset: "0x08", name: "CONTROL", access: "R/W", reset: "0x00000000", desc: "UART control register",
        bits: [
          { hi: 31, lo: 31, name: "FA", desc: "FIFOs available (RO)" },
          { hi: 14, lo: 14, name: "DB", desc: "FIFO debug mode enable" },
          { hi: 13, lo: 13, name: "BL", desc: "Break length" },
          { hi: 12, lo: 12, name: "DI", desc: "Disable RX" },
          { hi: 11, lo: 11, name: "SI", desc: "Sync interrupt" },
          { hi: 10, lo: 10, name: "TF", desc: "Transmit FIFO interrupt" },
          { hi: 9,  lo: 9,  name: "RF", desc: "Receive FIFO interrupt" },
          { hi: 8,  lo: 8,  name: "EC", desc: "External clock" },
          { hi: 7,  lo: 7,  name: "LB", desc: "Loop back" },
          { hi: 6,  lo: 6,  name: "FL", desc: "Flow control (RTS/CTS)" },
          { hi: 5,  lo: 5,  name: "PE", desc: "Parity enable" },
          { hi: 4,  lo: 4,  name: "PS", desc: "Parity select (0=even, 1=odd)" },
          { hi: 3,  lo: 3,  name: "TI", desc: "Transmitter interrupt enable" },
          { hi: 2,  lo: 2,  name: "RI", desc: "Receiver interrupt enable" },
          { hi: 1,  lo: 1,  name: "TE", desc: "Transmitter enable" },
          { hi: 0,  lo: 0,  name: "RE", desc: "Receiver enable" },
        ] },
      { offset: "0x0C", name: "SCALER",  access: "R/W", reset: "0x00000000", desc: "Baud-rate scaler reload value",
        bits: [{ hi: 11, lo: 0, name: "RELOAD", desc: "scaler = clk / (8·(1+baud))" }] },
      { offset: "0x10", name: "FIFO_DBG",access: "R/W", reset: "0x00000000", desc: "Debug FIFO peek/poke (when DB=1)",
        bits: [{ hi: 7, lo: 0, name: "DATA", desc: "Direct access to TX/RX FIFO" }] },
    ],
  },

  grspw2: {
    name: "GRSPW2 · SpaceWire Link & DMA",
    width: 32,
    regs: [
      { offset: "0x00", name: "CTRL",    access: "R/W", reset: "0x00000000", desc: "Control register",
        bits: [
          { hi: 31, lo: 28, name: "RA/RX/RC/NCH", desc: "RMAP, RX-unaligned, RMAP-CRC, #channels (RO)" },
          { hi: 26, lo: 26, name: "PO",   desc: "Port force" },
          { hi: 16, lo: 16, name: "RE",   desc: "RMAP enable" },
          { hi: 15, lo: 15, name: "RD",   desc: "RMAP buffer disable" },
          { hi: 11, lo: 11, name: "TR",   desc: "Time-code RX enable" },
          { hi: 10, lo: 10, name: "TT",   desc: "Time-code TX enable" },
          { hi: 9,  lo: 9,  name: "LI",   desc: "Link error IRQ" },
          { hi: 8,  lo: 8,  name: "TQ",   desc: "Tick-out IRQ" },
          { hi: 5,  lo: 5,  name: "PM",   desc: "Promiscuous mode" },
          { hi: 4,  lo: 4,  name: "TI",   desc: "Tick-in (generate time-code)" },
          { hi: 3,  lo: 3,  name: "IE",   desc: "Interrupt enable" },
          { hi: 2,  lo: 2,  name: "AS",   desc: "Auto-start" },
          { hi: 1,  lo: 1,  name: "LS",   desc: "Link start" },
          { hi: 0,  lo: 0,  name: "LD",   desc: "Link disable" },
        ] },
      { offset: "0x04", name: "STATUS",  access: "R/W", reset: "0x00000000", desc: "Link status register (W1C)",
        bits: [
          { hi: 23, lo: 21, name: "LS",  desc: "Link state (000=ErrorReset…101=Run)" },
          { hi: 9,  lo: 9,  name: "EE",  desc: "Early EOP/EEP" },
          { hi: 8,  lo: 8,  name: "IA",  desc: "Invalid address" },
          { hi: 7,  lo: 7,  name: "PE",  desc: "Parity error" },
          { hi: 5,  lo: 5,  name: "DE",  desc: "Disconnect error" },
          { hi: 4,  lo: 4,  name: "ER",  desc: "Escape error" },
          { hi: 3,  lo: 3,  name: "CE",  desc: "Credit error" },
          { hi: 0,  lo: 0,  name: "TO",  desc: "Tick-out received" },
        ] },
      { offset: "0x08", name: "DEFADDR", access: "R/W", reset: "0x00000000", desc: "Default node address + mask",
        bits: [{ hi: 7, lo: 0, name: "ADDR", desc: "Node address" }, { hi: 15, lo: 8, name: "MASK", desc: "Node-address mask" }] },
      { offset: "0x0C", name: "CLKDIV",  access: "R/W", reset: "0x00000909", desc: "Clock divisor (start / run)",
        bits: [{ hi: 7, lo: 0, name: "CLKDIV-RUN", desc: "Run-mode TX clock divisor − 1" },
               { hi: 15, lo: 8, name: "CLKDIV-START", desc: "Init/start TX clock (10 Mb/s)" }] },
      { offset: "0x10", name: "DKEY",    access: "R/W", reset: "0x00000000", desc: "Destination key (RMAP)",
        bits: [{ hi: 7, lo: 0, name: "KEY", desc: "Destination-key byte" }] },
      { offset: "0x14", name: "TIME",    access: "R/W", reset: "0x00000000", desc: "Time-code register",
        bits: [{ hi: 7, lo: 6, name: "CTRL", desc: "Control flags" }, { hi: 5, lo: 0, name: "TIME", desc: "6-bit time-counter" }] },
      { offset: "0x20", name: "DMACTRL", access: "R/W", reset: "0x00000000", desc: "DMA control (channel 0)",
        bits: [
          { hi: 16, lo: 16, name: "LE", desc: "Link-error abort" },
          { hi: 13, lo: 13, name: "EN", desc: "RX enable" },
          { hi: 12, lo: 12, name: "NR", desc: "No spill" },
          { hi: 11, lo: 11, name: "RX", desc: "RX descriptor table valid" },
          { hi: 10, lo: 10, name: "AT", desc: "Abort TX" },
          { hi: 6,  lo: 6,  name: "RA", desc: "RX active" },
          { hi: 5,  lo: 5,  name: "TA", desc: "TX active" },
          { hi: 1,  lo: 1,  name: "RE", desc: "Receive enable" },
          { hi: 0,  lo: 0,  name: "TE", desc: "Transmit enable" },
        ] },
      { offset: "0x24", name: "DMARXLEN",access: "R/W", reset: "0x02000000", desc: "RX max packet length" },
      { offset: "0x28", name: "DMATXDESC",access: "R/W", reset: "0x00000000", desc: "TX descriptor base address" },
      { offset: "0x2C", name: "DMARXDESC",access: "R/W", reset: "0x00000000", desc: "RX descriptor base address" },
      { offset: "0xA0", name: "ICODEGEN",access: "R/W", reset: "0x00000000", desc: "Distributed-interrupt: code generator" },
    ],
  },

  occan: {
    name: "OC-CAN · SJA1000-compatible (PeliCAN)",
    width: 8,
    regs: [
      { offset: "0x00", name: "MOD",     access: "R/W", reset: "0x01", desc: "Mode register",
        bits: [
          { hi: 4, lo: 4, name: "AFM", desc: "Acceptance filter mode (1=single)" },
          { hi: 3, lo: 3, name: "STM", desc: "Self-test mode" },
          { hi: 2, lo: 2, name: "LOM", desc: "Listen-only mode" },
          { hi: 1, lo: 1, name: "RM",  desc: "Reset mode (1 after power-up)" },
          { hi: 0, lo: 0, name: "RES", desc: "Reset request" },
        ] },
      { offset: "0x01", name: "CMR",     access: "W",   reset: "—",    desc: "Command register",
        bits: [
          { hi: 4, lo: 4, name: "SRR", desc: "Self-reception request" },
          { hi: 3, lo: 3, name: "CDO", desc: "Clear data-overrun" },
          { hi: 2, lo: 2, name: "RRB", desc: "Release receive buffer" },
          { hi: 1, lo: 1, name: "AT",  desc: "Abort transmission" },
          { hi: 0, lo: 0, name: "TR",  desc: "Transmission request" },
        ] },
      { offset: "0x02", name: "SR",      access: "R",   reset: "0x3C", desc: "Status register",
        bits: [
          { hi: 7, lo: 7, name: "BS", desc: "Bus-off" },
          { hi: 6, lo: 6, name: "ES", desc: "Error status" },
          { hi: 5, lo: 5, name: "TS", desc: "Transmit status" },
          { hi: 4, lo: 4, name: "RS", desc: "Receive status" },
          { hi: 3, lo: 3, name: "TCS",desc: "Transmit complete" },
          { hi: 2, lo: 2, name: "TBS",desc: "Transmit buffer access" },
          { hi: 1, lo: 1, name: "DOS",desc: "Data overrun" },
          { hi: 0, lo: 0, name: "RBS",desc: "Receive buffer status" },
        ] },
      { offset: "0x03", name: "IR",      access: "R",   reset: "0xE0", desc: "Interrupt register (read clears)",
        bits: [
          { hi: 4, lo: 4, name: "WUI", desc: "Wake-up" },
          { hi: 3, lo: 3, name: "DOI", desc: "Data overrun" },
          { hi: 2, lo: 2, name: "EI",  desc: "Error warning" },
          { hi: 1, lo: 1, name: "TI",  desc: "Transmit" },
          { hi: 0, lo: 0, name: "RI",  desc: "Receive" },
        ] },
      { offset: "0x04", name: "IER",     access: "R/W", reset: "0x00", desc: "Interrupt enable register" },
      { offset: "0x06", name: "BTR0",    access: "R/W", reset: "—",    desc: "Bus-timing 0",
        bits: [{ hi: 7, lo: 6, name: "SJW", desc: "Sync jump width" }, { hi: 5, lo: 0, name: "BRP", desc: "Baud-rate prescaler" }] },
      { offset: "0x07", name: "BTR1",    access: "R/W", reset: "—",    desc: "Bus-timing 1",
        bits: [{ hi: 7, lo: 7, name: "SAM", desc: "Sampling 1=triple, 0=single" },
               { hi: 6, lo: 4, name: "TSEG2", desc: "Time segment 2" },
               { hi: 3, lo: 0, name: "TSEG1", desc: "Time segment 1" }] },
      { offset: "0x08", name: "OCR",     access: "R/W", reset: "—",    desc: "Output control" },
      { offset: "0x10", name: "TXBUF",   access: "R/W", reset: "—",    desc: "Tx buffer (frame info + data, 13 bytes)" },
      { offset: "0x10", name: "RXBUF",   access: "R",   reset: "—",    desc: "Rx buffer (alias of TXBUF in receive mode)" },
      { offset: "0x1C", name: "RXERR",   access: "R",   reset: "0x00", desc: "RX error counter" },
      { offset: "0x1D", name: "TXERR",   access: "R/W", reset: "0x00", desc: "TX error counter" },
      { offset: "0x1F", name: "CDR",     access: "R/W", reset: "0x00", desc: "Clock divider · output mode" },
    ],
  },

  irqmp: {
    name: "IRQ(A)MP · Multiprocessor Interrupt Controller",
    width: 32,
    regs: [
      { offset: "0x00", name: "ILEVEL",  access: "R/W", reset: "0x00000000", desc: "Interrupt level register (1 bit per IRQ)",
        bits: [{ hi: 15, lo: 1, name: "IL[15:1]", desc: "Level (1=high, 0=low priority)" }] },
      { offset: "0x04", name: "IPEND",   access: "R/W", reset: "0x00000000", desc: "Interrupt pending register",
        bits: [{ hi: 31, lo: 17, name: "EIP[15:1]", desc: "Extended IRQ pending (IRQ16-IRQ31)" },
               { hi: 15, lo: 1,  name: "IP[15:1]",  desc: "Standard IRQ pending" }] },
      { offset: "0x08", name: "IFORCE",  access: "R/W", reset: "0x00000000", desc: "Force interrupt (uniprocessor / CPU 0)" },
      { offset: "0x0C", name: "ICLEAR",  access: "W",   reset: "0x00000000", desc: "Clear interrupts (W1C)" },
      { offset: "0x10", name: "MPSTAT",  access: "R/W", reset: "—",          desc: "Multiprocessor status",
        bits: [{ hi: 31, lo: 28, name: "NCPU", desc: "Number of CPUs − 1 (RO)" },
               { hi: 27, lo: 20, name: "BA",   desc: "Broadcast available" },
               { hi: 15, lo: 0,  name: "STATUS", desc: "Per-CPU power-down status (1 = halted)" }] },
      { offset: "0x14", name: "BRDCST",  access: "R/W", reset: "0x00000000", desc: "Broadcast register · IRQ delivered to all CPUs" },
      { offset: "0x18", name: "ERRSTAT", access: "R/W", reset: "—",          desc: "Error mode status (per-CPU error trap)" },
      { offset: "0x1C", name: "WDOGCTRL",access: "R/W", reset: "—",          desc: "Watchdog control / mask" },
      { offset: "0x20", name: "ASMPCTRL",access: "R/W", reset: "—",          desc: "Asymmetric MP control" },
      { offset: "0x24", name: "ICSEL",   access: "R/W", reset: "—",          desc: "Interrupt-controller select per CPU (AMP)" },
      { offset: "0x40", name: "PIMASK[n]",access: "R/W", reset: "0x00000000", desc: "Per-CPU interrupt mask · n=0..(NCPU-1), stride 4" },
      { offset: "0x80", name: "PIFORCE[n]",access: "R/W",reset: "0x00000000", desc: "Per-CPU interrupt force · n=0..(NCPU-1), stride 4" },
      { offset: "0xC0", name: "PEXTACK[n]",access: "R/W",reset: "0x00000000", desc: "Per-CPU extended-IRQ ack (returns IRQ #)" },
    ],
  },
};

// Map a selected block (by id or label keyword) onto a register catalog.
function catalogFor(selected) {
  if (!selected) return null;
  const id = (selected.id || "").toLowerCase();
  const lbl = (selected.label || "").toLowerCase();
  if (/uart/.test(id) || /uart/.test(lbl)) return REG_CATALOGS.apbuart;
  if (/spw|spacewire/.test(id) || /spw|spacewire/.test(lbl)) return REG_CATALOGS.grspw2;
  if (/can/.test(id) || /can/.test(lbl)) return REG_CATALOGS.occan;
  if (/irq/.test(id) || /irq/.test(lbl)) return REG_CATALOGS.irqmp;
  return null;
}

// ── External interfaces (pins, ports, host-side bindings) ─────────
const INTERFACES = {
  gr712rc: [
    { kind: "uart",  id: "apbuart0", label: "APBUART 0",  base: "0x80000100", irq: 2, pins: "TX:Q14 RX:Q15",  port: "tcp/3010 (chardev)", note: "Default stdout" },
    { kind: "uart",  id: "apbuart1", label: "APBUART 1",  base: "0x80100100", irq: 17, pins: "TX:R14 RX:R15", port: "tcp/3011", note: "RTEMS shell" },
    { kind: "uart",  id: "apbuart2", label: "APBUART 2",  base: "0x80100200", irq: 18, pins: "TX:T14 RX:T15", port: "tcp/3012" },
    { kind: "uart",  id: "apbuart3", label: "APBUART 3",  base: "0x80100300", irq: 19, pins: "TX:U14 RX:U15", port: "tcp/3013" },
    { kind: "uart",  id: "apbuart4", label: "APBUART 4",  base: "0x80100400", irq: 20, pins: "TX:V14 RX:V15", port: "tcp/3014" },
    { kind: "spw",   id: "spw0", label: "SpaceWire link 0", base: "0x80000A00", irq: 10, pins: "Din0±/Sin0±/Dout0±/Sout0±", port: "tcp/2010 (STAR-Dundee)", note: "200 Mbit/s" },
    { kind: "spw",   id: "spw1", label: "SpaceWire link 1", base: "0x80000B00", irq: 11, pins: "Din1±/…",     port: "tcp/2011" },
    { kind: "spw",   id: "spw2", label: "SpaceWire link 2", base: "0x80000C00", irq: 12, pins: "Din2±/…",     port: "tcp/2012" },
    { kind: "spw",   id: "spw3", label: "SpaceWire link 3", base: "0x80000D00", irq: 13, pins: "Din3±/…",     port: "tcp/2013" },
    { kind: "can",   id: "can0", label: "OC-CAN 0", base: "0x80000800", irq: 8,  pins: "CANTX0/CANRX0", port: "tcp/2900 (vcan)", note: "ISO 11898-1" },
    { kind: "can",   id: "can1", label: "OC-CAN 1", base: "0x80000900", irq: 9,  pins: "CANTX1/CANRX1", port: "tcp/2901 (vcan)" },
    { kind: "mil",   id: "mil0", label: "MIL-STD-1553B", base: "0x80100600", irq: 6, pins: "BUS-A±/BUS-B±", port: "tcp/2553" },
    { kind: "gpio",  id: "gpio", label: "GRGPIO (32 lines)", base: "0x8000C000", irq: 5, pins: "GPIO[31:0]", port: "REST /gpio/{n}", note: "Open-drain or push-pull" },
    { kind: "i2c",   id: "i2c",  label: "I²C-Master", base: "0x80100700", irq: 14, pins: "SCL/SDA", port: "tcp/2400" },
    { kind: "spi",   id: "spi",  label: "SPI Controller", base: "0x80100800", irq: 15, pins: "SCK/MOSI/MISO/CS[3:0]", port: "tcp/2200" },
  ],
  gr740: [
    { kind: "uart", id: "apbuart0", label: "APBUART 0", base: "0xFF900000", irq: 2,  pins: "TX:AC18 RX:AC19", port: "tcp/3010 (chardev)", note: "Default stdout" },
    { kind: "spw",  id: "spw0", label: "SpW Router port 1", base: "0xFFB00000", irq: 18, pins: "Din0±/Sin0±/…", port: "tcp/2010", note: "Routed via on-chip SpW Router" },
    { kind: "spw",  id: "spw1", label: "SpW Router port 2", base: "0xFFB00100", irq: 19, pins: "Din1±/…",      port: "tcp/2011" },
    { kind: "spw",  id: "spw2", label: "SpW Router port 3", base: "0xFFB00200", irq: 20, pins: "Din2±/…",      port: "tcp/2012" },
    { kind: "spw",  id: "spw3", label: "SpW Router port 4", base: "0xFFB00300", irq: 21, pins: "Din3±/…",      port: "tcp/2013" },
    { kind: "spw",  id: "spw4", label: "SpW Router port 5", base: "0xFFB00400", irq: 22, pins: "Din4±/…",      port: "tcp/2014" },
    { kind: "spw",  id: "spw5", label: "SpW Router port 6", base: "0xFFB00500", irq: 23, pins: "Din5±/…",      port: "tcp/2015" },
    { kind: "spw",  id: "spw6", label: "SpW Router port 7", base: "0xFFB00600", irq: 24, pins: "Din6±/…",      port: "tcp/2016" },
    { kind: "spw",  id: "spw7", label: "SpW Router port 8", base: "0xFFB00700", irq: 25, pins: "Din7±/…",      port: "tcp/2017" },
    { kind: "can",  id: "can0", label: "GRCAN 0", base: "0xFFD00000", irq: 9,  pins: "CANTX0/CANRX0", port: "tcp/2900 (vcan)" },
    { kind: "can",  id: "can1", label: "GRCAN 1", base: "0xFFD10000", irq: 10, pins: "CANTX1/CANRX1", port: "tcp/2901 (vcan)" },
    { kind: "mil",  id: "mil0", label: "MIL-STD-1553B", base: "0xFFD20000", irq: 6, pins: "BUS-A±/BUS-B±", port: "tcp/2553" },
    { kind: "eth",  id: "eth0", label: "GRETH 1G", base: "0xFFE00000", irq: 12, pins: "MII/RGMII", port: "tap0 (host bridge)", note: "Time-stamped frames" },
    { kind: "gpio", id: "gpio0", label: "GPIO Port 0 (8)", base: "0xFFA00000", irq: 5, pins: "GPIO0[7:0]", port: "REST /gpio/0/{n}", note: "Programmable pull-up" },
    { kind: "gpio", id: "gpio1", label: "GPIO Port 1 (8)", base: "0xFFA10000", irq: 6, pins: "GPIO1[7:0]", port: "REST /gpio/1/{n}" },
    { kind: "spi",  id: "spi",  label: "SPI Controller", base: "0xFFA20000", irq: 15, pins: "SCK/MOSI/MISO/CS[3:0]", port: "tcp/2200" },
    { kind: "pci",  id: "pci",  label: "PCI Master/Target", base: "0xFFC00000", irq: 14, pins: "AD[31:0]/CBE[3:0]/…", port: "—", note: "32-bit PCI 2.3" },
  ],
};

// ── Block diagram component ──────────────────────────────
function BlockDiagram({ machineId, selected, onSelect }) {
  const topo = TOPOLOGY[machineId];
  if (!topo) return null;
  const W = 800, H = 400;

  const blockColor = (kind) => ({
    cpu:    "#1d2c3f",
    bridge: "#3a2a3a",
    mem:    "#2d2415",
    periph: "#1c2330",
    iface:  "#10222a",
    bus:    "transparent",
  }[kind] || "#1c2330");

  const blockStroke = (kind) => ({
    cpu:    "#5eb1ff",
    bridge: "#d678e8",
    mem:    "#f5b14a",
    periph: "#4a5566",
    iface:  "#7af2a8",
    bus:    "#8a94a3",
  }[kind] || "#3a4554");

  return (
    <div className="block-diagram">
      <div className="bd-legend">
        <span className="lg cpu">CPU core</span>
        <span className="lg bridge">Bridge</span>
        <span className="lg mem">Memory</span>
        <span className="lg iface">External I/F</span>
        <span className="lg periph">Peripheral</span>
        <span className="lg bus">Bus</span>
      </div>
      <svg viewBox={`-20 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="bd-svg">
        {/* CPU row */}
        {topo.cpus.map((c) => (
          <g key={c.id}
             className={`bd-block cpu ${selected === c.id ? "sel" : ""}`}
             onClick={() => onSelect({ id: c.id, label: c.label, kind: "cpu" })}>
            <rect x={c.x} y={c.y} width="80" height="42" rx="3"
                  fill={blockColor("cpu")} stroke={blockStroke("cpu")} strokeWidth="1.2"/>
            <text x={c.x + 40} y={c.y + 17} textAnchor="middle" fill="#d6dce5" fontSize="10" fontWeight="600">LEON</text>
            <text x={c.x + 40} y={c.y + 30} textAnchor="middle" fill="#8a94a3" fontSize="9">Cache + MMU</text>
            <text x={c.x + 40} y={c.y - 4} textAnchor="middle" fill="#5eb1ff" fontSize="9" fontFamily="var(--font-mono)">{c.label}</text>
          </g>
        ))}

        {topo.blocks.map((b) => {
          const isBus = b.kind === "bus";
          const isSel = selected === b.id;
          return (
            <g key={b.id}
               className={`bd-block ${b.kind} ${isSel ? "sel" : ""} ${b.ext ? "ext" : ""}`}
               onClick={() => onSelect({ id: b.id, label: b.label, kind: b.kind })}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={isBus ? 2 : 3}
                    fill={isBus ? "#1a2330" : blockColor(b.kind)}
                    stroke={blockStroke(b.kind)} strokeWidth={isSel ? 1.8 : 1}/>
              {b.label.split("\n").map((line, i, arr) => (
                <text key={i}
                      x={b.x + b.w / 2}
                      y={b.y + b.h / 2 + (i - (arr.length - 1) / 2) * 11 + 3}
                      textAnchor="middle"
                      fill={isBus ? "#8a94a3" : "#d6dce5"}
                      fontSize={isBus ? 9 : 9.5}
                      fontWeight={isBus ? 600 : 500}
                      fontFamily={isBus ? "var(--font-mono)" : "inherit"}
                      style={isBus ? { letterSpacing: "0.06em", textTransform: "uppercase" } : null}>
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Detail card for selected block ───────────────────────
function BlockDetail({ machineId, selected }) {
  const ifaces = INTERFACES[machineId] || [];
  const match = ifaces.find((i) => i.id === selected?.id || i.label === selected?.label);
  const catalog = catalogFor(selected);
  // IRQ(A)MP block has a fixed base in both SoCs
  const irqBase = machineId === "gr740" ? "0xFF904000" : "0x80000200";

  if (!selected) {
    return (
      <div className="bd-detail empty">
        <Icon name="chip" size={22} />
        <div className="title">Select a block</div>
        <div className="sub">Click any IP core, bus, or external interface in the diagram to view its base address, IRQ, pin mapping, and full register table.</div>
      </div>
    );
  }

  const base = match?.base || (catalog === REG_CATALOGS.irqmp ? irqBase : null);

  return (
    <div className="bd-detail">
      <div className="bd-detail-head">
        <span className={`tag ${kindTag(selected.kind)}`}>{selected.kind}</span>
        <span className="bd-detail-title">{selected.label}</span>
      </div>
      {match ? (
        <div className="kv-table">
          <div><span className="k">Base address</span><span className="v mono accent">{match.base}</span></div>
          <div><span className="k">IRQ line</span><span className="v mono">{match.irq}</span></div>
          <div><span className="k">Pins / signals</span><span className="v mono">{match.pins}</span></div>
          <div><span className="k">Host binding</span><span className="v mono accent">{match.port}</span></div>
          {match.note && <div><span className="k">Note</span><span className="v">{match.note}</span></div>}
        </div>
      ) : catalog === REG_CATALOGS.irqmp ? (
        <div className="kv-table">
          <div><span className="k">Base address</span><span className="v mono accent">{irqBase}</span></div>
          <div><span className="k">Width</span><span className="v mono">32-bit APB</span></div>
        </div>
      ) : !catalog && (
        <div className="bd-detail-body">
          <p className="dim" style={{ fontSize: 12, lineHeight: 1.5 }}>
            This block is part of the on-chip topology but does not expose a host-facing port or a documented register block in this view.
          </p>
        </div>
      )}

      {catalog && <RegisterTable catalog={catalog} base={base} />}
    </div>
  );
}

function RegisterTable({ catalog, base }) {
  const [openIdx, setOpenIdx] = useState(null);
  return (
    <div className="reg-cat">
      <div className="reg-cat-head">
        <div>
          <div className="reg-cat-title">{catalog.name}</div>
          <div className="reg-cat-sub mono">
            {base && <>base <span className="accent">{base}</span> · </>}
            {catalog.width}-bit · {catalog.regs.length} registers
          </div>
        </div>
      </div>
      <div className="reg-cat-table">
        <div className="reg-cat-row head">
          <span>Offset</span>
          {base && <span>Address</span>}
          <span>Name</span>
          <span>Acc</span>
          <span>Reset</span>
          <span>Description</span>
        </div>
        {catalog.regs.map((r, i) => {
          const off = parseInt(r.offset, 16);
          const abs = base && !isNaN(off)
            ? "0x" + ((parseInt(base, 16) + off) >>> 0).toString(16).toUpperCase().padStart(8, "0")
            : null;
          const open = openIdx === i;
          return (
            <React.Fragment key={i}>
              <div className={`reg-cat-row ${r.bits ? "expandable" : ""} ${open ? "open" : ""}`}
                   onClick={() => r.bits && setOpenIdx(open ? null : i)}>
                <span className="mono accent">{r.offset}</span>
                {base && <span className="mono">{abs}</span>}
                <span className="mono">{r.name}</span>
                <span className="mono dim">{r.access}</span>
                <span className="mono dim">{r.reset}</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {r.bits && <Icon name="chev" size={10} />}
                  <span>{r.desc}</span>
                </span>
              </div>
              {open && r.bits && (
                <div className="reg-cat-bits">
                  {r.bits.map((b, j) => (
                    <div key={j} className="reg-bit-row">
                      <span className="mono accent">[{b.hi === b.lo ? b.hi : `${b.hi}:${b.lo}`}]</span>
                      <span className="mono">{b.name}</span>
                      <span className="dim">{b.desc}</span>
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function kindTag(kind) {
  return { cpu: "blue", iface: "green", mem: "amber", bridge: "amber", periph: "", bus: "" }[kind] || "";
}

// ── Memory map table ─────────────────────────────────────
function MemoryMap({ machineId }) {
  const rows = MEMORY_MAPS[machineId] || [];
  return (
    <div className="mmap">
      <div className="mmap-bar">
        {rows.map((r, i) => (
          <div key={i}
               className="mmap-band"
               style={{ flex: parseFlex(r.base, r.end), background: bandColor(r.region) }}
               title={`${r.region}\n${r.base} – ${r.end}`}>
            <span>{r.region}</span>
          </div>
        ))}
      </div>
      <div className="mmap-table">
        <div className="mmap-row head">
          <span>Base</span><span>End</span><span>Size</span><span>Region</span><span>Perms</span><span>Cached</span><span>Attributes</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="mmap-row">
            <span className="mono accent">{r.base}</span>
            <span className="mono">{r.end}</span>
            <span className="mono">{r.size}</span>
            <span>{r.region}</span>
            <span className="mono">{r.perms}</span>
            <span className={r.cached ? "tag green sm" : "tag sm"}>{r.cached ? "yes" : "no"}</span>
            <span className="dim" style={{ fontSize: 11 }}>{r.attrs}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function parseFlex(base, end) {
  const lo = parseInt(base, 16), hi = parseInt(end, 16);
  const span = Math.max(1, hi - lo);
  return Math.max(0.5, Math.log2(span) - 18);
}

function bandColor(region) {
  if (/PROM|ROM/i.test(region)) return "linear-gradient(180deg,#3a2a15,#241a0d)";
  if (/RAM|SDRAM/i.test(region)) return "linear-gradient(180deg,#15302a,#0d2018)";
  if (/APB|IO|I\/O/i.test(region)) return "linear-gradient(180deg,#1d2a40,#10182a)";
  if (/AHB/i.test(region)) return "linear-gradient(180deg,#2a1d40,#1a102a)";
  return "linear-gradient(180deg,#222a36,#15191e)";
}

// ── Interfaces list ──────────────────────────────────────
function InterfacesList({ machineId, filter, onSelect, selected }) {
  const ifaces = (INTERFACES[machineId] || []).filter((i) =>
    filter === "all" ? true : i.kind === filter
  );
  return (
    <div className="ifaces">
      <div className="ifaces-row head">
        <span></span>
        <span>Interface</span>
        <span>Base</span>
        <span>IRQ</span>
        <span>Pins</span>
        <span>Host binding</span>
        <span></span>
      </div>
      {ifaces.map((i) => (
        <div key={i.id}
             className={`ifaces-row ${selected?.id === i.id ? "sel" : ""}`}
             onClick={() => onSelect({ id: i.id, label: i.label, kind: i.kind })}>
          <span className={`tag ${kindTagForIface(i.kind)} sm`}>{i.kind}</span>
          <span>{i.label}</span>
          <span className="mono accent">{i.base}</span>
          <span className="mono">{i.irq}</span>
          <span className="mono dim" style={{ fontSize: 10.5 }}>{i.pins}</span>
          <span className="mono accent" style={{ fontSize: 11 }}>{i.port}</span>
          <button className="btn ghost icon sm" title="Connect">
            <Icon name="plus" size={11} />
          </button>
        </div>
      ))}
      {ifaces.length === 0 && (
        <div className="faint mono" style={{ padding: 14, fontSize: 11 }}>
          No interfaces of kind <span className="inline-code">{filter}</span> on this machine.
        </div>
      )}
    </div>
  );
}

function kindTagForIface(kind) {
  return ({ uart: "blue", spw: "green", can: "amber", mil: "red", gpio: "", i2c: "blue", spi: "blue", eth: "green", pci: "amber" }[kind]) || "";
}

// ── The full Machine View ───────────────────────────────
function MachineView() {
  const [mid, setMid] = useState("gr740");
  const machine = MACHINES.find((m) => m.id === mid);
  const [selected, setSelected] = useState(null);
  const [ifaceFilter, setIfaceFilter] = useState("all");

  const ifaceKinds = ["all", ...new Set((INTERFACES[mid] || []).map((i) => i.kind))];

  return (
    <div className="machine-view">
      <div className="mv-header">
        <div className="mv-title-block">
          <div className="mv-eyebrow">SoC inspector</div>
          <div className="mv-title">{TOPOLOGY[mid]?.label}</div>
          <div className="mv-sub mono">
            {machine.cpus} CPUs · {machine.uart_count} UART · max {machine.max_ram_mb} MiB RAM · arch {machine.arch}
          </div>
        </div>
        <div className="mv-machine-tabs">
          {MACHINES.map((m) => (
            <button key={m.id}
                    className={`mv-mtab ${mid === m.id ? "active" : ""}`}
                    onClick={() => { setMid(m.id); setSelected(null); }}>
              <span className="mono">{m.id}</span>
              <span className="dim" style={{ fontSize: 10 }}>{m.cpus} CPU</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mv-grid">
        <section className="mv-card mv-diagram">
          <div className="mv-card-head">
            <span className="mv-card-title">Block diagram</span>
            <span className="dim mono" style={{ fontSize: 10.5 }}>AMBA AHB · APB · click any block →</span>
          </div>
          <BlockDiagram machineId={mid} selected={selected?.id} onSelect={setSelected} />
        </section>

        <aside className="mv-card mv-detail">
          <div className="mv-card-head">
            <span className="mv-card-title">Block details</span>
          </div>
          <BlockDetail machineId={mid} selected={selected} />
        </aside>

        <section className="mv-card mv-mmap">
          <div className="mv-card-head">
            <span className="mv-card-title">Memory map</span>
            <span className="dim mono" style={{ fontSize: 10.5 }}>Physical · big-endian</span>
          </div>
          <MemoryMap machineId={mid} />
        </section>

        <section className="mv-card mv-ifaces">
          <div className="mv-card-head">
            <span className="mv-card-title">External interfaces</span>
            <div className="mv-filters">
              {ifaceKinds.map((k) => (
                <button key={k}
                        className={`mv-filter ${ifaceFilter === k ? "active" : ""}`}
                        onClick={() => setIfaceFilter(k)}>{k}</button>
              ))}
            </div>
          </div>
          <InterfacesList machineId={mid} filter={ifaceFilter} onSelect={setSelected} selected={selected} />
        </section>
      </div>
    </div>
  );
}

window.MachineView = MachineView;
