import { describe, expect, test } from 'vitest';
import {
  defaultRules,
  emptyDirectorState,
  acceptedGameRecords,
  resultDecisionIssue,
  type DirectorState,
  type GameRecord,
  type ScheduledGame,
  type TeamGameScore,
} from '../src/index.js';

const at = '2026-09-05T12:00:00.000Z';

function score(teamId: string, value: number): TeamGameScore {
  return {
    teamId,
    score: value,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
  };
}

function stateForResult(
  options: {
    overtime?: boolean;
    phaseKind?: DirectorState['phases'][number]['kind'];
    formatKind?: DirectorState['formats'][number]['kind'];
    bracketKey?: string;
  } = {},
): { state: DirectorState; scheduled: ScheduledGame } {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-1',
    name: 'Test tournament',
    date: '2026-09-05',
    timeZone: 'America/New_York',
    venue: '',
    organizer: '',
    status: 'running',
    rules: { ...defaultRules, overtime: options.overtime ?? true },
    formatId: 'format-1',
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: 'round-1',
    createdAt: at,
    updatedAt: at,
  };
  state.formats.push({
    id: 'format-1',
    name: 'Test format',
    kind: options.formatKind ?? 'round-robin',
    phaseIds: ['phase-1'],
    roundsPerTeam: null,
    avoidRematches: true,
    avoidSameOrganization: false,
    allowByes: true,
    editable: true,
  });
  state.phases.push({
    id: 'phase-1',
    name: 'Test phase',
    kind: options.phaseKind ?? 'preliminary',
    order: 1,
    formatId: 'format-1',
    poolIds: [],
    roundIds: ['round-1'],
    advancementRule: null,
    carryover: false,
    status: 'active',
  });
  state.rounds.push({
    id: 'round-1',
    phaseId: 'phase-1',
    name: 'Round 1',
    number: 1,
    revision: 1,
    status: 'released',
    packetId: null,
    scheduledGameIds: ['game-1'],
    scheduledStart: null,
    releasedAt: at,
    startedAt: at,
    closedAt: null,
  });
  const scheduled: ScheduledGame = {
    id: 'game-1',
    roundId: 'round-1',
    roomId: null,
    packetId: null,
    leftTeamId: 'team-a',
    rightTeamId: 'team-b',
    bye: false,
    status: 'released',
    assignmentRevision: 1,
    ...(options.bracketKey ? { bracketKey: options.bracketKey } : {}),
  };
  state.scheduledGames.push(scheduled);
  return { state, scheduled };
}

function acceptedTie(): GameRecord {
  return {
    id: 'result-1',
    scheduledGameId: 'game-1',
    roundId: 'round-1',
    packetId: null,
    status: 'accepted',
    scores: [score('team-a', 200), score('team-b', 200)],
    playerStats: [],
    source: 'manual',
  };
}

describe('resultDecisionIssue', () => {
  test('rejects a tied final when overtime is required with actionable guidance', () => {
    const { state, scheduled } = stateForResult();

    const issue = resultDecisionIssue(state, scheduled, [score('team-a', 200), score('team-b', 200)]);

    expect(issue).toMatchObject({ code: 'winner-required-tie' });
    expect(issue?.message).toMatch(/winner|overtime|forfeit/i);
  });

  test('allows a tie when the format explicitly permits ties', () => {
    const { state, scheduled } = stateForResult({ overtime: false });

    expect(resultDecisionIssue(state, scheduled, [score('team-a', 200), score('team-b', 200)])).toBeNull();
  });

  test('requires a winner for elimination and final phases even without overtime', () => {
    const elimination = stateForResult({ overtime: false, formatKind: 'single-elimination' });
    const final = stateForResult({ overtime: false, phaseKind: 'final' });

    expect(
      resultDecisionIssue(elimination.state, elimination.scheduled, [score('team-a', 1), score('team-b', 1)]),
    ).not.toBeNull();
    expect(
      resultDecisionIssue(final.state, final.scheduled, [score('team-a', 1), score('team-b', 1)]),
    ).not.toBeNull();
  });

  test('allows an explicit administrative forfeit with a tied stored score', () => {
    const { state, scheduled } = stateForResult();

    expect(
      resultDecisionIssue(state, scheduled, [score('team-a', 0), score('team-b', 0)], {
        forfeitedTeamId: 'team-a',
      }),
    ).toBeNull();
  });

  test('keeps an invalid legacy tie out of canonical standings while retaining legal ties', () => {
    const { state } = stateForResult();
    state.games = [acceptedTie()];

    expect(acceptedGameRecords(state)).toEqual([]);

    state.tournament!.rules.overtime = false;
    expect(acceptedGameRecords(state)).toEqual(state.games);
  });
});
