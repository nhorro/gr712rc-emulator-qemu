# Adapter Service & API Specification (v0)

> **Status:** Draft — MVP for issue #14. Implementation has not started yet; this document is the contract UI development can mock against.
>
> **Stability:** API is **v0**. Breaking changes are possible until a v1 freeze is declared. The path prefix is intentionally absent (no `/v1/`) — when v1 ships, paths will be moved under `/v1/` and v0 will be marked deprecated.

This document specifies the HTTP + WebSocket service that wraps the GR712RC / GR740 QEMU emulator. It is the only contract between the service and any client (browser UI, CLI tools, automated tests). Implementations on either side MUST follow it.

A machine-readable [OpenAPI 3](https://www.openapis.org/) schema will be served by the running service at `/openapi.json` once implemented. This document is the human-readable counterpart — read it first, then use the OpenAPI export for codegen.

---

## 1. Architecture summary

```
  client (browser, CLI, test)
        │ HTTP + WebSocket
  ┌─────┴───────────────────┐
  │  adapter service        │   ← Python / FastAPI
  │  (this spec)            │
  └─────┬───────────────────┘
        │ QMP (Unix socket) + chardev sockets
  ┌─────┴───────────────────┐
  │  qemu-system-sparc      │
  │  -M gr712rc / gr740     │
  └─────────────────────────┘
```

- The service spawns one QEMU child process per session.
- **Single-session model**: at most one emulator session exists at any time. Creating a new session while one is active is an error (`409 session_exists`); clients must `DELETE /session` first.
- **Single-container deployment**: the service and QEMU run in the same Docker container.
- **No authentication** in v0. The service is intended for local or trusted-LAN use only. Operators MUST NOT expose port `8080` to untrusted networks.

---

## 2. Base conventions

### 2.1 Base URL

Default: `http://localhost:8080`. Configurable via the container's published port.

### 2.2 Content types

- All REST request and response bodies are `application/json; charset=utf-8`, **except**:
  - `POST /uploads` request: `multipart/form-data`
  - `GET /session/memory` response: `application/json` (data field is hex-encoded)
- WebSocket frame formats are documented per endpoint in §5.

### 2.3 Timestamps

All timestamps are RFC 3339 / ISO 8601 strings in UTC, e.g. `"2026-05-08T12:34:56Z"`.

### 2.4 Address and size encoding

Memory addresses, register values, and similar 32-bit unsigned quantities are returned as **lower-case hex strings with `0x` prefix** (e.g. `"0xc0000000"`). Sizes are unsigned integers in bytes.

### 2.5 CORS

The service responds with permissive CORS headers (`Access-Control-Allow-Origin: *`) so a browser UI served from a different origin (e.g. `localhost:3000` during UI development) can consume it. Production deployments behind a proxy may tighten this.

### 2.6 Error response shape

All `4xx` and `5xx` responses have the following body:

```json
{
  "error": "code_string",
  "message": "Human-readable description.",
  "details": { }
}
```

`details` is optional and may carry structured context (e.g. allowed values, current state).

#### 2.6.1 Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `session_not_found` | 404 | No active session. |
| `session_exists` | 409 | A session already exists; `DELETE /session` first. |
| `invalid_state` | 409 | The requested transition is not valid from the current state. `details.current_status` and `details.allowed_from` are populated. |
| `invalid_machine` | 400 | Machine ID not in the list returned by `GET /machines`. |
| `invalid_kernel` | 400 | Kernel URL does not point to an uploaded file, or the file is not a valid SPARC ELF. |
| `kernel_too_large` | 413 | Uploaded file exceeds the 32 MiB limit. |
| `invalid_address` | 400 | Memory address malformed or out of range for the active machine. |
| `invalid_size` | 400 | Memory read size is zero or exceeds 4096 bytes. |
| `qemu_error` | 502 | QEMU returned an error or terminated unexpectedly. `details.qemu_message` carries the QMP error string. |
| `internal_error` | 500 | Unexpected service-side failure. |

---

## 3. Session state machine

```
                       POST /session
                            │
                            ▼
                     ┌─────────────┐
                     │   created   │
                     └──────┬──────┘
                            │ POST /session/start
                            ▼
            ┌──────►┌─────────────┐
            │       │   running   │◄────────┐
            │       └──────┬──────┘         │
            │              │                │ kernel running
            │ POST         │ POST           │ (no client action)
            │ /session/    │ /session/      │
            │ resume       │ pause          │
            │              ▼                │
            │       ┌─────────────┐         │
            └───────│   paused    │         │
                    └──────┬──────┘         │
                           │                │
                           │ kernel exits   │
                           │ or fatal trap  │
                           ▼                │
                    ┌─────────────┐         │
                    │   exited    │◄────────┘
                    └──────┬──────┘
                           │
                           │ POST /session/reset
                           ▼
                    (back to running)

  Any state ── DELETE /session ──► (session gone)
```

States:

- **`created`**: Session resource exists but QEMU has not been started yet. Most introspection endpoints return `409 invalid_state`.
- **`running`**: QEMU is executing guest instructions.
- **`paused`**: QEMU is alive but the guest CPU is stopped. Memory and register reads are stable.
- **`exited`**: The guest has called `exit()` or hit a fatal trap. QEMU may still be alive (so introspection works); from this state only `reset` (back to `running`) and `delete` are valid.

Transitions table:

| From → To | Trigger | Result |
|---|---|---|
| (none) → `created` | `POST /session` | Session created |
| `created` → `running` | `POST /session/start` | QEMU spawned, guest runs |
| `running` → `paused` | `POST /session/pause` | QMP `stop` |
| `paused` → `running` | `POST /session/resume` | QMP `cont` |
| `running` → `exited` | guest event | `events` WS emits `exit` or `fatal` |
| `paused` → `exited` | impossible (guest is stopped) | n/a |
| `running` / `paused` / `exited` → `running` | `POST /session/reset` | QMP `system_reset` |
| any → (gone) | `DELETE /session` | QMP `quit`, resources freed |

---

## 4. REST endpoints

### 4.1 `GET /machines`

List the machine types the service can instantiate.

#### Response 200

```json
[
  {
    "id": "gr712rc",
    "description": "GR712RC dual-core LEON3FT",
    "cpus": 2,
    "default_ram_mb": 64,
    "max_ram_mb": 1024,
    "uart_count": 5,
    "spw_count": 1
  },
  {
    "id": "gr740",
    "description": "GR740 quad-core LEON4",
    "cpus": 4,
    "default_ram_mb": 256,
    "max_ram_mb": 2048,
    "uart_count": 1,
    "spw_count": 0
  }
]
```

Field contract: `id` is the value clients pass to `POST /session`. `cpus` is the maximum addressable CPU count. `uart_count` is the number of WebSocket UART endpoints (`/ws/uart/0` … `/ws/uart/{uart_count-1}`). `spw_count` is the number of GRSPW2 SpaceWire taps (`/ws/spw/0` … `/ws/spw/{spw_count-1}`); `0` means the machine exposes no SpW links to the service in this release.

---

### 4.2 `POST /uploads`

Upload an ELF kernel. Files persist for the life of the **container** (across multiple sessions); they are wiped on container restart.

#### Request

`multipart/form-data` with one field:

- `file`: the ELF binary. Maximum size **32 MiB**.

#### Response 201

```json
{
  "kernel_url": "/uploads/4f9c6e8a-hello.exe",
  "filename": "hello.exe",
  "size": 142336,
  "uploaded_at": "2026-05-08T12:30:00Z"
}
```

`kernel_url` is the value clients pass as `kernel_url` in `POST /session`. Clients SHOULD treat it as opaque; the service is free to change the URL scheme.

Uploaded files MAY be retrieved via `GET {kernel_url}` for inspection (returns `application/octet-stream`).

#### Errors

- `413 kernel_too_large` if file size exceeds 32 MiB.
- `400 invalid_kernel` if file is empty or unreadable.

---

### 4.3 `POST /session`

Create a new session.

#### Request body

```json
{
  "machine": "gr712rc",
  "smp": 2,
  "kernel_url": "/uploads/4f9c6e8a-hello.exe",
  "ram_mb": 64
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `machine`     | yes | — | Must be an `id` from `GET /machines`. |
| `kernel_url`  | yes | — | Must be a `kernel_url` returned by `POST /uploads`. |
| `smp`         | no  | machine's `cpus` | Number of CPUs to enable. `1 ≤ smp ≤ machine.cpus`. |
| `ram_mb`      | no  | machine's `default_ram_mb` | RAM in MiB. `1 ≤ ram_mb ≤ machine.max_ram_mb`. |

#### Response 201

The session object (see §4.4).

#### Errors

- `409 session_exists` if a session is already active.
- `400 invalid_machine`, `400 invalid_kernel` for the obvious causes.

---

### 4.4 `GET /session`

Get the current session.

#### Response 200

```json
{
  "id": "session-1",
  "machine": "gr712rc",
  "status": "running",
  "smp": 2,
  "kernel_url": "/uploads/4f9c6e8a-hello.exe",
  "ram_mb": 64,
  "created_at": "2026-05-08T12:34:56Z",
  "started_at": "2026-05-08T12:35:00Z",
  "exit_code": null,
  "spw_peer_ports": { "0": 51873 }
}
```

`started_at` is `null` while `status == "created"`. `exit_code` is non-null only when `status == "exited"`; values are integer (exit code from RTEMS `exit()`) or the string `"fatal"` (fatal trap).

`spw_peer_ports` maps SpW link index (as a string key) to the TCP port on `127.0.0.1` where an external peer can connect (see §5.3). The map is empty until `status == "running"` (ports are bound at start) and for machines whose `spw_count` is `0`.

#### Errors

- `404 session_not_found` if no session is active.

---

### 4.5 `POST /session/start`

Start the previously created session. Spawns QEMU and runs the kernel.

#### Request body

Empty.

#### Response 200

The session object with `status: "running"` and `started_at` populated.

#### Errors

- `404 session_not_found`
- `409 invalid_state` if `status != "created"`. `details.current_status` is set.

---

### 4.6 `POST /session/pause`

QMP `stop`. Halts guest execution.

#### Response 200

Session object with `status: "paused"`.

#### Errors

- `409 invalid_state` if `status != "running"`.

---

### 4.7 `POST /session/resume`

QMP `cont`. Resumes execution.

#### Response 200

Session object with `status: "running"`.

#### Errors

- `409 invalid_state` if `status != "paused"`.

---

### 4.8 `POST /session/reset`

QMP `system_reset`. Returns to PROM entry; guest re-runs from boot.

#### Response 200

Session object with `status: "running"`.

#### Errors

- `409 invalid_state` if `status == "created"` (use `start`).

---

### 4.9 `DELETE /session`

QMP `quit`. Terminates QEMU and frees the session slot. After this, a new session may be created.

#### Response 204

Empty body.

#### Errors

- `404 session_not_found`.

---

### 4.10 `GET /session/cpu/{n}/registers`

Snapshot the integer-unit register set of CPU `n`. The snapshot is taken at the moment of the request; if the session is running, the values may be stale by the time the response is consumed. To get a stable snapshot, call `POST /session/pause` first.

`n` is in `[0, smp)`. Out-of-range returns `400 invalid_address`.

#### Response 200

```json
{
  "cpu": 0,
  "pc": "0xc0000000",
  "npc": "0xc0000004",
  "psr": "0x000000c0",
  "y": "0x00000000",
  "wim": "0x00000000",
  "tbr": "0x00000000",
  "asr17": "0x00000000",
  "global": ["0x0", "0x1", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0"],
  "out":    ["0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x40000fff", "0x0"],
  "local":  ["0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0"],
  "in":     ["0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0", "0x0"]
}
```

Field contract:

- `pc`, `npc`: program counter and next-PC (delay slot).
- `psr`, `y`, `wim`, `tbr`: SPARC special registers.
- `asr17`: ancillary state register 17 (per-CPU; bits [31:28] = CPU ID).
- `global` / `out` / `local` / `in`: each is an 8-element array of GPRs from the current register window. `out[6]` is the stack pointer (`%sp`), `out[7]` is the link register (`%o7`), conventionally.

Floating-point registers are NOT in v0. They will be added in v1 if needed for the demo.

#### Errors

- `404 session_not_found`
- `400 invalid_address` if `n` is out of range.
- `409 invalid_state` if `status == "created"`.

---

### 4.11 `GET /session/memory?addr={addr}&size={size}`

Read guest physical memory.

Query parameters:

- `addr`: hex string with `0x` prefix, e.g. `0xc0000000`. Must be 4-byte aligned.
- `size`: integer, `1 ≤ size ≤ 4096`. Recommended to be a multiple of 4.

#### Response 200

```json
{
  "addr": "0xc0000000",
  "size": 64,
  "data": "82100000 03300000 82106000 81c04000 01000000 ..."
}
```

The `data` field is a space-separated sequence of lower-case hex 32-bit words, big-endian (the SPARC native endianness). For non-aligned reads (not recommended), `data` falls back to a space-separated sequence of bytes.

Reads to unmapped addresses return zeros without error. Future revisions may add a `holes` field reporting which ranges were unmapped.

#### Errors

- `404 session_not_found`
- `400 invalid_address` (malformed `addr`)
- `400 invalid_size` (out of range)
- `409 invalid_state` if `status == "created"`.

---

## 5. WebSocket endpoints

WebSocket connections use `ws://` (or `wss://` behind a TLS proxy). All frame payloads are documented per endpoint.

Connection lifetime: a WebSocket is bound to the **current** session. If the session is deleted (`DELETE /session`) or QEMU exits, the server closes the WebSocket with code `1001` (going away). Clients SHOULD reconnect after creating a new session.

Backpressure: the server may close a WebSocket with code `1011` if a client cannot keep up with output (more than 1 MiB buffered per connection).

### 5.1 `WS /ws/uart/{n}`

Bidirectional stream of UART data for UART index `n`. `n` is in `[0, machine.uart_count)`.

**Frame format**: text frames in both directions.

- **Server → client**: each frame contains UART output bytes decoded as UTF-8 (replacement character `U+FFFD` for invalid sequences). Frame boundaries do NOT correspond to anything semantic — clients MUST NOT assume a frame contains a complete line. Buffer client-side and split on `\n` for line-oriented display.
- **Client → server**: each frame contains text to write to the UART RX. UTF-8 is encoded to bytes and forwarded verbatim. Send a `\n` to submit a line if the guest expects line-buffered input.

A future revision may add binary-frame support for clients that need byte-exact control. v0 is text-only.

When the UART is unbuffered (the QEMU APBUART is): output is delivered with sub-millisecond latency. There is no buffering on the server beyond what is required for socket-level writes.

If the WebSocket disconnects, server-side UART output produced during the disconnection is **discarded** (no replay). The UI MUST tolerate gaps if it expects to maintain a long-running view.

#### Example

```
$ wscat -c ws://localhost:8080/ws/uart/0
< *** GR712RC RTEMS Hello World ***
< Running on QEMU gr712rc machine
< *** END OF TEST ***
```

### 5.2 `WS /ws/events`

Server-sent stream of session lifecycle events. Client → server messages are ignored in v0.

**Frame format**: text frames containing JSON objects.

```json
{ "type": "status", "session_id": "session-1", "status": "running", "timestamp": "2026-05-08T12:35:00Z" }
{ "type": "status", "session_id": "session-1", "status": "paused", "timestamp": "2026-05-08T12:35:30Z" }
{ "type": "exit",   "session_id": "session-1", "exit_code": 0, "timestamp": "2026-05-08T12:36:00Z" }
{ "type": "fatal",  "session_id": "session-1", "trap": 4, "pc": "0xc0001234", "cpu": 1, "timestamp": "2026-05-08T12:36:01Z" }
```

Event types:

| `type` | Fields | Meaning |
|---|---|---|
| `status` | `status` | Status transition. The `status` field is the new state. |
| `exit`   | `exit_code` | Guest called `exit()`. After this, the session is in state `exited`. |
| `fatal`  | `trap`, `pc`, `cpu` | Fatal trap. `trap` is the SPARC trap number; `pc` is where the trap was taken; `cpu` is the CPU index. After this, the session is in state `exited`. |
| `error`  | `error`, `message` | Service-side error (e.g. QEMU died unexpectedly). After this, the session is unrecoverable; clients SHOULD `DELETE /session`. |

On connection, the server emits the **current** status as a `status` event so clients can synchronize without polling `GET /session`.

### 5.3 `WS /ws/spw/{n}`

Read-only stream of GRSPW2 (SpaceWire) packet events for SpW link index `n`. `n` is in `[0, machine.spw_count)`.

The service interposes between QEMU and an external peer (e.g. `tools/spw-echo-peer.py`) as a transparent TCP proxy, parses the chardev's 4-byte big-endian length framing, and publishes each packet as a JSON event on this endpoint. Bytes are forwarded verbatim between QEMU and the peer regardless of whether any UI is connected.

**Frame format**: text frames containing JSON objects. Two `type` values:

```json
{ "type": "packet", "port": 0, "ts": 1715342400.123, "iso": "2026-05-08T12:35:00.123Z",
  "dir": "tx", "len": 6, "hex": "fe000000000a" }
{ "type": "state",  "port": 0, "ts": 1715342400.001, "iso": "2026-05-08T12:35:00.001Z",
  "state": "qemu_connected" }
```

`packet` fields:

| Field | Meaning |
|---|---|
| `port` | SpW link index (matches `{n}` in the path). |
| `ts`   | Unix epoch seconds, float. Use for ordering. |
| `iso`  | UTC timestamp in ISO-8601, useful for display. |
| `dir`  | `"tx"` = QEMU → peer; `"rx"` = peer → QEMU. |
| `len`  | Payload length in bytes (excludes the 4-byte length prefix). |
| `hex`  | Lowercase hex of the full packet payload. The first byte is the SpW destination address; subsequent bytes are protocol-id + user payload as written to the GRSPW2 TX descriptor. |

`state` fields:

| `state` | Meaning |
|---|---|
| `qemu_connected` / `qemu_disconnected`     | The QEMU side of the tap accepted a connection (it does so once per session start) or lost it (process exit). |
| `peer_connected` / `peer_disconnected`     | An external peer dialed in or hung up. The tap continues to publish QEMU-side packets even when no peer is connected. |

**Connecting an external peer**: when a session is in `running` state, `GET /session` returns a `spw_peer_ports` map of `{port_index: tcp_port}`. Point an external peer at that TCP port. Example:

```bash
curl -s http://localhost:8080/session | jq .spw_peer_ports
# { "0": 5101 }

python3 tools/spw-echo-peer.py --port 5101 --connect -v
```

The peer-side listeners are bound on `0.0.0.0` so external peers can dial in. The default port assignment is `5101 + port_index` (override with the `SPW_PEER_PORT_BASE` env var); `docker-compose.yml` publishes `5101-5106` accordingly.

This endpoint is one-way (server → client) in v0. Injecting packets from the UI is a v1-roadmap item; the external-peer side covers that need today.

---

## 6. Example workflows

### 6.1 Single-session Hello World demo

```bash
# 1. Discover machines
curl http://localhost:8080/machines

# 2. Upload an ELF (built locally with the FSW toolchain)
curl -F file=@apps/01-hello-rtems/hello.exe http://localhost:8080/uploads
# → { "kernel_url": "/uploads/abc-hello.exe", ... }

# 3. Create the session
curl -X POST http://localhost:8080/session \
     -H 'Content-Type: application/json' \
     -d '{"machine":"gr712rc","kernel_url":"/uploads/abc-hello.exe"}'

# 4. Subscribe to events and UART (in two separate terminals or browser tabs)
wscat -c ws://localhost:8080/ws/events
wscat -c ws://localhost:8080/ws/uart/0

# 5. Start
curl -X POST http://localhost:8080/session/start

# UART terminal will print:
#   *** GR712RC RTEMS Hello World ***
#   ...
# Events terminal will print:
#   { "type": "status", "status": "running", ... }
#   { "type": "exit",   "exit_code": 0, ... }

# 6. Inspect, then clean up
curl http://localhost:8080/session/cpu/0/registers
curl 'http://localhost:8080/session/memory?addr=0xc0000000&size=32'
curl -X DELETE http://localhost:8080/session
```

### 6.2 Pause / resume / inspect

```bash
# Session is running (steps 1-5 from above)

curl -X POST http://localhost:8080/session/pause
# State is now "paused"; register and memory reads are stable.

curl http://localhost:8080/session/cpu/0/registers
curl 'http://localhost:8080/session/memory?addr=0xc0000000&size=4096'

curl -X POST http://localhost:8080/session/resume
```

### 6.3 Reset without restarting QEMU

```bash
curl -X POST http://localhost:8080/session/reset
# Guest re-runs from PROM entry. UART will replay the boot banner.
```

---

## 7. Out of scope (v0)

The following are intentionally **not** in v0. They will be considered for v1 based on demo feedback.

- **Memory writes** (`PUT /session/memory`).
- **Breakpoints / single-step** (`POST /session/cpu/{n}/breakpoints`, `POST /session/step`).
- **Per-CPU pause / resume**.
- **Multiple concurrent sessions**.
- **Authentication / authorization**.
- **Persistent uploads across container restarts**.
- **Floating-point register snapshot**.
- **Disassembly endpoint** (`GET /session/disas?addr&count`).
- **GDB stub passthrough**.
- **Snapshot / restore** (QMP `savevm` / `loadvm`).
- **Trace / log streaming** (e.g. QEMU `-d guest_errors,unimp` over WebSocket).
- **AMBA scriptable-device control surface**.
- **Binary-frame WebSocket UART**.

---

## 8. Versioning policy

- v0: this document. Breaking changes possible. No path prefix.
- v1: contract freeze. Paths move under `/v1/`. v0 endpoints continue to work for at least one release after v1 ships, marked deprecated in OpenAPI.
- v2+: same pattern; one major version of overlap.

Adding new fields to existing responses is non-breaking. Removing or renaming fields, or changing types, is breaking.

---

## 9. Open questions for UI

These are explicit choices flagged for the UI team to weigh in on **before** the v1 contract is frozen. Decisions made during UI development can be folded back here.

1. **UART encoding**: text-only is fine for RTEMS-style consoles. Is binary-frame support needed for any UI scenario in the near term?
2. **Memory dump format**: hex words are compact but require client-side parsing. Would a base64-encoded `Uint8Array` be more useful?
3. **Status polling vs. events**: is the `WS /ws/events` channel sufficient, or does the UI need a long-poll fallback for environments where WebSockets are blocked?
4. **Color / line-buffering**: the UART stream is raw. Should the service strip ANSI escapes, or pass them through for the UI to handle? (Default in v0: pass through.)
5. **Reconnection semantics**: should the service buffer the last N kilobytes of UART so a reconnecting WebSocket can replay them? (Default in v0: no buffering.)

File feedback as comments on issue #14.
