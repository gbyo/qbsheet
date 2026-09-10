import { describe, expect, it } from 'vitest';
import { isTauriRuntime } from './native';

describe('Director native bridge', () => {
  it('does not claim desktop authority in a normal browser preview', () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it('uses an explicit desktop-only error for commands outside Tauri', async () => {
    const { getApplicationPaths } = await import('./native');
    await expect(getApplicationPaths()).rejects.toThrow(
      'This action is available from the QBSheet Director desktop app.',
    );
  });

  it('installs no close interception outside the desktop runtime (#731)', async () => {
    const { installCloseInterception } = await import('./native');
    const { getClosePerformer } = await import('../../../src/director/platform/closeGuard');
    const cleanup = await installCloseInterception();
    // No native close performer: the browser keeps beforeunload only, and no
    // destructive quit path is offered.
    expect(getClosePerformer()).toBeNull();
    cleanup();
  });
});
