import os
import json
import time
import asyncio
import serial
import serial.tools.list_ports
import struct
import threading
import subprocess
import hashlib
import shutil
import queue
import gi

gi.require_version('Aravis', '0.8')
from gi.repository import Aravis

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI()

# =========================================================================
# 1. SERVE REACT FRONTEND (FIXED: Properly serves styles.css and assets)
# =========================================================================
# Mount the 'assets' folder for Vite's JS/CSS bundles
app.mount("/assets", StaticFiles(directory="js/dist/assets"), name="assets")

# Serve root-level static files (like styles.css, favicon.ico)
@app.get("/{file_name:path}")
async def serve_static_files(file_name: str):
    file_path = os.path.join("js/dist", file_name)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    
    # If the file doesn't exist, it's likely a frontend route (e.g., /control), 
    # so serve index.html to let React Router handle it.
    return FileResponse("js/dist/index.html")

# =========================================================================
# 2. GLOBAL STATE MANAGEMENT
# =========================================================================
active_ws = None
loop = None
serial_objects = {}
serial_threads = {}
serial_write_queues = {}   # well_num -> queue.Queue of (bytes, label); drained by the reader thread
camera_threads = {}
stop_events = {}
camera_settings = {}

def send_ws_sync(msg_type, data):
    if active_ws and loop:
        try:
            asyncio.run_coroutine_threadsafe(
                active_ws.send_json({"type": msg_type, "data": data}), loop
            )
        except Exception as e:
            print(f"WS JSON send error: {e}")

def send_ws_binary_sync(binary_data):
    if active_ws and loop:
        try:
            asyncio.run_coroutine_threadsafe(active_ws.send_bytes(binary_data), loop)
        except Exception as e:
            print(f"WS Binary send error: {e}")

# =========================================================================
# 2b. FIRMWARE FLASHING (auto-flash ESP32 on connect via arduino-cli)
# =========================================================================
# Requirements on the Pi:
#   - arduino-cli installed and on PATH (or set MCCB_ARDUINO_CLI)
#   - ESP32 core installed:  arduino-cli core install esp32:esp32
#   - The sketch must live in a folder named after the .ino, e.g.
#       <repo>/esp32_helmholtz/esp32_helmholtz.ino
#
# Config (all overridable via environment variables):
FLASH_ENABLED = os.environ.get("MCCB_FLASH", "1") == "1"
ARDUINO_CLI   = os.environ.get("MCCB_ARDUINO_CLI", "arduino-cli")
FQBN          = os.environ.get("MCCB_FQBN", "esp32:esp32:esp32doit-devkit-v1")
SKETCH_PATH   = os.environ.get(
    "MCCB_SKETCH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "esp32_helmholtz")
)
BUILD_DIR     = os.environ.get("MCCB_BUILD_DIR", "/tmp/mccb_build")
FLASH_SETTLE_S = float(os.environ.get("MCCB_FLASH_SETTLE", "1.5"))  # boot delay after upload

_compile_lock = threading.Lock()
_last_compile_hash = None


def _sketch_dir_and_ino():
    """Return (sketch_dir, ino_path). Accepts either a sketch folder or a .ino path."""
    if SKETCH_PATH.endswith(".ino"):
        return os.path.dirname(SKETCH_PATH), SKETCH_PATH
    name = os.path.basename(SKETCH_PATH.rstrip("/"))
    return SKETCH_PATH, os.path.join(SKETCH_PATH, name + ".ino")


def _hash_sketch():
    """Hash the .ino so we only recompile when the source actually changes."""
    _, ino = _sketch_dir_and_ino()
    try:
        with open(ino, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def compile_firmware():
    """Compile the sketch once; cached by source hash. Returns (ok, message)."""
    global _last_compile_hash
    if shutil.which(ARDUINO_CLI) is None and not os.path.isabs(ARDUINO_CLI):
        return False, f"'{ARDUINO_CLI}' not found on PATH"
    with _compile_lock:
        h = _hash_sketch()
        if h is None:
            _, ino = _sketch_dir_and_ino()
            return False, f"sketch not found at {ino}"
        # Skip recompile if source is unchanged and we still have a build.
        if h == _last_compile_hash and os.path.isdir(BUILD_DIR) and os.listdir(BUILD_DIR):
            return True, "cached"
        sketch_dir, _ = _sketch_dir_and_ino()
        os.makedirs(BUILD_DIR, exist_ok=True)
        try:
            proc = subprocess.run(
                [ARDUINO_CLI, "compile", "--fqbn", FQBN, "--output-dir", BUILD_DIR, sketch_dir],
                capture_output=True, text=True, timeout=600
            )
        except FileNotFoundError:
            return False, f"'{ARDUINO_CLI}' not found"
        except subprocess.TimeoutExpired:
            return False, "compile timed out"
        if proc.returncode != 0:
            return False, (proc.stderr or proc.stdout or "compile failed").strip()[-600:]
        _last_compile_hash = h
        return True, "compiled"


def upload_firmware(port):
    """Upload the cached build to a single port. Returns (ok, message)."""
    sketch_dir, _ = _sketch_dir_and_ino()
    try:
        proc = subprocess.run(
            [ARDUINO_CLI, "upload", "--fqbn", FQBN, "--input-dir", BUILD_DIR, "-p", port, sketch_dir],
            capture_output=True, text=True, timeout=240
        )
    except FileNotFoundError:
        return False, f"'{ARDUINO_CLI}' not found"
    except subprocess.TimeoutExpired:
        return False, "upload timed out"
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "upload failed").strip()[-600:]
    return True, "uploaded"


def send_log(well_num, line, level="info"):
    """Push a human-readable line to the UI's serial log AND the server console."""
    print(f"[well {well_num}] {line}")
    send_ws_sync("log", {"well": well_num, "level": level, "line": line})


def write_to_well(well_num, payload: bytes, label: str):
    """Queue a serial write to be performed by the well's reader thread.

    All writes go through the reader thread so the serial port is only ever
    touched by ONE thread — writing from the websocket thread while the reader
    thread is mid-read causes dropped/garbled commands on some USB-serial
    drivers, which is why a command could "send" yet never reach the firmware.
    """
    q = serial_write_queues.get(well_num)
    if q is None:
        send_log(well_num, f"Cannot send {label}: well {well_num} is not connected.", "error")
        return False
    q.put((payload, label))
    return True


def flash_port(port, log=None):
    """Compile (cached) then upload to `port`. Returns (ok, message).
    `log` is an optional callable(level, line) for step-by-step progress."""
    def emit(level, line):
        if log:
            log(level, line)
    emit("info", "Compiling firmware…")
    ok, msg = compile_firmware()
    if not ok:
        emit("error", f"Compile failed: {msg}")
        return False, f"compile: {msg}"
    emit("ok", "Build is current (cached)" if msg == "cached" else "Compile succeeded")
    emit("info", f"Uploading to {port} …")
    ok, msg = upload_firmware(port)
    if not ok:
        emit("error", f"Upload failed: {msg}")
        return False, f"upload: {msg}"
    emit("ok", f"Upload complete on {port}")
    return True, "flashed"


def well_worker(well_num, port, stop_event, old_thread, do_flash):
    """Provision a well: wait for the old reader to release the port, optionally
    flash firmware, then run the serial read loop. Runs in its own daemon thread
    so the websocket event loop is never blocked by the slow flash."""
    # Make sure the previous reader on this well has fully closed the port,
    # otherwise the upload (which needs exclusive access) will fail.
    if old_thread is not None and old_thread.is_alive():
        send_log(well_num, "Waiting for previous connection to release the port…")
        old_thread.join(timeout=3.0)

    if do_flash:
        send_ws_sync("flash_status", {"well": well_num, "status": "running"})
        send_log(well_num, f"=== Flashing Well {well_num} on {port} ===")
        ok, msg = flash_port(port, log=lambda lvl, ln: send_log(well_num, ln, lvl))
        if ok:
            send_ws_sync("flash_status", {"well": well_num, "status": "done", "msg": "uploaded"})
            send_log(well_num, f"Firmware flashed — waiting {FLASH_SETTLE_S:.1f}s for reboot…", "ok")
            time.sleep(FLASH_SETTLE_S)  # let the board reboot before we read
        else:
            # Don't abort — fall through and try to read an already-flashed board.
            send_ws_sync("flash_status", {"well": well_num, "status": "error", "msg": msg})
            send_log(well_num, f"Flash failed — attempting to read existing firmware anyway. ({msg})", "error")
    else:
        send_log(well_num, "Flashing skipped — connecting to existing firmware on the board")

    serial_reader_loop(well_num, port, stop_event)

# =========================================================================
# 3. BACKGROUND HARDWARE THREADS
# =========================================================================
def serial_reader_loop(well_num, port, stop_event):
    ser = None
    try:
        # Match the ESP32's 500000 baud rate (firmware is set to 500000)
        ser = serial.Serial(port, 500000, timeout=0.1)
        serial_objects[well_num] = ser
        wq = queue.Queue()
        serial_write_queues[well_num] = wq
        send_log(well_num, f"Serial port {port} opened @ 500000 baud — awaiting data…", "ok")
        buf = ""
        last_data = time.time()
        warned_silent = False
        total_lines = 0

        while not stop_event.is_set():
            # --- Outbound: drain any queued commands (single-threaded writes) ---
            try:
                while True:
                    payload, label = wq.get_nowait()
                    ser.write(payload)
                    ser.flush()
                    send_log(well_num, f"→ sent {label} — {len(payload)} bytes to {port}", "info")
            except queue.Empty:
                pass

            data = ser.read(512).decode(errors='ignore')
            if data:
                if warned_silent:
                    send_log(well_num, "Serial data resumed.", "ok")
                last_data = time.time()
                warned_silent = False
                buf += data
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue

                    # ---- Calibration protocol ----------------------------
                    if line.startswith("CAL_LUT "):
                        lut_str = line[8:]
                        try:
                            lut = [float(x) for x in lut_str.split(',')]
                            # A complete LUT is always exactly 1001 points
                            # (0.0 % to 100.0 % in 0.1 % steps). Fewer points
                            # means the ESP32 TX buffer overflowed mid-line and
                            # silently dropped the tail — fix: increase
                            # Serial.setTxBufferSize() in the firmware setup().
                            if len(lut) != 1001:
                                msg = (f"CAL_LUT truncated — received {len(lut)}/1001 points. "
                                       f"The ESP32 TX buffer overflowed; "
                                       f"Serial.setTxBufferSize() must be >= 8192.")
                                send_log(well_num, msg, "error")
                                send_ws_sync("cal_status", {
                                    "well": well_num,
                                    "status": "error",
                                    "msg": f"Truncated LUT ({len(lut)}/1001 points)"
                                })
                            else:
                                peak = max(lut)
                                send_ws_sync("calibration", {"well": well_num, "lut": lut})
                                send_log(well_num,
                                         f"CAL_LUT received — {len(lut)} points, peak {peak:.2f} G", "ok")
                        except ValueError as exc:
                            send_log(well_num,
                                     f"CAL_LUT parse error ({exc}): {line[:80]}", "error")
                            send_ws_sync("cal_status", {
                                "well": well_num,
                                "status": "error",
                                "msg": "LUT parse error — check firmware serial output"
                            })
                    elif line == "CAL_START":
                        send_ws_sync("cal_status", {"well": well_num, "status": "running"})
                        send_log(well_num, "CAL_START — calibration sweep underway", "info")
                    elif line.startswith("CAL_PT "):
                        try:
                            _, pwm_s, g_s = line.split()
                            send_log(well_num, f"Cal point — PWM {float(pwm_s):.1f}% → {float(g_s):.3f} G", "info")
                        except ValueError:
                            send_ws_sync("log", {"well": well_num, "level": "raw", "line": line})
                    elif line == "CAL_END":
                        send_ws_sync("cal_status", {"well": well_num, "status": "done"})
                        send_log(well_num, "CAL_END — calibration sequence complete", "ok")
                    else:
                        # ---- Telemetry (JSON, or two bare floats) --------
                        parsed = False
                        try:
                            obj = json.loads(line)
                            send_ws_sync("telemetry", {"well": well_num, "data": obj})
                            parsed = True
                        except json.JSONDecodeError:
                            parts = line.split()
                            if len(parts) >= 2:
                                try:
                                    obj = {"gauss1": float(parts[0]), "gauss2": float(parts[1])}
                                    send_ws_sync("telemetry", {"well": well_num, "data": obj})
                                    parsed = True
                                except ValueError:
                                    pass
                        if parsed:
                            total_lines += 1
                            if total_lines == 1:
                                send_log(well_num, "First telemetry frame received — board is streaming.", "ok")
                        else:
                            # Unrecognized line: almost certainly a firmware
                            # debug/boot print. Surface it verbatim so the user
                            # can see exactly what the board is saying.
                            send_ws_sync("log", {"well": well_num, "level": "raw", "line": line})
            else:
                # No bytes this cycle — warn once if the board has gone quiet.
                if not warned_silent and (time.time() - last_data) > 3.0:
                    warned_silent = True
                    send_log(well_num,
                             f"No serial data from {port} after 3s — check that the firmware "
                             f"is running and the baud rate is 500000.", "warn")
    except Exception as e:
        send_log(well_num, f"Serial error on {port}: {e}", "error")
        send_ws_sync("error", {"well": well_num, "msg": str(e)})
    finally:
        if well_num in serial_objects: del serial_objects[well_num]
        serial_write_queues.pop(well_num, None)
        if ser and ser.is_open: ser.close()
        send_log(well_num, f"Serial port {port} closed.", "info")

def camera_reader_loop(well_num, camera_id, stop_event):
    try:
        Aravis.update_device_list()
        camera = Aravis.Camera.new(camera_id)
        camera.set_exposure_time(5000.0)
        camera.set_gain(0.0)
        try: camera.set_frame_rate(10.0)
        except: pass
        
        payload = camera.get_payload()
        stream = camera.create_stream(None, None)
        for _ in range(4): stream.push_buffer(Aravis.Buffer.new_allocate(payload))
        camera.start_acquisition()
        
        while not stop_event.is_set():
            settings = camera_settings.get(well_num)
            if settings:
                try:
                    camera.set_exposure_time(float(settings["exposure"]))
                    camera.set_gain(float(settings["gain"]))
                    try: camera.set_frame_rate(float(settings["fps"]))
                    except: pass
                except Exception as e: print(f"Cam {well_num} settings error: {e}")
                camera_settings[well_num] = None

            buf = stream.try_pop_buffer()
            if buf is None:
                import time; time.sleep(0.01); continue
                
            if buf.get_status() == Aravis.BufferStatus.SUCCESS:
                w = buf.get_image_width()
                h = buf.get_image_height()
                data = buf.get_data()
                header = struct.pack('!BHH', well_num, w, h)
                send_ws_binary_sync(header + bytes(data))
            stream.push_buffer(buf)
    except Exception as e:
        send_ws_sync("error", {"well": well_num, "msg": f"Camera error: {e}"})
    finally:
        try: camera.stop_acquisition()
        except: pass

# =========================================================================
# 4. WEBSOCKET ENDPOINT
# =========================================================================
@app.websocket("/ws/hardware")
async def websocket_endpoint(websocket: WebSocket):
    global active_ws, loop
    await websocket.accept()
    active_ws = websocket
    loop = asyncio.get_running_loop()

    # Push current device lists immediately on connect — the frontend
    # may not yet be ready to send enumerate commands by the time it renders.
    async def push_initial_state():
        try:
            ports = serial.tools.list_ports.comports()
            port_list = []
            for p in ports:
                desc = (p.description or "").lower()
                mfr  = (p.manufacturer or "").lower()
                dev  = (p.device or "").lower()
                haystack = desc + mfr + dev
                esp_keywords = ['cp210', 'ch340', 'ch341', 'ftdi', 'esp32', 'uart',
                                'ttyusb', 'ttyacm', 'silicon labs', 'wch']
                is_esp = any(k in haystack for k in esp_keywords)
                port_list.append({
                    "label": f"{'ESP32' if is_esp else 'Unknown'} — {p.device} ({p.description})",
                    "port": p.device,
                    "kind": "ESP32" if is_esp else "Unknown"
                })
            await websocket.send_json({"type": "ports", "data": port_list})
        except Exception as e:
            print(f"Initial port push error: {e}")
        try:
            Aravis.update_device_list()
            cams = [{"id": Aravis.get_device_id(i), "present": True} for i in range(Aravis.get_n_devices())]
            while len(cams) < 4:
                cams.append({"id": None, "present": False})
            await websocket.send_json({"type": "cameras", "data": cams})
        except Exception as e:
            print(f"Initial camera push error: {e}")

    await push_initial_state()
    
    try:
        while True:
            msg = await websocket.receive()
            # Low-level .receive() returns a disconnect *message* instead of
            # raising WebSocketDisconnect. Detect it and break, otherwise the
            # next .receive() raises "Cannot call receive once a disconnect
            # message has been received."
            if msg["type"] == "websocket.disconnect":
                break
            if "text" in msg:
                data = json.loads(msg["text"])
                cmd = data.get("cmd")
                
                if cmd == "enumerate_ports":
                    ports = serial.tools.list_ports.comports()
                    port_list = []
                    for p in ports:
                        # manufacturer can be None on Linux — guard against it
                        desc = (p.description or "").lower()
                        mfr  = (p.manufacturer or "").lower()
                        dev  = (p.device or "").lower()
                        haystack = desc + mfr + dev
                        esp_keywords = ['cp210', 'ch340', 'ch341', 'ftdi', 'esp32', 'uart',
                                        'ttyusb', 'ttyacm', 'silicon labs', 'wch']
                        is_esp = any(k in haystack for k in esp_keywords)
                        kind_label = "ESP32" if is_esp else "Unknown"
                        port_list.append({
                            "label": f"{kind_label} — {p.device} ({p.description})",
                            "port": p.device,
                            "kind": kind_label
                        })
                    await websocket.send_json({"type": "ports", "data": port_list})
                    
                elif cmd == "enumerate_cameras":
                    Aravis.update_device_list()
                    cams = [{"id": Aravis.get_device_id(i), "present": True} for i in range(Aravis.get_n_devices())]
                    while len(cams) < 4: cams.append({"id": None, "present": False})
                    await websocket.send_json({"type": "cameras", "data": cams})
                    
                elif cmd == "connect_well":
                    well, port = data["well"], data["port"]
                    # Per-connect flash flag from the frontend; gated by the
                    # server-side FLASH_ENABLED master switch.
                    do_flash = bool(data.get("flash", True)) and FLASH_ENABLED
                    if well in stop_events: stop_events[well].set()
                    old_thread = serial_threads.get(well)   # hand off so the worker can join it
                    stop_evt = threading.Event(); stop_events[well] = stop_evt
                    t = threading.Thread(
                        target=well_worker,
                        args=(well, port, stop_evt, old_thread, do_flash),
                        daemon=True
                    )
                    t.start(); serial_threads[well] = t
                    
                elif cmd == "disconnect_well":
                    well = data["well"]
                    if well in stop_events: stop_events[well].set()
                    
                elif cmd == "set":
                    well = data.get("well")
                    channel = data.get("channel")   # 'h' (Helmholtz) or 'e' (Electrode)
                    pwm = data.get("pwm", 0.0)       # 0.0 to 100.0
                    mode = data.get("mode", 1)       # Default to STEP (1)
                    freq = data.get("freq", 10.0)    # Default to 10 Hz
                    if channel in ('h', 'e'):
                        # Format for ESP32: <target> <mode> <amp%> <freq>
                        cmd_str = f"{channel} {mode} {pwm:.2f} {freq:.2f}\n"
                        write_to_well(well, cmd_str.encode(),
                                      f"set[{channel}] mode={mode} amp={pwm:.2f}% freq={freq:.2f}Hz")

                elif cmd == "stop":
                    well = data.get("well")
                    # well may be a specific number, or 'all' (global E-STOP)
                    targets = list(serial_write_queues.keys()) if well == "all" else [well]
                    for wn in targets:
                        write_to_well(wn, b"e 0 0.00 10.00\n", "stop electrode")
                        write_to_well(wn, b"h 0 0.00 10.00\n", "stop helmholtz")

                elif cmd == "zero":
                    # Trigger the ESP32's auto-zero routine
                    well = data.get("well")
                    write_to_well(well, b"z\n", "auto-zero (z)")
                        
                elif cmd == "start_camera":
                    well, cam_id = data["well"], data["id"]
                    if f"cam_{well}" in stop_events: stop_events[f"cam_{well}"].set()
                    stop_evt = threading.Event(); stop_events[f"cam_{well}"] = stop_evt
                    t = threading.Thread(target=camera_reader_loop, args=(well, cam_id, stop_evt), daemon=True)
                    t.start(); camera_threads[well] = t
                    
                elif cmd == "stop_camera":
                    well = data["well"]
                    if f"cam_{well}" in stop_events: stop_events[f"cam_{well}"].set()
                    
                elif cmd == "camera_settings":
                    camera_settings[data["well"]] = {
                        "exposure": data.get("exposure", 5000),
                        "gain": data.get("gain", 0),
                        "fps": data.get("fps", 10)
                    }
                
                elif cmd == "calibrate":
                    well = data.get("well")
                    write_to_well(well, b"c\n", "calibrate (c)")

    except WebSocketDisconnect:
        print("UI disconnected")
    finally:
        # Only tear down if THIS handler still owns the active socket. The
        # frontend auto-reconnects every few seconds; without this guard a stale
        # handler's cleanup would stop the hardware threads and null out
        # active_ws that a newer connection already owns.
        if active_ws is websocket:
            for evt in stop_events.values():
                evt.set()
            active_ws = None

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)