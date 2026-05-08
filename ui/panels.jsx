/* global React, useStore, api, MACHINES, tsShort, formatHexAddr, Icon */
const { useState, useEffect, useRef, useMemo } = React;

// ── Generic pane wrapper with tabbed header ──────────────
function Pane({ tabs, active, onTab, actions, children }) {
  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`pane-tab ${active === t.id ? "active" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.icon && <Icon name={t.icon} size={12} />}
              <span>{t.label}</span>
              {t.count != null && <span className="count">{t.count}</span>}
              {t.dot && <span className="tab-dot"></span>}
            </button>
          ))}
        </div>
        {actions && <div className="pane-actions">{actions}</div>}
      </div>
      <div className="pane-body">{children}</div>
    </div>
  );
}

// ── UART terminal ─────────────────────────────────────────
function UartPane() {
  const session = useStore((s) => s.session);
  const active = useStore((s) => s.activeUart);
  const allLines = useStore((s) => s.uartLines);
  const showTs = useStore((s) => s.termTimestamps);
  const wrap = useStore((s) => s.termWrap);
  const machine = MACHINES.find((m) => m.id === session?.machine);
  const uartCount = machine?.uart_count || 1;
  const tabs = Array.from({ length: uartCount }).map((_, i) => ({
    id: i,
    label: `UART ${i}`,
    count: (allLines[i] || []).length || undefined,
  }));

  const [input, setInput] = useState("");
  const bodyRef = useRef(null);
  const lines = allLines[active] || [];

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [lines.length, active]);

  const onSend = () => {
    if (!input) return;
    api._sendUart(active, input + "\n");
    setInput("");
  };

  if (!session) {
    return (
      <Pane tabs={[{ id: 0, label: "UART 0", icon: "term" }]} active={0} onTab={() => {}}>
        <div className="pane-empty">
          <Icon name="term" size={42} />
          <div className="title">No active session</div>
          <div className="sub">Create a session and start it to see UART output here. <span className="inline-code">WS /ws/uart/0</span> will stream once the kernel boots.</div>
        </div>
      </Pane>
    );
  }

  return (
    <Pane
      tabs={tabs.map((t) => ({ ...t, icon: "term" }))}
      active={active}
      onTab={(i) => api.setActiveUart(i)}
      actions={
        <>
          <button className="btn ghost icon" title="Toggle timestamps" onClick={() => api.setTweak({ termTimestamps: !showTs })}>
            <Icon name="dot" size={12} />
          </button>
          <button className="btn ghost icon" title="Clear" onClick={() => {
            const s = window.store.get();
            window.store.set({ uartLines: { ...s.uartLines, [active]: [] } });
          }}>
            <Icon name="trash" size={12} />
          </button>
          <button className="btn ghost icon" title="Download" onClick={() => {}}>
            <Icon name="download" size={12} />
          </button>
        </>
      }
    >
      <div className="term" ref={bodyRef} style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>
        {lines.length === 0 && (
          <div className="faint" style={{ color: "rgba(122,242,168,0.4)" }}>
            ── waiting for UART {active} traffic ──
          </div>
        )}
        {lines.map((l, i) => (
          <span key={i} className="line">
            {showTs && <span className="ts">{tsShort(l.ts)}</span>}
            {l.text}
          </span>
        ))}
        {session.status === "running" && <span className="cursor"></span>}
      </div>
    </Pane>
  );
}

// ── Events log ───────────────────────────────────────────
function EventsPane({ tabs, active, onTab }) {
  const events = useStore((s) => s.events);
  const bodyRef = useRef(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [events.length]);

  return (
    <Pane tabs={tabs} active={active} onTab={onTab}>
      <div className="events" ref={bodyRef}>
        {events.length === 0 && (
          <div className="pane-empty">
            <Icon name="log" size={36} />
            <div className="title">No events</div>
            <div className="sub"><span className="inline-code">WS /ws/events</span> will emit lifecycle events here once a session is active.</div>
          </div>
        )}
        {events.map((e, i) => (
          <div key={i} className={`event-row ${e.type}`}>
            <span className="ts">{tsShort(e.ts)}</span>
            <span className="type">{e.type}</span>
            <span className="msg">
              {e.text || (
                e.type === "exit" ? <span><span className="k">exit_code=</span><span className="vmono">{String(e.exit_code)}</span></span> :
                e.type === "fatal" ? <span><span className="k">trap=</span><span className="vmono">{e.trap}</span> <span className="k">pc=</span><span className="vmono">{e.pc}</span></span> :
                e.type === "status" ? <span><span className="k">status=</span><span className="vmono">{e.status}</span></span> :
                ""
              )}
            </span>
          </div>
        ))}
      </div>
    </Pane>
  );
}

// ── Registers ────────────────────────────────────────────
function RegistersPane({ tabs, active, onTab }) {
  const session = useStore((s) => s.session);
  const regs = useStore((s) => s.registers);
  const cpu = useStore((s) => s.cpu);
  const machine = MACHINES.find((m) => m.id === session?.machine);
  const cpus = machine?.cpus || 1;

  if (!session) return (
    <Pane tabs={tabs} active={active} onTab={onTab}>
      <div className="pane-empty">
        <Icon name="cpu" size={36} />
        <div className="title">No session</div>
        <div className="sub">Pause a running session, then <span className="inline-code">GET /session/cpu/{cpu}/registers</span> snapshots the IU register set.</div>
      </div>
    </Pane>
  );

  const stale = session.status === "running";

  return (
    <Pane
      tabs={tabs}
      active={active}
      onTab={onTab}
      actions={
        <button className="btn ghost icon" title="Refresh" onClick={api.refreshRegisters}>
          <Icon name="refresh" size={12} />
        </button>
      }
    >
      <div className="reg-toolbar">
        <span className="faint">CPU</span>
        <div className="reg-cpu-pills">
          {Array.from({ length: cpus }).map((_, i) => (
            <button key={i} className={`cpu-pill ${cpu === i ? "active" : ""}`} onClick={() => api.setCpu(i)}>cpu{i}</button>
          ))}
        </div>
        <span className="spacer"></span>
        {stale && <span className="tag amber">may be stale — pause for stable snapshot</span>}
        {!stale && <span className="tag green">snapshot stable</span>}
      </div>
      <div className="reg-grid">
        <div className="reg-section">
          <div className="h">Special</div>
          <div className="reg-special-grid">
            {[["pc", regs.pc], ["npc", regs.npc], ["psr", regs.psr], ["y", regs.y], ["wim", regs.wim], ["tbr", regs.tbr], ["asr17", regs.asr17]].map(([k, v]) => (
              <div key={k} className="reg-row special"><span className="name">%{k}</span><span className="val">{v}</span></div>
            ))}
          </div>
        </div>
        <div className="reg-section">
          <div className="h">Window — global / out</div>
          <div className="reg-window-grid">
            <div>
              {regs.global.map((v, i) => (
                <div key={i} className={`reg-row ${i === 0 ? "" : (v !== "0x00000000" ? "changed" : "")}`}>
                  <span className="name">%g{i}</span><span className="val">{v}</span>
                </div>
              ))}
            </div>
            <div>
              {regs.out.map((v, i) => {
                const lbl = i === 6 ? "%sp" : i === 7 ? "%o7" : `%o${i}`;
                return <div key={i} className={`reg-row ${v !== "0x00000000" ? "changed" : ""}`}><span className="name">{lbl}</span><span className="val">{v}</span></div>;
              })}
            </div>
          </div>
        </div>
        <div className="reg-section">
          <div className="h">Window — local / in</div>
          <div className="reg-window-grid">
            <div>
              {regs.local.map((v, i) => (
                <div key={i} className="reg-row"><span className="name">%l{i}</span><span className="val">{v}</span></div>
              ))}
            </div>
            <div>
              {regs.in.map((v, i) => (
                <div key={i} className={`reg-row ${v !== "0x00000000" ? "changed" : ""}`}><span className="name">%i{i}</span><span className="val">{v}</span></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Pane>
  );
}

// ── Memory inspector ─────────────────────────────────────
function MemoryPane({ tabs, active, onTab }) {
  const session = useStore((s) => s.session);
  const base = useStore((s) => s.memBase);
  const sz = useStore((s) => s.memSize);
  const data = useStore((s) => s.memData);
  const [draftAddr, setDraftAddr] = useState(base);
  const [draftSize, setDraftSize] = useState(sz);

  if (!session) return (
    <Pane tabs={tabs} active={active} onTab={onTab}>
      <div className="pane-empty">
        <Icon name="mem" size={36} />
        <div className="title">No session</div>
        <div className="sub">Reads via <span className="inline-code">GET /session/memory?addr=…&size=…</span>. Max 4096 bytes per request.</div>
      </div>
    </Pane>
  );

  // build rows: 4 words per row = 16 bytes
  const rows = [];
  const baseN = parseInt(data.addr, 16);
  for (let i = 0; i < data.words.length; i += 4) {
    const wordsRow = data.words.slice(i, i + 4);
    const ascii = wordsRow.map((w) => {
      let s = "";
      for (let b = 24; b >= 0; b -= 8) {
        const c = (w >>> b) & 0xff;
        s += (c >= 32 && c < 127) ? String.fromCharCode(c) : ".";
      }
      return s;
    }).join("");
    rows.push({
      addr: formatHexAddr(baseN + i * 4),
      words: wordsRow,
      ascii,
    });
  }

  return (
    <Pane tabs={tabs} active={active} onTab={onTab} actions={
      <button className="btn ghost icon" title="Refresh" onClick={() => api.refreshMemory(draftAddr, draftSize)}>
        <Icon name="refresh" size={12} />
      </button>
    }>
      <div className="mem-toolbar">
        <span className="faint">addr</span>
        <input className="input" value={draftAddr} onChange={(e) => setDraftAddr(e.target.value)} />
        <span className="faint">size</span>
        <input className="input size" value={draftSize} onChange={(e) => setDraftSize(+e.target.value || 0)} />
        <button className="btn sm" onClick={() => api.refreshMemory(draftAddr, draftSize)}>Read</button>
        <span className="spacer"></span>
        <span className="faint">{data.size} B · {data.words.length} words · big-endian</span>
      </div>
      <div className="mem-body">
        {rows.map((r, i) => (
          <div key={i} className="mem-row">
            <span className="addr">{r.addr}</span>
            <span className="words">
              {r.words.map((w, j) => {
                const hex = w.toString(16).padStart(8, "0");
                return <span key={j} className={w === 0 ? "zero" : ""}>{hex}{j < r.words.length - 1 ? " " : ""}</span>;
              })}
            </span>
            <span className="ascii">|{r.ascii}|</span>
          </div>
        ))}
      </div>
    </Pane>
  );
}

// ── Breakpoints ──────────────────────────────────────────
function BreakpointsPane({ tabs, active, onTab }) {
  const bps = useStore((s) => s.breakpoints);
  return (
    <Pane tabs={tabs} active={active} onTab={onTab} actions={
      <>
        <button className="btn ghost icon" title="Add breakpoint"><Icon name="plus" size={12} /></button>
      </>
    }>
      <div className="bp-list">
        <div className="bp-row" style={{ background: "var(--bg-2)", color: "var(--text-faint)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em", borderBottom: "1px solid var(--border)" }}>
          <span></span>
          <span>Address</span>
          <span>Symbol</span>
          <span>Hits</span>
          <span></span>
        </div>
        {bps.map((b, i) => (
          <div key={i} className={`bp-row ${b.enabled ? "" : "disabled"}`}>
            <span className="dot" onClick={() => api.toggleBp(i)} style={{ cursor: "pointer" }}></span>
            <span className="addr">{b.addr}</span>
            <span className="sym">{b.sym}</span>
            <span className="hits">{b.hits}× hit</span>
            <button className="btn ghost icon sm"><Icon name="trash" size={11} /></button>
          </div>
        ))}
        <div style={{ padding: "10px 14px", color: "var(--text-faint)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
          <span className="tag amber">v0 stub</span> &nbsp; Endpoint <span className="inline-code">POST /session/cpu/{`{n}`}/breakpoints</span> is on the v1 roadmap.
        </div>
      </div>
    </Pane>
  );
}

// ── CAN ──────────────────────────────────────────────────
function CanPane({ tabs, active, onTab }) {
  const frames = useStore((s) => s.canFrames);
  return (
    <Pane tabs={tabs} active={active} onTab={onTab}>
      <div className="bus-table">
        <div className="bus-row can head">
          <span>Time</span><span>CAN ID</span><span>DLC</span><span>Route</span><span>Data</span>
        </div>
        {frames.slice(-80).reverse().map((f, i) => (
          <div key={i} className="bus-row can">
            <span className="ts">{tsShort(f.ts)}</span>
            <span className="id">{f.id}</span>
            <span>{f.dlc}</span>
            <span className="dim">{f.label}</span>
            <span className="data">{f.data}</span>
          </div>
        ))}
      </div>
    </Pane>
  );
}

// ── SpaceWire ────────────────────────────────────────────
function SpwPane({ tabs, active, onTab }) {
  const pkts = useStore((s) => s.spwPackets);
  return (
    <Pane tabs={tabs} active={active} onTab={onTab}>
      <div className="bus-table">
        <div className="bus-row spw head">
          <span>Time</span><span>Src</span><span>Dst</span><span>Type</span><span>Len</span><span>Address</span>
        </div>
        {pkts.slice(-80).reverse().map((p, i) => (
          <div key={i} className="bus-row spw">
            <span className="ts">{tsShort(p.ts)}</span>
            <span className="id">{p.src}</span>
            <span className="id">{p.dst}</span>
            <span className={p.type.includes("WR") || p.type === "TC_PKT" ? "dir-tx" : "dir-rx"}>{p.type}</span>
            <span>{p.len}</span>
            <span className="data">{p.addr}</span>
          </div>
        ))}
      </div>
    </Pane>
  );
}

window.UartPane = UartPane;
window.EventsPane = EventsPane;
window.RegistersPane = RegistersPane;
window.MemoryPane = MemoryPane;
window.BreakpointsPane = BreakpointsPane;
window.CanPane = CanPane;
window.SpwPane = SpwPane;
