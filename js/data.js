/* ============================================================================
data.js — MCCB telemetry engine + hardware seam (REAL HARDWARE MODE)
Connects to the Python FastAPI backend via WebSocket.
========================================================================== */
(function () {
'use strict';

const MAX_EFIELD = 1.5;   // V/cm
const MAX_MAG    = 15.0;  // Gauss
// Increased to 10000 to hold 2 seconds of data at 5 kHz (5000 samples/sec)
// This ensures the chart has a meaningful window and RMS calculation is accurate.
const HISTORY    = 10000; 
const TICK_MS    = 100;   

const ELECTRODE_GAP_CM = 0.5;
const LOAD_KOHM        = 4.7;
const COIL_A_PER_G     = 42.0;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

class Ring {
  constructor(n) { this.n = n; this.buf = []; }
  push(v) { this.buf.push(v); if (this.buf.length > this.n) this.buf.shift(); }
  get last() { return this.buf.length ? this.buf[this.buf.length - 1] : 0; }
  get values() { return this.buf; }
  clear() { this.buf = []; }
}

class WellDevice {
  constructor(num) {
    this.num = num;
    this.assigned = false;
    this.port = null;
    this.label = null;
    this.setEfield = 0;
    this.setGauss = 0;
    this.measEfield = 0;
    this.measGauss = 0;
    this.measRms = 0;
    this._hasRmsFromBackend = false; // Tracks if ESP32 is sending RMS directly
    this.voltage = 0;
    this.current = 0;
    this.coilCurrent = 0;

    this.history = {
      efield: new Ring(HISTORY),
      gauss: new Ring(HISTORY),
      voltage: new Ring(HISTORY),
      current: new Ring(HISTORY),
    };
    this.log = [];
  }

  statusOf(meas, set, max) {
    if (set <= 0 && meas < max * 0.02) return 'OFF';
    const err = Math.abs(meas - set);
    if (err > Math.max(0.04 * max, set * 0.08)) return 'RAMPING';
    if (meas > max) return 'OVER';
    return 'LOCKED';
  }
  get electricStatus() { return this.statusOf(this.measEfield, this.setEfield, MAX_EFIELD); }
  get magneticStatus() { return this.statusOf(this.measGauss, this.setGauss, MAX_MAG); }

  // Getter for RMS: returns backend value if provided, otherwise calculates from history
  get rms() {
    if (this._hasRmsFromBackend) return this.measRms;
    const vals = this.history.gauss.values;
    if (vals.length === 0) return 0;
    const sumSquares = vals.reduce((acc, val) => acc + val * val, 0);
    return Math.sqrt(sumSquares / vals.length);
  }

  _ingest(obj) {
    let gaussVal = null;
    let rmsVal = null;

    // Flexibly parse: handles {gauss: X, rms: Y} OR [X, Y] from ESP32
    if (Array.isArray(obj)) {
      gaussVal = obj[0];
      rmsVal = obj[1];
    } else {
      gaussVal = obj.gauss !== undefined ? obj.gauss : obj;
      if ('rms' in obj) {
        rmsVal = obj.rms;
        this._hasRmsFromBackend = true;
      }
    }

    if (gaussVal !== null) {
      this.history.gauss.push(gaussVal);
      this.measGauss = gaussVal;
    }
    
    if (rmsVal !== null) {
      this.measRms = rmsVal;
    }

    if ('efield' in obj) {
      this.history.efield.push(obj.efield);
      this.measEfield = obj.efield;
    } else if ('voltage' in obj) {
      this.history.efield.push(obj.voltage / ELECTRODE_GAP_CM);
      this.voltage = obj.voltage;
      this.history.voltage.push(obj.voltage);
    }
    if ('current' in obj) {
      this.current = obj.current;
      this.history.current.push(obj.current);
    }
    if ('coil' in obj) this.coilCurrent = obj.coil;

    const line = JSON.stringify(obj);
    this.log.push(line);
    if (this.log.length > 400) this.log.shift();
    return line;
  }

  reset() {
    this.setEfield = 0; this.setGauss = 0;
    this.measEfield = 0; this.measGauss = 0;
    this.measRms = 0;
    this._hasRmsFromBackend = false;
    this.voltage = 0; this.current = 0; this.coilCurrent = 0;
  }
}

// =========================================================================
// ---- WebSocket Connection Manager ---------------------------------------
// =========================================================================
let ws = null;
let wsConnected = false;
let cachedPorts = [];
let cachedCameras = [];

function connectToBackend() {
  const wsUrl = `ws://${window.location.hostname}:8000/ws/hardware`;
  console.log(`[MCCB] Connecting to backend at ${wsUrl}...`);
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('[MCCB] Connected to hardware backend');
    wsConnected = true;
    sendToBackend({ cmd: 'enumerate_ports' });
    sendToBackend({ cmd: 'enumerate_cameras' });
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      const view = new DataView(event.data);
      const well = view.getUint8(0);
      const w = view.getUint16(1);
      const h = view.getUint16(3);
      const pixels = new Uint8ClampedArray(event.data, 5);
      window.dispatchEvent(new CustomEvent('mccb_camera_frame', { 
        detail: { well, width: w, height: h, pixels } 
      }));
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      handleBackendMessage(msg);
    } catch (e) {
      console.error('[MCCB] Failed to parse backend message:', e);
    }
  };

  ws.onclose = () => {
    console.warn('[MCCB] Disconnected from backend. Reconnecting in 3s...');
    wsConnected = false;
    setTimeout(connectToBackend, 3000);
  };

  ws.onerror = (err) => {
    console.error('[MCCB] WebSocket error:', err);
  };
}

function sendToBackend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function handleBackendMessage(msg) {
  if (msg.type === 'telemetry') {
    const wellNum = msg.well;
    if (engine.wells[wellNum]) {
      engine.wells[wellNum]._ingest(msg.data);
      engine._emit(); // Trigger UI charts/readouts to update
    }
  } else if (msg.type === 'ports') {
    cachedPorts = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_ports_ready', { detail: msg.data }));
  } else if (msg.type === 'cameras') {
    cachedCameras = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_cameras_ready', { detail: msg.data }));
  }
}

// =========================================================================
// ---- Engine -------------------------------------------------------------
// =========================================================================
class Engine {
  constructor() {
    this.wells = {};
    for (let i = 1; i <= 4; i++) this.wells[i] = new WellDevice(i);
    this._subs = new Set();
    this._cmdSubs = new Set();
    this.running = false;
    this.globalStopped = false;
  }
  
  subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
  onCommand(cb) { this._cmdSubs.add(cb); return () => this._cmdSubs.delete(cb); }
  _emit() { this._subs.forEach((cb) => cb(this)); }

  _command(obj) {
    this._cmdSubs.forEach((cb) => cb(obj));
    sendToBackend(obj); 
  }

  start() {
    if (this.running) return;
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  assign(map) {
    for (let i = 1; i <= 4; i++) {
      const w = this.wells[i];
      if (map[i]) { 
        w.assigned = true; 
        w.port = map[i].port; 
        w.label = map[i].label; 
        sendToBackend({ cmd: 'connect_well', well: i, port: map[i].port });
      } else { 
        w.assigned = false; 
        w.port = null; 
        w.label = null; 
        w.reset(); 
        sendToBackend({ cmd: 'disconnect_well', well: i });
      }
    }
  }

  setParams(wellNum, { efield, gauss }) {
    const w = this.wells[wellNum];
    if (!w || !w.assigned) return;
    this.globalStopped = false;
    if (efield != null) { 
      w.setEfield = clamp(efield, 0, MAX_EFIELD); 
      this._command({ cmd: 'set', well: wellNum, voltage: w.setEfield }); 
    }
    if (gauss != null)  { 
      w.setGauss = clamp(gauss, 0, MAX_MAG);     
      this._command({ cmd: 'set', well: wellNum, gauss: w.setGauss }); 
    }
  }

  stopWell(wellNum) {
    const w = this.wells[wellNum];
    if (!w) return;
    w.setEfield = 0; w.setGauss = 0;
    this._command({ cmd: 'stop', well: wellNum });
  }

  stopAll() {
    this.globalStopped = true;
    for (const w of Object.values(this.wells)) {  w.setEfield = 0; w.setGauss = 0; }
    this._command({ cmd: 'stop', well: 'all' });
  }

  get assignedWells() { return Object.values(this.wells).filter((w) => w.assigned).map((w) => w.num); }
  get anyActive() { return Object.values(this.wells).some((w) => w.assigned && (w.setEfield > 0 || w.setGauss > 0)); }
}

function enumeratePorts() {
  if (wsConnected) sendToBackend({ cmd: 'enumerate_ports' });
  return cachedPorts;
}

function enumerateCameras() {
  if (wsConnected) sendToBackend({ cmd: 'enumerate_cameras' });
  return cachedCameras;
}

const engine = new Engine();
connectToBackend();

window.MCCB = {
  MAX_EFIELD, MAX_MAG, HISTORY,
  engine: engine,
  enumeratePorts,
  enumerateCameras,
  sendToBackend,
  clamp,
};
})();