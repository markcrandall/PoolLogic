// View-mode tests. resolveMode and the policies are pure, so this needs no DOM
// and no server: `node --test` from the repo root.
//
// The reason this file matters more than its size suggests: "the heater must
// not activate for the pool circuit" is a safety property, and it used to be
// spread across four call sites that each called activeBody(pool) — which
// resolved to "pool" whenever the spa circuit was off, i.e. the resting state.
// Tapping Heater before switching Mode started heating the whole pool. The
// property now lives in one resolver, and the sweep below is what keeps it
// there: it asserts SPA mode answers "spa" for every snapshot, including the
// ones that used to answer "pool".
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ViewMode,
  resolveMode,
  policyFor,
  setViewMode,
  viewMode,
  policy,
} from "../app/js/viewmode.js";

// --- Routing ----------------------------------------------------------------

test("the bare URL is the spa-only view", () => {
  assert.equal(resolveMode(""), ViewMode.SPA);
  assert.equal(resolveMode("?"), ViewMode.SPA);
});

test("?pool and ?config select their views", () => {
  assert.equal(resolveMode("?pool"), ViewMode.POOL);
  assert.equal(resolveMode("?config"), ViewMode.CONFIG);
  // Values are ignored; presence is the signal.
  assert.equal(resolveMode("?pool=1"), ViewMode.POOL);
});

test("config wins when both are given", () => {
  assert.equal(resolveMode("?pool&config"), ViewMode.CONFIG);
  assert.equal(resolveMode("?config&pool"), ViewMode.CONFIG);
});

test("the ?pool spelling is exact", () => {
  // URLSearchParams is case-sensitive. A typo must fall through to the safe
  // view rather than quietly unlocking the pool heater.
  for (const search of ["?Pool", "?POOL", "?pools", "? pool"]) {
    assert.equal(resolveMode(search), ViewMode.SPA, search);
  }
});

test("unrelated query strings do not change the view", () => {
  assert.equal(resolveMode("?utm_source=text"), ViewMode.SPA);
});

// --- The safety property ----------------------------------------------------

// Every shape the body resolver can be handed, including the ones that used to
// answer "pool": spa off, spa off with the pool circuit running, and the
// partial snapshots that exist before the first poll lands.
const SNAPSHOTS = {
  "spa on": { circuits: { spa: true, pool: false }, heat: { pool: { on: false }, spa: { on: true } } },
  "spa off, pool circulating": { circuits: { spa: false, pool: true }, heat: { pool: { on: false }, spa: { on: false } } },
  "spa off, pool heater on": { circuits: { spa: false, pool: true }, heat: { pool: { on: true }, spa: { on: false } } },
  "everything off": { circuits: { spa: false, pool: false }, heat: { pool: { on: false }, spa: { on: false } } },
  "circuits missing": { heat: { pool: { on: false }, spa: { on: false } } },
  "empty object": {},
  "null": null,
  "undefined": undefined,
};

test("SPA mode heats the spa and only the spa, for every snapshot", () => {
  const spa = policyFor(ViewMode.SPA);
  for (const [label, pool] of Object.entries(SNAPSHOTS)) {
    assert.equal(
      spa.body(pool),
      "spa",
      `${label}: SPA mode must never resolve the pool body`
    );
  }
});

test("SPA mode shows the heater only while the spa circuit is on", () => {
  const spa = policyFor(ViewMode.SPA);
  for (const [label, pool] of Object.entries(SNAPSHOTS)) {
    assert.equal(
      spa.showHeater(pool),
      label === "spa on",
      `${label}: heater visibility must follow the spa circuit`
    );
  }
});

test("SPA mode warns only when the pool heater is on and the spa is off", () => {
  const spa = policyFor(ViewMode.SPA);
  for (const [label, pool] of Object.entries(SNAPSHOTS)) {
    assert.equal(
      spa.warnPoolHeat(pool),
      label === "spa off, pool heater on",
      `${label}: the warning must not fire`
    );
  }
});

test("the heater section and the pool-heat warning are mutually exclusive", () => {
  // They share the heater command instance, so they must never be on screen
  // together. showHeater needs the spa circuit on; warnPoolHeat needs it off.
  const spa = policyFor(ViewMode.SPA);
  for (const [label, pool] of Object.entries(SNAPSHOTS)) {
    assert.ok(
      !(spa.showHeater(pool) && spa.warnPoolHeat(pool)),
      `${label}: both visible at once`
    );
  }
});

// --- /?pool is unchanged ----------------------------------------------------

test("POOL mode keeps the original active-body behavior", () => {
  const full = policyFor(ViewMode.POOL);
  assert.equal(full.body({ circuits: { spa: true } }), "spa");
  assert.equal(full.body({ circuits: { spa: false } }), "pool");
  assert.equal(full.body({}), "pool");
  assert.equal(full.body(null), "pool");
});

test("POOL mode always shows the heater and never warns", () => {
  const full = policyFor(ViewMode.POOL);
  for (const [label, pool] of Object.entries(SNAPSHOTS)) {
    assert.equal(full.showHeater(pool), true, label);
    // It renders the pool heater control itself; a banner would be noise.
    assert.equal(full.warnPoolHeat(pool), false, label);
  }
});

test("the config view resolves to a usable policy", () => {
  // It renders no controls, but policy() must never hand back undefined.
  const cfg = policyFor(ViewMode.CONFIG);
  assert.ok(cfg);
  assert.equal(typeof cfg.body, "function");
});

// --- The singleton ----------------------------------------------------------

test("the default is the safe view", () => {
  // Before app.js calls setViewMode. An init-order bug must break /?pool's
  // heater visibly rather than silently re-enable pool heating on /.
  assert.equal(policy().body({ circuits: { spa: false } }), "spa");
});

test("setViewMode selects the policy the rest of the app reads", () => {
  const original = viewMode();
  try {
    setViewMode(ViewMode.POOL);
    assert.equal(viewMode(), ViewMode.POOL);
    assert.equal(policy().body({ circuits: { spa: false } }), "pool");

    setViewMode(ViewMode.SPA);
    assert.equal(policy().body({ circuits: { spa: false } }), "spa");
  } finally {
    setViewMode(original);
  }
});
