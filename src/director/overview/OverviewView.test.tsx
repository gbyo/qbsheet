/**
 * `Current leaders` leads with somebody who has led something.
 *
 * `deriveTeamStandings` seeds a 0–0 row for every confirmed team, and this panel ranked the raw
 * list. A director who had entered a field and no results saw a numbered leaderboard of teams that
 * had not played a game — a ranking derived from nothing, which is exactly what the Director's
 * eighth principle says never to draw.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { playedTournament, team, tournamentState } from '../../../tests/directorFixtures';
import { OverviewView } from './OverviewView';

afterEach(cleanup);

function controllerFor(state: DirectorState): DirectorController {
  return { state, error: null, saving: false, repositoryKind: 'memory' } as unknown as DirectorController;
}

function draw(state: DirectorState) {
  render(
    <OverviewView
      state={state}
      controller={controllerFor(state)}
      onNavigate={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
}

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
