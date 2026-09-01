/**
 * What a room actually sees when a build is deployed mid-tournament.
 *
 * `AppUpdate.test.ts` proves the watcher cannot swap the application under a game. This proves the
 * other half: that the room is *told*, in the right words, on the right screen — and that the button
 * which would perform the swap is not reachable from a live scoresheet at all. Both halves are needed.
 * A safety property nobody can see looks like a bug, and a notice with a button next to it is an
 * invitation to press it during a bonus.
 */
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { appUpdates } from '../src/pwa/AppUpdate';
import { openApp, openGameFile, startLineups } from './appHarness';

/** A worker that records what the page asked it to do. */
function fakeWorker() {
  return {
    state: 'installed',
    messages: [] as unknown[],
    postMessage(message: unknown) {
      this.messages.push(message);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeRegistration(waiting: ReturnType<typeof fakeWorker> | null) {
  return {
    installing: null,
    waiting,
    update: () => Promise.resolve(),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** A device that is already running a build, with `waiting` newer one installed behind it. */
function deployBuild(waiting: ReturnType<typeof fakeWorker> | null) {
  act(() => {
    appUpdates.observe(fakeRegistration(waiting), {
      controller: waiting === null ? null : { id: 'old' },
      addEventListener() {},
      removeEventListener() {},
    });
  });
}

beforeEach(() => {
  // The watcher is a module singleton, as it must be — there is one service-worker registration per
  // device. Pointing it at a registration with nothing waiting is how a test starts from a device
  // that has no update.
  deployBuild(null);
});

afterEach(() => {
  appUpdates.reset();
  appUpdates.stop();
});

describe('a build deployed while a game is being scored', () => {
  test('the room is told it will apply afterwards, and is offered nothing to press', async () => {
    await openApp();
    await openGameFile();
    await startLineups();

    const worker = fakeWorker();
    deployBuild(worker);

    expect(screen.getByText('Update available — will apply after this game')).toBeInTheDocument();
    // The whole point. Nothing on a live scoresheet may reload the application.
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();

    // And nothing has been asked of the waiting worker, so it is still waiting.
    expect(worker.messages).toEqual([]);
  });

  test('the scoresheet is still there and still says the score', async () => {
    await openApp();
    await openGameFile();
    await startLineups();

    deployBuild(fakeWorker());

    // A notice that arrived by way of remounting the scoresheet is the failure this test is looking
    // for, so the scoring controls are asserted on rather than assumed.
    expect(screen.getByRole('button', { name: 'Sarah Mitchell 15' })).toBeInTheDocument();
    expect(screen.getByText('Update available — will apply after this game')).toBeInTheDocument();
  });
});

describe('a build deployed while the device is idle', () => {
  test('the front door offers Update now, and pressing it asks the waiting worker to take over', async () => {
    await openApp();

    const worker = fakeWorker();
    deployBuild(worker);

    expect(screen.getByRole('status')).toHaveAttribute('data-update-presentation', 'hero');
    expect(screen.getByRole('status')).toHaveClass('update-notice-hero');
    const update = screen.getByRole('button', { name: 'Update now' });
    expect(update).toHaveClass('is-primary');
    await act(async () => {
      update.click();
    });

    expect(worker.messages).toEqual(['qbsheet:skip-waiting']);
  });

  test('nothing is said when no build is waiting', async () => {
    await openApp();

    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.queryByText(/Update available/)).toBeNull();
    expect(document.querySelector('.update-notice-hero')).toBeNull();
  });

  test('an unfinished game keeps Resume dominant and presents the update compactly', async () => {
    await openApp();
    await openGameFile();

    // A reload returns to Home with the active record, which is the recovery state whose priority
    // this presentation rule protects.
    cleanup();
    await openApp();

    deployBuild(fakeWorker());

    expect(await screen.findByText('Unfinished game')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveClass('is-primary');
    expect(screen.getByRole('status')).toHaveAttribute('data-update-presentation', 'compact');
    expect(screen.getByRole('status')).not.toHaveClass('update-notice-hero');
    expect(screen.getByRole('button', { name: 'Update now' })).not.toHaveClass('is-primary');
  });
});
