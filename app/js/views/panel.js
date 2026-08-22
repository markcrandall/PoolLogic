// Moore output logic: the UI is derived only from current state. Handlers
// dispatch events; nothing here mutates state.

import { ConnState, ConnEvent, MAX_ATTEMPTS } from "../fsm/connection.js";
import { CmdState } from "../fsm/command.js";
import {
  activeBody,
  CONTROLS,
  SETPOINT_MIN,
  SETPOINT_MAX,
} from "../controls.js";
import { store } from "../state.js";
import {
  tapControl,
  stepSetpoint,
  slideSetpoint,
  commitSetpointDraft,
} from "../commands.js";

// Moore output for the connection FSM. Exported because the config view shows
// the same header dot, and a second copy of these colours (it had one, as a
// nested ternary) is a second thing to keep in step.
export const STATUS = {
  [ConnState.BOOTING]: { dot: "amber", banner: "Connecting…" },
  [ConnState.ONLINE]: { dot: "green", banner: null },
  [ConnState.DEGRADED]: {
    dot: "amber",
    banner: "Pool link down — server is retrying",
  },
  [ConnState.RETRY_WAIT]: { dot: "amber", banner: reconnectingText },
  [ConnState.RECONNECTING]: { dot: "amber", banner: reconnectingText },
  [ConnState.OFFLINE]: {
    dot: "red",
    banner: "Can't reach the pool server",
    showReconnect: true,
  },
};

function reconnectingText(conn) {
  return `Reconnecting (${conn.retryCount}/${MAX_ATTEMPTS})…`;
}

const TOGGLES = ["jets", "cleaner", "spillway", "poolLight", "spaLight"];

const FREEZE_TEXT =
  "Freeze protection is running — the pool turned equipment on by itself";
const FREEZE_HINT = "Leave it running until the air warms up.";
// The panel reports freeze mode for the controller as a whole, never which
// circuits it forced on, so we cannot grey out just the affected toggles.
// Instead every off-switch asks first while freeze is active.
const FREEZE_CONFIRM =
  "Freeze protection is running.\n\n" +
  "The pool turned this on by itself to keep water moving through the " +
  "pipes. Turning it off in freezing weather can let them freeze and " +
  "burst.\n\nTurn it off anyway?";

export function render(state) {
  const { conn, pool, lastUpdated, commands, setpointDraft } = state;
  const status = STATUS[conn.state];
  const live = conn.state === ConnState.ONLINE;

  const dot = document.getElementById("com-dot");
  dot.className = "com-dot " + status.dot;

  const banner = document.getElementById("status-banner");
  const text =
    typeof status.banner === "function" ? status.banner(conn) : status.banner;
  banner.textContent = text ?? "";
  banner.className = "status-banner" + (text ? " visible " + status.dot : "");

  document
    .getElementById("reconnect-btn")
    .classList.toggle("hidden", !status.showReconnect);

  document.getElementById("mock-badge").classList.toggle("hidden", !pool?.mock);

  // Only trustworthy while the poll is current — a stale snapshot must not
  // claim the pool is (or isn't) protecting itself.
  const freeze = live && !!pool?.freezeMode;
  const freezeBanner = document.getElementById("freeze-banner");
  freezeBanner.innerHTML = freeze
    ? `${FREEZE_TEXT}<small>${FREEZE_HINT}</small>`
    : "";
  freezeBanner.classList.toggle("visible", freeze);

  renderTemps(pool, lastUpdated, live, conn.state);
  renderControls(pool, commands, setpointDraft, live);
  renderToast(commands);
}

function renderTemps(pool, lastUpdated, live, connState) {
  const set = (id, value) => {
    document.getElementById(id).textContent = value != null ? `${value}°` : "—";
  };
  set("air-temp", pool?.airTemp);
  set("pool-temp", pool?.poolTemp);
  set("spa-temp", pool?.spaTemp);

  // Water temps are only live while that body circulates; otherwise the
  // controller reports the reading frozen from the last time water flowed.
  const bodyStale = (temp, hint, circulating) => {
    const isStale = !!pool && !circulating;
    document.getElementById(temp).classList.toggle("last-reading", isStale);
    document.getElementById(hint).textContent = isStale ? "last reading" : "";
  };
  bodyStale("pool-temp", "pool-temp-hint", pool?.circuits?.pool);
  bodyStale("spa-temp", "spa-temp-hint", pool?.circuits?.spa);

  document.getElementById("temps").classList.toggle("stale", !live);
  // Two different unknowns, two different answers. Both are pure functions of
  // state — no clock is read here, so identical state always renders identically.
  const asOf = document.getElementById("temps-as-of");
  if (live) {
    asOf.textContent = "";
  } else if (connState === ConnState.DEGRADED && pool?.poolAgeSeconds != null) {
    // Bridge is answering, so this age arrived with the current poll and is
    // the age of the readings themselves — which keeps climbing even though
    // /api/state still returns 200 from cache.
    asOf.textContent = `as of ${formatAge(pool.poolAgeSeconds)}`;
  } else if (lastUpdated) {
    // Bridge unreachable: no fresher age is coming, and the one in hand stopped
    // advancing when the polls did. Say when we last heard anything instead.
    const t = lastUpdated.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    asOf.textContent = `as of ${t}`;
  } else {
    asOf.textContent = "";
  }
}

function formatAge(seconds) {
  if (seconds < 90) return "just now";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderControls(pool, commands, setpointDraft, live) {
  document.getElementById("controls").classList.toggle("disabled", !live);
  const usable = live && pool;
  const cmd = (id) => commands[id] ?? { state: CmdState.IDLE };
  const pending = (id) => cmd(id).state === CmdState.PENDING;

  // Mode switch — displayed value is the pool's truth; pending shows on the
  // tapped (target) side.
  const mode = usable ? CONTROLS.mode.read(pool) : "pool";
  const modeCmd = cmd("mode");
  setButton("btn-mode-pool", {
    active: mode === "pool",
    pending: pending("mode") && modeCmd.target === "pool",
    enabled: usable && !pending("mode"),
  });
  setButton("btn-mode-spa", {
    active: mode === "spa",
    pending: pending("mode") && modeCmd.target === "spa",
    enabled: usable && !pending("mode"),
  });

  // Heater toggle + setpoint stepper (active body). Both are locked while a
  // mode change is pending (the active body is about to flip) and the
  // stepper/slider also lock while their own command is pending, so
  // follow-up edits can't be silently swallowed by the TAP-in-PENDING no-op.
  const heaterOn = usable ? CONTROLS.heater.read(pool) : false;
  setButton("btn-heater", {
    text: heaterOn ? "On" : "Off",
    on: heaterOn,
    pending: pending("heater"),
    enabled: usable && !pending("heater") && !pending("mode"),
  });
  // Draft first (still being dialed), then the in-flight target, then the
  // pool's truth. The middle rung matters: commitSetpointDraft clears the draft
  // before it taps, so without it the dial snapped back to the old value for
  // the whole PENDING window — while mode and lightShow below both show theirs.
  // Still pure Moore; the target is part of the command's committed state.
  const shownSetpoint =
    setpointDraft ??
    (pending("setpoint") ? cmd("setpoint").target?.temp : null) ??
    (usable ? CONTROLS.setpoint.read(pool) : null);
  document.getElementById("setpoint-value").textContent =
    shownSetpoint != null ? `${shownSetpoint}°` : "—°";
  const setpointEl = document.getElementById("setpoint-value");
  setpointEl.classList.toggle("draft", setpointDraft != null);
  setpointEl.classList.toggle("pending", pending("setpoint"));
  const setpointLocked = !usable || pending("setpoint") || pending("mode");
  for (const id of ["btn-step-down", "btn-step-up"]) {
    document.getElementById(id).disabled = setpointLocked;
  }
  const slider = document.getElementById("setpoint-slider");
  slider.disabled = setpointLocked;
  if (shownSetpoint != null && !sliderActive) {
    slider.value = shownSetpoint;
  }
  document.getElementById("heater-body").textContent = usable
    ? activeBody(pool)
    : "";

  // Simple circuit toggles
  for (const id of TOGGLES) {
    const on = usable ? CONTROLS[id].read(pool) : false;
    setButton(`btn-${id}`, {
      text: on ? "On" : "Off",
      on,
      pending: pending(id),
      enabled: usable && !pending(id),
    });
  }

  // Light show picker
  const show = usable ? CONTROLS.lightShow.read(pool) : null;
  const showCmd = cmd("lightShow");
  for (const s of ["white", "caribbean", "party"]) {
    setButton(`btn-show-${s}`, {
      active: show === s,
      pending: pending("lightShow") && showCmd.target === s,
      enabled: usable && !pending("lightShow"),
    });
  }
}

function setButton(id, { text, active, on, pending, enabled }) {
  const el = document.getElementById(id);
  if (text !== undefined) el.textContent = text;
  el.classList.toggle("active", !!active);
  el.classList.toggle("on", !!on);
  el.classList.toggle("pending", !!pending);
  el.disabled = !enabled;
}

function renderToast(commands) {
  const failed = Object.values(commands).some(
    (c) => c.state === CmdState.FAILED
  );
  document.getElementById("toast").classList.toggle("visible", failed);
}

// True while the user is dragging the slider, so render doesn't fight the thumb.
let sliderActive = false;

// Freeze protection is only ever defeated deliberately. Turning equipment ON
// is never the hazard, so only off-taps ask; returns true if the tap should be
// dropped.
function freezeBlocks(pool, turningOff) {
  if (!turningOff || !pool?.freezeMode) return false;
  return !window.confirm(FREEZE_CONFIRM);
}

export function bindHandlers() {
  const on = (id, fn) => document.getElementById(id).addEventListener("click", fn);

  on("reconnect-btn", () => store.dispatchConn(ConnEvent.RECONNECT_TAPPED));

  const slider = document.getElementById("setpoint-slider");
  slider.min = SETPOINT_MIN;
  slider.max = SETPOINT_MAX;
  document.getElementById("slider-min").textContent = `${SETPOINT_MIN}°`;
  document.getElementById("slider-max").textContent = `${SETPOINT_MAX}°`;
  slider.addEventListener("pointerdown", () => (sliderActive = true));
  slider.addEventListener("input", () => slideSetpoint(Number(slider.value)));
  slider.addEventListener("change", () => {
    sliderActive = false;
    commitSetpointDraft();
  });
  // "change" only fires when the committed value differs; these cover
  // tap-in-place and cancelled drags so the flag can never stick.
  const endDrag = () => (sliderActive = false);
  slider.addEventListener("pointerup", endDrag);
  slider.addEventListener("pointercancel", endDrag);

  // Leaving Spa switches the spa circuit off, so it goes through the same
  // guard as the plain toggles. Entering Spa only turns things on.
  on("btn-mode-pool", () => {
    const pool = store.getState().pool;
    if (freezeBlocks(pool, pool?.circuits?.spa)) return;
    tapControl("mode", "pool");
  });
  on("btn-mode-spa", () => tapControl("mode", "spa"));
  on("btn-heater", () => {
    const pool = store.getState().pool;
    if (!pool) return;
    const body = activeBody(pool);
    tapControl("heater", { body, on: !pool.heat[body].on });
  });
  on("btn-step-down", () => stepSetpoint(-1));
  on("btn-step-up", () => stepSetpoint(1));
  for (const id of TOGGLES) {
    on(`btn-${id}`, () => {
      const pool = store.getState().pool;
      if (!pool) return;
      const target = !CONTROLS[id].read(pool);
      if (freezeBlocks(pool, !target)) return;
      tapControl(id, target);
    });
  }
  on("btn-show-white", () => tapControl("lightShow", "white"));
  on("btn-show-caribbean", () => tapControl("lightShow", "caribbean"));
  on("btn-show-party", () => tapControl("lightShow", "party"));
}
