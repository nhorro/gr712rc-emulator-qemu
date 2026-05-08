# QEMU-SVF Frontend — Backend Integration Guide

This guide tells you exactly how to swap the mocked `api` / `store` layer in the prototype for real calls against the [Adapter Service v0](./uploads/07-adapter-api.md). The UI components do not need to change — every panel reads from the store and dispatches through the `api` object, so integration is a single-file rewrite of `store.jsx`.

---

## 1. Architecture map

```
 ┌───────────────────────────────────────────────────────┐
 │  React UI                                             │
 │  TopBar · SidePanel · UartPane · RegistersPane · …    │  ← read-only
 └───────────────┬─────────────────────┬─────────────────┘
                 │ useStore(selector)  │ api.action()
                 ▼                     ▼
 ┌───────────────────────────────────────────────────────┐
 │  store.jsx  (the only file you edit)                  │
 │  • createStore()  pub-sub state                       │  ← thin
 │  • api.*          REST / WS calls                     │
 │  • mock simulator (DELETE THIS BLOCK)                 │
 └───────────────┬─────────────────────┬─────────────────┘
                 │ HTTP                │ WebSocket
                 ▼                     ▼
 ┌───────────────────────────────────────────────────────┐
 │  Adapter Service (FastAPI) on :8080                   │
 └───────────────────────────────────────────────────────┘
```

**Contract**: nothing under `panels.jsx`, `chrome.jsx`, `sidepanel.jsx`, or `app.jsx` knows the shape of an HTTP call. They only call `api.foo()` and read `useStore(s => s.bar)`. As long as the store keys keep the same names and shapes, the UI keeps working.

---

## 2. Configuration

Add a base URL at the top of `store.jsx`:

```js
// store.jsx — line 1
const API_BASE = window.QEMU_SVF_API_BASE || "http://localhost:8080";
const WS_BASE  = API_BASE.replace(/^http/, "ws");
```

For dev, set `window.QEMU_SVF_API_BASE` from a `<script>` in `index.html` so you can switch between staging/local without rebuilding.

CORS is permissive in v0 (`Access-Control-Allow-Origin: *`), so cross-origin from `localhost:3000` to `localhost:8080` works out of the box.

---

## 3. State keys the UI expects

If your real responses don't match these names, normalize them in the store before calling `set()`. The UI reads:

| Key | Shape | Source |
|---|---|---|
| `uploads` | `[{ id, filename, size, kind, kernel_url, uploaded_at }]` | `POST /uploads` response (+ append `id` from `kernel_url`, `kind` from filename) |
| `selectedKernel` | `string \| null` (a `kernel_url`) | UI-only |
| `draftMachine` / `draftSmp` / `draftRamMb` | session-creation form draft | UI-only |
| `session` | `null \| { id, machine, status, smp, ram_mb, kernel_url, created_at, started_at, exit_code }` | `GET /session` |
| `uartLines` | `{ [n]: [{ ts, text }] }` | `WS /ws/uart/{n}` text frames, split on `\n` |
| `events` | `[{ type, status?, exit_code?, trap?, pc?, cpu?, text?, ts }]` | `WS /ws/events` JSON frames |
| `registers` | `{ pc, npc, psr, y, wim, tbr, asr17, global[8], out[8], local[8], in[8] }` | `GET /session/cpu/{n}/registers` |
| `cpu` | `number` | UI-only |
| `memBase` / `memSize` / `memData` | memory viewer | `GET /session/memory` |
| `breakpoints`, `canFrames`, `spwPackets` | placeholders for v1 endpoints | local |

Every value is rendered exactly as received — addresses must already be lower-case `0x…` strings (the API contract guarantees this).

---

## 4. Replace the mock — REST endpoints

Delete the entire `// ── Mock UART traffic ──` and `_beginSimulation` blocks, plus `clearTimers`, `_uartTimers`, `_eventTimer`, `_uptimeTimer`, `_busTimer`. Replace `api` with:

```js
async function http(method, path, { body, isForm } = {}) {
  const init = { method, headers: {} };
  if (body && !isForm) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body) {
    init.body = body; // FormData
  }
  const r = await fetch(API_BASE + path, init);
  if (!r.ok) {
    let err;
    try { err = await r.json(); } catch { err = { error: "http_" + r.status, message: r.statusText }; }
    throw err;
  }
  return r.status === 204 ? null : r.json();
}

const api = {
  async loadMachines() {
    const machines = await http("GET", "/machines");
    store.set({ machinesLive: machines }); // (or just replace MACHINES)
  },

  async upload(file) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      const u = await http("POST", "/uploads", { body: fd, isForm: true });
      const item = {
        id: u.kernel_url.split("/").pop(),
        filename: u.filename,
        size: u.size,
        kind: file.name.endsWith(".boot") ? "MKPROM" : "ELF32",
        kernel_url: u.kernel_url,
        uploaded_at: u.uploaded_at,
      };
      store.set(s => ({ uploads: s.uploads.concat([item]), selectedKernel: u.kernel_url }));
      toast({ kind: "success", title: "Upload complete", sub: `${item.filename} · ${formatBytes(item.size)}` });
    } catch (e) {
      toast({ kind: "danger", title: e.error || "upload_failed", sub: e.message });
    }
  },

  async createSession() {
    const s = store.get();
    const body = { machine: s.draftMachine, smp: s.draftSmp, ram_mb: s.draftRamMb, kernel_url: s.selectedKernel };
    try {
      const session = await http("POST", "/session", { body });
      store.set({ session, uartLines: {}, events: [], uptimeMs: 0 });
      api._openEventsWS();
      api._openUartWS(0);
    } catch (e) { toast({ kind: "warn", title: e.error, sub: e.message }); }
  },

  startSession()  { return api._transition("/session/start",  "Cannot start"); },
  pauseSession()  { return api._transition("/session/pause",  "Cannot pause"); },
  resumeSession() { return api._transition("/session/resume", "Cannot resume"); },
  resetSession()  { return api._transition("/session/reset",  "Cannot reset"); },

  async _transition(path, errTitle) {
    try {
      const session = await http("POST", path);
      store.set({ session });
    } catch (e) {
      toast({ kind: "warn", title: errTitle, sub: e.message });
    }
  },

  async deleteSession() {
    api._closeAllWS();
    try { await http("DELETE", "/session"); } catch {}
    store.set({ session: null, uartLines: {}, events: [], uptimeMs: 0 });
  },

  async refreshRegisters() {
    const cpu = store.get().cpu;
    try {
      const registers = await http("GET", `/session/cpu/${cpu}/registers`);
      store.set({ registers });
    } catch (e) { toast({ kind: "warn", title: "registers", sub: e.message }); }
  },

  async refreshMemory(addr, size) {
    try {
      const mem = await http("GET", `/session/memory?addr=${encodeURIComponent(addr)}&size=${size}`);
      // Parse the space-separated hex words into Number[]
      const words = mem.data.split(/\s+/).filter(Boolean).map(w => parseInt(w, 16));
      store.set({ memBase: mem.addr, memSize: mem.size, memData: { addr: mem.addr, size: mem.size, words } });
    } catch (e) { toast({ kind: "warn", title: "memory", sub: e.message }); }
  },
};
```

---

## 5. WebSocket integration

The two long-lived sockets are events and per-UART. Track them on `api` so we can close them cleanly on `DELETE /session`.

```js
let _evtWS = null;
let _uartWS = {};

api._openEventsWS = function () {
  if (_evtWS) return;
  _evtWS = new WebSocket(`${WS_BASE}/ws/events`);
  _evtWS.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    // mirror service status into our session view
    if (msg.type === "status") {
      store.set(s => s.session ? { session: { ...s.session, status: msg.status } } : {});
    } else if (msg.type === "exit") {
      store.set(s => s.session ? { session: { ...s.session, status: "exited", exit_code: msg.exit_code } } : {});
    } else if (msg.type === "fatal") {
      store.set(s => s.session ? { session: { ...s.session, status: "exited", exit_code: "fatal" } } : {});
    }
    pushEvent({ ...msg, ts: msg.timestamp || new Date().toISOString() });
  };
  _evtWS.onclose = () => { _evtWS = null; };
};

api._openUartWS = function (n) {
  if (_uartWS[n]) return;
  const ws = new WebSocket(`${WS_BASE}/ws/uart/${n}`);
  // line-buffer: frame boundaries are NOT line boundaries (per spec §5.1)
  let buf = "";
  ws.onmessage = (ev) => {
    buf += ev.data;
    const parts = buf.split("\n");
    buf = parts.pop();              // last incomplete line stays buffered
    parts.forEach(line => pushUart(n, line));
  };
  ws.onclose = (e) => {
    if (buf) { pushUart(n, buf); buf = ""; }
    delete _uartWS[n];
    if (e.code === 1011) toast({ kind: "warn", title: "UART backpressure", sub: "Server closed: client too slow." });
  };
  _uartWS[n] = ws;
};

api._sendUart = function (n, text) {
  _uartWS[n]?.send(text);
};

api._closeAllWS = function () {
  _evtWS?.close(); _evtWS = null;
  Object.values(_uartWS).forEach(w => w.close());
  _uartWS = {};
};
```

When the user switches UART tabs (`api.setActiveUart(i)`), open that UART socket lazily:

```js
api.setActiveUart = function (idx) {
  store.set({ activeUart: idx });
  api._openUartWS(idx);
};
```

---

## 6. Wiring the UI's send-input box

The terminal already has a send box (`onSend` in `panels.jsx`). Replace its placeholder with:

```js
const onSend = () => {
  if (!input) return;
  api._sendUart(active, input + "\n");
  setInput("");
};
```

The spec says `\n` is what most line-buffered guests expect.

---

## 7. Bootstrap order on page load

Add this near the bottom of `store.jsx`, after `Object.assign(window, …)`:

```js
// Pull live machine list and any existing session on first load.
(async () => {
  try {
    const machines = await http("GET", "/machines");
    // Replace the local MACHINES const if you want fully dynamic specs:
    window.MACHINES.splice(0, window.MACHINES.length, ...machines.map(m => ({
      ...m,
      arch: m.id === "gr740" ? "SPARC V8 / LEON4FT" : "SPARC V8 / LEON3FT",
    })));
    store.set({}); // force re-render
  } catch (e) { /* offline — keep defaults */ }

  try {
    const session = await http("GET", "/session");
    store.set({ session });
    api._openEventsWS();
    api._openUartWS(0);
  } catch { /* 404 — no session, normal */ }
})();
```

---

## 8. Error handling cheatsheet

| API code | UI behaviour |
|---|---|
| `session_not_found` (404) | Treat as "no session" — clear `session` in store, close WS. |
| `session_exists` (409) | Toast "Session already exists; delete it first." |
| `invalid_state` (409) | Toast with `details.current_status` & `details.allowed_from`. The transport buttons are already disabled by `status` so this should be rare. |
| `kernel_too_large` (413) | Toast "File exceeds 32 MiB." Keep the file in `<input>` so the user can pick a smaller one. |
| `qemu_error` (502) | Toast danger; `details.qemu_message` goes in `sub`. Recommend `DELETE /session`. |
| WS close `1001` (going away) | Quietly clear UART buffer and stop reconnecting. |
| WS close `1011` (backpressure) | Toast warn — client was too slow. UI should reconnect after a backoff. |

The `http()` helper above already throws the parsed error body; catch and toast.

---

## 9. Things the v0 contract leaves to the UI

These are the open questions in the spec §9 — the prototype already takes a position on each:

1. **UART text vs binary** — text-only is fine for the FSW console use case.
2. **Memory dump format** — the prototype parses space-separated hex words. If the API later switches to base64, only `api.refreshMemory` changes.
3. **Status polling fallback** — none. Pure WS. The bootstrap step above does a one-shot `GET /session` which is enough.
4. **ANSI escapes** — passed through. Add a stripper in the UART line buffer if you want.
5. **Reconnection replay** — none in v0. The UI shows a "session reconnected" toast on WS reopen and accepts the gap.

---

## 10. Test plan

A minimum smoke test against a real adapter:

1. `curl http://localhost:8080/machines` returns the list — UI machine cards reflect live `cpus` / `uart_count`.
2. Drop an ELF — `POST /uploads` returns 201, item appears in sidebar.
3. Click *Create session* → *Start*. Within 1 s the UART pane shows boot output.
4. Click *Pause* → Registers pane refresh button returns the snapshot; `tag` flips from "may be stale" to "snapshot stable".
5. Memory pane: enter `0xc0000000`, size `64`, click Read — words appear.
6. Let the guest exit — Events pane gets `{type:"exit", exit_code:0}`; status pill flips to `exited`.
7. Click *Reset* → guest re-runs from PROM; UART replays banner.
8. Click *Stop* → `DELETE /session` → all panes return to empty state.

---

## 11. File map

| File | Touch on integration? |
|---|---|
| `index.html` | no |
| `styles.css` | no |
| `tweaks-panel.jsx` | no |
| `chrome.jsx` | no |
| `sidepanel.jsx` | no |
| `panels.jsx` | one-line change in `UartPane.onSend` |
| `app.jsx` | no |
| **`store.jsx`** | **rewrite the marked sections** |

That's it. Everything visible in the UI is driven by store keys; once the keys are populated by real responses, the design is done.
