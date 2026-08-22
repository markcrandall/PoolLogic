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
import {
  LoadState,
  LoadEvent,
  LOAD_TABLE,
  loadTransition,
} from "../app/js/fsm/load.js";

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
function parseRows(section, States) {
  const rows = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] !== "") continue; // not a table row
    const [, state, eventCell, nextCell] = cells;
    if (!(state in States)) continue; // header or separator

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

function slice(from, to) {
  const start = DESIGN.indexOf(from);
  assert.notEqual(start, -1, `DESIGN.md no longer contains "${from}"`);
  const end = DESIGN.indexOf(to, start);
  assert.notEqual(end, -1, `DESIGN.md no longer contains "${to}" after "${from}"`);
  return DESIGN.slice(start, end);
}

// --- 4.1 Connection FSM -----------------------------------------------------
// The transition table only — 4.1 also carries a Moore output table, whose
// rows are keyed on state too and would otherwise parse as transitions.
const documented = parseRows(
  slice("### 4.1 Connection FSM", "Moore outputs:"),
  ConnState
);

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

// --- 4.3 Load FSM -----------------------------------------------------------
// Same check, same reason. The load machine went undocumented for as long as it
// existed, which is the state before drift, not an improvement on it: a table
// nobody can read is not more trustworthy than one that has gone stale.
const documentedLoad = parseRows(
  slice("### 4.3 Load FSM", "Moore outputs:"),
  LoadState
);

test("the documented load table is parseable and complete", () => {
  assert.equal(documentedLoad.length, 5, `parsed ${documentedLoad.length} rows`);
  for (const { state, event, next } of documentedLoad) {
    assert.ok(state in LoadState, `unknown state ${state}`);
    assert.ok(event in LoadEvent, `unknown event ${event}`);
    assert.ok(next in LoadState, `unknown next state ${next}`);
  }
});

test("every documented load row matches the code", () => {
  for (const { state, event, next } of documentedLoad) {
    const actual = loadTransition({ state, data: null }, event, {});
    assert.equal(
      actual.state,
      next,
      `DESIGN.md says ${state} + ${event} -> ${next}, code says ${actual.state}`
    );
  }
});

test("every implemented load transition is documented", () => {
  const pairs = new Set(
    documentedLoad.map(({ state, event }) => `${state}+${event}`)
  );
  for (const [state, row] of Object.entries(LOAD_TABLE)) {
    for (const event of Object.keys(row)) {
      assert.ok(
        pairs.has(`${state}+${event}`),
        `${state} + ${event} is implemented but missing from DESIGN.md 4.3`
      );
    }
  }
});

test("the load doc does not claim a transition the table has no row for", () => {
  for (const { state, event } of documentedLoad) {
    assert.ok(
      LOAD_TABLE[state]?.[event],
      `DESIGN.md 4.3 documents ${state} + ${event}, which the code ignores`
    );
  }
});

test("MAX_ATTEMPTS still matches the counts the doc reasons about", () => {
  // The guards are written as "(count = 5)"; if the cap moved, every guarded
  // row above would be quietly testing the wrong rung.
  assert.equal(MAX_ATTEMPTS, 5);
});
