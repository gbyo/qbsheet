/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import useConnectedRuntime from '../src/app/useConnectedRuntime';
import FruityServerClient from '../src/integrations/fruity/FruityServerClient';

describe('connected write authorization commits', () => {
  test('a final cannot be sent from the commit that disables connected delivery', () => {
    const postFinal = vi.fn(async () => ({
      ok: true as const,
      value: { received: true },
    }));
    const client = {
      baseUrl: 'http://127.0.0.1:8787',
      // Keep the initial connected poll in flight so it cannot introduce an unrelated state update
      // while this test isolates the permission mirror's commit timing.
      assignment: vi.fn(() => new Promise(() => undefined)),
      postFinal,
    } as unknown as FruityServerClient;

    function Harness({ enabled }: { enabled: boolean }) {
      const runtime = useConnectedRuntime({
        client,
        identity: { roomId: 'room-1', token: 'room-token' },
        credentials: { sessionId: 'session-1', token: 'session-token' },
        enabled,
      });
      const submitted = useRef(false);

      // useConnectedRuntime's commit effects are registered before this one. That makes this the
      // deterministic version of a click arriving after the DOM commit but before passive effects.
      useLayoutEffect(() => {
        if (enabled || submitted.current) return;
        submitted.current = true;
        void runtime.submitFinal({ tossups_read: 20 });
      }, [enabled, runtime.submitFinal]);

      return null;
    }

    const view = render(<Harness enabled />);
    view.rerender(<Harness enabled={false} />);

    expect(postFinal).not.toHaveBeenCalled();
    view.unmount();
  });
});
