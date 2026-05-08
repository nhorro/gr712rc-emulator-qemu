# Portable export — moving the demo to another PC

This guide covers shipping the running emulator-plus-UI demo to another
machine **without** building from source there. The target PC only needs
Docker; it does not need the toolchain, the QEMU sources, or even this
git repo.

The flow is:

```
[ source PC ] docker save → .tar.gz   →   USB / scp / shared drive
                                              ↓
                              [ target PC ] docker load → docker compose up
```

---

## 1. Prerequisites on the target PC

- **Docker Engine 24+** with the `compose` plugin (or **Docker Desktop**
  on Windows / macOS — both ship `docker compose` out of the box).
- **CPU architecture must match the source PC.** The image we build is
  `linux/amd64`. If your work PC is x86_64 / Intel / AMD, you're fine.
  If it's an ARM machine (Apple Silicon, Windows-on-ARM, Raspberry Pi),
  Docker Desktop will run the amd64 image under emulation but
  performance will suffer; rebuild for `linux/arm64` instead (see §6).
- **Free disk space**: ~600 MiB (the loaded image plus ~250 MiB of
  Docker layer cache). The transferred tarball is ~70 MiB
  (gzip compresses the 289 MiB image about 4:1).
- **Free network port 8080**, or pick another and adjust the published
  port mapping (see §5).

No source code, no toolchain, no Python — the image bundles everything.

---

## 2. On the source PC: save the image

From the repo root, build a fresh image (skip if you already did
`docker compose up --build` recently and haven't changed sources since):

```bash
docker compose build emulator
# or:
docker build -t qemu-gr712rc-emulator:latest .
```

Save and gzip in one pipeline:

```bash
docker save qemu-gr712rc-emulator:latest | gzip > qemu-gr712rc-emulator.tar.gz
```

Expected output size: **~70 MiB** (the 289 MiB image compresses about
4:1 since most of the layers are uncompressed binaries and Python
source).

Verify the file is not truncated:

```bash
gzip -t qemu-gr712rc-emulator.tar.gz && echo "ok"
ls -lh qemu-gr712rc-emulator.tar.gz
```

You also need a small `docker-compose.yml` for the target PC. The one
in the repo bind-mounts `./ui:/opt/ui:ro` for live JSX editing, which
requires the source tree. For the portable demo we want the bundled UI
that's already inside the image — see the next section.

---

## 3. Build the portable bundle

Create a directory you can ship as a single archive:

```bash
mkdir -p qemu-gr712rc-portable
cp qemu-gr712rc-emulator.tar.gz qemu-gr712rc-portable/
```

Drop a minimal `docker-compose.yml` next to the tarball — same as the
repo's compose file but **without** the bind-mount, so it runs on a PC
that doesn't have the source tree:

```yaml
# qemu-gr712rc-portable/docker-compose.yml
services:
  emulator:
    image: qemu-gr712rc-emulator:latest
    container_name: qemu-gr712rc-emulator
    ports:
      - "8080:8080"
    tmpfs:
      - /var/uploads:size=64m
    restart: unless-stopped
```

And a one-page README so whoever opens the bundle can run it without
reading these full docs:

```markdown
# QEMU GR712RC / GR740 emulator — portable demo

1. Load the image:
       docker load < qemu-gr712rc-emulator.tar.gz
2. Start it:
       docker compose up -d
3. Open http://localhost:8080/ in a browser.
4. Upload an ELF you built with the FSW toolchain, click Create Session
   and Start. UART output streams in real time.
5. Stop the demo:
       docker compose down
```

Final layout:

```
qemu-gr712rc-portable/
├── docker-compose.yml
├── qemu-gr712rc-emulator.tar.gz
└── README.md
```

Tar it up for transport (optional — you can ship the directory directly
on a USB drive):

```bash
tar -czf qemu-gr712rc-portable.tar.gz qemu-gr712rc-portable/
```

---

## 4. Transfer the bundle

Pick whichever moves bytes:

- **`scp`** — `scp qemu-gr712rc-portable.tar.gz user@workpc:~/`
- **USB drive** — copy the directory; FAT32 is fine, the tarball is one
  file under 4 GiB.
- **Shared network drive / corp file server** — drop, retrieve.
- **Cloud (Drive, OneDrive)** — works for the ~150 MiB tarball.

---

## 5. On the target PC: load and run

```bash
# In the directory that contains qemu-gr712rc-emulator.tar.gz:
docker load < qemu-gr712rc-emulator.tar.gz
# Loaded image: qemu-gr712rc-emulator:latest

docker compose up -d
# [+] Running 2/2
#  ✔ Network qemu-gr712rc-portable_default       Created
#  ✔ Container qemu-gr712rc-emulator             Started

docker compose ps
# NAME                   STATUS    PORTS
# qemu-gr712rc-emulator  Up        0.0.0.0:8080->8080/tcp
```

Open `http://localhost:8080/` in the browser. The UI redirects from `/`
to `/ui/`. Upload an ELF, click *Create session*, click *Start*.

Alternative port if 8080 is taken on the work PC — edit the compose
file before `up`:

```yaml
ports:
  - "9090:8080"
```

Then open `http://localhost:9090/`.

To shut down:

```bash
docker compose down
```

---

## 6. Targeting a different architecture (ARM)

If the work PC is ARM (Apple Silicon, Windows-on-ARM), build a native
image on a multi-arch capable Docker setup:

```bash
docker buildx build --platform linux/arm64 \
    -t qemu-gr712rc-emulator:arm64 \
    --output type=docker \
    .
docker save qemu-gr712rc-emulator:arm64 | gzip > qemu-gr712rc-emulator-arm64.tar.gz
```

Adjust `image:` in the portable `docker-compose.yml` to
`qemu-gr712rc-emulator:arm64`.

Or push the multi-arch image to a registry once and skip the tarball
step entirely:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
    -t registry.example.com/qemu-gr712rc-emulator:0.1 \
    --push .
# On the target:
docker pull registry.example.com/qemu-gr712rc-emulator:0.1
```

---

## 7. Verifying the portable demo end-to-end

Smoke test from the target PC's shell — confirms the API, WebSockets,
and bundled UI all work:

```bash
# Sanity:
curl -sS http://localhost:8080/machines | head
# Should list gr712rc and gr740.

# UI is reachable:
curl -sS -I http://localhost:8080/ui/
# HTTP/1.1 200 OK

# OpenAPI:
curl -sS http://localhost:8080/openapi.json | head
```

Browser-side: drag an ELF into the side panel, click *Create session*,
click *Start*, watch the UART stream.

If you hit issues, `docker compose logs -f emulator` shows the FastAPI
log including any spawned-QEMU stderr. See
[`docs/08-running-the-service.md`](08-running-the-service.md) for the
full troubleshooting list.

---

## 8. Updating later

When you make changes back on the source PC:

```bash
# Source PC
docker compose build emulator
docker save qemu-gr712rc-emulator:latest | gzip > qemu-gr712rc-emulator.tar.gz
# Transfer the new .tar.gz, overwrite the old one.

# Target PC
docker compose down
docker load < qemu-gr712rc-emulator.tar.gz   # overwrites :latest
docker compose up -d
```

Each `docker save` is a full snapshot — there's no incremental delta
file to manage. Simple and idempotent.

---

## 9. What does *not* survive the round-trip

- **Uploaded ELFs**: ephemeral. The `tmpfs` mount in the compose file
  wipes `/var/uploads` on every container restart. Re-upload after
  `down` / `up` cycles. This is intentional per the spec (§7 of
  `07-adapter-api.md`).
- **The git history of this repo**: not in the image. If you also want
  to develop on the work PC, clone the repo separately —
  `git clone --recurse-submodules git@github.com:nhorro/gr712rc-emulator-qemu.git`
  — and use the bind-mount compose for live editing.
- **The toolchain**: not in the image (and shouldn't be — license terms
  for RCC/BCC2/mkprom2 are per-user). Build ELFs on whichever PC has
  the toolchain installed; the image only needs the resulting `.exe`.
- **Network identity**: the container's TLS / certs / DNS state is
  reset on each `up`. For local-only demo this is fine.
