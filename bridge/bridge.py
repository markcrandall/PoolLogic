"""PoolLogic bridge: serves the PWA and a JSON API in front of the pool.

Talks to the real pool through screenlogicpy by default; --mock serves a
simulated one so the client can be built and its failure paths exercised with
no equipment. Real mode exits early if config.json is missing adapterIp or any
circuit ID. See DESIGN.md for the API contract.
"""

import argparse
import inspect
import ipaddress
import json
import mimetypes
import socket
import sys
from pathlib import Path

from aiohttp import web

from errors import BackendUnavailable
from led import StatusLedTask
from mock import MockBackend
from protocol import COM_POOL_UNREACHABLE

# mimetypes consults the Windows registry, so the type served for .js is
# machine state, not a constant — some installs map it to text/plain or
# application/x-javascript. The PWA is ES modules (<script type="module"> plus
# imports), and browsers refuse to execute a module under a non-JavaScript MIME
# type, so a dev box with a mangled registry serves a blank page with a console
# error and nothing else wrong. .mjs is commonly absent from the registry
# entirely, which would fall through to application/octet-stream. Pin them.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("application/manifest+json", ".webmanifest")

BRIDGE_DIR = Path(__file__).resolve().parent
APP_DIR = BRIDGE_DIR.parent / "app"

BODIES = ("pool", "spa")
SHOWS = ("white", "caribbean", "party")


def bad_request(message):
    return web.json_response({"error": message}, status=400)


async def read_json(request):
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    # Valid JSON that is not an object still reaches handlers that call
    # body.get(...), where a list or a bare string raises AttributeError and
    # becomes a text/plain 500 with a traceback in the log. Handlers already
    # treat None as "unusable body" and answer 400, so funnel it there.
    return body if isinstance(body, dict) else None


class Api:
    def __init__(self, backend, config):
        self.backend = backend
        self.config = config
        # Settable circuits derive from config so the whitelist and the
        # backend's ID map can never drift apart.
        #
        # Every circuit config.json names is settable, the pool body included.
        # It was held read-only while the client had a two-position body switch
        # that only ever needed to stop the spa and treated "spa off" as "pool
        # on". Both bodies can in fact be off, so selecting Pool now has to
        # actually start it — see DESIGN.md 5.2.
        self.circuits = tuple(config["circuitIds"])

    def routes(self):
        return [
            web.get("/api/state", self.get_state),
            web.get("/api/config", self.get_config),
            web.get("/api/panel", self.get_panel_info),
            web.post("/api/circuit/{name}", self.set_circuit),
            web.post("/api/heat/{body}/on", self.heat_on),
            web.post("/api/heat/{body}/off", self.heat_off),
            web.post("/api/heat/{body}/setpoint", self.set_setpoint),
            web.post("/api/lights", self.set_lights),
        ]

    async def get_state(self, request):
        return web.json_response(await self.backend.get_state())

    async def get_config(self, request):
        """Read-only view of the config the client needs to render the circuit
        map. A curated subset rather than the whole file, deliberately: this is
        the shape a future editable version would POST back, and the file also
        holds things the browser has no business reading (allowedHosts) or
        changing casually (adapterIp). Widen it when there is a reason to.
        """
        return web.json_response(
            {
                "circuitIds": self.config["circuitIds"],
                # Which of those the API will actually accept a command for.
                # Currently all of them; kept as its own field because the
                # config page renders it and a future read-only circuit should
                # show up there rather than as a surprise 404.
                "settableCircuits": list(self.circuits),
                "setpointMin": self.config["setpointMin"],
                "setpointMax": self.config["setpointMax"],
            }
        )

    async def get_panel_info(self, request):
        """Everything the panel reports about itself: circuits (not just the
        ones config.json names), pump telemetry, alerts and equipment. Kept off
        /api/state on purpose — only the config page wants it, and every phone
        polls state every 5s."""
        return web.json_response(await self.backend.get_panel_info())

    async def set_circuit(self, request):
        name = request.match_info["name"]
        if name not in self.circuits:
            return web.json_response({"error": f"unknown circuit '{name}'"}, status=404)
        body = await read_json(request)
        if body is None or not isinstance(body.get("on"), bool):
            return bad_request('expected {"on": true|false}')
        return await self._run(self.backend.set_circuit(name, body["on"]))

    async def heat_on(self, request):
        body_name = self._body_name(request)
        if body_name is None:
            return web.json_response({"error": "unknown body"}, status=404)
        body = await read_json(request)
        if body is None:
            return bad_request("expected JSON body")
        temp = self._valid_temp(body.get("setpoint"))
        if temp is None:
            return bad_request(self._temp_error())
        return await self._run(self.backend.heat_on(body_name, temp))

    async def heat_off(self, request):
        body_name = self._body_name(request)
        if body_name is None:
            return web.json_response({"error": "unknown body"}, status=404)
        return await self._run(self.backend.heat_off(body_name))

    async def set_setpoint(self, request):
        body_name = self._body_name(request)
        if body_name is None:
            return web.json_response({"error": "unknown body"}, status=404)
        body = await read_json(request)
        if body is None:
            return bad_request("expected JSON body")
        temp = self._valid_temp(body.get("temp"))
        if temp is None:
            return bad_request(self._temp_error())
        return await self._run(self.backend.set_setpoint(body_name, temp))

    async def set_lights(self, request):
        body = await read_json(request)
        if body is None or body.get("show") not in SHOWS:
            return bad_request(f'expected {{"show": one of {list(SHOWS)}}}')
        return await self._run(self.backend.set_lights(body["show"]))

    async def _run(self, coro):
        try:
            await coro
        except BackendUnavailable:
            return web.json_response({"error": COM_POOL_UNREACHABLE}, status=503)
        return web.json_response({})

    def _body_name(self, request):
        name = request.match_info["body"]
        return name if name in BODIES else None

    def _valid_temp(self, value):
        # bool subclasses int, so True would pass isinstance and read as 1.
        # The 40 degree floor rejects it today, but only by luck — that stops
        # being true the moment setpointMin is configured below 2.
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        if self.config["setpointMin"] <= value <= self.config["setpointMax"]:
            return value
        return None

    def _temp_error(self):
        return (
            f'setpoint must be an integer {self.config["setpointMin"]}-'
            f'{self.config["setpointMax"]}'
        )


class MockControls:
    """Failure-injection routes, registered only in --mock mode."""

    def __init__(self, backend):
        self.backend = backend

    def routes(self):
        return [
            web.post("/api/mock/pool_link", self.pool_link),
            web.post("/api/mock/command_timeout", self.command_timeout),
            web.post("/api/mock/fail_heat", self.fail_heat),
            web.post("/api/mock/freeze", self.freeze),
            web.post("/api/mock/alarm", self.alarm),
        ]

    async def pool_link(self, request):
        body = await read_json(request)
        if body is None or not isinstance(body.get("up"), bool):
            return bad_request('expected {"up": true|false}')
        self.backend.pool_link_up = body["up"]
        return web.json_response({"poolLinkUp": self.backend.pool_link_up})

    async def command_timeout(self, request):
        body = await read_json(request)
        if body is None or not isinstance(body.get("enabled"), bool):
            return bad_request('expected {"enabled": true|false}')
        self.backend.command_timeout = body["enabled"]
        return web.json_response({"commandTimeout": self.backend.command_timeout})

    async def fail_heat(self, request):
        """Reject the heat writes only. `mode` writes twice — spa circuit, then
        courtesy heat — and this is the only switch that can fail the second
        without the first, which is the case its confirmed() predicate exists
        to catch."""
        body = await read_json(request)
        if body is None or not isinstance(body.get("on"), bool):
            return bad_request('expected {"on": true|false}')
        self.backend.fail_heat = body["on"]
        return web.json_response({"failHeat": self.backend.fail_heat})

    async def freeze(self, request):
        body = await read_json(request)
        if body is None or not isinstance(body.get("on"), bool):
            return bad_request('expected {"on": true|false}')
        self.backend.freeze_mode = body["on"]
        return web.json_response({"freezeMode": self.backend.freeze_mode})

    async def alarm(self, request):
        body = await read_json(request)
        if body is None or not isinstance(body.get("on"), bool):
            return bad_request('expected {"on": true|false}')
        self.backend.alarm_injected = body["on"]
        return web.json_response({"alarm": self.backend.alarm_injected})


# "Cache it, but ask me before reusing it" — NOT "don't cache it", which is
# no-store. aiohttp sends ETag and Last-Modified but no Cache-Control, and a
# response with no Cache-Control gets *heuristic* freshness: browsers reuse it
# for roughly 10% of its age since Last-Modified, without asking. A stylesheet
# last edited a month ago is then served from disk for about three days.
#
# That is how a phone comes to run a new index.html against an old styles.css,
# and it has already bitten once: the M8 pool-heat banner relied on a
# display:none that the cached sheet did not have, so it announced a pool heater
# that was off. The app is now defensive about that (see 5.1), but the mismatch
# itself is the bug, and an update the family has to hard-reload is not an
# update. With no-cache the browser still caches and still sends If-None-Match;
# the bridge answers 304 in a couple hundred bytes when nothing changed, which
# on a LAN is free next to the /api/state poll every phone runs every 5s.
#
# Applied uniformly, icons included: they change so rarely that the revalidation
# costs nothing, and one rule is easier to reason about than a per-type table.
CACHE_CONTROL = "no-cache"


async def serve_app_file(request):
    tail = request.match_info.get("tail", "") or "index.html"
    target = (APP_DIR / tail).resolve()
    if APP_DIR not in target.parents and target != APP_DIR:
        raise web.HTTPForbidden()
    if not target.is_file():
        raise web.HTTPNotFound()
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return web.FileResponse(
        target,
        headers={"Content-Type": ctype, "Cache-Control": CACHE_CONTROL},
    )


LOCAL_CONFIG_SUFFIX = ".local.json"


def _merge_config(base, override):
    """Override wins, one level deep so a local file can set a single circuit
    ID or just statusLed.mode without restating the whole block."""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def load_config(path):
    """config.json holds what the repo ships; config.local.json holds what this
    particular Pi discovered, and is git-ignored.

    They are separate because they have different owners. The installer used to
    write the discovered adapter IP straight back into the tracked config.json,
    which left every install permanently dirty in git — so the first time the
    repo changed that file, `poollogic-update` aborted the pull on a headless
    box. Machine state and shipped defaults must not share a file.
    """
    with open(path, encoding="utf-8") as f:
        config = json.load(f)

    local_path = Path(path).with_suffix("")  # strip .json
    local_path = local_path.with_name(local_path.name + LOCAL_CONFIG_SUFFIX)
    if local_path.is_file():
        try:
            with open(local_path, encoding="utf-8") as f:
                overrides = json.load(f)
        except ValueError as ex:
            # systemd restarts us forever on a non-zero exit, so the log line
            # is the only thing standing between a typo here and a headless
            # box that just will not come up. Name the file and the error.
            raise SystemExit(f"{local_path} is not valid JSON: {ex}") from ex
        config = _merge_config(config, overrides)
        print(f"merged local overrides from {local_path.name}", flush=True)
    return config


# --- Browser-origin guards ---------------------------------------------------
# The bridge is deliberately unauthenticated: it lives on the home LAN and the
# family UX is "open the URL, no login". That is fine for people on the wifi;
# it is not fine for a web page one of their phones happens to load.
#
# Two distinct holes, closed by the two checks below.
#
# 1. Cross-site writes. Any page can fire a no-preflight POST at a guessed LAN
#    address. It cannot read the reply (we send no CORS headers, so the same
#    origin policy blocks that) but the command still runs — someone's pool
#    cleaner starts from a web ad. Only the CORS "simple" content types get
#    through this way; application/json triggers a preflight, and our OPTIONS
#    returns 405, so the browser gives up. aiohttp's request.json() ignores
#    Content-Type entirely and parses whatever body arrives, so requiring the
#    header is what actually closes it.
#
# 2. DNS rebinding. An attacker's hostname re-resolves to the bridge's LAN
#    address, which makes their page same-origin with us and lets them *read*
#    state. Such a request still carries their hostname in Host, so checking it
#    is the fix. A Host that is a bare IP cannot be rebinding: browsers only
#    send one when the user typed the address, which is the documented way in.
JSON_CONTENT_TYPE = "application/json"


def _host_label(host_header):
    """Hostname from a Host header, minus port and IPv6 brackets."""
    host = (host_header or "").strip()
    if host.startswith("["):                      # [::1]:8080
        end = host.find("]")
        return host[1:end] if end != -1 else host[1:]
    if host.count(":") == 1:                      # name:port / 1.2.3.4:port
        host = host.rsplit(":", 1)[0]
    return host.lower()


def _is_ip_literal(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


# Suffixes a home router may append to the hostname. The list is closed on
# purpose: matching only the first label would accept poollogic.evil.com, which
# an attacker can register, and that defeats the whole check.
LOCAL_SUFFIXES = ("local", "lan", "home", "localdomain", "home.arpa")


def host_allowed(host_header, config):
    host = _host_label(host_header)
    if not host:
        return False
    if _is_ip_literal(host):
        return True
    names = {"localhost", socket.gethostname().split(".", 1)[0].lower()}
    names |= {h.lower() for h in config.get("allowedHosts", [])}
    if host in names:
        return True
    # poollogic.local / .lan / .home resolve to the same box; anything else
    # keeps its full name and has to be listed explicitly.
    for suffix in LOCAL_SUFFIXES:
        if host.endswith("." + suffix):
            return host[: -(len(suffix) + 1)] in names
    return False


@web.middleware
async def guard_middleware(request, handler):
    config = request.app["config"]
    if not host_allowed(request.headers.get("Host"), config):
        # Logged, not silent: a wrong-but-honest hostname looks identical to an
        # attack from the outside, and the family URL 403ing needs to be
        # diagnosable from journalctl.
        print(
            f"rejected request with Host={request.headers.get('Host')!r}",
            flush=True,  # systemd captures stdout; buffered lines never appear
        )
        raise web.HTTPForbidden(reason="unrecognized Host")
    if request.method == "POST":
        # Media type only; charset and other parameters are fine.
        if request.content_type != JSON_CONTENT_TYPE:
            raise web.HTTPUnsupportedMediaType(
                reason=f"expected Content-Type: {JSON_CONTENT_TYPE}"
            )
    return await handler(request)


def build_app(backend, config, mock_controls=None):
    app = web.Application(middlewares=[guard_middleware])
    app["config"] = config
    app.add_routes(Api(backend, config).routes())
    if mock_controls is not None:
        app.add_routes(mock_controls.routes())
    app.add_routes([
        web.get("/", serve_app_file),
        web.get("/{tail:.+}", serve_app_file),
    ])
    return app


def main():
    parser = argparse.ArgumentParser(description="PoolLogic bridge")
    parser.add_argument("--mock", action="store_true",
                        help="serve a simulated pool (no equipment needed)")
    parser.add_argument("--port", type=int, default=None,
                        help="override httpPort from config.json")
    parser.add_argument("--config", default=str(BRIDGE_DIR / "config.json"))
    args = parser.parse_args()

    config = load_config(args.config)
    port = args.port or config["httpPort"]

    if args.mock:
        backend = MockBackend(config)
        mock_controls = MockControls(backend)
        label = "MOCK"
    else:
        if not config.get("adapterIp"):
            sys.exit("config.json needs adapterIp for real-pool mode.")
        missing = [k for k, v in config["circuitIds"].items() if not v]
        if missing:
            sys.exit(f"config.json circuitIds missing: {missing}")
        from real import RealBackend

        backend = RealBackend(config)
        mock_controls = None
        label = f"REAL pool at {config['adapterIp']}"

    app = build_app(backend, config, mock_controls=mock_controls)

    status_led = StatusLedTask(config, lambda: backend.link_state)

    async def on_startup(_app):
        # start() is synchronous by design — it only spawns tasks, so there is
        # nothing to await, unlike close()/stop() which must await cancellation.
        # That asymmetry is a trap: making a start() async later would leave an
        # un-awaited coroutine here and the bridge would come up with no pool
        # connection. Awaiting anything awaitable keeps this correct either way.
        for begin in (backend.start, status_led.start):
            started = begin()
            if inspect.isawaitable(started):
                await started
        # flush: under systemd stdout is a pipe and block-buffers, so an
        # unflushed banner never reaches journalctl.
        print(f"PoolLogic bridge ({label}) on http://localhost:{port}", flush=True)

    async def on_cleanup(_app):
        # aiohttp handles SIGTERM by default (handle_signals=True), so this
        # runs on `systemctl restart` as well as Ctrl+C. LED first, so it stops
        # flashing while the adapter disconnect is in flight.
        await status_led.stop()
        await backend.close()
        print("PoolLogic bridge stopped cleanly", flush=True)

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, port=port, print=None)


if __name__ == "__main__":
    main()
