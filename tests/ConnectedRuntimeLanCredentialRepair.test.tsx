/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';
import useConnectedRuntime from '../src/app/useConnectedRuntime';

function client(baseUrl: string, assignment: () => Promise<unknown>): FruityServerClient {
  return {
    baseUrl,
    assignment: vi.fn(assignment),
  } as unknown as FruityServerClient;
}

describe('connected runtime room credential repair routing', () => {
  test('routes a LAN assignment 401 to the LAN credential repair', async () => {
    const primary = client('https://relay.example/tournament', async () => ({
      ok: true,
      value: { state: 'none' },
    }));
    const lan = client('http://192.168.1.20:8787', async () => ({
      ok: false,
      error: 'Room token was refused.',
      status: 401,
    }));
    const onRepairConnection = vi.fn();

    const { result, unmount } = renderHook(() =>
      useConnectedRuntime({
        client: primary,
        identity: { roomId: 'room-1', token: 'relay-room-token', deviceId: 'device-1' },
        credentials: { sessionId: 'relay-session', token: 'relay-session-token' },
        enabled: true,
        lanClient: lan,
        lanIdentity: { roomId: 'room-1', token: 'lan-room-token', deviceId: 'device-1' },
        lanCredentials: { sessionId: 'lan-session', token: 'lan-session-token' },
        initialLan: true,
        onRepairConnection,
        socketFactory: null,
      }),
    );

    await waitFor(() => {
      expect(result.current.alerts.some((alert) => alert.id === 'credentials')).toBe(true);
    });

    const alert = result.current.alerts.find((candidate) => candidate.id === 'credentials');
    const action = alert?.actions?.[0];
    expect(action).toBeDefined();
    act(() => action?.onSelect());

    expect(onRepairConnection).toHaveBeenCalledTimes(1);
    expect(onRepairConnection).toHaveBeenCalledWith('lan');
    unmount();
  });
});
