/**
 * The compact shard state carried in an ActivityKit broadcast payload.
 *
 * # Why this is its own package
 *
 * Three things have to agree byte for byte about this shape: the push gateway that encodes it, the
 * Swift `ContentState` that decodes it, and the size test that decides how many teams fit in a
 * shard. Putting it beside any one of them would make the other two a copy.
 *
 * # Why the field names are one and two letters
 *
 * Apple caps a broadcast payload at 5 120 bytes, and JSON keys are repeated once per team. With
 * readable names an eight-team shard spends roughly a third of its budget on the word "opponent".
 * The encoder and decoder are both in this repository and both tested against the same fixtures, so
 * the cost of terse keys is paid once, here, in a comment.
 */

/** Apple's documented ceiling for a broadcast push payload. */
export const APNS_BROADCAST_PAYLOAD_LIMIT = 5120;

/**
 * The share of the limit QBSheet Live will actually use.
 *
 * Not 100%: a payload that exactly fits today fails the first time a team is renamed or a room
 * number gets longer, in the middle of a tournament, silently. 60% leaves room for the longest
 * plausible strings and for a future field.
 */
export const SHARD_PAYLOAD_BUDGET = Math.floor(APNS_BROADCAST_PAYLOAD_LIMIT * 0.6);

export const ActivityMode = {
  /** No current game. Showing the next scheduled event, or nothing. */
  idle: 0,
  /** A scheduled game that has not started. */
  upcoming: 1,
  /** In progress. */
  live: 2,
  /** Finished, result accepted. */
  final: 3,
} as const;

export type ActivityModeValue = (typeof ActivityMode)[keyof typeof ActivityMode];

/**
 * One team's glanceable state.
 *
 * Everything optional is genuinely absent when the tournament has not published it: a Director who
 * keeps live scores off produces entries with no `s`/`x`, and the Activity renders "In progress".
 * Absence is how a privacy setting reaches the Lock Screen.
 */
export interface ActivityTeamState {
  /** Index within the shard, not a team id. Ids are long and the client already knows the mapping. */
  i: number;
  /** Mode. */
  m: ActivityModeValue;
  /** Opponent's index within the shard, when the opponent is in the same shard. */
  o?: number;
  /** Opponent's short name, when the opponent is in a different shard. */
  on?: string;
  /** This team's score. */
  s?: number;
  /** Opponent's score. */
  x?: number;
  /** Tossups read. */
  u?: number;
  /** Room label. */
  rm?: string;
  /** Round number. */
  rd?: number;
  /** Scheduled start, Unix seconds. Absent means the tournament stated no time. */
  st?: number;
  /** A non-game event's title, for a team whose next thing is lunch rather than a match. */
  ev?: string;
}

export interface ActivityShardState {
  /** The publication revision this state was derived from. Used to discard a reordered update. */
  r: number;
  /** One entry per team in the shard, in shard order. */
  t: ActivityTeamState[];
}

/**
 * Static attributes: what the Activity is about, fixed for its lifetime.
 *
 * The followed team lives here rather than in `ContentState` because it never changes and because
 * a broadcast channel delivers the same `ContentState` to everybody — the per-viewer part has to be
 * the part ActivityKit does not broadcast.
 */
export interface ActivityAttributes {
  publicationId: string;
  tournamentName: string;
  followedTeamId: string;
  followedTeamName: string;
  shard: number;
  /** The followed team's index within the shard. */
  slot: number;
}

/**
 * The shard size used when a publication has not measured its own.
 *
 * Eight was the starting guess. Measurement (`tests/payload.test.ts`) shows sixteen fits with room
 * to spare — 2 618 bytes in a pessimistic case against Apple's 5 120 — so `chooseTeamsPerShard`
 * returns sixteen for any realistic tournament and halves the channels consumed. This constant
 * stays at the conservative value because it is the answer given without measuring.
 */
export const DEFAULT_TEAMS_PER_SHARD = 8;

export function shardForTeamIndex(teamIndex: number, teamsPerShard = DEFAULT_TEAMS_PER_SHARD): number {
  return Math.floor(teamIndex / teamsPerShard);
}

export function slotForTeamIndex(teamIndex: number, teamsPerShard = DEFAULT_TEAMS_PER_SHARD): number {
  return teamIndex % teamsPerShard;
}

export function shardCount(teamCount: number, teamsPerShard = DEFAULT_TEAMS_PER_SHARD): number {
  return Math.ceil(teamCount / teamsPerShard);
}

/**
 * The bytes an APNs broadcast body would occupy for this shard state.
 *
 * Measures the whole `aps` envelope, not just the content state, because the envelope is what Apple
 * counts.
 */
export function broadcastPayloadBytes(state: ActivityShardState, event: 'update' | 'end' = 'update'): number {
  const payload = {
    aps: {
      timestamp: 1757088000,
      event,
      'content-state': state,
    },
  };
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * A stable hash of a shard state, ignoring the revision.
 *
 * The gateway drops a push whose content is identical to the last one it sent. The revision is
 * excluded deliberately: Director's revision advances for reasons that do not change anything on a
 * Lock Screen — a room note edited, a standings scope added — and pushing for those would spend the
 * publishing budget on nothing.
 *
 * FNV-1a over the canonical JSON. Not cryptographic; it is a change detector, and a collision costs
 * one skipped update that the next one supersedes.
 */
export function shardStateFingerprint(state: ActivityShardState): string {
  const canonical = JSON.stringify(state.t);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Choose a shard size that fits the budget for this tournament's actual strings.
 *
 * Called once when a publication enables Apple push, and then held fixed for the tournament: a
 * shard size that changed mid-day would move teams between channels and strand the Activities
 * already subscribed to the old ones.
 */
export function chooseTeamsPerShard(
  worstCaseTeam: (index: number) => ActivityTeamState,
  candidates: readonly number[] = [16, 12, 8, 6, 4, 2],
  budget = SHARD_PAYLOAD_BUDGET,
): number {
  for (const size of candidates) {
    const state: ActivityShardState = {
      r: 999999,
      t: Array.from({ length: size }, (_unused, index) => worstCaseTeam(index)),
    };
    if (broadcastPayloadBytes(state) <= budget) return size;
  }
  // Even a two-team shard does not fit, which means the strings are pathological. One team per
  // channel is wasteful but correct, and the channel budget will notice.
  return 1;
}
