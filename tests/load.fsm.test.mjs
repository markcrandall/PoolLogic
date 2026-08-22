// Load FSM tests. Same shape as command.fsm.test.mjs: totality sweep, identity
// no-ops for the unfilled cells, then one test per filled cell.
//
// The table is 3 states x 3 events = 9 cells, 4 of them filled, and two of the
// four are subtle enough that only a test pins them:
//
//   LOADED + FETCH_FAIL keeps the last good data AND returns the same object.
//   Blanking a page someone is reading at the equipment pad because one poll's
//   panel fetch dropped is the failure this cell exists to prevent.
//
//   RETRY is honored ONLY in FAILED. views/config.js dispatches it on every
//   poll and relies on it being inert everywhere else — a RETRY that reset a
//   LOADED resource would blank the tables once per poll cycle.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LoadState,
  LoadEvent,
  loading,
  loadTransition,
} from "../app/js/fsm/load.js";

const STATES = Object.values(LoadState);
const EVENTS = Object.values(LoadEvent);

// loadTransition() console.debug's every ignored pair; silence the sweeps.
function quiet(fn) {
  const real = console.debug;
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.debug = real;
  }
}

const at = (state, data = null) => ({ state, data });

test("total: no (state, event) pair throws or yields an invalid state", () => {
  quiet(() => {
    for (const state of STATES) {
      for (const event of EVENTS) {
        for (const data of [null, {}, { circuits: [] }]) {
          const next = loadTransition(at(state), event, data);
          assert.ok(STATES.includes(next.state), `${state}+${event} -> ${next.state}`);
          assert.ok("data" in next, `${state}+${event} dropped the data field`);
        }
      }
    }
  });
});

test("unlisted pairs are identity no-ops", () => {
  quiet(() => {
    const cases = [
      [LoadState.LOADING, LoadEvent.RETRY],
      [LoadState.LOADED, LoadEvent.RETRY],
      [LoadState.FAILED, LoadEvent.FETCH_OK],
      [LoadState.FAILED, LoadEvent.FETCH_FAIL],
    ];
    for (const [state, event] of cases) {
      const load = at(state, { some: "data" });
      assert.equal(
        loadTransition(load, event),
        load,
        `${state}+${event} must return the same object`
      );
    }
  });
});

// --- The RETRY guard --------------------------------------------------------
// views/config.js calls loadTransition(res.load, RETRY) unconditionally, every
// poll, for both resources. FAILED is the only state that may move.
test("RETRY is honored only in FAILED", () => {
  quiet(() => {
    const failed = at(LoadState.FAILED);
    assert.equal(loadTransition(failed, LoadEvent.RETRY), loading);

    for (const state of [LoadState.LOADING, LoadState.LOADED]) {
      const load = at(state, { keep: true });
      assert.equal(
        loadTransition(load, LoadEvent.RETRY),
        load,
        `${state} must ignore RETRY or the config page blanks once per poll`
      );
    }
  });
});

// --- One test per filled cell ----------------------------------------------

test("LOADING + FETCH_OK -> LOADED carrying the data", () => {
  const data = { circuitIds: { spa: 500 } };
  const next = loadTransition(loading, LoadEvent.FETCH_OK, data);
  assert.equal(next.state, LoadState.LOADED);
  assert.equal(next.data, data);
});

test("LOADING + FETCH_FAIL -> FAILED with no data", () => {
  const next = loadTransition(loading, LoadEvent.FETCH_FAIL);
  assert.equal(next.state, LoadState.FAILED);
  assert.equal(next.data, null);
  // "not here yet" and "the fetch failed" are different answers — that
  // distinction is the entire reason this machine replaced a nullable.
  assert.notEqual(next.state, LoadState.LOADING);
});

test("LOADED + FETCH_OK -> LOADED with the fresh data", () => {
  const first = loadTransition(loading, LoadEvent.FETCH_OK, { n: 1 });
  const second = loadTransition(first, LoadEvent.FETCH_OK, { n: 2 });
  assert.equal(second.state, LoadState.LOADED);
  assert.equal(second.data.n, 2);
});

test("LOADED + FETCH_FAIL keeps the last good data, as the SAME object", () => {
  const data = { pumps: [{ id: 0 }] };
  const loaded = loadTransition(loading, LoadEvent.FETCH_OK, data);
  const next = loadTransition(loaded, LoadEvent.FETCH_FAIL);
  assert.equal(next.state, LoadState.LOADED, "must not fall back to FAILED");
  assert.equal(next.data, data, "the page someone is reading must not blank");
  // Listed in the table rather than left to the default, and returns `load`
  // because nothing changed. Identity is what callers check for a no-op.
  assert.equal(next, loaded, "nothing changed, so nothing new should be built");
});

test("FAILED + RETRY -> the frozen loading singleton", () => {
  const next = loadTransition(at(LoadState.FAILED), LoadEvent.RETRY);
  assert.equal(next, loading, "must be the shared singleton");
  assert.equal(next.data, null);
});

// --- Recovery round trip ----------------------------------------------------
test("a dropped first fetch recovers on a later retry", () => {
  // The bug this machine was built for: one dropped /api/config at boot left
  // the config page reading "Loading circuit map…" until a manual reload.
  let load = loading;
  load = loadTransition(load, LoadEvent.FETCH_FAIL);
  assert.equal(load.state, LoadState.FAILED);
  load = loadTransition(load, LoadEvent.RETRY);
  assert.equal(load.state, LoadState.LOADING);
  load = loadTransition(load, LoadEvent.FETCH_OK, { ok: true });
  assert.equal(load.state, LoadState.LOADED);
  assert.equal(load.data.ok, true);
});
