/**
 * Internet QBTCP relay configuration: what Director remembers about a tournament-owned relay.
 *
 * # What lives where
 *
 * The tournament document keeps only a *pointer* — the relay origin, the tournament id, and
 * which keychain entry holds the secret — because a Director file gets emailed and opened on a
 * co-director's laptop. The management credential itself goes to the operating system's
 * credential store through Tauri (`relayCredentials.ts`), exactly like the QBLive management
 * credential. A document that carried the credential would be a credential that travels.
 *
 * # Product language
 *
 * The relay is **hosted in the tournament's Cloudflare account**. QBSheet does not operate it,
 * does not receive its traffic, and needs no QBSheet account. The copy constants below keep
 * every surface that talks about the relay using that language.
 */

/** The scoresheet origin pairing links launch into. Matches the native server's builder. */
export const scoresheetOrigin = 'https://qbsheet.com';

export const relayKeychainService = 'com.qbsheet.director.qbtcp-relay';

/**
 * What Director persists (in the tournament document) about an Internet QBTCP relay.
 * Pointers only — never a credential, never a setup token, never a pairing code.
 */
export interface RelayConfig {
  /** Whether Director publishes to and syncs from the relay. */
  enabled: boolean;
  /** The relay origin, e.g. `https://qbtcp-relay-abc.workers.dev`. Normalized, no trailing slash. */
  baseUrl: string;
  /** The tournament's relay id. Names one Durable Object on the deployment. */
  tournamentId: string;
  /** The local Director tournament this pointer belongs to. Absent only on pre-runtime configs. */
  directorTournamentId?: string;
  /** Which keychain account holds the management credential. Always the tournament id. */
  keychainAccount: string;
  /** Set when the relay origin is a custom domain rather than `workers.dev`. */
  customDomain: boolean;
  /** ISO timestamp of the successful claim. */
  claimedAt: string | null;
  /** ISO timestamp of the last successful management contact. */
  lastContactAt: string | null;
}

/** A relay configuration that has never been claimed. */
export function unclaimedRelayConfig(): RelayConfig {
  return {
    enabled: false,
    baseUrl: '',
    tournamentId: '',
    keychainAccount: '',
    customDomain: false,
    claimedAt: null,
    lastContactAt: null,
  };
}

/**
 * Tournament ids name Durable Objects a stranger can address, so the alphabet is bounded.
 * This is the same rule the relay enforces (`isTournamentId` in
 * `apps/qbtcp-relay-backend-cloudflare/src/relay.ts`): 24 lowercase consonants and digits.
 */
export function isRelayTournamentId(value: string): boolean {
  return /^[0-9b-df-hj-np-tv-z]{24}$/.test(value);
}

export type RelayBaseUrlResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Normalize a relay origin typed or pasted by a director.
 *
 * Requires HTTPS on a bare origin: no path, no query, no fragment, no credentials. The normal
 * path needs no custom domain — a `workers.dev` origin is accepted as-is — and a custom domain
 * is allowed as an explicitly marked advanced setting, never silently.
 */
export function normalizeRelayBaseUrl(input: string): RelayBaseUrlResult {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false, error: 'Enter the relay address from Cloudflare.' };
  if (trimmed.length > 256) return { ok: false, error: 'That relay address is too long.' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'That relay address is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'The relay address must be an https:// URL.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'The relay address must not contain credentials.' };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, error: 'Enter just the relay origin, with no path.' };
  }
  if (url.search || url.hash) {
    return { ok: false, error: 'Enter just the relay origin, with nothing after the hostname.' };
  }
  return { ok: true, value: `${url.protocol}//${url.host}` };
}

/** True for the zero-config path: a `workers.dev` origin needs no custom domain. */
export function isWorkersDevOrigin(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('.workers.dev');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Product copy
// ---------------------------------------------------------------------------

export const relayOwnershipExplainer =
  'The tournament relay runs in a Cloudflare account controlled by the tournament — ' +
  'not on QBSheet servers. QBSheet does not operate it, does not receive its traffic, and ' +
  'requires no QBSheet account.';

export const relayFailureBudgetWarning =
  'Do not rely on the same Workers Free request budget for high-traffic spectator Workers ' +
  'and Internet QBTCP. A busy spectator Worker and scoring share one account-level allowance; ' +
  'when it is exhausted, scoring stops with it. Prefer the self-hosted QBServer for QBLive, ' +
  'or isolate scoring in its own Cloudflare account or paid capacity if you intentionally run ' +
  'other high-volume Workers.';

export const relayQbliveRecommendation =
  'Run QBLive from the self-hosted QBServer rather than from a Worker in the same Cloudflare ' +
  'account as Internet QBTCP. Spectator traffic must never be able to consume the request ' +
  'budget that keeps scorers connected.';

export const relaySetupTokenHint =
  'The one-time setup secret from deployment. It is exchanged once for a management ' +
  'credential that stays in this computer\u2019s keychain — never in the tournament file, ' +
  'a URL, a QR code, or an export. After the exchange the setup secret is worthless.';

export const relayCredentialLostRecovery =
  'If the management credential is lost, export any unacknowledged relay finals, destroy the ' +
  'relay tournament, and claim again with the setup secret. Director refuses a silent destroy ' +
  'while unacknowledged finals remain.';
