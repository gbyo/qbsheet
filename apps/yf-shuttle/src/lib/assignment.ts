/**
 * One room's game, as ordinary QBJ.
 *
 * # The same document QBBridge writes, generalized to file handoff
 *
 * This is the document `docs/QBJ_ASSIGNMENT_PROFILE.md` describes: a normal serialized QBJ
 * carrying exactly one unplayed `Match`. It follows the same shape as
 * `apps/qbbridge/src/model/assignment.ts` — QBJ 2.1.1, preserved YellowFruit ids, numeric
 * `Round.name`, nested Tournament → Phase → Round → Match spine plus a top-level Match,
 * completed scoring rules, timed/untimed through `_qbtcp`, no fake zero scores — generalized
 * only in that the operational extension carries a file-handoff instruction ("place it in this
 * room's OUT folder") instead of relay metadata, and the Match id is namespaced `yfshuttle-`
 * (see `shuttleMatchId`) so a file-handoff game can never share an identity with a relay game.
 *
 * Included: the tournament, the completed scoring rules, the two registrations, the two teams
 * and their players, the phase, the round, and one match. Excluded by construction: every
 * other room, every other round, standings, and anything credential-shaped.
 */

import { stripSecrets } from '../../../../src/director/transfers/canonical';
import { fnv1a64 } from './fnv';
import type { ShuttleTeam, ShuttleTournament } from './tournament';

/** The QBJ serialization version QBSheet writes and accepts. */
export const qbjSerializationVersion = '2.1.1';

export interface AssignmentInput {
  tournament: ShuttleTournament;
  /**
   * Preserve a real scheduled Match id from the file instead of deriving one.
   *
   * Used only for file-sourced schedules, where the `.yft` already holds this exact game as
   * a blank and the completed result must fill that same id. Preset games always derive.
   */
  existingMatchId?: string;
  roundId: string;
  roundQbjName: string;
  roundNumber?: number;
  phaseId: string;
  phaseName: string;
  slotId: string;
  roomName: string;
  left: ShuttleTeam;
  right: ShuttleTeam;
}

export interface PreparedAssignment {
  slotId: string;
  roomName: string;
  matchId: string;
  roundId: string;
  roundQbjName: string;
  roundNumber?: number;
  leftTeamId: string;
  rightTeamId: string;
  leftTeamName: string;
  rightTeamName: string;
  /** The document, exactly as it is written to the room's IN folder. */
  document: Record<string, unknown>;
}

export type AssignmentResult = { ok: true; assignment: PreparedAssignment } | { ok: false; error: string };

/**
 * The stable `Match.id` for one pairing.
 *
 * The same derivation QBBridge uses (`apps/qbbridge/src/model/identity.ts`): a pure function
 * of tournament id, round id, stable room-slot id, and the two team ids in order, hashed as an
 * unambiguous JSON tuple. Regenerating the same pairing reproduces the id; changing any input
 * produces a different one. The prefix is namespaced to this tool so a file-handoff assignment
 * and a relay assignment for the same pairing never claim one identity. Crucially the room
 * *display* name is not an input: renaming a room leaves every Match id untouched.
 */
export function shuttleMatchId(input: {
  tournamentId: string;
  roundId: string;
  slotId: string;
  leftTeamId: string;
  rightTeamId: string;
}): string {
  const key = JSON.stringify([
    input.tournamentId,
    input.roundId,
    input.slotId,
    input.leftTeamId,
    input.rightTeamId,
  ]);
  return `yfshuttle-match-${fnv1a64(key)}`;
}

/** Return the Round.name spelling that stock YellowFruit can resolve on import. */
function stockRoundName(roundQbjName: string, roundNumber?: number): string | null {
  if (roundNumber !== undefined) {
    return Number.isSafeInteger(roundNumber) && roundNumber > 0 ? String(roundNumber) : null;
  }
  const parsed = Number.parseInt(roundQbjName, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? roundQbjName : null;
}

function teamObject(team: ShuttleTeam): Record<string, unknown> {
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
 * A school that entered A and B teams is one `Registration` in YellowFruit, and both sides of
 * an A-vs-B game resolve to it. Each registration appears once, listing only the teams this
 * game actually contains.
 */
function registrationObjects(left: ShuttleTeam, right: ShuttleTeam): Record<string, unknown>[] {
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

/** Build the assignment for one room slot in one round. */
export function buildAssignment(input: AssignmentInput): AssignmentResult {
  const { tournament, left, right } = input;
  if (left.id === right.id) return { ok: false, error: 'Both sides of this room are the same team.' };
  if (tournament.timed === null) {
    // QBJ cannot say this and QBSheet refuses to guess it, so a file that never stated it cannot
    // produce a scoreable assignment. Saving the `.yft` again from YellowFruit fixes it.
    return {
      ok: false,
      error: 'This YellowFruit file does not say whether rounds are timed, so a room cannot score it.',
    };
  }
  const roundName = stockRoundName(input.roundQbjName, input.roundNumber);
  if (roundName === null) {
    return {
      ok: false,
      error: `Round “${input.roundQbjName}” has no numeric round identity for YellowFruit import.`,
    };
  }

  const matchId =
    input.existingMatchId ??
    shuttleMatchId({
      tournamentId: tournament.id,
      roundId: input.roundId,
      slotId: input.slotId,
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
      room_id: input.slotId,
      // The lifecycle marker consumers read: this file is an unplayed assignment, never a
      // result. QBSheet's finished and mid-game exports restamp it on the way out.
      file_state: 'assignment',
      handoff_instruction: `When the game is finished, download the completed QBJ and place it in ${input.roomName} → OUT.`,
      // The one scoring semantic QBJ has no field for. No duration travels with it: stock
      // YellowFruit stores none, so none is invented, and the moderator calls time.
      scorekeeper: { timed: tournament.timed },
    },
  };

  const roundObject: Record<string, unknown> = {
    type: 'Round',
    id: input.roundId,
    // Stock YellowFruit resolves the target round by running `parseInt` over `name`.
    name: roundName,
    ...(input.roundNumber !== undefined ? { number: input.roundNumber } : {}),
    // Exactly this game. The round holds other matches; naming them here is how a document
    // handed to one room would tell it the rest of the schedule.
    matches: [{ $ref: matchId }],
  };

  const phaseObject: Record<string, unknown> = {
    type: 'Phase',
    id: input.phaseId,
    name: input.phaseName,
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
        // The schedule spine is nested rather than referenced. Stock YellowFruit's importer
        // walks `Tournament.phases[].rounds[].matches[]` literally and does not resolve `$ref`
        // at the phase or round link, so a referenced spine reads as a file with no matches.
        // QBSheet resolves either. Nesting is the shape both can read.
        phases: [phaseObject],
      },
      tournament.rules,
      ...registrations,
      teamObject(left),
      teamObject(right),
      // The match is also a top-level object: QBSheet enumerates scoreable games from the
      // object list and reaches the round through the spine above.
      match,
    ],
  };

  return {
    ok: true,
    assignment: {
      slotId: input.slotId,
      roomName: input.roomName,
      matchId,
      roundId: input.roundId,
      roundQbjName: roundName,
      ...(input.roundNumber !== undefined ? { roundNumber: input.roundNumber } : {}),
      leftTeamId: left.id,
      rightTeamId: right.id,
      leftTeamName: left.name,
      rightTeamName: right.name,
      document: stripSecrets(document) as unknown as Record<string, unknown>,
    },
  };
}

/** The exact ordinary QBJ bytes written to a room's IN folder. */
export function assignmentFileContents(assignment: Pick<PreparedAssignment, 'document'>): string {
  return `${JSON.stringify(assignment.document, null, 2)}\n`;
}
