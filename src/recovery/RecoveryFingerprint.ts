import { IGameSetup } from '../scoring/deriveGame';
import { ScoreEvent } from '../scoring/ScoreEvents';
import { serializeScoreEvent } from '../scorer/QBSheetBackup';

/** Version the canonical input independently from the QBSheet backup envelope. */
export const recoveryFingerprintAlgorithm = 'sha256-core-v1' as const;

/** A deliberately small Web Crypto seam; no crypto dependency is needed. */
export interface IRecoveryWebCrypto {
  subtle?: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
}

export interface IRecoveryFingerprintResult {
  algorithm: typeof recoveryFingerprintAlgorithm;
  available: boolean;
  value?: string;
}

function canonicalTeam(team: IGameSetup['left']): Record<string, unknown> {
  return {
    name: team.name,
    players: team.players.slice(),
    ...(team.startingLineup === undefined ? {} : { startingLineup: team.startingLineup.slice() }),
  };
}

/**
 * Construct the deterministic, credential-free core input.
 *
 * Every property is named and ordered here. In particular, this does not stringify a live scorer
 * object, which could acquire a token, browser id, or a property whose insertion order varies.
 * `serializeScoreEvent` applies the existing event allowlist, so harmless runtime fields cannot
 * affect equality.
 */
export function canonicalRecoveryCoreV1(setup: IGameSetup, events: readonly ScoreEvent[]): string {
  const canonical = {
    version: 1,
    setup: {
      left: canonicalTeam(setup.left),
      right: canonicalTeam(setup.right),
    },
    events: events.map((event) => serializeScoreEvent(event)),
  };
  return JSON.stringify(canonical);
}

/** Alias with a shorter name for callers that do not need to mention the algorithm version. */
export const canonicalRecoveryCore = canonicalRecoveryCoreV1;

function defaultWebCrypto(): IRecoveryWebCrypto | null {
  try {
    const candidate = (globalThis as typeof globalThis & { crypto?: IRecoveryWebCrypto }).crypto;
    return candidate?.subtle ? candidate : null;
  } catch {
    return null;
  }
}

function hexDigest(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Fingerprint an exact setup/event history asynchronously.
 *
 * A browser without `crypto.subtle` is a supported recovery browser. It gets exact recovery and
 * source timestamps, but equality is reported as unavailable instead of making scoring fail.
 */
export async function fingerprintRecoveryCore(
  setup: IGameSetup,
  events: readonly ScoreEvent[],
  webCrypto: IRecoveryWebCrypto | null | undefined = defaultWebCrypto(),
): Promise<string | null> {
  const subtle = webCrypto?.subtle;
  if (!subtle) return null;
  try {
    const input = new TextEncoder().encode(canonicalRecoveryCoreV1(setup, events));
    return hexDigest(await subtle.digest('SHA-256', input));
  } catch {
    return null;
  }
}

/** Structured form useful to UI/status code that needs to distinguish unavailable from unequal. */
export async function computeRecoveryFingerprint(
  setup: IGameSetup,
  events: readonly ScoreEvent[],
  webCrypto: IRecoveryWebCrypto | null | undefined = defaultWebCrypto(),
): Promise<IRecoveryFingerprintResult> {
  const value = await fingerprintRecoveryCore(setup, events, webCrypto);
  return {
    algorithm: recoveryFingerprintAlgorithm,
    available: value !== null,
    ...(value === null ? {} : { value }),
  };
}

export type RecoveryFingerprintComparison = 'match' | 'different' | 'unavailable';

/** Compare only usable fingerprints; a missing hash never masquerades as a mismatch. */
export function compareRecoveryFingerprints(
  first: string | null | undefined,
  second: string | null | undefined,
): RecoveryFingerprintComparison {
  if (!first || !second) return 'unavailable';
  return first === second ? 'match' : 'different';
}
