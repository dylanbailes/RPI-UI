"""
camera_viewer.py — Aravis-based camera viewer for MCCB Controller
Replaces PySpin implementation. Runs on system Python 3.11.
Plug-in compatible with mccb_template_test.py.
"""

import sys
import time
import numpy as np

import gi
gi.require_version('Aravis', '0.8')
from gi.repository import Aravis

from PyQt5.QtWidgets import (
    QApplication, QWidget, QLabel, QPushButton, QVBoxLayout,
    QHBoxLayout, QGridLayout, QComboBox, QGroupBox, QSizePolicy,
    QFileDialog, QMessageBox
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QMutex, QMutexLocker
from PyQt5.QtGui import QImage, QPixmap, QFont

import cv2
import os

# ---------------------------------------------------------------------------
# Swiss International Style — must match mccb_template_test.py exactly
# ---------------------------------------------------------------------------
STYLE = """
QWidget {
    background-color: #FFFFFF;
    color: #000000;
    font-family: 'Inter', 'Helvetica', 'Arial', sans-serif;
    font-size: 12px;
}

QPushButton {
    background-color: #000000;
    color: #FFFFFF;
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 8px 16px;
    font-weight: bold;
    letter-spacing: 1px;
    text-transform: uppercase;
    min-height: 48px;
}
QPushButton:hover {
    background-color: #FF3000;
    border-color: #FF3000;
}
QPushButton:disabled {
    background-color: #999999;
    border-color: #999999;
    color: #CCCCCC;
}

QPushButton#secondary {
    background-color: #FFFFFF;
    color: #000000;
    border: 2px solid #000000;
}
QPushButton#secondary:hover {
    background-color: #FF3000;
    color: #FFFFFF;
    border-color: #FF3000;
}

QComboBox {
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 4px 8px;
    background-color: #FFFFFF;
    color: #000000;
    min-height: 32px;
}
QComboBox::drop-down {
    border: none;
    width: 24px;
}
QComboBox QAbstractItemView {
    border: 2px solid #000000;
    background-color: #FFFFFF;
    selection-background-color: #000000;
    selection-color: #FFFFFF;
}

QGroupBox {
    border: 2px solid #000000;
    border-radius: 0px;
    margin-top: 20px;
    font-weight: bold;
    letter-spacing: 1px;
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    background-color: #000000;
    color: #FFFFFF;
    padding: 2px 8px;
    text-transform: uppercase;
}

QLabel#section_header {
    background-color: #000000;
    color: #FFFFFF;
    font-size: 14px;
    font-weight: bold;
    letter-spacing: 2px;
    padding: 8px 12px;
}
QLabel#section_number {
    color: #FF3000;
    font-weight: bold;
    font-size: 14px;
    letter-spacing: 2px;
}
QLabel#tile_header {
    background-color: #000000;
    color: #FFFFFF;
    font-size: 11px;
    font-weight: bold;
    letter-spacing: 1px;
    padding: 4px 8px;
}
QLabel#video_label {
    background-color: #000000;
    color: #666666;
    border: 2px solid #000000;
}
QLabel#status_label {
    color: #000000;
    font-size: 11px;
    letter-spacing: 1px;
    padding: 2px 0px;
}
QLabel#status_label[status="live"] {
    color: #FF3000;
}
QLabel#status_label[status="stopped"] {
    color: #000000;
}
"""


# ---------------------------------------------------------------------------
# CameraThread — background acquisition using Aravis, one thread per camera
# ---------------------------------------------------------------------------
class CameraThread(QThread):
    frame_ready = pyqtSignal(np.ndarray)
    error_occurred = pyqtSignal(str)

    def __init__(self, camera_id: str, parent=None):
        super().__init__(parent)
        self._camera_id = camera_id   # Aravis device ID string
        self._running = False
        self._mutex = QMutex()
        self._exposure_us = 5000      # microseconds
        self._gain = 0.0
        self._target_fps = 10

    # --- public control ---
    def set_exposure(self, us: int):
        with QMutexLocker(self._mutex):
            self._exposure_us = us

    def set_gain(self, gain: float):
        with QMutexLocker(self._mutex):
            self._gain = gain

    def set_fps(self, fps: int):
        with QMutexLocker(self._mutex):
            self._target_fps = fps

    def stop(self):
        self._running = False
        self.wait(3000)

    # --- thread body ---
    def run(self):
        try:
            Aravis.update_device_list()
            camera = Aravis.Camera.new(self._camera_id)
        except Exception as e:
            self.error_occurred.emit(f"Cannot open camera {self._camera_id}: {e}")
            return

        try:
            with QMutexLocker(self._mutex):
                exp = self._exposure_us
                gain = self._gain
                fps = self._target_fps

            camera.set_exposure_time(float(exp))
            camera.set_gain(float(gain))
            # frame rate — best-effort, camera may clamp
            try:
                camera.set_frame_rate(float(fps))
            except Exception:
                pass

            payload = camera.get_payload()
            stream = camera.create_stream(None, None)
            for _ in range(4):
                stream.push_buffer(Aravis.Buffer.new_allocate(payload))

            camera.start_acquisition()
            self._running = True

            while self._running:
                # apply any mid-stream setting changes
                with QMutexLocker(self._mutex):
                    new_exp = self._exposure_us
                    new_gain = self._gain

                try:
                    camera.set_exposure_time(float(new_exp))
                    camera.set_gain(float(new_gain))
                except Exception:
                    pass

                buf = stream.try_pop_buffer()
                if buf is None:
                    time.sleep(0.01)
                    continue

                if buf.get_status() == Aravis.BufferStatus.SUCCESS:
                    data = buf.get_data()
                    width = buf.get_image_width()
                    height = buf.get_image_height()
                    arr = np.frombuffer(data, dtype=np.uint8).reshape((height, width))
                    self.frame_ready.emit(arr.copy())

                stream.push_buffer(buf)

        except Exception as e:
            self.error_occurred.emit(str(e))
        finally:
            try:
                camera.stop_acquisition()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CameraTile — single well view: header / video / footer (START·STOP·SNAP)
# ---------------------------------------------------------------------------
class CameraTile(QWidget):
    def __init__(self, well_index: int, camera_id: str | None, parent=None):
        super().__init__(parent)
        self._well_index = well_index
        self._camera_id = camera_id
        self._thread: CameraThread | None = None
        self._snapshot_dir = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(self._snapshot_dir, exist_ok=True)

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # --- header bar ---
        header = QLabel(f"WELL {self._well_index + 1:02d}")
        header.setObjectName("tile_header")
        header.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        layout.addWidget(header)

        # --- video display ---
        self.video_label = QLabel()
        self.video_label.setObjectName("video_label")
        self.video_label.setAlignment(Qt.AlignCenter)
        self.video_label.setText("NO SIGNAL")
        self.video_label.setMinimumSize(320, 240)
        self.video_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        layout.addWidget(self.video_label, stretch=1)

        # --- status row ---
        status_row = QHBoxLayout()
        status_row.setContentsMargins(4, 2, 4, 2)
        self.status_label = QLabel("STOPPED")
        self.status_label.setObjectName("status_label")
        self.status_label.setProperty("status", "stopped")
        status_row.addWidget(self.status_label)
        status_row.addStretch()
        if self._camera_id is None:
            no_cam = QLabel("NO CAMERA")
            no_cam.setObjectName("status_label")
            no_cam.setStyleSheet("color: #999999;")
            status_row.addWidget(no_cam)
        layout.addLayout(status_row)

        # --- footer buttons ---
        footer = QHBoxLayout()
        footer.setContentsMargins(0, 0, 0, 0)
        footer.setSpacing(0)

        self.btn_start = QPushButton("START")
        self.btn_stop = QPushButton("STOP")
        self.btn_snap = QPushButton("SNAP")
        self.btn_stop.setObjectName("secondary")
        self.btn_snap.setObjectName("secondary")

        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)

        if self._camera_id is None:
            self.btn_start.setEnabled(False)

        self.btn_start.clicked.connect(self.start_stream)
        self.btn_stop.clicked.connect(self.stop_stream)
        self.btn_snap.clicked.connect(self.take_snapshot)

        for btn in (self.btn_start, self.btn_stop, self.btn_snap):
            btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            footer.addWidget(btn)

        layout.addLayout(footer)

    # --- streaming ---
    def start_stream(self):
        if self._thread and self._thread.isRunning():
            return
        self._thread = CameraThread(self._camera_id)
        self._thread.frame_ready.connect(self._on_frame)
        self._thread.error_occurred.connect(self._on_error)
        self._thread.start()

        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.btn_snap.setEnabled(True)
        self._set_status("LIVE", "live")

    def stop_stream(self):
        if self._thread:
            self._thread.stop()
            self._thread = None
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)
        self.video_label.setText("NO SIGNAL")
        self._set_status("STOPPED", "stopped")

    def apply_settings(self, exposure_us: int, gain: float, fps: int):
        if self._thread:
            self._thread.set_exposure(exposure_us)
            self._thread.set_gain(gain)
            self._thread.set_fps(fps)

    # --- snapshot ---
    def take_snapshot(self):
        pixmap = self.video_label.pixmap()
        if pixmap is None or pixmap.isNull():
            return
        ts = time.strftime("%Y%m%d_%H%M%S")
        filename = os.path.join(
            self._snapshot_dir,
            f"well{self._well_index + 1:02d}_{ts}.png"
        )
        pixmap.save(filename)

    # --- slots ---
    def _on_frame(self, arr: np.ndarray):
        # arr is single-channel uint8; convert to QImage for display
        h, w = arr.shape
        # scale to fit label while preserving aspect ratio
        display = cv2.resize(
            arr,
            (self.video_label.width(), self.video_label.height()),
            interpolation=cv2.INTER_LINEAR
        )
        dh, dw = display.shape
        qimg = QImage(display.data, dw, dh, dw, QImage.Format_Grayscale8)
        self.video_label.setPixmap(QPixmap.fromImage(qimg))

    def _on_error(self, msg: str):
        self.video_label.setText(f"ERROR\n{msg}")
        self._set_status("ERROR", "stopped")
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)

    def _set_status(self, text: str, status_prop: str):
        self.status_label.setText(text)
        self.status_label.setProperty("status", status_prop)
        # force style refresh
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)

    def cleanup(self):
        if self._thread and self._thread.isRunning():
            self._thread.stop()
            self._thread = None


# ---------------------------------------------------------------------------
# CameraSettingsPanel — 300px docked right panel
# ---------------------------------------------------------------------------
class CameraSettingsPanel(QWidget):
    settings_changed = pyqtSignal(int, float, int)  # exposure_us, gain, fps

    EXPOSURE_OPTIONS = [
        ("500 µs",   500),
        ("1 ms",    1000),
        ("2 ms",    2000),
        ("5 ms",    5000),
        ("10 ms",  10000),
        ("20 ms",  20000),
        ("50 ms",  50000),
        ("100 ms", 100000),
    ]
    GAIN_OPTIONS = [
        ("0 dB",   0.0),
        ("3 dB",   3.0),
        ("6 dB",   6.0),
        ("12 dB", 12.0),
        ("18 dB", 18.0),
        ("24 dB", 24.0),
    ]
    FPS_OPTIONS = [5, 10, 15, 20, 30]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(300)
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # section header
        header = QLabel("  CAMERA SETTINGS")
        header.setObjectName("section_header")
        layout.addWidget(header)

        inner = QVBoxLayout()
        inner.setContentsMargins(12, 12, 12, 12)
        inner.setSpacing(16)

        # exposure
        exp_group = QGroupBox("EXPOSURE")
        exp_layout = QVBoxLayout(exp_group)
        self.combo_exposure = QComboBox()
        for label, _ in self.EXPOSURE_OPTIONS:
            self.combo_exposure.addItem(label)
        self.combo_exposure.setCurrentIndex(3)  # 5ms default
        exp_layout.addWidget(self.combo_exposure)
        inner.addWidget(exp_group)

        # gain
        gain_group = QGroupBox("GAIN")
        gain_layout = QVBoxLayout(gain_group)
        self.combo_gain = QComboBox()
        for label, _ in self.GAIN_OPTIONS:
            self.combo_gain.addItem(label)
        gain_layout.addWidget(self.combo_gain)
        inner.addWidget(gain_group)

        # fps
        fps_group = QGroupBox("FRAME RATE")
        fps_layout = QVBoxLayout(fps_group)
        self.combo_fps = QComboBox()
        for v in self.FPS_OPTIONS:
            self.combo_fps.addItem(f"{v} FPS")
        self.combo_fps.setCurrentIndex(1)  # 10fps default
        fps_layout.addWidget(self.combo_fps)
        inner.addWidget(fps_group)

        # apply button
        self.btn_apply = QPushButton("APPLY TO ALL")
        self.btn_apply.clicked.connect(self._emit_settings)
        inner.addWidget(self.btn_apply)

        inner.addStretch()

        # snapshot dir info
        snap_group = QGroupBox("SNAPSHOTS")
        snap_layout = QVBoxLayout(snap_group)
        snap_dir_label = QLabel("~/mccb_snapshots/")
        snap_dir_label.setWordWrap(True)
        snap_dir_label.setStyleSheet("color: #666666; font-size: 11px;")
        snap_layout.addWidget(snap_dir_label)

        self.btn_open_dir = QPushButton("OPEN FOLDER")
        self.btn_open_dir.setObjectName("secondary")
        self.btn_open_dir.clicked.connect(self._open_snapshot_dir)
        snap_layout.addWidget(self.btn_open_dir)
        inner.addWidget(snap_group)

        container = QWidget()
        container.setLayout(inner)
        container.setStyleSheet("background-color: #F2F2F2;")
        layout.addWidget(container, stretch=1)

    def _emit_settings(self):
        exp_us = self.EXPOSURE_OPTIONS[self.combo_exposure.currentIndex()][1]
        gain = self.GAIN_OPTIONS[self.combo_gain.currentIndex()][1]
        fps = self.FPS_OPTIONS[self.combo_fps.currentIndex()]
        self.settings_changed.emit(exp_us, gain, fps)

    def _open_snapshot_dir(self):
        path = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(path, exist_ok=True)
        QFileDialog.getOpenFileName(self, "SNAPSHOTS", path)

    def current_settings(self):
        exp_us = self.EXPOSURE_OPTIONS[self.combo_exposure.currentIndex()][1]
        gain = self.GAIN_OPTIONS[self.combo_gain.currentIndex()][1]
        fps = self.FPS_OPTIONS[self.combo_fps.currentIndex()]
        return exp_us, gain, fps


# ---------------------------------------------------------------------------
# CameraViewerWidget — 2×2 grid of tiles + settings panel
# Plug-in compatible: add as a tab in mccb_template_test.py
# ---------------------------------------------------------------------------
class CameraViewerWidget(QWidget):
    def __init__(self, num_wells: int = 4, parent=None):
        super().__init__(parent)
        self._num_wells = num_wells
        self._tiles: list[CameraTile] = []
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # --- section header ---
        hdr_row = QHBoxLayout()
        hdr_row.setContentsMargins(0, 0, 0, 0)
        hdr_row.setSpacing(0)

        num_label = QLabel("  04.")
        num_label.setObjectName("section_number")
        num_label.setFixedWidth(48)
        num_label.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        num_label.setStyleSheet(
            "background-color: #000000; color: #FF3000; "
            "font-weight: bold; font-size: 14px; letter-spacing: 2px; "
            "padding: 8px 0px 8px 12px;"
        )

        title_label = QLabel("IMAGING")
        title_label.setObjectName("section_header")
        title_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

        hdr_row.addWidget(num_label)
        hdr_row.addWidget(title_label)
        root.addLayout(hdr_row)

        # --- body: grid + panel ---
        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)

        # 2×2 grid
        camera_ids = self._enumerate_cameras()
        grid = QGridLayout()
        grid.setSpacing(2)
        grid.setContentsMargins(2, 2, 2, 2)

        for i in range(self._num_wells):
            cam_id = camera_ids[i] if i < len(camera_ids) else None
            tile = CameraTile(well_index=i, camera_id=cam_id)
            self._tiles.append(tile)
            row, col = divmod(i, 2)
            grid.addWidget(tile, row, col)
            grid.setRowStretch(row, 1)
            grid.setColumnStretch(col, 1)

        grid_container = QWidget()
        grid_container.setLayout(grid)
        grid_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        body.addWidget(grid_container, stretch=1)

        # settings panel
        self.settings_panel = CameraSettingsPanel()
        self.settings_panel.settings_changed.connect(self._apply_settings_to_all)
        body.addWidget(self.settings_panel)

        root.addLayout(body, stretch=1)

    # --- camera enumeration ---
    @staticmethod
    def _enumerate_cameras() -> list[str]:
        """Return list of Aravis device ID strings."""
        try:
            Aravis.update_device_list()
            count = Aravis.get_n_devices()
            return [Aravis.get_device_id(i) for i in range(count)]
        except Exception:
            return []

    # --- settings ---
    def _apply_settings_to_all(self, exposure_us: int, gain: float, fps: int):
        for tile in self._tiles:
            tile.apply_settings(exposure_us, gain, fps)

    # --- cleanup (called from mccb_template_test.py closeEvent) ---
    def stop_all(self):
        for tile in self._tiles:
            tile.cleanup()


# ---------------------------------------------------------------------------
# Standalone entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setStyleSheet(STYLE)

    win = QWidget()
    win.setWindowTitle("MCCB — CAMERA VIEWER")
    win.setStyleSheet(STYLE)

    layout = QVBoxLayout(win)
    layout.setContentsMargins(0, 0, 0, 0)

    viewer = CameraViewerWidget(num_wells=4)
    layout.addWidget(viewer)

    win.showFullScreen()

    def on_close():
        viewer.stop_all()
        app.quit()

    app.aboutToQuit.connect(on_close)
    sys.exit(app.exec_())