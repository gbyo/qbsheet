import { describe, expect, test } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { newRoom, publishableRooms } from './rooms';
import { phasePoolNames, phaseTeamPoolContext, roundGroups, schedulePairingWarnings } from './schedule';

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

  test('uses the real two-pool source evidence for both six-team carryover pools', () => {
    const round = tournament.rounds.find((entry) => entry.phaseName === 'Playoffs')!;
    const playoffs = tournament.schedule.phases.find((phase) => phase.name === 'Playoffs')!;
    for (const pool of playoffs.pools) {
      let conflicts = 0;
      let newGames = 0;
      for (let left = 0; left < pool.teamIds.length; left += 1) {
        for (let right = left + 1; right < pool.teamIds.length; right += 1) {
          const room = {
            ...newRoom('room-1', 'Room 101', '11112222'),
            leftTeamId: pool.teamIds[left]!,
            rightTeamId: pool.teamIds[right]!,
          };
          const warning = schedulePairingWarnings(tournament, round, [room]).some((entry) =>
            entry.message.includes('already satisfied by carryover'),
          );
          if (warning) conflicts += 1;
          else newGames += 1;
        }
      }
      expect([pool.name, conflicts, newGames]).toEqual([pool.name, 6, 9]);
    }
  });

  test('shows source provenance and stays conservative when it is not provable', () => {
    const round = tournament.rounds.find((entry) => entry.phaseName === 'Playoffs')!;
    const context = phaseTeamPoolContext(tournament, round, 'Team_Windham A');
    expect(context).toMatchObject({
      destinationPoolNames: ['Championship'],
      carryover: true,
      sourcePhaseName: 'Prelims',
      sourcePoolNames: ['Prelim A'],
    });

    const phases = tournament.schedule.phases.map((phase, index) =>
      index === 0
        ? {
            ...phase,
            pools: phase.pools.map((pool, poolIndex) =>
              poolIndex === 1 ? { ...pool, teamIds: [...pool.teamIds, 'Team_Windham A'] } : pool,
            ),
          }
        : phase,
    );
    const room = {
      ...newRoom('room-1', 'Room 101', '11112222'),
      leftTeamId: 'Team_Windham A',
      rightTeamId: 'Team_Hebron Academy',
    };
    expect(
      schedulePairingWarnings({ schedule: { phases } }, round, [room]).some((entry) =>
        entry.message.includes('carryover'),
      ),
    ).toBe(false);

    const withoutCarryover = tournament.schedule.phases.map((phase) =>
      phase.id === round.phaseId
        ? { ...phase, pools: phase.pools.map((pool) => ({ ...pool, hasCarryover: false })) }
        : phase,
    );
    expect(
      schedulePairingWarnings({ schedule: { phases: withoutCarryover } }, round, [room]).some((entry) =>
        entry.message.includes('carryover'),
      ),
    ).toBe(false);
  });
});
