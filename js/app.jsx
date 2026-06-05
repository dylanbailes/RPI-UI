/* ============================================================================
 * app.jsx — Shell: header, tab router, global E-STOP, toasts, Tweaks.
 * ========================================================================== */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#FF3000",
  "wellLayout": "stacked",
  "chartStyle": "area",
  "chartGrid": true
}/*EDITMODE-END*/;

function Toasts({ items }) {
  return (
    <div className="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={'toast' + (t.kind !== 'error' ? ' accent' : '')}>
          <span className="t-accent">{t.kind === 'error' ? '⚠' : t.kind === 'shot' ? '◉' : '✓'}</span>
          <span style={{ textTransform: t.kind === 'shot' ? 'none' : 'uppercase', fontFamily: t.kind === 'shot' ? 'var(--mono)' : 'inherit', fontSize: t.kind === 'shot' ? 12 : 13 }}>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [phase, setPhase] = React.useState('connect');
  const [tab, setTab] = React.useState('CONTROL');
  const [dialog, setDialog] = React.useState(null);   // {mode, well, metric}
  const [toasts, setToasts] = React.useState([]);
  useEngineTick(6);

  // apply accent to CSS + scale kiosk to viewport
  React.useEffect(() => { document.documentElement.style.setProperty('--accent', t.accent); }, [t.accent]);
  React.useEffect(() => {
    function fit() {
      const app = document.getElementById('app');
      if (!app) return;
      const w = window.innerWidth || 1280, h = window.innerHeight || 800;
      let s = Math.min(w / 1280, h / 800);
      if (!isFinite(s) || s <= 0) s = 1;
      app.style.transform = `scale(${s})`;
    }
    fit();
    requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
    window.addEventListener('load', fit);
    const ro = new ResizeObserver(fit);
    ro.observe(document.getElementById('viewport'));
    return () => { window.removeEventListener('resize', fit); window.removeEventListener('load', fit); ro.disconnect(); };
  }, []);

  function pushToast(o) {
    const id = Date.now() + Math.random();
    setToasts((s) => [...s.slice(-2), { ...o, id }]);
    setTimeout(() => setToasts((s) => s.filter((x) => x.id !== id)), o.kind === 'shot' ? 2600 : 2400);
  }

  function onConnect(map) {
    window.MCCB.engine.assign(map);
    window.MCCB.engine.start();
    setPhase('main'); setTab('CONTROL');
    // seed a little activity so charts aren't empty on arrival
    const wells = window.MCCB.engine.assignedWells;
    if (wells[0]) window.MCCB.engine.setParams(wells[0], { efield: 0.9, gauss: 6 });
    if (wells[1]) window.MCCB.engine.setParams(wells[1], { efield: 0.4 });
  }
  function reconfigure() { window.MCCB.engine.stop(); setPhase('connect'); }

  function onConfigure(wellNum, metric) {
    if (metric === 'reconfigure') { reconfigure(); return; }
    const mode = metric === 'magnetic' ? 'magnetic' : metric === 'electric' ? 'electric' : 'dual';
    setDialog({ mode, well: wellNum, metric });
  }

  const eng = window.MCCB.engine;
  const active = eng.anyActive;
  const stopped = eng.globalStopped && !active;

  if (phase === 'connect') {
    return (
      <React.Fragment>
        <ConnectionScreen onConnect={onConnect} onExit={() => pushToast({ kind: 'error', text: 'Exit disabled in preview (kiosk quits app)' })} />
        <Toasts items={toasts} />
        <TweaksPanelMount t={t} setTweak={setTweak} />
      </React.Fragment>
    );
  }

  const wellTabs = [1, 2, 3, 4];
  return (
    <React.Fragment>
      {/* Header */}
      <div className="app-header">
        <div className="brand-mark"></div>
        <div className="app-title">MCCB Controller</div>
        <div className={'live-tag'} style={{ marginLeft: 8 }}>
          <span className={'live-dot' + (active ? ' on' : '')} style={{ background: active ? 'var(--ok)' : 'var(--disabled)' }}></span>
          {active ? 'STIMULATION ACTIVE' : stopped ? 'ALL STOPPED' : 'IDLE'}
        </div>
        <div className="grow"></div>
        <button className="btn btn-secondary btn-sm" style={{ minWidth: 200 }} onClick={reconfigure}>Reconfigure Ports</button>
        <button className={'estop' + (active ? ' armed' : '')} onClick={() => { eng.stopAll(); pushToast({ kind: 'error', text: 'Global stop — all fields zeroed' }); }}>
          <span className="estop-ring"></span>Stop All
        </button>
      </div>

      {/* Tabs */}
      <div className="tabbar">
        <button className={'tab' + (tab === 'CONTROL' ? ' sel' : '')} onClick={() => setTab('CONTROL')}>Control</button>
        {wellTabs.map((n) => {
          const assigned = eng.wells[n].assigned;
          return (
            <button key={n} className={'tab' + (tab === 'WELL' + n ? ' sel' : '')} style={{ opacity: assigned ? 1 : .55 }} onClick={() => setTab('WELL' + n)}>
              Well {n}{assigned && <span className="tab-badge"></span>}
            </button>
          );
        })}
        <button className={'tab' + (tab === 'IMAGING' ? ' sel' : '')} onClick={() => setTab('IMAGING')}>Imaging</button>
      </div>

      {/* Pages */}
      <div className="tab-stack">
        <div key={tab} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
          {tab === 'CONTROL' && <ControlTab accent={t.accent} onMode={(m) => setDialog({ mode: m })} onConfigure={onConfigure} />}
          {wellTabs.map((n) => tab === 'WELL' + n && (
            <WellTab key={n} wellNum={n} layout={t.wellLayout} variant={t.chartStyle} grid={t.chartGrid} accent={t.accent} onConfigure={onConfigure} />
          ))}
          {tab === 'IMAGING' && <ImagingTab onToast={pushToast} />}
        </div>
      </div>

      {dialog && <ModeDialog mode={dialog.mode} initialWell={dialog.well} initialMetric={dialog.metric} onClose={() => setDialog(null)} onToast={pushToast} />}
      <Toasts items={toasts} />
      <TweaksPanelMount t={t} setTweak={setTweak} />
    </React.Fragment>
  );
}

function TweaksPanelMount({ t, setTweak }) {
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection label="Graph styling" />
      <TweakRadio label="Chart style" value={t.chartStyle} options={['area', 'line', 'bars']} onChange={(v) => setTweak('chartStyle', v)} />
      <TweakToggle label="Gridlines" value={t.chartGrid} onChange={(v) => setTweak('chartGrid', v)} />
      <TweakSection label="Well tab layout" />
      <TweakRadio label="Layout" value={t.wellLayout} options={['stacked', 'split', 'focus']} onChange={(v) => setTweak('wellLayout', v)} />
      <TweakSection label="Accent" />
      <TweakColor label="Signal color" value={t.accent}
        options={['#FF3000', '#2A6FDB', '#1F8A5B', '#7A5AE0', '#E0A800']}
        onChange={(v) => setTweak('accent', v)} />
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<App />);
