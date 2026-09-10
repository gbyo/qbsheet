/**
 * Canonical team TUH and fractional player GP (#746, epic #755).
 *
 * Team tossups-heard is the sum of exact match tossups-read denominators, never summed player
 * exposure: several players hear the same tossup and substitutions change summed exposure.
 * Player games-played is the sum of player TUH / game TUH, so a half game is 0.5 GP.
 * Unknown stays unknown (never a fabricated zero), and pure forfeits contribute W/L but no
 * denominators.
 */
import { describe, expect, test } from 'vitest';
import { derivePlayerStandings, deriveTeamStandings, isoNow, type GameRecord } from '../domain/model';
import { buildCanonicalSnapshot } from '../reports/canonicalReports';
import { digestText } from './canonical';
import { assessIncomingDocument, stageIncomingDocument, type IncomingDocument } from './ingest';
import { assignmentFor, directorFixture, scoreAssignment } from './testFixtures';

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

function matchOf(document: unknown): Record<string, unknown> {
  const objects = (document as { objects: Array<Record<string, unknown>> }).objects;
  const match = objects.find((object) => object.type === 'Match');
  if (!match) throw new Error('tuh: the assignment has no match');
  return match;
}

function score(
  teamId: string,
  value: number,
  extra: Record<string, number | null> = {},
): GameRecord['scores'][number] {
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
    ...extra,
  };
}

function playerStat(
  playerId: string,
  teamId: string,
  tossupsHeard: number | null,
): GameRecord['playerStats'][number] {
  return {
    playerId,
    teamId,
    superpowers: 0,
    powers: 0,
    gets: 0,
    negs: 0,
    bonusPoints: 0,
    tossupsHeard,
  };
}

function manualGame(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: 'game-manual-1',
    scheduledGameId: 'game-5-1',
    roundId: 'round-5',
    packetId: 'packet-5',
    status: 'accepted',
    scores: [score('team-1', 200), score('team-2', 100)],
    playerStats: [
      playerStat('team-1-player-1', 'team-1', 20),
      playerStat('team-1-player-2', 'team-1', 15),
      playerStat('team-2-player-1', 'team-2', 20),
    ],
    source: 'manual',
    detailedStats: 'complete',
    acceptedAt: isoNow(),
    ...overrides,
  };
}

describe('canonical team TUH', () => {
  test('ingest persists exact match TUH onto the game record', () => {
    const state = directorFixture();
    const document = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    const match = matchOf(document);
    match.tossups_read = 20;
    match.overtime_tossups_read = 0;
    const assessment = assessIncomingDocument(state, documentFor(document));
    expect(assessment.tossupsRead).toBe(20);
    expect(assessment.overtimeTossupsRead).toBe(0);
    const outcome = stageIncomingDocument(state, documentFor(document), assessment);
    const game = state.games.find((entry) => entry.id === outcome.gameId);
    expect(game?.tossupsRead).toBe(20);
    expect(game?.overtimeTossupsRead).toBe(0);
  });

  test('a malformed match count warns and reads as unknown, never zero', () => {
    const state = directorFixture();
    const document = scoreAssignment(assignmentFor(state, 'game-5-1').document);
    matchOf(document).tossups_read = 'twenty';
    const assessment = assessIncomingDocument(state, documentFor(document));
    expect(assessment.tossupsRead).toBeNull();
    expect(assessment.warnings.length).toBeGreaterThan(0);
  });

  test('team TUH sums game denominators, not player exposure', () => {
    const state = directorFixture();
    // Player exposure sums to 35 for team-1, but the match read 20 tossups.
    state.games.push(manualGame({ tossupsRead: 20, overtimeTossupsRead: 0 }));
    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === 'team-1');
    const right = standings.find((entry) => entry.teamId === 'team-2');
    expect(left?.tossupsHeard).toBe(20);
    expect(left?.tossupsHeardKnown).toBe(true);
    expect(left?.tossupsHeardRegulation).toBe(20);
    expect(left?.tossupsHeardRegulationKnown).toBe(true);
    expect(right?.tossupsHeard).toBe(20);
  });

  test('a game without an exact count marks TUH unknown instead of summing lines', () => {
    const state = directorFixture();
    state.games.push(manualGame());
    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === 'team-1');
    expect(left?.tossupsHeardKnown).toBe(false);
    expect(left?.tossupsHeardRegulationKnown).toBe(false);
    const snapshot = buildCanonicalSnapshot(state);
    expect(snapshot.teams.find((row) => row.teamId === 'team-1')?.pptuh).toBeNull();
  });

  test('overtime splits regulation TUH from total TUH', () => {
    const state = directorFixture();
    state.games.push(manualGame({ tossupsRead: 22, overtimeTossupsRead: 2 }));
    const standings = deriveTeamStandings(state);
    const left = standings.find((entry) => entry.teamId === 'team-1');
    expect(left?.tossupsHeard).toBe(22);
    expect(left?.tossupsHeardRegulation).toBe(20);
    expect(left?.tossupsHeardRegulationKnown).toBe(true);
  });

  test('a forfeit counts in W/L but contributes no TUH denominator', () => {
    const state = directorFixture();
    state.games.push(
      manualGame({
        id: 'game-forfeit-1',
        status: 'forfeit',
        forfeitedTeamId: 'team-2',
        tossupsRead: null,
        overtimeTossupsRead: null,
      }),
    );
    const standings = deriveTeamStandings(state);
    const winner = standings.find((entry) => entry.teamId === 'team-1');
    const forfeiter = standings.find((entry) => entry.teamId === 'team-2');
    expect(winner?.wins).toBe(1);
    expect(forfeiter?.losses).toBe(1);
    expect(winner?.gamesPlayed).toBe(1);
    expect(winner?.tossupsHeardKnown).toBe(true);
    expect(winner?.tossupsHeard).toBe(0);
    expect(forfeiter?.tossupsHeardKnown).toBe(true);
  });
});

describe('fractional player GP', () => {
  test('a partial game accrues fractionally and a full game is 1.0', () => {
    const state = directorFixture();
    state.games.push(manualGame({ tossupsRead: 20, overtimeTossupsRead: 0 }));
    const standings = derivePlayerStandings(state);
    const full = standings.find((entry) => entry.playerId === 'team-1-player-1');
    const partial = standings.find((entry) => entry.playerId === 'team-1-player-2');
    expect(full?.gamesPlayed).toBe(1);
    expect(full?.gamesPlayedKnown).toBe(true);
    expect(partial?.gamesPlayed).toBeCloseTo(0.75, 10);
    expect(partial?.gamesPlayedKnown).toBe(true);
  });

  test('unknown player or game TUH keeps GP unknown', () => {
    const state = directorFixture();
    state.games.push(manualGame({ id: 'game-known-1', tossupsRead: 20, overtimeTossupsRead: 0 }));
    state.games.push(
      manualGame({
        id: 'game-unknown-1',
        scheduledGameId: 'game-5-2',
        playerStats: [
          playerStat('team-1-player-1', 'team-1', null),
          playerStat('team-2-player-1', 'team-2', 20),
        ],
      }),
    );
    const standings = derivePlayerStandings(state);
    const unknown = standings.find((entry) => entry.playerId === 'team-1-player-1');
    // One known full game plus one unknowable appearance: 1.0 GP, flagged unknown.
    expect(unknown?.gamesPlayed).toBe(1);
    expect(unknown?.gamesPlayedKnown).toBe(false);
    const snapshot = buildCanonicalSnapshot(state);
    expect(snapshot.players.find((row) => row.playerId === 'team-1-player-1')?.gamesPlayedKnown).toBe(false);
  });
});
