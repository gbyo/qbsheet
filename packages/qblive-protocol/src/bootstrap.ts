/**
 * The QBSheet Live bootstrap URL: the one thing a QR code contains.
 *
 * ```
 * https://live.qbsheet.com/t/<publicationId>?b=<backend>&v=1
 * ```
 *
 * # What is and is not in here
 *
 * Public routing information only: which tournament, and which server holds it. No management
 * token, no QBTCP credential, no APNs publisher secret, no private tournament token. A QR code is
 * photographed by strangers and reposted; treating it as a bearer credential for anything would be
 * a mistake that cannot be walked back once the code is printed.
 *
 * `live.qbsheet.com` is a *bootstrap*, not a proxy. It tells the client where the tournament's own
 * backend is and then gets out of the way — every byte of tournament data is fetched from `b`.
 */

export const QBLIVE_BOOTSTRAP_VERSION = 1;

/** The official invocation domain. Also the only domain the official App Clip is associated with. */
export const QBLIVE_OFFICIAL_ORIGIN = 'https://live.qbsheet.com';

export interface QbliveBootstrap {
  version: number;
  publicationId: string;
  /** The tournament backend origin, already validated. No trailing slash. */
  backendOrigin: string;
}

export class QbliveBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QbliveBootstrapError';
  }
}

/** A generous ceiling that still keeps a printed QR code inside a scannable version. */
const maxBootstrapUrlLength = 512;
const maxBackendOriginLength = 255;

const publicationIdPattern = /^[0-9bcdfghjkmnpqrstvwxyz]{20}$/;

/**
 * Validate a backend origin hard enough to hand to `fetch`.
 *
 * The rules exist for specific attacks. `javascript:`/`data:`/`file:` are refused because the value
 * arrives from a QR code a stranger printed. Embedded userinfo is refused because a credential must
 * never travel in a bootstrap URL, and accepting one would quietly make the QR a bearer token. A
 * path is refused because the QBLive routes are appended to this origin and a base path would let a
 * crafted value redirect them.
 *
 * Plain HTTP is allowed only for loopback and RFC 1918 addresses, which is what Director's
 * local-only LAN mode actually is: a gym with no internet and a laptop on 192.168.1.20.
 */
export function assertPublicBackendOrigin(
  value: string,
  options: { allowInsecureLan?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QbliveBootstrapError('A QBSheet Live backend address is required.');
  }
  if (value.length > maxBackendOriginLength) {
    throw new QbliveBootstrapError('That QBSheet Live backend address is too long.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QbliveBootstrapError('That QBSheet Live backend address is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new QbliveBootstrapError('A QBSheet Live backend address must not contain a username or password.');
  }
  if (url.search || url.hash) {
    throw new QbliveBootstrapError('A QBSheet Live backend address must not contain a query or fragment.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new QbliveBootstrapError('A QBSheet Live backend address must be an origin without a path.');
  }
  if (url.protocol === 'https:') return `${url.protocol}//${url.host}`;
  if (url.protocol === 'http:' && options.allowInsecureLan && isLocalHost(url.hostname)) {
    return `${url.protocol}//${url.host}`;
  }
  throw new QbliveBootstrapError('A QBSheet Live backend address must use HTTPS.');
}

/** Loopback and the private ranges. Deliberately narrow: anything else must be HTTPS. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function isPublicationId(value: string): boolean {
  return publicationIdPattern.test(value);
}

/**
 * Build the bootstrap URL a Director prints.
 *
 * The backend origin is percent-encoded into `b` rather than shortened, because a QBLive server can
 * be anywhere and a QBSheet-operated shortener would put QBSheet back in the path of every scan.
 */
export function buildBootstrapUrl(
  bootstrap: Omit<QbliveBootstrap, 'version'> & { version?: number },
  officialOrigin = QBLIVE_OFFICIAL_ORIGIN,
): string {
  if (!isPublicationId(bootstrap.publicationId)) {
    throw new QbliveBootstrapError('That is not a valid QBSheet Live publication identifier.');
  }
  const backend = assertPublicBackendOrigin(bootstrap.backendOrigin, { allowInsecureLan: true });
  const url = new URL(`/t/${bootstrap.publicationId}`, officialOrigin);
  url.searchParams.set('b', backend);
  url.searchParams.set('v', String(bootstrap.version ?? QBLIVE_BOOTSTRAP_VERSION));
  const built = url.toString();
  if (built.length > maxBootstrapUrlLength) {
    throw new QbliveBootstrapError('That QBSheet Live link is too long to encode in a QR code.');
  }
  return built;
}

/**
 * Parse a bootstrap URL.
 *
 * Accepts the official host and a self-hosted Live Web deployment alike: the path and query carry
 * the meaning, and the host only decides whether the official App Clip can be invoked.
 */
export function parseBootstrapUrl(value: string): QbliveBootstrap {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxBootstrapUrlLength) {
    throw new QbliveBootstrapError('That is not a QBSheet Live link.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new QbliveBootstrapError('That is not a QBSheet Live link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new QbliveBootstrapError('That is not a QBSheet Live link.');
  }
  const match = /^\/t\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) throw new QbliveBootstrapError('That QBSheet Live link does not name a tournament.');
  let publicationId: string;
  try {
    publicationId = decodeURIComponent(match[1]);
  } catch {
    throw new QbliveBootstrapError('That QBSheet Live link does not name a valid tournament.');
  }
  if (!isPublicationId(publicationId)) {
    throw new QbliveBootstrapError('That QBSheet Live link does not name a valid tournament.');
  }
  const rawVersion = url.searchParams.get('v');
  const version = rawVersion === null ? QBLIVE_BOOTSTRAP_VERSION : Number(rawVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new QbliveBootstrapError('That QBSheet Live link uses an unknown format.');
  }
  if (version > QBLIVE_BOOTSTRAP_VERSION) {
    throw new QbliveBootstrapError('That QBSheet Live link needs a newer version of QBSheet Live.');
  }
  const backend = url.searchParams.get('b');
  if (!backend) throw new QbliveBootstrapError('That QBSheet Live link does not name a tournament server.');
  return {
    version,
    publicationId,
    backendOrigin: assertPublicBackendOrigin(backend, { allowInsecureLan: true }),
  };
}

/** The QBLive route for a public document on a backend origin. */
export function qbliveUrl(backendOrigin: string, publicationId: string, path: string): string {
  const base = backendOrigin.replace(/\/$/, '');
  return `${base}/qblive/v1/tournaments/${encodeURIComponent(publicationId)}/${path.replace(/^\//, '')}`;
}
