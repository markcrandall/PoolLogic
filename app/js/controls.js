// Control registry: how each UI control reads its current value from a pool
// snapshot and how it is sent to the bridge. Pure data + API calls; no state.

import { postJson } from "./api.js";

// The bounds used until /api/config answers with the ones the bridge actually
// enforces (see state.js `limits`). Not a mirror anyone has to keep in step:
// config.local.json on the Pi can override setpointMax, and the bridge rejects
// out-of-range values with a 400, so a hand-copied cap here would drift into
// either a stepper that stops short or a command that dies as an unexplained
// FAILED toast.
export const SETPOINT_MIN = 40;
export const SETPOINT_MAX = 102;

const circuit = (id) => ({
  id,
  read: (pool) => pool.circuits[id],
  send: (target) => postJson(`api/circuit/${id}`, { on: target }),
});

// The three positions of the body switch, in display order. Exported so the
// view renders exactly the set the control understands.
export const MODES = Object.freeze(["pool", "spa", "off"]);

// The two body circuits have three real states, not two. Both can be off — the
// panel reaches that on its own, and the vendor's ScreenLogic app reaches it by
// pressing the lit body again — so reading "pool" as merely the absence of spa
// lit POOL whenever nothing at all was running, and offered no way back to it.
// Same derive-from-absence shape as the heater-body bug in DESIGN.md 5.1.
//
// Both-on is not a state the panel produces; the bodies interlock. If one is
// ever reported anyway, "spa" is the truthful answer — it is the hot body, and
// the one whose courtesy heat this control is responsible for shutting off.
const bodyMode = (pool) =>
  pool.circuits.spa ? "spa" : pool.circuits.pool ? "pool" : "off";

export const CONTROLS = {
  mode: {
    id: "mode",
    read: bodyMode,
    // App-owned courtesy heat (replaces the panel's "Spa Manual Heat", which
    // re-asserts heat and makes Heater-Off not stick): selecting Spa also
    // starts the heater to the spa setpoint, once; leaving Spa — for either of
    // the other two positions — turns it off. Every POST is awaited
    // sequentially so a failure anywhere fails the whole command (toast)
    // instead of being silently swallowed, and the circuit change always lands
    // before the heat change.
    //
    // Pool and Off send the spa circuit and its heat down unconditionally,
    // even when the snapshot already says both are off. The snapshot is up to
    // one poll old, and a redundant off costs a write where a skipped one can
    // leave the spa heating with the body cold.
    send: async (target, pool) => {
      if (target === "spa") {
        const circuit = await postJson("api/circuit/spa", { on: true });
        if (!circuit.ok) return circuit;
        const setpoint = pool.heat.spa.setpoint;
        if (setpoint == null) return circuit;
        return postJson("api/heat/spa/on", { setpoint });
      }
      const circuit = await postJson("api/circuit/spa", { on: false });
      if (!circuit.ok) return circuit;
      const heat = await postJson("api/heat/spa/off", {});
      if (!heat.ok) return heat;
      // The only place Pool and Off differ. Entering Spa deliberately sends no
      // pool write: the panel's own interlock drops that circuit, and read()
      // answers "spa" whether or not it has caught up yet.
      return postJson("api/circuit/pool", { on: target === "pool" });
    },
    // Two or three writes, so "done" has to mean all of them landed. Without
    // this the default predicate (read(pool) === target) watched the circuits
    // alone: a poll confirming the spa circuit could beat the heat POST, move
    // the command to IDLE, and leave failIfCurrent with nothing to fail — the
    // switch reported success while the courtesy heat, the whole reason this
    // is one command, silently never happened. Mirrors send()'s own branches,
    // including the one where a null setpoint means no heat POST was issued.
    //
    // Not expressed as read(pool) === target plus extras: Pool and Off differ
    // only in the pool circuit, and both require the spa side fully down, so
    // saying that once is one fact instead of two that can disagree.
    confirmed: (pool, target) => {
      if (target === "spa") {
        if (!pool.circuits.spa) return false;
        if (pool.heat.spa.setpoint == null) return true;
        return pool.heat.spa.on === true;
      }
      return (
        !pool.circuits.spa &&
        !pool.heat.spa.on &&
        pool.circuits.pool === (target === "pool")
      );
    },
  },
  // Heater and setpoint targets carry the body captured at tap time, so a
  // mode change mid-flight can't redirect the command or its confirmation
  // to the other body.
  //
  // read() takes that body as a REQUIRED parameter — deliberately no default.
  // These used to derive it themselves via activeBody(pool), which resolved to
  // "pool" whenever the spa circuit was off and is how the app came to offer
  // pool heating from its resting state. A caller that forgets the argument now
  // hits pool.heat[undefined] and throws into render()'s try/catch, which is
  // loud; defaulting would put the silent pool fallback straight back.
  // viewmode.js owns the decision now.
  heater: {
    id: "heater",
    read: (pool, body) => pool.heat[body].on,
    send: (target, pool) => {
      if (!target.on) return postJson(`api/heat/${target.body}/off`, {});
      const setpoint = pool.heat[target.body].setpoint;
      if (setpoint == null) return Promise.resolve({ ok: false });
      return postJson(`api/heat/${target.body}/on`, { setpoint });
    },
    confirmed: (pool, target) => pool.heat[target.body].on === target.on,
  },
  setpoint: {
    id: "setpoint",
    read: (pool, body) => pool.heat[body].setpoint,
    send: (target) =>
      postJson(`api/heat/${target.body}/setpoint`, { temp: target.temp }),
    confirmed: (pool, target) => pool.heat[target.body].setpoint === target.temp,
  },
  jets: circuit("jets"),
  cleaner: circuit("cleaner"),
  spillway: circuit("spillway"),
  poolLight: circuit("poolLight"),
  spaLight: circuit("spaLight"),
  lightShow: {
    id: "lightShow",
    read: (pool) => pool.lightShow,
    send: (target) => postJson("api/lights", { show: target }),
  },
};
