// Boot, poll scheduler, and visibility handling. The scheduler is driven by
// the connection FSM's current state after every transition — it owns all
// timers and is the only caller of the API layer.

import { store } from "./state.js";
import { fetchState } from "./api.js";
import { ConnState, ConnEvent, BACKOFF_SECONDS } from "./fsm/connection.js";
import * as panelView from "./views/panel.js";
import * as configView from "./views/config.js";

// /?config swaps in the read-only circuit map. Same store, same poll loop —
// only the output logic differs, so connection handling stays in one place.
const view = new URLSearchParams(location.search).has("config")
  ? configView
  : panelView;
const { render, bindHandlers } = view;

const POLL_INTERVAL_MS = 5000;
// Comfortably past the 4s fetch timeout, so a normal reconnect poll always
// settles and transitions out (cancelling this) long before it fires. It only
// matters if a poll never settles at all, which would otherwise strand
// RECONNECTING — the one state with no timer of its own.
const RECONNECT_WATCHDOG_MS = 10000;

// One timer, always cleared before a new one is armed (see schedule), so a
// stale timer can never be delivered against the wrong state.
let timer = null;
let pollInFlight = false;
// Bumped when a poll is given up on. Its eventual answer — if it ever comes —
// is then discarded rather than counted a second time.
let pollGeneration = 0;

function abandonPoll() {
  pollGeneration += 1;
  // Also releases the in-flight latch: a poll that never settles would
  // otherwise leave it set and silently swallow every future poll.
  pollInFlight = false;
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  const generation = pollGeneration;
  const { event, data } = await fetchState();
  if (generation !== pollGeneration) return; // superseded by the watchdog
  pollInFlight = false;
  store.dispatchConn(event, data);
  // A view may need data outside /api/state. It piggybacks on the poll cadence
  // rather than running its own timer, so the scheduler stays the only thing
  // that decides when the network gets touched.
  view.afterPoll?.();
}

function schedule() {
  clearTimeout(timer);
  timer = null;
  if (document.hidden) return; // paused; APP_WAKE restarts things

  const { state, retryCount } = store.getState().conn;
  switch (state) {
    case ConnState.ONLINE:
    case ConnState.DEGRADED:
      timer = setTimeout(poll, POLL_INTERVAL_MS);
      break;
    case ConnState.BOOTING:
      poll();
      break;
    case ConnState.RECONNECTING:
      // Arm before polling: if the poll settles (it always should) the
      // resulting transition re-enters schedule(), which clears this.
      timer = setTimeout(() => {
        // The poll it was waiting on is written off here, so when the
        // watchdog counts this as a failed attempt the poll's own late
        // POLL_FAIL cannot count it a second time and skip a backoff rung.
        abandonPoll();
        store.dispatchConn(ConnEvent.TIMER);
      }, RECONNECT_WATCHDOG_MS);
      poll();
      break;
    case ConnState.RETRY_WAIT: {
      const idx = Math.min(retryCount - 1, BACKOFF_SECONDS.length - 1);
      timer = setTimeout(
        () => store.dispatchConn(ConnEvent.TIMER),
        BACKOFF_SECONDS[idx] * 1000
      );
      break;
    }
    case ConnState.OFFLINE:
      break; // quiescent until RECONNECT_TAPPED or APP_WAKE
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
    timer = null;
    return;
  }
  const { state } = store.getState().conn;
  if (state === ConnState.OFFLINE) {
    store.dispatchConn(ConnEvent.APP_WAKE); // OFFLINE -> RECONNECTING
    return;
  }
  poll(); // immediate refresh in any other state
  // Re-arm whatever the hide cleared. Without this, waking in RECONNECTING or
  // RETRY_WAIT leaves no timer at all — the transition that would normally
  // re-enter schedule() only happens once that poll resolves, so a poll that
  // never settles strands the app in exactly the state the watchdog exists to
  // rescue. schedule() is idempotent here: for states that poll on entry its
  // poll() call is swallowed by the in-flight latch.
  schedule();
});

document.addEventListener("DOMContentLoaded", () => {
  bindHandlers();
  let lastConn = store.getState().conn;
  store.subscribe((state) => {
    // A throwing render must not kill the scheduler (and with it, polling).
    try {
      render(state);
    } catch (ex) {
      console.error("render failed:", ex);
    }
    // Re-arm the scheduler only when the connection FSM produced a new state
    // object (transitions and completed polls). Command/draft notifies leave
    // conn untouched and must NOT reset the poll timer — continuous UI
    // interaction would starve polling and time out confirmations.
    if (state.conn !== lastConn) {
      lastConn = state.conn;
      schedule();
    }
  });
  render(store.getState());
  schedule(); // BOOTING -> fires the first poll
});
