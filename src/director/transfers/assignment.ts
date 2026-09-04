/**
 * A one-game assignment as ordinary QBJ.
 *
 * # The same document QBTCP sends
 *
 * `generated_assignment` in `apps/director/src-tauri/src/server.rs` already builds a one-game
 * assignment for QBTCP delivery. This builds the same document — same objects, same identifiers,
 * same `_qbtcp` block, same generated `ScoringRules` — because a room must not be able to tell
 * which route its assignment took. If the file path invented its own shape, a tournament running
 * both would be running two products, and the first difference anyone found would be found by a
 * scorekeeper mid-round rather than by a test.
 *
 * The two builders live in different languages for a boring reason: the QBTCP one runs inside the
 * native server that holds the released round, and the file one runs in the view that a director
 * clicks. `assignment.qbj.test.ts` pins the shape so they cannot drift silently.
 *
 * # What must not be in here, and how that is enforced rather than intended
 *
 * No other pairing, no future round, no standings, no pairing code, no QBTCP token, no session, no
 * server address, no private Director state. The construction below is additive from named fields,
 * so a leak would have to be written deliberately — and then `stripSecrets` removes anything
 * credential-shaped on the way out anyway, and a test asserts that a prepared round's files mention
 * no game other than their own.
 *
 * Additive construction is the primary defence. The strip is the second one, kept because "the
 * builder provably cannot leak" is a property of today's builder.
 */
import {
  orderDayItems,
  type DirectorId,
  type DirectorState,
  type Round,
  type ScheduledGame,
  type TournamentRules,
} from '../domain';
import { stripSecrets } from './canonical';
import { assignmentFileName } from './filenames';

/** The QBJ serialization version Director writes. Matches the scorer and the QBTCP server. */
export const qbjSerializationVersion = '2.1.1';
export const qbjMimeType = 'application/vnd.quizbowl.qbj+json';

export interface PreparedAssignment {
  scheduledGameId: DirectorId;
  matchId: string;
  roundId: DirectorId;
  roundName: string;
  roundNumber: number;
  roundRevision: number;
  assignmentRevision: number;
  roomName?: string;
  roomId?: string;
  leftTeamName: string;
  rightTeamName: string;
  fileName: string;
  /** The serialized document, exactly as it will be written. */
  text: string;
  document: Record<string, unknown>;
  /** Non-fatal notes for the director: something the tournament stated that QBJ could not carry. */
  warnings: string[];
}

export type AssignmentBuildFailure = {
  scheduledGameId: DirectorId;
  reason: string;
};

export type AssignmentBuildResult =
  { ok: true; assignment: PreparedAssignment } | { ok: false; failure: AssignmentBuildFailure };

function greatestCommonDivisor(left: number, right: number): number {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

function scoreDivisor(values: number[]): number {
  return Math.max(
    1,
    values
      .map((value) => Math.abs(value))
      .filter((value) => value > 0)
      .reduce((accumulator, value) => greatestCommonDivisor(accumulator, value), 0),
  );
}

/**
 * Director's rules as a QBJ `ScoringRules`.
 *
 * Structural throughout. `name` is a label and nothing branches on it — the scorer derives every
 * behaviour from `answer_types`, the bonus fields and the tossup counts, which is what makes an
 * assignment readable by a tool that has never heard of QBSheet.
 *
 * Both bonus toggles are always written. The assignment profile requires them explicitly when
 * bonus structure is present, because their absence changes the score rather than the presentation.
 */
export function scoringRulesObject(rules: TournamentRules, id: string): Record<string, unknown> {
  const tossup = rules.tossupValue;
  const power = rules.powerValue;
  const superpower = rules.superpowerValue;
  const neg = rules.negValue;
  const useBonuses = rules.useBonuses;
  const bonus = Math.max(1, rules.bonusValue);
  const tossupCount = rules.tossupCount > 0 ? rules.tossupCount : 20;
  const maximumTossups = rules.maximumTossupCount ?? tossupCount;
  const bonusParts = rules.bonusParts > 0 ? rules.bonusParts : 3;
  const minimumParts = rules.minimumBonusParts ?? bonusParts;
  const maximumBonusScore = rules.maximumBonusScore ?? bonus * bonusParts;
  const bonusDivisor = rules.bonusDivisor ?? bonus;
  const maximumPlayers = rules.maximumActivePlayers > 0 ? rules.maximumActivePlayers : 4;
  const answerTypes: Record<string, unknown>[] = [];
  if (superpower !== null && superpower !== undefined) {
    answerTypes.push({
      type: 'AnswerType',
      id: 'answer-superpower',
      value: superpower,
      label: 'Superpower',
      short_label: 'SP',
      awards_bonus: useBonuses,
    });
  }
  if (power !== null && power !== undefined) {
    answerTypes.push({
      type: 'AnswerType',
      id: 'answer-power',
      value: power,
      label: 'Power',
      short_label: 'P',
      awards_bonus: useBonuses,
    });
  }
  answerTypes.push({
    type: 'AnswerType',
    id: 'answer-correct',
    value: tossup,
    label: 'Correct',
    short_label: 'C',
    awards_bonus: useBonuses,
  });
  if (neg !== null && neg !== undefined) {
    answerTypes.push({
      type: 'AnswerType',
      id: 'answer-neg',
      value: neg,
      label: 'Neg',
      short_label: 'N',
      awards_bonus: false,
    });
  }
  return {
    type: 'ScoringRules',
    id,
    name: 'Director scoring rules',
    teams_per_match: 2,
    maximum_players_per_team: maximumPlayers,
    regulation_tossup_count: tossupCount,
    maximum_regulation_tossup_count: maximumTossups,
    minimum_overtime_question_count: Math.max(1, rules.overtimeTossupCount),
    overtime_includes_bonuses: useBonuses && rules.overtimeBonuses,
    // The scorer derives this same divisor from every answer value (negs
    // included), the bonus divisor, and the lightning divisor. Match that
    // derivation exactly: a divisor that does not divide every value fails
    // the shared playability check.
    total_divisor: scoreDivisor([
      ...(superpower !== null && superpower !== undefined ? [superpower] : []),
      ...(power !== null && power !== undefined ? [power] : []),
      tossup,
      ...(neg !== null && neg !== undefined ? [neg] : []),
      ...(useBonuses ? [bonusDivisor] : []),
      ...(rules.lightning ? [Math.max(1, rules.lightningDivisor)] : []),
    ]),
    answer_types: answerTypes,
    ...(useBonuses
      ? {
          maximum_bonus_score: maximumBonusScore,
          bonus_divisor: bonusDivisor,
          minimum_parts_per_bonus: minimumParts,
          maximum_parts_per_bonus: bonusParts,
          // A single per-part value is only true for regular bonuses. Omitting
          // it for irregular shapes is what tells the scorer to take a typed total.
          ...(minimumParts === bonusParts ? { points_per_bonus_part: bonus } : {}),
          bonuses_bounce_back: rules.bouncebacks,
        }
      : {}),
    ...(rules.lightning
      ? {
          lightning_count_per_team: Math.max(1, rules.lightningCountPerTeam),
          lightning_divisor: Math.max(1, rules.lightningDivisor),
        }
      : {}),
  };
}

function teamObject(state: DirectorState, teamId: DirectorId): Record<string, unknown> | null {
  const team = state.teams.find((entry) => entry.id === teamId);
  if (!team) return null;
  return {
    type: 'Team',
    id: team.id,
    name: team.displayName,
    registration: { $ref: `registration-${team.id}` },
    players: state.players
      .filter((player) => player.teamId === team.id && player.active !== false)
      .map((player) => ({
        type: 'Player',
        id: player.id,
        name: player.name,
        captain: player.captain,
      })),
  };
}

export interface AssignmentBuildOptions {
  /** Free text shown to the room. Never interpreted; carried in `_qbtcp.handoff_instruction`. */
  handoffInstruction?: string;
}

/**
 * Build the assignment for one scheduled game.
 *
 * Returns a failure rather than throwing, and a failure rather than a half-document: a round with
 * one unassigned room should produce eleven files and one explained gap, not eleven files and a
 * twelfth that a room cannot score.
 */
export function buildAssignment(
  state: DirectorState,
  scheduledGameId: DirectorId,
  options: AssignmentBuildOptions = {},
): AssignmentBuildResult {
  const fail = (reason: string): AssignmentBuildResult => ({
    ok: false,
    failure: { scheduledGameId, reason },
  });
  const tournament = state.tournament;
  if (!tournament) return fail('There is no open tournament.');
  const scheduled = state.scheduledGames.find((game) => game.id === scheduledGameId);
  if (!scheduled) return fail('That scheduled game is no longer in the schedule.');
  if (scheduled.bye) return fail('A bye has no game to score.');
  if (scheduled.status === 'cancelled') return fail('That game is cancelled.');
  if (!scheduled.rightTeamId) return fail('That game has only one team.');
  const round = state.rounds.find((entry) => entry.id === scheduled.roundId);
  if (!round) return fail('That game is not in a round.');

  const left = teamObject(state, scheduled.leftTeamId);
  const right = teamObject(state, scheduled.rightTeamId);
  if (!left || !right) return fail('One of the teams is no longer in the tournament.');
  const leftName = String(left.name);
  const rightName = String(right.name);

  const phase = state.phases.find((entry) => entry.id === round.phaseId);
  const room = scheduled.roomId ? state.rooms.find((entry) => entry.id === scheduled.roomId) : undefined;
  const packetId = scheduled.packetId ?? round.packetId ?? null;
  const packet = packetId ? state.packets.find((entry) => entry.id === packetId) : undefined;
  const rulesId = `scoring-rules-${tournament.id}`;
  const warnings: string[] = [];
  if (!room) warnings.push('This game has no room; the assignment carries no room name.');
  if (state.players.filter((player) => player.teamId === scheduled.leftTeamId).length === 0)
    warnings.push(`${leftName} has no roster; the room will enter players by hand.`);
  if (state.players.filter((player) => player.teamId === scheduled.rightTeamId).length === 0)
    warnings.push(`${rightName} has no roster; the room will enter players by hand.`);

  const matchObject: Record<string, unknown> = {
    type: 'Match',
    id: scheduled.id,
    ...(room ? { location: room.name } : {}),
    // An unplayed match is written as unplayed: no `tossups_read`, no team `points`, no zeroed
    // totals. A fabricated zero is what makes an assignment look like a 0-0 result to an importer.
    match_teams: [{ team: { $ref: scheduled.leftTeamId } }, { team: { $ref: scheduled.rightTeamId } }],
    _qbtcp: {
      version: 1,
      round_revision: round.revision > 0 ? round.revision : 1,
      assignment_revision: scheduled.assignmentRevision > 0 ? scheduled.assignmentRevision : 1,
      ...(room ? { room_id: room.id } : {}),
      ...(options.handoffInstruction ? { handoff_instruction: options.handoffInstruction } : {}),
      scorekeeper: { timed: tournament.rules.timed },
    },
  };

  const roundObject: Record<string, unknown> = {
    type: 'Round',
    id: round.id,
    name: round.name,
    number: round.number,
    // Exactly this game. The round genuinely holds other matches; naming them here is how a file
    // handed to one room would tell it the rest of the bracket.
    matches: [{ $ref: scheduled.id }],
    ...(packet ? { packet: { type: 'Packet', id: packet.id, name: packet.name } } : {}),
  };

  const phaseObject: Record<string, unknown> = {
    type: 'Phase',
    id: phase?.id ?? round.phaseId ?? 'phase-1',
    name: phase?.name ?? 'Tournament',
    rounds: [{ $ref: round.id }],
  };

  const document = {
    version: qbjSerializationVersion,
    objects: [
      {
        type: 'Tournament',
        id: tournament.id,
        name: tournament.name,
        scoring_rules: { $ref: rulesId },
        registrations: [
          { $ref: `registration-${scheduled.leftTeamId}` },
          { $ref: `registration-${scheduled.rightTeamId}` },
        ],
        phases: [{ $ref: phaseObject.id }],
      },
      scoringRulesObject(tournament.rules, rulesId),
      {
        type: 'Registration',
        id: `registration-${scheduled.leftTeamId}`,
        name: leftName,
        teams: [{ $ref: scheduled.leftTeamId }],
      },
      {
        type: 'Registration',
        id: `registration-${scheduled.rightTeamId}`,
        name: rightName,
        teams: [{ $ref: scheduled.rightTeamId }],
      },
      left,
      right,
      phaseObject,
      roundObject,
      matchObject,
      ...(packet ? [{ type: 'Packet', id: packet.id, name: packet.name }] : []),
    ],
  };

  const sanitized = stripSecrets(document) as Record<string, unknown>;
  return {
    ok: true,
    assignment: {
      scheduledGameId: scheduled.id,
      matchId: scheduled.id,
      roundId: round.id,
      roundName: round.name,
      roundNumber: round.number,
      roundRevision: round.revision > 0 ? round.revision : 1,
      assignmentRevision: scheduled.assignmentRevision > 0 ? scheduled.assignmentRevision : 1,
      ...(room ? { roomName: room.name, roomId: room.id } : {}),
      leftTeamName: leftName,
      rightTeamName: rightName,
      fileName: assignmentFileName({
        roundName: round.name,
        roomName: room?.name ?? null,
        leftTeam: leftName,
        rightTeam: rightName,
      }),
      text: `${JSON.stringify(sanitized, null, 2)}\n`,
      document: sanitized,
      warnings,
    },
  };
}

export type AssignmentSelection =
  | { kind: 'current-round' }
  | { kind: 'round'; roundId: DirectorId }
  | { kind: 'released' }
  | { kind: 'games'; scheduledGameIds: DirectorId[] }
  | { kind: 'unconnected-rooms'; roundId?: DirectorId };

export function currentOperationalRound(state: DirectorState): Round | undefined {
  const rounds = orderDayItems(state.rounds, state.timeline).flatMap((item) =>
    item.round ? [item.round] : [],
  );
  const selected = rounds.find((round) => round.id === state.tournament?.currentRoundId);
  // An actively running round wins. Otherwise the next round in the persisted day
  // order is useful; generating all nine rounds must not make Round 9 current.
  if (selected?.status === 'released') return selected;
  return (
    rounds.find((round) => round.status === 'released') ?? rounds.find((round) => round.status !== 'closed')
  );
}

/**
 * Which games a selection names.
 *
 * `unconnected-rooms` exists because a director sometimes wants exactly the rooms without a live
 * QBTCP session — but it is one option among several and never a filter applied on Director's own
 * initiative. Preparing files for rooms that are connected right now is the backup workflow, and it
 * is the most valuable one: the stick is made before the round, when nothing has gone wrong yet.
 */
export function selectScheduledGames(state: DirectorState, selection: AssignmentSelection): ScheduledGame[] {
  const playable = (game: ScheduledGame) => !game.bye && game.rightTeamId && game.status !== 'cancelled';
  switch (selection.kind) {
    case 'current-round': {
      const round = currentOperationalRound(state);
      return round ? state.scheduledGames.filter((game) => game.roundId === round.id && playable(game)) : [];
    }
    case 'round':
      return state.scheduledGames.filter((game) => game.roundId === selection.roundId && playable(game));
    case 'released': {
      const releasedRoundIds = new Set(
        state.rounds.filter((round) => round.status === 'released').map((round) => round.id),
      );
      return state.scheduledGames.filter((game) => releasedRoundIds.has(game.roundId) && playable(game));
    }
    case 'games': {
      const wanted = new Set(selection.scheduledGameIds);
      return state.scheduledGames.filter((game) => wanted.has(game.id) && playable(game));
    }
    case 'unconnected-rooms': {
      const roundId = selection.roundId ?? currentOperationalRound(state)?.id;
      const connectedRoomIds = new Set(
        state.qbtcpSessions
          .filter((session) => session.state !== 'abandoned')
          .map((session) => session.roomId)
          .filter(Boolean),
      );
      return state.scheduledGames.filter(
        (game) =>
          game.roundId === roundId && playable(game) && (!game.roomId || !connectedRoomIds.has(game.roomId)),
      );
    }
  }
}
