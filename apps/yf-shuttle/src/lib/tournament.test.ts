/**
 * The tournament view: what an assignment is built from, read off the real sample file.
 */

import { describe, expect, test } from 'vitest';
import {
  loadShuttleTournament,
  seedOrderOf,
  tournamentIdentityFingerprint,
} from './tournament';
import { loadedFixture, yftFixtureText } from '../tests/helpers';

describe('loading a YellowFruit file', () => {
  test('reads identity, teams, pools, rounds, and the timed flag', () => {
    const tournament = loadedFixture();
    expect(tournament.teams).toHaveLength(12);
    expect(tournament.rounds).toHaveLength(8);
    expect(tournament.pools).toHaveLength(4);
    expect(tournament.timed).toBe(false);
    expect(tournament.rules).toMatchObject({ type: 'ScoringRules' });
    expect(tournament.playerCount).toBeGreaterThan(0);
    for (const team of tournament.teams) {
      expect(team.seed).toBeGreaterThanOrEqual(1);
      expect(team.seed).toBeLessThanOrEqual(12);
    }
    const numbers = tournament.rounds.map((round) => round.number).sort((a, b) => a! - b!);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('rejects a non-YellowFruit file with a plain message', () => {
    const report = loadShuttleTournament(JSON.stringify({ version: '2.1.1', objects: [] }));
    expect(report.ok).toBe(false);
    if (!report.ok) expect(report.errors.join(' ')).toMatch(/YellowFruit/);
  });

  test('the seed order covers all twelve teams', () => {
    const tournament = loadedFixture();
    const parsed = JSON.parse(yftFixtureText()) as { objects: Record<string, unknown>[] };
    const raw = parsed.objects.find((entry) => entry.type === 'Tournament')!;
    const order = seedOrderOf(raw as Parameters<typeof seedOrderOf>[0]);
    expect(order).toHaveLength(12);
    expect(new Set(order)).toEqual(new Set(tournament.teams.map((team) => team.id)));
  });

  test('the fingerprint is stable for the same event and moves with it', () => {
    const first = loadedFixture();
    const second = loadedFixture();
    expect(tournamentIdentityFingerprint(first)).toBe(tournamentIdentityFingerprint(second));
    expect(
      tournamentIdentityFingerprint({ ...first, name: 'Renamed Event' }),
    ).toBe(tournamentIdentityFingerprint(first));
  });
});
