# 04 — MkProm self-bootable image

This example shows how to wrap an RTEMS application with **mkprom2** and boot
it through QEMU's `-bios` path, with no `-kernel` argument and no QEMU-generated
trampoline at the PROM base.

## How it differs from the other examples

The other apps rely on QEMU loading their ELF via `-kernel <file>`. When that
flag is present, the GR712RC machine writes a small SPARC stub at PROM
0x00000000 that performs minimal UART/timer init and jumps to the ELF entry
point in SDRAM (see `qemu/hw/sparc/gr712rc.c:write_bootloader`).

When **no** `-kernel` is passed, QEMU instead loads a flat binary from
`-bios <file>` (or the default `gr712rc-prom.bin` from the QEMU data
directories) verbatim into PROM and lets it run. The resulting boot flow
matches real hardware: the PROM firmware programs FTMCTRL, releases CPU 1
through IRQMP MPSTATUS, copies the application from PROM to SDRAM and jumps
to its entry point.

`mkprom2` is the Gaisler tool that produces such a flat PROM image from a
LEON ELF.

## Toolchain prerequisite

`mkprom2` is the Gaisler PROM image builder, distributed as a separate package
(not part of RCC). The Makefile expects the binary at:

```
toolchain/mkprom2-2.0.69/mkprom2/mkprom2
```

Toolchain archives are not tracked in git — see `toolchain/README.md` for the
download sources and version list.

**One-time system setup.** `mkprom2` was built with `/opt/mkprom2` baked in as
its install root and refuses to find its support files (linker scripts, prom
loader objects under `lib/`) anywhere else. Create a symlink once:

```bash
sudo ln -s $(pwd)/toolchain/mkprom2-2.0.69/mkprom2 /opt/mkprom2
```

(Run from the repo root.) The MKPROM2 User's Manual (section "Source code")
documents this — the package is designed to live at `/opt/mkprom2`.

If you already have `mkprom2` installed elsewhere, override at build time:

```bash
make MKPROM=/path/to/mkprom2
```

## Build and run

```bash
cd apps/04-mkprom-boot
make            # mkprom_boot.exe -> gr712rc-prom.elf -> gr712rc-prom.bin
make run        # qemu-system-sparc -M gr712rc -nographic -bios ./gr712rc-prom.bin
```

The build has three steps:

1. `sparc-gaisler-rtems5-gcc` compiles the RTEMS app into `mkprom_boot.exe`.
2. `mkprom2` wraps the ELF with its loader, producing `gr712rc-prom.elf`.
3. `objcopy -O binary` flattens that ELF into `gr712rc-prom.bin`. QEMU's
   `-bios` path loads the file verbatim into PROM, so it must be a flat
   image — feeding the mkprom2 ELF directly results in the CPU executing
   the ELF header as instructions and trapping immediately.

Expected console output:

```
  MKPROM2 boot loader v2.0.69
  Copyright Cobham Gaisler AB - all rights reserved

  system clock   : 50.0 MHz
  baud rate      : 38343 baud
  prom           : 8192 K, (15/15) ws (r/w)
  sram           : 65536 K, 1 bank(s), 3/3 ws (r/w)

  decompressing .text to 0x40000000
  decompressing .rtemsroset to 0x400314d0
  decompressing .data to 0x40035580

  starting mkprom_boot.exe

[mkprom-boot] RTEMS booted from MkProm PROM image
[mkprom-boot] CPU 0: 100
[mkprom-boot] CPU 1: 200
[mkprom-boot] CPU 0: 101
[mkprom-boot] CPU 1: 201
...
```

Press **Ctrl-A X** to exit QEMU.

## Notes

- The PROM image must fit in 8 MiB (`GR712RC_PROM_SIZE`); the small dual-core
  app here lands around 125 KiB. Tune `-romsize` if you build something larger.
- The QEMU FTMCTRL stub absorbs MkProm's MCFG1/MCFG2 writes without applying
  any real wait-state effects, so timing knobs in the firmware are cosmetic
  in emulation.
- SMP CPU release goes through the existing IRQMP MPSTATUS path; no extra
  QEMU support is needed beyond what the other dual-core examples already
  exercise.
- `mkprom2` v2.0.69 has a printf typo in its compiler auto-detect for
  `sparc-gaisler-rtems5-gcc`, so this Makefile passes `-ccprefix
  sparc-gaisler-rtems5` explicitly. mkprom2 appends `-gcc` internally — the
  trailing dash must NOT be in the prefix.
