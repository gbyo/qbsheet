// GENERATED FILE — do not edit.
//
// Copied from packages/qblive-protocol/src by scripts/sync-protocol.mjs so that this Worker is
// self-contained and deployable straight from the repository by "Deploy to Cloudflare", which
// cannot resolve monorepo workspace packages. Edit the original and re-run:
//
//     npm run sync-protocol --workspace=@qbsheet/qblive-backend-cloudflare
//
/**
 * QBLive v1 wire types.
 *
 * These are the *public* shapes. Nothing here is derived by removing fields from an internal
 * object: every field is declared because a spectator needs it, which is what makes the projection
 * in `@qbsheet/qblive-projection` a boundary rather than a filter. See `docs/QBLIVE.md`.
 *
 * The same shapes exist as JSON Schema in `../schemas` and as Swift `Codable` types in
 * `ios/QBSheetLiveKit`. `tests/schema.test.ts` and the Swift test target both read the fixtures in
 * `../fixtures`, so the three cannot drift apart without a red build.
 */

export const QBLIVE_PROTOCOL_VERSION = 1 as const;

export type QbliveProtocolVersion = typeof QBLIVE_PROTOCOL_VERSION;

/** Opaque, stable, public identifiers. Never a Director row id that means anything elsewhere. */
export type QbliveId = string;

/** An ISO 8601 timestamp that always carries an explicit offset or `Z`. Never a bare local time. */
export type QbliveTimestamp = string;

// ---------------------------------------------------------------------------
// Capability advertisement
// ---------------------------------------------------------------------------

/**
 * What a QBLive server can do.
 *
 * A client reads this once and then knows whether to open a socket, whether replay is worth
 * attempting, and whether to offer Live Activities. A static object host advertises `basic` and
 * nothing else, and every client still works.
 */
export interface QbliveCapabilities {
  /** Always present. `snapshot` is the floor of the protocol. */
  snapshot: true;
  /** Incremental `events?after=` replay. */
  events: boolean;
  /** A WebSocket at `/stream`. */
  stream: boolean;
  /** Official Apple background updates are configured for this publication. */
  applePush: boolean;
  /** The oldest revision `events` can replay from. Clients older than this must resnapshot. */
  minimumReplayRevision?: number;
}

export interface QbliveManifest {
  protocolVersion: QbliveProtocolVersion;
  publicationId: QbliveId;
  /** Monotonic. Increases on every published change and never resets for a publication. */
  revision: number;
  generatedAt: QbliveTimestamp;
  tournament: QblivePublicTournament;
  capabilities: QbliveCapabilities;
  /** Absolute or origin-relative URLs for the endpoints this server actually serves. */
  endpoints: {
    snapshot: string;
    events?: string;
    stream?: string;
  };
  /** Set once the tournament is over and the publication is frozen. */
  final: boolean;
}

// ---------------------------------------------------------------------------
// Tournament
// ---------------------------------------------------------------------------

export interface QblivePublicTournament {
  id: QbliveId;
  name: string;
  /** Calendar date in the tournament's own zone, `YYYY-MM-DD`. */
  date: string | null;
  venue: string | null;
  organizer: string | null;
  /** IANA identifier. Clients format times in this zone unless the viewer overrides. */
  timeZone: string;
  status: 'upcoming' | 'in-progress' | 'complete';
}

export interface QblivePublicTeam {
  id: QbliveId;
  /**
   * The team's public name, or a neutral identity when the Director has not published names.
   *
   * Never null: a client must always have something to render, and a client left to invent a label
   * would invent an inconsistent one.
   */
  name: string;
  /** The organization's short name when published, for grouping. */
  organization: string | null;
  seed: number | null;
  /** Present only when player publication is enabled. */
  players?: QblivePublicPlayer[];
}

export interface QblivePublicPlayer {
  id: QbliveId;
  name: string;
  teamId: QbliveId;
}

export interface QblivePublicRoom {
  id: QbliveId;
  name: string;
  building: string | null;
  /** Published only when the Director enables directions. */
  directions: string | null;
}

// ---------------------------------------------------------------------------
// Timeline and schedule
// ---------------------------------------------------------------------------

export type QbliveTimelineEventType =
  'round' | 'lunch' | 'break' | 'check-in' | 'awards' | 'ceremony' | 'custom';

export interface QbliveTimelineEvent {
  id: QbliveId;
  type: QbliveTimelineEventType;
  title: string;
  description: string | null;
  /**
   * Explicit position in the tournament-day sequence, or null when the
   * publisher predates day ordering. Missing decodes as null.
   */
  sequence: number | null;
  /**
   * An exact scheduled time, or null.
   *
   * Null means the tournament has not committed to a time. QBSheet Live renders nothing in that
   * case. It never estimates: see `docs/QBLIVE.md#no-estimated-times`.
   */
  scheduledStart: QbliveTimestamp | null;
  scheduledEnd: QbliveTimestamp | null;
  /** Empty means the event concerns everybody. */
  teamIds: QbliveId[];
  roomId: QbliveId | null;
  location: string | null;
}

export type QbliveGameState = 'upcoming' | 'live' | 'final' | 'bye' | 'cancelled';

export interface QbliveScheduledGame {
  id: QbliveId;
  roundId: QbliveId;
  roundName: string;
  roundNumber: number | null;
  /**
   * Explicit day-sequence position of this game's round, or null when the
   * publisher predates day ordering. Missing decodes as null.
   */
  sequence: number | null;
  phaseId: QbliveId | null;
  phaseName: string | null;
  poolId: QbliveId | null;
  poolName: string | null;
  /** Exactly two for a played game; one for a bye. */
  teamIds: QbliveId[];
  roomId: QbliveId | null;
  scheduledStart: QbliveTimestamp | null;
  state: QbliveGameState;
}

// ---------------------------------------------------------------------------
// Results and live games
// ---------------------------------------------------------------------------

export interface QbliveTeamScore {
  teamId: QbliveId;
  score: number;
}

export interface QbliveResult {
  gameId: QbliveId;
  roundId: QbliveId;
  scores: QbliveTeamScore[];
  /** Set when the Director recorded a forfeit or cancellation rather than a played game. */
  outcome: 'played' | 'forfeit' | 'cancelled';
  acceptedAt: QbliveTimestamp | null;
}

/**
 * A game currently being played.
 *
 * `score` and `tossupsRead` are independently optional because they are independently published:
 * a Director can say a game is happening without saying what the score is.
 */
export interface QbliveLiveGame {
  gameId: QbliveId;
  roundId: QbliveId;
  teamIds: QbliveId[];
  roomId: QbliveId | null;
  scores?: QbliveTeamScore[];
  tossupsRead?: number;
}

// ---------------------------------------------------------------------------
// Dynamic tables
// ---------------------------------------------------------------------------

export type QbliveColumnKind =
  'text' | 'integer' | 'decimal' | 'percentage' | 'record' | 'rank' | 'score' | 'team' | 'player';

export interface QbliveColumn {
  id: string;
  label: string;
  kind: QbliveColumnKind;
  alignment?: 'leading' | 'center' | 'trailing';
  /** Decimal places for `decimal` and `percentage`. Ignored otherwise. */
  precision?: number;
  description?: string;
}

/**
 * One value in a table row.
 *
 * `entityId` carries the team or player the cell refers to, which is how a client highlights the
 * followed team without knowing what the column means. `display` is authoritative for rendering:
 * Director has already applied the tournament's own formatting rules, and a client that re-derived
 * the string from `value` would disagree with the official printout.
 */
export interface QbliveCell {
  value: string | number | null;
  display?: string;
  entityId?: QbliveId;
}

export interface QbliveRow {
  id: string;
  cells: QbliveCell[];
  /** Set when the row is about one team, so clients can highlight without parsing cells. */
  teamId?: QbliveId;
  playerId?: QbliveId;
}

/**
 * A table the Director defines and the client renders without understanding.
 *
 * This is what lets a new statistic reach an installed iPhone app without an App Store release. A
 * client that meets an unknown `kind` renders the cell's `display`, which is always present when
 * the value is not trivially renderable.
 */
export interface QbliveDataTable {
  id: string;
  title: string;
  /** `overall`, `phase:<id>`, `pool:<id>`, or any future scope a Director advertises. */
  scope: string;
  scopeLabel?: string;
  columns: QbliveColumn[];
  rows: QbliveRow[];
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export type QbliveAnnouncementSeverity = 'information' | 'important' | 'urgent';

export interface QbliveAnnouncement {
  id: QbliveId;
  title: string;
  /**
   * Plain text. Never HTML, never Markdown.
   *
   * A tournament backend is not trusted to supply markup: it is a server somebody else operates,
   * and a client that rendered its HTML would be rendering a stranger's HTML. Line breaks are the
   * only structure that survives.
   */
  body: string;
  severity: QbliveAnnouncementSeverity;
  publishedAt: QbliveTimestamp;
  updatedAt: QbliveTimestamp | null;
  expiresAt: QbliveTimestamp | null;
  /** Empty means everybody. */
  audienceTeamIds: QbliveId[];
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * The named, independently replaceable parts of public state.
 *
 * Sections exist so a score tick does not have to resend a 64-team schedule. A revision update
 * carries only the sections that changed, and each one is replaced whole — see
 * `docs/QBLIVE.md#sections` for why whole-section replacement beats JSON Patch here.
 */
export const qbliveSectionNames = [
  'tournament',
  'teams',
  'rooms',
  'timeline',
  'schedule',
  'results',
  'liveGames',
  'standings',
  'statistics',
  'announcements',
] as const;

export type QbliveSectionName = (typeof qbliveSectionNames)[number];

export interface QbliveSections {
  tournament: QblivePublicTournament;
  teams: QblivePublicTeam[];
  rooms: QblivePublicRoom[];
  timeline: QbliveTimelineEvent[];
  schedule: QbliveScheduledGame[];
  results: QbliveResult[];
  liveGames: QbliveLiveGame[];
  standings: QbliveDataTable[];
  statistics: QbliveDataTable[];
  announcements: QbliveAnnouncement[];
}

export interface QbliveSnapshot extends QbliveSections {
  protocolVersion: QbliveProtocolVersion;
  publicationId: QbliveId;
  revision: number;
  generatedAt: QbliveTimestamp;
  capabilities: QbliveCapabilities;
  final: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One published change.
 *
 * `sections` names what changed and carries the replacement. A client that receives revision N+1
 * when it holds N applies it; a client that receives N+3 knows it has a gap and resnapshots.
 */
export interface QbliveEvent {
  revision: number;
  generatedAt: QbliveTimestamp;
  /** Present sections replace the client's copy wholesale. Absent sections are unchanged. */
  sections: Partial<QbliveSections>;
  /** Set on the event that freezes the publication. */
  final?: boolean;
}

export interface QbliveEventPage {
  protocolVersion: QbliveProtocolVersion;
  publicationId: QbliveId;
  /** The revision the server holds now, which may be ahead of the last event returned. */
  currentRevision: number;
  events: QbliveEvent[];
  /**
   * True when the requested `after` revision is older than the server's replay window.
   *
   * The client's only correct response is a full snapshot reload. Saying so explicitly is better
   * than returning a short page the client would mistake for being caught up.
   */
  resyncRequired: boolean;
}

/** Frames a QBLive WebSocket may send. Clients ignore frames with an unrecognised `type`. */
export type QbliveStreamFrame =
  | { type: 'hello'; protocolVersion: QbliveProtocolVersion; publicationId: QbliveId; revision: number }
  | { type: 'event'; event: QbliveEvent }
  | { type: 'resync'; currentRevision: number }
  | { type: 'final'; revision: number };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type QbliveErrorCode =
  | 'not-found'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'bad-request'
  | 'payload-too-large'
  | 'unsupported-protocol'
  | 'gone'
  | 'rate-limited'
  | 'internal';

export interface QbliveError {
  error: QbliveErrorCode;
  message: string;
  /** Present on `conflict`, so a publisher can repair with a full snapshot at the right revision. */
  currentRevision?: number;
}
