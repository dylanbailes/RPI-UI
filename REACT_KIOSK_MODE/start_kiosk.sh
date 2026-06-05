#!/usr/bin/env bash
# start_kiosk.sh — Waits for the MCCB backend then opens Chromium in kiosk mode.
# Runs as the pi user via XDG autostart after the desktop session starts.

BACKEND_URL="http://localhost:8000"
MAX_WAIT=30   # seconds to wait for backend before giving up

# ── 1. Disable screen blanking / power saving ──────────────────────────────
xset s off
xset s noblank
xset -dpms

# ── 2. Hide the mouse cursor (lab kiosk — touch screen only) ───────────────
# unclutter must be installed: sudo apt install unclutter
unclutter -idle 0 -root &

# ── 3. Wait for the backend to be accepting connections ────────────────────
echo "[kiosk] Waiting for backend at $BACKEND_URL..."
elapsed=0
while ! curl -sf "$BACKEND_URL" > /dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$MAX_WAIT" ]; then
        echo "[kiosk] Backend did not start within ${MAX_WAIT}s — launching anyway"
        break
    fi
done
echo "[kiosk] Backend ready after ${elapsed}s"

# ── 4. Launch Chromium in kiosk mode ──────────────────────────────────────
# --kiosk          : true full-screen, no address bar, no tab bar
# --noerrdialogs   : suppress crash dialogs (important for lab use)
# --disable-infobars: hide "Chrome is being controlled..." banner
# --disable-session-crashed-bubble: no "restore pages?" prompt on restart
# --disable-features=TranslateUI: no translate popups
# --overscroll-history-navigation=0: disable swipe-back gesture
# --check-for-update-interval=31536000: suppress update prompts for 1 year
chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --overscroll-history-navigation=0 \
    --check-for-update-interval=31536000 \
    --app="$BACKEND_URL"
