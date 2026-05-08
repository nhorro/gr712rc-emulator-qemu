/* global React */
// Backend integration for the QEMU-SVF adapter API (v0).
// Per ui/INTEGRATION.md: only this file changed; the mock simulator was
// removed and `api` now talks to the FastAPI service over HTTP/WebSocket.

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const API_BASE = window.QEMU_SVF_API_BASE || (location.origin || "http://localhost:8080");
const WS_BASE  = API_BASE.replace(/^http/, "ws");

// ── Tiny pub-sub store ─────────────────────────────────────
function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set: (next) => {
      state = typeof next === "function" ? next(state) : { ...state, ...next };
      subs.forEach((f) => f(state));
    },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  };
}

// ── Machine catalog (overwritten by GET /machines on bootstrap) ──
const MACHINES = [
  {
    id: "gr712rc",
    description: "GR712RC dual-core LEON3FT — flight-proven SPARC V8 with FPU and EDAC.",
    arch: "SPARC V8 / LEON3FT",
    cpus: 2,
    default_ram_mb: 64,
    max_ram_mb: 1024,
    uart_count: 5,
  },
  {
    id: "gr740",
    description: "GR740 quad-core LEON4 — next-gen radiation-hard NGMP for high-perf FSW.",
    arch: "SPARC V8 / LEON4FT",
    cpus: 4,
    default_ram_mb: 256,
    max_ram_mb: 2048,
    uart_count: 1,
  },
];

// ── Initial-state helpers (only used before the first API call returns) ──
function makeRegs(pc) {
  const z = "0x00000000";
  return {
    pc: "0x" + pc.toString(16).padStart(8, "0"),
    npc: "0x" + (pc + 4).toString(16).padStart(8, "0"),
    psr: z, y: z, wim: z, tbr: z, asr17: z,
    global: Array(8).fill(z), out: Array(8).fill(z),
    local:  Array(8).fill(z), in:  Array(8).fill(z),
  };
}

function makeMem(base, size) {
  return { addr: "0x" + base.toString(16).padStart(8, "0"), size, words: [] };
}

// ── Store ─────────────────────────────────────────────────
const store = createStore({
  uploads: [],
  selectedKernel: null,
  draftMachine: "gr712rc",
  draftSmp: 2,
  draftRamMb: 64,

  session: null,
  uartLines: {},
  activeUart: 0,
  events: [],
  registers: makeRegs(0xc0000000),
  cpu: 0,
  memBase: "0xc0000000",
  memSize: 256,
  memData: makeMem(0xc0000000, 256),
  // v1-roadmap placeholders — left empty since no v0 endpoint feeds them.
  breakpoints: [],
  canFrames: [],
  spwPackets: [],
  toasts: [],
  termWrap: true,
  termTimestamps: true,
  regBase: "hex",
  uptimeMs: 0,
});

// ── React hook ────────────────────────────────────────────
function useStore(selector = (s) => s) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((x) => x + 1)), []);
  return selector(store.get());
}

// ── Store helpers (used by api below) ─────────────────────
function pushUart(idx, text) {
  store.set((s) => {
    const lines = (s.uartLines[idx] || []).concat([{ ts: new Date().toISOString(), text }]);
    return { ...s, uartLines: { ...s.uartLines, [idx]: lines.slice(-2000) } };
  });
}

function pushEvent(ev) {
  store.set((s) => ({
    ...s,
    events: s.events.concat([{ ...ev, ts: ev.ts || new Date().toISOString() }]).slice(-500),
  }));
}

function toast(t) {
  const id = Math.random().toString(36).slice(2);
  store.set((s) => ({ ...s, toasts: s.toasts.concat([{ id, ...t }]) }));
  setTimeout(() => {
    store.set((s) => ({ ...s, toasts: s.toasts.filter((x) => x.id !== id) }));
  }, t.duration || 3500);
}

// ── HTTP helper ────────────────────────────────────────────
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

// ── WebSocket plumbing ────────────────────────────────────
let _evtWS = null;
let _uartWS = {};

function _openEventsWS() {
  if (_evtWS) return;
  const ws = new WebSocket(`${WS_BASE}/ws/events`);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const cur = store.get();
    if (cur.session) {
      if (msg.type === "status") {
        store.set({ session: { ...cur.session, status: msg.status } });
      } else if (msg.type === "exit") {
        store.set({ session: { ...cur.session, status: "exited", exit_code: msg.exit_code } });
      } else if (msg.type === "fatal") {
        store.set({ session: { ...cur.session, status: "exited", exit_code: "fatal" } });
      }
    }
    pushEvent({ ...msg, ts: msg.timestamp || new Date().toISOString() });
  };
  ws.onclose = (e) => {
    _evtWS = null;
    if (e.code === 1011) {
      // Server rejected — usually because no session is active. Quiet.
    }
  };
  _evtWS = ws;
}

function _openUartWS(n) {
  if (_uartWS[n]) return;
  const ws = new WebSocket(`${WS_BASE}/ws/uart/${n}`);
  let buf = "";
  ws.onmessage = (ev) => {
    buf += ev.data;
    const parts = buf.split("\n");
    buf = parts.pop(); // last incomplete line stays buffered
    parts.forEach((line) => pushUart(n, line));
  };
  ws.onclose = (e) => {
    if (buf) { pushUart(n, buf); buf = ""; }
    delete _uartWS[n];
    if (e.code === 1011) {
      // Backpressure or no session — quiet so the UI isn't spammy.
    }
  };
  _uartWS[n] = ws;
}

function _closeAllWS() {
  if (_evtWS) { _evtWS.close(); _evtWS = null; }
  Object.values(_uartWS).forEach((w) => { try { w.close(); } catch {} });
  _uartWS = {};
}

// ── Public API surface (consumed by panels.jsx, sidepanel.jsx, etc.) ──
const api = {
  async loadMachines() {
    try {
      const machines = await http("GET", "/machines");
      // Replace MACHINES in-place so all UI components see live values.
      MACHINES.splice(0, MACHINES.length, ...machines.map((m) => ({
        ...m,
        arch: m.id === "gr740" ? "SPARC V8 / LEON4FT" : "SPARC V8 / LEON3FT",
      })));
      store.set({}); // force re-render
    } catch (e) {
      // Offline — keep the hardcoded MACHINES defaults so the UI still renders.
    }
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
      store.set((s) => ({
        ...s,
        uploads: s.uploads.concat([item]),
        selectedKernel: u.kernel_url,
      }));
      toast({ kind: "success", title: "Upload complete", sub: `${item.filename} · ${formatBytes(item.size)}` });
      return item;
    } catch (e) {
      toast({ kind: "danger", title: e.error || "upload_failed", sub: e.message });
      throw e;
    }
  },

  async createSession() {
    const s = store.get();
    if (!s.selectedKernel) {
      toast({ kind: "warn", title: "No kernel selected", sub: "Upload an ELF or MkProm bootable first." });
      return;
    }
    const body = {
      machine: s.draftMachine,
      smp: s.draftSmp,
      ram_mb: s.draftRamMb,
      kernel_url: s.selectedKernel,
    };
    try {
      const session = await http("POST", "/session", { body });
      store.set({ session, uartLines: {}, events: [], uptimeMs: 0 });
      _openEventsWS();
      // UART socket connects after start (the chardev socket isn't there until QEMU runs).
    } catch (e) {
      toast({ kind: "warn", title: e.error || "create_failed", sub: e.message });
    }
  },

  startSession()  { return api._transition("/session/start",  "Cannot start"); },
  pauseSession()  { return api._transition("/session/pause",  "Cannot pause"); },
  resumeSession() { return api._transition("/session/resume", "Cannot resume"); },
  resetSession()  { return api._transition("/session/reset",  "Cannot reset"); },

  async _transition(path, errTitle) {
    try {
      const session = await http("POST", path);
      store.set({ session });
      // After start/reset, hook UART 0 if not already.
      if (path === "/session/start" || path === "/session/reset") {
        _openUartWS(0);
      }
    } catch (e) {
      toast({ kind: "warn", title: errTitle, sub: e.message });
    }
  },

  async deleteSession() {
    _closeAllWS();
    try { await http("DELETE", "/session"); } catch {}
    store.set({ session: null, uartLines: {}, events: [], uptimeMs: 0 });
    toast({ kind: "info", title: "Session deleted", sub: "DELETE /session → 204" });
  },

  async refreshRegisters() {
    const s = store.get();
    if (!s.session || s.session.status === "created") return;
    try {
      const registers = await http("GET", `/session/cpu/${s.cpu}/registers`);
      store.set({ registers });
    } catch (e) {
      toast({ kind: "warn", title: "registers", sub: e.message });
    }
  },

  async refreshMemory(addr, size) {
    const s = store.get();
    if (!s.session || s.session.status === "created") return;
    const sz = Math.min(4096, Math.max(4, size | 0));
    try {
      const mem = await http("GET", `/session/memory?addr=${encodeURIComponent(addr)}&size=${sz}`);
      const words = mem.data.split(/\s+/).filter(Boolean).map((w) => parseInt(w, 16));
      store.set({
        memBase: mem.addr,
        memSize: mem.size,
        memData: { addr: mem.addr, size: mem.size, words },
      });
    } catch (e) {
      toast({ kind: "warn", title: "memory", sub: e.message });
    }
  },

  // UI-only state setters — same shape as the mock store had.
  toggleBp(idx) {
    store.set((s) => ({
      ...s,
      breakpoints: s.breakpoints.map((b, i) => i === idx ? { ...b, enabled: !b.enabled } : b),
    }));
  },
  setActiveUart(idx) {
    store.set({ activeUart: idx });
    _openUartWS(idx);
  },
  setCpu(n) {
    store.set({ cpu: n });
    api.refreshRegisters();
  },
  setDraft(patch) { store.set(patch); },
  selectKernel(url) { store.set({ selectedKernel: url }); },
  removeUpload(id) {
    store.set((s) => ({
      ...s,
      uploads: s.uploads.filter((u) => u.id !== id),
      selectedKernel: s.selectedKernel === s.uploads.find((u) => u.id === id)?.kernel_url
                       ? null : s.selectedKernel,
    }));
  },
  setTweak(patch) { store.set(patch); },

  // Send a line to the active UART (called by panels.jsx UartPane.onSend).
  _sendUart(n, text) {
    _uartWS[n]?.send(text);
  },
};

// ── Helpers ────────────────────────────────────────────────
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
function formatHexAddr(n) { return "0x" + (n >>> 0).toString(16).padStart(8, "0"); }
function formatUptime(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60), rs = s - m * 60;
  return `${m}m ${rs.toFixed(0)}s`;
}
function tsShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toTimeString().slice(0, 8) + "." + d.getMilliseconds().toString().padStart(3, "0");
}

Object.assign(window, {
  store, api, useStore,
  MACHINES, formatBytes, formatHexAddr, formatUptime, tsShort,
});

// ── Bootstrap on page load ─────────────────────────────────
(async () => {
  await api.loadMachines();
  try {
    const session = await http("GET", "/session");
    store.set({ session });
    _openEventsWS();
    if (session.status !== "created") _openUartWS(0);
  } catch {
    // 404 — no session, that's the normal startup state.
  }
})();
