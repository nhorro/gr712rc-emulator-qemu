# Contributing and Development Workflow

## Repository structure

This project uses two git repositories:

| Repo | Purpose | Branch |
|------|---------|--------|
| `qemu-gr712rc` (this repo) | Apps, docs, toolchain README, submodule pointer | `main` |
| `qemu-gr712rc-fork` (submodule at `qemu/`) | Patched QEMU 8.2.2 source | `gr712rc` |

Clone everything in one step:

```bash
git clone --recurse-submodules git@github.com:nhorro/qemu-gr712rc.git
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

---

## Editing QEMU source files

The `qemu/` directory is a git submodule — it is a full, independent git
repository that happens to live inside this one.  Changes to QEMU files
require two separate commits: one inside the submodule, and one in the
parent repo to advance the submodule pointer.

### Step-by-step

```bash
# 1. Edit files inside qemu/ as normal
#    Example: adding a new peripheral
vim qemu/hw/sparc/gr712rc.c
vim qemu/hw/can/grlib_occan.c

# 2. Build and test from qemu/build/
cd qemu/build
make -j$(nproc) qemu-system-sparc
cd ../..
make -C apps/02-dual-core-timer run

# 3. Commit the QEMU changes (inside the submodule)
cd qemu
git add hw/sparc/gr712rc.c hw/can/grlib_occan.c
git commit -m "Add OCCAN stub peripheral"
git push origin gr712rc   # pushes to qemu-gr712rc-fork, branch gr712rc
cd ..

# 4. Update the submodule pointer in the parent repo
git add qemu
git commit -m "Update QEMU submodule: add OCCAN stub"
git push origin main
```

Step 4 is often forgotten — without it, the parent repo still points to the
old QEMU commit and collaborators won't see your QEMU changes after cloning.

### Why two commits?

The parent repo stores a submodule entry as a single SHA (the commit in the
fork that `qemu/` should be checked out at).  This is what `git add qemu`
stages — not the file contents, just the pointer.  Both commits must be
pushed for collaborators to get a consistent state.

---

## Editing apps or docs

Apps and docs live directly in the parent repo — no submodule involved.

```bash
# Edit, build, commit, push as normal
vim apps/02-dual-core-timer/dual_core_timer.c
make -C apps/02-dual-core-timer
git add apps/02-dual-core-timer/dual_core_timer.c
git commit -m "Fix task affinity setup"
git push origin main
```

---

## Setting up the toolchain

The RCC 1.3.2 toolchain is not stored in git (it is 1.3 GB).  Download it
from the [Gaisler downloads page](https://www.gaisler.com/index.php/downloads/compilers)
and extract into `toolchain/`:

```bash
cd toolchain
tar xf rcc-1.3.2-linux.txz   # produces rcc-1.3.2-gcc/
```

The app Makefiles locate the toolchain via a relative path and need no further
configuration.

---

## Building QEMU from scratch

If you cloned fresh (no pre-built `qemu/build/`):

```bash
cd qemu
mkdir -p build && cd build
../configure --target-list=sparc-softmmu
make -j$(nproc)
```

---

## Keeping in sync with upstream QEMU

When a new QEMU release is relevant, the process is:

```bash
cd qemu

# Add upstream as a remote (one-time)
git remote add upstream https://github.com/qemu/qemu.git

# Fetch the new tag and rebase our single commit on top of it
git fetch upstream tag v8.X.Y --depth=1
git rebase v8.X.Y

# Push the rebased branch to the fork
git push origin gr712rc --force-with-lease
cd ..

# Bump the submodule pointer
git add qemu
git commit -m "Rebase QEMU patches on v8.X.Y"
git push origin main
```
