/**
 * Everything the network does while a connected game is on screen.
 *
 * # The rule
 *
 * Once a game is on screen, nothing arriving over the network may take it off. Not a timeout, not a
 * 500, not a shutdown, not a 403, not a reassignment, not the server having opened a different
 * tournament. Those are operational problems with somebody's day; none of them is permission to
 * destroy the only copy of what a room has scored.
 *
 * The mechanical consequence is that this file contains no navigation of any kind — no assignment
 * to `location`, no route change, no unmounting of the scoresheet — and it never clears the game
 * package or the event history. What it produces instead is a connection state, a list of alerts
 * with actions attached, and a set of callbacks. Every network problem becomes something the room
 * is *told*, next to a scoresheet that still works.
 *
 * # Repair happens here, in place, with the game still running
 *
 * QBTCP distinguishes three failures that look identical from a distance and need opposite
 * responses, so this file keeps them apart:
 *
 *   - The **room token** was refused. The pairing is gone; a person types a new code. Only this one
 *     needs a code, and offering one for either of the others is how a scorekeeper ends up hunting
 *     for a slip of paper to fix something that was not broken.
 *   - The **session token** was refused. The pairing is fine, so the room reopens the same session
 *     with the capability it still holds. Both surfaces return the open session rather than making
 *     a second one, so this is a repair and not a new game.
 *   - Another device holds the **writer** lock. Nothing here resolves that, because two live devices
 *     that both decided they were authoritative is worse than one that is waiting. A person presses
 *     Take over, or does not.
 *
 * None of the three stops the scorekeeper scoring, and none of them unmounts anything.
 *
 * # Local first, always
 *
 * Scoring is local. This hook watches the game and offers the latest state to control on a trailing
 * interval; it is never in the path of a click. The final is delivered after the result is durably
 * recorded, and its failure changes what the completion screen says rather than whether the game
 * exists.
 *
 * # Reconnection converges rather than replays
 *
 * When the server comes back, the room does not send the hundred intermediate states it did not
 * send while it was away. It sends the current one. The server keeps one snapshot per session, so
 * the newest picture is the whole of what anybody wanted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomConnectionState } from './ConnectionState';
import { IScorerAlert } from '../scorer/ConnectionStatus';
import FruityServerClient, {
  ApiResult,
  IResultReceipt,
  IRoomIdentity,
  ISessionCredentials,
  IWriterConflict,
  readWriterConflict,
} from '../integrations/fruity/FruityServerClient';
import { ProgressSender } from '../integrations/fruity/FruityResultDestination';
import { HelpRequestCategory } from './HelpRequests';

/** How often a room asks control what it should be playing. */
export const assignmentPollIntervalMs = 10_000;

/** New credentials a repair produced, for the caller to persist. */
export interface ICredentialRepair {
  sessionId?: string;
  sessionToken?: string;
}

export interface IConnectedRuntimeInput {
  client: FruityServerClient;
  identity: IRoomIdentity;
  credentials: ISessionCredentials;
  /** The scheduled game this room is scoring, so a reassignment is detectable and a reopen is possible. */
  scheduledMatchId?: string;
  /** The tournament this game belongs to, so a server that has opened another one is detectable. */
  tournamentKey?: string;
  /**
   * False for a game with no tournament control behind it.
   *
   * The hook is still constructed, because React does not allow a conditional one, but nothing is
   * polled and nothing is sent. Everything it reports is inert.
   */
  enabled: boolean;
  /** Offer to pair this room again, in place. Never navigates. */
  onRepairConnection?: () => void;
  /** A repair produced new session credentials. Persist them; the game does not change. */
  onCredentialsRepaired?: (repair: ICredentialRepair) => void;
}

export interface IConnectedRuntime {
  connection: RoomConnectionState;
  /** Set when control answered but the poll failed: the game is real, the room state may be stale. */
  degradedMessage?: string;
  alerts: IScorerAlert[];
  /** Epoch ms of the last snapshot control accepted, or null. */
  serverSnapshotAt: number | null;
  snapshotError?: string;
  /** False once control has refused this room's credentials: writes stop, the game does not. */
  automaticDelivery: boolean;
  /** Offer the latest scoresheet for the next trailing snapshot. Safe to call every render. */
  reportProgress: (qbj: object) => void;
  submitFinal: (qbj: object) => Promise<ApiResult<IResultReceipt>>;
  recoverFromServer: () => Promise<object | null>;
  syncRosterPlayer: (teamName: string, playerName: string) => Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
  requestControl: (category: HelpRequestCategory, message: string) => Promise<void>;
  controlRequestPending: boolean;
}

/** Decide the connection state from one poll, without reading any message text. */
export function classifyPoll(result: ApiResult<unknown>): {
  connection: RoomConnectionState;
  credentialProblem: boolean;
} {
  if (result.ok) return { connection: RoomConnectionState.Connected, credentialProblem: false };
  // No status means nothing answered: DNS, a refused connection, dropped Wi-Fi, or our own timeout
  // abort. That, and only that, is what "offline" means to a scorekeeper.
  if (result.status === undefined) return { connection: RoomConnectionState.Offline, credentialProblem: false };
  // The room link is not valid for the tournament control is running. That is a credential problem,
  // not a connection problem, and it is repaired by pairing again rather than by retrying.
  if (result.status === 403 || result.status === 401) {
    return { connection: RoomConnectionState.Connected, credentialProblem: true };
  }
  return { connection: RoomConnectionState.Degraded, credentialProblem: false };
}

/**
 * What a refused write means, in the vocabulary of the three repairs.
 *
 * `401` on a session token is the session's problem alone: the room capability that opened it is
 * untouched, which is exactly why reopening works. `409` is a person's problem.
 */
export function classifyWrite(result: ApiResult<unknown>): {
  sessionProblem: boolean;
  conflict: IWriterConflict | null;
} {
  if (result.ok || result.status === undefined) return { sessionProblem: false, conflict: null };
  if (result.status === 401) return { sessionProblem: true, conflict: null };
  if (result.status === 409) return { sessionProblem: false, conflict: readWriterConflict(result.payload) };
  return { sessionProblem: false, conflict: null };
}

export default function useConnectedRuntime(input: IConnectedRuntimeInput): IConnectedRuntime {
  const {
    client,
    identity,
    credentials,
    scheduledMatchId,
    tournamentKey,
    enabled,
    onRepairConnection,
    onCredentialsRepaired,
  } = input;

  const [connection, setConnection] = useState(RoomConnectionState.Connected);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>(undefined);
  const [roomCredentialProblem, setRoomCredentialProblem] = useState(false);
  const [sessionCredentialProblem, setSessionCredentialProblem] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | undefined>(undefined);
  const [writerConflict, setWriterConflict] = useState<IWriterConflict | null>(null);
  const [reassigned, setReassigned] = useState(false);
  const [tournamentSwitched, setTournamentSwitched] = useState(false);
  const [serverSnapshotAt, setServerSnapshotAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | undefined>(undefined);
  const [controlRequestPending, setControlRequestPending] = useState(false);

  /**
   * Whether it is still safe to write to this session.
   *
   * Turned off by a credential failure, a writer conflict, or by control having opened a different
   * tournament, and never turned back on by anything except a successful repair. The point is to
   * stop filing snapshots against the wrong event, with credentials control has withdrawn, or over
   * another device's work — not to stop the room, which keeps scoring either way.
   */
  const writesAllowed =
    enabled && !roomCredentialProblem && !sessionCredentialProblem && !tournamentSwitched && writerConflict === null;
  const writesAllowedRef = useRef(writesAllowed);
  writesAllowedRef.current = writesAllowed;

  /** The newest complete game state, retained so a later successful poll can re-offer it. */
  const latestSnapshotRef = useRef<object | null>(null);

  /**
   * Reopen this room's session with the room capability it still holds.
   *
   * Not a takeover and not a new game: both surfaces answer an open request for an assignment that
   * already has a session with that same session, so this either returns what the room had or tells
   * it that control has moved on.
   */
  const repairSession = useCallback(async (): Promise<boolean> => {
    if (!scheduledMatchId) {
      setRepairMessage('This game has no scheduled match to reopen. Finish it and hand the QBJ over.');
      return false;
    }
    const opened = await client.openSession(identity, scheduledMatchId);
    if (!opened.ok) {
      setRepairMessage(opened.error);
      return false;
    }
    setRepairMessage(undefined);
    setSessionCredentialProblem(false);
    setWriterConflict(opened.value.writer ? null : { canTakeOver: true });
    onCredentialsRepaired?.({ sessionId: opened.value.sessionId, sessionToken: opened.value.token });
    return true;
  }, [client, identity, scheduledMatchId, onCredentialsRepaired]);

  const takeOverWriter = useCallback(async () => {
    const result = await client.takeWriter(identity, credentials);
    if (!result.ok) {
      setRepairMessage(result.error);
      return;
    }
    setRepairMessage(undefined);
    setWriterConflict(null);
    onCredentialsRepaired?.({ sessionId: result.value.sessionId, sessionToken: result.value.token });
  }, [client, identity, credentials, onCredentialsRepaired]);

  /**
   * One unattended reopen per session problem, and no more.
   *
   * A session token that stopped working is almost always a restarted server rather than a decision
   * about this room, and making a scorekeeper press a button for that is noise. Repeating it is
   * not: a server that refuses the reopen is saying something, and a loop would keep asking.
   */
  const autoRepairAttempted = useRef(false);
  const noteWrite = useCallback((result: ApiResult<unknown>) => {
    const classified = classifyWrite(result);
    if (classified.sessionProblem) setSessionCredentialProblem(true);
    if (classified.conflict) setWriterConflict(classified.conflict);
  }, []);

  useEffect(() => {
    if (!sessionCredentialProblem || autoRepairAttempted.current) return;
    autoRepairAttempted.current = true;
    void repairSession();
  }, [sessionCredentialProblem, repairSession]);

  // New credentials arrived, so whatever was wrong with the old ones is not a live problem.
  useEffect(() => {
    autoRepairAttempted.current = false;
    setSessionCredentialProblem(false);
  }, [credentials.token]);

  const sender = useMemo(
    () =>
      new ProgressSender(async (qbj) => {
        if (!writesAllowedRef.current) return;
        const result = await client.putSnapshot(credentials, qbj);
        if (result.ok) {
          setServerSnapshotAt(Date.now());
          setSnapshotError(undefined);
        } else {
          setSnapshotError(result.detail);
          noteWrite(result);
        }
      }),
    [client, credentials, noteWrite],
  );
  useEffect(() => () => sender.stop(), [sender]);

  // The assignment poll. Its only outputs are state; it can neither start nor stop a game.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const poll = async () => {
      const result = await client.assignment(identity);
      if (cancelled) return;
      const classified = classifyPoll(result);
      setConnection(classified.connection);
      if (classified.credentialProblem) setRoomCredentialProblem(true);
      if (!result.ok) {
        setDegradedMessage(
          classified.connection === RoomConnectionState.Degraded
            ? result.detail ?? 'Tournament control answered, but not with anything this room could use.'
            : undefined,
        );
        return;
      }
      setDegradedMessage(undefined);
      setRoomCredentialProblem(false);
      const assignment = result.value;
      if (tournamentKey && assignment.tournamentKey && assignment.tournamentKey !== tournamentKey) {
        setTournamentSwitched(true);
        return;
      }
      if (
        scheduledMatchId &&
        assignment.state === 'assigned' &&
        assignment.scheduledMatchId !== undefined &&
        assignment.scheduledMatchId !== scheduledMatchId
      ) {
        setReassigned(true);
      }

      // A successful poll proves the room can reach and authenticate to control again. Re-offer the
      // newest complete state even when nobody has scored since the outage, so reconnecting always
      // converges the server snapshot instead of waiting for the next tossup.
      const latestSnapshot = latestSnapshotRef.current;
      if (latestSnapshot !== null) sender.offer(latestSnapshot);
    };
    void poll();
    const timer = setInterval(() => void poll(), assignmentPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, identity, scheduledMatchId, tournamentKey, enabled, sender]);

  const alerts = useMemo<IScorerAlert[]>(() => {
    const list: IScorerAlert[] = [];
    if (roomCredentialProblem) {
      list.push({
        id: 'credentials',
        tone: 'warning',
        title: 'Tournament connection changed — keep scoring',
        body: 'Tournament control no longer recognizes this room, so results will not be sent automatically until the connection is repaired. The game is saved on this device and can be handed over as a file.',
        actions: onRepairConnection ? [{ label: 'Repair connection…', onSelect: onRepairConnection }] : undefined,
        offerDownload: true,
      });
    }
    if (sessionCredentialProblem) {
      list.push({
        id: 'session-credentials',
        tone: 'warning',
        title: 'This game lost its place with tournament control — keep scoring',
        body: `${repairMessage ?? 'Tournament control did not accept this game’s credentials.'} The room is still paired, so reconnecting reopens the same game rather than starting a new one. Nothing scored is affected.`,
        actions: [{ label: 'Reconnect this game', onSelect: () => void repairSession() }],
        offerDownload: true,
      });
    }
    if (writerConflict) {
      list.push({
        id: 'writer-conflict',
        tone: 'warning',
        title: 'Another device is scoring this game',
        body: `${repairMessage ?? 'Tournament control is accepting writes from a different device, so nothing from here is being sent.'} Keep scoring — this scoresheet is complete and can be handed over as a file. Take over only if the other device has stopped.`,
        actions: writerConflict.canTakeOver
          ? [{ label: 'Take over scoring', onSelect: () => void takeOverWriter() }]
          : undefined,
        offerDownload: true,
      });
    }
    if (tournamentSwitched) {
      list.push({
        id: 'tournament-switched',
        tone: 'warning',
        title: 'Tournament control is running a different tournament',
        body: 'Nothing more will be sent, so this game cannot be filed against the wrong event. Finish the game normally and hand the QBJ over.',
        offerDownload: true,
      });
    }
    if (reassigned) {
      list.push({
        id: 'reassigned',
        tone: 'info',
        title: 'Tournament control has moved this room on to another game',
        body: 'The game on screen is kept. Finish it, submit it, and check with tournament control about the change.',
        offerDownload: true,
      });
    }
    return list;
  }, [
    roomCredentialProblem,
    sessionCredentialProblem,
    writerConflict,
    repairMessage,
    tournamentSwitched,
    reassigned,
    onRepairConnection,
    repairSession,
    takeOverWriter,
  ]);

  const reportProgress = useCallback(
    (qbj: object) => {
      latestSnapshotRef.current = qbj;
      sender.offer(qbj);
    },
    [sender],
  );

  const submitFinal = useCallback(
    async (qbj: object) => {
      if (!writesAllowedRef.current) {
        return { ok: false as const, error: 'This room is not currently authorized to send results.' };
      }
      const result = await client.postFinal(credentials, qbj);
      if (!result.ok) noteWrite(result);
      return result;
    },
    [client, credentials, noteWrite],
  );

  const recoverFromServer = useCallback(async () => {
    const result = await client.recover(credentials);
    if (!result.ok) return null;
    return result.value.latestQbj;
  }, [client, credentials]);

  const syncRosterPlayer = useCallback(
    async (teamName: string, playerName: string) => {
      const result = await client.addRosterPlayer(identity, credentials, teamName, playerName);
      if (result.ok) return { ok: true };
      // A refusal that reached control is a decision about the roster; a failure that did not is a
      // network problem the room can try again. The scorer says different things about each.
      return { ok: false, error: result.error, rejected: result.status !== undefined };
    },
    [client, identity, credentials],
  );

  const requestControl = useCallback(
    async (category: HelpRequestCategory, message: string) => {
      const result = await client.requestHelp(identity, category, message);
      if (result.ok) setControlRequestPending(true);
    },
    [client, identity],
  );

  return {
    connection,
    degradedMessage,
    alerts,
    serverSnapshotAt,
    snapshotError,
    automaticDelivery: writesAllowed,
    reportProgress,
    submitFinal,
    recoverFromServer,
    syncRosterPlayer,
    requestControl,
    controlRequestPending,
  };
}
