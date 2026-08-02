// The poll latch and generation token: one poll in flight at a time, and a
// poll that has been given up on has its late answer discarded rather than
// counted a second time.
//
// Both mechanisms exist solely to stop the app wedging, so neither shows up in
// normal operation and neither was previously verified by anything but a
// comment. Together they are small enough to state as invariants:
//
//   - begin() hands out a token only when nothing is in flight
//   - settle() accepts a token only if it has not been abandoned since
//   - abandon() releases the latch, so a poll that never settles cannot
//     silently swallow every future one

export function createPollGuard() {
  let inFlight = false;
  let generation = 0;

  return {
    // null means "a poll is already in flight; don't start another".
    begin() {
      if (inFlight) return null;
      inFlight = true;
      return generation;
    },

    // false means "this answer arrived after we gave up on it" — the caller
    // must drop it on the floor. Counting it would advance the retry ladder
    // twice for one failed attempt and skip a backoff rung.
    settle(token) {
      if (token !== generation) return false;
      inFlight = false;
      return true;
    },

    abandon() {
      generation += 1;
      inFlight = false;
    },

    get busy() {
      return inFlight;
    },
  };
}
