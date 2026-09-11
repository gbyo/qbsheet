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
 * The relay management credential is. That is a deliberate, narrow choice: a keychain abstraction,
 * an export workflow and a lost-credential recovery flow are the kind of machinery this
 * application is supposed not to have, and the credential authorizes one tournament on a relay the
 * operator deployed themselves. Everything a relay credential must never enter — a QBJ file, a
 * mirror body, a pairing link, a QR code — it still never enters.
 *
 * The loaded tournament is not. It is reread from the `.yft`, which is the authority.
 */

import type { Room, RoomTombstone } from './rooms';

export const storageKey = 'qbbridge.state.v1';

export interface StoredResult {
  resultId: string;
  /** The exact QBJ the relay returned. Never rewritten, only stored and written out. */
  qbj: unknown;
  receivedAt: string;
  /** The path written, once a save succeeded. Absent means unsaved. */
  savedPath?: string;
}

export interface BridgeState {
  version: 1;
  relay: {
    baseUrl: string;
    tournamentId: string;
    managementToken: string;
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
  } | null;
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
  resultFolder: string | null;
  results: StoredResult[];
}

export function emptyState(): BridgeState {
  return {
    version: 1,
    relay: null,
    yftPath: null,
    tournamentName: null,
    rooms: [],
    pendingRoomRemovals: [],
    retiredRoomIds: [],
    selectedRoundId: null,
    resultFolder: null,
    results: [],
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

function normalizeRoom(value: unknown): Room | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  if (typeof value.pairingCode !== 'string') return null;
  const publishedMatchId = typeof value.publishedMatchId === 'string' ? value.publishedMatchId : null;
  const assignmentRevision =
    typeof value.assignmentRevision === 'number' && Number.isInteger(value.assignmentRevision)
      ? value.assignmentRevision
      : 0;
  return {
    ...(value as unknown as Room),
    pairingCode: value.pairingCode,
    pendingPairingCode: typeof value.pendingPairingCode === 'string' ? value.pendingPairingCode : null,
    relayPublished:
      typeof value.relayPublished === 'boolean'
        ? value.relayPublished
        : publishedMatchId !== null || assignmentRevision > 0,
    publishedMatchId,
    publishedRoundId: typeof value.publishedRoundId === 'string' ? value.publishedRoundId : null,
    assignmentRevision,
  };
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

/**
 * Read the saved state.
 *
 * A state that will not parse is replaced rather than repaired: this holds a morning's setup, not
 * a tournament's results, and asking the operator to add three rooms again is a better failure
 * than starting from something half-understood. Unsaved results are the one thing that would hurt
 * to lose, and they also live on the relay, which is why nothing here acknowledges them.
 */
export function loadState(): BridgeState {
  const store = storage();
  if (!store) return emptyState();
  const raw = store.getItem(storageKey);
  if (!raw) return emptyState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    const state = parsed as Partial<BridgeState>;
    if (state.version !== 1) return emptyState();
    const rooms = Array.isArray(state.rooms)
      ? state.rooms.map(normalizeRoom).filter((room): room is Room => room !== null)
      : [];
    const pendingRoomRemovals = Array.isArray(state.pendingRoomRemovals)
      ? state.pendingRoomRemovals
          .map(normalizeTombstone)
          .filter((room): room is RoomTombstone => room !== null)
      : [];
    const retiredRoomIds = Array.isArray(state.retiredRoomIds)
      ? state.retiredRoomIds.filter((id): id is string => typeof id === 'string')
      : [];
    return {
      version: 1,
      relay: state.relay ?? null,
      yftPath: state.yftPath ?? null,
      tournamentName: state.tournamentName ?? null,
      rooms,
      pendingRoomRemovals,
      retiredRoomIds,
      selectedRoundId: state.selectedRoundId ?? null,
      resultFolder: state.resultFolder ?? null,
      results: Array.isArray(state.results) ? state.results : [],
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: BridgeState): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey, JSON.stringify(state));
  } catch {
    // A full or disabled store is not worth interrupting a round for. The relay still holds every
    // result, and the operator can save them before restarting.
  }
}

export function clearState(): void {
  storage()?.removeItem(storageKey);
}
