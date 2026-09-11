/**
 * The whole native surface: file dialogs/writes, secure relay-credential storage, and HTTP.
 *
 * Tauri is here for the desktop capabilities a browser tab cannot do well on a tournament
 * morning — a real open dialog, a real folder picker, writing a dozen files without a download
 * prompt each, and an HTTP client whose requests carry no browser `Origin`. It is not here to own
 * application state, and nothing below models any.
 *
 * Every call degrades to a stated error outside Tauri rather than throwing at import time, so the
 * model and the views stay testable under `vitest` with no native host.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Whether a native host is present, memoized.
 *
 * The check is for `__TAURI_INTERNALS__.invoke`, which is the object `invoke` dispatches through,
 * rather than for the `isTauri` global the API's own helper reads. One signal, and it is the one
 * that decides whether the next call can work; two differently-sourced signals could disagree.
 *
 * Tests install a fake `__TAURI_INTERNALS__` and call `resetNativeHost`, so the fake is exercised
 * through the same door the real bridge uses instead of by stubbing the four functions below.
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

/** Stable non-secret key used to name one relay credential in the OS secure store. */
export function relayCredentialKey(
  baseUrl: string,
  tournamentId: string,
  controllerRole: 'primary' | 'backup' = 'primary',
  controllerId = '',
): string {
  return `${baseUrl.replace(/\/+$/, '')}\u001f${tournamentId}\u001f${controllerRole}\u001f${controllerId}`;
}

export class NativeUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} needs the QBSheet Bridge desktop application.`);
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

/** Native open dialog filtered to `.yft`, plus the file's text. Null when the operator cancels. */
export async function openYellowFruitFile(): Promise<OpenedFile | null> {
  requireNative('Opening a YellowFruit file');
  return invoke<OpenedFile | null>('open_yellowfruit_file');
}

/** Native folder picker for the result directory. Null when the operator cancels. */
export async function chooseResultFolder(): Promise<string | null> {
  requireNative('Choosing a results folder');
  return invoke<string | null>('choose_result_folder');
}

/** Native open dialog for the encrypted backup-controller package. */
export async function openRecoveryPackage(): Promise<OpenedFile | null> {
  requireNative('Opening a QBSheet recovery package');
  return invoke<OpenedFile | null>('open_recovery_package');
}

/** Write one encrypted recovery package. The native writer refuses to replace an existing file. */
export async function writeRecoveryPackage(
  directory: string,
  fileName: string,
  contents: string,
): Promise<string> {
  requireNative('Writing a QBSheet recovery package');
  return invoke<string>('write_recovery_package', { directory, fileName, contents });
}

/** Store a relay credential in the operating system's secure credential store. */
export async function storeRelayCredential(key: string, token: string): Promise<void> {
  requireNative('Storing a relay credential securely');
  await invoke('store_relay_credential', { key, token });
}

/** Load a relay credential from the operating system's secure credential store. */
export async function loadRelayCredential(key: string): Promise<string | null> {
  requireNative('Loading a relay credential securely');
  return invoke<string | null>('load_relay_credential', { key });
}

/** Delete a relay credential from the operating system's secure credential store. */
export async function deleteRelayCredential(key: string): Promise<void> {
  requireNative('Deleting a relay credential securely');
  await invoke('delete_relay_credential', { key });
}

/**
 * Write one result file. Returns the full path written.
 *
 * `overwrite` defaults to refusing an existing file. A result that is already on disk is a result
 * somebody may not have imported yet, and two different retained relay results for one game
 * produce names that differ only in their suffix — so the failure mode this guards against is a
 * corrected final quietly replacing the original.
 */
export async function writeResultFile(
  directory: string,
  fileName: string,
  contents: string,
  overwrite = false,
): Promise<string> {
  requireNative('Saving a result file');
  return invoke<string>('write_result_file', { directory, fileName, contents, overwrite });
}

export interface RelayResponse {
  status: number;
  body: string;
}

/**
 * One authenticated HTTP call to the relay, made natively.
 *
 * Native rather than `fetch` for one reason: the relay validates the browser `Origin` on every
 * credentialed route against the operator's allowlist. Adding a desktop application's origin to
 * that allowlist would weaken a rule that exists to keep arbitrary pages off the management
 * surface. A native request has no `Origin`, needs no preflight, and changes nothing about the
 * relay.
 */
export async function relayRequest(options: {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  bearer?: string;
  body?: unknown;
}): Promise<RelayResponse> {
  requireNative('Talking to the relay');
  return invoke<RelayResponse>('relay_request', {
    method: options.method,
    url: options.url,
    bearer: options.bearer ?? null,
    body: options.body === undefined ? null : JSON.stringify(options.body),
  });
}
