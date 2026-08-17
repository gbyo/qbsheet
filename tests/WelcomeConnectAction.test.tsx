/**
 * @vitest-environment jsdom
 */

/**
 * The one button beside the address field.
 *
 * The homepage did not gain a QR feature; it gained a second state for a control it already had.
 * That distinction is the whole design and it is easy to lose to a well-meant refactor, so what is
 * asserted here is mostly about what did *not* change: still one action beside the field, still the
 * same form, still the same manual path from an address on a projector to a pairing code, and no
 * mode picker anywhere. The QR state is what an empty field offers instead of a Connect button that
 * has nothing to connect to.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { openApp } from './appHarness';
import { takePairingLaunch } from '../src/app/PairingLaunch';

vi.mock('../src/app/ControlPairing', async () => {
  const actual = await vi.importActual<typeof import('../src/app/ControlPairing')>('../src/app/ControlPairing');
  return {
    ...actual,
    openControl: vi.fn(async () => ({
      ok: true as const,
      value: { client: {}, tournamentName: 'Spring Invitational', rooms: [] },
    })),
  };
});

/** Whether the scanner dialog would have opened, without opening a camera to find out. */
const scannerOpened = vi.fn();

vi.mock('../src/app/QrScannerDialog', () => ({
  default: (props: { onClose: () => void; onDecoded: (text: string) => string | null }) => {
    scannerOpened(props.onDecoded);
    return (
      <div role="dialog" aria-label="Scan tournament QR code">
        <button type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    );
  },
}));

/** The tournament-control block on the homepage, which is where all of this lives. */
function connectSection(): HTMLElement {
  return screen.getByRole('region', { name: /Connect to (tournament control|a different tournament)/ });
}

function addressField(): HTMLInputElement {
  return screen.getByLabelText('Tournament control address') as HTMLInputElement;
}

async function type(value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(addressField(), { target: { value } });
  });
}

beforeEach(() => {
  scannerOpened.mockClear();
  window.history.replaceState(null, '', '/scoresheet/');
});

afterEach(() => {
  takePairingLaunch();
});

describe('the connect action beside the address field', () => {
  test('an empty field offers to scan, with an understandable name', async () => {
    await openApp();

    const action = within(connectSection()).getByRole('button', { name: 'Scan QR' });
    expect(action).toBeInTheDocument();
    // One action, not two. A permanent second button is the thing this design is avoiding.
    expect(within(connectSection()).getAllByRole('button')).toHaveLength(1);
    expect(within(connectSection()).queryByRole('button', { name: 'Connect' })).toBeNull();
    // The glyph is decoration; the name is the word.
    expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  test('typing an address turns that same control into Connect', async () => {
    await openApp();

    await type('192.168.1.24:3000');

    expect(within(connectSection()).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(within(connectSection()).queryByRole('button', { name: 'Scan QR' })).toBeNull();
    expect(within(connectSection()).getAllByRole('button')).toHaveLength(1);
  });

  test('clearing the address turns it back', async () => {
    await openApp();

    await type('192.168.1.24:3000');
    await type('');

    expect(within(connectSection()).getByRole('button', { name: 'Scan QR' })).toBeInTheDocument();
  });

  test('an address of nothing but spaces is still nothing to connect to', async () => {
    await openApp();

    await type('   ');

    expect(within(connectSection()).getByRole('button', { name: 'Scan QR' })).toBeInTheDocument();
  });

  test('Connect opens the pairing step in the same gesture', async () => {
    await openApp();

    await type('192.168.1.24:3000');
    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Connect' }));
    });

    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  test('Scan QR opens the scanner and does not touch the address field', async () => {
    await openApp();

    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Scan QR' }));
    });

    expect(screen.getByRole('dialog', { name: 'Scan tournament QR code' })).toBeInTheDocument();
    expect(scannerOpened).toHaveBeenCalledTimes(1);
    expect(addressField()).toHaveValue('');
  });

  test('closing the scanner leaves the homepage exactly as it was', async () => {
    await openApp();

    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Scan QR' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(screen.queryByRole('dialog', { name: 'Scan tournament QR code' })).toBeNull();
    expect(within(connectSection()).getByRole('button', { name: 'Scan QR' })).toBeInTheDocument();
  });
});

describe('what the scanner is told about a payload', () => {
  test('a pairing link takes the device to the ready state', async () => {
    await openApp();
    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Scan QR' }));
    });
    const onDecoded = scannerOpened.mock.calls[0][0] as (text: string) => string | null;

    let rejection: string | null = 'unset';
    await act(async () => {
      rejection = onDecoded(
        'https://qbsheet.com/#qbtcp-pair?v=1&server=http%3A%2F%2F192.168.1.24%3A3000&code=48213906&room=room-204',
      );
    });

    expect(rejection).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ready to connect' })).toBeInTheDocument();
    expect(screen.getByText('room-204')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('48213906');
  });

  test('an unrelated QR code is refused without closing the scanner', async () => {
    await openApp();
    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Scan QR' }));
    });
    const onDecoded = scannerOpened.mock.calls[0][0] as (text: string) => string | null;

    expect(onDecoded('WIFI:S=Venue;T=WPA;P=hunter2;;')).toContain('not a QBSheet pairing code');
    expect(screen.getByRole('dialog', { name: 'Scan tournament QR code' })).toBeInTheDocument();
  });

  test('a broken pairing QR code says which kind of wrong it is', async () => {
    await openApp();
    await act(async () => {
      fireEvent.click(within(connectSection()).getByRole('button', { name: 'Scan QR' }));
    });
    const onDecoded = scannerOpened.mock.calls[0][0] as (text: string) => string | null;

    expect(onDecoded('https://qbsheet.com/#qbtcp-pair?v=9&server=http%3A%2F%2Fa.b&code=1')).toBe(
      'This pairing link uses a version this build does not support.',
    );
  });
});
