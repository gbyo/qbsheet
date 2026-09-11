/**
 * YellowFruit parity fixture matrix (#754, epic #755).
 *
 * Small human-reviewable tournaments, one per scoring mode, with expected math
 * checked into `parityMatrix.test.ts` as goldens. Every game carries exact
 * tossups-read counts unless the mode is about missing detail; bonuses use the
 * default regular shape (value 10, 3 parts) unless the mode says otherwise.
 */
import {
  defaultRules,
  emptyDirectorState,
  type DirectorState,
  type GameRecord,
  type Player,
  type PlayerGameStat,
  type TeamGameScore,
  type TournamentRules,
} from '../../src/index.js';

export const at = '2026-09-09T12:00:00.000Z';

export function teamScore(teamId: string, score: number, detail: Partial<TeamGameScore> = {}): TeamGameScore {
  return {
    teamId,
    score,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonuses: 0,
    bonusPoints: 0,
    bouncebacks: 0,
    ...detail,
  };
}

export function playerStat(
  playerId: string,
  teamId: string,
  detail: Partial<PlayerGameStat> = {},
): PlayerGameStat {
  return {
    playerId,
    teamId,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonusPoints: 0,
    tossupsHeard: 20,
    ...detail,
  };
}

export function game(
  id: string,
  scores: [TeamGameScore, TeamGameScore],
  detail: Partial<GameRecord> & { playerStats?: PlayerGameStat[] } = {},
): GameRecord {
  const { playerStats, ...rest } = detail;
  return {
    id,
    scheduledGameId: `s-${id}`,
    roundId: 'round-1',
    packetId: 'packet-1',
    status: 'accepted',
    scores,
    playerStats: playerStats ?? [],
    source: 'manual',
    detailedStats: 'complete',
    tossupsRead: 20,
    ...rest,
  } as GameRecord;
}

export function matrixState(
  games: GameRecord[],
  options: {
    rules?: Partial<TournamentRules>;
    players?: Player[];
    rounds?: DirectorState['rounds'];
    scheduledGames?: DirectorState['scheduledGames'];
    gameDefinitions?: DirectorState['gameDefinitions'];
    tournamentId?: string;
  } = {},
): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: options.tournamentId ?? 'parity-matrix',
    name: 'Parity Matrix',
    date: '2026-09-09',
    venue: '',
    organizer: '',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone({ ...defaultRules, ...options.rules }),
    formatId: null,
    currentPhaseId: 'phase-1',
    currentPacketId: null,
    currentRoundId: null,
    createdAt: at,
    updatedAt: at,
  };
  const teamIds = [...new Set(games.flatMap((entry) => entry.scores.map((score) => score.teamId)))];
  state.teams = teamIds.map((id) => ({
    id,
    organizationId: null,
    displayName: id.toUpperCase(),
    teamLetter: 'A',
    seed: null,
    status: 'confirmed' as const,
    createdAt: at,
    updatedAt: at,
  }));
  state.players = options.players ?? [];
  state.rounds = options.rounds ?? [
    {
      id: 'round-1',
      phaseId: 'phase-1',
      name: 'Round 1',
      number: 1,
      revision: 1,
      status: 'closed',
      packetId: 'packet-1',
      scheduledGameIds: games.map((entry) => entry.scheduledGameId),
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
    },
  ];
  state.scheduledGames =
    options.scheduledGames ??
    games.map((entry) => ({
      id: entry.scheduledGameId,
      roundId: entry.roundId,
      roomId: null,
      packetId: 'packet-1',
      leftTeamId: entry.scores[0]!.teamId,
      rightTeamId: entry.scores[1]!.teamId,
      bye: false,
      status: 'accepted' as const,
      assignmentRevision: 1,
    }));
  state.games = games;
  state.gameDefinitions = options.gameDefinitions ?? [];
  return state;
}

function player(id: string, teamId: string, detail: Partial<Player> = {}): Player {
  return { id, teamId, name: id, captain: false, active: true, ...detail };
}

/** 1. Standard 20-TU powers + bonuses. */
export function standardMode(): DirectorState {
  return matrixState([
    game('g1', [
      teamScore('a', 320, { powers: 4, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
      teamScore('b', 110, { powers: 1, gets: 5, negs: 2, bonuses: 6, bonusPoints: 40 }),
    ]),
  ]);
}

/** 2. Superpower format (20/15/10/−5). */
export function superpowerMode(): DirectorState {
  return matrixState(
    [
      game('g1', [
        teamScore('a', 350, { superpowers: 1, powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200 }),
        teamScore('b', 150, { superpowers: 0, powers: 1, gets: 6, negs: 2, bonuses: 6, bonusPoints: 90 }),
      ]),
    ],
    { rules: { superpowerValue: 20 } },
  );
}

/** 3. Tossup-only: no bonus columns apply. */
export function tossupOnlyMode(): DirectorState {
  return matrixState(
    [
      game('g1', [
        teamScore('a', 180, { powers: 2, gets: 8, negs: 1 }),
        teamScore('b', 90, { powers: 1, gets: 5, negs: 2 }),
      ]),
    ],
    { rules: { useBonuses: false } },
  );
}

/** 4. Regular bouncebacks: opponent 8-for-150 leaves 9 parts heard; 30 own points convert 3. */
export function bouncebackMode(): DirectorState {
  return matrixState(
    [
      game('g1', [
        teamScore('a', 350, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200, bouncebacks: 30 }),
        teamScore('b', 200, { powers: 1, gets: 7, negs: 2, bonuses: 8, bonusPoints: 150, bouncebacks: 0 }),
      ]),
    ],
    { rules: { bouncebacks: true } },
  );
}

/** 5. Irregular bonuses: parts are uncomputable, never zero. */
export function irregularBonusMode(): DirectorState {
  return matrixState(
    [
      game('g1', [
        teamScore('a', 350, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200, bouncebacks: 30 }),
        teamScore('b', 200, { powers: 1, gets: 7, negs: 2, bonuses: 8, bonusPoints: 150, bouncebacks: 0 }),
      ]),
    ],
    { rules: { bouncebacks: true, minimumBonusParts: 2 } },
  );
}

/** 6. Lightning: team-a known 40; team-b's game lacks the breakdown, unknowning every total it touches. */
export function lightningMode(): DirectorState {
  return matrixState(
    [
      game('g1', [
        teamScore('a', 350, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 200,
          lightningPoints: 40,
        }),
        teamScore('b', 200, {
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 150,
          lightningPoints: null,
        }),
      ]),
    ],
    { rules: { lightning: true } },
  );
}

/** 7. Overtime: 2 of 20 tossups are overtime; regulation TUH is 18. */
export function overtimeMode(): DirectorState {
  return matrixState([
    game(
      'g1',
      [
        teamScore('a', 330, { powers: 4, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
        teamScore('b', 120, { powers: 1, gets: 5, negs: 2, bonuses: 6, bonusPoints: 40 }),
      ],
      { tossupsRead: 20, overtimeTossupsRead: 2 },
    ),
  ]);
}

/** 8. Substitution: a2 hears half the game; metadata rides on the roster records. */
export function fractionalGpMode(): DirectorState {
  return matrixState(
    [
      game(
        'g1',
        [
          teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180 }),
          teamScore('b', 160, { powers: 1, gets: 5, negs: 2, bonuses: 6, bonusPoints: 60 }),
        ],
        {
          playerStats: [
            playerStat('a1', 'a', { powers: 2, gets: 5, negs: 1, tossupsHeard: 20 }),
            playerStat('a2', 'a', { gets: 3, tossupsHeard: 10 }),
            playerStat('b1', 'b', { powers: 1, gets: 5, negs: 2, tossupsHeard: 20 }),
          ],
        },
      ),
    ],
    {
      players: [
        player('a1', 'a', {
          name: 'A. One',
          schoolYear: 12,
          undergraduateEligible: false,
          divisionTwoEligible: false,
        }),
        player('a2', 'a', {
          name: 'A. Two',
          schoolYear: 10,
          undergraduateEligible: true,
          divisionTwoEligible: true,
        }),
        player('b1', 'b', { name: 'B. One' }),
      ],
    },
  );
}

/** 9. Custom 24-TU format with custom values; mirror winners tie at rank 1. */
export function customTiesMode(): DirectorState {
  const rules = { tossupCount: 24, powerValue: 20, tossupValue: 12, negValue: -10 };
  return matrixState(
    [
      game(
        'g1',
        [
          teamScore('a', 400, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200 }),
          teamScore('b', 150, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60 }),
        ],
        {
          tossupsRead: 24,
          playerStats: [playerStat('a1', 'a', { powers: 2, gets: 8, negs: 1, tossupsHeard: 24 })],
        },
      ),
      game(
        'g2',
        [
          teamScore('c', 400, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200 }),
          teamScore('d', 150, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60 }),
        ],
        { tossupsRead: 24 },
      ),
    ],
    { rules, players: [player('a1', 'a', { name: 'A. One' })] },
  );
}

/** 10. Pure forfeit: decided for W/L, invisible to TUH denominators. */
export function forfeitMode(): DirectorState {
  return matrixState([
    game('g1', [
      teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180 }),
      teamScore('b', 100, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60 }),
    ]),
    game('g2', [teamScore('a', 0, { bouncebacks: null }), teamScore('c', 0, { bouncebacks: null })], {
      status: 'forfeit',
      forfeitedTeamId: 'c',
    }),
  ]);
}

/** 11. Score-only partial: points without trustworthy detail. */
export function partialMode(): DirectorState {
  // Score-only lines: the breakdown columns are explicitly absent, not zero.
  return matrixState([
    game('g1', [teamScore('a', 250, { bouncebacks: null }), teamScore('b', 240, { bouncebacks: null })], {
      detailedStats: 'unknown',
      tossupsRead: null,
    }),
  ]);
}

/** 12. Two rounds plus a second phase for scoping. */
export function multiRoundMode(): DirectorState {
  const games = [
    game('g1', [
      teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180 }),
      teamScore('b', 100, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60 }),
    ]),
    game(
      'g2',
      [
        teamScore('a', 260, { powers: 1, gets: 7, negs: 1, bonuses: 8, bonusPoints: 140 }),
        teamScore('b', 180, { powers: 2, gets: 5, negs: 1, bonuses: 7, bonusPoints: 100 }),
      ],
      { roundId: 'round-2' },
    ),
    game(
      'g3',
      [
        teamScore('a', 200, { powers: 1, gets: 5, negs: 1, bonuses: 6, bonusPoints: 90 }),
        teamScore('b', 220, { powers: 2, gets: 5, negs: 0, bonuses: 7, bonusPoints: 110 }),
      ],
      { roundId: 'round-3' },
    ),
  ];
  return matrixState(games, {
    rounds: [
      {
        id: 'round-1',
        phaseId: 'phase-1',
        name: 'Round 1',
        number: 1,
        revision: 1,
        status: 'closed',
        packetId: 'packet-1',
        scheduledGameIds: ['s-g1'],
        dayOrder: 0,
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
      },
      {
        id: 'round-2',
        phaseId: 'phase-1',
        name: 'Round 2',
        number: 2,
        revision: 1,
        status: 'closed',
        packetId: 'packet-1',
        scheduledGameIds: ['s-g2'],
        dayOrder: 1,
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
      },
      {
        id: 'round-3',
        phaseId: 'phase-2',
        name: 'Round 3',
        number: 3,
        revision: 1,
        status: 'closed',
        packetId: 'packet-1',
        scheduledGameIds: ['s-g3'],
        dayOrder: 2,
        scheduledStart: null,
        releasedAt: null,
        startedAt: null,
        closedAt: null,
      },
    ],
  });
}

/** 13. Known zero vs unknown: explicit complete zeroes stay comparable; nulls decline. */
export function zeroVsUnknownMode(): DirectorState {
  return matrixState([
    game('g1', [
      teamScore('a', 200, { powers: 0, gets: 8, negs: 1, bonuses: 10, bonusPoints: 120, bouncebacks: 0 }),
      teamScore('b', 100, { powers: 0, gets: 4, negs: 2, bonuses: 5, bonusPoints: 0, bouncebacks: 0 }),
    ]),
    // Score-only lines carry zeroes the engine must not trust: the unknown
    // detail flag unknowns every count-derived aggregate for these teams.
    game('g2', [teamScore('c', 150, { bouncebacks: null }), teamScore('d', 120, { bouncebacks: null })], {
      detailedStats: 'unknown',
      tossupsRead: null,
    }),
  ]);
}

/** 15. Mixed bounceback history: game-2's pinned definition has no bouncebacks and stores a scorer-exported zero. */
export function mixedBouncebackMode(): DirectorState {
  const on = structuredClone({ ...defaultRules, bouncebacks: true });
  const off = structuredClone(defaultRules);
  const games = [
    game(
      'g1',
      [
        teamScore('a', 350, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 200, bouncebacks: 30 }),
        teamScore('b', 200, { powers: 1, gets: 7, negs: 2, bonuses: 8, bonusPoints: 150, bouncebacks: 0 }),
      ],
      { definitionDigest: 'bb-on' },
    ),
    game(
      'g2',
      [
        teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180, bouncebacks: 0 }),
        teamScore('b', 150, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60, bouncebacks: 0 }),
      ],
      { definitionDigest: 'bb-off' },
    ),
  ];
  return matrixState(games, {
    rules: { bouncebacks: false },
    gameDefinitions: [
      {
        id: 'def-bb-on',
        scheduledGameId: 's-g1',
        revision: 1,
        createdAt: at,
        rules: on,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'bb-on',
      },
      {
        id: 'def-bb-off',
        scheduledGameId: 's-g2',
        revision: 1,
        createdAt: at,
        rules: off,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'bb-off',
      },
    ],
  });
}

/** 16. Mixed lightning history: game-2's pinned definition has no lightning and carries no breakdown. */
export function mixedLightningMode(): DirectorState {
  const on = structuredClone({ ...defaultRules, lightning: true });
  const off = structuredClone(defaultRules);
  const games = [
    game(
      'g1',
      [
        teamScore('a', 350, {
          powers: 2,
          gets: 8,
          negs: 1,
          bonuses: 10,
          bonusPoints: 200,
          lightningPoints: 40,
        }),
        teamScore('b', 200, {
          powers: 1,
          gets: 7,
          negs: 2,
          bonuses: 8,
          bonusPoints: 150,
          lightningPoints: 30,
        }),
      ],
      { definitionDigest: 'lightning-on' },
    ),
    game(
      'g2',
      [
        teamScore('a', 300, { powers: 2, gets: 8, negs: 1, bonuses: 10, bonusPoints: 180 }),
        teamScore('b', 150, { powers: 1, gets: 4, negs: 2, bonuses: 5, bonusPoints: 60 }),
      ],
      { definitionDigest: 'lightning-off' },
    ),
  ];
  return matrixState(games, {
    rules: { lightning: false },
    gameDefinitions: [
      {
        id: 'def-lightning-on',
        scheduledGameId: 's-g1',
        revision: 1,
        createdAt: at,
        rules: on,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'lightning-on',
      },
      {
        id: 'def-lightning-off',
        scheduledGameId: 's-g2',
        revision: 1,
        createdAt: at,
        rules: off,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'lightning-off',
      },
    ],
  });
}

/** 17. Overtime with a known points split: regulation scoring excludes overtime points. */
export function overtimeKnownPointsMode(): DirectorState {
  return matrixState([
    game(
      'g1',
      [
        teamScore('a', 330, {
          powers: 4,
          gets: 8,
          negs: 1,
          bonuses: 12,
          bonusPoints: 130,
          overtimePoints: 30,
        }),
        teamScore('b', 120, {
          powers: 1,
          gets: 5,
          negs: 2,
          bonuses: 6,
          bonusPoints: 40,
          overtimePoints: 10,
        }),
      ],
      { tossupsRead: 20, overtimeTossupsRead: 2 },
    ),
  ]);
}

/** 18. Overtime-capable game with an unknown points split: regulation scoring declines. */
export function overtimeUnknownSplitMode(): DirectorState {
  return matrixState([
    game(
      'g1',
      [
        teamScore('a', 330, { powers: 4, gets: 8, negs: 1, bonuses: 12, bonusPoints: 130 }),
        teamScore('b', 120, { powers: 1, gets: 5, negs: 2, bonuses: 6, bonusPoints: 40 }),
      ],
      { tossupsRead: 20, overtimeTossupsRead: 2 },
    ),
  ]);
}

/** 14. Mixed history: game-2 was played under a 20-point power definition. */
export function mixedDefinitionsMode(): DirectorState {
  const modern = structuredClone(defaultRules);
  const legacy = structuredClone({ ...defaultRules, powerValue: 20 });
  const games = [
    game(
      'g1',
      [
        teamScore('a', 300, { powers: 2, gets: 8, negs: 1 }),
        teamScore('b', 100, { powers: 1, gets: 4, negs: 2 }),
      ],
      {
        definitionDigest: 'modern',
        playerStats: [playerStat('a1', 'a', { powers: 2, gets: 8, negs: 1, tossupsHeard: 20 })],
      },
    ),
    game(
      'g2',
      [
        teamScore('a', 320, { powers: 2, gets: 8, negs: 1 }),
        teamScore('b', 100, { powers: 1, gets: 4, negs: 2 }),
      ],
      {
        definitionDigest: 'legacy',
        playerStats: [playerStat('a1', 'a', { powers: 2, gets: 8, negs: 1, tossupsHeard: 20 })],
      },
    ),
  ];
  return matrixState(games, {
    players: [player('a1', 'a', { name: 'A. One' })],
    gameDefinitions: [
      {
        id: 'def-modern',
        scheduledGameId: 's-g1',
        revision: 1,
        createdAt: at,
        rules: modern,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'modern',
      },
      {
        id: 'def-legacy',
        scheduledGameId: 's-g2',
        revision: 1,
        createdAt: at,
        rules: legacy,
        roundId: 'round-1',
        packetId: 'packet-1',
        leftTeamId: 'a',
        rightTeamId: 'b',
        leftRoster: [],
        rightRoster: [],
        assignmentRevision: 1,
        digest: 'legacy',
      },
    ],
  });
}
