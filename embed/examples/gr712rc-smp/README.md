# GR712RC dual-core embedding example

Same shape as the [gr740-hello](../gr740-hello/README.md) example —
a custom `main()` calls `embed_qemu_init / step / cleanup` and
drives a guest forward in 1 ms wall-clock slices — but targeting
the **GR712RC LEON3FT dual-core** machine with a true SMP RTEMS
guest ([`apps/02-dual-core-timer`](../../../apps/02-dual-core-timer)).

This example exists to validate that the embedding API
[`embed_qemu.{h,c}`](../../../qemu/examples/embed-common/) really is
arch-agnostic, and to surface what (if anything) deserves to be
shared between examples beyond that.

## Build

The embedder binary is built from the QEMU build tree:

```bash
cd qemu/build && ninja embed-gr712rc-smp
```

(Both `embed-gr740` and `embed-gr712rc-smp` are registered in
`qemu/meson.build`'s `embed_examples` table. Adding a third is one
entry.)

## Run

From the repo root:

```bash
make -C embed/examples/gr712rc-smp run
```

Expected UART output (abbreviated):

```
Core 0: 10
Core 1: 20
Core 0: 11
Core 1: 21
Core 0: 12
Core 1: 22
```

Each core prints once per virtual second; at the default budget of
3000 steps × ~1 ms wall ≈ 3.5 s, you should see 2-3 lines per core.

The step-loop summary on stderr:

```
steps completed:  3000 / 3000
terminated by:    step budget
total wall:       ~3560 ms
mean wall/step:   ~1186000 ns
```

Mean wall/step ≈ 1.19 ms is the expected SMP operating point
(p50 ≈ 1.17× the requested 1 ms). The +7% over the single-core
gr740-hello example matches the SMP penalty documented in
[`NOTES.md`](../../../NOTES.md).

## Variables

| Variable  | Default | Meaning                       |
|---        |---      |---                            |
| `DT_US`   | 1000    | Step size in microseconds     |
| `N_STEPS` | 3000    | Total number of steps to run  |

```bash
make -C embed/examples/gr712rc-smp run DT_US=500 N_STEPS=6000
```

## Architecture

The C source lives in
[`qemu/examples/embed-gr712rc-smp/main.c`](../../../qemu/examples/embed-gr712rc-smp/main.c),
the API in
[`qemu/examples/embed-common/embed_qemu.{h,c}`](../../../qemu/examples/embed-common/),
both inside the QEMU submodule for the same build-system reasons
described in `gr740-hello/README.md`. When `libqemu-system-sparc.so`
becomes available, both `main.c` files and `embed_qemu.{h,c}`
migrate out of the submodule together.

## Notes

- The gr712rc QEMU machine instantiates 2 CPUs internally (see
  `qemu/hw/sparc/gr712rc.c::gr712rc_hw_init`); no `-smp` flag is
  passed in the embedder's argv. The BSP picked at guest build time
  (`gr712rc_smp` for this kernel) is what tells RTEMS to use both.
- The `dual_core_timer` guest runs forever — there is no `exit()`
  path, so the step loop always terminates by "step budget". This
  is the opposite of the gr740-hello guest, which reaches
  `exit(0)`. Together they exercise both termination paths of the
  embedder.
