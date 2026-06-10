import React from 'react';
import { useEffect, useState, useRef } from 'react';

// Client-side downscale factor. The backend now downscales frames BEFORE
// sending (MCCB_CAM_DOWNSCALE, default 2), which saves websocket bandwidth
// AND decode time, so this stays at 1. Raise it only if you disable
// server-side downscaling.
const DOWNSCALE = 1;

// Scoped layout override. We do NOT rely on .tab-page / .cam-grid / .cam-tile
// establishing height — we force the full flex/grid height chain ourselves so
// the camera stage always fills the available space on the kiosk.
const LAYOUT_CSS = `
.mccb-img{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;}
.mccb-img .img-row{display:flex;flex-direction:row;flex:1 1 auto;min-height:0;}
.mccb-img .img-col{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;}
.mccb-img .img-switch{flex:0 0 auto;}
.mccb-img .img-stage{flex:1 1 auto;min-height:0;position:relative;background:#000;}
.mccb-img .cam-grid{display:grid !important;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:4px;width:100%;height:100%;}
.mccb-img .cam-tile{position:relative;width:100%;height:100%;min-height:0;overflow:hidden;background:#000;}
.mccb-img .img-single{width:100%;height:100%;position:relative;}
.mccb-img .cam-feed{display:block;width:100%;height:100%;object-fit:contain;background:#000;}
.mccb-img .cam-settings{flex:0 0 auto;}
`;

function CameraTile({ wellIndex, cameraId, settings, onToast, onExpand, big, autoStart }) {
    const canvasRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [flash, setFlash] = useState(false);
    const [count, setCount] = useState(0);
    const hasCam = !!cameraId;

    useEffect(() => {
        if (!hasCam) return;
        // PERF: frames are coalesced through requestAnimationFrame — the
        // event handler only stashes the newest frame, and the draw happens
        // at most once per display refresh. If frames arrive faster than the
        // tile can paint, intermediate frames are silently dropped (the
        // backend also drops, so neither side ever backlogs).
        // The ImageData + Uint32 scratch buffers are reused across frames to
        // avoid allocating ~1.5 MB per frame on the Pi.
        let latest = null;
        let rafId = 0;
        let imgData = null;     // reused ImageData
        let img32 = null;       // Uint32 view of imgData.data

        const drawLatest = () => {
            rafId = 0;
            const f = latest;
            latest = null;
            if (!f) return;
            const { width, height, pixels } = f;
            const canvas = canvasRef.current;
            if (!canvas || !width || !height) return;
            const ctx = canvas.getContext('2d');
            const px = width * height;
            const channels = Math.max(1, Math.round(pixels.length / px));

            const step = DOWNSCALE;
            const dw = step > 1 ? Math.max(1, Math.floor(width / step)) : width;
            const dh = step > 1 ? Math.max(1, Math.floor(height / step)) : height;
            if (canvas.width !== dw || canvas.height !== dh || !imgData) {
                canvas.width = dw;
                canvas.height = dh;
                imgData = ctx.createImageData(dw, dh);
                img32 = new Uint32Array(imgData.data.buffer);
            }

            if (channels === 1 && step === 1) {
                // FAST PATH (the normal case): grayscale, no client downscale.
                // One Uint32 write per pixel (0xFF000000 | v<<16 | v<<8 | v)
                // is ~4× faster than four byte writes.
                for (let i = 0; i < px; i++) {
                    const v = pixels[i];
                    img32[i] = 0xFF000000 | (v << 16) | (v << 8) | v;
                }
            } else {
                // General path: optional downscale and/or RGB input.
                const rgba = imgData.data;
                let d = 0;
                for (let y = 0; y < dh; y++) {
                    const srcRow = (y * step) * width;
                    for (let x = 0; x < dw; x++) {
                        const s = (srcRow + x * step) * channels;
                        if (channels >= 3) { rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; }
                        else { const v = pixels[s]; rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; }
                        rgba[d + 3] = 255;
                        d += 4;
                    }
                }
            }
            ctx.putImageData(imgData, 0, 0);
        };

        const handleFrame = (e) => {
            if (e.detail.well !== wellIndex + 1) return;
            latest = e.detail;
            if (!rafId) rafId = requestAnimationFrame(drawLatest);
        };
        window.addEventListener('mccb_camera_frame', handleFrame);
        return () => {
            window.removeEventListener('mccb_camera_frame', handleFrame);
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [hasCam, wellIndex]);

    function play() {
        if (!hasCam) return;
        window.MCCB.sendToBackend({ cmd: 'start_camera', well: wellIndex + 1, id: cameraId });
        setPlaying(true);
    }
    function pause() {
        window.MCCB.sendToBackend({ cmd: 'stop_camera', well: wellIndex + 1 });
        setPlaying(false);
    }

    useEffect(() => {
        if (autoStart && hasCam) { play(); return () => pause(); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoStart, hasCam, cameraId]);

    function snap() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.toDataURL('image/png');
        setFlash(true); setTimeout(() => setFlash(false), 440);
        setCount(c => c + 1);
        onToast({ kind: 'shot', text: `Captured well${String(wellIndex + 1).padStart(2, '0')}` });
    }

    useEffect(() => {
        if (playing && hasCam) {
            window.MCCB.sendToBackend({ cmd: 'camera_settings', well: wellIndex + 1, exposure: settings.exposure, gain: settings.gain, fps: settings.fps });
        }
    }, [settings, playing, hasCam, wellIndex]);

    if (!hasCam) {
        return (
            <div className="cam-tile">
                <div className="cam-overlay-tl"><div className="cam-tag">WELL {String(wellIndex + 1).padStart(2, '0')}</div></div>
                <div className="cam-empty"><div className="empty-badge" style={{ width: 52, height: 52, borderColor: '#555' }}>✕</div><div>NO CAMERA DETECTED</div></div>
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
    return null;
}

const EXP_OPTS = [['500 µs', 500], ['1 ms', 1000], ['2 ms', 2000], ['5 ms', 5000], ['10 ms', 10000], ['20 ms', 20000], ['50 ms', 50000], ['100 ms', 100000]];
const GAIN_OPTS = [['0 dB', 0], ['3 dB', 3], ['6 dB', 6], ['12 dB', 12], ['18 dB', 18], ['24 dB', 24]];
const FPS_OPTS = [5, 10, 15, 20, 30];

function SettingsPanel({ onApply }) {
    const [exp, setExp] = useState(3);
    const [gain, setGain] = useState(0);
    const [fps, setFps] = useState(1);
    function apply() { onApply({ exposure: EXP_OPTS[exp][1], gain: GAIN_OPTS[gain][1], fps: FPS_OPTS[fps] }); }
    return (
        <div className="cam-settings">
            <div className="cam-settings-hd">Camera Settings</div>
            <div className="grow scroll-y" style={{ padding: 10 }}>
                <div className="gb" style={{ margin: '0 0 12px' }}><div className="gb-title">Exposure</div><div style={{ padding: '18px 10px 10px' }}>
                    <select className="select" value={exp} onChange={(e) => setExp(+e.target.value)}>{EXP_OPTS.map(([l], i) => <option key={i} value={i}>{l}</option>)}</select>
                </div></div>
                <div className="gb" style={{ margin: '0 0 12px' }}><div className="gb-title">Gain</div><div style={{ padding: '18px 10px 10px' }}>
                    <select className="select" value={gain} onChange={(e) => setGain(+e.target.value)}>{GAIN_OPTS.map(([l], i) => <option key={i} value={i}>{l}</option>)}</select>
                </div></div>
                <div className="gb" style={{ margin: '0 0 12px' }}><div className="gb-title">Frame Rate</div><div style={{ padding: '18px 10px 10px' }}>
                    <select className="select" value={fps} onChange={(e) => setFps(+e.target.value)}>{FPS_OPTS.map((v, i) => <option key={i} value={i}>{v} FPS</option>)}</select>
                </div></div>
                <button className="btn btn-block" style={{ marginBottom: 16 }} onClick={apply}>Apply To All</button>
            </div>
        </div>
    );
}

function ImagingTab({ onToast }) {
    const [cams, setCams] = useState(() => {
        try { return (window.MCCB && window.MCCB.enumerateCameras && window.MCCB.enumerateCameras()) || []; }
        catch { return []; }
    });
    const [settings, setSettings] = useState({ exposure: 5000, gain: 0, fps: 10 });
    const [full, setFull] = useState(null);
    const [viewMode, setViewMode] = useState('GRID');

    useEffect(() => {
        let iv = null, done = false;
        const finish = (list) => { setCams(list); done = true; if (iv) { clearInterval(iv); iv = null; } };
        const good = (l) => Array.isArray(l) && l.some(c => c && c.id);

        const handleCams = (e) => { if (Array.isArray(e.detail)) { setCams(e.detail); if (good(e.detail)) finish(e.detail); } };
        window.addEventListener('mccb_cameras_ready', handleCams);

        const ask = () => {
            if (done || !(window.MCCB && window.MCCB.enumerateCameras)) return;
            const cached = window.MCCB.enumerateCameras();
            if (good(cached)) finish(cached);
        };
        ask();
        // Retry only until we get a camera, so we don't keep re-enumerating the
        // bus (Aravis.update_device_list) while a feed is already streaming.
        let tries = 0;
        iv = setInterval(() => { ask(); if (++tries > 12 && iv) { clearInterval(iv); iv = null; } }, 500);

        return () => { window.removeEventListener('mccb_cameras_ready', handleCams); if (iv) clearInterval(iv); };
    }, []);

    const applyAll = (s) => setSettings(s);
    const slots = [0, 1, 2, 3];

    return (
        <div className="tab-page enter mccb-img">
            <style>{LAYOUT_CSS}</style>
            <div className="img-row">
                <div className="img-col">
                    <div className="row img-switch" style={{ padding: '12px 16px', gap: 8, borderBottom: '2px solid #000', background: '#f2f2f2' }}>
                        <button className="btn btn-sm" onClick={() => setViewMode('GRID')}
                            style={{ background: viewMode === 'GRID' ? '#000' : '#fff', color: viewMode === 'GRID' ? '#fff' : '#000', border: '2px solid #000' }}>
                            Combined View (Grid)
                        </button>
                        {slots.map(i => (
                            <button key={i} className="btn btn-sm" onClick={() => setViewMode(i)}
                                style={{ background: viewMode === i ? '#000' : '#fff', color: viewMode === i ? '#fff' : '#000', border: '2px solid #000' }}>
                                Well {i + 1}
                            </button>
                        ))}
                    </div>

                    <div className="img-stage">
                        {viewMode === 'GRID' ? (
                            <div className="cam-grid">
                                {slots.map(i => (
                                    <CameraTile key={i} wellIndex={i} cameraId={cams[i] && cams[i].id} settings={settings} onToast={onToast} onExpand={setFull} autoStart />
                                ))}
                            </div>
                        ) : (
                            <div className="img-single">
                                <CameraTile key={'single-' + viewMode} wellIndex={viewMode} cameraId={cams[viewMode] && cams[viewMode].id} settings={settings} onToast={onToast} onExpand={setFull} big autoStart />
                            </div>
                        )}
                    </div>
                </div>
                <SettingsPanel onApply={applyAll} />
            </div>

            {full != null && (
                <div className="cam-full" style={{ display: 'flex', flexDirection: 'column' }}>
                    <div className="row img-switch" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '2px solid #222' }}>
                        <span style={{ color: '#fff', fontWeight: 800, letterSpacing: 2 }}>WELL {String(full + 1).padStart(2, '0')} · FULLSCREEN</span>
                        <button className="btn btn-sm" style={{ minWidth: 130 }} onClick={() => setFull(null)}>Close ✕</button>
                    </div>
                    <div className="img-stage" style={{ flex: '1 1 auto' }}>
                        <CameraTile key={'full' + full} wellIndex={full} cameraId={cams[full] && cams[full].id} settings={settings} onToast={onToast} onExpand={() => {}} big autoStart />
                    </div>
                </div>
            )}
        </div>
    );
}

export { ImagingTab };
if (typeof window !== 'undefined') window.ImagingTab = ImagingTab;