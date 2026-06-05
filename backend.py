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

# 1. Serve the compiled React app from the js/dist folder
app.mount("/static", StaticFiles(directory="js/dist"), name="static")

@app.get("/")
@app.get("/{full_path:path}")
async def serve_react(full_path: str = ""):
    return FileResponse("js/dist/index.html")

# =========================================================================
# Global State Management
# =========================================================================
active_ws = None
loop = None
serial_objects = {}      # well_num -> serial.Serial object
serial_threads = {}      # well_num -> threading.Thread
camera_threads = {}      # well_num -> threading.Thread
stop_events = {}         # key -> threading.Event
camera_settings = {}     # well_num -> dict of settings

def send_ws_sync(msg_type, data):
    """Thread-safe helper to send JSON from background threads to the UI."""
    if active_ws and loop:
        try:
            asyncio.run_coroutine_threadsafe(
                active_ws.send_json({"type": msg_type, "data": data}), loop
            )
        except Exception as e:
            print(f"WS JSON send error: {e}")

def send_ws_binary_sync(binary_data):
    """Thread-safe helper to send raw binary camera frames to the UI."""
    if active_ws and loop:
        try:
            asyncio.run_coroutine_threadsafe(active_ws.send_bytes(binary_data), loop)
        except Exception as e:
            print(f"WS Binary send error: {e}")

# =========================================================================
# Background Hardware Threads
# =========================================================================
def serial_reader_loop(well_num, port, stop_event):
    ser = None
    try:
        ser = serial.Serial(port, 115200, timeout=0.1)
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
                        try:
                            obj = json.loads(line)
                            send_ws_sync("telemetry", {"well": well_num, "data": obj})
                        except json.JSONDecodeError:
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
        
        # Default settings
        camera.set_exposure_time(5000.0)
        camera.set_gain(0.0)
        try: camera.set_frame_rate(10.0)
        except: pass
        
        payload = camera.get_payload()
        stream = camera.create_stream(None, None)
        for _ in range(4): stream.push_buffer(Aravis.Buffer.new_allocate(payload))
        camera.start_acquisition()
        
        while not stop_event.is_set():
            # Apply settings if UI changed them
            settings = camera_settings.get(well_num)
            if settings:
                try:
                    camera.set_exposure_time(float(settings["exposure"]))
                    camera.set_gain(float(settings["gain"]))
                    try: camera.set_frame_rate(float(settings["fps"]))
                    except: pass
                except Exception as e: print(f"Cam {well_num} settings error: {e}")
                camera_settings[well_num] = None # Clear after applying

            buf = stream.try_pop_buffer()
            if buf is None:
                import time; time.sleep(0.01); continue
                
            if buf.get_status() == Aravis.BufferStatus.SUCCESS:
                w = buf.get_image_width()
                h = buf.get_image_height()
                data = buf.get_data()
                
                # Create binary packet: [1 byte well_num][2 bytes w][2 bytes h][raw pixels]
                header = struct.pack('!BHH', well_num, w, h)
                send_ws_binary_sync(header + bytes(data))
                
            stream.push_buffer(buf)
    except Exception as e:
        send_ws_sync("error", {"well": well_num, "msg": f"Camera error: {e}"})
    finally:
        try: camera.stop_acquisition()
        except: pass

# =========================================================================
# WebSocket Endpoint
# =========================================================================
@app.websocket("/ws/hardware")
async def websocket_endpoint(websocket: WebSocket):
    global active_ws, loop
    await websocket.accept()
    active_ws = websocket
    loop = asyncio.get_running_loop()
    
    try:
        while True:
            msg = await websocket.receive()
            
            if "text" in msg:
                data = json.loads(msg["text"])
                cmd = data.get("cmd")
                
                if cmd == "enumerate_ports":
                    ports = serial.tools.list_ports.comports()
                    port_list = [{"label": f"{'ESP32' if any(k in (p.description+p.manufacturer).lower() for k in ['cp210','ch340','ftdi','esp32','uart']) else 'Unknown'} — {p.device} ({p.description})", "port": p.device, "kind": "ESP32"} for p in ports]
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
                    
                elif cmd in ("set", "stop"):
                    well = data.get("well")
                    if well in serial_objects and serial_objects[well].is_open:
                        try: serial_objects[well].write((json.dumps(data) + '\n').encode())
                        except Exception as e: send_ws_sync("error", {"well": well, "msg": str(e)})
                        
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

    except WebSocketDisconnect:
        print("UI disconnected")
    finally:
        for evt in stop_events.values(): evt.set()
        active_ws = None