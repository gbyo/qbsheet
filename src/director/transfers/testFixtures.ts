/**
 * A tournament to run the transfer tests against, and a way to score one of its games.
 *
 * Not a test file: it is the shared setup for several, and Vitest would otherwise report it as a
 * suite with no tests.
 *
 * The scored result is built by filling in an assignment rather than by writing a result document
 * from scratch, which is exactly what a scorer does — the profile's "a result is the assignment,
 * filled in". That matters for the duplicate and conflict tests: if the fixture built results some
 * other way, those tests would be checking a shape no real scorer produces.
 */
import { emptyDirectorState, type DirectorState } from '../domain/model';
import { buildAssignment } from './assignment';

export interface FixtureOptions {
  /** How many rooms and concurrent games the round has. */
  games?: number;
  roundRevision?: number;
  released?: boolean;
}

export const fixtureTournamentId = 'tournament-fixture';

/**
 * Four teams in two rooms by default, with rosters, a packet and one released round.
 *
 * Deliberately small and deliberately complete: every test below needs identity to flow from
 * tournament through round to match, and a fixture missing a roster or a room would make several of
 * the assertions vacuous.
 */
export function directorFixture(options: FixtureOptions = {}): DirectorState {
  const gameCount = options.games ?? 2;
  const state = emptyDirectorState();
  const now = '2026-09-01T12:00:00.000Z';
  state.tournament = {
    id: fixtureTournamentId,
    name: 'Saturday Invitational',
    date: '2026-09-05',
    venue: 'Greenwood High School',
    organizer: 'Greenwood Quiz Bowl',
    status: 'running',
    timeZone: 'America/New_York',
    rules: {
      tossupValue: 10,
      powerValue: 15,
      negValue: -5,
      bonusValue: 10,
      tossupCount: 20,
      bonusParts: 3,
      bouncebacks: false,
      overtime: true,
      lightning: false,
      maximumActivePlayers: 4,
      regulationMinutes: 26,
      tiebreakers: ['head-to-head', 'record', 'points', 'margin', 'powers', 'gets', 'playoff'],
    },
    formatId: 'format-1',
    currentPhaseId: 'phase-1',
    currentPacketId: 'packet-5',
    currentRoundId: 'round-5',
    createdAt: now,
    updatedAt: now,
  };
  state.formats = [
    {
      id: 'format-1',
      name: 'Round robin',
      kind: 'round-robin',
      phaseIds: ['phase-1'],
      roundsPerTeam: null,
      avoidRematches: true,
      avoidSameOrganization: false,
      allowByes: true,
      editable: true,
    },
  ];
  state.phases = [
    {
      id: 'phase-1',
      name: 'Preliminary phase',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-5', 'round-6'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
  ];

  const names = [
    'Ninety Six A',
    'Greenwood A',
    'Emerald A',
    'Clinton A',
    'Ninety Six B',
    'Greenwood B',
    'Emerald B',
    'Clinton B',
  ];
  const teamCount = gameCount * 2;
  for (let index = 0; index < teamCount; index += 1) {
    const id = `team-${index + 1}`;
    state.teams.push({
      id,
      organizationId: null,
      displayName: names[index] ?? `Team ${index + 1}`,
      teamLetter: 'A',
      seed: index + 1,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now,
    });
    for (let player = 1; player <= 4; player += 1)
      state.players.push({
        id: `${id}-player-${player}`,
        teamId: id,
        name: `${names[index] ?? id} player ${player}`,
        captain: player === 1,
        active: true,
      });
  }

  for (let index = 0; index < gameCount; index += 1)
    state.rooms.push({
      id: `room-${101 + index}`,
      name: `Room ${101 + index}`,
      building: 'Main',
      status: 'available',
      moderatorId: null,
      scorekeeperId: null,
      equipmentId: null,
      available: true,
    });

  state.packets = [
    {
      id: 'packet-5',
      name: 'Packet 5',
      source: 'manual',
      assignedRoundIds: ['round-5'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
    },
  ];

  const released = options.released ?? true;
  state.rounds.push({
    id: 'round-5',
    phaseId: 'phase-1',
    name: 'Round 5',
    number: 5,
    revision: options.roundRevision ?? 1,
    status: released ? 'released' : 'prepared',
    packetId: 'packet-5',
    scheduledGameIds: [],
    startedAt: released ? now : null,
    closedAt: null,
  });
  // A second round exists and is deliberately not released. Every "no future pairings" assertion
  // below leans on it: an assignment for round 5 that mentions round 6 has leaked the next bracket.
  state.rounds.push({
    id: 'round-6',
    phaseId: 'phase-1',
    name: 'Round 6',
    number: 6,
    revision: 1,
    status: 'planned',
    packetId: null,
    scheduledGameIds: [],
    startedAt: null,
    closedAt: null,
  });

  for (let index = 0; index < gameCount; index += 1) {
    const id = `game-5-${index + 1}`;
    state.scheduledGames.push({
      id,
      roundId: 'round-5',
      roomId: `room-${101 + index}`,
      packetId: 'packet-5',
      leftTeamId: `team-${index * 2 + 1}`,
      rightTeamId: `team-${index * 2 + 2}`,
      bye: false,
      status: released ? 'released' : 'scheduled',
      assignmentRevision: 1,
    });
    state.rounds[0].scheduledGameIds.push(id);
  }

  // Round 6's pairings exist in Director. They must never appear in a round 5 assignment.
  for (let index = 0; index < gameCount; index += 1) {
    const id = `game-6-${index + 1}`;
    state.scheduledGames.push({
      id,
      roundId: 'round-6',
      roomId: `room-${101 + index}`,
      packetId: null,
      leftTeamId: `team-${index * 2 + 1}`,
      rightTeamId: `team-${((index * 2 + 3) % (gameCount * 2)) + 1}`,
      bye: false,
      status: 'scheduled',
      assignmentRevision: 1,
    });
    state.rounds[1].scheduledGameIds.push(id);
  }

  state.qbtcpSessions = [];
  return state;
}

export interface ScoreOptions {
  leftPoints?: number;
  rightPoints?: number;
  tossupsRead?: number;
  /** Override the round revision the result claims, to simulate a file scored from an old bracket. */
  roundRevision?: number;
  assignmentRevision?: number;
  tournamentId?: string;
}

function answerCounts(powers: number, gets: number, negs: number) {
  return [
    { answer_type: { value: 15 }, number: powers },
    { answer_type: { value: 10 }, number: gets },
    { answer_type: { value: -5 }, number: negs },
  ];
}

/**
 * Fill an assignment in, the way a scorer does.
 *
 * The identity of the assignment is preserved exactly — same `Tournament.id`, `Round.id`,
 * `Match.id`, same team and player ids — because that preservation is what makes reconciliation on
 * the Director side a lookup rather than a guess.
 */
export function scoreAssignment(assignment: Record<string, unknown>, options: ScoreOptions = {}) {
  const document = structuredClone(assignment) as {
    version: string;
    objects: Array<Record<string, unknown>>;
  };
  const leftPoints = options.leftPoints ?? 325;
  const rightPoints = options.rightPoints ?? 210;
  const match = document.objects.find((object) => object.type === 'Match');
  if (!match) throw new Error('fixture: the assignment has no match');
  match.tossups_read = options.tossupsRead ?? 20;
  const teams = match.match_teams as Array<Record<string, unknown>>;
  const shape = (entry: Record<string, unknown>, points: number, powers: number, gets: number) => {
    const teamRef = (entry.team as { $ref: string }).$ref;
    entry.points = points;
    entry.bonuses_heard = gets + powers;
    entry.bonus_points = points - (powers * 15 + gets * 10 - 5 * 2);
    entry.match_players = [
      {
        player: { $ref: `${teamRef}-player-1` },
        tossups_heard: 20,
        answer_counts: answerCounts(powers, gets, 1),
      },
      {
        player: { $ref: `${teamRef}-player-2` },
        tossups_heard: 20,
        answer_counts: answerCounts(0, 0, 1),
      },
    ];
  };
  shape(teams[0], leftPoints, 4, 8);
  shape(teams[1], rightPoints, 1, 6);

  const extension = match._qbtcp as Record<string, unknown> | undefined;
  if (extension) {
    if (options.roundRevision !== undefined) extension.round_revision = options.roundRevision;
    if (options.assignmentRevision !== undefined) extension.assignment_revision = options.assignmentRevision;
  }
  if (options.tournamentId !== undefined) {
    const tournament = document.objects.find((object) => object.type === 'Tournament');
    if (tournament) tournament.id = options.tournamentId;
  }
  return document;
}

/** Build the assignment for a scheduled game, failing loudly if the fixture cannot produce one. */
export function assignmentFor(state: DirectorState, scheduledGameId: string) {
  const built = buildAssignment(state, scheduledGameId);
  if (!built.ok) throw new Error(`fixture: ${built.failure.reason}`);
  return built.assignment;
}
