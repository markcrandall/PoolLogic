"""PoolLogic bridge: serves the PWA and a JSON API in front of the pool.

M1 scope: mock backend only (--mock). The real ScreenLogic backend via
screenlogicpy arrives in M4; until then running without --mock exits with a
message. See DESIGN.md for the API contract.
"""

import argparse
import json
import mimetypes
import sys
from pathlib import Path

from aiohttp import web

from errors import BackendUnavailable
from led import StatusLedTask
from mock import MockBackend

BRIDGE_DIR = Path(__file__).resolve().parent
APP_DIR = BRIDGE_DIR.parent / "app"

BODIES = ("pool", "spa")
SHOWS = ("white", "caribbean", "party")

# The pool circuit is exposed read-only in /api/state (it drives temp
# staleness); it is never settable through the API.
READ_ONLY_CIRCUITS = ("pool",)


def bad_request(message):
    return web.json_response({"error": message}, status=400)


async def read_json(request):
    try:
        return await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


class Api:
    def __init__(self, backend, config):
        self.backend = backend
        self.config = config
        # Settable circuits derive from config so the whitelist and the
        # backend's ID map can never drift apart.
        self.circuits = tuple(
            name for name in config["circuitIds"] if name not in READ_ONLY_CIRCUITS
        )

    def routes(self):
        return [
            web.get("/api/state", self.get_state),
            web.post("/api/circuit/{name}", self.set_circuit),
            web.post("/api/heat/{body}/on", self.heat_on),
            web.post("/api/heat/{body}/off", self.heat_off),
            web.post("/api/heat/{body}/setpoint", self.set_setpoint),
            web.post("/api/lights", self.set_lights),
        ]

    async def get_state(self, request):
        return web.json_response(await self.backend.get_state())

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
            return web.json_response({"error": "pool_unreachable"}, status=503)
        return web.json_response({})

    def _body_name(self, request):
        name = request.match_info["body"]
        return name if name in BODIES else None

    def _valid_temp(self, value):
        if not isinstance(value, int):
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


async def serve_app_file(request):
    tail = request.match_info.get("tail", "") or "index.html"
    target = (APP_DIR / tail).resolve()
    if APP_DIR not in target.parents and target != APP_DIR:
        raise web.HTTPForbidden()
    if not target.is_file():
        raise web.HTTPNotFound()
    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return web.FileResponse(target, headers={"Content-Type": ctype})


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_app(backend, config, mock_controls=None):
    app = web.Application()
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

    status_led = StatusLedTask(config, lambda: backend.pool_up)

    async def on_startup(_app):
        backend.start()
        status_led.start()
        print(f"PoolLogic bridge ({label}) on http://localhost:{port}")

    app.on_startup.append(on_startup)
    web.run_app(app, port=port, print=None)


if __name__ == "__main__":
    main()
