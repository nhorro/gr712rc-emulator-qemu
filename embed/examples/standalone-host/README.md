# standalone-host

A host program that **lives entirely outside the QEMU source tree**
and links against `libqemu-sparc.so` to embed a GR712RC or GR740
machine in-process. The host's only contact with QEMU is:

- `libqemu-sparc.so` — the shared library binary.
- `libqemu.h` — the SDK header that declares the public C ABI of
  the .so (~13 functions plus types and enum constants).

No QEMU internal headers, no QEMU build system, no QEMU source
needed. The pair `libqemu.{so,h}` is the complete SDK; everything
else is example code.

```
qemu/                                      ← SDK source
    include/libqemu.h                      ← public API header (SDK)
    build/libqemu-sparc.so                 ← built shared library (SDK)
    system/embed_api.{c,map}               ← fork's internal helpers
                                             + linker version script

embed/                                     ← consumer code
    embed_qemu.{h,c}                       ← *example* wrapper around
                                             libqemu.h (init/step/cleanup)
    examples/
        standalone-host/
            main.c                         ← own int main()
            Makefile                       ← plain gcc + linker
            README.md                      ← this file
```

The wrapper `embed_qemu.{h,c}` is *one possible way* to consume the
SDK. A different host could write its own wrapper directly against
`libqemu.h` (e.g. for an event-driven step pattern, or a custom
clock policy) without touching anything in the QEMU submodule.

## How it links

```
+--------------------------+        +-------------------------+
| standalone-host (binary) |        | embed_qemu.o (wrapper)  |
|--------------------------|        |-------------------------|
| main.o                   | <----> | embed_qemu_init  -+     |
|   #include "embed_qemu.h"|        | embed_qemu_step  -+---> |   qemu_init
+--------------------------+        | embed_qemu_cleanup       |   vm_start
                                    |   #include <libqemu.h>   |   vm_stop
                                    +--------------------------+   main_loop_wait
                                                                   ...
                                                                    |
                                                                    v
                                                +------------------------------+
                                                | libqemu-sparc.so             |
                                                | (exports 13 symbols, pinned  |
                                                |  by system/embed_api.map)    |
                                                +------------------------------+
                                                                    ^
                                                                    | declared by
                                                                    |
                                                +------------------------------+
                                                | qemu/include/libqemu.h       |
                                                | (the SDK header — types,     |
                                                |  enums, function prototypes) |
                                                +------------------------------+
```

## One-time setup

Just one command from this directory:

```bash
make qemu-lib-setup
```

That target configures `qemu/build` (if needed), enables
`b_staticpic=true` (required so the static libs the `.so` pulls
objects from are PIC-compatible), and runs `ninja libqemu-sparc.so`.
Idempotent — re-running it is safe.

Subsequent fast rebuilds of just the library: `make qemu-lib`.

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

## Error handling

`embed_qemu_init()` intercepts `exit()` calls from inside QEMU
(common via `&error_fatal` paths — bad kernel path, unknown
machine, missing dependency). Instead of taking the host down with
QEMU, `embed_qemu_init()` returns a *positive* code (the value QEMU
tried to pass to `exit()`).

```c
int rc = embed_qemu_init(qargc, qargv);
if (rc != 0) {
    fprintf(stderr, "QEMU init failed: rc=%d\n", rc);
    return rc;   /* don't reuse the lib — see below */
}
```

Mechanism: `embed_qemu.c` defines its own `exit()`. The dynamic
linker prefers the executable's definition over libc's for all
calls made by `libqemu-sparc.so`. When inside `embed_qemu_init()`,
our `exit()` longjmps back to a `setjmp` at the start of init().
Outside of init(), it forwards to `_exit()` so normal host
termination still works.

**Critical caveat**: after a non-zero return, QEMU's internal
state is corrupt (the longjmp left locks, fds, and threads
half-initialized). The host **MUST NOT** call any other
`embed_qemu_*` function. Terminate cleanly and start fresh if a
retry is needed. The included test demonstrates that a second
`embed_qemu_init()` call after a failure crashes with
`ran out of space in drive_config_groups`.

## Other caveats

- `libqemu.h` hardcodes numeric values for the `QEMUClockType` and
  `RunState` enums (e.g. `RUN_STATE_PAUSED = 4`). If QEMU upstream
  renumbers these enums, `libqemu.h` becomes a lie. The `.so` build
  catches that automatically: `system/embed_api.c` has
  `_Static_assert` checks that fail the build with a "drifted"
  message. Update `libqemu.h` to match if it ever fires.
- The host inherits all of `libqemu-sparc.so`'s runtime
  dependencies (glib, pixman, etc. — see `ldd standalone-host`).
  These are loaded into the host process whether or not it uses
  them directly.
- The `.so` exports exactly 13 symbols (plus a version tag), pinned
  by `qemu/system/embed_api.map`. Adding new functionality requires
  appending to that linker version script *and* adding the
  prototype to `libqemu.h`.
- `abort()` paths (used by some QEMU error_abort sites) are NOT
  intercepted — only `exit()` is. A small number of QEMU errors
  will still kill the host.
