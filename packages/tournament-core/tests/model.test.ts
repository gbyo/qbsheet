import {
  acceptGameResult,
  acceptResultSubmission,
  addOrganization,
  addPacket,
  addPhase,
  addPlayer,
  addPool,
  addRegistration,
  addResource,
  addRoom,
  addRoomAssignment,
  addRound,
  addStaffMember,
  addTeam,
  attachSchedule,
  createResultSubmission,
  createTournament,
  generateRoundRobinSchedule,
  recordResultSubmission,
  resolveProtest,
  setTeamStatus,
  recordProtest,
  updatePlayer,
  updateTournamentMetadata,
  updateTournamentRules,
} from '../src';
import type { TournamentSnapshot } from '../src';
import { fixedClock, rules } from './helpers';

function buildTournament(): TournamentSnapshot {
  let snapshot = createTournament({ id: 'tournament-1', name: 'Test Invitational', rules }, fixedClock);
  snapshot = addOrganization(
    snapshot,
    { id: 'org-1', name: 'Northview' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addTeam(
    snapshot,
    { id: 'team-a', name: 'Northview A', organizationId: 'org-1', seed: 1 },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addTeam(
    snapshot,
    { id: 'team-b', name: 'Northview B', organizationId: 'org-1', seed: 2 },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addRegistration(
    snapshot,
    { id: 'registration-a', teamId: 'team-a' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addRegistration(
    snapshot,
    { id: 'registration-b', teamId: 'team-b' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addPlayer(
    snapshot,
    { id: 'player-a', name: 'Alex', teamId: 'team-a', captain: true },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addPlayer(
    snapshot,
    { id: 'player-b', name: 'Blair', teamId: 'team-b' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addRoom(
    snapshot,
    { id: 'room-1', name: '101', accessible: true },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addStaffMember(
    snapshot,
    { id: 'staff-1', name: 'Morgan', roles: ['moderator'] },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addResource(
    snapshot,
    { id: 'buzzer-1', type: 'buzzer', name: 'Buzzer 1' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addPhase(
    snapshot,
    { id: 'phase-1', name: 'Preliminaries', order: 0, format: 'round-robin' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addPool(
    snapshot,
    { id: 'pool-1', phaseId: 'phase-1', name: 'Main', order: 0, teamIds: ['team-a', 'team-b'] },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addRound(
    snapshot,
    { id: 'round-1', phaseId: 'phase-1', poolId: 'pool-1', number: 1 },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addPacket(
    snapshot,
    { id: 'packet-1', name: 'Packet 1', nominalRoundId: 'round-1' },
    { actor: 'director', clock: fixedClock },
  );
  snapshot = addRoomAssignment(
    snapshot,
    {
      id: 'assignment-1',
      roomId: 'room-1',
      roundId: 'round-1',
      moderatorId: 'staff-1',
      resourceIds: ['buzzer-1'],
    },
    { actor: 'director', clock: fixedClock },
  );
  return snapshot;
}

describe('tournament snapshot domain', () => {
  it('creates a real empty tournament and records immutable operational changes', () => {
    const initial = createTournament({ id: 'tournament-1', name: 'Test Invitational' }, fixedClock);
    const next = addTeam(initial, { id: 'team-1', name: 'Alpha' }, { actor: 'director', clock: fixedClock });

    expect(initial.teams).toHaveLength(0);
    expect(next.teams).toHaveLength(1);
    expect(next.teams[0].displayName).toBe('Alpha');
    expect(next.auditEvents.at(-1)?.type).toBe('team-added');
    expect(next.application.lastSavedAt).toBe(fixedClock.now());
  });

  it('updates metadata, rules, and roster links without mutating the prior snapshot', () => {
    const initial = buildTournament();
    const withMetadata = updateTournamentMetadata(
      initial,
      { name: 'Updated Invitational', location: 'Main Hall' },
      { actor: 'director', clock: fixedClock },
    );
    const withRules = updateTournamentRules(
      withMetadata,
      { ...rules, tossupsPerGame: 24 },
      { actor: 'director', clock: fixedClock },
    );
    const moved = updatePlayer(
      withRules,
      'player-a',
      { teamId: 'team-b' },
      { actor: 'director', clock: fixedClock },
    );

    expect(initial.metadata.name).toBe('Test Invitational');
    expect(moved.metadata.name).toBe('Updated Invitational');
    expect(moved.rules.tossupsPerGame).toBe(24);
    expect(moved.teams.find((team) => team.id === 'team-a')?.playerIds).toEqual([]);
    expect(moved.teams.find((team) => team.id === 'team-b')?.playerIds).toEqual(['player-b', 'player-a']);
    expect(moved.auditEvents.at(-1)?.type).toBe('roster-changed');
  });

  it('maintains organization, roster, resource, packet, round, and room assignment references', () => {
    const snapshot = buildTournament();

    expect(snapshot.organizations.map((organization) => organization.name)).toEqual(['Northview']);
    expect(snapshot.teams[0].playerIds).toEqual(['player-a']);
    expect(snapshot.players[0].captain).toBe(true);
    expect(snapshot.registrations).toHaveLength(2);
    expect(snapshot.roomAssignments[0].resourceIds).toEqual(['buzzer-1']);
    expect(snapshot.packets[0].nominalRoundId).toBe('round-1');
    expect(snapshot.phases[0].poolIds).toEqual(['pool-1']);
    expect(snapshot.phases[0].roundIds).toEqual(['round-1']);
  });

  it('attaches a generated schedule, stores submissions, accepts results, and updates game state', () => {
    const snapshot = buildTournament();
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      poolId: 'pool-1',
      teams: snapshot.teams,
      rooms: snapshot.rooms,
      packetIds: ['packet-1'],
      rounds: [{ id: 'round-1', number: 1, poolId: 'pool-1' }],
      seed: 'model-test',
      requireRoomAssignments: true,
    });
    expect(schedule.games).toHaveLength(1);
    const match = schedule.games[0];
    if (match.kind === 'bye') throw new Error('expected a match');
    let withSchedule = attachSchedule(snapshot, schedule.games, { actor: 'director', clock: fixedClock });
    const payload = {
      scheduledGameId: match.id,
      phaseId: match.phaseId,
      roundId: match.roundId,
      roomId: match.roomId,
      packetId: match.packetId,
      outcome: 'played' as const,
      teamScores: [
        {
          teamId: match.teamAId,
          score: 210,
          tossupsHeard: 20,
          powers: 2,
          gets: 10,
          negs: 1,
          bonusesHeard: 8,
          bonusPoints: 80,
          bouncebacks: 0,
          lightningPoints: 0,
          overtimePoints: 0,
        },
        {
          teamId: match.teamBId,
          score: 150,
          tossupsHeard: 20,
          powers: 1,
          gets: 7,
          negs: 1,
          bonusesHeard: 8,
          bonusPoints: 60,
          bouncebacks: 0,
          lightningPoints: 0,
          overtimePoints: 0,
        },
      ],
      playerStats: [],
      notes: '',
    };
    const submission = createResultSubmission(
      { id: 'submission-1', source: 'manual', payload },
      {
        scheduledGames: withSchedule.scheduledGames,
        teams: withSchedule.teams,
        players: withSchedule.players,
        packetIds: withSchedule.packets.map((packet) => packet.id),
      },
    );
    expect(submission.status).toBe('clean');
    withSchedule = recordResultSubmission(withSchedule, submission, { actor: 'director', clock: fixedClock });
    const accepted = acceptResultSubmission(submission, 'director', {
      id: 'result-1',
      acceptedAt: fixedClock.now(),
    });
    withSchedule = acceptGameResult(withSchedule, accepted.result, { actor: 'director', clock: fixedClock });

    expect(withSchedule.resultSubmissions[0].status).toBe('accepted');
    expect(withSchedule.results[0].reviewStatus).toBe('accepted');
    expect(withSchedule.scheduledGames[0].status).toBe('completed');
  });

  it('keeps protest resolution and team drop decisions in the audit history', () => {
    let snapshot = buildTournament();
    const schedule = generateRoundRobinSchedule({
      phaseId: 'phase-1',
      poolId: 'pool-1',
      teams: snapshot.teams,
      rounds: [{ id: 'round-1' }],
    });
    snapshot = attachSchedule(snapshot, schedule.games, { actor: 'director', clock: fixedClock });
    const match = snapshot.scheduledGames.find((game) => game.kind !== 'bye');
    if (!match) throw new Error('expected a match');
    snapshot = recordProtest(
      snapshot,
      {
        scheduledGameId: match.id,
        resultId: null,
        category: 'procedure',
        questionNumber: 4,
        description: 'Check the room procedure.',
        ruling: null,
        notes: '',
        scoreImpacts: [],
        createdBy: 'director',
      },
      { actor: 'director', clock: fixedClock },
    );
    const protest = snapshot.protests[0];
    snapshot = resolveProtest(
      snapshot,
      protest.id,
      { status: 'denied', ruling: 'Procedure was followed.', resolvedBy: 'director' },
      { actor: 'director', clock: fixedClock },
    );
    snapshot = setTeamStatus(snapshot, 'team-b', 'dropped', { actor: 'director', clock: fixedClock });

    expect(snapshot.protests[0].status).toBe('denied');
    expect(snapshot.teams.find((team) => team.id === 'team-b')?.status).toBe('dropped');
    expect(snapshot.auditEvents.filter((event) => event.type === 'protest-ruled')).toHaveLength(1);
    expect(snapshot.auditEvents.filter((event) => event.type === 'team-status-changed')).toHaveLength(1);
  });

  it('rejects duplicate names and invalid roster references at the domain boundary', () => {
    const snapshot = createTournament({ id: 'tournament-1', name: 'Test' }, fixedClock);
    const withTeam = addTeam(snapshot, { id: 'team-1', name: 'Alpha' }, { clock: fixedClock });
    expect(() => addTeam(withTeam, { id: 'team-2', name: ' alpha ' }, { clock: fixedClock })).toThrow(
      /already exists/,
    );
    expect(() =>
      addPlayer(withTeam, { id: 'player-1', name: 'Alex', teamId: 'missing' }, { clock: fixedClock }),
    ).toThrow(/does not exist/);
  });
});
