/**
 * Internet QBTCP setup validation: prove the relay works before saying so.
 *
 * # What "ready" requires
 *
 * Every step must pass, in order: the HTTPS endpoint answers, discovery identifies a
 * compatible QBTCP relay, the management credential is accepted, an initial state
 * publication lands, and the realtime endpoint is reachable from a browser-compatible probe.
 * A bare HTTP 200 from the root proves none of that, so it never marks setup successful on
 * its own.
 *
 * # Boundaries
 *
 * The publication step is injected: the relay sync engine (#773) owns the ongoing mirror
 * projection, and setup only needs one initial publication to prove the path. The default
 * publishes a bootstrap mirror document the caller assembles (empty rooms/sessions on a fresh
 * claim, or the current room list when available). Later sync revisions supersede it under the
 * relay's `(director_epoch, revision)` fencing.
 */

export type RelaySetupStepKey = 'reachable' | 'discovery' | 'management' | 'publication' | 'stream';

export interface RelaySetupStep {
  key: RelaySetupStepKey;
  ok: boolean;
  message: string;
}

export interface RelaySetupReport {
  ready: boolean;
  steps: RelaySetupStep[];
}

export class RelaySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelaySetupError';
  }
}

/** The discovery fields setup acts on. Unknown fields are ignored per the v1 rule. */
export interface RelayDiscoveryView {
  version: number;
  capabilities: string[];
  retainsFinals: boolean;
  mirrorsAssignment: boolean;
  streamEndpoint: string | null;
}

export function readRelayDiscoveryView(value: unknown): RelayDiscoveryView | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.protocol !== 'QBTCP') return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version)) return null;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const stream =
    typeof record.stream === 'object' && record.stream !== null
      ? (record.stream as Record<string, unknown>)
      : null;
  return {
    version: record.version,
    capabilities,
    retainsFinals: stream?.retains_finals === true,
    mirrorsAssignment: stream?.mirrors_assignment === true,
    streamEndpoint: typeof stream?.endpoint === 'string' ? stream.endpoint : null,
  };
}

function tournamentBase(baseUrl: string, tournamentId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/tournaments/${tournamentId}`;
}

function manageBase(baseUrl: string, tournamentId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/tournaments/${tournamentId}`;
}

async function readJsonSafe(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** Step 1: the HTTPS endpoint answers as a QBTCP relay. */
export async function probeRelayReachable(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySetupStep> {
  const key: RelaySetupStepKey = 'reachable';
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`);
  } catch {
    return { key, ok: false, message: 'The relay address could not be reached.' };
  }
  const body = (await readJsonSafe(response)) as { service?: string; protocolVersion?: number } | null;
  if (response.ok && body?.service === 'qbtcp-relay' && body?.protocolVersion === 1) {
    return { key, ok: true, message: 'Relay reachable.' };
  }
  return { key, ok: false, message: `That address did not answer as a QBTCP relay (${response.status}).` };
}

/** Step 2: discovery identifies a compatible relay. Anything but protocol v1 is blocked. */
export async function probeRelayDiscovery(
  baseUrl: string,
  tournamentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySetupStep & { discovery?: RelayDiscoveryView }> {
  const key: RelaySetupStepKey = 'discovery';
  let response: Response;
  try {
    response = await fetchImpl(`${tournamentBase(baseUrl, tournamentId)}/discovery`);
  } catch {
    return { key, ok: false, message: 'The relay discovery check could not be reached.' };
  }
  if (response.status === 404) {
    return { key, ok: false, message: 'That tournament is not on this relay. Claim it first.' };
  }
  const view = readRelayDiscoveryView(await readJsonSafe(response));
  if (!response.ok || !view) {
    return { key, ok: false, message: `The relay discovery check failed (${response.status}).` };
  }
  if (view.version !== 1) {
    return {
      key,
      ok: false,
      message: `That relay speaks protocol version ${view.version}, which this Director does not support.`,
    };
  }
  if (!view.capabilities.includes('stream')) {
    return { key, ok: false, message: 'That relay does not offer the realtime stream.' };
  }
  if (!view.retainsFinals || !view.mirrorsAssignment) {
    return { key, ok: false, message: 'That relay does not retain finals or mirror assignments.' };
  }
  return { key, ok: true, message: 'Relay protocol and capabilities confirmed.', discovery: view };
}

/** Step 3: the management credential is accepted. */
export async function probeRelayManagement(
  baseUrl: string,
  tournamentId: string,
  managementToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySetupStep> {
  const key: RelaySetupStepKey = 'management';
  let response: Response;
  try {
    response = await fetchImpl(`${manageBase(baseUrl, tournamentId)}/health`, {
      headers: { authorization: `Bearer ${managementToken}` },
    });
  } catch {
    return { key, ok: false, message: 'The relay management check could not be reached.' };
  }
  if (response.status === 401) {
    return { key, ok: false, message: 'The stored relay credential was refused. Re-claim or rotate it.' };
  }
  if (response.status === 403) {
    return { key, ok: false, message: 'That relay has not been claimed yet.' };
  }
  if (!response.ok) {
    return { key, ok: false, message: `The relay management check failed (${response.status}).` };
  }
  const body = (await readJsonSafe(response)) as { protocolVersion?: number } | null;
  if (body?.protocolVersion !== 1) {
    return {
      key,
      ok: false,
      message: 'That relay speaks a protocol version this Director does not support.',
    };
  }
  return { key, ok: true, message: 'Management connection confirmed.' };
}

export interface SetupMirrorDocument {
  director_epoch: number;
  revision: number;
  rooms: unknown[];
  sessions: unknown[];
}

/**
 * Step 4: an initial state publication lands.
 *
 * The default publishes the caller's bootstrap document (empty on a fresh claim). The relay
 * fences on `(director_epoch, revision)`, so the later sync engine supersedes this with higher
 * revisions; setup only proves the management credential can actually write.
 */
export async function probeRelayPublication(
  baseUrl: string,
  tournamentId: string,
  managementToken: string,
  document: SetupMirrorDocument,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySetupStep> {
  const key: RelaySetupStepKey = 'publication';
  let response: Response;
  try {
    response = await fetchImpl(`${manageBase(baseUrl, tournamentId)}/mirror`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${managementToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        director_epoch: document.director_epoch,
        revision: document.revision,
        rooms: document.rooms,
        sessions: document.sessions,
      }),
    });
  } catch {
    return { key, ok: false, message: 'The initial state publication could not be reached.' };
  }
  if (response.status === 401) {
    return { key, ok: false, message: 'The stored relay credential was refused during publication.' };
  }
  if (response.status === 409) {
    return {
      key,
      ok: false,
      message: 'The relay holds newer state than this setup. Reconcile before continuing.',
    };
  }
  if (!response.ok) {
    return { key, ok: false, message: `The initial state publication failed (${response.status}).` };
  }
  return { key, ok: true, message: 'Initial state published.' };
}

/**
 * Step 5: the realtime endpoint is reachable from a browser-compatible probe.
 *
 * A plain HTTPS fetch cannot open a WebSocket, but it can prove the stream route is deployed:
 * the relay answers a non-upgrade request to the stream endpoint with an explicit
 * upgrade-required error. Only that answer — not any HTTP 200 elsewhere — passes this step.
 */
export async function probeRelayStream(
  baseUrl: string,
  tournamentId: string,
  streamEndpoint: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySetupStep> {
  const key: RelaySetupStepKey = 'stream';
  // The endpoint is relay-relative; join it to the configured origin rather than trusting it
  // as an absolute URL, so a hostile or stale descriptor cannot redirect the probe.
  const path =
    streamEndpoint &&
    streamEndpoint.startsWith('/') &&
    !streamEndpoint.includes('?') &&
    !streamEndpoint.includes('#')
      ? streamEndpoint
      : `/qbtcp/v1/tournaments/${tournamentId}/stream`;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return { key, ok: false, message: 'The realtime endpoint could not be reached.' };
  }
  const body = (await readJsonSafe(response)) as { error?: string; message?: string } | null;
  const text = `${body?.error ?? ''} ${body?.message ?? ''}`.toLowerCase();
  if ((response.status === 400 || response.status === 426) && text.includes('websocket')) {
    return { key, ok: true, message: 'Realtime endpoint reachable.' };
  }
  if (response.status === 404) {
    return { key, ok: false, message: 'The realtime endpoint is not on this relay.' };
  }
  return {
    key,
    ok: false,
    message: `The realtime endpoint did not answer as expected (${response.status}).`,
  };
}

export interface RelaySetupValidationInput {
  baseUrl: string;
  tournamentId: string;
  managementToken: string;
  /** Bootstrap mirror document for the publication step. */
  mirrorDocument: SetupMirrorDocument;
  fetchImpl?: typeof fetch;
}

/**
 * Run the full setup validation. Steps run in order and short-circuit on the first failure:
 * there is no point checking management auth when discovery already failed. `ready` is true
 * only when every step — including publication and the realtime probe — passes.
 */
export async function runRelaySetupValidation(input: RelaySetupValidationInput): Promise<RelaySetupReport> {
  const doFetch = input.fetchImpl ?? fetch;
  const steps: RelaySetupStep[] = [];

  const reachable = await probeRelayReachable(input.baseUrl, doFetch);
  steps.push(reachable);
  if (!reachable.ok) return { ready: false, steps };

  const discovery = await probeRelayDiscovery(input.baseUrl, input.tournamentId, doFetch);
  steps.push(discovery);
  if (!discovery.ok) return { ready: false, steps };

  const management = await probeRelayManagement(
    input.baseUrl,
    input.tournamentId,
    input.managementToken,
    doFetch,
  );
  steps.push(management);
  if (!management.ok) return { ready: false, steps };

  const publication = await probeRelayPublication(
    input.baseUrl,
    input.tournamentId,
    input.managementToken,
    input.mirrorDocument,
    doFetch,
  );
  steps.push(publication);
  if (!publication.ok) return { ready: false, steps };

  const stream = await probeRelayStream(
    input.baseUrl,
    input.tournamentId,
    discovery.discovery?.streamEndpoint ?? null,
    doFetch,
  );
  steps.push(stream);
  if (!stream.ok) return { ready: false, steps };

  return { ready: true, steps };
}
