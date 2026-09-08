import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ConnectedSetup from '../src/app/ConnectedSetup';
import { exchangePairingCode, openControl } from '../src/app/ControlPairing';

vi.mock('../src/app/ControlPairing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/ControlPairing')>();
  return { ...actual, openControl: vi.fn(), exchangePairingCode: vi.fn() };
});

const mockedOpenControl = vi.mocked(openControl);
const mockedExchangePairingCode = vi.mocked(exchangePairingCode);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('connected setup lifecycle', () => {
  test('a successful launch pairing is ignored after the user leaves setup', async () => {
    mockedOpenControl.mockReset();
    mockedExchangePairingCode.mockReset();
    mockedOpenControl.mockResolvedValue({
      ok: true,
      value: { client: {}, tournamentName: 'Lifecycle Invitational', rooms: [] },
    } as never);
    const pendingPair = deferred<never>();
    mockedExchangePairingCode.mockReturnValue(pendingPair.promise as never);
    const onPaired = vi.fn();

    const { unmount } = render(
      <ConnectedSetup
        initialBaseUrl=""
        launch={{ version: 1, server: 'http://control:8080', code: '123456', roomId: 'room-1' }}
        onPaired={onPaired}
        onPairingLaunch={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect and pair' }));
    await waitFor(() => expect(mockedExchangePairingCode).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      pendingPair.resolve({
        ok: true,
        value: {
          baseUrl: 'http://control:8080',
          roomId: 'room-1',
          roomName: 'Room 1',
          roomToken: 'token-1',
          deviceId: 'device-1',
        },
      } as never);
      await pendingPair.promise;
    });

    expect(onPaired).not.toHaveBeenCalled();
  });
});
