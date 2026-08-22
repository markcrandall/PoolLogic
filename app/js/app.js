// Boot, poll scheduler, and visibility handling. The scheduler is driven by
// the connection FSM's current state after every transition — it owns all
// timers and is the only caller of the API layer.
//
// The decision of what to arm lives in schedule.js (pure) and the in-flight
// bookkeeping in pollguard.js; what is left here is the executor and the DOM
// wiring, which is the part that genuinely needs a browser.

import { store } from "./state.js";
import { fetchState } from "./api.js";
import { ConnState, ConnEvent } from "./fsm/connection.js";
import { nextSchedule } from "./schedule.js";
import { createPollGuard } from "./pollguard.js";
import { ViewMode, resolveMode, setViewMode } from "./viewmode.js";
import * as panelView from "./views/panel.js";
import * as configView from "./views/config.js";

// Three URLs, one store and one poll loop — only the output logic differs, so
// connection handling stays in one place.
//
//   /         spa-only heating (default): the pool body cannot be heated
//   /?pool    the full panel, pool heater included
//   /?config  the read-only circuit map
//
// Resolved here, before anything renders, because this is the only module that
// should be reading `location` — which is what keeps the policy in viewmode.js
// pure and testable in node.
const mode = resolveMode(location.search);
setViewMode(mode);
const view = mode === ViewMode.CONFIG ? configView : panelView;
const { render, bindHandlers } = view;

// One timer, always cleared before a new one is armed (see schedule), so a
// stale timer can never be delivered against the wrong state.
let timer = null;
const polls = createPollGuard();

async function poll() {
  const token = polls.begin();
  if (token === null) return; // one at a time
  const { event, data } = await fetchState();
  if (!polls.settle(token)) return; // superseded by the watchdog
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

  const plan = nextSchedule(store.getState().conn);
  switch (plan.kind) {
    case "poll":
      poll();
      break;
    case "pollAfter":
      timer = setTimeout(poll, plan.delayMs);
      break;
    case "wait":
      timer = setTimeout(() => store.dispatchConn(plan.event), plan.delayMs);
      break;
    case "watchdog":
      // Arm before polling: if the poll settles (it always should) the
      // resulting transition re-enters schedule(), which clears this.
      timer = setTimeout(() => {
        // The poll it was waiting on is written off here, so when the
        // watchdog counts this as a failed attempt the poll's own late
        // answer cannot count it a second time and skip a backoff rung.
        polls.abandon();
        store.dispatchConn(plan.event);
      }, plan.delayMs);
      poll();
      break;
    case "idle":
      break;
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
