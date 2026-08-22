"""Pool link lifecycle — next-state logic only (pure; no adapter, no I/O).

`pool_up` was a bare boolean with four writers, and the state it could not
express was re-derived independently in three places: `_pool_age()` returning
None for "never reached the adapter since boot", led.py's `_ever_ok` latch, and
led.py's pattern ladder picking the starting blink from it. Three
re-derivations of one unnamed state is a missing state.

NEVER_CONNECTED self-loops on failure and can only leave on a success, so DOWN
means exactly "was up, now down" — which is what `_ever_ok` was standing in for.

    State            REFRESH_OK   REFRESH_FAIL         SHUTDOWN
    NEVER_CONNECTED  UP           NEVER_CONNECTED (d)  CLOSED (d)
    UP               UP           DOWN (d)             CLOSED (d)
    DOWN             UP           DOWN (d)             CLOSED (d)
    CLOSED           ignore       ignore               ignore
    (d) = force-disconnect on the way out

The transition RETURNS the action rather than taking it. The only action is an
async force-disconnect that must run under the backend's I/O lock, and a pure
next-state function has no business acquiring one — it would make the block
async, non-deterministic and untestable without an adapter. Taking it belongs to
_dispatch, which is also the reason _dispatch must never be called while its
caller already holds that lock: asyncio.Lock is not reentrant.

The documented table above is checked against _TABLE by tests/test_poollink.py,
along with DESIGN.md 3.1.
"""

from enum import Enum


class PoolLinkState(str, Enum):
    NEVER_CONNECTED = "NEVER_CONNECTED"
    UP = "UP"
    DOWN = "DOWN"
    CLOSED = "CLOSED"


class PoolLinkEvent(str, Enum):
    REFRESH_OK = "REFRESH_OK"
    REFRESH_FAIL = "REFRESH_FAIL"
    SHUTDOWN = "SHUTDOWN"


class LinkAction(str, Enum):
    NONE = "NONE"
    DISCONNECT = "DISCONNECT"


RECONNECT_BACKOFF_START = 5
RECONNECT_BACKOFF_MAX = 60


def next_backoff(seconds):
    """The reconnect ladder: 5, 10, 20, 40, 60, 60…

    Deliberately NOT part of the machine's state. Only the run loop sleeps on
    it, and only the run loop's own attempts should advance it: as shared state
    the post-command refresh could double it while the run loop was asleep, and
    the number would stop meaning "consecutive failed reconnect attempts".
    """
    return min(seconds * 2, RECONNECT_BACKOFF_MAX)


_S, _E, _A = PoolLinkState, PoolLinkEvent, LinkAction

# Every failure disconnects, matching what the run loop always did: a refresh
# that raised can leave the socket wedged, and reconnecting on top of it is how
# a transient drop turned into a permanent one.
_TABLE = {
    _S.NEVER_CONNECTED: {
        _E.REFRESH_OK: (_S.UP, _A.NONE),
        _E.REFRESH_FAIL: (_S.NEVER_CONNECTED, _A.DISCONNECT),
        _E.SHUTDOWN: (_S.CLOSED, _A.DISCONNECT),
    },
    _S.UP: {
        _E.REFRESH_OK: (_S.UP, _A.NONE),
        _E.REFRESH_FAIL: (_S.DOWN, _A.DISCONNECT),
        _E.SHUTDOWN: (_S.CLOSED, _A.DISCONNECT),
    },
    _S.DOWN: {
        _E.REFRESH_OK: (_S.UP, _A.NONE),
        _E.REFRESH_FAIL: (_S.DOWN, _A.DISCONNECT),
        _E.SHUTDOWN: (_S.CLOSED, _A.DISCONNECT),
    },
    # Terminal. A refresh already in flight when the bridge shut down must not
    # walk the link back to UP after the adapter's slot has been handed back.
    _S.CLOSED: {},
}

# Same role CONNECTION_TABLE plays for the client: tests/test_poollink.py reads
# DESIGN.md 3.1 and asserts the documented table and this one describe the same
# machine, in both directions. A table nobody executes is a table nobody
# notices going stale.
PUBLIC_TABLE = _TABLE


def link_transition(state, event):
    """(state, event) -> (next_state, action). Total: unlisted pairs are logged
    no-ops, the same rule the client FSMs use."""
    row = _TABLE.get(state, {})
    if event not in row:
        print(f"pool link: ignored {event.value} in {state.value}")
        return state, LinkAction.NONE
    return row[event]
