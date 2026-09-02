export interface NativeServerStatus {
  running: boolean;
  address?: string;
  port?: number;
  protocol?: string;
  pairedRooms?: number;
  pairingInvitations?: NativeRoomPairingInvitation[];
  pairingCode?: string;
  pairingUrl?: string;
  message?: string;
}

export interface NativeRoomPairingInvitation {
  roomId: string;
  roomName: string;
  pairingCode: string;
  pairingUrl: string;
  expiresInSeconds: number;
}

export interface NativeResultSnapshot {
  id: string;
  sessionId: string;
  tournamentId?: string;
  matchId?: string;
  /** Exact Director assignment identity when the native server has it. */
  scheduledGameId?: string;
  fingerprint: string;
  reviewRequired: boolean;
  warnings: string[];
  conflictWith?: string;
  qbj?: unknown;
  rawBase64?: string;
}

export interface NativeSessionSnapshot {
  sessionId: string;
  roomId: string;
  matchId?: string;
  deviceId?: string;
  operatorName?: string;
  status: 'open' | 'final-received' | 'abandoned' | string;
  resumable: boolean;
  resultReceived: boolean;
  progressSequence?: number;
  updatedAt: string;
}

export interface NativeHelpSnapshot {
  id: string;
  roomId: string;
  roomName: string;
  category: string;
  message: string;
  status: 'open' | 'cancelled' | 'resolved' | string;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  operatorName?: string;
  currentMatchup?: Record<string, unknown>;
}

export interface NativeRosterAmendmentSnapshot {
  sessionId: string;
  amendment: Record<string, unknown>;
}

export interface NativeProgressSnapshot {
  sessionId: string;
  roomId: string;
  sequence: number;
  matchState: unknown;
  receivedAt: string;
}

export interface NativePresenceSnapshot {
  roomId: string;
  roomName: string;
  deviceId: string;
  sessionId?: string;
  operatorName?: string;
  update: {
    ready?: boolean;
    client?: { name?: string; version?: string; build?: string; commit?: string };
    procedure_versions?: number[];
    qbj_version?: string;
  };
  observedAt: string;
}

export interface NativeServerSnapshot {
  results: NativeResultSnapshot[];
  progress: NativeProgressSnapshot[];
  presence: NativePresenceSnapshot[];
  sessions: NativeSessionSnapshot[];
  help: NativeHelpSnapshot[];
  rosterAmendments: NativeRosterAmendmentSnapshot[];
}

export type NativeSnapshotReadResult =
  { status: 'ok'; snapshot: NativeServerSnapshot } | { status: 'error'; message: string };

export type NativeSaveResult =
  { status: 'saved'; path: string } | { status: 'cancelled' } | { status: 'unavailable' };

export interface NativeSelectedFile {
  path: string;
  fileName: string;
  contentBase64: string;
  byteLength: number;
}

interface NativeBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: NativeBridge;
  }
}

function bridge(): NativeBridge | null {
  return typeof window === 'undefined' ? null : (window.__TAURI_INTERNALS__ ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeStatus(value: unknown, fallback: string): NativeServerStatus {
  if (!isRecord(value) || typeof value.running !== 'boolean') {
    return { running: false, message: fallback };
  }
  const invitations = value.pairingInvitations;
  return {
    running: value.running,
    ...(typeof value.address === 'string' ? { address: value.address } : {}),
    ...(typeof value.port === 'number' ? { port: value.port } : {}),
    ...(typeof value.protocol === 'string' ? { protocol: value.protocol } : {}),
    ...(typeof value.pairedRooms === 'number' ? { pairedRooms: value.pairedRooms } : {}),
    ...(Array.isArray(invitations)
      ? { pairingInvitations: invitations as NativeRoomPairingInvitation[] }
      : {}),
    ...(typeof value.pairingCode === 'string' ? { pairingCode: value.pairingCode } : {}),
    ...(typeof value.pairingUrl === 'string' ? { pairingUrl: value.pairingUrl } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
}

export function isNativeDirector(): boolean {
  return bridge() !== null;
}

export async function readNativeServerStatus(): Promise<NativeServerStatus> {
  const native = bridge();
  if (!native) return { running: false, message: 'Native server is available from the Tauri Director app.' };
  try {
    const status = await native.invoke('director_server_status');
    return normalizeStatus(status, 'Server status was not understood.');
  } catch (reason: unknown) {
    return {
      running: false,
      message: reason instanceof Error ? reason.message : 'Server status could not be read.',
    };
  }
}

export async function startNativeServer(): Promise<NativeServerStatus> {
  const native = bridge();
  if (!native) return { running: false, message: 'Open the Tauri Director app to start the LAN server.' };
  try {
    return normalizeStatus(
      await native.invoke('director_start_qbtcp_server'),
      'The QBTCP server returned an invalid start status.',
    );
  } catch (reason: unknown) {
    return {
      running: false,
      message: reason instanceof Error ? reason.message : 'The QBTCP server could not start.',
    };
  }
}

export async function stopNativeServer(): Promise<NativeServerStatus> {
  const native = bridge();
  if (!native) return { running: false, message: 'The browser preview has no native server to stop.' };
  try {
    return normalizeStatus(
      await native.invoke('director_stop_qbtcp_server'),
      'The QBTCP server returned an invalid stop status.',
    );
  } catch (reason: unknown) {
    return {
      running: false,
      message: reason instanceof Error ? reason.message : 'The QBTCP server could not stop.',
    };
  }
}

export async function issueNativeRoomPairing(roomId: string): Promise<NativeRoomPairingInvitation> {
  const native = bridge();
  if (!native) throw new Error('Open the Tauri Director app to issue a room pairing invitation.');
  const invitation = await native.invoke('director_issue_qbtcp_pairing', { roomId });
  if (!invitation || typeof invitation !== 'object') {
    throw new Error('The native server did not return a room pairing invitation.');
  }
  return invitation as NativeRoomPairingInvitation;
}

export async function readNativeServerSnapshot(): Promise<NativeSnapshotReadResult> {
  const native = bridge();
  if (!native)
    return { status: 'error', message: 'The native QBTCP server is unavailable in the browser preview.' };
  try {
    const snapshot = await native.invoke('director_server_snapshot');
    if (!isRecord(snapshot))
      return { status: 'error', message: 'The native server returned an invalid snapshot.' };
    if (
      !Array.isArray(snapshot.results) ||
      !Array.isArray(snapshot.progress) ||
      !Array.isArray(snapshot.presence) ||
      (snapshot.sessions !== undefined && !Array.isArray(snapshot.sessions)) ||
      (snapshot.help !== undefined && !Array.isArray(snapshot.help)) ||
      (snapshot.rosterAmendments !== undefined && !Array.isArray(snapshot.rosterAmendments))
    ) {
      return { status: 'error', message: 'The native server snapshot is missing required collections.' };
    }
    return {
      status: 'ok',
      snapshot: {
        results: snapshot.results
          .map(normalizeNativeResult)
          .filter((result): result is NativeResultSnapshot => result !== null),
        progress: snapshot.progress.filter(isNativeProgressSnapshot),
        presence: snapshot.presence.filter(isNativePresenceSnapshot),
        sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.filter(isNativeSessionSnapshot) : [],
        help: Array.isArray(snapshot.help) ? snapshot.help.filter(isNativeHelpSnapshot) : [],
        rosterAmendments: Array.isArray(snapshot.rosterAmendments)
          ? snapshot.rosterAmendments.filter(isNativeRosterAmendmentSnapshot)
          : [],
      },
    };
  } catch (reason: unknown) {
    return {
      status: 'error',
      message: reason instanceof Error ? reason.message : 'The native server snapshot could not be read.',
    };
  }
}

export async function openNativeTournamentFile(): Promise<NativeSelectedFile | null> {
  const native = bridge();
  if (!native) return null;
  try {
    const selected = await native.invoke('open_tournament_file');
    return selected && typeof selected === 'object' ? (selected as NativeSelectedFile) : null;
  } catch (reason: unknown) {
    throw reason instanceof Error ? reason : new Error('A tournament file could not be opened.');
  }
}

export async function saveNativeFile(defaultName: string, bytes: Uint8Array): Promise<NativeSaveResult> {
  const native = bridge();
  if (!native) return { status: 'unavailable' };
  const contentBase64 = bytesToBase64(bytes);
  const result = await native.invoke('save_tournament_file', {
    request: { defaultName, contentBase64 },
  });
  if (!isRecord(result)) throw new Error('The native save dialog returned an invalid response.');
  const path = result.path;
  return typeof path === 'string' && path.length > 0 ? { status: 'saved', path } : { status: 'cancelled' };
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function normalizeNativeResult(value: unknown): NativeResultSnapshot | null {
  if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.sessionId)) return null;
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const missingMetadata =
    typeof value.fingerprint !== 'string' ||
    typeof value.reviewRequired !== 'boolean' ||
    !Array.isArray(value.warnings);
  return {
    id: value.id,
    sessionId: value.sessionId,
    ...(nonEmptyString(value.tournamentId) ? { tournamentId: value.tournamentId } : {}),
    ...(nonEmptyString(value.matchId) ? { matchId: value.matchId } : {}),
    ...(nonEmptyString(value.scheduledGameId) ? { scheduledGameId: value.scheduledGameId } : {}),
    fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : `transport:${value.id}`,
    reviewRequired: value.reviewRequired === false && !missingMetadata ? false : true,
    warnings: [
      ...(missingMetadata
        ? ['The native result omitted review metadata; it was retained for manual review.']
        : []),
      ...warnings,
    ],
    ...(nonEmptyString(value.conflictWith) ? { conflictWith: value.conflictWith } : {}),
    ...(value.qbj !== undefined ? { qbj: value.qbj } : {}),
    ...(typeof value.rawBase64 === 'string' ? { rawBase64: value.rawBase64 } : {}),
  };
}

function isNativeProgressSnapshot(value: unknown): value is NativeProgressSnapshot {
  return (
    isRecord(value) &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.roomId) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    nonEmptyString(value.receivedAt)
  );
}

function isNativePresenceSnapshot(value: unknown): value is NativePresenceSnapshot {
  return (
    isRecord(value) &&
    nonEmptyString(value.roomId) &&
    nonEmptyString(value.roomName) &&
    nonEmptyString(value.deviceId) &&
    isRecord(value.update) &&
    (value.sessionId === undefined || nonEmptyString(value.sessionId)) &&
    nonEmptyString(value.observedAt)
  );
}

function isNativeSessionSnapshot(value: unknown): value is NativeSessionSnapshot {
  return (
    isRecord(value) &&
    nonEmptyString(value.sessionId) &&
    nonEmptyString(value.roomId) &&
    typeof value.status === 'string' &&
    (value.matchId === undefined || nonEmptyString(value.matchId)) &&
    (value.deviceId === undefined || nonEmptyString(value.deviceId)) &&
    (value.operatorName === undefined || typeof value.operatorName === 'string') &&
    typeof value.resumable === 'boolean' &&
    typeof value.resultReceived === 'boolean' &&
    nonEmptyString(value.updatedAt)
  );
}

function isNativeHelpSnapshot(value: unknown): value is NativeHelpSnapshot {
  return (
    isRecord(value) &&
    nonEmptyString(value.id) &&
    nonEmptyString(value.roomId) &&
    nonEmptyString(value.roomName) &&
    typeof value.category === 'string' &&
    typeof value.message === 'string' &&
    typeof value.status === 'string' &&
    nonEmptyString(value.createdAt) &&
    nonEmptyString(value.updatedAt) &&
    nonEmptyString(value.deviceId) &&
    (value.currentMatchup === undefined || isRecord(value.currentMatchup))
  );
}

function isNativeRosterAmendmentSnapshot(value: unknown): value is NativeRosterAmendmentSnapshot {
  return isRecord(value) && nonEmptyString(value.sessionId) && isRecord(value.amendment);
}
