"""Wire values shared with the client.

comStatus is the client's only input for the pool-link half of its connection
FSM: api.js maps anything that is not "ok" onto POLL_POOL_DOWN. That default is
the safe direction, but it is silent — renaming a value here would pin every
phone in DEGRADED indefinitely with nothing to show for it. Naming them makes
that a two-place edit instead of a mystery.

The client's copy is `ComStatus` in app/js/fsm/connection.js.
"""

COM_OK = "ok"
COM_POOL_UNREACHABLE = "pool_unreachable"
