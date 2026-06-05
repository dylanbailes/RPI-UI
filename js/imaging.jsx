/* ============================================================================
 * imaging.jsx — Camera grid (2x2), faux microscope feeds, settings panel,
 * fullscreen expand, snapshot flash + toast. Mirrors camera_viewer.py.
 * On the Pi: replace FauxScope with Aravis frames painted to the canvas.
 * ========================================================================== */

// ---- Simulated microscope feed (well-cell field) --------------------------
class FauxScope {
  constructor(canvas, seed) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    this.W = 360; this.H = 240; canvas.width = this.W; canvas.height = this.H;
    this.cells = [];
    const rng = mulberry(seed * 9301 + 49297);
    const n = 7 + Math.floor(rng() * 5);
    for (let i = 0; i < n; i++) {
      this.cells.push({
        x: rng() * this.W, y: rng() * this.H,
        r: 9 + rng() * 22, vx: (rng() - .5) * 8, vy: (rng() - .5) * 8,
        ph: rng() * 6.28, br: .5 + rng() * .5,
      });
    }
    this.exposure = 5000; this.gain = 0; this.fps = 10; this.playing = false;
    this._raf = 0; this._last = 0; this._t = 0;
  }
  set(p) { Object.assign(this, p); }
  start() { if (this.playing) return; this.playing = true; this._last = performance.now(); this._loop(); }
  stop() { this.playing = false; cancelAnimationFrame(this._raf); }
  _loop() {
    if (!this.playing) return;
    const now = performance.now();
    const interval = 1000 / this.fps;
    if (now - this._last >= interval) { this._last = now; this._t += interval / 1000; this.draw(this._t, interval / 1000); }
    this._raf = requestAnimationFrame(() => this._loop());
  }
  draw(t, dt) {
    const { ctx, W, H } = this;
    const bright = 0.45 + this.exposure / 100000 * 0.9;     // exposure -> brightness
    const contrast = 1 + this.gain / 24 * 1.1;              // gain -> contrast
    // illumination background
    const g = ctx.createRadialGradient(W * .5, H * .5, 20, W * .5, H * .5, W * .65);
    g.addColorStop(0, shade(70 * bright)); g.addColorStop(1, shade(16 * bright));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // cells
    for (const cell of this.cells) {
      if (dt > 0) {
        cell.x += cell.vx * dt; cell.y += cell.vy * dt;
        if (cell.x < -30) cell.x = W + 30; if (cell.x > W + 30) cell.x = -30;
        if (cell.y < -30) cell.y = H + 30; if (cell.y > H + 30) cell.y = -30;
      }
      const pulse = 1 + Math.sin(t * 1.5 + cell.ph) * 0.06;
      const rr = cell.r * pulse;
      const cg = ctx.createRadialGradient(cell.x, cell.y, rr * .15, cell.x, cell.y, rr);
      const lum = clampB(90 * bright * cell.br * contrast);
      cg.addColorStop(0, `rgba(${lum},${lum},${Math.min(255, lum + 12)},0.92)`);
      cg.addColorStop(.7, `rgba(${lum * .5},${lum * .5},${lum * .5},0.4)`);
      cg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cell.x, cell.y, rr, 0, 6.2832); ctx.fill();
      // nucleus
      ctx.fillStyle = `rgba(${clampB(lum * .35)},${clampB(lum * .35)},${clampB(lum * .4)},0.55)`;
      ctx.beginPath(); ctx.arc(cell.x + rr * .12, cell.y - rr * .1, rr * .32, 0, 6.2832); ctx.fill();
    }
    // grain
    const grain = Math.round(10 + this.gain * 0.9);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const nz = (Math.random() - .5) * grain;
      d[i] += nz; d[i + 1] += nz; d[i + 2] += nz;
    }
    ctx.putImageData(img, 0, 0);
  }
  snapshot() { return this.c.toDataURL('image/png'); }
}
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function shade(v) { v = clampB(v); return `rgb(${v},${v},${Math.min(255, v + 6)})`; }
function clampB(v) { return Math.max(0, Math.min(255, Math.round(v))); }

// ---- Camera tile ----------------------------------------------------------
function CameraTile({ wellIndex, cameraId, settings, onToast, onExpand, big }) {
  const canvasRef = React.useRef(null);
  const scopeRef = React.useRef(null);
  const [playing, setPlaying] = React.useState(false);
  const [flash, setFlash] = React.useState(false);
  const [count, setCount] = React.useState(0);
  const hasCam = !!cameraId;

  React.useEffect(() => {
    if (!hasCam) return;
    scopeRef.current = new FauxScope(canvasRef.current, wellIndex + 1);
    scopeRef.current.set(settings);
    scopeRef.current.draw(0, 0);
    return () => scopeRef.current && scopeRef.current.stop();
  }, [hasCam]);

  React.useEffect(() => { if (scopeRef.current) scopeRef.current.set(settings); }, [settings]);

  function play() { if (!scopeRef.current) return; scopeRef.current.start(); setPlaying(true); }
  function pause() { if (!scopeRef.current) return; scopeRef.current.stop(); setPlaying(false); }
  function snap() {
    if (!scopeRef.current) return;
    scopeRef.current.snapshot();
    setFlash(true); setTimeout(() => setFlash(false), 440);
    setCount((c) => c + 1);
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1_$2');
    onToast({ kind: 'shot', text: `Captured · ~/mccb_snapshots/well${String(wellIndex + 1).padStart(2, '0')}_${ts}.png` });
  }

  if (!hasCam) {
    return (
      <div className="cam-tile">
        <div className="cam-overlay-tl"><div className="cam-tag">WELL {String(wellIndex + 1).padStart(2, '0')}</div></div>
        <div className="cam-empty">
          <div className="empty-badge" style={{ width: 52, height: 52, borderColor: '#555' }}>✕</div>
          <div>NO CAMERA DETECTED</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cam-tile">
      <canvas ref={canvasRef} className="cam-feed"></canvas>
      <div className="cam-overlay-tl">
        <div className="cam-tag">WELL {String(wellIndex + 1).padStart(2, '0')}</div>
        <div className={'cam-status' + (playing ? ' live' : '')}>{playing ? '● LIVE' : '◼ STOPPED'}{count > 0 ? ` · ${count} SHOT${count === 1 ? '' : 'S'}` : ''}</div>
      </div>
      <div className="cam-controls">
        <button className="cam-btn" title="Play" disabled={playing} onClick={play}><Icn t="play" /></button>
        <button className="cam-btn" title="Pause" disabled={!playing} onClick={pause}><Icn t="pause" /></button>
        <button className="cam-btn" title="Snapshot" disabled={!playing} onClick={snap}><Icn t="cam" /></button>
      </div>
      {!big && <button className="cam-expand-icn" title="Fullscreen" onClick={() => onExpand(wellIndex)}><Icn t="expand" /></button>}
      <div className={'cam-flash' + (flash ? ' go' : '')}></div>
    </div>
  );
}

function Icn({ t }) {
  const s = { width: 18, height: 18, fill: 'currentColor' };
  if (t === 'play') return <svg viewBox="0 0 24 24" style={s}><polygon points="6,4 20,12 6,20" /></svg>;
  if (t === 'pause') return <svg viewBox="0 0 24 24" style={s}><rect x="5" y="4" width="5" height="16" /><rect x="14" y="4" width="5" height="16" /></svg>;
  if (t === 'cam') return <svg viewBox="0 0 24 24" style={s}><path d="M4 8h3l2-2h6l2 2h3v12H4z" /><circle cx="12" cy="13" r="3.4" fill="#000" /></svg>;
  if (t === 'expand') return <svg viewBox="0 0 24 24" style={s}><path d="M4 4h7v2H6v5H4zm9 0h7v7h-2V6h-5zm7 9v7h-7v-2h5v-5zM4 13h2v5h5v2H4z" /></svg>;
  if (t === 'collapse') return <svg viewBox="0 0 24 24" style={s}><path d="M9 4h2v7H4V9h5zm4 0h2v5h5v2h-7zm7 9v2h-5v5h-2v-7zM4 13h7v7H9v-5H4z" /></svg>;
  return null;
}

// ---- Settings panel -------------------------------------------------------
const EXP_OPTS = [['500 µs', 500], ['1 ms', 1000], ['2 ms', 2000], ['5 ms', 5000], ['10 ms', 10000], ['20 ms', 20000], ['50 ms', 50000], ['100 ms', 100000]];
const GAIN_OPTS = [['0 dB', 0], ['3 dB', 3], ['6 dB', 6], ['12 dB', 12], ['18 dB', 18], ['24 dB', 24]];
const FPS_OPTS = [5, 10, 15, 20, 30];

function SettingsPanel({ onApply, snapDir }) {
  const [exp, setExp] = React.useState(3);
  const [gain, setGain] = React.useState(0);
  const [fps, setFps] = React.useState(1);
  const [pulse, setPulse] = React.useState(false);

  function apply() {
    onApply({ exposure: EXP_OPTS[exp][1], gain: GAIN_OPTS[gain][1], fps: FPS_OPTS[fps] });
    setPulse(true); setTimeout(() => setPulse(false), 300);
  }
  const Group = ({ title, children }) => (
    <div className="gb" style={{ margin: '0 0 12px' }}><div className="gb-title">{title}</div><div style={{ padding: '18px 10px 10px' }}>{children}</div></div>
  );
  return (
    <div className="cam-settings">
      <div className="cam-settings-hd">Camera Settings</div>
      <div className="grow scroll-y" style={{ padding: 10 }}>
        <Group title="Exposure">
          <select className="select" value={exp} onChange={(e) => setExp(+e.target.value)}>{EXP_OPTS.map(([l], i) => <option key={i} value={i}>{l}</option>)}</select>
        </Group>
        <Group title="Gain">
          <select className="select" value={gain} onChange={(e) => setGain(+e.target.value)}>{GAIN_OPTS.map(([l], i) => <option key={i} value={i}>{l}</option>)}</select>
        </Group>
        <Group title="Frame Rate">
          <select className="select" value={fps} onChange={(e) => setFps(+e.target.value)}>{FPS_OPTS.map((v, i) => <option key={i} value={i}>{v} FPS</option>)}</select>
        </Group>
        <button className={'btn btn-block' + (pulse ? '' : '')} style={{ marginBottom: 16 }} onClick={apply}>Apply To All</button>
        <Group title="Snapshots">
          <div className="mono" style={{ fontSize: 11, color: '#444', marginBottom: 10, wordBreak: 'break-all' }}>{snapDir}</div>
          <button className="btn btn-secondary btn-block btn-sm" onClick={() => onApply.openFolder && onApply.openFolder()}>Open Folder</button>
        </Group>
      </div>
    </div>
  );
}

// ---- Imaging tab ----------------------------------------------------------
function ImagingTab({ onToast }) {
  const cams = React.useMemo(() => window.MCCB.enumerateCameras(), []);
  const [settings, setSettings] = React.useState({ exposure: 5000, gain: 0, fps: 10 });
  const [full, setFull] = React.useState(null);
  const snapDir = '~/mccb_snapshots/';

  const applyAll = (s) => setSettings(s);
  applyAll.openFolder = () => onToast({ kind: 'ok', text: `Opening ${snapDir}` });

  return (
    <div className="tab-page enter">
      <div className="row grow" style={{ minHeight: 0 }}>
        <div className="cam-grid">
          {cams.map((cam, i) => (
            <CameraTile key={i} wellIndex={i} cameraId={cam.id} settings={settings} onToast={onToast} onExpand={setFull} />
          ))}
        </div>
        <SettingsPanel onApply={applyAll} snapDir={snapDir} />
      </div>

      {full != null && (
        <div className="cam-full">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '2px solid #222' }}>
            <span style={{ color: '#fff', fontWeight: 800, letterSpacing: 2 }}>WELL {String(full + 1).padStart(2, '0')} · FULLSCREEN</span>
            <button className="btn btn-sm" style={{ minWidth: 130 }} onClick={() => setFull(null)}>Close ✕</button>
          </div>
          <div className="grow" style={{ position: 'relative', minHeight: 0 }}>
            <CameraTile key={'full' + full} wellIndex={full} cameraId={cams[full].id} settings={settings} onToast={onToast} onExpand={() => {}} big />
          </div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ImagingTab });
