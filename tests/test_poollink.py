"""Pool link FSM tests. link_transition() is pure and adapter-free, so this
needs no hardware, no screenlogicpy and no event loop:

    python -m unittest discover -s tests

Lives outside bridge/ for the same reason the .mjs tests live outside app/:
DEPLOY copies only app/ and bridge/ to the Pi.
"""

import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "bridge"))

from poollink import (  # noqa: E402
    PUBLIC_TABLE,
    RECONNECT_BACKOFF_MAX,
    RECONNECT_BACKOFF_START,
    LinkAction,
    PoolLinkEvent,
    PoolLinkState,
    link_transition,
    next_backoff,
)

STATES = list(PoolLinkState)
EVENTS = list(PoolLinkEvent)


def quiet(fn, *args):
    """link_transition prints every ignored pair; silence the sweeps."""
    with redirect_stdout(io.StringIO()):
        return fn(*args)


class TestTotality(unittest.TestCase):
    def test_no_pair_throws_or_yields_an_invalid_state(self):
        for state in STATES:
            for event in EVENTS:
                nxt, action = quiet(link_transition, state, event)
                self.assertIn(nxt, STATES, f"{state}+{event} -> {nxt}")
                self.assertIn(action, list(LinkAction))

    def test_closed_is_terminal(self):
        # A refresh already in flight at shutdown must not resurrect the link
        # after the adapter's connection slot has been handed back.
        for event in EVENTS:
            nxt, action = quiet(link_transition, PoolLinkState.CLOSED, event)
            self.assertIs(nxt, PoolLinkState.CLOSED)
            self.assertIs(action, LinkAction.NONE)


class TestTheMissingState(unittest.TestCase):
    """DOWN must mean "was up, now down" — the fact led.py's _ever_ok latch
    used to maintain by itself."""

    def test_never_connected_cannot_reach_down_without_a_success(self):
        state = PoolLinkState.NEVER_CONNECTED
        for _ in range(20):
            state, _ = quiet(link_transition, state, PoolLinkEvent.REFRESH_FAIL)
            self.assertIs(state, PoolLinkState.NEVER_CONNECTED)

    def test_a_success_then_a_failure_reaches_down(self):
        state, _ = link_transition(
            PoolLinkState.NEVER_CONNECTED, PoolLinkEvent.REFRESH_OK
        )
        self.assertIs(state, PoolLinkState.UP)
        state, action = link_transition(state, PoolLinkEvent.REFRESH_FAIL)
        self.assertIs(state, PoolLinkState.DOWN)
        self.assertIs(action, LinkAction.DISCONNECT)

    def test_down_recovers_on_the_next_success(self):
        state, action = link_transition(PoolLinkState.DOWN, PoolLinkEvent.REFRESH_OK)
        self.assertIs(state, PoolLinkState.UP)
        self.assertIs(action, LinkAction.NONE)


class TestExitActions(unittest.TestCase):
    def test_every_failure_hands_the_socket_back(self):
        # The run loop always force-disconnected on failure; the post-command
        # refresh did not, which is the asymmetry this machine removes.
        for state in (
            PoolLinkState.NEVER_CONNECTED,
            PoolLinkState.UP,
            PoolLinkState.DOWN,
        ):
            _, action = link_transition(state, PoolLinkEvent.REFRESH_FAIL)
            self.assertIs(action, LinkAction.DISCONNECT, f"from {state}")

    def test_shutdown_closes_and_disconnects_from_every_live_state(self):
        for state in (
            PoolLinkState.NEVER_CONNECTED,
            PoolLinkState.UP,
            PoolLinkState.DOWN,
        ):
            nxt, action = link_transition(state, PoolLinkEvent.SHUTDOWN)
            self.assertIs(nxt, PoolLinkState.CLOSED, f"from {state}")
            self.assertIs(action, LinkAction.DISCONNECT, f"from {state}")

    def test_success_takes_no_action(self):
        for state in (
            PoolLinkState.NEVER_CONNECTED,
            PoolLinkState.UP,
            PoolLinkState.DOWN,
        ):
            _, action = quiet(link_transition, state, PoolLinkEvent.REFRESH_OK)
            self.assertIs(action, LinkAction.NONE)


def _documented_rows():
    """Parse the transition table in DESIGN.md 3.1.

    Rows look like:
        | UP | REFRESH_FAIL | DOWN | DISCONNECT | hand the socket back |
    The Moore output table further down is keyed on state too, so the slice
    stops before it — the same boundary tests/design.doc.test.mjs uses for 4.1.
    """
    design = (REPO / "DESIGN.md").read_text(encoding="utf-8")
    start = design.index("### 3.1 Pool link FSM")
    end = design.index("Moore outputs:", start)
    rows = []
    for line in design[start:end].split("\n"):
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 6 or cells[0] != "":
            continue  # not a table row
        state, event, nxt, action = cells[1:5]
        if state not in PoolLinkState.__members__:
            continue  # header or separator
        rows.append(
            (
                PoolLinkState[state],
                PoolLinkEvent[event],
                PoolLinkState[nxt],
                LinkAction[action],
            )
        )
    return rows


class TestDesignDocDrift(unittest.TestCase):
    """DESIGN.md 3.1 and _TABLE must describe the same machine.

    Both directions matter: a documented row the code does not implement is a
    lie, and an implemented row the doc omits is a state nobody reviewing the
    design will know exists. This machine went undocumented for as long as it
    existed, which is not safer than drift — it is the state before drift.
    """

    def setUp(self):
        self.documented = _documented_rows()

    def test_the_documented_table_is_parseable(self):
        # 3 live states x 3 events; CLOSED is terminal and has no rows.
        self.assertEqual(len(self.documented), 9, self.documented)

    def test_every_documented_row_matches_the_code(self):
        for state, event, nxt, action in self.documented:
            actual_next, actual_action = link_transition(state, event)
            self.assertIs(
                actual_next,
                nxt,
                f"DESIGN.md 3.1 says {state.value} + {event.value} -> "
                f"{nxt.value}, code says {actual_next.value}",
            )
            self.assertIs(
                actual_action,
                action,
                f"DESIGN.md 3.1 says {state.value} + {event.value} takes "
                f"{action.value}, code takes {actual_action.value}",
            )

    def test_every_implemented_transition_is_documented(self):
        pairs = {(state, event) for state, event, _, _ in self.documented}
        for state, row in PUBLIC_TABLE.items():
            for event in row:
                self.assertIn(
                    (state, event),
                    pairs,
                    f"{state.value} + {event.value} is implemented but missing "
                    "from DESIGN.md 3.1",
                )

    def test_the_doc_claims_no_transition_the_table_lacks(self):
        for state, event, _, _ in self.documented:
            self.assertIn(
                event,
                PUBLIC_TABLE.get(state, {}),
                f"DESIGN.md 3.1 documents {state.value} + {event.value}, "
                "which the code ignores",
            )

    def test_closed_is_documented_as_terminal(self):
        # Its emptiness is load-bearing, so it must not be parsed as "forgotten".
        self.assertEqual(PUBLIC_TABLE[PoolLinkState.CLOSED], {})
        self.assertNotIn(
            PoolLinkState.CLOSED,
            {state for state, _, _, _ in self.documented},
        )


class TestBackoffLadder(unittest.TestCase):
    def test_ladder_doubles_to_the_cap(self):
        seconds, ladder = RECONNECT_BACKOFF_START, [RECONNECT_BACKOFF_START]
        for _ in range(5):
            seconds = next_backoff(seconds)
            ladder.append(seconds)
        self.assertEqual(ladder, [5, 10, 20, 40, 60, 60])

    def test_the_cap_is_a_fixed_point(self):
        self.assertEqual(
            next_backoff(RECONNECT_BACKOFF_MAX), RECONNECT_BACKOFF_MAX
        )


if __name__ == "__main__":
    unittest.main()
