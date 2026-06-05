/* ============================================================================
 * control.jsx — CONTROL tab (mode select + live overview), Mode dialog,
 * and the docked touch numpad for parameter entry.
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
    };
  });
  const [vals, setVals] = React.useState(init);
  const initialKey = initialWell && initialMetric && (initialMetric === 'electric' || initialMetric === 'magnetic')
    ? `${initialWell}-${initialMetric}` : null;
  const [armed, setArmed] = React.useState(initialKey);

  const showE = mode === 'electric' || mode === 'dual';
  const showM = mode === 'magnetic' || mode === 'dual';
  const label = { electric: 'Electric Field', magnetic: 'Magnetic Field', dual: 'Dual — Electric + Magnetic' }[mode];

  function fieldVal(key) { const [n, m] = key.split('-'); return vals[n][m]; }
  function setFieldVal(key, v) { const [n, m] = key.split('-'); setVals((s) => ({ ...s, [n]: { ...s[n], [m]: v } })); }

  function onKey(k) {
    if (!armed) return;
    let cur = fieldVal(armed);
    if (k === '⌫') cur = cur.slice(0, -1);
    else if (k === '.') { if (cur.includes('.')) return; cur = cur === '' ? '0.' : cur + '.'; }
    else cur += k;
    setFieldVal(armed, cur);
  }
  const armedLabel = armed ? (() => { const [n, m] = armed.split('-'); return `Well ${n} ${m}`; })() : null;

  function rangeBad(key) {
    const v = parseFloat(fieldVal(key));
    if (fieldVal(key) === '' ) return false;
    if (isNaN(v)) return true;
    const [, m] = key.split('-');
    return m === 'electric' ? (v < 0 || v > MAX_EFIELD) : (v < 0 || v > MAX_MAG);
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
        else { eng.setParams(n, { gauss: v }); summary.push(`W${n} M ${v} G`); }
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
                      <FieldRow label="Magnetic (Gauss)" placeholder={`0 – ${MAX_MAG}`}
                        k={`${n}-magnetic`} value={vals[n].magnetic} armed={armed} bad={rangeBad(`${n}-magnetic`)}
                        onArm={setArmed} />
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p style={{ color: 'var(--dim)', fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
              Limits enforced before transmit · Electric ≤ {MAX_EFIELD} V/cm · Magnetic ≤ {MAX_MAG} Gauss. Leave a field blank to hold its current value.
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

function FieldRow({ label, placeholder, k, value, armed, bad, onArm }) {
  const active = armed === k;
  return (
    <div className="col" style={{ gap: 6 }}>
      <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>{label}</span>
      <div className={'field tappable' + (active ? ' active' : '') + (bad ? ' invalid' : '')}
        onClick={() => onArm(k)} style={{ fontSize: 20 }}>
        {value !== '' ? value : <span style={{ color: 'var(--disabled)', fontFamily: 'var(--sans)', fontSize: 13 }}>{placeholder}</span>}
      </div>
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
        <SummaryMetric label="Magnetic" set={well.setGauss} meas={well.measGauss} unit="G"
          status={well.magneticStatus} accent={accent} values={well.history.gauss.values} max={window.MCCB.MAX_MAG} />
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

Object.assign(window, { ControlTab, ModeDialog });
