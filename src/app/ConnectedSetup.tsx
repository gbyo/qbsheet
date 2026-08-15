/**
 * The explicit pairing flow for a device that does not yet have an operational room.
 *
 * Pairing is setup, not the room itself. Once the exchange succeeds App stores the room capability
 * and mounts ConnectedRoom. Keeping the two concepts separate is important: a room can wait for
 * many assignments without asking for its address or pairing code again.
 *
 * Every entry method still ends in the same `openControl` → `exchangePairingCode` sequence. A launch
 * link or a scanned QR payload is inert until the user presses its button, which is the gesture the
 * browser needs before it permits a local-network request. Pairing codes remain in memory only until
 * the exchange consumes them.
 */
import { FormEvent, useState } from 'react';
import BrandLogo from '../BrandLogo';
import FruityServerClient from '../integrations/fruity/FruityServerClient';
import { IControlConnection, exchangePairingCode, openControl } from './ControlPairing';
import { IPairedRoom } from './ConnectedSession';
import { IPairingLaunchIntent, parsePairingLaunchUrl } from './PairingLaunch';
import { connectionTimeline } from './ConnectionTimeline';
import QrScannerDialog from './QrScannerDialog';
import ControlIcon from '../scorer/ControlIcon';
import UpdateNotice from '../pwa/UpdateNotice';

type Stage =
  | { kind: 'address' }
  /** A pairing link waiting for the user gesture that is allowed to reach the LAN. */
  | { kind: 'launch'; intent: IPairingLaunchIntent }
  | {
      kind: 'pair';
      client: FruityServerClient;
      tournamentName: string;
      rooms: IControlConnection['rooms'];
      roomsError?: string;
    };

export default function ConnectedSetup(props: {
  initialBaseUrl: string;
  launch?: IPairingLaunchIntent | null;
  /** Preserve the device identity when replacing a pairing. */
  existingDeviceId?: string;
  onPaired: (room: IPairedRoom) => void;
  onPairingLaunch: (intent: IPairingLaunchIntent) => void;
  onOtherScoring?: () => void;
  /** Back is appropriate here because no operational room has been established in this flow. */
  onCancel: () => void;
}) {
  const {
    initialBaseUrl,
    launch = null,
    existingDeviceId,
    onPaired,
    onPairingLaunch,
    onOtherScoring,
    onCancel,
  } = props;
  const [address, setAddress] = useState(launch?.server ?? initialBaseUrl);
  const [stage, setStage] = useState<Stage>(() => (launch ? { kind: 'launch', intent: launch } : { kind: 'address' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState(false);
  const [code, setCode] = useState('');
  const [roomId, setRoomId] = useState('');
  const [scanning, setScanning] = useState(false);

  const askForCode = (connection: IControlConnection, suggestedRoomId = '') => {
    setStage({
      kind: 'pair',
      client: connection.client,
      tournamentName: connection.tournamentName,
      rooms: connection.rooms,
      ...(connection.roomsError === undefined ? {} : { roomsError: connection.roomsError }),
    });
    setRoomId(suggestedRoomId);
  };

  const adoptRoom = (room: IPairedRoom) => {
    setCode('');
    setRoomId('');
    connectionTimeline.record('room-repaired', room.roomName);
    onPaired(room);
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setUnreachable(false);
    try {
      const opened = await openControl(address);
      if (!opened.ok) {
        setUnreachable(opened.unreachable);
        setError(opened.error);
        return;
      }
      askForCode(opened.value);
    } catch {
      setError('Tournament control could not be reached. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (stage.kind !== 'pair' || busy) return;
    setBusy(true);
    setError('');
    try {
      const paired = await exchangePairingCode(stage.client, code, roomId, existingDeviceId);
      if (!paired.ok) {
        setError(paired.error);
        return;
      }
      adoptRoom(paired.value);
    } catch {
      setError('This room could not be paired. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const connectAndPair = async () => {
    if (stage.kind !== 'launch' || busy) return;
    setBusy(true);
    setError('');
    setUnreachable(false);
    try {
      const opened = await openControl(stage.intent.server);
      if (!opened.ok) {
        setUnreachable(opened.unreachable);
        setError(opened.error);
        return;
      }
      const paired = await exchangePairingCode(
        opened.value.client,
        stage.intent.code,
        stage.intent.roomId,
        existingDeviceId,
      );
      if (!paired.ok) {
        setError(paired.error);
        askForCode(opened.value, stage.intent.roomId ?? '');
        return;
      }
      adoptRoom(paired.value);
    } catch {
      setError('This room could not be paired. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const readScannedCode = (text: string): string | null => {
    const parsed = parsePairingLaunchUrl(text);
    if (parsed.kind === 'problem') return parsed.message;
    if (parsed.kind === 'none') return 'That is not a QBSheet pairing code. Look for the QR code tournament control is showing.';
    setScanning(false);
    onPairingLaunch(parsed.intent);
    return null;
  };

  const addressEmpty = address.trim() === '';

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title shell-brand-title">
          <BrandLogo className="shell-brand-logo" />
        </h1>
      </header>

      {stage.kind === 'launch' && (
        <section className="shell-section">
          <h2 className="shell-heading">Ready to connect</h2>
          {stage.intent.roomId !== undefined && <p className="shell-subtitle">{stage.intent.roomId}</p>}
          <p className="shell-hint">{stage.intent.server.replace(/^http:\/\//i, '')}</p>
          <div className="shell-actions">
            <button
              type="button"
              className="shell-button is-primary"
              disabled={busy}
              onClick={() => void connectAndPair()}
            >
              {busy ? 'Connecting…' : 'Connect and pair'}
            </button>
          </div>
        </section>
      )}

      {stage.kind === 'address' && (
        <section className="shell-section">
          <h2 className="shell-heading">Connect to tournament control</h2>
          <form className="connect-form" onSubmit={(event) => void connect(event)}>
            <label className="shell-label" htmlFor="setup-address">
              Tournament control address
            </label>
            <div className="welcome-connect-fields setup-connect-fields">
              <input
                id="setup-address"
                className="shell-input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="http://"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
              {addressEmpty ? (
                <button
                  type="button"
                  className="shell-button is-primary welcome-scan-button"
                  onClick={() => setScanning(true)}
                >
                  <ControlIcon name="qr" />
                  Scan QR
                </button>
              ) : (
                <button type="submit" className="shell-button is-primary" disabled={busy}>
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {stage.kind === 'pair' && (
        <section className="shell-section">
          <h2 className="shell-heading">{stage.tournamentName || 'Pair this room'}</h2>
          {stage.roomsError && <p className="shell-warning" role="status">{stage.roomsError}</p>}
          <form className="connect-form" onSubmit={(event) => void pair(event)}>
            {stage.rooms.length > 0 && (
              <>
                <label className="shell-label" htmlFor="setup-room">
                  Room
                </label>
                <select
                  id="setup-room"
                  className="shell-input"
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                >
                  <option value="">Any room</option>
                  {stage.rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <label className="shell-label" htmlFor="setup-code">
              Pairing code
            </label>
            <input
              id="setup-code"
              className="shell-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button type="submit" className="shell-button is-primary" disabled={busy || code.trim() === ''}>
              {busy ? 'Pairing…' : 'Pair this room'}
            </button>
          </form>
        </section>
      )}

      {error !== '' && (
        <div className="shell-errors" role="alert">
          <p>{error}</p>
          {unreachable && <p>You can still score with a game file.</p>}
        </div>
      )}

      {unreachable && onOtherScoring && (
        <section className="shell-section">
          <p className="shell-hint">
            The browser may have refused this page permission to reach the local network, the address may be
            wrong, or tournament control may be on another network. None of that stops a game being scored
            from a file.
          </p>
          <button type="button" className="shell-button is-primary" onClick={onOtherScoring}>
            Open a game file
          </button>
        </section>
      )}

      <UpdateNotice />

      <div className="shell-actions">
        <button type="button" className="shell-button" onClick={onCancel}>
          Back
        </button>
      </div>

      {scanning && <QrScannerDialog onClose={() => setScanning(false)} onDecoded={readScannedCode} />}
    </main>
  );
}

// Kept as a compatibility export for the small pure status helpers; ownership now belongs to the
// established-room component rather than the pairing flow.
export { assignmentStateKey, checkStatusLine, lastCheckLabel } from './ConnectedRoom';
