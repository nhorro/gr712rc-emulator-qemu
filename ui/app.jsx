/* global React, ReactDOM, useStore, api,
   TopBar, ActivityBar, StatusBar, SidePanel,
   UartPane, EventsPane, RegistersPane, MemoryPane, BreakpointsPane, CanPane, SpwPane,
   TweaksPanel, useTweaks, TweakSection, TweakToggle, TweakRadio, TweakColor, Icon */

const { useState, useMemo } = React;

// Bottom row tab definitions — each one renders a different pane component.
const BOTTOM_TABS = [
  { id: "events",  label: "Events",       icon: "log",  Comp: window.EventsPane },
  { id: "regs",    label: "Registers",    icon: "cpu",  Comp: window.RegistersPane },
  { id: "mem",     label: "Memory",       icon: "mem",  Comp: window.MemoryPane },
  { id: "bps",     label: "Breakpoints",  icon: "bp",   Comp: window.BreakpointsPane },
  { id: "can",     label: "CAN",          icon: "bus",  Comp: window.CanPane },
  { id: "spw",     label: "SpaceWire",    icon: "spw",  Comp: window.SpwPane },
];

function App() {
  const [activeView, setActiveView] = useState("session");
  const [bottom, setBottom] = useState("events");
  const toasts = useStore((s) => s.toasts);

  // Tweaks
  const [t, setT] = useTweaks(/*EDITMODE-BEGIN*/{
    "termTimestamps": true,
    "termWrap": true,
    "regBase": "hex",
    "accent": "#5eb1ff",
    "density": "cozy"
  }/*EDITMODE-END*/);

  // Apply density
  React.useEffect(() => {
    document.documentElement.style.setProperty("--accent", t.accent);
    document.documentElement.style.setProperty("--accent-glow", hexToGlow(t.accent));
    api.setTweak({ termTimestamps: t.termTimestamps, termWrap: t.termWrap, regBase: t.regBase });
  }, [t.accent, t.termTimestamps, t.termWrap, t.regBase, t.density]);

  const bottomTabs = BOTTOM_TABS.map(({ id, label, icon }) => ({ id, label, icon }));
  const ActiveBottom = BOTTOM_TABS.find((b) => b.id === bottom)?.Comp;

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <ActivityBar active={activeView} onSelect={setActiveView} />
        <SidePanel />
        <div className="main">
          <UartPane />
          <div className="pane-row">
            <ActiveBottom tabs={bottomTabs} active={bottom} onTab={setBottom} />
            <RightInspector />
          </div>
        </div>
      </div>
      <StatusBar />

      <Toasts items={toasts} />

      <TweaksPanel title="Tweaks" defaultOpen={false}>
        <TweakSection title="Theme">
          <TweakColor
            label="Accent color"
            value={t.accent}
            onChange={(v) => setT("accent", v)}
            options={["#5eb1ff", "#7af2a8", "#f5b14a", "#d678e8", "#ef5e5e"]}
          />
          <TweakRadio
            label="Density"
            value={t.density}
            onChange={(v) => setT("density", v)}
            options={[
              { value: "compact", label: "Compact" },
              { value: "cozy",    label: "Cozy" },
            ]}
          />
        </TweakSection>
        <TweakSection title="Terminal">
          <TweakToggle label="Show timestamps" value={t.termTimestamps} onChange={(v) => setT("termTimestamps", v)} />
          <TweakToggle label="Wrap long lines" value={t.termWrap} onChange={(v) => setT("termWrap", v)} />
        </TweakSection>
        <TweakSection title="Registers">
          <TweakRadio
            label="Number base"
            value={t.regBase}
            onChange={(v) => setT("regBase", v)}
            options={[
              { value: "hex", label: "Hex" },
              { value: "dec", label: "Decimal" },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function hexToGlow(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.16)`;
}

// ── Right inspector: small fixed panel showing session at a glance ─
function RightInspector() {
  const session = useStore((s) => s.session);
  const machine = window.MACHINES.find((m) => m.id === session?.machine);
  const events = useStore((s) => s.events);
  const lastStatus = [...events].reverse().find((e) => e.type === "status");

  return (
    <div className="pane">
      <div className="pane-header">
        <div className="pane-tabs">
          <button className="pane-tab active">
            <Icon name="dot" size={10} />
            <span>Session</span>
          </button>
        </div>
      </div>
      <div className="pane-body" style={{ padding: 14 }}>
        {!session && (
          <div className="pane-empty">
            <div className="title">Idle</div>
            <div className="sub">Configure machine + kernel in the sidebar, then create a session.</div>
          </div>
        )}
        {session && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
            <KvBlock title="Identity" rows={[
              ["session_id", session.id],
              ["machine", machine?.id],
              ["arch", machine?.arch],
              ["status", <span className={`status-pill ${session.status}`}><span className="dot"></span>{session.status}</span>],
            ]} />
            <KvBlock title="Resources" rows={[
              ["smp", `${session.smp} / ${machine?.cpus} cpus`],
              ["ram_mb", `${session.ram_mb} MiB`],
              ["uart_count", machine?.uart_count],
            ]} />
            <KvBlock title="Kernel" rows={[
              ["url", <span style={{ color: "var(--accent)", overflowWrap: "anywhere" }}>{session.kernel_url}</span>],
              ["created_at", tsLine(session.created_at)],
              ["started_at", tsLine(session.started_at)],
              ["exit_code", session.exit_code != null ? <span className="tag green">{String(session.exit_code)}</span> : <span className="faint">—</span>],
            ]} />
            <KvBlock title="Last event" rows={[
              ["type", lastStatus?.type || "—"],
              ["status", lastStatus?.status || "—"],
              ["at", lastStatus ? tsLine(lastStatus.ts) : "—"],
            ]} />
          </div>
        )}
      </div>
    </div>
  );
}

function KvBlock({ title, rows }) {
  return (
    <div>
      <div style={{
        fontSize: 9.5, fontWeight: 600, letterSpacing: "0.12em",
        textTransform: "uppercase", color: "var(--text-faint)",
        borderBottom: "1px solid var(--border-soft)", paddingBottom: 4, marginBottom: 6,
      }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: "4px 12px" }}>
        {rows.map(([k, v], i) => (
          <React.Fragment key={i}>
            <div style={{ color: "var(--text-faint)" }}>{k}</div>
            <div style={{ color: "var(--text)" }}>{v ?? "—"}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function tsLine(iso) {
  if (!iso) return <span className="faint">—</span>;
  const d = new Date(iso);
  return d.toLocaleTimeString() + " · " + d.toLocaleDateString();
}

// ── Toasts ───────────────────────────────────────────────
function Toasts({ items }) {
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind || "info"}`}>
          <div className="title">{t.title}</div>
          {t.sub && <div className="sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
