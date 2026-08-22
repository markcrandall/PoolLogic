// Command controller: owns POSTs and the per-command timers (confirm timeout,
// failed auto-clear, stepper debounce). Dispatches events to the store; never
// touches the DOM.

import { store } from "./state.js";
import { CONTROLS } from "./controls.js";
import { policy } from "./viewmode.js";
import {
  CmdState,
  CmdEvent,
  COMMAND_TIMEOUT_MS,
  FAILED_CLEAR_MS,
} from "./fsm/command.js";
import { ConnState } from "./fsm/connection.js";

const STEP_DEBOUNCE_MS = 800;

export function tapControl(id, target) {
  const { conn, pool } = store.getState();
  if (conn.state !== ConnState.ONLINE || !pool) return;

  const before = store.getCommand(id);
  const cmd = store.dispatchCommand(id, CmdEvent.TAP, target);
  if (cmd === before) return; // tap ignored (already PENDING)

  const since = cmd.since;
  CONTROLS[id].send(target, pool).then(({ ok }) => {
    if (!ok) failIfCurrent(id, since, CmdEvent.HTTP_ERROR);
  });
  setTimeout(() => failIfCurrent(id, since, CmdEvent.TIMEOUT), COMMAND_TIMEOUT_MS);
}

function failIfCurrent(id, since, event) {
  const cur = store.getCommand(id);
  if (cur.state !== CmdState.PENDING || cur.since !== since) return;
  store.dispatchCommand(id, event);
  setTimeout(() => {
    // Only clear the failure this timer was armed for. A retry that fails
    // again inside the window carries a later `since`, and clearing on state
    // alone pulled the toast out from under it early — the same guard the
    // PENDING check above uses, for the same reason.
    const cur = store.getCommand(id);
    if (cur.state === CmdState.FAILED && cur.since === since) {
      store.dispatchCommand(id, CmdEvent.CLEAR);
    }
  }, FAILED_CLEAR_MS);
}

// Stepper taps and slider drags share one draft, shown immediately. Stepper
// sends once after the taps pause; the slider sends on release.
let stepperTimer = null;

// Clamped to what the bridge will actually accept, which /api/config reports
// and config.local.json can override — not to a constant compiled in here.
const clamp = (value) => {
  const { min, max } = store.getState().limits;
  return Math.max(min, Math.min(max, value));
};

export function stepSetpoint(delta) {
  const { conn, pool, setpointDraft } = store.getState();
  if (conn.state !== ConnState.ONLINE || !pool) return;

  const base = setpointDraft ?? CONTROLS.setpoint.read(pool, policy().body(pool));
  store.setSetpointDraft(clamp(base + delta));

  clearTimeout(stepperTimer);
  stepperTimer = setTimeout(commitSetpointDraft, STEP_DEBOUNCE_MS);
}

export function slideSetpoint(value) {
  const { conn, pool } = store.getState();
  if (conn.state !== ConnState.ONLINE || !pool) return;
  clearTimeout(stepperTimer);
  store.setSetpointDraft(clamp(value));
}

export function commitSetpointDraft() {
  clearTimeout(stepperTimer);
  const { pool, setpointDraft } = store.getState();
  store.setSetpointDraft(null);
  if (!pool || setpointDraft == null) return;
  // One resolver decides the body; on the spa-only view this is always "spa".
  const body = policy().body(pool);
  if (setpointDraft !== pool.heat[body].setpoint) {
    tapControl("setpoint", { body, temp: setpointDraft });
  }
}
