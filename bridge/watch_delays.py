"""Watch the panel's valve-delay bytes across a pool<->spa switch.

Circuit flags follow the relay, but valve actuators take ~20-30s to rotate, so
"spa on" is reported well before water actually routes to the spa. The panel
exposes pool_delay / spa_delay / cleaner_delay, but screenlogicpy reads them as
bare bytes with no enum, so the encoding is unknown: boolean, a countdown, or a
bitfield. This samples them once a second so one real switch answers it.

Reads the bridge's /api/state rather than the adapter directly, so it does not
take one of the adapter's limited connection slots.

    python bridge/watch_delays.py                        # localhost:8080
    python bridge/watch_delays.py http://192.168.1.73:8080

Run it, then flip Pool -> Spa in the app (or on the panel) and watch which
value moves, when it clears, and whether it counts.
"""
import json
import sys
import time
import urllib.request

FIELDS = ("poolDelay", "spaDelay", "cleanerDelay")
POLL_SECONDS = 1.0


def sample(url):
    with urllib.request.urlopen(url + "/api/state", timeout=5) as r:
        return json.load(r)


def row(state):
    circuits = state.get("circuits", {})
    delays = " ".join(f"{f}={state.get(f)!r}" for f in FIELDS)
    return (
        f"pool={int(bool(circuits.get('pool')))} "
        f"spa={int(bool(circuits.get('spa')))} "
        f"poolTemp={state.get('poolTemp')} spaTemp={state.get('spaTemp')} "
        f"{delays} com={state.get('comStatus')}"
    )


def main():
    url = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
    # ASCII only: this gets redirected to a log on Windows (cp1252) as often
    # as it runs on the Pi.
    print(f"watching {url} - Ctrl+C to stop\n", flush=True)
    start = time.monotonic()
    last = None
    while True:
        try:
            line = row(sample(url))
        except Exception as ex:
            line = f"unreachable ({ex!r})"
        if line != last:  # only print transitions, so the switch stands out
            # flush: stdout block-buffers when redirected, and this is meant to
            # be piped to a log while you walk out to the equipment pad.
            print(f"{time.monotonic() - start:7.1f}s  {line}", flush=True)
            last = line
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped")
