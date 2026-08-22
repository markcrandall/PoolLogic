// Which view the URL asked for, and the one answer to "which body does the
// heater act on". Pure: no DOM, no `location` read at import, so the whole
// policy is testable in node.
//
// This module exists because that body decision used to be re-derived in four
// places — activeHeat() in controls.js, the heater tap and the heater-body
// label in views/panel.js, and commitSetpointDraft() in commands.js — each
// calling a free-floating activeBody(pool). All four resolved to "pool"
// whenever the spa circuit was off, which is the resting state: opening the app
// to warm the spa and tapping Heater before switching Mode started heating the
// entire pool to its 78° setpoint, with the word "pool" in small text beside
// the label as the only warning. Mode → Spa already starts the spa heater by
// itself (the courtesy heat in controls.js), so from that resting state the
// button's one routine effect was the accident.
//
// "The heater must not activate for the pool circuit" is a safety property, and
// a property spread across four call sites holds only until someone updates
// three of them. Hence one resolver.

export const ViewMode = Object.freeze({
  SPA: "SPA",       // default: spa-only heating, the pool body is unreachable
  POOL: "POOL",     // /?pool — the full panel, pool heater included
  CONFIG: "CONFIG", // /?config — the circuit map
});

// "?pool" -> POOL, "" -> SPA. Exact lowercase spelling only: URLSearchParams is
// case-sensitive, so "?Pool" is not a match and falls through to the safe view
// rather than quietly unlocking the pool heater on a typo.
export function resolveMode(search) {
  const params = new URLSearchParams(search);
  if (params.has("config")) return ViewMode.CONFIG; // config wins if both given
  return params.has("pool") ? ViewMode.POOL : ViewMode.SPA;
}

const POLICY = Object.freeze({
  [ViewMode.SPA]: Object.freeze({
    // Never the pool. Ever. Not "the pool when the spa is off" — that was the
    // bug. This ignores the snapshot entirely so no state can redirect it.
    body: () => "spa",
    showHeater: (pool) => !!pool?.circuits?.spa,
    // A pool heater lit earlier, from /?pool, or at the panel itself would
    // otherwise be hidden here — this release's own failure mode, made
    // invisible. Surface it instead. See views/panel.js.
    warnPoolHeat: (pool) => !!pool?.heat?.pool?.on && !pool?.circuits?.spa,
  }),
  [ViewMode.POOL]: Object.freeze({
    body: (pool) => (pool?.circuits?.spa ? "spa" : "pool"),
    showHeater: () => true,
    warnPoolHeat: () => false, // this view shows the pool heater control itself
  }),
});

// The config view renders no controls, so it only needs a policy that exists.
const RESOLVED = Object.freeze({
  ...POLICY,
  [ViewMode.CONFIG]: POLICY[ViewMode.POOL],
});

// Set once at boot by app.js, before anything renders. SPA is the default
// because it is the safe direction: an initialization-order bug would break
// /?pool's heater visibly rather than silently re-enable pool heating on /.
let current = ViewMode.SPA;

export function setViewMode(mode) {
  current = mode;
}

export function viewMode() {
  return current;
}

export function policy() {
  return RESOLVED[current];
}

// For tests, which need to exercise a policy without touching the singleton.
export function policyFor(mode) {
  return RESOLVED[mode];
}
