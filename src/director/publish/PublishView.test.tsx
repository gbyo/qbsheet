/**
 * What Exports offers, and what each offer actually writes.
 *
 * Three of the four claims here are about things the page used to say and not do: a standings CSV
 * that was a roster CSV, a `Print current view` that promised room sheets from a page that draws
 * none, and an export list explaining what a tournament archive contains to somebody who has no
 * tournament open.
 *
 * The destination is called Exports now, because it writes local files. QBSheet Live is what
 * publishes.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyDirectorState } from '../domain';
import { playedTournament } from '../../../tests/directorFixtures';
import { downloadArchive, PublishView } from './PublishView';

/** Each export is a row naming the file and carrying the one action that writes it. */
function clickExport(name: string): void {
  const row = screen.getByText(name).closest('[role="listitem"]') as HTMLElement;
  fireEvent.click(within(row).getByRole('button'));
}

interface Saved {
  name: string;
  text: string;
}

let saved: Saved[] = [];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let originalBlob: typeof Blob;
/*
 * The bytes handed to the Blob, decoded. `Blob.text()` is a promise and the anchor click that
 * stands in for the download is synchronous, so the content is captured on the way in instead.
 */
let lastBlobText = '';

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
  URL.createObjectURL = vi.fn(() => 'blob:publish');
  URL.revokeObjectURL = vi.fn();
  // jsdom will not navigate to a blob, so the download is observed at the anchor instead.
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
});

test('Team standings CSV writes standings columns, not roster-import columns', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  clickExport('Team standings CSV');

  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational-standings.csv');
  expect(file?.text.split('\r\n')[0]).toContain('wins');
  expect(file?.text.split('\r\n')[0]).not.toContain('player_name');
});

test('the roster CSV is offered under a name that describes it', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  clickExport('Team & roster CSV');

  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational-teams.csv');
  expect(file?.text.split('\r\n')[0]).toContain('player_name');
});

test('player statistics can be exported from Exports too', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  clickExport('Player stats CSV');

  const file = saved.at(-1);
  expect(file?.name).toBe('Ninety-Six-Invitational-player-stats.csv');
  expect(file?.text).toContain('Gibson');
});

test('the archive has one entry point rather than two that do the same thing', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  expect(screen.getByRole('button', { name: 'Export tournament archive' })).toBeTruthy();
  expect(screen.queryByText('Portable archive')).toBeNull();
});

test('Exports does not offer to print reports it does not render', () => {
  render(<PublishView state={playedTournament()} onAnnounce={vi.fn()} />);

  expect(screen.queryByRole('button', { name: 'Print' })).toBeNull();
  expect(screen.queryByText(/browser print dialog/)).toBeNull();
});

test('with no tournament open, the page is the empty state and nothing else', () => {
  render(<PublishView state={emptyDirectorState()} onAnnounce={vi.fn()} />);

  expect(screen.getByText('Nothing to export')).toBeTruthy();
  // The standalone "What is included" card is gone; that information now lives
  // on the export rows themselves, which an empty page does not render.
  expect(screen.queryByText('What is included')).toBeNull();
  expect(screen.queryByText(/Team standings use accepted results only/)).toBeNull();
  expect(screen.queryByRole('list', { name: 'Export formats' })).toBeNull();
});

/**
 * A failed export does not get a green check.
 *
 * `downloadArchive` is also what the persistence banner's "Export recovery archive" runs, which is
 * the moment a director reaches for when storage has already failed. Announcing the failure as a
 * bare string gave it `role="status"` and the success icon — a toast reading "could not be
 * exported" beside a check mark, which is the one thing `notices` exists to make impossible.
 */
test('an archive that cannot be written is announced as an error, not a success', async () => {
  const onAnnounce = vi.fn();
  const state = playedTournament();
  // The serializer runs before anything is written; a Blob that refuses to construct stands in for
  // any failure inside the export.
  globalThis.Blob = class {
    constructor() {
      throw new Error('Disk is full.');
    }
  } as unknown as typeof Blob;

  await downloadArchive(state, onAnnounce);

  expect(onAnnounce).toHaveBeenCalledWith({ message: 'Disk is full.', tone: 'error' });
});
