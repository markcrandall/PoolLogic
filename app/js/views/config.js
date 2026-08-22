// Read-only config view, served at /?config.
//
// Exists for one job the main panel cannot do: proving that circuitIds still
// match the panel. Circuit IDs are assigned by the controller, so a board swap
// can renumber them — and a stale map actuates the wrong equipment while the
// app looks perfectly healthy, because the bridge faithfully reports whatever
// the circuit it asked about is doing. Standing at the equipment pad with this
// open on a phone, you can see which ID each name is bound to and watch its
// live state as things switch.
//
// Same Moore discipline as the panel: render() derives everything from the
// state passed in, and nothing here mutates state or sends commands. Each
// fetched resource carries a load FSM rather than a nullable variable, so
// "still loading" and "the fetch failed" are different answers and the second
// one is recoverable — see fsm/load.js.

import { ConnState } from "../fsm/connection.js";
import { LoadState, LoadEvent, loading, loadTransition } from "../fsm/load.js";
import { fetchConfig, fetchPanelInfo } from "../api.js";
import { createPollGuard } from "../pollguard.js";
import { STATUS } from "./panel.js";
import { store } from "../state.js";

// The state register for each resource: one place per resource that applies a
// load transition, same rule the store follows for the connection FSM.
//
// Each carries its own latch as well, because LOADING means "no data yet", not
// "a fetch is in flight" — the load FSM has no in-flight state and its RETRY
// guard only covers the config fetch. Same latch the state poll uses, for the
// same reason: one request at a time, and a late answer that has been
// superseded is dropped rather than written over a fresher one.
const configRes = { load: loading, guard: createPollGuard() };
const panelRes = { load: loading, guard: createPollGuard() };

export function bindHandlers() {
  // Swap the pool controls out for the config view. Both live in index.html so
  // the header, connection dot and MOCK badge keep working unchanged.
  for (const id of ["temps", "controls"]) {
    document.getElementById(id).classList.add("hidden");
  }
  document.getElementById("config-view").classList.remove("hidden");

  // Async, but the view renders fine without it — the rows simply appear once
  // it lands. Re-render explicitly because a config fetch is not a state
  // transition and will not notify subscribers on its own.
  fetchInto(configRes, fetchConfig);
  afterPoll();
}

// Called by the scheduler after each poll, so this view never owns a timer.
export function afterPoll() {
  // The circuit map is static and so is fetched once — but a failed fetch must
  // not be final, which is what it used to be. FAILED is the only state RETRY
  // moves, so a dropped fetch recovers on the next poll and a map already in
  // hand is never re-requested. (Overlap is the latch's job, not this check's;
  // see fetchInto.)
  if (configRes.load.state === LoadState.FAILED) {
    fetchInto(configRes, fetchConfig);
  }
  fetchInto(panelRes, fetchPanelInfo);
}

function fetchInto(res, fetcher) {
  // The latch, not the FSM, is what serializes this. The panel fetch runs on
  // every poll regardless of state, and boot calls afterPoll twice in quick
  // succession — bindHandlers directly, then again when the BOOTING poll
  // resolves. Those two overlap whenever /api/panel outlives the state poll,
  // and then whichever answers last wins, which can be the older of the two.
  // (On localhost it never happens: panel answers in ~20ms against the poll's
  // ~190ms. Over wifi to a Pi, where both are slow and variable, it can.)
  const token = res.guard.begin();
  if (token === null) return;
  // Ignored outside FAILED; dispatching it unconditionally is what lets the
  // panel fetch — which runs every poll — climb back out of a failure without
  // a second code path.
  res.load = loadTransition(res.load, LoadEvent.RETRY);
  fetcher().then((data) => {
    if (!res.guard.settle(token)) return;
    res.load = loadTransition(
      res.load,
      data === null ? LoadEvent.FETCH_FAIL : LoadEvent.FETCH_OK,
      data
    );
    render(store.getState());
  });
}

export function render(state) {
  const { conn, pool } = state;
  const live = conn.state === ConnState.ONLINE;
  const config = configRes.load.data;
  const panel = panelRes.load.data;

  // Shared with the panel view so the two pages cannot disagree about what a
  // connection state looks like.
  document.getElementById("com-dot").className =
    "com-dot " + STATUS[conn.state].dot;
  document.getElementById("mock-badge").classList.toggle("hidden", !pool?.mock);

  // Every table renders independently. A failed config fetch used to return
  // here and take the panel's own tables down with it — and the panel's list
  // is precisely what is useful at the pad when the map is unavailable.
  renderConfigCircuits(config, pool, live);
  renderPanelCircuits(panel, config, live);
  renderPumps(panel, live);
  renderStatus(panel, live);
  renderAlerts(panel, live);
  renderEquipment(panel, config);
}

// What to say when a table has no data: "not here yet" and "the fetch failed"
// are different answers, which is the whole reason the load FSM exists.
function pendingNote(res, what) {
  return res.load.state === LoadState.FAILED
    ? `Couldn't read ${what} — retrying.`
    : `Reading ${what}…`;
}

// config.json's map: our name for each circuit, and the ID we actuate for it.
function renderConfigCircuits(config, pool, live) {
  const note = document.getElementById("config-note");
  const tbody = document.querySelector("#config-circuits tbody");

  if (config === null) {
    note.textContent = pendingNote(configRes, "the circuit map");
    return;
  }

  const entries = Object.entries(config.circuitIds);
  if (tbody.childElementCount !== entries.length) {
    tbody.replaceChildren(...entries.map(([name]) => row(name)));
  }

  for (const [name, id] of entries) {
    const tr = tbody.querySelector(`[data-circuit="${name}"]`);
    const on = pool?.circuits?.[name];
    tr.querySelector(".config-id").textContent = id;

    const stateCell = tr.querySelector(".config-state");
    // Only claim a state when the reading is current; a stale snapshot must
    // not be read as "this ID maps to the thing that is running right now",
    // which is the entire question this page exists to answer.
    stateCell.textContent = !live || on == null ? "—" : on ? "On" : "Off";
    stateCell.classList.toggle("on", live && on === true);

    const settable = config.settableCircuits.includes(name);
    tr.querySelector(".config-note-cell").textContent = settable ? "" : "read-only";
  }

  note.textContent = live
    ? "Switch each circuit from the panel and watch which row changes — that is the ID it is really bound to."
    : "Not connected — states below are not current.";
}

// The panel's own list: every circuit it reports, under the name it gives it.
// Rows the config map does not claim are flagged, because after a controller
// swap those are exactly where the missing equipment went.
function renderPanelCircuits(panel, config, live) {
  const tbody = document.querySelector("#panel-circuits tbody");
  const note = document.getElementById("panel-note");
  const panelCircuits = panel?.circuits ?? null;

  if (panelCircuits === null) {
    note.textContent = pendingNote(panelRes, "the panel");
    return;
  }
  if (panelCircuits.length === 0) {
    note.textContent = "The panel reported no circuits.";
    tbody.replaceChildren();
    return;
  }

  // Without the map there is nothing to be missing from. Flagging every row
  // "not in config" because /api/config failed would raise exactly the alarm
  // this page exists to raise — a controller that renumbered everything —
  // over a dropped fetch.
  const known = config !== null;
  const mapped = new Map(
    Object.entries(config?.circuitIds ?? {}).map(([name, id]) => [id, name])
  );

  tbody.replaceChildren(
    ...panelCircuits.map((circuit) => {
      const ours = mapped.get(circuit.id);
      return cells([
        ["config-id", String(circuit.id)],
        ["config-name", circuit.name ?? "(unnamed)"],
        ["config-state", !live ? "—" : circuit.on ? "On" : "Off", live && circuit.on],
        ["config-note-cell", !known ? "—" : ours ? `= ${ours}` : "not in config", known && !ours],
      ]);
    })
  );

  const unmapped = panelCircuits.filter((c) => !mapped.has(c.id)).length;
  note.textContent =
    !known
      ? `${panelCircuits.length} circuits reported; ${pendingNote(configRes, "the circuit map").toLowerCase()}`
      : unmapped
        ? `${panelCircuits.length} circuits reported; ${unmapped} not in config.json.`
        : `${panelCircuits.length} circuits reported, all mapped.`;
}

// Live pump telemetry. Only populated slots come back — a panel reports eight
// regardless of how many pumps exist.
function renderPumps(panel, live) {
  const tbody = document.querySelector("#panel-pumps tbody");
  const note = document.getElementById("pumps-note");
  const pumps = panel?.pumps ?? null;

  if (pumps === null) {
    note.textContent = pendingNote(panelRes, "pump telemetry");
    return;
  }
  if (pumps.length === 0) {
    tbody.replaceChildren();
    note.textContent = "No pump telemetry reported.";
    return;
  }
  note.textContent = "";

  const num = (v, unit) => (!live || v == null ? "—" : `${v} ${unit}`);
  tbody.replaceChildren(
    ...pumps.map((p) =>
      cells([
        ["config-name", `Pump ${p.id}`],
        ["config-state", !live ? "—" : p.running ? "Running" : "Idle", live && p.running],
        ["config-value", num(p.watts, "W")],
        ["config-value", num(p.rpm, "rpm")],
        ["config-value", num(p.gpm, "gpm")],
      ])
    )
  );
}

// Readings, not verdicts. Nothing here can be "wrong", so no row carries an
// ok/attention flag — a producing chlorinator is just a producing chlorinator.
function renderStatus(panel, live) {
  const tbody = document.querySelector("#panel-status tbody");
  const note = document.getElementById("status-note");
  const status = panel?.status ?? null;

  if (status === null) {
    note.textContent = pendingNote(panelRes, "panel readings");
    return;
  }
  if (status.length === 0) {
    tbody.replaceChildren();
    note.textContent = "No chlorinator reported.";
    return;
  }
  tbody.replaceChildren(
    ...status.map((s) =>
      cells([
        ["config-name", s.label],
        ["config-value", !live ? "—" : String(s.value)],
      ])
    )
  );
  note.textContent = live ? "" : "Not connected — readings are not current.";
}

// Faults only. Every row here is something wrong, so every row is flagged; an
// empty table is the healthy case and says so rather than sitting blank.
function renderAlerts(panel, live) {
  const tbody = document.querySelector("#panel-alerts tbody");
  const note = document.getElementById("alerts-note");
  const alerts = panel?.alerts ?? null;

  if (alerts === null) {
    // "Nothing reported" and "we could not ask" must not look the same on a
    // table whose empty state means everything is fine.
    note.textContent = pendingNote(panelRes, "alerts");
    return;
  }
  tbody.replaceChildren(
    ...alerts.map((a) =>
      cells([
        ["config-name", a.label],
        ["config-note-cell", !live ? "—" : String(a.value), live],
      ])
    )
  );
  note.textContent = !live
    ? "Not connected — alert states are not current."
    : alerts.length
      ? `${alerts.length} item${alerts.length === 1 ? "" : "s"} needing attention.`
      : "Nothing reported.";
}

function renderEquipment(panel, config) {
  const dl = document.getElementById("panel-equipment");
  const note = document.getElementById("equipment-note");
  const e = panel?.equipment ?? null;
  if (e === null) {
    note.textContent = pendingNote(panelRes, "equipment");
    return;
  }

  const rows = [
    ["Model", e.model ?? "—"],
    ["Firmware", e.firmware ?? "—"],
    ["Installed", (e.installed ?? []).join(", ") || "—"],
    ["Circuits", e.circuitCount ?? "—"],
    ["Colors", e.colorCount ?? "—"],
    ["Setpoint range", e.minSetpoint != null ? `${e.minSetpoint}–${e.maxSetpoint}°` : "—"],
  ];
  dl.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      return [dt, dd];
    })
  );

  // The panel's own bounds are authoritative; config.json duplicates them.
  const configured = config?.setpointMax;
  note.textContent =
    configured != null && e.maxSetpoint != null && configured !== e.maxSetpoint
      ? `config.json caps the setpoint at ${configured}°, but the panel allows ${e.maxSetpoint}°.`
      : "";
}

function cells(spec) {
  const tr = document.createElement("tr");
  for (const [cls, text, flag] of spec) {
    const td = document.createElement("td");
    td.className = cls;
    td.textContent = text;
    if (flag) td.classList.add(cls === "config-note-cell" ? "attention" : "on");
    tr.appendChild(td);
  }
  return tr;
}

function row(name) {
  const tr = document.createElement("tr");
  tr.dataset.circuit = name;
  // ID first, matching the panel's own table, so the two ID columns line up
  // and cross-reading them is a single vertical scan.
  for (const cls of ["config-id", "config-name", "config-state", "config-note-cell"]) {
    const td = document.createElement("td");
    td.className = cls;
    if (cls === "config-name") td.textContent = name;
    tr.appendChild(td);
  }
  return tr;
}
