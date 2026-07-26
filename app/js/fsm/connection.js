// Connection FSM — next-state logic only (pure; the aic-lab "always_comb" block).
// The store is the state register; views/panel.js is the Moore output logic.
// Unlisted (state, event) pairs are logged no-ops so nothing can wedge the app.

export const ConnState = Object.freeze({
  BOOTING: "BOOTING",
  ONLINE: "ONLINE",
  DEGRADED: "DEGRADED",       // bridge reachable, pool link down
  RETRY_WAIT: "RETRY_WAIT",
  RECONNECTING: "RECONNECTING",
  OFFLINE: "OFFLINE",         // gave up; manual reconnect (or app wake) resumes
});

export const ConnEvent = Object.freeze({
  POLL_OK: "POLL_OK",
  POLL_POOL_DOWN: "POLL_POOL_DOWN",
  POLL_FAIL: "POLL_FAIL",
  TIMER: "TIMER",
  RECONNECT_TAPPED: "RECONNECT_TAPPED",
  APP_WAKE: "APP_WAKE",
});

export const MAX_ATTEMPTS = 5;
export const BACKOFF_SECONDS = [2, 4, 8, 15, 30];

// A failed attempt advances the counter, and the last one gives up. Shared by
// RECONNECTING (its own poll failed) and RETRY_WAIT (a wake-triggered poll
// failed mid-backoff) so a retry counts the same however it was triggered.
const retryOrGiveUp = (conn) =>
  conn.retryCount < MAX_ATTEMPTS
    ? { state: ConnState.RETRY_WAIT, retryCount: conn.retryCount + 1 }
    : { state: ConnState.OFFLINE, retryCount: 0 };

const online = () => ({ state: ConnState.ONLINE, retryCount: 0 });
const degraded = () => ({ state: ConnState.DEGRADED, retryCount: 0 });
const firstRetry = () => ({ state: ConnState.RETRY_WAIT, retryCount: 1 });
const manualRetry = () => ({ state: ConnState.RECONNECTING, retryCount: 1 });

const TABLE = {
  [ConnState.BOOTING]: {
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    [ConnEvent.POLL_FAIL]: firstRetry,
  },
  [ConnState.ONLINE]: {
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    [ConnEvent.POLL_FAIL]: firstRetry,
  },
  [ConnState.DEGRADED]: {
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    [ConnEvent.POLL_FAIL]: firstRetry,
  },
  [ConnState.RETRY_WAIT]: {
    [ConnEvent.TIMER]: (conn) => ({
      state: ConnState.RECONNECTING,
      retryCount: conn.retryCount,
    }),
    // A wake-triggered poll can land while waiting; honor its result rather
    // than showing a stale "Reconnecting" banner over a live connection.
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    // That wake poll can also fail, and it was a real attempt, so it counts:
    // re-arming the same interval without advancing would pin the banner at
    // "Reconnecting (3/5)" forever and never surface the Reconnect button,
    // which only renders in OFFLINE. The returned object is always new, which
    // also re-arms the timer the visibility handler cleared on hide —
    // returning `conn` unchanged would leave no timer and no polling at all.
    [ConnEvent.POLL_FAIL]: retryOrGiveUp,
  },
  [ConnState.RECONNECTING]: {
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    [ConnEvent.POLL_FAIL]: retryOrGiveUp,
    // Watchdog (app.js arms one on entry). Every fetchState path resolves to
    // exactly one poll event, so this should never fire — but this state's
    // only other exits are those events, and it arms no backoff of its own, so
    // a poll that never settles would strand the app here with no timer and no
    // Reconnect button. Counting it as a failed attempt means a hang degrades
    // into a retry and eventually into OFFLINE, where the user gets a button.
    [ConnEvent.TIMER]: retryOrGiveUp,
  },
  [ConnState.OFFLINE]: {
    [ConnEvent.RECONNECT_TAPPED]: manualRetry,
    [ConnEvent.APP_WAKE]: manualRetry,
  },
};

export function transition(conn, event) {
  const fn = TABLE[conn.state]?.[event];
  if (!fn) {
    console.debug(`connection FSM: ignored ${event} in ${conn.state}`);
    return conn;
  }
  return fn(conn);
}
