/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import { IGameDefinition } from '../src/game/GameDefinition';
import { validPackage } from './packages';

let answer: () => Promise<unknown>;
let sessionAnswer: () => Promise<unknown>;
let assignmentCalls = 0;
let sessionCalls = 0;
let helpMessages: string[] = [];

vi.mock('../src/integrations/fruity/FruityServerClient', () => {
  class StubClient {
    constructor(public baseUrl: string) {}

    async assignment() {
      assignmentCalls += 1;
      return answer();
    }

    async openSession() {
      sessionCalls += 1;
      return sessionAnswer();
    }

    async join() {
      return { ok: true, value: { roomId: 'room-1', roomName: 'Room 204', accessToken: 'room-token-2' } };
    }

    async requestHelp(_identity: unknown, _category: unknown, message: string) {
      helpMessages.push(message);
      return { kind: 'accepted', request: { category: 'wrong-matchup', message: 'reported', id: 'help-1' } };
    }
  }

  return {
    default: StubClient,
    normalizeBaseUrl: (value: string) => ({ ok: true as const, value }),
  };
});

const { default: ConnectedRoom } = await import('../src/app/ConnectedRoom');

const pairedRoom = {
  baseUrl: 'http://control.local:8787',
  roomId: 'room-1',
  roomName: 'Room 204',
  roomToken: 'room-token',
  deviceId: 'device-1',
};

const definition = { ...validPackage(), origin: 'qbj' } as IGameDefinition;
type RoomProps = ComponentProps<typeof ConnectedRoom>;

function assignmentOf(overrides: Partial<INormalizedAssignment> = {}): INormalizedAssignment {
  return {
    state: 'none',
    roomId: 'room-1',
    roomName: 'Room 204',
    tournamentName: 'Ninety Six Invitational',
    definition: null,
    session: null,
    ...overrides,
  };
}

const ok = (value: INormalizedAssignment) => async () => ({ ok: true as const, value });

function renderRoom(overrides: Partial<RoomProps> = {}) {
  return render(
    <ConnectedRoom
      pairedRoom={pairedRoom}
      durable
      operatorName=""
      onOperatorNameChange={() => undefined}
      settingsConnection={{ roomName: 'Room 204', address: pairedRoom.baseUrl }}
      onForgetPairing={() => undefined}
      onResetDevicePreferences={() => undefined}
      practiceInProgress={false}
      onReadiness={() => undefined}
      onPractice={() => undefined}
      onOtherScoring={() => undefined}
      onChangeTournament={() => undefined}
      onResume={() => undefined}
      onStart={() => ({ ok: true })}
      onPaired={() => undefined}
      {...overrides}
    />,
  );
}

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
  assignmentCalls = 0;
  sessionCalls = 0;
  helpMessages = [];
  answer = ok(assignmentOf());
  sessionAnswer = async () => ({
    ok: true as const,
    value: { sessionId: 'session-1', token: 'session-token' },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the established room', () => {
  test('checks automatically and does not offer a manual check in the healthy waiting state', async () => {
    renderRoom();
    await settle();

    expect(assignmentCalls).toBe(1);
    expect(screen.getByText('Waiting for the next assignment.')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText(/QBSheet checks automatically/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start scoring' })).toBeNull();

    await poll();
    await poll();
    expect(assignmentCalls).toBe(3);
  });

  test('shows the opaque next-assignment label without interpreting it', async () => {
    answer = ok(assignmentOf({ nextAssignmentLabel: 'Round 5 · Clinton vs Greenwood' }));
    renderRoom();
    await settle();

    expect(screen.getByLabelText('Up next')).toHaveTextContent('Round 5 · Clinton vs Greenwood');
  });

  test('replaces the waiting state when a matchup arrives and preserves focus', async () => {
    renderRoom();
    await settle();
    const settings = screen.getByRole('button', { name: 'Settings' });
    settings.focus();

    answer = ok(
      assignmentOf({
        state: 'assigned',
        scheduledMatchId: 'match-5',
        definition,
      }),
    );
    await poll();

    expect(screen.getByText('Round 7 · Room 204')).toBeInTheDocument();
    expect(screen.getByText('Ninety Six A')).toBeInTheDocument();
    expect(screen.getByText('Greenwood')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start scoring' })).toBeEnabled();
    expect(screen.getByText('Packet 7')).toBeInTheDocument();
    expect(screen.queryByText('Packet Packet 7')).toBeNull();
    expect(screen.getByText('Paired', { exact: true })).toBeInTheDocument();
    expect(document.activeElement).toBe(settings);
  });

  test('does not open a session until Start scoring is pressed, then rechecks before starting', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    const onStart = vi.fn(() => ({ ok: true as const }));
    renderRoom({ onStart });
    await settle();

    expect(sessionCalls).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start scoring' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sessionCalls).toBe(1);
    expect(assignmentCalls).toBe(2);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test('disables room navigation and abandons a stale Start transaction on unmount', async () => {
    let finishSession: ((value: unknown) => void) | undefined;
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    sessionAnswer = () =>
      new Promise((resolve) => {
        finishSession = resolve;
      });
    const onStart = vi.fn(() => ({ ok: true as const }));
    renderRoom({ onStart });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Start scoring' }));
    await settle();

    expect(screen.getByRole('button', { name: 'Settings' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Something wrong?' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();

    cleanup();
    await act(async () => {
      finishSession?.({ ok: true, value: { sessionId: 'session-1', token: 'session-token' } });
      await Promise.resolve();
    });

    expect(onStart).not.toHaveBeenCalled();
  });

  test('shows the assignment room from the QBJ while keeping the paired room identity', async () => {
    answer = ok(
      assignmentOf({
        state: 'assigned',
        scheduledMatchId: 'match-5',
        definition: { ...definition, room: { id: 'room-205', name: 'Room 205' } },
      }),
    );
    renderRoom();
    await settle();

    expect(screen.getByText('Room 204', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Round 7 · Room 205')).toBeInTheDocument();
  });

  test('explains when an assigned game is missing its scheduled match identity', async () => {
    answer = ok(assignmentOf({ state: 'assigned', definition, scheduledMatchId: undefined }));
    renderRoom();
    await settle();

    expect(
      screen.getByText(
        'Tournament control has not supplied enough information to start yet. QBSheet will keep checking.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start scoring' })).toBeNull();
  });

  test('keeps the details-not-ready message when an assigned definition is absent', async () => {
    answer = ok(assignmentOf({ state: 'assigned', definition: null, scheduledMatchId: undefined }));
    renderRoom();
    await settle();

    expect(
      screen.getByText(
        'Tournament control assigned a game, but its details are not ready. QBSheet will keep checking.',
      ),
    ).toBeInTheDocument();
  });

  test('reports a failed Start as an action error rather than a failed poll', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    sessionAnswer = async () => ({
      ok: false as const,
      status: 500,
      error: 'Tournament control did not answer.',
    });
    renderRoom();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Start scoring' }));
    await settle();

    expect(
      screen.getByText(
        'Tournament control could not start this game. Tournament control did not answer. No scoring has started. Try Start scoring again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('QBSheet will keep trying automatically.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
  });

  test('moves focus into the note field after choosing an assignment problem', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    renderRoom();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Something wrong?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong packet' }));

    expect(screen.getByLabelText('Which packet does the reader actually have?')).toHaveFocus();
  });

  test('reports the assignment that was shown when the problem dialog opened', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    renderRoom();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Something wrong?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong packet' }));

    answer = ok(
      assignmentOf({
        state: 'assigned',
        scheduledMatchId: 'match-6',
        definition: { ...definition, room: { id: 'room-205', name: 'Room 205' } },
      }),
    );
    await poll();
    fireEvent.click(screen.getByRole('button', { name: 'Tell tournament control' }));
    await settle();

    expect(helpMessages).toHaveLength(1);
    expect(helpMessages[0]).toContain('Round 7 · Room 204');
    expect(helpMessages[0]).not.toContain('Room 205');
  });

  test('does not carry a problem receipt into a different scheduled match', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    renderRoom();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Something wrong?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wrong packet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tell tournament control' }));
    await settle();

    expect(
      screen.getByText('Tournament control has been notified about the assignment.'),
    ).toBeInTheDocument();

    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-6', definition }));
    await poll();

    expect(screen.queryByText('Tournament control has been notified about the assignment.')).toBeNull();
  });
});

describe('room recovery', () => {
  test('keeps the room paired after a transient failure and offers a contextual retry', async () => {
    answer = async () => ({ ok: false as const, status: 500, error: 'Tournament control did not answer.' });
    renderRoom();
    await settle();

    expect(screen.getByText('Tournament control did not answer.')).toBeInTheDocument();
    expect(screen.getByText('QBSheet will keep trying automatically.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try now' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();

    const afterFirst = assignmentCalls;
    await poll();
    expect(assignmentCalls).toBe(afterFirst + 1);
  });

  test('pauses automatic checks on 403 while retaining the room and offers a deliberate retry', async () => {
    answer = async () => ({
      ok: false as const,
      status: 403,
      detail: 'This page is not on the allowlist.',
      error: 'Forbidden',
    });
    renderRoom();
    await settle();

    expect(screen.getByText('This page is not on the allowlist.')).toBeInTheDocument();
    expect(screen.getByText('Automatic checks paused · try tournament control again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try tournament control again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();

    const afterFirst = assignmentCalls;
    await poll();
    expect(assignmentCalls).toBe(afterFirst);
    fireEvent.click(screen.getByRole('button', { name: 'Try tournament control again' }));
    await settle();
    expect(assignmentCalls).toBe(afterFirst + 1);
  });

  test('opens repair with the known room and only asks for a new code on 401', async () => {
    answer = async () => ({ ok: false as const, status: 401, error: 'Unknown room.' });
    renderRoom();
    await settle();

    expect(screen.getByText(/no longer recognizes Room 204/)).toBeInTheDocument();
    expect(screen.getByText('Automatic checks are paused.')).toBeInTheDocument();
    expect(screen.queryByText('QBSheet will keep trying automatically.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pair Room 204 again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pair Room 204 again' }));
    expect(screen.getByRole('dialog', { name: 'Pair Room 204 again' })).toBeInTheDocument();
    expect(screen.getByText(/address and room are already known/)).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
  });
});
