/**
 * Encrypted QBBridge backup-controller packages.
 *
 * The package is an explicit, operator-created handoff. Its outer JSON contains only the
 * algorithm parameters; relay identity, the backup credential, room pairing codes, plans and
 * result bookkeeping are authenticated ciphertext. It is therefore safe to move as a file only
 * when the operator also moves the recovery passphrase through a separate channel.
 */

import { normalizeState, type BridgeState } from './persistence';
import { fnv1a64 } from '../../../../src/director/transfers/canonical';
import { isRelayTournamentId, normalizeRelayBaseUrl } from '../../../../src/director/relay/relayConfig';

const packageFormat = 'qbsheet-bridge-recovery';
const packageVersion = 1;
const kdfIterations = 210_000;
const aad = 'qbsheet-bridge-recovery-v1';

export const recoveryPackageFileName = 'qbsheet-recovery.qbr';

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

export interface BackupCredential {
  managementToken: string;
  controllerId: string;
  label: string;
}

export interface RecoveryPackageState {
  kind: typeof packageFormat;
  version: typeof packageVersion;
  createdAt: string;
  /**
   * Identity hash of the `.yft` bytes the primary had loaded when the package was created, or
   * null when no file was loaded or the package predates fingerprinting. The backup must be
   * holding these exact bytes before its first publication — see the publish gate.
   */
  sourceYftFingerprint: string | null;
  /**
   * Content digests of the state captured above, so the primary can say *what* moved since the
   * package was created, and so an old package can never be mistaken for a fresh one. Null when
   * the package predates digests; the state snapshot itself remains the fallback.
   */
  digests: RecoveryDigests | null;
  state: BridgeState;
}

/**
 * What a freshness comparison watches. Identity and codes are separate digests on purpose: a
 * regenerated pairing code must not read as a rebuilt room list, and a renamed room must not
 * hide behind unchanged codes. Order-insensitive by construction (sorted before hashing), so
 * only content moves the needle.
 */
export interface RecoveryDigests {
  roomIdentity: string;
  pairingCodes: string;
  plans: string;
  results: string;
}

/**
 * The primary's baseline: what the world looked like when its current package was created.
 * Compared against live state by `describeRecoveryFreshness`.
 */
export interface RecoveryBaseline {
  createdAt: string;
  yftFingerprint: string | null;
  digests: RecoveryDigests;
  relayEpoch: number;
  relayRevision: number;
}

/** Provenance a backup carries after importing a package, until it proves its own state fresh. */
export interface RecoveryProvenance {
  createdAt: string;
  yftFingerprint: string | null;
  packageRelayEpoch: number;
  packageRelayRevision: number;
}

/**
 * Import provenance as kept in BridgeState. `verified` turns true only when the loaded `.yft`
 * bytes hash exactly to the package's source fingerprint — the key that unlocks publication.
 */
export interface RecoverySource extends RecoveryProvenance {
  verified: boolean;
}

/**
 * Identity hash over `.yft` file bytes. A synchronous FNV-1a 64-bit hash, deliberately: this
 * answers "is this the same file?" at load time on a synchronous path, not "can anyone forge
 * this file?" — and it matches the change-detection hashing the result ledger already uses.
 */
export function yftFingerprint(contents: string): string {
  return fnv1a64(contents);
}

/** Content digests of the state a package would capture. Pure and synchronous. */
export function recoveryDigests(state: BridgeState): RecoveryDigests {
  const roomIds = [...state.rooms].map((room) => room.id).sort();
  const byId = new Map(state.rooms.map((room) => [room.id, room]));
  const tombstones = [...state.pendingRoomRemovals].map((room) => room.id).sort();
  const plans = [...state.roundPlans]
    .map((plan) => ({
      roundId: plan.roundId,
      pairings: [...plan.pairings]
        .map((pairing) => [pairing.roomId, pairing.leftTeamId, pairing.rightTeamId])
        .sort(),
    }))
    .sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
  // Identity plus every operational field recovery restores: a package created before a
  // result was ACKed, marked imported, or saved must read as stale, not current.
  const results = [...state.results]
    .map((entry) => [
      entry.resultId,
      entry.savedPath ?? null,
      entry.ackPending ?? null,
      entry.importStatus ?? null,
    ])
    .sort();
  return {
    roomIdentity: fnv1a64(JSON.stringify([roomIds.map((id) => [id, byId.get(id)?.name ?? '']), tombstones])),
    pairingCodes: fnv1a64(
      JSON.stringify(
        roomIds.map((id) => [id, byId.get(id)?.pairingCode ?? '', byId.get(id)?.pendingPairingCode ?? null]),
      ),
    ),
    plans: fnv1a64(JSON.stringify(plans)),
    results: fnv1a64(JSON.stringify(results)),
  };
}

export interface RecoveryFreshness {
  createdAt: string;
  /** Milliseconds since the package was created. Never negative; unparseable dates read as 0. */
  ageMs: number;
  /** Which categories moved since the package was created. */
  changed: {
    rooms: boolean;
    codes: boolean;
    plans: boolean;
    yft: boolean;
    relay: boolean;
    results: boolean;
  };
  /** True when any category moved. */
  stale: boolean;
  baselineRelay: { epoch: number; revision: number };
  currentRelay: { epoch: number; revision: number };
}

/**
 * Compare live state against the baseline recorded at package creation.
 *
 * Null when the primary has no package baseline to compare against — no package, no opinion.
 * Every comparison is exact-equality on digests or positions; nothing here guesses whether a
 * change matters, it only names what moved so the operator can decide before play.
 */
export function describeRecoveryFreshness(
  state: BridgeState,
  nowMs: number = Date.now(),
): RecoveryFreshness | null {
  const baseline = state.lastRecoveryPackage;
  if (!baseline) return null;
  const live = recoveryDigests(state);
  const createdMs = Date.parse(baseline.createdAt);
  const relay = state.relay;
  const changed = {
    rooms: live.roomIdentity !== baseline.digests.roomIdentity,
    codes: live.pairingCodes !== baseline.digests.pairingCodes,
    plans: live.plans !== baseline.digests.plans,
    yft: (state.yftFingerprint ?? null) !== baseline.yftFingerprint,
    relay: !relay || relay.epoch !== baseline.relayEpoch || relay.revision !== baseline.relayRevision,
    results: live.results !== baseline.digests.results,
  };
  return {
    createdAt: baseline.createdAt,
    ageMs: Number.isNaN(createdMs) ? 0 : Math.max(0, nowMs - createdMs),
    changed,
    stale: Object.values(changed).some(Boolean),
    baselineRelay: { epoch: baseline.relayEpoch, revision: baseline.relayRevision },
    currentRelay: { epoch: relay?.epoch ?? baseline.relayEpoch, revision: relay?.revision ?? 0 },
  };
}

interface RecoveryEnvelope {
  format: typeof packageFormat;
  version: typeof packageVersion;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number };
  cipher: { name: 'AES-GCM'; iv: string };
  salt: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error('The recovery package is not valid base64.');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function requirePassphrase(passphrase: string): void {
  if (passphrase.trim().length < 12) {
    throw new Error('Use a recovery passphrase of at least 12 characters.');
  }
}

async function encryptionKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: arrayBuffer(salt), iterations: kdfIterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Build the encrypted payload with the backup credential, never the primary credential. */
export function recoveryPackageState(state: BridgeState, backup: BackupCredential): RecoveryPackageState {
  if (!state.relay) throw new Error('Connect a relay before creating a recovery package.');
  const relay = {
    ...state.relay,
    managementToken: backup.managementToken,
    controllerId: backup.controllerId,
    controllerRole: 'backup' as const,
    controllerLabel: backup.label,
  };
  return {
    kind: packageFormat,
    version: packageVersion,
    createdAt: new Date().toISOString(),
    sourceYftFingerprint: state.yftFingerprint ?? null,
    digests: recoveryDigests(state),
    state: { ...state, relay },
  };
}

/** Encrypt and authenticate a recovery package using an operator-provided passphrase. */
export async function encryptRecoveryPackage(
  payload: RecoveryPackageState,
  passphrase: string,
): Promise<string> {
  requirePassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: arrayBuffer(iv), additionalData: new TextEncoder().encode(aad) },
    key,
    plaintext,
  );
  const envelope: RecoveryEnvelope = {
    format: packageFormat,
    version: packageVersion,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdfIterations },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    salt: bytesToBase64(salt),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDigestString(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

/**
 * Read package digests leniently: a package that predates them yields null, never an error.
 * Exported for persisted-state normalization, which applies the same rule to its baseline.
 */
export function readRecoveryDigests(value: unknown): RecoveryDigests | null {
  if (!isRecord(value)) return null;
  if (
    !isDigestString(value.roomIdentity) ||
    !isDigestString(value.pairingCodes) ||
    !isDigestString(value.plans) ||
    !isDigestString(value.results)
  ) {
    return null;
  }
  return {
    roomIdentity: value.roomIdentity,
    pairingCodes: value.pairingCodes,
    plans: value.plans,
    results: value.results,
  };
}

/** Decrypt and minimally validate an untrusted package before it reaches BridgeState. */
export async function decryptRecoveryPackage(
  contents: string,
  passphrase: string,
): Promise<RecoveryPackageState> {
  requirePassphrase(passphrase);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('The recovery package is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.format !== packageFormat || parsed.version !== packageVersion) {
    throw new Error('That file is not a supported QBSheet recovery package.');
  }
  const kdf = isRecord(parsed.kdf) ? parsed.kdf : null;
  const cipher = isRecord(parsed.cipher) ? parsed.cipher : null;
  if (
    !kdf ||
    kdf.name !== 'PBKDF2' ||
    kdf.hash !== 'SHA-256' ||
    kdf.iterations !== kdfIterations ||
    !cipher ||
    cipher.name !== 'AES-GCM' ||
    typeof cipher.iv !== 'string' ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new Error('The recovery package uses an unsupported encryption profile.');
  }
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(cipher.iv);
  if (salt.byteLength !== 16 || iv.byteLength !== 12) {
    throw new Error('The recovery package has invalid encryption parameters.');
  }
  let plaintext: ArrayBuffer;
  try {
    const key = await encryptionKey(passphrase, salt);
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: arrayBuffer(iv), additionalData: new TextEncoder().encode(aad) },
      key,
      arrayBuffer(base64ToBytes(parsed.ciphertext)),
    );
  } catch {
    throw new Error('The recovery package could not be decrypted. Check the passphrase and file.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('The decrypted recovery package is not valid.');
  }
  if (!isRecord(payload) || payload.kind !== packageFormat || payload.version !== packageVersion) {
    throw new Error('The decrypted recovery package is not a supported QBSheet package.');
  }
  if (typeof payload.createdAt !== 'string' || !isRecord(payload.state)) {
    throw new Error('The recovery package is missing its BridgeState.');
  }
  // Fingerprints and digests are provenance, not access control: a package that predates them
  // decrypts with nulls, and the import flow treats nulls as "unknown, verify everything".
  const sourceYftFingerprint =
    typeof payload.sourceYftFingerprint === 'string' ? payload.sourceYftFingerprint : null;
  const digests = readRecoveryDigests(payload.digests);
  const state = normalizeState(payload.state);
  const relay = state && isRecord(state.relay) ? state.relay : null;
  const baseUrl = relay && typeof relay.baseUrl === 'string' ? normalizeRelayBaseUrl(relay.baseUrl) : null;
  const controllerId = relay && typeof relay.controllerId === 'string' ? relay.controllerId.trim() : '';
  const controllerLabel =
    relay && typeof relay.controllerLabel === 'string' ? relay.controllerLabel.trim() : '';
  const epoch = relay && typeof relay.epoch === 'number' ? relay.epoch : NaN;
  const revision = relay && typeof relay.revision === 'number' ? relay.revision : NaN;
  if (
    !state ||
    !relay ||
    !baseUrl?.ok ||
    typeof relay.tournamentId !== 'string' ||
    !isRelayTournamentId(relay.tournamentId) ||
    typeof relay.managementToken !== 'string' ||
    relay.managementToken.length === 0 ||
    relay.managementToken.length > 1024 ||
    relay.controllerRole !== 'backup' ||
    controllerId.length === 0 ||
    controllerId.length > 200 ||
    controllerLabel.length === 0 ||
    controllerLabel.length > 120 ||
    !Number.isInteger(epoch) ||
    epoch < 0 ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    throw new Error('The recovery package does not contain a backup controller credential.');
  }
  const safeRelay: NonNullable<BridgeState['relay']> = {
    baseUrl: baseUrl.value,
    tournamentId: relay.tournamentId,
    managementToken: relay.managementToken,
    epoch,
    revision,
    controllerRole: 'backup',
    controllerId,
    controllerLabel,
  };
  return {
    kind: packageFormat,
    version: packageVersion,
    createdAt: payload.createdAt,
    sourceYftFingerprint,
    digests,
    state: { ...state, relay: safeRelay },
  };
}

/**
 * What the relay holds for one room, learned from the assignment event log after takeover.
 * Events carry match identity and issue numbers, not full QBJs or pairing codes: enough to
 * name what moved, never a silent hydration.
 */
export interface RelayRoomEvent {
  roomId: string;
  matchId: string | null;
  assignmentRevision: number | null;
}

/** One room whose relay state provably moved past the package-time snapshot. */
export interface TakeoverRoomDrift {
  roomId: string;
  roomName: string;
  packageMatchId: string | null;
  liveMatchId: string | null;
  packageAssignmentRevision: number;
  liveAssignmentRevision: number;
}

/**
 * The relay-changes review a fresh controller owes before its first publication. `unknown`
 * means the event history was incomplete or unreadable: every room is suspect, not just the
 * listed ones. Pairing-code drift is not observable here — codes never appear in events —
 * so the review always covers codes by policy, not by proof.
 */
export interface TakeoverDriftReport {
  checkedAt: string;
  unknown: boolean;
  rooms: TakeoverRoomDrift[];
}

/**
 * Compare package-time rooms against the relay's assignment events.
 *
 * Only strictly newer proof counts: a room is drifted when the relay's latest event carries
 * an assignment revision past the package's. Older or equal revisions are the package's own
 * past, never an alarm; events without an issue number cannot prove newness either way and
 * are ignored for that room. Rooms the relay knows that the package never held are always
 * drift — something was published outside this profile's history.
 */
export function describeTakeoverDrift(
  packageRooms: readonly {
    id: string;
    name: string;
    publishedMatchId: string | null;
    assignmentRevision: number;
  }[],
  events: readonly RelayRoomEvent[],
): TakeoverRoomDrift[] {
  const latest = new Map<string, RelayRoomEvent>();
  for (const event of events) {
    const prior = latest.get(event.roomId);
    if (!prior || (event.assignmentRevision ?? -1) >= (prior.assignmentRevision ?? -1)) {
      latest.set(event.roomId, event);
    }
  }
  const drift: TakeoverRoomDrift[] = [];
  const packaged = new Map(packageRooms.map((room) => [room.id, room]));
  for (const [roomId, event] of latest) {
    const baseline = packaged.get(roomId);
    if (!baseline) {
      drift.push({
        roomId,
        roomName: roomId,
        packageMatchId: null,
        liveMatchId: event.matchId,
        packageAssignmentRevision: 0,
        liveAssignmentRevision: event.assignmentRevision ?? 0,
      });
      continue;
    }
    if (event.assignmentRevision === null || event.assignmentRevision <= baseline.assignmentRevision) {
      continue;
    }
    drift.push({
      roomId,
      roomName: baseline.name,
      packageMatchId: baseline.publishedMatchId,
      liveMatchId: event.matchId,
      packageAssignmentRevision: baseline.assignmentRevision,
      liveAssignmentRevision: event.assignmentRevision,
    });
  }
  return drift.sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
}

/**
 * The persisted takeover review: the drift report plus whether the operator confirmed it.
 * `reviewed: false` locks publication; only an explicit confirmation clears it.
 */
export interface TakeoverReview {
  checkedAt: string;
  unknown: boolean;
  rooms: TakeoverRoomDrift[];
  reviewed: boolean;
}

/** Read an untrusted takeover review; anything malformed is no review at all. */
export function readTakeoverReview(value: unknown): TakeoverReview | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { checkedAt, unknown, rooms, reviewed } = record;
  if (typeof checkedAt !== 'string' || typeof unknown !== 'boolean' || typeof reviewed !== 'boolean') {
    return null;
  }
  if (!Array.isArray(rooms)) return null;
  const clean: TakeoverRoomDrift[] = [];
  for (const entry of rooms) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const room = entry as Record<string, unknown>;
    if (
      typeof room.roomId !== 'string' ||
      typeof room.roomName !== 'string' ||
      (room.packageMatchId !== null && typeof room.packageMatchId !== 'string') ||
      (room.liveMatchId !== null && typeof room.liveMatchId !== 'string') ||
      typeof room.packageAssignmentRevision !== 'number' ||
      !Number.isInteger(room.packageAssignmentRevision) ||
      typeof room.liveAssignmentRevision !== 'number' ||
      !Number.isInteger(room.liveAssignmentRevision)
    ) {
      return null;
    }
    clean.push({
      roomId: room.roomId,
      roomName: room.roomName,
      packageMatchId: room.packageMatchId,
      liveMatchId: room.liveMatchId,
      packageAssignmentRevision: room.packageAssignmentRevision,
      liveAssignmentRevision: room.liveAssignmentRevision,
    });
  }
  return { checkedAt, unknown, rooms: clean, reviewed };
}
