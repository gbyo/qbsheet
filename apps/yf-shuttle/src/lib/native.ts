/**
 * The whole native surface: file dialogs and filesystem operations.
 *
 * Tauri is here for the desktop capabilities a browser tab cannot do well — a real open
 * dialog, a real folder picker, creating nested folders, and writing dozens of files without
 * a download prompt each. It is not here to own application state, and nothing below models
 * any: every call takes explicit paths and bytes, and every decision lives in TypeScript.
 *
 * Every call degrades to a stated error outside Tauri rather than throwing at import time, so
 * the model stays testable under `vitest` with no native host.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Whether a native host is present, memoized.
 *
 * The check is for `__TAURI_INTERNALS__.invoke`, which is the object `invoke` dispatches
 * through — the one signal that decides whether the next call can work.
 */
let cached: boolean | undefined;

export function isNativeHost(): boolean {
  if (cached === undefined) {
    const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    cached = typeof internals?.invoke === 'function';
  }
  return cached;
}

/** Forget the memoized answer. Tests only. */
export function resetNativeHost(): void {
  cached = undefined;
}

export class NativeUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} needs the YF Shuttle desktop application.`);
    this.name = 'NativeUnavailableError';
  }
}

function requireNative(what: string): void {
  if (!isNativeHost()) throw new NativeUnavailableError(what);
}

export interface OpenedFile {
  path: string;
  contents: string;
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  /** Last-modified time, milliseconds since the epoch, when the platform reports one. */
  modifiedMs?: number;
}

/** Native open dialog filtered to `.yft`, plus the file's text. Null when cancelled. */
export async function openYellowFruitFile(): Promise<OpenedFile | null> {
  requireNative('Opening a YellowFruit file');
  return invoke<OpenedFile | null>('open_yellowfruit_file');
}

/** Native folder picker for the project parent. Null when the operator cancels. */
export async function chooseProjectParent(): Promise<string | null> {
  requireNative('Choosing a project folder');
  return invoke<string | null>('choose_project_parent');
}

/**
 * Create every directory in `dirs` under `base`, including parents.
 *
 * Idempotent: existing directories are left alone. Never deletes anything.
 */
export async function createDirectories(base: string, dirs: string[]): Promise<void> {
  requireNative('Creating project folders');
  await invoke('create_directories', { base, dirs });
}

/** List one directory's immediate children. Files only report a name, kind, and mtime. */
export async function listDirectory(path: string): Promise<DirectoryEntry[]> {
  requireNative('Reading a folder');
  return invoke<DirectoryEntry[]>('list_directory', { path });
}

/** Read one text file. Refused above the import size bound, like the importer itself. */
export async function readTextFile(path: string): Promise<string> {
  requireNative('Reading a file');
  return invoke<string>('read_text_file', { path });
}

export interface WriteOptions {
  /**
   * Assignments are always exclusive: an existing IN file is never replaced blindly (the
   * caller compares bytes first and reports). The manifest and the derived YellowFruit
   * import batches are the only files written with overwrite, and only on explicit action.
   */
  overwrite?: boolean;
}

/** Write one text file. Exclusive unless `overwrite` says otherwise. */
export async function writeTextFile(
  path: string,
  contents: string,
  options: WriteOptions = {},
): Promise<void> {
  requireNative('Writing a file');
  await invoke('write_text_file', { path, contents, overwrite: options.overwrite ?? false });
}

/** Copy one file byte-for-byte. The bytes are never parsed, reserialized, or altered. */
export async function copyFile(src: string, dst: string, overwrite = false): Promise<void> {
  requireNative('Copying a file');
  await invoke('copy_file', { src, dst, overwrite });
}

/**
 * Remove one derived result file from inside the project's `YellowFruit Import` tree.
 *
 * `relativePath` must be exactly `Round N/<file>`; the command refuses anything else, and
 * refuses targets outside the import root. This is the one narrow eraser the derived batch
 * planner uses to drop its own stale copies — never a general delete.
 */
export async function removeImportFile(importRoot: string, relativePath: string): Promise<void> {
  requireNative('Removing a derived file');
  await invoke('remove_import_file', { importRoot, relativePath });
}
