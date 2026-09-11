/**
 * Issue #671 (remainder): the SQBS tournament export must derive every
 * historical game from its own pinned scoring definition, never from today's
 * tournament defaults.
 *
 * Fixture: Round 1 was issued and played with power=15, Round 2 with
 * power=20 (plus bouncebacks), while the live tournament defaults were later
 * mutated to power=25 with no bouncebacks. The export of each historical game
 * must preserve its own answer values, slots, and per-player points, and must
 * not move when defaults change again.
 */

import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import { defaultRules } from '../domain';
import {
  acceptedGame,
  player,
  playerStat,
  scheduledGame,
  score,
  team,
  tournamentState,
} from '../../../tests/directorFixtures';
import type { DirectorState } from '../domain';
import { exportSqbsTournament } from './interchange';

function twoDefinitionState(): DirectorState {
  const state = tournamentState();
  // Live defaults have moved on since these games were played.
  state.tournament!.rules = { ...defaultRules, powerValue: 25 };
  state.teams.push(team('team-a', 'Alpha'), team('team-b', 'Beta'));
  state.players.push(player('player-a', 'team-a', 'Alice'), player('player-b', 'team-b', 'Bob'));
  const phase = state.phases[0]!;
  phase.roundIds = ['round-1', 'round-2'];
  state.rounds.push({
    id: 'round-2',
    phaseId: 'phase-1',
    name: 'Round 2',
    number: 2,
    revision: 1,
    status: 'released',
    packetId: null,
    scheduledGameIds: ['scheduled-2'],
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  });
  state.rounds[0]!.scheduledGameIds = ['scheduled-1'];
  state.scheduledGames.push(
    scheduledGame('scheduled-1', 'team-a', 'team-b'),
    scheduledGame('scheduled-2', 'team-a', 'team-b', { roundId: 'round-2' }),
  );
  const rulesRound1 = { ...defaultRules, powerValue: 15 };
  const rulesRound2 = { ...defaultRules, powerValue: 20, bouncebacks: true };
  state.gameDefinitions.push(
    {
      id: 'definition-1',
      scheduledGameId: 'scheduled-1',
      revision: 1,
      createdAt: '2026-09-05T12:00:00.000Z',
      rules: rulesRound1,
      roundId: 'round-1',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      leftRoster: [],
      rightRoster: [],
      assignmentRevision: 1,
      digest: 'digest-round-1',
    },
    {
      id: 'definition-2',
      scheduledGameId: 'scheduled-2',
      revision: 1,
      createdAt: '2026-09-05T12:00:00.000Z',
      rules: rulesRound2,
      roundId: 'round-2',
      packetId: null,
      leftTeamId: 'team-a',
      rightTeamId: 'team-b',
      leftRoster: [],
      rightRoster: [],
      assignmentRevision: 1,
      digest: 'digest-round-2',
    },
  );
  state.games.push(
    acceptedGame(
      'game-1',
      'scheduled-1',
      [
        score('team-a', 320, { powers: 2, gets: 5, negs: 0, bonuses: 7, bonusPoints: 140 }),
        score('team-b', 200, { powers: 0, gets: 4, negs: 1, bonuses: 4, bonusPoints: 80 }),
      ],
      [
        playerStat('player-a', 'team-a', { powers: 2, gets: 5, tossupsHeard: 20 }),
        playerStat('player-b', 'team-b', { gets: 4, negs: 1, tossupsHeard: 20 }),
      ],
      { tossupsRead: 20, definitionDigest: 'digest-round-1' },
    ),
    acceptedGame(
      'game-2',
      'scheduled-2',
      [
        score('team-a', 300, { powers: 1, gets: 6, negs: 0, bonuses: 7, bonusPoints: 140, bouncebacks: 30 }),
        score('team-b', 240, { powers: 0, gets: 7, negs: 0, bonuses: 7, bonusPoints: 140, bouncebacks: 10 }),
      ],
      [
        playerStat('player-a', 'team-a', { powers: 1, gets: 6, tossupsHeard: 20 }),
        playerStat('player-b', 'team-b', { gets: 7, tossupsHeard: 20 }),
      ],
      { tossupsRead: 20, roundId: 'round-2', definitionDigest: 'digest-round-2' },
    ),
  );
  return state;
}

describe('SQBS export uses each game\u2019s own definition (#671)', () => {
  test('powers map to their own game\u2019s slot and price', () => {
    const exported = exportSqbsTournament(twoDefinitionState(), {});
    expect(exported.ok).toBe(true);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('export did not parse');
    // Slots follow the games in export order: 15 (round 1), then 10, -5,
    // then 20 (round 2).
    expect(parsed.value.pointValues).toEqual([15, 10, -5, 20]);
    const teamByName = new Map(parsed.value.teams.map((entry, index) => [entry.name, index]));
    const gameByRound = new Map(parsed.value.games.map((game) => [game.round, game]));
    const alice = parsed.value.teams[teamByName.get('Alpha')!]!.players.findIndex(
      (entry) => entry.name === 'Alice',
    );
    const round1 = gameByRound.get(1)!;
    const round1Alice = round1.left.teamIndex === teamByName.get('Alpha') ? round1.left : round1.right;
    expect(round1Alice.players[alice]!.counts).toEqual([2, 5, 0, 0]);
    // Two 15-point powers plus five 10-point gets.
    expect(round1Alice.players[alice]!.points).toBe(80);
    const round2 = gameByRound.get(2)!;
    const round2Alice = round2.left.teamIndex === teamByName.get('Alpha') ? round2.left : round2.right;
    expect(round2Alice.players[alice]!.counts).toEqual([0, 6, 0, 1]);
    // One 20-point power plus six 10-point gets: repriced by neither the
    // round-1 definition nor today's default of 25.
    expect(round2Alice.players[alice]!.points).toBe(80);
  });

  test('bonus and bounceback applicability follow each game\u2019s definition', () => {
    const exported = exportSqbsTournament(twoDefinitionState(), {});
    expect(exported.ok).toBe(true);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('export did not parse');
    // One game uses bouncebacks, so the file carries the section; the
    // no-bounceback game contributes no bounceback points.
    expect(parsed.value.bouncebacks).toBe(true);
    const gameByRound = new Map(parsed.value.games.map((game) => [game.round, game]));
    expect(gameByRound.get(1)!.left.bouncebackPoints).toBe(0);
    expect(gameByRound.get(2)!.left.bouncebackPoints).toBe(30);
    expect(gameByRound.get(2)!.right.bouncebackPoints).toBe(10);
  });

  test('mutating future defaults leaves the historical export byte-identical', () => {
    const state = twoDefinitionState();
    const before = exportSqbsTournament(state, {});
    expect(before.ok).toBe(true);
    state.tournament!.rules = {
      ...defaultRules,
      powerValue: 30,
      tossupValue: 12,
      negValue: -10,
      bonusValue: 5,
      useBonuses: false,
      bouncebacks: true,
    };
    const after = exportSqbsTournament(state, {});
    expect(after.ok).toBe(true);
    expect(after.text).toBe(before.text);
  });
});
