/**
 * A game opened from a file, with no server anywhere.
 *
 * This is the path that has to work when everything else has failed, so it is driven end to end
 * through the real screens: open the file, score, survive a reload, finish, download, and have the
 * file that comes out be an ordinary QBJ with the right numbers in it.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { bonus, openApp, openGameFile, press, score, pressControl, startLineups } from './appHarness';

/**
 * Capture what a download would have written, instead of writing it.
 *
 * jsdom has no object URLs and no synchronous way to read a Blob back, so the Blob constructor is
 * wrapped to remember its own contents and the anchor click is intercepted. What is asserted on is
 * therefore the exact bytes the browser would have saved.
 */
function captureDownloads(): { files: { name: string; contents: string }[] } {
  const files: { name: string; contents: string }[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const OriginalBlob = globalThis.Blob;
  const originalClick = HTMLAnchorElement.prototype.click;
  let pending = '';

  class RecordingBlob extends OriginalBlob {
    readonly recordedText: string;

    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      this.recordedText = parts.map((part) => String(part)).join('');
    }
  }
  globalThis.Blob = RecordingBlob as unknown as typeof Blob;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      pending = (blob as RecordingBlob).recordedText ?? '';
      return 'blob:captured';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    files.push({ name: this.download, contents: pending });
  };

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
    globalThis.Blob = OriginalBlob;
    HTMLAnchorElement.prototype.click = originalClick;
  });

  return { files };
}

/** What a reload is: a fresh application against the same storage. */
async function reload(): Promise<void> {
  cleanup();
  await openApp();
}

describe('opening a game file', () => {
  test('a valid file starts the game it describes', async () => {
    await openApp();
    await openGameFile();

    expect(await screen.findByText('Spring Invitational')).toBeInTheDocument();
    expect(screen.getByText(/Round 7/)).toBeInTheDocument();
    // Three players and a floor of four: everybody starts, so there is nothing to prompt for.
    expect(screen.getByText('Sarah Mitchell')).toBeInTheDocument();
  });

  test('a malformed file says what is wrong and starts nothing', async () => {
    await openApp();
    await openGameFile({
      name: 'broken.qbg',
      size: 40,
      text: () => Promise.resolve('{"format":"quizbowl-game","version":1}'),
    } as unknown as File);

    expect(await screen.findByText('That game file cannot be used.')).toBeInTheDocument();
    expect(screen.getByText('QBSheet')).toBeInTheDocument();
    expect(screen.queryByText('Spring Invitational')).toBeNull();
  });

  test('opening the same game file again resumes it rather than starting a second copy', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await score('Sarah Mitchell', '+15');
    await bonus('20');

    await reload();
    // Same file, same game. The questions already scored have to still be there.
    await openGameFile();

    expect(
      await screen.findByText('This game is already saved on this device. Resume it rather than starting again.'),
    ).toBeInTheDocument();
    await press('Resume');
    await waitFor(() => expect(screen.getByText('35')).toBeInTheDocument());
  });
});

describe('scoring, and getting the result out', () => {
  test('a scored game produces a QBJ with the right aggregates and no internal state', async () => {
    const downloads = captureDownloads();
    await openApp();
    await openGameFile();
    await startLineups();

    await score('Sarah Mitchell', '+15');
    await bonus('20');
    await score('Emma Chen', '+10');
    await bonus('10');

    await pressControl('Download QBJ backup');

    expect(downloads.files).toHaveLength(1);
    expect(downloads.files[0].name).toBe('R07_Room-204_Ninety-Six-A_vs_Greenwood.qbj');
    const payload = JSON.parse(downloads.files[0].contents);
    expect(payload.tossups_read).toBe(2);
    expect(payload.match_teams[0].points).toBe(35);
    expect(payload.match_teams[1].points).toBe(20);
    expect(payload).not.toHaveProperty('_yf_scorekeeper_recovery');
    expect(payload._scoresheet_source).toMatchObject({ scheduledMatchId: 'sched-101', roundRevision: 1 });
  });
});

describe('reload', () => {
  test('the unfinished game is offered, and comes back at the same score', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await score('Sarah Mitchell', '+15');
    await bonus('20');

    await reload();

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.getByText('Ninety Six A vs Greenwood')).toBeInTheDocument();
    expect(screen.getByText('Q1')).toBeInTheDocument();

    await press('Resume');

    expect(await screen.findByText('Spring Invitational')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('35')).toBeInTheDocument());
  });

  test('a reload with nothing in progress offers the ordinary screen', async () => {
    await openApp();
    await reload();

    expect(screen.queryByText('Unfinished game')).toBeNull();
    expect(screen.getByText('Connect to tournament control')).toBeInTheDocument();
  });
});

describe('the leave-site warning', () => {
  /** Whether the browser would show its dialog right now. */
  function wouldWarn(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  test('nothing in progress does not warn', async () => {
    await openApp();

    expect(wouldWarn()).toBe(false);
  });

  test('a game being scored warns', async () => {
    await openApp();
    await openGameFile();
    await startLineups();
    await score('Sarah Mitchell', '+15');

    await waitFor(() => expect(wouldWarn()).toBe(true));
  });
});
