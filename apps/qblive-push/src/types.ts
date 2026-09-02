/**
 * What the push gateway accepts and enqueues.
 *
 * Note what is absent: there is no route that takes an APNs payload. A publisher describes an
 * *intent* — this shard's state changed, publish this announcement, end these activities — and the
 * gateway constructs the APNs request itself. Accepting arbitrary APNs JSON would make the gateway
 * a way to send anything at all as QBSheet Live.
 */

export type PushClientKind = 'app' | 'app-clip';

/** One team's compact state. Mirrors `packages/qblive-activity`; see that package for the field names. */
export interface ShardTeamState {
  i: number;
  m: 0 | 1 | 2 | 3;
  o?: number;
  on?: string;
  s?: number;
  x?: number;
  u?: number;
  rm?: string;
  rd?: number;
  st?: number;
  ev?: string;
}

export interface ShardState {
  r: number;
  t: ShardTeamState[];
}

/** A publisher's request to update one shard's Live Activities. */
export interface ShardUpdateRequest {
  publicationId: string;
  shard: number;
  state: ShardState;
  /**
   * `routine` coalesces; `transition` sends promptly.
   *
   * A score change is routine. A game starting, a game going final, and a room change shortly
   * before a game are transitions. Using high priority for a score tick would spend the
   * publishing budget and the device's battery on something nobody is waiting for.
   */
  urgency: 'routine' | 'transition';
}

export interface AnnouncementRequest {
  publicationId: string;
  title: string;
  body: string;
  severity: 'information' | 'important' | 'urgent';
  /** Empty means everybody. */
  audienceTeamIds: string[];
}

export type PushJob =
  | {
      kind: 'shard';
      publicationId: string;
      shard: number;
      state: ShardState;
      urgency: 'routine' | 'transition';
    }
  | {
      kind: 'announcement';
      publicationId: string;
      title: string;
      body: string;
      severity: string;
      audienceTeamIds: string[];
    }
  | { kind: 'end'; publicationId: string };

/** Bounds. Past these a request is a mistake or an attack, and either way the answer is 4xx. */
export const pushLimits = {
  maxTeamsPerShard: 32,
  maxShardsPerPublication: 64,
  maxBodyBytes: 64 * 1024,
  maxAnnouncementTitle: 256,
  maxAnnouncementBody: 2048,
  maxAudienceTeams: 512,
  maxDeviceTokensPerPublication: 20_000,
  /** Apple's documented ceiling is 10,000 per app per environment. This leaves a reserve. */
  globalChannelCeiling: 8000,
  /** A tournament day plus a wide margin. Past this a channel is reclaimed. */
  channelLifetimeMs: 36 * 60 * 60 * 1000,
} as const;
