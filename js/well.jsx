/* ============================================================================
well.jsx — Per-well data tabs. Graph-primary, animated readouts,
collapsible terminal log, COMBINED / ELECTRIC / MAGNETIC sub-views.
Layout + chart styling are driven by Tweaks.
========================================================================== */
import React from 'react';

// ---- Single readout cell --------------------------------------------------
function Readout({ label, value, decimals = 2, unit, accent }) {
  return (
    <div className={'readout' + (accent ? ' accent' : '')}>
      <div className="ro-label">{label}</div>
      <div>
        <AnimatedNumber className="ro-value" value={value} decimals={decimals} />
        {unit && <span className="ro-unit">{unit}</span>}
      </div>
    </div>
  );
}

// ---- Terminal log with pause / clear --------------------------------------
function LogPanel({ well, filter, height }) {
  useEngineTick(8);
  const [paused, setPaused] = React.useState(false);
  const frozen = React.useRef(null);
  const scrollRef = React.useRef(null);
  
  let lines = well.log;
  if (filter) lines = lines.filter((l) => l.includes(filter));
  if (paused) { 
    if (!frozen.current) frozen.current = lines.slice(); 
    lines = frozen.current; 
  } else if (frozen.current) {
    frozen.current = null; 
  }
  
  const shown = lines.slice(-80);
  React.useEffect(() => {
    if (!paused && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  });

  return (
    <div className="col" style={{ height, minHeight: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '6px 2px', alignItems: 'center' }}>
        <span className="kicker">Raw Serial Feed{filter ? ' · ' + filter : ''}</span>
        <div className="row gap-8">
          <button className="btn btn-secondary btn-sm" style={{ minHeight: 38, minWidth: 92 }} onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn btn-secondary btn-sm" style={{ minHeight: 38, minWidth: 92 }} onClick={() => { well.log.length = 0; frozen.current = null; }}>
            Clear
          </button>
        </div>
      </div>
      <div className="term grow" ref={scrollRef}>
        {shown.length === 0
          ? <div className="ln" style={{ opacity: .5 }}> &gt; awaiting data…</div>
          : shown.map((l, i) => (
              <div className={'ln' + (i === shown.length - 1 ? ' fresh' : '')} key={i}>
                &gt; {l}
              </div>
            ))}
      </div>
    </div>
  );
}

// ---- Chart card (header + live chart) -------------------------------------
function ChartCard({ title, well, accessor, accent, variant, grid, height }) {
  return (
    <div className="gb" style={{ marginTop: 0, display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
      <div className="gb-title">{title}</div>
      <div style={{ padding: '20px 10px 10px', flex: '1 1 auto', minHeight: 0, display: 'flex' }}>
        <div style={{ width: '100%', height: height || '100%' }}>
          <LiveChart
            getSeries={() => accessor.series()}
            getSetpoint={() => accessor.setpoint()}
            getLatest={() => accessor.latest()}
            max={accessor.max} color={accent} variant={variant} grid={grid}
            height={height || '100%'}
          />
        </div>
      </div>
    </div>
  );
}

// ---- One metric view (electric or magnetic) -------------------------------
function MetricView({ well, metric, layout, variant, grid, accent, onConfigure }) {
  useEngineTick(10);
  const isE = metric === 'electric';
  
  // UPDATED: Pass both gauss1 and gauss2 arrays to the chart!
  const acc = isE
    ? { series: () => well.history.efield.values, setpoint: () => well.setEfield, latest: () => well.measEfield, max: window.MCCB.MAX_EFIELD }
    : { series: () => [well.history.gauss1.values, well.history.gauss2.values], setpoint: () => well.setGauss, latest: () => well.measGauss1, max: window.MCCB.MAX_MAG };
    
  const status = isE ? well.electricStatus : well.magneticStatus;
  const title = isE ? 'Electric Field' : 'Magnetic Field';
  const filter = isE ? 'voltage' : 'gauss';
  
  const readouts = isE ? (
    <React.Fragment>
      <Readout label="Setpoint" value={well.setEfield} unit="V/cm" />
      <Readout label="Measured" value={well.measEfield} unit="V/cm" accent />
      <Readout label="Voltage" value={well.voltage} decimals={3} unit="V" />
      <Readout label="Current" value={well.current} decimals={2} unit="mA" />
    </React.Fragment>
  ) : (
    // UPDATED: Show HE1, HE1 RMS, HE2, HE2 RMS
    <React.Fragment>
      <Readout label="HE1 Inst." value={well.measGauss1} unit="G" accent />
      <Readout label="HE1 RMS (2s)" value={well.rms1} unit="G" />
      <Readout label="HE2 Inst." value={well.measGauss2} unit="G" accent />
      <Readout label="HE2 RMS (2s)" value={well.rms2} unit="G" />
    </React.Fragment>
  );
  
  const roCols = 4; // 4 columns fits perfectly for both views now
  const chart = <ChartCard title={title + ' — Measured vs Setpoint'} well={well} accessor={acc} accent={accent} variant={variant} grid={grid} />;

  // ... The rest of MetricView remains exactly the same ...
  return (
    <div className="col grow" style={{ padding: 18, gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</h2>
          <StatusPill status={status} big />
        </div>
        <div className="row gap-8">
          <button className="btn btn-secondary btn-sm" style={{ minWidth: 150 }} onClick={() => onConfigure(well.num, metric)}>Set Value</button>
          <button className="btn btn-danger btn-sm" style={{ minWidth: 120 }} onClick={() => window.MCCB.engine.stopWell(well.num)}>Stop</button>
        </div>
      </div>
      
      <div className="readout-strip" style={{ gridTemplateColumns: `repeat(${roCols}, 1fr)` }}>{readouts}</div>

      {layout === 'split' ? (
        <div className="row grow gap-12" style={{ minHeight: 0 }}>
          <div className="col" style={{ flex: '1.7 1 0', minWidth: 0 }}>{chart}</div>
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex' }}>
            <div className="gb grow" style={{ marginTop: 0, display: 'flex', flexDirection: 'column' }}>
              <div className="gb-title">Log</div>
              <div className="grow" style={{ padding: '20px 10px 10px', minHeight: 0, display: 'flex' }}>
                <LogPanel well={well} filter={filter} height="100%" />
              </div>
            </div>
          </div>
        </div>
      ) : layout === 'focus' ? (
        <div className="grow" style={{ display: 'flex', minHeight: 0 }}>{chart}</div>
      ) : (
        <CollapsibleStack chart={chart} well={well} filter={filter} />
      )}
    </div>
  );
}

// ---- Stacked layout: chart grows, log collapses ---------------------------
function CollapsibleStack({ chart, well, filter }) {
  const [open, setOpen] = React.useState(false);
  return (
    <React.Fragment>
      <div className="grow" style={{ display: 'flex', minHeight: 0 }}>{chart}</div>
      <div className="col" style={{ flex: '0 0 auto' }}>
        <button className="btn btn-secondary btn-sm btn-block" style={{ justifyContent: 'space-between', minHeight: 42 }} onClick={() => setOpen((o) => !o)}>
          <span>Raw Serial Log</span>
          <span style={{ transition: 'transform .25s', display: 'inline-block', transform: open ? 'rotate(180deg)' : 'none' }}>▾</span>
        </button>
        <div className="log-collapse" style={{ height: open ? 190 : 0 }}>
          {open && <div style={{ paddingTop: 8, height: 182 }}><LogPanel well={well} filter={filter} height="100%" /></div>}
        </div>
      </div>
    </React.Fragment>
  );
}

// ---- Combined overview ----------------------------------------------------
function CombinedView({ well, layout, variant, grid, accent, onConfigure }) {
  useEngineTick(10);
  const eAcc = { series: () => well.history.efield.values, setpoint: () => well.setEfield, latest: () => well.measEfield, max: window.MCCB.MAX_EFIELD };
  const mAcc = { series: () => well.history.gauss.values, setpoint: () => well.setGauss, latest: () => well.measGauss, max: window.MCCB.MAX_MAG };
  const side = layout === 'split';
  
  const block = (title, acc, status, setVal, measVal, unit, mode, rmsVal) => (
    <div className="col grow" style={{ minHeight: 0, gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <span style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</span>
          <StatusPill status={status} />
        </div>
        <div className="row gap-16" style={{ alignItems: 'baseline' }}>
          <span className="kicker">SET <span className="mono" style={{ color: '#000', fontSize: 14 }}>{setVal.toFixed(2)}</span></span>
          <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: accent }}>
            <AnimatedNumber value={measVal} decimals={2} /><span className="ro-unit">{unit}</span>
          </span>
          {/* NEW: Compact RMS indicator in combined view */}
          {rmsVal !== undefined && (
            <span className="kicker" style={{ color: 'var(--dim)' }}>
              RMS: <span className="mono" style={{ color: 'var(--ink)', fontSize: 14 }}>{rmsVal.toFixed(2)}</span>
            </span>
          )}
          <button className="btn btn-secondary btn-sm" style={{ minHeight: 38, minWidth: 96 }} onClick={() => onConfigure(well.num, mode)}>Set</button>
        </div>
      </div>
      <ChartCard title={title + ' — Measured vs Setpoint'} well={well} accessor={acc} accent={accent} variant={variant} grid={grid} />
    </div>
  );

  return (
    <div className="col grow" style={{ padding: 18, gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1 }}>All Data</h2>
          <span className="kicker">{well.label || well.port || ''}</span>
        </div>
        <button className="btn btn-danger btn-sm" style={{ minWidth: 150 }} onClick={() => window.MCCB.engine.stopWell(well.num)}>Stop Well</button>
      </div>
      <div className={side ? 'row grow gap-14' : 'col grow gap-14'} style={{ minHeight: 0 }}>
        {block('Electric', eAcc, well.electricStatus, well.setEfield, well.measEfield, 'V/cm', 'electric')}
        {block('Magnetic', mAcc, well.magneticStatus, well.setGauss, well.measGauss, 'G', 'magnetic', well.measRms)}
      </div>
    </div>
  );
}

// ---- Well container with sub-nav ------------------------------------------
function WellTab({ wellNum, layout, variant, grid, accent, onConfigure }) {
  const well = window.MCCB.engine.wells[wellNum];
  const [view, setView] = React.useState('COMBINED');
  
  if (!well.assigned) {
    return (
      <div className="well-wrap">
        <div className="well-side">
          <div className="well-side-hd">WELL {wellNum}</div>
        </div>
        <div className="empty-well">
          <div className="empty-badge" style={{ fontSize: 26 }}>∅</div>
          <div style={{ fontWeight: 800, letterSpacing: 2, textTransform: 'uppercase' }}>No Device Assigned</div>
          <div style={{ color: 'var(--dim)', fontSize: 13, maxWidth: 320, textAlign: 'center', lineHeight: 1.5 }}>
            Well {wellNum} has no serial device mapped. Use <strong>Reconfigure Ports</strong> in the header to assign an ESP32.
          </div>
          <button className="btn btn-sm" style={{ marginTop: 6, minWidth: 200 }} onClick={() => onConfigure(wellNum, 'reconfigure')}>Reconfigure Ports</button>
        </div>
      </div>
    );
  }

  const navItems = [['COMBINED', 'All Data'], ['ELECTRIC', 'Electric'], ['MAGNETIC', 'Magnetic']];
  
  return (
    <div className="well-wrap">
      <div className="well-side">
        <div className="well-side-hd">WELL {wellNum}</div>
        {navItems.map(([v, sub]) => (
          <button key={v} className={'side-nav' + (view === v ? ' sel' : '')} onClick={() => setView(v)}>
            {v} <small>{sub}</small>
          </button>
        ))}
        <div className="grow"></div>
        <div style={{ padding: 14, borderTop: '2px solid #000' }}>
          <div className="kicker" style={{ marginBottom: 6 }}>Port</div>
          <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{well.port}</div>
        </div>
      </div>
      <div className="well-body">
        <div className="page-enter" key={view} style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {view === 'COMBINED' && <CombinedView well={well} layout={layout} variant={variant} grid={grid} accent={accent} onConfigure={onConfigure} />}
          {view === 'ELECTRIC' && <MetricView well={well} metric="electric" layout={layout} variant={variant} grid={grid} accent={accent} onConfigure={onConfigure} />}
          {view === 'MAGNETIC' && <MetricView well={well} metric="magnetic" layout={layout} variant={variant} grid={grid} accent={accent} onConfigure={onConfigure} />}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { WellTab });
export default WellTab;