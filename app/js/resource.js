// One fetched resource: a load FSM for "not here yet / here / the fetch failed",
// plus the pollguard latch that keeps two requests for it from overlapping.
//
// Extracted from views/config.js, which had this inline, once the panel view
// needed the same thing for /api/config. Copying it would have meant a second
// copy of the one subtlety that matters: RETRY is honored only in FAILED, so
// callers can dispatch it every poll and a resource that already has an answer
// is never reset — and the latch, not the FSM, is what stops two in flight.

import { LoadState, LoadEvent, loading, loadTransition } from "./fsm/load.js";
import { createPollGuard } from "./pollguard.js";

// fetcher() must resolve to the data, or to null for a failure — the contract
// api.js's fetchConfig/fetchPanelInfo already follow. It must not reject; if it
// did, the latch would never be released and the resource would go quiet.
export function createResource(fetcher, onSettled = () => {}) {
  const guard = createPollGuard();
  let load = loading;

  const resource = {
    get load() {
      return load;
    },

    fetch() {
      const token = guard.begin();
      if (token === null) return; // one at a time, per resource
      // Ignored outside FAILED; dispatching it unconditionally is what lets a
      // resource fetched on every poll climb back out of a failure without a
      // second code path.
      load = loadTransition(load, LoadEvent.RETRY);
      fetcher().then((data) => {
        if (!guard.settle(token)) return;
        load = loadTransition(
          load,
          data === null ? LoadEvent.FETCH_FAIL : LoadEvent.FETCH_OK,
          data
        );
        onSettled(load);
      });
    },

    // For a resource that is fetched once and only needs re-asking after a
    // failure — a static payload the bridge only re-reads on restart.
    retryIfFailed() {
      if (load.state === LoadState.FAILED) resource.fetch();
    },
  };

  return resource;
}
