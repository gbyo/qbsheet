/**
 * Disabling Internet QBTCP: stop syncing without losing anything.
 *
 * # Two different operations
 *
 * **Disable** is local and always safe: Director stops publishing to and syncing from the
 * relay, local/LAN QBTCP keeps serving the same rooms, and nothing on the relay is touched.
 * Scorer games continue — locally, over LAN, or wherever #772's transport currently has them.
 *
 * **Destroy** deletes the remote tournament (relay state, retained finals, credentials) and
 * is fenced: while the relay holds finals Director has not ingested, destroy is refused
 * unless the operator exports them first and confirms an explicit override. There is no
 * silent path from "turn off Internet QBTCP" to "discard a final nobody has seen."
 */

export interface RelayRetention {
  resultsUnacked: number;
  helpOpen: number;
  /** True when the unacked-results page filled up: the count is a lower bound, not exact. */
  resultsTruncated: boolean;
}

export type RelayTeardownPlan =
  | {
      kind: 'destroy-blocked';
      /** Why the destroy must not proceed. */
      reason: string;
      /** What the operator must do first, in order. */
      required: string[];
    }
  | {
      kind: 'destroy-allowed';
      /** Advisory concerns that do not block but must be shown with the confirm step. */
      advisories: string[];
    };

/**
 * Decide whether a remote destroy may proceed.
 *
 * Unacknowledged finals block unconditionally without an export-plus-override: they are the
 * records the relay exists to protect. Open help requests do not block — they are
 * operational, not results — but they must be shown so the confirm step is reviewed, not
 * clicked through.
 */
export function planRelayDestroy(
  retention: RelayRetention,
  override: { exported: boolean; confirmed: boolean } = { exported: false, confirmed: false },
): RelayTeardownPlan {
  if (retention.resultsUnacked > 0 && !(override.exported && override.confirmed)) {
    const finals =
      retention.resultsUnacked === 1
        ? '1 final'
        : retention.resultsTruncated
          ? `${retention.resultsUnacked} or more finals`
          : `${retention.resultsUnacked} finals`;
    return {
      kind: 'destroy-blocked',
      reason:
        `The relay still holds ${finals} Director has not ingested. ` +
        'Destroying it now would discard results no one has reviewed.',
      required: [
        'Export the unacknowledged finals from the relay (recovery path).',
        'Ingest the export through the normal Results pipeline, or confirm it is safely recorded elsewhere.',
        'Confirm the destroy explicitly, understanding retained relay state will be deleted.',
      ],
    };
  }
  const advisories: string[] = [];
  if (retention.helpOpen > 0) {
    const items = retention.helpOpen === 1 ? '1 help request' : `${retention.helpOpen} help requests`;
    advisories.push(`The relay still holds ${items} marked open. They will be deleted with the tournament.`);
  }
  if (retention.resultsUnacked > 0) {
    advisories.push(
      'Unacknowledged finals were exported and the destroy was explicitly confirmed. Deleting retained relay state now.',
    );
  }
  return { kind: 'destroy-allowed', advisories };
}

/** What a local disable promises: LAN keeps working, the relay keeps its state. */
export const relayDisablePromise =
  'Disabling Internet QBTCP stops Director publication and sync. Local and LAN QBTCP keep ' +
  'serving the same rooms, local scorer games are untouched, and the relay keeps whatever it ' +
  'retains until you explicitly revoke or destroy it.';

function manageBase(baseUrl: string, tournamentId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/qbtcp/v1/manage/tournaments/${tournamentId}`;
}

function countResults(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const results = (value as Record<string, unknown>).results;
  if (Array.isArray(results)) return results.length;
  const count = (value as Record<string, unknown>).count;
  return typeof count === 'number' ? count : null;
}

function countHelp(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.requests)) return record.requests.length;
  if (Array.isArray(record.help)) return record.help.length;
  return typeof record.count === 'number' ? record.count : null;
}

export class RelayTeardownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayTeardownError';
  }
}

/**
 * Read how much the relay still retains. Counts only — the QBJ bodies stay on the relay
 * until the sync engine ingests them; a teardown check must not pull payloads it will not
 * use. Reads page at 128 rows; a full page means "128 or more," which still blocks.
 */
export async function fetchRelayRetention(
  baseUrl: string,
  tournamentId: string,
  managementToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayRetention> {
  const headers = { authorization: `Bearer ${managementToken}` };
  let resultsResponse: Response;
  let helpResponse: Response;
  try {
    [resultsResponse, helpResponse] = await Promise.all([
      fetchImpl(`${manageBase(baseUrl, tournamentId)}/results?state=unacked&limit=128`, { headers }),
      fetchImpl(`${manageBase(baseUrl, tournamentId)}/help?state=open`, { headers }),
    ]);
  } catch {
    throw new RelayTeardownError('The relay could not be reached to check retained state.');
  }
  if (resultsResponse.status === 401 || helpResponse.status === 401) {
    throw new RelayTeardownError('The stored relay credential was refused.');
  }
  if (!resultsResponse.ok || !helpResponse.ok) {
    throw new RelayTeardownError('The relay retention check failed.');
  }
  const resultsUnacked = countResults(await resultsResponse.json().catch(() => null));
  const helpOpen = countHelp(await helpResponse.json().catch(() => null));
  if (resultsUnacked === null || helpOpen === null) {
    throw new RelayTeardownError(
      'The relay answered retention with shapes this Director does not understand.',
    );
  }
  return { resultsUnacked, helpOpen, resultsTruncated: resultsUnacked >= 128 };
}

/**
 * Destroy the remote tournament. The planner decides; this only executes an allowed plan.
 * Refuses to send the DELETE for a blocked plan even if the caller forgot to check.
 */
export async function destroyRelayTournament(
  baseUrl: string,
  tournamentId: string,
  managementToken: string,
  plan: RelayTeardownPlan,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (plan.kind !== 'destroy-allowed') {
    throw new RelayTeardownError(plan.reason);
  }
  let response: Response;
  try {
    response = await fetchImpl(manageBase(baseUrl, tournamentId), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${managementToken}` },
    });
  } catch {
    throw new RelayTeardownError('The relay could not be reached to destroy the tournament.');
  }
  if (response.status === 401) {
    throw new RelayTeardownError('The stored relay credential was refused.');
  }
  if (!response.ok) {
    throw new RelayTeardownError(`Destroying the relay tournament failed (${response.status}).`);
  }
}
