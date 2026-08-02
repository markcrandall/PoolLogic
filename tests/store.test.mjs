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

// The store is a module singleton, so each test starts from a known register.
function reset() {
  const s = store.getState();
  s.conn = { state: ConnState.ONLINE, retryCount: 0 };
  s.pool = null;
  s.lastUpdated = null;
  s.commands = {};
  s.setpointDraft = null;
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
