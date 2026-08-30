/**
 * The established room for a paired device.
 *
 * This is the scorekeeper's normal home between games. It owns assignment polling and the one
 * deliberate Start transaction, but it does not create a session or a local record merely because
 * an assignment was displayed. Pairing/setup lives in ConnectedSetup; a live scoresheet lives in
 * ScoringScreen. A healthy room stays quiet: the compact connection indicator is enough, while
 * timing/retry detail appears only when a check is pending or failing.
 */
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '../BrandLogo';
import { IStoredGameRecord } from '../game/GameStore';
import { IGameDefinition } from '../game/GameDefinition';
import { gamePackageMatchup } from '../game/GamePackage';
import deriveGame from '../scoring/deriveGame';
import ControlIcon from '../scorer/ControlIcon';
import FruityServerClient, {
  ApiResult,
  INormalizedAssignment,
  IRoomIdentity,
  ISessionCredentials,
} from '../integrations/fruity/FruityServerClient';
import { IPairedRoom } from './ConnectedSession';
import { assignmentPollIntervalMs, forbiddenIn } from './useConnectedRuntime';
import { connectionTimeline } from './ConnectionTimeline';
import { HelpRequestCategory, HelpRequestResult } from './HelpRequests';
import AssignmentProblemDialog, { assignmentLine } from './AssignmentProblemDialog';
import SettingsDialog, { ISettingsConnection } from './SettingsDialog';
import NativeDialog from './NativeDialog';
import { exchangePairingCode } from './ControlPairing';
import UpdateNotice from '../pwa/UpdateNotice';

export interface IConnectedStart {
  room: IPairedRoom;
  identity: IRoomIdentity;
  credentials: ISessionCredentials;
  tournamentKey?: string;
  definition: IGameDefinition;
  /** False once the room that owns this start transaction has unmounted or changed. */
  isCurrent?: () => boolean;
}

export type ConnectedStartResult = { ok: true } | { ok: false; error: string };

/** The assignment's semantic state, not the identity of the response object. */
export function assignmentStateKey(assignment: INormalizedAssignment | null): string {
  if (!assignment) return 'none';
  if (assignment.state === 'held') return 'held';
  if (assignment.state === 'blocked') return 'blocked';
  if (
    assignment.state === 'assigned' &&
    (!assignment.definition || assignment.scheduledMatchId === undefined)
  ) {
    return `assigned-incomplete:${assignment.scheduledMatchId ?? 'unknown'}`;
  }
  if (assignment.state === 'none') return 'none';
  return `assigned:${assignment.scheduledMatchId ?? 'unknown'}`;
}

export function lastCheckLabel(ageMs: number): string {
  if (ageMs < 60_000) return 'less than a minute ago';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'over an hour ago' : `over ${hours} hours ago`;
}

export function checkStatusLine(state: {
  forbidden: string;
  lastSuccessfulCheckAt: number | null;
  now: number;
  failing: boolean;
  credentialProblem?: boolean;
}): string {
  if (state.credentialProblem) return 'Automatic checks are paused.';
  if (state.forbidden !== '') return 'Automatic checks paused · try tournament control again.';
  if (state.lastSuccessfulCheckAt === null) return 'Checking tournament control…';
  const age = Math.max(0, state.now - state.lastSuccessfulCheckAt);
  if (state.failing)
    return `QBSheet will keep trying automatically · last successful check ${lastCheckLabel(age)}`;
  return `QBSheet checks automatically · checked ${age < 45_000 ? 'just now' : lastCheckLabel(age)}`;
}

function stateLine(assignment: INormalizedAssignment | null, busy: boolean): string {
  if (!assignment) return busy ? 'Checking tournament control…' : 'Waiting for the next assignment.';
  if (assignment.state === 'held') {
    return 'Tournament control has paused new starts. This room will be told when to begin.';
  }
  if (assignment.state === 'blocked') {
    return assignment.blockedMessage ?? 'Tournament control is holding this room.';
  }
  if (assignment.state === 'assigned' && !assignment.definition) {
    return 'Tournament control assigned a game, but its details are not ready. QBSheet will keep checking.';
  }
  if (assignment.state === 'assigned' && assignment.scheduledMatchId === undefined) {
    return 'Tournament control has not supplied enough information to start yet. QBSheet will keep checking.';
  }
  if (assignment.state === 'none') return 'Waiting for the next assignment.';
  return '';
}

function identityFor(room: IPairedRoom, operatorName: string): IRoomIdentity {
  return {
    roomId: room.roomId,
    token: room.roomToken,
    deviceId: room.deviceId,
    roomName: room.roomName,
    ...(operatorName.trim() !== '' ? { operatorName: operatorName.trim() } : {}),
  };
}

function progressFor(record: IStoredGameRecord): string {
  try {
    const game = deriveGame(record.package.scorekeeperFormat, record.setup, record.events);
    return game.tossupsRead === 0 ? 'Not started' : `${game.tossupsRead} tossups scored`;
  } catch {
    return 'In progress';
  }
}

function safeAssignmentFailure(result: ApiResult<unknown>): string {
  return result.ok
    ? 'Tournament control could not be reached.'
    : result.error || 'Tournament control could not be reached.';
}

function safeStartFailure(result: ApiResult<unknown>): string {
  return `Tournament control could not start this game. ${safeAssignmentFailure(result)} No scoring has started. Try Start scoring again.`;
}

interface IProblemReceipt {
  scheduledMatchId: string;
  message: string;
}

export default function ConnectedRoom(props: {
  pairedRoom: IPairedRoom;
  resumeRecord?: IStoredGameRecord | null;
  notice?: string;
  durable: boolean;
  storageDegraded?: boolean;
  storageError?: string;
  operatorName: string;
  onOperatorNameChange: (value: string) => void;
  settingsConnection: ISettingsConnection;
  pairingProtection?: string;
  onForgetPairing: () => void;
  onResetDevicePreferences: () => void;
  practiceInProgress: boolean;
  onReadiness: () => void;
  onPractice: () => void;
  onOtherScoring: () => void;
  onChangeTournament: () => void;
  onResume: (record: IStoredGameRecord) => void | Promise<void>;
  onStart: (start: IConnectedStart) => ConnectedStartResult | Promise<ConnectedStartResult>;
  onPaired: (room: IPairedRoom) => void;
}) {
  const {
    pairedRoom,
    resumeRecord = null,
    notice = '',
    durable,
    storageDegraded = false,
    storageError,
    operatorName,
    onOperatorNameChange,
    settingsConnection,
    pairingProtection,
    onForgetPairing,
    onResetDevicePreferences,
    onReadiness,
    onOtherScoring,
    onChangeTournament,
    onResume,
    onStart,
    onPaired,
  } = props;
  const [assignment, setAssignment] = useState<INormalizedAssignment | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [pollError, setPollError] = useState('');
  const [actionError, setActionError] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [roomCredentialProblem, setRoomCredentialProblem] = useState(false);
  const [lastSuccessfulCheckAt, setLastSuccessfulCheckAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [problemAssignment, setProblemAssignment] = useState<{
    packageValue: IGameDefinition;
    scheduledMatchId: string;
  } | null>(null);
  const [problemReceipt, setProblemReceipt] = useState<IProblemReceipt | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);

  const roomKey = `${pairedRoom.baseUrl}|${pairedRoom.roomId}|${pairedRoom.roomToken}`;
  const roomKeyRef = useRef(roomKey);
  const assignmentRequest = useRef<{ key: string; sequence: number } | null>(null);
  const assignmentSequence = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const forbiddenRef = useRef(forbidden);
  const roomCredentialProblemRef = useRef(roomCredentialProblem);
  const startingRef = useRef(false);
  const startGeneration = useRef(0);

  const client = useMemo(() => new FruityServerClient(pairedRoom.baseUrl), [pairedRoom.baseUrl]);
  const identity = useMemo(() => identityFor(pairedRoom, operatorName), [pairedRoom, operatorName]);

  // App keys this component by the persisted room binding, so a new pairing gets a fresh room
  // state instead of carrying the old assignment through. Keep this ref current for the narrow
  // case where a host reuses the component instance in an embedded test or shell.
  useEffect(() => {
    roomKeyRef.current = roomKey;
  }, [roomKey]);

  useEffect(() => {
    const generation = ++startGeneration.current;
    return () => {
      if (startGeneration.current === generation) startGeneration.current += 1;
    };
  }, [roomKey]);

  useEffect(() => {
    forbiddenRef.current = forbidden;
  }, [forbidden]);

  useEffect(() => {
    roomCredentialProblemRef.current = roomCredentialProblem;
  }, [roomCredentialProblem]);

  const noteFailure = useCallback((result: ApiResult<unknown>, message: string, source: 'poll' | 'start') => {
    if (!result.ok && result.status === 401) {
      setRoomCredentialProblem(true);
      roomCredentialProblemRef.current = true;
      setForbidden('');
      forbiddenRef.current = '';
      setPollFailed(false);
      setPollError('');
      setActionError('');
      return;
    }
    const refusal = forbiddenIn(result);
    if (refusal !== null) {
      setForbidden(refusal);
      forbiddenRef.current = refusal;
      if (source === 'poll') {
        setPollFailed(true);
        setPollError('');
      }
      setActionError('');
      return;
    }
    if (source === 'poll') {
      setPollFailed(true);
      setPollError(message);
    } else {
      setActionError(message);
    }
  }, []);

  const loadAssignment = useCallback(async () => {
    const key = roomKey;
    if (assignmentRequest.current?.key === key) return;
    const sequence = ++assignmentSequence.current;
    assignmentRequest.current = { key, sequence };
    setBusy(true);
    try {
      const result = await client.assignment(identity);
      if (roomKeyRef.current !== key || assignmentRequest.current?.sequence !== sequence) return;
      setNow(Date.now());
      if (!result.ok) {
        noteFailure(result, safeAssignmentFailure(result), 'poll');
        return;
      }
      setForbidden('');
      forbiddenRef.current = '';
      setRoomCredentialProblem(false);
      roomCredentialProblemRef.current = false;
      setPollFailed(false);
      setPollError('');
      setLastSuccessfulCheckAt(Date.now());
      setAssignment(result.value);
      setProblemReceipt((receipt) =>
        receipt && receipt.scheduledMatchId !== result.value.scheduledMatchId ? null : receipt,
      );
      if (result.value.errors?.length) setActionError(result.value.errors.join(' '));
      else setActionError('');
    } catch {
      if (roomKeyRef.current === key && assignmentRequest.current?.sequence === sequence) {
        setPollFailed(true);
        setPollError('Tournament control could not be reached.');
      }
    } finally {
      if (assignmentRequest.current?.sequence === sequence) {
        assignmentRequest.current = null;
        setBusy(false);
      }
    }
  }, [client, identity, noteFailure, roomKey]);

  useEffect(() => {
    loadRef.current = loadAssignment;
  }, [loadAssignment]);

  useEffect(() => {
    if (resumeRecord) return undefined;
    void loadRef.current();
    const timer = setInterval(() => {
      if (forbiddenRef.current !== '' || roomCredentialProblemRef.current) return;
      void loadRef.current();
    }, assignmentPollIntervalMs);
    return () => clearInterval(timer);
  }, [roomKey, resumeRecord]);

  const retryAssignment = () => {
    setActionError('');
    void loadAssignment();
  };

  const handleProblemReport = useCallback(
    async (category: HelpRequestCategory, message: string): Promise<HelpRequestResult> => {
      const result = await client.requestHelp(identity, category, message);
      if (result.kind === 'accepted' || result.kind === 'already-outstanding') {
        connectionTimeline.record(
          'control-requested',
          result.kind === 'already-outstanding' ? result.request.category : category,
        );
      } else if (result.kind === 'refused' && result.status === 401) {
        connectionTimeline.record('room-refused');
      } else if (result.kind === 'refused') {
        connectionTimeline.record('control-request-refused', category);
      } else {
        connectionTimeline.record('control-request-failed', category);
      }
      return result;
    },
    [client, identity],
  );

  const start = async () => {
    const selected = assignment;
    if (
      startingRef.current ||
      selected?.state !== 'assigned' ||
      !selected.definition ||
      selected.scheduledMatchId === undefined ||
      forbidden !== '' ||
      roomCredentialProblem
    ) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setActionError('');
    const expectedMatchId = selected.scheduledMatchId;
    const generation = startGeneration.current;
    const isCurrent = () => startGeneration.current === generation && roomKeyRef.current === roomKey;
    try {
      const session = await client.openSession(identity, expectedMatchId);
      if (!isCurrent()) return;
      if (!session.ok) {
        noteFailure(session, safeStartFailure(session), 'start');
        return;
      }
      // The assignment is deliberately read again at kickoff. A room may have been reassigned
      // between the display and the human press; opening the old session must not score the new game.
      const current = await client.assignment(identity);
      if (!isCurrent()) return;
      if (!current.ok) {
        noteFailure(current, safeStartFailure(current), 'start');
        return;
      }
      setAssignment(current.value);
      if (!current.value.definition) {
        setActionError('Tournament control started the game but did not say what to play. Check again.');
        return;
      }
      if (current.value.scheduledMatchId !== expectedMatchId) {
        setActionError(
          'Tournament control changed this room’s game while it was starting. Check the game shown and start again.',
        );
        return;
      }
      const outcome = await onStart({
        room: pairedRoom,
        identity,
        credentials: { sessionId: session.value.sessionId, token: session.value.token },
        ...(current.value.tournamentKey ? { tournamentKey: current.value.tournamentKey } : {}),
        definition: current.value.definition,
        isCurrent,
      });
      if (!isCurrent()) return;
      if (!outcome.ok) setActionError(outcome.error);
    } catch {
      if (isCurrent()) {
        setActionError(
          'Tournament control could not start this game. No scoring has started. Try Start scoring again.',
        );
      }
    } finally {
      if (startGeneration.current === generation) {
        startingRef.current = false;
        setStarting(false);
      }
    }
  };

  const assignmentDefinition = assignment?.definition;
  const startable =
    assignment?.state === 'assigned' &&
    assignmentDefinition !== null &&
    assignmentDefinition !== undefined &&
    assignment.scheduledMatchId !== undefined &&
    forbidden === '' &&
    !roomCredentialProblem;
  const assignmentKey = assignmentStateKey(assignment);
  const status = checkStatusLine({
    forbidden,
    lastSuccessfulCheckAt,
    now,
    failing: pollFailed,
    credentialProblem: roomCredentialProblem,
  });
  const healthyConnection =
    lastSuccessfulCheckAt !== null && !pollFailed && forbidden === '' && !roomCredentialProblem;
  const state = stateLine(assignment, busy);

  return (
    <main className="shell connected-room-shell">
      <header className="shell-header shell-header-row">
        <div>
          <h1 className="shell-title shell-brand-title">
            <BrandLogo className="shell-brand-logo" />
          </h1>
          <p className="room-title-line">{pairedRoom.roomName}</p>
          <p className="shell-subtitle">Paired</p>
          {healthyConnection && <p className="room-connection-indicator">Connected</p>}
        </div>
        <button
          type="button"
          className="shell-button shell-button-quiet shell-button-icon"
          onClick={() => setSettingsOpen(true)}
          disabled={starting}
          title="Settings"
          aria-label="Settings"
        >
          <ControlIcon name="settings" />
          <span className="shell-button-label">Settings</span>
        </button>
      </header>

      {(!durable || storageDegraded) && (
        <p className="shell-warning" role="alert">
          {!durable
            ? 'This browser will not let the scoresheet save anything. A game started here could be lost if the tab closes.'
            : 'The local game database is temporarily unavailable. Do not close an active game.'}{' '}
          {storageError}
        </p>
      )}
      {notice !== '' && (
        <p className="shell-notice" role="status">
          {notice}
        </p>
      )}

      {resumeRecord ? (
        <section className="shell-section room-resume" aria-labelledby="room-resume-heading">
          <h2 id="room-resume-heading" className="shell-heading">
            Resume this game
          </h2>
          <p className="assignment-context">{assignmentLine(resumeRecord.package)}</p>
          <p className="assignment-matchup">{gamePackageMatchup(resumeRecord.package)}</p>
          <p className="shell-hint">{progressFor(resumeRecord)}</p>
          <div className="shell-actions">
            <button
              type="button"
              className="shell-button is-primary"
              onClick={() => void onResume(resumeRecord)}
            >
              Resume scoring
            </button>
          </div>
        </section>
      ) : (
        <section className="shell-section room-assignment" aria-labelledby="room-assignment-heading">
          <h2 id="room-assignment-heading" className="visually-hidden">
            Current assignment
          </h2>
          <div className="assignment-state" aria-live="polite">
            <div key={assignmentKey} className="assignment-state-body">
              {state === '' && assignmentDefinition ? (
                <>
                  <p className="assignment-context">{assignmentLine(assignmentDefinition)}</p>
                  <p className="assignment-team">{assignmentDefinition.left.name}</p>
                  <p className="assignment-vs">vs</p>
                  <p className="assignment-team">{assignmentDefinition.right.name}</p>
                  <p
                    className={
                      assignmentDefinition.round.packetName ? 'pregame-packet' : 'pregame-packet is-missing'
                    }
                  >
                    {assignmentDefinition.round.packetName
                      ? /^packet\b/i.test(assignmentDefinition.round.packetName.trim())
                        ? assignmentDefinition.round.packetName
                        : `Packet ${assignmentDefinition.round.packetName}`
                      : 'No packet named for this round'}
                  </p>
                  <p className="pregame-tournament">{assignment?.tournamentName}</p>
                </>
              ) : (
                <p className="shell-hint">{state}</p>
              )}
            </div>
          </div>
          {status !== '' && !healthyConnection && <p className="assignment-check">{status}</p>}

          {assignment?.nextAssignmentLabel && (
            <aside className="assignment-next" aria-label="Up next">
              <span className="assignment-next-label">Up next</span>
              <span>{assignment.nextAssignmentLabel}</span>
            </aside>
          )}

          {assignmentDefinition?.assumptions && assignmentDefinition.assumptions.length > 0 && (
            <details className="assignment-details">
              <summary>Assignment details</summary>
              {assignmentDefinition.assumptions.map((assumption) => (
                <p className="shell-hint" key={assumption}>
                  {assumption}
                </p>
              ))}
            </details>
          )}

          {startable && (
            <div className="shell-actions room-primary-actions">
              <button
                type="button"
                className="shell-button is-primary"
                disabled={starting}
                onClick={() => void start()}
              >
                {starting ? 'Starting…' : assignment?.session?.resumable ? 'Resume scoring' : 'Start scoring'}
              </button>
              <button
                type="button"
                className="shell-button shell-button-quiet"
                disabled={starting}
                onClick={() => {
                  if (!assignmentDefinition || assignment?.scheduledMatchId === undefined) return;
                  setProblemAssignment({
                    packageValue: assignmentDefinition,
                    scheduledMatchId: assignment.scheduledMatchId,
                  });
                }}
              >
                Something wrong?
              </button>
            </div>
          )}
        </section>
      )}

      <div className="room-secondary-actions">
        <button
          type="button"
          className="shell-button shell-button-quiet"
          onClick={onOtherScoring}
          disabled={starting}
        >
          Other scoring options
        </button>
      </div>

      {forbidden !== '' && (
        <section className="shell-section room-recovery" aria-label="Tournament control recovery">
          <p className="shell-warning" role="alert">
            {forbidden}
          </p>
          <p className="shell-hint">This room is still paired. Automatic checks are paused.</p>
          <button type="button" className="shell-button" onClick={retryAssignment} disabled={busy}>
            Try tournament control again
          </button>
        </section>
      )}

      {roomCredentialProblem && (
        <section className="shell-section room-recovery" aria-label="Room pairing recovery">
          <p className="shell-warning" role="alert">
            Tournament control no longer recognizes {pairedRoom.roomName}.
          </p>
          <button type="button" className="shell-button" onClick={() => setRepairOpen(true)}>
            Pair {pairedRoom.roomName} again
          </button>
        </section>
      )}

      {pollFailed && forbidden === '' && !roomCredentialProblem && (
        <section className="shell-section room-recovery" aria-label="Temporary tournament control problem">
          <p className="shell-warning" role="alert">
            {pollError || 'Tournament control could not be reached.'}
          </p>
          <p className="shell-hint">QBSheet will keep trying automatically.</p>
          <button type="button" className="shell-button" onClick={retryAssignment} disabled={busy}>
            Try now
          </button>
        </section>
      )}

      {actionError !== '' && (
        <p className="shell-warning" role="alert">
          {actionError}
        </p>
      )}
      {problemReceipt && problemReceipt.scheduledMatchId === assignment?.scheduledMatchId && (
        <p className="shell-notice" role="status">
          {problemReceipt.message}
        </p>
      )}

      <UpdateNotice />

      {settingsOpen && (
        <SettingsDialog
          initialView="settings"
          operatorName={operatorName}
          onOperatorNameChange={onOperatorNameChange}
          connection={settingsConnection}
          pairingProtection={pairingProtection}
          onForgetPairing={onForgetPairing}
          onResetDevicePreferences={onResetDevicePreferences}
          onReadiness={onReadiness}
          onChangeTournament={onChangeTournament}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {problemAssignment && (
        <AssignmentProblemDialog
          packageValue={problemAssignment.packageValue}
          onReportProblem={handleProblemReport}
          onSent={(result) => {
            setProblemReceipt({
              scheduledMatchId: problemAssignment.scheduledMatchId,
              message:
                result.kind === 'already-outstanding'
                  ? 'Tournament control had already been notified about this room.'
                  : 'Tournament control has been notified about the assignment.',
            });
          }}
          onClose={() => setProblemAssignment(null)}
        />
      )}

      {repairOpen && (
        <RoomPairingRepair
          room={pairedRoom}
          onPaired={(room) => {
            setRepairOpen(false);
            onPaired(room);
          }}
          onClose={() => setRepairOpen(false)}
        />
      )}
    </main>
  );
}

function RoomPairingRepair(props: {
  room: IPairedRoom;
  onPaired: (room: IPairedRoom) => void;
  onClose: () => void;
}) {
  const { room, onPaired, onClose } = props;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await exchangePairingCode(
        new FruityServerClient(room.baseUrl),
        code,
        room.roomId,
        room.deviceId,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onPaired(result.value);
    } catch {
      setError('This room could not be paired. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <NativeDialog title={`Pair ${room.roomName} again`} onClose={onClose} className="room-repair-dialog">
      <p className="shell-hint">
        Tournament control no longer recognizes this room. The address and room are already known; enter only
        the new pairing code.
      </p>
      <form className="connect-form" onSubmit={(event) => void submit(event)}>
        <label className="shell-label" htmlFor="room-repair-code">
          Pairing code
        </label>
        <input
          id="room-repair-code"
          className="shell-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          data-dialog-autofocus
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" className="shell-button is-primary" disabled={busy || code.trim() === ''}>
          {busy ? 'Pairing…' : `Pair ${room.roomName} again`}
        </button>
      </form>
      {error !== '' && (
        <p className="shell-warning" role="alert">
          {error}
        </p>
      )}
    </NativeDialog>
  );
}
