/* global React, useStore, api, MACHINES, formatBytes, Icon */
const { useState, useRef, useCallback } = React;

// ── Side panel: file uploader + session config ──────────
function SidePanel() {
  const view = useStore((s) => s.activeView || "session");
  return (
    <div className="sidepanel">
      <div className="sidepanel-header">
        <span className="sidepanel-title">Workspace</span>
        <span className="tag blue">v0</span>
      </div>
      <div className="sidepanel-body">
        <UploaderSection />
        <MachineSection />
        <SessionConfigSection />
      </div>
    </div>
  );
}

function Section({ title, defaultOpen = true, right, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? "" : "collapsed"}`}>
      <div className="section-header" onClick={() => setOpen((o) => !o)}>
        <span className="label">
          <Icon name="chev" size={12} className="chev" />
          <span className="chev"><Icon name="chev" size={11} /></span>
          {title}
        </span>
        {right}
      </div>
      <div className="section-body">{children}</div>
    </div>
  );
}

function UploaderSection() {
  const uploads = useStore((s) => s.uploads);
  const selected = useStore((s) => s.selectedKernel);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const onFiles = useCallback((files) => {
    Array.from(files).forEach((f) => api.upload(f));
  }, []);

  return (
    <Section title="Application">
      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <Icon name="upload" size={22} />
        <span className="primary">Drop ELF or .boot here</span>
        <span className="secondary">or click to browse · max 32 MiB</span>
        <input ref={inputRef} type="file" hidden onChange={(e) => e.target.files && onFiles(e.target.files)} />
      </div>
      <div className="uploaded-list">
        {uploads.map((u) => (
          <div
            key={u.id}
            className={`uploaded-item ${selected === u.kernel_url ? "selected" : ""}`}
            onClick={() => api.selectKernel(u.kernel_url)}
          >
            <span className={`tag ${u.kind === "MKPROM" ? "amber" : "blue"}`}>{u.kind}</span>
            <span className="name" title={u.filename}>{u.filename}</span>
            <span className="size">{formatBytes(u.size)}</span>
            <button className="btn ghost icon sm" onClick={(e) => { e.stopPropagation(); api.removeUpload(u.id); }} title="Remove">
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        {uploads.length === 0 && (
          <div className="faint mono" style={{ padding: "8px 4px", fontSize: 11 }}>No uploads yet.</div>
        )}
      </div>
    </Section>
  );
}

function MachineSection() {
  const draft = useStore((s) => s.draftMachine);
  const session = useStore((s) => s.session);
  return (
    <Section title="Machine">
      {MACHINES.map((m) => (
        <div
          key={m.id}
          className={`machine-card ${draft === m.id ? "selected" : ""}`}
          style={{ marginBottom: 8, opacity: session ? 0.5 : 1, pointerEvents: session ? "none" : "auto" }}
          onClick={() => {
            api.setDraft({
              draftMachine: m.id,
              draftSmp: m.cpus,
              draftRamMb: m.default_ram_mb,
            });
          }}
        >
          <div className="name">
            <span className="id">{m.id}</span>
            <span className="arch">{m.arch}</span>
          </div>
          <div className="desc">{m.description}</div>
          <div className="specs">
            <div className="spec"><span className="l">CPUs</span><span className="v">{m.cpus}</span></div>
            <div className="spec"><span className="l">UART</span><span className="v">{m.uart_count}</span></div>
            <div className="spec"><span className="l">Max RAM</span><span className="v">{m.max_ram_mb}M</span></div>
          </div>
        </div>
      ))}
    </Section>
  );
}

function SessionConfigSection() {
  const draft = useStore((s) => ({ machine: s.draftMachine, smp: s.draftSmp, ram: s.draftRamMb }));
  const selected = useStore((s) => s.selectedKernel);
  const session = useStore((s) => s.session);
  const machine = MACHINES.find((m) => m.id === draft.machine);

  return (
    <Section title="Configure">
      <div className="field">
        <div className="field-label">
          <span>SMP — CPUs enabled</span>
          <span className="hint">{draft.smp} / {machine.cpus}</span>
        </div>
        <input
          type="range" min={1} max={machine.cpus} step={1}
          value={draft.smp}
          disabled={!!session}
          className="slider"
          onChange={(e) => api.setDraft({ draftSmp: +e.target.value })}
        />
      </div>
      <div className="field">
        <div className="field-label">
          <span>RAM</span>
          <span className="hint">{draft.ram} MiB / {machine.max_ram_mb}M</span>
        </div>
        <input
          type="range" min={16} max={machine.max_ram_mb} step={16}
          value={draft.ram}
          disabled={!!session}
          className="slider"
          onChange={(e) => api.setDraft({ draftRamMb: +e.target.value })}
        />
      </div>
      <div className="field">
        <div className="field-label"><span>Kernel</span></div>
        <div className="input mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected ? "var(--accent)" : "var(--text-faint)" }}>
          {selected || "— select an upload above —"}
        </div>
      </div>

      <div className="row" style={{ marginTop: 6 }}>
        {!session && (
          <button className="btn primary" disabled={!selected} onClick={api.createSession} style={{ flex: 1 }}>
            <Icon name="plus" size={13} /> Create session
          </button>
        )}
        {session && (
          <button className="btn danger" onClick={api.deleteSession} style={{ flex: 1 }}>
            <Icon name="trash" size={13} /> Delete session
          </button>
        )}
      </div>
      <div className="faint mono" style={{ fontSize: 10.5, marginTop: 8, lineHeight: 1.5 }}>
        Single-session model. <span className="inline-code">DELETE /session</span> before creating a new one.
      </div>
    </Section>
  );
}

window.SidePanel = SidePanel;
