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

export const directorSchemaVersion = 7;

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
export type TeamStatus = 'confirmed' | 'waitlist' | 'dropped';
export type RoomStatus = 'available' | 'live' | 'finished' | 'help' | 'offline';
export type GameStatus = 'scheduled' | 'live' | 'submitted' | 'accepted' | 'rejected' | 'cancelled';
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
  powerValue: number;
  negValue: number;
  bonusValue: number;
  tossupCount: number;
  bonusParts: number;
  bouncebacks: boolean;
  overtime: boolean;
  /** Whether the scorer should use a moderator-controlled timed regulation period. */
  timed: boolean;
  lightning: boolean;
  maximumActivePlayers: number;
  regulationMinutes: number;
  tiebreakers: Array<'head-to-head' | 'record' | 'points' | 'margin' | 'powers' | 'gets' | 'playoff'>;
}

export interface Tournament {
  id: DirectorId;
  name: string;
  date: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: DirectorId;
  name: string;
  shortName?: string;
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
  notes?: string;
}

export interface Team {
  id: DirectorId;
  organizationId: DirectorId | null;
  displayName: string;
  teamLetter: string;
  seed: number | null;
  status: TeamStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
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
  status: RoomStatus;
  moderatorId: DirectorId | null;
  scorekeeperId: DirectorId | null;
  equipmentId: DirectorId | null;
  available: boolean;
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
  poolIds: DirectorId[];
  roundIds: DirectorId[];
  advancementRule: AdvancementRule | null;
  carryover: boolean;
  status: 'planned' | 'active' | 'complete';
  /** Retired phases remain in the document because their rounds are historical. */
  archived?: boolean;
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
  notes?: string;
  /** Stable key into FormatDefinition.bracket when this is a dependent bracket game. */
  bracketKey?: string;
}

export interface TeamGameScore {
  teamId: DirectorId;
  score: number;
  powers: number;
  gets: number;
  negs: number;
  bonuses: number;
  bonusPoints: number;
  bouncebacks: number;
}

export interface PlayerGameStat {
  playerId: DirectorId;
  teamId: DirectorId;
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
  scores: TeamGameScore[];
  playerStats: PlayerGameStat[];
  source: 'qbtcp' | 'manual' | 'qbj' | 'paper';
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
    | 'roster-amendment'
    | 'qbtcp-help-resolved'
    | 'checkpoint-created'
    | 'imported'
    | 'exported';
  summary: string;
  entityId?: DirectorId;
  details?: Record<string, unknown>;
}

export interface AdvancementRule {
  qualifiersPerPool: number;
  tiebreakers: TournamentRules['tiebreakers'];
  manualOverrideAllowed: boolean;
}

export interface QbtcpRoomSession {
  roomId: DirectorId;
  sessionId: DirectorId;
  matchId?: string;
  deviceId: string;
  operatorName?: string;
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
  games: GameRecord[];
  submissions: ResultSubmission[];
  protests: Protest[];
  audit: AuditEvent[];
  qbtcpSessions: QbtcpRoomSession[];
  qbtcpHelpRequests: QbtcpHelpRequest[];
  qbtcpRosterAmendments: QbtcpRosterAmendment[];
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
  powerValue: 15,
  negValue: -5,
  bonusValue: 10,
  tossupCount: 20,
  bonusParts: 3,
  bouncebacks: false,
  overtime: true,
  timed: false,
  lightning: false,
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
    games: [],
    submissions: [],
    protests: [],
    audit: [],
    qbtcpSessions: [],
    qbtcpHelpRequests: [],
    qbtcpRosterAmendments: [],
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
