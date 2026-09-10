/**
 * Unknown player games played renders as unknown, never zero (#746).
 *
 * Fractional GP needs both the player's TUH and the game's TUH denominator. A game that
 * carries result lines but no tossups-read count leaves participation unknown: the G and PPG
 * cells render an em dash, while the scored points still render.
 */
import { describe, expect, test } from 'vitest';
import type { DirectorState } from '@qbsheet/tournament-domain';
import { privacyFixture } from '../src/fixture';
import { buildPlayerStatisticsTable } from '../src/tables';

const scope = { id: 'overall', label: 'Overall' };
const naming = {
  teamName: (teamId: string) => teamId,
  playerName: (playerId: string) => playerId,
};

function columnIndexes() {
  const table = buildPlayerStatisticsTable(privacyFixture(), scope, naming);
  const columns = table.columns.map((column) => column.id);
  return {
    games: columns.indexOf('games'),
    points: columns.indexOf('points'),
    ppg: columns.indexOf('ppg'),
  };
}

function rowsFor(state: DirectorState) {
  return buildPlayerStatisticsTable(state, scope, naming).rows;
}

describe('unknown player games played', () => {
  test('renders em-dash G and PPG when the game supplies no TUH denominator', () => {
    const { games, points, ppg } = columnIndexes();
    const rows = rowsFor(privacyFixture());
    const byId = new Map(rows.map((row) => [row.id, row]));
    const scorer = byId.get('player-0-0')!;
    expect(scorer.cells[games]).toEqual({ value: null, display: '—' });
    expect(scorer.cells[ppg]).toEqual({ value: null, display: '—' });
    // Unknown participation never zeroes scoring.
    expect(scorer.cells[points]).toEqual({ value: 85, display: '85' });
    // A bench player with no lines is a verified zero, not an unknown.
    const bench = byId.get('player-0-1')!;
    expect(bench.cells[games]).toEqual({ value: 0, display: '0' });
  });

  test('renders participation once the game TUH is known', () => {
    const state = privacyFixture();
    state.games[0]!.tossupsRead = 20;
    const { games, ppg } = columnIndexes();
    const rows = rowsFor(state);
    expect(rows[0]!.cells[games]).toEqual({ value: 1, display: '1' });
    expect(rows[0]!.cells[ppg]).toEqual({ value: 85, display: '85.0' });
  });
});
