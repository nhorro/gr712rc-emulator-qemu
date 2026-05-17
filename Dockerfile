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
        git \
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
#
# b_staticpic=true makes the bundled static libs PIC so they can be
# linked into libqemu-sparc.so (the embedding-SDK shared library used by
# the qemu-system-sparc-embed wrapper below). Without this flag meson
# refuses to build a shared library out of these objects.
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
        --disable-tools \
        -Db_staticpic=true && \
    ninja -j"$(nproc)" libqemu-sparc.so && \
    ninja install && \
    strip /qemu-install/bin/qemu-system-sparc && \
    install -D -m 0755 libqemu-sparc.so /qemu-install/lib/libqemu-sparc.so

# Build the embedding wrapper qemu-system-sparc-embed. This is the
# drop-in replacement for qemu-system-sparc that the FastAPI service
# uses when QEMU_BINARY=qemu-system-sparc-embed. Same argv shape,
# different implementation (host process linking libqemu-sparc.so).
COPY embed/ /src/embed/
COPY apps/  /src/apps/
RUN gcc -Wall -Wextra -O2 \
        -I/src/embed -I/src/qemu/include \
        /src/embed/examples/qemu-service/main.c \
        /src/embed/embed_qemu.c \
        -L/src/qemu/build -lqemu-sparc \
        -Wl,-rpath,/usr/local/lib \
        -o /qemu-install/bin/qemu-system-sparc-embed && \
    strip /qemu-install/bin/qemu-system-sparc-embed

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

# QEMU binary + pc-bios + share files + libqemu-sparc.so + the
# qemu-system-sparc-embed wrapper from the builder. ldconfig picks up
# /usr/local/lib so the dynamic loader finds libqemu-sparc.so without
# LD_LIBRARY_PATH.
COPY --from=qemu-builder /qemu-install /usr/local
RUN ldconfig

# Adapter service. Installed editable so a bind-mount of service/ during
# development picks up code changes without an image rebuild.
COPY service/ /opt/service/
RUN pip install --no-cache-dir /opt/service

# Bundled web UI. Served at /ui/ with a redirect from /. Optional — if
# you want a headless API-only image, omit this COPY and main.py will
# skip the static mount.
COPY ui/ /opt/ui/

ENV UPLOADS_DIR=/var/uploads
ENV UI_DIR=/opt/ui
RUN mkdir -p /var/uploads
WORKDIR /opt/service

EXPOSE 8080
CMD ["uvicorn", "adapter.main:app", \
     "--host", "0.0.0.0", "--port", "8080", \
     "--log-level", "info"]
