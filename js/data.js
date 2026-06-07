/* ============================================================================
data.js — MCCB telemetry engine + hardware seam (REAL HARDWARE MODE)
FIX: Raw serial lines are now properly pushed to well.log so the UI serial
     feed shows every message. Two-float telemetry ("21.2 31.5") is ingested
     into gauss1/gauss2 and both history rings are updated.

RMS FIX: Removed the manual running-sum accumulators (_sumSq1/_sumSq2).
     The previous approach subtracted the outgoing sample *before* ring.push()
     shifted it out, meaning the eviction was applied twice — once manually and
     once inside push() — causing _sumSq to accumulate toward infinity and
     occasionally go negative via floating-point underflow. rms1/rms2 now
     iterate the ring buffer directly, which is always correct regardless of
     buffer size and has negligible CPU cost at the 10 Hz UI tick rate.
========================================================================== */
(function () {
'use strict';

// ---- Safety limits ------------------------------------------------------
const MAX_EFIELD = 1.5;   // V/cm
const MAX_MAG    = 50.0;  // Gauss
const HISTORY    = 10000; // 2 seconds of data at 5kHz
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
function generatePlaceholderLut(maxVal) {
  const lut = {};
  for (let i = 0; i <= 1000; i++) {
    lut[i / 10.0] = (i / 1000.0) * maxVal;
  }
  return lut;
}

// TODO: Replace these with your real calibration dictionaries
const PWM_TO_GAUSS  = generatePlaceholderLut(50.0);
const PWM_TO_EFIELD = generatePlaceholderLut(1.5);

function buildReverseLut(forwardLut) {
  const reverse = [];
  const keys = Object.keys(forwardLut).map(Number).sort((a, b) => a - b);
  for (const k of keys) reverse.push({ pwm: k, val: forwardLut[k] });
  return reverse;
}

const GAUSS_LUT  = buildReverseLut(PWM_TO_GAUSS);
const EFIELD_LUT = buildReverseLut(PWM_TO_EFIELD);

function physicalToPwm(target, lut) {
  if (!lut || lut.length === 0) return 0.0;
  if (target <= 0) return 0.0;
  if (target >= lut[lut.length - 1].val) return lut[lut.length - 1].pwm;
  for (let i = 1; i < lut.length; i++) {
    if (target <= lut[i].val) {
      const p0 = lut[i - 1], p1 = lut[i];
      const ratio = (target - p0.val) / (p1.val - p0.val);
      return p0.pwm + ratio * (p1.pwm - p0.pwm);
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
    this.voltage = 0;
    this.current = 0;
    this.coilCurrent = 0;
    this.calibrated = false;
    this.calibrating = false;
    this.flashing = false;
    this.gaussLut = null;
    this.reverseGaussLut = null;

    this.history = {
      efield: new Ring(HISTORY),
      gauss1: new Ring(HISTORY),
      gauss2: new Ring(HISTORY),
      voltage: new Ring(HISTORY),
      current: new Ring(HISTORY),
    };
    // log stores both raw serial lines and system event lines.
    // Raw lines come in as plain strings (from "raw" level backend messages).
    // System/event lines are prefixed with "» [LEVEL] " for easy filtering.
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

  // Compute RMS by iterating the ring buffer directly.
  // This is always correct: no accumulator drift, no negative values, no
  // infinity growth. At 10 Hz UI ticks iterating up to 10 000 floats costs
  // ~0.05 ms in V8 — well within budget.
  static _rmsOf(ring) {
    const buf = ring.buf;
    const n = buf.length;
    if (n === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) sumSq += buf[i] * buf[i];
    return Math.sqrt(sumSq / n);
  }
  get rms1() { return WellDevice._rmsOf(this.history.gauss1); }
  get rms2() { return WellDevice._rmsOf(this.history.gauss2); }

  // _ingest handles JSON telemetry objects from the backend.
  // Both gauss1 and gauss2 are updated and tracked in their own history rings.
  _ingest(obj) {
    if ('efield' in obj) this.history.efield.push(obj.efield);
    else if ('voltage' in obj) this.history.efield.push(obj.voltage / ELECTRODE_GAP_CM);

    if ('gauss1' in obj) {
      this.measGauss1 = obj.gauss1;
      this.history.gauss1.push(obj.gauss1);
    }
    if ('gauss2' in obj) {
      this.measGauss2 = obj.gauss2;
      this.history.gauss2.push(obj.gauss2);
    }

    if ('voltage' in obj) { this.voltage = obj.voltage; this.history.voltage.push(obj.voltage); }
    if ('current' in obj) { this.current = obj.current; this.history.current.push(obj.current); }
    if ('coil' in obj) this.coilCurrent = obj.coil;
    if ('efield' in obj) this.measEfield = obj.efield;
  }

  // _pushLog is called for every line received over serial, regardless of type.
  // Raw lines (level === 'raw') are stored verbatim so the serial feed shows them.
  // System lines (level === info/ok/warn/error) get a "» [LEVEL]" prefix so
  // LogPanel can distinguish them from raw telemetry for filtered views.
  _pushLog(level, line) {
    const entry = level === 'raw' ? line : `» [${level.toUpperCase()}] ${line}`;
    this.log.push(entry);
    if (this.log.length > 600) this.log.shift();
  }

  reset() {
    this.setEfield = 0; this.setGauss = 0;
    this.measEfield = 0; this.measGauss1 = 0; this.measGauss2 = 0;
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
    const wellNum = msg.data.well;
    if (engine.wells[wellNum]) {
      engine.wells[wellNum]._ingest(msg.data.data);
      engine._emit();
    }
  } else if (msg.type === 'log') {
    // ALL serial lines — both raw board output and system events — come through
    // this path. Push every one to the well's log so the UI serial feed is complete.
    const wellNum = msg.data.well;
    const w = engine.wells[wellNum];
    if (w) {
      const level = msg.data.level || 'info';
      const line  = msg.data.line  || '';
      w._pushLog(level, line);
      engine._emit();
    }
  } else if (msg.type === 'ports') {
    cachedPorts = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_ports_ready', { detail: msg.data }));
  } else if (msg.type === 'cameras') {
    cachedCameras = msg.data;
    window.dispatchEvent(new CustomEvent('mccb_cameras_ready', { detail: msg.data }));
  } else if (msg.type === 'calibration') {
    const wellNum = msg.data.well;
    if (engine.wells[wellNum]) {
      engine.wells[wellNum].gaussLut = msg.data.lut;
      engine.wells[wellNum].calibrated = true;
      engine.wells[wellNum].calibrating = false;
      engine.wells[wellNum].reverseGaussLut = buildReverseLutFromArr(msg.data.lut);
      engine._emit();
    }
  } else if (msg.type === 'cal_status') {
    const wellNum = msg.data.well;
    if (engine.wells[wellNum]) {
      engine.wells[wellNum].calibrating = (msg.data.status === 'running');
      if (msg.data.status === 'done') engine.wells[wellNum].calibrating = false;
      engine._emit();
    }
  } else if (msg.type === 'flash_status') {
    const wellNum = msg.data.well;
    const w = engine.wells[wellNum];
    if (w) {
      const status = msg.data.status;
      w.flashing = (status === 'running');
      if (status === 'running') {
        window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'ok', text: `Flashing firmware to Well ${wellNum}…` } }));
      } else if (status === 'done') {
        window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'ok', text: `Well ${wellNum} firmware flashed` } }));
      } else if (status === 'error') {
        window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'error', text: `Well ${wellNum} flash failed: ${msg.data.msg || 'unknown error'}` } }));
      }
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

  assign(map, doFlash = true) {
    for (let i = 1; i <= 4; i++) {
      const w = this.wells[i];
      if (map[i]) {
        w.assigned = true; w.port = map[i].port; w.label = map[i].label;
        sendToBackend({ cmd: 'connect_well', well: i, port: map[i].port, flash: !!doFlash });
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

    if (efield != null) {
      w.setEfield = clamp(efield, 0, MAX_EFIELD);
      this._command({ cmd: 'set', well: wellNum, channel: 'e', pwm: w.setEfield * (100.0 / MAX_EFIELD) });
    }
    if (gauss != null) {
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

  calibrateWell(wellNum) {
    const w = this.wells[wellNum];
    if (!w || !w.assigned || w.calibrating) return;
    w.calibrating = true;
    w._pushLog('info', 'Calibration requested — sent "c" to device, waiting for CAL_START…');
    this._command({ cmd: 'calibrate', well: wellNum });
    this._emit();
  }

  calibrateAll() {
    let started = 0;
    for (const w of Object.values(this.wells)) {
      if (w.assigned && !w.calibrating) {
        w.calibrating = true;
        w._pushLog('info', 'Calibration requested — sent "c" to device, waiting for CAL_START…');
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