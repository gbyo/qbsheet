/**
 * APNs broadcast channel lifecycle, and the global budget.
 *
 * # The interface exists to be replaceable
 *
 * Channel create/read/delete is the only APNs path on a non-standard port, and the only part of
 * this service whose transport is unproven on the deployed edge (see
 * `docs/QBLIVE_PUSH_PROTOTYPE.md`). Putting it behind one interface means that if Cloudflare turns
 * out not to reach port 2196, the fix is a second implementation of *this file's* contract — not a
 * redesign. Everything else, including all broadcast sending, is on port 443 and unaffected.
 * `ExternalChannelManager` below is that second implementation.
 */

import { apnsHosts, MessageStoragePolicy, type ApnsEnvironment } from './apns';

export interface ChannelManager {
  create(publicationId: string, shard: number): Promise<string>;
  delete(channelId: string): Promise<void>;
  /** Every channel Apple currently holds for this app. Used by the reconciler. */
  list(): Promise<string[]>;
}

export class ChannelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export interface ApnsChannelManagerOptions {
  environment: ApnsEnvironment;
  bundleId: string;
  /** Asked for a token per operation, so a rotation between calls is picked up. */
  providerToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Apple's channel-management API.
 *
 * `POST /1/apps/{bundleId}/channels` → `201` with the id in `apns-channel-id`.
 * `DELETE` the same path with `apns-channel-id` → `204`.
 * `GET /1/apps/{bundleId}/all-channels` → the ids Apple holds.
 */
export class ApnsChannelManager implements ChannelManager {
  constructor(private readonly options: ApnsChannelManagerOptions) {}

  private get base(): string {
    return `${apnsHosts[this.options.environment].manage}/1/apps/${encodeURIComponent(this.options.bundleId)}`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      authorization: `bearer ${await this.options.providerToken()}`,
      'apns-request-id': crypto.randomUUID(),
      ...extra,
    };
  }

  async create(publicationId: string, shard: number): Promise<string> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.base}/channels`, {
        method: 'POST',
        headers: await this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          'message-storage-policy': MessageStoragePolicy.MostRecentMessageStored,
          'push-type': 'LiveActivity',
        }),
      });
    } catch (error) {
      // The transport failure the prototype exists to characterise: the request never reached
      // Apple. Retryable, because it is also what a transient network fault looks like.
      throw new ChannelError(
        `Apple's channel-management endpoint could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    if (response.status !== 201) {
      const reason = await reasonOf(response);
      throw new ChannelError(
        `Apple refused a channel for publication ${publicationId} shard ${shard}: ${response.status} ${reason ?? ''}`.trim(),
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const channelId = response.headers.get('apns-channel-id');
    if (!channelId) {
      throw new ChannelError('Apple created a channel but returned no channel id.', false, response.status);
    }
    // Opaque and of unspecified length, as Apple's documentation asks. Never parsed.
    return channelId;
  }

  async delete(channelId: string): Promise<void> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.base}/channels`, {
        method: 'DELETE',
        headers: await this.headers({ 'apns-channel-id': channelId }),
      });
    } catch (error) {
      throw new ChannelError(
        `Apple's channel-management endpoint could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    // 404 means Apple has already forgotten it, which is the state deletion was aiming for.
    if (response.status !== 204 && response.status !== 404) {
      throw new ChannelError(
        `Apple refused to delete a channel: ${response.status}`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
  }

  async list(): Promise<string[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.base}/all-channels`, {
        method: 'GET',
        headers: await this.headers(),
      });
    } catch (error) {
      throw new ChannelError(
        `Apple's channel-management endpoint could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    if (!response.ok) {
      throw new ChannelError(
        `Apple refused to list channels: ${response.status}`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const body = (await response.json()) as { channels?: unknown };
    return Array.isArray(body.channels)
      ? body.channels.filter((id): id is string => typeof id === 'string')
      : [];
  }
}

/**
 * The fallback: forward channel lifecycle to a small external service.
 *
 * Exists so that the conclusion of `docs/QBLIVE_PUSH_PROTOTYPE.md` — whichever way it goes — is a
 * configuration change rather than a rewrite. If the deployed edge cannot reach port 2196, set
 * `EXTERNAL_CHANNEL_MANAGER_URL` to a Lambda holding the same APNs key and the rest of this Worker
 * is untouched: publisher auth, the publication objects, dedup, coalescing, the Queue, and every
 * broadcast send.
 */
export class ExternalChannelManager implements ChannelManager {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(action: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/${action}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ChannelError(
        `The external channel manager could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        true,
      );
    }
    if (!response.ok) {
      throw new ChannelError(
        `The external channel manager answered ${response.status}.`,
        response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  async create(publicationId: string, shard: number): Promise<string> {
    const body = await this.call<{ channelId?: string }>('create', { publicationId, shard });
    if (!body.channelId)
      throw new ChannelError('The external channel manager returned no channel id.', false);
    return body.channelId;
  }

  async delete(channelId: string): Promise<void> {
    await this.call<unknown>('delete', { channelId });
  }

  async list(): Promise<string[]> {
    const body = await this.call<{ channels?: string[] }>('list', {});
    return body.channels ?? [];
  }
}

// ---------------------------------------------------------------------------
// The global budget
// ---------------------------------------------------------------------------

export interface ChannelAllocation {
  publicationId: string;
  shard: number;
  channelId: string;
  createdAt: number;
  expiresAt: number;
}

export type AllocationOutcome =
  | { granted: true; channelId: string; reused: boolean }
  /**
   * Refused, and QBSheet Live still works.
   *
   * The client's response is to fall back to foreground realtime and say so. Nothing else degrades:
   * the app, the App Clip, the web client, schedules, standings, statistics and results are all
   * unaffected. See `docs/QBLIVE.md#132-channel-sharding`.
   */
  | {
      granted: false;
      reason: 'budget-exhausted' | 'per-publication-limit' | 'apple-refused';
      detail: string;
    };

/**
 * How many shards a publication may hold channels for.
 *
 * Derived from the team count rather than fixed, so a publication cannot request a thousand
 * channels for a four-team tournament. A publication that inflates its team count still runs into
 * the per-publication ceiling and then the global one.
 */
export function allowedShards(teamCount: number, teamsPerShard: number, ceiling: number): number {
  if (teamCount <= 0) return 0;
  return Math.min(ceiling, Math.ceil(teamCount / Math.max(1, teamsPerShard)));
}

/** Apple's error `reason`, when the body has one. */
async function reasonOf(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { reason?: string };
    return typeof body.reason === 'string' ? body.reason : null;
  } catch {
    return null;
  }
}
