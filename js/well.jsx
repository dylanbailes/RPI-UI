/* ============================================================================
well.jsx — Per-well data tabs. Graph-primary, animated readouts,
collapsible terminal log, COMBINED / ELECTRIC / MAGNETIC sub-views.

FIX 1 — Raw Serial Feed:
  LogPanel no longer over-filters. When no `filter` is passed (Combined view,
  no sub-filter), ALL lines are shown. When a `filter` keyword is provided
  (e.g. "voltage" or "gauss"), system lines (starting with "»") are always
  shown, AND raw lines that contain the keyword are shown. Raw lines that
  don't match are still shown in the unfiltered panel so nothing is hidden from
  the operator. The "Raw Serial Feed" label now correctly reflects the filter.

FIX 2 — Dual-series graphing:
  LiveChart and MiniSpark accept `getSeries()` returning either a flat number[]
  (single series) OR an array of number[] (multi-series). When multiple series
  are detected they are drawn with distinct colours (accent + a muted secondary)
  so both gauss1 and gauss2 are visible on the same chart.
========================================================================== */
import React from 'react';

// ---- helpers assumed global (defined in charts.jsx) ----------------------
// AnimatedNumber, StatusPill, useEngineTick — accessed via window.* or
// declared inline as fallbacks below so this file is self-contained if
// charts.jsx hasn't loaded yet.

function AnimatedNumber({ value = 0, decimals = 2, className, style }) {
  // charts.jsx provides a fancier version; this is the fallback.
  if (window.AnimatedNumber) return React.createElement(window.AnimatedNumber, { value, decimals, className, style });
  return <span className={className} style={style}>{Number(value).toFixed(decimals)}</span>;
}
function StatusPill({ status, big }) {
  if (window.StatusPill) return React.createElement(window.StatusPill, { status, big });
  const map = { OFF: ['#aaa', '#f4f4f4'], LOCKED: ['#16A34A', '#D8F3DF'], RAMPING: ['#C98A00', '#FFF3CD'], OVER: ['#e00', '#ffe'], };
  const [dot, bg] = map[status] || ['#aaa', '#eee'];
  return <span style={{ display:'inline-flex', alignItems:'center', gap:4, background:bg, borderRadius:2, padding:'2px 7px', fontSize:10, fontWeight:700 }}><span style={{ width:6,height:6,borderRadius:'50%',background:dot,display:'inline-block' }}></span>{status}</span>;
}
function useEngineTick(fps = 10) {
  const [, force] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => {
    if (!window.MCCB || !window.MCCB.engine) return;
    let last = 0;
    const minDt = 1000 / fps;
    const unsub = window.MCCB.engine.subscribe(() => {
      const now = performance.now();
      if (now - last >= minDt) { last = now; force(); }
    });
    return () => unsub && unsub();
  }, [fps]);
}

// ---- Multi-series SVG chart (inline — avoids dependency on charts.jsx) ----
// getSeries() → number[]  (single)  OR  number[][] (multi)
// When multi: index 0 uses `color` (accent), index 1 uses SECONDARY_COLOR, etc.
const SERIES_COLORS = ['var(--accent, #FF3000)', '#2A6FDB', '#1F8A5B', '#7A5AE0'];

function LiveChart({ getSeries, getSetpoint, getLatest, max, color, variant = 'area', grid = true, height = '100%' }) {
  const ref = React.useRef(null);
  const raf = React.useRef(null);

  function draw() {
    const canvas = ref.current;
    if (!canvas) return;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const PAD = { top: 8, right: 8, bottom: 22, left: 40 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top - PAD.bottom;

    // Gridlines
    if (grid) {
      ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = PAD.top + cH - (cH * i / 4);
        ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
      }
    }

    // Y-axis labels
    ctx.fillStyle = '#888'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = max * i / 4;
      const y = PAD.top + cH - (cH * i / 4);
      ctx.fillText(val.toFixed(1), PAD.left - 4, y + 3);
    }

    // Normalise getSeries() into always-an-array-of-arrays
    const raw = getSeries ? getSeries() : [];
    const isMulti = Array.isArray(raw[0]);
    const seriesArr = isMulti ? raw : [raw];

    seriesArr.forEach((data, si) => {
      if (!data || data.length < 2) return;
      const serColor = color && si === 0 ? color : SERIES_COLORS[si] || SERIES_COLORS[si % SERIES_COLORS.length];
      const pts = data.map((v, i) => ({
        x: PAD.left + (i / (data.length - 1)) * cW,
        y: PAD.top + cH - Math.max(0, Math.min(1, v / max)) * cH,
      }));

      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));

      if (variant === 'area' && si === 0) {
        const path = new Path2D();
        pts.forEach((p, i) => i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y));
        path.lineTo(pts[pts.length - 1].x, PAD.top + cH);
        path.lineTo(PAD.left, PAD.top + cH);
        path.closePath();
        const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
        grad.addColorStop(0, serColor + '55');
        grad.addColorStop(1, serColor + '08');
        ctx.fillStyle = grad;
        ctx.fill(path);
      }

      ctx.strokeStyle = si > 0 ? (serColor + 'cc') : serColor;
      ctx.lineWidth = si === 0 ? 2 : 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    });

    // Setpoint line
    if (getSetpoint) {
      const sp = getSetpoint();
      if (sp > 0) {
        const spY = PAD.top + cH - Math.max(0, Math.min(1, sp / max)) * cH;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD.left, spY); ctx.lineTo(PAD.left + cW, spY); ctx.stroke();
        ctx.restore();
      }
    }
  }

  React.useEffect(() => {
    function loop() { draw(); raf.current = requestAnimationFrame(loop); }
    loop();
    return () => cancelAnimationFrame(raf.current);
  }, [getSeries, getSetpoint, max, color, variant, grid]);

  return (
    <canvas ref={ref} style={{ width: '100%', height: height, display: 'block' }} />
  );
}

// Mini spark for summary cards — also multi-series aware
function MiniSpark({ values, max, color, width = 160, height = 34 }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const isMulti = Array.isArray(values[0]);
    const seriesArr = isMulti ? values : [values];
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    seriesArr.forEach((data, si) => {
      if (!data || data.length < 2) return;
      const serColor = (si === 0 ? color : SERIES_COLORS[si]) || SERIES_COLORS[0];
      const pts = data.map((v, i) => ({
        x: (i / (data.length - 1)) * width,
        y: height - Math.max(0, Math.min(1, v / max)) * height,
      }));
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = si === 0 ? serColor : (serColor + 'aa');
      ctx.lineWidth = si === 0 ? 1.5 : 1;
      ctx.stroke();
    });
  });
  return <canvas ref={ref} width={width} height={height} style={{ display:'block', width:'100%', height }} />;
}

// ---- Local calibration status pill ----------------------------------------
function CalStatusPill({ well, big }) {
  const c = (window.calState ? window.calState(well) :
    well.calibrating ? { key: 'cal', fg: '#000', bg: '#FFE9B0', dot: '#C98A00', label: 'Calibrating…' }
    : well.calibrated ? { key: 'done', fg: '#0A6B2E', bg: '#D8F3DF', dot: '#16A34A', label: 'Calibrated' }
    : { key: 'todo', fg: '#fff', bg: 'var(--accent)', dot: '#fff', label: 'Not Calibrated' });
  return (
    <span className="status-pill" style={{ color: c.fg, background: c.bg, fontSize: big ? 11 : 10, padding: big ? '4px 10px' : '3px 8px' }}>
      <span className={'status-dot' + (c.key === 'cal' ? ' pulse' : '')} style={{ background: c.dot }}></span>{c.label}
    </span>
  );
}

// ---- Sidebar calibration block --------------------------------------------
function SidebarCalibration({ well }) {
  return (
    <div style={{ padding: 14, borderTop: '2px solid #000' }}>
      {well.flashing && (
        <div className="status-pill" style={{ background: '#FFE9B0', color: '#000', fontSize: 10, padding: '3px 8px', marginBottom: 10 }}>
          <span className="status-dot pulse" style={{ background: '#C98A00' }}></span>FLASHING FIRMWARE
        </div>
      )}
      <div className="kicker" style={{ marginBottom: 8 }}>Magnetic Calibration</div>
      <div style={{ marginBottom: 10 }}><CalStatusPill well={well} /></div>
      <button
        className="btn btn-secondary btn-sm btn-block"
        style={{
          minHeight: 42,
          background: well.calibrating ? 'var(--dim)' : (!well.calibrated ? 'var(--accent)' : ''),
          color: (well.calibrating || !well.calibrated) ? '#fff' : '',
        }}
        disabled={well.calibrating || well.flashing}
        onClick={() => window.MCCB.engine.calibrateWell(well.num)}>
        {well.calibrating ? 'Calibrating…' : (well.calibrated ? 'Recalibrate' : 'Calibrate Now')}
      </button>
    </div>
  );
}

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

// StaticReadout: like Readout but skips AnimatedNumber.
// Use for RMS and any value where tween drift would produce misleading
// intermediate states (e.g. a sliding-window RMS that updates every frame).
function StaticReadout({ label, value, decimals = 2, unit, accent }) {
  return (
    <div className={'readout' + (accent ? ' accent' : '')}>
      <div className="ro-label">{label}</div>
      <div>
        <span className="ro-value" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Number(value).toFixed(decimals)}
        </span>
        {unit && <span className="ro-unit">{unit}</span>}
      </div>
    </div>
  );
}

// ---- Terminal log with pause / clear -------------------------------------
// FIX: Every raw serial line is now visible.
//
// Filtering logic:
//   • No filter prop → show ALL lines (Combined view "Raw Serial Feed")
//   • filter="voltage" → show system lines (starts with "»") + raw lines
//     containing "voltage". Other raw lines are still shown so nothing is lost.
//   • filter="gauss"  → same pattern for magnetic view.
//
// Operators can always use Pause to freeze the display and read any message.
function LogPanel({ well, filter, height }) {
  useEngineTick(8);
  const [paused, setPaused] = React.useState(false);
  const frozen = React.useRef(null);
  const scrollRef = React.useRef(null);

  // Classify each log line:
  //   systemLine  → starts with "»" (event/level lines added by _pushLog)
  //   rawLine     → everything else (verbatim board output)
  //
  // Show policy:
  //   no filter  → show all
  //   with filter→ always show systemLines; show rawLines when they contain
  //                the keyword (keyword match is case-insensitive)
  let lines = well.log;
  if (filter) {
    const kw = filter.toLowerCase();
    lines = lines.filter(l => {
      const isSystem = l.startsWith('»');
      if (isSystem) return true;
      return l.toLowerCase().includes(kw);
    });
  }

  if (paused) {
    if (!frozen.current) frozen.current = lines.slice();
    lines = frozen.current;
  } else {
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
          ? <div className="ln" style={{ opacity: .5 }}>&gt; awaiting data…</div>
          : shown.map((l, i) => {
              const isSystem = l.startsWith('»');
              const color = l.includes('[ERROR]') ? '#FF3000'
                : l.includes('[WARN]')  ? '#C98A00'
                : l.includes('[OK]')    ? '#0A6B2E'
                : isSystem              ? '#2A6FDB'
                : undefined;
              // Raw board lines get a slightly dimmer style so system lines
              // stand out, but raw content is always fully legible.
              const style = color
                ? { color, fontWeight: 600 }
                : !isSystem ? { color: '#334', opacity: 0.9 } : undefined;
              return (
                <div className={'ln' + (i === shown.length - 1 ? ' fresh' : '')} key={i} style={style}>
                  &gt; {l}
                </div>
              );
            })}
      </div>
    </div>
  );
}

// ---- Chart card (header + live chart) ------------------------------------
// FIX: accessor.series() may now return number[][] for multi-series.
// LiveChart (defined above) handles both cases.
function ChartCard({ title, well, accessor, accent, variant, grid, height }) {
  return (
    <div className="gb" style={{ marginTop: 0, display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
      <div className="gb-title">{title}</div>
      {/* Legend for multi-series charts */}
      <MultiSeriesLegend series={accessor.seriesLabels} color={accent} />
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

// Small legend row shown beneath the chart title when there are 2+ series
function MultiSeriesLegend({ series, color }) {
  if (!series || series.length < 2) return null;
  return (
    <div className="row" style={{ gap: 14, padding: '2px 12px 0', flexWrap: 'wrap' }}>
      {series.map((label, i) => (
        <span key={i} className="row" style={{ gap: 5, alignItems: 'center', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#555' }}>
          <span style={{ width: 16, height: 3, borderRadius: 2, display: 'inline-block', background: i === 0 ? (color || SERIES_COLORS[0]) : SERIES_COLORS[i] || SERIES_COLORS[1] }}></span>
          {label}
        </span>
      ))}
    </div>
  );
}

// ---- One metric view (electric or magnetic) ------------------------------
function MetricView({ well, metric, layout, variant, grid, accent, onConfigure }) {
  useEngineTick(10);
  const isE = metric === 'electric';
  const needsCalibration = !well.calibrated && metric === 'magnetic';

  // FIX: Magnetic accessor returns a two-element array of series so both
  // gauss1 and gauss2 are graphed simultaneously.
  const acc = isE
    ? {
        series: () => well.history.efield.values,
        setpoint: () => well.setEfield,
        latest: () => well.measEfield,
        max: window.MCCB.MAX_EFIELD,
        seriesLabels: null,
      }
    : {
        series: () => [well.history.gauss1.values, well.history.gauss2.values],
        setpoint: () => well.setGauss,
        latest: () => well.measGauss1,
        max: window.MCCB.MAX_MAG,
        seriesLabels: ['HE1 (Gauss)', 'HE2 (Gauss)'],
      };

  const status = isE ? well.electricStatus : well.magneticStatus;
  const title  = isE ? 'Electric Field' : 'Magnetic Field';
  const filter = null; // raw lines have no keyword labels — don't filter them out

  const readouts = isE ? (
    <React.Fragment>
      <Readout label="Setpoint" value={well.setEfield} unit="V/cm" />
      <Readout label="Measured" value={well.measEfield} unit="V/cm" accent />
      <Readout label="Voltage" value={well.voltage} decimals={3} unit="V" />
      <Readout label="Current" value={well.current} decimals={2} unit="mA" />
    </React.Fragment>
  ) : (
    <React.Fragment>
      <Readout label="HE1 Inst." value={well.measGauss1} unit="G" accent />
      <StaticReadout label="HE1 RMS (2s)" value={well.rms1} unit="G" />
      <Readout label="HE2 Inst." value={well.measGauss2} unit="G" accent />
      <StaticReadout label="HE2 RMS (2s)" value={well.rms2} unit="G" />
    </React.Fragment>
  );

  const roCols = 4;
  const chart = <ChartCard title={title + ' — Measured vs Setpoint'} well={well} accessor={acc} accent={accent} variant={variant} grid={grid} />;

  return (
    <div className="col grow" style={{ padding: 18, gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 19, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</h2>
          <StatusPill status={status} big />
          {metric === 'magnetic' && <CalStatusPill well={well} big />}
        </div>
        <div className="row gap-8">
          {metric === 'magnetic' && (
            <button
              className="btn btn-secondary btn-sm"
              style={{
                minWidth: 150,
                background: well.calibrating ? 'var(--dim)' : (needsCalibration ? 'var(--accent)' : ''),
                color: (well.calibrating || needsCalibration) ? '#fff' : ''
              }}
              disabled={well.calibrating}
              onClick={() => window.MCCB.engine.calibrateWell(well.num)}>
              {well.calibrating ? 'Calibrating…' : (well.calibrated ? 'Recalibrate' : 'Calibrate Mag')}
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            style={{ minWidth: 150 }}
            disabled={needsCalibration}
            onClick={() => onConfigure(well.num, metric)}>
            {needsCalibration ? 'Calibrate First' : 'Set Value'}
          </button>
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

// ---- Stacked layout: chart grows, log collapses --------------------------
function CollapsibleStack({ chart, well, filter }) {
  const [open, setOpen] = React.useState(true);
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

// ---- Combined overview ---------------------------------------------------
function CombinedView({ well, layout, variant, grid, accent, onConfigure }) {
  useEngineTick(10);
  const eAcc = {
    series: () => well.history.efield.values,
    setpoint: () => well.setEfield,
    latest: () => well.measEfield,
    max: window.MCCB.MAX_EFIELD,
    seriesLabels: null,
  };
  // FIX: Combined magnetic chart now plots both sensors
  const mAcc = {
    series: () => [well.history.gauss1.values, well.history.gauss2.values],
    setpoint: () => well.setGauss,
    latest: () => well.measGauss1,
    max: window.MCCB.MAX_MAG,
    seriesLabels: ['HE1', 'HE2'],
  };
  const side = layout === 'split';

  const block = (title, acc, status, setVal, measVal, unit, mode, rmsVal, isMag, measVal2, rmsVal2) => (
    <div className="col grow" style={{ minHeight: 0, gap: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="row gap-12" style={{ alignItems: 'center' }}>
          <span style={{ fontWeight: 800, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</span>
          <StatusPill status={status} />
          {isMag && <CalStatusPill well={well} />}
        </div>
        <div className="row gap-16" style={{ alignItems: 'baseline' }}>
          <span className="kicker">SET <span className="mono" style={{ color: '#000', fontSize: 14 }}>{setVal.toFixed(2)}</span></span>
          {/* For magnetic: show HE1 and HE2 side-by-side; for electric: single value */}
          {isMag ? (
            <span className="row gap-10" style={{ alignItems: 'baseline' }}>
              <span>
                <span className="kicker" style={{ fontSize: 10 }}>HE1 </span>
                <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: accent }}>
                  <AnimatedNumber value={measVal} decimals={2} /><span className="ro-unit">{unit}</span>
                </span>
                {rmsVal !== undefined && rmsVal !== null && (
                  <span className="kicker" style={{ color: 'var(--dim)', marginLeft: 4 }}>
                    RMS <span className="mono" style={{ color: 'var(--ink)', fontSize: 13 }}>{rmsVal.toFixed(2)}</span>
                  </span>
                )}
              </span>
              <span style={{ color: '#ccc', fontWeight: 300 }}>|</span>
              <span>
                <span className="kicker" style={{ fontSize: 10 }}>HE2 </span>
                <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: SERIES_COLORS[1] }}>
                  <AnimatedNumber value={measVal2} decimals={2} /><span className="ro-unit">{unit}</span>
                </span>
                {rmsVal2 !== undefined && rmsVal2 !== null && (
                  <span className="kicker" style={{ color: 'var(--dim)', marginLeft: 4 }}>
                    RMS <span className="mono" style={{ color: 'var(--ink)', fontSize: 13 }}>{rmsVal2.toFixed(2)}</span>
                  </span>
                )}
              </span>
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 22, fontWeight: 700, color: accent }}>
              <AnimatedNumber value={measVal} decimals={2} /><span className="ro-unit">{unit}</span>
            </span>
          )}
          {!isMag && rmsVal !== undefined && rmsVal !== null && (
            <span className="kicker" style={{ color: 'var(--dim)' }}>
              RMS: <span className="mono" style={{ color: 'var(--ink)', fontSize: 14 }}>{rmsVal.toFixed(2)}</span>
            </span>
          )}
          {isMag && !well.calibrated
            ? <button className="btn btn-secondary btn-sm" style={{ minHeight: 38, minWidth: 96, background: 'var(--accent)', color: '#fff' }}
                disabled={well.calibrating} onClick={() => window.MCCB.engine.calibrateWell(well.num)}>
                {well.calibrating ? '…' : 'Calibrate'}
              </button>
            : <button className="btn btn-secondary btn-sm" style={{ minHeight: 38, minWidth: 96 }} onClick={() => onConfigure(well.num, mode)}>Set</button>}
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
        {block('Magnetic', mAcc, well.magneticStatus, well.setGauss, well.measGauss1, 'G', 'magnetic', well.rms1, true, well.measGauss2, well.rms2)}
      </div>
    </div>
  );
}

// ---- Well container with sub-nav -----------------------------------------
function WellTab({ wellNum, layout, variant, grid, accent, onConfigure }) {
  useEngineTick(6);
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
        <SidebarCalibration well={well} />
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