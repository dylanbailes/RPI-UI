import React from 'react';
import { useEffect, useState, useRef } from 'react';

// ---- Camera tile (Real Hardware Feed) -------------------------------------
function CameraTile({ wellIndex, cameraId, settings, onToast, onExpand, big, autoStart }) {
    const canvasRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [flash, setFlash] = useState(false);
    const [count, setCount] = useState(0);
    const hasCam = !!cameraId;

    useEffect(() => {
        if (!hasCam) return;
        const handleFrame = (e) => {
            const { well, width, height, pixels } = e.detail;
            if (well !== wellIndex + 1) return; // wellIndex 0-based, well 1-based
            const canvas = canvasRef.current;
            if (!canvas || !width || !height) return;

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            const px = width * height;
            // Be robust to the camera's pixel format instead of assuming Mono8.
            // channels = how many source bytes per pixel (1=Mono8, 3=RGB8, etc.)
            const channels = Math.max(1, Math.round(pixels.length / px));
            const rgba = new Uint8ClampedArray(px * 4);
            for (let p = 0; p < px; p++) {
                const s = p * channels;
                const d = p * 4;
                if (channels >= 3) {
                    rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2];
                } else {
                    const v = pixels[s];
                    rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v;
                }
                rgba[d + 3] = 255;
            }
            ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
        };
        window.addEventListener('mccb_camera_frame', handleFrame);
        return () => window.removeEventListener('mccb_camera_frame', handleFrame);
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

    // Auto-start the live feed as soon as a camera is present so the tab shows
    // an image without the operator having to hit play. Stops on unmount/tab away.
    useEffect(() => {
        if (autoStart && hasCam) {
            play();
            return () => pause();
        }
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
            window.MCCB.sendToBackend({
                cmd: 'camera_settings', well: wellIndex + 1,
                exposure: settings.exposure, gain: settings.gain, fps: settings.fps
            });
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
            <canvas ref={canvasRef} className="cam-feed" style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000' }}></canvas>
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

function SettingsPanel({ onApply, snapDir }) {
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
    // Seed from whatever the backend already cached at startup (it pushes the
    // camera list once on connect, before this tab ever mounts).
    const [cams, setCams] = useState(() => {
        try { return (window.MCCB && window.MCCB.enumerateCameras && window.MCCB.enumerateCameras()) || []; }
        catch { return []; }
    });
    const [settings, setSettings] = useState({ exposure: 5000, gain: 0, fps: 10 });
    const [full, setFull] = useState(null);
    const [viewMode, setViewMode] = useState('GRID');
    const snapDir = '~/mccb_snapshots/';

    useEffect(() => {
        // 1) Listen FIRST so we can't miss a push that arrives mid-mount.
        const handleCams = (e) => { if (Array.isArray(e.detail)) setCams(e.detail); };
        window.addEventListener('mccb_cameras_ready', handleCams);

        // 2) Ask the backend to (re)enumerate now. enumerateCameras() also returns
        //    the cached list synchronously — use it if it's already populated.
        const ask = () => {
            if (!(window.MCCB && window.MCCB.enumerateCameras)) return;
            const cached = window.MCCB.enumerateCameras();
            if (Array.isArray(cached) && cached.some(c => c && c.id)) setCams(cached);
        };
        ask();

        // 3) If the socket wasn't connected yet at mount, keep retrying briefly so
        //    a late connection still fills the grid with no manual refresh.
        let tries = 0;
        const iv = setInterval(() => { ask(); if (++tries > 12) clearInterval(iv); }, 500);

        return () => { window.removeEventListener('mccb_cameras_ready', handleCams); clearInterval(iv); };
    }, []);

    const applyAll = (s) => setSettings(s);
    // Always render a fixed set of 4 well slots; index into cams defensively so
    // the grid is NEVER empty/blank even before the list arrives.
    const slots = [0, 1, 2, 3];

    return (
        <div className="tab-page enter">
            <div className="row grow" style={{ minHeight: 0 }}>
                <div className="col grow" style={{ minHeight: 0 }}>
                    <div className="row" style={{ padding: '12px 16px', gap: 8, borderBottom: '2px solid #000', background: '#f2f2f2' }}>
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

                    <div className="grow" style={{ position: 'relative', minHeight: 0, background: '#000' }}>
                        {viewMode === 'GRID' ? (
                            <div className="cam-grid" style={{ height: '100%' }}>
                                {slots.map(i => (
                                    <CameraTile key={i} wellIndex={i} cameraId={cams[i] && cams[i].id} settings={settings} onToast={onToast} onExpand={setFull} autoStart />
                                ))}
                            </div>
                        ) : (
                            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CameraTile key={'single-' + viewMode} wellIndex={viewMode} cameraId={cams[viewMode] && cams[viewMode].id} settings={settings} onToast={onToast} onExpand={setFull} big autoStart />
                            </div>
                        )}
                    </div>
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
                        <CameraTile key={'full' + full} wellIndex={full} cameraId={cams[full] && cams[full].id} settings={settings} onToast={onToast} onExpand={() => {}} big autoStart />
                    </div>
                </div>
            )}
        </div>
    );
}

export { ImagingTab };
if (typeof window !== 'undefined') window.ImagingTab = ImagingTab;