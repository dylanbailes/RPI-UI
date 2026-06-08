/* ============================================================================
 * charts.jsx — Live canvas chart + animated numeric readouts (Swiss style)
 * Exports to window: LiveChart, AnimatedNumber, StatusPill, MiniSpark
 * ========================================================================== */
import React from 'react';
const { useRef, useEffect, useState } = React;

// ---- useEngineTick: re-render subscriber to the telemetry engine ----------
function useEngineTick(hz = 10) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!window.MCCB || !window.MCCB.engine) return;
    let last = 0; const minDt = 1000 / hz;
    const unsub = window.MCCB.engine.subscribe(() => {
      const now = performance.now();
      if (now - last >= minDt) { last = now; setN((x) => x + 1); }
    });
    return unsub;
  }, [hz]);
}

// ---- AnimatedNumber: tweens to its target, monospace ----------------------
// FIX: The original used `a.from = disp` (stale React state) as the tween
// start point. When new values arrive faster than the 260 ms tween duration
// each new animation restarts from an outdated snapshot, causing the display
// to ratchet upward continuously. The fix stores the true live position in a
// ref (dispRef) that is written on every animation frame, so a.from always
// picks up exactly where the needle is sitting right now.
function AnimatedNumber({ value, decimals = 2, className, style }) {
  const [disp, setDisp] = useState(value);
  const dispRef = useRef(value);        // true live position, updated every frame
  const animRef = useRef({ from: value, to: value, start: 0, raf: null });

  useEffect(() => {
    const a = animRef.current;
    if (a.raf) { cancelAnimationFrame(a.raf); a.raf = null; }
    a.from  = dispRef.current;          // start from wherever the needle actually is
    a.to    = value;
    a.start = performance.now();
    const dur = 260;
    const tick = (now) => {
      const p = Math.min(1, (now - a.start) / dur);
      const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
      const v = a.from + (a.to - a.from) * e;
      dispRef.current = v;              // keep ref in sync before state update
      setDisp(v);
      a.raf = p < 1 ? requestAnimationFrame(tick) : null;
    };
    a.raf = requestAnimationFrame(tick);
    return () => { if (a.raf) { cancelAnimationFrame(a.raf); a.raf = null; } };
  }, [value]);

  return (
    <span className={className} style={{ fontVariantNumeric: 'tabular-nums', ...style }}>
      {disp.toFixed(decimals)}
    </span>
  );
}

// ---- StatusPill: OFF / RAMPING / LOCKED / OVER ----------------------------
const STATUS_COLORS = {
  OFF:     { fg: '#666666', bg: '#F2F2F2', dot: '#999999' },
  RAMPING: { fg: '#000000', bg: '#FFE9B0', dot: '#C98A00' },
  LOCKED:  { fg: '#0A6B2E', bg: '#D8F3DF', dot: '#16A34A' },
  OVER:    { fg: '#FFFFFF', bg: '#FF3000', dot: '#FFFFFF' },
};
function StatusPill({ status, big }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.OFF;
  const pulse = status === 'RAMPING' || status === 'OVER';
  return (
    <span className="status-pill" style={{
      color: c.fg, background: c.bg,
      fontSize: big ? 13 : 11, padding: big ? '6px 12px' : '4px 9px',
    }}>
      <span className={'status-dot' + (pulse ? ' pulse' : '')} style={{ background: c.dot }}></span>
      {status}
    </span>
  );
}

// ---- LiveChart: self-driven canvas, reads ring buffer each frame ----------
function LiveChart({
  getSeries, getSetpoint, getLatest,
  max, color = '#FF3000', variant = 'area', grid = true,
  height = '100%', unit = '', label = '', tall = true,
  colors = ['#FF3000', '#2A6FDB', '#1F8A5B', '#7A5AE0'] // Palette for multiple lines
}) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const r = wrapRef.current.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrapRef.current);

    const padL = 6, padR = 6, padT = 10, padB = 6;

    function draw() {
      const seriesData = getSeries() || [];
      // Detect if we received multiple series (2D array) or a single series (1D array)
      const isMulti = seriesData.length > 0 && Array.isArray(seriesData[0]);
      const seriesList = isMulti ? seriesData : [seriesData];

      const setpoint = getSetpoint ? getSetpoint() : null;
      const yMax = max * 1.08;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const xOf = (i, n) => padL + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
      const yOf = (v) => padT + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

      ctx.clearRect(0, 0, W, H);

      // grid
      if (grid) {
        ctx.strokeStyle = '#ECECEC'; ctx.lineWidth = 1;
        for (let g = 0; g <= 4; g++) {
          const y = padT + (g / 4) * plotH + 0.5;
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        }
        for (let g = 0; g <= 6; g++) {
          const x = padL + (g / 6) * plotW + 0.5;
          ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
        }
      }

      // setpoint dashed line
      if (setpoint != null && setpoint > 0) {
        const ys = yOf(setpoint);
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(padL, ys); ctx.lineTo(W - padR, ys); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = color;
        ctx.fillRect(W - padR - 46, ys - 9, 46, 14);
        ctx.fillStyle = '#fff';
        ctx.font = '700 9px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText('SET ' + setpoint.toFixed(2), W - padR - 43, ys - 1);
      }

      // Draw all series
      // Series 0 uses the `color` accent prop; subsequent series use the palette.
      const resolvedColors = [color, ...colors.filter(c => c !== color)];
      let hasData = false;
      seriesList.forEach((series, idx) => {
        const c = resolvedColors[idx % resolvedColors.length];
        const n = series.length;
        if (n >= 2) {
          hasData = true;
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const x = xOf(i, n), y = yOf(series[i]);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          if (variant === 'area') {
            ctx.lineTo(xOf(n - 1, n), H - padB);
            ctx.lineTo(xOf(0, n), H - padB);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
            grad.addColorStop(0, hexA(c, 0.28));
            grad.addColorStop(1, hexA(c, 0.02));
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.beginPath();
            for (let i = 0; i < n; i++) {
              const x = xOf(i, n), y = yOf(series[i]);
              i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
          }
          ctx.strokeStyle = variant === 'area' ? c : '#000000';
          ctx.lineWidth = 2; ctx.lineJoin = 'round';
          ctx.stroke();
        }
      });

      // leading dots for all series
      seriesList.forEach((series, idx) => {
        const c = resolvedColors[idx % resolvedColors.length];
        const n = series.length;
        if (n >= 2) {
          const latest = series[n - 1];
          const lx = xOf(n - 1, n), ly = yOf(latest);
          const t = (performance.now() % 1400) / 1400;
          ctx.beginPath();
          ctx.fillStyle = hexA(c, 0.25 * (1 - t));
          ctx.arc(lx, ly, 4 + t * 9, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = c;
          ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        }
      });

      if (!hasData) {
        ctx.fillStyle = '#BBBBBB';
        ctx.font = '700 11px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('AWAITING TELEMETRY', W / 2, H / 2);
      }

      rafRef.current = requestAnimationFrame(draw);
    }
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, [variant, grid, color, max, colors]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height }}>
      <canvas ref={canvasRef} style={{ display: 'block' }}></canvas>
    </div>
  );
}

// tiny inline sparkline for connection/overview — handles number[] or number[][]
function MiniSpark({ values, max, color = '#FF3000', width = 120, height = 30,
  colors = ['#FF3000', '#2A6FDB', '#1F8A5B', '#7A5AE0'] }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = width * dpr; c.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const raw = values || [];
    const isMulti = raw.length > 0 && Array.isArray(raw[0]);
    const seriesList = isMulti ? raw : [raw];
    const resolvedColors = [color, ...colors.filter(col => col !== color)];
    seriesList.forEach((series, idx) => {
      const n = series.length;
      if (n < 2) return;
      const yMax = max * 1.08;
      const serColor = resolvedColors[idx % resolvedColors.length];
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * width;
        const y = height - (Math.min(yMax, Math.max(0, series[i])) / yMax) * height;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = serColor; ctx.lineWidth = idx === 0 ? 1.5 : 1; ctx.stroke();
    });
  });
  return <canvas ref={ref} style={{ width, height, display: 'block' }}></canvas>;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

Object.assign(window, { LiveChart, AnimatedNumber, StatusPill, MiniSpark, hexA, useEngineTick });