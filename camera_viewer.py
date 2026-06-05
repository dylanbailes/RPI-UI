"""
camera_viewer.py — Aravis-based camera viewer for MCCB Controller
Replaces PySpin implementation. Runs on system Python 3.11.
Plug-in compatible with mccb_template_test.py.
"""

import sys
import time
import numpy as np
import os

import gi
gi.require_version('Aravis', '0.8')
from gi.repository import Aravis

from PyQt5.QtWidgets import (
    QApplication, QWidget, QLabel, QPushButton, QVBoxLayout,
    QHBoxLayout, QGridLayout, QComboBox, QGroupBox, QSizePolicy,
    QFileDialog, QScrollArea
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QMutex, QMutexLocker, QRect, QPoint
from PyQt5.QtGui import QImage, QPixmap, QPainter, QColor, QPen, QBrush, QPolygon

# ---------------------------------------------------------------------------
# Swiss International Style
# ---------------------------------------------------------------------------
STYLE = """
QWidget {
    background-color: #FFFFFF;
    color: #000000;
    font-family: 'Helvetica', 'Arial', sans-serif;
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
}
QPushButton:hover {
    background-color: #FF3000;
    border-color: #FF3000;
    color: #FFFFFF;
}
QPushButton:disabled {
    background-color: #999999;
    border-color: #999999;
    color: #CCCCCC;
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
# Custom Label that CROPS to fit (Keep Aspect Ratio by Expanding)
# ---------------------------------------------------------------------------
class CroppingLabel(QLabel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._pixmap = None
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Ignored)
        # Transparent to mouse so overlay buttons above it receive clicks
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)

    def setPixmap(self, pixmap):
        self._pixmap = pixmap
        self.update()

    def pixmap(self):
        return self._pixmap

    def paintEvent(self, event):
        if self._pixmap and not self._pixmap.isNull():
            painter = QPainter(self)
            painter.setRenderHint(QPainter.SmoothPixmapTransform)
            scaled = self._pixmap.scaled(
                self.size(), Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation
            )
            x = (self.width()  - scaled.width())  // 2
            y = (self.height() - scaled.height()) // 2
            painter.drawPixmap(x, y, scaled)
        else:
            super().paintEvent(event)


# ---------------------------------------------------------------------------
# IconButton — QPushButton that draws its icon via QPainter
# No font/emoji dependency; always perfectly centred.
# icon: 'play' | 'pause' | 'camera'
# ---------------------------------------------------------------------------
class IconButton(QPushButton):
    # Colours
    _C_NORMAL   = QColor(0,   0,   0,   200)
    _C_HOVER    = QColor(255, 48,  0,   255)
    _C_DISABLED = QColor(80,  80,  80,  200)
    _C_BORDER   = QColor(255, 255, 255, 255)
    _C_ICON     = QColor(255, 255, 255, 255)
    _C_ICON_DIS = QColor(150, 150, 150, 255)

    def __init__(self, icon: str, parent=None):
        super().__init__("", parent)
        self._icon     = icon
        self._hovered  = False
        self.setMouseTracking(True)
        # No stylesheet — we paint everything ourselves
        self.setStyleSheet("")

    # Hover tracking
    def enterEvent(self, e):
        self._hovered = True
        self.update()

    def leaveEvent(self, e):
        self._hovered = False
        self.update()

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)

        enabled = self.isEnabled()
        if not enabled:
            bg = self._C_DISABLED
        elif self._hovered:
            bg = self._C_HOVER
        else:
            bg = self._C_NORMAL

        w, h = self.width(), self.height()

        # Background
        p.fillRect(0, 0, w, h, bg)

        # Border (2 px, white)
        pen = QPen(self._C_BORDER, 2)
        p.setPen(pen)
        p.drawRect(1, 1, w - 2, h - 2)

        # Icon
        ic = self._C_ICON if enabled else self._C_ICON_DIS
        p.setPen(Qt.NoPen)
        p.setBrush(QBrush(ic))

        cx, cy = w // 2, h // 2

        if self._icon == 'play':
            # Solid right-pointing triangle, centred
            size = min(w, h) // 3
            pts = QPolygon([
                QPoint(cx - size // 2,     cy - size),
                QPoint(cx - size // 2,     cy + size),
                QPoint(cx + size,          cy),
            ])
            p.drawPolygon(pts)

        elif self._icon == 'pause':
            # Two vertical bars
            bw = max(2, w // 7)   # bar width
            bh = min(h, h // 2)   # bar height
            gap = max(2, w // 8)
            total = 2 * bw + gap
            lx = cx - total // 2
            by = cy - bh // 2
            p.fillRect(lx,          by, bw, bh, ic)
            p.fillRect(lx + bw + gap, by, bw, bh, ic)

        elif self._icon == 'camera':
            # Camera body + lens circle
            pen2 = QPen(ic, 1.5)
            p.setPen(pen2)
            p.setBrush(Qt.NoBrush)
            bw2 = w * 5 // 8
            bh2 = h * 4 // 9
            bx = cx - bw2 // 2
            by = cy - bh2 // 2 + 1
            p.drawRect(bx, by, bw2, bh2)
            # Viewfinder notch on top-left
            nw = bw2 // 4
            nh = max(2, bh2 // 4)
            p.drawRect(bx + 3, by - nh, nw, nh)
            # Lens
            r = min(bw2, bh2) * 3 // 10
            p.setBrush(QBrush(ic))
            p.drawEllipse(QPoint(cx, cy + 1), r, r)

        p.end()


# ---------------------------------------------------------------------------
# CameraThread
# ---------------------------------------------------------------------------
class CameraThread(QThread):
    frame_ready    = pyqtSignal(np.ndarray)
    error_occurred = pyqtSignal(str)

    def __init__(self, camera_id, parent=None):
        super().__init__(parent)
        self._camera_id   = camera_id
        self._running     = False
        self._mutex       = QMutex()
        self._exposure_us = 5000
        self._gain        = 0.0
        self._fps         = 10

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
                exp  = self._exposure_us
                gain = self._gain
                fps  = self._fps

            camera.set_exposure_time(float(exp))
            camera.set_gain(float(gain))
            try:
                camera.set_frame_rate(float(fps))
            except Exception:
                pass

            payload = camera.get_payload()
            stream  = camera.create_stream(None, None)
            for _ in range(4):
                stream.push_buffer(Aravis.Buffer.new_allocate(payload))

            camera.start_acquisition()
            self._running = True

            while self._running:
                with QMutexLocker(self._mutex):
                    new_exp  = self._exposure_us
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
                    w    = buf.get_image_width()
                    h    = buf.get_image_height()
                    data = buf.get_data()
                    arr  = np.frombuffer(data, dtype=np.uint8).reshape((h, w)).copy()
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
    # Overlay button geometry — tweak here only
    _BTN_W     = 120   # px wide
    _BTN_H     = 24   # px tall  (compact so 3 fit easily)
    _BTN_GAP   = 60    # px between buttons
    _RIGHT_PAD = 12    # px from right edge of tile

    def __init__(self, well_index, camera_id, parent=None):
        super().__init__(parent)
        self._well_index   = well_index
        self._camera_id    = camera_id
        self._thread       = None
        self._snapshot_dir = os.path.expanduser("~/mccb_snapshots")
        os.makedirs(self._snapshot_dir, exist_ok=True)
        # Allow the tile to shrink below its natural size hint
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMinimumSize(0, 0)
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── black video area ─────────────────────────────────────────────
        self.video_container = QWidget()
        self.video_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.video_container.setMinimumSize(0, 0)
        self.video_container.setStyleSheet("background-color:#000000;")

        vc_layout = QVBoxLayout(self.video_container)
        vc_layout.setContentsMargins(0, 0, 0, 0)
        vc_layout.setSpacing(0)

        self.video_label = CroppingLabel()
        vc_layout.addWidget(self.video_label)

        layout.addWidget(self.video_container, stretch=1)

        # ── overlays are children of CameraTile itself (not video_container)
        # so they sit above the video area in Z-order and receive mouse events
        # without being blocked by the CroppingLabel inside the container.

        # Well number label
        self.header_label = QLabel(f"WELL {self._well_index + 1:02d}", self)
        self.header_label.setStyleSheet(
            "color:#FFFFFF; font-weight:900; font-size:12px; letter-spacing:2px; "
            "background-color: rgba(0,0,0,180); padding: 3px 7px;"
        )
        self.header_label.adjustSize()
        self.header_label.raise_()

        # Status label
        self.status_label = QLabel("STOPPED", self)
        self.status_label.setStyleSheet(
            "color:#FFFFFF; font-size:10px; letter-spacing:1px; "
            "background-color: rgba(0,0,0,160); padding: 2px 5px;"
        )
        self.status_label.adjustSize()
        self.status_label.raise_()

        # Three IconButtons — also direct children of CameraTile
        self.btn_start = IconButton('play',   self)
        self.btn_stop  = IconButton('pause',  self)
        self.btn_snap  = IconButton('camera', self)

        for btn in (self.btn_start, self.btn_stop, self.btn_snap):
            btn.setFixedSize(self._BTN_W, self._BTN_H)
            btn.raise_()

        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)
        if self._camera_id is None:
            self.btn_start.setEnabled(False)

        self.btn_start.clicked.connect(self.start_stream)
        self.btn_stop.clicked.connect(self.stop_stream)
        self.btn_snap.clicked.connect(self.take_snapshot)

    # ------------------------------------------------------------------ layout
    def resizeEvent(self, event):
        super().resizeEvent(event)
        # video_container fills the whole tile
        self.video_container.setGeometry(0, 0, self.width(), self.height())
        self._reposition_overlays()

    def showEvent(self, event):
        super().showEvent(event)
        self._reposition_overlays()

    def _reposition_overlays(self):
        w, h = self.width(), self.height()
        if w == 0 or h == 0:
            return

        # Header top-left
        self.header_label.adjustSize()
        self.header_label.move(6, 6)

        # Status just below header
        self.status_label.adjustSize()
        self.status_label.move(6, 6 + self.header_label.height() + 2)

        # Buttons: right edge, vertically centred
        bw = self._BTN_W
        bh = self._BTN_H
        gap = self._BTN_GAP
        pad = self._RIGHT_PAD

        total_h = 3 * bh + 2 * gap
        bx = w - bw - pad
        by = max(50, (h - total_h) // 2)

        self.btn_start.setGeometry(bx, by,              bw, bh)
        self.btn_stop .setGeometry(bx, by + bh + gap,   bw, bh)
        self.btn_snap .setGeometry(bx, by + 2*(bh+gap), bw, bh)

        for btn in (self.btn_start, self.btn_stop, self.btn_snap):
            btn.raise_()

    # ------------------------------------------------------------------ stream
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
        self.status_label.adjustSize()
        self.status_label.setStyleSheet(
            "color:#FF3000; font-size:10px; letter-spacing:1px; font-weight:bold; "
            "background-color: rgba(0,0,0,160); padding: 2px 5px;"
        )

    def stop_stream(self):
        if self._thread:
            self._thread.stop()
            self._thread = None
        self.video_label.setPixmap(QPixmap())
        self.btn_start.setEnabled(self._camera_id is not None)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)
        self.status_label.setText("STOPPED")
        self.status_label.adjustSize()
        self.status_label.setStyleSheet(
            "color:#FFFFFF; font-size:10px; letter-spacing:1px; "
            "background-color: rgba(0,0,0,160); padding: 2px 5px;"
        )

    def apply_settings(self, exposure_us, gain, fps):
        if self._thread:
            self._thread.set_exposure(exposure_us)
            self._thread.set_gain(gain)
            self._thread.set_fps(fps)

    def take_snapshot(self):
        pix = self.video_label.pixmap()
        if pix and not pix.isNull():
            ts   = time.strftime("%Y%m%d_%H%M%S")
            path = os.path.join(
                self._snapshot_dir,
                f"well{self._well_index + 1:02d}_{ts}.png"
            )
            pix.save(path)

    def _on_frame(self, arr):
        h, w = arr.shape
        qimg = QImage(arr.data, w, h, w, QImage.Format_Grayscale8)
        self.video_label.setPixmap(QPixmap.fromImage(qimg))

    def _on_error(self, msg):
        self.status_label.setText("ERROR")
        self.status_label.adjustSize()
        self.status_label.setStyleSheet(
            "color:#FF3000; font-size:10px; letter-spacing:1px; font-weight:bold; "
            "background-color: rgba(0,0,0,160); padding: 2px 5px;"
        )
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_snap.setEnabled(False)

    def cleanup(self):
        if self._thread and self._thread.isRunning():
            self._thread.stop()
            self._thread = None


# ---------------------------------------------------------------------------
# CameraSettingsPanel
# ---------------------------------------------------------------------------
class CameraSettingsPanel(QWidget):
    settings_changed = pyqtSignal(int, float, int)

    EXPOSURE_OPTIONS = [
        ("500 µs",   500), ("1 ms",    1000), ("2 ms",    2000), ("5 ms",    5000),
        ("10 ms",  10000), ("20 ms",  20000), ("50 ms",  50000), ("100 ms", 100000),
    ]
    GAIN_OPTIONS = [
        ("0 dB",   0.0), ("3 dB",   3.0), ("6 dB",   6.0),
        ("12 dB", 12.0), ("18 dB", 18.0), ("24 dB", 24.0),
    ]
    FPS_OPTIONS = [5, 10, 15, 20, 30]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumWidth(220)
        self.setMaximumWidth(220)
        self.setSizePolicy(QSizePolicy.Fixed, QSizePolicy.Expanding)
        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # ── panel header ─────────────────────────────────────────────────
        header = QLabel("CAMERA SETTINGS")
        header.setFixedHeight(32)
        header.setStyleSheet(
            "background-color:#000000; color:#FFFFFF; font-size:12px; "
            "font-weight:900; letter-spacing:2px; padding-left:8px; padding-top:6px;"
        )
        layout.addWidget(header)

        # ── scroll area ───────────────────────────────────────────────────
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setStyleSheet(
            "QScrollArea { border: none; background-color: #F2F2F2; }"
            "QScrollBar:vertical { width: 6px; background: #E8E8E8; }"
            "QScrollBar::handle:vertical { background: #AAAAAA; min-height: 20px; }"
            "QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0px; }"
        )

        inner_widget = QWidget()
        inner_widget.setStyleSheet("background-color: #F2F2F2;")
        inner = QVBoxLayout(inner_widget)
        inner.setContentsMargins(6, 6, 6, 6)
        inner.setSpacing(6)

        # ── Exposure ──────────────────────────────────────────────────────
        exp_group = QGroupBox("EXPOSURE")
        exp_layout = QVBoxLayout(exp_group)
        exp_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_exposure = QComboBox()
        for label, _ in self.EXPOSURE_OPTIONS:
            self.combo_exposure.addItem(label)
        self.combo_exposure.setCurrentIndex(3)
        exp_layout.addWidget(self.combo_exposure)
        inner.addWidget(exp_group)

        # ── Gain ──────────────────────────────────────────────────────────
        gain_group = QGroupBox("GAIN")
        gain_layout = QVBoxLayout(gain_group)
        gain_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_gain = QComboBox()
        for label, _ in self.GAIN_OPTIONS:
            self.combo_gain.addItem(label)
        gain_layout.addWidget(self.combo_gain)
        inner.addWidget(gain_group)

        # ── Frame Rate ────────────────────────────────────────────────────
        fps_group = QGroupBox("FRAME RATE")
        fps_layout = QVBoxLayout(fps_group)
        fps_layout.setContentsMargins(6, 14, 6, 6)
        self.combo_fps = QComboBox()
        for v in self.FPS_OPTIONS:
            self.combo_fps.addItem(f"{v} FPS")
        self.combo_fps.setCurrentIndex(1)
        fps_layout.addWidget(self.combo_fps)
        inner.addWidget(fps_group)

        # ── Apply to All — same QGroupBox pattern as the other controls ───
        apply_group = QGroupBox("APPLY SETTINGS")
        apply_layout = QVBoxLayout(apply_group)
        apply_layout.setContentsMargins(6, 14, 6, 6)
        btn_apply = QPushButton("APPLY TO ALL")
        btn_apply.setFixedHeight(32)
        # Direct stylesheet on the button instance — not via objectName on parent
        btn_apply.setStyleSheet("""
            QPushButton {
                background-color: #000000;
                color: #FFFFFF;
                border: 2px solid #000000;
                border-radius: 0px;
                font-weight: 900;
                font-size: 11px;
                letter-spacing: 1px;
            }
            QPushButton:hover {
                background-color: #FF3000;
                border-color: #FF3000;
            }
            QPushButton:pressed {
                background-color: #CC2000;
            }
        """)
        btn_apply.clicked.connect(self._emit_settings)
        apply_layout.addWidget(btn_apply)
        inner.addWidget(apply_group)

        # ── Snapshots ─────────────────────────────────────────────────────
        snap_group = QGroupBox("SNAPSHOTS")
        snap_layout = QVBoxLayout(snap_group)
        snap_layout.setContentsMargins(6, 14, 6, 6)
        snap_layout.setSpacing(4)
        lbl = QLabel("~/mccb_snapshots/")
        lbl.setStyleSheet("font-size: 10px; color: #444444;")
        lbl.setWordWrap(True)
        snap_layout.addWidget(lbl)
        btn_open = QPushButton("OPEN FOLDER")
        btn_open.setFixedHeight(32)
        btn_open.setStyleSheet("""
            QPushButton {
                background-color: #FFFFFF;
                color: #000000;
                border: 2px solid #000000;
                border-radius: 0px;
                font-weight: 700;
                font-size: 11px;
                letter-spacing: 1px;
            }
            QPushButton:hover {
                background-color: #FF3000;
                color: #FFFFFF;
                border-color: #FF3000;
            }
            QPushButton:pressed {
                background-color: #CC2000;
                color: #FFFFFF;
            }
        """)
        btn_open.clicked.connect(self._open_dir)
        snap_layout.addWidget(btn_open)
        inner.addWidget(snap_group)

        inner.addStretch(1)

        scroll.setWidget(inner_widget)
        layout.addWidget(scroll, stretch=1)

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
        self._tiles     = []
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
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
            tile   = CameraTile(well_index=i, camera_id=cam_id)
            self._tiles.append(tile)
            row, col = divmod(i, 2)
            grid.addWidget(tile, row, col)

        for r in range(2):
            grid.setRowStretch(r, 1)
        for c in range(2):
            grid.setColumnStretch(c, 1)

        grid_container = QWidget()
        grid_container.setLayout(grid)
        grid_container.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        grid_container.setMinimumSize(0, 0)
        body.addWidget(grid_container, stretch=1)

        self.settings_panel = CameraSettingsPanel()
        self.settings_panel.settings_changed.connect(self._apply_settings)
        body.addWidget(self.settings_panel, stretch=0)

        root.addLayout(body, stretch=1)

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
    win.resize(1280, 800)

    layout = QVBoxLayout(win)
    layout.setContentsMargins(0, 0, 0, 0)

    viewer = CameraViewerWidget(num_wells=4)
    layout.addWidget(viewer)

    win.showFullScreen()

    app.aboutToQuit.connect(viewer.stop_all)
    sys.exit(app.exec_())