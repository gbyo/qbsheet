/**
 * The application's state, as one hook.
 *
 * Small on purpose: a `useReducer`-shaped store with a schedule, a lifecycle and a projection
 * layer is the architecture this application is supposed not to have. What is here is the loaded
 * file, the persisted state, one poll timer, and the handful of actions the three views call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chooseResultFolder, isNativeHost, openYellowFruitFile, writeResultFile } from './native';
import { generatePairingCode } from './pairing';
import { planRoomSetup, planRound, publishRound, type PublishOutcome, type PublishPlan } from './publish';
import {
  relayAcknowledgeResults,
  relayClaim,
  relayCheckScorerReadiness,
  relayFetchResults,
  relayUnackedWindow,
  RelayError,
  type RelayConnection,
  type ScorerReadinessResult,
} from './relay';
import { resultFileContents, resultFileName, resultFilePath, resultSummary } from './results';
import { nextRoomId } from './identity';
import {
  newRoom,
  pairingWarnings,
  resetRelayPublication,
  roomTombstone,
  type Room,
  type RoomStatus,
} from './rooms';
import {
  emptyState,
  loadState,
  saveState,
  type BridgeState,
  type PersistResult,
  type ScorerReadinessSnapshot,
  type StoredResult,
} from './persistence';
import { loadYellowFruitTournament, type BridgeTournament } from './tournament';
import { scoresheetOrigin } from '../../../../src/director/relay/relayConfig';

/** How often the results poll runs while the window is open. */
export const resultPollIntervalMs = 5000;

/** Routine confirmations are useful briefly, while problems need to remain available. */
export const noticeAutoDismissMs = 4000;

/**
 * How many unsaved results may pile up before the operator is told.
 *
 * The relay serves the oldest `relayUnackedWindow` unacknowledged results and nothing behind
 * them, and a result leaves that window when it is saved. So the window can only fill if results
 * stop being saved, and this is the point at which that stops being a matter of taste.
 */
export const unsavedResultWarningThreshold = relayUnackedWindow - 28;

export interface BridgeNotice {
  kind: 'good' | 'warn' | 'bad';
  message: string;
}

export type ScorerReadinessStatus = 'checking' | 'ready' | 'blocked' | 'unknown';

export interface ScorerReadinessState {
  status: ScorerReadinessStatus;
  origin: typeof scoresheetOrigin;
  message: string;
  checkedAt?: string;
}

export interface BridgeApi {
  state: BridgeState;
  tournament: BridgeTournament | null;
  /** What the last `.yft` read reported that QBSheet could not carry over. */
  loadWarnings: string[];
  notice: BridgeNotice | null;
  dismissNotice(): void;
  relayReachable: boolean | null;
  /** Whether the ordinary browser Scorer origin can use the connected relay. */
  scorerReadiness: ScorerReadinessState | null;
  busy: boolean;
  native: boolean;

  loadFile(): Promise<void>;
  loadFileContents(path: string | null, contents: string): void;
  pendingFileSwitch: { tournamentName: string; path: string | null } | null;
  confirmFileSwitch(): void;
  cancelFileSwitch(): void;
  connectRelay(input: { baseUrl: string; tournamentId: string; setupToken: string }): Promise<boolean>;
  /** True when a claimed credential is held in memory until local persistence succeeds. */
  relayCredentialSavePending: boolean;
  retryRelayCredentialSave(): Promise<boolean>;
  /** True when a relay-accepted state transition still needs a durable local retry. */
  persistenceSavePending: boolean;
  retryStatePersistence(): boolean;
  /** Re-run the management-authenticated check for the fixed qbsheet.com Scorer origin. */
  checkScorerReadiness(): Promise<void>;
  /** Show the relay setup form without touching the stored relay. */
  beginRelayChange(): void;
  /** Close the setup form and keep whatever relay was already stored. */
  cancelRelayChange(): void;
  changingRelay: boolean;
  /** Delete the stored management credential. Deliberate, confirmed, and not undoable. */
  forgetRelayCredential(): void;

  addRoom(): void;
  renameRoom(roomId: string, name: string): void;
  removeRoom(roomId: string): void;
  setRoomTeams(roomId: string, side: 'left' | 'right', teamId: string | null): void;
  regeneratePairingCode(roomId: string): void;
  selectRound(roundId: string): void;
  /** True when changing rounds would discard team selections the operator has entered. */
  roundChangeDiscardsSelections: boolean;
  publish(): Promise<void>;
  /** Publish room identities and pairing hashes without sending any match assignments. */
  publishRoomSetup(): Promise<void>;
  roomStatus(room: Room): RoomStatus;
  warnings: ReturnType<typeof pairingWarnings>;

  chooseFolder(): Promise<void>;
  saveNewResults(): Promise<void>;
  saveResult(resultId: string): Promise<void>;
  /** True when this row cannot start a save because a save or another bridge action is active. */
  resultBusy(resultId: string): boolean;
  /** True while an individual or batch result save is in progress. */
  savingResults: boolean;
  pollResults(): Promise<void>;
  /** Set when unsaved results are approaching the relay's unacknowledged window. */
  unsavedResultWarning: string | null;
}

function connectionOf(state: BridgeState): RelayConnection | null {
  if (!state.relay) return null;
  return {
    baseUrl: state.relay.baseUrl,
    tournamentId: state.relay.tournamentId,
    managementToken: state.relay.managementToken,
  };
}

/** Compare the relay identity a request was made against with the relay currently in state. */
function sameRelayConnection(left: RelayConnection | null, right: RelayConnection | null): boolean {
  return (
    left?.baseUrl === right?.baseUrl &&
    left?.tournamentId === right?.tournamentId &&
    left?.managementToken === right?.managementToken
  );
}

function connectionKey(connection: RelayConnection): string {
  return [connection.baseUrl, connection.tournamentId, connection.managementToken].join('\u001f');
}

function readinessState(result: ScorerReadinessResult): ScorerReadinessState {
  return {
    status: result.canPair ? 'ready' : 'blocked',
    origin: result.origin,
    message: result.message,
  };
}

function persistedReadiness(readiness: ScorerReadinessState): ScorerReadinessSnapshot | null {
  if (readiness.status === 'checking') return null;
  return {
    status: readiness.status,
    origin: readiness.origin,
    message: readiness.message,
    checkedAt: readiness.checkedAt ?? new Date().toISOString(),
  };
}

function readinessNotice(readiness: ScorerReadinessState): BridgeNotice {
  if (readiness.status === 'ready') {
    return { kind: 'good', message: `Scorer connection ready. ${readiness.message}` };
  }
  if (readiness.status === 'blocked') {
    return { kind: 'warn', message: `Scorer cannot use this relay yet. ${readiness.message}` };
  }
  return { kind: 'warn', message: readiness.message };
}

function hasRelayPublication(rooms: readonly Room[], pendingRoomRemovals: readonly unknown[]): boolean {
  return (
    pendingRoomRemovals.length > 0 ||
    rooms.some(
      (room) =>
        room.relayPublished ||
        room.publishedMatchId !== null ||
        room.publishedRoundId !== null ||
        room.assignmentRevision !== 0,
    )
  );
}

function isRelayReplacement(current: BridgeState, connection: RelayConnection): boolean {
  const previous = connectionOf(current);
  return (
    (previous !== null && !sameRelayConnection(previous, connection)) ||
    (previous === null && hasRelayPublication(current.rooms, current.pendingRoomRemovals))
  );
}

/** Build the state for a newly claimed relay without exposing its credential to ordinary UI. */
function stateWithRelay(current: BridgeState, connection: RelayConnection): BridgeState {
  const replacing = isRelayReplacement(current, connection);
  return {
    ...current,
    scorerReadiness: null,
    relay: {
      ...connection,
      epoch: 1,
      revision: 0,
    },
    rooms: replacing ? current.rooms.map(resetRelayPublication) : current.rooms,
    // A tombstone describes a room that existed on the old relay. A new relay has never seen it;
    // keeping the local retired id is still useful, but sending the tombstone would recreate it.
    pendingRoomRemovals: replacing ? [] : current.pendingRoomRemovals,
  };
}

export function useBridge(): BridgeApi {
  const [state, setState] = useState<BridgeState>(() => loadState());
  const [tournament, setTournament] = useState<BridgeTournament | null>(null);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [notice, setNotice] = useState<BridgeNotice | null>(null);
  const [relayReachable, setRelayReachable] = useState<boolean | null>(null);
  const [scorerReadiness, setScorerReadiness] = useState<ScorerReadinessState | null>(() =>
    state.relay
      ? {
          status: 'checking',
          origin: scoresheetOrigin,
          message: `Checking whether ${scoresheetOrigin} can pair with this relay.`,
        }
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [changingRelay, setChangingRelay] = useState(false);
  const [pendingFileSwitch, setPendingFileSwitch] = useState<{
    tournamentName: string;
    path: string | null;
  } | null>(null);
  const stateRef = useRef(state);
  const pollGenerationRef = useRef(0);
  const pendingFileRef = useRef<{
    path: string | null;
    tournament: BridgeTournament;
    warnings: string[];
  } | null>(null);
  const pendingRelayClaimRef = useRef<RelayConnection | null>(null);
  const [relayCredentialSavePending, setRelayCredentialSavePending] = useState(false);
  const [persistenceSavePending, setPersistenceSavePending] = useState(false);
  const savingResultIdsRef = useRef(new Set<string>());
  const [savingResultIds, setSavingResultIds] = useState<Set<string>>(() => new Set());
  const savingBatchRef = useRef(false);
  const [savingBatch, setSavingBatch] = useState(false);

  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (notice?.kind !== 'good') return;
    const timer = setTimeout(() => setNotice(null), noticeAutoDismissMs);
    return () => clearTimeout(timer);
  }, [notice]);
  const readinessKeyRef = useRef<string | null>(null);

  const activateState = useCallback((next: BridgeState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const commit = useCallback(
    (
      next: BridgeState | ((current: BridgeState) => BridgeState),
      options: { critical?: boolean } = {},
    ): { state: BridgeState; persisted: PersistResult } => {
      const current = stateRef.current;
      const resolved = typeof next === 'function' ? next(current) : next;
      const persisted = saveState(resolved);
      if (options.critical) setPersistenceSavePending(!persisted.ok);
      activateState(resolved);
      return { state: resolved, persisted };
    },
    [activateState],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setResultSaving = useCallback((resultId: string, saving: boolean) => {
    const next = new Set(savingResultIdsRef.current);
    if (saving) next.add(resultId);
    else next.delete(resultId);
    savingResultIdsRef.current = next;
    setSavingResultIds(next);
  }, []);
  const refreshScorerReadiness = useCallback(
    async (connection: RelayConnection): Promise<ScorerReadinessState> => {
      const key = connectionKey(connection);
      readinessKeyRef.current = key;
      const checking: ScorerReadinessState = {
        status: 'checking',
        origin: scoresheetOrigin,
        message: `Checking whether ${scoresheetOrigin} can pair with this relay.`,
      };
      setScorerReadiness(checking);
      commit((current) =>
        connectionOf(current) && connectionKey(connectionOf(current)!) === key
          ? { ...current, scorerReadiness: null }
          : current,
      );
      try {
        const result = await relayCheckScorerReadiness(connection);
        const next = readinessState(result);
        const stored = persistedReadiness(next);
        if (readinessKeyRef.current === key) {
          setRelayReachable(true);
          setScorerReadiness(stored ? { ...next, checkedAt: stored.checkedAt } : next);
          commit((current) =>
            connectionOf(current) && connectionKey(connectionOf(current)!) === key
              ? { ...current, scorerReadiness: stored }
              : current,
          );
        }
        return next;
      } catch (error) {
        const next: ScorerReadinessState = {
          status: 'unknown',
          origin: scoresheetOrigin,
          message: `Scorer readiness could not be verified. Do not pair until this check succeeds. ${(error as Error).message}`,
        };
        const stored = persistedReadiness(next);
        if (readinessKeyRef.current === key) {
          setRelayReachable(false);
          setScorerReadiness(stored ? { ...next, checkedAt: stored.checkedAt } : next);
          commit((current) =>
            connectionOf(current) && connectionKey(connectionOf(current)!) === key
              ? { ...current, scorerReadiness: stored }
              : current,
          );
        }
        return next;
      }
    },
    [commit],
  );

  const applyLoadedFile = useCallback(
    (
      path: string | null,
      report: { ok: true; tournament: BridgeTournament; warnings: string[] },
      startNew: boolean,
    ): boolean => {
      const current = stateRef.current;
      const firstRoundId = report.tournament.rounds[0]?.id ?? null;
      if (startNew) {
        const next: BridgeState = {
          ...emptyState(),
          resultFolder: current.resultFolder,
          yftPath: path,
          tournamentName: report.tournament.name,
          selectedRoundId: firstRoundId,
        };
        const persisted = saveState(next);
        if (!persisted.ok) {
          setNotice({
            kind: 'bad',
            message:
              'The new tournament could not be started because QBBridge could not save its local state.',
          });
          return false;
        }
        pollGenerationRef.current += 1;
        readinessKeyRef.current = null;
        pendingRelayClaimRef.current = null;
        setRelayCredentialSavePending(false);
        setPersistenceSavePending(false);
        setScorerReadiness(null);
        setRelayReachable(null);
        setChangingRelay(false);
        activateState(next);
      } else {
        commit((currentState) => {
          const roundIds = new Set(report.tournament.rounds.map((round) => round.id));
          return {
            ...currentState,
            yftPath: path,
            tournamentName: report.tournament.name,
            selectedRoundId:
              currentState.selectedRoundId && roundIds.has(currentState.selectedRoundId)
                ? currentState.selectedRoundId
                : firstRoundId,
          };
        });
      }
      setTournament(report.tournament);
      setLoadWarnings(report.warnings);
      setNotice({
        kind: 'good',
        message: `${startNew ? 'Started a new QBBridge tournament for' : 'Loaded'} ${report.tournament.name}: ${report.tournament.teams.length} teams, ${report.tournament.playerCount} players.`,
      });
      return true;
    },
    [activateState, commit],
  );

  const loadFileContents = useCallback(
    (path: string | null, contents: string) => {
      const report = loadYellowFruitTournament(contents);
      if (!report.ok) {
        // Parsing a candidate is transactional: a bad replacement must not unload the last
        // working tournament while its persisted bridge state remains active.
        pendingFileRef.current = null;
        setPendingFileSwitch(null);
        setNotice({ kind: 'bad', message: report.errors.join(' ') });
        return;
      }
      const current = stateRef.current;
      const differentFile =
        current.yftPath !== null &&
        path !== null &&
        current.yftPath !== path &&
        current.tournamentName !== null;
      if (differentFile) {
        pendingFileRef.current = { path, tournament: report.tournament, warnings: report.warnings };
        setPendingFileSwitch({ path, tournamentName: report.tournament.name });
        setNotice({
          kind: 'warn',
          message:
            "You're opening a different YellowFruit file. Confirm if you want to start a new QBBridge tournament setup.",
        });
        return;
      }
      // A successful reload of the current file supersedes any older replacement proposal. Do not
      // leave a stale confirmation dialog able to switch away from the file now on screen.
      pendingFileRef.current = null;
      setPendingFileSwitch(null);
      applyLoadedFile(path, report, false);
    },
    [applyLoadedFile],
  );

  const confirmFileSwitch = useCallback(() => {
    const pending = pendingFileRef.current;
    if (!pending) return;
    if (
      !applyLoadedFile(
        pending.path,
        { ok: true, tournament: pending.tournament, warnings: pending.warnings },
        true,
      )
    )
      return;
    pendingFileRef.current = null;
    setPendingFileSwitch(null);
  }, [applyLoadedFile]);

  const cancelFileSwitch = useCallback(() => {
    pendingFileRef.current = null;
    setPendingFileSwitch(null);
    setNotice({ kind: 'warn', message: 'The current YellowFruit file and QBBridge setup are unchanged.' });
  }, []);

  const loadFile = useCallback(async () => {
    setBusy(true);
    try {
      const opened = await openYellowFruitFile();
      if (!opened) return;
      loadFileContents(opened.path, opened.contents);
    } catch (error) {
      setNotice({ kind: 'bad', message: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }, [loadFileContents]);

  /** Persist a claimed relay before exposing it as the active connection. */
  const activateClaimedRelay = useCallback(
    async (connection: RelayConnection): Promise<boolean> => {
      const replacing = isRelayReplacement(stateRef.current, connection);
      const next = stateWithRelay(stateRef.current, connection);
      const persisted = saveState(next);
      if (!persisted.ok) {
        // The claim crossed a one-time boundary, so retain only the returned credential needed for
        // an in-session retry. It is deliberately not placed in BridgeState or any user-visible
        // diagnostic while it is not durable.
        pendingRelayClaimRef.current = connection;
        setRelayCredentialSavePending(true);
        setChangingRelay(true);
        setRelayReachable(null);
        setNotice({
          kind: 'bad',
          message:
            'The relay claim succeeded, but QBBridge could not save the returned management credential. The new relay is not active yet; fix local storage and retry saving the credential.',
        });
        return false;
      }

      pendingRelayClaimRef.current = null;
      setRelayCredentialSavePending(false);
      setPersistenceSavePending(false);
      pollGenerationRef.current += 1;
      readinessKeyRef.current = null;
      activateState(next);
      setChangingRelay(false);
      setRelayReachable(true);
      const readiness = await refreshScorerReadiness(connection);
      if (readinessKeyRef.current === connectionKey(connection)) {
        const nextNotice = readinessNotice(readiness);
        setNotice(
          replacing
            ? {
                ...nextNotice,
                message: `${nextNotice.message} Publish Room Setup to activate these rooms on the new relay.`,
              }
            : nextNotice,
        );
      }
      return true;
    },
    [activateState, refreshScorerReadiness],
  );

  /**
   * Claim a relay and store the credential it returns.
   *
   * The stored relay is replaced **only after a successful claim**. A failed attempt leaves the
   * existing one exactly as it was, which matters because a relay's setup token is consumed by
   * its first claim: a credential deleted before a replacement exists cannot be recovered, and
   * the relay it authorized cannot be claimed again.
   */
  const connectRelay = useCallback(
    async (input: { baseUrl: string; tournamentId: string; setupToken: string }): Promise<boolean> => {
      setBusy(true);
      try {
        if (pendingRelayClaimRef.current !== null) {
          setNotice({ kind: 'bad', message: 'Retry saving the previously claimed relay credential first.' });
          return false;
        }
        const preflight = saveState(stateRef.current);
        if (!preflight.ok) {
          setNotice({
            kind: 'bad',
            message:
              'Relay setup did not start because QBBridge could not write its local state. The setup token was not sent.',
          });
          return false;
        }
        const claimed = await relayClaim(input);
        const connection: RelayConnection = {
          baseUrl: input.baseUrl.replace(/\/+$/, ''),
          tournamentId: claimed.tournamentId,
          managementToken: claimed.managementToken,
        };
        return await activateClaimedRelay(connection);
      } catch (error) {
        setRelayReachable(false);
        setNotice({
          kind: 'bad',
          message: `${(error as Error).message} The relay already set up here is unchanged.`,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activateClaimedRelay],
  );

  const retryRelayCredentialSave = useCallback(async (): Promise<boolean> => {
    const connection = pendingRelayClaimRef.current;
    if (!connection) return false;
    setBusy(true);
    try {
      return await activateClaimedRelay(connection);
    } catch (error) {
      setNotice({
        kind: 'bad',
        message: `The relay credential is still not saved. ${(error as Error).message}`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, [activateClaimedRelay]);

  const beginRelayChange = useCallback(() => setChangingRelay(true), []);
  const cancelRelayChange = useCallback(() => setChangingRelay(false), []);

  const checkScorerReadiness = useCallback(async () => {
    const connection = connectionOf(stateRef.current);
    if (!connection) return;
    const readiness = await refreshScorerReadiness(connection);
    if (readinessKeyRef.current === connectionKey(connection)) setNotice(readinessNotice(readiness));
  }, [refreshScorerReadiness]);

  useEffect(() => {
    if (!state.relay) {
      readinessKeyRef.current = null;
      return;
    }
    const connection = connectionOf(state);
    if (!connection) return;
    if (readinessKeyRef.current === connectionKey(connection)) return;
    void refreshScorerReadiness(connection);
  }, [refreshScorerReadiness, state]);

  /**
   * Delete the stored management credential.
   *
   * Separate from changing relays, named for what it does, and confirmed by the caller. There is
   * no way back: the relay's setup token was consumed by the claim that produced this
   * credential, so the same relay cannot be claimed again.
   */
  const forgetRelayCredential = useCallback(() => {
    pollGenerationRef.current += 1;
    const persisted = commit((current) => ({ ...current, relay: null, scorerReadiness: null }), {
      critical: true,
    }).persisted;
    setChangingRelay(true);
    setRelayReachable(null);
    setNotice({
      kind: persisted.ok ? 'warn' : 'bad',
      message: persisted.ok
        ? 'The relay credential was deleted from this machine. Set up a relay to publish again.'
        : 'The relay credential was removed from the active session but could not be saved locally. Retry saving local state before restarting.',
    });
  }, [commit]);

  const retryStatePersistence = useCallback((): boolean => {
    const persisted = saveState(stateRef.current);
    if (persisted.ok) {
      setPersistenceSavePending(false);
      setNotice({ kind: 'good', message: 'The current relay state is saved locally.' });
      return true;
    }
    setPersistenceSavePending(true);
    setNotice({
      kind: 'bad',
      message: 'QBBridge still cannot save the current relay state. Restore local storage access and retry.',
    });
    return false;
  }, []);

  const addRoom = useCallback(() => {
    commit((current) => {
      const id = nextRoomId([
        ...current.rooms,
        ...current.pendingRoomRemovals,
        ...current.retiredRoomIds.map((roomId) => ({ id: roomId })),
      ]);
      const name = `Room ${current.rooms.length + 1}`;
      return { ...current, rooms: [...current.rooms, newRoom(id, name, generatePairingCode())] };
    });
  }, [commit]);

  const updateRoom = useCallback(
    (roomId: string, change: (room: Room) => Room) => {
      commit((current) => ({
        ...current,
        rooms: current.rooms.map((room) => (room.id === roomId ? change(room) : room)),
      }));
    },
    [commit],
  );

  const renameRoom = useCallback(
    (roomId: string, name: string) => updateRoom(roomId, (room) => ({ ...room, name })),
    [updateRoom],
  );

  const removeRoom = useCallback(
    (roomId: string) => {
      const room = stateRef.current.rooms.find((entry) => entry.id === roomId);
      if (!room) return;
      const tombstone = room.relayPublished ? roomTombstone(room) : null;
      commit((current) => ({
        ...current,
        rooms: current.rooms.filter((entry) => entry.id !== roomId),
        pendingRoomRemovals:
          tombstone && !current.pendingRoomRemovals.some((entry) => entry.id === roomId)
            ? [...current.pendingRoomRemovals, tombstone]
            : current.pendingRoomRemovals,
        retiredRoomIds:
          tombstone && !current.retiredRoomIds.includes(roomId)
            ? [...current.retiredRoomIds, roomId]
            : current.retiredRoomIds,
      }));
      setNotice(
        tombstone
          ? {
              kind: 'warn',
              message: `${room.name} was removed locally and will be cleared from the relay on the next successful publish.`,
            }
          : { kind: 'good', message: `${room.name} was removed.` },
      );
    },
    [commit],
  );

  const setRoomTeams = useCallback(
    (roomId: string, side: 'left' | 'right', teamId: string | null) =>
      updateRoom(roomId, (room) => ({
        ...room,
        [side === 'left' ? 'leftTeamId' : 'rightTeamId']: teamId,
      })),
    [updateRoom],
  );

  const regeneratePairingCode = useCallback(
    (roomId: string) =>
      updateRoom(roomId, (room) => ({ ...room, pendingPairingCode: generatePairingCode() })),
    [updateRoom],
  );

  /**
   * Choose the round the pairing table is for.
   *
   * Selecting a different round clears every room's team selection. The alternative — leaving
   * last round's pairings in the dropdowns under a new round's heading — makes the single most
   * damaging operator mistake available in one click: publishing round 4's matchups as real,
   * correctly formatted round 5 assignments, which the rooms would score and YellowFruit would
   * import without complaint.
   *
   * Rooms, their ids, their names, their pairing codes and their publication history all
   * survive. Only the entry state for the current round is cleared.
   */
  const selectRound = useCallback(
    (roundId: string) =>
      commit((current) =>
        current.selectedRoundId === roundId
          ? current
          : {
              ...current,
              selectedRoundId: roundId,
              rooms: current.rooms.map((room) => ({
                ...room,
                leftTeamId: null,
                rightTeamId: null,
              })),
            },
      ),
    [commit],
  );

  /** Apply a successful mirror without activating a code changed while the request was in flight. */
  const applyPublication = useCallback(
    (
      outcome: PublishOutcome,
      pendingCodes: ReadonlyMap<string, string | null>,
      tombstoneIds: ReadonlySet<string>,
    ) => {
      const byRoom = new Map(outcome.assignments.map((entry) => [entry.roomId, entry]));
      const cleared = new Set(outcome.clearedRoomIds);
      return commit(
        (current) => ({
          ...current,
          relay: current.relay ? { ...current.relay, revision: outcome.revision } : null,
          rooms: current.rooms.map((room) => {
            const wasMirrored = pendingCodes.has(room.id);
            if (!wasMirrored) return room;
            const sentPendingCode = pendingCodes.get(room.id) ?? null;
            const pendingStillCurrent = room.pendingPairingCode === sentPendingCode;
            const published = {
              ...room,
              pairingCode:
                pendingStillCurrent && sentPendingCode !== null ? sentPendingCode : room.pairingCode,
              pendingPairingCode: pendingStillCurrent ? null : room.pendingPairingCode,
              relayPublished: true,
            };
            const assignment = byRoom.get(room.id);
            if (assignment) {
              return {
                ...published,
                publishedMatchId: assignment.matchId,
                publishedRoundId: assignment.roundId,
                assignmentRevision: assignment.assignmentRevision,
              };
            }
            if (!cleared.has(room.id)) return published;
            // The relay just cleared this room. Local state says so too, or the room table would
            // keep reporting a game that is no longer on the relay.
            return {
              ...published,
              publishedMatchId: null,
              publishedRoundId: null,
              assignmentRevision: room.assignmentRevision + 1,
            };
          }),
          pendingRoomRemovals: current.pendingRoomRemovals.filter((room) => !tombstoneIds.has(room.id)),
          retiredRoomIds: [...new Set([...current.retiredRoomIds, ...tombstoneIds])],
        }),
        { critical: true },
      ).persisted;
    },
    [commit],
  );

  const publishPlan = useCallback(
    async (input: {
      plan: PublishPlan;
      tournamentName: string;
      successKind: 'good' | 'warn';
      successMessage: (outcome: PublishOutcome) => string;
      failureMessage: string;
      missingRelayMessage: string;
    }): Promise<PublishOutcome | null> => {
      const current = stateRef.current;
      const connection = connectionOf(current);
      if (!connection) {
        setNotice({ kind: 'bad', message: input.missingRelayMessage });
        return null;
      }
      if (input.plan.publications.length === 0) {
        setNotice({ kind: 'bad', message: 'There are no rooms to publish. Add a room first.' });
        return null;
      }
      setBusy(true);
      const pendingCodes = new Map(current.rooms.map((room) => [room.id, room.pendingPairingCode]));
      const tombstoneIds = new Set(current.pendingRoomRemovals.map((room) => room.id));
      try {
        const outcome = await publishRound(connection, {
          epoch: current.relay?.epoch ?? 1,
          lastRevision: current.relay?.revision ?? 0,
          tournamentName: input.tournamentName,
          plan: input.plan,
          rooms: current.rooms,
          tombstones: current.pendingRoomRemovals,
        });
        const persisted = applyPublication(outcome, pendingCodes, tombstoneIds);
        setRelayReachable(true);
        setNotice(
          persisted.ok
            ? { kind: input.successKind, message: input.successMessage(outcome) }
            : {
                kind: 'warn',
                message: `${input.successMessage(outcome)} The relay accepted it, but QBBridge could not save the new revision locally. Keep this window open and retry saving local state before restarting.`,
              },
        );
        return outcome;
      } catch (error) {
        if (error instanceof RelayError) setRelayReachable(false);
        setNotice({ kind: 'bad', message: `${input.failureMessage} ${(error as Error).message}` });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [applyPublication],
  );

  const publish = useCallback(async () => {
    const current = stateRef.current;
    const round = tournament?.rounds.find((entry) => entry.id === current.selectedRoundId);
    if (!tournament || !round) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file and choose a round first.' });
      return;
    }
    const plan = planRound(tournament, round, current.rooms, current.pendingRoomRemovals);
    if (plan.assignments.length === 0) {
      setNotice({
        kind: 'bad',
        message:
          'No room in this round has two teams chosen. Use “Publish Room Setup” to publish room codes or clear assignments.',
      });
      return;
    }
    await publishPlan({
      plan,
      tournamentName: tournament.name,
      successKind: plan.cleared.length > 0 ? 'warn' : 'good',
      successMessage: (outcome) => {
        const clearedNote =
          plan.cleared.length > 0
            ? ` ${plan.cleared.length} room(s) were cleared and can no longer open a game.`
            : '';
        return `Published round ${round.displayName} to ${outcome.assignments.length} room(s).${clearedNote}`;
      },
      failureMessage: 'Round not published — the rooms still have whatever they had before.',
      missingRelayMessage: 'Connect the relay before publishing a round.',
    });
  }, [publishPlan, tournament]);

  const publishRoomSetup = useCallback(async () => {
    const current = stateRef.current;
    if (!current.tournamentName) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file before publishing room setup.' });
      return;
    }
    const plan = planRoomSetup(current.rooms, current.pendingRoomRemovals);
    await publishPlan({
      plan,
      tournamentName: current.tournamentName,
      successKind: 'good',
      successMessage: () => {
        const removed = plan.publications.length - current.rooms.length;
        const removedNote = removed > 0 ? ` Cleared ${removed} removed room(s) from the relay.` : '';
        return `Published room setup for ${current.rooms.length} room(s). Pairing codes are now active and room tokens remain valid.${removedNote}`;
      },
      failureMessage: 'Room setup not published — the relay and local active codes are unchanged.',
      missingRelayMessage: 'Connect the relay before publishing room setup.',
    });
  }, [publishPlan]);

  const pollResults = useCallback(async () => {
    const current = stateRef.current;
    const connection = connectionOf(current);
    if (!connection || !isNativeHost()) return;

    // Each request supersedes an older overlapping request. The connection check handles relay
    // replacement, while the generation check also handles a slow earlier poll from the same
    // relay returning after a newer poll has already completed.
    const generation = pollGenerationRef.current + 1;
    pollGenerationRef.current = generation;
    const isCurrentPoll = () =>
      generation === pollGenerationRef.current &&
      sameRelayConnection(connection, connectionOf(stateRef.current));

    try {
      const fetched = await relayFetchResults(connection);
      if (!isCurrentPoll()) return;

      const currentAtSuccess = stateRef.current;
      const pendingAckIds = [
        ...new Set(
          fetched
            .filter((entry) => {
              const local = currentAtSuccess.results.find((row) => row.resultId === entry.resultId);
              return local?.savedPath !== undefined && local.ackPending !== false;
            })
            .map((entry) => entry.resultId),
        ),
      ];
      setRelayReachable(true);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        const fresh: StoredResult[] = fetched
          .filter((entry) => !current.results.some((row) => row.resultId === entry.resultId))
          .map((entry) => ({ resultId: entry.resultId, qbj: entry.qbj, receivedAt: entry.receivedAt }));
        if (fresh.length === 0) return current;
        return { ...current, results: [...current.results, ...fresh] };
      });

      if (pendingAckIds.length === 0 || !isCurrentPoll()) return;
      try {
        // The connection is captured from the poll, never reread from state after the await. A
        // relay replacement can therefore not accidentally receive an ACK for the old relay.
        await relayAcknowledgeResults(connection, pendingAckIds);
      } catch {
        // The file is already safe locally. Leave ackPending set so this result is retried on a
        // later poll, including after a restart.
        return;
      }
      if (!isCurrentPoll()) return;
      const acknowledged = new Set(pendingAckIds);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        return {
          ...current,
          results: current.results.map((entry) =>
            acknowledged.has(entry.resultId) ? { ...entry, ackPending: false } : entry,
          ),
        };
      });
    } catch {
      if (isCurrentPoll()) setRelayReachable(false);
    }
  }, [commit]);

  useEffect(() => {
    // Changing the active relay invalidates every in-flight request, even if a replacement happens
    // to reuse the same visible URL. The identity check above is the second, explicit fence.
    pollGenerationRef.current += 1;
    if (!state.relay) return;
    // The first poll is scheduled rather than run inline: polling ends in a `setState`, and a
    // `setState` in an effect body is a cascading render. A tick's delay costs nothing here.
    const first = setTimeout(() => void pollResults(), 0);
    const timer = setInterval(() => void pollResults(), resultPollIntervalMs);
    return () => {
      pollGenerationRef.current += 1;
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pollResults, state.relay]);

  const chooseFolder = useCallback(async () => {
    try {
      const folder = await chooseResultFolder();
      if (folder) commit((current) => ({ ...current, resultFolder: folder }));
    } catch (error) {
      setNotice({ kind: 'bad', message: (error as Error).message });
    }
  }, [commit]);

  /**
   * Write one result and record where it went.
   *
   * The native writer refuses an existing file unless the target is exactly the result's previous
   * savedPath. That keeps a folder change exclusive while still allowing an intentional Save again
   * to rewrite this result's own file.
   */
  const writeOne = useCallback(
    async (entry: StoredResult, folder: string): Promise<void> => {
      const summary = resultSummary(entry.qbj);
      const fileName = resultFileName(summary, entry.resultId);
      const targetPath = resultFilePath(folder, fileName);
      const path = await writeResultFile(
        folder,
        fileName,
        // The bytes are the relay's document, serialized. Nothing is recalculated on the way out.
        resultFileContents(entry.qbj),
        entry.savedPath === targetPath,
      );
      commit((current) => ({
        ...current,
        results: current.results.map((row) =>
          row.resultId === entry.resultId ? { ...row, savedPath: path, ackPending: true } : row,
        ),
      }));
    },
    [commit],
  );

  /**
   * Tell the relay these results are on disk.
   *
   * The only place an acknowledgment is sent, and it runs after the write rather than alongside
   * it. A failure is swallowed on purpose: the file exists, the local record says so, and an
   * unacknowledged result costs nothing beyond being offered again on the next poll.
   */
  const acknowledgeSaved = useCallback(
    async (connection: RelayConnection | null, resultIds: readonly string[]): Promise<void> => {
      if (
        !connection ||
        resultIds.length === 0 ||
        !sameRelayConnection(connection, connectionOf(stateRef.current))
      )
        return;
      try {
        await relayAcknowledgeResults(connection, resultIds);
      } catch {
        // Deliberately quiet. See above; ackPending remains true for a later poll retry.
        return;
      }
      if (!sameRelayConnection(connection, connectionOf(stateRef.current))) return;
      const acknowledged = new Set(resultIds);
      commit((current) => {
        if (!sameRelayConnection(connection, connectionOf(current))) return current;
        return {
          ...current,
          results: current.results.map((entry) =>
            acknowledged.has(entry.resultId) ? { ...entry, ackPending: false } : entry,
          ),
        };
      });
    },
    [commit],
  );

  const saveResult = useCallback(
    async (resultId: string) => {
      if (savingBatchRef.current || savingResultIdsRef.current.has(resultId)) return;
      const current = stateRef.current;
      const folder = current.resultFolder;
      const entry = current.results.find((row) => row.resultId === resultId);
      if (!folder) {
        setNotice({ kind: 'bad', message: 'Choose a results folder first.' });
        return;
      }
      if (!entry) return;
      const connection = connectionOf(current);
      setResultSaving(resultId, true);
      try {
        await writeOne(entry, folder);
        await acknowledgeSaved(connection, [entry.resultId]);
        setNotice({ kind: 'good', message: 'Result saved.' });
      } catch (error) {
        setNotice({ kind: 'bad', message: `That result was not saved. ${(error as Error).message}` });
      } finally {
        setResultSaving(resultId, false);
      }
    },
    [acknowledgeSaved, setResultSaving, writeOne],
  );

  const saveNewResults = useCallback(async () => {
    if (savingBatchRef.current || savingResultIdsRef.current.size > 0) return;
    const current = stateRef.current;
    const folder = current.resultFolder;
    if (!folder) {
      setNotice({ kind: 'bad', message: 'Choose a results folder first.' });
      return;
    }
    const unsaved = current.results.filter((entry) => !entry.savedPath);
    if (unsaved.length === 0) {
      setNotice({ kind: 'good', message: 'Every result is already saved.' });
      return;
    }
    savingBatchRef.current = true;
    setSavingBatch(true);
    setBusy(true);
    const failures: string[] = [];
    const written: string[] = [];
    const connection = connectionOf(current);
    try {
      for (const entry of unsaved) {
        try {
          await writeOne(entry, folder);
          written.push(entry.resultId);
        } catch (error) {
          // One bad filename or one full disk must not stop the other eleven, and the one that
          // failed stays unsaved rather than being marked done.
          failures.push((error as Error).message);
        }
      }
      await acknowledgeSaved(connection, written);
      setNotice(
        failures.length === 0
          ? { kind: 'good', message: `Saved ${written.length} result file(s) to ${folder}.` }
          : {
              kind: 'bad',
              message: `Saved ${written.length} of ${unsaved.length}. ${failures[0]}`,
            },
      );
    } finally {
      savingBatchRef.current = false;
      setSavingBatch(false);
      setBusy(false);
    }
  }, [acknowledgeSaved, writeOne]);

  const resultMatchIds = useMemo(
    () => new Set(state.results.map((entry) => matchIdOf(entry.qbj)).filter(Boolean)),
    [state.results],
  );

  const roomStatus = useCallback(
    (room: Room): RoomStatus => {
      if (!room.relayPublished) return 'not-published';
      if (!room.publishedMatchId) return 'ready-to-pair';
      if (resultMatchIds.has(room.publishedMatchId)) return 'result-received';
      return 'waiting';
    },
    [resultMatchIds],
  );

  const teamName = useCallback(
    (id: string) => tournament?.teams.find((team) => team.id === id)?.name ?? id,
    [tournament],
  );

  const warnings = useMemo(() => pairingWarnings(state.rooms, teamName), [state.rooms, teamName]);

  const roundChangeDiscardsSelections = state.rooms.some(
    (room) => room.leftTeamId !== null || room.rightTeamId !== null,
  );

  /**
   * The one place the relay's unacknowledged window is surfaced.
   *
   * Saved results leave that window, so it can only fill with results nobody has written to
   * disk. Past the threshold the operator is told plainly, because the failure beyond it is
   * silent: the relay would keep accepting finals and stop showing them.
   */
  const unsavedCount = state.results.filter((entry) => !entry.savedPath || entry.ackPending).length;
  const unsavedResultWarning =
    unsavedCount >= unsavedResultWarningThreshold
      ? `${unsavedCount} results are still unsaved or awaiting relay acknowledgment. The relay shows the oldest ${relayUnackedWindow} unconfirmed results at a time — save these before more games finish.`
      : null;

  const resultBusy = useCallback(
    (resultId: string) => busy || savingBatch || savingResultIds.has(resultId),
    [busy, savingBatch, savingResultIds],
  );

  return {
    state,
    tournament,
    loadWarnings,
    notice,
    dismissNotice,
    relayReachable,
    scorerReadiness,
    busy,
    native: isNativeHost(),
    loadFile,
    loadFileContents,
    pendingFileSwitch,
    confirmFileSwitch,
    cancelFileSwitch,
    connectRelay,
    relayCredentialSavePending,
    retryRelayCredentialSave,
    persistenceSavePending,
    retryStatePersistence,
    checkScorerReadiness,
    beginRelayChange,
    cancelRelayChange,
    changingRelay,
    forgetRelayCredential,
    addRoom,
    renameRoom,
    removeRoom,
    setRoomTeams,
    regeneratePairingCode,
    selectRound,
    roundChangeDiscardsSelections,
    publish,
    publishRoomSetup,
    roomStatus,
    warnings,
    chooseFolder,
    saveNewResults,
    saveResult,
    resultBusy,
    savingResults: savingBatch || savingResultIds.size > 0,
    pollResults,
    unsavedResultWarning,
  };
}

/** The `Match.id` inside a result document, for matching a result back to the room that played it. */
function matchIdOf(qbj: unknown): string {
  if (!qbj || typeof qbj !== 'object' || Array.isArray(qbj)) return '';
  const record = qbj as Record<string, unknown>;
  if (record.type === 'Match' && typeof record.id === 'string') return record.id;
  const objects = Array.isArray(record.objects) ? record.objects : [];
  for (const entry of objects) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const object = entry as Record<string, unknown>;
      if (object.type === 'Match' && typeof object.id === 'string') return object.id;
    }
  }
  return '';
}
