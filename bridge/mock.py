"""Simulated pool backend so the PWA can be built without real equipment.

Mimics the observable behavior of the real bridge: commands are acknowledged
immediately but the state changes only after APPLY_DELAY, temperatures drift,
and the pool link can be dropped or commands made to silently stall to
exercise the client FSM failure paths.
"""

import asyncio
import random
import time
from contextlib import suppress
from datetime import datetime

from errors import BackendUnavailable
from poollink import PoolLinkState
from protocol import COM_OK, COM_POOL_UNREACHABLE


APPLY_DELAY = 1.5    # seconds between command ack and visible state change
DRIFT_PERIOD = 2.0   # seconds between temperature updates

# What a panel might report back: this pool's IDs as the replacement controller
# numbers them, plus two circuits config.json has no entry for — the case the
# config page has to make visible.
PANEL_CIRCUIT_NAMES = {
    500: "Spa",
    501: "Jets",
    502: "Pool Light",
    503: "Aux 3",
    504: "Spa Light",
    505: "Pool",
    506: "Spillway",
    507: "Cleaner",
    510: "Feature 1",
}


def _now():
    return datetime.now().isoformat(timespec="seconds")


class MockBackend:
    def __init__(self, config):
        self.setpoint_min = config["setpointMin"]
        self.setpoint_max = config["setpointMax"]
        self._circuit_ids = config["circuitIds"]

        # Failure injection switches (driven by /api/mock/* routes)
        self.pool_link_up = True
        self.command_timeout = False
        # Fails the heat POSTs only, leaving circuits working. The one command
        # that writes twice is `mode` (spa circuit + courtesy heat), and its
        # half-executed path — circuit lands, heat does not — is not reachable
        # with command_timeout, which stalls everything at once.
        self.fail_heat = False
        # Panel freeze protection. Real panels force circuits on themselves
        # when it engages; the mock just reports the flag so the client's
        # freeze handling can be exercised out of season.
        self.freeze_mode = False
        self.alarm_injected = False

        self._last_contact = _now()
        self._last_contact_mono = time.monotonic()
        self._temps = {"air": 88.0, "pool": 84.0, "spa": 84.0}
        self._circuits = {
            "pool": True,   # read-only in the API; drives pool-temp freshness
            "spa": False,
            "jets": False,
            "cleaner": False,
            "spillway": False,
            "poolLight": False,
            "spaLight": False,
        }
        self._heat = {
            "pool": {"setpoint": 78, "on": False},
            "spa": {"setpoint": 101, "on": False},
        }
        self._light_show = None
        self._drift_task = None
        self._pump_watts = 1450.0

    @property
    def pool_up(self):
        """Same accessor RealBackend exposes."""
        return self.pool_link_up

    @property
    def link_state(self):
        """What the status LED reads. The mock has no reconnect lifecycle and
        no notion of "never connected" — its link is a switch — so it maps onto
        the two states that switch can actually distinguish."""
        return PoolLinkState.UP if self.pool_link_up else PoolLinkState.DOWN

    def start(self):
        self._drift_task = asyncio.get_event_loop().create_task(self._drift_loop())

    async def close(self):
        """Parity with RealBackend so bridge.py has one shutdown path."""
        if self._drift_task is not None:
            self._drift_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._drift_task
            self._drift_task = None

    async def _drift_loop(self):
        while True:
            await asyncio.sleep(DRIFT_PERIOD)
            if not self.pool_link_up:
                continue  # readings freeze and age, exactly like the real one
            self._last_contact = _now()
            self._last_contact_mono = time.monotonic()

            self._pump_watts = _walk(self._pump_watts, 25, 1350, 1550)
            self._temps["air"] = _walk(self._temps["air"], 0.3, 75, 95)
            self._temps["pool"] = _walk(self._temps["pool"], 0.1, 80, 88)

            # Spa heats toward setpoint when spa + heater are on, else relaxes
            # toward pool temperature.
            spa = self._temps["spa"]
            if self._circuits["spa"] and self._heat["spa"]["on"]:
                target = self._heat["spa"]["setpoint"]
                spa += min(0.5, max(-0.5, target - spa))
            else:
                spa += min(0.2, max(-0.2, self._temps["pool"] - spa))
            self._temps["spa"] = spa

    # -- Queries ----------------------------------------------------------

    async def get_state(self):
        heat = {}
        for body in ("pool", "spa"):
            h = self._heat[body]
            temp = self._temps[body]
            heat[body] = {
                "setpoint": h["setpoint"],
                "on": h["on"],
                "active": h["on"] and temp < h["setpoint"] - 0.5,
            }
        return {
            "mock": True,
            "comStatus": COM_OK if self.pool_link_up else COM_POOL_UNREACHABLE,
            "lastPoolContact": self._last_contact,
            "poolAgeSeconds": int(time.monotonic() - self._last_contact_mono),
            "freezeMode": self.freeze_mode,
            # Shape parity with the real backend; the mock has no valves, and
            # the real encoding isn't known yet, so these stay 0.
            "poolDelay": 0,
            "spaDelay": 0,
            "cleanerDelay": 0,
            "airTemp": round(self._temps["air"]),
            "poolTemp": round(self._temps["pool"]),
            "spaTemp": round(self._temps["spa"]),
            "circuits": dict(self._circuits),
            "heat": heat,
            "lightShow": self._light_show,
        }

    async def get_panel_info(self):
        """What a panel might report about itself.

        The circuit list is deliberately a superset of config.json — the extras
        (Aux 4, Waterfall) have no entry in circuitIds, which is the case the
        config page has to make visible. A mock echoing only our own map would
        never exercise it.
        """
        by_id = {cid: name for name, cid in self._circuit_ids.items()}
        circuits = [
            {
                "id": cid,
                "name": label,
                "on": bool(self._circuits.get(by_id.get(cid), False)),
            }
            for cid, label in sorted(PANEL_CIRCUIT_NAMES.items())
        ]

        # Pump telemetry tracks whether anything is actually circulating, so
        # the numbers move when you toggle circuits instead of sitting still.
        running = any(
            self._circuits.get(name) for name in ("pool", "spa", "jets", "cleaner")
        )
        pumps = [
            {
                "id": 0,
                "type": 1,
                "running": running,
                "watts": round(self._pump_watts) if running else 0,
                "rpm": 3000 if running else 0,
                "gpm": 68 if running else 0,
            }
        ]

        # Readings carry no verdict; only genuine faults land in alerts, so an
        # empty alerts list is the healthy case.
        status = [
            {"label": "Chlorinator", "value": "Producing" if running else "Idle"},
            {"label": "Salt", "value": "3400 ppm"},
            {"label": "Pool output", "value": "35%"},
            {"label": "Spa output", "value": "15%"},
        ]
        alerts = []
        if self.alarm_injected:
            alerts.append({"label": "Flow", "value": "active"})

        return {
            "circuits": circuits,
            "pumps": pumps,
            "status": status,
            "alerts": alerts,
            "equipment": {
                "model": "MockTouch 8",
                "firmware": "MOCK 0.0 Build 0.0",
                "installed": ["CHLORINATOR", "INTELLIBRITE", "INTELLIFLO_0"],
                "circuitCount": len(PANEL_CIRCUIT_NAMES),
                "colorCount": 8,
                "minSetpoint": self.setpoint_min,
                "maxSetpoint": self.setpoint_max,
            },
        }

    # -- Commands ---------------------------------------------------------

    async def set_circuit(self, name, on):
        self._command_gate()
        self._apply_later(lambda: self._circuits.__setitem__(name, bool(on)))

    async def heat_on(self, body, setpoint):
        self._command_gate(heat=True)

        def apply():
            self._heat[body]["on"] = True
            self._heat[body]["setpoint"] = setpoint

        self._apply_later(apply)

    async def heat_off(self, body):
        self._command_gate(heat=True)
        self._apply_later(lambda: self._heat[body].__setitem__("on", False))

    async def set_setpoint(self, body, temp):
        self._command_gate(heat=True)
        self._apply_later(lambda: self._heat[body].__setitem__("setpoint", temp))

    async def set_lights(self, show):
        self._command_gate()
        self._apply_later(lambda: setattr(self, "_light_show", show))

    # -- Internals --------------------------------------------------------

    def _command_gate(self, heat=False):
        """Commands fail fast when the link is down; with command_timeout on,
        they are accepted but never applied (client sees a confirm timeout).
        fail_heat rejects the heat writes alone, so `mode` can land its circuit
        and lose its courtesy heat — the asymmetry the other switches cannot
        produce."""
        if not self.pool_link_up:
            raise BackendUnavailable()
        if heat and self.fail_heat:
            raise BackendUnavailable()

    def _apply_later(self, fn):
        if self.command_timeout:
            return

        async def later():
            await asyncio.sleep(APPLY_DELAY)
            fn()

        asyncio.get_event_loop().create_task(later())


def _walk(value, step, lo, hi):
    return max(lo, min(hi, value + random.uniform(-step, step)))
