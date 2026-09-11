/**
 * The application's state, as one hook.
 *
 * Small on purpose: a `useReducer`-shaped store with a schedule, a lifecycle and a projection
 * layer is the architecture this application is supposed not to have. What is here is the loaded
 * file, the persisted state, one poll timer, and the handful of actions the three views call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fnv1a64 } from '../../../../src/director/transfers/canonical';
import {
  assignmentFileContents,
  assignmentFileName,
  assignmentFingerprint,
  plannedAssignmentFingerprint,
} from './assignment';
import { buildEmergencyPack, packAuthorityWarnings, type EmergencyPack } from './emergencyPacks';
import {
  chooseAssignmentFolder,
  chooseResultFolder,
  deleteRelayCredential,
  isNativeHost,
  loadRelayCredential,
  openRecoveryPackage,
  openRoundPlan,
  openYellowFruitFile,
  relayCredentialKey,
  storeRelayCredential,
  writeAssignmentFile,
  writeRecoveryPackage,
  writeResultFile,
  writeRoundPackFile,
} from './native';
import { generatePairingCode } from './pairing';
import {
  planRoomSetup,
  planRound,
  publicationReviewItems,
  publishRound,
  type PublicationReviewItem,
  type PublishOutcome,
  type PublishPlan,
} from './publish';
import {
  relayAcknowledgeResults,
  relayClaim,
  relayCheckScorerReadiness,
  relayFetchResults,
  relayHealth,
  relayProvisionBackup,
  relayRevokeBackup,
  relayRotateBackup,
  relayTakeover,
  relayTransfer,
  relayUnackedWindow,
  RelayError,
  type BackupProvisionResult,
  type RelayConnection,
  type ScorerReadinessResult,
} from './relay';
import {
  resultFileContents,
  resultFileName,
  resultFilePath,
  resultImportStatus,
  resultMatchId,
  resultSummary,
} from './results';
import { nextRoomId } from './identity';
import {
  newRoom,
  pairingWarnings,
  resetRelayPublication,
  roomTombstone,
  type Room,
  type RoomStatus,
  type RoomTombstone,
} from './rooms';
import {
  assignedRoomCount,
  pairingsForRound,
  pairingFor,
  planPublicationStatus,
  plannedMatchId,
  plannedTeams,
  reconcilePlans,
  reconciliationChangedAnything,
  type PlanReconciliation,
  removeRoomFromPlans,
  setPlannedSide,
  type PlanPublicationStatus,
} from './roundPlans';
import {
  accountRound,
  dispositionFor,
  normalizeRoundDispositions,
  reconcileDispositions,
  roundPublishGate,
  setTeamDisposition as setDispositionEntry,
  type DispositionReconciliation,
  type RoundAccount,
  type TeamDispositionKind,
} from './roundAccountability';
import {
  applyPortablePlan,
  diffPortablePlan,
  exportPortablePlan,
  exportPrelimCsv,
  importPrelimCsv,
  parsePortablePlan,
  type PlanImportDiff,
  type PortableRoundPlan,
} from './planExchange';
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
import {
  decryptRecoveryPackage,
  encryptRecoveryPackage,
  recoveryPackageFileName,
  recoveryPackageState,
} from './recovery';
import { schedulePairingWarnings } from './schedule';
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

export interface AssignmentFallback {
  tournamentName: string;
  roundId: string;
  roundName: string;
  plan: PublishPlan;
  /** Room ids whose assignment files were already written during a partial retry. */
  exportedRoomIds: string[];
  /** The one folder chosen for this export attempt. */
  exportDirectory: string | null;
}

interface PublicationSnapshot {
  connection: RelayConnection | null;
  epoch: number;
  revision: number;
  rooms: Room[];
  tombstones: RoomTombstone[];
}

export interface PendingPublicationReview {
  tournamentName: string;
  roundId: string;
  roundName: string;
  plan: PublishPlan;
  items: PublicationReviewItem[];
  snapshot: PublicationSnapshot;
  /**
   * Accountability warnings under review. Confirming publishes anyway as an explicit, labeled
   * exception; the success notice says so.
   */
  accountabilityWarningCount: number;
}

/** A parsed plan file waiting for the operator to review its diff and confirm. */
export interface PendingPlanImport {
  sourceName: string;
  /** The validated plan. Confirm re-resolves it against current state — never trusted blind. */
  plan: PortableRoundPlan;
  diff: PlanImportDiff;
}

/** A built emergency pack waiting on its authority-warning review before anything is written. */
export interface PendingPackExport {
  pack: EmergencyPack;
  roundCount: number;
  warnings: string[];
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
  importRecoveryPackage(passphrase: string): Promise<boolean>;
  createRecoveryPackage(passphrase: string, label?: string): Promise<boolean>;
  provisionBackup(label: string): Promise<BackupProvisionResult | null>;
  rotateBackup(label?: string): Promise<BackupProvisionResult | null>;
  revokeBackup(): Promise<boolean>;
  takeOverRelay(): Promise<boolean>;
  transferRelayToPrimary(): Promise<boolean>;
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
  /** Choose one side of one room's matchup in the selected round. Never touches another round. */
  setRoomTeams(roomId: string, side: 'left' | 'right', teamId: string | null): void;
  /** The selected round's planned matchup for this room. Both null when nothing is entered. */
  plannedTeamsFor(roomId: string): { leftTeamId: string | null; rightTeamId: string | null };
  /** How this room's planned game for the selected round compares with what the relay holds. */
  planStatus(room: Room): PlanPublicationStatus;
  /**
   * How many complete matchups the selected round has planned. Descriptive, never a fraction:
   * QBBridge does not know how many games a round should contain — a bye, a playoff phase using
   * fewer rooms, or an intentionally idle room all make the physical room count a wrong
   * denominator — so no expected total is reported.
   */
  roundProgress: { roundId: string | null; assigned: number };
  /** Assignment counts for every round in the selected round's phase, for the pre-tournament view. */
  phaseRoundProgress: { roundId: string; displayName: string; assigned: number }[];
  /**
   * State (or clear) one team's bye/inactive disposition in the selected round. Assignment stays
   * derived from the pairings; this records only the explicit decision to sit a team out.
   */
  setTeamDisposition(teamId: string, kind: TeamDispositionKind | null): void;
  /** One team's stated disposition in the selected round. Null means expected to play. */
  dispositionForTeam(teamId: string): TeamDispositionKind | null;
  /** The full accountability report for the selected round. Null before a file loads. */
  roundAccount: RoundAccount | null;
  /** Write the portable round-plan file (ids plus YFT fingerprint, never credentials). */
  exportRoundPlan(): Promise<boolean>;
  /** Write the prelim schedule as spreadsheet CSV. */
  exportPrelimCsvFile(): Promise<boolean>;
  /** Open a plan or CSV file, validate it, and hold its diff for explicit review. */
  importRoundPlan(): Promise<void>;
  pendingPlanImport: PendingPlanImport | null;
  /** Apply the reviewed import, replacing exactly the rounds the file covers. */
  confirmPlanImport(): void;
  cancelPlanImport(): void;
  /** Build the next N rounds' emergency pack; writes immediately unless rooms are live. */
  exportEmergencyPack(roundCount: number): Promise<boolean>;
  pendingPackExport: PendingPackExport | null;
  confirmPackExport(): Promise<boolean>;
  cancelPackExport(): void;
  regeneratePairingCode(roomId: string): void;
  /** Change which round the table is editing. Changes nothing else, and discards nothing. */
  selectRound(roundId: string): void;
  publish(): Promise<void>;
  pendingPublicationReview: PendingPublicationReview | null;
  confirmPublicationReview(): Promise<void>;
  cancelPublicationReview(): void;
  assignmentFallback: AssignmentFallback | null;
  exportAssignmentFallback(): Promise<boolean>;
  /** Publish room identities and pairing hashes without sending any match assignments. */
  publishRoomSetup(): Promise<void>;
  roomStatus(room: Room): RoomStatus;
  warnings: ReturnType<typeof pairingWarnings>;

  chooseFolder(): Promise<void>;
  saveNewResults(): Promise<void>;
  saveResult(resultId: string): Promise<void>;
  markResultImported(resultId: string): void;
  unmarkResultImported(resultId: string): void;
  needsImportCount: number;
  /** True when this row cannot start a save because a save or another bridge action is active. */
  resultBusy(resultId: string): boolean;
  /** True while an individual or batch result save is in progress. */
  savingResults: boolean;
  pollResults(): Promise<void>;
  /** Set when unsaved results are approaching the relay's unacknowledged window. */
  unsavedResultWarning: string | null;
}

/**
 * One sentence about what a reload cost the saved plans.
 *
 * Deliberately one notice rather than one per casualty: a `.yft` reloaded after a team withdrew can
 * clear a side in nine rounds, and nine notices is a wall the operator dismisses without reading.
 */
function describeReconciliation(report: PlanReconciliation): string {
  const parts: string[] = [];
  if (report.removedRoundIds.length > 0) {
    parts.push(
      `${report.removedRoundIds.length} planned round(s) no longer exist in the file and were dropped`,
    );
  }
  if (report.removedRoomIds.length > 0) {
    parts.push(`${report.removedRoomIds.length} removed room(s) were dropped from saved rounds`);
  }
  if (report.clearedSideCount > 0) {
    parts.push(`${report.clearedSideCount} team selection(s) were cleared because the team is gone`);
  }
  if (report.removedPairingCount > 0) {
    parts.push(`${report.removedPairingCount} planned matchup(s) were emptied as a result`);
  }
  return `Saved round plans were reconciled with the file: ${parts.join('; ')}. Re-enter those selections before publishing.`;
}

/** One sentence about what a reload cost the stated bye/inactive markings, if anything. */
function describeDispositionReconciliation(report: DispositionReconciliation): string | null {
  const parts: string[] = [];
  if (report.droppedRoundIds.length > 0) {
    parts.push(
      `${report.droppedRoundIds.length} round(s) of bye/inactive markings were dropped with their rounds`,
    );
  }
  if (report.droppedTeamCount > 0) {
    parts.push(`${report.droppedTeamCount} bye/inactive marking(s) were dropped because the team is gone`);
  }
  // Dropped markings fail open toward unaccounted, which the publish gate refuses to ignore —
  // so this is a recount, not a repair.
  return parts.length === 0 ? null : `Also ${parts.join('; ')}. Those teams now read as unaccounted.`;
}

function connectionOf(state: BridgeState): RelayConnection | null {
  if (!state.relay || typeof state.relay.managementToken !== 'string') return null;
  return {
    baseUrl: state.relay.baseUrl,
    tournamentId: state.relay.tournamentId,
    managementToken: state.relay.managementToken,
    ...(state.relay.controllerRole ? { controllerRole: state.relay.controllerRole } : {}),
    ...(state.relay.controllerId ? { controllerId: state.relay.controllerId } : {}),
    ...(state.relay.controllerLabel ? { controllerLabel: state.relay.controllerLabel } : {}),
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

function publicationSnapshot(state: BridgeState): PublicationSnapshot {
  return {
    connection: connectionOf(state),
    epoch: state.relay?.epoch ?? 1,
    revision: state.relay?.revision ?? 0,
    rooms: state.rooms.map((room) => ({ ...room })),
    tombstones: state.pendingRoomRemovals.map((room) => ({ ...room })),
  };
}

/** Only transport/server failures justify a local-file fallback; refusals require correction. */
function relayUnavailable(error: unknown): boolean {
  return !(error instanceof RelayError) || (error.status !== null && error.status >= 500);
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
  const [pendingPublicationReview, setPendingPublicationReview] = useState<PendingPublicationReview | null>(
    null,
  );
  const pendingPublicationReviewRef = useRef<PendingPublicationReview | null>(null);
  const [assignmentFallback, setAssignmentFallback] = useState<AssignmentFallback | null>(null);
  const assignmentFallbackRef = useRef<AssignmentFallback | null>(null);
  const [pendingPlanImport, setPendingPlanImport] = useState<PendingPlanImport | null>(null);
  const pendingPlanImportRef = useRef<PendingPlanImport | null>(null);
  const [pendingPackExport, setPendingPackExport] = useState<PendingPackExport | null>(null);
  const pendingPackExportRef = useRef<PendingPackExport | null>(null);
  const stateRef = useRef(state);
  const pollGenerationRef = useRef(0);
  const pendingFileRef = useRef<{
    path: string | null;
    tournament: BridgeTournament;
    warnings: string[];
    yftFingerprint: string | null;
  } | null>(null);
  const pendingRelayClaimRef = useRef<RelayConnection | null>(null);
  const [relayCredentialSavePending, setRelayCredentialSavePending] = useState(false);
  const [persistenceSavePending, setPersistenceSavePending] = useState(false);
  const savingResultIdsRef = useRef(new Set<string>());
  const [savingResultIds, setSavingResultIds] = useState<Set<string>>(() => new Set());
  const savingBatchRef = useRef(false);
  const [savingBatch, setSavingBatch] = useState(false);
  const credentialMigrationRef = useRef<string | null>(null);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const rememberPublicationReview = useCallback((review: PendingPublicationReview | null): void => {
    pendingPublicationReviewRef.current = review;
    setPendingPublicationReview(review);
  }, []);

  const rememberAssignmentFallback = useCallback((fallback: AssignmentFallback | null): void => {
    assignmentFallbackRef.current = fallback;
    setAssignmentFallback(fallback);
  }, []);

  const rememberPlanImport = useCallback((pending: PendingPlanImport | null): void => {
    pendingPlanImportRef.current = pending;
    setPendingPlanImport(pending);
  }, []);

  const rememberPackExport = useCallback((pending: PendingPackExport | null): void => {
    pendingPackExportRef.current = pending;
    setPendingPackExport(pending);
  }, []);

  const invalidateRoundArtifacts = useCallback((): void => {
    rememberPublicationReview(null);
    rememberAssignmentFallback(null);
    // A plan diff or a built pack belongs to the file it was validated against. A new file
    // must not inherit either: the fingerprint check would be theater if stale state survived.
    rememberPlanImport(null);
    rememberPackExport(null);
  }, [rememberAssignmentFallback, rememberPackExport, rememberPlanImport, rememberPublicationReview]);

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

  /**
   * Migrate legacy localStorage credentials to the OS secure store, or restore a secure-only
   * credential after a restart. The bearer remains in memory only; every native save omits it from
   * the JSON blob so a profile backup/cloud-sync copy cannot become a plaintext credential backup.
   */
  useEffect(() => {
    const relay = state.relay;
    if (!relay || !isNativeHost()) return;
    const key = relayCredentialKey(
      relay.baseUrl,
      relay.tournamentId,
      relay.controllerRole ?? 'primary',
      relay.controllerId ?? '',
    );
    if (credentialMigrationRef.current === key) return;
    credentialMigrationRef.current = key;
    const sameRelay = (current: BridgeState): boolean =>
      current.relay?.baseUrl === relay.baseUrl && current.relay?.tournamentId === relay.tournamentId;
    if (typeof relay.managementToken === 'string' && relay.managementToken !== '') {
      void storeRelayCredential(key, relay.managementToken)
        .then(() => {
          const current = stateRef.current;
          if (sameRelay(current)) saveState(current, { secureCredential: true });
        })
        .catch((error) => {
          setNotice({
            kind: 'bad',
            message: `QBBridge could not move the relay credential into secure storage. Keep this profile private and repair secure storage before continuing. ${(error as Error).message}`,
          });
        });
      return;
    }
    void loadRelayCredential(key)
      .then((token) => {
        const current = stateRef.current;
        if (!token || !sameRelay(current) || !current.relay) {
          setRelayReachable(false);
          setNotice({
            kind: 'bad',
            message:
              'This profile has relay metadata but no secure management credential. Import the encrypted recovery package or connect a relay again; the consumed setup token cannot recover it.',
          });
          return;
        }
        activateState({ ...current, relay: { ...current.relay, managementToken: token } });
      })
      .catch((error) => {
        setRelayReachable(false);
        setNotice({
          kind: 'bad',
          message: `QBBridge could not read the relay credential from secure storage. ${(error as Error).message}`,
        });
      });
  }, [activateState, state.relay?.baseUrl, state.relay?.tournamentId]);

  const commit = useCallback(
    (
      next: BridgeState | ((current: BridgeState) => BridgeState),
    ): { state: BridgeState; persisted: PersistResult } => {
      const current = stateRef.current;
      const resolved = typeof next === 'function' ? next(current) : next;
      const persisted = saveState(resolved, { secureCredential: true });
      // Every BridgeState transition contains tournament-day working state. A failed ordinary
      // edit is still usable in memory, but it must remain visibly non-durable until a later
      // retry succeeds. The shared flag is deliberately broader than the old critical-only path
      // so room/setup edits cannot disappear silently on restart.
      setPersistenceSavePending(!persisted.ok);
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
      yftFingerprint: string | null,
    ): boolean => {
      const current = stateRef.current;
      const firstRoundId = report.tournament.rounds[0]?.id ?? null;
      let reconciliationReport: PlanReconciliation | null = null;
      let dispositionReport: DispositionReconciliation | null = null;
      if (startNew) {
        const next: BridgeState = {
          ...emptyState(),
          resultFolder: current.resultFolder,
          yftPath: path,
          yftFingerprint,
          tournamentName: report.tournament.name,
          selectedRoundId: firstRoundId,
        };
        const persisted = saveState(next, { secureCredential: true });
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
        invalidateRoundArtifacts();
        activateState(next);
      } else {
        const roundIds = new Set(report.tournament.rounds.map((round) => round.id));
        const teamIds = new Set(report.tournament.teams.map((team) => team.id));
        // Reconciled by stable id only. YellowFruit owns rounds, teams and their identities; the
        // plans are local intent that references them. A referenced id that is gone is gone — a
        // repair by team name, room name, round label, or position would be a guess, and a wrong
        // guess here sends two teams to play a game nobody scheduled.
        commit((currentState) => {
          reconciliationReport = reconcilePlans(currentState.roundPlans, {
            roundIds,
            teamIds,
            roomIds: new Set(currentState.rooms.map((room) => room.id)),
          });
          dispositionReport = reconcileDispositions(currentState.roundDispositions, {
            roundIds,
            teamIds,
          });
          return {
            ...currentState,
            yftPath: path,
            yftFingerprint,
            tournamentName: report.tournament.name,
            roundPlans: reconciliationReport.plans,
            roundDispositions: dispositionReport.dispositions,
            selectedRoundId:
              currentState.selectedRoundId && roundIds.has(currentState.selectedRoundId)
                ? currentState.selectedRoundId
                : firstRoundId,
          };
        });
      }
      setTournament(report.tournament);
      setLoadWarnings(report.warnings);
      invalidateRoundArtifacts();
      const dispositionNote =
        dispositionReport !== null ? describeDispositionReconciliation(dispositionReport) : null;
      const reconciliationNote =
        reconciliationReport !== null && reconciliationChangedAnything(reconciliationReport)
          ? ` ${describeReconciliation(reconciliationReport)}${dispositionNote ? ` ${dispositionNote}` : ''}`
          : dispositionNote
            ? ` ${dispositionNote}`
            : '';
      setNotice({
        kind: reconciliationNote === '' ? 'good' : 'warn',
        message: `${startNew ? 'Started a new QBBridge tournament for' : 'Loaded'} ${report.tournament.name}: ${report.tournament.teams.length} teams, ${report.tournament.playerCount} players.${reconciliationNote}`,
      });
      return true;
    },
    [activateState, commit, invalidateRoundArtifacts],
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
      const differentFile = current.yftPath !== null && path !== null && current.yftPath !== path;
      if (differentFile) {
        pendingFileRef.current = {
          path,
          tournament: report.tournament,
          warnings: report.warnings,
          yftFingerprint: fnv1a64(contents),
        };
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
      applyLoadedFile(path, report, false, fnv1a64(contents));
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
        pending.yftFingerprint,
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
      try {
        await storeRelayCredential(
          relayCredentialKey(connection.baseUrl, connection.tournamentId, 'primary'),
          connection.managementToken,
        );
      } catch (error) {
        // A claim is one-time. Do not activate a credential that cannot be placed in the OS store;
        // retain it only in the existing in-session retry ref and never in a persisted diagnostic.
        pendingRelayClaimRef.current = connection;
        setRelayCredentialSavePending(true);
        setChangingRelay(true);
        setRelayReachable(null);
        setNotice({
          kind: 'bad',
          message: `The relay claim succeeded, but QBBridge could not save the returned management credential in secure storage. Repair secure storage and retry. ${(error as Error).message}`,
        });
        return false;
      }
      const persisted = saveState(next, { secureCredential: true });
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
            'The relay claim succeeded, but QBBridge could not save the returned management credential. The new relay is not active yet; fix local persistence and retry saving the credential.',
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
        const preflight = saveState(stateRef.current, { secureCredential: true });
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
          controllerRole: 'primary',
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

  const provisionBackup = useCallback(async (label: string): Promise<BackupProvisionResult | null> => {
    const connection = connectionOf(stateRef.current);
    if (!connection) {
      setNotice({ kind: 'bad', message: 'Connect a relay before provisioning backup control access.' });
      return null;
    }
    try {
      const provisioned = await relayProvisionBackup(connection, label);
      setNotice({
        kind: 'warn',
        message:
          'Backup control access was provisioned. Create its encrypted recovery package now; the credential is never shown again by QBBridge.',
      });
      return provisioned;
    } catch (error) {
      setNotice({
        kind: 'bad',
        message: `Backup control access was not provisioned. ${(error as Error).message}`,
      });
      return null;
    }
  }, []);

  const rotateBackup = useCallback(async (label?: string): Promise<BackupProvisionResult | null> => {
    const connection = connectionOf(stateRef.current);
    if (!connection) return null;
    try {
      const rotated = await relayRotateBackup(connection, label);
      setNotice({
        kind: 'warn',
        message:
          'The backup controller credential was rotated. Create a new encrypted recovery package before relying on the backup laptop.',
      });
      return rotated;
    } catch (error) {
      setNotice({
        kind: 'bad',
        message: `Backup control access was not rotated. ${(error as Error).message}`,
      });
      return null;
    }
  }, []);

  const revokeBackup = useCallback(async (): Promise<boolean> => {
    const connection = connectionOf(stateRef.current);
    if (!connection) return false;
    try {
      await relayRevokeBackup(connection);
      setNotice({
        kind: 'good',
        message: 'Backup controller access was revoked. Retained results and room access were unchanged.',
      });
      return true;
    } catch (error) {
      setNotice({
        kind: 'bad',
        message: `Backup control access was not revoked. ${(error as Error).message}`,
      });
      return false;
    }
  }, []);

  const createRecoveryPackage = useCallback(
    async (passphrase: string, label = 'Tournament backup controller'): Promise<boolean> => {
      const current = stateRef.current;
      const connection = connectionOf(current);
      if (!connection) {
        setNotice({ kind: 'bad', message: 'Connect a relay before creating a recovery package.' });
        return false;
      }
      setBusy(true);
      let provisioned: BackupProvisionResult | null = null;
      try {
        provisioned = await relayProvisionBackup(connection, label);
        const payload = recoveryPackageState(current, provisioned);
        const contents = await encryptRecoveryPackage(payload, passphrase);
        const path = await writeRecoveryPackage('', recoveryPackageFileName, contents);
        setNotice({
          kind: 'good',
          message: `Encrypted backup control package saved to ${path}. Keep the file and passphrase separate; the package contains no primary credential.`,
        });
        return true;
      } catch (error) {
        if (provisioned) {
          try {
            await relayRevokeBackup(connection);
          } catch {
            setNotice({
              kind: 'bad',
              message:
                'The recovery package could not be written, and the temporary backup credential could not be revoked. Revoke or rotate backup control access before continuing.',
            });
            return false;
          }
        }
        setNotice({
          kind: 'bad',
          message: `The encrypted recovery package was not created. ${(error as Error).message}`,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const importRecoveryPackage = useCallback(
    async (passphrase: string): Promise<boolean> => {
      setBusy(true);
      try {
        const opened = await openRecoveryPackage();
        if (!opened) return false;
        const packageData = await decryptRecoveryPackage(opened.contents, passphrase);
        const imported = packageData.state;
        const connection = connectionOf(imported);
        if (!connection || connection.controllerRole !== 'backup') {
          throw new Error('The recovery package does not contain backup controller access.');
        }
        await storeRelayCredential(
          relayCredentialKey(
            connection.baseUrl,
            connection.tournamentId,
            connection.controllerRole ?? 'backup',
            connection.controllerId ?? '',
          ),
          connection.managementToken,
        );
        const health = await relayHealth(connection);
        const next: BridgeState = {
          ...imported,
          relay: imported.relay
            ? {
                ...imported.relay,
                epoch: health.directorEpoch,
                revision: health.revision,
                controllerRole: 'backup',
              }
            : null,
        };
        const persisted = saveState(next, { secureCredential: true });
        if (!persisted.ok) throw new Error('The imported recovery state could not be saved locally.');
        pollGenerationRef.current += 1;
        readinessKeyRef.current = null;
        pendingRelayClaimRef.current = null;
        setRelayCredentialSavePending(false);
        setPersistenceSavePending(false);
        setTournament(null);
        setLoadWarnings([]);
        setChangingRelay(false);
        setRelayReachable(true);
        activateState(next);
        const readiness = await refreshScorerReadiness(connection);
        setNotice({
          kind: 'good',
          message: `Encrypted recovery package imported for ${connection.tournamentId}. Reload the authoritative .yft, then take over explicitly before publishing. ${readiness.message}`,
        });
        return true;
      } catch (error) {
        setRelayReachable(false);
        setNotice({
          kind: 'bad',
          message: `The recovery package was not imported. ${(error as Error).message}`,
        });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [activateState, refreshScorerReadiness],
  );

  const takeOverRelay = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    const connection = connectionOf(current);
    if (!connection || connection.controllerRole !== 'backup') {
      setNotice({ kind: 'bad', message: 'Import a backup recovery package before taking over.' });
      return false;
    }
    setBusy(true);
    try {
      const takeoverId =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const outcome = await relayTakeover(connection, takeoverId);
      const persisted = commit((stateAtCommit) =>
        stateAtCommit.relay
          ? {
              ...stateAtCommit,
              relay: { ...stateAtCommit.relay, epoch: outcome.directorEpoch, revision: outcome.revision },
            }
          : stateAtCommit,
      ).persisted;
      if (!persisted.ok) {
        setNotice({
          kind: 'bad',
          message:
            'The relay takeover succeeded, but the new epoch could not be saved locally. Keep this window open and retry local persistence before publishing.',
        });
        return false;
      }
      setRelayReachable(true);
      setNotice({
        kind: 'warn',
        message:
          'This backup is now the active relay controller. The old primary is fenced from publishing and acknowledging; reload the .yft and review the recovered room state before publishing the next round.',
      });
      return true;
    } catch (error) {
      setRelayReachable(false);
      setNotice({ kind: 'bad', message: `Relay takeover was not completed. ${(error as Error).message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, [commit]);

  const transferRelayToPrimary = useCallback(async (): Promise<boolean> => {
    const connection = connectionOf(stateRef.current);
    if (!connection) return false;
    setBusy(true);
    try {
      const outcome = await relayTransfer(connection, 'primary');
      commit((current) =>
        current.relay
          ? {
              ...current,
              relay: { ...current.relay, epoch: outcome.directorEpoch, revision: outcome.revision },
            }
          : current,
      );
      setRelayReachable(false);
      setNotice({
        kind: 'warn',
        message:
          'Relay control was transferred to the primary controller. This backup is now read-only; open the primary QBBridge profile before publishing or acknowledging results.',
      });
      return true;
    } catch (error) {
      setNotice({ kind: 'bad', message: `Relay control was not transferred. ${(error as Error).message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, [commit]);

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
  const forgetRelayCredential = useCallback(async () => {
    const existing = stateRef.current.relay;
    if (existing) {
      try {
        await deleteRelayCredential(
          relayCredentialKey(
            existing.baseUrl,
            existing.tournamentId,
            existing.controllerRole ?? 'primary',
            existing.controllerId ?? '',
          ),
        );
      } catch (error) {
        setNotice({
          kind: 'bad',
          message: `QBBridge could not delete the relay credential from secure storage. Nothing was forgotten. ${(error as Error).message}`,
        });
        return;
      }
    }
    pollGenerationRef.current += 1;
    const persisted = commit((current) => ({ ...current, relay: null, scorerReadiness: null })).persisted;
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
    const persisted = saveState(stateRef.current, { secureCredential: true });
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
        // The room is gone, so every round that planned a game in it loses that entry. The relay
        // side of the removal is the tombstone below, which is a different concern and survives.
        roundPlans: removeRoomFromPlans(current.roundPlans, roomId),
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

  /**
   * Choose a team for one side of one room, in the selected round.
   *
   * The edit lands in that round's plan and nowhere else. The room is untouched — it is a physical
   * room and a relay identity, and neither of those changed because a dropdown did.
   */
  const setRoomTeams = useCallback(
    (roomId: string, side: 'left' | 'right', teamId: string | null) =>
      commit((current) =>
        current.selectedRoundId === null
          ? current
          : {
              ...current,
              roundPlans: setPlannedSide(current.roundPlans, current.selectedRoundId, roomId, side, teamId),
            },
      ),
    [commit],
  );

  const regeneratePairingCode = useCallback(
    (roomId: string) =>
      updateRoom(roomId, (room) => ({ ...room, pendingPairingCode: generatePairingCode() })),
    [updateRoom],
  );

  /**
   * Choose the round the pairing table is for.
   *
   * This changes one field and nothing else. It used to clear every room's team selection, because
   * the selections lived on the rooms and there was nowhere else for a round's matchups to be —
   * which made entering a tournament's prelims in advance impossible, and made every round change
   * a destructive action that had to be confirmed.
   *
   * Now each round's matchups are its own persisted plan, so returning to a round shows exactly
   * what was entered for it. The mistake the old clearing existed to prevent — publishing round
   * 4's pairings as round 5 — is prevented instead by `publish()` reading the selected round's own
   * plan, and by the per-room planned-versus-live status in the table.
   */
  const selectRound = useCallback(
    (roundId: string) =>
      commit((current) =>
        current.selectedRoundId === roundId ? current : { ...current, selectedRoundId: roundId },
      ),
    [commit],
  );

  /**
   * State (or clear) one team's bye/inactive disposition in the selected round.
   *
   * The edit lands in that round's disposition entry and nowhere else, mirroring `setRoomTeams`.
   * Assignment stays derived from the pairings — stating a bye never moves a team, it only
   * records that the team is not expected to play.
   */
  const setTeamDisposition = useCallback(
    (teamId: string, kind: TeamDispositionKind | null) =>
      commit((current) =>
        current.selectedRoundId === null
          ? current
          : {
              ...current,
              roundDispositions: setDispositionEntry(
                current.roundDispositions,
                current.selectedRoundId,
                teamId,
                kind,
              ),
            },
      ),
    [commit],
  );

  const dispositionForTeam = useCallback(
    (teamId: string): TeamDispositionKind | null =>
      dispositionFor(stateRef.current.roundDispositions, stateRef.current.selectedRoundId, teamId),
    [],
  );

  /**
   * Apply a successful mirror without activating a code changed while the request was in flight.
   *
   * Relay truth comes from the outcome — the fingerprint of the assignment that was actually
   * sent — never by rebuilding from the current plan, which an in-flight edit may already have
   * moved on from. A failed publish never reaches here, so the previous fingerprint stands.
   */
  const applyPublication = useCallback(
    (
      outcome: PublishOutcome,
      pendingCodes: ReadonlyMap<string, string | null>,
      tombstoneIds: ReadonlySet<string>,
    ) => {
      const byRoom = new Map(outcome.assignments.map((entry) => [entry.roomId, entry]));
      const fingerprints = new Map(
        outcome.assignments.map((entry) => [entry.roomId, assignmentFingerprint(entry.document)]),
      );
      const cleared = new Set(outcome.clearedRoomIds);
      return commit((current) => ({
        ...current,
        relay: current.relay ? { ...current.relay, revision: outcome.revision } : null,
        rooms: current.rooms.map((room) => {
          const wasMirrored = pendingCodes.has(room.id);
          if (!wasMirrored) return room;
          const sentPendingCode = pendingCodes.get(room.id) ?? null;
          const pendingStillCurrent = room.pendingPairingCode === sentPendingCode;
          const published = {
            ...room,
            pairingCode: pendingStillCurrent && sentPendingCode !== null ? sentPendingCode : room.pairingCode,
            pendingPairingCode: pendingStillCurrent ? null : room.pendingPairingCode,
            relayPublished: true,
          };
          const assignment = byRoom.get(room.id);
          if (assignment) {
            return {
              ...published,
              publishedMatchId: assignment.matchId,
              publishedRoundId: assignment.roundId,
              publishedAssignmentFingerprint: fingerprints.get(room.id) ?? null,
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
            publishedAssignmentFingerprint: null,
            assignmentRevision: room.assignmentRevision + 1,
          };
        }),
        pendingRoomRemovals: current.pendingRoomRemovals.filter((room) => !tombstoneIds.has(room.id)),
        retiredRoomIds: [...new Set([...current.retiredRoomIds, ...tombstoneIds])],
      })).persisted;
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
      assignmentFallback?: AssignmentFallback;
      snapshot?: PublicationSnapshot;
    }): Promise<PublishOutcome | null> => {
      const current = stateRef.current;
      const snapshot = input.snapshot ?? publicationSnapshot(current);
      const connection = snapshot.connection;
      if (!connection) {
        setNotice({ kind: 'bad', message: input.missingRelayMessage });
        return null;
      }
      if (
        !sameRelayConnection(connection, connectionOf(current)) ||
        snapshot.revision !== current.relay?.revision
      ) {
        setNotice({
          kind: 'bad',
          message:
            'Round not published because the relay changed after this plan was prepared. Review it again.',
        });
        return null;
      }
      if (input.plan.publications.length === 0) {
        setNotice({ kind: 'bad', message: 'There are no rooms to publish. Add a room first.' });
        return null;
      }
      setBusy(true);
      const pendingCodes = new Map(snapshot.rooms.map((room) => [room.id, room.pendingPairingCode]));
      const tombstoneIds = new Set(snapshot.tombstones.map((room) => room.id));
      try {
        const outcome = await publishRound(connection, {
          epoch: snapshot.epoch,
          lastRevision: snapshot.revision,
          tournamentName: input.tournamentName,
          plan: input.plan,
          rooms: snapshot.rooms,
          tombstones: snapshot.tombstones,
        });
        if (
          !sameRelayConnection(connection, connectionOf(stateRef.current)) ||
          stateRef.current.relay?.revision !== snapshot.revision
        ) {
          setNotice({
            kind: 'bad',
            message: 'The relay changed while this round was publishing. Review the round before retrying.',
          });
          return null;
        }
        const persisted = applyPublication(outcome, pendingCodes, tombstoneIds);
        if (input.assignmentFallback) rememberAssignmentFallback(null);
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
        const fallbackAvailable = input.assignmentFallback && relayUnavailable(error);
        if (fallbackAvailable) rememberAssignmentFallback(input.assignmentFallback!);
        setNotice({
          kind: 'bad',
          message: `${input.failureMessage} ${(error as Error).message}${
            fallbackAvailable
              ? ' Already-open games are safe; export the round assignment files below to keep the tournament moving.'
              : ''
          }`,
        });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [applyPublication, rememberAssignmentFallback],
  );

  const confirmPublicationReview = useCallback(async (): Promise<void> => {
    const review = pendingPublicationReviewRef.current;
    if (!review) return;
    rememberPublicationReview(null);
    await publishPlan({
      plan: review.plan,
      tournamentName: review.tournamentName,
      successKind: review.plan.cleared.length > 0 || review.accountabilityWarningCount > 0 ? 'warn' : 'good',
      successMessage: (outcome) => {
        const clearedNote =
          review.plan.cleared.length > 0
            ? ` ${review.plan.cleared.length} room(s) were cleared and can no longer open a game.`
            : '';
        const overrideNote =
          review.accountabilityWarningCount > 0
            ? ` Published with ${review.accountabilityWarningCount} accountability warning(s) as an explicit exception.`
            : '';
        return `Published round ${review.roundName} to ${outcome.assignments.length} room(s).${clearedNote}${overrideNote}`;
      },
      failureMessage: 'Round not published — the rooms still have whatever they had before.',
      missingRelayMessage: 'Connect the relay before publishing a round.',
      assignmentFallback: {
        tournamentName: review.tournamentName,
        roundId: review.roundId,
        roundName: review.roundName,
        plan: review.plan,
        exportedRoomIds: [],
        exportDirectory: null,
      },
      snapshot: review.snapshot,
    });
  }, [publishPlan, rememberPublicationReview]);

  const cancelPublicationReview = useCallback((): void => {
    if (!pendingPublicationReviewRef.current) return;
    rememberPublicationReview(null);
    setNotice({ kind: 'warn', message: 'Round publication canceled. The room selections are unchanged.' });
  }, [rememberPublicationReview]);

  const publish = useCallback(async () => {
    const current = stateRef.current;
    const round = tournament?.rounds.find((entry) => entry.id === current.selectedRoundId);
    if (!tournament || !round) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file and choose a round first.' });
      return;
    }
    const pairings = pairingsForRound(current.roundPlans, round.id);
    const teamNameForReview = (id: string): string =>
      tournament.teams.find((team) => team.id === id)?.name ?? id;
    // The accountability gate runs before anything is built: a blocked round publishes nothing,
    // and a warned round publishes only through the explicit review below.
    const account = accountRound({
      pairings,
      dispositions: current.roundDispositions,
      roundId: round.id,
      teamIds: new Set(tournament.teams.map((team) => team.id)),
      roomIds: new Set(current.rooms.map((room) => room.id)),
    });
    const gate = roundPublishGate(account, teamNameForReview);
    if (gate.blocks.length > 0) {
      setNotice({
        kind: 'bad',
        message: `Round ${round.displayName} cannot publish: ${gate.blocks.join(' ')}`,
      });
      return;
    }
    const plan = planRound(tournament, round, current.rooms, pairings, current.pendingRoomRemovals);
    const snapshot = publicationSnapshot(current);
    const reviewItems = publicationReviewItems(
      plan,
      [
        ...pairingWarnings(current.rooms, pairings, teamNameForReview),
        ...schedulePairingWarnings(tournament, round, current.rooms, pairings),
      ],
      current.rooms,
      pairings,
      teamNameForReview,
    );
    const accountabilityWarningCount = gate.warnings.length;
    for (const warning of gate.warnings) {
      reviewItems.push({
        roomId: round.id,
        roomName: `Round ${round.displayName}`,
        message: warning,
      });
    }
    // A round with no playable matchup is not a round publication. Keep the explicit room-setup
    // action as the only way to send a clear-only mirror; otherwise a mistaken empty round could
    // silently revoke every room's active assignment.
    if (plan.assignments.length === 0) {
      setNotice({
        kind: 'bad',
        message:
          'No room in this round has two teams chosen. Use “Publish Room Setup” to publish room codes or clear assignments.',
      });
      return;
    }
    const previousFallback = assignmentFallbackRef.current;
    if (
      previousFallback?.roundId === round.id &&
      previousFallback.exportedRoomIds.length > 0 &&
      plan.assignments.length > 0
    ) {
      reviewItems.unshift({
        roomId: plan.assignments[0]?.roomId ?? round.id,
        roomName: plan.assignments[0]?.roomName ?? `Round ${round.displayName}`,
        message:
          'Fallback assignment files for this round were already exported. Publishing the same games to the relay can create two active writers; continue only if no scorer opened those files.',
      });
    }
    const assignmentFallback: AssignmentFallback = {
      tournamentName: tournament.name,
      roundId: round.id,
      roundName: round.displayName,
      plan,
      exportedRoomIds: [],
      exportDirectory: null,
    };
    if (reviewItems.length > 0) {
      rememberPublicationReview({
        tournamentName: tournament.name,
        roundId: round.id,
        roundName: round.displayName,
        plan,
        items: reviewItems,
        snapshot,
        accountabilityWarningCount,
      });
      setNotice({
        kind: 'warn',
        message: `Round ${round.displayName} has ${reviewItems.length} issue(s) to review before publishing.`,
      });
      return;
    }
    rememberPublicationReview(null);
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
      assignmentFallback,
      snapshot,
    });
  }, [publishPlan, rememberPublicationReview, tournament]);

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

  /** Timestamped file stem so every export is exclusive-create without ever replacing a file. */
  const exportStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

  const exportRoundPlan = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!tournament) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file before exporting a round plan.' });
      return false;
    }
    setBusy(true);
    try {
      const folder = await chooseAssignmentFolder();
      if (!folder) {
        setNotice({ kind: 'warn', message: 'Choose an output folder for the round plan.' });
        return false;
      }
      const slug =
        tournament.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'tournament';
      const fileName = `${slug}-round-plans-${exportStamp()}.qbplan.json`;
      const contents = `${JSON.stringify(
        exportPortablePlan({
          tournamentName: tournament.name,
          yftFingerprint: current.yftFingerprint,
          exportedAt: new Date().toISOString(),
          rooms: current.rooms,
          plans: current.roundPlans,
          dispositions: current.roundDispositions,
        }),
        null,
        2,
      )}\n`;
      // A plan carries ids and a fingerprint — no credentials, no pairing codes, no publication
      // state — by construction in `exportPortablePlan`, so a plain file write is the export.
      await writeRoundPackFile(folder, fileName, contents, false);
      setNotice({ kind: 'good', message: `Exported the round plan to ${fileName}.` });
      return true;
    } catch (error) {
      setNotice({ kind: 'bad', message: `The round plan was not exported. ${(error as Error).message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, [tournament]);

  const exportPrelimCsvFile = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!tournament) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file before exporting prelim CSV.' });
      return false;
    }
    setBusy(true);
    try {
      const folder = await chooseAssignmentFolder();
      if (!folder) {
        setNotice({ kind: 'warn', message: 'Choose an output folder for the prelim CSV.' });
        return false;
      }
      const teamNames = new Map(tournament.teams.map((team) => [team.id, team.name]));
      const roomNames = new Map(current.rooms.map((room) => [room.id, room.name]));
      const contents = exportPrelimCsv({
        rounds: tournament.rounds,
        plans: current.roundPlans,
        dispositions: current.roundDispositions,
        roomName: (roomId) => roomNames.get(roomId) ?? roomId,
        teamName: (teamId) => teamNames.get(teamId) ?? teamId,
      });
      const fileName = `prelim-schedule-${exportStamp()}.csv`;
      await writeRoundPackFile(folder, fileName, contents, false);
      setNotice({ kind: 'good', message: `Exported the prelim schedule to ${fileName}.` });
      return true;
    } catch (error) {
      setNotice({ kind: 'bad', message: `The prelim CSV was not exported. ${(error as Error).message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, [tournament]);

  const describePlanDiffProblems = (diff: PlanImportDiff): string => {
    const parts: string[] = [];
    if (diff.unknownRoundIds.length > 0) {
      parts.push(`rounds this setup does not have: ${diff.unknownRoundIds.join(', ')}`);
    }
    if (diff.unknownRoomIds.length > 0) {
      parts.push(
        `rooms this setup does not have: ${diff.unknownRoomIds.map((room) => `${room.name} (${room.id})`).join(', ')}`,
      );
    }
    if (diff.unknownTeamIds.length > 0) {
      parts.push(`teams the loaded file does not have: ${diff.unknownTeamIds.join(', ')}`);
    }
    return `This plan does not fit this setup — ${parts.join('; ')}. Nothing was applied.`;
  };

  /**
   * Open a portable plan or prelim CSV, validate it, and hold the diff for explicit review.
   *
   * Nothing touches local state here: a dirty or mismatched file ends in a notice, and a clean
   * one ends in `pendingPlanImport`, which only `confirmPlanImport` applies.
   */
  const importRoundPlan = useCallback(async (): Promise<void> => {
    if (!tournament) {
      setNotice({ kind: 'bad', message: 'Load a YellowFruit file before importing a plan.' });
      return;
    }
    setBusy(true);
    try {
      const opened = await openRoundPlan();
      if (!opened) return;
      const sourceName = opened.path.split(/[\\/]/).pop() ?? opened.path;
      const firstLine = (opened.contents.split('\n', 1)[0] ?? '').trim().toLowerCase();
      const knownSets = {
        yftFingerprint: stateRef.current.yftFingerprint,
        roundIds: new Set(tournament.rounds.map((round) => round.id)),
        roomIds: new Set(stateRef.current.rooms.map((room) => room.id)),
        teamIds: new Set(tournament.teams.map((team) => team.id)),
      };
      if (opened.path.toLowerCase().endsWith('.csv') || firstLine === 'round,room,left_team,right_team') {
        const teamIdsByName = new Map(tournament.teams.map((team) => [team.name, team.id]));
        const roomIdsByName = new Map(stateRef.current.rooms.map((room) => [room.name, room.id]));
        const roundIdsByName = new Map<string, string[]>();
        for (const round of tournament.rounds) {
          for (const name of [round.displayName, round.qbjName]) {
            roundIdsByName.set(name, [...(roundIdsByName.get(name) ?? []), round.id]);
          }
        }
        const byExactName = (table: Map<string, string>, name: string): string[] => {
          const hit = table.get(name);
          return hit === undefined ? [] : [hit];
        };
        const imported = importPrelimCsv(opened.contents, {
          ...knownSets,
          roundNameToId: (name) => roundIdsByName.get(name) ?? [],
          roomNameToId: (name) => byExactName(roomIdsByName, name),
          teamNameToId: (name) => byExactName(teamIdsByName, name),
        });
        if (!imported.ok) {
          setNotice({ kind: 'bad', message: `${sourceName}: ${imported.error} Nothing was applied.` });
          return;
        }
        const pairingCount = imported.plans.reduce((total, plan) => total + plan.pairings.length, 0);
        const byeCount = imported.dispositions.reduce(
          (total, entry) => total + entry.byes.length + entry.inactive.length,
          0,
        );
        // CSV carries no fingerprint and no room catalog: provenance is unverifiable and room
        // names were resolved strictly at parse time, so the review always says both.
        const csvPlan: PortableRoundPlan = {
          format: 'qbbridge-round-plan',
          formatVersion: 1,
          exportedAt: '',
          yftFingerprint: null,
          tournamentName: '',
          rooms: [],
          rounds: imported.plans.map((plan) => {
            const stated = imported.dispositions.find((entry) => entry.roundId === plan.roundId);
            return {
              roundId: plan.roundId,
              pairings: plan.pairings.map((pairing) => ({
                roomId: pairing.roomId,
                leftTeamId: pairing.leftTeamId,
                rightTeamId: pairing.rightTeamId,
              })),
              byes: stated ? [...stated.byes] : [],
              inactive: stated ? [...stated.inactive] : [],
            };
          }),
        };
        rememberPlanImport({
          sourceName,
          plan: csvPlan,
          diff: {
            fingerprintMatch: false,
            planFingerprint: null,
            currentFingerprint: knownSets.yftFingerprint,
            planTournamentName: '',
            roundCount: imported.plans.length,
            pairingCount,
            byeCount,
            unknownRoundIds: [],
            unknownRoomIds: [],
            unknownTeamIds: [],
            clean: true,
          },
        });
        setNotice({
          kind: 'warn',
          message: `${sourceName} parsed as prelim CSV with no YellowFruit fingerprint. Review the diff before applying.`,
        });
        return;
      }
      const parsed = parsePortablePlan(opened.contents);
      if (!parsed.ok) {
        setNotice({ kind: 'bad', message: `${sourceName}: ${parsed.error} Nothing was applied.` });
        return;
      }
      const diff = diffPortablePlan(parsed.plan, knownSets);
      if (!diff.clean) {
        setNotice({ kind: 'bad', message: `${sourceName}: ${describePlanDiffProblems(diff)}` });
        return;
      }
      rememberPlanImport({ sourceName, plan: parsed.plan, diff });
      setNotice({
        kind: 'warn',
        message: diff.fingerprintMatch
          ? `${sourceName} matches the loaded file: ${diff.roundCount} round(s), ${diff.pairingCount} pairing(s). Review before applying.`
          : `${sourceName} was prepared against DIFFERENT YellowFruit bytes. Review every matchup before applying.`,
      });
    } catch (error) {
      setNotice({ kind: 'bad', message: `The plan was not imported. ${(error as Error).message}` });
    } finally {
      setBusy(false);
    }
  }, [rememberPlanImport, tournament]);

  /**
   * Apply the reviewed import, replacing exactly the rounds the file covers.
   *
   * The plan is re-resolved against current state at confirm time, not trusted from review
   * time: a room removed or a file reloaded between review and confirm must refuse rather than
   * apply against ids that no longer mean what they meant. Whole-round replacement keeps the
   * import an explicit snapshot — a pairing deleted from the plan file disappears locally
   * rather than lingering as a ghost — and rounds the file does not mention are untouched.
   */
  const confirmPlanImport = useCallback((): void => {
    const pending = pendingPlanImportRef.current;
    if (!pending || !tournament) return;
    const current = stateRef.current;
    const applied = applyPortablePlan(pending.plan, {
      yftFingerprint: current.yftFingerprint,
      roundIds: new Set(tournament.rounds.map((round) => round.id)),
      roomIds: new Set(current.rooms.map((room) => room.id)),
      teamIds: new Set(tournament.teams.map((team) => team.id)),
    });
    if (!applied.ok) {
      rememberPlanImport(null);
      setNotice({
        kind: 'bad',
        message: `${pending.sourceName} no longer fits this setup: ${applied.error} Nothing was applied.`,
      });
      return;
    }
    rememberPlanImport(null);
    const replaced = new Set(applied.plans.map((plan) => plan.roundId));
    commit((currentState) => ({
      ...currentState,
      roundPlans: [
        ...currentState.roundPlans.filter((plan) => !replaced.has(plan.roundId)),
        ...applied.plans.filter((plan) => plan.pairings.length > 0),
      ],
      roundDispositions: normalizeRoundDispositions([
        ...currentState.roundDispositions.filter((entry) => !replaced.has(entry.roundId)),
        ...applied.dispositions,
      ]),
    }));
    const provenanceNote = pending.diff.fingerprintMatch
      ? ''
      : ' It was prepared against different YellowFruit bytes — verify every matchup before publishing.';
    setNotice({
      kind: 'good',
      message: `Applied ${applied.plans.length} planned round(s) from ${pending.sourceName}.${provenanceNote}`,
    });
  }, [commit, rememberPlanImport, tournament]);

  const cancelPlanImport = useCallback((): void => {
    if (!pendingPlanImportRef.current) return;
    rememberPlanImport(null);
    setNotice({ kind: 'warn', message: 'Plan import canceled. The saved rounds are unchanged.' });
  }, [rememberPlanImport]);

  const writePackFiles = useCallback(async (pack: EmergencyPack): Promise<boolean> => {
    setBusy(true);
    try {
      const folder = await chooseAssignmentFolder();
      if (!folder) {
        setNotice({ kind: 'warn', message: 'Choose an output folder for the emergency pack.' });
        return false;
      }
      let written = 0;
      const failures: string[] = [];
      for (const file of pack.files) {
        try {
          if (file.kind === 'assignment') {
            await writeAssignmentFile(folder, file.fileName, file.contents);
          } else {
            await writeRoundPackFile(folder, file.fileName, file.contents, file.overwrite);
          }
          written += 1;
        } catch (error) {
          failures.push(`${file.fileName}: ${(error as Error).message}`);
        }
      }
      if (failures.length > 0) {
        setNotice({
          kind: 'bad',
          message: `Wrote ${written} of ${pack.files.length} pack files to ${folder}. ${failures[0]} Choose another folder and retry the rest.`,
        });
        return false;
      }
      setNotice({
        kind: 'good',
        message: `Emergency pack written to ${folder}: ${pack.manifest.totalAssignmentFiles} game(s) plus manifest and README. Pack files are a separate delivery path — never hand one out for a room the relay is serving.`,
      });
      return true;
    } catch (error) {
      setNotice({ kind: 'bad', message: `The emergency pack was not written. ${(error as Error).message}` });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Build the next N rounds' emergency pack from the selected round on.
   *
   * Building is free; writing is fenced. When a pack room is live on the relay, nothing is
   * written until the operator reviews the authority warnings and confirms explicitly.
   */
  const exportEmergencyPack = useCallback(
    async (roundCount: number): Promise<boolean> => {
      const current = stateRef.current;
      if (!tournament) {
        setNotice({ kind: 'bad', message: 'Load a YellowFruit file before exporting a pack.' });
        return false;
      }
      const built = buildEmergencyPack({
        tournament,
        rounds: tournament.rounds,
        startRoundId: current.selectedRoundId,
        roundCount,
        rooms: current.rooms,
        plans: current.roundPlans,
        generatedAt: new Date().toISOString(),
        yftFingerprint: current.yftFingerprint,
      });
      if (!built.ok) {
        setNotice({ kind: 'bad', message: built.errors.join(' ') });
        return false;
      }
      const roundName = (roundId: string): string =>
        tournament.rounds.find((round) => round.id === roundId)?.displayName ?? roundId;
      const warnings = packAuthorityWarnings({ pack: built.pack, rooms: current.rooms, roundName });
      if (warnings.length > 0) {
        rememberPackExport({ pack: built.pack, roundCount, warnings });
        setNotice({
          kind: 'warn',
          message: `${warnings.length} pack room(s) are live on the relay. Review the authority warnings before anything is written.`,
        });
        return false;
      }
      return writePackFiles(built.pack);
    },
    [rememberPackExport, tournament, writePackFiles],
  );

  const confirmPackExport = useCallback(async (): Promise<boolean> => {
    const pending = pendingPackExportRef.current;
    if (!pending) return false;
    rememberPackExport(null);
    return writePackFiles(pending.pack);
  }, [rememberPackExport, writePackFiles]);

  const cancelPackExport = useCallback((): void => {
    if (!pendingPackExportRef.current) return;
    rememberPackExport(null);
    setNotice({ kind: 'warn', message: 'Emergency pack canceled. Nothing was written.' });
  }, [rememberPackExport]);

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
   * Export the exact assignments from a failed round plan for local/USB handoff.
   *
   * This is deliberately a file export rather than a second relay: each document is the same
   * ordinary one-game QBJ that the scorer would have received, with its original match and room
   * identity intact. A partial export remembers the rooms already written so retrying cannot
   * replace a file a scorekeeper may already have opened.
   */
  const exportAssignmentFallback = useCallback(async (): Promise<boolean> => {
    const fallback = assignmentFallbackRef.current;
    if (!fallback) return false;
    setBusy(true);
    try {
      let folder = fallback.exportDirectory;
      if (!folder) {
        folder = await chooseAssignmentFolder();
        if (!folder) {
          setNotice({ kind: 'warn', message: 'Choose an output folder to export the round assignments.' });
          return false;
        }
      }

      let written = 0;
      const failures: string[] = [];
      const exported = new Set(fallback.exportedRoomIds);
      for (const assignment of fallback.plan.assignments) {
        if (exported.has(assignment.roomId)) continue;
        try {
          await writeAssignmentFile(
            folder,
            assignmentFileName(assignment),
            assignmentFileContents(assignment),
          );
          exported.add(assignment.roomId);
          written += 1;
          const next = { ...fallback, exportDirectory: folder, exportedRoomIds: [...exported] };
          assignmentFallbackRef.current = next;
          setAssignmentFallback(next);
        } catch (error) {
          failures.push((error as Error).message);
        }
      }

      const next = { ...fallback, exportDirectory: folder, exportedRoomIds: [...exported] };
      assignmentFallbackRef.current = next;
      setAssignmentFallback(next);
      if (failures.length > 0) {
        setNotice({
          kind: 'bad',
          message: `Exported ${written} of ${fallback.plan.assignments.length} assignment file(s). ${failures[0]} Choose another output folder and retry the remaining files.`,
        });
        return false;
      }
      setNotice({
        kind: 'good',
        message: `Exported ${fallback.plan.assignments.length} assignment file(s) to ${folder}. Open each QBJ in its room's QBSheet Scorer by local handoff or USB. Do not also publish this round to the relay after a scorer opens a fallback file.`,
      });
      return true;
    } catch (error) {
      setNotice({
        kind: 'bad',
        message: `The round assignments were not exported. ${(error as Error).message}`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

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
          row.resultId === entry.resultId
            ? {
                ...row,
                savedPath: path,
                ackPending: true,
                importStatus: row.importStatus === 'imported' ? 'imported' : 'needs-import',
              }
            : row,
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

  const markResultImported = useCallback(
    (resultId: string): void => {
      const entry = stateRef.current.results.find((row) => row.resultId === resultId);
      if (!entry?.savedPath) {
        setNotice({ kind: 'bad', message: 'Save this result before marking it imported.' });
        return;
      }
      const persisted = commit((current) => ({
        ...current,
        results: current.results.map((row) =>
          row.resultId === resultId ? { ...row, importStatus: 'imported' as const } : row,
        ),
      })).persisted;
      setNotice({
        kind: persisted.ok ? 'good' : 'bad',
        message: persisted.ok
          ? 'Marked imported — this is your local confirmation that YellowFruit handled the file.'
          : 'Marked imported for this session, but QBBridge could not save that marker locally. Retry local persistence before restarting.',
      });
    },
    [commit],
  );

  const unmarkResultImported = useCallback(
    (resultId: string): void => {
      const entry = stateRef.current.results.find((row) => row.resultId === resultId);
      if (!entry?.savedPath) return;
      const persisted = commit((current) => ({
        ...current,
        results: current.results.map((row) =>
          row.resultId === resultId ? { ...row, importStatus: 'needs-import' as const } : row,
        ),
      })).persisted;
      setNotice({
        kind: persisted.ok ? 'good' : 'bad',
        message: persisted.ok
          ? 'Import marker removed; this result needs YellowFruit handling again.'
          : 'Import marker removed for this session, but QBBridge could not save that change locally. Retry local persistence before restarting.',
      });
    },
    [commit],
  );

  const resultMatchIds = useMemo(
    () => new Set(state.results.map((entry) => resultMatchId(entry.qbj)).filter(Boolean)),
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

  /** The selected round's pairings. Every plan-aware derivation below starts here. */
  const selectedPairings = useMemo(
    () => pairingsForRound(state.roundPlans, state.selectedRoundId),
    [state.roundPlans, state.selectedRoundId],
  );

  const warnings = useMemo(
    () => pairingWarnings(state.rooms, selectedPairings, teamName),
    [selectedPairings, state.rooms, teamName],
  );

  const plannedTeamsFor = useCallback(
    (roomId: string) => plannedTeams(state.roundPlans, state.selectedRoundId, roomId),
    [state.roundPlans, state.selectedRoundId],
  );

  /**
   * Whether the relay is serving the assignment this room's selected-round plan would build now.
   *
   * Derived every time from relay truth plus the current plan, never stored. Match identity and
   * assignment content are compared separately: a renamed room or an edited roster moves the
   * fingerprint without moving the match id, and must read as `edited` rather than `live`. The
   * case that matters most is `other-round`: while round 1 is live, the room-level status is
   * `waiting` for every room, and without this the operator entering round 5 would see round 5
   * reported as already published.
   */
  const planStatus = useCallback(
    (room: Room): PlanPublicationStatus => {
      if (tournament === null) return 'no-game';
      const round =
        state.selectedRoundId === null
          ? null
          : (tournament.rounds.find((entry) => entry.id === state.selectedRoundId) ?? null);
      const pairing = pairingFor(state.roundPlans, state.selectedRoundId, room.id);
      return planPublicationStatus({
        roundId: state.selectedRoundId,
        room,
        pairing,
        plannedMatchId:
          state.selectedRoundId === null
            ? null
            : plannedMatchId({
                tournamentId: tournament.id,
                roundId: state.selectedRoundId,
                pairing,
              }),
        plannedFingerprint:
          round === null
            ? null
            : plannedAssignmentFingerprint({
                tournament,
                round,
                roomId: room.id,
                roomName: room.name,
                pairing,
              }),
      });
    },
    [state.roundPlans, state.selectedRoundId, tournament],
  );

  const roundProgress = useMemo(
    () => ({
      roundId: state.selectedRoundId,
      assigned: assignedRoomCount(state.roundPlans, state.selectedRoundId),
    }),
    [state.roundPlans, state.selectedRoundId],
  );

  /**
   * The accountability report for the selected round. Null before a file loads — dispositions
   * without the authoritative team list would be a guess about the denominator.
   */
  const roundAccount = useMemo((): RoundAccount | null => {
    if (!tournament) return null;
    return accountRound({
      pairings: pairingsForRound(state.roundPlans, state.selectedRoundId),
      dispositions: state.roundDispositions,
      roundId: state.selectedRoundId,
      teamIds: new Set(tournament.teams.map((team) => team.id)),
      roomIds: new Set(state.rooms.map((room) => room.id)),
    });
  }, [tournament, state.roundPlans, state.roundDispositions, state.selectedRoundId, state.rooms]);

  /**
   * Assignment counts for the rounds beside this one, so setup completeness is visible at a glance.
   *
   * Scoped to the selected round's phase rather than the whole file: eleven prelim rounds is a list
   * an operator reads, and every round of a three-phase tournament is not.
   */
  const phaseRoundProgress = useMemo(() => {
    if (!tournament) return [];
    const selected = tournament.rounds.find((round) => round.id === state.selectedRoundId);
    if (!selected) return [];
    return tournament.rounds
      .filter((round) => round.phaseId === selected.phaseId)
      .map((round) => ({
        roundId: round.id,
        displayName: round.displayName,
        assigned: assignedRoomCount(state.roundPlans, round.id),
      }));
  }, [state.roundPlans, state.selectedRoundId, tournament]);

  /**
   * The one place the relay's unacknowledged window is surfaced.
   *
   * Saved results leave that window, so it can only fill with results nobody has written to
   * disk. Past the threshold the operator is told plainly, because the failure beyond it is
   * silent: the relay would keep accepting finals and stop showing them.
   */
  const unsavedCount = state.results.filter((entry) => !entry.savedPath || entry.ackPending).length;
  const needsImportCount = state.results.filter(
    (entry) => resultImportStatus(entry) === 'needs-import',
  ).length;
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
    importRecoveryPackage,
    createRecoveryPackage,
    provisionBackup,
    rotateBackup,
    revokeBackup,
    takeOverRelay,
    transferRelayToPrimary,
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
    plannedTeamsFor,
    planStatus,
    roundProgress,
    phaseRoundProgress,
    regeneratePairingCode,
    selectRound,
    setTeamDisposition,
    dispositionForTeam,
    roundAccount,
    exportRoundPlan,
    exportPrelimCsvFile,
    importRoundPlan,
    pendingPlanImport,
    confirmPlanImport,
    cancelPlanImport,
    exportEmergencyPack,
    pendingPackExport,
    confirmPackExport,
    cancelPackExport,
    publish,
    pendingPublicationReview,
    confirmPublicationReview,
    cancelPublicationReview,
    assignmentFallback,
    exportAssignmentFallback,
    publishRoomSetup,
    roomStatus,
    warnings,
    chooseFolder,
    saveNewResults,
    saveResult,
    markResultImported,
    unmarkResultImported,
    needsImportCount,
    resultBusy,
    savingResults: savingBatch || savingResultIds.size > 0,
    pollResults,
    unsavedResultWarning,
  };
}
