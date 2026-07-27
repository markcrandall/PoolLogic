// Fetch wrappers. These translate HTTP outcomes into FSM events and never
// touch state or the DOM directly.

import { ConnEvent } from "./fsm/connection.js";

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
    const event =
      data.comStatus === "ok" ? ConnEvent.POLL_OK : ConnEvent.POLL_POOL_DOWN;
    return { event, data };
  } catch {
    return { event: ConnEvent.POLL_FAIL, data: null };
  } finally {
    clearTimeout(timer);
  }
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

// Every circuit the panel reports, with its panel-assigned name. Only the
// config view asks for this, which is why it is not folded into /api/state.
export async function fetchPanelCircuits() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("api/circuits", {
      cache: "no-store",
      signal: abort.signal,
    });
    if (!res.ok) return null;
    return (await res.json()).circuits ?? null;
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
