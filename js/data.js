/* ============================================================================
 * data.js — MCCB telemetry engine + hardware seam (REAL HARDWARE MODE)
 * ----------------------------------------------------------------------------
 * Connects to the Python FastAPI backend via WebSocket.
 * The UI components interact with MCCB.engine exactly as before, but all 
 * telemetry and commands are now routed over the network to the Pi.
 * ========================================================================== */
(function () {
  'use strict';

  // ---- Safety limits (mirror mccb_template_test.py) ----------------------
  const MAX_EFIELD = 1.5;   // V/cm
  const MAX_MAG    = 15.0;  // Gauss
  const HISTORY    = 240;   // samples kept per metric
  const TICK_MS    = 100;   // (Unused in real hardware mode, kept for compat)

  // Derived/cosmetic hardware constants (used if firmware sends voltage instead of efield)
  const ELECTRODE_GAP_CM = 0.5;   
  const LOAD_KOHM        = 4.7;   
  const COIL_A_PER_G     = 42.0;  

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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

    // --- Universal ingest: feed this real parsed JSON from the backend. ----
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

  // =========================================================================
  // ---- WebSocket Connection Manager (NEW) -------------------------------
  // =========================================================================
  let ws = null;
  let wsConnected = false;
  let cachedPorts = [];
  let cachedCameras = [];

  function connectToBackend() {
    // Connect to the Python FastAPI backend running on the same host
    const wsUrl = `ws://${window.location.hostname}:8000/ws/hardware`;
    console.log(`[MCCB] Connecting to backend at ${wsUrl}...`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[MCCB] Connected to hardware backend');
      wsConnected = true;
      // Request initial device lists immediately upon connection
      sendToBackend({ cmd: 'enumerate_ports' });
      sendToBackend({ cmd: 'enumerate_cameras' });
    };

    ws.onmessage = (event) => {
      // 1. Handle binary camera frames (Raw Mono8)
      if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const well = view.getUint8(0);
        const w = view.getUint16(1);
        const h = view.getUint16(3);
        const pixels = new Uint8ClampedArray(event.data, 5);
        
        // Dispatch to imaging.jsx
        window.dispatchEvent(new CustomEvent('mccb_camera_frame', { 
          detail: { well, width: w, height: h, pixels } 
        }));
        return; // Stop processing, it's not JSON
      }

      // 2. Handle JSON telemetry/events (Your existing code)
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
      setTimeout(connectToBackend, 3000); // Auto-reconnect
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
      // msg format: { type: 'telemetry', well: 1, data: { voltage: ..., gauss: ... } }
      const wellNum = msg.well;
      if (engine.wells[wellNum]) {
        engine.wells[wellNum]._ingest(msg.data);
        engine._emit(); // Trigger UI charts/readouts to update
      }
    } 
    else if (msg.type === 'ports') {
      cachedPorts = msg.data;
      // Notify connection.jsx that new port data is available
      window.dispatchEvent(new CustomEvent('mccb_ports_ready', { detail: msg.data }));
    }
    else if (msg.type === 'cameras') {
      cachedCameras = msg.data;
      // Notify imaging.jsx that new camera data is available
      window.dispatchEvent(new CustomEvent('mccb_cameras_ready', { detail: msg.data }));
    }
  }

  // =========================================================================
  // ---- Engine (Modified for Real Hardware) ------------------------------
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
    
    // Intercept commands and send them to the Python backend
    _command(obj) {
      this._cmdSubs.forEach((cb) => cb(obj));
      sendToBackend(obj); 
    }

    start() {
      if (this.running) return;
      this.running = true;
      // WebSocket is already open from module-load time; nothing extra needed here.
    }

    stop() {
      this.running = false;
      // Do NOT close the WebSocket here — it's persistent across reconfigures.
      // The socket auto-reconnects if it drops; closing it manually causes a
      // reconnect loop whenever the user hits "Reconfigure Ports".
    }

    // Tell the backend to open/close serial connections
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
        w.setGauss  = clamp(gauss, 0, MAX_MAG);     
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
      for (const w of Object.values(this.wells)) { w.setEfield = 0; w.setGauss = 0; }
      this._command({ cmd: 'stop', well: 'all' });
    }

    get assignedWells() { return Object.values(this.wells).filter((w) => w.assigned).map((w) => w.num); }
    get anyActive() { return Object.values(this.wells).some((w) => w.assigned && (w.setEfield > 0 || w.setGauss > 0)); }
  }

  // ---- Device enumeration (Cached from backend) -------------------------
  function enumeratePorts() {
    if (wsConnected) sendToBackend({ cmd: 'enumerate_ports' }); // Request refresh
    return cachedPorts; // Return immediately (UI will update via event listener)
  }

  function enumerateCameras() {
    if (wsConnected) sendToBackend({ cmd: 'enumerate_cameras' }); // Request refresh
    return cachedCameras;
  }

  const engine = new Engine();

  // Connect to the backend immediately when the page loads so that
  // port/camera lists arrive before the user interacts with the UI.
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