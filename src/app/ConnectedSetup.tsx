/**
 * Connecting a room to tournament control, and then staying connected to it.
 *
 * # Pairing is once a tournament, not once a game
 *
 * A Chromebook is assigned to Room 204 in the morning and is still Room 204 at five o'clock. So the
 * pairing code is asked for once, the room capability is kept, and after that this screen is where
 * the room *lives*: it shows what the room is playing, or that it is waiting, and the scorekeeper
 * comes back to it between games. Sending somebody back through an address box and a pairing code
 * after every round is asking them to redo work the browser already remembers, eleven times a day,
 * under time pressure, with a code they have to go and find again.
 *
 * A new code is asked for in exactly one circumstance: tournament control refused the stored room
 * token. That is the only evidence that the pairing is actually gone.
 *
 * # Every step is a button
 *
 * Not a style choice. From Chrome 142 a page may only reach the local network after the person
 * using it has granted a permission, and that prompt appears in response to a user gesture. A page
 * that quietly probed an address on load would get a denial the scorekeeper never saw and an error
 * they could do nothing about. So the connection begins when somebody presses Connect — and the
 * room screen, which polls, is only ever reached through one.
 *
 * # A denial is not a dead end
 *
 * If the browser will not let this page reach the local network — the permission was refused, the
 * address is wrong, the laptop is on a different network, the venue's Wi-Fi isolates clients — the
 * room is told plainly and offered the file workflow, which needs none of it. Connected scoring is
 * a convenience for tournaments that have a server running. It is never a requirement for this
 * application to be useful.
 *
 * # Discovery happens before anything authenticated
 *
 * The first thing a client does with an address is ask what protocol it speaks. Everything after
 * that — pairing, the assignment, opening a session — goes through whichever surface it answered
 * with, and no code below this line knows which one that was.
 */
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import BrandLogo from '../BrandLogo';
import FruityServerClient, {
  INormalizedAssignment,
  IRoomIdentity,
  IRoomListEntry,
  ISessionCredentials,
  normalizeBaseUrl,
} from '../integrations/fruity/FruityServerClient';
import { IGameDefinition } from '../game/GameDefinition';
import { gamePackageMatchup } from '../game/GamePackage';
import { IPairedRoom, newDeviceId } from './ConnectedSession';
import { assignmentPollIntervalMs } from './useConnectedRuntime';

export interface IConnectedStart {
  room: IPairedRoom;
  identity: IRoomIdentity;
  credentials: ISessionCredentials;
  tournamentKey?: string;
  definition: IGameDefinition;
}

type Stage =
  | { kind: 'address' }
  | { kind: 'pair'; client: FruityServerClient; tournamentName: string; rooms: IRoomListEntry[] }
  | { kind: 'room'; client: FruityServerClient; room: IPairedRoom };

/** The room capability as an identity the client can use. Never rendered; see `ConnectedSession`. */
function identityFor(room: IPairedRoom): IRoomIdentity {
  return { roomId: room.roomId, token: room.roomToken, deviceId: room.deviceId, roomName: room.roomName };
}

/** What the room is being told about its situation, in one line. */
function stateLine(assignment: INormalizedAssignment | null, busy: boolean): string {
  if (!assignment) return busy ? 'Asking tournament control what this room is playing…' : '';
  if (assignment.state === 'held') {
    return 'Tournament control has paused new starts. This room will be told when to begin.';
  }
  if (assignment.state === 'blocked') {
    return assignment.blockedMessage ?? 'Tournament control is holding this room.';
  }
  if (assignment.state === 'none' || !assignment.definition) {
    return 'Waiting for the next assignment.';
  }
  return '';
}

export default function ConnectedSetup(props: {
  initialBaseUrl: string;
  /** A room this device is already paired with. Present means the address and the code are settled. */
  pairedRoom: IPairedRoom | null;
  /** Called the moment a code is exchanged, so the capability survives a reload before any game. */
  onPaired: (room: IPairedRoom) => void;
  onStart: (start: IConnectedStart) => void | Promise<void>;
  /** Tournament control refused the stored room token. The pairing really is gone. */
  onRoomLost: () => void;
  onCancel: () => void;
}) {
  const { initialBaseUrl, pairedRoom, onPaired, onStart, onRoomLost, onCancel } = props;
  const [address, setAddress] = useState(pairedRoom?.baseUrl ?? initialBaseUrl);
  const [stage, setStage] = useState<Stage>(() =>
    pairedRoom
      ? { kind: 'room', client: new FruityServerClient(pairedRoom.baseUrl), room: pairedRoom }
      : { kind: 'address' },
  );
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState(false);
  const [code, setCode] = useState('');
  const [roomId, setRoomId] = useState('');
  const [assignment, setAssignment] = useState<INormalizedAssignment | null>(null);

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
    // The client discovers on its first call, so this also settles which surface everything below
    // will use. Nothing here or later needs to know which one that turned out to be.
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
      rooms: rooms.ok ? rooms.value : [],
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
    const room: IPairedRoom = {
      baseUrl: stage.client.baseUrl,
      roomId: joined.value.roomId,
      roomName: joined.value.roomName,
      roomToken: joined.value.accessToken,
      // A device identity is stable for as long as the pairing is, so a re-pair of the same browser
      // keeps the identity tournament control has been arbitrating writer ownership with.
      deviceId: pairedRoom?.deviceId ?? newDeviceId(),
    };
    // Written before anything else can fail. A room that paired and then lost the tab must not have
    // to find the code again.
    onPaired(room);
    setCode('');
    setAssignment(null);
    setStage({ kind: 'room', client: stage.client, room });
  };

  const loadAssignment = useCallback(async () => {
    if (stage.kind !== 'room') return;
    setBusy(true);
    setError('');
    const result = await stage.client.assignment(identityFor(stage.room));
    setBusy(false);
    if (!result.ok) {
      // A refused room token is the one thing that sends a scorekeeper back to a pairing code. Any
      // other failure is the network's problem and the room keeps its capability.
      if (result.status === 401 || result.status === 403) {
        onRoomLost();
        setAssignment(null);
        setError('Tournament control no longer recognizes this room. Pair it again with a new code.');
        setStage({ kind: 'pair', client: stage.client, tournamentName: '', rooms: [] });
        return;
      }
      setError(result.error);
      return;
    }
    setAssignment(result.value);
    if (result.value.errors?.length) setError(result.value.errors.join(' '));
  }, [stage, onRoomLost]);

  const loadRef = useRef(loadAssignment);
  loadRef.current = loadAssignment;

  // The room screen keeps itself current, so a scorekeeper who finishes a game and comes back here
  // sees the next assignment appear rather than having to ask for it. Only ever reached by a press,
  // which is what satisfies the browser's local-network gesture requirement.
  useEffect(() => {
    if (stage.kind !== 'room') return undefined;
    void loadRef.current();
    const timer = setInterval(() => void loadRef.current(), assignmentPollIntervalMs);
    return () => clearInterval(timer);
  }, [stage]);

  const start = async () => {
    if (stage.kind !== 'room' || !assignment?.definition || !assignment.scheduledMatchId) return;
    setStarting(true);
    setError('');
    const identity = identityFor(stage.room);
    // The same call whether this is a new game or the one already open: both surfaces return the
    // existing session rather than creating a second one, which is what makes resume free.
    const session = await stage.client.openSession(identity, assignment.scheduledMatchId);
    if (!session.ok) {
      setStarting(false);
      setError(session.error);
      return;
    }
    // Re-read the assignment so the game is built from the rosters as they stand at kickoff rather
    // than as they stood when the room paired, which may have been an hour ago.
    const current = await stage.client.assignment(identity);
    setStarting(false);
    if (!current.ok || !current.value.definition) {
      setError('Tournament control started the game but did not say what to play.');
      return;
    }
    // The session was opened against one game and this is the answer about another, which means
    // control moved the room between the two calls. Starting anyway would file the new game's
    // scoresheet under the old game's session. Pressing Start again picks up the current one.
    if (current.value.scheduledMatchId !== assignment.scheduledMatchId) {
      setError('Tournament control changed this room’s game while it was starting. Check the game shown and start again.');
      return;
    }
    await onStart({
      room: stage.room,
      identity,
      credentials: { sessionId: session.value.sessionId, token: session.value.token },
      ...(current.value.tournamentKey ? { tournamentKey: current.value.tournamentKey } : {}),
      definition: current.value.definition,
    });
  };

  const resumable = assignment?.session?.resumable === true && assignment.session.finalReceived !== true;
  // The scheduled match is what a session is opened against, so an assignment without one cannot be
  // started. Enabling the button for it would make Start a control that visibly does nothing.
  const startable =
    assignment?.state === 'assigned' && assignment.definition !== null && assignment.scheduledMatchId !== undefined;
  const waiting = stateLine(assignment, busy);

  return (
    <main className="shell">
      <header className="shell-header">
        <h1 className="shell-title shell-brand-title">
          <BrandLogo className="shell-brand-logo" />
        </h1>
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
          <h2 className="shell-heading">{stage.tournamentName || 'Pair this room'}</h2>
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

      {stage.kind === 'room' && (
        <section className="shell-section">
          <h2 className="shell-heading">{stage.room.roomName} · Connected</h2>
          {assignment?.tournamentName && <p className="shell-subtitle">{assignment.tournamentName}</p>}
          {waiting === '' && assignment?.definition ? (
            <p className="assignment-matchup">
              {assignment.definition.round.name} · {gamePackageMatchup(assignment.definition)}
            </p>
          ) : (
            <p className="shell-hint">{waiting}</p>
          )}
          {resumable && (
            <p className="shell-notice">Tournament control still has this room&apos;s game open.</p>
          )}
          {assignment?.definition?.assumptions?.map((assumption) => (
            <p className="shell-hint" key={assumption}>
              {assumption}
            </p>
          ))}
          <div className="shell-actions">
            <button
              type="button"
              className="shell-button is-primary"
              disabled={starting || !startable}
              onClick={() => void start()}
            >
              {starting ? 'Starting…' : resumable ? 'Resume scoring' : 'Start scoring'}
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
