import { describe, expect, test } from 'vitest';
import { loadedFixture } from '../tests/fixture';
import { newRoom, publishableRooms } from './rooms';
import { phasePoolNames, planSuggestionPlacements, roundGroups, schedulePairingWarnings } from './schedule';

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

describe('concrete Match suggestion placement', () => {
  const suggestion = (overrides: Record<string, unknown> = {}) => ({
    id: 'match-1',
    roundId: 'round-1',
    phaseId: 'phase-1',
    teamIds: ['Team_A', 'Team_B'] as [string, string],
    ...overrides,
  });

  test('uses only an exact source location and stages an unlocated game', () => {
    const rooms = [newRoom('room-1', 'Room 101', '11112222'), newRoom('room-2', 'Room 102', '33334444')];
    const placements = planSuggestionPlacements(
      [suggestion({ id: 'unlocated' }), suggestion({ id: 'located', location: 'Room 102' })],
      rooms,
    );
    expect(
      placements.map((placement) => [placement.suggestion.id, placement.roomId, placement.status]),
    ).toEqual([
      ['unlocated', null, 'staged'],
      ['located', 'room-2', 'available'],
    ]);
  });

  test('stages a source game when its room is not configured and marks edits for confirmation', () => {
    const edited = {
      ...newRoom('room-1', 'Room 101', '11112222'),
      leftTeamId: 'Team_X',
      rightTeamId: 'Team_Y',
    };
    const placements = planSuggestionPlacements(
      [
        suggestion({ id: 'located', location: 'Gym 4' }),
        suggestion({ id: 'overwrite', location: 'Room 101' }),
      ],
      [edited],
    );
    expect(placements[0]).toMatchObject({ roomId: null, status: 'staged' });
    expect(placements[1]).toMatchObject({ roomId: 'room-1', status: 'overwrite' });
  });
});
