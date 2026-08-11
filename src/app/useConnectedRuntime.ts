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
 * QBTCP distinguishes four failures that look identical from a distance and need opposite
 * responses, so this file keeps them apart:
 *
 *   - The **room token** was refused — `401`. The pairing is gone; a person types a new code. Only
 *     this one needs a code, and offering one for any of the others is how a scorekeeper ends up
 *     hunting for a slip of paper to fix something that was not broken.
 *   - The credential was accepted and the operation **forbidden** — `403`, most often this page's
 *     origin missing from the server's allowlist. The pairing is good and must be kept; the server's
 *     own explanation is shown, and the room stops asking rather than repeating the question.
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
  IRoomIdentity,
  ISessionCredentials,
  IWriterConflict,
  readWriterConflict,
} from '../integrations/fruity/FruityServerClient';
import { ServerDeliveryState } from '../game/GameStore';
import { ProgressSender } from '../integrations/fruity/FruityResultDestination';
import { HelpRequestCategory } from './HelpRequests';

/** How often a room asks control what it should be playing. */
export const assignmentPollIntervalMs = 10_000;

/**
 * What became of a final.
 *
 * Classified here rather than by the caller, because the facts it depends on are here. The
 * difference between `pending` and `rejected` is the difference between "wait, something is
 * retrying" and "a person has to act", and the caller would have to reconstruct it from a rendered
 * copy of state this hook holds live — which is wrong in the one case that matters, a snapshot
 * refused in the instant somebody was pressing Submit.
 */
export interface IFinalDelivery {
  /** Never `none`: this path only runs for a game that has tournament control behind it. */
  delivery: Exclude<ServerDeliveryState, 'none'>;
  /** Whatever control said, when it said anything. Safe to show. */
  detail?: string;
  /** Control already had this exact statistical result. The right answer to a retry, not a problem. */
  duplicate?: boolean;
}

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
  /** The highest progress sequence this room has already used, as it was last persisted. */
  progressSequence?: number;
  /** A sequence has been used. Persist it before it can matter; nothing else changed. */
  onProgressSequence?: (sequence: number) => void;
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
  submitFinal: (qbj: object) => Promise<IFinalDelivery>;
  recoverFromServer: () => Promise<object | null>;
  syncRosterPlayer: (teamName: string, playerName: string) => Promise<{ ok: boolean; error?: string; rejected?: boolean }>;
  requestControl: (category: HelpRequestCategory, message: string) => Promise<void>;
  controlRequestPending: boolean;
}

/**
 * Decide the connection state from one poll, without reading any message text.
 *
 * `401` and `403` are deliberately not the same answer, because the two repairs are opposite. `401`
 * is a credential control does not accept, which a new pairing code fixes. `403` is a credential it
 * accepts and will not act on — most often this browser's origin is not on the server's allowlist —
 * and a pairing code cannot fix that at all. Treating the second as the first throws away a room
 * capability that was working, and hands the scorekeeper a task that cannot succeed.
 */
export function classifyPoll(result: ApiResult<unknown>): {
  connection: RoomConnectionState;
  credentialProblem: boolean;
  forbidden: boolean;
} {
  const settled = { credentialProblem: false, forbidden: false };
  if (result.ok) return { connection: RoomConnectionState.Connected, ...settled };
  // No status means nothing answered: DNS, a refused connection, dropped Wi-Fi, or our own timeout
  // abort. That, and only that, is what "offline" means to a scorekeeper.
  if (result.status === undefined) return { connection: RoomConnectionState.Offline, ...settled };
  if (result.status === 401) {
    return { connection: RoomConnectionState.Connected, credentialProblem: true, forbidden: false };
  }
  if (result.status === 403) {
    return { connection: RoomConnectionState.Connected, credentialProblem: false, forbidden: true };
  }
  return { connection: RoomConnectionState.Degraded, ...settled };
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
    progressSequence,
    onProgressSequence,
  } = input;

  const [connection, setConnection] = useState(RoomConnectionState.Connected);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>(undefined);
  const [roomCredentialProblem, setRoomCredentialProblem] = useState(false);
  /** Control accepted the credential and refused the operation. A person, not a code, resolves it. */
  const [forbidden, setForbidden] = useState<string | null>(null);
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
    enabled &&
    !roomCredentialProblem &&
    !sessionCredentialProblem &&
    !tournamentSwitched &&
    forbidden === null &&
    writerConflict === null;
  const writesAllowedRef = useRef(writesAllowed);
  writesAllowedRef.current = writesAllowed;

  /** The newest complete game state, retained so a later successful poll can re-offer it. */
  const latestSnapshotRef = useRef<object | null>(null);

  /**
   * The next sequence for this session, and the reason it is not just the clock.
   *
   * QBTCP requires the number to increase within a session and has servers discard a lower one
   * silently with a `200`, so every way it can go backwards is a way for a room to keep scoring
   * into a snapshot nobody keeps, with no error to notice. The clock alone goes backwards whenever
   * the device corrects it. So the floor is the highest number this room is known to have used —
   * carried across reloads by the stored connection — and the clock only ever raises it, which is
   * what keeps two devices in one room from colliding on a small counter.
   */
  const usedSequence = useRef(0);
  const nextSequence = useCallback(() => {
    const floor = Math.max(usedSequence.current, progressSequence ?? 0);
    const next = Math.max(floor + 1, Date.now());
    usedSequence.current = next;
    onProgressSequence?.(next);
    return next;
  }, [progressSequence, onProgressSequence]);

  /** Read by the poll, which must be able to see the current answer without restarting itself. */
  const forbiddenRef = useRef(forbidden);
  forbiddenRef.current = forbidden;

  /**
   * Whether the one unattended reopen has already been spent on the current problem.
   *
   * Declared here rather than beside the effect that reads it, because the repair itself re-arms it.
   */
  const autoRepairAttempted = useRef(false);

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
    // Reopening said another device is writing, which is worth telling the room. It did not say
    // this room may take that away, and inventing the offer here would put a takeover button in
    // front of somebody on this client's own authority — the one decision the protocol reserves for
    // a server to grant and a person to make. The offer arrives with a `409`, or not at all.
    setWriterConflict(opened.value.writer ? null : { canTakeOver: false });
    // Re-armed here rather than left to the credentials effect, because reopening usually returns
    // the same token — the session did not change, only the server's memory of it — and a token
    // that did not change means that effect never runs. Without this, a session refused twice in
    // one game would silently stop repairing itself after the first.
    autoRepairAttempted.current = false;
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
        const result = await client.putSnapshot(credentials, qbj, nextSequence());
        if (result.ok) {
          setServerSnapshotAt(Date.now());
          setSnapshotError(undefined);
        } else {
          setSnapshotError(result.detail);
          noteWrite(result);
        }
      }),
    [client, credentials, noteWrite, nextSequence],
  );
  useEffect(() => () => sender.stop(), [sender]);

  // The assignment poll. Its only outputs are state; it can neither start nor stop a game.
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const poll = async () => {
      // "Surface it. Do not retry in a loop." A refusal of this kind does not change because it was
      // asked again ten seconds later, so the room asks once and then waits for somebody to press
      // the action on the alert.
      if (forbiddenRef.current !== null) return;
      const result = await client.assignment(identity);
      if (cancelled) return;
      const classified = classifyPoll(result);
      setConnection(classified.connection);
      if (classified.credentialProblem) setRoomCredentialProblem(true);
      if (classified.forbidden) {
        // The server's own words. It is the only thing that can explain a refusal this client has
        // no way to interpret, and the protocol says that string is safe to show unchanged.
        setForbidden(result.ok ? null : result.detail ?? 'Tournament control will not accept requests from this page.');
      }
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
      setForbidden(null);
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
    if (forbidden) {
      list.push({
        id: 'forbidden',
        tone: 'warning',
        title: 'Tournament control will not accept this room’s requests — keep scoring',
        body: `${forbidden} This room is still paired, so this is not something a new pairing code fixes. The game is saved on this device and can be handed over as a file.`,
        actions: [{ label: 'Try tournament control again', onSelect: () => setForbidden(null) }],
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
    forbidden,
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
    async (qbj: object): Promise<IFinalDelivery> => {
      // Read at the moment the write would happen. A room already barred from writing has nothing
      // retrying on its behalf, so calling that pending would be telling a scorekeeper to wait for
      // something that is never coming.
      if (!writesAllowedRef.current) {
        return { delivery: 'rejected', detail: 'This room is not currently authorized to send results.' };
      }
      const result = await client.postFinal(credentials, qbj);
      if (result.ok) return { delivery: 'sent', duplicate: result.value.duplicate };
      noteWrite(result);
      // Nothing answered, so nothing refused it: worth retrying, and the room can be told to wait.
      // A capability this server never advertised is not that — no request went out, and none will.
      if (result.status === undefined && !result.unsupported) {
        return { delivery: 'pending', detail: result.error };
      }
      return { delivery: 'rejected', detail: result.detail ?? result.error };
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
