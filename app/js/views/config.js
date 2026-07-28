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
// state passed in, and nothing here mutates state or sends commands.

import { ConnState } from "../fsm/connection.js";
import { fetchConfig, fetchPanelInfo } from "../api.js";
import { store } from "../state.js";

let config = null;
let panel = null;

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
  fetchConfig().then((loaded) => {
    config = loaded;
    render(store.getState());
  });
  afterPoll();
}

// Called by the scheduler after each poll, so this view never owns a timer.
export function afterPoll() {
  fetchPanelInfo().then((loaded) => {
    if (loaded === null) return; // keep the last good data rather than blanking
    panel = loaded;
    render(store.getState());
  });
}

export function render(state) {
  const { conn, pool } = state;
  const live = conn.state === ConnState.ONLINE;

  const dot = document.getElementById("com-dot");
  dot.className = "com-dot " + (live ? "green" : conn.state === ConnState.OFFLINE ? "red" : "amber");
  document.getElementById("mock-badge").classList.toggle("hidden", !pool?.mock);

  const note = document.getElementById("config-note");
  const tbody = document.querySelector("#config-circuits tbody");

  if (config === null) {
    note.textContent = "Loading circuit map…";
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

  renderPanelCircuits(live);
  renderPumps(live);
  renderAlerts(live);
  renderEquipment();
}

// The panel's own list: every circuit it reports, under the name it gives it.
// Rows the config map does not claim are flagged, because after a controller
// swap those are exactly where the missing equipment went.
function renderPanelCircuits(live) {
  const tbody = document.querySelector("#panel-circuits tbody");
  const note = document.getElementById("panel-note");
  const panelCircuits = panel?.circuits ?? null;

  if (panelCircuits === null) {
    note.textContent = "Reading the panel…";
    return;
  }
  if (panelCircuits.length === 0) {
    note.textContent = "The panel reported no circuits.";
    tbody.replaceChildren();
    return;
  }

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
        ["config-note-cell", ours ? `= ${ours}` : "not in config", !ours],
      ]);
    })
  );

  const unmapped = panelCircuits.filter((c) => !mapped.has(c.id)).length;
  note.textContent = unmapped
    ? `${panelCircuits.length} circuits reported; ${unmapped} not in config.json.`
    : `${panelCircuits.length} circuits reported, all mapped.`;
}

// Live pump telemetry. Only populated slots come back — a panel reports eight
// regardless of how many pumps exist.
function renderPumps(live) {
  const tbody = document.querySelector("#panel-pumps tbody");
  const note = document.getElementById("pumps-note");
  const pumps = panel?.pumps ?? null;

  if (pumps === null) return;
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

// Anything the panel is complaining about. Zero rows is the normal case, so
// the section says so plainly rather than sitting empty.
function renderAlerts(live) {
  const tbody = document.querySelector("#panel-alerts tbody");
  const note = document.getElementById("alerts-note");
  const alerts = panel?.alerts ?? null;

  if (alerts === null) return;
  tbody.replaceChildren(
    ...alerts.map((a) =>
      cells([
        ["config-name", a.label],
        ["config-state", !live ? "—" : String(a.value), false],
        ["config-note-cell", a.ok ? "ok" : "ATTENTION", !a.ok],
      ])
    )
  );
  const bad = alerts.filter((a) => !a.ok).length;
  note.textContent = !live
    ? "Not connected — alert states are not current."
    : bad
      ? `${bad} item${bad === 1 ? "" : "s"} needing attention.`
      : "Nothing reported.";
}

function renderEquipment() {
  const dl = document.getElementById("panel-equipment");
  const e = panel?.equipment ?? null;
  if (e === null) return;

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
  const note = document.getElementById("equipment-note");
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
