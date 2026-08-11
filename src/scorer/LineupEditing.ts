/**
 * Turning "who is playing" into the array a substitution event stores.
 *
 * # Why the order is worked out rather than collected
 *
 * A lineup event carries a complete `activePlayers` array, and the order in that array is part of
 * the scoresheet: it is what a director reads, what the QBJ carries, and what a later correction is
 * diffed against. It is *not* a record of the order somebody happened to press buttons in.
 *
 * The old checkbox editor collected it by accident. Unticking Sarah and ticking her again put her at
 * the end of the array, so an editor session that changed nothing but a scorekeeper's mind produced
 * an event whose lineup had been silently rewritten. Nothing downstream is wrong afterwards —
 * tossups heard is set membership — but the scoresheet now says something happened that did not, and
 * the next person to compare two lineup events has to work out that the difference is noise.
 *
 * So membership is the only thing the editors track, and the array is derived from it here: whoever
 * was already playing keeps the place they already had, and whoever is genuinely new is appended in
 * roster order. Two scorekeepers who reach the same lineup by different routes write the same event.
 *
 * # Why device seating is not in this file
 *
 * Because it is not scoring history. `PlayerSeating` owns what order this Chromebook shows people
 * in, and it is deliberately a different question from who was on the floor at a tossup boundary —
 * see the note at the top of that file. The editors present rows in seating order because that is
 * what the room is looking at; what they write comes from here, from the roster and from the lineup
 * that is already recorded.
 */
import { LeftOrRight } from '../scoring/types';
import { ScoreEvent } from '../scoring/ScoreEvents';

/**
 * The complete lineup a membership change produces.
 *
 * Survivors first, in the order the recorded lineup already had them, then the newly-active in
 * roster order. Neither input is the order the rows were shown in and neither is the order they were
 * clicked in, which is the whole point.
 */
export function orderedActivePlayers(
  recordedActive: readonly string[],
  rosterNames: readonly string[],
  playing: ReadonlySet<string>,
): string[] {
  const surviving = recordedActive.filter((name) => playing.has(name));
  const arriving = rosterNames.filter((name) => playing.has(name) && !recordedActive.includes(name));
  // A name in neither list is a name in `playing` that is on no roster, which is a caller's bug
  // rather than a lineup, and dropping it here would hide it. Append it so it stays visible.
  const known = new Set(surviving.concat(arriving));
  const unplaced = Array.from(playing).filter((name) => !known.has(name));
  return surviving.concat(arriving, unplaced);
}

/** Whether two lineups contain the same people, whatever order either of them is in. */
export function sameMembership(first: readonly string[], second: readonly string[]): boolean {
  if (first.length !== second.length) return false;
  const inFirst = new Set(first);
  return second.every((name) => inFirst.has(name));
}

/**
 * Who this team's roster did not have yet at a tossup boundary.
 *
 * A substitution being corrected to take effect at tossup 8 cannot put on somebody the roster gained
 * at tossup 14. Offering them as an ordinary bench choice would let a scorekeeper build a history in
 * which a player heard tossups that were read before anybody wrote their name down — which
 * `validateCorrectedHistory` would then refuse, from inside a dialog that had just presented the
 * option as normal.
 *
 * Read from the events rather than from the derived roster because the derived roster is the roster
 * *now*; only the `roster-add` events say when each name arrived.
 */
export function playersAddedAfter(
  events: readonly ScoreEvent[],
  team: LeftOrRight,
  boundary: number,
): Set<string> {
  const later = new Set<string>();
  for (const event of events) {
    if (event.type !== 'roster-add' || event.team !== team) continue;
    if (event.questionNumber > boundary) later.add(event.playerName);
  }
  return later;
}
