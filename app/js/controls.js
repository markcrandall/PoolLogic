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

export const CONTROLS = {
  mode: {
    id: "mode",
    read: (pool) => (pool.circuits.spa ? "spa" : "pool"),
    // App-owned courtesy heat (replaces the panel's "Spa Manual Heat", which
    // re-asserts heat and makes Heater-Off not stick): selecting Spa also
    // starts the heater to the spa setpoint, once; leaving Spa turns it off.
    // Both POSTs are awaited sequentially so a heat failure fails the whole
    // command (toast) instead of being silently swallowed, and the circuit
    // change always lands before the heat change.
    send: async (target, pool) => {
      const entering = target === "spa";
      const circuit = await postJson("api/circuit/spa", { on: entering });
      if (!circuit.ok) return circuit;
      if (entering) {
        const setpoint = pool.heat.spa.setpoint;
        if (setpoint == null) return circuit;
        return postJson("api/heat/spa/on", { setpoint });
      }
      return postJson("api/heat/spa/off", {});
    },
    // Two writes, so "done" has to mean both landed. Without this the default
    // predicate (read(pool) === target) watched the circuit alone: a poll
    // confirming the spa circuit could beat the heat POST, move the command to
    // IDLE, and leave failIfCurrent with nothing to fail — the switch reported
    // success while the courtesy heat, the whole reason this is one command,
    // silently never happened. Mirrors send()'s own branches, including the
    // one where a null setpoint means no heat POST was ever issued.
    confirmed: (pool, target) => {
      const entering = target === "spa";
      if (pool.circuits.spa !== entering) return false;
      if (entering && pool.heat.spa.setpoint == null) return true;
      return pool.heat.spa.on === entering;
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
