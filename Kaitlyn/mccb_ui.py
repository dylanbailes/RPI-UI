import sys
from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QVBoxLayout,
    QHBoxLayout, QGridLayout
)
from PyQt5.QtCore import Qt

class MCCB_UI(QWidget):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("MCCB Control Interface")
        self.setGeometry(100, 100, 900, 600)

        title = Qlabel("Multi-Chamber Camera Bioreactor")
        title.setAlignment(Qt.AlignCenter)
        title.setStyleSheet("font-size: 24px; font-weight: bold;")

        record_btn = QPushButton("RECORD")
        stop_btn = QPushButton("STOP")
        electric_btn = QPushButton("Electric Stimulus")
        magnetic_btn = QPushButton("Magnetic Stimulus")

        for btn in [record_btn, stop_btn, electric_btn, magnetic_btn]:
            btn.setMinimumHeight(50)
                btn.setStyleSheet("font-size: 18px;")

    camera_grid = QGridLayout()

    for i in range(4):
        cam_label = Qlabel(f"Camera {i+1} Feed")
        cam_label.setAlignment(Qt.AlignCenter)
        cam_label.setStyleSheet(
        "background-color: black; color: white; font-size: 18px;border: 2px solid gray;")
        camera_grid.addWidget(cam_label, i // 2, i % 2)

    top_buttons = QHBoxLayout()
    top_buttons.addWidget(record_btn)
    top_buttons.addWidget(stop_btn)

    stimulus_buttons = QHBoxLayout()
    stimulus_buttons.addWidget(electric_btn)
    stimulus_buttons.addWidget(magnetic_btn)

    main_layout = QVBoxLayout()
    main_layout.addWidget(title)
    main_layout.addLayout(top_buttons)
    main_layout.addLayout(camera_grid)
    main_layout.addLayout(stimulus_buttons)

    self.setLayout(main_layout)

app = QApplication(sys.argv)
window = MCCB_UI()
window.show()
sys.exit(app.exec_())
