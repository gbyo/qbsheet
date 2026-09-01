/**
 * Serializable tournament objects.
 *
 * This module deliberately contains domain objects rather than storage rows. A host may store a
 * `TournamentSnapshot` in SQLite, a file archive, or another repository without making React aware
 * of that choice. Functions in this package never mutate a snapshot in place.
 */

import { defaultRules, validateRules } from './rules';

export type EntityId = string;
export type ISODateTime = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type TournamentStatus = 'draft' | 'ready' | 'in-progress' | 'completed' | 'archived';
export type TeamStatus = 'active' | 'late' | 'no-show' | 'dropped' | 'withdrawn';
export type RegistrationStatus = 'registered' | 'checked-in' | 'withdrawn' | 'disqualified';

export interface TournamentMetadata {
  readonly id: EntityId;
  readonly name: string;
  readonly shortName: string;
  readonly date: string | null;
  readonly location: string | null;
  readonly organizer: string | null;
  readonly director: string | null;
  readonly notes: string;
  readonly status: TournamentStatus;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export type RulesPreset = 'acf' | 'naqt' | 'house' | 'custom';
export type RematchPolicy = 'allow' | 'avoid-when-possible' | 'forbid';
export type Tiebreaker =
  | 'wins'
  | 'head-to-head'
  | 'point-differential'
  | 'points-for'
  | 'powers'
  | 'gets'
  | 'negs'
  | 'bonus-points'
  | 'ppg'
  | 'seed';

export interface TournamentRules {
  readonly preset: RulesPreset;
  readonly tossupsPerGame: number;
  readonly tossupPoints: number;
  readonly powerPoints: number;
  readonly negPoints: number;
  readonly bonusParts: number;
  readonly bonusPartPoints: readonly number[];
  readonly bouncebacks: boolean;
  readonly overtime: {
    readonly enabled: boolean;
    readonly tossups: number;
    readonly suddenDeath: boolean;
  };
  readonly lightning: {
    readonly enabled: boolean;
    readonly tossups: number;
    readonly pointsPerTossup: number;
  };
  readonly maximumActivePlayers: number;
  readonly roomProcedure: {
    readonly timed: boolean;
    readonly halfLengthMinutes: number | null;
    readonly allowRosterAmendments: boolean;
  };
  readonly rematchPolicy: RematchPolicy;
  readonly tiebreakers: readonly Tiebreaker[];
}

export interface Organization {
  readonly id: EntityId;
  readonly name: string;
  readonly shortName: string | null;
  readonly notes: string;
  readonly active: boolean;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface Player {
  readonly id: EntityId;
  readonly name: string;
  readonly organizationId: EntityId | null;
  readonly teamId: EntityId | null;
  readonly grade: string | null;
  readonly captain: boolean;
  readonly active: boolean;
  readonly notes: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface Team {
  readonly id: EntityId;
  readonly name: string;
  readonly displayName: string;
  readonly letter: string | null;
  readonly organizationId: EntityId | null;
  readonly seed: number | null;
  readonly status: TeamStatus;
  readonly playerIds: readonly EntityId[];
  readonly notes: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface Registration {
  readonly id: EntityId;
  readonly tournamentId: EntityId;
  readonly teamId: EntityId;
  readonly division: string | null;
  readonly seed: number | null;
  readonly status: RegistrationStatus;
  readonly registeredAt: ISODateTime;
  readonly checkedInAt: ISODateTime | null;
}

export interface AvailabilityWindow {
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly available: boolean;
}

export interface Room {
  readonly id: EntityId;
  readonly name: string;
  readonly building: string | null;
  readonly floor: string | null;
  readonly accessible: boolean;
  readonly directions: string;
  readonly notes: string;
  readonly availability: readonly AvailabilityWindow[];
  readonly active: boolean;
}

export type StaffRole = 'moderator' | 'scorekeeper' | 'runner' | 'hq' | 'director';

export interface StaffMember {
  readonly id: EntityId;
  readonly name: string;
  readonly roles: readonly StaffRole[];
  readonly availability: readonly AvailabilityWindow[];
  readonly notes: string;
  readonly active: boolean;
}

export type ResourceType = 'buzzer' | 'laptop' | 'tablet' | 'projector' | 'other';

export interface Resource {
  readonly id: EntityId;
  readonly type: ResourceType;
  readonly name: string;
  readonly quantity: number;
  readonly availableQuantity: number;
  readonly roomIds: readonly EntityId[];
  readonly notes: string;
  readonly active: boolean;
}

export interface RoomAssignment {
  readonly id: EntityId;
  readonly roomId: EntityId;
  readonly roundId: EntityId;
  readonly moderatorId: EntityId | null;
  readonly scorekeeperId: EntityId | null;
  readonly resourceIds: readonly EntityId[];
}

export type PacketKind = 'standard' | 'replacement' | 'tiebreaker' | 'lightning' | 'custom';
export type PacketStatus = 'available' | 'assigned' | 'used' | 'quarantined' | 'retired';

export interface Packet {
  readonly id: EntityId;
  readonly name: string;
  readonly kind: PacketKind;
  readonly source: string | null;
  readonly status: PacketStatus;
  readonly nominalRoundId: EntityId | null;
  readonly replacementForPacketId: EntityId | null;
  readonly assignedRoundIds: readonly EntityId[];
  readonly assignedGameIds: readonly EntityId[];
  readonly usedGameIds: readonly EntityId[];
  readonly securityNotes: string;
  readonly notes: string;
}

export type PhaseFormat =
  | 'round-robin'
  | 'repeated-round-robin'
  | 'preliminary-pools'
  | 'playoff-pools'
  | 'rebracket'
  | 'crossovers'
  | 'single-elimination'
  | 'semifinals'
  | 'finals'
  | 'placement'
  | 'swiss'
  | 'custom';
export type PhaseStatus = 'draft' | 'scheduled' | 'in-progress' | 'complete' | 'cancelled';
export type CarryoverMode = 'none' | 'intra-pool' | 'all';
export type SeedingMethod = 'straight' | 'snake' | 'manual';
export type TiePolicy = 'block' | 'tiebreaker-game' | 'manual-override' | 'use-seed';

export interface AdvancementRule {
  readonly qualifiersPerPool: number | null;
  readonly totalQualifiers: number | null;
  readonly targetPoolCount: number | null;
  readonly seeding: SeedingMethod;
  readonly tiePolicy: TiePolicy;
  readonly carryover: CarryoverMode;
}

export interface Phase {
  readonly id: EntityId;
  readonly name: string;
  readonly order: number;
  readonly format: PhaseFormat;
  readonly status: PhaseStatus;
  readonly poolIds: readonly EntityId[];
  readonly roundIds: readonly EntityId[];
  readonly advancement: AdvancementRule | null;
  readonly notes: string;
}

export interface Pool {
  readonly id: EntityId;
  readonly phaseId: EntityId;
  readonly name: string;
  readonly order: number;
  readonly teamIds: readonly EntityId[];
  readonly sourcePoolIds: readonly EntityId[];
}

export type RoundStatus = 'draft' | 'ready' | 'live' | 'closed' | 'cancelled';

export interface Round {
  readonly id: EntityId;
  readonly phaseId: EntityId;
  readonly poolId: EntityId | null;
  readonly number: number;
  readonly name: string;
  readonly status: RoundStatus;
  readonly packetIds: readonly EntityId[];
  readonly scheduledGameIds: readonly EntityId[];
}

export type ScheduledGameKind = 'game' | 'tiebreaker' | 'placement' | 'bye';
export type ScheduledGameStatus = 'scheduled' | 'held' | 'in-progress' | 'completed' | 'cancelled';

export interface ScheduledMatch {
  readonly id: EntityId;
  readonly phaseId: EntityId;
  readonly roundId: EntityId;
  readonly poolId: EntityId | null;
  readonly sequence: number;
  readonly kind: Exclude<ScheduledGameKind, 'bye'>;
  readonly teamAId: EntityId;
  readonly teamBId: EntityId;
  readonly roomId: EntityId | null;
  readonly packetId: EntityId | null;
  readonly status: ScheduledGameStatus;
  readonly notes: string;
}

export interface ScheduledBye {
  readonly id: EntityId;
  readonly phaseId: EntityId;
  readonly roundId: EntityId;
  readonly poolId: EntityId | null;
  readonly sequence: number;
  readonly kind: 'bye';
  readonly byeTeamId: EntityId;
  readonly status: ScheduledGameStatus;
  readonly notes: string;
}

export type ScheduledGame = ScheduledMatch | ScheduledBye;

export type GameOutcome = 'played' | 'forfeit' | 'cancelled' | 'partial';
export type ResultSource = 'qbtcp' | 'manual' | 'qbj' | 'yellowfruit' | 'sqbs' | 'import';
export type ResultReviewStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface TeamGameStat {
  readonly teamId: EntityId;
  readonly score: number;
  readonly tossupsHeard: number;
  readonly powers: number;
  readonly gets: number;
  readonly negs: number;
  readonly bonusesHeard: number;
  readonly bonusPoints: number;
  readonly bouncebacks: number;
  readonly lightningPoints: number;
  readonly overtimePoints: number;
}

export interface PlayerGameStat {
  readonly playerId: EntityId;
  readonly teamId: EntityId;
  readonly tossupsHeard: number;
  readonly powers: number;
  readonly gets: number;
  readonly negs: number;
  readonly bonusesHeard: number;
  readonly bonusPoints: number;
  readonly bouncebacks: number;
  readonly points: number;
  readonly notes: string;
}

export interface SubmittedResultPayload {
  readonly scheduledGameId: EntityId;
  readonly phaseId: EntityId;
  readonly roundId: EntityId;
  readonly roomId: EntityId | null;
  readonly packetId: EntityId | null;
  readonly outcome: GameOutcome;
  readonly teamScores: readonly TeamGameStat[];
  readonly playerStats: readonly PlayerGameStat[];
  readonly notes: string;
}

export interface GameResult extends SubmittedResultPayload {
  readonly id: EntityId;
  readonly fingerprint: string;
  readonly source: ResultSource;
  readonly receivedAt: ISODateTime;
  readonly acceptedAt: ISODateTime | null;
  readonly acceptedBy: string | null;
  readonly reviewStatus: ResultReviewStatus;
  readonly revision: number;
  readonly originalSubmissionId: EntityId | null;
  readonly supersedesResultId: EntityId | null;
}

export type ResultSubmissionStatus = 'clean' | 'review' | 'accepted' | 'rejected' | 'duplicate';
export type ResultIssueSeverity = 'error' | 'warning';

export interface ResultIssue {
  readonly code: string;
  readonly severity: ResultIssueSeverity;
  readonly message: string;
  readonly entityIds: readonly EntityId[];
}

export interface ResultSubmission {
  readonly id: EntityId;
  readonly receivedAt: ISODateTime;
  readonly source: ResultSource;
  readonly sessionId: EntityId | null;
  readonly roomId: EntityId | null;
  readonly clientId: string | null;
  readonly fingerprint: string;
  readonly rawPayload: JsonValue;
  readonly payload: SubmittedResultPayload;
  readonly issues: readonly ResultIssue[];
  readonly status: ResultSubmissionStatus;
  readonly duplicateOfSubmissionId: EntityId | null;
  readonly acceptedResultId: EntityId | null;
}

export type ProtestCategory = 'scoring' | 'question' | 'procedure' | 'eligibility' | 'other';
export type ProtestStatus = 'open' | 'under-review' | 'upheld' | 'denied' | 'withdrawn';

export interface ProtestScoreImpact {
  readonly teamId: EntityId;
  readonly delta: number;
  readonly reason: string;
}

export interface Protest {
  readonly id: EntityId;
  readonly scheduledGameId: EntityId;
  readonly resultId: EntityId | null;
  readonly category: ProtestCategory;
  readonly questionNumber: number | null;
  readonly description: string;
  readonly status: ProtestStatus;
  readonly ruling: string | null;
  readonly notes: string;
  readonly scoreImpacts: readonly ProtestScoreImpact[];
  readonly createdAt: ISODateTime;
  readonly createdBy: string;
  readonly updatedAt: ISODateTime;
  readonly resolvedAt: ISODateTime | null;
  readonly resolvedBy: string | null;
}

export type AuditEventType =
  | 'tournament-created'
  | 'metadata-changed'
  | 'team-added'
  | 'team-updated'
  | 'team-status-changed'
  | 'roster-changed'
  | 'room-changed'
  | 'staff-changed'
  | 'packet-changed'
  | 'schedule-generated'
  | 'schedule-repaired'
  | 'result-submitted'
  | 'result-accepted'
  | 'result-edited'
  | 'result-rejected'
  | 'protest-opened'
  | 'protest-ruled'
  | 'advancement-previewed'
  | 'advancement-committed'
  | 'override-recorded'
  | 'checkpoint-created';

export interface AuditEvent {
  readonly id: EntityId;
  readonly at: ISODateTime;
  readonly actor: string;
  readonly type: AuditEventType;
  readonly entityType: string;
  readonly entityId: EntityId;
  readonly summary: string;
  readonly details: JsonValue | null;
  readonly undoable: boolean;
}

export type QbtcpSessionStatus = 'paired' | 'connected' | 'disconnected' | 'expired';

export interface QbtcpRoomSession {
  readonly id: EntityId;
  readonly roomId: EntityId;
  readonly clientId: string;
  readonly protocolVersion: string;
  readonly capabilities: readonly string[];
  readonly status: QbtcpSessionStatus;
  readonly pairedAt: ISODateTime;
  readonly lastSeenAt: ISODateTime | null;
  readonly assignmentId: EntityId | null;
}

export interface ApplicationMetadata {
  readonly schemaVersion: number;
  readonly lastOpenedAt: ISODateTime | null;
  readonly lastSavedAt: ISODateTime | null;
}

export interface TournamentSnapshot {
  readonly application: ApplicationMetadata;
  readonly metadata: TournamentMetadata;
  readonly rules: TournamentRules;
  readonly organizations: readonly Organization[];
  readonly teams: readonly Team[];
  readonly players: readonly Player[];
  readonly registrations: readonly Registration[];
  readonly rooms: readonly Room[];
  readonly staff: readonly StaffMember[];
  readonly resources: readonly Resource[];
  readonly roomAssignments: readonly RoomAssignment[];
  readonly packets: readonly Packet[];
  readonly phases: readonly Phase[];
  readonly pools: readonly Pool[];
  readonly rounds: readonly Round[];
  readonly scheduledGames: readonly ScheduledGame[];
  readonly results: readonly GameResult[];
  readonly resultSubmissions: readonly ResultSubmission[];
  readonly protests: readonly Protest[];
  readonly auditEvents: readonly AuditEvent[];
  readonly qbtcpSessions: readonly QbtcpRoomSession[];
}

export interface Clock {
  now(): ISODateTime;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

let fallbackIdCounter = 0;

/** Generate an opaque identifier for a newly-created domain object. */
export function newEntityId(prefix: string): EntityId {
  const runtimeCrypto = (
    globalThis as typeof globalThis & {
      crypto?: { randomUUID?: () => string };
    }
  ).crypto;
  if (runtimeCrypto?.randomUUID) return `${prefix}-${runtimeCrypto.randomUUID()}`;
  fallbackIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
}

export interface CreateTournamentInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly shortName?: string;
  readonly date?: string | null;
  readonly location?: string | null;
  readonly organizer?: string | null;
  readonly director?: string | null;
  readonly notes?: string;
  readonly rules?: TournamentRules;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DomainError(`${field} must not be empty.`);
  return normalized;
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized || null;
}

export class DomainError extends Error {
  public readonly code: string;

  public constructor(message: string, code = 'invalid-domain-operation') {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Create a new empty tournament snapshot with no application fixtures. */
export function createTournament(
  input: CreateTournamentInput,
  clock: Clock = systemClock,
): TournamentSnapshot {
  const now = clock.now();
  const id = input.id ?? newEntityId('tournament');
  const name = requiredText(input.name, 'Tournament name');
  const metadata: TournamentMetadata = {
    id,
    name,
    shortName: optionalText(input.shortName) ?? name,
    date: optionalText(input.date),
    location: optionalText(input.location),
    organizer: optionalText(input.organizer),
    director: optionalText(input.director),
    notes: input.notes?.trim() ?? '',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  return {
    application: { schemaVersion: 1, lastOpenedAt: now, lastSavedAt: now },
    metadata,
    rules: input.rules ?? defaultRules('acf'),
    organizations: [],
    teams: [],
    players: [],
    registrations: [],
    rooms: [],
    staff: [],
    resources: [],
    roomAssignments: [],
    packets: [],
    phases: [],
    pools: [],
    rounds: [],
    scheduledGames: [],
    results: [],
    resultSubmissions: [],
    protests: [],
    auditEvents: [
      {
        id: newEntityId('audit'),
        at: now,
        actor: 'system',
        type: 'tournament-created',
        entityType: 'tournament',
        entityId: id,
        summary: `Created tournament “${name}”.`,
        details: null,
        undoable: false,
      },
    ],
    qbtcpSessions: [],
  };
}

export interface AuditContext {
  readonly actor?: string;
  readonly clock?: Clock;
}

function auditEvent(input: Omit<AuditEvent, 'id' | 'at'>, context: AuditContext = {}): AuditEvent {
  return {
    ...input,
    id: newEntityId('audit'),
    at: context.clock?.now() ?? systemClock.now(),
    actor: context.actor?.trim() || 'system',
  };
}

export function recordAuditEvent(
  snapshot: TournamentSnapshot,
  input: Omit<AuditEvent, 'id' | 'at'>,
  context: AuditContext = {},
): TournamentSnapshot {
  const now = context.clock?.now() ?? systemClock.now();
  return {
    ...snapshot,
    metadata: { ...snapshot.metadata, updatedAt: now },
    application: { ...snapshot.application, lastSavedAt: now },
    auditEvents: [...snapshot.auditEvents, auditEvent(input, context)],
  };
}

export type TournamentMetadataChanges = Partial<
  Pick<
    TournamentMetadata,
    'name' | 'shortName' | 'date' | 'location' | 'organizer' | 'director' | 'notes' | 'status'
  >
>;

/** Update tournament metadata while preserving creation history and recording the change. */
export function updateTournamentMetadata(
  snapshot: TournamentSnapshot,
  changes: TournamentMetadataChanges,
  context: AuditContext = {},
): TournamentSnapshot {
  const current = snapshot.metadata;
  const nextName = changes.name === undefined ? current.name : requiredText(changes.name, 'Tournament name');
  const now = context.clock?.now() ?? systemClock.now();
  const metadata: TournamentMetadata = {
    ...current,
    ...changes,
    name: nextName,
    shortName:
      changes.shortName === undefined ? current.shortName : (optionalText(changes.shortName) ?? nextName),
    date: changes.date === undefined ? current.date : optionalText(changes.date),
    location: changes.location === undefined ? current.location : optionalText(changes.location),
    organizer: changes.organizer === undefined ? current.organizer : optionalText(changes.organizer),
    director: changes.director === undefined ? current.director : optionalText(changes.director),
    notes: changes.notes === undefined ? current.notes : changes.notes.trim(),
    status: changes.status ?? current.status,
    updatedAt: now,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), metadata },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'tournament',
      entityId: snapshot.metadata.id,
      summary: `Updated tournament metadata for “${metadata.name}”.`,
      details: changes as unknown as JsonValue,
      undoable: true,
    },
    context,
  );
}

/** Replace the complete ruleset only after validating its scoring shape. */
export function updateTournamentRules(
  snapshot: TournamentSnapshot,
  rules: TournamentRules,
  context: AuditContext = {},
): TournamentSnapshot {
  const issues = validateRules(rules);
  if (issues.length > 0) {
    throw new DomainError(
      `Rules are invalid: ${issues.map((issue) => issue.message).join(' ')}`,
      'invalid-rules',
    );
  }
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), rules },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'rules',
      entityId: snapshot.metadata.id,
      summary: `Updated rules to the ${rules.preset} ruleset.`,
      details: rules as unknown as JsonValue,
      undoable: true,
    },
    context,
  );
}

function touch(snapshot: TournamentSnapshot, clock: Clock = systemClock): TournamentSnapshot {
  const now = clock.now();
  return {
    ...snapshot,
    metadata: { ...snapshot.metadata, updatedAt: now },
    application: { ...snapshot.application, lastSavedAt: now },
  };
}

function normalizedKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function ensureUniqueName(values: readonly { name: string }[], name: string, entity: string): void {
  const key = normalizedKey(name);
  if (values.some((value) => normalizedKey(value.name) === key)) {
    throw new DomainError(`${entity} “${name}” already exists.`, 'duplicate-name');
  }
}

export interface NewOrganizationInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly shortName?: string | null;
  readonly notes?: string;
  readonly active?: boolean;
}

export function addOrganization(
  snapshot: TournamentSnapshot,
  input: NewOrganizationInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Organization name');
  ensureUniqueName(snapshot.organizations, name, 'Organization');
  const now = context.clock?.now() ?? systemClock.now();
  const organization: Organization = {
    id: input.id ?? newEntityId('organization'),
    name,
    shortName: optionalText(input.shortName),
    notes: input.notes?.trim() ?? '',
    active: input.active ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), organizations: [...snapshot.organizations, organization] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'organization',
      entityId: organization.id,
      summary: `Added organization “${organization.name}”.`,
      details: { name: organization.name },
      undoable: true,
    },
    context,
  );
}

export interface NewTeamInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly displayName?: string;
  readonly letter?: string | null;
  readonly organizationId?: EntityId | null;
  readonly seed?: number | null;
  readonly status?: TeamStatus;
  readonly notes?: string;
}

export interface NewRegistrationInput {
  readonly id?: EntityId;
  readonly teamId: EntityId;
  readonly division?: string | null;
  readonly seed?: number | null;
  readonly status?: RegistrationStatus;
}

export function addRegistration(
  snapshot: TournamentSnapshot,
  input: NewRegistrationInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const team = snapshot.teams.find((candidate) => candidate.id === input.teamId);
  if (!team) throw new DomainError(`Team “${input.teamId}” does not exist.`, 'missing-team');
  if (
    snapshot.registrations.some(
      (registration) =>
        registration.teamId === input.teamId && registration.tournamentId === snapshot.metadata.id,
    )
  ) {
    throw new DomainError(`Team “${team.displayName}” is already registered.`, 'duplicate-registration');
  }
  const seed = input.seed ?? team.seed;
  if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
    throw new DomainError('Registration seed must be a positive integer.', 'invalid-seed');
  }
  const now = context.clock?.now() ?? systemClock.now();
  const registration: Registration = {
    id: input.id ?? newEntityId('registration'),
    tournamentId: snapshot.metadata.id,
    teamId: input.teamId,
    division: optionalText(input.division),
    seed,
    status: input.status ?? 'registered',
    registeredAt: now,
    checkedInAt: input.status === 'checked-in' ? now : null,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), registrations: [...snapshot.registrations, registration] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'registration',
      entityId: registration.id,
      summary: `Registered team “${team.displayName}”.`,
      details: { teamId: team.id, division: registration.division, seed: registration.seed },
      undoable: true,
    },
    context,
  );
}

function assertOrganization(snapshot: TournamentSnapshot, organizationId: EntityId | null | undefined): void {
  if (organizationId && !snapshot.organizations.some((organization) => organization.id === organizationId)) {
    throw new DomainError(`Organization “${organizationId}” does not exist.`, 'missing-organization');
  }
}

export function addTeam(
  snapshot: TournamentSnapshot,
  input: NewTeamInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Team name');
  assertOrganization(snapshot, input.organizationId);
  ensureUniqueName(snapshot.teams, name, 'Team');
  const seed = input.seed ?? null;
  if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
    throw new DomainError('Team seed must be a positive integer.', 'invalid-seed');
  }
  const now = context.clock?.now() ?? systemClock.now();
  const team: Team = {
    id: input.id ?? newEntityId('team'),
    name,
    displayName: requiredText(input.displayName ?? name, 'Team display name'),
    letter: optionalText(input.letter),
    organizationId: input.organizationId ?? null,
    seed,
    status: input.status ?? 'active',
    playerIds: [],
    notes: input.notes?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), teams: [...snapshot.teams, team] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'team-added',
      entityType: 'team',
      entityId: team.id,
      summary: `Added team “${team.displayName}”.`,
      details: { organizationId: team.organizationId, seed: team.seed },
      undoable: true,
    },
    context,
  );
}

export function updateTeam(
  snapshot: TournamentSnapshot,
  teamId: EntityId,
  changes: Partial<Pick<Team, 'name' | 'displayName' | 'letter' | 'organizationId' | 'seed' | 'notes'>>,
  context: AuditContext = {},
): TournamentSnapshot {
  const current = snapshot.teams.find((team) => team.id === teamId);
  if (!current) throw new DomainError(`Team “${teamId}” does not exist.`, 'missing-team');
  assertOrganization(snapshot, changes.organizationId ?? current.organizationId);
  const nextName = changes.name === undefined ? current.name : requiredText(changes.name, 'Team name');
  if (nextName !== current.name) {
    ensureUniqueName(
      snapshot.teams.filter((team) => team.id !== teamId),
      nextName,
      'Team',
    );
  }
  const nextSeed = changes.seed === undefined ? current.seed : changes.seed;
  if (nextSeed !== null && (!Number.isInteger(nextSeed) || nextSeed < 1)) {
    throw new DomainError('Team seed must be a positive integer.', 'invalid-seed');
  }
  const now = context.clock?.now() ?? systemClock.now();
  const next: Team = {
    ...current,
    ...changes,
    name: nextName,
    displayName:
      changes.displayName === undefined
        ? current.displayName
        : requiredText(changes.displayName, 'Team display name'),
    letter: changes.letter === undefined ? current.letter : optionalText(changes.letter),
    organizationId: changes.organizationId === undefined ? current.organizationId : changes.organizationId,
    seed: nextSeed,
    notes: changes.notes === undefined ? current.notes : changes.notes.trim(),
    updatedAt: now,
  };
  const updated = {
    ...touch(snapshot, context.clock),
    teams: snapshot.teams.map((team) => (team.id === teamId ? next : team)),
  };
  return recordAuditEvent(
    updated,
    {
      actor: context.actor?.trim() || 'system',
      type: 'team-updated',
      entityType: 'team',
      entityId: teamId,
      summary: `Updated team “${next.displayName}”.`,
      details: changes as unknown as JsonValue,
      undoable: true,
    },
    context,
  );
}

export function setTeamStatus(
  snapshot: TournamentSnapshot,
  teamId: EntityId,
  status: TeamStatus,
  context: AuditContext = {},
): TournamentSnapshot {
  const team = snapshot.teams.find((candidate) => candidate.id === teamId);
  if (!team) throw new DomainError(`Team “${teamId}” does not exist.`, 'missing-team');
  const now = context.clock?.now() ?? systemClock.now();
  const updated = {
    ...touch(snapshot, context.clock),
    teams: snapshot.teams.map((candidate) =>
      candidate.id === teamId ? { ...candidate, status, updatedAt: now } : candidate,
    ),
  };
  return recordAuditEvent(
    updated,
    {
      actor: context.actor?.trim() || 'system',
      type: 'team-status-changed',
      entityType: 'team',
      entityId: teamId,
      summary: `Marked team “${team.displayName}” ${status}.`,
      details: { status },
      undoable: true,
    },
    context,
  );
}

export interface NewPlayerInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly teamId?: EntityId | null;
  readonly organizationId?: EntityId | null;
  readonly grade?: string | null;
  readonly captain?: boolean;
  readonly active?: boolean;
  readonly notes?: string;
}

export function addPlayer(
  snapshot: TournamentSnapshot,
  input: NewPlayerInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Player name');
  const teamId = input.teamId ?? null;
  const team = teamId ? snapshot.teams.find((candidate) => candidate.id === teamId) : undefined;
  if (teamId && !team) throw new DomainError(`Team “${teamId}” does not exist.`, 'missing-team');
  const organizationId = input.organizationId ?? team?.organizationId ?? null;
  assertOrganization(snapshot, organizationId);
  if (
    teamId &&
    team?.playerIds.some(
      (playerId) =>
        snapshot.players.find((player) => player.id === playerId)?.name.toLocaleLowerCase() ===
        name.toLocaleLowerCase(),
    )
  ) {
    throw new DomainError(`Player “${name}” is already on team “${team.displayName}”.`, 'duplicate-player');
  }
  const now = context.clock?.now() ?? systemClock.now();
  const player: Player = {
    id: input.id ?? newEntityId('player'),
    name,
    organizationId,
    teamId,
    grade: optionalText(input.grade),
    captain: input.captain ?? false,
    active: input.active ?? true,
    notes: input.notes?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
  };
  const teams = teamId
    ? snapshot.teams.map((candidate) =>
        candidate.id === teamId
          ? { ...candidate, playerIds: [...candidate.playerIds, player.id], updatedAt: now }
          : candidate,
      )
    : snapshot.teams;
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), players: [...snapshot.players, player], teams },
    {
      actor: context.actor?.trim() || 'system',
      type: 'roster-changed',
      entityType: 'player',
      entityId: player.id,
      summary: `Added player “${player.name}”.`,
      details: { teamId: player.teamId, captain: player.captain },
      undoable: true,
    },
    context,
  );
}

export type PlayerChanges = Partial<
  Pick<Player, 'name' | 'teamId' | 'organizationId' | 'grade' | 'captain' | 'active' | 'notes'>
>;

/** Edit a player, including moving the player between team rosters atomically. */
export function updatePlayer(
  snapshot: TournamentSnapshot,
  playerId: EntityId,
  changes: PlayerChanges,
  context: AuditContext = {},
): TournamentSnapshot {
  const current = snapshot.players.find((player) => player.id === playerId);
  if (!current) throw new DomainError(`Player “${playerId}” does not exist.`, 'missing-player');
  const nextName = changes.name === undefined ? current.name : requiredText(changes.name, 'Player name');
  const nextTeamId = changes.teamId === undefined ? current.teamId : changes.teamId;
  const nextTeam = nextTeamId ? snapshot.teams.find((team) => team.id === nextTeamId) : undefined;
  if (nextTeamId && !nextTeam) throw new DomainError(`Team “${nextTeamId}” does not exist.`, 'missing-team');
  if (
    nextTeam &&
    nextTeam.playerIds.some(
      (candidateId) =>
        candidateId !== playerId &&
        snapshot.players.find((player) => player.id === candidateId)?.name.toLocaleLowerCase() ===
          nextName.toLocaleLowerCase(),
    )
  ) {
    throw new DomainError(
      `Player “${nextName}” is already on team “${nextTeam.displayName}”.`,
      'duplicate-player',
    );
  }
  const nextOrganizationId =
    changes.organizationId === undefined
      ? changes.teamId === undefined
        ? current.organizationId
        : (nextTeam?.organizationId ?? null)
      : changes.organizationId;
  assertOrganization(snapshot, nextOrganizationId);
  const now = context.clock?.now() ?? systemClock.now();
  const player: Player = {
    ...current,
    ...changes,
    name: nextName,
    teamId: nextTeamId,
    organizationId: nextOrganizationId,
    grade: changes.grade === undefined ? current.grade : optionalText(changes.grade),
    notes: changes.notes === undefined ? current.notes : changes.notes.trim(),
    updatedAt: now,
  };
  const teams = snapshot.teams.map((team) => {
    const withoutPlayer = team.playerIds.filter((candidateId) => candidateId !== playerId);
    if (team.id !== nextTeamId) {
      return withoutPlayer.length === team.playerIds.length
        ? team
        : { ...team, playerIds: withoutPlayer, updatedAt: now };
    }
    return {
      ...team,
      playerIds: [...withoutPlayer, playerId],
      updatedAt: now,
    };
  });
  return recordAuditEvent(
    {
      ...touch(snapshot, context.clock),
      players: snapshot.players.map((candidate) => (candidate.id === playerId ? player : candidate)),
      teams,
    },
    {
      actor: context.actor?.trim() || 'system',
      type: 'roster-changed',
      entityType: 'player',
      entityId: playerId,
      summary: `Updated player “${player.name}”.`,
      details: changes as unknown as JsonValue,
      undoable: true,
    },
    context,
  );
}

export function removePlayer(
  snapshot: TournamentSnapshot,
  playerId: EntityId,
  context: AuditContext = {},
): TournamentSnapshot {
  const player = snapshot.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new DomainError(`Player “${playerId}” does not exist.`, 'missing-player');
  const now = context.clock?.now() ?? systemClock.now();
  return recordAuditEvent(
    {
      ...touch(snapshot, context.clock),
      players: snapshot.players.filter((candidate) => candidate.id !== playerId),
      teams: snapshot.teams.map((team) =>
        team.playerIds.includes(playerId)
          ? { ...team, playerIds: team.playerIds.filter((id) => id !== playerId), updatedAt: now }
          : team,
      ),
    },
    {
      actor: context.actor?.trim() || 'system',
      type: 'roster-changed',
      entityType: 'player',
      entityId: playerId,
      summary: `Removed player “${player.name}”.`,
      details: { teamId: player.teamId },
      undoable: true,
    },
    context,
  );
}

export interface NewRoomInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly building?: string | null;
  readonly floor?: string | null;
  readonly accessible?: boolean;
  readonly directions?: string;
  readonly notes?: string;
  readonly availability?: readonly AvailabilityWindow[];
  readonly active?: boolean;
}

export function addRoom(
  snapshot: TournamentSnapshot,
  input: NewRoomInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Room name');
  ensureUniqueName(snapshot.rooms, name, 'Room');
  const room: Room = {
    id: input.id ?? newEntityId('room'),
    name,
    building: optionalText(input.building),
    floor: optionalText(input.floor),
    accessible: input.accessible ?? false,
    directions: input.directions?.trim() ?? '',
    notes: input.notes?.trim() ?? '',
    availability: input.availability ? [...input.availability] : [],
    active: input.active ?? true,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), rooms: [...snapshot.rooms, room] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'room-changed',
      entityType: 'room',
      entityId: room.id,
      summary: `Added room “${room.name}”.`,
      details: { accessible: room.accessible },
      undoable: true,
    },
    context,
  );
}

export interface NewStaffInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly roles?: readonly StaffRole[];
  readonly availability?: readonly AvailabilityWindow[];
  readonly notes?: string;
  readonly active?: boolean;
}

export function addStaffMember(
  snapshot: TournamentSnapshot,
  input: NewStaffInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Staff member name');
  const staffMember: StaffMember = {
    id: input.id ?? newEntityId('staff'),
    name,
    roles: input.roles ? [...new Set(input.roles)] : [],
    availability: input.availability ? [...input.availability] : [],
    notes: input.notes?.trim() ?? '',
    active: input.active ?? true,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), staff: [...snapshot.staff, staffMember] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'staff-changed',
      entityType: 'staff',
      entityId: staffMember.id,
      summary: `Added staff member “${staffMember.name}”.`,
      details: { roles: staffMember.roles },
      undoable: true,
    },
    context,
  );
}

export interface NewResourceInput {
  readonly id?: EntityId;
  readonly type: ResourceType;
  readonly name: string;
  readonly quantity?: number;
  readonly availableQuantity?: number;
  readonly roomIds?: readonly EntityId[];
  readonly notes?: string;
  readonly active?: boolean;
}

export function addResource(
  snapshot: TournamentSnapshot,
  input: NewResourceInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Resource name');
  const quantity = input.quantity ?? 1;
  const availableQuantity = input.availableQuantity ?? quantity;
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    !Number.isInteger(availableQuantity) ||
    availableQuantity < 0 ||
    availableQuantity > quantity
  ) {
    throw new DomainError(
      'Resource quantities must be whole numbers with available quantity in range.',
      'invalid-resource-quantity',
    );
  }
  const roomIds = [...(input.roomIds ?? [])];
  if (roomIds.some((roomId) => !snapshot.rooms.some((room) => room.id === roomId))) {
    throw new DomainError('Resource references a room that does not exist.', 'missing-room');
  }
  const resource: Resource = {
    id: input.id ?? newEntityId('resource'),
    type: input.type,
    name,
    quantity,
    availableQuantity,
    roomIds,
    notes: input.notes?.trim() ?? '',
    active: input.active ?? true,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), resources: [...snapshot.resources, resource] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'room-changed',
      entityType: 'resource',
      entityId: resource.id,
      summary: `Added resource “${resource.name}”.`,
      details: { type: resource.type, quantity: resource.quantity },
      undoable: true,
    },
    context,
  );
}

export interface NewRoomAssignmentInput {
  readonly id?: EntityId;
  readonly roomId: EntityId;
  readonly roundId: EntityId;
  readonly moderatorId?: EntityId | null;
  readonly scorekeeperId?: EntityId | null;
  readonly resourceIds?: readonly EntityId[];
}

export function addRoomAssignment(
  snapshot: TournamentSnapshot,
  input: NewRoomAssignmentInput,
  context: AuditContext = {},
): TournamentSnapshot {
  if (!snapshot.rooms.some((room) => room.id === input.roomId && room.active)) {
    throw new DomainError(`Room “${input.roomId}” does not exist or is inactive.`, 'missing-room');
  }
  if (!snapshot.rounds.some((round) => round.id === input.roundId)) {
    throw new DomainError(`Round “${input.roundId}” does not exist.`, 'missing-round');
  }
  const staffIds = [input.moderatorId ?? null, input.scorekeeperId ?? null].filter((id): id is EntityId =>
    Boolean(id),
  );
  if (staffIds.some((staffId) => !snapshot.staff.some((member) => member.id === staffId && member.active))) {
    throw new DomainError('Room assignment references missing or inactive staff.', 'missing-staff');
  }
  const resourceIds = [...(input.resourceIds ?? [])];
  if (
    resourceIds.some(
      (resourceId) => !snapshot.resources.some((resource) => resource.id === resourceId && resource.active),
    )
  ) {
    throw new DomainError('Room assignment references missing or inactive equipment.', 'missing-resource');
  }
  if (
    snapshot.roomAssignments.some(
      (assignment) => assignment.roomId === input.roomId && assignment.roundId === input.roundId,
    )
  ) {
    throw new DomainError(
      `Room “${input.roomId}” already has an assignment for this round.`,
      'duplicate-room-assignment',
    );
  }
  const assignment: RoomAssignment = {
    id: input.id ?? newEntityId('room-assignment'),
    roomId: input.roomId,
    roundId: input.roundId,
    moderatorId: input.moderatorId ?? null,
    scorekeeperId: input.scorekeeperId ?? null,
    resourceIds,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), roomAssignments: [...snapshot.roomAssignments, assignment] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'room-changed',
      entityType: 'room-assignment',
      entityId: assignment.id,
      summary: `Assigned room “${assignment.roomId}” to round “${assignment.roundId}”.`,
      details: { moderatorId: assignment.moderatorId, scorekeeperId: assignment.scorekeeperId, resourceIds },
      undoable: true,
    },
    context,
  );
}

export interface NewPacketInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly kind?: PacketKind;
  readonly source?: string | null;
  readonly nominalRoundId?: EntityId | null;
  readonly replacementForPacketId?: EntityId | null;
  readonly securityNotes?: string;
  readonly notes?: string;
}

export function addPacket(
  snapshot: TournamentSnapshot,
  input: NewPacketInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Packet name');
  if (input.nominalRoundId && !snapshot.rounds.some((round) => round.id === input.nominalRoundId)) {
    throw new DomainError(`Round “${input.nominalRoundId}” does not exist.`, 'missing-round');
  }
  if (
    input.replacementForPacketId &&
    !snapshot.packets.some((packet) => packet.id === input.replacementForPacketId)
  ) {
    throw new DomainError(`Packet “${input.replacementForPacketId}” does not exist.`, 'missing-packet');
  }
  const packet: Packet = {
    id: input.id ?? newEntityId('packet'),
    name,
    kind: input.kind ?? 'standard',
    source: optionalText(input.source),
    status: 'available',
    nominalRoundId: input.nominalRoundId ?? null,
    replacementForPacketId: input.replacementForPacketId ?? null,
    assignedRoundIds: [],
    assignedGameIds: [],
    usedGameIds: [],
    securityNotes: input.securityNotes?.trim() ?? '',
    notes: input.notes?.trim() ?? '',
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), packets: [...snapshot.packets, packet] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'packet-changed',
      entityType: 'packet',
      entityId: packet.id,
      summary: `Added packet “${packet.name}”.`,
      details: { kind: packet.kind, source: packet.source },
      undoable: true,
    },
    context,
  );
}

export interface NewPhaseInput {
  readonly id?: EntityId;
  readonly name: string;
  readonly order: number;
  readonly format: PhaseFormat;
  readonly advancement?: AdvancementRule | null;
  readonly notes?: string;
}

export function addPhase(
  snapshot: TournamentSnapshot,
  input: NewPhaseInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const name = requiredText(input.name, 'Phase name');
  if (!Number.isInteger(input.order) || input.order < 0) {
    throw new DomainError('Phase order must be a non-negative integer.', 'invalid-phase-order');
  }
  if (snapshot.phases.some((phase) => phase.order === input.order)) {
    throw new DomainError(`Phase order ${input.order} is already in use.`, 'duplicate-phase-order');
  }
  const phase: Phase = {
    id: input.id ?? newEntityId('phase'),
    name,
    order: input.order,
    format: input.format,
    status: 'draft',
    poolIds: [],
    roundIds: [],
    advancement: input.advancement ?? null,
    notes: input.notes?.trim() ?? '',
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), phases: [...snapshot.phases, phase] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'phase',
      entityId: phase.id,
      summary: `Added phase “${phase.name}”.`,
      details: { format: phase.format, order: phase.order },
      undoable: true,
    },
    context,
  );
}

export interface NewPoolInput {
  readonly id?: EntityId;
  readonly phaseId: EntityId;
  readonly name: string;
  readonly order: number;
  readonly teamIds?: readonly EntityId[];
  readonly sourcePoolIds?: readonly EntityId[];
}

export function addPool(
  snapshot: TournamentSnapshot,
  input: NewPoolInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const phase = snapshot.phases.find((candidate) => candidate.id === input.phaseId);
  if (!phase) throw new DomainError(`Phase “${input.phaseId}” does not exist.`, 'missing-phase');
  const name = requiredText(input.name, 'Pool name');
  if (
    snapshot.pools.some(
      (pool) => pool.phaseId === input.phaseId && normalizedKey(pool.name) === normalizedKey(name),
    )
  ) {
    throw new DomainError(`Pool “${name}” already exists in this phase.`, 'duplicate-pool-name');
  }
  const teamIds = [...(input.teamIds ?? [])];
  if (new Set(teamIds).size !== teamIds.length) {
    throw new DomainError('A pool cannot contain the same team twice.', 'duplicate-team');
  }
  if (teamIds.some((teamId) => !snapshot.teams.some((team) => team.id === teamId))) {
    throw new DomainError('Pool references a team that does not exist.', 'missing-team');
  }
  const sourcePoolIds = [...(input.sourcePoolIds ?? [])];
  if (sourcePoolIds.some((poolId) => !snapshot.pools.some((pool) => pool.id === poolId))) {
    throw new DomainError('Pool references a source pool that does not exist.', 'missing-pool');
  }
  const pool: Pool = {
    id: input.id ?? newEntityId('pool'),
    phaseId: input.phaseId,
    name,
    order: input.order,
    teamIds,
    sourcePoolIds,
  };
  const updatedPhase: Phase = { ...phase, poolIds: [...phase.poolIds, pool.id] };
  return recordAuditEvent(
    {
      ...touch(snapshot, context.clock),
      phases: snapshot.phases.map((candidate) => (candidate.id === phase.id ? updatedPhase : candidate)),
      pools: [...snapshot.pools, pool],
    },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'pool',
      entityId: pool.id,
      summary: `Added pool “${pool.name}”.`,
      details: { phaseId: pool.phaseId, teamCount: pool.teamIds.length },
      undoable: true,
    },
    context,
  );
}

export interface NewRoundInput {
  readonly id?: EntityId;
  readonly phaseId: EntityId;
  readonly poolId?: EntityId | null;
  readonly number: number;
  readonly name?: string;
  readonly packetIds?: readonly EntityId[];
}

export function addRound(
  snapshot: TournamentSnapshot,
  input: NewRoundInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const phase = snapshot.phases.find((candidate) => candidate.id === input.phaseId);
  if (!phase) throw new DomainError(`Phase “${input.phaseId}” does not exist.`, 'missing-phase');
  const poolId = input.poolId ?? null;
  if (poolId && !snapshot.pools.some((pool) => pool.id === poolId && pool.phaseId === input.phaseId)) {
    throw new DomainError(`Pool “${poolId}” does not belong to phase “${input.phaseId}”.`, 'invalid-pool');
  }
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new DomainError('Round number must be a positive integer.', 'invalid-round-number');
  }
  if (
    snapshot.rounds.some(
      (round) => round.phaseId === input.phaseId && round.poolId === poolId && round.number === input.number,
    )
  ) {
    throw new DomainError(`Round ${input.number} already exists in this phase/pool.`, 'duplicate-round');
  }
  const packetIds = [...(input.packetIds ?? [])];
  if (packetIds.some((packetId) => !snapshot.packets.some((packet) => packet.id === packetId))) {
    throw new DomainError('Round references a packet that does not exist.', 'missing-packet');
  }
  const round: Round = {
    id: input.id ?? newEntityId('round'),
    phaseId: input.phaseId,
    poolId,
    number: input.number,
    name: input.name?.trim() || `Round ${input.number}`,
    status: 'draft',
    packetIds,
    scheduledGameIds: [],
  };
  const updatedPhase: Phase = { ...phase, roundIds: [...phase.roundIds, round.id] };
  return recordAuditEvent(
    {
      ...touch(snapshot, context.clock),
      phases: snapshot.phases.map((candidate) => (candidate.id === phase.id ? updatedPhase : candidate)),
      rounds: [...snapshot.rounds, round],
    },
    {
      actor: context.actor?.trim() || 'system',
      type: 'metadata-changed',
      entityType: 'round',
      entityId: round.id,
      summary: `Added ${round.name}.`,
      details: { phaseId: round.phaseId, poolId: round.poolId },
      undoable: true,
    },
    context,
  );
}

function appendUnique(values: readonly EntityId[], additions: readonly EntityId[]): EntityId[] {
  return [...new Set([...values, ...additions])];
}

/** Attach a generated schedule to a snapshot and update its round/packet indexes atomically. */
export function attachSchedule(
  snapshot: TournamentSnapshot,
  games: readonly ScheduledGame[],
  context: AuditContext = {},
): TournamentSnapshot {
  const phaseIds = new Set(snapshot.phases.map((phase) => phase.id));
  const roundById = new Map(snapshot.rounds.map((round) => [round.id, round]));
  const packetById = new Map(snapshot.packets.map((packet) => [packet.id, packet]));
  const roomIds = new Set(snapshot.rooms.filter((room) => room.active).map((room) => room.id));
  const teamIds = new Set(snapshot.teams.map((team) => team.id));
  if (
    new Set(games.map((game) => game.id)).size !== games.length ||
    games.some((game) => snapshot.scheduledGames.some((existing) => existing.id === game.id))
  ) {
    throw new DomainError('Schedule game ids must be unique and new to this tournament.', 'duplicate-game');
  }
  for (const game of games) {
    if (!phaseIds.has(game.phaseId))
      throw new DomainError(`Phase “${game.phaseId}” does not exist.`, 'missing-phase');
    if (!roundById.has(game.roundId))
      throw new DomainError(`Round “${game.roundId}” does not exist.`, 'missing-round');
    if (game.kind === 'bye') {
      if (!teamIds.has(game.byeTeamId))
        throw new DomainError(`Team “${game.byeTeamId}” does not exist.`, 'missing-team');
      continue;
    }
    if (!teamIds.has(game.teamAId) || !teamIds.has(game.teamBId))
      throw new DomainError('Schedule references a team that does not exist.', 'missing-team');
    if (game.roomId && !roomIds.has(game.roomId))
      throw new DomainError(`Room “${game.roomId}” does not exist or is inactive.`, 'missing-room');
    if (game.packetId && !packetById.has(game.packetId))
      throw new DomainError(`Packet “${game.packetId}” does not exist.`, 'missing-packet');
  }
  const scheduledGames = [...snapshot.scheduledGames, ...games];
  const roundGameIds = new Map<EntityId, EntityId[]>();
  const packetGameIds = new Map<EntityId, EntityId[]>();
  for (const game of games) {
    const roundGames = roundGameIds.get(game.roundId) ?? [];
    roundGames.push(game.id);
    roundGameIds.set(game.roundId, roundGames);
    if (game.kind !== 'bye' && game.packetId) {
      const packetGames = packetGameIds.get(game.packetId) ?? [];
      packetGames.push(game.id);
      packetGameIds.set(game.packetId, packetGames);
    }
  }
  const rounds = snapshot.rounds.map((round) => ({
    ...round,
    scheduledGameIds: appendUnique(round.scheduledGameIds, roundGameIds.get(round.id) ?? []),
    status: round.status === 'draft' ? ('ready' as const) : round.status,
  }));
  const packets = snapshot.packets.map((packet) => {
    const addedGameIds = packetGameIds.get(packet.id) ?? [];
    if (addedGameIds.length === 0) return packet;
    const addedRoundIds = games
      .filter((game) => game.kind !== 'bye' && game.packetId === packet.id)
      .map((game) => game.roundId);
    return {
      ...packet,
      assignedGameIds: appendUnique(packet.assignedGameIds, addedGameIds),
      assignedRoundIds: appendUnique(packet.assignedRoundIds, addedRoundIds),
      status: packet.status === 'available' ? ('assigned' as const) : packet.status,
    };
  });
  const phases = snapshot.phases.map((phase) =>
    games.some((game) => game.phaseId === phase.id) && phase.status === 'draft'
      ? { ...phase, status: 'scheduled' as const }
      : phase,
  );
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), scheduledGames, rounds, packets, phases },
    {
      actor: context.actor?.trim() || 'system',
      type: 'schedule-generated',
      entityType: 'phase',
      entityId: games[0]?.phaseId ?? snapshot.metadata.id,
      summary: `Attached ${games.length} scheduled entries.`,
      details: { gameIds: games.map((game) => game.id), gameCount: games.length },
      undoable: true,
    },
    context,
  );
}

/** Persist an incoming submission while retaining its raw payload and duplicate fingerprint. */
export function recordResultSubmission(
  snapshot: TournamentSnapshot,
  submission: ResultSubmission,
  context: AuditContext = {},
): TournamentSnapshot {
  if (snapshot.resultSubmissions.some((existing) => existing.id === submission.id)) {
    throw new DomainError(
      `Result submission “${submission.id}” is already recorded.`,
      'duplicate-submission-id',
    );
  }
  const duplicate = snapshot.resultSubmissions.find(
    (existing) => existing.fingerprint === submission.fingerprint,
  );
  const persisted: ResultSubmission = duplicate
    ? { ...submission, status: 'duplicate', duplicateOfSubmissionId: duplicate.id }
    : submission;
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), resultSubmissions: [...snapshot.resultSubmissions, persisted] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'result-submitted',
      entityType: 'result-submission',
      entityId: persisted.id,
      summary: duplicate
        ? `Recorded duplicate result submission for “${persisted.payload.scheduledGameId}”.`
        : `Received result submission for “${persisted.payload.scheduledGameId}”.`,
      details: {
        fingerprint: persisted.fingerprint,
        status: persisted.status,
        duplicateOfSubmissionId: persisted.duplicateOfSubmissionId,
      },
      undoable: false,
    },
    context,
  );
}

function assertAcceptedResultReferencesSnapshot(
  snapshot: TournamentSnapshot,
  result: GameResult,
): ScheduledMatch {
  if (snapshot.results.some((candidate) => candidate.id === result.id)) {
    throw new DomainError(`Game result “${result.id}” is already recorded.`, 'duplicate-result-id');
  }
  const scheduledGame = snapshot.scheduledGames.find((game) => game.id === result.scheduledGameId);
  if (!scheduledGame || scheduledGame.kind === 'bye')
    throw new DomainError(`Scheduled game “${result.scheduledGameId}” does not exist.`, 'missing-game');
  const round = snapshot.rounds.find((candidate) => candidate.id === result.roundId);
  if (!round || round.phaseId !== result.phaseId || round.phaseId !== scheduledGame.phaseId) {
    throw new DomainError(
      'Accepted result phase and round do not match the scheduled game.',
      'result-round-mismatch',
    );
  }
  if (scheduledGame.roundId !== result.roundId) {
    throw new DomainError(
      'Accepted result round does not match the scheduled game.',
      'result-round-mismatch',
    );
  }
  if (scheduledGame.phaseId !== result.phaseId) {
    throw new DomainError(
      'Accepted result phase does not match the scheduled game.',
      'result-phase-mismatch',
    );
  }
  if (scheduledGame.roomId !== result.roomId) {
    throw new DomainError('Accepted result room does not match the scheduled game.', 'result-room-mismatch');
  }
  if (scheduledGame.packetId !== result.packetId) {
    throw new DomainError(
      'Accepted result packet does not match the scheduled game.',
      'result-packet-mismatch',
    );
  }
  const expectedTeamIds = new Set([scheduledGame.teamAId, scheduledGame.teamBId]);
  const submittedTeamIds = result.teamScores.map((score) => score.teamId);
  if (
    submittedTeamIds.length !== 2 ||
    new Set(submittedTeamIds).size !== submittedTeamIds.length ||
    submittedTeamIds.some((teamId) => !expectedTeamIds.has(teamId))
  ) {
    throw new DomainError(
      'Accepted result must contain exactly the two scheduled teams.',
      'result-team-mismatch',
    );
  }
  const teamIds = new Set(snapshot.teams.map((team) => team.id));
  if (submittedTeamIds.some((teamId) => !teamIds.has(teamId))) {
    throw new DomainError('Accepted result references an unknown team.', 'missing-team');
  }
  const playerById = new Map(snapshot.players.map((player) => [player.id, player]));
  const playerIds = new Set<EntityId>();
  for (const stat of result.playerStats) {
    if (playerIds.has(stat.playerId))
      throw new DomainError('Accepted result contains duplicate player statistics.', 'duplicate-player-stat');
    playerIds.add(stat.playerId);
    const player = playerById.get(stat.playerId);
    if (!player) throw new DomainError(`Player “${stat.playerId}” does not exist.`, 'missing-player');
    if (player.teamId !== stat.teamId || !expectedTeamIds.has(stat.teamId)) {
      throw new DomainError(
        `Player “${stat.playerId}” is not registered to a team in this game.`,
        'player-team-mismatch',
      );
    }
  }
  if (
    result.originalSubmissionId &&
    !snapshot.resultSubmissions.some((submission) => submission.id === result.originalSubmissionId)
  ) {
    throw new DomainError(
      `Original submission “${result.originalSubmissionId}” does not exist.`,
      'missing-submission',
    );
  }
  return scheduledGame;
}

/** Store an accepted result and close its scheduled game without deleting prior revisions. */
export function acceptGameResult(
  snapshot: TournamentSnapshot,
  result: GameResult,
  context: AuditContext = {},
): TournamentSnapshot {
  if (result.reviewStatus !== 'accepted')
    throw new DomainError('Only accepted results can be added to standings.', 'result-not-accepted');
  assertAcceptedResultReferencesSnapshot(snapshot, result);
  const previous = snapshot.results.find(
    (candidate) =>
      candidate.scheduledGameId === result.scheduledGameId && candidate.reviewStatus === 'accepted',
  );
  if (previous && result.supersedesResultId !== previous.id)
    throw new DomainError(
      'An accepted result already exists; create an explicit revision first.',
      'result-conflict',
    );
  const results = previous
    ? snapshot.results
        .map((candidate) =>
          candidate.id === previous.id ? { ...candidate, reviewStatus: 'superseded' as const } : candidate,
        )
        .concat(result)
    : [...snapshot.results, result];
  const submissions = result.originalSubmissionId
    ? snapshot.resultSubmissions.map((submission) =>
        submission.id === result.originalSubmissionId
          ? { ...submission, status: 'accepted' as const, acceptedResultId: result.id }
          : submission,
      )
    : snapshot.resultSubmissions;
  const scheduledGames = snapshot.scheduledGames.map((game) =>
    game.id === result.scheduledGameId
      ? { ...game, status: result.outcome === 'cancelled' ? ('cancelled' as const) : ('completed' as const) }
      : game,
  );
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), results, resultSubmissions: submissions, scheduledGames },
    {
      actor: context.actor?.trim() || result.acceptedBy || 'system',
      type: previous ? 'result-edited' : 'result-accepted',
      entityType: 'game-result',
      entityId: result.id,
      summary: previous
        ? `Accepted corrected result for “${result.scheduledGameId}”.`
        : `Accepted result for “${result.scheduledGameId}”.`,
      details: {
        previousResultId: previous?.id ?? null,
        fingerprint: result.fingerprint,
        revision: result.revision,
      },
      undoable: Boolean(previous),
    },
    context,
  );
}

export interface ProtestResolutionInput {
  readonly status: Exclude<ProtestStatus, 'open' | 'under-review'>;
  readonly ruling: string;
  readonly notes?: string;
  readonly scoreImpacts?: readonly ProtestScoreImpact[];
  readonly resolvedBy: string;
}

export function resolveProtest(
  snapshot: TournamentSnapshot,
  protestId: EntityId,
  input: ProtestResolutionInput,
  context: AuditContext = {},
): TournamentSnapshot {
  const protest = snapshot.protests.find((candidate) => candidate.id === protestId);
  if (!protest) throw new DomainError(`Protest “${protestId}” does not exist.`, 'missing-protest');
  if (!input.ruling.trim()) throw new DomainError('A protest ruling is required.', 'missing-ruling');
  if (!input.resolvedBy.trim()) throw new DomainError('A resolving operator is required.', 'missing-actor');
  const now = context.clock?.now() ?? systemClock.now();
  const updated: Protest = {
    ...protest,
    status: input.status,
    ruling: input.ruling.trim(),
    notes: input.notes?.trim() ?? protest.notes,
    scoreImpacts: input.scoreImpacts ? [...input.scoreImpacts] : protest.scoreImpacts,
    updatedAt: now,
    resolvedAt: now,
    resolvedBy: input.resolvedBy.trim(),
  };
  return recordAuditEvent(
    {
      ...touch(snapshot, context.clock),
      protests: snapshot.protests.map((candidate) => (candidate.id === protestId ? updated : candidate)),
    },
    {
      actor: context.actor?.trim() || input.resolvedBy.trim(),
      type: 'protest-ruled',
      entityType: 'protest',
      entityId: protestId,
      summary: `Ruled protest “${protestId}” ${input.status}.`,
      details: {
        ruling: updated.ruling,
        scoreImpacts: updated.scoreImpacts.map((impact) => ({
          teamId: impact.teamId,
          delta: impact.delta,
          reason: impact.reason,
        })),
      },
      undoable: false,
    },
    context,
  );
}

export function recordProtest(
  snapshot: TournamentSnapshot,
  input: Omit<Protest, 'id' | 'createdAt' | 'updatedAt' | 'resolvedAt' | 'resolvedBy' | 'status'> &
    Partial<Pick<Protest, 'status'>>,
  context: AuditContext = {},
): TournamentSnapshot {
  if (!snapshot.scheduledGames.some((game) => game.id === input.scheduledGameId && game.kind !== 'bye')) {
    throw new DomainError(`Scheduled game “${input.scheduledGameId}” does not exist.`, 'missing-game');
  }
  const now = context.clock?.now() ?? systemClock.now();
  const protest: Protest = {
    ...input,
    id: newEntityId('protest'),
    status: input.status ?? 'open',
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: null,
  };
  return recordAuditEvent(
    { ...touch(snapshot, context.clock), protests: [...snapshot.protests, protest] },
    {
      actor: context.actor?.trim() || 'system',
      type: 'protest-opened',
      entityType: 'protest',
      entityId: protest.id,
      summary: `Opened protest for game “${protest.scheduledGameId}”.`,
      details: { category: protest.category, questionNumber: protest.questionNumber },
      undoable: false,
    },
    context,
  );
}

export function ruleTiebreakers(rules: TournamentRules): readonly Tiebreaker[] {
  return rules.tiebreakers.length > 0
    ? rules.tiebreakers
    : ['wins', 'point-differential', 'points-for', 'seed'];
}
