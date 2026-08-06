import { FormEvent, useEffect, useState } from 'react';
import { getJoinRooms, getOrCreateDeviceId, IRoomIdentity, joinRoom, rememberRoomIdentity } from './api';
import { IRoomJoinDescriptor } from '../main/server/ServerTypes';

/** The intentionally small landing page for a new or forgotten room browser. */
export default function JoinRoomApp() {
  const [rooms, setRooms] = useState<IRoomJoinDescriptor[]>([]);
  const [roomId, setRoomId] = useState('');
  const [code, setCode] = useState('');
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getJoinRooms()
      .then((result) => {
        if (!cancelled) {
          setLoadingRooms(false);
          if (result.ok) {
            setRooms(result.value.rooms);
            if (result.value.rooms.length === 1) setRoomId(result.value.rooms[0].id);
          } else setError(result.error);
        }
        return result;
      })
      .catch(() => {
        if (!cancelled) {
          setLoadingRooms(false);
          setError('Could not reach the YellowFruit computer.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setJoining(true);
    const result = await joinRoom({ code, roomId: roomId || undefined });
    setJoining(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const identity: IRoomIdentity = {
      roomId: result.value.roomId,
      token: result.value.accessToken,
      deviceId: getOrCreateDeviceId(),
    };
    rememberRoomIdentity(identity);
    // The token is intentionally never put in this navigation URL. RoomApp adopts the stored identity.
    window.location.assign(`/room/${encodeURIComponent(identity.roomId)}`);
  };

  return (
    <main className="room-shell room-join-shell">
      <header className="room-header">
        <p className="room-tournament">YellowFruit</p>
        <h1 className="room-name">Join a scoring room</h1>
      </header>
      <p className="room-muted">Enter the 8-digit code printed on the room sheet or shown by tournament control.</p>

      <form className="room-join-form" onSubmit={submit}>
        {rooms.length > 1 && (
          <label className="room-field-label" htmlFor="room-join-room">
            Room
            <select id="room-join-room" value={roomId} onChange={(event) => setRoomId(event.target.value)}>
              <option value="">Any enabled room</option>
              {rooms.map((room) => (
                <option value={room.id} key={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="room-field-label" htmlFor="room-join-code">
          Pairing code
          <input
            id="room-join-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="4827 1934"
            aria-describedby="room-join-help"
          />
        </label>
        <p id="room-join-help" className="room-muted room-join-help">
          Spaces and a hyphen are okay.
        </p>
        {error !== '' && <div className="room-banner room-banner-error">{error}</div>}
        {loadingRooms && <p className="room-muted">Checking which rooms are available&hellip;</p>}
        <button type="submit" className="room-button" disabled={joining || code.trim() === ''}>
          {joining ? 'Joining…' : 'Join room'}
        </button>
      </form>

      <p className="room-join-manual">
        <a href="/room/manual">Score manually instead</a>
      </p>
    </main>
  );
}
