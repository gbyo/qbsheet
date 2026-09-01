/**
 * Pairing and established-room screens share the ordinary inline update treatment. The homepage is
 * the only call site allowed to turn the same state into an environmental hero.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ConnectedSetup from '../src/app/ConnectedSetup';

vi.mock('../src/pwa/useAppUpdate', () => ({
  useAppUpdate: () => ({ available: true, applying: false }),
}));

describe('the pairing screen update notice', () => {
  test('uses the default compact presentation', () => {
    render(
      <ConnectedSetup
        initialBaseUrl=""
        onPaired={() => undefined}
        onPairingLaunch={() => undefined}
        onCancel={() => undefined}
      />,
    );

    const notice = screen.getByText('A new version of QBSheet is ready on this device.').closest('section');
    expect(notice).toHaveAttribute('data-update-presentation', 'compact');
    expect(notice).not.toHaveClass('update-notice-hero');
    expect(screen.getByRole('button', { name: 'Update now' })).not.toHaveClass('is-primary');
  });
});
