import { describe, expect, test } from 'vitest';
import { buildResourceCenterReport } from '../src/resourceCenterReport';
import { preflightResourceCenterReport, resourceCenterCompatibility } from '../src/resourceCenterPreflight';
import {
  buildReportPresentation,
  type ReportPresentationCapabilities,
  type ReportScoringDefinition,
} from '../src/reportPresentation';
import type { ReportOptions } from '../src/reportPresentation';
import type { GamePlayerStatsRow, GameTeamStatsRow } from '../src/reportDetail';
import type { GameStatsRow, StatsSnapshot } from '../src/stats';

const generatedAt = '2026-09-10T12:00:00.000Z';

function definition(overrides: Partial<ReportScoringDefinition> = {}): ReportScoringDefinition {
  return {
    tossupValue: 10,
    superpowerValue: null,
    powerValue: 15,
    negValue: -5,
    useBonuses: true,
    tossupCount: 20,
    bouncebacks: false,
    lightning: false,
    overtime: false,
    ...overrides,
  };
}

const capabilities: ReportPresentationCapabilities = {
  bouncebacksRecorded: false,
  lightningRecorded: false,
  packetRecorded: true,
  stageRecorded: false,
};

function snapshotFor(input: {
  tournament?: string;
  definitions?: ReportScoringDefinition[];
  capabilities?: ReportPresentationCapabilities;
  options?: ReportOptions;
  teams?: StatsSnapshot['teams'];
  players?: StatsSnapshot['players'];
  games?: GameStatsRow[];
}): StatsSnapshot {
  const name = input.tournament ?? 'Preflight Open';
  const presentation = buildReportPresentation({
    metadata: { tournamentName: name, scopeLabel: 'Overall', generatedAt },
    definitions: input.definitions ?? [definition()],
    ...(input.options ? { options: input.options } : {}),
    capabilities: input.capabilities ?? capabilities,
  });
  return {
    format: 'qbsheet-stats',
    version: 1,
    generatedAt,
    tournament: { id: 'tournament', name },
    teams: input.teams ?? [],
    players: input.players ?? [],
    games: input.games ?? [],
    extensions: { scopeLabel: 'Overall' },
    presentation,
  };
}

function teamLine(
  overrides: Partial<GameTeamStatsRow> & Pick<GameTeamStatsRow, 'teamId' | 'teamName' | 'points'>,
): GameTeamStatsRow {
  return {
    superpowers: null,
    powers: 2,
    gets: 4,
    negs: 1,
    tossupsHeard: 20,
    bonusesHeard: 6,
    bonusPoints: 110,
    ppb: 110 / 6,
    bouncebacks: null,
    ...overrides,
  };
}

function playerLine(
  overrides: Partial<GamePlayerStatsRow> &
    Pick<GamePlayerStatsRow, 'playerId' | 'playerName' | 'teamId' | 'teamName'>,
): GamePlayerStatsRow {
  return {
    tossupsHeard: 20,
    superpowers: null,
    powers: 1,
    gets: 2,
    negs: 0,
    bonusPoints: null,
    points: 35,
    ...overrides,
  };
}

/** Two accepted games, complete detail, internally coherent. */
function coherentSnapshot(): StatsSnapshot {
  return snapshotFor({
    teams: [
      {
        rank: 1,
        teamId: 'team-a',
        teamName: 'Alder',
        gamesPlayed: 2,
        wins: 2,
        losses: 0,
        ties: 0,
        winPercentage: 1,
        pointsFor: 620,
        pointsAgainst: 330,
        ppg: 310,
        papg: 165,
        margin: 290,
        superpowers: 0,
        powers: 4,
        gets: 8,
        negs: 2,
        tossupsHeard: 40,
        tossupsHeardKnown: true,
        pptuh: 620 / 40,
        bonusPoints: 220,
        bonusesHeard: 12,
        ppb: 220 / 12,
      },
      {
        rank: 2,
        teamId: 'team-b',
        teamName: 'Birch',
        gamesPlayed: 2,
        wins: 0,
        losses: 2,
        ties: 0,
        winPercentage: 0,
        pointsFor: 330,
        pointsAgainst: 620,
        ppg: 165,
        papg: 310,
        margin: -290,
        superpowers: 0,
        powers: 2,
        gets: 6,
        negs: 4,
        tossupsHeard: 40,
        tossupsHeardKnown: true,
        pptuh: 330 / 40,
        bonusPoints: 120,
        bonusesHeard: 10,
        ppb: 12,
      },
    ],
    players: [
      {
        rank: 1,
        playerId: 'player-a',
        playerName: 'Ava Rios',
        teamId: 'team-a',
        teamName: 'Alder',
        gamesPlayed: 2,
        tossupsHeard: 40,
        superpowers: 0,
        powers: 2,
        gets: 4,
        negs: 0,
        points: 70,
        ppg: 35,
        pptuh: 1.75,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
      {
        rank: 2,
        playerId: 'player-b',
        playerName: 'Dev Patel',
        teamId: 'team-b',
        teamName: 'Birch',
        gamesPlayed: 2,
        tossupsHeard: 40,
        superpowers: 0,
        powers: 2,
        gets: 4,
        negs: 2,
        points: 60,
        ppg: 30,
        pptuh: 1.5,
        bonusesHeard: 0,
        bonusPoints: 0,
        ppb: null,
      },
    ],
    games: [
      {
        gameId: 'game-1',
        roundId: 'round-1',
        roundName: 'Round 1',
        teamOneId: 'team-a',
        teamOneName: 'Alder',
        teamOnePoints: 310,
        teamTwoId: 'team-b',
        teamTwoName: 'Birch',
        teamTwoPoints: 150,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        tossupsRead: 20,
        overtimeTossupsRead: 0,
        teamStats: [
          teamLine({
            teamId: 'team-a',
            teamName: 'Alder',
            points: 310,
            powers: 2,
            gets: 4,
            negs: 1,
            bonusesHeard: 6,
            bonusPoints: 110,
            ppb: 110 / 6,
          }),
          teamLine({
            teamId: 'team-b',
            teamName: 'Birch',
            points: 150,
            powers: 1,
            gets: 3,
            negs: 2,
            bonusesHeard: 5,
            bonusPoints: 60,
            ppb: 12,
          }),
        ],
        playerStats: [
          playerLine({
            playerId: 'player-a',
            playerName: 'Ava Rios',
            teamId: 'team-a',
            teamName: 'Alder',
            powers: 1,
            gets: 2,
            negs: 0,
            points: 35,
          }),
          playerLine({
            playerId: 'player-b',
            playerName: 'Dev Patel',
            teamId: 'team-b',
            teamName: 'Birch',
            powers: 1,
            gets: 2,
            negs: 1,
            points: 30,
          }),
        ],
      },
      {
        gameId: 'game-2',
        roundId: 'round-2',
        roundName: 'Round 2',
        teamOneId: 'team-a',
        teamOneName: 'Alder',
        teamOnePoints: 310,
        teamTwoId: 'team-b',
        teamTwoName: 'Birch',
        teamTwoPoints: 180,
        winnerId: 'team-a',
        status: 'accepted',
        detail: 'complete',
        tossupsRead: 20,
        overtimeTossupsRead: 0,
        teamStats: [
          teamLine({
            teamId: 'team-a',
            teamName: 'Alder',
            points: 310,
            powers: 2,
            gets: 4,
            negs: 1,
            bonusesHeard: 6,
            bonusPoints: 110,
            ppb: 110 / 6,
          }),
          teamLine({
            teamId: 'team-b',
            teamName: 'Birch',
            points: 180,
            powers: 1,
            gets: 3,
            negs: 2,
            bonusesHeard: 5,
            bonusPoints: 60,
            ppb: 12,
          }),
        ],
        playerStats: [
          playerLine({
            playerId: 'player-a',
            playerName: 'Ava Rios',
            teamId: 'team-a',
            teamName: 'Alder',
            powers: 1,
            gets: 2,
            negs: 0,
            points: 35,
          }),
          playerLine({
            playerId: 'player-b',
            playerName: 'Dev Patel',
            teamId: 'team-b',
            teamName: 'Birch',
            powers: 1,
            gets: 2,
            negs: 1,
            points: 30,
          }),
        ],
      },
    ],
  });
}

function codes(result: ReturnType<typeof preflightResourceCenterReport>): string[] {
  return result.blocking.map((entry) => entry.code);
}

describe('resource center preflight happy path', () => {
  test('a coherent report passes with no blocking errors', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  test('artifact-only preflight checks shape without snapshot invariants', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('live upload is still unverified until the manual smoke test succeeds', () => {
    expect(resourceCenterCompatibility.liveUploadVerified).toBe(false);
  });
});

describe('resource center preflight blocking errors', () => {
  test('a missing required report blocks', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    artifact.files = artifact.files.filter((file) => file.kind !== 'rounds');
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('missing-required-report');
  });

  test('duplicate report roles block', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    artifact.files = [...artifact.files, { ...artifact.files[0]! }];
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('duplicate-report-role');
  });

  test('a renamed file breaking the shared prefix blocks', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    artifact.files.find((file) => file.kind === 'standings')!.fileName = 'standings.html';
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('report-filename-mismatch');
  });

  test('scripts and remote dependencies block', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const standings = artifact.files.find((file) => file.kind === 'standings')!;
    standings.content = standings.content.replace(
      '</body>',
      '<script src="https://example.com/stats.js"></script></body>',
    );
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('active-content');
    expect(codes(result)).toContain('remote-dependency');
  });

  test('dangling internal links block', () => {
    const snapshot = coherentSnapshot();
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const standings = artifact.files.find((file) => file.kind === 'standings')!;
    standings.content = standings.content.replace(
      'preflight-open_individuals.html',
      'preflight-open_missing.html',
    );
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('dangling-report-link');
  });

  test('a tournament with no accepted games blocks', () => {
    const snapshot = snapshotFor({});
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'empty' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('no-accepted-games');
  });

  test('a standings row that disagrees with its games blocks', () => {
    const snapshot = coherentSnapshot();
    snapshot.teams[0]!.wins = 1;
    snapshot.teams[0]!.losses = 1;
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('standings-game-mismatch');
  });

  test('a player total that disagrees with game lines blocks', () => {
    const snapshot = coherentSnapshot();
    snapshot.players[0]!.points = 999;
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('player-total-mismatch');
  });

  test('a contradictory winner blocks instead of silently awarding', () => {
    const snapshot = coherentSnapshot();
    snapshot.games[0]!.winnerId = 'team-b';
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('unresolved-game-winner');
  });

  test('a numeric rate on an unknown denominator blocks', () => {
    const snapshot = coherentSnapshot();
    snapshot.teams[0]!.tossupsHeardKnown = false;
    snapshot.teams[0]!.pptuh = 12.5;
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('impossible-rate');
  });
});

describe('resource center preflight warnings', () => {
  test('partial detail and forfeits warn without blocking', () => {
    const snapshot = coherentSnapshot();
    snapshot.games[1]!.detail = 'partial';
    snapshot.games.push({
      gameId: 'game-forfeit',
      roundId: 'round-3',
      roundName: 'Round 3',
      teamOneId: 'team-a',
      teamOneName: 'Alder',
      teamOnePoints: 0,
      teamTwoId: 'team-b',
      teamTwoName: 'Birch',
      teamTwoPoints: 0,
      forfeitedTeamId: 'team-b',
      status: 'accepted',
      detail: 'complete',
      tossupsRead: null,
      overtimeTossupsRead: null,
    });
    // Keep the standings coherent with the added forfeit (Alder 3-0, Birch 0-3).
    snapshot.teams[0]!.gamesPlayed = 3;
    snapshot.teams[0]!.wins = 3;
    snapshot.teams[1]!.gamesPlayed = 3;
    snapshot.teams[1]!.losses = 3;
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((entry) => entry.code)).toContain('partial-player-detail');
    expect(result.warnings.map((entry) => entry.code)).toContain('forfeit-representation');
    expect(result.warnings.find((entry) => entry.code === 'partial-player-detail')!.path).toContain('game-2');
  });

  test('unknown tossups-heard warns while honest rendering stays green', () => {
    const snapshot = coherentSnapshot();
    snapshot.teams[0]!.tossupsHeardKnown = false;
    snapshot.teams[0]!.pptuh = null;
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((entry) => entry.code)).toContain('unknown-tossups-heard');
  });

  test('mixed scoring definitions warn', () => {
    const snapshot = snapshotFor({
      definitions: [definition({ powerValue: 15 }), definition({ powerValue: 20 })],
      teams: coherentSnapshot().teams,
      players: coherentSnapshot().players,
      games: coherentSnapshot().games,
    });
    const artifact = buildResourceCenterReport(snapshot, { baseName: 'preflight-open' });
    const result = preflightResourceCenterReport(artifact, snapshot);
    expect(result.warnings.map((entry) => entry.code)).toContain('mixed-scoring-definitions');
  });
});
