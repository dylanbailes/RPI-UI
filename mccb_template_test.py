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

# =============================================
# SWISS INTERNATIONAL STYLE QSS (Design Tokens)
# =============================================
SWISS_QSS = """
/* 1. Global Reset & Typography */
QWidget {
    font-family: "Inter", "Helvetica", "Arial", sans-serif;
    font-size: 14px;
    color: #000000;
    background-color: #FFFFFF;
}

/* 2. The Grid as Law: Thick, visible borders, 0px radius */
QGroupBox, QFrame, QScrollArea {
    border: 2px solid #000000;
    border-radius: 0px;
    background-color: #FFFFFF;
}

QGroupBox::title {
    subcontrol-origin: margin;
    subcontrol-position: top left;
    padding: 4px 12px;
    background-color: #000000;
    color: #FFFFFF;
    font-weight: 700;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 2px;
}

/* 3. Pattern-Based Texture: Subtle 24px Grid on Muted Backgrounds */
QWidget[variant="muted"] {
    background-color: #F2F2F2;
    background-image: 
        linear-gradient(#E0E0E0 1px, transparent 1px),
        linear-gradient(90deg, #E0E0E0 1px, transparent 1px);
    background-size: 24px 24px;
}

/* 4. Typography Roles */
QLabel {
    background-color: transparent;
}
QLabel[role="heading"] {
    font-size: 28px;
    font-weight: 900;
    text-transform: uppercase;
    letter-spacing: 1px;
}
QLabel[role="section-number"] {
    color: #FF3000;
    font-weight: 900;
    font-size: 14px;
    letter-spacing: 3px;
    text-transform: uppercase;
}

/* 5. Buttons: Brutalist, Rectangular, Instant Feedback */
QPushButton {
    background-color: #000000;
    color: #FFFFFF;
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 12px 24px;
    font-weight: 700;
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 1px;
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

/* 6. Inputs: Sharp, High-Contrast */
QLineEdit, QComboBox {
    background-color: #FFFFFF;
    border: 2px solid #000000;
    border-radius: 0px;
    padding: 10px 12px;
    font-weight: 500;
    font-size: 16px;
    selection-background-color: #FF3000;
    selection-color: #FFFFFF;
}
QLineEdit:focus, QComboBox:focus {
    border-color: #FF3000;
}
QLineEdit[readonly="true"] {
    background-color: #F2F2F2;
    color: #000000;
}

/* 7. Tabs */
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
    padding: 12px 24px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-right: 2px;
}
QTabBar::tab:selected {
    background-color: #000000;
    color: #FFFFFF;
}
QTabBar::tab:hover:!selected {
    background-color: #FFFFFF;
}

/* 8. Scrollbars: Minimalist & Geometric */
QScrollBar:vertical {
    border: none;
    background: #F2F2F2;
    width: 12px;
    margin: 0px;
}
QScrollBar::handle:vertical {
    background: #000000;
    min-height: 20px;
    border-radius: 0px;
}
QScrollBar::handle:vertical:hover {
    background: #FF3000;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0px;
}

/* 9. Text Edit (Log) */
QTextEdit {
    border: 2px solid #000000;
    border-radius: 0px;
    background-color: #000000;
    color: #00FF00; /* Classic terminal green for raw data contrast, or use #FFFFFF */
    font-family: "Monospace", "Courier New", monospace;
    font-size: 12px;
    padding: 8px;
}
"""

# =============================================
# Safety limits
# =============================================
MAX_EFIELD = 1.5    # V/cm
MAX_MAG    = 15.0   # Gauss
BAUDRATE   = 115200

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
# Numpad dialog (Swiss Styled)
# =============================================
class NumpadDialog(QDialog):
    def __init__(self, parent=None, current=""):
        super().__init__(parent)
        self.setWindowTitle("ENTER VALUE")
        self.setModal(True)
        self.setMinimumWidth(280)
        self._value = current

        layout = QVBoxLayout()
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(12)

        self.display = QLineEdit(current)
        self.display.setReadOnly(True)
        self.display.setAlignment(Qt.AlignRight)
        self.display.setFont(QFont("Monospace", 24, QFont.Bold))
        self.display.setFixedHeight(60)
        layout.addWidget(self.display)

        grid = QGridLayout()
        grid.setSpacing(8)

        buttons = [
            ('7', 0, 0), ('8', 0, 1), ('9', 0, 2),
            ('4', 1, 0), ('5', 1, 1), ('6', 1, 2),
            ('1', 2, 0), ('2', 2, 1), ('3', 2, 2),
            ('.',  3, 0), ('0', 3, 1), ('⌫', 3, 2),
        ]
        for (label, row, col) in buttons:
            btn = QPushButton(label)
            btn.setFixedSize(72, 60)
            btn.setFont(QFont("Inter", 18, QFont.Bold))
            if label == '⌫':
                btn.setProperty("variant", "secondary")
            btn.clicked.connect(lambda _, l=label: self._on_key(l))
            grid.addWidget(btn, row, col)

        layout.addLayout(grid)

        row_btns = QHBoxLayout()
        row_btns.setSpacing(8)
        cancel = QPushButton("Cancel")
        cancel.setProperty("variant", "secondary")
        ok     = QPushButton("Confirm")
        ok.setDefault(True)
        
        cancel.clicked.connect(self.reject)
        ok.clicked.connect(self.accept)
        
        row_btns.addWidget(cancel)
        row_btns.addWidget(ok)
        layout.addLayout(row_btns)

        self.setLayout(layout)

    def _on_key(self, label):
        if label == '⌫':
            self._value = self._value[:-1]
        elif label == '.' and '.' in self._value:
            return
        else:
            self._value += label
        self.display.setText(self._value)

    @staticmethod
    def get_value(parent, current=""):
        dlg = NumpadDialog(parent, current)
        if dlg.exec_() == QDialog.Accepted:
            return dlg._value
        return None


# =============================================
# NumpadLineEdit with real-time validation
# =============================================
class NumpadLineEdit(QLineEdit):
    def __init__(self, min_val=0.0, max_val=100.0, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.min_val = min_val
        self.max_val = max_val
        self.setReadOnly(True)
        self.setCursor(Qt.PointingHandCursor)
        self.textChanged.connect(self._validate_style)

    def _validate_style(self, text):
        text = text.strip()
        if not text or text == '.':
            self.setStyleSheet("color: #FF3000; font-weight: bold;")  # Swiss Red for incomplete
            return
        try:
            val = float(text)
            if self.min_val <= val <= self.max_val:
                self.setStyleSheet("color: #000000; font-weight: 900;")  # Pure Black for valid
            else:
                self.setStyleSheet("color: #FF3000; font-weight: 900;")  # Swiss Red for out of range
        except ValueError:
            self.setStyleSheet("color: #FF3000;")  # Swiss Red for invalid

    def mousePressEvent(self, event):
        val = NumpadDialog.get_value(self.window(), self.text())
        if val is not None:
            self.setText(val)


# =============================================
# Continuous sensor log widget
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

        # Header with muted grid background
        hdr_frame = QFrame()
        hdr_frame.setProperty("variant", "muted")
        hdr = QHBoxLayout(hdr_frame)
        hdr.setContentsMargins(12, 8, 12, 8)
        
        lbl = QLabel(f"LIVE FEED // {device_label.upper()}")
        lbl.setFont(QFont("Inter", 12, QFont.Bold))
        lbl.setStyleSheet("letter-spacing: 2px;")
        hdr.addWidget(lbl)
        
        hdr.addStretch()
        
        self.pause_btn = QPushButton("Pause")
        self.pause_btn.setProperty("variant", "secondary")
        self.pause_btn.setCheckable(True)
        self.pause_btn.setFixedSize(80, 32)
        self.pause_btn.clicked.connect(self._toggle_pause)
        
        clear_btn = QPushButton("Clear")
        clear_btn.setProperty("variant", "secondary")
        clear_btn.setFixedSize(80, 32)
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
# Device connection panel
# =============================================
class DeviceConnectPanel(QWidget):
    connected = pyqtSignal(dict)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout()
        layout.setContentsMargins(40, 40, 40, 40)
        layout.setSpacing(24)

        # Section Number
        sec_num = QLabel("01. CONNECTION")
        sec_num.setProperty("role", "section-number")
        layout.addWidget(sec_num)

        # Heading
        title = QLabel("ASSIGN SERIAL DEVICES")
        title.setProperty("role", "heading")
        layout.addWidget(title)

        # Muted background container for form
        form_container = QFrame()
        form_container.setProperty("variant", "muted")
        form_layout = QVBoxLayout(form_container)
        form_layout.setContentsMargins(24, 24, 24, 24)
        form_layout.setSpacing(16)

        self.devices = detect_serial_devices()
        port_options = ["(NONE)"] + list(self.devices.values())

        form = QFormLayout()
        form.setLabelAlignment(Qt.AlignLeft)
        form.setFormAlignment(Qt.AlignLeft)
        form.setSpacing(16)

        # Custom styling for form labels
        form_label_style = "font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-size: 12px;"

        self.combo_electrode = QComboBox()
        self.combo_electrode.addItems(port_options)
        form.addRow("<span style='" + form_label_style + "'>Electrode ESP32:</span>", self.combo_electrode)

        self.combo_magnet = QComboBox()
        self.combo_magnet.addItems(port_options)
        form.addRow("<span style='" + form_label_style + "'>Electromagnet ESP32:</span>", self.combo_magnet)

        form_layout.addLayout(form)
        layout.addWidget(form_container)

        self.refresh_btn = QPushButton("↺ Refresh Ports")
        self.refresh_btn.setProperty("variant", "secondary")
        self.refresh_btn.setFixedWidth(200)
        self.refresh_btn.clicked.connect(self._refresh)
        layout.addWidget(self.refresh_btn)

        note = QLabel(
            "Plug in one device at a time if unsure which port is which.\n"
            "ESP32s typically appear as CP210x or CH340."
        )
        note.setWordWrap(True)
        note.setStyleSheet("color: #666666; font-size: 12px;")
        layout.addWidget(note)

        layout.addStretch()

        connect_btn = QPushButton("Connect & Continue")
        connect_btn.setFixedHeight(56)
        connect_btn.setFont(QFont("Inter", 14, QFont.Bold))
        connect_btn.clicked.connect(self._on_connect)
        layout.addWidget(connect_btn)

        self.setLayout(layout)

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
        
        if e_port != "(NONE)" and m_port != "(NONE)" and e_port == m_port:
            QMessageBox.warning(self, "PORT CONFLICT", 
                "You cannot assign the same serial port to both roles.")
            return

        result = {}
        if e_port != "(NONE)":
            result["electrode"] = e_port
        if m_port != "(NONE)":
            result["magnet"] = m_port
            
        if not result:
            QMessageBox.warning(self, "NO DEVICE", "Please select at least one device.")
            return
            
        self.connected.emit(result)


# =============================================
# Main application window
# =============================================
class MCCB_UI(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MCCB CONTROLLER")
        self.setGeometry(100, 100, 800, 600)

        self.serial_threads = {}
        self.log_widgets    = {}
        self.stack = QStackedLayout()

        self.connect_panel = DeviceConnectPanel()
        self.connect_panel.connected.connect(self._on_devices_connected)
        self.stack.addWidget(self.connect_panel)

        container = QWidget()
        container.setLayout(self.stack)
        root = QVBoxLayout()
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(container)
        self.setLayout(root)

    def _on_devices_connected(self, port_map):
        for role, port in port_map.items():
            thread = SerialThread(port, BAUDRATE, device_label=role)
            log_w  = SensorLogWidget(role)
            
            thread.received.connect(lambda obj, r=role: self._on_json(r, obj))
            thread.raw_line.connect(lambda line, r=role: self.log_widgets[r].append(line))
            thread.error.connect(self.on_serial_error)
            thread.connection_lost.connect(lambda r=role: self._on_conn_lost(r))
            
            thread.start()
            self.serial_threads[role] = thread
            self.log_widgets[role]    = log_w

        self._build_main_ui()
        self.stack.setCurrentIndex(1)

    def _build_main_ui(self):
        main = QWidget()
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        tabs = QTabWidget()
        tabs.setDocumentMode(True)

        # ---- Control tab ----
        ctrl = QWidget()
        ctrl_layout = QVBoxLayout()
        ctrl_layout.setContentsMargins(32, 32, 32, 32)
        ctrl_layout.setSpacing(24)

        sec_num = QLabel("02. STIMULATION")
        sec_num.setProperty("role", "section-number")
        ctrl_layout.addWidget(sec_num)

        title = QLabel("MCCB STIMULATION CONTROL")
        title.setProperty("role", "heading")
        ctrl_layout.addWidget(title)

        mode_box = QGroupBox("SELECT MODE")
        mb = QVBoxLayout()
        mb.setSpacing(12)
        for label, mode in [
            ("ELECTRIC CURRENT",         "electric"),
            ("MAGNETIC FIELD",           "magnetic"),
            ("DUAL: ELECTRIC + MAGNETIC","dual"),
        ]:
            btn = QPushButton(label)
            btn.setFixedHeight(56)
            btn.setFont(QFont("Inter", 14, QFont.Bold))
            btn.clicked.connect(lambda _, m=mode: self._open_mode(m))
            mb.addWidget(btn)
        mode_box.setLayout(mb)
        ctrl_layout.addWidget(mode_box)
        ctrl_layout.addStretch()

        ctrl.setLayout(ctrl_layout)
        tabs.addTab(ctrl, "CONTROL")

        # ---- Live sensor tabs ----
        for role, log_w in self.log_widgets.items():
            tabs.addTab(log_w, f"SENSORS // {role.upper()}")

        layout.addWidget(tabs)
        main.setLayout(layout)
        self.stack.addWidget(main)

    def _open_mode(self, mode):
        dlg = ModeDialog(mode, self.serial_threads, self.log_widgets, self)
        dlg.exec_()

    def _on_json(self, role, obj):
        if 'well' in obj:
            try:
                self.log_widgets[role].latest[int(obj['well'])] = obj
            except (ValueError, TypeError):
                pass

    def _on_conn_lost(self, role):
        QMessageBox.critical(self, "CONNECTION LOST",
                             f"Serial connection to '{role.upper()}' was lost.")

    def on_serial_error(self, msg):
        QMessageBox.warning(self, "SERIAL ERROR", msg)

    def closeEvent(self, e):
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

        self.setWindowTitle(self._mode_label().upper())
        self.setMinimumSize(550, 600)

        layout = QVBoxLayout()
        layout.setContentsMargins(24, 24, 24, 24)
        layout.setSpacing(20)

        sec_num = QLabel("03. PARAMETERS")
        sec_num.setProperty("role", "section-number")
        layout.addWidget(sec_num)

        title = QLabel(self._mode_label())
        title.setProperty("role", "heading")
        layout.addWidget(title)

        # ---- Well input boxes ----
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        wells_layout = QVBoxLayout()
        wells_layout.setSpacing(16)
        self.inputs = []

        for i in range(1, 5):
            gb = QGroupBox(f"WELL {i}")
            form = QFormLayout()
            form.setLabelAlignment(Qt.AlignLeft)
            form.setFormAlignment(Qt.AlignLeft)
            form.setSpacing(12)

            e_input = None
            m_input = None

            if mode in ("electric", "dual"):
                e_input = NumpadLineEdit(min_val=0.0, max_val=MAX_EFIELD)
                e_input.setPlaceholderText(f"0 – {MAX_EFIELD} V/CM")
                form.addRow("<span style='font-weight:600;'>ELECTRIC (V/CM):</span>", e_input)

            if mode in ("magnetic", "dual"):
                m_input = NumpadLineEdit(min_val=0.0, max_val=MAX_MAG)
                m_input.setPlaceholderText(f"0 – {MAX_MAG} GAUSS")
                form.addRow("<span style='font-weight:600;'>MAGNETIC (GAUSS):</span>", m_input)

            gb.setLayout(form)
            wells_layout.addWidget(gb)
            self.inputs.append({"electric": e_input, "magnetic": m_input})

        inner.setLayout(wells_layout)
        scroll.setWidget(inner)
        layout.addWidget(scroll)

        # ---- Live readings display ----
        self.live_label = QLabel("LIVE READINGS: WAITING FOR DATA…")
        self.live_label.setWordWrap(True)
        self.live_label.setStyleSheet("""
            font-family: "Monospace", "Courier New", monospace;
            font-size: 12px; 
            color: #000000;
            background-color: #F2F2F2;
            border: 2px solid #000000;
            padding: 12px;
        """)
        layout.addWidget(self.live_label)

        # Timer to refresh live readings
        self.live_timer = QTimer(self)
        self.live_timer.timeout.connect(self._refresh_live)
        self.live_timer.start(1000)

        # ---- Buttons ----
        btn_row = QHBoxLayout()
        btn_row.setSpacing(12)
        
        back = QPushButton("BACK")
        back.setProperty("variant", "secondary")
        back.setFixedHeight(48)
        back.clicked.connect(self.reject)
        
        self.apply_btn = QPushButton("APPLY PARAMETERS")
        self.apply_btn.setFixedHeight(48)
        self.apply_btn.setFont(QFont("Inter", 14, QFont.Bold))
        self.apply_btn.clicked.connect(self._apply)
        
        btn_row.addWidget(back)
        btn_row.addWidget(self.apply_btn)
        layout.addLayout(btn_row)

        self.setLayout(layout)

    def _mode_label(self):
        return {
            "electric": "Electric Current",
            "magnetic": "Magnetic Field",
            "dual":     "Dual: Electric + Magnetic",
        }[self.mode]

    def _refresh_live(self):
        lines = []
        for role, log_w in self.log_widgets.items():
            if not log_w.latest:
                lines.append(f"[{role.upper()}] NO DATA YET")
                continue
            
            for well, data in sorted(log_w.latest.items()):
                parts = [f"WELL {well}"]
                for key in ("busVoltage_V", "current_mA", "drv_current_mA",
                            "shunt_mV", "power_mW", "actualElectrodeVoltage_V"):
                    if key in data:
                        val = data[key]
                        if isinstance(val, (int, float)):
                            parts.append(f"{key.upper()}={val:.3f}")
                        else:
                            parts.append(f"{key.upper()}={val}")
                lines.append(f"  > " + "  |  ".join(parts))
        
        if lines:
            self.live_label.setText("\n".join(lines))
        else:
            self.live_label.setText("LIVE READINGS: WAITING FOR DATA…")

    def _apply(self):
        if self.is_applying:
            return
        self.is_applying = True
        self.apply_btn.setEnabled(False)
        self.apply_btn.setText("SENDING...")

        errors   = []
        commands = []

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
                    except ValueError:
                        errors.append(f"WELL {i} MAGNETIC: INVALID NUMBER.")

        if errors:
            QMessageBox.warning(self, "VALIDATION ERROR", "\n".join(errors))
            self._reset_apply_button()
            return

        for role, cmd in commands:
            if role in self.serial_threads:
                self.serial_threads[role].send(cmd)
            else:
                QMessageBox.warning(self, "DEVICE NOT CONNECTED",
                                    f"NO '{role.upper()}' DEVICE IS CONNECTED.")
                self._reset_apply_button()
                return

        QMessageBox.information(self, "COMMANDS SENT",
                                f"{len(commands)} COMMAND(S) TRANSMITTED.\n"
                                "LIVE READINGS PANEL WILL UPDATE AUTOMATICALLY.")
        
        self._reset_apply_button()

    def _reset_apply_button(self):
        self.is_applying = False
        self.apply_btn.setEnabled(True)
        self.apply_btn.setText("APPLY PARAMETERS")


# =============================================
# Entry point
# =============================================
if __name__ == "__main__":
    app = QApplication(sys.argv)
    
    # Apply the Swiss International Style globally
    app.setStyleSheet(SWISS_QSS)
    
    window = MCCB_UI()
    window.show()
    sys.exit(app.exec_())