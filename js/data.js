/* ============================================================================
data.js — MCCB telemetry engine + hardware seam (REAL HARDWARE MODE)
KEY FIXES:
Ring buffer replaced with a true circular buffer (Float64Array + head
pointer). push() is now O(1) — no Array.shift(), no copying. At 2 kHz
the old Array.shift() on 10 000-element arrays cost ~20 M element moves/s,
stalling the JS thread and causing the intermittent "crazy values" bursts.
RMS is a proper 2-second sliding window. At 2 kHz that is 4 000 samples.
A running sum-of-squares is maintained with a correct eviction pattern:
read the value that WILL be overwritten BEFORE writing the new one, then
subtract it. This avoids the original double-eviction bug (checking length
before push() while push() also evicts internally).
measGauss1/2 (the "Inst." readout) is always the newest value in the ring,
read once after each ingest. Previously it was written mid-burst during
50-message floods from a single ser.read(512) call, making it
non-deterministic which sample was displayed.
_emit is throttled to at most once per animation frame via
requestAnimationFrame. Serial bursts that arrive together (50+ messages
from one ser.read()) no longer trigger 50 back-to-back React re-renders.
========================================================================== */
(function () {
'use strict';
// ---- Safety limits ------------------------------------------------------
const MAX_EFIELD = 1.5;    // V/cm
const MAX_MAG    = 50.0;   // Gauss
// At 2 kHz, 4 000 samples = 2 seconds exactly.
const RMS_WINDOW = 4000;   // samples in the RMS sliding window
// History ring keeps enough samples to fill the chart. 10 000 @ 2 kHz = 5 s.
const HISTORY    = 10000;
// Number of samples shown in the chart sliding window.
// 1 000 samples @ 2 kHz = 0.5 s — short enough to see high-frequency waves.
// The ring retains the full HISTORY so the window can be widened without loss.
const CHART_WINDOW = 1000;
const ELECTRODE_GAP_CM = 0.5;
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function buildReverseLutFromArr(lutArr) {
const reverse = [];
for (let i = 0; i < lutArr.length; i++) {
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
// =========================================================================
// ---- O(1) Circular buffer -----------------------------------------------
// Uses a fixed Float64Array so push() never allocates or shifts memory.
// head points to the slot that will be written NEXT (oldest live value).
// count tracks how many valid samples are in the buffer (saturates at n).
// =========================================================================
class Ring {
constructor(n) {
this.n   = n;
this.buf = new Float64Array(n); // pre-allocated, always full size
this.head  = 0;   // next write position
this.count = 0;   // number of valid entries (< n until first full wrap)
}
push(v) {
this.buf[this.head] = v;
this.head = (this.head + 1) % this.n;
if (this.count < this.n) this.count++;
}
// The value that will be evicted on the NEXT push — used by the RMS
// running-sum to subtract before it gets overwritten.
get nextEvict() {
// If the buffer isn't full yet there is nothing to evict.
if (this.count < this.n) return 0;
return this.buf[this.head]; // head points at oldest when full
}
// Newest value written.
get last() {
if (this.count === 0) return 0;
const idx = (this.head - 1 + this.n) % this.n;
return this.buf[idx];
}
// Returns a plain number[] in chronological order for the chart.
// Allocates a new array — only called by the chart's rAF loop, not by
// the hot ingest path.
get values() {
return this.tailN(this.count);
}
// Returns the last `n` samples in chronological order (newest at end).
// If fewer than n samples exist, returns all of them.
// Used by the chart to show a fixed-duration sliding window without
// having to change the ring capacity.
tailN(n) {
if (this.count === 0) return [];
const take = Math.min(n, this.count);
const out  = new Array(take);
// Newest sample is at (head - 1). Walk backwards `take` steps to find
// the oldest sample we want, then read forward.
const oldestIdx = (this.head - take + this.n * 2) % this.n;
for (let i = 0; i < take; i++) {
out[i] = this.buf[(oldestIdx + i) % this.n];
}
return out;
}
clear() {
this.head  = 0;
this.count = 0;
// No need to zero the Float64Array — count guards all reads.
}
}
// =========================================================================
// ---- Sliding-window RMS tracker -----------------------------------------
// Maintains sum-of-squares over the last `window` samples in O(1) per push.
// Reads the value about to be evicted from the ring BEFORE push() overwrites
// it, so the subtraction is always exact.
// =========================================================================
class RmsTracker {
constructor(window) {
this.window = window;
this.ring   = new Ring(window);
this.sumSq  = 0;
}
push(v) {
// If the window is full, evict the oldest value from the sum first.
if (this.ring.count >= this.ring.n) {
const evicted = this.ring.nextEvict;
this.sumSq -= evicted * evicted;
// Guard against floating-point underflow to negative.
if (this.sumSq < 0) this.sumSq = 0;
}
this.ring.push(v);
this.sumSq += v * v;
}
get value() {
if (this.ring.count === 0) return 0;
return Math.sqrt(this.sumSq / this.ring.count);
}
clear() {
this.ring.clear();
this.sumSq = 0;
}
}
// ---- Per-well device ---------------------------------------------------
class WellDevice {
constructor(num) {
this.num    = num;
this.assigned = false;
this.port   = null;
this.label  = null;
this.setEfield  = 0;
this.setGauss   = 0;
this.measEfield = 0;
this.measGauss1 = 0;
this.measGauss2 = 0;

this.voltage     = 0;
this.current     = 0;
this.coilCurrent = 0;

this.calibrated  = false;
this.calibrating = false;
this.flashing    = false;
this.gaussLut    = null;
this.reverseGaussLut = null;

// Chart history rings (O(1) push, values() called only by rAF).
this.history = {
  efield:  new Ring(HISTORY),
  gauss1:  new Ring(HISTORY),
  gauss2:  new Ring(HISTORY),
  voltage: new Ring(HISTORY),
  current: new Ring(HISTORY),
};

// Separate 2-second RMS trackers, independent of the chart rings.
this._rms1 = new RmsTracker(RMS_WINDOW);
this._rms2 = new RmsTracker(RMS_WINDOW);

this.log = [];
}
// ---- Computed status ------------------------------------------------
statusOf(meas, set, max) {
if (set <= 0 && meas < max * 0.02) return 'OFF';
const err = Math.abs(meas - set);
if (err > Math.max(0.04 * max, set * 0.08)) return 'RAMPING';
if (meas > max) return 'OVER';
return 'LOCKED';
}
get electricStatus()  { return this.statusOf(this.measEfield, this.setEfield, MAX_EFIELD); }
get magneticStatus()  { return this.statusOf(Math.max(this.measGauss1, this.measGauss2), this.setGauss, MAX_MAG); }
// ---- RMS accessors (used by the UI readout) -------------------------
// These read the RmsTracker, which is a 2-second window regardless of
// how many samples the chart ring holds.
get rms1() { return this._rms1.value; }
get rms2() { return this._rms2.value; }
// ---- Ingest a telemetry object from the backend ---------------------
// Only called from the 'telemetry' WebSocket message path.
// NEVER called from the 'log' path — that causes double-counting and
// makes sumSq grow without bound (RMS hits millions within seconds).
// measGauss1/2 are set from ring.last after push so they reflect the
// newest sample even during a burst of 50+ rapid updates.
_ingest(obj) {
  if (!obj || typeof obj !== 'object') return; // reject strings/nulls
  
  if ('efield' in obj) {
      this.history.efield.push(obj.efield);
      this.measEfield = this.history.efield.last;
  } else if ('electrode_v' in obj) {
      // Raw CS-pin voltage from the Arduino's third column.
      // Stored as-is now; divide by ELECTRODE_GAP_CM once you switch to V/cm.
      this.history.efield.push(obj.electrode_v);
      this.measEfield = this.history.efield.last;
  }

  // 2. Handle Magnetic Sensors
  if ('gauss1' in obj) {
    const g1 = obj.gauss1;
    if (!isNaN(g1) && isFinite(g1)) {   // guard: reject negative/NaN at ingest
      this.history.gauss1.push(g1);
      this._rms1.push(g1);
      this.measGauss1 = this.history.gauss1.last;
    }
  }
  if ('gauss2' in obj) {
    const g2 = obj.gauss2;
    if (!isNaN(g2) && isFinite(g2)) {   // guard: reject negative/NaN at ingest
      this.history.gauss2.push(g2);
      this._rms2.push(g2);
      this.measGauss2 = this.history.gauss2.last;
    }
  }

  // 3. Handle System Diagnostics
  if ('voltage' in obj) { this.voltage = obj.voltage; this.history.voltage.push(obj.voltage); }
  if ('current' in obj) { this.current = obj.current; this.history.current.push(obj.current); }
  if ('coil'    in obj) { this.coilCurrent = obj.coil; }
}
_pushLog(level, line) {
const entry = level === 'raw' ? line : `» [${level.toUpperCase()}] ${line}`;
this.log.push(entry);
if (this.log.length > 600) this.log.shift();
}
reset() {
this.setEfield = 0; this.setGauss = 0;
this.measEfield = 0; this.measGauss1 = 0; this.measGauss2 = 0;
this.voltage = 0; this.current = 0; this.coilCurrent = 0;
Object.values(this.history).forEach(r => r.clear());
this._rms1.clear();
this._rms2.clear();
}
}
// =========================================================================
// ---- WebSocket Connection Manager ---------------------------------------
// =========================================================================
let ws          = null;
let wsConnected = false;
let cachedPorts   = [];
let cachedCameras = [];
function connectToBackend() {
const wsUrl = `ws://${window.location.hostname}:8000/ws/hardware`;
ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer'; 
ws.onopen = () => {
wsConnected = true;
sendToBackend({ cmd: 'enumerate_ports' });
sendToBackend({ cmd: 'enumerate_cameras' });
};
ws.onmessage = (event) => {
if (event.data instanceof ArrayBuffer) {
const view   = new DataView(event.data);
const well   = view.getUint8(0);
const w      = view.getUint16(1);
const h      = view.getUint16(3);
const pixels = new Uint8ClampedArray(event.data, 5);
console.log(`[MCCB Data] 📦 Binary frame received: Well ${well}, ${w}x${h}, ${pixels.length} bytes`);
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
engine._scheduleEmit();   // throttled — one rAF per burst
}
} else if (msg.type === 'log') {
const wellNum = msg.data.well;
const w = engine.wells[wellNum];
if (w) {
// Log messages are display-only. The backend sends a separate
// 'telemetry' message for every reading — ingesting the raw log line
// here too would push each sample into the rings TWICE, doubling 
// sumSq without doubling evictions and causing RMS to blow up to
// millions. Log path must never touch _ingest.
w._pushLog(msg.data.level || 'info', msg.data.line || '');
engine._scheduleEmit();
}
} else if (msg.type === 'ports') {
cachedPorts = msg.data;
window.dispatchEvent(new CustomEvent('mccb_ports_ready', { detail: msg.data }));
} else if (msg.type  === 'cameras') {
console.log('[MCCB Data] 📷 Received camera list from backend:', msg.data);
cachedCameras = msg.data;
window.dispatchEvent(new CustomEvent('mccb_cameras_ready', { detail: msg.data }));
} else if (msg.type === 'calibration') {
const wellNum  = msg.data.well;
if (engine.wells[wellNum]) {
engine.wells[wellNum].gaussLut         = msg.data.lut;
engine.wells[wellNum].calibrated       = true;
engine.wells[wellNum].calibrating      = false;
engine.wells[wellNum].reverseGaussLut  = buildReverseLutFromArr(msg.data.lut);
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
window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'ok',   text:  `Flashing firmware to Well ${wellNum}…`  } }));
} else if (status === 'done') {
window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'ok',   text:  `Well ${wellNum} firmware flashed`  } }));
} else if (status === 'error') {
window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'error', text:  `Well ${wellNum} flash failed: ${msg.data.msg || 'unknown error'}`  } }));
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
this.wells  = {};
for (let i = 1; i <= 4; i++) this.wells[i] = new WellDevice(i);
this._subs          = new Set();
this.running        = false;
this.globalStopped  = false;
this._emitPending   = false;   // rAF throttle flag
}
subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
// Immediate emit — used for non-telemetry events (calibration, flash, etc.)
_emit() { this._subs.forEach(cb => cb(this)); }
// Throttled emit — coalesces rapid telemetry bursts into one notify per
// animation frame (~16 ms). Prevents 50 back-to-back React re-renders
// from a single ser.read(512) burst.
_scheduleEmit() {
if (this._emitPending) return;
this._emitPending = true;
requestAnimationFrame(() => {
this._emitPending = false;
this._emit();
});
}
start() { this.running = true; }
stop()  { this.running = false; }
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
// --- UPDATED: Now accepts and forwards 'mode' and 'freq' ---
setParams(wellNum, { efield, gauss, mode, freq }) {
  const w = this.wells[wellNum];
  if (!w || !w.assigned) return;
  this.globalStopped = false;
  if (efield != null) {
    w.setEfield = clamp(efield, 0, MAX_EFIELD);
    this._command({ 
      cmd: 'set', 
      well: wellNum, 
      channel: 'e', 
      pwm: w.setEfield * (100.0 / MAX_EFIELD),
      mode: mode !== undefined ? mode : 1,
      freq: freq !== undefined ? freq : 10.0
    });
  }
  if (gauss != null) {
    if (!w.calibrated) {
      console.warn('Cannot set Gauss: Well not calibrated!');
      window.dispatchEvent(new CustomEvent('mccb_toast', { detail: { kind: 'error', text: `Well ${wellNum} requires magnetic calibration first.` } }));
      return;
    }
    w.setGauss = clamp(gauss, 0, MAX_MAG);
    const pwm = physicalToPwm(w.setGauss, w.reverseGaussLut);
    this._command({ 
      cmd: 'set', 
      well: wellNum, 
      channel: 'h', 
      pwm,
      mode: mode !== undefined ? mode : 1,
      freq: freq !== undefined ? freq : 10.0
    });
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
get assignedWells()  { return Object.values(this.wells).filter(w => w.assigned).map(w => w.num); }
get anyActive()      { return Object.values(this.wells).some(w => w.assigned && (w.setEfield > 0 || w.setGauss > 0)); }
get anyCalibrating() { return Object.values(this.wells).some(w => w.assigned && w.calibrating); }
}
function enumeratePorts()   { if (wsConnected) sendToBackend({ cmd: 'enumerate_ports' });   return cachedPorts; }
function enumerateCameras() { if (wsConnected) sendToBackend({ cmd: 'enumerate_cameras' }); return cachedCameras; }
const engine = new Engine();
connectToBackend();
window.MCCB = {
MAX_EFIELD, MAX_MAG, HISTORY, RMS_WINDOW, CHART_WINDOW,
engine,
enumeratePorts,
enumerateCameras,
sendToBackend,
clamp,
};
})();