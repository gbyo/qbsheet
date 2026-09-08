import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { defaultRules, emptyDirectorState, type DirectorState } from '../src/director/domain';
import { FormatView } from '../src/director/format/FormatView';
import type { DirectorController } from '../src/director/state/useDirectorController';

type Phase = DirectorState['phases'][number];

function phase(id: string, name: string, order: number): Phase {
  return {
    id,
    name,
    kind: 'preliminary',
    order,
    formatId: 'format-1',
    poolIds: [],
    roundIds: [],
    advancementRule: null,
    carryover: false,
    status: 'planned',
  };
}

function formatState(phases: Phase[]): DirectorState {
  const state = emptyDirectorState();
  state.tournament = {
    id: 'tournament-disclosure',
    name: 'Disclosure Event',
    date: '2026-09-05',
    venue: 'Main hall',
    organizer: 'Director',
    status: 'running',
    timeZone: 'America/New_York',
    rules: structuredClone(defaultRules),
    formatId: 'format-1',
    currentPhaseId: phases[0]?.id ?? null,
    currentPacketId: null,
    currentRoundId: null,
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
  };
  state.formats = [
    {
      id: 'format-1',
      name: 'Round robin',
      kind: 'round-robin',
      phaseIds: phases.map((entry) => entry.id),
      roundsPerTeam: null,
      avoidRematches: true,
      avoidSameOrganization: false,
      allowByes: true,
      editable: true,
    },
  ];
  state.phases = phases;
  return state;
}

function renderFormat(state: DirectorState) {
  render(
    <FormatView
      state={state}
      controller={{} as DirectorController}
      onNavigate={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
}

describe('FormatView progressive disclosure', () => {
  test('one ordinary stage keeps stage machinery out of the page entirely', () => {
    renderFormat(formatState([phase('phase-1', 'Tournament', 1)]));

    // Nothing about stages is on screen: no stage list, no per-stage settings,
    // and no "phase" anywhere in the copy a director reads.
    expect(screen.queryByRole('heading', { name: 'Tournament stage' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Selected stage/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add playoff stage' })).toBeNull();
    expect(screen.queryByText(/phase/i, { selector: 'h1,h2,h3,p,button,label' })).toBeNull();

    // It is still reachable, and the disclosure says why it is not needed.
    const stages = screen.getByRole('button', { name: /Stages & advancement/ });
    expect(stages).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getByText(/A one-stage tournament does not need stage concepts/),
    ).toBeInTheDocument();

    fireEvent.click(stages);
    expect(screen.getByRole('button', { name: 'Add playoff stage' })).toBeTruthy();
  });

  test('a second stage reveals stage navigation and settings without being asked', () => {
    renderFormat(formatState([phase('phase-1', 'Prelims', 1), phase('phase-2', 'Playoffs', 2)]));

    // The tournament now has stages, so the section is open on arrival.
    expect(screen.getByRole('button', { name: /Stages & advancement/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Stage sequence' })).toBeVisible();
    expect(screen.getByRole('heading', { name: /^Selected stage/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add stage' })).toBeTruthy();
  });
});
