/**
 * Public, file-format-facing types for QBSheet Director.
 *
 * This package deliberately does not model a database row.  The Director store can evolve its
 * tables independently; these types are the stable interchange shape that an archive or an adapter
 * can carry between applications.  `extensions` is part of the contract: an adapter must retain
 * data it does not understand and explain it with a warning rather than quietly throwing it away.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface FormatWarning {
  code: string;
  path: string;
  message: string;
  /** The original value, when retaining it in `extensions` is useful to a caller. */
  value?: JsonValue;
}

export interface FormatError {
  code: string;
  path: string;
  message: string;
}

export type FormatReport<T> =
  | { ok: true; value: T; warnings: FormatWarning[] }
  | { ok: false; errors: FormatError[]; warnings: FormatWarning[] };

export interface ExtensibleRecord {
  /** Adapter-specific or source-format data that this package does not interpret. */
  extensions?: JsonObject;
  /** The source object used to preserve fields from a foreign format. */
  source?: JsonObject;
}

export interface TournamentRecord extends ExtensibleRecord {
  id: string;
  name: string;
  date?: string;
  location?: string;
  organizationId?: string;
  notes?: string;
}

export interface OrganizationRecord extends ExtensibleRecord {
  id: string;
  name: string;
  city?: string;
  state?: string;
  country?: string;
  notes?: string;
}

export interface PlayerRecord extends ExtensibleRecord {
  id: string;
  name: string;
  organizationId?: string;
  grade?: string;
  rosterNumber?: string | number;
  captain?: boolean;
  notes?: string;
}

export type TeamStatus =
  'active' | 'dropped' | 'withdrawn' | 'no-show' | 'late' | 'forfeit' | 'archived' | string;

export interface TeamRecord extends ExtensibleRecord {
  id: string;
  name: string;
  displayName?: string;
  letter?: string;
  organizationId?: string;
  seed?: number;
  status?: TeamStatus;
  notes?: string;
  /** The normalized archive representation uses references. */
  playerIds?: string[];
  /** Convenience for adapters and callers that have a roster embedded already. */
  players?: PlayerRecord[];
}

export interface RegistrationRecord extends ExtensibleRecord {
  id: string;
  teamId: string;
  organizationId?: string;
  division?: string;
  seed?: number;
  status?: string;
}

export interface RoomRecord extends ExtensibleRecord {
  id: string;
  name: string;
  building?: string;
  floor?: string;
  accessible?: boolean;
  directions?: string;
  notes?: string;
  moderatorId?: string;
  scorekeeperId?: string;
  equipmentIds?: string[];
  available?: boolean;
}

export type StaffRole = 'moderator' | 'scorekeeper' | 'runner' | 'hq' | 'director' | string;

export interface StaffRecord extends ExtensibleRecord {
  id: string;
  name: string;
  role?: StaffRole;
  email?: string;
  phone?: string;
  availability?: JsonObject;
  notes?: string;
}

export interface EquipmentRecord extends ExtensibleRecord {
  id: string;
  name: string;
  kind?: string;
  serialNumber?: string;
  available?: boolean;
  notes?: string;
}

export interface PacketRecord extends ExtensibleRecord {
  id: string;
  name: string;
  roundId?: string;
  gameIds?: string[];
  replacementForId?: string;
  tiebreaker?: boolean;
  used?: boolean;
  securityNotes?: string;
  notes?: string;
}

export interface PhaseRecord extends ExtensibleRecord {
  id: string;
  name: string;
  kind?: string;
  order?: number;
  poolIds?: string[];
  roundIds?: string[];
  advancement?: JsonObject;
  carryovers?: JsonObject;
}

export interface PoolRecord extends ExtensibleRecord {
  id: string;
  name: string;
  phaseId?: string;
  order?: number;
  teamIds?: string[];
}

export type ScheduledGameStatus = 'scheduled' | 'released' | 'held' | 'cancelled' | 'complete' | string;

export interface ScheduledGameRecord extends ExtensibleRecord {
  id: string;
  phaseId?: string;
  roundId?: string;
  poolId?: string;
  roomId?: string;
  packetId?: string;
  teamIds: [string | null, string | null];
  status?: ScheduledGameStatus;
  sequence?: number;
  startsAt?: string;
  bye?: boolean;
}

export interface GameTeamResult extends ExtensibleRecord {
  teamId: string;
  points?: number;
  forfeitLoss?: boolean;
  tossupPoints?: number;
  bonusPoints?: number;
  bonusBouncebackPoints?: number;
  lightningPoints?: number;
  powers?: number;
  gets?: number;
  negs?: number;
  tossupsHeard?: number;
  correctTossupsWithoutBonuses?: number;
  bonusesHeard?: number;
  /** Preserve answer-type identity, including custom QBJ answer types. */
  answerCounts?: JsonValue;
}

export interface GamePlayerResult extends ExtensibleRecord {
  playerId: string;
  teamId: string;
  tossupsHeard?: number;
  powers?: number;
  gets?: number;
  negs?: number;
  points?: number;
  bonusesHeard?: number;
  bonusPoints?: number;
  answerCounts?: JsonValue;
}

export interface GameResult extends ExtensibleRecord {
  teams: GameTeamResult[];
  players?: GamePlayerResult[];
  /** True when one or more imported detailed statistics were unavailable or not classifiable. */
  statisticsIncomplete?: boolean;
  tossupsRead?: number;
  overtimeTossupsRead?: number;
  questions?: JsonValue[];
  notes?: string;
  moderator?: string;
  scorekeeper?: string;
  forfeit?: boolean;
  /** The original result object is retained even after normalization. */
  rawSubmission?: JsonValue;
}

export type GameStatus =
  | 'scheduled'
  | 'released'
  | 'in-progress'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'complete'
  | 'forfeit'
  | 'cancelled'
  | string;

export interface GameRecord extends ExtensibleRecord {
  id: string;
  scheduledGameId?: string;
  phaseId?: string;
  roundId?: string;
  poolId?: string;
  roomId?: string;
  packetId?: string;
  teamIds: [string | null, string | null];
  status?: GameStatus;
  result?: GameResult;
  rawSubmission?: JsonValue;
  submittedAt?: string;
  acceptedAt?: string;
}

export type ResultSubmissionStatus = 'pending' | 'accepted' | 'rejected' | 'duplicate' | 'edited' | string;

export interface ResultSubmissionRecord extends ExtensibleRecord {
  id: string;
  gameId: string;
  receivedAt: string;
  status: ResultSubmissionStatus;
  fingerprint?: string;
  raw: JsonValue;
  validationWarnings?: string[];
  reviewedAt?: string;
  reviewNote?: string;
}

export interface PlayerStatisticRecord extends ExtensibleRecord {
  id: string;
  playerId: string;
  phaseId?: string;
  roundId?: string;
  games?: number;
  tossupsHeard?: number;
  powers?: number;
  gets?: number;
  negs?: number;
  points?: number;
  bonusesHeard?: number;
  bonusPoints?: number;
}

export interface QbtcpSessionRecord extends ExtensibleRecord {
  id: string;
  gameId?: string;
  roomId?: string;
  clientId?: string;
  status?: string;
  pairedAt?: string;
  lastSeenAt?: string;
}

export interface ProtestRecord extends ExtensibleRecord {
  id: string;
  gameId: string;
  questionNumber?: number;
  subject?: string;
  description: string;
  status: 'open' | 'resolved' | 'withdrawn' | string;
  ruling?: string;
  notes?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface AuditEventRecord extends ExtensibleRecord {
  id: string;
  at: string;
  action: string;
  actor?: string;
  entityType?: string;
  entityId?: string;
  reason?: string;
  details?: JsonObject;
}

export interface QbjPreservation extends ExtensibleRecord {
  version?: string;
  /** Objects whose types this package does not yet interpret. */
  unknownObjects?: JsonObject[];
}

/**
 * The portable Director interchange model. Arrays are required after `normalizeTournamentData`; the
 * input type below intentionally permits omitted optional collections for small imports.
 */
export interface DirectorTournament {
  tournament: TournamentRecord;
  rules?: JsonObject;
  organizations: OrganizationRecord[];
  players: PlayerRecord[];
  teams: TeamRecord[];
  registrations: RegistrationRecord[];
  rooms: RoomRecord[];
  staff: StaffRecord[];
  equipment: EquipmentRecord[];
  packets: PacketRecord[];
  phases: PhaseRecord[];
  pools: PoolRecord[];
  rounds: RoundRecord[];
  scheduledGames: ScheduledGameRecord[];
  games: GameRecord[];
  playerStatistics: PlayerStatisticRecord[];
  qbtcpSessions: QbtcpSessionRecord[];
  resultSubmissions: ResultSubmissionRecord[];
  protests: ProtestRecord[];
  auditEvents: AuditEventRecord[];
  qbj?: QbjPreservation;
  extensions?: JsonObject;
}

export interface RoundRecord extends ExtensibleRecord {
  id: string;
  name: string;
  phaseId?: string;
  number?: number;
  /** Exact QBJ Round.name spelling, when it differs from the display name. */
  qbjName?: string;
  packetIds?: string[];
  revision?: number;
  status?: string;
}

export type DirectorTournamentInput = Omit<Partial<DirectorTournament>, 'tournament'> & {
  tournament: TournamentRecord;
};

export const emptyTournamentCollections = {
  organizations: [],
  players: [],
  teams: [],
  registrations: [],
  rooms: [],
  staff: [],
  equipment: [],
  packets: [],
  phases: [],
  pools: [],
  rounds: [],
  scheduledGames: [],
  games: [],
  playerStatistics: [],
  qbtcpSessions: [],
  resultSubmissions: [],
  protests: [],
  auditEvents: [],
} as const;
