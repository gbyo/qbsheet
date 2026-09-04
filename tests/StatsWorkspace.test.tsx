import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  defaultRules,
  derivePlayerStandings,
  emptyDirectorState,
  type DirectorState,
} from '../src/director/domain';
import {
  buildStatsScopes,
  usedClassifications,
  classificationLabels,
  formatPptuh,
} from '../src/director/standings/statsDisplay';
import { MemoryDirectorRepository } from '../src/director/persistence';
import { useDirectorController } from '../src/director/state/useDirectorController';
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
    expect(screen.getByRole('heading', { name: '2 teams' })).toBeTruthy();
    expect(screen.getAllByText('Aiken').length).toBeGreaterThan(0);
    // The current screen presents tables. Scope, classification, and unknown-value
    // presentation helpers remain covered without expecting removed tab controls.
    const state = tournamentState();
    expect(buildStatsScopes(state).showSelector).toBe(false);
    expect(usedClassifications(state).map((value) => classificationLabels[value])).toEqual(['Small School']);
    expect(screen.getByText('A. Player')).toBeTruthy();
    expect(formatPptuh(0, derivePlayerStandings(state)[0])).toBe('—');
  });

  test('final order remains an audited controller action', async () => {
    const repository = new MemoryDirectorRepository();
    await repository.save(tournamentState());
    const hook = renderHook(() => useDirectorController(repository));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    act(() => {
      expect(
        hook.result.current.setFinalPlacement({ order: ['team-b', 'team-a'], reason: 'Tiebreak game.' })
          .applied,
      ).toBe(true);
    });
    expect(hook.result.current.state.tournament?.finalPlacement?.order).toEqual(['team-b', 'team-a']);
    expect(hook.result.current.state.audit.at(-1)?.type).toBe('final-placement-set');
    await waitFor(() => expect(hook.result.current.saving).toBe(false));
    expect((await repository.load()).tournament?.finalPlacement).toEqual(
      hook.result.current.state.tournament?.finalPlacement,
    );
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
    const { scopes, showSelector } = buildStatsScopes(state);
    expect(showSelector).toBe(true);
    expect(scopes.map((scope) => scope.label)).toEqual(['Overall', 'Prelims', 'Playoffs']);
  });
});
