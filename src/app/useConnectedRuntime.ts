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
  HelpClearResult,
  HelpReadResult,
  HelpRequestResult,
  IRoomIdentity,
  IRosterAddResult,
  ISessionRecovery,
  ISessionCredentials,
  IWriterConflict,
  readWriterConflict,
} from '../integrations/fruity/FruityServerClient';
import { deliverFinalResult, ProgressSender } from '../integrations/fruity/FruityResultDestination';
import type { IFinalDelivery } from '../integrations/fruity/FruityResultDestination';
import {
  ControlRequestState,
  HelpRequestCategory,
  IHelpRequestSummary,
  helpRequestCategoryLabels,
} from './HelpRequests';
import { ConnectionTimeline, connectionTimeline } from './ConnectionTimeline';
import { buildVersion } from '../pwa/BuildVersion';
import { qbjSerializationVersion } from '../qbj/QbjSerialization';

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
  /** The highest progress sequence this room has already used, as it was last persisted. */
  progressSequence?: number;
  /** A sequence has been used. Persist it before it can matter; nothing else changed. */
  onProgressSequence?: (sequence: number) => void;
  /**
   * Where this room's connection history is written.
   *
   * Injectable because the history is the only externally visible evidence that the repairs below
   * happened at all, which makes it the only thing a test can assert about them. Defaults to the
   * device-wide buffer; see `ConnectionTimeline`.
   */
  timeline?: ConnectionTimeline;
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
  recoverFromServer: () => Promise<ISessionRecovery | null>;
  syncRosterPlayer: (
    teamName: string,
    playerName: string,
    teamId?: string,
    questionNumber?: number,
  ) => Promise<{ ok: boolean; error?: string; rejected?: boolean; canonical?: IRosterAddResult }>;
  requestControl: (category: HelpRequestCategory, message: string) => Promise<HelpRequestResult>;
  retryControlRequest: () => Promise<HelpRequestResult | null>;
  cancelControlRequest: () => Promise<HelpClearResult | null>;
  controlRequest: ControlRequestState;
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
 *
 * `403` is deliberately not here. It is not a repair at all — nothing about this session or this
 * room can be changed to satisfy it — so it is handled by `forbiddenIn`, which every path that can
 * receive one consults. See `classifyPoll`.
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

/** The server's own words about a refusal, or a plain fallback when it offered none. */
export function forbiddenIn(result: ApiResult<unknown>): string | null {
  if (result.ok || result.status !== 403) return null;
  return result.detail ?? 'Tournament control will not accept requests from this page.';
}

const helpMessageLimit = 500;

type HelpDraftOutcome =
  { kind: 'failed'; status?: number } | { kind: 'refused'; status: number; retryable: boolean };

interface IHelpDraft {
  category: HelpRequestCategory;
  message: string;
  outcome?: HelpDraftOutcome;
}

function isHelpCategory(value: unknown): value is HelpRequestCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(helpRequestCategoryLabels, value);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHelpDraft(key: string): IHelpDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecordLike(parsed) || !isHelpCategory(parsed.category) || typeof parsed.message !== 'string')
      return null;
    if (parsed.message.trim() === '' || parsed.message.length > helpMessageLimit) return null;
    const rawOutcome = isRecordLike(parsed.outcome) ? parsed.outcome : undefined;
    const outcome: HelpDraftOutcome | undefined =
      rawOutcome?.kind === 'refused' &&
      typeof rawOutcome.status === 'number' &&
      typeof rawOutcome.retryable === 'boolean'
        ? { kind: 'refused', status: rawOutcome.status, retryable: rawOutcome.retryable }
        : rawOutcome?.kind === 'failed'
          ? {
              kind: 'failed',
              ...(typeof rawOutcome.status === 'number' ? { status: rawOutcome.status } : {}),
            }
          : undefined;
    return { category: parsed.category, message: parsed.message, ...(outcome ? { outcome } : {}) };
  } catch {
    return null;
  }
}

function writeHelpDraft(key: string, draft: IHelpDraft): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // A full or unavailable session store must not make a local issue fail.
  }
}

function clearHelpDraft(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // In-memory state remains authoritative for this mount.
  }
}

function requestTime(
  request: IHelpRequestSummary,
  existing?: ControlRequestState,
): { value: string; source: 'server' | 'device' } {
  if (request.createdAt && !Number.isNaN(Date.parse(request.createdAt))) {
    return { value: request.createdAt, source: 'server' };
  }
  if (
    existing?.kind === 'outstanding' &&
    existing.requestedAtSource === 'device' &&
    existing.request.id === request.id &&
    existing.request.category === request.category &&
    existing.request.message === request.message
  ) {
    return { value: existing.requestedAt, source: 'device' };
  }
  return { value: new Date().toISOString(), source: 'device' };
}

function controlFailureState(
  category: HelpRequestCategory,
  message: string,
  result: Exclude<HelpRequestResult, { kind: 'accepted' | 'already-outstanding' }>,
): ControlRequestState {
  if (result.kind === 'unsupported') return result;
  if (result.kind === 'refused') {
    return {
      kind: 'refused',
      category,
      message,
      error: result.error,
      status: result.status,
      retryable: result.retryable,
    };
  }
  return {
    kind: 'failed',
    category,
    message,
    error: result.error,
    retryable: result.kind === 'unreachable' || result.kind === 'server-error',
  };
}

function draftFailureState(draft: IHelpDraft): ControlRequestState {
  if (draft.outcome?.kind === 'refused') {
    return {
      kind: 'refused',
      category: draft.category,
      message: draft.message,
      error: 'Tournament control refused this request.',
      status: draft.outcome.status,
      retryable: draft.outcome.retryable,
    };
  }
  return {
    kind: 'failed',
    category: draft.category,
    message: draft.message,
    error: 'A previous request was not confirmed by tournament control.',
    retryable: true,
  };
}

function readFailureState(
  draft: IHelpDraft | null,
  result: Exclude<HelpReadResult, { kind: 'idle' | 'outstanding' }>,
): ControlRequestState {
  if (result.kind === 'unsupported') return result;
  // A legacy POST-only server cannot reconcile after a reload, but the draft still gives the room
  // a truthful retry action. Do not replace that useful state with a generic "unavailable" line.
  if (result.kind === 'unavailable') return draft ? draftFailureState(draft) : result;
  if (!draft) return { kind: 'unavailable', error: result.error };
  return controlFailureState(draft.category, draft.message, result);
}

function sameControlRequestState(first: ControlRequestState, second: ControlRequestState): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'idle' && second.kind === 'idle') return true;
  if (first.kind === 'unavailable' && second.kind === 'unavailable') return first.error === second.error;
  if (first.kind === 'unsupported' && second.kind === 'unsupported') return first.error === second.error;
  if (first.kind === 'sending' && second.kind === 'sending') {
    return first.category === second.category && first.message === second.message;
  }
  if (first.kind === 'failed' && second.kind === 'failed') {
    return (
      first.category === second.category &&
      first.message === second.message &&
      first.error === second.error &&
      first.retryable === second.retryable
    );
  }
  if (first.kind === 'refused' && second.kind === 'refused') {
    return (
      first.category === second.category &&
      first.message === second.message &&
      first.error === second.error &&
      first.status === second.status &&
      first.retryable === second.retryable
    );
  }
  if (first.kind === 'outstanding' && second.kind === 'outstanding') {
    return (
      first.request.id === second.request.id &&
      first.request.category === second.request.category &&
      first.request.message === second.request.message &&
      first.request.createdAt === second.request.createdAt &&
      first.request.updatedAt === second.request.updatedAt &&
      first.requestedAt === second.requestedAt &&
      first.requestedAtSource === second.requestedAtSource &&
      first.canCancel === second.canCancel
    );
  }
  return false;
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
    timeline = connectionTimeline,
  } = input;

  /**
   * Presence is deliberately advisory. It carries only bounded build/procedure information and
   * uses the already-paired room endpoint; a failed heartbeat must never affect scoring or result
   * delivery. The interval is long enough not to become a second progress channel, while still
   * letting control distinguish an old browser from a live one during a room check.
   */
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const publish = () => {
      if (cancelled) return;
      if (typeof client.updatePresence !== 'function') return;
      void client.updatePresence(identity, {
        ready: true,
        client: {
          name: 'QBSheet',
          version: buildVersion.version,
          build: buildVersion.commit,
          commit: buildVersion.commit,
        },
        procedureVersions: [3],
        qbjVersion: qbjSerializationVersion,
      });
    };
    publish();
    const timer = setInterval(publish, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, enabled, identity]);

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
  const helpStorageKey = useMemo(
    () => `qbsheet-help-draft:${client.baseUrl}:${identity.roomId}:${scheduledMatchId ?? 'room'}`,
    [client.baseUrl, identity.roomId, scheduledMatchId],
  );
  const initialHelpDraft = useMemo(() => readHelpDraft(helpStorageKey), [helpStorageKey]);
  const [controlRequest, setControlRequest] = useState<ControlRequestState>(() =>
    initialHelpDraft ? draftFailureState(initialHelpDraft) : { kind: 'unavailable' },
  );
  const controlRequestRef = useRef(controlRequest);
  const helpDraftRef = useRef<IHelpDraft | null>(initialHelpDraft);
  const helpReadInFlight = useRef<Promise<HelpReadResult> | null>(null);
  const helpSendInFlight = useRef<Promise<HelpRequestResult> | null>(null);
  const helpClearInFlight = useRef<Promise<HelpClearResult> | null>(null);
  const helpMutationVersion = useRef(0);
  const helpRoomCredentialProblem = useRef(false);
  const {
    deviceId: helpDeviceId,
    operatorName: helpOperatorName,
    roomId: helpRoomId,
    roomName: helpRoomName,
    token: helpToken,
  } = identity;
  const helpIdentity = useMemo(
    () => ({
      roomId: helpRoomId,
      token: helpToken,
      ...(helpDeviceId !== undefined ? { deviceId: helpDeviceId } : {}),
      ...(helpOperatorName !== undefined ? { operatorName: helpOperatorName } : {}),
      ...(helpRoomName !== undefined ? { roomName: helpRoomName } : {}),
    }),
    [helpDeviceId, helpOperatorName, helpRoomId, helpRoomName, helpToken],
  );

  useEffect(() => {
    // A repaired room token is the only event that can make a help-specific 401 stale.
    helpRoomCredentialProblem.current = false;
  }, [helpIdentity.token]);

  const noteHelpCredentialProblem = useCallback(() => {
    helpRoomCredentialProblem.current = true;
    setRoomCredentialProblem(true);
    setForbidden(null);
  }, []);

  const setControlRequestValue = useCallback((next: ControlRequestState) => {
    if (sameControlRequestState(controlRequestRef.current, next)) return;
    controlRequestRef.current = next;
    setControlRequest(next);
  }, []);

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
  /*
   * Assigned from a committed effect rather than during render. A render can be thrown away and
   * replayed, and a ref written during one holds a value from a pass that never happened; the
   * readers here are all timers and event handlers, which run as their own tasks after the effects
   * of any commit before them, so an effect is never the staler of the two options and is the only
   * one that stays correct if this tree ever renders concurrently.
   */
  useEffect(() => {
    writesAllowedRef.current = writesAllowed;
  }, [writesAllowed]);

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
  useEffect(() => {
    forbiddenRef.current = forbidden;
  }, [forbidden]);

  /**
   * Whether the one unattended reopen has already been spent on the current problem.
   *
   * Declared here rather than beside the effect that reads it, because the repair itself re-arms it.
   */
  const autoRepairAttempted = useRef(false);

  /**
   * Everything a refusal changes, wherever it came from.
   *
   * A snapshot, a reopen, a takeover and the final all reach the same server with the same
   * credentials, so a `403` means the same thing to all four and the room stops trying on all four.
   * Handling it only on the poll left the trailing snapshot sender repeating a refused request
   * every few seconds for the rest of the game — the one thing the protocol names about this
   * status, and the reason it names it.
   */
  const noteWrite = useCallback(
    (result: ApiResult<unknown>) => {
      const refusal = forbiddenIn(result);
      if (refusal !== null) setForbidden(refusal);
      const classified = classifyWrite(result);
      if (classified.sessionProblem) setSessionCredentialProblem(true);
      if (classified.conflict) {
        setWriterConflict(classified.conflict);
        timeline.record('writer-conflict');
      }
    },
    [timeline],
  );

  /** Reconcile help through the existing low-volume assignment poll. */
  const reconcileHelp = useCallback(async (): Promise<HelpReadResult> => {
    if (!enabled) {
      const result: HelpReadResult = {
        kind: 'unsupported',
        error: 'This tournament connection does not support remote control requests.',
      };
      setControlRequestValue(result);
      return result;
    }
    if (helpReadInFlight.current) return helpReadInFlight.current;

    const readVersion = helpMutationVersion.current;
    const mutationInFlightAtRead = helpSendInFlight.current !== null || helpClearInFlight.current !== null;
    const read = Promise.resolve()
      .then(() => client.readHelp(helpIdentity))
      .catch((): HelpReadResult => ({ kind: 'unreachable', error: 'Could not reach tournament control.' }));
    helpReadInFlight.current = read;
    try {
      const result = await read;
      // A POST made after this GET began is the fresher local fact.
      // A GET begun during a POST/DELETE may have read the old server state. Let the next poll
      // reconcile after the mutation instead of allowing that response to undo the local result.
      if (
        mutationInFlightAtRead ||
        helpSendInFlight.current !== null ||
        helpClearInFlight.current !== null ||
        helpMutationVersion.current !== readVersion
      )
        return result;
      const current = controlRequestRef.current;
      if (result.kind === 'outstanding') {
        const at = requestTime(result.request, current);
        helpDraftRef.current = null;
        clearHelpDraft(helpStorageKey);
        setControlRequestValue({
          kind: 'outstanding',
          request: result.request,
          requestedAt: at.value,
          requestedAtSource: at.source,
          ...(current.kind === 'outstanding' &&
          current.request.id === result.request.id &&
          current.canCancel === false
            ? { canCancel: false }
            : {}),
        });
        return result;
      }
      if (result.kind === 'idle') {
        if (current.kind === 'outstanding') {
          timeline.record('control-request-cleared', current.request.category);
          helpDraftRef.current = null;
          clearHelpDraft(helpStorageKey);
          setControlRequestValue({ kind: 'idle' });
        } else if (helpDraftRef.current === null) {
          setControlRequestValue({ kind: 'idle' });
        }
        // A failed POST remains visible until a person retries it.
        return result;
      }
      if (result.kind === 'unsupported') {
        if (current.kind === 'outstanding') setControlRequestValue({ ...current, canCancel: false });
        else setControlRequestValue(result);
        helpDraftRef.current = null;
        clearHelpDraft(helpStorageKey);
        return result;
      }
      if (result.kind === 'unavailable') {
        if (current.kind === 'outstanding') setControlRequestValue({ ...current, canCancel: false });
        else setControlRequestValue(readFailureState(helpDraftRef.current, result));
        return result;
      }
      if (result.kind === 'refused' && result.status === 401) {
        noteHelpCredentialProblem();
        timeline.record('room-refused');
      }
      if (current.kind !== 'outstanding')
        setControlRequestValue(readFailureState(helpDraftRef.current, result));
      return result;
    } finally {
      if (helpReadInFlight.current === read) helpReadInFlight.current = null;
    }
  }, [
    client,
    enabled,
    helpIdentity,
    helpStorageKey,
    noteHelpCredentialProblem,
    setControlRequestValue,
    timeline,
  ]);

  /** Ask control to come, or return the one already outstanding without a duplicate POST. */
  const requestControl = useCallback(
    async (category: HelpRequestCategory, message: string): Promise<HelpRequestResult> => {
      const current = controlRequestRef.current;
      if (current.kind === 'outstanding') return { kind: 'already-outstanding', request: current.request };
      if (current.kind === 'unsupported') return current;
      if (current.kind === 'sending' && helpSendInFlight.current) return helpSendInFlight.current;

      const draft = { category, message: message.slice(0, helpMessageLimit) };
      helpMutationVersion.current += 1;
      helpDraftRef.current = draft;
      writeHelpDraft(helpStorageKey, draft);
      setControlRequestValue({ kind: 'sending', ...draft });

      const send = Promise.resolve()
        .then(() => client.requestHelp(helpIdentity, draft.category, draft.message))
        .catch((): HelpRequestResult => ({
          kind: 'unreachable',
          error: 'Could not reach tournament control.',
        }));
      helpSendInFlight.current = send;
      try {
        const result = await send;
        if (result.kind === 'accepted' || result.kind === 'already-outstanding') {
          const at = requestTime(result.request);
          helpDraftRef.current = null;
          clearHelpDraft(helpStorageKey);
          setControlRequestValue({
            kind: 'outstanding',
            request: result.request,
            requestedAt: at.value,
            requestedAtSource: at.source,
          });
          if (result.kind === 'accepted') timeline.record('control-requested', category);
          return result;
        }
        if (result.kind === 'unsupported') {
          helpDraftRef.current = null;
          clearHelpDraft(helpStorageKey);
        }
        if (result.kind === 'refused' && result.status === 401) {
          noteHelpCredentialProblem();
          timeline.record('room-refused');
        }
        setControlRequestValue(controlFailureState(draft.category, draft.message, result));
        if (result.kind === 'unreachable' || result.kind === 'server-error') {
          const status = result.kind === 'server-error' ? result.status : undefined;
          helpDraftRef.current = {
            ...draft,
            outcome: { kind: 'failed', ...(status !== undefined ? { status } : {}) },
          };
          writeHelpDraft(helpStorageKey, helpDraftRef.current);
        } else if (result.kind === 'refused') {
          helpDraftRef.current = {
            ...draft,
            outcome: { kind: 'refused', status: result.status, retryable: result.retryable },
          };
          writeHelpDraft(helpStorageKey, helpDraftRef.current);
        }
        timeline.record(
          result.kind === 'refused' ? 'control-request-refused' : 'control-request-failed',
          category,
        );
        return result;
      } finally {
        if (helpSendInFlight.current === send) helpSendInFlight.current = null;
      }
    },
    [client, helpIdentity, helpStorageKey, noteHelpCredentialProblem, setControlRequestValue, timeline],
  );

  const retryControlRequest = useCallback(async (): Promise<HelpRequestResult | null> => {
    const current = controlRequestRef.current;
    const draft =
      helpDraftRef.current ??
      (current.kind === 'failed' || current.kind === 'refused'
        ? { category: current.category, message: current.message }
        : null);
    if (!draft) return null;
    return requestControl(draft.category, draft.message);
  }, [requestControl]);

  const cancelControlRequest = useCallback(async (): Promise<HelpClearResult | null> => {
    const current = controlRequestRef.current;
    if (current.kind !== 'outstanding' || !current.request.id) return null;
    if (helpClearInFlight.current) return helpClearInFlight.current;
    helpMutationVersion.current += 1;
    const clear = Promise.resolve()
      .then(() => client.cancelHelp(helpIdentity, current.request.id as string))
      .catch((): HelpClearResult => ({ kind: 'unreachable', error: 'Could not reach tournament control.' }));
    helpClearInFlight.current = clear;
    try {
      const result = await clear;
      if (result.kind === 'cleared' || result.kind === 'idle') {
        helpDraftRef.current = null;
        clearHelpDraft(helpStorageKey);
        setControlRequestValue({ kind: 'idle' });
        timeline.record('control-request-cleared', current.request.category);
      } else if (result.kind === 'unsupported') {
        setControlRequestValue({ ...current, canCancel: false });
      } else if (result.kind === 'refused' && result.status === 401) {
        noteHelpCredentialProblem();
        timeline.record('room-refused');
      }
      return result;
    } finally {
      if (helpClearInFlight.current === clear) helpClearInFlight.current = null;
    }
  }, [client, helpIdentity, helpStorageKey, noteHelpCredentialProblem, setControlRequestValue, timeline]);

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
      noteWrite(opened);
      setRepairMessage(opened.error);
      timeline.record('session-reopen-failed', opened.error);
      return false;
    }
    setRepairMessage(undefined);
    // The line that makes the repair visible afterwards. Nothing on screen changes when this works,
    // which is the point of it and also why it has to be written down somewhere.
    timeline.record('session-reopened');
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
  }, [client, identity, scheduledMatchId, onCredentialsRepaired, noteWrite, timeline]);

  const takeOverWriter = useCallback(async () => {
    const result = await client.takeWriter(identity, credentials);
    if (!result.ok) {
      noteWrite(result);
      setRepairMessage(result.error);
      return;
    }
    setRepairMessage(undefined);
    setWriterConflict(null);
    timeline.record('writer-taken');
    onCredentialsRepaired?.({ sessionId: result.value.sessionId, sessionToken: result.value.token });
  }, [client, identity, credentials, onCredentialsRepaired, noteWrite, timeline]);

  /**
   * One unattended reopen per session problem, and no more.
   *
   * A session token that stopped working is almost always a restarted server rather than a decision
   * about this room, and making a scorekeeper press a button for that is noise. Repeating it is
   * not: a server that refuses the reopen is saying something, and a loop would keep asking.
   */
  useEffect(() => {
    if (!sessionCredentialProblem || autoRepairAttempted.current) return;
    autoRepairAttempted.current = true;
    void repairSession();
  }, [sessionCredentialProblem, repairSession]);

  // New credentials arrived, so whatever was wrong with the old ones is not a live problem. The
  // problem is dropped as the new token renders; the ref that spends the one unattended reopen is
  // re-armed from a committed effect, because that is the only place a ref may be written.
  const [tokenSeen, setTokenSeen] = useState(credentials.token);
  if (tokenSeen !== credentials.token) {
    setTokenSeen(credentials.token);
    setSessionCredentialProblem(false);
  }
  useEffect(() => {
    autoRepairAttempted.current = false;
  }, [credentials.token]);

  // The send itself is a callback rather than part of the `useMemo` below, because it reads the
  // clock and the writes-allowed ref at the moment the send happens. Both are the right thing to do
  // from a timer and the wrong thing to do while rendering, and only the callback form says so.
  const sendProgress = useCallback(
    async (qbj: object) => {
      if (!writesAllowedRef.current) return;
      const result = await client.putSnapshot(credentials, qbj, nextSequence());
      if (result.ok) {
        setServerSnapshotAt(Date.now());
        setSnapshotError(undefined);
        timeline.record('progress-sent');
      } else {
        setSnapshotError(result.detail);
        timeline.record('progress-refused', result.detail ?? result.error);
        noteWrite(result);
      }
    },
    [client, credentials, noteWrite, nextSequence, timeline],
  );
  /*
   * The sender is built by an effect and held in a ref, not memoized into render.
   *
   * It is a timer that outlives the render that asked for it, and its send reads the clock and the
   * writes-allowed ref when the send happens. Building it during render would hand a render-scoped
   * closure to something that calls it much later. The effect keys on the send, which changes with
   * exactly the dependencies the memo used to list, so a new sender is still built — and the one
   * before it still stopped — at the same moments as before.
   */
  const senderRef = useRef<ProgressSender | null>(null);
  useEffect(() => {
    const built = new ProgressSender(sendProgress);
    senderRef.current = built;
    return () => {
      built.stop();
      if (senderRef.current === built) senderRef.current = null;
    };
  }, [sendProgress]);

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
      // Only transitions are kept; a poll every ten seconds all day would otherwise be the whole
      // history. See `ConnectionTimeline`.
      timeline.record(classified.connection);
      if (classified.credentialProblem) {
        setRoomCredentialProblem(true);
        setForbidden(null);
        timeline.record('room-refused');
      }
      const refusal = forbiddenIn(result);
      if (refusal !== null) setForbidden(refusal);
      if (!result.ok) {
        setDegradedMessage(
          classified.connection === RoomConnectionState.Degraded
            ? (result.detail ?? 'Tournament control answered, but not with anything this room could use.')
            : undefined,
        );
        return;
      }
      setDegradedMessage(undefined);
      if (!helpRoomCredentialProblem.current) setRoomCredentialProblem(false);
      setForbidden(null);
      void reconcileHelp();
      const assignment = result.value;
      if (tournamentKey && assignment.tournamentKey && assignment.tournamentKey !== tournamentKey) {
        setTournamentSwitched(true);
        timeline.record('tournament-switched');
        return;
      }
      if (
        scheduledMatchId &&
        assignment.state === 'assigned' &&
        assignment.scheduledMatchId !== undefined &&
        assignment.scheduledMatchId !== scheduledMatchId
      ) {
        setReassigned(true);
        timeline.record('reassigned');
      }

      // A successful poll proves the room can reach and authenticate to control again. Re-offer the
      // newest complete state even when nobody has scored since the outage, so reconnecting always
      // converges the server snapshot instead of waiting for the next tossup.
      const latestSnapshot = latestSnapshotRef.current;
      if (latestSnapshot !== null) senderRef.current?.offer(latestSnapshot);
    };
    void poll();
    const timer = setInterval(() => void poll(), assignmentPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `sendProgress` rather than the sender itself, so the poll still restarts on the same changes
    // the memoized sender used to signal.
  }, [client, identity, scheduledMatchId, tournamentKey, enabled, reconcileHelp, sendProgress, timeline]);

  /*
   * Built as one literal rather than by pushing onto a list.
   *
   * "Reconnect this game" carries `repairSession`, which re-arms the one-unattended-reopen ref when
   * it succeeds. Handing that to a function during render — even `Array.prototype.push` — is how a
   * ref escapes into somewhere that could read it mid-render, so the alerts are declared in the
   * order they appear instead. The conditions and their order are the ones that were here.
   */
  const alerts = useMemo<IScorerAlert[]>(
    () => [
      ...(roomCredentialProblem
        ? [
            {
              id: 'credentials',
              tone: 'warning' as const,
              title: 'Tournament connection changed — keep scoring',
              body: 'Tournament control no longer recognizes this room, so results will not be sent automatically until the connection is repaired. The game is saved on this device and can be handed over as a file.',
              actions: onRepairConnection
                ? [{ label: 'Repair connection…', onSelect: onRepairConnection }]
                : undefined,
              offerDownload: true,
            },
          ]
        : []),
      ...(forbidden
        ? [
            {
              id: 'forbidden',
              tone: 'warning' as const,
              title: 'Tournament control will not accept this room’s requests — keep scoring',
              body: `${forbidden} This room is still paired, so this is not something a new pairing code fixes. The game is saved on this device and can be handed over as a file.`,
              actions: [{ label: 'Try tournament control again', onSelect: () => setForbidden(null) }],
              offerDownload: true,
            },
          ]
        : []),
      ...(sessionCredentialProblem
        ? [
            {
              id: 'session-credentials',
              tone: 'warning' as const,
              title: 'This game lost its place with tournament control — keep scoring',
              body: `${repairMessage ?? 'Tournament control did not accept this game’s credentials.'} The room is still paired, so reconnecting reopens the same game rather than starting a new one. Nothing scored is affected.`,
              actions: [{ label: 'Reconnect this game', onSelect: () => void repairSession() }],
              offerDownload: true,
            },
          ]
        : []),
      ...(writerConflict
        ? [
            {
              id: 'writer-conflict',
              tone: 'warning' as const,
              title: 'Another device is scoring this game',
              body: `${repairMessage ?? 'Tournament control is accepting writes from a different device, so nothing from here is being sent.'} Keep scoring — this scoresheet is complete and can be handed over as a file. Take over only if the other device has stopped.`,
              actions: writerConflict.canTakeOver
                ? [{ label: 'Take over scoring', onSelect: () => void takeOverWriter() }]
                : undefined,
              offerDownload: true,
            },
          ]
        : []),
      ...(tournamentSwitched
        ? [
            {
              id: 'tournament-switched',
              tone: 'warning' as const,
              title: 'Tournament control is running a different tournament',
              body: 'Nothing more will be sent, so this game cannot be filed against the wrong event. Finish the game normally and hand the QBJ over.',
              offerDownload: true,
            },
          ]
        : []),
      ...(reassigned
        ? [
            {
              id: 'reassigned',
              tone: 'info' as const,
              title: 'Tournament control has moved this room on to another game',
              body: 'The game on screen is kept. Finish it, submit it, and check with tournament control about the change.',
              offerDownload: true,
            },
          ]
        : []),
    ],
    [
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
    ],
  );

  const reportProgress = useCallback((qbj: object) => {
    latestSnapshotRef.current = qbj;
    senderRef.current?.offer(qbj);
  }, []);

  const submitFinal = useCallback(
    async (qbj: object): Promise<IFinalDelivery> => {
      // Read at the moment the write would happen. A room already barred from writing has nothing
      // retrying on its behalf, so calling that pending would be telling a scorekeeper to wait for
      // something that is never coming.
      if (!writesAllowedRef.current) {
        timeline.record('final-refused', 'this room is not authorized to send results');
        return {
          delivery: 'rejected',
          detail: 'This room is not currently authorized to send results.',
          attempted: false,
          // A forbidden response or writer conflict can become valid after a person fixes it; an
          // invalid room/session credential cannot be repaired from Recent Games alone.
          retryable: forbidden !== null || writerConflict !== null,
        };
      }
      const delivered = await deliverFinalResult(client, credentials, qbj, noteWrite);
      if (delivered.delivery === 'sent') {
        timeline.record(delivered.duplicate ? 'final-duplicate' : 'final-sent');
      } else if (delivered.delivery === 'pending') {
        timeline.record('final-pending', delivered.detail);
      } else {
        timeline.record('final-refused', delivered.detail);
      }
      return delivered;
    },
    [client, credentials, forbidden, noteWrite, timeline, writerConflict],
  );

  const recoverFromServer = useCallback(async () => {
    const result = await client.recover(credentials);
    if (!result.ok) {
      throw new Error(result.detail ?? result.error);
    }
    return result.value;
  }, [client, credentials]);

  const syncRosterPlayer = useCallback(
    async (teamName: string, playerName: string, teamId?: string, questionNumber?: number) => {
      const result = await client.addRosterPlayer(
        identity,
        credentials,
        teamName,
        playerName,
        teamId,
        questionNumber,
      );
      if (result.ok) {
        timeline.record('roster-synced');
        return { ok: true, canonical: result.value };
      }
      // A refusal that reached control is a decision about the roster; a failure that did not is a
      // network problem the room can try again. The scorer says different things about each.
      return { ok: false, error: result.error, rejected: result.status !== undefined };
    },
    [client, identity, credentials, timeline],
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
    retryControlRequest,
    cancelControlRequest,
    controlRequest,
  };
}
