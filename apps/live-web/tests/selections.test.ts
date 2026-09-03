import { describe, expect, test } from 'vitest';
import { parseSnapshot, type QbliveSnapshot } from '@qbsheet/qblive-protocol';
import defaultSnapshot from '@qbsheet/qblive-protocol/fixtures/snapshot-default.json';
import { restoreSelections } from '../src/state/selections';

function snapshotWithTeams(teams: QbliveSnapshot['teams']): QbliveSnapshot {
  const base = parseSnapshot(defaultSnapshot);
  return { ...base, teams };
}

const teamsWithRosters: QbliveSnapshot['teams'] = [
  {
    id: 'team-a',
    name: 'Ninety Six A',
    organization: 'Ninety Six',
    seed: 1,
    players: [
      { id: 'player-a1', name: 'Ava', teamId: 'team-a' },
      { id: 'player-a2', name: 'Ari', teamId: 'team-a' },
    ],
  },
  {
    id: 'team-b',
    name: 'Ninety Six B',
    organization: 'Ninety Six',
    seed: 2,
    players: [{ id: 'player-b1', name: 'Bea', teamId: 'team-b' }],
  },
];

describe('live-web selection restore', () => {
  test('a withdrawn followed team clears both team and player', () => {
    const snapshot = snapshotWithTeams(teamsWithRosters.filter((team) => team.id !== 'team-a'));
    expect(restoreSelections({ followedTeamId: 'team-a', selectedPlayerId: 'player-a1' }, snapshot)).toEqual({
      followedTeamId: null,
      selectedPlayerId: null,
    });
  });

  test('a vanished selected player clears while the team survives', () => {
    const snapshot = snapshotWithTeams(
      teamsWithRosters.map((team) =>
        team.id === 'team-a'
          ? { ...team, players: team.players?.filter((player) => player.id !== 'player-a1') }
          : team,
      ),
    );
    expect(restoreSelections({ followedTeamId: 'team-a', selectedPlayerId: 'player-a1' }, snapshot)).toEqual({
      followedTeamId: 'team-a',
      selectedPlayerId: null,
    });
  });

  test('a player from another team does not belong to the followed team', () => {
    expect(
      restoreSelections(
        { followedTeamId: 'team-a', selectedPlayerId: 'player-b1' },
        snapshotWithTeams(teamsWithRosters),
      ),
    ).toEqual({ followedTeamId: 'team-a', selectedPlayerId: null });
  });

  test('a matching team and player survive untouched', () => {
    expect(
      restoreSelections(
        { followedTeamId: 'team-a', selectedPlayerId: 'player-a1' },
        snapshotWithTeams(teamsWithRosters),
      ),
    ).toEqual({ followedTeamId: 'team-a', selectedPlayerId: 'player-a1' });
  });

  test('an unpublished roster cannot validate a stale player', () => {
    const snapshot = snapshotWithTeams(teamsWithRosters.map(({ players: _dropped, ...team }) => team));
    expect(restoreSelections({ followedTeamId: 'team-a', selectedPlayerId: 'player-a1' }, snapshot)).toEqual({
      followedTeamId: 'team-a',
      selectedPlayerId: null,
    });
  });

  test('no snapshot leaves the selection alone', () => {
    const selection = { followedTeamId: 'team-a', selectedPlayerId: 'player-a1' };
    expect(restoreSelections(selection, null)).toBe(selection);
  });
});
