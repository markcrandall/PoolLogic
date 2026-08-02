// Command controller: owns POSTs and the per-command timers (confirm timeout,
// failed auto-clear, stepper debounce). Dispatches events to the store; never
// touches the DOM.

import { store } from "./state.js";
import {
  CONTROLS,
  SETPOINT_MIN,
  SETPOINT_MAX,
  activeBody,
} from "./controls.js";
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

export function stepSetpoint(delta) {
  const { conn, pool, setpointDraft } = store.getState();
  if (conn.state !== ConnState.ONLINE || !pool) return;

  const base = setpointDraft ?? CONTROLS.setpoint.read(pool);
  const draft = Math.max(SETPOINT_MIN, Math.min(SETPOINT_MAX, base + delta));
  store.setSetpointDraft(draft);

  clearTimeout(stepperTimer);
  stepperTimer = setTimeout(commitSetpointDraft, STEP_DEBOUNCE_MS);
}

export function slideSetpoint(value) {
  const { conn, pool } = store.getState();
  if (conn.state !== ConnState.ONLINE || !pool) return;
  clearTimeout(stepperTimer);
  store.setSetpointDraft(
    Math.max(SETPOINT_MIN, Math.min(SETPOINT_MAX, value))
  );
}

export function commitSetpointDraft() {
  clearTimeout(stepperTimer);
  const { pool, setpointDraft } = store.getState();
  store.setSetpointDraft(null);
  if (!pool || setpointDraft == null) return;
  const body = activeBody(pool);
  if (setpointDraft !== pool.heat[body].setpoint) {
    tapControl("setpoint", { body, temp: setpointDraft });
  }
}
