/**
 * The Director's persisted domain model.
 *
 * This is deliberately a document-shaped model rather than a copy of SQLite rows. The browser
 * preview can persist the same document in IndexedDB, while the Tauri store maps it to normalized
 * tables and returns this shape at the application boundary. React never receives database rows.
 */

import { emptyTransferState, type TransferState } from './transfers.js';
import type { IanaTimeZone } from './timezone.js';
import type { TournamentTimelineEvent } from './timeline.js';
import type { LivePublication } from './publication.js';

export const directorSchemaVersion = 9;

export type {
  ArtifactClassification,
  ArtifactSourceKind,
  ArtifactStatus,
  AssignmentTransfer,
  AssignmentTransferStatus,
  IncomingArtifact,
  TransferEvent,
  TransferEventKind,
  TransferLocation,
  TransferLocationKind,
  TransferState,
  TransportKind,
} from './transfers.js';

export type DirectorId = string;
export type TournamentStatus = 'draft' | 'running' | 'complete' | 'archived';
/**
 * Exhibition teams compete fully — scheduled, scored, and counted in official
 * standings — but are labeled as exhibition and flagged in SQBS exports.
 */
export type TeamStatus = 'confirmed' | 'waitlist' | 'dropped' | 'exhibition';
export type RoomStatus = 'available' | 'live' | 'finished' | 'help' | 'offline';
export type GameStatus =
  'scheduled' | 'live' | 'submitted' | 'accepted' | 'rejected' | 'cancelled' | 'forfeit';
export type SubmissionStatus = 'received' | 'accepted' | 'review' | 'rejected' | 'duplicate' | 'superseded';
export type DetailedStatsStatus = 'complete' | 'incomplete' | 'unknown';
export type StaffRole = 'moderator' | 'scorekeeper' | 'runner' | 'hq';
export type PhaseKind = 'preliminary' | 'playoff' | 'final' | 'placement' | 'custom';
export type FormatKind =
  | 'round-robin'
  | 'double-round-robin'
  | 'pools'
  | 'playoff-pools'
  | 'single-elimination'
  | 'swiss'
  | 'custom';

export interface TournamentRules {
  tossupValue: number;
  /** Optional second early-buzz tier above power (for example 20 with power 15). Null means unused. */
  superpowerValue: number | null;
  /** Null means the format has no power mark. */
  powerValue: number | null;
  /** Null means the format has no interrupt penalty. */
  negValue: number | null;
  /** False means tossups only: no bonus structure is written to assignments or expected in results. */
  useBonuses: boolean;
  /** Points per bonus part for regular bonuses. */
  bonusValue: number;
  tossupCount: number;
  /** Parts per bonus, and the maximum part count for irregular bonuses. */
  bonusParts: number;
  /**
   * Fewest parts a bonus can have. Null means every bonus has bonusParts parts (regular bonuses
   * with fixed buttons in the scorer); a smaller value means irregular bonuses with a typed total.
   */
  minimumBonusParts: number | null;
  /**
   * Most a bonus can be worth. Null means bonusValue * bonusParts. Set explicitly for irregular
   * bonuses whose parts are not all worth the same.
   */
  maximumBonusScore: number | null;
  /** Bonus scoring increment override. Null means one bonus part. */
  bonusDivisor: number | null;
  bouncebacks: boolean;
  overtime: boolean;
  /** Tossups in the initial overtime period. 1 is sudden death. */
  overtimeTossupCount: number;
  /** Whether an overtime tossup earns a bonus. Always false when bonuses are disabled. */
  overtimeBonuses: boolean;
  /** Whether the scorer should use a moderator-controlled timed regulation period. */
  timed: boolean;
  lightning: boolean;
  /** Lightning rounds each team gets, when lightning is used. */
  lightningCountPerTeam: number;
  /** The increment a lightning total moves in. */
  lightningDivisor: number;
  /** Longest regulation can run. Null means regulation always ends at tossupCount. */
  maximumTossupCount: number | null;
  maximumActivePlayers: number;
  regulationMinutes: number;
  tiebreakers: Array<'head-to-head' | 'record' | 'points' | 'margin' | 'powers' | 'gets' | 'playoff'>;
  /**
   * Whether games played on tiebreaker packets count toward normal standings
   * statistics (record, PPG, etc.). Absent means false: tiebreaker games are
   * shown as explicit result context but excluded from standings totals unless
   * the tournament's canonical rules say they count statistically. This is a
   * standings-reporting rule, not part of any scorer game definition.
   */
  tiebreakerCountsStatistically?: boolean;
}

export interface Tournament {
  id: DirectorId;
  name: string;
  date: string;
  /** Optional last day for multi-day events. Absent means single-day. */
  endDate?: string;
  /** Optional question-set name, shown in exports and reports. */
  questionSet?: string;
  /**
   * The IANA zone the tournament is actually run in.
   *
   * Offered from the host at creation and then never re-derived: a Director who travels, or who
   * hands the laptop to a co-director in another state, must not silently move the tournament's
   * schedule. See `./timezone.ts`.
   */
  timeZone: IanaTimeZone;
  venue: string;
  organizer: string;
  status: TournamentStatus;
  rules: TournamentRules;
  formatId: DirectorId | null;
  currentPhaseId: DirectorId | null;
  currentPacketId: DirectorId | null;
  currentRoundId: DirectorId | null;
  /** Explicit final ranking for final outputs. Absent means calculated standings are final. */
  finalPlacement?: FinalPlacement;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: DirectorId;
  name: string;
  /** Optional Director-facing label; kept separate from the QBJ geographic fields. */
  shortName?: string;
  /** Actual municipality from QBJ/interchange data. */
  city?: string;
  notes?: string;
  /** Retired organization records remain addressable by historical teams and results. */
  archived?: boolean;
}

export interface Player {
  id: DirectorId;
  teamId: DirectorId;
  name: string;
  captain: boolean;
  active: boolean;
  rosterNumber?: string | number;
  /** Structured school year/grade (for example 10 for a sophomore), distinct from freeform notes. */
  schoolYear?: number | null;
  /**
   * Player-level undergraduate eligibility, YellowFruit parity field (#749).
   *
   * Tri-state: true/false are explicit eligibility states, null/undefined means unknown or not
   * supplied. This is a per-player attribute and must never be inferred from the team's
   * `undergraduate` classification: a roster can mix eligibility states.
   */
  undergraduateEligible?: boolean | null;
  /**
   * Player-level Division II eligibility, YellowFruit parity field (#749).
   *
   * Same tri-state semantics as `undergraduateEligible`, and likewise never inferred from the
   * team's `division-2` classification.
   */
  divisionTwoEligible?: boolean | null;
  notes?: string;
}

/** Built-in reporting classifications. Generalized grouping beyond these belongs in Team.tags. */
export type TeamClassification = 'small-school' | 'junior-varsity' | 'undergraduate' | 'division-2';

export const teamClassifications: readonly TeamClassification[] = [
  'small-school',
  'junior-varsity',
  'undergraduate',
  'division-2',
];

export function isTeamClassification(value: unknown): value is TeamClassification {
  return (
    value === 'small-school' ||
    value === 'junior-varsity' ||
    value === 'undergraduate' ||
    value === 'division-2'
  );
}

export interface Team {
  id: DirectorId;
  organizationId: DirectorId | null;
  displayName: string;
  teamLetter: string;
  seed: number | null;
  status: TeamStatus;
  /** Reporting classifications (Small School, JV, …). Only the ones a tournament uses are shown. */
  classifications?: TeamClassification[];
  /** Generalized grouping tags beyond the built-in classifications. */
  tags?: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * An explicit final ranking that overrides calculated standings for final
 * outputs only. Raw scores, W/L records, and mid-tournament standings are
 * never rewritten: the calculated order stays recoverable by ignoring this.
 */
export interface FinalPlacement {
  /** Team ids from first place down. Teams not listed keep calculated order after the listed ones. */
  order: DirectorId[];
  actor: string;
  at: string;
  reason?: string;
}

export interface StaffMember {
  id: DirectorId;
  name: string;
  roles: StaffRole[];
  available: boolean;
  notes?: string;
}

export interface EquipmentResource {
  id: DirectorId;
  name: string;
  kind: 'buzzer' | 'device' | 'other';
  available: boolean;
  notes?: string;
}

export interface Room {
  id: DirectorId;
  name: string;
  building?: string;
  floor?: string;
  accessibility?: string;
  directions?: string;
  notes?: string;
  /**
   * Legacy runtime status.
   *
   * Operational readiness is derived (see `operations.ts`); this field survives so that older
   * documents, the SQLite projection, and archives written by earlier builds keep round-tripping.
   * Nothing in the operations layer reads it as authority.
   *
   * @deprecated Derive readiness with `deriveOperationalRoom` instead of reading this.
   */
  status: RoomStatus;
  /**
   * Default moderator for this room.
   *
   * These three fields are the *default* configuration a round inherits when it has no explicit
   * operational assignment yet. Per-round staffing lives on `OperationalAssignment`.
   */
  moderatorId: DirectorId | null;
  scorekeeperId: DirectorId | null;
  /** @deprecated Single-resource default; `defaultEquipmentIds` supersedes it. Kept for round-trips. */
  equipmentId: DirectorId | null;
  /** Default equipment for this room. Supports the multiple resources the interchange format allows. */
  defaultEquipmentIds?: DirectorId[];
  /** Operator intent: whether the room may be used for future assignment at all. */
  available: boolean;
}

/** What an operational assignment is for. Room duty is the common case. */
export type OperationalAssignmentKind = 'room' | 'hq' | 'runner';

/**
 * Which parts of an assignment the director chose explicitly.
 *
 * Auto-fill and repair may replace anything that is not pinned. A pinned value that becomes
 * impossible is surfaced as a decision rather than silently overwritten.
 */
export interface OperationalAssignmentPins {
  room?: boolean;
  moderator?: boolean;
  scorekeeper?: boolean;
  /** Equipment ids the director placed by hand. Auto-fill keeps these and fills around them. */
  equipmentIds?: DirectorId[];
  /** Staff ids on a non-room duty the director placed by hand. */
  staffIds?: DirectorId[];
}

/**
 * How a round is actually being operated.
 *
 * A `Room` record says what a room *is*; an assignment says how it is *being used* for one round.
 * That split is what lets a moderator move between rounds, equipment travel, and runner/HQ duty
 * exist at all without inventing room-shaped slots for people who are not in a room.
 *
 * Assignments are round-scoped. A room-kind assignment normally also names the scheduled game it
 * operates, which is what makes "who is scoring this match?" answerable without re-deriving the
 * schedule.
 */
export interface OperationalAssignment {
  id: DirectorId;
  roundId: DirectorId;
  kind: OperationalAssignmentKind;
  scheduledGameId?: DirectorId | null;
  roomId?: DirectorId | null;
  moderatorId?: DirectorId | null;
  scorekeeperId?: DirectorId | null;
  /** Staff on a non-room duty (runner, HQ). Room duty uses the moderator/scorekeeper slots. */
  staffIds?: DirectorId[];
  equipmentIds: DirectorId[];
  pinned?: OperationalAssignmentPins;
  notes?: string;
}

export interface Packet {
  id: DirectorId;
  name: string;
  source: 'manual' | 'qbj' | 'imported';
  /** Retired inventory remains addressable for historical games but cannot be selected for new play. */
  retired?: boolean;
  assignedRoundIds: DirectorId[];
  assignedGameIds: DirectorId[];
  usedGameIds: DirectorId[];
  replacementForPacketId: DirectorId | null;
  tiebreaker: boolean;
  notes?: string;
}

export interface FormatDefinition {
  id: DirectorId;
  name: string;
  kind: FormatKind;
  phaseIds: DirectorId[];
  roundsPerTeam: number | null;
  avoidRematches: boolean;
  avoidSameOrganization: boolean;
  allowByes: boolean;
  editable: boolean;
  /** Structural state for formats whose next game depends on an earlier result. */
  bracket?: BracketState;
}

export type BracketSlot = { kind: 'seed'; seed: number } | { kind: 'winner' | 'loser'; gameKey: string };

export interface BracketNodeState {
  key: string;
  roundIndex: number;
  sequence: number;
  label: string;
  kind: 'elimination' | 'third-place' | 'placement';
  slotA: BracketSlot;
  slotB: BracketSlot;
}

export interface BracketState {
  /** Phase that owns this draw; absent on legacy documents created before phase-scoped fields. */
  phaseId?: DirectorId;
  teamCount: number;
  bracketSize: number;
  roundCount: number;
  seeding: Array<{ seed: number; teamId: DirectorId }>;
  nodes: BracketNodeState[];
  byes: Array<{ seed: number; roundIndex: number; protectedSeed: boolean }>;
  roundNumbers: number[];
  roundIds: Record<string, DirectorId>;
}

export interface Phase {
  id: DirectorId;
  name: string;
  kind: PhaseKind;
  order: number;
  formatId: DirectorId;
  /** Explicit competitive field for non-pool stages, normally written by advancement. */
  teamIds?: DirectorId[];
  poolIds: DirectorId[];
  roundIds: DirectorId[];
  advancementRule: AdvancementRule | null;
  carryover: boolean;
  status: 'planned' | 'active' | 'complete';
  /** Retired phases remain in the document because their rounds are historical. */
  archived?: boolean;
}

/**
 * The operator's intended way for a round's assignments to reach scorekeepers.
 *
 * #702: this is only the default for games without explicit per-game intent
 * or stronger per-game evidence. It must never be read as authoritative
 * per-game truth — one round routinely mixes QBTCP, file, and manual rooms.
 */
export type RoundDeliveryMode = 'qbtcp' | 'usb' | 'manual';

/** Per-game delivery route (#702). `file` covers USB drives, folders, and downloads. */
export type DeliveryTransport = 'qbtcp' | 'file' | 'manual';

/**
 * Explicit per-scheduled-game delivery intent (#702). Persisted only when the
 * operator deliberately routes one game; everything else derives from
 * session/transfer evidence and the round default. Changing one game's intent
 * never mutates its siblings, and a later game in the same room starts fresh.
 */
export interface GameDeliveryIntent {
  primary?: DeliveryTransport;
  fallbacks?: DeliveryTransport[];
}

export interface Pool {
  id: DirectorId;
  phaseId: DirectorId;
  name: string;
  teamIds: DirectorId[];
  order: number;
  /** Retired pools retain their prior membership and round references. */
  archived?: boolean;
}

export interface Round {
  id: DirectorId;
  phaseId: DirectorId;
  name: string;
  number: number;
  revision: number;
  status: 'planned' | 'prepared' | 'released' | 'closed';
  packetId: DirectorId | null;
  scheduledGameIds: DirectorId[];
  /**
   * Explicit position in the tournament-day sequence shared with timeline
   * events. Missing values sort last and are densified on load; see
   * `dayOrder.ts`. Rounds keep their numeric `number` independently.
   */
  dayOrder?: number | null;
  /** When the round was planned to begin, if the schedule has an explicit time. */
  scheduledStart: string | null;
  /** When assignments were released to rooms. This is not a scheduled or actual start. */
  releasedAt: string | null;
  /** When play actually began, if Director has observed it. */
  startedAt: string | null;
  closedAt: string | null;
  /**
   * Default delivery intent for games without explicit per-game intent
   * (#702). Older documents omit this and use the deterministic legacy
   * fallback. Never authoritative per-game truth.
   */
  deliveryMode?: RoundDeliveryMode;
}

export interface ScheduledGameCancellation {
  /** Why the schedule row was cancelled; only team-drop cancellations are restorable by Restore. */
  reasonKind: 'team-dropped' | 'manual' | 'administrative';
  teamId?: DirectorId;
  reason: string;
  at: string;
  /** Audit event that records the cancellation decision. */
  auditId?: DirectorId;
}

export interface ScheduledGame {
  id: DirectorId;
  roundId: DirectorId;
  poolId?: DirectorId | null;
  roomId: DirectorId | null;
  packetId: DirectorId | null;
  leftTeamId: DirectorId;
  rightTeamId: DirectorId | null;
  bye: boolean;
  status: 'scheduled' | 'released' | 'live' | 'submitted' | 'accepted' | 'cancelled';
  /** Per-game planned start. Falls back to the round's planned start when absent. */
  scheduledStart?: string | null;
  /**
   * Whether this game may reach the public projection.
   *
   * `auto` defers to the round: a game becomes public when its round is released, which is the same
   * moment the paper schedule goes up. `hidden` is an override for a game a Director has generated
   * but does not want seen yet — a rebracket pairing, a tiebreaker being considered. There is
   * deliberately no `shown` override: nothing publishes ahead of its round.
   */
  publicVisibility?: 'auto' | 'hidden';
  assignmentRevision: number;
  movedFromRoomId?: DirectorId | null;
  /**
   * Explicit per-game delivery intent (#702). Absent means "derive": live
   * QBTCP session evidence, then the round default, then manual. Absent on
   * older documents, which derive exactly like unconfigured games.
   */
  deliveryIntent?: GameDeliveryIntent;
  notes?: string;
  /** Stable key into FormatDefinition.bracket when this is a dependent bracket game. */
  bracketKey?: string;
  /** Provenance for a cancellation, retained so later recovery cannot guess its cause. */
  cancellation?: ScheduledGameCancellation;
  /**
   * The issued competitive-definition revision for this game, if any scorer assignment has
   * escaped Director (file/USB preparation, download/share, QBTCP delivery, or round release).
   * Absent means unissued: future assignments derive from current tournament defaults.
   */
  definitionRevision?: number;
  /** The snapshot carrying the issued revision's exact competitive semantics. */
  definitionSnapshotId?: DirectorId | null;
}

/** One roster line as issued to a scorer: identity and display name, nothing operational. */
export interface IssuedRosterPlayer {
  playerId: DirectorId;
  name: string;
  captain?: boolean;
}

/**
 * Where the scoring truth for one game came from (#671).
 *
 * - `issued`: the echoed digest exactly matches the game's active snapshot.
 * - `corrected`: resolved through Director history without an exact match — a superseded
 *   revision the digest names, or the active snapshot standing in for an unknown echo.
 * - `qbj`: resolved from the result document's own embedded ScoringRules vocabulary.
 * - `legacy-inferred`: no snapshot history exists but the game already has records, so the
 *   definition cannot be proven; current defaults are used and flagged as inference.
 * - `current`: no snapshot history and no prior records; current defaults are the only truth.
 */
export type HistoricalDefinitionSource = 'issued' | 'corrected' | 'qbj' | 'legacy-inferred' | 'current';

/**
 * An immutable competitive definition issued to a scorer for one scheduled game (#667).
 *
 * Once persisted, a snapshot is never edited in place. Tournament defaults may keep changing
 * for future games, but every transport and every recovery path rebuilds this game's
 * assignment from its snapshot, so `(scheduledGameId, definitionRevision)` always means the
 * exact same scoring/procedure semantics. A new revision is created only by explicit reissue,
 * and previous revisions are retained so a late result from an older artifact is recognized
 * rather than misread.
 *
 * Only competitive fields participate in the digest: room display names, handoff instructions,
 * tokens, and filesystem paths travel with assignments but never change what a tossup is worth.
 */
export interface GameDefinitionSnapshot {
  id: DirectorId;
  scheduledGameId: DirectorId;
  /** 1-based revision within this scheduled game. */
  revision: number;
  createdAt: string;
  /** The exact scoring truth as issued: answer tiers/values, bonus shape, counts, procedure flags. */
  rules: TournamentRules;
  roundId: DirectorId;
  packetId: DirectorId | null;
  leftTeamId: DirectorId;
  rightTeamId: DirectorId;
  /** Active roster as issued; a later roster amendment does not rewrite history. */
  leftRoster: IssuedRosterPlayer[];
  rightRoster: IssuedRosterPlayer[];
  /** The scheduled game's assignmentRevision at issue time, for correlation. */
  assignmentRevision: number;
  /** Deterministic digest over the competitive fields above (see `digestGameDefinition`). */
  digest: string;
  /**
   * When set, this revision was superseded by the named revision's explicit reissue. Retained
   * for late-result recognition; never reused for new assignments.
   */
  supersededById?: DirectorId | null;
}

export interface TeamGameScore {
  teamId: DirectorId;
  score: number;
  /** Early-buzz tier above power (for example 20-point superpowers). Zero when the format has none. */
  superpowers: number;
  powers: number;
  gets: number;
  negs: number;
  bonuses: number;
  bonusPoints: number;
  /**
   * Bounceback points earned, YellowFruit parity field (#748).
   *
   * Null/undefined means the source result supplied no bounceback breakdown: a manual or
   * legacy result without that detail is unknown, not a verified zero. Only an explicit zero
   * (which the scorer always writes) is a known zero. Bounceback conversion denominators are
   * derived from opponent bonus detail, never inferred from point deltas.
   */
  bouncebacks?: number | null;
  /**
   * Tossup points converted in overtime, YellowFruit parity field (#746 follow-up).
   *
   * Valued from the result's own overtime-buzz detail (each entry carries its answer value),
   * so the figure is exact in both directions — never estimated from counts times live rules.
   * Null/undefined means the source supplied no overtime-buzz breakdown (MODAQ exports and
   * manual results lose it; the scorer omits the breakdown when nobody converted in overtime),
   * not zero: only the scoring definition's lack of an overtime period makes it a known zero,
   * resolved at derivation time.
   */
  overtimePoints?: number | null;
  /**
   * Known lightning-round points for this team game, YellowFruit-parity field (#747).
   *
   * Null/undefined means the source result did not supply a lightning breakdown: a legacy or
   * manual result without that detail is unknown, not a verified zero. Only an explicit zero
   * from a lightning-format result is a known zero.
   */
  lightningPoints?: number | null;
}

export interface PlayerGameStat {
  playerId: DirectorId;
  teamId: DirectorId;
  /** Early-buzz tier above power (for example 20-point superpowers). Zero when the format has none. */
  superpowers: number;
  powers: number;
  gets: number;
  negs: number;
  bonusPoints: number;
  /** Null means the source did not provide a tossups-heard count. */
  tossupsHeard: number | null;
}

export interface GameRecord {
  id: DirectorId;
  scheduledGameId: DirectorId;
  roundId: DirectorId;
  packetId: DirectorId | null;
  status: GameStatus;
  /**
   * Set when status is 'forfeit': the side that forfeited. The other side is
   * the winner regardless of recorded scores, which are kept as-entered and
   * never fabricated (forfeits usually arrive scoreless).
   */
  forfeitedTeamId?: DirectorId;
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  /**
   * Exact tossups read in the match, YellowFruit parity field (#746).
   *
   * Both teams hear the same tossups, so this is a game fact, not a sum over player lines:
   * several players hear the same tossup and substitutions change summed exposure. Team TUH
   * aggregates this value, never player exposure. Null/undefined means the source result did
   * not supply an exact count (legacy/manual detail), not zero.
   */
  tossupsRead?: number | null;
  /**
   * Overtime tossups read within `tossupsRead`, YellowFruit parity field (#746).
   *
   * Null/undefined means unknown, not zero: only an explicit zero (which the scorer writes)
   * or a game played under rules without overtime is a known zero.
   */
  overtimeTossupsRead?: number | null;
  source: 'qbtcp' | 'manual' | 'qbj' | 'paper';
  /**
   * Which accepted truth this record carries (#673). The first accepted result is
   * revision 1; every accepted correction (score edit, protest adjustment,
   * administrative replacement) increments it. Absent on records written before
   * revision tracking, which read as revision 1. Superseded records keep their
   * revision as historical evidence; dependency references (advancement basis
   * records) name the revision they verified against.
   */
  resultRevision?: number;
  /**
   * Issued definition revision the scorer used, when the returned document carried one (#670).
   * The per-game historical semantics themselves arrive with #671; this is the correlation
   * key that lets statistics resolve the right definition instead of current defaults.
   */
  definitionRevision?: number;
  /** Digest over the competitive semantics the scorer actually used (#670). */
  definitionDigest?: string;
  /**
   * Which scoring truth statistics used for this game (#671). Absent on records written
   * before per-game resolution existed.
   */
  definitionSource?: HistoricalDefinitionSource;
  /** Manual/paper results may have a known final score without detailed scoresheet stats. */
  detailedStats?: DetailedStatsStatus;
  transportResultId?: string;
  rawQbj?: unknown;
  startedAt?: string;
  finishedAt?: string;
  acceptedAt?: string;
  note?: string;
}

export interface ResultSubmission {
  id: DirectorId;
  gameId: DirectorId;
  transportResultId?: string;
  sessionId?: string;
  receivedAt: string;
  fingerprint: string;
  status: SubmissionStatus;
  /** Issued definition revision echoed by the room, when the returned document carried one (#670). */
  definitionRevision?: number;
  /** Digest over the competitive semantics the room actually scored under (#670). */
  definitionDigest?: string;
  /** Which scoring truth the staged statistics were derived under (#671). */
  definitionSource?: HistoricalDefinitionSource;
  rawSubmission: unknown;
  warnings?: string[];
  conflictWith?: string;
  reason?: string;
  supersedesSubmissionId?: DirectorId;
  supersededBySubmissionId?: DirectorId;
  acceptedBy?: string;
  acceptedAt?: string;
}

export interface ProtestScoreAdjustment {
  teamId: DirectorId;
  delta: number;
}

export interface Protest {
  id: DirectorId;
  gameId: DirectorId;
  category: 'tossup' | 'bonus' | 'procedure' | 'other';
  description: string;
  status: 'open' | 'ruled' | 'withdrawn';
  ruling?: string;
  scoreAdjustment?: ProtestScoreAdjustment;
  correctionSubmissionId?: DirectorId;
  /** Retained only when importing a pre-v2 ambiguous numeric adjustment. */
  legacyScoreAdjustment?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: DirectorId;
  at: string;
  actor: string;
  type:
    | 'tournament-created'
    | 'tournament-updated'
    | 'team-changed'
    | 'room-changed'
    | 'packet-changed'
    | 'format-changed'
    | 'schedule-generated'
    | 'assignment-released'
    | 'assignment-prepared'
    | 'result-received'
    | 'result-accepted'
    | 'result-edited'
    | 'protest-created'
    | 'protest-ruled'
    | 'team-dropped'
    | 'schedule-repaired'
    | 'schedule-cancelled'
    | 'advancement-committed'
    | 'advancement-stale'
    | 'checkpoint-restored'
    | 'final-placement-set'
    | 'final-placement-cleared'
    | 'roster-amendment'
    | 'qbtcp-help-resolved'
    | 'checkpoint-created'
    | 'definition-reissued'
    | 'delivery-intent-changed'
    | 'imported'
    | 'exported';
  summary: string;
  entityId?: DirectorId;
  details?: Record<string, unknown>;
}

export interface AdvancementRule {
  qualifiersPerPool: number;
  /** Best remaining teams across pools after the per-pool qualifiers. */
  wildcards: number;
  tiebreakers: TournamentRules['tiebreakers'];
  manualOverrideAllowed: boolean;
}

export interface QbtcpRoomSession {
  roomId: DirectorId;
  sessionId: DirectorId;
  matchId?: string;
  deviceId: string;
  operatorName?: string;
  /**
   * The staff member Director believes is operating this session.
   *
   * Set when a pairing invitation named an expected scorekeeper, or when an operator name maps
   * unambiguously onto exactly one staff member. Left absent for an ad hoc scorer rather than
   * guessed: a wrong identity is worse than an unknown one, because the operations layer reports
   * it as "the wrong person is in this room".
   */
  staffId?: DirectorId;
  /** The scorekeeper the room's assignment expects, recorded when the invitation was issued. */
  expectedStaffId?: DirectorId;
  state: 'paired' | 'assigned' | 'live' | 'result-received' | 'abandoned';
  resumable?: boolean;
  resultReceived?: boolean;
  lastSeenAt: string;
  progressSequence?: number;
  progress: {
    tossupsRead: number;
    leftScore: number;
    rightScore: number;
  } | null;
  helpRequestId: DirectorId | null;
}

export interface QbtcpHelpRequest {
  id: DirectorId;
  roomId: DirectorId;
  roomName: string;
  category: string;
  message: string;
  status: 'open' | 'cancelled' | 'resolved' | string;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  operatorName?: string;
  currentMatchup?: Record<string, unknown>;
}

export interface QbtcpRosterAmendment {
  id: DirectorId;
  sessionId: DirectorId;
  amendment: Record<string, unknown>;
  status: 'pending' | 'approved-new' | 'mapped-existing' | 'rejected';
  decidedAt: string | null;
  decidedBy: string | null;
  mappedPlayerId: DirectorId | null;
  decisionReason?: string;
}

export interface DirectorState {
  schemaVersion: number;
  tournament: Tournament | null;
  organizations: Organization[];
  teams: Team[];
  players: Player[];
  staff: StaffMember[];
  equipment: EquipmentResource[];
  rooms: Room[];
  packets: Packet[];
  formats: FormatDefinition[];
  phases: Phase[];
  pools: Pool[];
  rounds: Round[];
  scheduledGames: ScheduledGame[];
  /**
   * Immutable issued competitive definitions, one revision history per scheduled game (#667).
   * Empty for tournaments created before definitions were pinned; absent history means the
   * game was never issued, never that it shares current defaults.
   */
  gameDefinitions: GameDefinitionSnapshot[];
  games: GameRecord[];
  submissions: ResultSubmission[];
  protests: Protest[];
  audit: AuditEvent[];
  qbtcpSessions: QbtcpRoomSession[];
  qbtcpHelpRequests: QbtcpHelpRequest[];
  qbtcpRosterAmendments: QbtcpRosterAmendment[];
  /**
   * How each round is operated: rooms, staff, and equipment for that round only.
   *
   * Separate from `rooms` because a room is a place and an assignment is a shift. See
   * `OperationalAssignment`.
   */
  operationalAssignments: OperationalAssignment[];
  /**
   * Public and staff events that are not games: lunch, check-in, awards.
   *
   * A separate list rather than pseudo-games, because a lunch has no result, no packet, and no
   * teams that can win it. See `./timeline.ts`.
   */
  timeline: TournamentTimelineEvent[];
  /**
   * QBSheet Live publication state, or null when Live has never been configured.
   *
   * Null rather than a disabled record so that a tournament that predates Live, or one whose
   * Director never opens the Live section, carries no publication identity at all.
   */
  live: LivePublication | null;
  /**
   * Transport-agnostic transfers.
   *
   * A separate block rather than fields on `ScheduledGame`, because delivery and return are events
   * that happen around a game rather than properties of it. See `../transfers/model.ts`.
   */
  transfers: TransferState;
  metadata: {
    lastSavedAt: string | null;
    lastCheckpointAt: string | null;
    archivePath?: string;
  };
}

export const defaultRules: TournamentRules = {
  tossupValue: 10,
  superpowerValue: null,
  powerValue: 15,
  negValue: -5,
  useBonuses: true,
  bonusValue: 10,
  tossupCount: 20,
  bonusParts: 3,
  minimumBonusParts: null,
  maximumBonusScore: null,
  bonusDivisor: null,
  bouncebacks: false,
  overtime: true,
  overtimeTossupCount: 1,
  // Matches the previous assignment behavior, which carried overtime itself
  // into overtime_includes_bonuses.
  overtimeBonuses: true,
  timed: false,
  lightning: false,
  lightningCountPerTeam: 1,
  lightningDivisor: 10,
  maximumTossupCount: null,
  maximumActivePlayers: 4,
  regulationMinutes: 26,
  tiebreakers: ['head-to-head', 'record', 'points', 'margin', 'powers', 'gets', 'playoff'],
};

export function emptyDirectorState(): DirectorState {
  return {
    schemaVersion: directorSchemaVersion,
    tournament: null,
    organizations: [],
    teams: [],
    players: [],
    staff: [],
    equipment: [],
    rooms: [],
    packets: [],
    formats: [],
    phases: [],
    pools: [],
    rounds: [],
    scheduledGames: [],
    gameDefinitions: [],
    games: [],
    submissions: [],
    protests: [],
    audit: [],
    qbtcpSessions: [],
    qbtcpHelpRequests: [],
    qbtcpRosterAmendments: [],
    operationalAssignments: [],
    timeline: [],
    live: null,
    transfers: emptyTransferState(),
    metadata: { lastSavedAt: null, lastCheckpointAt: null },
  };
}

export function cloneState(state: DirectorState): DirectorState {
  return structuredClone(state);
}

export function newDirectorId(prefix: string): DirectorId {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Return the highest-numbered round without depending on persistence array order. */
export function latestRound<T extends { id: string; number?: number }>(rounds: readonly T[]): T | null {
  const selected = rounds.reduce<{ entry: T; index: number } | null>((current, entry, index) => {
    if (!current) return { entry, index };
    const currentNumber = Number.isFinite(current.entry.number)
      ? (current.entry.number ?? -Infinity)
      : -Infinity;
    const entryNumber = Number.isFinite(entry.number) ? (entry.number ?? -Infinity) : -Infinity;
    return entryNumber > currentNumber || (entryNumber === currentNumber && index > current.index)
      ? { entry, index }
      : current;
  }, null);
  return selected?.entry ?? null;
}
