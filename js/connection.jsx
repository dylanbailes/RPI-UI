import React from 'react';
import { useEffect, useState } from 'react';

function Connection({ onConnect, onExit }) {
    const [ports, setPorts] = useState([]);
    const [sel, setSel] = useState({ 1: '', 2: '', 3: '', 4: '' });
    const [spin, setSpin] = useState(false);
    const [flashOnConnect, setFlashOnConnect] = useState(true);

    useEffect(() => {
        const initialPorts = window.MCCB.enumeratePorts();
        if (initialPorts && initialPorts.length > 0) setPorts(initialPorts);

        const handlePorts = (e) => setPorts(e.detail);
        window.addEventListener('mccb_ports_ready', handlePorts);
        return () => window.removeEventListener('mccb_ports_ready', handlePorts);
    }, []);

    function refresh() {
        setSpin(true);
        window.MCCB.enumeratePorts(); // Triggers backend request
        setTimeout(() => setSpin(false), 620); 
    }

    function setWell(n, v) { setSel((s) => ({ ...s, [n]: v })); }

    const chosen = Object.values(sel).filter(Boolean);
    const dupes = chosen.filter((p, i) => chosen.indexOf(p) !== i);
    const assignedCount = chosen.length;

    function connect() {
        const map = {};
        for (let i = 1; i <= 4; i++) {
            if (sel[i]) {
                const p = ports.find((x) => x.port === sel[i]);
                map[i] = { port: sel[i], label: p ? p.label : sel[i] };
            }
        }
        onConnect(map, flashOnConnect);
    }

    return (
        <div className="tab-page enter" style={{ background: '#fff' }}>
            <div className="grow scroll-y" style={{ padding: '34px 40px' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div>
                        <div className="section-number">01 — Connection</div>
                        <h1 className="heading">Assign Serial Devices To Wells</h1>
                    </div>
                    <button className={'btn btn-secondary btn-sm' + (spin ? ' is-spin' : '')} onClick={refresh} style={{ minWidth: 190 }}>
                        <span style={{ display: 'inline-block', transition: 'transform .6s', transform: spin ? 'rotate(360deg)' : 'none' }}>↻</span>
                        {spin ? 'Scanning…' : 'Refresh Ports'}
                    </button>
                </div>

                <div className="row gap-12" style={{ marginTop: 20, marginBottom: 8 }}>
                    <div className="live-tag"><span className="live-dot on"></span>{ports.length} DEVICES DETECTED</div>
                    <div className="live-tag"><span className="live-dot" style={{ background: assignedCount ? 'var(--ok)' : 'var(--disabled)' }}></span>{assignedCount} / 4 WELLS MAPPED</div>
                </div>

                <div className="gb panel-muted" style={{ marginTop: 22 }}>
                    <div className="gb-title">Device Mapping</div>
                    <div className="gb-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
                        {[1, 2, 3, 4].map((n) => {
                            const isDupe = sel[n] && dupes.includes(sel[n]);
                            return (
                                <div key={n} className="col" style={{ gap: 8 }}>
                                    <div className="row" style={{ justifyContent: 'space-between' }}>
                                        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>Well {n}</span>
                                        {sel[n]
                                            ? <span className="status-pill" style={{ color: isDupe ? '#fff' : '#0A6B2E', background: isDupe ? 'var(--accent)' : '#D8F3DF', fontSize: 10, padding: '3px 8px' }}>
                                                <span className="status-dot" style={{ background: isDupe ? '#fff' : '#16A34A' }}></span>{isDupe ? 'Conflict' : 'Ready'}
                                            </span>
                                            : <span className="kicker" style={{ color: 'var(--disabled)' }}>Unassigned</span>}
                                    </div>
                                    <select className="select" value={sel[n]} onChange={(e) => setWell(n, e.target.value)} style={isDupe ? { borderColor: 'var(--accent)' } : null}>
                                        <option value="">(NONE)</option>
                                        {ports.map((p) => <option key={p.port} value={p.port}>{p.label}</option>)}
                                    </select>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Firmware flashing option */}
                <div className="gb" style={{ marginTop: 22 }}>
                    <div className="gb-title">Firmware</div>
                    <div className="gb-body">
                        <button
                            className="row"
                            onClick={() => setFlashOnConnect((v) => !v)}
                            style={{
                                width: '100%', justifyContent: 'space-between', alignItems: 'center',
                                gap: 16, padding: '14px 16px', border: '2px solid #000', background: '#fff',
                                cursor: 'pointer', textAlign: 'left',
                            }}>
                            <div className="col" style={{ gap: 4 }}>
                                <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>Flash Firmware On Connect</span>
                                <span style={{ color: 'var(--dim)', fontSize: 12, lineHeight: 1.5, maxWidth: 560 }}>
                                    Compiles <span className="mono">esp32_helmholtz.ino</span> and uploads it to each mapped well before streaming.
                                    The sketch is only recompiled when it changes. Turn off to skip flashing when nothing was modified.
                                </span>
                            </div>
                            {/* Swiss-style toggle */}
                            <span style={{
                                flex: '0 0 auto', width: 54, height: 30, borderRadius: 0, border: '2px solid #000',
                                background: flashOnConnect ? 'var(--accent)' : '#fff', position: 'relative',
                                transition: 'background .15s',
                            }}>
                                <span style={{
                                    position: 'absolute', top: 2, left: flashOnConnect ? 26 : 2, width: 22, height: 22,
                                    background: flashOnConnect ? '#fff' : '#000', transition: 'left .15s',
                                }}></span>
                            </span>
                        </button>
                    </div>
                </div>

                <p style={{ color: 'var(--dim)', fontSize: 13, lineHeight: 1.5, marginTop: 18, maxWidth: 620 }}>
                    Each well drives its own ESP32 over USB serial @ 500000 baud. Bridge chips appear as CP210x or CH340.
                    Wells left as <strong>(NONE)</strong> stay idle. {dupes.length > 0 && <span style={{ color: 'var(--accent)', fontWeight: 700 }}> One port is mapped to multiple wells.</span>}
                </p>
            </div>

            <div className="divider"></div>
            <div className="row" style={{ padding: '16px 40px', gap: 16, justifyContent: 'space-between' }}>
                <button className="btn btn-danger" onClick={onExit} style={{ minWidth: 200 }}>Exit Application</button>
                <button className="btn" onClick={connect} disabled={assignedCount === 0 || dupes.length > 0} style={{ minWidth: 280, fontSize: 16 }}>
                    {flashOnConnect ? 'Flash & Connect →' : 'Connect & Continue →'}
                </button>
            </div>
        </div>
    );
}

export default Connection;
if (typeof window !== 'undefined') window.ConnectionScreen = Connection; // Fallback for app.jsx