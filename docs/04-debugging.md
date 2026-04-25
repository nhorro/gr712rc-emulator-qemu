# Debugging Guide

Techniques for diagnosing problems in the QEMU GR712RC emulation, from RTEMS
application bugs all the way down to TCG translation issues.

---

## 1. GDB remote debugging (most useful starting point)

QEMU includes a built-in GDB server.  Launch QEMU with `-s -S`:

```bash
./qemu/build/qemu-system-sparc \
    -M gr712rc -nographic \
    -kernel apps/02-dual-core-timer/dual_core_timer.exe \
    -s -S          # -s = GDB server on :1234, -S = pause at reset
```

In a second terminal, start the SPARC GDB from the RCC toolchain:

```bash
./toolchain/rcc-1.3.2-gcc/bin/sparc-gaisler-rtems5-gdb \
    apps/02-dual-core-timer/dual_core_timer.exe

(gdb) target remote :1234
(gdb) continue
```

### Useful GDB commands for SPARC/RTEMS

```gdb
# Show SPARC PSR (Processor State Register)
info registers psr

# Show all SPARC registers
info registers all

# Decode PSR fields manually:
#   bit 12 = EF (FPU enabled)   bit 5 = ET (traps enabled)
#   bits 11:8 = PIL              bit 7 = S (supervisor)
#   bits 4:0 = CWP (current window)

# Break on RTEMS fatal handler
break _Terminate
break rtems_fatal

# Break on a specific SPARC trap
# (set a breakpoint at the trap table entry + offset)

# Examine memory (e.g., IRQMP pending register)
x/1wx 0x80000204

# Examine GPTIMER scaler
x/1wx 0x80000300

# Print RTEMS per-CPU state
print *_Per_CPU_Information[0]
print *_Per_CPU_Information[1]
```

### Catching RTEMS fatal errors

RTEMS fatal errors call `_Terminate` with a source, is-internal flag, and code.
Break there to catch any fatal before the CPU halts:

```gdb
break _Terminate
run
# When it stops, print the arguments:
info args
# Or look at the o-registers (SPARC calling convention: %o0, %o1, %o2)
info registers o0 o1 o2
```

Common codes to look for:

| Code | Meaning |
|------|---------|
| 38 | `INTERNAL_ERROR_ILLEGAL_USE_OF_FLOATING_POINT_UNIT` — task used FP with PSR.EF=0.  Fix: create the task with `RTEMS_FLOATING_POINT`. |
| 5 | `INTERNAL_ERROR_TOO_MANY_OPEN_FILES` |
| 16 | `INTERNAL_ERROR_THREAD_QUEUE_ENQUEUE_FROM_BAD_STATE` |

### SMP note

In SMP mode QEMU exposes two GDB "threads" (one per vCPU).  You can switch
between them with:

```gdb
info threads
thread 2      # switch to CPU 1's context
info registers
```

---

## 2. QEMU monitor

Press **Ctrl-A C** in a `-nographic` session to enter the QEMU monitor.  Useful
commands:

```
(qemu) info registers          # dump all CPU registers (CPU 0)
(qemu) info cpus               # list CPUs and halted/running state
(qemu) info mtree              # print the full memory region tree
(qemu) xp /4wx 0x80000200      # examine 4 words at IRQMP base
(qemu) x /10i $pc              # disassemble 10 instructions at PC
(qemu) stop / cont             # pause / resume execution
(qemu) quit
```

`info mtree` is particularly useful for confirming that a newly added device's
`MemoryRegion` is mapped at the expected address.

---

## 3. Tracing QEMU device activity

QEMU has a trace subsystem — many GRLIB device operations are already instrumented.

### List available trace events

```bash
./qemu/build/qemu-system-sparc -trace help 2>&1 | grep grlib
```

### Enable traces at runtime

```bash
./qemu/build/qemu-system-sparc -M gr712rc -nographic \
    -trace grlib_irqmp_set_irq \
    -trace grlib_gptimer_enable \
    -kernel apps/02-dual-core-timer/dual_core_timer.exe
```

Or enable all GRLIB events:

```bash
-trace "grlib*"
```

Trace output goes to stderr by default.  To write to a file:

```bash
-trace "grlib*,events=/dev/null" ... 2>trace.log
```

### Adding trace events to a new device

1. Create `hw/<subsystem>/trace-events` with one event per line:
   ```
   grlib_occan_read(uint32_t addr, uint32_t val) "addr=0x%08x val=0x%08x"
   grlib_occan_write(uint32_t addr, uint32_t val) "addr=0x%08x val=0x%08x"
   ```

2. Add `#include "trace.h"` to your `.c` file.

3. Call `trace_grlib_occan_read(addr, val)` in the read callback.

4. Add the events file to `hw/<subsystem>/meson.build`:
   ```meson
   system_ss.add(when: 'CONFIG_GRLIB', if_true: files('grlib_occan.c'))
   ```
   And register the trace file in the same `meson.build`:
   ```meson
   hw_arch['sparc'].add(when: 'CONFIG_GRLIB', if_true: trace_events('trace-events'))
   ```

---

## 4. fprintf debugging (quick and dirty)

For rapid prototyping, `fprintf(stderr, ...)` is the fastest way to add
instrumentation.  All GRLIB files already include `<stdio.h>` transitively.

```c
static void grlib_occan_write(void *opaque, hwaddr addr,
                              uint64_t value, unsigned size)
{
    fprintf(stderr, "[OCCAN] write addr=0x%02x val=0x%08x\n",
            (unsigned)addr, (unsigned)value);
    /* ... */
}
```

Remove these before committing; they fire on every register access and will
flood output from RTEMS startup code that scans all APB devices.

---

## 5. Common failure modes

### RTEMS halts silently at startup

Likely cause: `bsp_fatal_extension` polling MPSTATUS.  This happens when a
secondary CPU fails to reach its ready state.  Symptoms: ~1.2 million identical
reads of address 0x80000210 in a trace.  Check:

- `gr712rc_cpu_start` is wired — `qdev_connect_gpio_out_named` for `"cpu-start"`
  in `gr712rc_hw_init`.
- CPU 1 is started halted (`cs->halted = 1`) and released when the GPIO fires.
- `%asr17` returns the correct CPU index (bits [31:28]) for each CPU.

### `INTERNAL_ERROR_ILLEGAL_USE_OF_FLOATING_POINT_UNIT` (code 38)

The task called a function that emits FP instructions (commonly `printf` via
`_vfprintf_r`) but was created without `RTEMS_FLOATING_POINT`.  In RTEMS SMP
mode, lazy FP switching is disabled; a `fp_disabled` trap is always fatal.

Fix: add `RTEMS_FLOATING_POINT` to the task attribute mask:

```c
rtems_task_create(name, priority, RTEMS_MINIMUM_STACK_SIZE,
                  RTEMS_DEFAULT_MODES, RTEMS_FLOATING_POINT, &tid);
```

### Data cache snooping abort

RTEMS LEON3 SMP calls `leon3_data_cache_snooping_enabled()` at startup; it
reads the cache control register (ASI 2, address 0) and checks bit 23
(`CACHE_CTRL_DS`).  If not set, the BSP calls `bsp_fatal`.

The GR712RC machine sets `env->cache_control = CACHE_CTRL_DS` in
`gr712rc_cpu_reset` for both CPUs.  If you add a new CPU or re-implement reset,
make sure this field is set.

### Wrong CPU ID — both CPUs take the primary path

RTEMS `start.S` reads `%asr17`, shifts bits [31:28], and compares to determine
whether to take the primary or secondary boot path.  If both CPUs return 0,
both try to initialise all peripherals and the timer reset on CPU 1 corrupts
CPU 0's clock tick.

Verify `cpu_sparc_set_id(env, i)` is called for each CPU in `gr712rc_hw_init`
and that `do_rd_leon3_config` in `translate.c` loads `env->leon3_cpuid` at
runtime (not a compile-time constant).

### Device not found by RTEMS PnP scanner

The BSP uses the AHB and APB Plug&Play ROMs to discover devices.  If a device
is missing from the PnP ROM, the BSP driver won't find it and will not use it.

Check that `grlib_apb_pnp_add_entry` (or `grlib_ahb_pnp_add_entry` for AHB
devices) is called with the correct vendor ID, device ID, and base address.  The
IDs must match what the RTEMS driver expects — look them up in the GRLIB User's
Manual or in the RTEMS BSP PnP scanner source.

### New device memory region not mapped

Run `info mtree` in the QEMU monitor and verify the device's address range
appears.  If it is missing, `sysbus_mmio_map` was not called or
`sysbus_realize_and_unref` failed (check for error messages on stderr).

### IRQ never delivered to the CPU

1. Confirm `sysbus_connect_irq` connects the device output to the IRQMP input
   at the correct line index.
2. Confirm the RTEMS task has the interrupt unmasked in the IRQMP mask register
   (`LEON3_IrqCtrl_Regs->mask[cpu] |= 1 << irq_line`).
3. Enable `grlib_irqmp_*` traces to see whether the pending bit is being set.
4. Check PSR.PIL (bits 11:8): RTEMS runs tasks with PIL=0 (all interrupts
   enabled), but ISRs raise PIL.

---

## 6. Rebuilding after changes

```bash
# From the build directory:
cd qemu/build
make -j$(nproc) qemu-system-sparc

# Then run:
./qemu-system-sparc -M gr712rc -nographic \
    -kernel ../../apps/02-dual-core-timer/dual_core_timer.exe
```

Meson tracks dependencies precisely; only translation units that depend on
modified files are recompiled.  A typical one-file change takes a few seconds.

---

## 7. QEMU log flags (`-d`) and the `gr712rc-diag` catcher

When a real GR712RC application runs against this incomplete emulator, the
most common failure modes are (a) accessing an unmodeled peripheral
register, and (b) hitting a SPARC trap (illegal instruction, alignment,
unhandled register-window overflow, etc.). The flags below cover both.

### Recommended flag combo

```bash
./qemu/build/qemu-system-sparc -M gr712rc -nographic \
    -d guest_errors,unimp,int \
    -D /tmp/qemu.log \
    -kernel <app>.exe
```

| Flag           | What it logs                                                                |
|----------------|-----------------------------------------------------------------------------|
| `guest_errors` | `[gr712rc-diag]` lines for unmodeled-peripheral accesses (see below)        |
| `unimp`        | Same `[gr712rc-diag]` lines plus other "unimplemented" device messages      |
| `int`          | Every SPARC trap entry (trap number, CPU, PC) — useful for crashes          |

`-D <file>` redirects the log to a file; without it, `-d` output goes to
stderr and intermixes with the guest's serial output.

### The `gr712rc-diag` catcher

`gr712rc_install_amba_diag()` registers a low-priority `MemoryRegion`
covering both APB bridges (`0x80000000`–`0x80200000`, 2 MiB). Real and
scripted devices override it via subregion priority and behave normally;
anything that falls through gets a tagged log line:

```
[gr712rc-diag] CPU0 PC=0x4000146c: unmapped write at 0x80000a00 size=4 value=0x12345678
[gr712rc-diag] CPU0 PC=0x40001474: unmapped read  at 0x80000a00 size=4 -> 0
```

Reads return 0; writes are no-ops. The goal is *visibility*, not
faithfulness to GR712RC bus-error semantics — a real chip would raise a
`data_access_exception` here, but trapping makes the failure point harder
to find than logging does.

When you see one of these lines while running a real app, the address is
a peripheral that needs either (a) a real QEMU device model, or (b) a
Lua-driven stub via the scriptable-device YAML config (see
[apps/05-scriptable-stub/](../apps/05-scriptable-stub/)).

### Cross-referencing PC with the application

The PC in the diag line is a guest-virtual address. To find the source
location, use `objdump`:

```bash
sparc-gaisler-rtems5-objdump -d <app>.exe | grep -B2 '4000146c:'
```

Or run the app under GDB (see §1) and `break *0x4000146c` to stop at the
exact instruction that performs the access.

