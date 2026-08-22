// Load FSM — next-state logic for one fetched resource (pure). Same three-block
// idiom as fsm/connection.js: this is the combinational block, the view holds
// the register, and render() is the output logic.
//
// It exists because `null` was doing two jobs — "not here yet" and "the fetch
// failed". Nothing could tell them apart, so nothing could retry: one dropped
// /api/config at boot left the config page reading "Loading circuit map…"
// until a manual reload, on a phone, at the equipment pad, on exactly the
// marginal wifi that caused it.

export const LoadState = Object.freeze({
  LOADING: "LOADING",
  LOADED: "LOADED",
  FAILED: "FAILED",
});

export const LoadEvent = Object.freeze({
  FETCH_OK: "FETCH_OK",
  FETCH_FAIL: "FETCH_FAIL",
  RETRY: "RETRY",
});

export const loading = Object.freeze({ state: LoadState.LOADING, data: null });

const toLoaded = (load, data) => ({ state: LoadState.LOADED, data });
const toFailed = () => ({ state: LoadState.FAILED, data: null });

const TABLE = {
  [LoadState.LOADING]: {
    [LoadEvent.FETCH_OK]: toLoaded,
    [LoadEvent.FETCH_FAIL]: toFailed,
  },
  [LoadState.LOADED]: {
    [LoadEvent.FETCH_OK]: toLoaded,
    // Keep the last good data rather than blanking a page someone is reading
    // at the pad. Listed rather than left to the default so it reads as a
    // decision, and returns the same object because nothing changed.
    [LoadEvent.FETCH_FAIL]: (load) => load,
  },
  [LoadState.FAILED]: {
    [LoadEvent.RETRY]: () => loading,
  },
};

// Exported for the DESIGN.md drift check in tests/design.doc.test.mjs, same as
// CONNECTION_TABLE. A machine whose table nothing executes is a table nobody
// notices going stale.
export { TABLE as LOAD_TABLE };

// Returns the SAME object reference when the event is ignored, so callers can
// detect no-op transitions by identity — RETRY is only honored in FAILED, so a
// retry cannot restart a resource that already has an answer.
//
// Note what this does NOT do: LOADING means "no data yet", not "a fetch is in
// flight", and nothing here tracks a request. A caller that re-fetches on a
// cadence rather than only out of FAILED has to serialize its own requests —
// views/config.js gives each resource a pollguard latch for exactly that.
export function loadTransition(load, event, data = null) {
  const fn = TABLE[load.state]?.[event];
  if (!fn) {
    console.debug(`load FSM: ignored ${event} in ${load.state}`);
    return load;
  }
  return fn(load, data);
}
