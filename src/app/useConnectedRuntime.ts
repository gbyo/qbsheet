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
import FruityServerClient, { ApiResult, IRoomIdentity, ISessionCredentials } from '../integrations/fruity/FruityServerClient';
import { ProgressSender } from '../integrations/fruity/FruityResultDestination';
import { HelpRequestCategory } from './HelpRequests';

/** How often a room asks control what it should be playing. */
export const assignmentPollIntervalMs = 10_000;

export interface IConnectedRuntimeInput {
  client: FruityServerClient;
  identity: IRoomIdentity;
  credentials: ISessionCredentials;
  /** The scheduled game this room is scoring, so a reassignment is detectable. */
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
  /** Offer to repair the room's credentials in place. Never navigates. */
  onRepairConnection?: () => void;
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
  submitFinal: (qbj: object) => Promise<ApiResult<unknown>>;
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

export default function useConnectedRuntime(input: IConnectedRuntimeInput): IConnectedRuntime {
  const { client, identity, credentials, scheduledMatchId, tournamentKey, enabled, onRepairConnection } = input;

  const [connection, setConnection] = useState(RoomConnectionState.Connected);
  const [degradedMessage, setDegradedMessage] = useState<string | undefined>(undefined);
  const [credentialProblem, setCredentialProblem] = useState(false);
  const [reassigned, setReassigned] = useState(false);
  const [tournamentSwitched, setTournamentSwitched] = useState(false);
  const [serverSnapshotAt, setServerSnapshotAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | undefined>(undefined);
  const [controlRequestPending, setControlRequestPending] = useState(false);

  /**
   * Whether it is still safe to write to this session.
   *
   * Turned off by a credential failure or by control having opened a different tournament, and
   * never turned back on by anything except a successful repair. The point is to stop filing
   * snapshots against the wrong event or with credentials control has withdrawn — not to stop the
   * room, which keeps scoring either way.
   */
  const writesAllowed = enabled && !credentialProblem && !tournamentSwitched;
  const writesAllowedRef = useRef(writesAllowed);
  writesAllowedRef.current = writesAllowed;

  /** The newest complete game state, retained so a later successful poll can re-offer it. */
  const latestSnapshotRef = useRef<object | null>(null);

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
        }
      }),
    [client, credentials],
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
      if (classified.credentialProblem) setCredentialProblem(true);
      if (!result.ok) {
        setDegradedMessage(
          classified.connection === RoomConnectionState.Degraded
            ? result.detail ?? 'Tournament control answered, but not with anything this room could use.'
            : undefined,
        );
        return;
      }
      setDegradedMessage(undefined);
      setCredentialProblem(false);
      const assignment = result.value;
      if (tournamentKey && assignment.tournamentKey && assignment.tournamentKey !== tournamentKey) {
        setTournamentSwitched(true);
        return;
      }
      if (
        scheduledMatchId &&
        assignment.current !== null &&
        assignment.current.scheduledMatchId !== scheduledMatchId
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
    if (credentialProblem) {
      list.push({
        id: 'credentials',
        tone: 'warning',
        title: 'Tournament connection changed — keep scoring',
        body: 'Tournament control no longer recognizes this room, so results will not be sent automatically until the connection is repaired. The game is saved on this device and can be handed over as a file.',
        actions: onRepairConnection ? [{ label: 'Repair connection…', onSelect: onRepairConnection }] : undefined,
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
  }, [credentialProblem, tournamentSwitched, reassigned, onRepairConnection]);

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
      return client.postFinal(credentials, qbj);
    },
    [client, credentials],
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
