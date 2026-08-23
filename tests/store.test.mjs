// State-register tests. The two pure transition functions are covered
// elsewhere; this covers the thing that applies them, because the register is
// where the two rules with real-world consequences live:
//
//   1. a poll is the confirmation channel — the pool is the source of truth
//   2. a pool-down payload carries the bridge's CACHED state and must never
//      confirm a command the equipment may never have seen
//
// Rule 2 is the reason this file exists. Nothing else tests it, and getting it
// wrong shows a tap as succeeded when the pool never got it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { store } from "../app/js/state.js";
import { ConnState, ConnEvent } from "../app/js/fsm/connection.js";
import { CmdState, CmdEvent } from "../app/js/fsm/command.js";
import { SETPOINT_MIN, SETPOINT_MAX } from "../app/js/controls.js";

// The store is a module singleton, so each test starts from a known register.
function reset() {
  const s = store.getState();
  s.conn = { state: ConnState.ONLINE, retryCount: 0 };
  s.pool = null;
  s.lastUpdated = null;
  s.commands = {};
  s.setpointDraft = null;
  s.limits = { min: SETPOINT_MIN, max: SETPOINT_MAX };
}

const payload = (over = {}) => ({
  comStatus: "ok",
  circuits: {
    pool: true,
    spa: false,
    jets: false,
    cleaner: false,
    spillway: false,
    poolLight: false,
    spaLight: false,
  },
  heat: {
    pool: { setpoint: 78, on: false, active: false },
    spa: { setpoint: 101, on: false, active: false },
  },
  lightShow: null,
  ...over,
});

const withCircuit = (name, on, over = {}) =>
  payload({ circuits: { ...payload().circuits, [name]: on }, ...over });

test("a poll confirms a PENDING command once the pool reports the target", () => {
  reset();
  store.dispatchCommand("jets", CmdEvent.TAP, true);
  assert.equal(store.getCommand("jets").state, CmdState.PENDING);

  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("jets", true));
  assert.equal(store.getCommand("jets").state, CmdState.IDLE);
});

test("a poll that does not yet show the target leaves the command PENDING", () => {
  reset();
  store.dispatchCommand("jets", CmdEvent.TAP, true);
  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("jets", false));
  assert.equal(store.getCommand("jets").state, CmdState.PENDING);
});

// --- The rule that matters --------------------------------------------------
test("a pool-down payload never confirms a pending command", () => {
  reset();
  store.dispatchCommand("jets", CmdEvent.TAP, true);

  // The bridge answers 200 from cache while the pool link is down, and that
  // cache can already show the target value — from an earlier state, or from
  // this very command having been accepted by the bridge but not the panel.
  store.dispatchConn(
    ConnEvent.POLL_POOL_DOWN,
    withCircuit("jets", true, { comStatus: "pool_unreachable" })
  );

  assert.equal(
    store.getCommand("jets").state,
    CmdState.PENDING,
    "a cached payload must not stand in for the equipment's own answer"
  );
  assert.equal(store.getState().conn.state, ConnState.DEGRADED);
});

test("structured targets are confirmed by the control's own predicate", () => {
  reset();
  // The heater target carries the body captured at tap time, so a mode change
  // mid-flight cannot redirect the confirmation to the other body.
  store.dispatchCommand("heater", CmdEvent.TAP, { body: "spa", on: true });

  // The pool body heating is not this command's answer.
  store.dispatchConn(
    ConnEvent.POLL_OK,
    payload({
      heat: {
        pool: { setpoint: 78, on: true, active: true },
        spa: { setpoint: 101, on: false, active: false },
      },
    })
  );
  assert.equal(store.getCommand("heater").state, CmdState.PENDING);

  store.dispatchConn(
    ConnEvent.POLL_OK,
    payload({
      heat: {
        pool: { setpoint: 78, on: false, active: false },
        spa: { setpoint: 101, on: true, active: true },
      },
    })
  );
  assert.equal(store.getCommand("heater").state, CmdState.IDLE);
});

// --- A command that writes twice is confirmed on both writes ---------------
// `mode` posts the spa circuit and then the courtesy heat. With no confirmed()
// of its own it fell back to read(pool) === target, which watches the circuit
// alone: a poll could confirm the circuit, move the command to IDLE, and leave
// failIfCurrent with nothing to fail when the heat POST came back an error.
// The switch reported success and the heat silently never happened — which is
// the entire reason mode is one command and not two.
// Reproduce the bridge side with POST /api/mock/fail_heat {"on": true}.
const heat = (over) => ({
  pool: { setpoint: 78, on: false, active: false },
  spa: { setpoint: 101, on: false, active: false },
  ...over,
});

test("entering spa stays PENDING until the courtesy heat lands too", () => {
  reset();
  store.dispatchCommand("mode", CmdEvent.TAP, "spa");

  // Circuit landed, heat did not. Exactly what the mock produces with
  // fail_heat on, and what a slow heat POST looks like at the 5s poll.
  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("spa", true));
  assert.equal(
    store.getCommand("mode").state,
    CmdState.PENDING,
    "half a two-write command is not a confirmed command"
  );

  store.dispatchConn(
    ConnEvent.POLL_OK,
    withCircuit("spa", true, {
      heat: heat({ spa: { setpoint: 101, on: true, active: true } }),
    })
  );
  assert.equal(store.getCommand("mode").state, CmdState.IDLE);
});

test("leaving spa stays PENDING until the heat is off too", () => {
  reset();
  store.dispatchCommand("mode", CmdEvent.TAP, "pool");

  store.dispatchConn(
    ConnEvent.POLL_OK,
    withCircuit("spa", false, {
      heat: heat({ spa: { setpoint: 101, on: true, active: true } }),
    })
  );
  assert.equal(store.getCommand("mode").state, CmdState.PENDING);

  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("spa", false));
  assert.equal(store.getCommand("mode").state, CmdState.IDLE);
});

// Requirement: selecting Pool mode turns off any active spa heater. The
// courtesy-heat command has always sent the heat-off, but nothing asserted the
// leaving-spa direction end to end — only the entering direction was covered.
test("leaving spa is not confirmed until the spa heat is actually off", () => {
  reset();
  store.dispatchConn(
    ConnEvent.POLL_OK,
    withCircuit("spa", true, {
      heat: heat({ spa: { setpoint: 101, on: true, active: true } }),
    })
  );
  store.dispatchCommand("mode", CmdEvent.TAP, "pool");

  // Spa circuit off but the heater still reported on — the panel has not
  // caught up, or the heat-off POST failed. Not done.
  store.dispatchConn(
    ConnEvent.POLL_OK,
    withCircuit("spa", false, {
      heat: heat({ spa: { setpoint: 101, on: true, active: true } }),
    })
  );
  assert.equal(
    store.getCommand("mode").state,
    CmdState.PENDING,
    "a spa heater still running means the mode change is not finished"
  );

  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("spa", false));
  assert.equal(store.getCommand("mode").state, CmdState.IDLE);
});

// The third position. Turning both bodies off is three writes — spa circuit,
// spa heat, pool circuit — and the last of them is the one the two-position
// switch never had, so it is the one a stale predicate would skip.
test("Off stays PENDING until the pool circuit is down too", () => {
  reset();
  store.dispatchConn(ConnEvent.POLL_OK, payload()); // pool running, spa off
  store.dispatchCommand("mode", CmdEvent.TAP, "off");

  // Spa side settled, pool circuit still on: the equipment is still running.
  store.dispatchConn(ConnEvent.POLL_OK, withCircuit("spa", false));
  assert.equal(
    store.getCommand("mode").state,
    CmdState.PENDING,
    "a pool circuit still on means the pool is not off"
  );

  store.dispatchConn(
    ConnEvent.POLL_OK,
    payload({ circuits: { ...payload().circuits, pool: false } })
  );
  assert.equal(store.getCommand("mode").state, CmdState.IDLE);
});

test("a null spa setpoint confirms on the circuit alone", () => {
  reset();
  // send() skips the heat POST entirely when there is no setpoint to send, so
  // waiting on heat here would hang the command until its 10s timeout.
  store.dispatchCommand("mode", CmdEvent.TAP, "spa");
  store.dispatchConn(
    ConnEvent.POLL_OK,
    withCircuit("spa", true, {
      heat: heat({ spa: { setpoint: null, on: false, active: false } }),
    })
  );
  assert.equal(store.getCommand("mode").state, CmdState.IDLE);
});

test("the register applies connection transitions and records the payload", () => {
  reset();
  const data = payload();
  store.dispatchConn(ConnEvent.POLL_OK, data);
  assert.equal(store.getState().pool, data);
  assert.ok(store.getState().lastUpdated instanceof Date);

  store.dispatchConn(ConnEvent.POLL_FAIL);
  assert.equal(store.getState().conn.state, ConnState.RETRY_WAIT);
  // A failed poll carries no payload; the last-known one must survive it, or
  // the temps would blank every time a single poll dropped.
  assert.equal(store.getState().pool, data);
});

// --- Setpoint bounds --------------------------------------------------------
// The UI cap used to be a constant hand-copied from bridge/config.json. The
// bridge enforces its own value with a 400 and config.local.json on the Pi can
// override it, so the copy could drift into a stepper that stops short or a
// command that dies as an unexplained FAILED toast.
test("limits start at the shipped fallback and follow /api/config", () => {
  reset();
  assert.deepEqual(store.getState().limits, {
    min: SETPOINT_MIN,
    max: SETPOINT_MAX,
  });

  store.setLimits(40, 96);
  assert.deepEqual(store.getState().limits, { min: 40, max: 96 });
});

test("an unusable bounds pair leaves the last good one in place", () => {
  reset();
  const quiet = console.warn;
  console.warn = () => {};
  try {
    // NaN would make Math.min/Math.max pass anything through, so a malformed
    // payload must not be allowed to replace a known bound.
    for (const [min, max] of [
      [undefined, 102],
      [40, null],
      [NaN, NaN],
      [102, 40], // inverted
      [80, 80], // empty range
    ]) {
      store.setLimits(min, max);
      assert.deepEqual(
        store.getState().limits,
        { min: SETPOINT_MIN, max: SETPOINT_MAX },
        `${min}-${max} must be refused`
      );
    }
  } finally {
    console.warn = quiet;
  }
});

test("subscribers are notified on every dispatch", () => {
  reset();
  let calls = 0;
  const unsubscribe = store.subscribe(() => (calls += 1));
  try {
    store.dispatchConn(ConnEvent.POLL_OK, payload());
    store.dispatchCommand("jets", CmdEvent.TAP, true);
    store.setSetpointDraft(90);
    assert.equal(calls, 3);
  } finally {
    unsubscribe();
  }
});
