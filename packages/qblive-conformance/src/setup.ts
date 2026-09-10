/**
 * The standard setup/claim hook for testing an arbitrary QBLive backend.
 *
 * The conformance suite itself never creates state: pointed at a live
 * tournament without a management token its management checks skip, so a
 * director learns something without risking anything. Pointed at a fresh
 * backend with a setup secret — Cloudflare's `QBLIVE_SETUP_TOKEN`, QBServer's
 * configured setup secret, or a test stub's — this hook performs the one-time
 * claim and the first publish, returning the credential the suite needs.
 *
 * Nothing here depends on Durable Object internals, Wrangler bindings,
 * Cloudflare-specific headers, a specific database, or Director-native APIs.
 * It speaks observable QBLive behavior only, which is what makes the suite
 * runnable against a non-Cloudflare backend.
 */

export interface SetupBackendOptions {
  origin: string;
  /** The deployment's one-time setup secret (never part of the protocol). */
  setupToken: string;
  publicationId: string;
  /** The first snapshot to publish after claiming. Skipped when omitted. */
  initialSnapshot?: unknown;
  fetchImpl?: typeof fetch;
}

export interface SetupBackendResult {
  origin: string;
  publicationId: string;
  managementToken: string;
}

/**
 * Claim a freshly deployed backend and optionally publish its first snapshot.
 *
 * The claim/setup exchange is the same on every host: `POST
 * /qblive/v1/manage/claim` with `{ setupToken, publicationId }` answers
 * `{ managementToken }` exactly once. How the deployment supplies its setup
 * secret — Cloudflare environment variable, QBServer config file, test
 * constant — is host-specific and not part of the protocol.
 */
export async function setupBackend(options: SetupBackendOptions): Promise<SetupBackendResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const origin = options.origin.replace(/\/$/, '');
  const claimResponse = await doFetch(`${origin}/qblive/v1/manage/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      setupToken: options.setupToken,
      publicationId: options.publicationId,
    }),
  });
  if (!claimResponse.ok) {
    const detail = await claimResponse.text().catch(() => '');
    throw new Error(
      `claiming ${options.publicationId} answered ${claimResponse.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const claimed = (await claimResponse.json()) as { managementToken?: unknown };
  if (typeof claimed.managementToken !== 'string' || claimed.managementToken.length === 0) {
    throw new Error('the backend did not return a management credential');
  }
  const managementToken = claimed.managementToken;

  if (options.initialSnapshot !== undefined) {
    const publishResponse = await doFetch(
      `${origin}/qblive/v1/manage/tournaments/${encodeURIComponent(options.publicationId)}/snapshot`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${managementToken}`,
        },
        body: JSON.stringify({ snapshot: options.initialSnapshot }),
      },
    );
    if (!publishResponse.ok) {
      throw new Error(`publishing the initial snapshot answered ${publishResponse.status}`);
    }
  }

  return { origin, publicationId: options.publicationId, managementToken };
}

/**
 * A random valid publication id for ephemeral test backends.
 *
 * Twenty characters from the QBLive alphabet, from a CSPRNG. Ephemeral runs
 * claim a fresh id so lifecycle checks (finalize, unpublish, delete) never
 * touch a real tournament.
 */
export function randomPublicationId(random: () => number = Math.random): string {
  const alphabet = '0123456789bcdfghjkmnpqrstvwxyz';
  let id = '';
  for (let index = 0; index < 20; index += 1) {
    id += alphabet[Math.floor(random() * alphabet.length)];
  }
  return id;
}
