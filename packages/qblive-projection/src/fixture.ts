/**
 * A Director document with a secret in every private corner.
 *
 * Every field that must never be published carries `SENTINEL`. The privacy test then asserts that
 * string does not occur in the serialized snapshot under any combination of settings, which turns
 * "we remembered not to publish that" into a property the build checks.
 *
 * When a new private field is added to the domain, add it here. A field that is not seeded is a
 * field the privacy test cannot protect, so `tests/privacy.test.ts` also walks the document and
 * fails if it finds a string-valued private field this fixture left un-seeded.
 */

import {
  defaultRules,
  emptyDirectorState,
  emptyLivePublication,
  type DirectorState,
} from '@qbsheet/tournament-domain';

export const SENTINEL = 'QBSHEET-PRIVATE-DO-NOT-PUBLISH-8f3a1c';

export const fixtureTeamIds = ['team-a', 'team-b', 'team-c', 'team-d'];

/**
 * A running tournament: four teams, two rooms, two rounds (one closed, one released), one
 * unreleased playoff round, a live game, an accepted result, and a full set of private state.
 */
export function privacyFixture(): DirectorState {
  const state = emptyDirectorState();
  const at = '2026-09-05T14:00:00.000Z';

  state.tournament = {
    id: 'tournament-1',
    name: 'Saturday Invitational',
    date: '2026-09-05',
    venue: 'Greenwood High School',
    organizer: 'Greenwood Quiz Bowl',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: 'format-1',
    currentPhaseId: 'phase-prelim',
    currentPacketId: 'packet-1',
    currentRoundId: 'round-2',
    createdAt: at,
    updatedAt: at,
  };

  state.organizations = [
    { id: 'org-1', name: 'Ninety Six High School', shortName: 'Ninety Six', notes: SENTINEL },
    { id: 'org-2', name: 'Greenwood High School', shortName: 'Greenwood', notes: SENTINEL },
  ];

  state.teams = fixtureTeamIds.map((id, index) => ({
    id,
    organizationId: index < 2 ? 'org-1' : 'org-2',
    displayName: `${index < 2 ? 'Ninety Six' : 'Greenwood'} ${index % 2 === 0 ? 'A' : 'B'}`,
    teamLetter: index % 2 === 0 ? 'A' : 'B',
    seed: index + 1,
    status: 'confirmed',
    notes: SENTINEL,
    createdAt: at,
    updatedAt: at,
  }));

  state.players = fixtureTeamIds.flatMap((teamId, teamIndex) =>
    [0, 1, 2, 3].map((slot) => ({
      id: `player-${teamIndex}-${slot}`,
      teamId,
      name: `Player ${teamIndex}-${slot}`,
      captain: slot === 0,
      active: true,
      rosterNumber: slot + 1,
      notes: SENTINEL,
    })),
  );

  state.staff = [
    { id: 'staff-1', name: 'Alex Moderator', roles: ['moderator'], available: true, notes: SENTINEL },
    { id: 'staff-2', name: 'Sam Scorekeeper', roles: ['scorekeeper'], available: true, notes: SENTINEL },
  ];

  state.equipment = [
    { id: 'equip-1', name: 'Buzzer set 3', kind: 'buzzer', available: true, notes: SENTINEL },
  ];

  state.rooms = [
    {
      id: 'room-1',
      name: 'Room 104',
      building: 'Main',
      floor: '1',
      accessibility: 'Elevator access',
      directions: 'Left past the trophy case.',
      notes: SENTINEL,
      status: 'live',
      moderatorId: 'staff-1',
      scorekeeperId: 'staff-2',
      equipmentId: 'equip-1',
      available: true,
    },
    {
      id: 'room-2',
      name: 'Room 212',
      building: 'Main',
      floor: '2',
      directions: 'Up the north stairs.',
      notes: SENTINEL,
      status: 'available',
      moderatorId: null,
      scorekeeperId: null,
      equipmentId: null,
      available: true,
    },
  ];

  state.packets = [
    {
      id: 'packet-1',
      name: 'Round 1 packet',
      source: 'manual',
      assignedRoundIds: ['round-1'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
      // Packet security information must never leave Director.
      notes: SENTINEL,
    },
    {
      id: 'packet-9',
      name: 'Unreleased finals packet',
      source: 'manual',
      assignedRoundIds: ['round-playoff'],
      assignedGameIds: [],
      usedGameIds: [],
      replacementForPacketId: null,
      tiebreaker: false,
      notes: SENTINEL,
    },
  ];

  state.formats = [
    {
      id: 'format-1',
      name: 'Round robin',
      kind: 'round-robin',
      phaseIds: ['phase-prelim', 'phase-playoff'],
      roundsPerTeam: null,
      avoidRematches: true,
      avoidSameOrganization: false,
      allowByes: true,
      editable: true,
    },
  ];

  state.phases = [
    {
      id: 'phase-prelim',
      name: 'Preliminary',
      kind: 'preliminary',
      order: 1,
      formatId: 'format-1',
      poolIds: ['pool-1'],
      roundIds: ['round-1', 'round-2'],
      advancementRule: null,
      carryover: false,
      status: 'active',
    },
    {
      id: 'phase-playoff',
      // A phase name is itself a disclosure before its rounds are released.
      name: `Championship bracket ${SENTINEL}`,
      kind: 'playoff',
      order: 2,
      formatId: 'format-1',
      poolIds: [],
      roundIds: ['round-playoff'],
      advancementRule: null,
      carryover: false,
      status: 'planned',
    },
  ];

  state.pools = [
    { id: 'pool-1', phaseId: 'phase-prelim', name: 'Pool A', teamIds: [...fixtureTeamIds], order: 1 },
  ];

  state.rounds = [
    {
      id: 'round-1',
      phaseId: 'phase-prelim',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: ['game-1', 'game-2'],
      scheduledStart: '2026-09-05T13:00:00.000Z',
      releasedAt: '2026-09-05T12:50:00.000Z',
      startedAt: '2026-09-05T13:00:00.000Z',
      closedAt: '2026-09-05T13:45:00.000Z',
    },
    {
      id: 'round-2',
      phaseId: 'phase-prelim',
      name: 'Round 2',
      number: 2,
      revision: 1,
      status: 'released',
      packetId: null,
      scheduledGameIds: ['game-3'],
      scheduledStart: '2026-09-05T14:00:00.000Z',
      releasedAt: '2026-09-05T13:53:00.000Z',
      startedAt: '2026-09-05T14:00:00.000Z',
      closedAt: null,
    },
    {
      id: 'round-playoff',
      phaseId: 'phase-playoff',
      name: `Semifinal ${SENTINEL}`,
      number: 3,
      revision: 1,
      // Generated but not released: nothing about it may reach the projection.
      status: 'planned',
      packetId: 'packet-9',
      scheduledGameIds: ['game-playoff'],
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];

  state.scheduledGames = [
    {
      id: 'game-1',
      roundId: 'round-1',
      poolId: 'pool-1',
      roomId: 'room-1',
      packetId: 'packet-1',
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      bye: false,
      status: 'accepted',
      assignmentRevision: 1,
      notes: SENTINEL,
    },
    {
      id: 'game-2',
      roundId: 'round-1',
      poolId: 'pool-1',
      roomId: 'room-2',
      packetId: 'packet-1',
      leftTeamId: 'team-c',
      rightTeamId: 'team-d',
      bye: false,
      status: 'accepted',
      assignmentRevision: 1,
      notes: SENTINEL,
    },
    {
      id: 'game-3',
      roundId: 'round-2',
      poolId: 'pool-1',
      roomId: 'room-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-c',
      bye: false,
      status: 'live',
      assignmentRevision: 1,
      notes: SENTINEL,
    },
    {
      id: 'game-playoff',
      roundId: 'round-playoff',
      poolId: null,
      roomId: 'room-1',
      packetId: 'packet-9',
      leftTeamId: 'team-a',
      rightTeamId: 'team-d',
      bye: false,
      status: 'scheduled',
      assignmentRevision: 1,
      notes: SENTINEL,
    },
  ];

  state.games = [
    {
      id: 'result-1',
      scheduledGameId: 'game-1',
      roundId: 'round-1',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [
        {
          teamId: 'team-a',
          score: 285,
          superpowers: 0,
          powers: 4,
          gets: 9,
          negs: 1,
          bonuses: 13,
          bonusPoints: 150,
          bouncebacks: 0,
        },
        {
          teamId: 'team-b',
          score: 190,
          superpowers: 0,
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 90,
          bouncebacks: 0,
        },
      ],
      playerStats: [
        {
          playerId: 'player-0-0',
          superpowers: 0,
          teamId: 'team-a',
          powers: 3,
          gets: 4,
          negs: 0,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
        {
          playerId: 'player-1-0',
          superpowers: 0,
          teamId: 'team-b',
          powers: 1,
          gets: 3,
          negs: 1,
          bonusPoints: 0,
          tossupsHeard: 20,
        },
      ],
      source: 'qbtcp',
      detailedStats: 'complete',
      transportResultId: SENTINEL,
      // The raw scoresheet a scorer submitted is internal review material.
      rawQbj: { internal: SENTINEL },
      startedAt: '2026-09-05T13:00:00.000Z',
      finishedAt: '2026-09-05T13:40:00.000Z',
      acceptedAt: '2026-09-05T13:45:00.000Z',
      note: SENTINEL,
    },
    {
      id: 'result-2',
      scheduledGameId: 'game-2',
      roundId: 'round-1',
      packetId: 'packet-1',
      status: 'accepted',
      scores: [
        {
          teamId: 'team-c',
          score: 240,
          superpowers: 0,
          powers: 2,
          gets: 10,
          negs: 0,
          bonuses: 12,
          bonusPoints: 120,
          bouncebacks: 0,
        },
        {
          teamId: 'team-d',
          score: 205,
          superpowers: 0,
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 100,
          bouncebacks: 0,
        },
      ],
      playerStats: [],
      source: 'manual',
      detailedStats: 'unknown',
      acceptedAt: '2026-09-05T13:50:00.000Z',
      note: SENTINEL,
    },
  ];

  state.submissions = [
    {
      id: 'submission-1',
      gameId: 'result-1',
      transportResultId: SENTINEL,
      sessionId: SENTINEL,
      receivedAt: '2026-09-05T13:42:00.000Z',
      // A result fingerprint is an internal deduplication key.
      fingerprint: SENTINEL,
      status: 'accepted',
      rawSubmission: { raw: SENTINEL },
      warnings: [SENTINEL],
      acceptedBy: SENTINEL,
      acceptedAt: '2026-09-05T13:45:00.000Z',
    },
    {
      id: 'submission-rejected',
      gameId: 'result-1',
      receivedAt: '2026-09-05T13:41:00.000Z',
      fingerprint: SENTINEL,
      status: 'rejected',
      rawSubmission: { raw: SENTINEL },
      reason: SENTINEL,
    },
  ];

  state.protests = [
    {
      id: 'protest-1',
      gameId: 'result-1',
      category: 'tossup',
      description: SENTINEL,
      status: 'open',
      ruling: SENTINEL,
      createdAt: at,
      updatedAt: at,
    },
  ];

  state.audit = [
    {
      id: 'audit-1',
      at,
      actor: SENTINEL,
      type: 'result-accepted',
      summary: SENTINEL,
      entityId: 'result-1',
      details: { internal: SENTINEL },
    },
  ];

  state.qbtcpSessions = [
    {
      roomId: 'room-1',
      sessionId: SENTINEL,
      matchId: SENTINEL,
      deviceId: SENTINEL,
      operatorName: SENTINEL,
      state: 'live',
      resumable: true,
      resultReceived: false,
      lastSeenAt: at,
      progressSequence: 12,
      progress: { tossupsRead: 13, leftScore: 180, rightScore: 135 },
      helpRequestId: null,
    },
  ];

  state.qbtcpHelpRequests = [
    {
      id: 'help-1',
      roomId: 'room-1',
      roomName: 'Room 104',
      category: 'equipment',
      message: SENTINEL,
      status: 'open',
      createdAt: at,
      updatedAt: at,
      deviceId: SENTINEL,
      operatorName: SENTINEL,
      currentMatchup: { internal: SENTINEL },
    },
  ];

  state.qbtcpRosterAmendments = [
    {
      id: 'roster-amendment-fixture',
      sessionId: SENTINEL,
      amendment: { internal: SENTINEL },
      status: 'pending',
      decidedAt: null,
      decidedBy: null,
      mappedPlayerId: null,
    },
  ];

  state.timeline = [
    {
      id: 'timeline-lunch',
      type: 'lunch',
      title: 'Lunch',
      description: 'Cafeteria, first floor.',
      scheduledStart: '2026-09-05T16:00:00.000Z',
      scheduledEnd: '2026-09-05T16:45:00.000Z',
      teamIds: [],
      roomId: null,
      location: 'Cafeteria',
      visibility: 'public',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'timeline-staff',
      type: 'custom',
      title: `Moderator briefing ${SENTINEL}`,
      description: SENTINEL,
      scheduledStart: '2026-09-05T12:30:00.000Z',
      scheduledEnd: null,
      teamIds: [],
      roomId: 'room-2',
      location: SENTINEL,
      visibility: 'staff',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'timeline-hidden',
      type: 'custom',
      title: SENTINEL,
      description: SENTINEL,
      scheduledStart: null,
      scheduledEnd: null,
      teamIds: [],
      roomId: null,
      location: SENTINEL,
      visibility: 'hidden',
      createdAt: at,
      updatedAt: at,
    },
  ];

  const live = emptyLivePublication('bcdfghjkmnpqrstvwxyz', at);
  live.lifecycle = 'live';
  live.settings.enabled = true;
  live.backend = { kind: 'cloudflare', origin: 'https://qblive.example.workers.dev', displayName: SENTINEL };
  // A credential reference names a keychain entry. Neither the reference nor the secret publishes.
  live.credential = { keychainService: SENTINEL, keychainAccount: SENTINEL, verifiedAt: at };
  live.push = {
    status: 'enabled',
    publisherId: SENTINEL,
    credential: { keychainService: SENTINEL, keychainAccount: SENTINEL },
    teamsPerShard: 8,
  };
  live.sync = {
    localRevision: 41,
    acknowledgedRevision: 40,
    pendingItems: 1,
    lastSuccessAt: at,
    lastError: SENTINEL,
    retrying: false,
  };
  live.outbox = [
    {
      id: 'outbox-1',
      revision: 41,
      kind: 'sections',
      payload: { internal: SENTINEL },
      state: 'pending',
      attempts: 1,
      createdAt: at,
      lastError: SENTINEL,
    },
  ];
  live.announcements = [
    {
      id: 'announcement-1',
      title: 'Round 2 begins at 2:00',
      body: 'Please be in your rooms by 1:55.',
      severity: 'important',
      audienceTeamIds: [],
      publishedAt: '2026-09-05T13:50:00.000Z',
      updatedAt: null,
      expiresAt: null,
    },
    {
      id: 'announcement-withdrawn',
      title: SENTINEL,
      body: SENTINEL,
      severity: 'urgent',
      audienceTeamIds: [],
      publishedAt: '2026-09-05T13:00:00.000Z',
      withdrawn: true,
    },
  ];
  state.live = live;

  state.metadata = {
    lastSavedAt: at,
    lastCheckpointAt: at,
    // A filesystem path discloses the operator's machine.
    archivePath: `/Users/${SENTINEL}/Documents/tournament.qbsheet`,
  };

  return state;
}
