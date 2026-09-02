/**
 * QBSheet Live publication: what a tournament chooses to make public, and where it publishes it.
 *
 * # Why the settings live in the canonical domain
 *
 * The public projection is a privacy boundary, and a boundary whose rules are stored somewhere else
 * can be bypassed by anything that forgets to consult them. Keeping the settings inside the
 * authoritative tournament document means the projection takes exactly one argument pair —
 * the state and the settings that state carries — and a caller cannot construct a snapshot without
 * having stated what it is allowed to contain.
 *
 * Nothing in this module is a secret. Management credentials are deliberately absent: see
 * `LivePublicationCredentialRef` and `docs/QBLIVE.md`.
 */

import type { DirectorId } from './model.js';

/** The QBLive protocol version this build speaks. Bumped only by a breaking wire change. */
export const qbliveProtocolVersion = 1 as const;

export type LiveBackendKind = 'cloudflare' | 'custom' | 'local';

export type LivePublicationLifecycle = 'disabled' | 'configuring' | 'live' | 'final' | 'unpublished';

/**
 * Public visibility switches.
 *
 * # Defaults
 *
 * Every field here is a deliberate default rather than an inherited one. The three that are off are
 * off because they are the ones a Director would regret: a live score turns a scoresheet into a
 * scoreboard the room can see, player names identify minors, and unreleased pairings leak the
 * bracket. Everything a paper schedule taped to a wall would already have said is on.
 */
export interface LivePublicationSettings {
  enabled: boolean;

  /** Team names. Off means teams appear as their seed/letter identity only. */
  teamNames: boolean;
  /** Player names on public rosters. Separate from statistics on purpose. */
  playerNames: boolean;
  /** Individual player statistics. Requires `playerNames` to be meaningful, but is its own switch. */
  playerStatistics: boolean;

  /** The released schedule. Unreleased rounds are never published regardless of this switch. */
  releasedSchedule: boolean;
  /** Room names on public games. */
  roomLocations: boolean;
  /** Free-text directions attached to rooms. */
  roomDirections: boolean;

  /** Accepted, final results. */
  acceptedResults: boolean;

  /** That a game is in progress at all. */
  liveGameStatus: boolean;
  /** The running score of a game in progress. Off by default. */
  liveScores: boolean;
  /** Tossups read so far in a game in progress. */
  liveProgress: boolean;

  /** Director announcements. */
  announcements: boolean;

  /** Standings tables. */
  standings: boolean;
  /** Team-level statistics tables. */
  teamStatistics: boolean;
}

/**
 * The initial settings for a newly enabled publication.
 *
 * Anything a spectator could read off the wall is on. Anything that is a new disclosure is off.
 */
export function defaultLivePublicationSettings(): LivePublicationSettings {
  return {
    enabled: false,
    teamNames: true,
    playerNames: false,
    playerStatistics: false,
    releasedSchedule: true,
    roomLocations: true,
    roomDirections: true,
    acceptedResults: true,
    liveGameStatus: true,
    liveScores: false,
    liveProgress: false,
    announcements: true,
    standings: true,
    teamStatistics: true,
  };
}

/**
 * Settings that publish nothing.
 *
 * Used as the projection input whenever publication is disabled or a caller has not proven it holds
 * real settings, so that the failure mode of a missing configuration is an empty snapshot rather
 * than a full one.
 */
export function closedLivePublicationSettings(): LivePublicationSettings {
  return {
    enabled: false,
    teamNames: false,
    playerNames: false,
    playerStatistics: false,
    releasedSchedule: false,
    roomLocations: false,
    roomDirections: false,
    acceptedResults: false,
    liveGameStatus: false,
    liveScores: false,
    liveProgress: false,
    announcements: false,
    standings: false,
    teamStatistics: false,
  };
}

export interface LiveBackendDescriptor {
  kind: LiveBackendKind;
  /**
   * The public origin the backend serves QBLive from, without a trailing slash.
   *
   * Public routing information only. A management credential is never part of this value, and
   * `assertPublicBackendOrigin` rejects one that carries userinfo.
   */
  origin: string;
  /** Director-facing label. Never published. */
  displayName?: string;
}

/**
 * A pointer to a management credential, not the credential.
 *
 * The secret itself lives in the OS keychain under `keychainAccount`. A tournament archive can
 * carry this record and still be safe to email: the recipient learns that a credential exists and
 * where this machine kept it, which is nothing they could not have guessed.
 */
export interface LivePublicationCredentialRef {
  keychainService: string;
  keychainAccount: string;
  /** Set when the Director has confirmed the credential authenticates against the backend. */
  verifiedAt?: string | null;
}

export type LiveOutboxOperationState = 'pending' | 'in-flight' | 'failed' | 'done';

/**
 * One durable publication intent.
 *
 * The payload is already sanitized when it lands here: the outbox is downstream of the projection,
 * so nothing private can be queued even if publishing is later reconfigured. See
 * `docs/QBLIVE.md#durable-outbox`.
 */
export interface LiveOutboxItem {
  id: DirectorId;
  /** The local public revision this item carries the tournament to. */
  revision: number;
  kind: 'snapshot' | 'sections' | 'announcement' | 'finalize' | 'delete' | 'unpublish';
  /** Serialized sanitized QBLive management-request body. */
  payload: unknown;
  state: LiveOutboxOperationState;
  attempts: number;
  createdAt: string;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  /** When the worker may next try. Backoff is stored so a restart does not reset it. */
  nextAttemptAt?: string | null;
}

export type LivePushStatus = 'disabled' | 'enabled' | 'degraded' | 'unavailable';

export interface LivePushState {
  status: LivePushStatus;
  /** Set once push.qbsheet.com has issued this publication a push publisher identity. */
  publisherId?: string | null;
  credential?: LivePublicationCredentialRef | null;
  teamsPerShard?: number;
  lastError?: string | null;
  lastSuccessAt?: string | null;
}

export interface LiveSyncHealth {
  /** The revision Director has derived locally. */
  localRevision: number;
  /** The revision the backend last acknowledged. */
  acknowledgedRevision: number;
  pendingItems: number;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
  /** True while the worker is holding off after a failure. */
  retrying: boolean;
}

export interface LiveAnnouncement {
  id: DirectorId;
  title: string;
  body: string;
  severity: 'information' | 'important' | 'urgent';
  /** Empty audience means everybody. */
  audienceTeamIds: DirectorId[];
  publishedAt: string;
  updatedAt?: string | null;
  expiresAt?: string | null;
  /** A withdrawn announcement stays in the document for audit but leaves the projection. */
  withdrawn?: boolean;
}

/**
 * Everything the Director knows about its QBSheet Live publication.
 *
 * `publicationId` is high-entropy and public: it is the only tournament identifier that appears in
 * a QR code, and it is a capability to *read* a public projection, never to write one.
 */
export interface LivePublication {
  publicationId: string;
  lifecycle: LivePublicationLifecycle;
  settings: LivePublicationSettings;
  backend: LiveBackendDescriptor | null;
  credential: LivePublicationCredentialRef | null;
  push: LivePushState;
  sync: LiveSyncHealth;
  outbox: LiveOutboxItem[];
  announcements: LiveAnnouncement[];
  /** The bootstrap URL last generated for this publication, kept so the QR is stable. */
  publicUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function emptyLivePublication(publicationId: string, at: string): LivePublication {
  return {
    publicationId,
    lifecycle: 'disabled',
    settings: defaultLivePublicationSettings(),
    backend: null,
    credential: null,
    push: { status: 'disabled' },
    sync: {
      localRevision: 0,
      acknowledgedRevision: 0,
      pendingItems: 0,
      retrying: false,
    },
    outbox: [],
    announcements: [],
    publicUrl: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * A cryptographically random publication identifier.
 *
 * 128 bits, base32-ish alphabet without vowels or lookalikes, so it survives being read off a
 * printed page and cannot be guessed by walking a counter. Unguessability is doing real work: an
 * unlisted publication is only unlisted for as long as its ID is unguessable.
 */
const publicationAlphabet = '0123456789bcdfghjkmnpqrstvwxyz';

export function newPublicationId(randomBytes: (length: number) => Uint8Array = defaultRandomBytes): string {
  const bytes = randomBytes(20);
  let id = '';
  for (const byte of bytes) id += publicationAlphabet[byte % publicationAlphabet.length];
  return id;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return bytes;
  }
  throw new Error('A cryptographic random source is required to create a QBSheet Live publication.');
}

/** Publication IDs are fixed-length and drawn from one alphabet, so this is exact. */
export function isPublicationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 20 &&
    [...value].every((c) => publicationAlphabet.includes(c))
  );
}
