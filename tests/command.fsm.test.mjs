// Command FSM tests. Same shape as connection.fsm.test.mjs: totality sweep,
// identity-no-op assertions, then one test per filled cell.
//
// The table is 3 states x 5 events = 15 cells, 6 of them filled. The empty
// ones are as load-bearing as the filled ones — a TAP that lands while a
// command is already PENDING must be a no-op, and the identity return is the
// only thing the caller has to detect it by.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CmdState,
  CmdEvent,
  idleCommand,
  commandTransition,
} from "../app/js/fsm/command.js";

const STATES = Object.values(CmdState);
const EVENTS = Object.values(CmdEvent);

// commandTransition() console.debug's every ignored pair; silence the sweeps.
function quiet(fn) {
  const real = console.debug;
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.debug = real;
  }
}

const at = (state, extra = {}) => ({
  state,
  target: null,
  since: 0,
  ...extra,
});

test("total: no (state, event) pair throws or yields an invalid state", () => {
  quiet(() => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        for (const target of [null, true, "spa", { body: "spa", temp: 100 }]) {
          const next = commandTransition(at(state), event, target);
          assert.ok(STATES.includes(next.state), `${state}+${event} -> ${next.state}`);
          assert.equal(typeof next.since, "number");
        }
      }
    }
  });
});

// --- The double-POST guard --------------------------------------------------
// commands.js does `if (cmd === before) return;` before sending. That identity
// check is the only thing standing between a double-tap and two POSTs to pool
// equipment, and it works solely because an ignored event returns the same
// object. Nothing else in the app asserts this.
test("TAP while PENDING returns the SAME object (no second POST)", () => {
  quiet(() => {
    const pending = at(CmdState.PENDING, { target: true, since: 1234 });
    const next = commandTransition(pending, CmdEvent.TAP, false);
    assert.equal(next, pending, "must be the same reference, not a copy");
  });
});

test("unlisted pairs are identity no-ops", () => {
  quiet(() => {
    const cases = [
      [CmdState.IDLE, CmdEvent.CONFIRMED],
      [CmdState.IDLE, CmdEvent.HTTP_ERROR],
      [CmdState.IDLE, CmdEvent.TIMEOUT],
      [CmdState.IDLE, CmdEvent.CLEAR],
      [CmdState.PENDING, CmdEvent.TAP],
      [CmdState.PENDING, CmdEvent.CLEAR],
      [CmdState.FAILED, CmdEvent.CONFIRMED],
      [CmdState.FAILED, CmdEvent.HTTP_ERROR],
      [CmdState.FAILED, CmdEvent.TIMEOUT],
    ];
    for (const [state, event] of cases) {
      const cmd = at(state);
      assert.equal(
        commandTransition(cmd, event),
        cmd,
        `${state}+${event} must return the same object`
      );
    }
  });
});

// --- One test per filled cell ----------------------------------------------

test("IDLE + TAP -> PENDING carries the target and stamps since", () => {
  const before = Date.now();
  const next = commandTransition(idleCommand, CmdEvent.TAP, "spa");
  assert.equal(next.state, CmdState.PENDING);
  assert.equal(next.target, "spa");
  assert.ok(next.since >= before, "since must be stamped at TAP");
});

test("PENDING + CONFIRMED -> the frozen idle singleton", () => {
  const next = commandTransition(
    at(CmdState.PENDING, { target: { body: "spa", temp: 100 }, since: 999 }),
    CmdEvent.CONFIRMED
  );
  assert.equal(next, idleCommand, "must be the shared singleton");
  // commands.js guards on `since` to tell one attempt from another. A stale
  // one surviving into IDLE would let an old timer fire against a new command.
  assert.equal(next.target, null);
  assert.equal(next.since, 0);
});

for (const event of [CmdEvent.HTTP_ERROR, CmdEvent.TIMEOUT]) {
  test(`PENDING + ${event} -> FAILED keeping target and since`, () => {
    const pending = at(CmdState.PENDING, { target: false, since: 4321 });
    const next = commandTransition(pending, event);
    assert.equal(next.state, CmdState.FAILED);
    assert.equal(next.target, false);
    // commands.js's auto-clear timer compares this to decide whether the
    // failure it armed for is still the one on screen.
    assert.equal(next.since, 4321);
  });
}

test("FAILED + CLEAR -> the frozen idle singleton", () => {
  const next = commandTransition(
    at(CmdState.FAILED, { target: true, since: 7 }),
    CmdEvent.CLEAR
  );
  assert.equal(next, idleCommand);
});

test("FAILED + TAP -> PENDING with the new target (retry after a failure)", () => {
  const failed = at(CmdState.FAILED, { target: true, since: 7 });
  const next = commandTransition(failed, CmdEvent.TAP, false);
  assert.equal(next.state, CmdState.PENDING);
  assert.equal(next.target, false);
  assert.ok(next.since > 7, "a retry is a new attempt and needs a new stamp");
});
