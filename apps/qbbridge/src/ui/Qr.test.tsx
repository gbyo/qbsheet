import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import bridgePackage from '../../package.json';
import { pairingLink } from '../model/pairing';
import Qr from './Qr';

const relay = {
  baseUrl: 'https://relay.example.workers.dev',
  tournamentId: 'bcdfghjkmnpqrstvwxyz2345',
};

describe('printed pairing QR provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T18:45:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('identifies the Bridge build and active pairing-code generation without adding a new secret', () => {
    const pairing = pairingLink({ ...relay, code: '48213906', roomId: 'room-204' });
    render(
      <div className="room-print-sheet">
        <Qr url={pairing.url} roomName="Room 204" />
      </div>,
    );

    const stamp = screen.getByText(new RegExp(`QBBridge ${bridgePackage.version}`));
    expect(stamp).toHaveTextContent('Pairing code ends 3906');
    expect(stamp).toHaveTextContent('Use only the newest sheet for this room.');
    expect(stamp).not.toHaveTextContent('management');
    expect(stamp).not.toHaveTextContent('bearer');
    expect(stamp).not.toHaveTextContent('setup token');
  });

  test('keeps the ordinary QR accessible while the paper-only stamp is ignored by assistive technology', () => {
    const pairing = pairingLink({ ...relay, code: '48213906', roomId: 'room-204' });
    render(<Qr url={pairing.url} roomName="Room 204" />);

    expect(screen.getByRole('img', { name: /Pairing QR code for Room 204/ })).toBeInTheDocument();
    expect(screen.getByText(/Use only the newest sheet for this room/)).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});
