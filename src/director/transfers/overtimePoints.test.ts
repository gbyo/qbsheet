/**
 * Per-team overtime points splits (#746 follow-up, epic #755).
 *
 * Overtime tossup points are valued from the result's own overtime-buzz breakdown — each entry
 * carries its answer value, so the figure is exact in both directions and never estimated from
 * counts times live rules. An absent breakdown is unknown (MODAQ exports and manual results lose
 * it; the scorer omits it when nobody converted in overtime); only rules without overtime make
 * it a known zero. Regulation points are the residual, and points-per-regulation-tossup is gated
 * on both halves being known.
 */
import { describe, expect, test } from 'vitest';
import {
  deriveTeamStandings,
  invalidTeamGameScoreOvertimePoints,
  regulationDerivationForTeam,
} from '../domain/model';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from './ingest';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';
import { digestText } from './canonical';

function documentFor(qbj: unknown): IncomingDocument {
  const text = JSON.stringify(qbj);
  return {
    sourceKind: 'removable-drive',
    sourceLabel: 'SanDisk Ultra',
    fileName: 'result.qbj',
    byteLength: text.length,
    digest: digestText(text),
    qbj,
  };
}

function matchTeamsOf(document: unknown): Array<Record<string, unknown>> {
  const objects = (document as { objects: Array<Record<string, unknown>> }).objects;
  const match = objects.find((object) => object.type === 'Match');
  if (!match) throw new Error('overtime: the assignment has no match');
  return match.match_teams as Array<Record<string, unknown>>;
}

function overtimeGame(
  leftOvertime: number | null,
  rightOvertime: number | null,
  extra: Record<string, unknown> = {},
) {
  const state = directorFixture();
  state.games.push({
    id: 'game-ot-1',
    scheduledGameId: 'game-5-1',
    roundId: 'round-5',
    packetId: 'packet-5',
    status: 'accepted',
    scores: [
      {
        teamId: 'team-1',
        score: 260,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
        ...(leftOvertime === null ? {} : { overtimePoints: leftOvertime }),
      },
      {
        teamId: 'team-2',
        score: 180,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
        ...(rightOvertime === null ? {} : { overtimePoints: rightOvertime }),
      },
    ],
    playerStats: [],
    source: 'manual',
    tossupsRead: 22,
    overtimeTossupsRead: 2,
    ...extra,
  });
  return state;
}

describe('overtime points ingest', () => {
  test('overtime-buzz entries value exactly and persist onto the record', () => {
    const state = directorFixture();
    const document = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const teams = matchTeamsOf(document);
    teams[0]!.YfData = {
      overTimeBuzzes: [
        { number: 2, answer_type: { id: 'power', value: 15 } },
        { number: 1, answer_type: { id: 'tossup', value: 10 } },
      ],
    };
    const assessment = assessIncomingDocument(state, documentFor(document));
    expect(assessment.warnings).toHaveLength(0);
    const outcome = stageIncomingDocument(state, documentFor(document), assessment);
    const game = state.games.find((entry) => entry.id === outcome.gameId);
    expect(game?.scores[0]?.overtimePoints).toBe(40);
    expect(game?.scores[1]?.overtimePoints).toBeNull();
  });

  test('a malformed breakdown warns and reads as unknown, never partial', () => {
    const state = directorFixture();
    const document = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    matchTeamsOf(document)[0]!.YfData = {
      overTimeBuzzes: [{ number: 2, answer_type: { id: 'power', value: 'fifteen' } }],
    };
    const assessment = assessIncomingDocument(state, documentFor(document));
    expect(assessment.warnings.length).toBeGreaterThan(0);
    const outcome = stageIncomingDocument(state, documentFor(document), assessment);
    const game = state.games.find((entry) => entry.id === outcome.gameId);
    expect(game?.scores[0]?.overtimePoints).toBeNull();
  });

  test('overtime points validate as finite when supplied, unknown otherwise', () => {
    const base = {
      teamId: 'team-1',
      score: 0,
      superpowers: 0,
      powers: 0,
      gets: 0,
      negs: 0,
      bonuses: 0,
      bonusPoints: 0,
      bouncebacks: 0,
    };
    expect(invalidTeamGameScoreOvertimePoints({ ...base })).toBeNull();
    expect(invalidTeamGameScoreOvertimePoints({ ...base, overtimePoints: null })).toBeNull();
    expect(invalidTeamGameScoreOvertimePoints({ ...base, overtimePoints: 40 })).toBeNull();
    expect(invalidTeamGameScoreOvertimePoints({ ...base, overtimePoints: Number.NaN })).toBe(
      'overtimePoints',
    );
  });
});

describe('overtime points derivation', () => {
  test('explicit splits aggregate and feed points-per-regulation-tossup', () => {
    const standings = deriveTeamStandings(overtimeGame(40, 10));
    const left = standings.find((entry) => entry.teamId === 'team-1')!;
    expect(left.overtimePoints).toBe(40);
    expect(left.overtimePointsKnown).toBe(true);

    const derivation = regulationDerivationForTeam(left);
    expect(derivation.overtimePoints).toBe(40);
    expect(derivation.regulationPoints).toBe(220);
    expect(derivation.pointsPerRegulationTossup).toBeCloseTo(220 / 20, 10);
  });

  test('one unknown breakdown unknowns the whole split', () => {
    const state = overtimeGame(40, 10);
    // A second game where team-1's source supplied no overtime-buzz breakdown.
    state.games.push({
      id: 'game-ot-2',
      scheduledGameId: 'game-5-2',
      roundId: 'round-5',
      packetId: 'packet-5',
      status: 'accepted',
      scores: [
        {
          teamId: 'team-1',
          score: 200,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
        {
          teamId: 'team-2',
          score: 100,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
          overtimePoints: 0,
        },
      ],
      playerStats: [],
      source: 'manual',
      tossupsRead: 20,
      // Overtime scope genuinely unknown: without an overtime-tossups count, the
      // missing breakdown cannot be proven zero and unknowns the whole split.
    });
    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === 'team-1')!;
    expect(left.overtimePointsKnown).toBe(false);

    const derivation = regulationDerivationForTeam(left);
    expect(derivation.overtimePoints).toBeNull();
    expect(derivation.regulationPoints).toBeNull();
    expect(derivation.pointsPerRegulationTossup).toBeNull();

    // The other side's books stay clean: its breakdowns were all explicit.
    const right = standings.find((entry) => entry.teamId === 'team-2')!;
    expect(right.overtimePointsKnown).toBe(true);
    expect(right.overtimePoints).toBe(10);
  });

  test('zero overtime tossups make an absent breakdown a known zero (#755)', () => {
    const state = overtimeGame(40, 10);
    state.games.push({
      id: 'game-ot-2',
      scheduledGameId: 'game-5-2',
      roundId: 'round-5',
      packetId: 'packet-5',
      status: 'accepted',
      scores: [
        {
          teamId: 'team-1',
          score: 200,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
        {
          teamId: 'team-2',
          score: 100,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
          overtimePoints: 0,
        },
      ],
      playerStats: [],
      source: 'manual',
      tossupsRead: 20,
      overtimeTossupsRead: 0,
    });
    const standings = deriveTeamStandings(state);
    // No overtime tossups means no overtime scoring events: team-1's missing
    // breakdown is a known zero, so regulation is the full 200.
    const left = standings.find((entry) => entry.teamId === 'team-1')!;
    expect(left.overtimePointsKnown).toBe(true);
    expect(left.overtimePoints).toBe(40);
    // Game 1 regulation is 260 − 40; game 2 regulation is the full 200.
    expect(regulationDerivationForTeam(left).regulationPoints).toBe(420);
  });

  test('rules without overtime make an absent breakdown a known zero', () => {
    const state = overtimeGame(null, null);
    state.tournament!.rules.overtime = false;
    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === 'team-1')!;

    expect(left.overtimePoints).toBe(0);
    expect(left.overtimePointsKnown).toBe(true);
    expect(regulationDerivationForTeam(left).regulationPoints).toBe(260);
  });

  test('a split that contradicts the total fails closed, never negative', () => {
    const standings = deriveTeamStandings(overtimeGame(400, 0));
    const left = standings.find((entry) => entry.teamId === 'team-1')!;

    expect(left.overtimePoints).toBe(400);
    const derivation = regulationDerivationForTeam(left);
    expect(derivation.regulationPoints).toBeNull();
    expect(derivation.pointsPerRegulationTossup).toBeNull();
  });

  test('a forfeit counts in W/L and contributes a known zero', () => {
    const state = directorFixture();
    state.games.push({
      id: 'game-forfeit-ot',
      scheduledGameId: 'game-5-1',
      roundId: 'round-5',
      packetId: 'packet-5',
      status: 'forfeit',
      forfeitedTeamId: 'team-2',
      scores: [
        {
          teamId: 'team-1',
          score: 0,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
        {
          teamId: 'team-2',
          score: 0,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
      ],
      playerStats: [],
      source: 'manual',
    });
    const standings = deriveTeamStandings(state);
    const winner = standings.find((entry) => entry.teamId === 'team-1')!;
    expect(winner.wins).toBe(1);
    expect(winner.overtimePoints).toBe(0);
    expect(winner.overtimePointsKnown).toBe(true);
  });
});
