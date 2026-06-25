import sys
import numpy as np
import cv2
import datetime
import os

try:
    import PySpin
    PYSPIN_AVAILABLE = True
except ImportError:
    PYSPIN_AVAILABLE = False

from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QVBoxLayout, QHBoxLayout, QLabel,
    QGroupBox, QSizePolicy, QFrame, QMessageBox, QGridLayout,
    QComboBox, QFormLayout, QScrollArea
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt5.QtGui import QImage, QPixmap, QFont

# =============================================
# Swiss International Style QSS
# (Mirrors the system UI exactly)
# =============================================
SWISS_QSS = """
QWidget {
    font-family: "Inter", "Helvetica", "Arial", sans-serif;
    font-size: 15px;
    color: #000000;
    background-color: #FFFFFF;
}
QFrame {
    border: 2px solid #000000;
    border-radius: 0px;
    background-color: #FFFFFF;
}
QGroupBox {
    border: 2px solid #000000;
    border-radius: 0px;
    background-color: #FFFFFF;
    margin-top: 14px;
    padding: 20px 12px 12px 12px;
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 12px;
    padding: 4px 16px;
    background-color: #000000;
    color: #FFFFFF;
    font-weight: 700;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
}
QLabel { background-color: transparent; }
QLabel[role="heading"] {
    font-size: 26px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 1px;
}
QLabel[role="section-number"] {
    color: #FF3000;
    font-weight: 900;
    font-size: 13px;
    letter-spacing: 3px;
    text-transform: uppercase;
}
QPushButton {
    background-color: #000000;
    color: #FFFFFF;
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 12px 24px;
    font-weight: 700;
    font-size: 15px;
    text-transform: uppercase;
    letter-spacing: 1px;
    min-height: 48px;
}
QPushButton:hover { background-color: #FF3000; border-color: #FF3000; }
QPushButton:pressed { background-color: #000000; color: #FF3000; }
QPushButton:disabled {
    background-color: #F2F2F2;
    color: #999999;
    border-color: #CCCCCC;
}
QPushButton[variant="secondary"] {
    background-color: #FFFFFF;
    color: #000000;
}
QPushButton[variant="secondary"]:hover {
    background-color: #000000;
    color: #FFFFFF;
}
QPushButton[variant="active"] {
    background-color: #FF3000;
    border-color: #FF3000;
    color: #FFFFFF;
}
QComboBox {
    background-color: #FFFFFF;
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 10px 14px;
    font-weight: 500;
    font-size: 15px;
    min-height: 44px;
    selection-background-color: #FF3000;
    selection-color: #FFFFFF;
}
QComboBox:focus { border-color: #FF3000; }
QScrollBar:vertical {
    border: none;
    background: #F2F2F2;
    width: 18px;
    margin: 0px;
}
QScrollBar::handle:vertical {
    background: #000000;
    min-height: 50px;
    border-radius: 0px;
}
QScrollBar::handle:vertical:hover { background: #FF3000; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }
"""

# =============================================
# Camera acquisition thread
# =============================================
class CameraThread(QThread):
    frame_ready  = pyqtSignal(np.ndarray)
    error        = pyqtSignal(str)
    camera_lost  = pyqtSignal()
    stats_update = pyqtSignal(dict)   # emits {"model":..., "serial":..., "fps":...}

    def __init__(self, cam_index=0):
        super().__init__()
        self.cam_index    = cam_index
        self._running     = False
        self._system      = None
        self._cam         = None
        self._frame_count = 0

        # Configurable before start()
        self.exposure_us = 5000.0
        self.gain_db     = 0.0
        self.fps_target  = 15.0

    def run(self):
        if not PYSPIN_AVAILABLE:
            self.error.emit("PySpin not installed.")
            return

        try:
            self._system = PySpin.System.GetInstance()
            cam_list = self._system.GetCameras()

            if cam_list.GetSize() == 0:
                self.error.emit("No FLIR cameras detected. Check USB connection.")
                cam_list.Clear()
                self._system.ReleaseInstance()
                return

            self._cam = cam_list.GetByIndex(self.cam_index)
            cam_list.Clear()
            self._cam.Init()
            self._configure_camera()

            # Read device info and emit
            try:
                nodemap  = self._cam.GetTLDeviceNodeMap()
                def nstr(name):
                    n = PySpin.CStringPtr(nodemap.GetNode(name))
                    return n.GetValue() if PySpin.IsAvailable(n) else "N/A"
                self.stats_update.emit({
                    "model":  nstr("DeviceModelName"),
                    "serial": nstr("DeviceSerialNumber"),
                    "fps":    0
                })
            except Exception:
                pass

            self._cam.BeginAcquisition()
            self._running = True

            # FPS counter reset every second
            fps_timer_start = self.currentTime_ms()
            fps_count = 0

            while self._running:
                try:
                    image = self._cam.GetNextImage(1000)
                    if image.IsIncomplete():
                        image.Release()
                        continue

                    converted = image.Convert(
                        PySpin.PixelFormat_Mono8,
                        PySpin.HQ_LINEAR
                    )
                    frame = converted.GetNDArray()
                    image.Release()

                    self.frame_ready.emit(frame.copy())
                    fps_count += 1

                    # Emit FPS every second
                    now = self.currentTime_ms()
                    if now - fps_timer_start >= 1000:
                        self.stats_update.emit({"fps": fps_count})
                        fps_count = 0
                        fps_timer_start = now

                except PySpin.SpinnakerException as e:
                    if self._running:
                        self.error.emit(f"Acquisition error: {e}")
                    break

            self._cam.EndAcquisition()

        except PySpin.SpinnakerException as e:
            self.error.emit(f"Camera init error: {e}")
            self.camera_lost.emit()
        finally:
            self._cleanup()

    def currentTime_ms(self):
        import time
        return int(time.time() * 1000)

    def _configure_camera(self):
        nodemap = self._cam.GetNodeMap()

        # Continuous acquisition
        node_acq = PySpin.CEnumerationPtr(nodemap.GetNode("AcquisitionMode"))
        if PySpin.IsAvailable(node_acq) and PySpin.IsWritable(node_acq):
            entry = node_acq.GetEntryByName("Continuous")
            if PySpin.IsAvailable(entry):
                node_acq.SetIntValue(entry.GetValue())

        # Exposure — manual
        node_exp_auto = PySpin.CEnumerationPtr(nodemap.GetNode("ExposureAuto"))
        if PySpin.IsAvailable(node_exp_auto) and PySpin.IsWritable(node_exp_auto):
            off = node_exp_auto.GetEntryByName("Off")
            if PySpin.IsAvailable(off):
                node_exp_auto.SetIntValue(off.GetValue())

        node_exp = PySpin.CFloatPtr(nodemap.GetNode("ExposureTime"))
        if PySpin.IsAvailable(node_exp) and PySpin.IsWritable(node_exp):
            node_exp.SetValue(
                max(node_exp.GetMin(), min(self.exposure_us, node_exp.GetMax())))

        # Gain — manual
        node_gain_auto = PySpin.CEnumerationPtr(nodemap.GetNode("GainAuto"))
        if PySpin.IsAvailable(node_gain_auto) and PySpin.IsWritable(node_gain_auto):
            off = node_gain_auto.GetEntryByName("Off")
            if PySpin.IsAvailable(off):
                node_gain_auto.SetIntValue(off.GetValue())

        node_gain = PySpin.CFloatPtr(nodemap.GetNode("Gain"))
        if PySpin.IsAvailable(node_gain) and PySpin.IsWritable(node_gain):
            node_gain.SetValue(
                max(node_gain.GetMin(), min(self.gain_db, node_gain.GetMax())))

        # Frame rate
        node_fps_en = PySpin.CBooleanPtr(
            nodemap.GetNode("AcquisitionFrameRateEnable"))
        if PySpin.IsAvailable(node_fps_en) and PySpin.IsWritable(node_fps_en):
            node_fps_en.SetValue(True)

        node_fps = PySpin.CFloatPtr(nodemap.GetNode("AcquisitionFrameRate"))
        if PySpin.IsAvailable(node_fps) and PySpin.IsWritable(node_fps):
            node_fps.SetValue(
                max(node_fps.GetMin(), min(self.fps_target, node_fps.GetMax())))

    def update_settings(self, exposure_us=None, gain_db=None, fps=None):
        if exposure_us is not None: self.exposure_us = exposure_us
        if gain_db     is not None: self.gain_db     = gain_db
        if fps         is not None: self.fps_target   = fps

        if not self._cam or not self._running:
            return
        try:
            self._cam.EndAcquisition()
            self._configure_camera()
            self._cam.BeginAcquisition()
        except PySpin.SpinnakerException as e:
            self.error.emit(f"Settings update error: {e}")

    def stop(self):
        self._running = False
        self.wait()

    def _cleanup(self):
        try:
            if self._cam:
                self._cam.DeInit()
                del self._cam
        except Exception:
            pass
        try:
            if self._system:
                self._system.ReleaseInstance()
        except Exception:
            pass


# =============================================
# Single camera tile
# =============================================
class CameraTile(QWidget):
    """
    One well's camera feed. Displays live video, well number badge,
    FPS counter, and per-tile snapshot button. Matches the Swiss
    QGroupBox aesthetic from the system UI.
    """
    def __init__(self, cam_index=0, well_number=1, parent=None):
        super().__init__(parent)
        self.cam_index   = cam_index
        self.well_number = well_number
        self.cam_thread  = None
        self._last_frame = None
        self._streaming  = False

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ---- Tile header bar ----
        header = QFrame()
        header.setStyleSheet(
            "background-color: #000000; border: none;"
        )
        header.setFixedHeight(44)
        hdr_layout = QHBoxLayout(header)
        hdr_layout.setContentsMargins(12, 0, 12, 0)

        well_lbl = QLabel(f"WELL {well_number}  //  CAM {cam_index + 1}")
        well_lbl.setFont(QFont("Inter", 11, QFont.Bold))
        well_lbl.setStyleSheet(
            "color: #FFFFFF; letter-spacing: 2px; background: transparent; border: none;")
        hdr_layout.addWidget(well_lbl)

        hdr_layout.addStretch()

        self.fps_badge = QLabel("● OFFLINE")
        self.fps_badge.setFont(QFont("Monospace", 10))
        self.fps_badge.setStyleSheet(
            "color: #666666; background: transparent; border: none;")
        hdr_layout.addWidget(self.fps_badge)

        layout.addWidget(header)

        # ---- Video display ----
        self.video_label = QLabel()
        self.video_label.setAlignment(Qt.AlignCenter)
        self.video_label.setMinimumSize(200, 150)
        self.video_label.setSizePolicy(
            QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.video_label.setStyleSheet(
            "background-color: #0A0A0A; border: none;")
        self._show_offline_state()
        layout.addWidget(self.video_label, stretch=1)

        # ---- Tile footer bar ----
        footer = QFrame()
        footer.setStyleSheet(
            "background-color: #F2F2F2; border: none; border-top: 2px solid #000000;")
        footer.setFixedHeight(48)
        ftr_layout = QHBoxLayout(footer)
        ftr_layout.setContentsMargins(8, 4, 8, 4)
        ftr_layout.setSpacing(8)

        self.toggle_btn = QPushButton("START")
        self.toggle_btn.setFixedHeight(36)
        self.toggle_btn.setFont(QFont("Inter", 11, QFont.Bold))
        self.toggle_btn.clicked.connect(self._toggle_stream)
        ftr_layout.addWidget(self.toggle_btn)

        snap_btn = QPushButton("SNAP")
        snap_btn.setFixedHeight(36)
        snap_btn.setProperty("variant", "secondary")
        snap_btn.setFont(QFont("Inter", 11, QFont.Bold))
        snap_btn.clicked.connect(self._save_snapshot)
        ftr_layout.addWidget(snap_btn)

        layout.addWidget(footer)

        # Outer border — matches QGroupBox style from system UI
        self.setStyleSheet(
            "CameraTile { border: 2px solid #000000; background: #000000; }")
        self.setLayout(layout)

    # ------------------------------------------
    def _show_offline_state(self):
        self.video_label.setText(
            f"CAM {self.cam_index + 1}\nOFFLINE")
        self.video_label.setFont(QFont("Monospace", 13))
        self.video_label.setStyleSheet(
            "background-color: #0A0A0A; color: #333333; border: none;")

    def _toggle_stream(self):
        if self._streaming:
            self._stop_stream()
        else:
            self._start_stream()

    def _start_stream(self):
        if not PYSPIN_AVAILABLE:
            QMessageBox.critical(
                self, "PYSPIN MISSING",
                "PySpin is not installed.\n\n"
                "Install the Spinnaker SDK and PySpin wheel\n"
                "from: https://www.flir.com/products/spinnaker-sdk/")
            return

        self.cam_thread = CameraThread(self.cam_index)
        self.cam_thread.frame_ready.connect(self._on_frame)
        self.cam_thread.stats_update.connect(self._on_stats)
        self.cam_thread.error.connect(self._on_error)
        self.cam_thread.camera_lost.connect(self._on_camera_lost)
        self.cam_thread.start()

        self._streaming = True
        self.toggle_btn.setText("STOP")
        self.toggle_btn.setProperty("variant", "active")
        self.toggle_btn.style().unpolish(self.toggle_btn)
        self.toggle_btn.style().polish(self.toggle_btn)
        self.fps_badge.setText("● INIT...")
        self.fps_badge.setStyleSheet(
            "color: #FF3000; background: transparent; border: none;")

    def _stop_stream(self):
        if self.cam_thread:
            self.cam_thread.stop()
            self.cam_thread = None
        self._streaming = False
        self.toggle_btn.setText("START")
        self.toggle_btn.setProperty("variant", "")
        self.toggle_btn.style().unpolish(self.toggle_btn)
        self.toggle_btn.style().polish(self.toggle_btn)
        self.fps_badge.setText("● OFFLINE")
        self.fps_badge.setStyleSheet(
            "color: #666666; background: transparent; border: none;")
        self._show_offline_state()

    def _on_frame(self, frame: np.ndarray):
        self._last_frame = frame
        h, w = frame.shape
        q_img = QImage(frame.data, w, h, w, QImage.Format_Grayscale8)
        pixmap = QPixmap.fromImage(q_img)
        scaled = pixmap.scaled(
            self.video_label.size(),
            Qt.KeepAspectRatio,
            Qt.SmoothTransformation
        )
        self.video_label.setPixmap(scaled)
        self.video_label.setStyleSheet(
            "background-color: #000000; border: none;")

    def _on_stats(self, stats: dict):
        if "fps" in stats:
            fps = stats["fps"]
            if fps > 0:
                self.fps_badge.setText(f"● {fps} FPS")
                self.fps_badge.setStyleSheet(
                    "color: #00CC44; background: transparent; border: none;")
            else:
                self.fps_badge.setText("● INIT...")

        if "model" in stats:
            # Model info received on first connect — could display in info panel
            pass

    def _save_snapshot(self):
        if self._last_frame is None:
            QMessageBox.information(
                self, "NO FRAME",
                f"Well {self.well_number}: No frame received yet.")
            return
        folder = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(folder, exist_ok=True)
        ts   = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(folder, f"well{self.well_number}_{ts}.png")
        cv2.imwrite(path, self._last_frame)
        QMessageBox.information(
            self, "SNAPSHOT SAVED", f"Saved:\n{path}")

    def _on_error(self, msg):
        self._stop_stream()
        QMessageBox.warning(self, f"CAM {self.cam_index + 1} ERROR", msg)

    def _on_camera_lost(self):
        self._stop_stream()
        QMessageBox.critical(
            self, "CAMERA LOST",
            f"Well {self.well_number} camera connection was lost.")

    def stop(self):
        """Called on app close."""
        if self.cam_thread:
            self.cam_thread.stop()


# =============================================
# Camera settings panel
# =============================================
class CameraSettingsPanel(QWidget):
    """
    Docked right-side panel — same pattern as the numpad in ModeDialog.
    Controls exposure, gain, FPS for all tiles simultaneously or per-tile.
    """
    settings_changed = pyqtSignal(dict)   # {"exposure_us": x, "gain_db": x, "fps": x}

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(300)

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Panel header — matches system UI section headers
        hdr = QFrame()
        hdr.setStyleSheet(
            "background-color: #000000; border: none;")
        hdr.setFixedHeight(56)
        hdr_layout = QHBoxLayout(hdr)
        hdr_layout.setContentsMargins(16, 0, 16, 0)
        hdr_lbl = QLabel("CAMERA SETTINGS")
        hdr_lbl.setFont(QFont("Inter", 12, QFont.Bold))
        hdr_lbl.setStyleSheet(
            "color: #FFFFFF; letter-spacing: 2px; background: transparent; border: none;")
        hdr_layout.addWidget(hdr_lbl)
        layout.addWidget(hdr)

        # Settings form
        form_container = QWidget()
        form_container.setStyleSheet("background-color: #F2F2F2;")
        form_layout = QVBoxLayout(form_container)
        form_layout.setContentsMargins(20, 20, 20, 20)
        form_layout.setSpacing(20)

        # Exposure
        exp_box = QGroupBox("EXPOSURE")
        exp_layout = QVBoxLayout()
        self.exp_combo = QComboBox()
        exp_vals = ["500", "1000", "2000", "5000", "10000", "20000", "50000"]
        self.exp_combo.addItems([f"{e} µs" for e in exp_vals])
        self.exp_combo.setCurrentIndex(3)   # 5000µs
        exp_layout.addWidget(self.exp_combo)
        exp_box.setLayout(exp_layout)
        form_layout.addWidget(exp_box)

        # Gain
        gain_box = QGroupBox("GAIN")
        gain_layout = QVBoxLayout()
        self.gain_combo = QComboBox()
        gain_vals = ["0", "3", "6", "10", "15", "20"]
        self.gain_combo.addItems([f"{g} dB" for g in gain_vals])
        self.gain_combo.setCurrentIndex(0)
        gain_layout.addWidget(self.gain_combo)
        gain_box.setLayout(gain_layout)
        form_layout.addWidget(gain_box)

        # Frame rate
        fps_box = QGroupBox("FRAME RATE")
        fps_layout = QVBoxLayout()
        self.fps_combo = QComboBox()
        fps_vals = ["5", "10", "15", "20", "30"]
        self.fps_combo.addItems([f"{f} FPS" for f in fps_vals])
        self.fps_combo.setCurrentIndex(2)   # 15fps
        fps_layout.addWidget(self.fps_combo)
        fps_box.setLayout(fps_layout)
        form_layout.addWidget(fps_box)

        # Apply button
        apply_btn = QPushButton("APPLY TO ALL")
        apply_btn.setMinimumHeight(56)
        apply_btn.setFont(QFont("Inter", 14, QFont.Bold))
        apply_btn.clicked.connect(self._emit_settings)
        form_layout.addWidget(apply_btn)

        form_layout.addStretch()

        # Snapshot all button
        snap_all_btn = QPushButton("SNAPSHOT ALL WELLS")
        snap_all_btn.setMinimumHeight(56)
        snap_all_btn.setProperty("variant", "secondary")
        snap_all_btn.clicked.connect(self.snapshot_all_requested)
        form_layout.addWidget(snap_all_btn)

        layout.addWidget(form_container, stretch=1)

        # Info footer — device info block, terminal style
        info_frame = QFrame()
        info_frame.setStyleSheet(
            "background-color: #000000; border: none; border-top: 2px solid #000000;")
        info_layout = QVBoxLayout(info_frame)
        info_layout.setContentsMargins(16, 16, 16, 16)

        info_hdr = QLabel("DEVICE INFO")
        info_hdr.setFont(QFont("Inter", 10, QFont.Bold))
        info_hdr.setStyleSheet(
            "color: #FF3000; letter-spacing: 2px; background: transparent; border: none;")
        info_layout.addWidget(info_hdr)

        self.info_label = QLabel(
            "Model: FLIR Firefly S\nFFY-U3-16S2M-S\n\nConnect camera\nto view details.")
        self.info_label.setFont(QFont("Monospace", 10))
        self.info_label.setStyleSheet(
            "color: #00FF00; background: transparent; border: none;")
        self.info_label.setWordWrap(True)
        info_layout.addWidget(self.info_label)

        layout.addWidget(info_frame)
        self.setLayout(layout)

    def snapshot_all_requested(self):
        # Resolved externally by CameraViewerWidget
        pass

    def _emit_settings(self):
        exp  = float(self.exp_combo.currentText().split()[0])
        gain = float(self.gain_combo.currentText().split()[0])
        fps  = float(self.fps_combo.currentText().split()[0])
        self.settings_changed.emit({
            "exposure_us": exp,
            "gain_db":     gain,
            "fps":         fps
        })

    def update_device_info(self, model, serial):
        self.info_label.setText(
            f"Model:\n{model}\n\nSerial:\n{serial}")


# =============================================
# Camera viewer tab widget
# =============================================
class CameraViewerWidget(QWidget):
    """
    Drop-in tab for MCCB_UI._build_main_ui().
    Contains a 2x2 grid of CameraTile widgets plus
    a docked settings panel — mirrors ModeDialog layout.
    """
    def __init__(self, num_wells=4, parent=None):
        super().__init__(parent)
        self.num_wells = num_wells
        self.tiles     = []

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ---- Section header — matches system UI pattern ----
        page_header = QFrame()
        page_header.setStyleSheet(
            "background-color: #FFFFFF; border-bottom: 4px solid #000000; "
            "border-top: none; border-left: none; border-right: none;")
        page_header.setFixedHeight(72)
        ph_layout = QHBoxLayout(page_header)
        ph_layout.setContentsMargins(32, 0, 32, 0)

        sec_num = QLabel("04. IMAGING")
        sec_num.setProperty("role", "section-number")
        ph_layout.addWidget(sec_num)

        ph_layout.addSpacing(24)

        heading = QLabel("LIVE CAMERA FEEDS")
        heading.setProperty("role", "heading")
        ph_layout.addWidget(heading)

        ph_layout.addStretch()

        # Global start/stop all
        self.all_btn = QPushButton("START ALL")
        self.all_btn.setFixedHeight(48)
        self.all_btn.clicked.connect(self._toggle_all)
        self._all_running = False
        ph_layout.addWidget(self.all_btn)

        layout.addWidget(page_header)

        # ---- Content: 2x2 grid + settings panel ----
        content = QHBoxLayout()
        content.setContentsMargins(0, 0, 0, 0)
        content.setSpacing(0)

        # 2x2 tile grid
        grid_widget = QWidget()
        grid_widget.setStyleSheet("background: #1A1A1A;")
        grid = QGridLayout(grid_widget)
        grid.setContentsMargins(16, 16, 16, 16)
        grid.setSpacing(12)

        for i in range(num_wells):
            tile = CameraTile(cam_index=i, well_number=i + 1)
            row  = i // 2
            col  = i % 2
            grid.addWidget(tile, row, col)
            grid.setRowStretch(row, 1)
            grid.setColumnStretch(col, 1)
            self.tiles.append(tile)

        content.addWidget(grid_widget, stretch=1)

        # Settings panel — same docked pattern as numpad in ModeDialog
        self.settings_panel = CameraSettingsPanel()
        self.settings_panel.settings_changed.connect(self._apply_settings_to_all)
        self.settings_panel.snap_all_btn_ref = None

        # Wire snapshot all button
        # Find it by iterating the panel's children
        for child in self.settings_panel.findChildren(QPushButton):
            if "SNAPSHOT ALL" in child.text():
                child.clicked.disconnect()
                child.clicked.connect(self._snapshot_all)
                break

        content.addWidget(self.settings_panel, stretch=0)
        layout.addLayout(content, stretch=1)

        self.setLayout(layout)

    # ------------------------------------------
    def _toggle_all(self):
        self._all_running = not self._all_running
        if self._all_running:
            for tile in self.tiles:
                if not tile._streaming:
                    tile._start_stream()
            self.all_btn.setText("STOP ALL")
            self.all_btn.setProperty("variant", "active")
        else:
            for tile in self.tiles:
                if tile._streaming:
                    tile._stop_stream()
            self.all_btn.setText("START ALL")
            self.all_btn.setProperty("variant", "")
        self.all_btn.style().unpolish(self.all_btn)
        self.all_btn.style().polish(self.all_btn)

    def _apply_settings_to_all(self, settings: dict):
        for tile in self.tiles:
            if tile.cam_thread:
                tile.cam_thread.update_settings(
                    exposure_us=settings.get("exposure_us"),
                    gain_db=settings.get("gain_db"),
                    fps=settings.get("fps")
                )

    def _snapshot_all(self):
        saved = []
        for tile in self.tiles:
            if tile._last_frame is not None:
                folder = os.path.expanduser("~/mccb_snapshots")
                os.makedirs(folder, exist_ok=True)
                ts   = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                path = os.path.join(
                    folder, f"well{tile.well_number}_{ts}.png")
                cv2.imwrite(path, tile._last_frame)
                saved.append(f"Well {tile.well_number}: {path}")

        if saved:
            QMessageBox.information(
                self, "SNAPSHOTS SAVED",
                "Saved:\n" + "\n".join(saved))
        else:
            QMessageBox.information(
                self, "NO FRAMES",
                "No active camera feeds to snapshot.")

    def stop_all(self):
        for tile in self.tiles:
            tile.stop()


# =============================================
# Standalone entry point
# =============================================
if __name__ == "__main__":
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setStyleSheet(SWISS_QSS)

    window = CameraViewerWidget(num_wells=4)
    window.setWindowTitle("MCCB — CAMERA VIEWER")
    window.showFullScreen()
    sys.exit(app.exec_())