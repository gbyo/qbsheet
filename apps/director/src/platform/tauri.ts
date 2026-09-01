import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import { saveWindowState as saveWindowStateCommand, StateFlags } from '@tauri-apps/plugin-window-state';

export const directorDatabaseUrl = 'sqlite:director.sqlite';

export interface AppDataPaths {
  appData: string;
  appConfig: string;
  appLocalData: string;
  appCache: string;
  appLog: string;
}

export interface OpenedTournamentFile {
  path: string;
  contents: string;
}

export interface UpdateCheckResult {
  available: boolean;
  currentVersion: string;
  version: string | null;
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

let databasePromise: Promise<Database> | undefined;

export function isNativeRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'The native operation failed.';
  }
}

export async function getAppDataPaths(): Promise<AppDataPaths | null> {
  if (!isNativeRuntime()) return null;
  return invoke<AppDataPaths>('get_app_data_paths');
}

export async function openTournamentFile(): Promise<OpenedTournamentFile | null> {
  if (!isNativeRuntime()) return null;
  return invoke<OpenedTournamentFile | null>('open_tournament_file');
}

export async function saveTournamentSnapshot(contents: string, defaultName: string): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  return invoke<string | null>('save_tournament_snapshot', { contents, defaultName });
}

export async function exportDiagnostics(): Promise<string | null> {
  if (!isNativeRuntime()) return null;
  return invoke<string | null>('export_diagnostics');
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!isNativeRuntime()) {
    return { available: false, currentVersion: 'browser-preview', version: null };
  }
  return invoke<UpdateCheckResult>('check_for_updates');
}

export async function persistWindowState(): Promise<void> {
  if (!isNativeRuntime()) return;
  await saveWindowStateCommand(StateFlags.ALL);
}

export async function openDirectorStore(): Promise<Database | null> {
  if (!isNativeRuntime()) return null;
  if (!databasePromise) databasePromise = Database.load(directorDatabaseUrl);
  return databasePromise;
}

export async function initializeDirectorStore(): Promise<boolean> {
  const database = await openDirectorStore();
  if (!database) return false;
  await database.select<{ ready: number }>('SELECT 1 AS ready');
  return true;
}

export async function recordDirectorEvent(eventType: string): Promise<boolean> {
  const database = await openDirectorStore();
  if (!database) return false;
  await database.execute('INSERT INTO director_shell_events (event_type, recorded_at) VALUES ($1, $2)', [
    eventType,
    new Date().toISOString(),
  ]);
  return true;
}
