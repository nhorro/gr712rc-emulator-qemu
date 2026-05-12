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

// ── GPIO mock state (no v0 endpoint — local test-bench only) ──
// Pin layouts mirror what the FSW build expects on each board so the
// machine view / GPIO panel labels make sense without a backend.
const GPIO_LABELS = {
  gr712rc: [
    "STATUS_LED",     "HEARTBEAT",      "WDOG_FEED",      "SAFE_MODE",
    "RX_VALID",       "TX_READY",       "PCDU_EN",        "AOCS_EN",
    "PYRO_ARM_1",     "PYRO_FIRE_1",    "PYRO_ARM_2",     "PYRO_FIRE_2",
    "SUN_SENS_RDY",   "STAR_TRK_RDY",   "GYRO_RDY",       "MAG_RDY",
    "RW_X_EN",        "RW_Y_EN",        "RW_Z_EN",        "MTQ_EN",
    "TC_RX",          "TM_TX",          "EXT_INT_0",      "EXT_INT_1",
    "TEMP_ALERT_1",   "TEMP_ALERT_2",   "OVR_CURR",       "UNDR_VOLT",
    "USR_GPIO_28",    "USR_GPIO_29",    "USR_GPIO_30",    "USR_GPIO_31",
  ],
  gr740: [
    "STATUS_LED",     "HEARTBEAT",      "WDOG_FEED",      "SAFE_MODE",
    "PCDU_EN",        "AOCS_EN",        "TC_RX",          "TM_TX",
    "PYRO_ARM",       "PYRO_FIRE",      "RW_EN",          "MTQ_EN",
    "EXT_INT_0",      "EXT_INT_1",      "TEMP_ALERT",     "OVR_CURR",
  ],
};
const GPIO_DIRS = {
  gr712rc: [1,1,1,1, 0,0,1,1, 1,1,1,1, 0,0,0,0, 1,1,1,1, 0,1,0,0, 0,0,0,0, 1,0,1,0],
  gr740:   [1,1,1,1, 1,1,0,1, 1,1,1,1, 0,0,0,0],
};

function makeGpio(machineId) {
  const labels = GPIO_LABELS[machineId] || GPIO_LABELS.gr712rc;
  const dirs   = GPIO_DIRS[machineId]   || GPIO_DIRS.gr712rc;
  return labels.map((label, n) => ({
    n, label,
    dir: dirs[n] ? "out" : "in",
    level: 0,
    lastChange: null,
    history: [],
  }));
}

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
  // GPIO is local-only (no v0 endpoint); seeded for the default machine.
  gpio: makeGpio("gr712rc"),
  busPaused: false,
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

function pushSpwPacket(msg) {
  // Map the /ws/spw/{n} JSON frame to the row shape used by SpwPane.
  // First byte of the packet is the SpW destination/path address;
  // last 4 bytes are interpreted as a big-endian counter for the
  // echo demo. Both are best-effort decoding.
  const hex = msg.hex || "";
  const dst = hex.length >= 2 ? "0x" + hex.slice(0, 2) : "—";
  let counter = null;
  if (msg.len >= 4 && hex.length >= 8) {
    counter = parseInt(hex.slice(-8), 16) >>> 0;
  }
  const tail = hex.length > 32 ? hex.slice(0, 32) + "…" : hex;
  const row = {
    ts: msg.iso || new Date().toISOString(),
    port: msg.port,
    src: "—",
    dst,
    type: msg.dir === "tx" ? "TX_PKT" : "RX_PKT",
    len: msg.len,
    addr: tail,
    counter,
  };
  store.set((s) => ({ ...s, spwPackets: s.spwPackets.concat([row]).slice(-500) }));
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
let _spwWS = {};

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

function _openSpwWS(n) {
  if (_spwWS[n]) return;
  const ws = new WebSocket(`${WS_BASE}/ws/spw/${n}`);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "packet") pushSpwPacket(msg);
    // "state" frames (qemu_connected/peer_connected/...) are observable
    // but we don't surface them in the table; could later route to events.
  };
  ws.onclose = () => { delete _spwWS[n]; };
  _spwWS[n] = ws;
}

function _closeAllWS() {
  if (_evtWS) { _evtWS.close(); _evtWS = null; }
  Object.values(_uartWS).forEach((w) => { try { w.close(); } catch {} });
  _uartWS = {};
  Object.values(_spwWS).forEach((w) => { try { w.close(); } catch {} });
  _spwWS = {};
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
      store.set({ session, uartLines: {}, events: [], spwPackets: [], uptimeMs: 0 });
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
      // After start/reset, hook UART 0 and SpW taps if not already.
      if (path === "/session/start" || path === "/session/reset") {
        _openUartWS(0);
        const ports = session?.spw_peer_ports || {};
        Object.keys(ports).forEach((idx) => _openSpwWS(+idx));
      }
    } catch (e) {
      toast({ kind: "warn", title: errTitle, sub: e.message });
    }
  },

  async deleteSession() {
    _closeAllWS();
    try { await http("DELETE", "/session"); } catch {}
    store.set({ session: null, uartLines: {}, events: [], spwPackets: [], uptimeMs: 0 });
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
  setDraft(patch) {
    store.set(patch);
    if (patch.draftMachine) store.set({ gpio: makeGpio(patch.draftMachine) });
  },
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

  // ── GPIO (local test-bench, no v0 endpoint) ─────────────
  _driveGpio(idx, level, userDriven) {
    const s = store.get();
    const pin = s.gpio[idx];
    if (!pin || pin.level === level) return;
    const t = Date.now();
    const next = s.gpio.slice();
    next[idx] = {
      ...pin, level, lastChange: t,
      history: pin.history.concat([{ t, level }]).slice(-200),
    };
    store.set({ gpio: next });
    if (userDriven) {
      pushEvent({ type: "info", text: `GPIO[${idx}] ${pin.label} → ${level}` });
    }
  },
  toggleGpio(idx) {
    const s = store.get();
    const pin = s.gpio[idx];
    if (!pin || pin.dir !== "in") return;
    api._driveGpio(idx, pin.level ? 0 : 1, true);
    toast({ kind: "info", title: `GPIO[${idx}] ${pin.label}`, sub: `host drove ${pin.level ? 0 : 1}` });
  },
  syncGpioForMachine(machineId) {
    store.set({ gpio: makeGpio(machineId) });
  },
  setBusPaused(p) { store.set({ busPaused: p }); },
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
    if (session.status !== "created") {
      _openUartWS(0);
      const ports = session?.spw_peer_ports || {};
      Object.keys(ports).forEach((idx) => _openSpwWS(+idx));
    }
  } catch {
    // 404 — no session, that's the normal startup state.
  }
})();
