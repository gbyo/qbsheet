import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { emptyDirectorState, type DirectorState } from '../src/director/domain';
import { RecommendedPlan } from '../src/director/format/RecommendedPlan';
import type { DirectorController } from '../src/director/state/useDirectorController';

function confirmedTeam(id: string): DirectorState['teams'][number] {
  return {
    id,
    organizationId: null,
    displayName: id,
    teamLetter: '',
    seed: null,
    status: 'confirmed',
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
}

function teamState(count: number): DirectorState {
  const state = emptyDirectorState();
  state.teams = Array.from({ length: count }, (_, index) => confirmedTeam(`team-${index + 1}`));
  return state;
}

function renderPlan(state: DirectorState, applyTournamentPlan = vi.fn(() => true)) {
  const controller = { applyTournamentPlan } as unknown as DirectorController;
  const onNavigate = vi.fn();
  const onAnnounce = vi.fn();
  render(
    <RecommendedPlan state={state} controller={controller} onNavigate={onNavigate} onAnnounce={onAnnounce} />,
  );
  return { applyTournamentPlan, onNavigate, onAnnounce };
}

describe('RecommendedPlan', () => {
  test('ten teams see the full round robin with an honest round count', () => {
    renderPlan(teamState(10));

    expect(screen.getByRole('heading', { name: 'Full round robin' })).toBeTruthy();
    expect(screen.getByText('9 rounds · 9 games per team')).toBeTruthy();
    // The summary and the first consequence share this wording.
    expect(screen.getAllByText('Every team plays every other team once.')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Use this plan' })).toBeTruthy();
    expect(screen.getByText('Other formats')).toBeTruthy();
  });

  test('Use this plan applies the recommendation and goes to Rounds', () => {
    const { applyTournamentPlan, onNavigate, onAnnounce } = renderPlan(teamState(10));

    fireEvent.click(screen.getByRole('button', { name: 'Use this plan' }));
    expect(applyTournamentPlan).toHaveBeenCalledTimes(1);
    expect(applyTournamentPlan).toHaveBeenCalledWith(expect.objectContaining({ id: 'full-round-robin' }));
    expect(onNavigate).toHaveBeenCalledWith('schedule');
    expect(onAnnounce).toHaveBeenCalledTimes(1);
  });

  test('one team is too small a field for a recommendation', () => {
    const { container } = render(
      <RecommendedPlan
        state={teamState(1)}
        controller={{} as DirectorController}
        onNavigate={vi.fn()}
        onAnnounce={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test('panel disappears once pairings exist so it cannot wipe them', () => {
    const state = teamState(10);
    state.scheduledGames = [
      {
        id: 'game-1',
        roundId: 'round-1',
        poolId: null,
        roomId: null,
        packetId: null,
        leftTeamId: 'team-1',
        rightTeamId: 'team-2',
        bye: false,
        status: 'scheduled',
        assignmentRevision: 1,
      },
    ];
    const { container } = render(
      <RecommendedPlan
        state={state}
        controller={{} as DirectorController}
        onNavigate={vi.fn()}
        onAnnounce={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
