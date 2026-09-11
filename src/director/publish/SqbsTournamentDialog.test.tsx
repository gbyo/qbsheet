/**
 * Exports offers a full SQBS tournament file next to the roster-only file,
 * with scope choice, pre-save diagnostics, and honest failure behavior.
 *
 * The roster row is the regression guard: it keeps its label, its filename,
 * and its positional content while the tournament export is what carries
 * games and scores.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parseSqbsTournamentFile } from '@qbsheet/tournament-formats';
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
import { SqbsTournamentDialog } from './SqbsTournamentDialog';
import type { AnnounceInput } from '../notices';

/** Two stages with one decided game and one pool each, so every scope has something to say. */
function twoStageTournament(): DirectorState {
  const state = playedTournament();
  state.scheduledGames[0]!.poolId = 'pool-1';
  state.phases[0]!.poolIds = ['pool-1'];
  state.pools.push(
    { id: 'pool-1', phaseId: 'phase-1', name: 'Pool A', teamIds: ['team-a', 'team-b'], order: 0 },
    { id: 'pool-2', phaseId: 'phase-2', name: 'Pool A', teamIds: ['team-a', 'team-b'], order: 0 },
  );
  state.phases.push({
    id: 'phase-2',
    name: 'Playoffs',
    kind: 'playoff',
    order: 2,
    formatId: 'format-1',
    poolIds: ['pool-2'],
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
  state.scheduledGames.push(
    scheduledGame('scheduled-2', 'team-a', 'team-b', { roundId: 'round-2', poolId: 'pool-2' }),
  );
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
  // Manual final score with no bonus accounting: unknown detail the file
  // must carry as zeroes with a warning, not as legitimate zeroes.
  playoff.detailedStats = 'unknown';
  state.games.push(playoff);
  return state;
}

interface Saved {
  name: string;
  text: string;
}

let saved: Saved[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let originalBlob: typeof Blob;
let lastBlobText = '';

function clickRowAction(name: string): void {
  const row = screen.getByText(name).closest('[role="listitem"]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button'));
}

function openTournamentDialog(state: DirectorState, onAnnounce: (announcement: AnnounceInput) => void): void {
  render(<PublishView state={state} onAnnounce={onAnnounce} />);
  clickRowAction('SQBS tournament');
}

beforeEach(() => {
  saved = [];
  lastBlobText = '';
  originalCreate = URL.createObjectURL;
  originalRevoke = URL.revokeObjectURL;
  originalBlob = globalThis.Blob;
  const NativeBlob = originalBlob;
  class RecordingBlob extends NativeBlob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      lastBlobText = parts
        .map((part) =>
          part instanceof ArrayBuffer
            ? new TextDecoder().decode(new Uint8Array(part))
            : ArrayBuffer.isView(part)
              ? new TextDecoder().decode(part as Uint8Array)
              : String(part),
        )
        .join('');
    }
  }
  globalThis.Blob = RecordingBlob as unknown as typeof Blob;
  URL.createObjectURL = vi.fn(() => 'blob:sqbs');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: lastBlobText });
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

test('Exports names the tournament file and the roster file as different things', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  expect(screen.getByText('SQBS tournament')).toBeTruthy();
  expect(screen.getByText('SQBS roster')).toBeTruthy();
  // Neither action may hide behind a bare “SQBS” once both forms exist.
  expect(screen.queryByRole('button', { name: 'Download SQBS' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Download tournament' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Download roster' })).toBeTruthy();
});

test('the roster download keeps its filename and positional content', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  clickRowAction('SQBS roster');

  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational.sqbs');
  expect(file?.text.split(/\r?\n/)[0]).toBe('2');
  expect(file?.text).toContain('Ninety Six');
});

test('a single-stage tournament downloads without a scope picker', async () => {
  const onAnnounce = vi.fn();
  openTournamentDialog(playedTournament(), onAnnounce);

  expect(screen.getByText('SQBS tournament export')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Export scope' })).toBeNull();
  expect(screen.getByText(/Entire tournament · 2 teams · 1 game/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Download Ninety-Six-Invitational-tournament\.sqbs/ }));

  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational-tournament.sqbs');
  const parsed = parseSqbsTournamentFile(file?.text ?? '');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.teams.map((team) => team.name)).toEqual(['Ninety Six', 'Greenwood']);
  expect([parsed.value.games[0]!.left.score, parsed.value.games[0]!.right.score]).toEqual([300, 210]);
  expect(onAnnounce).toHaveBeenCalledWith('SQBS tournament exported (Entire tournament).');
});

test('a multi-stage tournament offers each stage and warns about the flattened whole', () => {
  const onAnnounce = vi.fn();
  openTournamentDialog(twoStageTournament(), onAnnounce);

  fireEvent.click(screen.getByRole('combobox', { name: 'Export scope' }));
  const listbox = screen.getByRole('listbox', { name: 'Export scope' });
  // Option labels carry their game counts; pool scopes repeat the stage name.
  const options = within(listbox).getAllByRole('option');
  expect(options.map((option) => option.textContent)).toEqual([
    'Entire tournament2 games',
    'Preliminary1 game',
    'Playoffs1 game',
    'Preliminary · Pool A1 game',
    'Playoffs · Pool A1 game',
  ]);

  // The whole-tournament scope is never silent about lost stage semantics.
  expect(screen.getByText(/multiple stages/)).toBeTruthy();

  fireEvent.pointerDown(options.find((option) => option.textContent === 'Playoffs1 game')!);
  expect(screen.getByText(/Playoffs · 2 teams · 1 game/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Download Ninety-Six-Invitational-Playoffs\.sqbs/ }));
  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational-Playoffs.sqbs');
  const parsed = parseSqbsTournamentFile(file?.text ?? '');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.games).toHaveLength(1);
  expect([parsed.value.games[0]!.left.score, parsed.value.games[0]!.right.score]).toEqual([260, 240]);
});

test('warnings stay visible through the save', async () => {
  const onAnnounce = vi.fn();
  openTournamentDialog(twoStageTournament(), onAnnounce);

  // The whole-tournament scope warns three times: flattened stage semantics,
  // the playoff game's unknown bonus detail, and its unknown match TUH (player
  // lines cannot establish the match count, so a game without exact tossups-read
  // exports honest zeroes with a warning, #746). All stay visible before the save…
  expect(screen.getAllByText('Export warning')).toHaveLength(3);
  expect(screen.getByText(/multiple stages/)).toBeTruthy();
  expect(screen.getByText(/unknown bonus/)).toBeTruthy();
  expect(screen.getByText(/unknown tossups-heard/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Download Ninety-Six-Invitational-tournament\.sqbs/ }));
  await Promise.resolve();

  // …and announced after it, so the director keeps the caveat with the file.
  expect(onAnnounce).toHaveBeenCalledWith(
    expect.objectContaining({ tone: 'warning', message: expect.stringMatching(/unknown bonus/) }),
  );
  expect(saved.at(-1)?.name).toBe('Ninety-Six-Invitational-tournament.sqbs');
});

test('a blocking error disables the download and announces failure, never success', () => {
  const onAnnounce = vi.fn();
  // No decided games: there is nothing honest to write.
  render(<SqbsTournamentDialog state={tournamentState()} onAnnounce={onAnnounce} onClose={vi.fn()} />);

  expect(screen.getByText('Export blocked')).toBeTruthy();
  // The blocked header and the error itself are both alerts: nothing hides in plain text.
  expect(screen.getAllByRole('alert')).toHaveLength(2);
  expect(screen.getByText(/nothing to export/)).toBeTruthy();
  const download = screen.getByRole('button', {
    name: /Download Ninety-Six-Invitational-tournament\.sqbs/,
  });
  expect(download.hasAttribute('disabled')).toBe(true);

  fireEvent.click(download);
  expect(saved).toHaveLength(0);
  expect(onAnnounce).not.toHaveBeenCalled();
});

test('the native app saves through the file dialog instead of the browser download', async () => {
  const invoke = vi.fn(async () => ({ path: '/tmp/Ninety-Six-Invitational-tournament.sqbs' }));
  window.__TAURI_INTERNALS__ = { invoke };
  const onAnnounce = vi.fn();
  openTournamentDialog(playedTournament(), onAnnounce);

  fireEvent.click(screen.getByRole('button', { name: /Download Ninety-Six-Invitational-tournament\.sqbs/ }));
  await Promise.resolve();
  await Promise.resolve();

  expect(invoke).toHaveBeenCalledWith(
    'save_tournament_file',
    expect.objectContaining({
      request: expect.objectContaining({ defaultName: 'Ninety-Six-Invitational-tournament.sqbs' }),
    }),
  );
  expect(saved).toHaveLength(0);
  expect(onAnnounce).toHaveBeenCalledWith(
    'SQBS tournament exported (Entire tournament) Saved to /tmp/Ninety-Six-Invitational-tournament.sqbs.',
  );
});
