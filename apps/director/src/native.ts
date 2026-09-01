import { invoke } from '@tauri-apps/api/core';

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
  port?: number;
  protocol?: string;
  pairedRooms?: number;
  pairingCode?: string;
  pairingUrl?: string;
  message?: string;
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
