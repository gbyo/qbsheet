import {
  acceptResultSubmission,
  createResultSubmission,
  fingerprintResult,
  generateRoundRobinSchedule,
  makeTeamGameStat,
  reviseAcceptedResult,
} from '../src';
import type { ScheduledMatch, SubmittedResultPayload } from '../src';
import { makeTeams } from './helpers';

function resultPayload(game: ScheduledMatch, scoreA = 200, scoreB = 150): SubmittedResultPayload {
  return {
    scheduledGameId: game.id,
    phaseId: game.phaseId,
    roundId: game.roundId,
    roomId: game.roomId,
    packetId: game.packetId,
    outcome: 'played',
    teamScores: [
      makeTeamGameStat({ teamId: game.teamAId, score: scoreA, tossupsHeard: 20 }),
      makeTeamGameStat({ teamId: game.teamBId, score: scoreB, tossupsHeard: 20 }),
    ],
    playerStats: [],
    notes: '',
  };
}

function contextFor(game: ScheduledMatch, teams: ReturnType<typeof makeTeams>) {
  return {
    scheduledGames: [game],
    teams,
    packetIds: [],
  };
}

describe('result submissions and corrections', () => {
  it('fingerprints equivalent score lines in a stable order', () => {
    const teams = makeTeams(2);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'results' });
    const game = schedule.games[0];
    if (!game || game.kind === 'bye') throw new Error('expected a match');
    const payload = resultPayload(game);
    const reordered: SubmittedResultPayload = {
      ...payload,
      teamScores: [...payload.teamScores].reverse(),
    };

    expect(fingerprintResult(payload)).toBe(fingerprintResult(reordered));
  });

  it('accepts a clean submission and creates a pending revision without metadata leakage', () => {
    const teams = makeTeams(2);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'results' });
    const game = schedule.games[0];
    if (!game || game.kind === 'bye') throw new Error('expected a match');
    const payload = resultPayload(game);
    const submission = createResultSubmission(
      { id: 'submission-1', source: 'manual', payload },
      contextFor(game, teams),
    );
    const accepted = acceptResultSubmission(submission, 'director', {
      id: 'result-1',
      acceptedAt: '2026-09-01T12:00:00.000Z',
    });
    const correctedPayload: SubmittedResultPayload = {
      ...payload,
      teamScores: [
        makeTeamGameStat({ teamId: game.teamAId, score: 190, tossupsHeard: 20 }),
        makeTeamGameStat({ teamId: game.teamBId, score: 150, tossupsHeard: 20 }),
      ],
      notes: 'Corrected one score entry.',
    };
    const revision = reviseAcceptedResult(accepted.result, correctedPayload, {
      revisedBy: 'director',
      reason: 'Paper scoresheet confirmed the corrected score.',
      revisedAt: '2026-09-01T12:05:00.000Z',
    });

    expect(submission.status).toBe('clean');
    expect(revision.fingerprint).toBe(fingerprintResult(correctedPayload));
    expect(revision.reviewStatus).toBe('pending');
    expect(revision.revision).toBe(2);
    expect(revision.supersedesResultId).toBe('result-1');
    expect(revision.acceptedAt).toBeNull();
    expect(revision.acceptedBy).toBeNull();
    expect(revision.notes).toBe(correctedPayload.notes);
  });

  it('requires an explicit operator note when warnings need review', () => {
    const teams = makeTeams(2);
    const schedule = generateRoundRobinSchedule({ phaseId: 'phase-1', teams, seed: 'results' });
    const game = schedule.games[0];
    if (!game || game.kind === 'bye') throw new Error('expected a match');
    const payload: SubmittedResultPayload = { ...resultPayload(game), outcome: 'cancelled' };
    const submission = createResultSubmission({ source: 'manual', payload }, contextFor(game, teams));

    expect(submission.status).toBe('review');
    expect(() => acceptResultSubmission(submission, 'director')).toThrow(/acceptance note/);
    expect(
      acceptResultSubmission(submission, 'director', { overrideReason: 'Director verified cancellation.' })
        .result,
    ).toMatchObject({ reviewStatus: 'accepted', outcome: 'cancelled' });
  });
});
