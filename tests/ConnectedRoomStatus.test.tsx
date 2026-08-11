/**
 * @vitest-environment jsdom
 */

/**
 * The room screen between rounds.
 *
 * A Chromebook that has finished round four sits on this screen for ten minutes with one sentence on
 * it — "Waiting for the next assignment." — and that sentence is identical whether the software is
 * polling tournament control every ten seconds or has silently stopped. It has always been polling.
 * Nothing ever said so, which is why scorekeepers press the manual button between every round, and
 * why some of them go looking for a pairing code when nothing is wrong.
 *
 * So these tests are about evidence rather than about mechanism: that the room really does check on
 * its own, that the screen says it is checking, that it stops saying so in the one state where it
 * has deliberately stopped, and that a matchup arriving is the only thing that moves.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';

/** Whatever the next `assignment()` call should answer with. Set per test. */
let answer: () => Promise<unknown>;
let assignmentCalls = 0;

vi.mock('../src/integrations/fruity/FruityServerClient', () => {
  class StubClient {
    baseUrl: string;

    constructor(baseUrl: string) {
      this.baseUrl = baseUrl;
    }

    async assignment() {
      assignmentCalls += 1;
      return answer();
    }

    async openSession() {
      return { ok: true, value: { sessionId: 'session-1', token: 'session-token' } };
    }

    missingCapabilities() {
      return [];
    }
  }
  return {
    default: StubClient,
    normalizeBaseUrl: (value: string) => ({ ok: true as const, value }),
  };
});

const { default: ConnectedSetup } = await import('../src/app/ConnectedSetup');

const pairedRoom = {
  baseUrl: 'http://control.local:8787',
  roomId: 'room-1',
  roomName: 'Room 204',
  roomToken: 'room-token',
  deviceId: 'device-1',
};

function assignmentOf(overrides: Partial<INormalizedAssignment> = {}): INormalizedAssignment {
  return {
    state: 'none',
    roomId: 'room-1',
    roomName: 'Room 204',
    tournamentName: 'Ninety Six Invitational',
    definition: null,
    session: null,
    ...overrides,
  } as INormalizedAssignment;
}

/** An assignment with a game attached, of the shape the room screen reads. */
function matchup(scheduledMatchId: string, roundName: string): INormalizedAssignment {
  return assignmentOf({
    state: 'assigned',
    scheduledMatchId,
    definition: {
      round: { name: roundName },
      left: { name: 'Ninety Six' },
      right: { name: 'Greenwood' },
    },
  } as Partial<INormalizedAssignment>);
}

const ok = (value: INormalizedAssignment) => async () => ({ ok: true as const, value });

function renderRoom() {
  render(
    <ConnectedSetup
      initialBaseUrl="http://control.local:8787"
      pairedRoom={pairedRoom}
      onPaired={() => undefined}
      onStart={() => undefined}
      onRoomLost={() => undefined}
      onCancel={() => undefined}
    />,
  );
}

/** Let the mounted first read settle, without advancing the poll interval. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(assignmentPollIntervalMs);
  });
}

function checkLine(): string {
  return document.querySelector('.assignment-check')?.textContent ?? '';
}

function assignmentBody(): Element | null {
  return document.querySelector('.assignment-state-body');
}

beforeEach(() => {
  vi.useFakeTimers();
  assignmentCalls = 0;
  answer = ok(assignmentOf());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a room that is waiting', () => {
  test('it checks on its own, without anybody pressing anything', async () => {
    renderRoom();
    await settle();
    expect(assignmentCalls).toBe(1);

    await poll();
    await poll();

    expect(assignmentCalls).toBe(3);
  });

  test('the screen says the checking is automatic, and when it last happened', async () => {
    renderRoom();
    await settle();

    expect(screen.getByText('Waiting for the next assignment.')).toBeTruthy();
    expect(checkLine()).toBe('QBSheet checks automatically · checked just now');
  });

  test('before the first answer it says it is asking rather than claiming a check', async () => {
    // A promise that never settles: this is the state during the very first request.
    answer = () => new Promise(() => undefined);
    renderRoom();
    await settle();

    expect(checkLine()).toBe('Checking tournament control…');
  });

  test('the manual button is an override, and says so', async () => {
    renderRoom();
    await settle();
    const button = screen.getByRole('button', { name: 'Check now' });

    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    fireEvent.click(button);
    await settle();

    expect(assignmentCalls).toBe(2);
  });

  test('the manual button is not offered twice while one request is in flight', async () => {
    let release: (() => void) | null = null;
    answer = () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: assignmentOf() });
      });
    renderRoom();
    await settle();

    expect(screen.getByRole('button', { name: 'Check now' }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      release?.();
    });
    expect(screen.getByRole('button', { name: 'Check now' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('an assignment arriving', () => {
  test('the matchup appears on the next poll, with nothing pressed', async () => {
    renderRoom();
    await settle();
    expect(screen.getByRole('button', { name: 'Start scoring' }).hasAttribute('disabled')).toBe(true);

    answer = ok(matchup('match-5', 'Round 5'));
    await poll();

    expect(screen.getByText(/Round 5 · Ninety Six vs Greenwood/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start scoring' }).hasAttribute('disabled')).toBe(false);
    // Still one pairing, still one room, and the button was never pressed.
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });

  test('ten identical polls are one state, so nothing on screen restarts', async () => {
    answer = ok(matchup('match-5', 'Round 5'));
    renderRoom();
    await settle();
    const first = assignmentBody();

    await poll();
    await poll();

    // The same element across every poll: the assignment block is keyed on what the assignment
    // means, not on the object the server sent, so an unchanged answer changes nothing.
    expect(assignmentBody()).toBe(first);
    expect(assignmentCalls).toBe(3);
  });

  test('a genuinely different game replaces the block, so it re-enters', async () => {
    answer = ok(matchup('match-5', 'Round 5'));
    renderRoom();
    await settle();
    const first = assignmentBody();

    answer = ok(matchup('match-6', 'Round 6'));
    await poll();

    expect(assignmentBody()).not.toBe(first);
    expect(screen.getByText(/Round 6 · Ninety Six vs Greenwood/)).toBeTruthy();
  });

  test('the state is announced politely, and the check timestamp is kept out of it', async () => {
    renderRoom();
    await settle();
    const live = document.querySelector('.assignment-state');

    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toContain('Waiting for the next assignment.');
    // Otherwise a screen reader would be interrupted every ten seconds by a poll that changed nothing.
    expect(live?.querySelector('.assignment-check')).toBeNull();
    expect(document.querySelector('.assignment-check')).toBeTruthy();
  });

  test('an arriving assignment does not take the keyboard away from anybody', async () => {
    renderRoom();
    await settle();
    const backButton = screen.getByRole('button', { name: 'Back' });
    backButton.focus();

    answer = ok(matchup('match-5', 'Round 5'));
    await poll();

    expect(document.activeElement).toBe(backButton);
  });
});

describe('when a check fails', () => {
  test('the last successful check is remembered, and the line stops claiming the present', async () => {
    renderRoom();
    await settle();
    expect(checkLine()).toContain('checked just now');

    answer = async () => ({ ok: false as const, status: 500, error: 'Tournament control did not answer.' });
    await poll();

    expect(screen.getByText('Tournament control did not answer.')).toBeTruthy();
    expect(checkLine()).toBe('Automatic checks continue · last successful check less than a minute ago');
    expect(checkLine()).not.toContain('just now');
  });

  test('a failure does not stop the room checking', async () => {
    answer = async () => ({ ok: false as const, status: 500, error: 'Tournament control did not answer.' });
    renderRoom();
    await settle();
    const afterFirst = assignmentCalls;

    await poll();

    expect(assignmentCalls).toBe(afterFirst + 1);
  });
});

describe('when control accepts the room and refuses the request', () => {
  const refusal = async () => ({
    ok: false as const,
    status: 403,
    detail: 'This page is not on the allowlist.',
    error: 'Forbidden',
  });

  test('the screen says the automatic checks have stopped', async () => {
    answer = refusal;
    renderRoom();
    await settle();

    expect(checkLine()).toBe('Automatic checks paused · choose Check now after this is fixed.');
    expect(checkLine()).not.toContain('checks automatically');
    expect(screen.getByText(/This page is not on the allowlist/)).toBeTruthy();
  });

  test('and they really have stopped, exactly as before', async () => {
    answer = refusal;
    renderRoom();
    await settle();
    const afterFirst = assignmentCalls;

    await poll();
    await poll();

    // "Surface it. Do not retry in a loop." The manual override is still the way back.
    expect(assignmentCalls).toBe(afterFirst);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await settle();
    expect(assignmentCalls).toBe(afterFirst + 1);
  });
});
