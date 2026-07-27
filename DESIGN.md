# PoolLogic — Design Document

A family-facing web app for controlling a Pentair pool system over home wifi.
PWA client (HTML/JS, FSM-driven) + thin Python bridge speaking the ScreenLogic
protocol. High-trust home environment: anyone on the wifi may use it.

Decided 2026-07-21 after design discussion. This document is the spec; code
follows it.

---

## 1. System architecture

```
Phones / tablets / laptops        Bridge host (dev PC now,          Pool equipment
                                  turnkey box later)
┌──────────────────────┐  HTTP/JSON  ┌───────────────────────┐  ScreenLogic  ┌─────────┐
│ PoolLogic PWA        │ ──────────> │ bridge.py             │  TCP (1 conn) │ Adapter │──RS-485──> Panel
│ (HTML/JS, FSM+store) │  poll ~5s   │ screenlogicpy+aiohttp │ ────────────> │         │
└──────────────────────┘             │ also serves PWA files │               └─────────┘
                                     └───────────────────────┘
```

**Why a bridge (settled):** Browsers cannot open raw TCP/UDP sockets; the
ScreenLogic adapter speaks only a raw binary TCP protocol with UDP discovery.
Additionally the adapter tolerates only a few concurrent clients (shared with
the official Pentair app), so a single multiplexing connection is correct even
beyond the browser limitation. The official Pentair app needs no bridge because
it is native code with raw socket access — a capability web pages do not have.

**Single origin:** one process, one port. `http://<host>:8080/` serves the PWA
static files; `/api/*` serves JSON. No CORS, one URL for the family.

**Deployment:** develop and run on the dev PC (same wifi as the adapter).
Deployment target decided later; preference is turnkey (e.g., preloaded-SD Pi
kit). Nothing in the design changes between hosts.

**Hosting constraints (settled):** GitHub Pages is not usable — an HTTPS page
cannot make requests to the LAN (mixed content), and GitHub cannot reach the
pool. Files are served from the bridge over plain LAN HTTP. Consequence: no
service worker (requires secure context). Offline caching is worthless for
this app anyway. Manifest + icons are kept so add-to-home-screen gives a real
icon and title on iOS/Android.

**Reference projects:**
- Protocol library: https://github.com/dieselrabbit/screenlogicpy (used by the bridge)
- Protocol documentation: https://github.com/ceisenach/screenlogic_over_ip
- PWA structure model: https://github.com/markcrandall/SimpleShoppingList
- FSM idiom: https://aic-lab.com/systemverilog/FSM/

---

## 2. Feature scope (settled)

| Control | UI | Maps to |
|---|---|---|
| Pool / Spa mode | two-position switch | spa circuit on/off (panel handles valve interlock) |
| Heater | On/Off toggle + setpoint stepper per active body | heat mode Off(0) / Heater(3); SetHeatPoint |
| Spa auto-heat | selecting Spa mode also sends heater-on (spa setpoint); leaving Spa sends heater-off. App-owned so a mid-session Heater-Off sticks. REQUIRES disabling the panel's "Spa Manual Heat" setting (verified 2026-07-22: with it enabled the controller re-asserts heat ~15s after any off command while the spa circuit is on) | app-side, in the mode control's send |
| Setpoint bounds | 40–102 °F, enforced bridge-side AND clamped in UI (lowered from 75 on 2026-07-22 to match the pool body's real setpoint range) | |
| Jets | toggle | jets circuit |
| Cleaner | toggle | cleaner circuit |
| Spillway | toggle | spillway circuit |
| Pool light | toggle | pool light circuit |
| Spa light | toggle | spa light circuit |
| Light show | picker: **White** (non-color) / **Caribbean** / **Party** (added 2026-07-22) | IntelliBrite color command (applies to IntelliBrite lights collectively) |
| Temperatures | read-only banner: air / pool / spa; a water temp renders muted with a "last reading" hint while its body isn't circulating (the controller only measures flowing water, so idle-body temps are frozen at the last circulated reading) | polled; pool circuit (505) is in the payload read-only to drive this |
| Com status | header dot + banners; manual Reconnect when offline | see Connection FSM |

No solar modes, no schedules, no chemistry — out of scope by decision.
Heat control is deliberately "turn on + setpoint / turn off" only.

### Bridge-host status LED (added 2026-07-22)

`bridge/led.py` drives a status LED on the deployment host (CanaKit Pi Zero
2 W kit). Configured via `statusLed` in config.json; `mode: auto` uses the
Pi's onboard ACT LED via sysfs (no extra hardware; needs root or a udev rule
for /sys/class/leds writes) and resolves to a no-op on dev machines. `mode:
gpio` supports one external LED (`pin`) or a green/red pair (`okPin` /
`downPin`) once the kit's unpopulated GPIO header is soldered on
(gpiozero; LEDs + 330Ω resistors not included in the kit).

Single-LED patterns: rapid blink = starting; heartbeat flash every 3s =
pool link OK (distinguishes a live bridge from a hung one, unlike solid-on);
1s blink = pool unreachable; dark = bridge not running. Dual-LED: green
heartbeat = OK, solid red = pool unreachable.

---

## 3. Bridge (Python, `bridge/`)

~200 lines. Responsibilities:

- Holds the **single** adapter connection via `screenlogicpy`'s async
  `ScreenLogicGateway`. Uses its push subscription for freshness plus a slow
  safety poll. Own retry loop with backoff if the pool link drops — the PWA
  never talks to the adapter.
- Caches the latest pool state; every `/api/state` answer is served from cache
  instantly.
- **Clean shutdown** (`on_cleanup`): stops the LED task, cancels the poll and
  post-command refresh tasks, and disconnects the gateway. aiohttp handles
  SIGTERM by default, so this runs on `systemctl restart` too. This is
  determinism, not a leak fix — process exit closes the socket regardless (the
  kernel sends FIN even on SIGKILL), so the adapter never holds a slot to its
  timeout on a restart. What it does buy: the disconnect happens at a known
  point rather than as a side effect of teardown ordering, and the ACT LED is
  always handed back to its `mmc0` trigger instead of occasionally freezing
  mid-flash stuck on, which would contradict the documented "dark = not
  running". The case that genuinely strands a slot — power cut, wifi drop —
  runs no code at all and is only reaped by the adapter's own timeout.
- After any command, triggers an immediate state refresh so clients' PENDING
  controls resolve fast.
- **Two-hop honesty:** every response carries `comStatus: "ok" |
  "pool_unreachable"` and `lastPoolContact` (ISO timestamp) so the app can
  distinguish "bridge unreachable" (HTTP fails) from "bridge up, pool link
  down" (HTTP ok, comStatus bad). The user remedy differs.
- **Reading age, not poll age** (`poolAgeSeconds`): while the pool link is
  down `/api/state` still answers 200 from cache, so a fresh *poll* is not
  fresh *data* — the client cannot tell them apart on its own, and a
  poll-time "as of" hint reads as current while the temperatures under it
  are hours old. Measured on `time.monotonic()`, not the wall clock: a
  headless Pi has no RTC and can step hours when NTP first lands. Shipping
  an age rather than a timestamp also means the phone's clock and the Pi's
  never have to agree — and `lastPoolContact`, being naive local time, would
  be misread by a phone in another zone if a client ever parsed it.
  The client shows this age only in DEGRADED, where the bridge is still
  answering and the value therefore arrived with the current poll. Once the
  *bridge* is unreachable the age stops advancing with the polls, so the app
  falls back to the time of the last successful poll — a different unknown,
  honestly labelled. Keeping both cases derived from stored state (never from
  a clock read at render time) is what keeps the output block Moore-pure.
- **Config file** (`bridge/config.json`): adapter IP (or UDP auto-discover),
  HTTP port, friendly-name → circuit-ID map (discovered once via
  `screenlogicpy` CLI at setup), setpoint bounds, poll intervals.
- **Machine state lives in `config.local.json`**, git-ignored, merged over the
  tracked defaults one level deep at load. The installer used to write the
  discovered adapter IP back into the tracked `config.json`, which left every
  install permanently dirty — so the first repo-side change to that file
  aborted `poollogic-update` mid-pull on a headless box. Shipped defaults and
  per-machine discovery have different owners and must not share a file. The
  installer and updater both migrate an already-dirty install automatically,
  and the installer no longer rewrites anything when the value already matches.
- **`--mock` flag:** serves a simulated pool — temps drift, commands succeed
  after a realistic delay, failure injection endpoints for testing FSM edges
  (drop bridge, drop pool link, command timeout). The entire PWA is built and
  tested against mock before touching real equipment.

### API contract

```
GET  /api/state → {
  comStatus: "ok" | "pool_unreachable",
  lastPoolContact: "2026-07-21T14:03:22",   // informational; clients use age
  poolAgeSeconds: 0,  // age of the readings below (monotonic, bridge-side)
  freezeMode: bool,   // panel-level freeze protection is engaged
  airTemp: 88, poolTemp: 84, spaTemp: 101,
  circuits: { pool: bool,   // read-only: drives pool-temp staleness
              spa: bool, jets: bool, cleaner: bool, spillway: bool,
              poolLight: bool, spaLight: bool },
  heat: { pool: { setpoint: 78, on: bool, active: bool },
          spa:  { setpoint: 101, on: bool, active: bool } },
  lightShow: "white" | "caribbean" | "party" | null
}
POST /api/circuit/{name}        {"on": true}          → 200 {} | 4xx/5xx {error}
POST /api/heat/{body}/on        {"setpoint": 101}     → turns heater on (mode 3) and sets temp
POST /api/heat/{body}/off       {}                    → heat mode 0
POST /api/heat/{body}/setpoint  {"temp": 101}         → setpoint only (config bounds, currently 40–102)
POST /api/lights                {"show": "white" | "caribbean" | "party"}
```

`{name}` ∈ spa, jets, cleaner, spillway, poolLight, spaLight.
`{body}` ∈ pool, spa. Unknown names → 404. Out-of-bounds temp → 400.

Mock-only: `POST /api/mock/freeze {"on": bool}` alongside the existing
`pool_link` and `command_timeout` injectors, so freeze handling is testable
out of season.

`poolDelay` / `spaDelay` / `cleanerDelay` are raw panel bytes, passed through
uninterpreted and **consumed by nothing yet** — see Valve lag below.

### Browser-origin guards

No login is a deliberate choice: anyone on the home wifi can drive the pool.
The threat that choice does *not* cover is a web page one of their phones
loads, and two checks (one aiohttp middleware) close it without costing the
no-login UX — the PWA is same-origin and already satisfies both.

**Require `Content-Type: application/json` on POST → 415.** A cross-site page
can fire a POST at a guessed LAN address with no preflight, and while it cannot
read the reply (we send no CORS headers), the command still runs. Only the CORS
*simple* content types get through that way — `application/json` triggers a
preflight and our `OPTIONS` returns 405. `request.json()` ignores
`Content-Type` and parses whatever body arrives, so requiring the header is
what actually closes it. Verified: `text/plain`, `x-www-form-urlencoded`,
`multipart/form-data` and absent all became 415, having been 200.

**Validate `Host` → 403.** DNS rebinding re-points an attacker hostname at the
bridge to become same-origin and *read* state; the request still carries their
hostname. Bare-IP Hosts pass (a browser sends one only when the user typed the
address). Names must match the machine hostname, `localhost`, or
`allowedHosts` in config.json — optionally suffixed `.local` / `.lan` /
`.home` / `.localdomain` / `.home.arpa`.

Matching only the *first* label is not enough: `poollogic.evil.com` is
registrable and would have passed. The suffix list is closed for that reason.
Rejections are logged (flushed — systemd buffers otherwise) because an honest
wrong hostname and an attack look identical from outside, and a 403 on the
family URL has to be diagnosable from `journalctl`.

### Valve lag (open)

Circuit flags follow the relay; valve actuators take ~20-30s to rotate. So the
panel reports the spa circuit on — and the client resolves PENDING to IDLE —
while water is still routing to the pool. Not incorrect (we render the pool's
truth) but it reads as "it says it's on, why is it cold".

A fixed "switching…" timer on the mode control would paper over it, but the
panel already reports `pool_delay` / `spa_delay`, so the honest fix ends the
switching state when the *panel* says the valves are done, keeping the pool as
the source of truth.

Blocked on one observation: screenlogicpy reads these as bare bytes
(`status.py:52-62`) with no enum, so boolean vs countdown vs bitfield is
unknown, and valve delay is a *configurable* panel feature — if it is off, the
flag may never set while the actuators still take their time, which would force
the timer fallback after all. `bridge/watch_delays.py` samples them once a
second across a real pool→spa switch; one switch settles both questions.

### Freeze protection

The panel engages freeze protection on its own when air temperature nears
freezing, switching circuits on to keep water moving. Rendered as plain
"on" circuits this reads as someone left equipment running, and the natural
family reaction — tapping them off — is exactly the wrong move with pipes
full of water.

`freeze_mode` (screenlogicpy `controller.sensor`, bit `0x08` of the status
byte) is surfaced as `freezeMode` and shown as a dedicated banner, separate
from the connection banner: nothing is wrong, the pool is protecting itself.

The flag is **controller-level, not per-circuit** — the panel reports that it
is protecting itself, never which circuits it forced on. So affected toggles
can't be selectively disabled without guessing. Instead, while freeze is
active, every *off*-tap confirms first (on-taps are never the hazard). This
covers the plain circuit toggles and Pool mode, which switches the spa
circuit off.

---

## 4. Client FSMs (aic-lab three-block Moore idiom, in JS)

Translation of the SystemVerilog pattern:

| SV block | JS realization |
|---|---|
| Next-state logic (`always_comb`) | pure function `transition(state, event) → nextState`, explicit table |
| State register (`always_ff`) | the store (SimpleShoppingList `store` pattern); only the register applies transitions |
| Output logic (Moore) | render derived **only** from current state; handlers never touch the DOM, they dispatch events |
| `default` case | any (state, event) pair not in the table is a logged no-op — nothing can wedge the app |
| Enumerated semantic names | `ONLINE`, `RETRY_WAIT`, … as frozen string constants |

### 4.1 Connection FSM (one instance)

States: `BOOTING, ONLINE, DEGRADED, RETRY_WAIT, RECONNECTING, OFFLINE`
Events: `POLL_OK, POLL_POOL_DOWN, POLL_FAIL, TIMER, RECONNECT_TAPPED, APP_WAKE`

| State | Event | Next | Action / notes |
|---|---|---|---|
| BOOTING | POLL_OK | ONLINE | first fetch on load |
| BOOTING | POLL_POOL_DOWN | DEGRADED | |
| BOOTING | POLL_FAIL | RETRY_WAIT | retryCount = 1 |
| ONLINE | POLL_OK | ONLINE | refresh data |
| ONLINE | POLL_POOL_DOWN | DEGRADED | |
| ONLINE | POLL_FAIL | RETRY_WAIT | retryCount = 1 |
| DEGRADED | POLL_OK | ONLINE | bridge recovered pool link itself |
| DEGRADED | POLL_POOL_DOWN | DEGRADED | |
| DEGRADED | POLL_FAIL | RETRY_WAIT | retryCount = 1 |
| RETRY_WAIT | TIMER | RECONNECTING | backoff schedule 2, 4, 8, 15, 30 s |
| RETRY_WAIT | POLL_OK / POLL_POOL_DOWN | ONLINE / DEGRADED | wake-triggered poll honored (added 2026-07-24) |
| RETRY_WAIT | POLL_FAIL | RETRY_WAIT | count unchanged; backoff re-arms |
| RECONNECTING | POLL_OK | ONLINE | retryCount reset |
| RECONNECTING | POLL_POOL_DOWN | DEGRADED | retryCount reset |
| RECONNECTING | POLL_FAIL (count < 5) | RETRY_WAIT | retryCount++ |
| RECONNECTING | POLL_FAIL (count = 5) | OFFLINE | gave up |
| OFFLINE | RECONNECT_TAPPED | RECONNECTING | manual reconnect (requirement) |
| OFFLINE | APP_WAKE | RECONNECTING | phone unlocked / tab visible again |
| RECONNECTING | TIMER | RETRY_WAIT / OFFLINE | watchdog: a poll that never settled, counted as a failed attempt |

`APP_WAKE` is dispatched **only** in OFFLINE (`app.js`, visibility handler).
Waking in any other state fires an immediate `poll()` directly instead — the
result arrives as a normal poll event. It is not an FSM row, so no
`(any) | APP_WAKE | (same)` identity transitions exist, and none should be
added: an unlisted (state, event) pair is meant to mean "cannot happen", and
`APP_WAKE` genuinely cannot arrive outside OFFLINE. Rows for it would be dead
code that dilute that guarantee.

Moore outputs:

| State | Header dot | Controls | Extra |
|---|---|---|---|
| ONLINE | green | enabled | |
| DEGRADED | amber | disabled | banner "Pool link down — server retrying"; temps greyed with age |
| RETRY_WAIT / RECONNECTING | amber | disabled | "Reconnecting (n/5)…"; last-known temps greyed |
| OFFLINE | red | disabled | banner + **Reconnect** button |

Polling: `GET /api/state` every 5 s while page visible; paused when hidden
(Page Visibility API); one immediate poll on wake.

### 4.2 Command FSM (one instance per control)

States: `IDLE, PENDING, FAILED`

| State | Event | Next | Action / notes |
|---|---|---|---|
| IDLE | TAP | PENDING | POST sent; spinner on control; further taps ignored |
| PENDING | poll confirms target value | IDLE | **the pool is the source of truth** |
| PENDING | HTTP error | FAILED | |
| PENDING | 10 s timeout without confirmation | FAILED | |
| FAILED | 3 s auto | IDLE | toast shown; UI reverts to actual polled state |

Multi-phone coherence falls out for free: every device renders whatever truth
the next poll delivers (e.g., spouse turns on spa → your phone shows it within
one poll cycle).

Hardening (2026-07-24 review): confirmation only runs on `comStatus: ok`
polls (cached pool-down data must not confirm commands); heater/setpoint
targets carry the body captured at tap time (`{body, on}` / `{body, temp}`)
with per-control `confirmed()` predicates, so a mid-flight mode change can't
redirect a command or its confirmation; heater/stepper/slider lock while a
mode (or their own) command is pending; UI notifies no longer reset the poll
timer (only connection transitions do); command POSTs get 8s (vs 4s poll
timeout) to survive the bridge's adapter-lock contention.

---

## 5. PWA (`app/`)

Modeled on SimpleShoppingList's structure and store idiom. Single screen, no
tabs.

```
┌────────────────────────────────────┐
│ PoolLogic                       ●  │   ← com status dot
├────────────────────────────────────┤
│  Air 88°   Pool 84°   Spa 101°     │   ← greyed + "as of 2:03 PM" when stale
├────────────────────────────────────┤
│  Mode      [ POOL ]■[ SPA ]        │   ← two-position switch
│  Heater    [ OFF/ON ]  ◄ 101° ►    │   ← stepper for active body, 40–102
│  Jets      [ OFF/ON ]              │
│  Cleaner   [ OFF/ON ]              │
│  Spillway  [ OFF/ON ]              │
│  Pool Light[ OFF/ON ]              │
│  Spa Light [ OFF/ON ]              │
│  Light Show  ( White )( Caribbean )│   ← visible when a light is on
└────────────────────────────────────┘
```

Big touch targets (poolside, wet hands). Manifest + 192/512 icons for
add-to-home-screen; **no service worker** (see §1).

### File layout

```
PoolLogic/
├── DESIGN.md
├── app/
│   ├── index.html
│   ├── manifest.json
│   ├── icons/icon-192.png, icon-512.png
│   ├── css/styles.css
│   └── js/
│       ├── app.js              # boot, poll scheduler, visibility handling
│       ├── state.js            # store = state register (SimpleShoppingList idiom)
│       ├── api.js              # fetch wrappers → events, never state
│       ├── fsm/
│       │   ├── connection.js   # table + transition() (pure)
│       │   └── command.js      # per-control machines (pure)
│       └── views/panel.js      # Moore output logic: render(state)
└── bridge/
    ├── bridge.py
    ├── mock.py
    ├── config.json
    └── requirements.txt        # screenlogicpy, aiohttp
```

---

## 6. Build milestones

1. **M1 — bridge skeleton + mock**: `GET /api/state` + static serving, `--mock`
   with drifting temps and failure injection. Verified with curl/browser.
2. **M2 — PWA skeleton + connection FSM** against mock: temps banner, com dot,
   full reconnect/backoff/OFFLINE/manual-reconnect behavior exercised via
   failure injection.
3. **M3 — controls + command FSMs** against mock: all toggles, heater on/off +
   setpoint, light show picker; PENDING/FAILED paths exercised.
4. **M4 — real pool**: circuit-ID discovery via screenlogicpy CLI, fill
   config.json, integration test with actual equipment (official Pentair app
   confirmed working on the wifi, so adapter is present and reachable).
5. **M5 — polish + deployment**: icons, styling pass, add-to-home-screen check
   on iOS/Android, runbook for moving the bridge to the turnkey box.
6. **M6 — in service**: everything after the bridge went live on the Pi, driven
   by review rather than plan. Freeze protection surfaced; reading age split
   from poll age; browser-origin guards (Content-Type + Host); two connection
   FSM liveness bugs closed with regression tests; clean shutdown; machine
   config separated from shipped defaults so updates stop colliding; the
   read-only circuit map at `/?config` for verifying `circuitIds` against the
   panel from a phone at the equipment pad.

Each milestone is independently demonstrable; M1–M3 require no pool access.
