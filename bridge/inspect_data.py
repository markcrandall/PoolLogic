"""Print the circuit/body/feature layout from a screenlogicpy JSON dump."""
import json
import sys

d = json.load(open(sys.argv[1], encoding="utf-8"))
print("top-level keys:", list(d.keys()))

for cid, c in d.get("circuit", {}).items():
    print(
        f"circuit {cid}: name={c.get('name')!r} value={c.get('value')}"
        f" function={c.get('function')} interface={c.get('interface')}"
    )

for bid, b in d.get("body", {}).items():
    if isinstance(b, dict):
        print(f"body {bid}: name={b.get('name')!r}")
        for k, v in b.items():
            if isinstance(v, dict) and "value" in v:
                print(f"    {k} = {v.get('value')} {v.get('unit', '')}")

controller = d.get("controller", {})
sensor = controller.get("sensor", {})
for k, v in sensor.items():
    if isinstance(v, dict):
        print(f"sensor {k} = {v.get('value')} {v.get('unit', '')}")
