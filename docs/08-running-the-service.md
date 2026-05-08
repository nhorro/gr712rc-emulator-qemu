# Running the adapter service

This document is the operator/user-facing companion to
[`07-adapter-api.md`](07-adapter-api.md). The API doc defines *what* the
service exposes; this one walks through *how* to run it and exercise
every endpoint by hand.

## Prerequisites

- Docker engine 24+ and `docker compose` plugin.
- The `qemu/` submodule populated: `git submodule update --init --recursive`.
- For test sessions: an ELF built locally with the FSW toolchain (RCC,
  BCC2, or mkprom2). The service intentionally does not bundle the
  toolchain or sample ELFs.

No host-side Python install or build deps are needed; the image bundles
QEMU and the service.

## Build and start

From the repo root:

```bash
docker compose up --build
```

Wait for the line `Uvicorn running on http://0.0.0.0:8080`. Press
**Ctrl-C** to stop, or use `docker compose up -d` to detach.

To rebuild after editing `service/`, `docker compose up --build` again.
QEMU itself is built only when `qemu/` source files change (Docker layer
cache).

## Health check

```bash
$ curl http://localhost:8080/machines
[{"id":"gr712rc",...},{"id":"gr740",...}]
```

If this returns the two machine entries, the service is up and QEMU is
on the container's PATH.

## End-to-end Hello World

This is the same demo flow that the UI implements. We use `wscat`
(Node) and `curl`. Replace with `websocat` if preferred.

```bash
# Install wscat once if you haven't:  npm install -g wscat

# 1. Build a kernel with your local toolchain.
make -C apps/01-hello-rtems

# 2. Upload it.
$ curl -F file=@apps/01-hello-rtems/hello.exe http://localhost:8080/uploads
{"kernel_url":"/uploads/abc123-hello.exe","filename":"hello.exe", ...}

# 3. Create the session.
$ curl -X POST http://localhost:8080/session \
       -H 'Content-Type: application/json' \
       -d '{"machine":"gr712rc","kernel_url":"/uploads/abc123-hello.exe"}'
{"id":"session-1","machine":"gr712rc","status":"created", ...}

# 4. In one terminal, watch lifecycle events:
$ wscat -c ws://localhost:8080/ws/events
< {"type":"status","status":"created","timestamp":"..."}

# 5. Start the session — events stream will emit "running":
$ curl -X POST http://localhost:8080/session/start
{"id":"session-1","status":"running", ...}

# 6. In another terminal, attach to UART 0:
$ wscat -c ws://localhost:8080/ws/uart/0
< 
< *** GR712RC RTEMS Hello World ***
< Running on QEMU gr712rc machine
< *** END OF TEST ***

# 7. The events terminal will receive the exit:
< {"type":"exit","exit_code":0,"timestamp":"..."}

# 8. Clean up.
$ curl -X DELETE http://localhost:8080/session
```

## Pause / resume

`apps/02-dual-core-timer` is a long-running counter, useful for showing
the pause behavior visibly:

```bash
make -C apps/02-dual-core-timer
curl -F file=@apps/02-dual-core-timer/dual_core_timer.exe \
     http://localhost:8080/uploads
# (use the returned kernel_url)
curl -X POST http://localhost:8080/session \
     -H 'Content-Type: application/json' \
     -d '{"machine":"gr712rc","smp":2,"kernel_url":"/uploads/..."}'
curl -X POST http://localhost:8080/session/start

# UART 0 streams "Core 0: 10 / Core 1: 20 / ..." once per second.
# In the wscat -c ws://localhost:8080/ws/uart/0 terminal:

curl -X POST http://localhost:8080/session/pause     # output stops
curl -X POST http://localhost:8080/session/resume    # output continues
curl -X POST http://localhost:8080/session/reset     # back to "Core 0: 10"
```

## Quad-core SMP on GR740

```bash
make -C apps/08-gr740-smp
curl -F file=@apps/08-gr740-smp/quad_core_timer.exe http://localhost:8080/uploads
curl -X POST http://localhost:8080/session \
     -H 'Content-Type: application/json' \
     -d '{"machine":"gr740","smp":4,"kernel_url":"/uploads/..."}'
curl -X POST http://localhost:8080/session/start
# UART 0 interleaves Core 0/1/2/3.
```

## Introspection

```bash
# Pause first so the snapshot is stable:
curl -X POST http://localhost:8080/session/pause

# Per-CPU register snapshot:
$ curl http://localhost:8080/session/cpu/0/registers
{"cpu":0,"pc":"0x40001944","npc":"0x40001948","psr":"0xf39000e6", ...}

# Memory dump (returns 32-bit big-endian words):
$ curl 'http://localhost:8080/session/memory?addr=0x40000000&size=32'
{"addr":"0x40000000","size":32,"data":"a0100000 29100004 ..."}
```

## OpenAPI

The service publishes its OpenAPI 3 schema at:

```
http://localhost:8080/openapi.json
```

and an interactive Swagger UI at:

```
http://localhost:8080/docs
```

Pipe `openapi.json` into your codegen of choice for typed clients.

## Logs and troubleshooting

```bash
docker compose logs -f emulator    # follow service logs
docker compose ps                  # is it running?
docker compose restart emulator    # bounce the service
```

Common issues:

- **`qemu_error: QEMU did not create QMP socket within 5s`** — the
  spawned QEMU exited during init. Check `docker compose logs` for the
  underlying QEMU stderr. Usually means an unsupported flag was passed
  or the kernel ELF couldn't be loaded.
- **`/ws/uart/0` closes immediately with code 1011** — no active
  session, or the session is in `created` state (not started yet).
- **HTTP 409 on `POST /session`** — a previous session is still active.
  `DELETE /session` first.
- **Container restarts unexpectedly** — `docker compose ps` shows
  exit codes; the default `restart: unless-stopped` policy will keep
  bringing it back. Set to `no` in `docker-compose.yml` for debugging.

## Configuration

The service is configurable via environment variables. All have safe
defaults; override in `docker-compose.yml` under `services.emulator.environment:`.

| Variable | Default | Purpose |
|---|---|---|
| `UPLOADS_DIR` | `/var/uploads` | Where uploaded ELFs are stored. Backed by tmpfs in the default compose file (ephemeral). |

There is no authentication. The service is intended for local or
trusted-LAN use only. Do not expose port `8080` to untrusted networks.

## Porting to a more powerful host

The image is platform-independent (no host bind mounts, no privileged
flags). To run it on a remote machine:

```bash
# Push the image to a registry your remote can pull from.
docker tag qemu-gr712rc-emulator:latest registry.example.com/qemu-emulator:0.1
docker push registry.example.com/qemu-emulator:0.1

# On the remote, fetch and run:
docker run -d -p 8080:8080 --tmpfs /var/uploads:size=64m \
    registry.example.com/qemu-emulator:0.1
```

Once exposed across a network, add an authentication layer (reverse
proxy with HTTP basic auth, or a service-side API key — currently out
of scope per the v0 spec).
