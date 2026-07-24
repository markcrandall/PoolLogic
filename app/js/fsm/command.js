// Command FSM — next-state logic for one control (pure). Each control gets
// its own instance in the store. The pool is the source of truth: a tapped
// control shows PENDING until a poll confirms the new value; on error or
// timeout it reverts to whatever the pool reports.

export const CmdState = Object.freeze({
  IDLE: "IDLE",
  PENDING: "PENDING",
  FAILED: "FAILED",
});

export const CmdEvent = Object.freeze({
  TAP: "TAP",
  CONFIRMED: "CONFIRMED",
  HTTP_ERROR: "HTTP_ERROR",
  TIMEOUT: "TIMEOUT",
  CLEAR: "CLEAR",
});

export const COMMAND_TIMEOUT_MS = 10000;
export const FAILED_CLEAR_MS = 3000;

export const idleCommand = Object.freeze({
  state: CmdState.IDLE,
  target: null,
  since: 0,
});

const toPending = (cmd, target) => ({
  state: CmdState.PENDING,
  target,
  since: Date.now(),
});
const toIdle = () => idleCommand;
const toFailed = (cmd) => ({ ...cmd, state: CmdState.FAILED });

const TABLE = {
  [CmdState.IDLE]: {
    [CmdEvent.TAP]: toPending,
  },
  [CmdState.PENDING]: {
    [CmdEvent.CONFIRMED]: toIdle,
    [CmdEvent.HTTP_ERROR]: toFailed,
    [CmdEvent.TIMEOUT]: toFailed,
  },
  [CmdState.FAILED]: {
    [CmdEvent.CLEAR]: toIdle,
    [CmdEvent.TAP]: toPending,
  },
};

// Returns the SAME object reference when the event is ignored, so callers can
// detect no-op transitions by identity (e.g. a TAP while already PENDING).
export function commandTransition(cmd, event, target = null) {
  const fn = TABLE[cmd.state]?.[event];
  if (!fn) {
    console.debug(`command FSM: ignored ${event} in ${cmd.state}`);
    return cmd;
  }
  return fn(cmd, target);
}
