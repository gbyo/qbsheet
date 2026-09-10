import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  getCloseGuardRequest,
  getClosePerformer,
  registerClosePerformer,
} from '../../../src/director/platform/closeGuard';

export interface ApplicationPaths {
  appData: string;
  appConfig: string;
  appLocalData: string;
  appCache: string;
  appLog: string;
  database: string;
  backups: string;
}

export interface StoreStatus {
  databasePath: string;
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  migrationCount: number;
}

export interface NativeServerStatus {
  running: boolean;
  address?: string;
  bindAddress?: string;
  port?: number;
  addressCandidates?: NativeAdvertisedAddressCandidate[];
  addressSelectionRequired?: boolean;
  advertisedAddressSource?: string;
  expiredPairingRoomIds?: string[];
  protocol?: string;
  pairedRooms?: number;
  pairingInvitations?: NativeRoomPairingInvitation[];
  pairingCode?: string;
  pairingUrl?: string;
  message?: string;
}

export interface NativeAdvertisedAddressCandidate {
  interfaceName: string;
  address: string;
}

export interface NativeRoomPairingInvitation {
  roomId: string;
  roomName: string;
  pairingCode: string;
  pairingUrl?: string;
  issuedAt: string;
  expiresAt: string;
  expiresInSeconds: number;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  protocol: string;
  qbjVersion: string;
  target: string;
  os: string;
  arch: string;
  paths: ApplicationPaths;
  store: StoreStatus;
  server: NativeServerStatus;
}

export interface SelectedFile {
  path: string;
  fileName: string;
  contentBase64: string;
  byteLength: number;
}

export interface SaveFileRequest {
  defaultName?: string;
  contentBase64: string;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function closeCurrentWindow(): Promise<void> {
  await getCurrentWindow().close();
}

/**
 * Native close interception (#731). The first close request is prevented and
 * handed to the registered Director close guard, which flushes the canonical
 * persistence queue and only permits exit once the current revision is
 * durable (or the operator explicitly quits without saving). The `bypass`
 * flag is the one-shot escape for the programmatic close that follows a
 * successful flush, so the guard never re-triggers on its own close.
 *
 * Outside Tauri this is a no-op: browser tabs keep the best-effort
 * `beforeunload` warning owned by DirectorApp.
 */
export async function installCloseInterception(): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  let bypass = false;
  const performer = () => {
    bypass = true;
    void closeCurrentWindow();
  };
  registerClosePerformer(performer);
  const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
    if (bypass) return;
    const requestClose = getCloseGuardRequest();
    if (!requestClose) return;
    event.preventDefault();
    if (await requestClose()) {
      bypass = true;
      await closeCurrentWindow();
    }
  });
  return () => {
    if (getClosePerformer() === performer) registerClosePerformer(null);
    unlisten();
  };
}

function requireTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error('This action is available from the QBSheet Director desktop app.');
  }
}

export async function getApplicationPaths(): Promise<ApplicationPaths> {
  requireTauri();
  return invoke<ApplicationPaths>('get_application_paths');
}

export async function getStoreStatus(): Promise<StoreStatus> {
  requireTauri();
  return invoke<StoreStatus>('get_store_status');
}

export async function loadDirectorState<T = unknown>(): Promise<T | null> {
  requireTauri();
  return invoke<T | null>('director_load_state');
}

export async function saveDirectorState(state: unknown): Promise<StoreStatus> {
  requireTauri();
  return invoke<StoreStatus>('director_save_state', { state });
}

export async function checkpointDirectorState(state: unknown, reason: string): Promise<StoreStatus> {
  requireTauri();
  return invoke<StoreStatus>('director_checkpoint', { state, reason });
}

export async function getServerStatus(): Promise<NativeServerStatus> {
  requireTauri();
  return invoke<NativeServerStatus>('director_server_status');
}

export async function startQbtcpServer(): Promise<NativeServerStatus> {
  requireTauri();
  return invoke<NativeServerStatus>('director_start_qbtcp_server');
}

export async function stopQbtcpServer(): Promise<NativeServerStatus> {
  requireTauri();
  return invoke<NativeServerStatus>('director_stop_qbtcp_server');
}

export async function resetQbtcpCredentials(): Promise<NativeServerStatus> {
  requireTauri();
  return invoke<NativeServerStatus>('director_reset_qbtcp_credentials');
}

export async function issueRoomPairing(roomId: string): Promise<NativeRoomPairingInvitation> {
  requireTauri();
  return invoke<NativeRoomPairingInvitation>('director_issue_qbtcp_pairing', { roomId });
}

export async function setQbtcpAdvertisedAddress(address: string): Promise<NativeServerStatus> {
  requireTauri();
  return invoke<NativeServerStatus>('director_set_qbtcp_advertised_address', { address });
}

export async function openTournamentFile(): Promise<SelectedFile | null> {
  requireTauri();
  return invoke<SelectedFile | null>('open_tournament_file');
}

export async function saveTournamentFile(request: SaveFileRequest): Promise<string | null> {
  requireTauri();
  const result = await invoke<{ path: string } | null>('save_tournament_file', { request });
  return result?.path ?? null;
}

export async function getDiagnostics(): Promise<DiagnosticsSnapshot> {
  requireTauri();
  return invoke<DiagnosticsSnapshot>('get_diagnostics_snapshot');
}

export async function saveDiagnostics(): Promise<string | null> {
  requireTauri();
  const result = await invoke<{ path: string } | null>('save_diagnostics_bundle');
  return result?.path ?? null;
}

export async function checkpointStore(reason: string): Promise<StoreStatus> {
  requireTauri();
  return invoke<StoreStatus>('checkpoint_store', { reason });
}
