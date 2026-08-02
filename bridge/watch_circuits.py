"""Watch raw circuit state straight from the ScreenLogic adapter.

Reads the adapter directly rather than through the bridge, so nothing our own
code interprets can hide or delay a change, and samples fast enough to catch a
transition that lasts a second or two.

That speed is the point. Chasing "the Spa button reports an error" in 2026-07,
sampling 8 seconds after sending a command showed no change at all and led to
the wrong conclusion twice — the panel was applying each command and reverting
it within ~2s, and every slower sample fell in the gap afterwards. Anything
polling on the bridge's cadence (10s) or the client's (5s) cannot see that.

    python bridge/watch_circuits.py                  # adapterIp from config
    python bridge/watch_circuits.py 192.168.1.25
    python bridge/watch_circuits.py --seconds 600

Read-only: it never sends a command. To test a command, issue it from the app
or the ScreenLogic app while this runs, and watch what the panel does with it.
"""
import argparse
import asyncio
import json
import os
import sys

from screenlogicpy import ScreenLogicGateway
from screenlogicpy.device_const.system import CONTROLLER_STATE

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))


def _adapter_ip():
    """Same base + local layering the bridge uses, so this follows the Pi."""
    cfg = {}
    for name in ("config.json", "config.local.json"):
        try:
            with open(os.path.join(BRIDGE_DIR, name), encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (OSError, ValueError):
            pass
    return cfg.get("adapterIp")


def _value(node):
    return node.get("value") if isinstance(node, dict) else node


def _line(data):
    parts = []
    for cid, circuit in sorted((data.get("circuit") or {}).items()):
        if isinstance(circuit, dict):
            parts.append(f"{cid}:{int(bool(_value(circuit.get('value'))))}")

    for bid, body in sorted((data.get("body") or {}).items()):
        if isinstance(body, dict):
            parts.append(
                f"{body.get('name', bid)}"
                f"[mode={_value(body.get('heat_mode'))}"
                f" state={_value(body.get('heat_state'))}"
                f" temp={_value(body.get('last_temperature'))}]"
            )

    sensor = (data.get("controller") or {}).get("sensor") or {}
    parts.append(f"ctrl={_value(sensor.get('state'))}")
    parts.append(f"freeze={_value(sensor.get('freeze_mode'))}")
    return " ".join(parts)


async def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("ip", nargs="?", default=None, help="adapter IP")
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--seconds", type=float, default=300)
    args = parser.parse_args()

    ip = args.ip or _adapter_ip()
    if not ip:
        sys.exit("No adapter IP given and none found in config.json.")

    gateway = ScreenLogicGateway()
    await gateway.async_connect(ip=ip)
    await gateway.async_update()
    data = gateway.get_data()

    state = _value((data.get("controller") or {}).get("sensor", {}).get("state"))
    try:
        label = CONTROLLER_STATE(state).name
    except (ValueError, TypeError):
        label = "not a known value"
    print(f"adapter {ip}")
    print(f"controller state: {state} (screenlogicpy calls this {label})")
    print("circuit id:on/off, then bodies, then controller state\n", flush=True)

    for cid, circuit in sorted((data.get("circuit") or {}).items()):
        if isinstance(circuit, dict):
            print(f"  {cid}  {circuit.get('name')}")
    print(flush=True)

    loop = asyncio.get_event_loop()
    start = loop.time()
    last = None
    try:
        while loop.time() - start < args.seconds:
            await gateway.async_update()
            current = _line(gateway.get_data())
            if current != last:
                print(f"{loop.time() - start:8.1f}s  {current}", flush=True)
                last = current
            await asyncio.sleep(args.interval)
    finally:
        await gateway.async_disconnect()
    print("\nstopped", flush=True)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nstopped")
