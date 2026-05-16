# standalone-host

A host program that **lives entirely outside the QEMU source tree**
and links against `libqemu-sparc.so` to embed a GR712RC or GR740
machine in-process. This is the "real" embedding model: the host
needs only the shared library plus a single header
(`embed/embed_qemu.h`); it doesn't include any QEMU header, doesn't
use QEMU's build system, and doesn't ship QEMU source.

```
embed/
    embed_qemu.h        ← consumer-side wrapper API (3 functions)
    embed_qemu.c        ← consumer-side wrapper impl (forward-decl QEMU API)
    examples/
        standalone-host/
            main.c      ← own int main() — argv → step loop → cleanup
            Makefile    ← plain gcc + linker; no meson
            README.md   ← this file
            standalone-host  (the built binary)

qemu/
    build/
        libqemu-sparc.so   ← QEMU as library; supports -M gr712rc and -M gr740
    system/embed_api.c     ← in-submodule helper that wraps the static-inline
                             timer_new_ns / timer_free as real exported symbols
```

## How it links

```
+--------------------------+        +--------------------------+
| standalone-host (binary) |        | embed_qemu.o (wrapper)   |
|--------------------------|        |--------------------------|
| main.o                   | <----> | embed_qemu_init  -+      |
|   uses embed_qemu_init() |        | embed_qemu_step  -+--->  |
|   uses embed_qemu_step() |        | embed_qemu_cleanup        |  qemu_init
|   uses embed_qemu_cleanup|        | (forward-decl QEMU API:   |  vm_start
+--------------------------+        |  qemu_init, vm_start,     |  vm_stop
                                    |  main_loop_wait, ...)     |  main_loop_wait
                                    +---------------------------+  ...
                                                                    |
                                                                    v
                                                +------------------------------+
                                                | libqemu-sparc.so             |
                                                |  - native QEMU API (qemu_init|
                                                |    vm_start, timer_mod_ns…)  |
                                                |  - embed_timer_new_ns/free   |
                                                |    (wrap static inlines)     |
                                                |  - libqemu_embed_version     |
                                                |  - 8.2.2 emulator core       |
                                                +------------------------------+
```

## One-time setup

The `.so` is not built by QEMU's default configure. You need
`b_staticpic=true` so the static libraries that the `.so` pulls
objects from are PIC-compatible:

```bash
cd qemu && mkdir -p build && cd build
../configure --target-list=sparc-softmmu
./pyvenv/bin/meson configure -Db_staticpic=true
ninja libqemu-sparc.so
```

Subsequent rebuilds: `ninja libqemu-sparc.so` from `qemu/build/`.

## Build the host

```bash
make -C embed/examples/standalone-host
```

This compiles `main.c` and `../../embed_qemu.c` with plain `gcc`,
then links against `libqemu-sparc.so` via `-L`, `-l`, and `-Wl,-rpath`.
No QEMU includes, no meson.

## Run

```bash
make -C embed/examples/standalone-host run-gr740
make -C embed/examples/standalone-host run-gr712rc
```

Or invoke the binary directly:

```bash
./standalone-host gr740   apps/07-hello-gr740/hello.exe         1000 2000
./standalone-host gr712rc apps/02-dual-core-timer/dual_core_timer.exe 1000 3000
```

Expected output (UART captured to `/tmp/standalone-host-<machine>-uart.log`):

```
*** GR740 RTEMS Hello World ***
Running on QEMU
*** END OF TEST ***
```

```
Core 0: 10
Core 1: 20
Core 1: 21
Core 0: 11
Core 0: 12
Core 1: 22
```

Measured wall/step at the 1 ms operating point:

| Machine  | mean wall/step | matches NOTES.md prediction |
|---       |---             |---                           |
| gr740    | ~1.12 ms       | p50 = 1.10× single-core      |
| gr712rc  | ~1.20 ms       | p50 = 1.17× SMP              |

## What is `embed_qemu`?

A 90-line wrapper (`embed/embed_qemu.{h,c}`) that gives the host a
3-function API in exchange for managing the iothread mutex, the
deadline timer, and the runstate check internally. Without it the
host would have to call ~12 QEMU functions in a specific order to
do a single step — the wrapper hides that contract behind:

```c
embed_qemu_init(qargc, qargv);
for (...) {
    EmbedStepStats st;
    embed_qemu_step(dt_ns, &st);
    if (st.guest_left_running_state) break;
}
embed_qemu_cleanup();
```

The wrapper's `.c` source has no QEMU `#include`s. It forward-
declares only the symbols it links against:

```c
extern void qemu_init(int argc, char **argv);
extern void vm_start(void);
extern bool main_loop_wait(bool nonblocking);
/* ... */
#define QEMU_CLOCK_REALTIME 0
#define RUN_STATE_PAUSED    4
```

Two QEMU functions are `static inline` in `qemu/include/qemu/timer.h`
and therefore have no ELF symbol. The fork's `.so` exports paper-
thin forwarders (`embed_timer_new_ns`, `embed_timer_free`) defined
in `qemu/system/embed_api.c`. The wrapper uses those instead.

## How is this different from the older in-tree examples?

Earlier iterations placed `embed_qemu.{h,c}` and the host `main.c`
inside `qemu/examples/`, built by QEMU's meson as in-tree
executables (`embed-gr740`, `embed-gr712rc-smp`). That worked but
left the consumer code tangled with QEMU's build.

This iteration moves all consumer code outside the submodule. The
submodule's `meson.build` produces only the `.so` (plus the
`embed_api.c` helpers); everything that uses the `.so` lives in
`embed/` and builds with a plain `gcc` invocation. That is the
distinction between "QEMU has an example that drives itself" and
"a third-party program embeds QEMU".

## Caveats

- The `.so` exports a very wide symbol surface (~all of QEMU). A
  production embedder would tighten this with `-fvisibility=hidden`
  + an explicit export list. Not done here.
- `embed_qemu.c`'s forward declarations encode the values of
  `RUN_STATE_PAUSED` and `QEMU_CLOCK_REALTIME` from QEMU 8.2.2.
  If those change upstream, update `embed_qemu.c` to match.
- The host inherits all of `libqemu-sparc.so`'s runtime
  dependencies (glib, pixman, etc. — see `ldd standalone-host`).
  These are loaded into the host process whether or not it uses
  them directly.
- QEMU's `error_fatal` paths still call `exit()`; embedding
  arbitrarily-bad inputs can still take the host process down.
  Hardening that is "deuda" #2 in `NOTES.md` "Open technical
  issues".
