"""Real pool backend: one persistent ScreenLogic adapter connection via
screenlogicpy, refreshed on a cadence and immediately after commands. All
gateway I/O is serialized through a lock; failures flip comStatus to
pool_unreachable and the run loop reconnects with backoff.
"""

import asyncio
from datetime import datetime

from screenlogicpy import ScreenLogicGateway
from screenlogicpy.device_const.heat import HEAT_MODE, HEAT_STATE
from screenlogicpy.device_const.system import COLOR_MODE

from errors import BackendUnavailable

SHOW_COMMANDS = {
    "white": COLOR_MODE.WHITE.value,
    "caribbean": COLOR_MODE.CARIBBEAN.value,
    "party": COLOR_MODE.PARTY.value,
}
BODY_INDEX = {"pool": 0, "spa": 1}

# The client confirms commands by polling, with a 10s deadline; refresh the
# adapter data quickly after any command so confirmation beats the deadline.
COMMAND_REFRESH_DELAYS = (1.0, 3.5)

RECONNECT_BACKOFF_START = 5
RECONNECT_BACKOFF_MAX = 60


def _now():
    return datetime.now().isoformat(timespec="seconds")


class RealBackend:
    def __init__(self, config):
        self.ip = config["adapterIp"]
        self.circuit_ids = config["circuitIds"]
        self.poll_seconds = config.get("adapterPollSeconds", 10)
        self.gateway = ScreenLogicGateway()
        self.pool_up = False
        self._last_contact = None
        self._light_show = None  # adapter doesn't report the active show; echo ours
        self._lock = asyncio.Lock()
        self._refresh_task = None

    def start(self):
        asyncio.get_event_loop().create_task(self._run_loop())

    async def _run_loop(self):
        backoff = RECONNECT_BACKOFF_START
        while True:
            try:
                await self._refresh()
                backoff = RECONNECT_BACKOFF_START
                await asyncio.sleep(self.poll_seconds)
            except Exception as ex:
                self.pool_up = False
                print(f"pool link down ({ex!r}); retrying in {backoff}s")
                async with self._lock:
                    try:
                        await self.gateway.async_disconnect(force=True)
                    except Exception:
                        pass
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)

    async def _refresh(self):
        async with self._lock:
            if not self.gateway.is_connected:
                await self.gateway.async_connect(ip=self.ip)
            await self.gateway.async_update()
        self.pool_up = True
        self._last_contact = _now()

    # -- Queries ----------------------------------------------------------

    async def get_state(self):
        d = self.gateway.get_data()
        circuits = {}
        for name, cid in self.circuit_ids.items():
            value = d.get("circuit", {}).get(cid, {}).get("value")
            circuits[name] = bool(value)

        heat = {}
        for body, idx in BODY_INDEX.items():
            b = d.get("body", {}).get(idx, {})
            heat[body] = {
                "setpoint": b.get("heat_setpoint", {}).get("value"),
                "on": b.get("heat_mode", {}).get("value", 0) != HEAT_MODE.OFF.value,
                "active": b.get("heat_state", {}).get("value", 0)
                != HEAT_STATE.OFF.value,
            }

        temps = d.get("controller", {}).get("sensor", {})
        return {
            "comStatus": "ok" if self.pool_up else "pool_unreachable",
            "lastPoolContact": self._last_contact,
            "airTemp": temps.get("air_temperature", {}).get("value"),
            "poolTemp": d.get("body", {}).get(0, {})
            .get("last_temperature", {}).get("value"),
            "spaTemp": d.get("body", {}).get(1, {})
            .get("last_temperature", {}).get("value"),
            "circuits": circuits,
            "heat": heat,
            "lightShow": self._light_show,
        }

    # -- Commands ---------------------------------------------------------

    async def set_circuit(self, name, on):
        cid = self.circuit_ids[name]
        await self._cmd(lambda: self.gateway.async_set_circuit(cid, 1 if on else 0))

    async def heat_on(self, body, setpoint):
        idx = BODY_INDEX[body]
        # One _cmd for both writes: they run back-to-back under one lock hold
        # (no refresh can interleave) and share a single refresh chain.
        await self._cmd(
            lambda: self.gateway.async_set_heat_temp(idx, setpoint),
            lambda: self.gateway.async_set_heat_mode(idx, HEAT_MODE.HEATER.value),
        )

    async def heat_off(self, body):
        idx = BODY_INDEX[body]
        await self._cmd(
            lambda: self.gateway.async_set_heat_mode(idx, HEAT_MODE.OFF.value)
        )

    async def set_setpoint(self, body, temp):
        idx = BODY_INDEX[body]
        await self._cmd(lambda: self.gateway.async_set_heat_temp(idx, temp))

    async def set_lights(self, show):
        await self._cmd(
            lambda: self.gateway.async_set_color_lights(SHOW_COMMANDS[show])
        )
        self._light_show = show

    # -- Internals --------------------------------------------------------

    async def _cmd(self, *make_coros):
        if not self.pool_up:
            raise BackendUnavailable()
        try:
            async with self._lock:
                for make_coro in make_coros:
                    await make_coro()
        except Exception as ex:
            raise BackendUnavailable() from ex
        # Coalesce: rapid commands share one refresh chain instead of
        # stacking adapter round-trips.
        if self._refresh_task is None or self._refresh_task.done():
            self._refresh_task = asyncio.get_event_loop().create_task(
                self._post_command_refresh()
            )

    async def _post_command_refresh(self):
        for delay in COMMAND_REFRESH_DELAYS:
            await asyncio.sleep(delay)
            try:
                await self._refresh()
            except Exception:
                self.pool_up = False
