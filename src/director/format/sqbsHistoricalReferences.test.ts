/**
 * SQBS archival references survive roster lifecycle edits (#893).
 *
 * A mid-tournament withdrawal or roster cleanup must not make the final SQBS
 * export fail: every team and player referenced by an included accepted game
 * keeps a record and a stable index, while the eight-participant SQBS limit
 * still applies to actual per-game participation.
 */
import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import { directorFixture } from '../transfers/testFixtures';
import { exportSqbsTournament } from './interchange';
import { isoNow, type DirectorState, type GameRecord } from '../domain/model';

function game(
  id: string,
  scheduledGameId: string,
  leftTeam: string,
  rightTeam: string,
  leftPlayer: string,
  rightPlayer: string,
): GameRecord {
  // Decisive scores: tied finals require overtime under these rules, so ties
  // are decision issues and never reach the export.
  const side = (teamId: string, points: number): GameRecord['scores'][number] => ({
    teamId,
    score: points,
    superpowers: 0,
    powers: 1,
    gets: 5,
    negs: 0,
    bonuses: 6,
    bonusPoints: 100,
  });
  return {
    id,
    scheduledGameId,
    roundId: 'round-5',
    packetId: 'packet-5',
    status: 'accepted',
    scores: [side(leftTeam, 215), side(rightTeam, 195)],
    playerStats: [
      {
        playerId: leftPlayer,
        teamId: leftTeam,
        superpowers: 0,
        powers: 1,
        gets: 5,
        negs: 0,
        bonusPoints: 0,
        tossupsHeard: 20,
      },
      {
        playerId: rightPlayer,
        teamId: rightTeam,
        superpowers: 0,
        powers: 1,
        gets: 5,
        negs: 0,
        bonusPoints: 0,
        tossupsHeard: 20,
      },
    ],
    tossupsRead: 20,
    source: 'manual',
    detailedStats: 'complete',
    acceptedAt: isoNow(),
  };
}

function twoGameState(): DirectorState {
  const state = directorFixture();
  state.games.push(
    game('game-hist-1', 'game-5-1', 'team-1', 'team-2', 'team-1-player-1', 'team-2-player-1'),
    game('game-hist-2', 'game-5-2', 'team-3', 'team-4', 'team-3-player-1', 'team-4-player-1'),
  );
  return state;
}

describe('SQBS historical references (#893)', () => {
  test('a team dropped after playing stays in the final export with its games', () => {
    const state = twoGameState();
    const team = state.teams.find((entry) => entry.id === 'team-2');
    if (!team) throw new Error('fixture: no team-2');
    team.status = 'dropped';

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.teams.map((entry) => entry.name)).toContain('Greenwood A');
    expect(parsed.value.games).toHaveLength(2);
    // Historical W/L facts are unchanged by the visibility state.
    for (const sqbsGame of parsed.value.games) {
      expect([sqbsGame.left.score, sqbsGame.right.score]).toEqual([215, 195]);
    }
  });

  test('a player deactivated after playing keeps roster slot and stats', () => {
    const state = twoGameState();
    const player = state.players.find((entry) => entry.id === 'team-1-player-1');
    if (!player) throw new Error('fixture: no team-1-player-1');
    player.active = false;

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const home = parsed.value.teams.find((entry) => entry.name === 'Ninety Six A')!;
    expect(home.players.map((entry) => entry.name)).toContain('Ninety Six A player 1');
    const played = parsed.value.games.find(
      (entry) => entry.left.teamIndex === parsed.value.teams.indexOf(home),
    )!;
    expect(played.left.players).toHaveLength(1);
    // Current roster order first, then the historical referenced player.
    expect(played.left.players[0]).toMatchObject({ playerIndex: 3, points: 65 });
  });

  test('a renamed player keeps canonical identity with correct game references', () => {
    const state = twoGameState();
    const player = state.players.find((entry) => entry.id === 'team-1-player-1');
    if (!player) throw new Error('fixture: no team-1-player-1');
    player.name = 'Ninety Six A newcomer';

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const home = parsed.value.teams.find((entry) => entry.name === 'Ninety Six A')!;
    expect(home.players.map((entry) => entry.name)).toContain('Ninety Six A newcomer');
    const played = parsed.value.games.find(
      (entry) => entry.left.teamIndex === parsed.value.teams.indexOf(home),
    )!;
    expect(played.left.players[0]!.playerIndex).toBe(0);
  });

  test('more than eight actual participants on one side still blocks', () => {
    const state = twoGameState();
    for (let seat = 5; seat <= 10; seat += 1) {
      state.players.push({
        id: `team-1-player-${seat}`,
        teamId: 'team-1',
        name: `Ninety Six A player ${seat}`,
        captain: false,
        active: true,
      });
    }
    const target = state.games.find((entry) => entry.id === 'game-hist-1');
    if (!target) throw new Error('fixture: no game-hist-1');
    target.playerStats = Array.from({ length: 9 }, (_, index) => ({
      playerId: `team-1-player-${index + 1}`,
      teamId: 'team-1',
      superpowers: 0,
      powers: 0,
      gets: 1,
      negs: 0,
      bonusPoints: 0,
      tossupsHeard: 20,
    }));

    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(false);
    expect(exported.errors.join('\n')).toMatch(/at most 8 players/);
  });

  test('a large roster exports when each game uses at most eight', () => {
    const state = twoGameState();
    for (let seat = 5; seat <= 12; seat += 1) {
      state.players.push({
        id: `team-1-player-${seat}`,
        teamId: 'team-1',
        name: `Ninety Six A player ${seat}`,
        captain: false,
        active: true,
      });
    }
    const exported = exportSqbsTournament(state, {});
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.teams[0]!.players).toHaveLength(12);
    expect(parsed.value.games[0]!.left.players).toHaveLength(1);
  });
});
