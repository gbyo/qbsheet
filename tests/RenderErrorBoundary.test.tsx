/** @vitest-environment jsdom */

/**
 * What the room sees when the scoresheet throws during render.
 *
 * The failure being tested is not "an error happened" — that part was always handled, silently, by
 * React unmounting the tree. It is what the scorekeeper was left with afterwards, which was a white
 * page, no explanation, and no way to reach any of the exports that would have got their morning off
 * the device. Every case below is about what is on the screen and what can be done from it.
 *
 * `console.error` is silenced around the crashes on purpose. React writes the caught error to it
 * whatever a boundary does, and a test suite whose passing runs are full of stack traces is a test
 * suite nobody reads.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import RenderErrorBoundary, {
  crashCountStorageKey,
  journalFileContents,
  journalFileName,
  readCrashCount,
  recordCrash,
} from '../src/app/RenderErrorBoundary';
import { ErrorLog } from '../src/app/ErrorLog';
import { exportJournals } from '../src/scorer/GameSession';

function Boom(): never {
  throw new Error('the scoresheet exploded');
}

/** A `sessionStorage` a test can see into, and one that refuses everything. */
function fakeStorage(initial: Record<string, string> = {}) {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('a render-phase throw', () => {
  test('replaces the blank page with the fact that the scoring is safe', () => {
    render(
      <RenderErrorBoundary storage={fakeStorage()}>
        <Boom />
      </RenderErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/scoring is saved on this device/i)).toBeInTheDocument();
    // Reloading is the answer to a first crash, so it is the primary action.
    expect(screen.getByRole('button', { name: /reload the scoresheet/i })).toHaveClass('is-primary');
  });

  test('renders its children untouched when nothing throws', () => {
    render(
      <RenderErrorBoundary storage={fakeStorage()}>
        <p>Tossup 14</p>
      </RenderErrorBoundary>,
    );
    expect(screen.getByText('Tossup 14')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('records the throw as a render error, which is the one source window.onerror cannot see', () => {
    const log = new ErrorLog();
    render(
      <RenderErrorBoundary storage={fakeStorage()} log={log}>
        <Boom />
      </RenderErrorBoundary>,
    );
    expect(log.entries()).toHaveLength(1);
    expect(log.entries()[0]).toMatchObject({ source: 'render' });
    expect(log.entries()[0].message).toContain('the scoresheet exploded');
  });

  test('shows the message rather than hiding it behind a reference number', () => {
    render(
      <RenderErrorBoundary storage={fakeStorage()}>
        <Boom />
      </RenderErrorBoundary>,
    );
    expect(screen.getByText(/the scoresheet exploded/)).toBeInTheDocument();
  });

  test('reloads on request', () => {
    const onReload = vi.fn();
    render(
      <RenderErrorBoundary storage={fakeStorage()} onReload={onReload}>
        <Boom />
      </RenderErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /reload the scoresheet/i }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});

describe('a crash that comes back after the reload', () => {
  test('stops recommending the reload and makes the recovery file the action', () => {
    // The count a previous crash in this session left behind.
    render(
      <RenderErrorBoundary storage={fakeStorage({ [crashCountStorageKey]: '1' })}>
        <Boom />
      </RenderErrorBoundary>,
    );

    expect(screen.getByText(/happened more than once/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save recovery file/i })).toHaveClass('is-primary');
    expect(screen.getByRole('button', { name: /reload the scoresheet/i })).not.toHaveClass('is-primary');
    // Still true, and still the first thing said.
    expect(screen.getByText(/scoring is still saved on this device/i)).toBeInTheDocument();
  });

  test('offers the journal even though nothing in the application can be reached', () => {
    window.localStorage.setItem(
      'yellowfruit.room.game.v1.game-7',
      JSON.stringify({
        version: 1,
        gameKey: 'game-7',
        events: [],
        setup: {},
        updatedAt: '2026-08-20T14:00:00.000Z',
      }),
    );
    const write = vi.fn().mockReturnValue(true);

    render(
      <RenderErrorBoundary storage={fakeStorage({ [crashCountStorageKey]: '1' })} write={write}>
        <Boom />
      </RenderErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /save recovery file/i }));

    expect(write).toHaveBeenCalledOnce();
    const [contents, fileName] = write.mock.calls[0];
    expect(fileName).toMatch(/^qbsheet-recovery-.*\.json$/);
    expect(JSON.parse(contents as string).games['game-7']).toContain('game-7');
    expect(screen.getByText(/recovery file saved/i)).toBeInTheDocument();
  });

  test('says so plainly when there is no game to recover', () => {
    const write = vi.fn().mockReturnValue(true);
    render(
      <RenderErrorBoundary storage={fakeStorage()} write={write}>
        <Boom />
      </RenderErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /save recovery file/i }));
    expect(write).not.toHaveBeenCalled();
    expect(screen.getByText(/no in-progress game saved/i)).toBeInTheDocument();
  });

  test('does not claim to have saved a file the browser refused', () => {
    window.localStorage.setItem(
      'yellowfruit.room.game.v1.game-7',
      JSON.stringify({
        version: 1,
        gameKey: 'game-7',
        events: [],
        setup: {},
        updatedAt: '2026-08-20T14:00:00.000Z',
      }),
    );
    render(
      <RenderErrorBoundary storage={fakeStorage()} write={() => false}>
        <Boom />
      </RenderErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /save recovery file/i }));
    expect(screen.getByText(/refused the download/i)).toBeInTheDocument();
  });

  test('offers diagnostics, which carry the crash that produced the screen', () => {
    const write = vi.fn().mockReturnValue(true);
    render(
      <RenderErrorBoundary storage={fakeStorage()} write={write}>
        <Boom />
      </RenderErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /save diagnostics/i }));
    expect(write).toHaveBeenCalledOnce();
    expect(screen.getByText(/diagnostics saved/i)).toBeInTheDocument();
  });
});

describe('the crash count', () => {
  test('counts up, and treats anything unparseable as a first crash', () => {
    const storage = fakeStorage();
    expect(readCrashCount(storage)).toBe(0);
    expect(recordCrash(storage)).toBe(1);
    expect(recordCrash(storage)).toBe(2);

    storage.values[crashCountStorageKey] = 'not a number';
    expect(readCrashCount(storage)).toBe(0);
  });

  test('a device that refuses storage still gets the boundary, just not the escalation', () => {
    expect(readCrashCount(null)).toBe(0);
    expect(recordCrash(null)).toBe(1);

    render(
      <RenderErrorBoundary storage={null}>
        <Boom />
      </RenderErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('the recovery file itself', () => {
  const at = new Date('2026-08-20T14:32:05.123Z');

  test('is named so a folder of them sorts, and cannot be mistaken for a result', () => {
    expect(journalFileName(at)).toBe('qbsheet-recovery-2026-08-20T14-32-05-123.json');
  });

  test('says what it is, for whoever opens it on Monday', () => {
    const parsed = JSON.parse(journalFileContents({ 'game-1': '{"events":[]}' }, at));
    expect(parsed.qbsheetRecoveryExport).toBe(1);
    expect(parsed.exportedAt).toBe(at.toISOString());
    expect(parsed.note).toMatch(/Not a QBJ/);
    expect(parsed.games['game-1']).toBe('{"events":[]}');
  });
});

describe('exporting the journal without judging it', () => {
  test('returns entries `loadGame` would refuse, because getting them off the device is the point', () => {
    // Too old for `gameSessionMaxAgeMs`, and with an event list `validEvent` would reject.
    window.localStorage.setItem(
      'yellowfruit.room.game.v1.stale',
      JSON.stringify({
        version: 1,
        gameKey: 'stale',
        events: ['nonsense'],
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    window.localStorage.setItem('qbsheet.unrelated', 'not a journal');

    const exported = exportJournals();
    expect(Object.keys(exported)).toEqual(['stale']);
    expect(exported.stale).toContain('nonsense');
  });

  test('a storage that cannot be enumerated gives back nothing rather than throwing', () => {
    expect(exportJournals(null)).toEqual({});
    expect(
      exportJournals({ getItem: () => null, setItem: () => undefined, removeItem: () => undefined }),
    ).toEqual({});
  });
});
