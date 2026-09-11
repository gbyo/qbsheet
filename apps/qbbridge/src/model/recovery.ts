/**
 * Encrypted QBBridge backup-controller packages.
 *
 * The package is an explicit, operator-created handoff. Its outer JSON contains only the
 * algorithm parameters; relay identity, the backup credential, room pairing codes, plans and
 * result bookkeeping are authenticated ciphertext. It is therefore safe to move as a file only
 * when the operator also moves the recovery passphrase through a separate channel.
 */

import { normalizeState, type BridgeState } from './persistence';
import { isRelayTournamentId, normalizeRelayBaseUrl } from '../../../../src/director/relay/relayConfig';

/** Outer marker of an encrypted recovery package; exported so readiness can prove the crypto path. */
export const packageFormat = 'qbsheet-bridge-recovery';
/** Package schema version; exported so readiness can prove the crypto path. */
export const packageVersion = 1;
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
  state: BridgeState;
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
    state: { ...state, relay: safeRelay },
  };
}
