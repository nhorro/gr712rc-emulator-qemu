/* global React, useStore, api, Icon, MACHINES */
const { useMemo: useGpioMemo } = React;

function GpioBoardPane({ tabs, active, onTab }) {
  const gpio = useStore((s) => s.gpio);
  const session = useStore((s) => s.session);
  const draftMachine = useStore((s) => s.draftMachine);
  const machineId = session?.machine || draftMachine;
  const [selected, setSelected] = React.useState(0);
  const [filter, setFilter] = React.useState("all");

  // Re-init pins if session machine changes
  React.useEffect(() => {
    if (!gpio.length || (machineId === "gr740" && gpio.length !== 16) || (machineId === "gr712rc" && gpio.length !== 32)) {
      api.syncGpioForMachine(machineId);
    }
  }, [machineId]);

  const filtered = gpio.filter((p) => filter === "all" ? true : p.dir === filter);

  // Two-column board: even pins left, odd pins right (DIP-style)
  const left = filtered.filter((_, i) => i % 2 === 0);
  const right = filtered.filter((_, i) => i % 2 === 1);

  const sel = gpio[selected];

  return (
    <div className="pane gpio-pane">
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
          <span className="dim mono" style={{ fontSize: 10.5 }}>{machineId.toUpperCase()} · {gpio.length} lines</span>
          <div className="seg">
            {["all", "out", "in"].map((f) => (
              <button key={f}
                      className={`seg-btn ${filter === f ? "active" : ""}`}
                      onClick={() => setFilter(f)}>
                {f === "all" ? "all" : f}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="pane-body gpio-body">
        <div className="gpio-board">
          <div className="gpio-board-frame">
            <div className="gpio-board-label">GR · BREAKOUT</div>
            <div className="gpio-board-rows">
              <div className="gpio-col">
                {left.map((pin) => (
                  <PinRow key={pin.n} pin={pin} side="left" selected={selected === pin.n} onSelect={setSelected} />
                ))}
              </div>
              <div className="gpio-trace">
                {Array.from({ length: Math.max(left.length, right.length) }).map((_, i) => (
                  <div key={i} className="gpio-trace-rail"></div>
                ))}
              </div>
              <div className="gpio-col">
                {right.map((pin) => (
                  <PinRow key={pin.n} pin={pin} side="right" selected={selected === pin.n} onSelect={setSelected} />
                ))}
              </div>
            </div>
            <div className="gpio-board-footer mono">GRGPIO · 0x8000C000 · IRQ 5</div>
          </div>
        </div>

        <PinDetail pin={sel} />
      </div>
    </div>
  );
}

function PinRow({ pin, side, selected, onSelect }) {
  return (
    <button
      className={`pin-row ${side} ${selected ? "sel" : ""} ${pin.dir} ${pin.level ? "high" : "low"}`}
      onClick={() => {
        onSelect(pin.n);
        if (pin.dir === "in") api.toggleGpio(pin.n);
      }}
      title={pin.dir === "in" ? "Click to drive" : "Driven by FSW"}
    >
      {side === "left" && (
        <>
          <span className="pin-num mono">{String(pin.n).padStart(2, "0")}</span>
          <span className={`pin-dot ${pin.level ? "high" : "low"}`}></span>
          <span className="pin-label mono">{pin.label}</span>
          <span className={`pin-dir ${pin.dir}`}>{pin.dir.toUpperCase()}</span>
        </>
      )}
      {side === "right" && (
        <>
          <span className={`pin-dir ${pin.dir}`}>{pin.dir.toUpperCase()}</span>
          <span className="pin-label mono">{pin.label}</span>
          <span className={`pin-dot ${pin.level ? "high" : "low"}`}></span>
          <span className="pin-num mono">{String(pin.n).padStart(2, "0")}</span>
        </>
      )}
    </button>
  );
}

function PinDetail({ pin }) {
  if (!pin) return null;
  const sinceMs = pin.lastChange ? Date.now() - pin.lastChange : null;

  return (
    <div className="pin-detail">
      <div className="pin-detail-head">
        <div>
          <div className="pin-detail-eyebrow mono">GPIO[{pin.n}]</div>
          <div className="pin-detail-title">{pin.label}</div>
        </div>
        <div className={`big-level ${pin.level ? "high" : "low"}`}>
          <span className="lvl-led"></span>
          <span className="lvl-text mono">{pin.level ? "HIGH" : "LOW"}</span>
        </div>
      </div>

      <div className="pin-detail-kv">
        <div><span className="k">Direction</span><span className={`v tag ${pin.dir === "out" ? "blue" : "green"} sm`}>{pin.dir === "out" ? "OUTPUT (FSW → host)" : "INPUT (host → FSW)"}</span></div>
        <div><span className="k">Register bit</span><span className="v mono accent">DATA[{pin.n}]</span></div>
        <div><span className="k">MMIO</span><span className="v mono accent">0x8000C000 + 0x00</span></div>
        <div><span className="k">IRQ on edge</span><span className="v mono">5 (shared)</span></div>
        <div><span className="k">Last change</span><span className="v mono">{sinceMs == null ? "—" : `${(sinceMs / 1000).toFixed(2)}s ago`}</span></div>
      </div>

      <div className="pin-trace">
        <div className="pin-trace-label mono">TIMELINE  ·  last 200 transitions</div>
        <PinTrace history={pin.history} level={pin.level} />
      </div>

      {pin.dir === "in" && (
        <div className="pin-actions">
          <button className="btn primary sm" onClick={() => api._driveGpio(pin.n, pin.level ? 0 : 1, true)}>
            Drive {pin.level ? "LOW" : "HIGH"}
          </button>
          <button className="btn ghost sm mono" onClick={() => navigator.clipboard?.writeText(`gpioWrite(${pin.n}, ${pin.level ? 0 : 1})`)} title="Copy API call">
            <Icon name="clip" size={11} />  gpioWrite({pin.n}, {pin.level ? 0 : 1})
          </button>
        </div>
      )}
      {pin.dir === "out" && (
        <div className="pin-actions">
          <button className="btn ghost sm mono" onClick={() => navigator.clipboard?.writeText(`gpioRead(${pin.n})`)} title="Copy API call">
            <Icon name="clip" size={11} />  gpioRead({pin.n})  →  {pin.level}
          </button>
          <span className="dim mono" style={{ fontSize: 10 }}>output — driven by guest software</span>
        </div>
      )}
    </div>
  );
}

function PinTrace({ history, level }) {
  // Render last 10s of waveform
  const now = Date.now();
  const span = 10000;
  const start = now - span;
  // Build a waveform from history. Initial level = first historical or current.
  const events = history.filter((h) => h.t >= start);
  const initialLevel = events.length ? (events[0].level ^ 1) : level;
  const W = 380, H = 36;
  const xOf = (t) => ((t - start) / span) * W;

  const points = [];
  let curLvl = initialLevel;
  let curT = start;
  // Always start drawing at left edge
  points.push([0, levelY(curLvl)]);
  events.forEach((ev) => {
    points.push([xOf(ev.t), levelY(curLvl)]);
    points.push([xOf(ev.t), levelY(ev.level)]);
    curLvl = ev.level;
    curT = ev.t;
  });
  points.push([W, levelY(curLvl)]);

  function levelY(l) { return l ? 6 : H - 6; }

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="pin-trace-svg">
      <line x1="0" y1={H - 6} x2={W} y2={H - 6} stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3" />
      <line x1="0" y1={6}   x2={W} y2={6}   stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3" />
      <text x="2" y={H - 1}   fill="#5a6470" fontFamily="var(--font-mono)" fontSize="8.5">0</text>
      <text x="2" y={11}      fill="#5a6470" fontFamily="var(--font-mono)" fontSize="8.5">1</text>
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
    </svg>
  );
}

window.GpioBoardPane = GpioBoardPane;
