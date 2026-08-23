// Body-switch tests: the Pool / Spa / Off control.
//
// This file exists because the switch used to have two positions over a
// three-state panel. `read` was `spa ? "spa" : "pool"` — the pool position was
// the *absence* of spa, not the presence of the pool — so with both bodies off
// (the panel's own resting state, and where the vendor's ScreenLogic app lands
// when you press the lit body again) the app lit POOL while nothing at all was
// running, and had no command that could stop the pool.
//
// The same derive-from-absence shape as the heater-body bug in DESIGN.md 5.1,
// so it is tested the same way: sweep every combination of the two circuits
// rather than the two that used to be reachable.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTROLS, MODES } from "../app/js/controls.js";

const { read, confirmed } = CONTROLS.mode;

const snapshot = ({ pool = false, spa = false, heatOn = false, setpoint = 101 } = {}) => ({
  circuits: { pool, spa },
  heat: {
    pool: { setpoint: 78, on: false, active: false },
    spa: { setpoint, on: heatOn, active: heatOn },
  },
});

test("the switch offers exactly the three states the panel has", () => {
  assert.deepEqual([...MODES], ["pool", "spa", "off"]);
});

test("read answers off when both bodies are off", () => {
  // The regression itself. This snapshot used to read "pool".
  assert.equal(read(snapshot()), "off");
});

test("read answers each body from its own circuit, not the other's absence", () => {
  assert.equal(read(snapshot({ pool: true })), "pool");
  assert.equal(read(snapshot({ spa: true })), "spa");
});

test("both circuits on reads as spa", () => {
  // The panel interlocks the bodies so this should not occur; if it is ever
  // reported anyway, spa is the honest answer — it is the hot body, and the
  // one whose courtesy heat the control is on the hook to shut off. Saying
  // "pool" there would hide a running spa heater behind the pool position.
  assert.equal(read(snapshot({ pool: true, spa: true })), "spa");
});

test("read never answers outside the switch's own positions", () => {
  for (const pool of [false, true]) {
    for (const spa of [false, true]) {
      assert.ok(
        MODES.includes(read(snapshot({ pool, spa }))),
        `circuits pool=${pool} spa=${spa} read as an unrenderable position`
      );
    }
  }
});

// --- confirmed() ------------------------------------------------------------
// Pool and Off are three writes (spa circuit, spa heat, pool circuit) and Spa
// is two, so "done" has to mean all of them landed. See store.test.mjs for the
// same rule exercised end to end through the register.

test("Pool is not confirmed by the spa going down alone", () => {
  // What the old two-position control accepted as done: spa off, and nothing
  // said about the pool. The pool circuit is now the point of the command.
  assert.equal(confirmed(snapshot(), "pool"), false);
  assert.equal(confirmed(snapshot({ pool: true }), "pool"), true);
});

test("Off is not confirmed while either body is still running", () => {
  assert.equal(confirmed(snapshot({ pool: true }), "off"), false);
  assert.equal(confirmed(snapshot({ spa: true }), "off"), false);
  assert.equal(confirmed(snapshot(), "off"), true);
});

test("Pool and Off both wait for the courtesy heat to be off", () => {
  // Leaving the spa turns its heater off, and a heat POST that failed must not
  // be papered over by a circuit that landed.
  for (const target of ["pool", "off"]) {
    const stillHeating = snapshot({ pool: target === "pool", heatOn: true });
    assert.equal(
      confirmed(stillHeating, target),
      false,
      `${target} confirmed with the spa heater still on`
    );
  }
});

test("Spa waits for the circuit and the courtesy heat", () => {
  assert.equal(confirmed(snapshot({ spa: true }), "spa"), false);
  assert.equal(confirmed(snapshot({ spa: true, heatOn: true }), "spa"), true);
});

test("a null spa setpoint confirms Spa on the circuit alone", () => {
  // send() issues no heat POST when there is no setpoint to send, so waiting
  // on heat here would hang the command until its timeout.
  const noSetpoint = snapshot({ spa: true, setpoint: null });
  assert.equal(confirmed(noSetpoint, "spa"), true);
});
