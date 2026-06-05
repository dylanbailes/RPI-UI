/* ============================================================================
 * data.js — MCCB telemetry engine + hardware seam
 * ----------------------------------------------------------------------------
 * This module is the ONE place that fakes the hardware. To run on the real Pi:
 *
 *   1. Replace DeviceSim.tick() with a parser fed by the pyserial / WebSerial
 *      stream. Each ESP32 line is JSON like {"voltage":..,"current":..,"gauss":..}.
 *      Call engine._ingest(wellNum, obj) with each parsed object.
 *   2. setParams() already emits the exact command object the firmware expects:
 *      {cmd:"set", well:N, voltage:v}  /  {cmd:"set", well:N, gauss:v}
 *      Wire engine.onCommand(cb) to your serial writer.
 *   3. enumeratePorts() / enumerateCameras() return the device lists — swap the
 *      stubs for serial.tools.list_ports / Aravis device enumeration.
 *
 * Everything the UI reads goes through this engine, so the visual layer never
 * needs to know whether data is real or simulated.
 * ========================================================================== */
(function () {
  'use strict';

  // ---- Safety limits (mirror mccb_template_test.py) ----------------------
  const MAX_EFIELD = 1.5;   // V/cm
  const MAX_MAG    = 15.0;  // Gauss
  const HISTORY    = 240;   // samples kept per metric (~24s @ 10Hz)
  const TICK_MS    = 100;   // 10 Hz telemetry

  // Derived/cosmetic hardware constants (only used by the simulator) --------
  const ELECTRODE_GAP_CM = 0.5;   // efield(V/cm) * gap -> drive voltage(V)
  const LOAD_KOHM        = 4.7;   // voltage / R -> current(mA)
  const COIL_A_PER_G     = 42.0;  // gauss -> coil current(mA)

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function noise(scale) { return (Math.random() - 0.5) * 2 * scale; }

  // ---- Ring buffer -------------------------------------------------------
  class Ring {
    constructor(n) { this.n = n; this.buf = []; }
    push(v) { this.buf.push(v); if (this.buf.length > this.n) this.buf.shift(); }
    get last() { return this.buf.length ? this.buf[this.buf.length - 1] : 0; }
    get values() { return this.buf; }
    clear() { this.buf = []; }
  }

  // ---- Per-well device simulation ---------------------------------------
  // On real hardware this class shrinks to just the ring buffers + _ingest.
  class WellDevice {
    constructor(num) {
      this.num = num;
      this.assigned = false;
      this.port = null;
      this.label = null;

      // setpoints (what the user commanded)
      this.setEfield = 0;
      this.setGauss = 0;
      // measured (what the sim/hardware reports)
      this.measEfield = 0;
      this.measGauss = 0;
      this.voltage = 0;
      this.current = 0;
      this.coilCurrent = 0;

      this.history = {
        efield: new Ring(HISTORY),
        gauss: new Ring(HISTORY),
        voltage: new Ring(HISTORY),
        current: new Ring(HISTORY),
      };
      this.log = [];           // raw JSON lines, like the QTextEdit feed
      this._seeded = false;
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

    // --- SIMULATION ONLY. Replace with _ingest() from real serial. ---------
    tick(dt) {
      if (!this.assigned) return null;
      // first-order approach toward setpoint (time constant ~0.6s)
      const k = 1 - Math.exp(-dt / 0.6);
      this.measEfield += (this.setEfield - this.measEfield) * k;
      this.measGauss  += (this.setGauss  - this.measGauss)  * k;

      // sensor noise rides on top
      const eNoise = this.setEfield > 0 ? noise(0.012) : noise(0.004);
      const gNoise = this.setGauss  > 0 ? noise(0.10)  : noise(0.03);
      const eMeas = clamp(this.measEfield + eNoise, 0, MAX_EFIELD * 1.05);
      const gMeas = clamp(this.measGauss + gNoise, 0, MAX_MAG * 1.05);

      const voltage = eMeas * ELECTRODE_GAP_CM;                 // V
      const current = (voltage / LOAD_KOHM) * 1000;            // mA
      const coil    = gMeas * COIL_A_PER_G + noise(2);         // mA

      this._ingest({
        well: this.num,
        voltage: +voltage.toFixed(4),
        current: +current.toFixed(3),
        efield: +eMeas.toFixed(4),
        gauss: +gMeas.toFixed(3),
        coil: +Math.max(0, coil).toFixed(1),
      });
      return true;
    }

    // --- Universal ingest: feed this real parsed JSON on the Pi. -----------
    _ingest(obj) {
      if ('efield' in obj) this.history.efield.push(obj.efield);
      else if ('voltage' in obj) this.history.efield.push(obj.voltage / ELECTRODE_GAP_CM);
      if ('gauss' in obj) this.history.gauss.push(obj.gauss);
      if ('voltage' in obj) { this.voltage = obj.voltage; this.history.voltage.push(obj.voltage); }
      if ('current' in obj) { this.current = obj.current; this.history.current.push(obj.current); }
      if ('coil' in obj) this.coilCurrent = obj.coil;
      if ('efield' in obj) this.measEfield = obj.efield;
      if ('gauss' in obj) this.measGauss = obj.gauss;

      const line = JSON.stringify(obj);
      this.log.push(line);
      if (this.log.length > 400) this.log.shift();
      return line;
    }

    reset() {
      this.setEfield = 0; this.setGauss = 0;
      this.measEfield = 0; this.measGauss = 0;
      this.voltage = 0; this.current = 0; this.coilCurrent = 0;
    }
  }

  // ---- Engine ------------------------------------------------------------
  class Engine {
    constructor() {
      this.wells = {};
      for (let i = 1; i <= 4; i++) this.wells[i] = new WellDevice(i);
      this._subs = new Set();
      this._cmdSubs = new Set();
      this._timer = null;
      this._last = performance.now();
      this.running = false;
      this.globalStopped = false;
    }

    // pub/sub: fired every telemetry tick
    subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
    onCommand(cb) { this._cmdSubs.add(cb); return () => this._cmdSubs.delete(cb); }
    _emit() { this._subs.forEach((cb) => cb(this)); }
    _command(obj) { this._cmdSubs.forEach((cb) => cb(obj)); }

    start() {
      if (this._timer) return;
      this._last = performance.now();
      this._timer = setInterval(() => {
        const now = performance.now();
        const dt = (now - this._last) / 1000;
        this._last = now;
        let any = false;
        for (const w of Object.values(this.wells)) if (w.tick(dt)) any = true;
        this.running = any;
        this._emit();
      }, TICK_MS);
    }
    stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

    assign(map) {
      // map: { 1: {port, label}, ... }  unassigned wells omitted
      for (let i = 1; i <= 4; i++) {
        const w = this.wells[i];
        if (map[i]) { w.assigned = true; w.port = map[i].port; w.label = map[i].label; }
        else { w.assigned = false; w.port = null; w.label = null; w.reset(); }
      }
    }

    setParams(wellNum, { efield, gauss }) {
      const w = this.wells[wellNum];
      if (!w || !w.assigned) return;
      this.globalStopped = false;
      if (efield != null) { w.setEfield = clamp(efield, 0, MAX_EFIELD); this._command({ cmd: 'set', well: wellNum, voltage: w.setEfield }); }
      if (gauss != null)  { w.setGauss  = clamp(gauss, 0, MAX_MAG);     this._command({ cmd: 'set', well: wellNum, gauss: w.setGauss }); }
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

    get assignedWells() {
      return Object.values(this.wells).filter((w) => w.assigned).map((w) => w.num);
    }
    get anyActive() {
      return Object.values(this.wells).some((w) => w.assigned && (w.setEfield > 0 || w.setGauss > 0));
    }
  }

  // ---- Device enumeration stubs -----------------------------------------
  // Swap for serial.tools.list_ports.comports() on the Pi.
  function enumeratePorts() {
    return [
      { label: 'ESP32 — /dev/ttyUSB0 (CP210x UART Bridge)', port: '/dev/ttyUSB0', kind: 'ESP32' },
      { label: 'ESP32 — /dev/ttyUSB1 (CP210x UART Bridge)', port: '/dev/ttyUSB1', kind: 'ESP32' },
      { label: 'ESP32 — /dev/ttyUSB2 (CH340 Serial)',       port: '/dev/ttyUSB2', kind: 'ESP32' },
      { label: 'Unknown — /dev/ttyACM0 (USB Serial Device)', port: '/dev/ttyACM0', kind: 'Unknown' },
    ];
  }
  // Swap for Aravis.get_device_id(i) on the Pi.
  function enumerateCameras() {
    return [
      { id: 'Aravis-GV-0001', present: true },
      { id: 'Aravis-GV-0002', present: true },
      { id: 'Aravis-GV-0003', present: true },
      { id: null,             present: false }, // well 4 has no camera -> empty state
    ];
  }

  window.MCCB = {
    MAX_EFIELD, MAX_MAG, HISTORY,
    engine: new Engine(),
    enumeratePorts, enumerateCameras,
    clamp,
  };
})();
