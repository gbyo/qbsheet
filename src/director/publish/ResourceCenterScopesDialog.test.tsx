/**
 * Multi-phase Resource Center export dialog (issue #763).
 *
 * Single-stage tournaments keep the direct ZIP download with no phase
 * chooser; multi-stage tournaments open a preset picker (recommended,
 * phases-only, combined-only) that previews set/file counts before export.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DirectorState } from '../domain';
import {
  acceptedGame,
  playedTournament,
  playerStat,
  scheduledGame,
  score,
} from '../../../tests/directorFixtures';
import { PublishView } from './PublishView';
import type { AnnounceInput } from '../notices';

function twoStageTournament(): DirectorState {
  const state = playedTournament();
  state.phases[0]!.name = 'Prelims';
  state.phases.push({
    id: 'phase-2',
    name: 'Playoffs',
    kind: 'playoff',
    order: 2,
    formatId: 'format-1',
    poolIds: [],
    roundIds: ['round-2'],
    advancementRule: null,
    carryover: false,
    status: 'active',
  });
  state.rounds.push({
    id: 'round-2',
    phaseId: 'phase-2',
    name: 'Round 2',
    number: 2,
    revision: 1,
    status: 'released',
    packetId: null,
    scheduledGameIds: ['scheduled-2'],
    scheduledStart: null,
    releasedAt: null,
    startedAt: null,
    closedAt: null,
  });
  state.scheduledGames.push(scheduledGame('scheduled-2', 'team-a', 'team-b', { roundId: 'round-2' }));
  const playoff = acceptedGame(
    'game-2',
    'scheduled-2',
    [score('team-a', 260), score('team-b', 240)],
    [
      playerStat('player-a', 'team-a', { gets: 8, tossupsHeard: 20 }),
      playerStat('player-b', 'team-b', { gets: 7, tossupsHeard: 20 }),
    ],
  );
  playoff.roundId = 'round-2';
  state.games.push(playoff);
  return state;
}

interface Saved {
  name: string;
}

let saved: Saved[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let originalBlob: typeof Blob;

function clickRowAction(name: string): void {
  const row = screen.getByText(name).closest('[role="listitem"]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button'));
}

beforeEach(() => {
  saved = [];
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  originalBlob = globalThis.Blob;
  URL.createObjectURL = vi.fn(() => 'blob:rc');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    saved.push({ name: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  globalThis.Blob = originalBlob;
  delete window.__TAURI_INTERNALS__;
});

test('a single-stage tournament downloads without a scope picker', () => {
  const onAnnounce = vi.fn();
  render(<PublishView state={playedTournament()} onAnnounce={onAnnounce} />);

  clickRowAction('Resource Center report');

  expect(screen.queryByText('Resource Center reports export')).toBeNull();
  expect(saved.at(-1)?.name).toBe('Ninety-Six-Invitational-resource-center.zip');
});

test('a multi-stage tournament offers the recommended preset with set and file counts', () => {
  render(<PublishView state={twoStageTournament()} onAnnounce={vi.fn()} />);

  clickRowAction('Resource Center report');

  expect(screen.getByText('Resource Center reports export')).toBeTruthy();
  expect(screen.getByText('Recommended for Resource Center')).toBeTruthy();
  // Recommended preset: every phase plus combined, each with seven files.
  expect(screen.getByText(/3 report sets · 21 files/)).toBeTruthy();
  // Each scope appears both as a checkbox and as a contents line.
  expect(screen.getAllByText(/Prelims · 1 game/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Playoffs · 1 game/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Combined · 2 games/).length).toBeGreaterThan(0);
});

test('the combined-only preset narrows the export to one set', () => {
  render(<PublishView state={twoStageTournament()} onAnnounce={vi.fn()} />);

  clickRowAction('Resource Center report');
  fireEvent.click(screen.getByText('Combined only'));

  expect(screen.getByText(/1 report set · 7 files/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Download .*resource-center\.zip/ }));
  expect(saved.at(-1)?.name).toBe('Ninety-Six-Invitational-combined-resource-center.zip');
});

test('the recommended download writes one ZIP and announces the export', async () => {
  const onAnnounce: (announcement: AnnounceInput) => void = vi.fn();
  render(<PublishView state={twoStageTournament()} onAnnounce={onAnnounce} />);

  clickRowAction('Resource Center report');
  fireEvent.click(screen.getByRole('button', { name: /Download .*resource-center-all\.zip/ }));
  await Promise.resolve();

  expect(saved.at(-1)?.name).toBe('Ninety-Six-Invitational-resource-center-all.zip');
  expect(onAnnounce).toHaveBeenCalledWith('Resource Center reports exported (3 sets, 21 files).');
});
