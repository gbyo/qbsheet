/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import { assignmentPollIntervalMs } from '../src/app/useConnectedRuntime';
import { IGameDefinition } from '../src/game/GameDefinition';
import { validPackage } from './packages';

let answer: () => Promise<unknown>;
let assignmentCalls = 0;
let sessionCalls = 0;

vi.mock('../src/integrations/fruity/FruityServerClient', () => {
  class StubClient {
    constructor(public baseUrl: string) {}

    async assignment() {
      assignmentCalls += 1;
      return answer();
    }

    async openSession() {
      sessionCalls += 1;
      return { ok: true, value: { sessionId: 'session-1', token: 'session-token' } };
    }

    async join() {
      return { ok: true, value: { roomId: 'room-1', roomName: 'Room 204', accessToken: 'room-token-2' } };
    }

    async requestHelp() {
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

function renderRoom() {
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
  answer = ok(assignmentOf());
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
    expect(screen.getByText('QBSheet checks automatically · checked just now')).toBeInTheDocument();
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

    expect(screen.getByText('Room 204 · Round 7')).toBeInTheDocument();
    expect(screen.getByText('Ninety Six A')).toBeInTheDocument();
    expect(screen.getByText('Greenwood')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start scoring' })).toBeEnabled();
    expect(document.activeElement).toBe(settings);
  });

  test('does not open a session until Start scoring is pressed, then rechecks before starting', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    const onStart = vi.fn(() => ({ ok: true as const }));
    render(
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
        onStart={onStart}
        onPaired={() => undefined}
      />,
    );
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
    expect(screen.getByRole('button', { name: 'Pair Room 204 again' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Pair Room 204 again' }));
    expect(screen.getByRole('dialog', { name: 'Pair Room 204 again' })).toBeInTheDocument();
    expect(screen.getByText(/address and room are already known/)).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
  });
});
