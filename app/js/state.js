// The store is the FSM's state register: the only place transitions are
// applied. Everything else dispatches events (handlers) or reads state
// (render). Same subscribe/notify idiom as SimpleShoppingList.

import { transition, ConnState, ComStatus } from "./fsm/connection.js";
import {
  commandTransition,
  idleCommand,
  CmdState,
  CmdEvent,
} from "./fsm/command.js";
import { CONTROLS } from "./controls.js";

export const store = {
  _state: {
    conn: { state: ConnState.BOOTING, retryCount: 0 },
    pool: null,           // last-known /api/state payload
    lastUpdated: null,    // Date of last successful poll (ok or pool-down)
    commands: {},         // controlId -> command FSM instance
    setpointDraft: null,  // stepper value being edited, pre-send
  },
  _listeners: [],

  getState() {
    return this._state;
  },

  getCommand(id) {
    return this._state.commands[id] ?? idleCommand;
  },

  subscribe(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== fn);
    };
  },

  dispatchConn(event, pollData = null) {
    this._state.conn = transition(this._state.conn, event);
    if (pollData) {
      this._state.pool = pollData;
      this._state.lastUpdated = new Date();
      // Pool-down payloads carry the bridge's last CACHED state, which must
      // not confirm pending commands the equipment may never have seen.
      if (pollData.comStatus === ComStatus.OK) {
        this._confirmPendingCommands(pollData);
      }
    }
    this._notify();
  },

  dispatchCommand(id, event, target = null) {
    const next = commandTransition(this.getCommand(id), event, target);
    this._state.commands[id] = next;
    this._notify();
    return next;
  },

  setSetpointDraft(value) {
    this._state.setpointDraft = value;
    this._notify();
  },

  // A fresh poll is the confirmation channel: any PENDING command whose
  // target now matches the pool's reported value has succeeded. Controls
  // with structured targets provide their own confirmed() predicate.
  _confirmPendingCommands(pool) {
    for (const [id, cmd] of Object.entries(this._state.commands)) {
      // States are a closed type, never a string in logic: a typo here would
      // silently disable command confirmation for every control at once.
      if (cmd.state !== CmdState.PENDING) continue;
      const control = CONTROLS[id];
      const done = control.confirmed
        ? control.confirmed(pool, cmd.target)
        : control.read(pool) === cmd.target;
      if (done) {
        this._state.commands[id] = commandTransition(cmd, CmdEvent.CONFIRMED);
      }
    }
  },

  _notify() {
    this._listeners.forEach((fn) => fn(this._state));
  },
};
