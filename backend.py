import os
import json
import asyncio
import serial
import serial.tools.list_ports
import struct
import threading
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
# 3. BACKGROUND HARDWARE THREADS
# =========================================================================
def serial_reader_loop(well_num, port, stop_event):
    ser = None
    try:
        # FIX 1: Match the ESP32's 500000 baud rate (firmware is set to 500000)
        ser = serial.Serial(port, 500000, timeout=0.1)
        serial_objects[well_num] = ser
        buf = ""
        
        while not stop_event.is_set():
            data = ser.read(512).decode(errors='ignore')
            if data:
                buf += data
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip()
                    if line:
                        # NEW: Handle calibration protocol
                        if line.startswith("CAL_LUT "):
                            lut_str = line[8:]
                            try:
                                lut = [float(x) for x in lut_str.split(',')]
                                send_ws_sync("calibration", {"well": well_num, "lut": lut})
                            except ValueError:
                                pass
                        elif line == "CAL_START":
                            send_ws_sync("cal_status", {"well": well_num, "status": "running"})
                        elif line == "CAL_END":
                            send_ws_sync("cal_status", {"well": well_num, "status": "done"})
                        else:
                            # Existing telemetry parsing
                            try:
                                obj = json.loads(line)
                                send_ws_sync("telemetry", {"well": well_num, "data": obj})
                            except json.JSONDecodeError:
                                parts = line.split()
                                if len(parts) >= 2:
                                    try:
                                        obj = {"gauss1": float(parts[0]), "gauss2": float(parts[1])}
                                        send_ws_sync("telemetry", {"well": well_num, "data": obj})
                                    except ValueError:
                                        pass
    except Exception as e:
        send_ws_sync("error", {"well": well_num, "msg": str(e)})
    finally:
        if well_num in serial_objects: del serial_objects[well_num]
        if ser and ser.is_open: ser.close()

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
                    if well in stop_events: stop_events[well].set()
                    stop_evt = threading.Event(); stop_events[well] = stop_evt
                    t = threading.Thread(target=serial_reader_loop, args=(well, port, stop_evt), daemon=True)
                    t.start(); serial_threads[well] = t
                    
                elif cmd == "disconnect_well":
                    well = data["well"]
                    if well in stop_events: stop_events[well].set()
                    
                elif cmd == "set":
                    well = data.get("well")
                    if well in serial_objects and serial_objects[well].is_open:
                        try:
                            # Extract translated PWM and channel from frontend
                            channel = data.get("channel") # 'h' (Helmholtz) or 'e' (Electrode)
                            pwm = data.get("pwm", 0.0)    # 0.0 to 100.0
                            mode = data.get("mode", 1)    # Default to STEP (1)
                            freq = data.get("freq", 10.0) # Default to 10 Hz
                            
                            if channel in ('h', 'e'):
                                # Format for ESP32: <target> <mode> <amp%> <freq>
                                cmd_str = f"{channel} {mode} {pwm:.2f} {freq:.2f}\n"
                                serial_objects[well].write(cmd_str.encode())
                                
                        except Exception as e:
                            send_ws_sync("error", {"well": well, "msg": str(e)})
                            
                elif cmd == "stop":
                    well = data.get("well")
                    if well in serial_objects and serial_objects[well].is_open:
                        try:
                            # Send OFF command (mode 0, 0% PWM) for both channels
                            serial_objects[well].write(b"e 0 0.00 10.00\n")
                            serial_objects[well].write(b"h 0 0.00 10.00\n")
                        except Exception as e:
                            send_ws_sync("error", {"well": well, "msg": str(e)})

                elif cmd == "zero":
                    # Optional: Trigger the ESP32's auto-zero calibration
                    well = data.get("well")
                    if well in serial_objects and serial_objects[well].is_open:
                        try:
                            serial_objects[well].write(b"z\n")
                        except Exception as e:
                            send_ws_sync("error", {"well": well, "msg": str(e)})
                        
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
                    if well in serial_objects and serial_objects[well].is_open:
                        try:
                            serial_objects[well].write(b"c\n")
                        except Exception as e:
                            send_ws_sync("error", {"well": well, "msg": str(e)})

    except WebSocketDisconnect:
        print("UI disconnected")
    finally:
        for evt in stop_events.values(): evt.set()
        active_ws = None

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)