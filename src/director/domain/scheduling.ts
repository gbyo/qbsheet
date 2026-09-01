import {
  type DirectorId,
  type DirectorState,
  type Round,
  type ScheduledGame,
  type Team,
  newDirectorId,
  isoNow,
} from './model';

export interface ScheduleOptions {
  roundName?: string;
  roundNumber?: number;
  phaseId?: DirectorId;
  roomIds?: DirectorId[];
  packetId?: DirectorId | null;
  avoidRematches?: boolean;
  avoidSameOrganization?: boolean;
  allowByes?: boolean;
  seed?: number;
}

export interface ScheduleConflict {
  code: 'not-enough-rooms' | 'same-organization' | 'rematch' | 'no-bye-allowed';
  message: string;
  teamIds?: DirectorId[];
}

export interface ScheduleGenerationResult {
  round: Round;
  games: ScheduledGame[];
  conflicts: ScheduleConflict[];
}

/** A small deterministic PRNG; repeatable schedules matter when a director regenerates a preview. */
function seededRandom(seed: number): () => number {
  let value = Math.abs(Math.trunc(seed)) || 1;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function activeTeams(state: DirectorState, seed?: number): Team[] {
  const teams = state.teams.filter((team) => team.status === 'confirmed');
  if (seed === undefined) return [...teams].sort((a, b) => (a.seed ?? 9999) - (b.seed ?? 9999));
  const random = seededRandom(seed);
  return [...teams]
    .map((team) => ({ team, sort: random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ team }) => team);
}

function hasPlayed(state: DirectorState, leftId: DirectorId, rightId: DirectorId): boolean {
  return state.scheduledGames.some(
    (game) =>
      game.status !== 'cancelled' &&
      ((game.leftTeamId === leftId && game.rightTeamId === rightId) ||
        (game.leftTeamId === rightId && game.rightTeamId === leftId)),
  );
}

function organizationId(state: DirectorState, teamId: DirectorId): DirectorId | null {
  return state.teams.find((team) => team.id === teamId)?.organizationId ?? null;
}

/**
 * Generate one round with the circle method, then make the constraints explicit in the result.
 *
 * The pairing algorithm never emits a self-match or a duplicate team. It will choose a legal
 * alternate pairing for organization/rematch restrictions when one exists; otherwise it returns a
 * visible conflict rather than silently violating the director's requested rule.
 */
export function generateRoundRobinRound(
  state: DirectorState,
  options: ScheduleOptions = {},
): ScheduleGenerationResult {
  const teams = activeTeams(state, options.seed);
  const conflicts: ScheduleConflict[] = [];
  const allowByes = options.allowByes ?? true;
  const slots: Array<Team | null> = [...teams];
  if (slots.length % 2 === 1) slots.push(null);

  if (slots.includes(null) && !allowByes) {
    conflicts.push({ code: 'no-bye-allowed', message: 'This field needs a bye, but byes are disabled.' });
  }

  const fixed = slots[0] ?? null;
  const rotating = slots.slice(1);
  const roundNumber = options.roundNumber ?? nextRoundNumber(state);
  const shift = rotating.length === 0 ? 0 : (roundNumber - 1) % rotating.length;
  const ordered = rotating.length
    ? [...rotating.slice(rotating.length - shift), ...rotating.slice(0, rotating.length - shift)]
    : [];
  const circle = [fixed, ...ordered];
  const candidatePairs: Array<[Team | null, Team | null]> = [];
  for (let index = 0; index < circle.length / 2; index += 1) {
    candidatePairs.push([circle[index], circle[circle.length - index - 1]]);
  }

  const used = new Set<DirectorId>();
  const games: ScheduledGame[] = [];
  for (const [first, second] of candidatePairs) {
    if (!first || !second) {
      const byeTeam = first ?? second;
      if (byeTeam) {
        games.push(buildGame(roundNumber, byeTeam.id, null, options));
        used.add(byeTeam.id);
      }
      continue;
    }

    const left = first;
    let right = second;
    const rematch = options.avoidRematches && hasPlayed(state, left.id, right.id);
    const sameOrganization =
      options.avoidSameOrganization &&
      organizationId(state, left.id) !== null &&
      organizationId(state, left.id) === organizationId(state, right.id);

    if (rematch || sameOrganization) {
      const replacement = findLegalReplacement(teams, used, state, left, right, options);
      if (replacement) {
        right = replacement;
      } else {
        conflicts.push({
          code: rematch ? 'rematch' : 'same-organization',
          message: rematch
            ? `${left.displayName} and ${right.displayName} have already played.`
            : `${left.displayName} and ${right.displayName} are from the same organization.`,
          teamIds: [left.id, right.id],
        });
      }
    }

    if (used.has(left.id) || used.has(right.id) || left.id === right.id) {
      conflicts.push({
        code: 'rematch',
        message: 'The generated round would use a team twice; no invalid game was emitted.',
        teamIds: [left.id, right.id],
      });
      continue;
    }
    games.push(buildGame(roundNumber, left.id, right.id, options));
    used.add(left.id);
    used.add(right.id);
  }

  const roomIds = options.roomIds ?? state.rooms.filter((room) => room.available).map((room) => room.id);
  if (games.filter((game) => !game.bye).length > roomIds.length) {
    conflicts.push({
      code: 'not-enough-rooms',
      message: `${games.filter((game) => !game.bye).length} games need rooms, but only ${roomIds.length} are available.`,
    });
  }
  games.forEach((game, index) => {
    game.roomId = game.bye ? null : (roomIds[index] ?? null);
  });

  const phaseId = options.phaseId ?? state.phases[0]?.id ?? newDirectorId('phase');
  const round: Round = {
    id: newDirectorId('round'),
    phaseId,
    name: options.roundName ?? `Round ${roundNumber}`,
    number: roundNumber,
    revision: 1,
    status: 'planned',
    packetId: options.packetId ?? null,
    scheduledGameIds: games.map((game) => game.id),
    startedAt: null,
    closedAt: null,
  };
  games.forEach((game) => {
    game.roundId = round.id;
  });
  return { round, games, conflicts };
}

function findLegalReplacement(
  teams: Team[],
  used: ReadonlySet<DirectorId>,
  state: DirectorState,
  left: Team,
  right: Team,
  options: ScheduleOptions,
): Team | null {
  for (const candidate of teams) {
    if (candidate.id === left.id || candidate.id === right.id || used.has(candidate.id)) continue;
    if (options.avoidRematches && hasPlayed(state, left.id, candidate.id)) continue;
    if (
      options.avoidSameOrganization &&
      organizationId(state, left.id) !== null &&
      organizationId(state, left.id) === organizationId(state, candidate.id)
    )
      continue;
    return candidate;
  }
  return null;
}

function buildGame(
  roundNumber: number,
  leftTeamId: DirectorId,
  rightTeamId: DirectorId | null,
  options: ScheduleOptions,
): ScheduledGame {
  return {
    id: newDirectorId('game'),
    roundId: '',
    roomId: null,
    packetId: options.packetId ?? null,
    leftTeamId,
    rightTeamId,
    bye: rightTeamId === null,
    status: 'scheduled',
    assignmentRevision: 1,
    notes: rightTeamId === null ? `Bye in round ${roundNumber}` : undefined,
  };
}

function nextRoundNumber(state: DirectorState): number {
  return state.rounds.reduce((maximum, round) => Math.max(maximum, round.number), 0) + 1;
}

export function scheduleGameCount(games: ScheduledGame[]): number {
  return games.filter((game) => !game.bye && game.status !== 'cancelled').length;
}

export function scheduleIsValid(games: ScheduledGame[]): boolean {
  const teams = new Set<DirectorId>();
  for (const game of games) {
    if (game.bye) continue;
    if (game.rightTeamId === null || game.leftTeamId === game.rightTeamId) return false;
    if (teams.has(game.leftTeamId) || teams.has(game.rightTeamId)) return false;
    teams.add(game.leftTeamId);
    teams.add(game.rightTeamId);
  }
  return true;
}

export function closeRound(round: Round, at = isoNow()): Round {
  return { ...round, status: 'closed', closedAt: at };
}
