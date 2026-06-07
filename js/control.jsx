/* ============================================================================
 * control.jsx — CONTROL tab (mode select + live overview), Mode dialog,
 * the docked touch numpad, and the global calibration panel.
 * ========================================================================== */
import React from 'react';

// ---- Touch numpad ---------------------------------------------------------
function Numpad({ armedField, value, onKey, onClear, onConfirm }) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'];
  return (
    <div className="numpad">
      <div className="kicker" style={{ color: armedField ? 'var(--accent)' : 'var(--dim)', textAlign: 'center' }}>
        {armedField ? 'Editing: ' + armedField : 'Tap a field to edit'}
      </div>
      <div className={'numpad-display' + (armedField ? ' armed' : '')}>{value || (armedField ? '' : '—')}</div>
      <div className="numpad-grid">
        {keys.map((k) => (
          <button key={k} className={'key' + (k === '⌫' ? ' alt' : '')} disabled={!armedField} onClick={() => onKey(k)}>{k}</button>
        ))}
      </div>
      <div className="row gap-12">
        <button className="btn btn-secondary" style={{ flex: 1 }} disabled={!armedField} onClick={onClear}>Clear</button>
        <button className="btn" style={{ flex: 1 }} disabled={!armedField} onClick={onConfirm}>Done</button>
      </div>
    </div>
  );
}

// ---- Mode dialog ----------------------------------------------------------
function ModeDialog({ mode, initialWell, initialMetric, onClose, onToast }) {
  const eng = window.MCCB.engine;
  const wells = eng.assignedWells;
  const { MAX_EFIELD, MAX_MAG } = window.MCCB;

  const init = {};
  wells.forEach((n) => {
    const w = eng.wells[n];
    init[n] = {
      electric: w.setEfield ? String(w.setEfield) : '',
      magnetic: w.setGauss ? String(w.setGauss) : '',
      magWaveType: w.magWaveType || 1,
      magFreq: w.magFreqHz ? String(w.magFreqHz) : '50',
    };
  });
  const [vals, setVals] = React.useState(init);
  // armed tracks which numpad field is being edited: `${well}-electric`,
  // `${well}-magnetic`, or `${well}-magFreq`
  const initialKey = initialWell && initialMetric && (initialMetric === 'electric' || initialMetric === 'magnetic')
    ? `${initialWell}-${initialMetric}` : null;
  const [armed, setArmed] = React.useState(initialKey);

  const showE = mode === 'electric' || mode === 'dual';
  const showM = mode === 'magnetic' || mode === 'dual';
  const label = { electric: 'Electric Field', magnetic: 'Magnetic Field', dual: 'Dual — Electric + Magnetic' }[mode];

  // fieldVal / setFieldVal handle keys: `${n}-electric`, `${n}-magnetic`, `${n}-magFreq`
  function fieldVal(key) {
    const parts = key.split('-');
    const n = parts[0];
    const m = parts.slice(1).join('-'); // 'electric' | 'magnetic' | 'magFreq'
    return vals[n][m];
  }
  function setFieldVal(key, v) {
    const parts = key.split('-');
    const n = parts[0];
    const m = parts.slice(1).join('-');
    setVals((s) => ({ ...s, [n]: { ...s[n], [m]: v } }));
  }
  function setWaveType(n, wt) {
    setVals((s) => ({ ...s, [n]: { ...s[n], magWaveType: wt } }));
  }

  function onKey(k) {
    if (!armed) return;
    let cur = fieldVal(armed);
    if (k === '⌫') cur = cur.slice(0, -1);
    else if (k === '.') { if (cur.includes('.')) return; cur = cur === '' ? '0.' : cur + '.'; }
    else cur += k;
    setFieldVal(armed, cur);
  }
  function armedLabelText() {
    if (!armed) return null;
    const parts = armed.split('-');
    const n = parts[0];
    const m = parts.slice(1).join('-');
    const mLabel = m === 'electric' ? 'Electric' : m === 'magnetic' ? 'Magnetic (G)' : 'Frequency (Hz)';
    return `Well ${n} ${mLabel}`;
  }
  const armedLabel = armedLabelText();

  function rangeBad(key) {
    const v = parseFloat(fieldVal(key));
    if (fieldVal(key) === '') return false;
    if (isNaN(v)) return true;
    const parts = key.split('-');
    const m = parts.slice(1).join('-');
    if (m === 'electric') return v < 0 || v > MAX_EFIELD;
    if (m === 'magnetic') return v < 0 || v > MAX_MAG;
    if (m === 'magFreq')  return v < 0.1 || v > 250;
    return false;
  }

  function apply() {
    const errors = [];
    const summary = [];
    wells.forEach((n) => {
      if (showE && vals[n].electric !== '') {
        const v = parseFloat(vals[n].electric);
        if (isNaN(v) || v < 0 || v > MAX_EFIELD) errors.push(`Well ${n} E-field out of range (0–${MAX_EFIELD}).`);
        else { eng.setParams(n, { efield: v }); summary.push(`W${n} E ${v} V/cm`); }
      }
      if (showM && vals[n].magnetic !== '') {
        const v = parseFloat(vals[n].magnetic);
        if (isNaN(v) || v < 0 || v > MAX_MAG) errors.push(`Well ${n} magnetic out of range (0–${MAX_MAG}).`);
        else if (!eng.wells[n].calibrated) errors.push(`Well ${n} requires magnetic calibration first.`);
        else {
          // Parse frequency — fall back to current stored value if field left blank
          const freqStr = vals[n].magFreq;
          const freq = freqStr !== '' ? parseFloat(freqStr) : eng.wells[n].magFreqHz;
          if (isNaN(freq) || freq < 0.1 || freq > 250) {
            errors.push(`Well ${n} frequency out of range (0.1–250 Hz).`);
          } else {
            const wt = vals[n].magWaveType;
            const waveNames = { 1: 'STEP', 2: 'SQR', 3: 'SINE', 4: 'TRI' };
            eng.setParams(n, { gauss: v, magWaveType: wt, magFreqHz: freq });
            summary.push(`W${n} M ${v} G · ${waveNames[wt] || 'STEP'} ${wt !== 1 ? freq.toFixed(1) + ' Hz' : 'DC'}`);
          }
        }
      }
    });
    if (errors.length) { onToast({ kind: 'error', text: errors[0] }); return; }
    onToast({ kind: 'ok', text: `${summary.length} command${summary.length === 1 ? '' : 's'} transmitted · ${summary.join('  ')}` });
    onClose();
  }

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target.classList.contains('scrim')) onClose(); }}>
      <div className="dialog">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px 0' }}>
          <div>
            <div className="section-number">03 — Parameters</div>
            <h1 className="heading" style={{ fontSize: 24 }}>{label}</h1>
          </div>
          <button className="btn btn-secondary btn-sm" style={{ minWidth: 60, fontSize: 18 }} onClick={onClose}>✕</button>
        </div>

        <div className="row grow" style={{ minHeight: 0, padding: '16px 24px 0', gap: 24 }}>
          {/* well inputs */}
          <div className="grow scroll-y" style={{ minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              {wells.map((n) => (
                <div key={n} className="gb" style={{ marginTop: 8 }}>
                  <div className="gb-title">Well {n}</div>
                  <div className="gb-body col" style={{ gap: 14 }}>
                    {showE && (
                      <FieldRow label="Electric (V/cm)" placeholder={`0 – ${MAX_EFIELD}`}
                        k={`${n}-electric`} value={vals[n].electric} armed={armed} bad={rangeBad(`${n}-electric`)}
                        onArm={setArmed} />
                    )}
                    {showM && (
                      <React.Fragment>
                        <FieldRow label="Magnetic (Gauss)" placeholder={eng.wells[n].calibrated ? `0 – ${MAX_MAG}` : 'Calibrate well first'}
                          k={`${n}-magnetic`} value={vals[n].magnetic} armed={armed} bad={rangeBad(`${n}-magnetic`)}
                          disabled={!eng.wells[n].calibrated} onArm={setArmed} />

                        {/* Wave type selector — only shown when calibrated */}
                        <div className="col" style={{ gap: 6, opacity: eng.wells[n].calibrated ? 1 : 0.45 }}>
                          <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>Waveform</span>
                          <WaveTypeSelector
                            value={vals[n].magWaveType}
                            disabled={!eng.wells[n].calibrated}
                            onChange={(wt) => setWaveType(n, wt)} />
                        </div>

                        {/* Frequency field — hidden for STEP (DC) since freq is irrelevant */}
                        {vals[n].magWaveType !== 1 && (
                          <FieldRow label="Frequency (Hz) · 0.1 – 250"
                            placeholder="0.1 – 250"
                            k={`${n}-magFreq`} value={vals[n].magFreq} armed={armed}
                            bad={rangeBad(`${n}-magFreq`)}
                            disabled={!eng.wells[n].calibrated}
                            onArm={setArmed} />
                        )}
                      </React.Fragment>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
              Limits enforced before transmit · Electric ≤ {MAX_EFIELD} V/cm · Magnetic ≤ {MAX_MAG} G · Frequency 0.1–250 Hz. Leave a field blank to hold its current value.
            </p>
          </div>

          {/* numpad */}
          <div style={{ width: 360, flex: '0 0 360px' }}>
            <Numpad armedField={armedLabel} value={armed ? fieldVal(armed) : ''}
              onKey={onKey} onClear={() => armed && setFieldVal(armed, '')} onConfirm={() => setArmed(null)} />
          </div>
        </div>

        <div className="divider" style={{ marginTop: 16 }}></div>
        <div className="row" style={{ padding: '14px 24px', gap: 16 }}>
          <button className="btn btn-secondary" style={{ flex: '0 0 200px' }} onClick={onClose}>Back</button>
          <button className="btn" style={{ flex: 1, fontSize: 16 }} onClick={apply}>Apply Parameters</button>
        </div>
      </div>
    </div>
  );
}

// ---- Wave type selector ---------------------------------------------------
// Renders four toggle buttons: STEP (DC), SQUARE, SINE, TRIANGLE.
// Maps to Arduino WaveformType enum: 1=STEP, 2=SQUARE, 3=SINE, 4=TRIANGLE.
const WAVE_TYPES = [
  { id: 1, label: 'DC',  sub: 'Step',     glyph: <WaveGlyphStep /> },
  { id: 2, label: 'SQR', sub: 'Square',   glyph: <WaveGlyphSquare /> },
  { id: 3, label: 'SINE',sub: 'Sine',     glyph: <WaveGlyphSine /> },
  { id: 4, label: 'TRI', sub: 'Triangle', glyph: <WaveGlyphTri /> },
];

function WaveGlyphStep() {
  return (
    <svg width="36" height="18" viewBox="0 0 36 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="2,16 2,4 34,4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function WaveGlyphSquare() {
  return (
    <svg width="36" height="18" viewBox="0 0 36 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="2,14 2,4 10,4 10,14 20,14 20,4 30,4 30,14 34,14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function WaveGlyphSine() {
  return (
    <svg width="36" height="18" viewBox="0 0 36 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2,9 C6,2 8,2 10,9 C12,16 14,16 16,9 C18,2 20,2 22,9 C24,16 26,16 28,9 C30,2 32,2 34,9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
    </svg>
  );
}
function WaveGlyphTri() {
  return (
    <svg width="36" height="18" viewBox="0 0 36 18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="2,9 8,3 14,15 20,3 26,15 32,3 34,5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function WaveTypeSelector({ value, disabled, onChange }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
      {WAVE_TYPES.map(({ id, label, sub, glyph }) => {
        const sel = value === id;
        return (
          <button
            key={id}
            disabled={disabled}
            onClick={() => !disabled && onChange(id)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '10px 4px 8px',
              border: sel ? '2px solid #000' : '2px solid #ddd',
              background: sel ? '#000' : '#fafafa',
              color: sel ? '#fff' : '#555',
              cursor: disabled ? 'not-allowed' : 'pointer',
              transition: 'border-color .12s, background .12s, color .12s',
              borderRadius: 0,
            }}>
            {glyph}
            <span style={{ fontWeight: 800, fontSize: 10, letterSpacing: 1 }}>{label}</span>
            <span style={{ fontSize: 9, opacity: .7 }}>{sub}</span>
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({ label, placeholder, k, value, armed, bad, disabled, onArm }) {
  const active = armed === k;
  return (
    <div className="col" style={{ gap: 6, opacity: disabled ? .5 : 1 }}>
      <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
      <div className={'field tappable' + (active ? ' active' : '') + (bad ? ' invalid' : '')}
        onClick={() => !disabled && onArm(k)} style={{ fontSize: 20, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        {value !== '' ? value : <span style={{ color: 'var(--disabled)', fontFamily: 'var(--sans)', fontSize: 13 }}>{placeholder}</span>}
      </div>
    </div>
  );
}

// ---- Calibration status pill (shared look) --------------------------------
function calState(well) {
  if (well.calibrating) return { key: 'cal',  fg: '#000',     bg: '#FFE9B0',      dot: '#C98A00', label: 'Calibrating…' };
  if (well.calibrated)  return { key: 'done', fg: '#0A6B2E',  bg: '#D8F3DF',      dot: '#16A34A', label: 'Calibrated' };
  return                       { key: 'todo', fg: '#FFFFFF',  bg: 'var(--accent)', dot: '#FFFFFF', label: 'Not Calibrated' };
}
function CalPill({ well, big }) {
  const c = calState(well);
  return (
    <span className="status-pill" style={{ color: c.fg, background: c.bg, fontSize: big ? 11 : 10, padding: big ? '4px 10px' : '3px 8px' }}>
      <span className={'status-dot' + (c.key === 'cal' ? ' pulse' : '')} style={{ background: c.dot }}></span>{c.label}
    </span>
  );
}

// ---- Global calibration panel (Control tab) -------------------------------
function CalibrationPanel({ accent }) {
  const eng = window.MCCB.engine;
  const wells = eng.assignedWells;
  const anyCalibrating = eng.anyCalibrating;
  const allDone = wells.length > 0 && wells.every((n) => eng.wells[n].calibrated);

  return (
    <div className="gb" style={{ marginTop: 26 }}>
      <div className="gb-title">Magnetic Calibration</div>
      <div className="gb-body">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 16 }}>
          <p style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.5, margin: 0, maxWidth: 540 }}>
            Each well runs a magnetic sweep to build its PWM→Gauss lookup table from the on-board Hall sensors.
            Gauss setpoints stay locked until the well reports a completed calibration.
          </p>
          <button className="btn btn-sm" style={{ minWidth: 200 }}
            disabled={wells.length === 0 || anyCalibrating}
            onClick={() => eng.calibrateAll()}>
            {anyCalibrating ? 'Calibrating…' : allDone ? 'Recalibrate All Wells' : 'Calibrate All Wells'}
          </button>
        </div>

        {wells.length === 0
          ? <div style={{ color: 'var(--dim)', padding: '6px 2px' }}>No wells connected.</div>
          : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {wells.map((n) => <CalibrationRow key={n} well={eng.wells[n]} eng={eng} />)}
            </div>
          )}
      </div>
    </div>
  );
}

function CalibrationRow({ well, eng }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', border: '2px solid #000', padding: '10px 12px' }}>
      <div className="col" style={{ gap: 7 }}>
        <span style={{ fontWeight: 800, letterSpacing: 2, fontSize: 13 }}>WELL {well.num}</span>
        <CalPill well={well} />
      </div>
      <button className="btn btn-secondary btn-sm"
        style={{ minWidth: 130, minHeight: 42, background: well.calibrating ? 'var(--dim)' : '', color: well.calibrating ? '#fff' : '' }}
        disabled={well.calibrating}
        onClick={() => eng.calibrateWell(well.num)}>
        {well.calibrating ? 'Calibrating…' : (well.calibrated ? 'Recalibrate' : 'Calibrate')}
      </button>
    </div>
  );
}

// ---- CONTROL tab ----------------------------------------------------------
function ControlTab({ accent, onMode, onConfigure }) {
  useEngineTick(8);
  const eng = window.MCCB.engine;
  const wells = eng.assignedWells;

  const modes = [
    ['electric', 'Electric Field', 'V/cm potential across electrodes'],
    ['magnetic', 'Magnetic Field', 'Gauss via coil drive current'],
    ['dual', 'Dual Stimulation', 'Electric + Magnetic together'],
  ];

  return (
    <div className="tab-page enter">
      <div className="grow scroll-y" style={{ padding: '28px 34px' }}>
        <div className="section-number">02 — Stimulation</div>
        <h1 className="heading">MCCB Stimulation Control</h1>

        <div className="gb" style={{ marginTop: 24 }}>
          <div className="gb-title">Select Mode</div>
          <div className="gb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            {modes.map(([m, t, sub]) => (
              <button key={m} className="btn" onClick={() => onMode(m)}
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, minHeight: 104, padding: '18px 20px', textAlign: 'left' }}>
                <ModeGlyph mode={m} />
                <span style={{ fontSize: 16 }}>{t}</span>
                <span style={{ fontSize: 10, opacity: .7, letterSpacing: .5, textTransform: 'none', fontWeight: 600 }}>{sub}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Global magnetic calibration */}
        <CalibrationPanel accent={accent} />

        <div className="gb" style={{ marginTop: 26 }}>
          <div className="gb-title">Active Stimulation · {wells.length} Well{wells.length === 1 ? '' : 's'}</div>
          <div className="gb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {wells.length === 0 && <div style={{ color: 'var(--dim)', padding: 20 }}>No wells connected.</div>}
            {wells.map((n) => <WellSummaryCard key={n} well={eng.wells[n]} accent={accent} onConfigure={onConfigure} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function WellSummaryCard({ well, accent, onConfigure }) {
  return (
    <div style={{ border: '2px solid #000', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', background: '#000', color: '#fff', padding: '8px 12px' }}>
        <span style={{ fontWeight: 800, letterSpacing: 2 }}>WELL {well.num}</span>
        <span className="mono" style={{ fontSize: 11, opacity: .7 }}>{well.port}</span>
      </div>
      <div className="row" style={{ padding: 12, gap: 12 }}>
        <SummaryMetric label="Electric" set={well.setEfield} meas={well.measEfield} unit="V/cm"
          status={well.electricStatus} accent={accent} values={well.history.efield.values} max={window.MCCB.MAX_EFIELD} />
        <div style={{ width: 2, background: '#eee', alignSelf: 'stretch' }}></div>
        <SummaryMetric label="Magnetic" set={well.setGauss} meas={well.measGauss1} unit="G"
          status={well.magneticStatus} accent={accent} values={well.history.gauss1.values} max={window.MCCB.MAX_MAG} />
      </div>
      <div className="row" style={{ padding: '0 12px 12px', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" style={{ flex: 1, minHeight: 40 }} onClick={() => onConfigure(well.num, 'electric')}>Configure</button>
        <button className="btn btn-danger btn-sm" style={{ flex: 1, minHeight: 40 }} onClick={() => window.MCCB.engine.stopWell(well.num)}>Stop</button>
      </div>
    </div>
  );
}

function SummaryMetric({ label, set, meas, unit, status, accent, values, max }) {
  return (
    <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="kicker">{label}</span>
        <StatusPill status={status} />
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
        <span className="mono" style={{ fontSize: 24, fontWeight: 700, color: accent }}><AnimatedNumber value={meas} decimals={2} /></span>
        <span className="ro-unit">{unit}</span>
        <span className="kicker" style={{ marginLeft: 'auto' }}>set {set.toFixed(2)}</span>
      </div>
      <MiniSpark values={values} max={max} color={accent} width={240} height={34} />
    </div>
  );
}

function ModeGlyph({ mode }) {
  // simple geometric marks, no detailed SVG
  if (mode === 'electric') return <div style={{ display: 'flex', gap: 4 }}><span style={{ width: 4, height: 22, background: 'currentColor' }}></span><span style={{ width: 4, height: 22, background: 'currentColor', opacity: .5 }}></span><span style={{ width: 4, height: 22, background: 'currentColor' }}></span></div>;
  if (mode === 'magnetic') return <div style={{ width: 24, height: 22, border: '4px solid currentColor', borderRadius: '50%', borderRightColor: 'transparent' }}></div>;
  return <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}><span style={{ width: 4, height: 20, background: 'currentColor' }}></span><span style={{ width: 18, height: 18, border: '4px solid currentColor', borderRadius: '50%', borderRightColor: 'transparent' }}></span></div>;
}

// expose the calibration pill + state helper so well.jsx can reuse the look
Object.assign(window, { ControlTab, ModeDialog, CalPill, calState });