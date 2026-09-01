import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getAppDataPaths,
  initializeDirectorStore,
  isNativeRuntime,
  openTournamentFile,
  saveTournamentSnapshot,
} from './tauri';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn(async () => ({
      select: vi.fn(async () => [{ ready: 1 }]),
    })),
  },
}));

vi.mock('@tauri-apps/plugin-window-state', () => ({
  StateFlags: { ALL: 63 },
  saveWindowState: vi.fn(),
}));

describe('Tauri command boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('does not invoke native commands in the browser preview', async () => {
    expect(isNativeRuntime()).toBe(false);
    expect(await getAppDataPaths()).toBeNull();
    expect(await openTournamentFile()).toBeNull();
    expect(await saveTournamentSnapshot('{}', 'snapshot.json')).toBeNull();
    expect(await initializeDirectorStore()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('passes file operations through to Rust in the native runtime', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        appData: '/data',
        appConfig: '/config',
        appLocalData: '/local',
        appCache: '/cache',
        appLog: '/log',
      })
      .mockResolvedValueOnce({ path: '/tmp/round.qbj', contents: '{}' })
      .mockResolvedValueOnce('/tmp/snapshot.json');

    expect(isNativeRuntime()).toBe(true);
    await expect(getAppDataPaths()).resolves.toEqual({
      appData: '/data',
      appConfig: '/config',
      appLocalData: '/local',
      appCache: '/cache',
      appLog: '/log',
    });
    await expect(openTournamentFile()).resolves.toEqual({ path: '/tmp/round.qbj', contents: '{}' });
    await expect(saveTournamentSnapshot('{}', 'snapshot.json')).resolves.toBe('/tmp/snapshot.json');
    expect(invoke).toHaveBeenNthCalledWith(3, 'save_tournament_snapshot', {
      contents: '{}',
      defaultName: 'snapshot.json',
    });
  });
});
