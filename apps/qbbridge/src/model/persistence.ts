/**
 * Everything QBBridge remembers, in one `localStorage` key.
 *
 * # Why not a database
 *
 * The state is a few kilobytes and it belongs to one operator on one machine for one day. A
 * SQLite file in the Tauri layer would mean a schema, a migration path, a store module and four
 * more commands, all to hold what a JSON blob holds. `localStorage` in the desktop webview
 * persists across restarts, is synchronous, and needs no native code at all.
 *
 * # What is and is not in here
 *
 * The relay management credential is present in memory while the native bridge is running. A
 * native save omits it after it moves to the operating system's secure store; a profile restored
 * before that asynchronous load therefore has relay metadata but no bearer and cannot publish.
 * Everything a relay credential must never enter — a QBJ file, a mirror body, a pairing link, or a
 * QR code — it still never enters.
 *
 * The loaded tournament is not. It is reread from the `.yft`, which is the authority.
 */

import type { Room, RoomTombstone } from './rooms';
import { dedupeRoundPlans } from './roundPlans';
import type { PlannedPairing, RoundPlan } from './roundPlans';
import { scoresheetOrigin } from '../../../../src/director/relay/relayConfig';

/**
 * The one key, unchanged across schema versions.
 *
 * The version lives *inside* the value, not in the key. Bumping the key would be a silent data
 * loss dressed as a migration: the old value would sit in local storage forever while QBBridge
 * started empty, taking the relay management credential, the active pairing codes, and any unsaved
 * result with it.
 */
export const storageKey = 'qbbridge.state.v1';

/** The current schema version. See `migrateV1`. */
export const currentStateVersion = 2;

export interface StoredResult {
  resultId: string;
  /** The exact QBJ the relay returned. Never rewritten, only stored and written out. */
  qbj: unknown;
  receivedAt: string;
  /** The path written, once a save succeeded. Absent means unsaved. */
  savedPath?: string;
  /** True after the file is on disk, until the relay confirms the result was acknowledged. */
  ackPending?: boolean;
  /** An operator's local handoff marker; this is never inferred from relay state. */
  importStatus?: 'needs-import' | 'imported';
}

/** The last persisted result of the fixed ordinary Scorer-origin check. */
export interface ScorerReadinessSnapshot {
  status: 'ready' | 'blocked' | 'unknown';
  origin: typeof scoresheetOrigin;
  message: string;
  checkedAt: string;
}

export interface BridgeState {
  version: 2;
  relay: {
    baseUrl: string;
    tournamentId: string;
    /** Present in memory; omitted from secure localStorage saves until restored from the keychain. */
    managementToken?: string;
    /**
     * Bumped once per app installation's lifetime of this tournament, and otherwise left alone.
     *
     * The relay fences a mirror on `(director_epoch, revision)`. One operator on one machine
     * needs no epoch changes; the field exists so that a stale-mirror refusal is reported rather
     * than worked around.
     */
    epoch: number;
    /** The last mirror revision the relay accepted. The next publish is this plus one. */
    revision: number;
    /** Which independently provisioned controller this local profile uses. */
    controllerRole?: 'primary' | 'backup';
    controllerId?: string;
    controllerLabel?: string;
  } | null;
  /** Last Scorer-origin check; a new app session rechecks it before showing pairing as ready. */
  scorerReadiness: ScorerReadinessSnapshot | null;
  /** Where the `.yft` was last read from, so the panel can name it after a restart. */
  yftPath: string | null;
  tournamentName: string | null;
  rooms: Room[];
  /** Rooms removed locally whose assignments still need a clear publication. */
  pendingRoomRemovals: RoomTombstone[];
  /** Room ids that must never be reused after their relay identity was retired locally. */
  retiredRoomIds: string[];
  /** The round selected in the pairing table. A `Round.id` from the loaded file. */
  selectedRoundId: string | null;
  /**
   * What the operator intends to run, per round. Local planning data; see `roundPlans.ts`.
   *
   * Sparse in both directions: a round with nothing entered has no entry, and a round's plan lists
   * only the rooms with a side chosen. Changing the selected round never touches this.
   */
  roundPlans: RoundPlan[];
  resultFolder: string | null;
  results: StoredResult[];
  /**
   * A mirror publication sent (or about to be sent) without a confirmed receipt. Written before
   * the PUT and cleared by its definitive outcome, so a crash or restart can reconcile the
   * indeterminate operation against the relay instead of guessing. Never includes pairing
   * codes or credentials — only the position and key needed to recognize the publication.
   */
  pendingPublication: PendingPublication | null;
}

/** A publication whose receipt is unconfirmed. See `BridgeState.pendingPublication`. */
export interface PendingPublication {
  epoch: number;
  revision: number;
  /** The idempotency key the PUT carries, for comparison with the relay's stored key. */
  key: string;
  /** Operator-facing description of what was attempted, for recovery notices. */
  roundName: string | null;
  roomIds: string[];
}

export type PersistResult = { ok: true } | { ok: false; error: unknown };

export function emptyState(): BridgeState {
  return {
    version: currentStateVersion,
    relay: null,
    scorerReadiness: null,
    yftPath: null,
    tournamentName: null,
    rooms: [],
    pendingRoomRemovals: [],
    retiredRoomIds: [],
    selectedRoundId: null,
    roundPlans: [],
    resultFolder: null,
    results: [],
    pendingPublication: null,
  };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one persisted room, keeping only the fields a room is allowed to have.
 *
 * Built field by field rather than by spreading the stored object. A v1 room carried
 * `leftTeamId`/`rightTeamId`, and a spread would carry them straight back into a v2 `Room` where
 * nothing reads them and nothing clears them — a stale matchup riding along under a type that says
 * it does not exist. See `migrateV1` for where those two values actually go.
 */
function normalizeRoom(value: unknown): Room | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  if (typeof value.pairingCode !== 'string') return null;
  const publishedMatchId = typeof value.publishedMatchId === 'string' ? value.publishedMatchId : null;
  const assignmentRevision =
    typeof value.assignmentRevision === 'number' && Number.isInteger(value.assignmentRevision)
      ? value.assignmentRevision
      : 0;
  return {
    id: value.id,
    name: value.name,
    pairingCode: value.pairingCode,
    pendingPairingCode: typeof value.pendingPairingCode === 'string' ? value.pendingPairingCode : null,
    relayPublished:
      typeof value.relayPublished === 'boolean'
        ? value.relayPublished
        : publishedMatchId !== null || assignmentRevision > 0,
    publishedMatchId,
    publishedRoundId: typeof value.publishedRoundId === 'string' ? value.publishedRoundId : null,
    // States written before the fingerprint existed restore as null, which reads as `edited`
    // rather than `live` until the next successful publish records what the relay accepted.
    publishedAssignmentFingerprint:
      typeof value.publishedAssignmentFingerprint === 'string' ? value.publishedAssignmentFingerprint : null,
    assignmentRevision,
  };
}

/** The legacy matchup a v1 room carried, if it had one. Only `migrateV1` looks at this. */
function legacyTeams(value: unknown): { leftTeamId: string | null; rightTeamId: string | null } {
  if (!isRecord(value)) return { leftTeamId: null, rightTeamId: null };
  return {
    leftTeamId: typeof value.leftTeamId === 'string' && value.leftTeamId !== '' ? value.leftTeamId : null,
    rightTeamId: typeof value.rightTeamId === 'string' && value.rightTeamId !== '' ? value.rightTeamId : null,
  };
}

/**
 * Read the persisted plans into the canonical shape the UI and publisher share.
 *
 * Parsing is lenient field by field, but duplicates are not passed through: see
 * `dedupeRoundPlans`. Persisted state is a trust boundary, and two entries for one room must
 * never reach one consumer as first-wins and another as last-wins.
 */
function normalizeRoundPlans(value: unknown): RoundPlan[] {
  if (!Array.isArray(value)) return [];
  const plans: RoundPlan[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.roundId !== 'string' || !Array.isArray(entry.pairings)) {
      continue;
    }
    const pairings: PlannedPairing[] = [];
    for (const pairing of entry.pairings) {
      if (!isRecord(pairing) || typeof pairing.roomId !== 'string') continue;
      const leftTeamId = typeof pairing.leftTeamId === 'string' ? pairing.leftTeamId : null;
      const rightTeamId = typeof pairing.rightTeamId === 'string' ? pairing.rightTeamId : null;
      // Sparse means sparse: a stored row of two nulls is dropped rather than restored.
      if (leftTeamId === null && rightTeamId === null) continue;
      pairings.push({ roomId: pairing.roomId, leftTeamId, rightTeamId });
    }
    if (pairings.length > 0) plans.push({ roundId: entry.roundId, pairings });
  }
  return dedupeRoundPlans(plans);
}

function normalizeTombstone(value: unknown): RoomTombstone | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.pairingCode !== 'string'
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    pairingCode: value.pairingCode,
    pendingPairingCode: null,
    assignmentRevision:
      typeof value.assignmentRevision === 'number' && Number.isInteger(value.assignmentRevision)
        ? value.assignmentRevision
        : 0,
  };
}

function readScorerReadiness(value: unknown): ScorerReadinessSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    (record.status !== 'ready' && record.status !== 'blocked' && record.status !== 'unknown') ||
    record.origin !== scoresheetOrigin ||
    typeof record.message !== 'string' ||
    typeof record.checkedAt !== 'string'
  ) {
    return null;
  }
  return {
    status: record.status,
    origin: scoresheetOrigin,
    message: record.message,
    checkedAt: record.checkedAt,
  };
}

/**
 * Read the saved state.
 *
 * A state that will not parse is replaced rather than repaired: this holds a morning's setup, not
 * a tournament's results, and asking the operator to add three rooms again is a better failure
 * than starting from something half-understood. Unsaved results are the one thing that would hurt
 * to lose, and they also live on the relay. A saved result keeps a pending-ack bit here so a failed
 * acknowledgment can be retried after a restart.
 */
function restoreResults(value: unknown): StoredResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry as StoredResult;
    const result = entry as StoredResult;
    // States written by the first QBBridge build only had savedPath. Treat those saves as pending;
    // the relay ACK is idempotent, so retrying is safer than silently losing the knowledge.
    const withAck =
      result.savedPath !== undefined && result.ackPending === undefined
        ? { ...result, ackPending: true }
        : result;
    // Older builds stopped at "Saved". A saved file needs an explicit operator handoff marker;
    // never infer that YellowFruit imported it.
    if (withAck.savedPath === undefined) {
      const unsaved = { ...withAck };
      delete unsaved.importStatus;
      return unsaved;
    }
    return {
      ...withAck,
      importStatus: withAck.importStatus === 'imported' ? 'imported' : 'needs-import',
    };
  });
}

/**
 * Bring a version 1 state forward.
 *
 * v1 rooms held the currently selected round's matchup directly. v2 keeps rooms physical and moves
 * intent into `roundPlans`, so the migration has exactly one interesting job: the matchups sitting
 * on the rooms belong to `selectedRoundId`, and they become that round's plan.
 *
 * Everything else is preserved verbatim and deliberately. What is in a live v1 state is a relay
 * management credential, active pairing codes, the mirror revision the relay has fenced on,
 * publication state per room, tombstones for rooms already cleared, and results that may not yet
 * be written to disk. Losing any of it is not a cosmetic regression: losing the credential locks
 * the operator out of their own relay, losing the revision makes the next mirror stale-refuse, and
 * losing a result loses a game. So this migration adds a field and moves two, and touches nothing
 * else.
 *
 * A v1 state with no `selectedRoundId` yields no plan. There is no round to attribute those
 * selections to, and inventing one — the first round of the file, say — would be guessing which
 * round the operator was about to publish.
 */
export function migrateV1(state: Partial<BridgeState> & Record<string, unknown>): BridgeState {
  const storedRooms = Array.isArray(state.rooms) ? state.rooms : [];
  const rooms = storedRooms.map(normalizeRoom).filter((room): room is Room => room !== null);
  const pendingRoomRemovals = Array.isArray(state.pendingRoomRemovals)
    ? state.pendingRoomRemovals.map(normalizeTombstone).filter((room): room is RoomTombstone => room !== null)
    : [];
  const retiredRoomIds = Array.isArray(state.retiredRoomIds)
    ? state.retiredRoomIds.filter((id): id is string => typeof id === 'string')
    : [];
  const selectedRoundId = typeof state.selectedRoundId === 'string' ? state.selectedRoundId : null;

  const pairings: PlannedPairing[] = [];
  if (selectedRoundId !== null) {
    for (const stored of storedRooms) {
      const room = normalizeRoom(stored);
      if (room === null) continue;
      const { leftTeamId, rightTeamId } = legacyTeams(stored);
      if (leftTeamId === null && rightTeamId === null) continue;
      pairings.push({ roomId: room.id, leftTeamId, rightTeamId });
    }
  }

  return {
    version: currentStateVersion,
    relay: state.relay ?? null,
    scorerReadiness: readScorerReadiness(state.scorerReadiness),
    yftPath: typeof state.yftPath === 'string' ? state.yftPath : null,
    tournamentName: typeof state.tournamentName === 'string' ? state.tournamentName : null,
    rooms,
    pendingRoomRemovals,
    retiredRoomIds,
    selectedRoundId,
    roundPlans: dedupeRoundPlans(
      selectedRoundId !== null && pairings.length > 0 ? [{ roundId: selectedRoundId, pairings }] : [],
    ),
    resultFolder: typeof state.resultFolder === 'string' ? state.resultFolder : null,
    results: restoreResults(state.results),
    pendingPublication: readPendingPublication(state.pendingPublication),
  };
}

/** Read an untrusted pending-publication record; anything malformed is no record at all. */
export function readPendingPublication(value: unknown): PendingPublication | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { epoch, revision, key, roundName, roomIds } = record;
  if (
    typeof epoch !== 'number' ||
    !Number.isInteger(epoch) ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    typeof key !== 'string' ||
    key === '' ||
    (roundName !== null && roundName !== undefined && typeof roundName !== 'string') ||
    !Array.isArray(roomIds) ||
    !roomIds.every((entry): entry is string => typeof entry === 'string')
  ) {
    return null;
  }
  return {
    epoch,
    revision,
    key,
    roundName: typeof roundName === 'string' ? roundName : null,
    roomIds: [...roomIds],
  };
}

/** Read a version 2 state, normalizing every field the same way the migration does. */
function readV2(state: Partial<BridgeState> & Record<string, unknown>): BridgeState {
  const migrated = migrateV1(state);
  return { ...migrated, roundPlans: normalizeRoundPlans(state.roundPlans) };
}

export function loadState(): BridgeState {
  const store = storage();
  if (!store) return emptyState();
  let raw: string | null;
  try {
    raw = store.getItem(storageKey);
  } catch {
    return emptyState();
  }
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeState(parsed) ?? emptyState();
  } catch {
    return emptyState();
  }
}

/** Normalize an untrusted serialized state before it reaches the Bridge UI. */
export function normalizeState(value: unknown): BridgeState | null {
  if (!isRecord(value)) return null;
  const state = value as Partial<BridgeState> & Record<string, unknown>;
  // Exactly the two versions this build understands. A version from the future is not
  // downgraded — guessing at a shape a later build wrote is how a credential gets dropped.
  if (state.version === 2) return readV2(state);
  if (state.version === 1) return migrateV1(state);
  return null;
}

export interface SaveStateOptions {
  /** Omit the bearer credential from the localStorage blob after it has moved to OS secure storage. */
  secureCredential?: boolean;
}

function stateForStorage(state: BridgeState, options: SaveStateOptions): BridgeState {
  if (!options.secureCredential || !state.relay) return state;
  const relay: Record<string, unknown> = { ...state.relay };
  delete relay.managementToken;
  return { ...state, relay: relay as BridgeState['relay'] };
}

export function saveState(state: BridgeState, options: SaveStateOptions = {}): PersistResult {
  const store = storage();
  if (!store) return { ok: false, error: new Error('local storage is unavailable') };
  try {
    const serialized = JSON.stringify(stateForStorage(state, options));
    store.setItem(storageKey, serialized);
    if (store.getItem(storageKey) !== serialized) {
      return { ok: false, error: new Error('local storage did not retain the saved state') };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function clearState(): void {
  try {
    storage()?.removeItem(storageKey);
  } catch {
    // Forgetting the local copy is best effort; the caller has already deliberately discarded it
    // from the in-memory state.
  }
}
