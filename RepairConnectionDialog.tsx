/**
 * Re-pairing a Chromebook without taking the game away from it.
 *
 * # Why this exists at all
 *
 * The room page used to answer a 403 by clearing the remembered identity, clearing the scoring kit
 * and navigating to /join. That is a reasonable thing to do to an idle browser and a catastrophic
 * thing to do to one in the middle of round 4: tournament control resetting a room's access, or
 * restoring a tournament file with new tokens in it, would take a scorekeeper mid-tossup to a
 * pairing form with no game and no way back to one.
 *
 * A credential problem is an operational problem. So the game stays exactly where it is, this
 * appears over the top of it, and the only thing that changes on success is the token the page uses
 * for its next request.
 *
 * # Why it refuses a different room
 *
 * A code for another room would re-point this browser at an assignment that has nothing to do with
 * the game on screen. Silently adopting it would file round 4 of Room 204 against Room 118's
 * schedule. So the mismatch is surfaced and nothing is changed: the game stays intact and a human
 * decides, which for a genuinely mis-paired browser means downloading the QBJ and handing it over.
 */
import { FormEvent, useEffect, useState } from 'react';
import { IRoomJoinDescriptor } from '../main/server/ServerTypes';
import { getJoinRooms, getOrCreateDeviceId, IRoomIdentity, joinRoom, rememberRoomIdentity } from './api';

export interface IRepairConnectionDialogProps {
  /** The room this browser is, and must stay. */
  roomId: string;
  /** True while a game is on screen, which is what makes a room mismatch a conflict rather than a choice. */
  gameInProgress: boolean;
  onRepaired: (identity: IRoomIdentity) => void;
  onDownloadBackup: () => void;
  onClose: () => void;
}

export default function RepairConnectionDialog(props: IRepairConnectionDialogProps) {
  const { roomId, gameInProgress, onRepaired, onDownloadBackup, onClose } = props;
  const [rooms, setRooms] = useState<IRoomJoinDescriptor[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mismatch, setMismatch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getJoinRooms()
      .then((result) => {
        if (!cancelled && result.ok) setRooms(result.value.rooms);
        return result;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const thisRoom = rooms.find((room) => room.id === roomId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setMismatch(null);
    setBusy(true);
    const result = await joinRoom({ code, roomId });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (result.value.roomId !== roomId) {
      // Never silently migrate a game to another assignment. See the file comment.
      setMismatch(result.value.roomName);
      return;
    }
    const identity: IRoomIdentity = {
      roomId: result.value.roomId,
      token: result.value.accessToken,
      deviceId: getOrCreateDeviceId(),
    };
    rememberRoomIdentity(identity);
    onRepaired(identity);
  };

  return (
    <div className="room-repair-backdrop" role="dialog" aria-modal="true" aria-label="Repair room connection">
      <div className="room-repair">
        <h2 className="room-repair-title">Repair this room&apos;s connection</h2>
        <p className="room-muted">
          {gameInProgress
            ? 'The game on screen is saved on this device and is not affected by this. Enter the pairing code for '
            : 'Enter the pairing code for '}
          <strong>{thisRoom?.name ?? 'this room'}</strong> from the room sheet or from tournament control.
        </p>
        {mismatch === null ? (
          <form className="room-join-form" onSubmit={submit}>
            <label className="room-field-label" htmlFor="room-repair-code">
              Pairing code
              <input
                id="room-repair-code"
                value={code}
                onChange={(changeEvent) => setCode(changeEvent.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="4827 1934"
              />
            </label>
            {error !== '' && <div className="room-banner room-banner-error">{error}</div>}
            <div className="room-repair-actions">
              <button type="submit" className="room-button" disabled={busy || code.trim() === ''}>
                {busy ? 'Checking…' : 'Repair connection'}
              </button>
              <button type="button" className="room-button-secondary" onClick={onDownloadBackup}>
                Download QBJ backup
              </button>
              <button type="button" className="room-button-secondary" onClick={onClose}>
                Not now
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="room-banner room-banner-warning">
              <strong>That code is for {mismatch}, not this room.</strong>
              <div>
                Nothing has been changed. {gameInProgress ? 'The game on screen is still saved on this device. ' : ''}
                Download the QBJ and give it to tournament control, or get the code for this room and try again.
              </div>
            </div>
            <div className="room-repair-actions">
              <button
                type="button"
                className="room-button"
                onClick={() => {
                  setMismatch(null);
                  setCode('');
                }}
              >
                Try another code
              </button>
              <button type="button" className="room-button-secondary" onClick={onDownloadBackup}>
                Download QBJ backup
              </button>
              <button type="button" className="room-button-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
