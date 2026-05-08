/* global React, useStore, api, Icon */

function BusTimelinePane({ tabs, active, onTab }) {
  const uartLines = useStore((s) => s.uartLines);
  const canFrames = useStore((s) => s.canFrames);
  const spwPackets = useStore((s) => s.spwPackets);
  const session = useStore((s) => s.session);
  const paused = useStore((s) => s.busPaused);
  const [selected, setSelected] = React.useState(null);
  const [filter, setFilter] = React.useState({ uart: true, spw: true, can: true });
  const [now, setNow] = React.useState(Date.now());

  // Tick the clock for the sliding window (don't advance when paused)
  React.useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [paused]);

  const SPAN = 30_000; // 30s window
  const start = now - SPAN;

  // Build lanes
  const lanes = [];
  if (filter.uart) {
    Object.entries(uartLines).forEach(([n, lines]) => {
      lanes.push({
        id: `uart${n}`,
        kind: "uart",
        label: `UART ${n}`,
        color: "#7af2a8",
        events: lines.slice(-200).map((l, i) => ({
          t: new Date(l.ts).getTime(),
          dur: 30,
          label: l.text.slice(0, 24) || "<empty>",
          tooltip: `[${l.ts.slice(11, 23)}] ${l.text}`,
          decoded: l.text,
          kind: "uart",
          src: `UART ${n}`,
        })),
      });
    });
  }
  if (filter.spw) {
    lanes.push({
      id: "spw",
      kind: "spw",
      label: "SpW",
      color: "#5eb1ff",
      events: spwPackets.slice(-200).map((p) => ({
        t: new Date(p.ts).getTime(),
        dur: 50 + Math.min(p.len, 200) * 2,
        label: p.type,
        tooltip: `${p.type}  src=${p.src}  dst=${p.dst}  len=${p.len}\naddr=${p.addr}`,
        decoded: p,
        kind: "spw",
        src: `SpW ${p.src}→${p.dst}`,
      })),
    });
  }
  if (filter.can) {
    lanes.push({
      id: "can",
      kind: "can",
      label: "CAN",
      color: "#f5b14a",
      events: canFrames.slice(-200).map((f) => ({
        t: new Date(f.ts).getTime(),
        dur: 80 + f.dlc * 6,
        label: f.id,
        tooltip: `${f.label}  id=${f.id}  dlc=${f.dlc}\ndata=${f.data}`,
        decoded: f,
        kind: "can",
        src: f.label,
      })),
    });
  }

  // Counts
  const counts = lanes.reduce((acc, l) => {
    acc[l.kind] = (acc[l.kind] || 0) + l.events.filter((e) => e.t >= start).length;
    return acc;
  }, {});
  const totalCount = lanes.reduce((acc, l) => acc + l.events.filter((e) => e.t >= start).length, 0);

  return (
    <div className="pane bus-pane">
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
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <span className="dim mono" style={{ fontSize: 10.5 }}>{totalCount} frames in last {SPAN / 1000}s</span>
          <div className="seg">
            {[
              { k: "uart", label: "UART", color: "#7af2a8" },
              { k: "spw",  label: "SpW",  color: "#5eb1ff" },
              { k: "can",  label: "CAN",  color: "#f5b14a" },
            ].map((b) => (
              <button key={b.k}
                      className={`seg-btn ${filter[b.k] ? "active" : ""}`}
                      onClick={() => setFilter({ ...filter, [b.k]: !filter[b.k] })}>
                <span className="dot" style={{ background: b.color }}></span>
                {b.label} <span className="dim">{counts[b.k] || 0}</span>
              </button>
            ))}
          </div>
          <button className={`btn ghost sm ${paused ? "active" : ""}`} onClick={() => api.setBusPaused(!paused)}>
            <Icon name={paused ? "play" : "pause"} size={11} /> {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      <div className="pane-body bus-body">
        <div className="bus-canvas">
          <BusAxis start={start} span={SPAN} />
          <div className="bus-lanes">
            {lanes.map((lane) => (
              <BusLane key={lane.id} lane={lane} start={start} span={SPAN}
                       selected={selected} onSelect={setSelected} />
            ))}
            {lanes.length === 0 && (
              <div className="bus-empty mono">All lanes filtered out</div>
            )}
            {!session && (
              <div className="bus-overlay">
                <div className="bus-overlay-title mono">— no session —</div>
                <div className="bus-overlay-sub">Create + start a session to see live bus traffic</div>
              </div>
            )}
          </div>
        </div>

        <BusInspector ev={selected} />
      </div>
    </div>
  );
}

function BusAxis({ start, span }) {
  const ticks = 6;
  return (
    <div className="bus-axis">
      <div className="bus-axis-spacer"></div>
      <div className="bus-axis-track">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const t = start + (span * i) / ticks;
          const d = new Date(t);
          const label = d.toTimeString().slice(3, 8) + "." + String(d.getMilliseconds()).padStart(3, "0").slice(0, 1) + "s";
          return (
            <div key={i} className="bus-tick" style={{ left: `${(i / ticks) * 100}%` }}>
              <span className="bus-tick-label mono">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BusLane({ lane, start, span, selected, onSelect }) {
  const visible = lane.events.filter((e) => e.t >= start && e.t <= start + span);
  return (
    <div className="bus-lane">
      <div className="bus-lane-label">
        <span className="dot" style={{ background: lane.color }}></span>
        <span className="mono">{lane.label}</span>
      </div>
      <div className="bus-lane-track">
        {/* Horizontal rule */}
        <div className="bus-lane-rule"></div>
        {visible.map((ev, i) => {
          const left = ((ev.t - start) / span) * 100;
          const width = Math.max(0.4, (ev.dur / span) * 100);
          const isSel = selected && selected.t === ev.t && selected.kind === ev.kind && selected.label === ev.label;
          return (
            <button
              key={i}
              className={`bus-blip ${ev.kind} ${isSel ? "sel" : ""}`}
              style={{ left: `${left}%`, width: `${width}%`, "--lane-color": lane.color }}
              onClick={() => onSelect(ev)}
              title={ev.tooltip}
            >
              <span className="bus-blip-label mono">{ev.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BusInspector({ ev }) {
  if (!ev) {
    return (
      <div className="bus-inspect empty">
        <div className="title mono">no frame selected</div>
        <div className="sub">Click a bar to inspect decoded payload, source/dest, and copy as API call.</div>
      </div>
    );
  }
  const d = ev.decoded;

  if (ev.kind === "uart") {
    return (
      <div className="bus-inspect">
        <div className="bus-inspect-head">
          <span className="tag green sm">UART</span>
          <span className="bus-inspect-title">{ev.src}</span>
          <span className="dim mono" style={{ marginLeft: "auto", fontSize: 10.5 }}>{new Date(ev.t).toISOString().slice(11, 23)}</span>
        </div>
        <div className="bus-inspect-body">
          <div className="kv-row"><span>Bytes</span><span className="mono accent">{d.length}</span></div>
          <div className="kv-row"><span>Text</span><span className="mono" style={{ overflowWrap: "anywhere" }}>{d}</span></div>
          <div className="kv-row"><span>Hex</span><span className="mono dim" style={{ fontSize: 10.5, overflowWrap: "anywhere" }}>{[...d].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ")}</span></div>
        </div>
      </div>
    );
  }

  if (ev.kind === "can") {
    return (
      <div className="bus-inspect">
        <div className="bus-inspect-head">
          <span className="tag amber sm">CAN</span>
          <span className="bus-inspect-title">{d.label}</span>
          <span className="dim mono" style={{ marginLeft: "auto", fontSize: 10.5 }}>{new Date(ev.t).toISOString().slice(11, 23)}</span>
        </div>
        <div className="bus-inspect-body">
          <div className="kv-row"><span>ID</span><span className="mono accent">{d.id}</span></div>
          <div className="kv-row"><span>DLC</span><span className="mono">{d.dlc}</span></div>
          <div className="kv-row"><span>Data</span><span className="mono">{d.data}</span></div>
          <div className="kv-row"><span>API</span><span className="mono accent">canSend({d.id}, [{d.data.split(" ").map(b => "0x" + b).join(", ")}])</span></div>
        </div>
      </div>
    );
  }

  if (ev.kind === "spw") {
    return (
      <div className="bus-inspect">
        <div className="bus-inspect-head">
          <span className="tag blue sm">SpW</span>
          <span className="bus-inspect-title">{d.type}</span>
          <span className="dim mono" style={{ marginLeft: "auto", fontSize: 10.5 }}>{new Date(ev.t).toISOString().slice(11, 23)}</span>
        </div>
        <div className="bus-inspect-body">
          <div className="kv-row"><span>Src→Dst</span><span className="mono accent">{d.src} → {d.dst}</span></div>
          <div className="kv-row"><span>Length</span><span className="mono">{d.len} bytes</span></div>
          <div className="kv-row"><span>RMAP addr</span><span className="mono accent">{d.addr}</span></div>
          <div className="kv-row"><span>API</span><span className="mono accent">spwInject({d.src}, {d.dst}, "{d.type}", {d.len})</span></div>
        </div>
      </div>
    );
  }

  return null;
}

window.BusTimelinePane = BusTimelinePane;
