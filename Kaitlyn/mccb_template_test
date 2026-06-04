import sys
import time
import json
import serial
from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QVBoxLayout, QHBoxLayout, QLabel,
    QStackedLayout, QLineEdit, QGroupBox, QMessageBox, QSizePolicy, QFormLayout
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal

# Safety limits (adjust if needed)
MAX_EFIELD = 5.0    # V/cm
MAX_MAG = 15.0      # Gauss

SERIAL_PORT = "/dev/ttyUSB0"  # adjust to your Pi device (e.g., /dev/ttyACM0)
BAUDRATE = 115200

class SerialThread(QThread):
    received = pyqtSignal(dict)
    error = pyqtSignal(str)

    def __init__(self, port=SERIAL_PORT, baud=BAUDRATE):
        super().__init__()
        self.port = port
        self.baud = baud
        self._running = True
        self._ser = None

    def run(self):
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.1)
        except Exception as e:
            self.error.emit(f"Serial open error: {e}")
            return

        buf = ""
        while self._running:
            try:
                data = self._ser.read(512).decode(errors='ignore')
            except Exception:
                data = ""
            if data:
                buf += data
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        self.received.emit(obj)
                    except Exception:
                        # ignore non-json lines
                        pass
            self.msleep(10)

        try:
            self._ser.close()
        except Exception:
            pass

    def send(self, obj):
        try:
            if not self._ser or not self._ser.is_open:
                # try to open temporarily
                self._ser = serial.Serial(self.port, self.baud, timeout=0.1)
            s = json.dumps(obj) + '\n'
            self._ser.write(s.encode())
        except Exception as e:
            self.error.emit(f"Serial send error: {e}")

    def stop(self):
        self._running = False
        self.wait()


class MCCB_UI_Template(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MCCB UI Template")
        self.setGeometry(100, 100, 600, 480)

        # Latest reports storage: well -> report dict
        self.latest_reports = {}

        # Main stacked layout to swap pages
        self.stack = QStackedLayout()
        self.init_home_page()
        self.init_mode_pages()

        container = QWidget()
        container.setLayout(self.stack)

        main_layout = QVBoxLayout()
        main_layout.addWidget(container)
        self.setLayout(main_layout)

        # Serial thread
        self.serial_thread = SerialThread(SERIAL_PORT, BAUDRATE)
        self.serial_thread.received.connect(self.on_serial_received)
        self.serial_thread.error.connect(self.on_serial_error)
        self.serial_thread.start()

    def init_home_page(self):
        home = QWidget()
        layout = QVBoxLayout()
        layout.setAlignment(Qt.AlignTop)

        title = QLabel("Home Screen")
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("font-size: 20px; font-weight: bold;")
        layout.addWidget(title)

        # Stimuli Mode section
        stimuli_box = QGroupBox("Stimuli Mode")
        sb_layout = QVBoxLayout()

        btn_e = QPushButton("Electric Current")
        btn_e.clicked.connect(lambda: self.enter_mode("electric"))
        btn_m = QPushButton("Magnetic Field")
        btn_m.clicked.connect(lambda: self.enter_mode("magnetic"))
        btn_dual = QPushButton("Dual: Electric + Magnetic")
        btn_dual.clicked.connect(lambda: self.enter_mode("dual"))

        for b in (btn_e, btn_m, btn_dual):
            b.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            sb_layout.addWidget(b)

        stimuli_box.setLayout(sb_layout)
        layout.addWidget(stimuli_box)

        home.setLayout(layout)
        self.stack.addWidget(home)

    def init_mode_pages(self):
        # Create three mode pages (electric, magnetic, dual)
        self.mode_pages = {}
        for mode in ("electric", "magnetic", "dual"):
            page = QWidget()
            v = QVBoxLayout()
            title = QLabel(f"Mode: {self.mode_label(mode)}")
            title.setAlignment(Qt.AlignCenter)
            title.setStyleSheet("font-size: 18px; font-weight: bold;")
            v.addWidget(title)

            wells_layout = QVBoxLayout()
            # Create one box per well (4 wells)
            self.mode_pages[mode] = {"widget": page, "inputs": []}
            for i in range(1, 5):
                gb = QGroupBox(f"Well {i}")
                form = QFormLayout()

                if mode in ("electric", "dual"):
                    e_input = QLineEdit()
                    e_input.setPlaceholderText(f"0 - {MAX_EFIELD} V/cm")
                    e_input.setObjectName(f"{mode}_well{i}_electric")
                    form.addRow("Electric (V/cm):", e_input)
                else:
                    e_input = None

                if mode in ("magnetic", "dual"):
                    m_input = QLineEdit()
                    m_input.setPlaceholderText(f"0 - {MAX_MAG} Gauss")
                    m_input.setObjectName(f"{mode}_well{i}_mag")
                    form.addRow("Magnetic (Gauss):", m_input)
                else:
                    m_input = None

                gb.setLayout(form)
                wells_layout.addWidget(gb)
                self.mode_pages[mode]["inputs"].append({"electric": e_input, "magnetic": m_input})

            v.addLayout(wells_layout)

            # Buttons row
            btn_row = QHBoxLayout()
            back = QPushButton("Back")
            back.clicked.connect(self.go_home)
            validate = QPushButton("Validate & Record")
            validate.clicked.connect(lambda _, m=mode: self.validate_and_record(m))
            btn_row.addWidget(back)
            btn_row.addWidget(validate)
            v.addLayout(btn_row)

            page.setLayout(v)
            self.stack.addWidget(page)

    def mode_label(self, mode):
        return {
            "electric": "Electric Current",
            "magnetic": "Magnetic Field",
            "dual": "Dual: Electric + Magnetic"
        }[mode]

    def enter_mode(self, mode):
        index = {"electric": 1, "magnetic": 2, "dual": 3}[mode]
        self.current_mode = mode
        self.stack.setCurrentIndex(index)

    def go_home(self):
        self.stack.setCurrentIndex(0)

    def on_serial_received(self, obj):
        # store sensor reports keyed by well if present
        if isinstance(obj, dict):
            if 'sensor' in obj and 'well' in obj:
                well = int(obj.get('well', 1))
                self.latest_reports[well] = obj

    def on_serial_error(self, msg):
        QMessageBox.warning(self, "Serial Error", msg)

    def validate_and_record(self, mode):
        # Validate inputs for each well according to safety limits.
        entries = self.mode_pages[mode]["inputs"]
        errors = []
        recorded = []
        for i, ent in enumerate(entries, start=1):
            e_val = None
            m_val = None
            if ent["electric"] is not None:
                txt = ent["electric"].text().strip()
                if txt == "":
                    e_val = None
                else:
                    try:
                        e_val = float(txt)
                        if not (0.0 <= e_val <= MAX_EFIELD):
                            errors.append(f"Well {i} electric out of range (0 - {MAX_EFIELD}).")
                    except ValueError:
                        errors.append(f"Well {i} electric invalid number.")
            if ent["magnetic"] is not None:
                txt = ent["magnetic"].text().strip()
                if txt == "":
                    m_val = None
                else:
                    try:
                        m_val = float(txt)
                        if not (0.0 <= m_val <= MAX_MAG):
                            errors.append(f"Well {i} magnetic out of range (0 - {MAX_MAG}).")
                    except ValueError:
                        errors.append(f"Well {i} magnetic invalid number.")
            recorded.append({"well": i, "electric": e_val, "magnetic": m_val})

        if errors:
            QMessageBox.warning(self, "Validation Error", "\n".join(errors))
            return

        # Send set commands for electric values (only relevant wells)
        for r in recorded:
            if r['electric'] is not None:
                cmd = {"cmd": "set", "well": r['well'], "voltage": r['electric']}
                self.serial_thread.send(cmd)

        # Request fresh report(s) for wells that were set (use well 1 primarily)
        # Here we request well 1 specifically as your ESP32 handles only well 1 now
        self.serial_thread.send({"cmd": "report", "well": 1})

        # Wait up to 1s for a report to arrive (non-blocking UI responsiveness kept)
        start = time.time()
        report = None
        while time.time() - start < 1.0:
            QApplication.processEvents()
            if 1 in self.latest_reports:
                report = self.latest_reports[1]
                break
            time.sleep(0.02)

        # Build confirmation message including INA219 fields if available
        msg = "Recorded values:\n"
        for r in recorded:
            msg += f"Well {r['well']}: "
            parts = []
            if mode in ("electric", "dual"):
                parts.append(f"E={r['electric'] if r['electric'] is not None else 'N/A'} V/cm")
            if mode in ("magnetic", "dual"):
                parts.append(f"M={r['magnetic'] if r['magnetic'] is not None else 'N/A'} G")
            # append sensor fields for well 1
            if r['well'] == 1 and report:
                parts.append(f"INA_busV={report.get('busVoltage_V')}")
                parts.append(f"INA_shunt_mV={report.get('shunt_mV')}")
                parts.append(f"INA_current_mA={report.get('current_mA')}")
                parts.append(f"actualElectrodeV={report.get('actualElectrodeVoltage_V')}")
            msg += ", ".join(parts) + "\n"

        QMessageBox.information(self, "Saved", msg)

    def closeEvent(self, e):
        try:
            self.serial_thread.stop()
        except Exception:
            pass
        e.accept()


if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MCCB_UI_Template()
    window.show()
    sys.exit(app.exec_())
