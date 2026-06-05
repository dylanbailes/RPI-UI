import { useEffect, useState, useRef } from 'react';

// ---- Camera tile (Real Hardware Feed) -------------------------------------
function CameraTile({ wellIndex, cameraId, settings, onToast, onExpand, big }) {
    const canvasRef = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [flash, setFlash] = useState(false);
    const [count, setCount] = useState(0);
    const hasCam = !!cameraId;

    useEffect(() => {
        if (!hasCam) return;

        // Listen for raw binary frames from the Python backend
        const handleFrame = (e) => {
            const { well, width, height, pixels } = e.detail;
            if (well !== wellIndex + 1) return; // wellIndex is 0-based, well is 1-based
            
            const canvas = canvasRef.current;
            if (!canvas) return;
            
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            
            // Convert Mono8 (Grayscale) to RGBA for Canvas ImageData
            const rgbaPixels = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < pixels.length; i++) {
                const v = pixels[i];
                const idx = i * 4;
                rgbaPixels[idx] = v;     // R
                rgbaPixels[idx + 1] = v; // G
                rgbaPixels[idx + 2] = v; // B
                rgbaPixels[idx + 3] = 255; // A
            }
            
            const imageData = new ImageData(rgbaPixels, width, height);
            ctx.putImageData(imageData, 0, 0);
        };

        window.addEventListener('mccb_camera_frame', handleFrame);
        return () => window.removeEventListener('mccb_camera_frame', handleFrame);
    }, [hasCam, wellIndex]);

    function play() {
        window.MCCB.sendToBackend({ cmd: 'start_camera', well: wellIndex + 1, id: cameraId });
        setPlaying(true);
    }
    function pause() {
        window.MCCB.sendToBackend({ cmd: 'stop_camera', well: wellIndex + 1 });
        setPlaying(false);
    }
    function snap() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dataUrl = canvas.toDataURL('image/png');
        // Trigger download or save logic here
        setFlash(true); setTimeout(() => setFlash(false), 440);
        setCount(c => c + 1);
        onToast({ kind: 'shot', text: `Captured well${String(wellIndex + 1).padStart(2, '0')}` });
    }

    // Push settings to backend when they change
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

// ---- Settings panel -------------------------------------------------------
const EXP_OPTS = [['500 µs', 500], ['1 ms', 1000], ['2 ms', 2000], ['5 ms', 5000], ['10 ms', 10000], ['20 ms', 20000], ['50 ms', 50000], ['100 ms', 100000]];
const GAIN_OPTS = [['0 dB', 0], ['3 dB', 3], ['6 dB', 6], ['12 dB', 12], ['18 dB', 18], ['24 dB', 24]];
const FPS_OPTS = [5, 10, 15, 20, 30];

function SettingsPanel({ onApply, snapDir }) {
    const [exp, setExp] = useState(3);
    const [gain, setGain] = useState(0);
    const [fps, setFps] = useState(1);

    function apply() {
        onApply({ exposure: EXP_OPTS[exp][1], gain: GAIN_OPTS[gain][1], fps: FPS_OPTS[fps] });
    }

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

// ---- Imaging tab ----------------------------------------------------------
function ImagingTab({ onToast }) {
    const [cams, setCams] = useState([]);
    const [settings, setSettings] = useState({ exposure: 5000, gain: 0, fps: 10 });
    const [full, setFull] = useState(null);
    const snapDir = '~/mccb_snapshots/';

    useEffect(() => {
        setCams(window.MCCB.enumerateCameras());
        const handleCams = (e) => setCams(e.detail);
        window.addEventListener('mccb_cameras_ready', handleCams);
        return () => window.removeEventListener('mccb_cameras_ready', handleCams);
    }, []);

    const applyAll = (s) => setSettings(s);

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

export { ImagingTab };
if (typeof window !== 'undefined') window.ImagingTab = ImagingTab;