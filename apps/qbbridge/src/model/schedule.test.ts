import { describe, expect, test } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { newRoom, publishableRooms } from './rooms';
import { phasePoolNames, roundGroups, schedulePairingWarnings } from './schedule';

describe('manual pairing schedule context', () => {
  const tournament = loadedFixture();

  test('groups the imported rounds by phase without changing their QBJ names', () => {
    expect(
      roundGroups(tournament).map((group) => [group.label, group.rounds.map((round) => round.qbjName)]),
    ).toEqual([
      ['Prelims', ['1', '2', '3', '4', '5']],
      ['Playoffs', ['6', '7', '8']],
    ]);
  });

  test('warns about a cross-pool pairing while keeping it publishable', () => {
    const prelims = tournament.schedule.phases.find((phase) => phase.name === 'Prelims');
    const leftTeamId = prelims?.pools[0]?.teamIds[0];
    const rightTeamId = prelims?.pools[1]?.teamIds[0];
    expect(leftTeamId).toBeTruthy();
    expect(rightTeamId).toBeTruthy();
    if (!leftTeamId || !rightTeamId) return;

    const rooms = [{ ...newRoom('room-1', 'Room 101', '11112222'), leftTeamId, rightTeamId }];
    const warnings = schedulePairingWarnings(tournament, tournament.rounds[0], rooms);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(/crosses pools/);
    expect(publishableRooms(rooms)).toHaveLength(1);
  });

  test('keeps phase-specific pool membership honest after a reload', () => {
    const prelims = tournament.schedule.phases.find((phase) => phase.name === 'Prelims');
    const playoffs = tournament.schedule.phases.find((phase) => phase.name === 'Playoffs');
    const teamId = prelims?.pools[0]?.teamIds[0];
    expect(teamId).toBeTruthy();
    if (!teamId || !playoffs) return;

    // The playoff file can be reloaded before YellowFruit has populated its resulting pools. The
    // empty phase has no membership to display, so the UI must not borrow the prelim pool.
    const emptyPlayoffs = { ...playoffs, pools: playoffs.pools.map((pool) => ({ ...pool, teamIds: [] })) };
    expect(phasePoolNames(emptyPlayoffs, teamId)).toEqual([]);
    expect(phasePoolNames(prelims, teamId)).toHaveLength(1);
  });
});
