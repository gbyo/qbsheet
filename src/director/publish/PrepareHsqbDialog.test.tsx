/**
 * Director "Prepare for HSQuizbowl" publishing workflow (issue #766).
 *
 * Entry point, report-set selection, preflight with fix links, semantic file
 * mapping, browser/nativesave behavior, Resource Center handoff, report-name
 * safety, and honest saved-vs-published language.
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
  tournamentState,
} from '../../../tests/directorFixtures';
import { PublishView } from './PublishView';
import { PrepareHsqbDialog } from './PrepareHsqbDialog';
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

let saved: string[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let originalBlob: typeof Blob;

function openPrepare(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  render(<PublishView state={state} onAnnounce={onAnnounce} />);
  const row = screen.getByText('Quizbowl Resource Center').closest('[role="listitem"]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button', { name: 'Prepare for HSQuizbowl' }));
}

beforeEach(() => {
  saved = [];
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  originalBlob = globalThis.Blob;
  URL.createObjectURL = vi.fn(() => 'blob:hsqb');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    saved.push(this.download);
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

test('Exports offers one obvious Resource Center preparation entry point', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  const row = screen.getByText('Quizbowl Resource Center').closest('[role="listitem"]') as HTMLElement;
  expect(row.textContent).toContain('hsquizbowl.org');
  fireEvent.click(within(row).getByRole('button', { name: 'Prepare for HSQuizbowl' }));

  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('1 · Report sets')).toBeTruthy();
  expect(screen.getByText('5 · Upload to the Resource Center')).toBeTruthy();
});

test('a simple tournament needs no configuration and previews its one set', () => {
  openPrepare(playedTournament(), vi.fn());

  expect(screen.queryByText('Scope preset')).toBeNull();
  expect(screen.getByText(/no configuration needed/)).toBeTruthy();
  expect(screen.getByText(/Overall · 2 teams · 1 game · 1 round/)).toBeTruthy();
  expect(screen.getByText('Ready to save with warnings')).toBeTruthy();
});

test('the simple happy path saves one ZIP and says saved, never published', async () => {
  const onAnnounce: (announcement: AnnounceInput) => void = vi.fn();
  openPrepare(playedTournament(), onAnnounce);

  fireEvent.click(
    screen.getByRole('button', { name: /Download Ninety-Six-Invitational-resource-center\.zip/ }),
  );
  await screen.findByText('Saved — not yet published');

  expect(saved.at(-1)).toBe('Ninety-Six-Invitational-resource-center.zip');
  expect(onAnnounce).toHaveBeenCalledWith(
    'Resource Center reports saved (1 set, 7 files). Not yet published.',
  );
  // The preflight warning survives the save instead of being dismissed with it.
  expect(screen.getByText(/Overtime tossups are listed/)).toBeTruthy();
  // No success state confuses a local save with an online publication.
  expect(
    screen.queryByText(/published online|has been published|has been uploaded|successfully uploaded/i),
  ).toBeNull();
});

test('the save confirmation tracks the saved package, not a later edit', async () => {
  openPrepare(playedTournament(), vi.fn());

  fireEvent.click(
    screen.getByRole('button', { name: /Download Ninety-Six-Invitational-resource-center\.zip/ }),
  );
  await screen.findByText('Saved — not yet published');

  // Renaming after the save changes the package revision, so the stale
  // confirmation must go rather than vouch for numbers it did not write.
  const name = screen.getByLabelText('Report name for Ninety-Six-Invitational') as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'Overall plus corrections' } });
  expect(screen.queryByText('Saved — not yet published')).toBeNull();
});

test('the semantic file mapping names every upload role with its real file', () => {
  openPrepare(playedTournament(), vi.fn());

  // Only the attested Scoreboard mapping renders bare; every other field
  // carries the honesty marker explained under the table.
  for (const [field, suffix] of [
    ['Standings *', '_standings.html'],
    ['Individuals *', '_individuals.html'],
    ['Scoreboard', '_games.html'],
    ['Team Detail *', '_teamdetail.html'],
    ['Player Detail *', '_playerdetail.html'],
    ['Round Report *', '_rounds.html'],
  ] as const) {
    expect(screen.getByText(field)).toBeTruthy();
    expect(screen.getByText(`Ninety-Six-Invitational${suffix}`)).toBeTruthy();
  }
});

test('the browser flow says to extract the ZIP and choose HTML files', () => {
  openPrepare(playedTournament(), vi.fn());

  expect(screen.getByText(/Extract it first, then choose each HTML file.*not the ZIP/)).toBeTruthy();
});

test('a multi-stage tournament defaults to the recommended preset', () => {
  openPrepare(twoStageTournament(), vi.fn());

  expect(screen.getByText('Recommended for Resource Center')).toBeTruthy();
  expect(screen.getByText(/3 report sets · 21 files/)).toBeTruthy();
  expect(screen.getAllByText(/Prelims · 2 teams · 1 game · 1 round/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Playoffs · 2 teams · 1 game · 1 round/).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/Combined · 2 teams · 2 games · 2 rounds/).length).toBeGreaterThan(0);
});

test('the combined-only preset narrows the export to one set', () => {
  openPrepare(twoStageTournament(), vi.fn());

  fireEvent.click(screen.getByText('Combined only'));

  expect(screen.getByText(/1 report set · 7 files/)).toBeTruthy();
});

test('blocking preflight prevents the ready state and links at the fix', () => {
  const state = playedTournament();
  state.tournament!.name = '';
  const onNavigate = vi.fn();
  render(<PrepareHsqbDialog state={state} onAnnounce={vi.fn()} onClose={vi.fn()} onNavigate={onNavigate} />);

  expect(screen.getByText('Not ready — fixes required')).toBeTruthy();
  expect(screen.queryByText(/Ready to save/)).toBeNull();
  expect(screen.getByText(/no tournament name/)).toBeTruthy();

  const save = screen.getByRole('button', { name: /Download .*\.zip/ });
  expect(save.hasAttribute('disabled')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Go to Settings' }));
  expect(onNavigate).toHaveBeenCalledWith('settings');
});

test('an empty tournament links its blocker at Results', () => {
  const onNavigate = vi.fn();
  render(
    <PrepareHsqbDialog
      state={tournamentState()}
      onAnnounce={vi.fn()}
      onClose={vi.fn()}
      onNavigate={onNavigate}
    />,
  );

  expect(screen.getByText('Not ready — fixes required')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Go to Results' }));
  expect(onNavigate).toHaveBeenCalledWith('results');
});

test('duplicate report names warn while the save stays available', () => {
  openPrepare(twoStageTournament(), vi.fn());

  const playoffsName = screen.getByLabelText(
    'Report name for Ninety-Six-Invitational-Playoffs',
  ) as HTMLInputElement;
  fireEvent.change(playoffsName, { target: { value: 'Prelims' } });

  expect(screen.getByText(/Duplicate report name "Prelims"/)).toBeTruthy();
  expect(screen.getByText(/Another set already uses the name/)).toBeTruthy();
  const save = screen.getByRole('button', { name: /Download .*resource-center-all\.zip/ });
  expect(save.hasAttribute('disabled')).toBe(false);
});

test('the handoff opens the Resource Center with steps and owner reminder', () => {
  openPrepare(playedTournament(), vi.fn());

  const link = screen.getByRole('link', { name: /Open Quizbowl Resource Center/ });
  expect(link.getAttribute('href')).toBe('https://hsquizbowl.org/db/');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(screen.getByText(/Only the forum account that owns the tournament entry/)).toBeTruthy();
  expect(screen.getByText(/Manage stat reports/)).toBeTruthy();
});

test('the native app saves through the file dialog with the same extract step', async () => {
  const invoke = vi.fn(async () => ({ path: '/tmp/Ninety-Six-Invitational-resource-center.zip' }));
  window.__TAURI_INTERNALS__ = { invoke };
  const onAnnounce: (announcement: AnnounceInput) => void = vi.fn();
  openPrepare(playedTournament(), onAnnounce);

  fireEvent.click(screen.getByRole('button', { name: /Save Ninety-Six-Invitational-resource-center\.zip/ }));
  await screen.findByText('Saved — not yet published');

  expect(invoke).toHaveBeenCalledWith(
    'save_tournament_file',
    expect.objectContaining({
      request: expect.objectContaining({ defaultName: 'Ninety-Six-Invitational-resource-center.zip' }),
    }),
  );
  expect(saved).toHaveLength(0);
  expect(onAnnounce).toHaveBeenCalledWith(
    expect.stringContaining('Saved to /tmp/Ninety-Six-Invitational-resource-center.zip'),
  );
  expect(screen.getByText(/The app saves one ZIP file\. Extract it/)).toBeTruthy();
});
