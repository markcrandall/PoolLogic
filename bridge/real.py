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


# --- Panel introspection ------------------------------------------------------
# screenlogicpy wraps most readings as {"name": ..., "value": ..., "unit": ...}
# but not all of them, so unwrap defensively rather than assuming.

def _val(node, default=None):
    if isinstance(node, dict):
        return node.get("value", default)
    return node if node is not None else default


def _unit(node):
    return node.get("unit") if isinstance(node, dict) else None


def _panel_circuits(d):
    circuits = [
        {"id": cid, "name": c.get("name"), "on": bool(_val(c.get("value")))}
        for cid, c in (d.get("circuit") or {}).items()
        if isinstance(c, dict)
    ]
    circuits.sort(key=lambda c: (c["id"] is None, c["id"]))
    return circuits


NO_DATA_BYTE = 0xFF


def _pumps(d):
    """Only populated slots. A panel reports eight regardless of how many
    pumps exist; the empty ones carry nothing but a raw data blob."""
    pumps = []
    for pid, p in sorted((d.get("pump") or {}).items(), key=lambda kv: str(kv[0])):
        if not isinstance(p, dict) or "watts_now" not in p:
            continue
        # 0xFF is the panel's "no reading" sentinel. Only applied to gpm: this
        # pool reports 255 gpm, which is not a residential flow rate, and it
        # read 255 on the old board and its replacement alike — so it is a
        # missing value, not a measurement. 255 W or 255 rpm are both plausible
        # readings, so they are passed through untouched.
        gpm = _val(p.get("gpm_now"))
        pumps.append(
            {
                "id": pid,
                "type": _val(p.get("type")),
                "running": bool(_val(p.get("state"))),
                "watts": _val(p.get("watts_now")),
                "rpm": _val(p.get("rpm_now")),
                "gpm": None if gpm == NO_DATA_BYTE else gpm,
            }
        )
    return pumps


# Flags worth surfacing. IntelliChem's are included only when non-zero: on a
# system without one they are a permanent row of zeroes that trains you to
# ignore the whole section.
_ALARM_LABELS = (
    ("flow_alarm", "Flow"),
    ("ph_high_alarm", "pH high"),
    ("ph_low_alarm", "pH low"),
    ("orp_high_alarm", "ORP high"),
    ("orp_low_alarm", "ORP low"),
    ("ph_supply_alarm", "pH supply"),
    ("orp_supply_alarm", "ORP supply"),
    ("probe_fault_alarm", "Probe fault"),
)


def _status(d):
    """Readings. Never a verdict — nothing here can be 'wrong'.

    Kept apart from _alerts because conflating them is what made the page lie:
    screenlogicpy reports SCG state as ON_OFF.from_bool(state & 0x01), i.e.
    'the chlorinator is producing', and treating non-zero as a fault flagged a
    perfectly healthy chlorinator every time it ran.
    """
    scg = d.get("scg") or {}
    if not scg.get("scg_present"):
        return []

    sensor = scg.get("sensor") or {}
    config = scg.get("configuration") or {}
    items = [
        {
            "label": "Chlorinator",
            "value": "Producing" if _val(sensor.get("state"), 0) else "Idle",
        }
    ]
    salt = _val(sensor.get("salt_ppm"))
    if salt is not None:
        items.append({"label": "Salt", "value": f"{salt} ppm"})
    for key, label in (("pool_setpoint", "Pool output"), ("spa_setpoint", "Spa output")):
        pct = _val(config.get(key))
        if pct is not None:
            items.append({"label": label, "value": f"{pct}%"})
    return items


def _alerts(d):
    """Faults only. An empty list is the healthy case and says so."""
    items = []

    alert = _val(d.get("controller", {}).get("sensor", {}).get("active_alert"), 0)
    if alert:
        # A panel alert code, not a flag: surfaced raw because its meaning is
        # undocumented here, and inventing a label would be worse than showing
        # the number.
        items.append({"label": "Panel alert code", "value": alert})

    alarms = (d.get("intellichem") or {}).get("alarm") or {}
    for key, label in _ALARM_LABELS:
        if _val(alarms.get(key), 0):
            items.append({"label": label, "value": "active"})
    return items


def _equipment(d):
    controller = d.get("controller") or {}
    config = controller.get("configuration") or {}
    equipment = controller.get("equipment") or {}
    return {
        "model": _val(controller.get("model")),
        "firmware": _val((d.get("adapter") or {}).get("firmware")),
        "installed": equipment.get("list") or [],
        "circuitCount": _val(config.get("circuit_count")),
        "colorCount": _val(config.get("color_count")),
        # The panel's own setpoint bounds. config.json duplicates these; if the
        # two ever disagree the panel is right.
        "minSetpoint": _val((config.get("body_type") or {}).get(0, {}).get("min_setpoint")),
        "maxSetpoint": _val((config.get("body_type") or {}).get(0, {}).get("max_setpoint")),
    }


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

    async def get_panel_info(self):
        """Everything the panel reports about itself, for the config page.

        config.json's circuitIds is our map; this is the panel's own account of
        what exists. After a controller replacement the two can disagree
        silently — the bridge faithfully reports whatever circuit it asked
        about — so reading the panel's names, equipment and telemetry is what
        makes the map fixable and the hardware legible.
        """
        d = self.gateway.get_data()
        return {
            "circuits": _panel_circuits(d),
            "pumps": _pumps(d),
            "status": _status(d),
            "alerts": _alerts(d),
            "equipment": _equipment(d),
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
