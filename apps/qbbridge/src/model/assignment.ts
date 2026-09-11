/**
 * One room's game, as ordinary QBJ.
 *
 * # Not a new format, and not Director's builder
 *
 * This writes the document `docs/QBJ_ASSIGNMENT_PROFILE.md` describes: a normal serialized QBJ
 * carrying exactly one unplayed `Match`. QBSheet Scorer reads it with the same parser it uses for
 * a file on a memory stick, because it is the same kind of document.
 *
 * Director's `src/director/transfers/assignment.ts` builds the same shape and was the reference
 * for it. It is not reused, because its input is a `DirectorState` — issued definition snapshots,
 * scheduled games, lifecycle status, packet and release state, submission records. Constructing a
 * fake one of those so that a twelve-team Saturday could publish a pairing would import the whole
 * machine this application exists to avoid. What is shared is the format, not the state machine.
 *
 * # What travels, and what must not
 *
 * Included: the tournament, the completed scoring rules, the two registrations, the two teams and
 * their players, the phase, the round, and one match. Excluded, by construction rather than by a
 * filter: every other room, every other round, standings, and anything credential-shaped. The
 * document is assembled from named fields, and `stripSecrets` runs over the result as a second
 * check rather than as the defence.
 *
 * # Unplayed means unplayed
 *
 * No `tossups_read`, no team `points`, no zeroed totals. An importer separates an assignment from
 * a result by the absence of scoring content, and a fabricated zero removes that signal.
 */

import { stripSecrets } from '../../../../src/director/transfers/canonical';
import { pairingMatchId } from './identity';
import type { BridgeRound, BridgeTeam, BridgeTournament } from './tournament';

/** The QBJ serialization version QBSheet writes and accepts. */
export const qbjSerializationVersion = '2.1.1';

export interface AssignmentInput {
  tournament: BridgeTournament;
  round: BridgeRound;
  roomId: string;
  roomName: string;
  left: BridgeTeam;
  right: BridgeTeam;
  /** The room's issue number for this assignment. Not an identity; see `identity.ts`. */
  assignmentRevision: number;
}

export interface PreparedAssignment {
  roomId: string;
  roomName: string;
  matchId: string;
  roundId: string;
  roundQbjName: string;
  roundNumber?: number;
  assignmentRevision: number;
  leftTeamName: string;
  rightTeamName: string;
  /** The document, exactly as it goes to the relay. */
  document: Record<string, unknown>;
}

export type AssignmentResult = { ok: true; assignment: PreparedAssignment } | { ok: false; error: string };

function teamObject(team: BridgeTeam): Record<string, unknown> {
  return {
    type: 'Team',
    id: team.id,
    name: team.name,
    registration: { $ref: team.registrationId },
    players: team.players.map((player) => ({ type: 'Player', id: player.id, name: player.name })),
  };
}

/**
 * The registrations for the two teams playing.
 *
 * A school that entered A and B teams is one `Registration` in YellowFruit, and both sides of an
 * A-vs-B game resolve to it. Emitting it twice would put two objects with one id in the document;
 * emitting the school's whole team list would leave references to teams the document does not
 * carry. So each registration appears once, listing only the teams this game actually contains.
 */
function registrationObjects(left: BridgeTeam, right: BridgeTeam): Record<string, unknown>[] {
  const byId = new Map<string, { name: string; teamIds: string[] }>();
  for (const team of [left, right]) {
    const existing = byId.get(team.registrationId);
    if (existing) existing.teamIds.push(team.id);
    else byId.set(team.registrationId, { name: team.registrationName, teamIds: [team.id] });
  }
  return [...byId].map(([id, entry]) => ({
    type: 'Registration',
    id,
    name: entry.name,
    teams: entry.teamIds.map((teamId) => ({ $ref: teamId })),
  }));
}

/** Build the assignment for one room in one round. */
export function buildAssignment(input: AssignmentInput): AssignmentResult {
  const { tournament, round, left, right } = input;
  if (left.id === right.id) return { ok: false, error: 'Both sides of this room are the same team.' };
  if (tournament.timed === null) {
    // QBJ cannot say this and QBSheet refuses to guess it, so a file that never stated it cannot
    // produce a scoreable assignment. Reloading a `.yft` saved by any YellowFruit build fixes it.
    return {
      ok: false,
      error: 'This YellowFruit file does not say whether rounds are timed, so a room cannot score it.',
    };
  }

  const matchId = pairingMatchId({
    tournamentId: tournament.id,
    roundId: round.id,
    roomId: input.roomId,
    leftTeamId: left.id,
    rightTeamId: right.id,
  });

  const match: Record<string, unknown> = {
    type: 'Match',
    id: matchId,
    location: input.roomName,
    match_teams: [{ team: { $ref: left.id } }, { team: { $ref: right.id } }],
    _qbtcp: {
      version: 1,
      assignment_revision: Math.max(1, input.assignmentRevision),
      room_id: input.roomId,
      // The one scoring semantic QBJ has no field for. No duration travels with it: stock
      // YellowFruit stores none, so none is invented, and the moderator calls time.
      scorekeeper: { timed: tournament.timed },
    },
  };

  const roundObject: Record<string, unknown> = {
    type: 'Round',
    id: round.id,
    // YellowFruit's own spelling, usually a bare number. Its importer resolves a round by running
    // `parseInt` over this, so it is carried through untouched.
    name: round.qbjName,
    ...(round.number !== undefined ? { number: round.number } : {}),
    // Exactly this game. The round holds other matches; naming them here is how a document handed
    // to one room would tell it the rest of the schedule.
    matches: [{ $ref: matchId }],
  };

  const phaseId = round.phaseId || 'Phase_QBBridge';
  const phaseObject: Record<string, unknown> = {
    type: 'Phase',
    id: phaseId,
    name: round.phaseName || 'Tournament',
    rounds: [roundObject],
  };

  const registrations = registrationObjects(left, right);

  const document = {
    version: qbjSerializationVersion,
    objects: [
      {
        type: 'Tournament',
        id: tournament.id,
        name: tournament.name,
        scoring_rules: { $ref: tournament.rules.id },
        registrations: registrations.map((registration) => ({ $ref: registration.id })),
        // The schedule spine is nested rather than referenced. Stock YellowFruit's importer walks
        // `Tournament.phases[].rounds[].matches[]` literally and does not resolve `$ref` at the
        // phase or round link, so a referenced spine reads to it as a file with no matches in it.
        // QBSheet resolves either. Nesting is the shape both can read.
        phases: [phaseObject],
      },
      tournament.rules,
      ...registrations,
      teamObject(left),
      teamObject(right),
      // The match is also a top-level object: QBSheet enumerates scoreable games from the object
      // list and reaches the round through the spine above.
      match,
    ],
  };

  return {
    ok: true,
    assignment: {
      roomId: input.roomId,
      roomName: input.roomName,
      matchId,
      roundId: round.id,
      roundQbjName: round.qbjName,
      ...(round.number !== undefined ? { roundNumber: round.number } : {}),
      assignmentRevision: Math.max(1, input.assignmentRevision),
      leftTeamName: left.name,
      rightTeamName: right.name,
      document: stripSecrets(document) as unknown as Record<string, unknown>,
    },
  };
}
