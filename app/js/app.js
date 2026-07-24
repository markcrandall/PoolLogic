// Boot, poll scheduler, and visibility handling. The scheduler is driven by
// the connection FSM's current state after every transition — it owns all
// timers and is the only caller of the API layer.

import { store } from "./state.js";
import { fetchState } from "./api.js";
import { ConnState, ConnEvent, BACKOFF_SECONDS } from "./fsm/connection.js";
import { render, bindHandlers } from "./views/panel.js";

const POLL_INTERVAL_MS = 5000;

let timer = null;
let pollInFlight = false;

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  const { event, data } = await fetchState();
  pollInFlight = false;
  store.dispatchConn(event, data);
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
    case ConnState.RECONNECTING:
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
  } else {
    poll(); // immediate refresh in any other state
  }
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
