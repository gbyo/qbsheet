/**
 * The Director's persisted domain model.
 *
 * This is deliberately a document-shaped model rather than a copy of SQLite rows. The browser
 * preview can persist the same document in IndexedDB, while the Tauri store maps it to normalized
 * tables and returns this shape at the application boundary. React never receives database rows.
 */

import { emptyTransferState, type TransferState } from '../transfers/model';

export const directorSchemaVersion = 1;

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
} from '../transfers/model';

export type DirectorId = string;
export type TournamentStatus = 'draft' | 'running' | 'complete' | 'archived';
export type TeamStatus = 'confirmed' | 'waitlist' | 'dropped';
export type RoomStatus = 'available' | 'live' | 'finished' | 'help' | 'offline';
export type GameStatus = 'scheduled' | 'live' | 'submitted' | 'accepted' | 'rejected' | 'cancelled';
export type SubmissionStatus = 'received' | 'accepted' | 'review' | 'rejected' | 'duplicate';
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
  lightning: boolean;
  maximumActivePlayers: number;
  regulationMinutes: number;
  tiebreakers: Array<'head-to-head' | 'record' | 'points' | 'margin' | 'powers' | 'gets' | 'playoff'>;
}

export interface Tournament {
  id: DirectorId;
  name: string;
  date: string;
  venue: string;
  organizer: string;
  status: TournamentStatus;
  rules: TournamentRules;
  formatId: DirectorId | null;
  currentRoundId: DirectorId | null;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: DirectorId;
  name: string;
  shortName?: string;
  notes?: string;
}

export interface Player {
  id: DirectorId;
  teamId: DirectorId;
  name: string;
  captain: boolean;
  active: boolean;
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
}

export interface Pool {
  id: DirectorId;
  phaseId: DirectorId;
  name: string;
  teamIds: DirectorId[];
  order: number;
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
  startedAt: string | null;
  closedAt: string | null;
}

export interface ScheduledGame {
  id: DirectorId;
  roundId: DirectorId;
  roomId: DirectorId | null;
  packetId: DirectorId | null;
  leftTeamId: DirectorId;
  rightTeamId: DirectorId | null;
  bye: boolean;
  status: 'scheduled' | 'released' | 'live' | 'submitted' | 'accepted' | 'cancelled';
  assignmentRevision: number;
  movedFromRoomId?: DirectorId | null;
  notes?: string;
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
  tossupsHeard: number;
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
  acceptedBy?: string;
  acceptedAt?: string;
}

export interface Protest {
  id: DirectorId;
  gameId: DirectorId;
  category: 'tossup' | 'bonus' | 'procedure' | 'other';
  description: string;
  status: 'open' | 'ruled' | 'withdrawn';
  ruling?: string;
  scoreAdjustment?: number;
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
  deviceId: string;
  operatorName?: string;
  state: 'paired' | 'assigned' | 'live' | 'result-received' | 'abandoned';
  lastSeenAt: string;
  progress: {
    tossupsRead: number;
    leftScore: number;
    rightScore: number;
  } | null;
  helpRequestId: DirectorId | null;
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
