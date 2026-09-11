/**
 * Match identity for a hand-made pairing.
 *
 * # Why it is derived rather than minted
 *
 * A result QBJ is reconciled to its game by `Tournament.id` + `Match.id`. That only works if the
 * same pairing keeps the same match id across a rerender, a reload, a republish and an app
 * restart — so the id is a pure function of what the pairing *is*, and is never stored, never
 * random, and never derived from a filename.
 *
 * The inputs are exactly the things that make it a different game: the tournament, the round, the
 * room, and the two teams in the order they were entered. Change any of them and the pairing is a
 * different pairing, which is the behaviour wanted: a room whose matchup was corrected must not
 * hand back a result under the identity of the pairing it replaced.
 *
 * Reissuing the *same* pairing — republishing a round after a relay failure, say — moves only the
 * assignment revision. The match identity is unchanged, because the game is unchanged.
 */

import { fnv1a64 } from '../../../../src/director/transfers/canonical';

export interface PairingIdentityInput {
  tournamentId: string;
  roundId: string;
  roomId: string;
  leftTeamId: string;
  rightTeamId: string;
}

/**
 * The stable `Match.id` for one pairing.
 *
 * The parts are encoded as a JSON tuple before hashing. JSON's length and quoting rules keep
 * boundaries unambiguous even when an imported id contains punctuation or control characters.
 */
export function pairingMatchId(input: PairingIdentityInput): string {
  const key = JSON.stringify([
    input.tournamentId,
    input.roundId,
    input.roomId,
    input.leftTeamId,
    input.rightTeamId,
  ]);
  return `qbbridge-match-${fnv1a64(key)}`;
}

/** A room's stable id. Rooms persist across rounds, so this is minted once and then kept. */
export function nextRoomId(existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((room) => room.id));
  let index = existing.length + 1;
  while (taken.has(`room-${index}`)) index += 1;
  return `room-${index}`;
}
