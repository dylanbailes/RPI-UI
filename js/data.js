/* ============================================================================
data.js — MCCB telemetry engine + hardware seam (REAL HARDWARE MODE)
========================================================================== */
(function () {
'use strict';

// ---- Safety limits ------------------------------------------------------
const MAX_EFIELD = 1.5;   // V/cm
const MAX_MAG    = 50.0;  // Gauss (UPDATED from 15.0)
const HISTORY    = 10000; // 2 seconds of data at 5kHz (UPDATED from 240)
const TICK_MS    = 100;   

const ELECTRODE_GAP_CM = 0.5;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function buildReverseLutFromArr(lutArr) {
    const reverse = [];
    for(let i=0; i<lutArr.length; i++) {
        reverse.push({ pwm: i / 10.0, val: lutArr[i] });
    }
    return reverse;
}

// =========================================================================
// ---- LOOKUP TABLES (PWM % -> Physical Value) ----------------------------
// =========================================================================
// These tables map 0.1% PWM increments to physical values.
// REPLACE the placeholder generator below with your actual calibration data!
// Format: { 0.0: 0.0, 0.1: 0.05, 0.2: 0.10, ... 100.0: 50.0 }

function generatePlaceholderLut(maxVal) {
  const lut = {};
  for (let i = 0; i <= 1000; i++) {
    lut[i / 10.0] = (i / 1000.0) * maxVal; // Linear placeholder
  }
  return lut;
}

// TODO: Replace these with your real calibration dictionaries
const PWM_TO_GAUSS  = generatePlaceholderLut(50.0); 
const PWM_TO_EFIELD = generatePlaceholderLut(1.5);

// Invert LUTs for fast Physical -> PWM lookup
function buildReverseLut(forwardLut) {
  const reverse = [];
  const keys = Object.keys(forwardLut).map(Number).sort((a, b) => a - b);
  for (const k of keys) reverse.push({ pwm: k, val: forwardLut[k] });
  return reverse;
}

const GAUSS_LUT  = buildReverseLut(PWM_TO_GAUSS);
const EFIELD_LUT = buildReverseLut(PWM_TO_EFIELD);

// Interpolates the exact PWM % for a target physical value.
// Single definition — guards against empty/missing LUTs.
function physicalToPwm(target, lut) {
  if (!lut || lut.length === 0) return 0.0;
  if (target <= 0) return 0.0;
  if (target >= lut[lut.length - 1].val) return lut[lut.length - 1].pwm;

  for (let i = 1; i < lut.length; i++) {
    if (target <= lut[i].val) {
      const p0 = lut[i - 1], p1 = lut[i];
      const ratio = (target - p0.val) / (p1.val - p0.val);
      return p0.pwm + ratio * (p1.pwm - p0.pwm); // Linear interpolation
    }
  }
  return lut[lut.length - 1].pwm;
}

// ---- Ring buffer -------------------------------------------------------
class Ring {
  constructor(n) { this.n = n; this.buf = []; }
  push(v) { this.buf.push(v); if (this.buf.length > this.n) this.buf.shift(); }
  get last() { return this.buf.length ? this.buf[this.buf.length - 1] : 0; }
  get values() { return this.buf; }
  clear() { this.buf = []; }
}

// ---- Per-well device ---------------------------------------------------
class WellDevice {
  constructor(num) {
    this.num = num;
    this.assigned = false;
    this.port = null;
    this.label = null;
    this.setEfield = 0;
    this.setGauss = 0;
    this.measEfield = 0;
    this.measGauss1 = 0;
    this.measGauss2 = 0;
    this._sumSq1 = 0; 
    this._sumSq2 = 0;
    this.voltage = 0;
    this.current = 0;
    this.coilCurrent = 0;
    this.calibrated = false;
    this.calibrating = false;
    this.gaussLut = null;
    this.reverseGaussLut = null;

    this.history = {
      efield: new Ring(HISTORY),
      gauss1: new Ring(HISTORY),
      gauss2: new Ring(HISTORY),
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
  get magneticStatus() { return this.statusOf(Math.max(this.measGauss1, this.measGauss2), this.setGauss, MAX_MAG); }

  get rms1() {
    const len = this.history.gauss1.buf.length;
    return len > 0 ? Math.sqrt(this._sumSq1 / len) : 0;
  }
  get rms2() {
    const len = this.history.gauss2.buf.length;
    return len > 0 ? Math.sqrt(this._sumSq2 / len) : 0;
  }

  _ingest(obj) {
    if ('efield' in obj) this.history.efield.push(obj.efield);
    else if ('voltage' in obj) this.history.efield.push(obj.voltage / ELECTRODE_GAP_CM);
    
    if ('gauss1' in obj) {
      const v = obj.gauss1;
      const ring = this.history.gauss1;
      if (ring.buf.length >= ring.n) this._sumSq1 -= ring.buf[0] ** 2;
      ring.push(v);
      this._sumSq1 += v * v;
      this.measGauss1 = v;
    }
    if ('gauss2' in obj) {
      const v = obj.gauss2;
      const ring = this.history.gauss2;
      if (ring.buf.length >= ring.n) this._sumSq2 -= ring.buf[0] ** 2;
      ring.push(v);
      this._sumSq2 += v * v;
      this.measGauss2 = v;
    }

    if ('voltage' in obj) { this.voltage = obj.voltage; this.history.voltage.push(obj.voltage); }
    if ('current' in obj) { this.current = obj.current; this.history.current.push(obj.current); }
    if ('coil' in obj) this.coilCurrent = obj.coil;
    if ('efield' in obj) this.measEfield = obj.efield;

    const line = JSON.stringify(obj);
    this.log.push(line);
    if (this.log.length > 400) this.log.shift();
    return line;
  }

  reset() {
    this.setEfield = 0; this.setGauss = 0;
    this.measEfield = 0; this.measGauss1 = 0; this.measGauss2 = 0;
    this._sumSq1 = 0; this._sumSq2 = 0;
    this.voltage = 0; this.current = 0; this.coilCurrent = 0;
    Object.values(this.history).forEach(ring => ring.clear());
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
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
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
      window.dispatchEvent(new CustomEvent('mccb_camera_frame', { detail: { well, width: w, height: h, pixels } }));
      return;
    }
    try { handleBackendMessage(JSON.parse(event.data)); } catch (e) {}
  };

  ws.onclose = () => { wsConnected = false; setTimeout(connectToBackend, 3000); };
}

function sendToBackend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleBackendMessage(msg) {
  if (msg.type === 'telemetry') {
    const wellNum = msg.well;
    if (engine.wells[wellNum]) {
      engine.wells[wellNum]._ingest(msg.data);
      engine._emit();
    }
  } else if (msg.type === 'ports') {
    cachedPorts = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_ports_ready', { detail: msg.data }));
  } else if (msg.type === 'cameras') {
    cachedCameras = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_cameras_ready', { detail: msg.data }));
  } else if (msg.type === 'calibration') {
    const wellNum = msg.well;
    if (engine.wells[wellNum]) {
        engine.wells[wellNum].gaussLut = msg.data.lut;
        engine.wells[wellNum].calibrated = true;
        engine.wells[wellNum].calibrating = false;
        engine.wells[wellNum].reverseGaussLut = buildReverseLutFromArr(msg.data.lut);
        engine._emit();
    }
  } else if (msg.type === 'cal_status') {
    const wellNum = msg.well;
    if (engine.wells[wellNum]) {
        engine.wells[wellNum].calibrating = (msg.data.status === 'running');
        if (msg.data.status === 'done') engine.wells[wellNum].calibrating = false;
        engine._emit();
    }
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
    this.running = false;
    this.globalStopped = false;
  }
  
  subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
  _emit() { this._subs.forEach((cb) => cb(this)); }

  start() { this.running = true; }
  stop() { this.running = false; }

  assign(map) {
    for (let i = 1; i <= 4; i++) {
      const w = this.wells[i];
      if (map[i]) { 
        w.assigned = true; w.port = map[i].port; w.label = map[i].label; 
        sendToBackend({ cmd: 'connect_well', well: i, port: map[i].port });
      } else { 
        w.assigned = false; w.reset(); 
        sendToBackend({ cmd: 'disconnect_well', well: i });
      }
    }
  }

  setParams(wellNum, { efield, gauss }) {
    const w = this.wells[wellNum];
    if (!w || !w.assigned) return;

    this.globalStopped = false;

    // Electric field has no LUT yet — scale linearly. Not gated by calibration.
    if (efield != null) {
      w.setEfield = clamp(efield, 0, MAX_EFIELD);
      this._command({ cmd: 'set', well: wellNum, channel: 'e', pwm: w.setEfield * (100.0 / MAX_EFIELD) });
    }

    if (gauss != null) {
      // ENFORCE CALIBRATION — only blocks the magnetic channel, not electric.
      if (!w.calibrated) {
        console.warn("Cannot set Gauss: Well not calibrated!");
        window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'error', text: `Well ${wellNum} requires magnetic calibration first.` } }));
        return;
      }
      w.setGauss = clamp(gauss, 0, MAX_MAG);
      const pwm = physicalToPwm(w.setGauss, w.reverseGaussLut);
      this._command({ cmd: 'set', well: wellNum, channel: 'h', pwm: pwm });
    }
  }

  _command(obj) { sendToBackend(obj); }

  // ---- Calibration --------------------------------------------------------
  // Initiate a magnetic sweep on a single well. Marks the well as calibrating
  // optimistically so the UI reflects it immediately; the backend confirms via
  // cal_status / calibration messages handled in handleBackendMessage().
  calibrateWell(wellNum) {
    const w = this.wells[wellNum];
    if (!w || !w.assigned || w.calibrating) return;
    w.calibrating = true;
    this._command({ cmd: 'calibrate', well: wellNum });
    this._emit();
  }

  // Kick off calibration on every assigned well that isn't already running.
  calibrateAll() {
    let started = 0;
    for (const w of Object.values(this.wells)) {
      if (w.assigned && !w.calibrating) {
        w.calibrating = true;
        this._command({ cmd: 'calibrate', well: w.num });
        started++;
      }
    }
    if (started) this._emit();
    return started;
  }

  stopWell(wellNum) {
    const w = this.wells[wellNum];
    if (!w) return;
    w.setEfield = 0; w.setGauss = 0;
    this._command({ cmd: 'stop', well: wellNum });
  }

  stopAll() {
    this.globalStopped = true;
    for (const w of Object.values(this.wells)) { w.setEfield = 0; w.setGauss = 0; }
    this._command({ cmd: 'stop', well: 'all' });
  }

  get assignedWells() { return Object.values(this.wells).filter((w) => w.assigned).map((w) => w.num); }
  get anyActive() { return Object.values(this.wells).some((w) => w.assigned && (w.setEfield > 0 || w.setGauss > 0)); }
  get anyCalibrating() { return Object.values(this.wells).some((w) => w.assigned && w.calibrating); }
}

function enumeratePorts() { if (wsConnected) sendToBackend({ cmd: 'enumerate_ports' }); return cachedPorts; }
function enumerateCameras() { if (wsConnected) sendToBackend({ cmd: 'enumerate_cameras' }); return cachedCameras; }

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