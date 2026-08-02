// Scheduler policy: Moore output for the connection FSM — state in, timer
// decision out. Pure and DOM-free, so every state's decision is testable;
// app.js is the executor that arms the timer and fires the poll.
//
// The split matters because the decisions are load-bearing and were previously
// only checkable by reading: the backoff index, and the fact that no state
// except OFFLINE may be left with nothing armed and nothing in flight.

import { ConnState, ConnEvent, BACKOFF_SECONDS } from "./fsm/connection.js";

export const POLL_INTERVAL_MS = 5000;
// Comfortably past the 4s fetch timeout, so a normal reconnect poll always
// settles and transitions out (cancelling this) long before it fires. It only
// matters if a poll never settles at all, which would otherwise strand
// RECONNECTING — the one state with no timer of its own.
export const RECONNECT_WATCHDOG_MS = 10000;

// What the executor should do next:
//   poll      — poll now, no timer
//   pollAfter — arm a timer that polls in delayMs
//   wait      — arm a timer that dispatches `event` in delayMs
//   watchdog  — poll now AND arm a timer that abandons it and dispatches
//               `event` if it never settles
//   idle      — nothing; quiescent until a user or visibility event
export function nextSchedule({ state, retryCount }) {
  switch (state) {
    case ConnState.BOOTING:
      return { kind: "poll" };
    case ConnState.ONLINE:
    case ConnState.DEGRADED:
      return { kind: "pollAfter", delayMs: POLL_INTERVAL_MS };
    case ConnState.RECONNECTING:
      return {
        kind: "watchdog",
        delayMs: RECONNECT_WATCHDOG_MS,
        event: ConnEvent.TIMER,
      };
    case ConnState.RETRY_WAIT: {
      // The FSM only ever enters RETRY_WAIT with a count of 1 or more, so the
      // clamp at zero is belt and braces — but an out-of-range index here
      // yields NaN, and setTimeout(NaN) fires immediately, which would turn
      // the backoff into a hot loop against a pool bridge that is already
      // struggling.
      const idx = Math.min(
        Math.max(retryCount - 1, 0),
        BACKOFF_SECONDS.length - 1
      );
      return {
        kind: "wait",
        delayMs: BACKOFF_SECONDS[idx] * 1000,
        event: ConnEvent.TIMER,
      };
    }
    case ConnState.OFFLINE:
      return { kind: "idle" }; // quiescent until RECONNECT_TAPPED or APP_WAKE
  }
  // Unreachable while ConnState stays the closed type it is. Unlike an FSM
  // no-op, though, falling through here would leave the app with no timer and
  // no poll at all, so it is worth a warning rather than a silent default.
  console.warn(`scheduler: unknown connection state ${state}; idling`);
  return { kind: "idle" };
}
