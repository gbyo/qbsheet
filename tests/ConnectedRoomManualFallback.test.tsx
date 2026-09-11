/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/pwa/useAppUpdate', () => ({
  useAppUpdate: () => ({ available: false, applying: false }),
}));

vi.mock('../src/integrations/fruity/FruityServerClient', () => {
  class StubClient {
    constructor(public baseUrl: string) {}

    async assignment() {
      return {
        ok: true as const,
        value: {
          state: 'none' as const,
          roomId: 'room-1',
          roomName: 'Room 204',
          tournamentName: 'Ninety Six Invitational',
          definition: null,
          session: null,
        },
      };
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

afterEach(cleanup);

describe('Connected Room manual fallback', () => {
  test('opens the existing manual creator directly without using the general scoring escape hatch', async () => {
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

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create game manually' }));

    expect(onCreateGame).toHaveBeenCalledTimes(1);
    expect(onOtherScoring).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Other scoring options' })).toBeInTheDocument();
  });
});
