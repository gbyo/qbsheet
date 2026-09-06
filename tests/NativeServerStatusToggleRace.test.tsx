import { useLayoutEffect } from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

describe('native server status toggle timing', () => {
  test('a toggle from the commit that shows a running server stops it instead of starting again', async () => {
    const native = await import('../src/director/platform/native');
    const read = vi.spyOn(native, 'readNativeServerStatus').mockResolvedValue({ running: true });
    const start = vi.spyOn(native, 'startNativeServer').mockResolvedValue({ running: true });
    const stop = vi.spyOn(native, 'stopNativeServer').mockResolvedValue({ running: false });
    const { useNativeServerStatus } = await import('../src/director/server/useNativeServerStatus');

    let toggled = false;
    function Harness() {
      const server = useNativeServerStatus({ active: true });
      useLayoutEffect(() => {
        if (server.status.running && !toggled) {
          toggled = true;
          void server.toggle();
        }
      }, [server.status.running, server.toggle]);
      return null;
    }

    const { unmount } = render(<Harness />);

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(start).not.toHaveBeenCalled();

    unmount();
    read.mockRestore();
    start.mockRestore();
    stop.mockRestore();
  });
});
