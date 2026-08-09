/**
 * Connecting a room to tournament control, once, before a game starts.
 *
 * # Every step is a button
 *
 * Not a style choice. From Chrome 142 a page may only reach the local network after the person
 * using it has granted a permission, and that prompt appears in response to a user gesture. A page
 * that quietly probed an address on load would get a denial the scorekeeper never saw and an error
 * they could do nothing about. So the connection begins when somebody presses Connect.
 *
 * # A denial is not a dead end
 *
 * If the browser will not let this page reach the local network — the permission was refused, the
 * address is wrong, the laptop is on a different network, the venue's Wi-Fi isolates clients — the
 * room is told plainly and offered the file workflow, which needs none of it. Connected scoring is
 * a convenience for tournaments that have a server running. It is never a requirement for this
 * application to be useful.
 *
 * # Nothing here is remembered until it works
 *
 * The address and the token are written to storage by the caller, after a session exists. A failed
 * attempt leaves nothing behind for the next one to trip over.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import FruityServerClient, {
  IJoinResult,
  IRoomIdentity,
  IRoomListEntry,
  ISessionCredentials,
  normalizeBaseUrl,
} from '../integrations/fruity/FruityServerClient';
import { assignmentToGamePackage } from '../integrations/fruity/FruityGameSource';
import { IGamePackage, gamePackageMatchup } from '../game/GamePackage';
import { newDeviceId } from './ConnectedSession';

export interface IConnectedStart {
  baseUrl: string;
  identity: IRoomIdentity;
  roomName: string;
  credentials: ISessionCredentials;
  tournamentKey?: string;
  package: IGamePackage;
}

type Stage =
  | { kind: 'address' }
  | { kind: 'pair'; client: FruityServerClient; tournamentName: string; rooms: IRoomListEntry[] }
  | { kind: 'assignment'; client: FruityServerClient; identity: IRoomIdentity; roomName: string };

export default function ConnectedSetup(props: {
  initialBaseUrl: string;
  onStart: (start: IConnectedStart) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { initialBaseUrl, onStart, onCancel } = props;
  const [address, setAddress] = useState(initialBaseUrl);
  const [stage, setStage] = useState<Stage>({ kind: 'address' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState(false);
  const [code, setCode] = useState('');
  const [roomId, setRoomId] = useState('');
  const [matchupText, setMatchupText] = useState('');
  const [startable, setStartable] = useState<{ scheduledMatchId: string } | null>(null);
  const [blocked, setBlocked] = useState('');

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBaseUrl(address);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    setBusy(true);
    setError('');
    setUnreachable(false);
    const client = new FruityServerClient(normalized.value);
    const verified = await client.verify();
    if (!verified.ok) {
      setBusy(false);
      // No status at all is the shape of both "nothing is there" and "this browser refused to go
      // there", and the room can act on either the same way.
      setUnreachable(verified.status === undefined);
      setError(
        verified.status === undefined
          ? 'Tournament control could not be reached from this browser.'
          : verified.error,
      );
      return;
    }
    const identified = await client.identify();
    const rooms = await client.listRooms();
    setBusy(false);
    if (!identified.ok) {
      setError(identified.error);
      return;
    }
    setStage({
      kind: 'pair',
      client,
      tournamentName: identified.value.name,
      rooms: rooms.ok ? rooms.value.rooms : [],
    });
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (stage.kind !== 'pair') return;
    setBusy(true);
    setError('');
    const joined = await stage.client.join(code.trim(), roomId === '' ? undefined : roomId);
    setBusy(false);
    if (!joined.ok) {
      setError(joined.error);
      return;
    }
    const result: IJoinResult = joined.value;
    setStage({
      kind: 'assignment',
      client: stage.client,
      identity: {
        roomId: result.roomId,
        token: result.accessToken,
        deviceId: newDeviceId(),
      },
      roomName: result.roomName,
    });
  };

  const loadAssignment = useCallback(async () => {
    if (stage.kind !== 'assignment') return;
    setBusy(true);
    setError('');
    setBlocked('');
    const result = await stage.client.assignment(stage.identity);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const assignment = result.value;
    if (assignment.blockedMessage) setBlocked(assignment.blockedMessage);
    if (!assignment.current) {
      setMatchupText('');
      setStartable(null);
      return;
    }
    setMatchupText(
      `${assignment.current.roundName} · ${assignment.current.leftTeam.name} vs ${assignment.current.rightTeam.name}`,
    );
    setStartable(assignment.blockedMessage ? null : { scheduledMatchId: assignment.current.scheduledMatchId });
  }, [stage]);

  useEffect(() => {
    if (stage.kind === 'assignment') void loadAssignment();
  }, [stage, loadAssignment]);

  const start = async () => {
    if (stage.kind !== 'assignment' || !startable) return;
    setBusy(true);
    setError('');
    const session = await stage.client.startAssignedMatch(stage.identity, startable.scheduledMatchId);
    if (!session.ok) {
      setBusy(false);
      setError(session.error);
      return;
    }
    // Re-read the assignment so the package is built from the rosters as they stand at kickoff
    // rather than as they stood when the room paired, which may have been an hour ago.
    const assignment = await stage.client.assignment(stage.identity);
    setBusy(false);
    if (!assignment.ok || !assignment.value.current) {
      setError('Tournament control started the game but did not say what to play.');
      return;
    }
    const built = assignmentToGamePackage({
      assignment: assignment.value,
      matchup: assignment.value.current,
    });
    if (!built.ok) {
      setError(built.errors.join(' '));
      return;
    }
    await onStart({
      baseUrl: stage.client.baseUrl,
      identity: stage.identity,
      roomName: stage.roomName,
      credentials: { sessionId: session.value.sessionId, token: session.value.token },
      tournamentKey: assignment.value.tournamentKey,
      package: built.value,
    });
  };

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title">QBSheet</h1>
      </header>

      {stage.kind === 'address' && (
        <section className="shell-section">
          <h2 className="shell-heading">Connect to tournament control</h2>
          <form className="connect-form" onSubmit={connect}>
            <label className="shell-label" htmlFor="setup-address">
              Tournament control address
            </label>
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
            <button type="submit" className="shell-button is-primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        </section>
      )}

      {stage.kind === 'pair' && (
        <section className="shell-section">
          <h2 className="shell-heading">{stage.tournamentName}</h2>
          <form className="connect-form" onSubmit={pair}>
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
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button type="submit" className="shell-button is-primary" disabled={busy}>
              {busy ? 'Pairing…' : 'Pair this room'}
            </button>
          </form>
        </section>
      )}

      {stage.kind === 'assignment' && (
        <section className="shell-section">
          <h2 className="shell-heading">{stage.roomName}</h2>
          {matchupText === '' ? (
            <p className="shell-hint">
              {busy ? 'Asking tournament control what this room is playing…' : 'This room has nothing assigned yet.'}
            </p>
          ) : (
            <p className="assignment-matchup">{matchupText}</p>
          )}
          {blocked !== '' && <p className="shell-warning">{blocked}</p>}
          <div className="shell-actions">
            <button
              type="button"
              className="shell-button is-primary"
              disabled={busy || !startable}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Start scoring'}
            </button>
            <button type="button" className="shell-button" disabled={busy} onClick={() => void loadAssignment()}>
              Check again
            </button>
          </div>
        </section>
      )}

      {error !== '' && (
        <div className="shell-errors" role="alert">
          <p>{error}</p>
          {unreachable && <p>You can still score with a game file.</p>}
        </div>
      )}

      {unreachable && (
        <section className="shell-section">
          <p className="shell-hint">
            The browser may have refused this page permission to reach the local network, the address may be
            wrong, or the tournament computer may be on a different network. None of that stops a game being
            scored from a file.
          </p>
          <button type="button" className="shell-button is-primary" onClick={onCancel}>
            Open game file
          </button>
        </section>
      )}

      <div className="shell-actions">
        <button type="button" className="shell-button" onClick={onCancel}>
          Back
        </button>
      </div>
    </main>
  );
}

/** Exported for tests: the matchup line a room sees before it presses Start. */
export function matchupLine(packageValue: IGamePackage): string {
  return `${packageValue.round.name} · ${gamePackageMatchup(packageValue)}`;
}
