/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { INormalizedAssignment } from '../src/integrations/fruity/FruityServerClient';
import type { IGameDefinition } from '../src/game/GameDefinition';
import { validPackage } from './packages';

vi.mock('../src/pwa/useAppUpdate', () => ({
  useAppUpdate: () => ({ available: false, applying: false }),
}));

let answer: () => Promise<unknown>;

vi.mock('../src/integrations/fruity/FruityServerClient', () => {
  class StubClient {
    constructor(public baseUrl: string) {}

    async assignment() {
      return answer();
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderRoom() {
  return render(
    <ConnectedRoom
      pairedRoom={pairedRoom}
      durable
      operatorName=""
      onOperatorNameChange={() => undefined}
      settingsConnection={{ roomName: pairedRoom.roomName, address: pairedRoom.baseUrl }}
      onForgetPairing={() => undefined}
      onResetDevicePreferences={() => undefined}
      practiceInProgress={false}
      onReadiness={() => undefined}
      onPractice={() => undefined}
      onCreateGame={() => undefined}
      onOtherScoring={() => undefined}
      onChangeTournament={() => undefined}
      onResume={() => undefined}
      onStart={() => ({ ok: true })}
      onPaired={() => undefined}
    />,
  );
}

afterEach(cleanup);

describe('Connected Room manual fallback', () => {
  test('opens the existing manual creator directly without using the general scoring escape hatch', async () => {
    answer = ok(assignmentOf({ state: 'none' }));
    const onCreateGame = vi.fn();
    const onOtherScoring = vi.fn();

    render(
      <ConnectedRoom
        pairedRoom={pairedRoom}
        durable
        operatorName=""
        onOperatorNameChange={() => undefined}
        settingsConnection={{ roomName: pairedRoom.roomName, address: pairedRoom.baseUrl }}
        onForgetPairing={() => undefined}
        onResetDevicePreferences={() => undefined}
        practiceInProgress={false}
        onReadiness={() => undefined}
        onPractice={() => undefined}
        onCreateGame={onCreateGame}
        onOtherScoring={onOtherScoring}
        onChangeTournament={() => undefined}
        onResume={() => undefined}
        onStart={() => ({ ok: true })}
        onPaired={() => undefined}
      />,
    );

    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Create game manually' }));

    expect(onCreateGame).toHaveBeenCalledTimes(1);
    expect(onOtherScoring).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Other scoring options' })).toBeInTheDocument();
  });

  test('recedes while a valid tournament assignment is ready (#832)', async () => {
    answer = ok(assignmentOf({ state: 'assigned', scheduledMatchId: 'match-5', definition }));
    renderRoom();

    await settle();

    expect(screen.getByRole('button', { name: 'Start scoring' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create game manually' })).not.toBeInTheDocument();
    // Manual scoring stays reachable through the general escape hatch.
    expect(screen.getByRole('button', { name: 'Other scoring options' })).toBeInTheDocument();
  });

  test('returns when the assignment is incomplete (delivery failure)', async () => {
    answer = ok(assignmentOf({ state: 'assigned' }));
    renderRoom();

    await settle();

    expect(screen.getByRole('button', { name: 'Create game manually' })).toBeInTheDocument();
  });
});
