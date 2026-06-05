#!/usr/bin/env bash
# install.sh — Run once on the Raspberry Pi as the pi user (with sudo available).
# Sets up the MCCB backend service and kiosk autostart.
#
# Usage:
#   cd /home/pi/mccb
#   chmod +x install.sh
#   ./install.sh

set -e   # exit on any error
MCCB_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_USER="${SUDO_USER:-pi}"
PI_HOME="/home/$PI_USER"

echo "=== MCCB Install ==="
echo "App directory : $MCCB_DIR"
echo "Running as    : $PI_USER"
echo ""

# ── 1. System packages ──────────────────────────────────────────────────────
echo "[1/6] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y \
    chromium-browser \
    unclutter \
    curl \
    python3-venv \
    python3-pip \
    python3-serial

# ── 2. Add pi user to dialout group (serial port access) ───────────────────
echo "[2/6] Adding $PI_USER to dialout group..."
sudo usermod -aG dialout "$PI_USER"
echo "      NOTE: Serial access takes effect after next login / reboot."

# ── 3. Python virtual environment ──────────────────────────────────────────
echo "[3/6] Setting up Python virtual environment..."
if [ ! -d "$MCCB_DIR/venv" ]; then
    python3 -m venv "$MCCB_DIR/venv"
fi
"$MCCB_DIR/venv/bin/pip" install --upgrade pip -q
"$MCCB_DIR/venv/bin/pip" install fastapi uvicorn pyserial -q
echo "      venv ready at $MCCB_DIR/venv"

# ── 4. Install systemd service for the backend ─────────────────────────────
echo "[4/6] Installing mccb-backend systemd service..."

# Patch the WorkingDirectory and ExecStart in the service file to match
# wherever this script was run from, in case it's not /home/pi/mccb.
SERVICE_SRC="$MCCB_DIR/mccb-backend.service"
SERVICE_DEST="/etc/systemd/system/mccb-backend.service"

sed \
    -e "s|WorkingDirectory=.*|WorkingDirectory=$MCCB_DIR|" \
    -e "s|ExecStart=.*|ExecStart=$MCCB_DIR/venv/bin/uvicorn backend:app --host 0.0.0.0 --port 8000|" \
    -e "s|User=pi|User=$PI_USER|" \
    -e "s|Group=pi|Group=$PI_USER|" \
    -e "s|Environment=PATH=.*|Environment=PATH=$MCCB_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin|" \
    "$SERVICE_SRC" | sudo tee "$SERVICE_DEST" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable mccb-backend.service
sudo systemctl start  mccb-backend.service
echo "      Service enabled and started."

# ── 5. Install kiosk autostart ─────────────────────────────────────────────
echo "[5/6] Installing kiosk autostart..."

# Copy and make the launch script executable
cp "$MCCB_DIR/start_kiosk.sh" "$MCCB_DIR/start_kiosk.sh"
chmod +x "$MCCB_DIR/start_kiosk.sh"

# Patch the Exec path in the desktop entry
AUTOSTART_DIR="$PI_HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
sed \
    -e "s|Exec=.*|Exec=$MCCB_DIR/start_kiosk.sh|" \
    "$MCCB_DIR/mccb-kiosk.desktop" > "$AUTOSTART_DIR/mccb-kiosk.desktop"

echo "      Autostart entry written to $AUTOSTART_DIR/mccb-kiosk.desktop"

# ── 6. Configure RPi for kiosk boot ────────────────────────────────────────
echo "[6/6] Configuring Raspberry Pi kiosk settings..."

# Auto-login to desktop (requires raspi-config or direct file edit)
# This uses the official raspi-config non-interactive interface.
if command -v raspi-config &>/dev/null; then
    sudo raspi-config nonint do_boot_behaviour B4   # Desktop autologin
    echo "      Boot behaviour set to: Desktop autologin (B4)"
else
    echo "      WARNING: raspi-config not found — ensure desktop autologin is enabled manually."
    echo "      Run: sudo raspi-config → System Options → Boot / Auto Login → Desktop Autologin"
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "Next steps:"
echo "  1. Reboot the Pi:  sudo reboot"
echo "  2. The backend service will start automatically."
echo "  3. Chromium will open in kiosk mode and load the MCCB UI."
echo ""
echo "Useful commands:"
echo "  Check backend status : sudo systemctl status mccb-backend"
echo "  Watch backend logs   : journalctl -u mccb-backend -f"
echo "  Restart backend      : sudo systemctl restart mccb-backend"
echo "  Disable kiosk        : rm ~/.config/autostart/mccb-kiosk.desktop"
echo ""
echo "To exit kiosk mode on the Pi: Alt+F4 closes Chromium"
echo "To get a terminal while in kiosk: Ctrl+Alt+T (if keyboard is attached)"
