import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../src/director/domain';
import { StandingsView } from '../src/director/standings/StandingsView';
import type { DirectorController } from '../src/director/state/useDirectorController';

function tournamentState(): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-stats',
    name: 'Saturday Event',
    date: '2026-09-05',
    venue: 'Main hall',
    organizer: 'Director',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: null,
    currentPhaseId: null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  state.teams = [
    {
      id: 'team-a',
      organizationId: null,
      displayName: 'Aiken',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      classifications: ['small-school'],
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
    {
      id: 'team-b',
      organizationId: null,
      displayName: 'Wren',
      teamLetter: 'A',
      seed: null,
      status: 'confirmed',
      createdAt: '2026-09-05T10:00:00.000Z',
      updatedAt: '2026-09-05T10:00:00.000Z',
    },
  ];
  state.players = [
    {
      id: 'player-a1',
      teamId: 'team-a',
      name: 'A. Player',
      captain: true,
      active: true,
      schoolYear: 10,
    },
  ];
  state.rounds = [
    {
      id: 'round-1',
      name: 'Round 1',
      phaseId: 'phase-1',
      number: 1,
      packetId: null,
      revision: 1,
      status: 'closed',
      dayOrder: 0,
      scheduledStart: null,
      releasedAt: null,
      startedAt: null,
      closedAt: null,
      scheduledGameIds: [],
    },
  ];
  // Final score with no tossups-heard or player detail: standings stay
  // correct while detail columns render an honest unknown.
  state.games = [
    {
      id: 'game-1',
      scheduledGameId: 'scheduled-1',
      roundId: 'round-1',
      packetId: null,
      status: 'accepted',
      scores: [
        {
          teamId: 'team-a',
          score: 300,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
        {
          teamId: 'team-b',
          score: 100,
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonuses: 0,
          bonusPoints: 0,
          bouncebacks: 0,
        },
      ],
      playerStats: [
        {
          playerId: 'player-a1',
          teamId: 'team-a',
          superpowers: 0,
          powers: 0,
          gets: 0,
          negs: 0,
          bonusPoints: 0,
          tossupsHeard: null,
        },
      ],
      source: 'manual',
      detailedStats: 'unknown',
    },
  ];
  return state;
}

function stubController(overrides: Partial<DirectorController> = {}) {
  return {
    setFinalPlacement: vi.fn(() => ({ applied: true, message: 'Final placement recorded.' })),
    clearFinalPlacement: vi.fn(() => true),
    ...overrides,
  } as unknown as DirectorController;
}

function renderStats(state: DirectorState, controller: DirectorController) {
  const onAnnounce = vi.fn();
  render(<StandingsView state={state} controller={controller} onAnnounce={onAnnounce} />);
  return { onAnnounce, controller };
}

describe('Stats workspace', () => {
  test('single-stage tournaments show no scope selector and honest unknowns', () => {
    renderStats(tournamentState(), stubController());
    expect(screen.queryByLabelText('Scope')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Aiken')).toBeTruthy();
    // Classifications in use are shown, not buried in a form: once as the
    // row badge and once as the group filter option.
    expect(screen.getAllByText(/Small School/)).toHaveLength(2);
    expect(screen.getByLabelText('Group')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Individuals' }));
    expect(screen.getByText('A. Player')).toBeTruthy();
    expect(screen.getByText(/Grade 10/)).toBeTruthy();
    // Unknown TUH and PPTUH render as em dashes, never fabricated zeroes.
    const row = screen.getByText('A. Player').closest('tr')!;
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  test('final order editor saves through the audited controller action', () => {
    const controller = stubController();
    renderStats(tournamentState(), controller);
    fireEvent.click(screen.getByRole('button', { name: 'Set final order' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);
    fireEvent.change(screen.getByPlaceholderText(/Why does the final differ/), {
      target: { value: 'Tiebreak game.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save final order' }));
    expect(controller.setFinalPlacement).toHaveBeenCalledWith({
      order: ['team-b', 'team-a'],
      reason: 'Tiebreak game.',
    });
  });

  test('multi-stage tournaments gain a scope selector only then', () => {
    const state = tournamentState();
    state.phases = [
      {
        id: 'phase-1',
        name: 'Prelims',
        kind: 'preliminary',
        order: 0,
        formatId: 'format-1',
        poolIds: [],
        roundIds: ['round-1'],
        advancementRule: null,
        carryover: false,
        status: 'complete',
      },
      {
        id: 'phase-2',
        name: 'Playoffs',
        kind: 'playoff',
        order: 1,
        formatId: 'format-1',
        poolIds: [],
        roundIds: [],
        advancementRule: null,
        carryover: false,
        status: 'planned',
      },
    ];
    renderStats(state, stubController());
    const scope = screen.getByLabelText('Scope') as HTMLSelectElement;
    expect([...scope.options].map((option) => option.text)).toEqual(['Overall', 'Prelims', 'Playoffs']);
  });
});
