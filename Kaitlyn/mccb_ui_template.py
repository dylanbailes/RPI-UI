import sys
from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QVBoxLayout, QHBoxLayout, QLabel,
    QStackedLayout, QLineEdit, QGroupBox, QMessageBox, QSizePolicy, QFormLayout
)
from PyQt5.QtCore import Qt

# Safety limits (adjust if needed)
MAX_EFIELD = 5.0    # V/cm
MAX_MAG = 15.0      # Gauss

class MCCB_UI_Template(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MCCB UI Template")
        self.setGeometry(100, 100, 600, 480)

        # Main stacked layout to swap pages
        self.stack = QStackedLayout()
        self.init_home_page()
        self.init_mode_pages()

        container = QWidget()
        container.setLayout(self.stack)

        main_layout = QVBoxLayout()
        main_layout.addWidget(container)
        self.setLayout(main_layout)

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
        # switch stacked layout to the correct page index
        # home is index 0, mode pages added in order electric, magnetic, dual
        index = {"electric": 1, "magnetic": 2, "dual": 3}[mode]
        self.current_mode = mode
        self.stack.setCurrentIndex(index)

    def go_home(self):
        self.stack.setCurrentIndex(0)

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

        # For this template we just show a confirmation with recorded values.
        msg = "Recorded values:\n"
        for r in recorded:
            msg += f"Well {r['well']}: "
            parts = []
            if mode in ("electric", "dual"):
                parts.append(f"E={r['electric'] if r['electric'] is not None else 'N/A'} V/cm")
            if mode in ("magnetic", "dual"):
                parts.append(f"M={r['magnetic'] if r['magnetic'] is not None else 'N/A'} G")
            msg += ", ".join(parts) + "\n"

        QMessageBox.information(self, "Saved", msg)

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MCCB_UI_Template()
    window.show()
    sys.exit(app.exec_())
