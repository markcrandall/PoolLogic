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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))

from poollink import (  # noqa: E402
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
