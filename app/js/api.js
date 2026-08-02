// Fetch wrappers. These translate HTTP outcomes into FSM events and never
// touch state or the DOM directly.

import { ConnEvent, ComStatus } from "./fsm/connection.js";

const FETCH_TIMEOUT_MS = 4000; // state polls stay snappy
// Commands can queue behind the bridge's adapter lock (refresh/reconnect in
// flight); give them room under the 10s confirm deadline instead of turning
// a slow-but-successful command into a false FAILED.
const COMMAND_FETCH_TIMEOUT_MS = 8000;

export async function fetchState() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("api/state", {
      cache: "no-store",
      signal: abort.signal,
    });
    if (!res.ok) return { event: ConnEvent.POLL_FAIL, data: null };
    const data = await res.json();
    return { event: comEvent(data.comStatus), data };
  } catch {
    return { event: ConnEvent.POLL_FAIL, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Anything that is not "ok" means the bridge answered but the pool link is
// down, and treating an unrecognized value that way is the safe direction: it
// is the only one that stops a cached payload being read as live. It is also
// the silent one — an unknown value would pin every phone in DEGRADED forever
// — so it is taken deliberately and said out loud.
function comEvent(comStatus) {
  if (comStatus === ComStatus.OK) return ConnEvent.POLL_OK;
  if (comStatus !== ComStatus.POOL_UNREACHABLE) {
    console.warn(
      `unknown comStatus ${JSON.stringify(comStatus)}; treating the pool link as down`
    );
  }
  return ConnEvent.POLL_POOL_DOWN;
}

// Fetched once at boot by the config view. Static for the life of the process
// — the bridge only re-reads config.json on restart.
export async function fetchConfig() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("api/config", {
      cache: "no-store",
      signal: abort.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// What the panel reports about itself: circuits, pumps, alerts, equipment.
// Only the config view asks for this, which is why it is not folded into
// /api/state — every phone polls that every 5s.
export async function fetchPanelInfo() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("api/panel", {
      cache: "no-store",
      signal: abort.signal,
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function postJson(url, body) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMMAND_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
