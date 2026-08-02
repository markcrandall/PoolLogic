// Documentation drift check.
//
// DESIGN.md section 4 documented `RETRY_WAIT | POLL_FAIL | RETRY_WAIT | count
// unchanged` for long enough that the code had already been fixed and tested
// against it — anyone reconciling the code to the doc would have reintroduced
// the exact livelock connection.fsm.test.mjs exists to prevent. A table nobody
// executes is a table nobody notices going stale, so this executes it.
//
// Both directions matter: a documented row that the code does not implement is
// a lie, and an implemented row the doc omits is a state nobody reviewing the
// design will know exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ConnState,
  ConnEvent,
  MAX_ATTEMPTS,
  CONNECTION_TABLE,
  transition,
} from "../app/js/fsm/connection.js";

const DESIGN = readFileSync(
  fileURLToPath(new URL("../DESIGN.md", import.meta.url)),
  "utf8"
);

// Rows look like:
//   | ONLINE | POLL_FAIL | RETRY_WAIT | retryCount = 1 |
//   | RETRY_WAIT | POLL_OK / POLL_POOL_DOWN | ONLINE / DEGRADED | ... |
//   | RECONNECTING | POLL_FAIL (count = 5) | OFFLINE | gave up |
// A "/" pair is shorthand for two rows and is expanded; a "(count …)" suffix
// picks which retryCount the row is claiming something about.
function parseRows(section) {
  const rows = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] !== "") continue; // not a table row
    const [, state, eventCell, nextCell] = cells;
    if (!(state in ConnState)) continue; // header or separator

    const guard = /\(count\s*(<|=)\s*(\d+)\)/.exec(eventCell);
    // "count < 5" holds for any count below the cap; 1 exercises it.
    const retryCount = !guard
      ? 1
      : guard[1] === "="
        ? Number(guard[2])
        : Number(guard[2]) - 4;

    const events = eventCell.replace(/\(.*\)/, "").trim().split(" / ");
    const nexts = nextCell.split(" / ");
    assert.equal(
      events.length,
      nexts.length,
      `unparseable row (paired events need paired results): ${line}`
    );
    events.forEach((event, i) => {
      rows.push({ state, event: event.trim(), next: nexts[i].trim(), retryCount });
    });
  }
  return rows;
}

// The transition table only — 4.1 also carries a Moore output table, whose
// rows are keyed on state too and would otherwise parse as transitions.
const section = DESIGN.slice(
  DESIGN.indexOf("### 4.1 Connection FSM"),
  DESIGN.indexOf("Moore outputs:")
);
const documented = parseRows(section);

test("the documented table is parseable and complete", () => {
  assert.ok(documented.length >= 20, `only parsed ${documented.length} rows`);
  for (const { state, event, next } of documented) {
    assert.ok(state in ConnState, `unknown state ${state}`);
    assert.ok(event in ConnEvent, `unknown event ${event}`);
    assert.ok(next in ConnState, `unknown next state ${next}`);
  }
});

test("every documented row matches the code", () => {
  for (const { state, event, next, retryCount } of documented) {
    const actual = transition({ state, retryCount }, event);
    assert.equal(
      actual.state,
      next,
      `DESIGN.md says ${state} + ${event} (count ${retryCount}) -> ${next}, code says ${actual.state}`
    );
  }
});

test("every implemented transition is documented", () => {
  const documentedPairs = new Set(
    documented.map(({ state, event }) => `${state}+${event}`)
  );
  for (const [state, row] of Object.entries(CONNECTION_TABLE)) {
    for (const event of Object.keys(row)) {
      assert.ok(
        documentedPairs.has(`${state}+${event}`),
        `${state} + ${event} is implemented but missing from DESIGN.md 4.1`
      );
    }
  }
});

test("the doc does not claim a transition the table has no row for", () => {
  for (const { state, event } of documented) {
    assert.ok(
      CONNECTION_TABLE[state]?.[event],
      `DESIGN.md 4.1 documents ${state} + ${event}, which the code ignores`
    );
  }
});

test("MAX_ATTEMPTS still matches the counts the doc reasons about", () => {
  // The guards are written as "(count = 5)"; if the cap moved, every guarded
  // row above would be quietly testing the wrong rung.
  assert.equal(MAX_ATTEMPTS, 5);
});
