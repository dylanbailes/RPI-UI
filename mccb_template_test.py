import sys
import time
import json
import serial
import serial.tools.list_ports

from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QVBoxLayout, QHBoxLayout, QLabel,
    QStackedLayout, QLineEdit, QGroupBox, QMessageBox, QSizePolicy,
    QFormLayout, QDialog, QGridLayout, QScrollArea, QTabWidget,
    QTextEdit, QComboBox, QFrame
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt5.QtGui import QFont

from camera_viewer import CameraViewerWidget

# =============================================
# SWISS INTERNATIONAL STYLE QSS
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

QScrollArea {
    border: none;
    background-color: transparent;
}
QScrollArea > QWidget > QWidget {
    background-color: transparent;
}

QWidget[variant="muted"] {
    background-color: #F2F2F2;
}

QLabel {
    background-color: transparent;
}
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
QPushButton:hover {
    background-color: #FF3000;
    border-color: #FF3000;
}
QPushButton:pressed {
    background-color: #000000;
    color: #FF3000;
}
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

QLineEdit, QComboBox {
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
QLineEdit:focus, QComboBox:focus {
    border-color: #FF3000;
}

QTabWidget::pane {
    border: 2px solid #000000;
    border-radius: 0px;
    top: -2px;
    background-color: #FFFFFF;
}
QTabBar::tab {
    background-color: #F2F2F2;
    border: 2px solid #000000;
    border-bottom: none;
    border-radius: 0px;
    padding: 14px 36px; 
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-right: 4px;
    min-height: 52px;
    min-width: 240px; 
}
QTabBar::tab:selected {
    background-color: #000000;
    color: #FFFFFF;
}
QTabBar::tab:hover:!selected {
    background-color: #FFFFFF;
}

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
QScrollBar::handle:vertical:hover {
    background: #FF3000;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0px;
}

QTextEdit {
    border: 2px solid #000000;
    border-radius: 0px;
    background-color: #000000;
    color: #00FF00;
    font-family: "Monospace", "Courier New", monospace;
    font-size: 13px;
    padding: 12px;
}
"""

# =============================================
# Safety limits
# =============================================
MAX_EFIELD = 1.5    # V/cm
MAX_MAG    = 15.0   # Gauss
BAUDRATE   = 115200

# =============================================
# RPi-Compatible Message Box Helper
# =============================================
def show_message(parent, title, text, icon=QMessageBox.Warning, 
                 buttons=QMessageBox.Ok, auto_close_ms=0):
    msg = QMessageBox(parent)
    msg.setWindowFlags(Qt.Dialog | Qt.WindowStaysOnTopHint)
    msg.setIcon(icon)
    msg.setWindowTitle(title)
    msg.setText(text)
    msg.setStandardButtons(buttons)
    if auto_close_ms > 0:
        QTimer.singleShot(auto_close_ms, msg.accept)
    return msg.exec_()

# =============================================
# Device auto-detection
# =============================================
def detect_serial_devices():
    found = {}
    ports = serial.tools.list_ports.comports()
    for p in ports:
        desc = (p.description or "").lower()
        mfg  = (p.manufacturer or "").lower()
        is_esp = any(kw in desc or kw in mfg for kw in [
            "cp210", "ch340", "ch341", "ftdi", "esp32", "uart", "silicon labs"
        ])
        tag = "ESP32" if is_esp else "Unknown"
        label = f"{tag} — {p.device} ({p.description})"
        found[label] = p.device
    return found

# =============================================
# Serial thread
# =============================================
class SerialThread(QThread):
    received        = pyqtSignal(dict)
    raw_line        = pyqtSignal(str)
    error           = pyqtSignal(str)
    connection_lost = pyqtSignal()

    def __init__(self, port, baud=BAUDRATE, device_label=""):
        super().__init__()
        self.port         = port
        self.baud         = baud
        self.device_label = device_label
        self._running     = True
        self._ser         = None
        self._write_queue = []

    def run(self):
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.1)
        except Exception as e:
            self.error.emit(f"[{self.device_label}] Open error: {e}")
            return

        buf = ""
        while self._running:
            while self._write_queue:
                obj = self._write_queue.pop(0)
                try:
                    self._ser.write((json.dumps(obj) + '\n').encode())
                except Exception as e:
                    self.error.emit(f"[{self.device_label}] Write error: {e}")

            try:
                data = self._ser.read(512).decode(errors='ignore')
            except Exception:
                self.connection_lost.emit()
                break

            if data:
                buf += data
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue
                    self.raw_line.emit(line)
                    try:
                        obj = json.loads(line)
                        self.received.emit(obj)
                    except Exception:
                        pass
            self.msleep(10)

        try:
            self._ser.close()
        except Exception:
            pass

    def send(self, obj):
        if not self._running:
            return
        self._write_queue.append(obj)

    def stop(self):
        self._running = False
        self.wait()

# =============================================
# Touch-Friendly Docked Numpad Widget
# =============================================
class TouchNumpadWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.active_input = None
        
        layout = QVBoxLayout()
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)
        
        self.status_label = QLabel("TAP A FIELD TO EDIT")
        self.status_label.setAlignment(Qt.AlignCenter)
        self.status_label.setFont(QFont("Inter", 14, QFont.Bold))
        self.status_label.setStyleSheet("color: #666666; letter-spacing: 1px;")
        layout.addWidget(self.status_label)
        
        self.display = QLineEdit()
        self.display.setReadOnly(True)
        self.display.setAlignment(Qt.AlignRight)
        self.display.setFont(QFont("Monospace", 32, QFont.Bold))
        self.display.setFixedHeight(80)
        self.display.setStyleSheet("border: 2px solid #000000; background-color: #F2F2F2;")
        layout.addWidget(self.display)
        
        grid = QGridLayout()
        grid.setSpacing(12)
        buttons = [
            ('7', 0, 0), ('8', 0, 1), ('9', 0, 2),
            ('4', 1, 0), ('5', 1, 1), ('6', 1, 2),
            ('1', 2, 0), ('2', 2, 1), ('3', 2, 2),
            ('.',  3, 0), ('0', 3, 1), ('⌫', 3, 2),
        ]
        for (label, row, col) in buttons:
            btn = QPushButton(label)
            btn.setMinimumSize(80, 70)
            btn.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
            btn.setFont(QFont("Inter", 22, QFont.Bold))
            if label == '⌫':
                btn.setProperty("variant", "secondary")
            btn.clicked.connect(lambda _, l=label: self._on_key(l))
            grid.addWidget(btn, row, col)
        layout.addLayout(grid)
        
        row_btns = QHBoxLayout()
        row_btns.setSpacing(12)
        
        clear_btn = QPushButton("CLEAR")
        clear_btn.setProperty("variant", "secondary")
        clear_btn.setMinimumHeight(56)
        clear_btn.clicked.connect(self._clear)
        
        confirm_btn = QPushButton("CONFIRM")
        confirm_btn.setMinimumHeight(56)
        confirm_btn.setFont(QFont("Inter", 15, QFont.Bold))
        confirm_btn.clicked.connect(self._confirm)
        
        row_btns.addWidget(clear_btn)
        row_btns.addWidget(confirm_btn)
        layout.addLayout(row_btns)
        
        self.setLayout(layout)

    def set_active_input(self, input_widget):
        if self.active_input:
            self.active_input.set_active(False)
        self.active_input = input_widget
        if self.active_input:
            self.active_input.set_active(True)
            self.display.setText(self.active_input.text())
            self.status_label.setText(f"EDITING: {self.active_input.field_name.upper()}")
            self.status_label.setStyleSheet("color: #FF3000; font-weight: 900;")
            self.display.setStyleSheet("border: 3px solid #FF3000; background-color: #FFFFFF;")
        else:
            self.display.setText("")
            self.status_label.setText("TAP A FIELD TO EDIT")
            self.status_label.setStyleSheet("color: #666666; font-weight: 700;")
            self.display.setStyleSheet("border: 2px solid #000000; background-color: #F2F2F2;")
            
    def _on_key(self, label):
        if not self.active_input:
            return
        current = self.display.text()
        if label == '⌫':
            current = current[:-1]
        elif label == '.' and '.' in current:
            return
        else:
            current += label
        self.display.setText(current)
        self.active_input.setText(current)
        
    def _clear(self):
        if not self.active_input:
            return
        self.display.setText("")
        self.active_input.setText("")
        
    def _confirm(self):
        if self.active_input:
            self.active_input.set_active(False)
            self.active_input = None
            self.display.setText("")
            self.status_label.setText("TAP A FIELD TO EDIT")
            self.status_label.setStyleSheet("color: #666666; font-weight: 700;")
            self.display.setStyleSheet("border: 2px solid #000000; background-color: #F2F2F2;")

# =============================================
# NumpadLineEdit
# =============================================
class NumpadLineEdit(QLineEdit):
    activated = pyqtSignal(object)

    def __init__(self, field_name, min_val=0.0, max_val=100.0, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.field_name = field_name
        self.min_val = min_val
        self.max_val = max_val
        self.setReadOnly(True)
        self.setCursor(Qt.PointingHandCursor)
        self._is_active = False
        self.textChanged.connect(self._validate_style)

    def set_active(self, active):
        self._is_active = active
        if active:
            self.setStyleSheet("border: 3px solid #FF3000; color: #000000; font-weight: 900; background-color: #FFF8F8;")
        else:
            self._validate_style(self.text())

    def _validate_style(self, text):
        if self._is_active:
            return
        text = text.strip()
        if not text or text == '.':
            self.setStyleSheet("border: 2px solid #000000; color: #FF3000; font-weight: bold;")
            return
        try:
            val = float(text)
            if self.min_val <= val <= self.max_val:
                self.setStyleSheet("border: 2px solid #000000; color: #000000; font-weight: 900;")
            else:
                self.setStyleSheet("border: 2px solid #000000; color: #FF3000; font-weight: 900;")
        except ValueError:
            self.setStyleSheet("border: 2px solid #000000; color: #FF3000;")

    def mousePressEvent(self, event):
        self.activated.emit(self)
        super().mousePressEvent(event)

# =============================================
# Sensor log widget
# =============================================
class SensorLogWidget(QWidget):
    def __init__(self, device_label, parent=None):
        super().__init__(parent)
        self.device_label = device_label
        self.latest       = {}
        self._paused      = False

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        hdr_frame = QFrame()
        hdr_frame.setProperty("variant", "muted")
        hdr = QHBoxLayout(hdr_frame)
        hdr.setContentsMargins(16, 12, 16, 12)
        
        lbl = QLabel(f"LIVE FEED // {device_label.upper()}")
        lbl.setFont(QFont("Inter", 12, QFont.Bold))
        lbl.setStyleSheet("letter-spacing: 2px;")
        hdr.addWidget(lbl)
        hdr.addStretch()
        
        self.pause_btn = QPushButton("Pause")
        self.pause_btn.setProperty("variant", "secondary")
        self.pause_btn.setCheckable(True)
        self.pause_btn.setMinimumWidth(120)
        self.pause_btn.setFixedHeight(44)
        self.pause_btn.clicked.connect(self._toggle_pause)
        
        clear_btn = QPushButton("Clear")
        clear_btn.setProperty("variant", "secondary")
        clear_btn.setMinimumWidth(120)
        clear_btn.setFixedHeight(44)
        clear_btn.clicked.connect(self._clear)
        
        hdr.addWidget(self.pause_btn)
        hdr.addWidget(clear_btn)
        layout.addWidget(hdr_frame)

        self.log = QTextEdit()
        self.log.setReadOnly(True)
        layout.addWidget(self.log)

        self.setLayout(layout)

    def append(self, line: str, obj: dict = None):
        if self._paused:
            return
        self.log.append(f"> {line}")
        doc = self.log.document()
        if doc.blockCount() > 500:
            cursor = self.log.textCursor()
            cursor.movePosition(cursor.Start)
            cursor.select(cursor.LineUnderCursor)
            cursor.removeSelectedText()
            cursor.deleteChar()
        if obj and 'well' in obj:
            try:
                self.latest[int(obj['well'])] = obj
            except (ValueError, TypeError):
                pass

    def _toggle_pause(self, checked):
        self._paused = checked
        self.pause_btn.setText("Resume" if checked else "Pause")

    def _clear(self):
        self.log.clear()
        self.latest = {}

# =============================================
# Device connection panel (Page 0)
# =============================================
class DeviceConnectPanel(QWidget):
    connected = pyqtSignal(dict)
    exit_requested = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(0, 0, 0, 0)
        
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        
        content_widget = QWidget()
        layout = QVBoxLayout(content_widget)
        layout.setContentsMargins(40, 40, 40, 40)
        layout.setSpacing(24)

        sec_num = QLabel("01. CONNECTION")
        sec_num.setProperty("role", "section-number")
        layout.addWidget(sec_num)

        title = QLabel("ASSIGN SERIAL DEVICES")
        title.setProperty("role", "heading")
        layout.addWidget(title)

        form_container = QFrame()
        form_container.setProperty("variant", "muted")
        form_layout = QVBoxLayout(form_container)
        form_layout.setContentsMargins(24, 24, 24, 24)
        form_layout.setSpacing(20)

        self.devices = detect_serial_devices()
        port_options = ["(NONE)"] + list(self.devices.values())

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft)
        form.setFormAlignment(Qt.AlignLeft)
        form.setSpacing(20)

        form_label_style = "font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-size: 14px;"

        self.combo_electrode = QComboBox()
        self.combo_electrode.addItems(port_options)
        form.addRow("<span style='" + form_label_style + "'>Electrode ESP32:</span>", self.combo_electrode)

        self.combo_magnet = QComboBox()
        self.combo_magnet.addItems(port_options)
        form.addRow("<span style='" + form_label_style + "'>Electromagnet ESP32:</span>", self.combo_magnet)

        form_layout.addLayout(form)
        layout.addWidget(form_container)

        note = QLabel(
            "Select the same port for both if using a single ESP32 for electric and magnetic control.\n"
            "ESP32s typically appear as CP210x or CH340."
        )
        note.setWordWrap(True)
        note.setStyleSheet("color: #666666; font-size: 13px;")
        layout.addWidget(note)

        self.refresh_btn = QPushButton("↺ Refresh Ports")
        self.refresh_btn.setProperty("variant", "secondary")
        self.refresh_btn.setMaximumWidth(240)
        self.refresh_btn.clicked.connect(self._refresh)
        layout.addWidget(self.refresh_btn)

        layout.addStretch()

        bottom_row = QHBoxLayout()
        bottom_row.setSpacing(16)
        
        exit_btn = QPushButton("EXIT APPLICATION")
        exit_btn.setFixedHeight(56)
        exit_btn.setStyleSheet("""
            QPushButton { background-color: #FF3000; color: #FFFFFF; border: 2px solid #FF3000; }
            QPushButton:hover { background-color: #000000; border-color: #000000; }
        """)
        exit_btn.clicked.connect(self.exit_requested.emit)
        bottom_row.addWidget(exit_btn)
        bottom_row.addStretch()
        
        connect_btn = QPushButton("Connect & Continue")
        connect_btn.setMinimumHeight(56)
        connect_btn.setFont(QFont("Inter", 16, QFont.Bold))
        connect_btn.clicked.connect(self._on_connect)
        bottom_row.addWidget(connect_btn)
        
        layout.addLayout(bottom_row)

        scroll.setWidget(content_widget)
        main_layout.addWidget(scroll)
        self.setLayout(main_layout)

    def _refresh(self):
        self.devices = detect_serial_devices()
        port_options = ["(NONE)"] + list(self.devices.values())
        for combo in (self.combo_electrode, self.combo_magnet):
            current = combo.currentText()
            combo.clear()
            combo.addItems(port_options)
            idx = combo.findText(current)
            if idx >= 0:
                combo.setCurrentIndex(idx)

    def _on_connect(self):
        e_port = self.combo_electrode.currentText()
        m_port = self.combo_magnet.currentText()
        result = {}
        if e_port != "(NONE)":
            result["electrode"] = e_port
        if m_port != "(NONE)":
            result["magnet"] = m_port
        if not result:
            show_message(self, "NO DEVICE",
                "Please select at least one device.",
                QMessageBox.Warning)
            return
        self.connected.emit(result)

# =============================================
# Main application window
# =============================================
class MCCB_UI(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MCCB CONTROLLER")
        self.resize(1280, 800)

        self.serial_threads = {}
        self.log_widgets    = {}
        self.camera_tab     = None
        self.stack = QStackedLayout()

        self.connect_panel = DeviceConnectPanel()
        self.connect_panel.connected.connect(self._on_devices_connected)
        self.connect_panel.exit_requested.connect(self._exit_app)
        self.stack.addWidget(self.connect_panel)

        container = QWidget()
        container.setLayout(self.stack)
        root = QVBoxLayout()
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(container)
        self.setLayout(root)

    def _on_devices_connected(self, port_map):
        for t in self.serial_threads.values():
            try: t.stop()
            except: pass
        self.serial_threads.clear()
        self.log_widgets.clear()

        unique_ports = {}
        for role, port in port_map.items():
            if port not in unique_ports:
                unique_ports[port] = []
            unique_ports[port].append(role)

        port_to_thread = {}
        for port, roles in unique_ports.items():
            label = roles[0] if len(roles) == 1 else "COMBINED"
            thread = SerialThread(port, BAUDRATE, device_label=label)
            log_w  = SensorLogWidget(label)
            thread.received.connect(lambda obj, l=label: self._on_json(l, obj))
            thread.raw_line.connect(lambda line, l=label: self.log_widgets[l].append(line))
            thread.error.connect(self.on_serial_error)
            thread.connection_lost.connect(lambda l=label: self._on_conn_lost(l))
            thread.start()
            port_to_thread[port] = thread
            self.log_widgets[label] = log_w

        for role, port in port_map.items():
            self.serial_threads[role] = port_to_thread[port]

        self._build_main_ui()
        self.stack.setCurrentIndex(1)

    def _build_main_ui(self):
        if self.stack.count() > 1:
            old_widget = self.stack.widget(1)
            self.stack.removeWidget(old_widget)
            old_widget.deleteLater()

        main = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # --- header ---
        header = QFrame()
        header.setStyleSheet("background-color: #FFFFFF; border-bottom: 4px solid #000000; border-top: none; border-left: none; border-right: none;")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(32, 16, 32, 16)
        
        title_lbl = QLabel("MCCB CONTROLLER")
        title_lbl.setFont(QFont("Inter", 20, QFont.Bold))
        title_lbl.setStyleSheet("color: #000000; letter-spacing: 2px; text-transform: uppercase; border: none;")
        header_layout.addWidget(title_lbl)
        header_layout.addStretch()
        
        reconfig_btn = QPushButton("RECONFIGURE PORTS")
        reconfig_btn.setProperty("variant", "secondary")
        reconfig_btn.setFixedHeight(48)
        reconfig_btn.clicked.connect(self._reconfigure_ports)
        header_layout.addWidget(reconfig_btn)
        
        exit_btn = QPushButton("EXIT APPLICATION")
        exit_btn.setFixedHeight(48)
        exit_btn.setStyleSheet("""
            QPushButton { background-color: #FF3000; color: #FFFFFF; border: 2px solid #FF3000; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;}
            QPushButton:hover { background-color: #000000; border-color: #000000; }
        """)
        exit_btn.clicked.connect(self._exit_app)
        header_layout.addWidget(exit_btn)
        layout.addWidget(header)

        # --- tabs ---
        tabs = QTabWidget()
        tabs.setDocumentMode(True)

        # CONTROL tab
        ctrl = QWidget()
        ctrl_layout = QVBoxLayout()
        ctrl_layout.setContentsMargins(40, 40, 40, 40)
        ctrl_layout.setSpacing(24)

        sec_num = QLabel("02. STIMULATION")
        sec_num.setProperty("role", "section-number")
        ctrl_layout.addWidget(sec_num)

        title = QLabel("MCCB STIMULATION CONTROL")
        title.setProperty("role", "heading")
        ctrl_layout.addWidget(title)

        mode_box = QGroupBox("SELECT MODE")
        mb = QVBoxLayout()
        mb.setSpacing(16)
        for label, mode in [
            ("ELECTRIC CURRENT",          "electric"),
            ("MAGNETIC FIELD",            "magnetic"),
            ("DUAL: ELECTRIC + MAGNETIC", "dual"),
        ]:
            btn = QPushButton(label)
            btn.setMinimumHeight(56)
            btn.setFont(QFont("Inter", 16, QFont.Bold))
            btn.clicked.connect(lambda _, m=mode: self._open_mode(m))
            mb.addWidget(btn)
        mode_box.setLayout(mb)
        ctrl_layout.addWidget(mode_box)
        ctrl_layout.addStretch()
        ctrl.setLayout(ctrl_layout)
        tabs.addTab(ctrl, "CONTROL")

        # SENSORS tabs
        for label, log_w in self.log_widgets.items():
            tabs.addTab(log_w, f"SENSORS // {label.upper()}")

        # IMAGING tab
        self.camera_tab = CameraViewerWidget(num_wells=4)
        tabs.addTab(self.camera_tab, "IMAGING")

        layout.addWidget(tabs, 1)
        main.setLayout(layout)
        self.stack.addWidget(main)

    def _reconfigure_ports(self):
        if self.camera_tab:
            try:
                self.camera_tab.stop_all()
            except Exception:
                pass
        for t in self.serial_threads.values():
            try: t.stop()
            except: pass
        self.serial_threads.clear()
        self.log_widgets.clear()
        self.stack.setCurrentIndex(0)

    def _exit_app(self):
        if self.camera_tab:
            try:
                self.camera_tab.stop_all()
            except Exception:
                pass
        for t in self.serial_threads.values():
            try: t.stop()
            except: pass
        QApplication.instance().quit()

    def _open_mode(self, mode):
        dlg = ModeDialog(mode, self.serial_threads, self.log_widgets, self)
        dlg.exec_()

    def _on_json(self, label, obj):
        if 'well' in obj:
            try:
                self.log_widgets[label].latest[int(obj['well'])] = obj
            except (ValueError, TypeError):
                pass

    def _on_conn_lost(self, label):
        show_message(self, "CONNECTION LOST",
                     f"Serial connection to '{label.upper()}' was lost.",
                     QMessageBox.Critical)

    def on_serial_error(self, msg):
        show_message(self, "SERIAL ERROR", msg, QMessageBox.Warning)

    def closeEvent(self, e):
        if self.camera_tab:
            try:
                self.camera_tab.stop_all()
            except Exception:
                pass
        for t in self.serial_threads.values():
            try:
                t.stop()
            except Exception:
                pass
        e.accept()

# =============================================
# Mode dialog
# =============================================
class ModeDialog(QDialog):
    def __init__(self, mode, serial_threads, log_widgets, parent=None):
        super().__init__(parent)
        self.mode           = mode
        self.serial_threads = serial_threads
        self.log_widgets    = log_widgets
        self.is_applying    = False
        self._positioned    = False

        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)
        self.setWindowTitle(self._mode_label().upper())
        self.resize(1150, 740)

        main_layout = QVBoxLayout()
        main_layout.setContentsMargins(24, 24, 24, 24)
        main_layout.setSpacing(20)

        sec_num = QLabel("03. PARAMETERS")
        sec_num.setProperty("role", "section-number")
        main_layout.addWidget(sec_num)

        title = QLabel(self._mode_label())
        title.setProperty("role", "heading")
        main_layout.addWidget(title)

        split_layout = QHBoxLayout()
        split_layout.setSpacing(24)
        split_layout.setAlignment(Qt.AlignTop)

        left_widget = QWidget()
        left_layout = QVBoxLayout(left_widget)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(16)
        
        wells_grid = QGridLayout()
        wells_grid.setSpacing(16)
        self.inputs = []

        for i in range(1, 5):
            gb = QGroupBox(f"WELL {i}")
            form = QFormLayout()
            form.setContentsMargins(0, 4, 0, 4)
            form.setLabelAlignment(Qt.AlignLeft)
            form.setFormAlignment(Qt.AlignLeft)
            form.setSpacing(8)
            form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)

            e_input = None
            m_input = None

            if mode in ("electric", "dual"):
                e_input = NumpadLineEdit(f"Well {i} Electric", min_val=0.0, max_val=MAX_EFIELD)
                e_input.setPlaceholderText(f"0 – {MAX_EFIELD} V/CM")
                e_input.setFixedHeight(44)
                e_input.activated.connect(self._on_input_activated)
                form.addRow("<span style='font-weight:700; font-size:13px;'>ELECTRIC (V/CM):</span>", e_input)

            if mode in ("magnetic", "dual"):
                m_input = NumpadLineEdit(f"Well {i} Magnetic", min_val=0.0, max_val=MAX_MAG)
                m_input.setPlaceholderText(f"0 – {MAX_MAG} GAUSS")
                m_input.setFixedHeight(44)
                m_input.activated.connect(self._on_input_activated)
                form.addRow("<span style='font-weight:700; font-size:13px;'>MAGNETIC (GAUSS):</span>", m_input)

            gb.setLayout(form)
            row = (i - 1) // 2
            col = (i - 1) % 2
            wells_grid.addWidget(gb, row, col)
            self.inputs.append({"electric": e_input, "magnetic": m_input})

        left_layout.addLayout(wells_grid)

        self.numpad = TouchNumpadWidget()
        self.numpad.setFixedWidth(380)
        
        split_layout.addWidget(left_widget, stretch=2)
        split_layout.addWidget(self.numpad, stretch=1)
        main_layout.addLayout(split_layout)

        btn_row = QHBoxLayout()
        btn_row.setSpacing(16)
        
        back = QPushButton("BACK")
        back.setProperty("variant", "secondary")
        back.setMinimumHeight(56)
        back.clicked.connect(self.reject)
        
        self.apply_btn = QPushButton("APPLY PARAMETERS")
        self.apply_btn.setMinimumHeight(56)
        self.apply_btn.setFont(QFont("Inter", 16, QFont.Bold))
        self.apply_btn.clicked.connect(self._apply)
        
        btn_row.addWidget(back)
        btn_row.addWidget(self.apply_btn)
        main_layout.addLayout(btn_row)

        self.setLayout(main_layout)

    def showEvent(self, event):
        super().showEvent(event)
        if not self._positioned:
            self._center_on_screen()
            self._positioned = True

    def _center_on_screen(self):
        screen = QApplication.primaryScreen()
        if screen:
            screen_geo = screen.availableGeometry()
            w = min(self.width(), screen_geo.width() - 80)
            h = min(self.height(), screen_geo.height() - 80)
            if w != self.width() or h != self.height():
                self.resize(w, h)
            x = screen_geo.x() + (screen_geo.width() - w) // 2
            y = screen_geo.y() + (screen_geo.height() - h) // 2
            self.move(x, y)

    def _on_input_activated(self, input_widget):
        self.numpad.set_active_input(input_widget)

    def _mode_label(self):
        return {
            "electric": "Electric Current",
            "magnetic": "Magnetic Field",
            "dual":     "Dual: Electric + Magnetic",
        }[self.mode]

    def _apply(self):
        self.numpad._confirm()
        if self.is_applying:
            return
        self.is_applying = True
        self.apply_btn.setEnabled(False)
        self.apply_btn.setText("SENDING...")

        errors   = []
        commands = []
        summary  = []

        for i, ent in enumerate(self.inputs, start=1):
            if ent["electric"] is not None:
                txt = ent["electric"].text().strip()
                if txt:
                    try:
                        v = float(txt)
                        if not (0.0 <= v <= MAX_EFIELD):
                            errors.append(f"WELL {i} E-FIELD OUT OF RANGE (0 - {MAX_EFIELD}).")
                        else:
                            commands.append(("electrode", {"cmd": "set", "well": i, "voltage": v}))
                            summary.append(f"Well {i} Electric: {v} V/cm")
                    except ValueError:
                        errors.append(f"WELL {i} E-FIELD: INVALID NUMBER.")

            if ent["magnetic"] is not None:
                txt = ent["magnetic"].text().strip()
                if txt:
                    try:
                        v = float(txt)
                        if not (0.0 <= v <= MAX_MAG):
                            errors.append(f"WELL {i} MAGNETIC OUT OF RANGE (0 - {MAX_MAG}).")
                        else:
                            commands.append(("magnet", {"cmd": "set", "well": i, "gauss": v}))
                            summary.append(f"Well {i} Magnetic: {v} Gauss")
                    except ValueError:
                        errors.append(f"WELL {i} MAGNETIC: INVALID NUMBER.")

        if errors:
            show_message(self, "VALIDATION ERROR", "\n".join(errors), QMessageBox.Warning)
            self._reset_apply_button()
            return

        for role, cmd in commands:
            if role in self.serial_threads:
                self.serial_threads[role].send(cmd)
            else:
                show_message(self, "DEVICE NOT CONNECTED",
                             f"NO '{role.upper()}' DEVICE IS CONNECTED.",
                             QMessageBox.Warning)
                self._reset_apply_button()
                return

        msg_text = f"✓ {len(commands)} COMMAND(S) TRANSMITTED.\n\n"
        if summary:
            msg_text += "VALUES SENT:\n" + "\n".join(summary) + "\n\n"
        msg_text += "Check the sensor tab for live readings."

        show_message(self, "SETTINGS APPLIED", msg_text,
                     QMessageBox.Information, auto_close_ms=2000)
        self._reset_apply_button()
        self.accept()

    def _reset_apply_button(self):
        self.is_applying = False
        self.apply_btn.setEnabled(True)
        self.apply_btn.setText("APPLY PARAMETERS")

# =============================================
# Entry point
# =============================================
if __name__ == "__main__":
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)
    
    app = QApplication(sys.argv)
    app.setStyleSheet(SWISS_QSS)
    
    window = MCCB_UI()
    window.showFullScreen()
    sys.exit(app.exec_())