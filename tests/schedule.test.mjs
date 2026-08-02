// Scheduler tests: the timer decision (schedule.js) and the in-flight
// bookkeeping (pollguard.js). Both were extracted out of app.js precisely so
// they could be tested — what is left there is DOM wiring and needs a browser,
// and is covered by the mock end-to-end run instead.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ConnState,
  ConnEvent,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
} from "../app/js/fsm/connection.js";
import {
  nextSchedule,
  POLL_INTERVAL_MS,
  RECONNECT_WATCHDOG_MS,
} from "../app/js/schedule.js";
import { createPollGuard } from "../app/js/pollguard.js";

const STATES = Object.values(ConnState);

// --- The timer decision -----------------------------------------------------

test("every connection state produces a usable plan", () => {
  for (const state of STATES) {
    for (const retryCount of [0, 1, 3, MAX_ATTEMPTS]) {
      const plan = nextSchedule({ state, retryCount });
      assert.ok(plan, `${state} produced no plan`);
      if (plan.delayMs !== undefined) {
        assert.ok(
          Number.isFinite(plan.delayMs) && plan.delayMs > 0,
          `${state}(${retryCount}) -> delayMs ${plan.delayMs}`
        );
      }
    }
  }
});

// The invariant behind the visibility handler's re-arm: waking into any state
// but OFFLINE must leave something running. A state with no timer and no poll
// is the wedge the watchdog exists to prevent, and OFFLINE is the one state
// allowed to sit still — it renders a Reconnect button.
test("no state except OFFLINE is left with nothing armed", () => {
  for (const state of STATES) {
    const plan = nextSchedule({ state, retryCount: 1 });
    if (state === ConnState.OFFLINE) {
      assert.equal(plan.kind, "idle");
      continue;
    }
    assert.notEqual(plan.kind, "idle", `${state} would sit with no timer`);
  }
});

test("BOOTING polls immediately; ONLINE and DEGRADED poll on the interval", () => {
  assert.deepEqual(nextSchedule({ state: ConnState.BOOTING, retryCount: 0 }), {
    kind: "poll",
  });
  for (const state of [ConnState.ONLINE, ConnState.DEGRADED]) {
    assert.deepEqual(nextSchedule({ state, retryCount: 0 }), {
      kind: "pollAfter",
      delayMs: POLL_INTERVAL_MS,
    });
  }
});

test("RECONNECTING polls and arms the watchdog", () => {
  const plan = nextSchedule({ state: ConnState.RECONNECTING, retryCount: 2 });
  assert.equal(plan.kind, "watchdog");
  assert.equal(plan.delayMs, RECONNECT_WATCHDOG_MS);
  assert.equal(plan.event, ConnEvent.TIMER);
  // The watchdog must outlast a poll that is merely slow, or a normal
  // reconnect would be written off as a hang.
  assert.ok(plan.delayMs > POLL_INTERVAL_MS);
});

test("RETRY_WAIT walks the backoff ladder and holds at the last rung", () => {
  const delays = [];
  for (let retryCount = 1; retryCount <= MAX_ATTEMPTS; retryCount++) {
    const plan = nextSchedule({ state: ConnState.RETRY_WAIT, retryCount });
    assert.equal(plan.kind, "wait");
    assert.equal(plan.event, ConnEvent.TIMER);
    delays.push(plan.delayMs);
  }
  assert.deepEqual(delays, BACKOFF_SECONDS.map((s) => s * 1000));

  // Out of range would index past the end and yield NaN — and setTimeout(NaN)
  // fires immediately, turning the backoff into a hot loop.
  for (const retryCount of [0, MAX_ATTEMPTS + 3]) {
    const { delayMs } = nextSchedule({ state: ConnState.RETRY_WAIT, retryCount });
    assert.ok(Number.isFinite(delayMs) && delayMs > 0, `retryCount ${retryCount}`);
  }
});

// --- The in-flight bookkeeping ---------------------------------------------

test("only one poll is in flight at a time", () => {
  const polls = createPollGuard();
  assert.equal(polls.begin(), 0);
  assert.equal(polls.begin(), null, "a second poll must be refused");
  assert.ok(polls.settle(0));
  assert.equal(polls.busy, false);
  assert.equal(polls.begin(), 0, "and allowed again once the first settles");
});

// The watchdog's whole job: count the hung poll as ONE failed attempt.
test("an abandoned poll's late answer is discarded", () => {
  const polls = createPollGuard();
  const token = polls.begin();

  polls.abandon(); // watchdog fires; the FSM is told TIMER instead

  assert.equal(
    polls.settle(token),
    false,
    "the late answer must not be counted a second time"
  );
});

test("abandoning releases the latch so polling can resume", () => {
  const polls = createPollGuard();
  polls.begin();
  polls.abandon();
  // Without this, a poll that never settles leaves the latch set and silently
  // swallows every future poll — the app goes quiet with no error anywhere.
  assert.equal(polls.busy, false);
  assert.notEqual(polls.begin(), null);
});

test("a fresh poll after an abandonment still settles normally", () => {
  const polls = createPollGuard();
  polls.begin();
  polls.abandon();
  const token = polls.begin();
  assert.ok(polls.settle(token));
});
