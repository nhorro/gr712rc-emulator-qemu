/* global React, useStore, api, MACHINES, formatBytes, formatUptime, tsShort, formatHexAddr */
const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ── Tiny SVG icon set ─────────────────────────────────────
const Icon = ({ name, size = 16 }) => {
  const s = size;
  const props = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  const I = {
    upload: <svg {...props}><path d="M12 16V4m0 0l-5 5m5-5l5 5"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>,
    play:   <svg {...props}><path d="M7 5l12 7-12 7V5z" fill="currentColor"/></svg>,
    pause:  <svg {...props}><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>,
    stop:   <svg {...props}><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>,
    reset:  <svg {...props}><path d="M3 12a9 9 0 1015.5-6.36L21 3M21 9V3h-6"/></svg>,
    chip:   <svg {...props}><rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/></svg>,
    cpu:    <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>,
    mem:    <svg {...props}><rect x="3" y="6" width="18" height="12" rx="1"/><path d="M7 10v4M11 10v4M15 10v4M19 10v4"/></svg>,
    bp:     <svg {...props}><circle cx="12" cy="12" r="6" fill="currentColor"/></svg>,
    bus:    <svg {...props}><path d="M4 8h16M4 16h16"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="16" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="16" r="1.5" fill="currentColor"/><circle cx="16" cy="16" r="1.5" fill="currentColor"/></svg>,
    spw:    <svg {...props}><path d="M3 12c4 0 4-6 9-6s5 6 9 6"/><path d="M3 18c4 0 4-6 9-6s5 6 9 6"/></svg>,
    term:   <svg {...props}><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>,
    log:    <svg {...props}><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>,
    cog:    <svg {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>,
    file:   <svg {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>,
    trash:  <svg {...props}><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>,
    refresh:<svg {...props}><path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5"/></svg>,
    chev:   <svg {...props}><path d="M6 9l6 6 6-6"/></svg>,
    plus:   <svg {...props}><path d="M12 5v14M5 12h14"/></svg>,
    download:<svg {...props}><path d="M12 4v12m0 0l-5-5m5 5l5-5"/><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1"/></svg>,
    search: <svg {...props}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>,
    close:  <svg {...props}><path d="M18 6L6 18M6 6l12 12"/></svg>,
    dot:    <svg {...props}><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>,
  };
  return I[name] || null;
};

window.Icon = Icon;

// ── TopBar ────────────────────────────────────────────────
function TopBar() {
  const session = useStore((s) => s.session);
  const machine = MACHINES.find((m) => m.id === session?.machine);
  const status = session?.status || "idle";
  const statusLabel = session ? status : "no session";

  const canStart = session?.status === "created";
  const canPause = session?.status === "running";
  const canResume = session?.status === "paused";
  const canReset = session && session.status !== "created";
  const canDelete = !!session;

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <div className="logo"></div>
        <div className="name">QEMU-SVF</div>
        <div className="tag">Experimental</div>
      </div>
      <div className="topbar-divider"></div>

      <div className="topbar-meta">
        <span className={`status-pill ${status}`}>
          <span className="dot"></span>
          {statusLabel}
        </span>
        {session && (
          <>
            <div className="kv"><span className="k">machine</span><span className="v">{machine?.id}</span></div>
            <div className="kv"><span className="k">smp</span><span className="v">{session.smp}</span></div>
            <div className="kv"><span className="k">ram</span><span className="v">{session.ram_mb} MiB</span></div>
            <div className="kv"><span className="k">id</span><span className="v">{session.id}</span></div>
          </>
        )}
        {!session && (
          <div className="kv faint" style={{ fontSize: 11 }}>
            <span>POST <span className="inline-code">/session</span> to begin — drop an ELF in the sidebar →</span>
          </div>
        )}
      </div>

      <div className="topbar-controls">
        <button className="btn success" disabled={!canStart} onClick={api.startSession}>
          <Icon name="play" size={13} /> Start
        </button>
        <button className="btn warn" disabled={!canPause} onClick={api.pauseSession}>
          <Icon name="pause" size={13} /> Pause
        </button>
        <button className="btn success" disabled={!canResume} onClick={api.resumeSession}>
          <Icon name="play" size={13} /> Resume
        </button>
        <button className="btn" disabled={!canReset} onClick={api.resetSession} title="POST /session/reset">
          <Icon name="reset" size={13} /> Reset
        </button>
        <button className="btn danger" disabled={!canDelete} onClick={api.deleteSession} title="DELETE /session">
          <Icon name="stop" size={13} /> Stop
        </button>
      </div>
    </div>
  );
}

// ── Activity bar ──────────────────────────────────────────
function ActivityBar({ active, onSelect }) {
  const items = [
    { id: "session", icon: "chip",  label: "Session" },
    { id: "machine", icon: "bus",   label: "Machine inspector" },
    { id: "files",   icon: "file",  label: "Uploads" },
  ];
  return (
    <div className="activitybar">
      {items.map((it) => (
        <button
          key={it.id}
          className={`activitybar-btn ${active === it.id ? "active" : ""}`}
          title={it.label}
          onClick={() => onSelect(it.id)}
        >
          <Icon name={it.icon} size={18} />
        </button>
      ))}
      <div className="activitybar-divider"></div>
      <div style={{ flex: 1 }}></div>
      <button className="activitybar-btn" title="Settings">
        <Icon name="cog" size={18} />
      </button>
    </div>
  );
}

// ── Status bar ────────────────────────────────────────────
function StatusBar() {
  const session = useStore((s) => s.session);
  const uptime = useStore((s) => s.uptimeMs);
  const events = useStore((s) => s.events.length);
  const breakpoints = useStore((s) => s.breakpoints.filter((b) => b.enabled).length);
  const pc = useStore((s) => s.registers.pc);

  return (
    <div className="statusbar">
      <div className="item">
        <span className="conn-dot" style={{ background: session ? "var(--status-running)" : "var(--text-low)" }}></span>
        <span className="v">{session ? "ws://localhost:8080 · connected" : "ws://localhost:8080 · idle"}</span>
      </div>
      <div className="item"><span className="k">adapter</span><span className="v">v0.1.2-dev</span></div>
      {session && (
        <>
          <div className="item"><span className="k">uptime</span><span className="v">{formatUptime(uptime)}</span></div>
          <div className="item"><span className="k">PC</span><span className="v">{pc}</span></div>
        </>
      )}
      <div className="spacer"></div>
      <div className="item"><span className="k">events</span><span className="v">{events}</span></div>
      <div className="item"><span className="k">breakpoints</span><span className="v">{breakpoints}</span></div>
      <div className="item"><span className="k">⌘K</span><span className="v">commands</span></div>
    </div>
  );
}

window.TopBar = TopBar;
window.ActivityBar = ActivityBar;
window.StatusBar = StatusBar;
