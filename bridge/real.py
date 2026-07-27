"""Real pool backend: one persistent ScreenLogic adapter connection via
screenlogicpy, refreshed on a cadence and immediately after commands. All
gateway I/O is serialized through a lock; failures flip comStatus to
pool_unreachable and the run loop reconnects with backoff.
"""

import asyncio
import time
from contextlib import suppress
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
        # Measured on the monotonic clock, not the wall clock: a headless Pi
        # with no RTC can step its wall clock by hours when NTP first lands,
        # which would make the readings look newer (or wildly older) than they
        # are. Clients get an age, so no clock has to agree with any other.
        self._last_contact_mono = None
        self._light_show = None  # adapter doesn't report the active show; echo ours
        self._lock = asyncio.Lock()
        self._refresh_task = None
        self._run_task = None

    def start(self):
        self._run_task = asyncio.get_event_loop().create_task(self._run_loop())

    async def close(self):
        """Hand the adapter's connection slot back deliberately.

        Process exit closes the socket regardless — the kernel sends FIN even
        on SIGKILL — so this is determinism, not a leak fix: the slot is
        released by an explicit disconnect at a known point rather than as a
        side effect of teardown ordering. The case that genuinely strands a
        slot (power cut, wifi drop) runs no code at all and is beyond reach
        from here; the adapter reaps those on its own timeout.
        """
        for task in (self._run_task, self._refresh_task):
            if task is not None:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
        self._run_task = self._refresh_task = None
        async with self._lock:
            with suppress(Exception):  # already down / never connected
                await self.gateway.async_disconnect(force=True)
        self.pool_up = False

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
        self._last_contact_mono = time.monotonic()

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

        # The controller sensor block carries the temperatures and the
        # panel-level freeze flag. Freeze mode is reported for the controller
        # as a whole, not per circuit: the panel tells us it is protecting
        # itself, never which circuits it forced on.
        sensor = d.get("controller", {}).get("sensor", {})
        return {
            "comStatus": "ok" if self.pool_up else "pool_unreachable",
            "lastPoolContact": self._last_contact,
            # How old the readings below actually are. While the pool link is
            # down this keeps climbing even though /api/state still answers
            # 200 from cache, which is the only way the client can tell a
            # fresh poll from fresh data.
            "poolAgeSeconds": self._pool_age(),
            "freezeMode": bool(sensor.get("freeze_mode", {}).get("value")),
            # Valve-delay bytes, passed through RAW and deliberately
            # uninterpreted. Circuit flags follow the relay, but actuators take
            # ~20-30s to rotate, so "spa on" precedes water actually reaching
            # the spa. screenlogicpy reads these as bare bytes with no enum, so
            # the encoding (boolean / countdown / bitfield) is still unknown —
            # observe them across a real pool->spa switch before any UI reads
            # them. Nothing consumes these yet.
            "poolDelay": sensor.get("pool_delay", {}).get("value"),
            "spaDelay": sensor.get("spa_delay", {}).get("value"),
            "cleanerDelay": sensor.get("cleaner_delay", {}).get("value"),
            "airTemp": sensor.get("air_temperature", {}).get("value"),
            "poolTemp": d.get("body", {}).get(0, {})
            .get("last_temperature", {}).get("value"),
            "spaTemp": d.get("body", {}).get(1, {})
            .get("last_temperature", {}).get("value"),
            "circuits": circuits,
            "heat": heat,
            "lightShow": self._light_show,
        }

    def _pool_age(self):
        if self._last_contact_mono is None:
            return None  # never reached the adapter since boot
        return int(time.monotonic() - self._last_contact_mono)

    async def get_panel_circuits(self):
        """Every circuit the panel reports, with the name the panel gives it.

        config.json's circuitIds is our map; this is the panel's. After a
        controller replacement the two can disagree silently — the bridge
        faithfully reports whatever circuit it asked about — so being able to
        read the panel's own names and IDs is what makes the map fixable.
        """
        circuits = []
        for cid, circuit in (self.gateway.get_data().get("circuit") or {}).items():
            if not isinstance(circuit, dict):
                continue
            circuits.append(
                {
                    "id": cid,
                    "name": circuit.get("name"),
                    "on": bool(circuit.get("value")),
                }
            )
        circuits.sort(key=lambda c: (c["id"] is None, c["id"]))
        return circuits

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
