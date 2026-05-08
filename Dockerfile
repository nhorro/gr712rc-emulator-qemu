# syntax=docker/dockerfile:1.7
#
# QEMU GR712RC / GR740 emulator container — Phase 1 (issue #14).
#
# Stage 1 builds qemu-system-sparc from the bundled fork sources.
# Stage 2 ships only the runtime artifacts: QEMU binary, pc-bios files,
# and the shared libraries QEMU needs to start.
#
# The Python adapter service (Phase 2) will be added on top of this image
# without changing the runtime base.

#######################################################################
# Stage 1: build QEMU
#######################################################################
FROM debian:bookworm-slim AS qemu-builder

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ninja-build \
        pkg-config \
        python3 \
        python3-pip \
        python3-venv \
        libglib2.0-dev \
        libpixman-1-dev \
        libslirp-dev \
        liblua5.4-dev \
        libyaml-dev \
        bison \
        flex \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY qemu/ ./qemu/

# Configure for SPARC soft-MMU only. --disable-werror tolerates harmless
# warnings from the bundled fork. --prefix is where `ninja install` puts
# the binary, pc-bios files, etc., so stage 2 can copy a single tree.
RUN cd qemu && \
    mkdir -p build && cd build && \
    ../configure \
        --target-list=sparc-softmmu \
        --prefix=/qemu-install \
        --disable-werror \
        --disable-docs \
        --disable-gtk \
        --disable-sdl \
        --disable-vnc \
        --disable-curses \
        --disable-tools && \
    ninja -j"$(nproc)" && \
    ninja install && \
    strip /qemu-install/bin/qemu-system-sparc

#######################################################################
# Stage 2: runtime image
#######################################################################
FROM python:3.12-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libpixman-1-0 \
        libslirp0 \
        liblua5.4-0 \
        libyaml-0-2 \
    && rm -rf /var/lib/apt/lists/*

# QEMU binary + pc-bios + share files from the builder.
COPY --from=qemu-builder /qemu-install /usr/local

# Working directory for ELF uploads (Phase 2 will write here).
RUN mkdir -p /var/uploads
WORKDIR /work

# Phase 1: no service yet. The default command prints the QEMU version
# so a `docker run --rm <image>` confirms the build works. Override with
# any qemu-system-sparc invocation, e.g.:
#
#   docker run --rm -it -v $(pwd)/apps/01-hello-rtems:/work \
#       <image> qemu-system-sparc -M gr712rc -nographic -kernel hello.exe
#
# Phase 2 will replace the CMD with the FastAPI service entrypoint.
CMD ["qemu-system-sparc", "--version"]
