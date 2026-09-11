/**
 * Issue #895: canonical exhibition-team semantics and the SQBS exhibition flag.
 *
 * Director has one canonical statistical policy, matching conventional SQBS
 * treatment: an exhibition team plays a full schedule and keeps its own
 * competitive aggregates, but games against an exhibition team never inflate
 * the non-exhibition opponent's record or individual statistics. Raw game
 * facts stay visible, exhibition teams cannot qualify on results, and the
 * native exhibition state travels on the SQBS wire as the per-team 1/0 flag.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
import {
  acceptedGame,
  player,
  playerStat,
  scheduledGame,
  score,
  team,
  tournamentState,
} from '../../../tests/directorFixtures';
import {
  acceptedGameRecords,
  advancementBasisToken,
  derivePlayerStandings,
  deriveTeamStandings,
  previewAdvancement,
  type DirectorState,
} from '../domain';
import { MemoryDirectorRepository } from '../persistence';
import { useDirectorController } from '../state/useDirectorController';
import { exportSqbsTournament } from './interchange';

function exhibitionState(): DirectorState {
  const state = tournamentState();
  state.teams.push(
    team('team-a', 'Alpha'),
    team('team-b', 'Beta'),
    { ...team('team-e1', 'Exhibition One'), status: 'exhibition' },
    { ...team('team-e2', 'Exhibition Two'), status: 'exhibition' },
  );
  state.players.push(
    player('player-a', 'team-a', 'Alice'),
    player('player-b', 'team-b', 'Bob'),
    player('player-e1', 'team-e1', 'Exene'),
    player('player-e2', 'team-e2', 'Exra'),
  );
  state.pools.push(
    { id: 'pool-1', phaseId: 'phase-1', name: 'Pool 1', teamIds: ['team-a', 'team-e1'], order: 0 },
    { id: 'pool-2', phaseId: 'phase-1', name: 'Pool 2', teamIds: ['team-b', 'team-e2'], order: 1 },
  );
  const phase = state.phases[0]!;
  phase.poolIds = ['pool-1', 'pool-2'];
  phase.advancementRule = {
    qualifiersPerPool: 1,
    wildcards: 0,
    tiebreakers: state.tournament!.rules.tiebreakers,
    manualOverrideAllowed: false,
  };
  state.scheduledGames.push(
    scheduledGame('scheduled-1', 'team-a', 'team-b'),
    scheduledGame('scheduled-2', 'team-e1', 'team-a', { poolId: 'pool-1' }),
    scheduledGame('scheduled-3', 'team-e1', 'team-e2'),
  );
  const detail = { powers: 1, gets: 6, negs: 0, bonuses: 7, bonusPoints: 140 };
  state.games.push(
    acceptedGame(
      'game-1',
      'scheduled-1',
      [
        score('team-a', 300, detail),
        score('team-b', 200, { ...detail, powers: 0, gets: 4, negs: 1, bonuses: 4, bonusPoints: 80 }),
      ],
      [
        playerStat('player-a', 'team-a', { powers: 1, gets: 6, tossupsHeard: 20 }),
        playerStat('player-b', 'team-b', { gets: 4, negs: 1, tossupsHeard: 20 }),
      ],
      { tossupsRead: 20 },
    ),
    acceptedGame(
      'game-2',
      'scheduled-2',
      [score('team-e1', 320, { ...detail, gets: 8 }), score('team-a', 280, { ...detail, gets: 5 })],
      [
        playerStat('player-e1', 'team-e1', { gets: 8, tossupsHeard: 20 }),
        playerStat('player-a', 'team-a', { gets: 5, tossupsHeard: 20 }),
      ],
      { tossupsRead: 20 },
    ),
    acceptedGame(
      'game-3',
      'scheduled-3',
      [score('team-e1', 250, { ...detail, gets: 4 }), score('team-e2', 150, { ...detail, gets: 2 })],
      [
        playerStat('player-e1', 'team-e1', { gets: 4, tossupsHeard: 20 }),
        playerStat('player-e2', 'team-e2', { gets: 2, tossupsHeard: 20 }),
      ],
      { tossupsRead: 20 },
    ),
  );
  return state;
}

function standingById(state: DirectorState, teamId: string) {
  const standing = deriveTeamStandings(state).find((entry) => entry.teamId === teamId);
  if (!standing) throw new Error(`missing standings row for ${teamId}`);
  return standing;
}

describe('exhibition statistical semantics (#895)', () => {
  test('normal-vs-normal games count for both sides', () => {
    const state = exhibitionState();
    const beta = standingById(state, 'team-b');
    expect(beta.gamesPlayed).toBe(1);
    expect([beta.wins, beta.losses, beta.ties]).toEqual([0, 1, 0]);
    expect(beta.pointsFor).toBe(200);
    expect(beta.pointsAgainst).toBe(300);
    expect(beta.tossupsHeard).toBe(20);
  });

  test('an exhibition opponent does not inflate the competitive side', () => {
    const state = exhibitionState();
    const alpha = standingById(state, 'team-a');
    // Alpha beat Beta 300-200, then lost 280-320 to Exhibition One. Only the
    // Beta game counts for Alpha.
    expect([alpha.wins, alpha.losses, alpha.ties]).toEqual([1, 0, 0]);
    expect(alpha.gamesPlayed).toBe(1);
    expect(alpha.pointsFor).toBe(300);
    expect(alpha.pointsAgainst).toBe(200);
    expect(alpha.tossupsHeard).toBe(20);
    expect(alpha.bonuses).toBe(7);
    expect(alpha.bonusPoints).toBe(140);
    expect(alpha.powers).toBe(1);
    expect(alpha.gets).toBe(6);
    expect(alpha.negs).toBe(0);
  });

  test('the exhibition side keeps its own aggregates', () => {
    const state = exhibitionState();
    const exOne = standingById(state, 'team-e1');
    expect([exOne.wins, exOne.losses, exOne.ties]).toEqual([2, 0, 0]);
    expect(exOne.gamesPlayed).toBe(2);
    expect(exOne.pointsFor).toBe(570);
    expect(exOne.pointsAgainst).toBe(430);
    expect(exOne.tossupsHeard).toBe(40);
  });

  test('exhibition-vs-exhibition games count for both sides', () => {
    const state = exhibitionState();
    const exTwo = standingById(state, 'team-e2');
    expect([exTwo.wins, exTwo.losses, exTwo.ties]).toEqual([0, 1, 0]);
    expect(exTwo.gamesPlayed).toBe(1);
    expect(exTwo.pointsFor).toBe(150);
    expect(exTwo.pointsAgainst).toBe(250);
  });

  test('individual totals follow the same side-specific policy', () => {
    const state = exhibitionState();
    const byPlayer = new Map(derivePlayerStandings(state).map((entry) => [entry.playerId, entry]));
    // Alice scored 6 gets against Beta and 5 against Exhibition One; only the
    // Beta line counts.
    expect(byPlayer.get('player-a')?.gets).toBe(6);
    expect(byPlayer.get('player-a')?.powers).toBe(1);
    expect(byPlayer.get('player-a')?.tossupsHeard).toBe(20);
    expect(byPlayer.get('player-a')?.gamesPlayed).toBe(1);
    expect(byPlayer.get('player-a')?.points).toBe(75);
    // Exene's lines count in both of her games.
    expect(byPlayer.get('player-e1')?.gets).toBe(12);
    expect(byPlayer.get('player-e1')?.tossupsHeard).toBe(40);
    expect(byPlayer.get('player-e1')?.gamesPlayed).toBe(2);
    expect(byPlayer.get('player-e1')?.points).toBe(120);
  });

  test('raw exhibition games remain visible in the accepted record set', () => {
    const state = exhibitionState();
    const games = acceptedGameRecords(state);
    expect(games.map((game) => game.id).sort()).toEqual(['game-1', 'game-2', 'game-3']);
    const mixed = games.find((game) => game.id === 'game-2')!;
    expect(mixed.scores.map((entry) => entry.teamId).sort()).toEqual(['team-a', 'team-e1']);
  });

  test('a mixed meeting decides no head-to-head tiebreak', () => {
    const state = exhibitionState();
    // Alpha (1-0) and Exhibition One (2-0) tie on record; their mutual game
    // must not break the tie for either side.
    const standings = deriveTeamStandings(state, undefined, { tiebreakers: ['record', 'head-to-head'] });
    expect(standings.map((entry) => entry.teamId)).toEqual(['team-a', 'team-e1', 'team-b', 'team-e2']);
    expect(standings.find((entry) => entry.teamId === 'team-a')?.headToHead).toBe(1);
    expect(standings.find((entry) => entry.teamId === 'team-e1')?.headToHead).toBe(1);
  });

  test('an exhibition team cannot qualify on results', () => {
    const state = exhibitionState();
    // Exhibition One tops Pool 1 on record (1-0 over Alpha's 0-0 in scope).
    const poolStandings = deriveTeamStandings(state, undefined, {
      phaseId: 'phase-1',
      poolId: 'pool-1',
      teamIds: ['team-a', 'team-e1'],
    });
    expect(poolStandings[0]?.teamId).toBe('team-e1');
    const preview = previewAdvancement(state, state.phases[0]!);
    expect(preview.qualifiers.map((entry) => entry.id)).not.toContain('team-e1');
    expect(preview.explanation.some((line) => line.includes('exhibition'))).toBe(true);
  });
});

describe('exhibition SQBS export (#895)', () => {
  test('native exhibition state maps to the per-team SQBS flag', () => {
    const exported = exportSqbsTournament(exhibitionState(), {});
    expect(exported.ok).toBe(true);
    const parsed = parseSqbsTournamentFile(exported.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('export did not parse');
    const flags = new Map(parsed.value.teams.map((entry) => [entry.name, entry.exhibition]));
    expect(flags.get('Alpha')).toBe(false);
    expect(flags.get('Beta')).toBe(false);
    expect(flags.get('Exhibition One')).toBe(true);
    expect(flags.get('Exhibition Two')).toBe(true);
    // The raw exhibition games travel in the file so SQBS can credit the
    // exhibition side itself.
    expect(parsed.value.games.length).toBe(3);
  });

  test('the wire flags match the documented per-team 1/0 layout', () => {
    const exported = exportSqbsTournament(exhibitionState(), {});
    expect(exported.ok).toBe(true);
    // Documented SQBS layout (qbwiki "SQBS data file"): the file ends with
    // one `1`/`0` line per team in team-index order. Team-index order is the
    // order team names appear in the roster section of the same text, so this
    // pins the serializer without using QBSheet's own parser as the oracle.
    const lines = exported.text.trimEnd().split('\n');
    const names = ['Alpha', 'Beta', 'Exhibition One', 'Exhibition Two'];
    const order = [...names].sort((left, right) => {
      const leftIndex = lines.findIndex((line) => line === left);
      const rightIndex = lines.findIndex((line) => line === right);
      if (leftIndex < 0 || rightIndex < 0) throw new Error('team name missing from SQBS text');
      return leftIndex - rightIndex;
    });
    const expected: Record<string, string> = {
      Alpha: '0',
      Beta: '0',
      'Exhibition One': '1',
      'Exhibition Two': '1',
    };
    const tail = lines.slice(-order.length);
    expect(tail.every((line) => line === '0' || line === '1')).toBe(true);
    expect(tail).toEqual(order.map((name) => expected[name]));
  });

  test('the parser maps hand-set flags to the correct teams', () => {
    const exported = exportSqbsTournament(exhibitionState(), {});
    expect(exported.ok).toBe(true);
    // Flip Alpha's flag in the raw text to a pattern the serializer never
    // emits, so the parse proves the flag-to-team mapping rather than a
    // self-round-trip.
    const lines = exported.text.trimEnd().split('\n');
    const names = ['Alpha', 'Beta', 'Exhibition One', 'Exhibition Two'];
    const order = [...names].sort(
      (left, right) => lines.findIndex((line) => line === left) - lines.findIndex((line) => line === right),
    );
    const flagLines = lines.slice(-order.length);
    flagLines[order.indexOf('Alpha')] = '1';
    const parsed = parseSqbsTournamentFile([...lines.slice(0, -order.length), ...flagLines].join('\n'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('edited export did not parse: ' + JSON.stringify(parsed.errors));
    const flags = new Map(parsed.value.teams.map((entry) => [entry.name, entry.exhibition]));
    expect(flags.get('Alpha')).toBe(true);
    expect(flags.get('Exhibition One')).toBe(true);
    expect(flags.get('Beta')).toBe(false);
    expect(flags.get('Exhibition Two')).toBe(true);
  });

  test('a scoped export retains flags when team ordering changes', () => {
    const state = exhibitionState();
    const full = exportSqbsTournament(state, {});
    expect(full.ok).toBe(true);
    const scoped = exportSqbsTournament(state, { poolId: 'pool-1' });
    expect(scoped.ok).toBe(true);
    const scopedParsed = parseSqbsTournamentFile(scoped.text);
    expect(scopedParsed.ok).toBe(true);
    if (!scopedParsed.ok) throw new Error('scoped export did not parse');
    const scopedFlags = new Map(scopedParsed.value.teams.map((entry) => [entry.name, entry.exhibition]));
    // Only the Alpha/Exhibition One game falls in Pool 1; the two-team export
    // reorders and reindexes teams but keeps each team's own flag.
    expect(scopedFlags.get('Alpha')).toBe(false);
    expect(scopedFlags.get('Exhibition One')).toBe(true);
    expect(scopedFlags.size).toBe(2);
  });
});

describe('exhibition status changes (#895)', () => {
  test('flipping exhibition state retires the verified advancement basis', () => {
    const state = exhibitionState();
    const phase = state.phases[0]!;
    const before = advancementBasisToken(state, phase);
    state.teams.find((entry) => entry.id === 'team-a')!.status = 'exhibition';
    expect(advancementBasisToken(state, phase)).not.toBe(before);
  });

  test('the controller flip is audited and invalidates dependent bases', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(exhibitionState());
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let changed = false;
    await act(async () => {
      changed = hook.result.current.setTeamExhibition('team-b', true);
    });
    expect(changed).toBe(true);
    const saved = await repository.load();
    expect(saved?.teams.find((entry) => entry.id === 'team-b')?.status).toBe('exhibition');
    const audit = saved?.audit.filter((entry) => entry.type === 'team-changed') ?? [];
    expect(audit.some((entry) => entry.summary.includes('marked as an exhibition team'))).toBe(true);
    // Re-marking an exhibition team is a no-op error, mirroring dropTeam.
    let already = true;
    await act(async () => {
      already = hook.result.current.setTeamExhibition('team-b', true);
    });
    expect(already).toBe(false);
    let invalid = false;
    await act(async () => {
      invalid = hook.result.current.setTeamExhibition('team-nope', true);
    });
    expect(invalid).toBe(false);
  });
});
