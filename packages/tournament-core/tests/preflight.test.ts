import {
  addRoom,
  addPhase,
  addRound,
  addTeam,
  attachSchedule,
  createTournament,
  generateRoundRobinSchedule,
  recordProtest,
  runPreflight,
} from '../src';
import type { TournamentSnapshot } from '../src';
import { fixedClock, makeTeams } from './helpers';

function snapshotWithTeamsAndRoom(): TournamentSnapshot {
  let snapshot = createTournament({ id: 'tournament-1', name: 'Preflight Test' }, fixedClock);
  for (const team of makeTeams(2))
    snapshot = addTeam(snapshot, { id: team.id, name: team.name, seed: team.seed }, { clock: fixedClock });
  snapshot = addRoom(snapshot, { id: 'room-1', name: '101' }, { clock: fixedClock });
  return snapshot;
}

describe('tournament preflight', () => {
  it('classifies a schedule with valid storage and listener state as startable', () => {
    const snapshot = snapshotWithTeamsAndRoom();
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: snapshot.teams,
      roomIds: ['room-1'],
      seed: 'preflight',
    });
    const report = runPreflight({
      tournament: snapshot,
      schedule: schedule.games,
      qbtcp: { listenerReady: true, port: 8787 },
      storage: { writable: true, backupDirectoryConfigured: true, lastCheckpointAt: fixedClock.now() },
    });

    expect(report.canStart).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.recommendations.some((check) => check.code === 'staff-not-configured')).toBe(true);
  });

  it('keeps optional QBTCP and staff information from blocking a valid local schedule', () => {
    const snapshot = snapshotWithTeamsAndRoom();
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: snapshot.teams,
      roomIds: ['room-1'],
      seed: 'optional',
    });
    const report = runPreflight({ tournament: snapshot, schedule: schedule.games });

    expect(report.canStart).toBe(true);
    expect(
      report.checks.some((check) => check.code === 'qbtcp-not-probed' && check.severity === 'recommendation'),
    ).toBe(true);
    expect(
      report.checks.some(
        (check) => check.code === 'storage-not-probed' && check.severity === 'recommendation',
      ),
    ).toBe(true);
  });

  it('blocks invalid storage, listener, and room assignments', () => {
    const snapshot = snapshotWithTeamsAndRoom();
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: snapshot.teams,
      roomIds: ['missing-room'],
      seed: 'invalid',
    });
    const report = runPreflight({
      tournament: snapshot,
      schedule: schedule.games,
      qbtcp: { listenerReady: false, port: 8787 },
      storage: { writable: false, backupDirectoryConfigured: false },
      requireQbtcp: true,
    });

    expect(report.canStart).toBe(false);
    expect(report.blockers.map((check) => check.code)).toEqual(
      expect.arrayContaining(['schedule-unknown-room', 'qbtcp-not-ready', 'storage-not-writable']),
    );
  });

  it('prevents finalization while an unresolved protest remains', () => {
    let base = snapshotWithTeamsAndRoom();
    base = addPhase(
      base,
      { id: 'phase-1', name: 'Preliminaries', order: 0, format: 'round-robin' },
      { clock: fixedClock },
    );
    base = addRound(base, { id: 'round-1', phaseId: 'phase-1', number: 1 }, { clock: fixedClock });
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      teams: base.teams,
      roomIds: ['room-1'],
      rounds: [{ id: 'round-1', number: 1 }],
      seed: 'protest',
    });
    let snapshot = attachSchedule(base, schedule.games, { actor: 'director', clock: fixedClock });
    const match = snapshot.scheduledGames.find((game) => game.kind !== 'bye');
    if (!match) throw new Error('expected a match');
    snapshot = recordProtest(
      snapshot,
      {
        scheduledGameId: match.id,
        resultId: null,
        category: 'scoring',
        questionNumber: 1,
        description: 'Review the ruling.',
        ruling: null,
        notes: '',
        scoreImpacts: [],
        createdBy: 'director',
      },
      { actor: 'director', clock: fixedClock },
    );
    const report = runPreflight({
      tournament: snapshot,
      schedule: snapshot.scheduledGames,
      purpose: 'finalize',
    });

    expect(report.canFinalize).toBe(false);
    expect(report.blockers.some((check) => check.code === 'open-protests')).toBe(true);
  });
});
