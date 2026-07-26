# PoolLogic

A family pool controller for Pentair ScreenLogic systems: a simple web app
anyone on the home wifi can open, backed by a small Python bridge that holds
the single connection to the ScreenLogic adapter.

```
Phones / tablets / laptops        Always-on host (Raspberry Pi)       Pool equipment
┌──────────────────────┐  HTTP/JSON  ┌───────────────────────┐  ScreenLogic  ┌─────────┐
│ PWA (vanilla JS,     │ ──────────> │ bridge.py             │  TCP (1 conn) │ Adapter │──RS-485──> Panel
│ FSM-driven, no deps) │  poll 5s    │ aiohttp+screenlogicpy │ ────────────> │         │
└──────────────────────┘             │ also serves the PWA   │               └─────────┘
                                     └───────────────────────┘
```

Controls: pool/spa mode (with app-owned spa auto-heat), heater + setpoint
(slider and stepper), jets, cleaner, spillway, pool/spa lights, IntelliBrite
shows (White / Caribbean / Party), live temperatures with honest
"last reading" staleness, connection status with automatic reconnect, and a
status LED on the bridge host. The pool is always the source of truth: every
control renders polled state, and commands show pending until the equipment
confirms.

## Install on a Raspberry Pi

1. Flash the SD card and boot the Pi — sections 1–3 of
   [bridge/DEPLOY_RaspberryPi.md](bridge/DEPLOY_RaspberryPi.md)
   (Raspberry Pi Imager with wifi + SSH preconfigured; fully headless).
2. SSH in and run:

   ```
   curl -fsSL https://raw.githubusercontent.com/markcrandall/PoolLogic/main/installer/install.sh | sudo bash
   ```

   The installer finds the ScreenLogic adapter automatically, offers a static
   IP, installs the auto-starting service, and prints the family URL.
3. Update any time after with `sudo poollogic-update`.

Note: `bridge/config.json` ships with this pool's circuit IDs. For a
different pool, run
`bridge/discover_direct.py` and `python -m screenlogicpy -i <ip> get json`
to find yours, and edit `circuitIds` to match your panel's circuits.

## Develop on a PC

```
python -m venv .venv
.venv/Scripts/pip install -r bridge/requirements.txt
.venv/Scripts/python bridge/bridge.py --mock --port 7665
```

`--mock` serves a simulated pool (drifting temps, realistic command delays,
failure injection at `/dev.html`) so the entire client — including every
failure path — can be exercised with no equipment. The app shows an amber
MOCK badge whenever it's talking to the simulator.

The connection FSM is pure and total, so its tests need no browser, no server
and no dependencies — just Node's built-in runner from the repo root:

```
node --test
```

Design decisions, API contract, and the FSM transition tables are in
[DESIGN.md](DESIGN.md).
