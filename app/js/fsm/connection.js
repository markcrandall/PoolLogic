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
    [ConnEvent.POLL_FAIL]: (conn) => ({ ...conn }), // fresh object re-arms the backoff timer
  },
  [ConnState.RECONNECTING]: {
    [ConnEvent.POLL_OK]: online,
    [ConnEvent.POLL_POOL_DOWN]: degraded,
    [ConnEvent.POLL_FAIL]: (conn) =>
      conn.retryCount < MAX_ATTEMPTS
        ? { state: ConnState.RETRY_WAIT, retryCount: conn.retryCount + 1 }
        : { state: ConnState.OFFLINE, retryCount: 0 },
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
