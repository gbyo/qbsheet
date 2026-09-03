/**
 * The two things Results has to get right when a tournament is busy.
 *
 * Rejecting used to be a single click on a row a director is scanning at speed — the destructive
 * half of an Accept/Reject pair, with no way to say why and no step between the press and the audit
 * entry. And the schedule panel listed every game ever scheduled, so by the afternoon the three
 * rooms that had not reported were buried in two hundred that had.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import type { DirectorController } from '../state/useDirectorController';
import { acceptedGame, playedTournament, scheduledGame, score } from '../../../tests/directorFixtures';
import { ResultsView } from './ResultsView';

afterEach(cleanup);

function stateForReview(): DirectorState {
  const state = playedTournament();
  state.games[0].status = 'submitted';
  state.scheduledGames[0].status = 'submitted';
  state.submissions.push({
    id: 'submission-1',
    gameId: 'game-1',
    receivedAt: '2026-09-05T14:00:00.000Z',
    fingerprint: 'fingerprint-1',
    status: 'review',
    rawSubmission: {},
  });
  return state;
}

function controllerWith(overrides: Partial<DirectorController> = {}): DirectorController {
  return {
    acceptSubmission: vi.fn(() => true),
    rejectSubmission: vi.fn(() => true),
    ...overrides,
  } as unknown as DirectorController;
}

describe('rejecting a result', () => {
  test('the first press asks rather than rejecting', () => {
    const controller = controllerWith();
    render(<ResultsView state={stateForReview()} controller={controller} onAnnounce={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));

    expect(controller.rejectSubmission).not.toHaveBeenCalled();
    expect(screen.getByText('Reject this result')).toBeTruthy();
  });

  test('Cancel leaves the submission exactly as it was', () => {
    const controller = controllerWith();
    render(<ResultsView state={stateForReview()} controller={controller} onAnnounce={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(controller.rejectSubmission).not.toHaveBeenCalled();
    expect(screen.queryByText('Reject this result')).toBeNull();
  });

  test('confirming rejects it', () => {
    const controller = controllerWith();
    render(<ResultsView state={stateForReview()} controller={controller} onAnnounce={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject result' }));

    expect(controller.rejectSubmission).toHaveBeenCalledTimes(1);
    expect(controller.rejectSubmission).toHaveBeenCalledWith('submission-1', undefined);
  });

  test('a typed reason reaches the controller', () => {
    const controller = controllerWith();
    render(<ResultsView state={stateForReview()} controller={controller} onAnnounce={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByPlaceholderText('Scores transposed; room is re-entering'), {
      target: { value: '  Scores transposed  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject result' }));

    expect(controller.rejectSubmission).toHaveBeenCalledWith('submission-1', 'Scores transposed');
  });
});

describe('the scheduled games panel', () => {
  /** One game still out in a room, one already accepted, one cancelled. */
  function stateWithMixedSchedule(): DirectorState {
    const state = playedTournament();
    state.scheduledGames.push(
      scheduledGame('scheduled-2', 'team-a', 'team-b', { status: 'live' }),
      scheduledGame('scheduled-3', 'team-a', 'team-b', { status: 'cancelled' }),
    );
    state.games.push(acceptedGame('game-2', 'scheduled-2', [score('team-a', 10), score('team-b', 20)]));
    return state;
  }

  function scheduleRows(): string[] {
    const panel = screen.getByText('Scheduled games').closest('.director-panel') as HTMLElement;
    return within(panel)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
  }

  test('games that still need attention are what the panel opens on', () => {
    render(
      <ResultsView state={stateWithMixedSchedule()} controller={controllerWith()} onAnnounce={vi.fn()} />,
    );

    const rows = scheduleRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('scheduled-2');
    expect(screen.getByText('1 unresolved of 3')).toBeTruthy();
  });

  test('the settled games are one press away, not gone', () => {
    render(
      <ResultsView state={stateWithMixedSchedule()} controller={controllerWith()} onAnnounce={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show all scheduled games' }));

    expect(scheduleRows()).toHaveLength(3);
    // And back again, so the default is a filter rather than a one-way door.
    fireEvent.click(screen.getByRole('button', { name: 'Show only unresolved' }));
    expect(scheduleRows()).toHaveLength(1);
  });
});

test('open protests are counted where a director is already looking', () => {
  const state = playedTournament();
  state.protests.push({
    id: 'protest-1',
    gameId: 'game-1',
    category: 'tossup',
    description: 'Answer was equivalent',
    status: 'open',
    createdAt: '2026-09-05T14:10:00.000Z',
    updatedAt: '2026-09-05T14:10:00.000Z',
  });

  render(<ResultsView state={state} controller={controllerWith()} onAnnounce={vi.fn()} />);

  expect(screen.getByText(/1 open protest ·/)).toBeTruthy();
  // The panel itself is still there with the protest in it.
  expect(screen.getByText('Answer was equivalent', { exact: false })).toBeTruthy();
});
