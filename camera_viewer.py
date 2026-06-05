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
    QFileDialog
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QMutex, QMutexLocker
from PyQt5.QtGui import QImage, QPixmap

import os

# ---------------------------------------------------------------------------
# Swiss International Style (Ultra-Compact)
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
    padding: 0px 4px;
    font-weight: bold;
    letter-spacing: 1px;
    min-height: 28px;
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
QPushButton#apply_btn {
    background-color: #000000;
    color: #FFFFFF;
    border: 2px solid #000000;
    font-weight: 900;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
    min-height: 36px;
}
QPushButton#apply_btn:hover {
    background-color: #FF3000;
    border-color: #FF3000;
}
QPushButton#exit_btn {
    background-color: #FF3000;
    color: #FFFFFF;
    border: 2px solid #FF3000;
    min-height: 48px;
    font-weight: bold;
}
QPushButton#exit_btn:hover {
    background-color: #000000;
    border-color: #000000;
}
QComboBox {
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 2px 6px;
    background-color: #FFFFFF;
    color: #000000;
    min-height: 28px;
}
QComboBox::drop-down { border: none; width: 24px; }
QComboBox QAbstractItemView {
    border: 2px solid #000000;
    background-color: #FFFFFF;
    selection-background-color: #000000;
    selection-color: #FFFFFF;
}
QGroupBox {
    border: 2px solid #000000;
    border-radius: 0px;
    margin-top: 14px;
    font-weight: bold;
    letter-spacing: 1px;
}
QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    background-color: #000000;
    color: #FFFFFF;
    padding: 2px 6px;
    font-size: 11px;
}
"""


# ---------------------------------------------------------------------------
# CameraThread
# ---------------------------------------------------------------------------
class CameraThread(QThread):
    frame_ready = pyqtSignal(np.ndarray)
    error_occurred = pyqtSignal(str)

    def __init__(self, camera_id, parent=None):
        super().__init__(parent)
        self._camera_id = camera_id
        self._running = False
        self._mutex = QMutex()
        self._exposure_us = 5000
        self._gain = 0.0
        self._fps = 10

    def set_exposure(self, us):
        with QMutexLocker(self._mutex):
            self._exposure_us = us

    def set_gain(self, gain):
        with QMutexLocker(self._mutex):
            self._gain = gain

    def set_fps(self, fps):
        with QMutexLocker(self._mutex):
            self._fps = fps

    def stop(self):
        self._running = False
        self.wait(3000)

    def run(self):
        try:
            Aravis.update_device_list()
            camera = Aravis.Camera.new(self._camera_id)
        except Exception as e:
            self.error_occurred.emit(f"Cannot open camera: {e}")
            return

        try:
            with QMutexLocker(self._mutex):
                exp = self._exposure_us
                gain = self._gain
                fps = self._fps

            camera.set_exposure_time(float(exp))
            camera.set_gain(float(gain))
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
                    w = buf.get_image_width()
                    h = buf.get_image_height()
                    data = buf.get_data()
                    arr = np.frombuffer(data, dtype=np.uint8).reshape((h, w)).copy()
                    self.frame_ready.emit(arr)

                stream.push_buffer(buf)

        except Exception as e:
            self.error_occurred.emit(str(e))
        finally:
            try:
                camera.stop_acquisition()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CameraTile
# ---------------------------------------------------------------------------
class CameraTile(QWidget):
    def __init__(self, well_index, camera_id, parent=None):
        super().__init__(parent)
        self._well_index = well_index
        self._camera_id = camera_id
        self._thread = None
        self._snapshot_dir = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(self._snapshot_dir, exist_ok=True)
        self._build_ui()

    def _build_ui(self):
        # Zero margins and spacing to eliminate ALL gaps
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # Ultra-compact header
        header = QLabel(f"WELL {self._well_index + 1:02d}")
        header.setFixedHeight(20)
        header.setStyleSheet("background-color:#000000; color:#FFFFFF; font-weight:bold; letter-spacing:1px; font-size:11px; padding-left: 4px; padding-top: 2px;")
        layout.addWidget(header)

        # Video container with internal layout (no manual resize needed, no gaps)
        self.video_container = QWidget()
        self.video_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.video_container.setStyleSheet("background-color:#000000; border: 2px solid #000000;")
        
        video_layout = QVBoxLayout(self.video_container)
        video_layout.setContentsMargins(0, 0, 0, 0)
        video_layout.setSpacing(0)

        self.video_label = QLabel()
        self.video_label.setAlignment(Qt.AlignCenter)
        self.video_label.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.video_label.setStyleSheet("background-color:#000000;")
        self.video_label.setScaledContents(True)
        video_layout.addWidget(self.video_label)

        self.status_label = QLabel("STOPPED", self.video_container)
        self.status_label.setStyleSheet(
            "color:#FFFFFF; font-size:10px; letter-spacing:1px; "
            "background-color: rgba(0,0,0,160); padding: 1px 4px;"
        )
        self.status_label.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        self.status_label.move(4, 4)
        self.status_label.raise_()

        layout.addWidget(self.video_container, stretch=1)

        # Buttons flush against video container
        footer = QHBoxLayout()
        footer.setContentsMargins(0, 0, 0, 0)
        footer.setSpacing(0)

        self.btn_start = QPushButton("START")
        self.btn_stop  = QPushButton("STOP")
        self.btn_snap  = QPushButton("SNAP")
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
            btn.setFixedHeight(28)
            footer.addWidget(btn)
        layout.addLayout(footer)

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
        self.status_label.setText("LIVE")
        self.status_label.setStyleSheet("color:#FF3000; font-size:11px; letter-spacing:1px;")

    def stop_stream(self):
        if self._thread:
            self._thread.stop()
            self._thread = None
        self.video_label.clear()
        self.video_label.setStyleSheet("background-color:#000000;")
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)
        self.status_label.setText("STOPPED")
        self.status_label.setStyleSheet("color:#000000; font-size:11px; letter-spacing:1px;")

    def apply_settings(self, exposure_us, gain, fps):
        if self._thread:
            self._thread.set_exposure(exposure_us)
            self._thread.set_gain(gain)
            self._thread.set_fps(fps)

    def take_snapshot(self):
        pix = self.video_label.pixmap()
        if pix and not pix.isNull():
            ts = time.strftime("%Y%m%d_%H%M%S")
            path = os.path.join(self._snapshot_dir, f"well{self._well_index+1:02d}_{ts}.png")
            pix.save(path)

    def _on_frame(self, arr):
        h, w = arr.shape
        qimg = QImage(arr.data, w, h, w, QImage.Format_Grayscale8)
        self.video_label.setPixmap(QPixmap.fromImage(qimg))

    def _on_error(self, msg):
        self.status_label.setText("ERROR")
        self.status_label.setStyleSheet("color:#FF3000; font-size:11px; letter-spacing:1px;")
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)

    def cleanup(self):
        if self._thread and self._thread.isRunning():
            self._thread.stop()
            self._thread = None


# ---------------------------------------------------------------------------
# CameraSettingsPanel (Ultra-Compact)
# ---------------------------------------------------------------------------
class CameraSettingsPanel(QWidget):
    settings_changed = pyqtSignal(int, float, int)

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
        self.setFixedWidth(220)  # Reduced from 240 to give more room to cameras
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        header = QLabel("CAMERA SETTINGS")
        header.setFixedHeight(28)
        header.setStyleSheet("background-color:#000000; color:#FFFFFF; font-size:12px; font-weight:bold; letter-spacing:2px; padding-left:8px; padding-top: 4px;")
        layout.addWidget(header)

        inner = QVBoxLayout()
        inner.setContentsMargins(6, 6, 6, 6)
        inner.setSpacing(6)  # Reduced from 12 to 6

        exp_group = QGroupBox("EXPOSURE")
        exp_layout = QVBoxLayout(exp_group)
        exp_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_exposure = QComboBox()
        for label, _ in self.EXPOSURE_OPTIONS:
            self.combo_exposure.addItem(label)
        self.combo_exposure.setCurrentIndex(3)
        exp_layout.addWidget(self.combo_exposure)
        inner.addWidget(exp_group)

        gain_group = QGroupBox("GAIN")
        gain_layout = QVBoxLayout(gain_group)
        gain_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_gain = QComboBox()
        for label, _ in self.GAIN_OPTIONS:
            self.combo_gain.addItem(label)
        gain_layout.addWidget(self.combo_gain)
        inner.addWidget(gain_group)

        fps_group = QGroupBox("FRAME RATE")
        fps_layout = QVBoxLayout(fps_group)
        fps_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_fps = QComboBox()
        for v in self.FPS_OPTIONS:
            self.combo_fps.addItem(f"{v} FPS")
        self.combo_fps.setCurrentIndex(1)
        fps_layout.addWidget(self.combo_fps)
        inner.addWidget(fps_group)

        btn_apply = QPushButton("APPLY TO ALL")
        btn_apply.setObjectName("apply_btn")
        btn_apply.setFixedHeight(36)
        btn_apply.clicked.connect(self._emit_settings)
        inner.addWidget(btn_apply)

        snap_group = QGroupBox("SNAPSHOTS")
        snap_layout = QVBoxLayout(snap_group)
        snap_layout.setContentsMargins(6, 14, 6, 6)
        lbl = QLabel("~/mccb_snapshots/")
        lbl.setStyleSheet("font-size: 10px; margin-bottom: 4px;")
        snap_layout.addWidget(lbl)
        btn_open = QPushButton("OPEN FOLDER")
        btn_open.setObjectName("secondary")
        btn_open.setFixedHeight(36)
        btn_open.clicked.connect(self._open_dir)
        snap_layout.addWidget(btn_open)
        inner.addWidget(snap_group)

        container = QWidget()
        container.setLayout(inner)
        container.setStyleSheet("background-color: #F2F2F2;")
        layout.addWidget(container, stretch=1)

    def _emit_settings(self):
        exp_us = self.EXPOSURE_OPTIONS[self.combo_exposure.currentIndex()][1]
        gain   = self.GAIN_OPTIONS[self.combo_gain.currentIndex()][1]
        fps    = self.FPS_OPTIONS[self.combo_fps.currentIndex()]
        self.settings_changed.emit(exp_us, gain, fps)

    def _open_dir(self):
        path = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(path, exist_ok=True)
        QFileDialog.getOpenFileName(self, "SNAPSHOTS", path)

    def current_settings(self):
        exp_us = self.EXPOSURE_OPTIONS[self.combo_exposure.currentIndex()][1]
        gain   = self.GAIN_OPTIONS[self.combo_gain.currentIndex()][1]
        fps    = self.FPS_OPTIONS[self.combo_fps.currentIndex()]
        return exp_us, gain, fps


# ---------------------------------------------------------------------------
# CameraViewerWidget
# ---------------------------------------------------------------------------
class CameraViewerWidget(QWidget):
    def __init__(self, num_wells=4, parent=None):
        super().__init__(parent)
        self._num_wells = num_wells
        self._tiles = []
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)

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

        self.settings_panel = CameraSettingsPanel()
        self.settings_panel.settings_changed.connect(self._apply_settings)
        body.addWidget(self.settings_panel)

        root.addLayout(body, stretch=1)

    def _on_exit(self):
        self.stop_all()
        app = QApplication.instance()
        if app:
            app.quit()

    @staticmethod
    def _enumerate_cameras():
        try:
            Aravis.update_device_list()
            count = Aravis.get_n_devices()
            return [Aravis.get_device_id(i) for i in range(count)]
        except Exception:
            return []

    def _apply_settings(self, exposure_us, gain, fps):
        for tile in self._tiles:
            tile.apply_settings(exposure_us, gain, fps)

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

    layout = QVBoxLayout(win)
    layout.setContentsMargins(0, 0, 0, 0)

    viewer = CameraViewerWidget(num_wells=4)
    layout.addWidget(viewer)

    win.showFullScreen()

    app.aboutToQuit.connect(viewer.stop_all)
    sys.exit(app.exec_())