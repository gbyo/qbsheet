export interface NativeServerStatus {
  running: boolean;
  address?: string;
  port?: number;
  protocol?: string;
  pairedRooms?: number;
  pairingCode?: string;
  pairingUrl?: string;
  message?: string;
}

export interface NativeResultSnapshot {
  id: string;
  sessionId: string;
  tournamentId?: string;
  matchId?: string;
  fingerprint: string;
  reviewRequired: boolean;
  warnings: string[];
  conflictWith?: string;
  qbj?: unknown;
  rawBase64?: string;
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
}

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

export function isNativeDirector(): boolean {
  return bridge() !== null;
}

export async function readNativeServerStatus(): Promise<NativeServerStatus> {
  const native = bridge();
  if (!native) return { running: false, message: 'Native server is available from the Tauri Director app.' };
  try {
    const status = await native.invoke('director_server_status');
    return typeof status === 'object' && status !== null
      ? (status as NativeServerStatus)
      : { running: false, message: 'Server status was not understood.' };
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
    return (await native.invoke('director_start_qbtcp_server')) as NativeServerStatus;
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
    return (await native.invoke('director_stop_qbtcp_server')) as NativeServerStatus;
  } catch (reason: unknown) {
    return {
      running: false,
      message: reason instanceof Error ? reason.message : 'The QBTCP server could not stop.',
    };
  }
}

export async function readNativeServerSnapshot(): Promise<NativeServerSnapshot | null> {
  const native = bridge();
  if (!native) return null;
  try {
    const snapshot = await native.invoke('director_server_snapshot');
    if (!snapshot || typeof snapshot !== 'object') return null;
    const value = snapshot as Partial<NativeServerSnapshot>;
    return {
      results: Array.isArray(value.results) ? value.results : [],
      progress: Array.isArray(value.progress) ? value.progress : [],
      presence: Array.isArray(value.presence) ? value.presence : [],
    };
  } catch {
    return null;
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

export async function saveNativeFile(defaultName: string, bytes: Uint8Array): Promise<string | null> {
  const native = bridge();
  if (!native) return null;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const contentBase64 = btoa(binary);
  const result = await native.invoke('save_tournament_file', {
    request: { defaultName, contentBase64 },
  });
  if (!result || typeof result !== 'object') return null;
  const path = (result as { path?: unknown }).path;
  return typeof path === 'string' ? path : null;
}
