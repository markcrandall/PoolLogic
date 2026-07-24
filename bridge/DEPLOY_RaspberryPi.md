# Deploying the PoolLogic Bridge on a Raspberry Pi

Complete instructions for moving the bridge from the dev PC to a Raspberry Pi
Zero 2 W (CanaKit Starter MAX Kit, 64GB edition) as a permanent, always-on
appliance. After this the family URL works whenever the Pi has power, with no
PC involved.

**What the Pi ends up running:** the Python bridge as a systemd service that
starts on boot, holds the single ScreenLogic adapter connection, serves the
PWA at port 8080, restarts itself on any crash, and blinks the onboard ACT
LED as a status indicator.

> **Shortcut:** sections 4–7 are fully automated by the installer. After
> finishing section 3, run
> `curl -fsSL https://raw.githubusercontent.com/markcrandall/PoolLogic/main/installer/install.sh | sudo bash`
> and skip to section 8. It discovers the adapter, prompts about a static IP,
> installs the service and the `poollogic-update` command, and verifies the
> bridge answers. The sections below remain as the reference for what it does
> (and for doing it by hand).

---

## 1. What you need

- CanaKit Pi Zero 2 W kit: board, case, 64GB microSD, power supply
  (the kit's HDMI adapter, OTG cable, and GPIO header are NOT needed —
  setup is fully headless)
- A PC with a microSD card reader (built-in or USB)
- Your wifi network name and password
- ~30 minutes, most of it waiting

## 2. Flash the microSD card (on the PC)

Even if the kit's card came preloaded, re-image it — the Raspberry Pi Imager
lets us preconfigure wifi and SSH so the Pi never needs a keyboard or monitor.

1. Download and install **Raspberry Pi Imager** from
   https://www.raspberrypi.com/software/ and insert the microSD card.
2. In Imager:
   - **Device**: Raspberry Pi Zero 2 W
   - **OS**: Raspberry Pi OS **Lite** (32-bit) — no desktop; the Zero 2 W has
     512MB RAM and the bridge needs none of the GUI
   - **Storage**: the kit's microSD card
3. Click **Next → Edit Settings** (the OS customization dialog) and set:
   - Hostname: `poollogic`
   - Username / password: `pi` / a password you'll remember
   - **Configure wireless LAN**: your SSID + password, country `US`
     (must be the same 2.4GHz network the pool adapter is on — the
     Zero 2 W has no 5GHz)
   - **Enable SSH** (password authentication) — under the Services tab
4. Write the image (several minutes), then put the card in the Pi.

## 3. First boot

1. Assemble the case, insert the card, connect the kit's power supply to the
   port marked **PWR IN** (the micro-USB port nearest the corner).
2. Wait ~2 minutes for first boot. The green ACT LED flickers during boot.
3. From the PC, verify it's on the network:

   ```
   ping poollogic.local
   ```

   If `.local` doesn't resolve, find the Pi's IP in your router's client list
   (hostname `poollogic`) and use the IP wherever this guide says
   `poollogic.local`.
4. Log in:

   ```
   ssh pi@poollogic.local
   ```

5. **Reserve the Pi's IP address** in your router's DHCP settings now, and do
   the same for the pool adapter (192.168.1.25) if you haven't — the bridge
   config points at that address, and a DHCP change would break it. While
   you're in the router, note the Pi's reserved IP; it becomes the family URL.

## 4. Copy PoolLogic to the Pi

From a terminal **on the PC** (not the Pi) — `scp` is built into Windows 10:

```
cd C:\Users\markc\source\repos\Fun\PoolLogic
scp -r app bridge pi@poollogic.local:/home/pi/PoolLogic/
```

Do NOT copy `.venv` (it's Windows binaries) or `DESIGN.md` (not needed to run).
The `app` and `bridge` directories must end up side by side —
`bridge.py` finds the PWA files at `../app`.

## 5. Install Python dependencies (on the Pi)

```
ssh pi@poollogic.local
sudo apt update && sudo apt full-upgrade -y      # first time only, ~10 min
sudo apt install -y python3-venv
python3 -m venv /home/pi/PoolLogic/.venv
/home/pi/PoolLogic/.venv/bin/pip install -r /home/pi/PoolLogic/bridge/requirements.txt
```

The install pulls prebuilt packages from piwheels, so it takes a couple of
minutes, not an hour.

## 6. Test run (foreground)

Close the official Pentair app on all phones (shared adapter connection
slots), then:

```
/home/pi/PoolLogic/.venv/bin/python /home/pi/PoolLogic/bridge/bridge.py
```

You should see `PoolLogic bridge (REAL pool at 192.168.1.25) on
http://localhost:8080`. From a phone or the PC, open:

```
http://poollogic.local:8080
```

Green dot, live temps, working controls = success. (For a no-equipment dry
run, add `--mock` and look for the amber MOCK badge.) Ctrl+C to stop.

If the dot goes amber with "Pool link down": check the adapter answers
`ping 192.168.1.25` from the Pi; if not, power-cycle the ScreenLogic adapter
(they lock up occasionally — 10 seconds unplugged fixes it). If the adapter
IP ever changes, rediscover it with:

```
/home/pi/PoolLogic/.venv/bin/python /home/pi/PoolLogic/bridge/discover_direct.py <the Pi's IP>
```

and update `adapterIp` in `bridge/config.json`.

## 7. Install as a service (start on boot, restart on crash)

Create the unit file:

```
sudo nano /etc/systemd/system/poollogic.service
```

Paste exactly:

```ini
[Unit]
Description=PoolLogic pool bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/home/pi/PoolLogic/bridge
ExecStart=/home/pi/PoolLogic/.venv/bin/python /home/pi/PoolLogic/bridge/bridge.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

(`User=root` exists solely because the status LED writes to
`/sys/class/leds/ACT`, which is root-only. If you'd rather not run as root,
set `"statusLed": { "mode": "off" }` in config.json and change `User=pi` —
everything else works identically.)

Save (Ctrl+O, Enter, Ctrl+X), then:

```
sudo systemctl daemon-reload
sudo systemctl enable --now poollogic
systemctl status poollogic
```

`active (running)` = done. Reboot once (`sudo reboot`) and confirm the app
comes back on its own.

## 8. The status LED

The Pi's onboard green ACT LED (visible through the case's port cutouts) now
reports bridge health at a glance:

| Pattern | Meaning |
|---|---|
| Short flash every 3 s (heartbeat) | Bridge up, pool link OK |
| Steady 1 s blink | Pool adapter unreachable — bridge is retrying (try power-cycling the adapter) |
| Rapid blink | Bridge starting, first connection not yet made |
| Dark (after boot finishes) | Bridge not running — check `systemctl status poollogic` |

## 9. Family phones

Tell everyone the URL — the reserved IP form is the most reliable across
devices:

```
http://<the-Pi's-reserved-IP>:8080     e.g. http://192.168.1.60:8080
```

Add-to-home-screen for a real app icon:
- **iPhone/iPad**: open in Safari → Share → **Add to Home Screen**
- **Android**: open in Chrome → ⋮ menu → **Add to Home screen**

## 10. Updating the app later

After changing code on the PC:

```
scp -r app bridge pi@poollogic.local:/home/pi/PoolLogic/
ssh pi@poollogic.local sudo systemctl restart poollogic
```

Phones pick up UI changes on their next page load (no service worker, so no
stale-cache surprises).

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| App unreachable from phones | `systemctl status poollogic`; `ss -tlnp \| grep 8080` on the Pi; phone on the same wifi? |
| Live logs | `journalctl -u poollogic -f` |
| Amber "Pool link down" persists | `ping 192.168.1.25` from the Pi; power-cycle the adapter; confirm the Pentair app isn't hogging connection slots |
| Adapter moved to a new IP | rediscover (section 6) and edit `config.json`, then `sudo systemctl restart poollogic` |
| Everything mysteriously wrong | `sudo reboot` — the service self-starts |

Config reference (`bridge/config.json`): `adapterIp`, `httpPort` (8080),
setpoint bounds (40–102), `circuitIds` (this pool's ScreenLogic circuit
numbers — also defines which circuits the API accepts), `statusLed`.
