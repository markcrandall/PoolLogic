// Connection FSM tests. transition() is pure and total, so this needs no DOM,
// no server and no dependencies: node --test tests/
//
// Lives outside app/ deliberately — the bridge serves everything under app/,
// and DEPLOY copies only app/ and bridge/ to the Pi.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ConnState,
  ConnEvent,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  transition,
} from "../app/js/fsm/connection.js";

const STATES = Object.values(ConnState);
const EVENTS = Object.values(ConnEvent);

// transition() console.debug's every ignored pair; silence it for the sweeps.
function quiet(fn) {
  const real = console.debug;
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.debug = real;
  }
}

test("total: no (state, event) pair throws or yields an invalid state", () => {
  quiet(() => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        for (const retryCount of [0, 1, 3, MAX_ATTEMPTS, MAX_ATTEMPTS + 1]) {
          const next = transition({ state, retryCount }, event);
          assert.ok(STATES.includes(next.state), `${state}+${event} -> ${next.state}`);
          assert.ok(Number.isInteger(next.retryCount) && next.retryCount >= 0);
        }
      }
    }
  });
});

test("unlisted pairs are identity no-ops", () => {
  quiet(() => {
    const conn = { state: ConnState.ONLINE, retryCount: 0 };
    // ONLINE has no TIMER / RECONNECT_TAPPED / APP_WAKE row.
    for (const event of [ConnEvent.TIMER, ConnEvent.RECONNECT_TAPPED, ConnEvent.APP_WAKE]) {
      assert.equal(transition(conn, event), conn, `${event} must return the same object`);
    }
  });
});

test("retryCount never exceeds MAX_ATTEMPTS before giving up", () => {
  let conn = { state: ConnState.ONLINE, retryCount: 0 };
  const seen = [];
  for (let i = 0; i < 50 && conn.state !== ConnState.OFFLINE; i++) {
    conn = transition(conn, ConnEvent.POLL_FAIL);
    seen.push(conn.retryCount);
    if (conn.state === ConnState.RETRY_WAIT) conn = transition(conn, ConnEvent.TIMER);
  }
  assert.equal(conn.state, ConnState.OFFLINE);
  assert.ok(Math.max(...seen) <= MAX_ATTEMPTS, `saw ${Math.max(...seen)}`);
});

test("BACKOFF_SECONDS covers every retryCount the FSM can produce", () => {
  // app.js indexes BACKOFF_SECONDS[min(retryCount - 1, len - 1)].
  for (let count = 1; count <= MAX_ATTEMPTS; count++) {
    const idx = Math.min(count - 1, BACKOFF_SECONDS.length - 1);
    assert.equal(typeof BACKOFF_SECONDS[idx], "number", `no backoff for retryCount ${count}`);
  }
});

// --- Regression: the RETRY_WAIT livelock ------------------------------------
// A wake-triggered poll can fail while the backoff is still pending. That used
// to return {...conn} — a fresh object with retryCount UNCHANGED — so repeated
// wake/fail cycles re-armed the same interval forever: pinned at
// "Reconnecting (3/5)", OFFLINE never reached, and the Reconnect button (which
// only renders in OFFLINE) never offered. Asserting "retryCount unchanged"
// here would enshrine exactly that bug; the count must advance.
test("regression: repeated POLL_FAIL in RETRY_WAIT advances and reaches OFFLINE", () => {
  let conn = { state: ConnState.RETRY_WAIT, retryCount: 3 };
  const counts = [];
  for (let i = 0; i < 10 && conn.state !== ConnState.OFFLINE; i++) {
    const before = conn.retryCount;
    conn = transition(conn, ConnEvent.POLL_FAIL);
    counts.push(conn.retryCount);
    if (conn.state === ConnState.RETRY_WAIT) {
      assert.ok(conn.retryCount > before, "a failed attempt must advance the counter");
    }
  }
  assert.equal(conn.state, ConnState.OFFLINE, `stuck at ${conn.state}(${conn.retryCount})`);
});

test("regression: POLL_FAIL in RETRY_WAIT always returns a new object", () => {
  // Identity change is what re-arms the timer app.js cleared when the app was
  // hidden. Returning `conn` unchanged would leave no timer and no polling.
  const conn = { state: ConnState.RETRY_WAIT, retryCount: 1 };
  assert.notEqual(transition(conn, ConnEvent.POLL_FAIL), conn);
});

// --- Regression: RECONNECTING had no self-rescue ----------------------------
test("regression: RECONNECTING + TIMER (watchdog) counts as a failed attempt", () => {
  const mid = transition({ state: ConnState.RECONNECTING, retryCount: 2 }, ConnEvent.TIMER);
  assert.equal(mid.state, ConnState.RETRY_WAIT);
  assert.equal(mid.retryCount, 3);

  const last = transition(
    { state: ConnState.RECONNECTING, retryCount: MAX_ATTEMPTS },
    ConnEvent.TIMER
  );
  assert.equal(last.state, ConnState.OFFLINE, "a hung poll must still reach OFFLINE");
});

test("RECONNECTING cannot be a trap: every event leads somewhere or is inert", () => {
  quiet(() => {
    const conn = { state: ConnState.RECONNECTING, retryCount: 1 };
    const exits = EVENTS.map((e) => transition(conn, e)).filter((n) => n !== conn);
    assert.ok(exits.length >= 4, "needs the three poll results plus the watchdog");
  });
});

// --- Manual vs automatic reconnect parity -----------------------------------
function attemptsUntilOffline(start) {
  let conn = start;
  let attempts = 0;
  for (let i = 0; i < 50 && conn.state !== ConnState.OFFLINE; i++) {
    if (conn.state === ConnState.RETRY_WAIT) {
      conn = transition(conn, ConnEvent.TIMER);
      continue;
    }
    if (conn.state === ConnState.RECONNECTING) attempts++;
    conn = transition(conn, ConnEvent.POLL_FAIL);
  }
  assert.equal(conn.state, ConnState.OFFLINE);
  return attempts;
}

test("a manual reconnect gets the same number of attempts as the automatic path", () => {
  const manual = attemptsUntilOffline(
    transition({ state: ConnState.OFFLINE, retryCount: 0 }, ConnEvent.RECONNECT_TAPPED)
  );
  const automatic = attemptsUntilOffline(
    transition({ state: ConnState.ONLINE, retryCount: 0 }, ConnEvent.POLL_FAIL)
  );
  assert.equal(manual, MAX_ATTEMPTS, `manual gave ${manual}`);
  assert.equal(
    manual,
    automatic,
    `manualRetry starts at retryCount 1 on purpose: ${manual} vs ${automatic}`
  );
});

test("APP_WAKE is an OFFLINE-only event", () => {
  quiet(() => {
    for (const state of STATES) {
      const conn = { state, retryCount: 1 };
      const next = transition(conn, ConnEvent.APP_WAKE);
      if (state === ConnState.OFFLINE) {
        assert.equal(next.state, ConnState.RECONNECTING);
      } else {
        // app.js dispatches APP_WAKE only from OFFLINE; elsewhere it polls
        // directly. Identity rows here would be unreachable code and would
        // dilute "unlisted means cannot happen".
        assert.equal(next, conn, `${state} must not handle APP_WAKE`);
      }
    }
  });
});
