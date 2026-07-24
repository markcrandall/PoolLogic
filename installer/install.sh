#!/usr/bin/env bash
# PoolLogic one-command installer for Raspberry Pi.
#
# On a freshly flashed Pi (see bridge/DEPLOY_RaspberryPi.md sections 1-3):
#
#   curl -fsSL https://raw.githubusercontent.com/markcrandall/PoolLogic/main/installer/install.sh | sudo bash
#
# or, from an existing clone:
#
#   sudo bash installer/install.sh
#
# What it does: installs packages, clones/updates the repo, builds the Python
# environment, discovers the ScreenLogic adapter and writes its IP into the
# config, optionally sets a static IP for the Pi, installs the systemd
# service + the poollogic-update command, starts the bridge, and verifies it
# answers. Safe to re-run at any time.

set -euo pipefail

REPO_URL="https://github.com/markcrandall/PoolLogic.git"
APP_USER="pi"
INSTALL_DIR="/home/${APP_USER}/PoolLogic"
SERVICE_NAME="poollogic"
PORT=8080

say() { echo ""; echo "==> $*"; }
ask() { local reply; read -rp "$1" reply </dev/tty; echo "$reply"; }

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }

say "Installing packages (git, python3-venv, curl)..."
apt-get update -qq
apt-get install -y -qq git python3-venv curl >/dev/null

# --- Get the code -----------------------------------------------------------
# If this script is running from inside a checkout, use that checkout;
# otherwise clone (or fast-forward an existing clone) at $INSTALL_DIR.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/nonexistent}")" 2>/dev/null && pwd || true)"
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../bridge/bridge.py" ]; then
  INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  say "Using existing checkout at $INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing install at $INSTALL_DIR..."
  sudo -u "$APP_USER" git -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning PoolLogic to $INSTALL_DIR..."
  sudo -u "$APP_USER" git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"

# --- Python environment -----------------------------------------------------
say "Building Python environment (prebuilt packages from piwheels)..."
sudo -u "$APP_USER" python3 -m venv "$INSTALL_DIR/.venv"
sudo -u "$APP_USER" "$INSTALL_DIR/.venv/bin/pip" install -q -r "$INSTALL_DIR/bridge/requirements.txt"
PYTHON="$INSTALL_DIR/.venv/bin/python"

# --- Find the ScreenLogic adapter -------------------------------------------
say "Searching for the ScreenLogic adapter (close the Pentair app on phones first)..."
FOUND_IP="$("$PYTHON" - "$INSTALL_DIR" <<'PY' || true
import socket
import sys

sys.path.insert(0, sys.argv[1] + "/bridge")
from discover_direct import probe

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect(("8.8.8.8", 80))
local_ip = s.getsockname()[0]
s.close()

for bcast in (local_ip.rsplit(".", 1)[0] + ".255", "255.255.255.255"):
    host, _ = probe(local_ip, bcast)
    if host:
        print(host["ip"])
        break
PY
)"

if [ -n "$FOUND_IP" ]; then
  say "Adapter found at $FOUND_IP — writing it into bridge/config.json"
  "$PYTHON" - "$INSTALL_DIR/bridge/config.json" "$FOUND_IP" <<'PY'
import json
import sys

path, ip = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
cfg["adapterIp"] = ip
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
else
  KEPT_IP="$(grep -o '"adapterIp": *"[^"]*"' "$INSTALL_DIR/bridge/config.json" || true)"
  say "No adapter answered discovery."
  echo "    Common causes: the official Pentair app is open on a phone (it"
  echo "    holds the adapter's limited connection slots), or the adapter is"
  echo "    hung (unplug it for 10 seconds). Keeping the configured value:"
  echo "    ${KEPT_IP:-none}. Re-run this installer to retry discovery."
fi

# --- Optional static IP for the Pi ------------------------------------------
CURRENT_IP="$(hostname -I | awk '{print $1}')"
STATIC_SET=""
say "Network: this Pi is currently at $CURRENT_IP (DHCP)."
echo "    Recommended: keep DHCP and reserve $CURRENT_IP for this Pi in your"
echo "    router — that survives OS reinstalls and network changes best."
STATIC_IP="$(ask "    Static IP for the bridge [Enter = keep DHCP]: ")"
if [ -n "$STATIC_IP" ]; then
  if ! command -v nmcli >/dev/null; then
    echo "    nmcli not found on this OS — keep DHCP and use a router reservation."
  elif ! echo "$STATIC_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    echo "    '$STATIC_IP' is not a valid IPv4 address — keeping DHCP."
  else
    if [ "${STATIC_IP%.*}" != "${CURRENT_IP%.*}" ]; then
      echo "    WARNING: $STATIC_IP is not on this Pi's subnet (${CURRENT_IP%.*}.x)."
    fi
    if ping -c 1 -W 1 "$STATIC_IP" >/dev/null 2>&1 && [ "$STATIC_IP" != "$CURRENT_IP" ]; then
      echo "    WARNING: $STATIC_IP already answers ping — pick a free address"
      echo "    outside your router's DHCP pool. Keeping DHCP."
    else
      GATEWAY="$(ip route | awk '/default/ {print $3; exit}')"
      CON="$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: '$2=="wlan0"{print $1; exit}')"
      if [ -n "$CON" ] && [ -n "$GATEWAY" ]; then
        nmcli con mod "$CON" ipv4.method manual \
          ipv4.addresses "$STATIC_IP/24" ipv4.gateway "$GATEWAY" \
          ipv4.dns "$GATEWAY 1.1.1.1"
        STATIC_SET="$STATIC_IP"
        echo "    Static IP $STATIC_IP configured — it takes effect on reboot"
        echo "    (applied at the end so this session doesn't drop mid-install)."
      else
        echo "    Could not determine the wifi connection/gateway — keeping DHCP."
      fi
    fi
  fi
fi

# --- systemd service + update command ---------------------------------------
say "Installing the $SERVICE_NAME service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=PoolLogic pool bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/bridge
ExecStart=${INSTALL_DIR}/.venv/bin/python ${INSTALL_DIR}/bridge/bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
# User=root only because the status LED writes /sys/class/leds/ACT. To run
# unprivileged instead: set statusLed mode "off" in config.json and User=pi.

install -m 755 "$INSTALL_DIR/installer/poollogic-update" /usr/local/bin/poollogic-update

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# --- Verify -----------------------------------------------------------------
say "Verifying..."
sleep 4
STATE="$(curl -fsS "http://localhost:$PORT/api/state" 2>/dev/null | grep -o '"comStatus": "[a-z_]*"' || echo unreachable)"

FINAL_IP="${STATIC_SET:-$CURRENT_IP}"
echo ""
echo "============================================================"
case "$STATE" in
  *'"ok"'*)
    echo " PoolLogic is UP and talking to the pool."
    ;;
  *pool_unreachable*)
    echo " PoolLogic is UP, but the pool adapter is not answering."
    echo " (Power-cycle the adapter; the bridge reconnects on its own.)"
    ;;
  *)
    echo " The bridge did not answer. Check: journalctl -u $SERVICE_NAME -n 50"
    ;;
esac
echo ""
echo "   Family URL:   http://${FINAL_IP}:${PORT}"
echo "   Also works:   http://$(hostname).local:${PORT}"
echo "   Status LED:   heartbeat = OK, steady blink = pool link down"
echo "   Update later: sudo poollogic-update"
if [ -n "$STATIC_SET" ]; then
  echo ""
  echo "   Static IP $STATIC_SET takes effect after: sudo reboot"
fi
echo "============================================================"
