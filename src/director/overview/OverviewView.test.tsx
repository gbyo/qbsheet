/**
 * `Current leaders` leads with somebody who has led something.
 *
 * `deriveTeamStandings` seeds a 0–0 row for every confirmed team, and this panel ranked the raw
 * list. A director who had entered a field and no results saw a numbered leaderboard of teams that
 * had not played a game — a ranking derived from nothing, which is exactly what the Director's
 * eighth principle says never to draw.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorNavigationTarget } from '../app/navigationTarget';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { playedTournament, team, tournamentState } from '../../../tests/directorFixtures';
import { OverviewView } from './OverviewView';

afterEach(cleanup);

function controllerFor(state: DirectorState): DirectorController {
  return { state, error: null, saving: false, repositoryKind: 'memory' } as unknown as DirectorController;
}

function draw(
  state: DirectorState,
  onNavigate = vi.fn<(section: string, target?: DirectorNavigationTarget | null) => void>(),
) {
  render(
    <OverviewView
      state={state}
      controller={controllerFor(state)}
      onNavigate={onNavigate as OverviewViewParameters['onNavigate']}
      onAnnounce={vi.fn()}
    />,
  );
  return onNavigate;
}

type OverviewViewParameters = Parameters<typeof OverviewView>[0];

function leaderList(): HTMLElement | null {
  return document.querySelector('.director-leader-list');
}

test('a field with no accepted results is not ranked', () => {
  const state = tournamentState();
  state.teams.push(team('team-a', 'Ninety Six'), team('team-b', 'Greenwood'));

  draw(state);

  expect(leaderList()).toBeNull();
  expect(screen.getByText('Accepted results will appear here.')).toBeTruthy();
});

test('teams that have not played are left out of a leaderboard that has real results', () => {
  const state = playedTournament();
  state.teams.push(team('team-c', 'Abbeville'));

  draw(state);

  const list = leaderList() as HTMLElement;
  expect(within(list).getByText('Ninety Six')).toBeTruthy();
  expect(within(list).getByText('Greenwood')).toBeTruthy();
  expect(within(list).queryByText('Abbeville')).toBeNull();
});

test('next-round readiness uses canonical operations data and deep-links its first bottleneck', () => {
  const state = tournamentState();
  state.rounds[0]!.dayOrder = 1;
  state.teams.push(
    team('team-a', 'Aiken'),
    team('team-b', 'Lakeside'),
    team('team-c', 'Jefferson'),
    team('team-d', 'Hoover'),
  );
  state.rooms.push({
    id: 'room-201',
    name: 'Room 201',
    status: 'available',
    moderatorId: 'staff-moderator',
    scorekeeperId: null,
    equipmentId: null,
    defaultEquipmentIds: [],
    available: true,
  });
  state.staff.push(
    { id: 'staff-moderator', name: 'Alice', roles: ['moderator'], available: true },
    { id: 'staff-scorekeeper', name: 'Bob', roles: ['scorekeeper'], available: true },
  );
  state.rounds.push({
    id: 'round-2',
    phaseId: 'phase-1',
    name: 'Round 2',
    number: 2,
    revision: 1,
    status: 'planned',
    packetId: null,
    scheduledGameIds: ['game-2'],
    dayOrder: 2,
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  });
  state.scheduledGames.push({
    id: 'game-2',
    roundId: 'round-2',
    poolId: null,
    roomId: 'room-201',
    packetId: null,
    leftTeamId: 'team-c',
    rightTeamId: 'team-d',
    bye: false,
    status: 'scheduled',
    assignmentRevision: 1,
  });

  const onNavigate = draw(state);

  expect(screen.getByText('Next-round readiness')).toBeTruthy();
  expect(screen.getByText('1/1 rooms assigned')).toBeTruthy();
  expect(screen.getByText('1/2 staff positions filled')).toBeTruthy();
  expect(screen.getByText('Room 201 needs a scorekeeper for Round 2.')).toBeTruthy();

  fireEvent.click(screen.getAllByRole('button', { name: 'Assign scorekeeper' })[0]!);
  expect(onNavigate).toHaveBeenCalledWith(
    'rooms',
    expect.objectContaining({
      section: 'rooms',
      entityType: 'game',
      entityId: 'game-2',
      parentId: 'round-2',
    }),
  );
});
