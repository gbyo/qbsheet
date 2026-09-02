import { afterEach, expect, test, vi } from 'vitest';
import type { QbliveSnapshot } from '@qbsheet/qblive-protocol';
import { clearLocalLive, publishLocalLive, startLocalLiveServer, stopLocalLiveServer } from './localServer';

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

test('local mode discovers the bound listener, publishes locally, and never needs an origin input', async () => {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'director_live_server_status') return { running: false };
    if (command === 'director_start_live_server') {
      expect(args).toEqual({ port: 0 });
      return { running: true, address: '192.168.1.20', port: 49152, revision: 0 };
    }
    if (command === 'director_publish_local_live') {
      expect((args?.snapshot as QbliveSnapshot).teams).toEqual([]);
      return {
        running: true,
        address: '192.168.1.20',
        port: 49152,
        publicationId: 'bcdfghjkmnpqrstvwxyz',
        publicUrl: 'http://192.168.1.20:49152/live/bcdfghjkmnpqrstvwxyz',
        revision: 1,
      };
    }
    if (command === 'director_clear_local_live') {
      expect(args).toEqual({ rememberAsGone: true });
      return { running: true, address: '192.168.1.20', port: 49152, revision: 0 };
    }
    if (command === 'director_stop_live_server') return { running: false, revision: 0 };
    throw new Error(`unexpected command ${command}`);
  });
  window.__TAURI_INTERNALS__ = { invoke };

  const started = await startLocalLiveServer();
  expect(started.port).toBe(49152);
  const snapshot = { teams: [] } as unknown as QbliveSnapshot;
  const published = await publishLocalLive(snapshot);
  expect(published.publicUrl).toBe('http://192.168.1.20:49152/live/bcdfghjkmnpqrstvwxyz');
  await clearLocalLive(true);
  await stopLocalLiveServer();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    'director_live_server_status',
    'director_start_live_server',
    'director_publish_local_live',
    'director_clear_local_live',
    'director_stop_live_server',
  ]);
});
