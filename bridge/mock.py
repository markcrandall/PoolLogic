"""Simulated pool backend so the PWA can be built without real equipment.

Mimics the observable behavior of the real bridge: commands are acknowledged
immediately but the state changes only after APPLY_DELAY, temperatures drift,
and the pool link can be dropped or commands made to silently stall to
exercise the client FSM failure paths.
"""

import asyncio
import random
from datetime import datetime

from errors import BackendUnavailable


APPLY_DELAY = 1.5    # seconds between command ack and visible state change
DRIFT_PERIOD = 2.0   # seconds between temperature updates


def _now():
    return datetime.now().isoformat(timespec="seconds")


class MockBackend:
    def __init__(self, config):
        self.setpoint_min = config["setpointMin"]
        self.setpoint_max = config["setpointMax"]

        # Failure injection switches (driven by /api/mock/* routes)
        self.pool_link_up = True
        self.command_timeout = False

        self._last_contact = _now()
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

    @property
    def pool_up(self):
        """Same accessor RealBackend exposes, for the status LED."""
        return self.pool_link_up

    def start(self):
        asyncio.get_event_loop().create_task(self._drift_loop())

    async def _drift_loop(self):
        while True:
            await asyncio.sleep(DRIFT_PERIOD)
            if not self.pool_link_up:
                continue
            self._last_contact = _now()

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
            "comStatus": "ok" if self.pool_link_up else "pool_unreachable",
            "lastPoolContact": self._last_contact,
            "airTemp": round(self._temps["air"]),
            "poolTemp": round(self._temps["pool"]),
            "spaTemp": round(self._temps["spa"]),
            "circuits": dict(self._circuits),
            "heat": heat,
            "lightShow": self._light_show,
        }

    # -- Commands ---------------------------------------------------------

    async def set_circuit(self, name, on):
        self._command_gate()
        self._apply_later(lambda: self._circuits.__setitem__(name, bool(on)))

    async def heat_on(self, body, setpoint):
        self._command_gate()

        def apply():
            self._heat[body]["on"] = True
            self._heat[body]["setpoint"] = setpoint

        self._apply_later(apply)

    async def heat_off(self, body):
        self._command_gate()
        self._apply_later(lambda: self._heat[body].__setitem__("on", False))

    async def set_setpoint(self, body, temp):
        self._command_gate()
        self._apply_later(lambda: self._heat[body].__setitem__("setpoint", temp))

    async def set_lights(self, show):
        self._command_gate()
        self._apply_later(lambda: setattr(self, "_light_show", show))

    # -- Internals --------------------------------------------------------

    def _command_gate(self):
        """Commands fail fast when the link is down; with command_timeout on,
        they are accepted but never applied (client sees a confirm timeout)."""
        if not self.pool_link_up:
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
