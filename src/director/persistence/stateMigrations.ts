import {
  defaultRules,
  directorSchemaVersion,
  emptyDirectorState,
  emptyLivePublication,
  fallbackTimeZone,
  normalizeTimeZone,
  normalizeTimelineEvents,
  rosterAmendmentId,
  type DirectorState,
  type GameRecord,
  type LiveBackendDescriptor,
  type Packet,
  type Protest,
  type ResultSubmission,
  type TournamentRules,
} from '../domain';
import { normalizeTransferState } from '../transfers/model';

export class DirectorStateVersionError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(
      `This Director build cannot open state schema v${version}; the newest supported schema is v${directorSchemaVersion}.`,
    );
    this.name = 'DirectorStateVersionError';
    this.version = version;
  }
}

/** Normalize persisted state without hiding a newer schema or a malformed top-level document. */
export function normalizeDirectorState(value: unknown): DirectorState {
  if (value === null || value === undefined) return emptyDirectorState();
  if (!isRecord(value)) throw new Error('Director storage contains an invalid state document.');
  const version = value.schemaVersion === undefined ? 0 : value.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error('Director storage contains an invalid schema version.');
  }
  if (version > directorSchemaVersion) throw new DirectorStateVersionError(version);
  const migrated = migrateDirectorState(value, version);
  return completeState(migrated);
}

/** Apply each known migration explicitly; future versions are rejected by normalizeDirectorState. */
export function migrateDirectorState(
  value: Record<string, unknown>,
  version = readVersion(value),
): Record<string, unknown> {
  let current = structuredClone(value);
  let currentVersion = version;
  while (currentVersion < directorSchemaVersion) {
    if (currentVersion === 0) {
      current = migrateV0ToV1(current);
    } else if (currentVersion === 1) {
      current = migrateV1ToV2(current);
    } else if (currentVersion === 2) {
      current = migrateV2ToV3(current);
    } else if (currentVersion === 3) {
      current = migrateV3ToV4(current);
    } else if (currentVersion === 4) {
      current = migrateV4ToV5(current);
    } else if (currentVersion === 5) {
      current = migrateV5ToV6(current);
    } else {
      throw new Error(`No Director migration exists for schema v${currentVersion}.`);
    }
    currentVersion += 1;
    current.schemaVersion = currentVersion;
  }
  return current;
}

/**
 * v4 separates the schedule, assignment release, and actual start clocks.
 *
 * Before v4 `Round.startedAt` was written by `releaseRound`, so every legacy value is a release
 * timestamp, not evidence that play began. Preserve it as `releasedAt` and leave actual start
 * unknown rather than relabelling it.
 */
function migrateV3ToV4(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  next.rounds = arrayOfRecords(next.rounds, 'rounds').map((round) => ({
    ...round,
    scheduledStart: typeof round.scheduledStart === 'string' ? round.scheduledStart : null,
    releasedAt:
      typeof round.releasedAt === 'string'
        ? round.releasedAt
        : typeof round.startedAt === 'string'
          ? round.startedAt
          : null,
    startedAt: null,
  }));
  return next;
}

/** v5 turns imported QBTCP roster observations into explicit, durable Director decisions. */
function migrateV4ToV5(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  next.qbtcpRosterAmendments = normalizeRosterAmendments(next.qbtcpRosterAmendments);
  return next;
}

/** v6 makes timed regulation an explicit Director rule instead of an assignment-only default. */
function migrateV5ToV6(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  const tournament = asRecord(next.tournament);
  const rules = tournament ? asRecord(tournament.rules) : null;
  if (tournament && rules) {
    const nestedProcedure = ['roomProcedure', 'room_procedure', 'procedure', 'regulation']
      .map((key) => asRecord(rules[key]))
      .find((procedure) => procedure && typeof procedure.timed === 'boolean');
    next.tournament = {
      ...tournament,
      rules: {
        ...rules,
        timed:
          typeof rules.timed === 'boolean'
            ? rules.timed
            : nestedProcedure && typeof nestedProcedure.timed === 'boolean'
              ? nestedProcedure.timed
              : false,
      },
    };
  }
  return next;
}

function readVersion(value: Record<string, unknown>): number {
  const version = value.schemaVersion;
  return version === undefined ? 0 : typeof version === 'number' ? version : -1;
}

function migrateV0ToV1(value: Record<string, unknown>): Record<string, unknown> {
  // v0 was the unversioned browser preview document. Its fields already match v1; recording the
  // transition explicitly keeps this path auditable and prevents an unknown version from being
  // silently treated as current.
  return { ...value, schemaVersion: 1 };
}

function migrateV1ToV2(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  const tournament = asRecord(next.tournament);
  if (tournament) {
    const rounds = arrayOfRecords(next.rounds, 'rounds');
    const currentRoundId = stringOrNull(tournament.currentRoundId);
    const currentRound = currentRoundId ? rounds.find((round) => round.id === currentRoundId) : undefined;
    const formatId = stringOrNull(tournament.formatId);
    const format = formatId
      ? arrayOfRecords(next.formats, 'formats').find((candidate) => candidate.id === formatId)
      : undefined;
    const formatPhaseIds = Array.isArray(format?.phaseIds)
      ? format.phaseIds.filter((id): id is string => typeof id === 'string')
      : [];
    const currentPhaseId =
      stringOrNull(tournament.currentPhaseId) ??
      stringOrNull(currentRound?.phaseId) ??
      (formatPhaseIds.length === 1 ? formatPhaseIds[0] : null);
    next.tournament = {
      ...tournament,
      currentPhaseId,
      currentPacketId: stringOrNull(tournament.currentPacketId),
    };
  }
  next.games = migrateGames(next.games);
  next.submissions = supersedeDuplicateAcceptedSubmissions(next.submissions);
  next.protests = migrateProtests(next.protests);
  return next;
}

/**
 * v3 adds the tournament timezone, the public timeline, and QBSheet Live publication state.
 *
 * A v2 tournament has no recorded zone, and there is no way to recover which one it was run in.
 * Adopting the host's current zone would be a guess that reads as fact on a spectator's phone, so
 * the migration writes UTC and leaves the Director to correct it — a visibly wrong offset is
 * recoverable, a plausibly wrong one is not. Live starts absent rather than disabled: a tournament
 * that never opens the Live section should carry no publication identity at all.
 */
function migrateV2ToV3(value: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(value);
  const tournament = asRecord(next.tournament);
  if (tournament) {
    next.tournament = {
      ...tournament,
      timeZone: typeof tournament.timeZone === 'string' ? tournament.timeZone : fallbackTimeZone,
    };
  }
  if (!Array.isArray(next.timeline)) next.timeline = [];
  if (next.live === undefined) next.live = null;
  return next;
}

function completeState(value: Record<string, unknown>): DirectorState {
  const empty = emptyDirectorState();
  const candidate = value as Partial<DirectorState>;
  if (candidate.metadata !== undefined && !isRecord(candidate.metadata)) {
    throw new Error('Director storage contains invalid metadata.');
  }
  const state: DirectorState = {
    ...empty,
    ...candidate,
    schemaVersion: directorSchemaVersion,
    metadata: { ...empty.metadata, ...(candidate.metadata ?? {}) },
    tournament: normalizeTournament(candidate.tournament),
    organizations: arrayOrEmpty(candidate.organizations, 'organizations'),
    teams: arrayOrEmpty(candidate.teams, 'teams'),
    players: arrayOrEmpty(candidate.players, 'players'),
    staff: arrayOrEmpty(candidate.staff, 'staff'),
    equipment: arrayOrEmpty(candidate.equipment, 'equipment'),
    rooms: arrayOrEmpty(candidate.rooms, 'rooms'),
    packets: arrayOrEmpty(candidate.packets, 'packets'),
    formats: arrayOrEmpty(candidate.formats, 'formats'),
    phases: arrayOrEmpty(candidate.phases, 'phases'),
    pools: arrayOrEmpty(candidate.pools, 'pools'),
    rounds: normalizeRounds(candidate.rounds),
    scheduledGames: normalizeScheduledGames(candidate.scheduledGames),
    games: migrateGames(candidate.games),
    submissions: supersedeDuplicateAcceptedSubmissions(candidate.submissions),
    protests: migrateProtests(candidate.protests),
    audit: arrayOrEmpty(candidate.audit, 'audit'),
    qbtcpSessions: arrayOrEmpty(candidate.qbtcpSessions, 'qbtcpSessions'),
    qbtcpHelpRequests: arrayOrEmpty(candidate.qbtcpHelpRequests, 'qbtcpHelpRequests'),
    qbtcpRosterAmendments: normalizeRosterAmendments(candidate.qbtcpRosterAmendments),
    timeline: normalizeTimelineEvents(candidate.timeline),
    live: normalizeLivePublication(candidate.live),
    transfers: normalizeTransferState(candidate.transfers),
  };
  state.submissions = supersedeDuplicateScheduledSubmissions(state);
  state.packets = canonicalizePacketReferences(state);
  return state;
}

function normalizeRosterAmendments(value: unknown): DirectorState['qbtcpRosterAmendments'] {
  return arrayOfRecords(value, 'qbtcpRosterAmendments').map((entry, index) => {
    const sessionId = stringOrNull(entry.sessionId);
    if (!sessionId)
      throw new Error(`Director storage contains an invalid qbtcpRosterAmendments[${index}] entry.`);
    const amendment = asRecord(entry.amendment);
    if (!amendment)
      throw new Error(`Director storage contains an invalid qbtcpRosterAmendments[${index}] amendment.`);
    const status = entry.status;
    return {
      ...entry,
      id: stringOrNull(entry.id) ?? rosterAmendmentId(sessionId, amendment),
      sessionId,
      amendment: structuredClone(amendment),
      status:
        status === 'approved-new' || status === 'mapped-existing' || status === 'rejected'
          ? status
          : 'pending',
      decidedAt: stringOrNull(entry.decidedAt),
      decidedBy: stringOrNull(entry.decidedBy),
      mappedPlayerId: stringOrNull(entry.mappedPlayerId),
      ...(typeof entry.decisionReason === 'string' && entry.decisionReason.trim()
        ? { decisionReason: entry.decisionReason.trim() }
        : {}),
    };
  });
}

function normalizeRounds(value: unknown): DirectorState['rounds'] {
  return arrayOrEmpty<DirectorState['rounds'][number]>(value, 'rounds').map((round) => ({
    ...round,
    scheduledStart: typeof round.scheduledStart === 'string' ? round.scheduledStart : null,
    releasedAt: typeof round.releasedAt === 'string' ? round.releasedAt : null,
    startedAt: typeof round.startedAt === 'string' ? round.startedAt : null,
  }));
}

function normalizeScheduledGames(value: unknown): DirectorState['scheduledGames'] {
  return arrayOrEmpty<DirectorState['scheduledGames'][number]>(value, 'scheduledGames').map((game) => ({
    ...game,
    scheduledStart: typeof game.scheduledStart === 'string' ? game.scheduledStart : null,
  }));
}

function normalizeTournament(value: unknown): DirectorState['tournament'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Director storage contains an invalid tournament.');
  const rulesValue = value.rules;
  let rules: TournamentRules;
  if (rulesValue === undefined || rulesValue === null) {
    // A missing rules object is a legacy document, not permission to construct an incomplete one.
    // Clone the complete canonical defaults so every scoring field is present and callers cannot
    // mutate the shared defaults through a normalized state.
    rules = structuredClone(defaultRules);
  } else {
    if (!isRecord(rulesValue)) throw new Error('Director storage contains invalid tournament rules.');
    rules = normalizeTournamentRules(rulesValue);
  }
  const id = stringOrNull(value.id);
  if (!id) throw new Error('Director storage contains a tournament without an id.');
  return {
    id,
    name: stringOrEmpty(value.name),
    date: stringOrEmpty(value.date),
    venue: stringOrEmpty(value.venue),
    organizer: stringOrEmpty(value.organizer),
    status: isTournamentStatus(value.status) ? value.status : 'draft',
    rules,
    formatId: stringOrNull(value.formatId),
    currentPhaseId: stringOrNull(value.currentPhaseId),
    currentPacketId: stringOrNull(value.currentPacketId),
    currentRoundId: stringOrNull(value.currentRoundId),
    timeZone: normalizeTimeZone(value.timeZone),
    createdAt: stringOrEmpty(value.createdAt),
    updatedAt: stringOrEmpty(value.updatedAt),
  };
}

function normalizeTournamentRules(value: Record<string, unknown>): TournamentRules {
  // Browser and native imports can contain an older or hand-edited rules object. Complete it from
  // the canonical defaults rather than allowing an incomplete object to reach scoring and export
  // code, while preserving each supplied value that satisfies the Director's field constraints.
  const rules = structuredClone(defaultRules);
  if (isFiniteNumber(value.tossupValue) && value.tossupValue > 0) rules.tossupValue = value.tossupValue;
  if (isFiniteNumber(value.powerValue) && value.powerValue > 0) rules.powerValue = value.powerValue;
  if (isFiniteNumber(value.negValue) && value.negValue <= 0) rules.negValue = value.negValue;
  if (isFiniteNumber(value.bonusValue) && value.bonusValue >= 0) rules.bonusValue = value.bonusValue;
  if (isIntegerAtLeast(value.tossupCount, 1)) rules.tossupCount = value.tossupCount;
  if (isIntegerAtLeast(value.bonusParts, 1)) rules.bonusParts = value.bonusParts;
  if (typeof value.bouncebacks === 'boolean') rules.bouncebacks = value.bouncebacks;
  if (typeof value.overtime === 'boolean') rules.overtime = value.overtime;
  const nestedProcedure = ['roomProcedure', 'room_procedure', 'procedure', 'regulation']
    .map((key) => asRecord(value[key]))
    .find((procedure) => procedure && typeof procedure.timed === 'boolean');
  if (typeof value.timed === 'boolean') rules.timed = value.timed;
  else if (nestedProcedure && typeof nestedProcedure.timed === 'boolean') rules.timed = nestedProcedure.timed;
  if (typeof value.lightning === 'boolean') rules.lightning = value.lightning;
  if (isIntegerAtLeast(value.maximumActivePlayers, 1)) {
    rules.maximumActivePlayers = value.maximumActivePlayers;
  }
  if (isFiniteNumber(value.regulationMinutes) && value.regulationMinutes > 0) {
    rules.regulationMinutes = value.regulationMinutes;
  }
  const tiebreakers = value.tiebreakers;
  if (
    Array.isArray(tiebreakers) &&
    tiebreakers.length > 0 &&
    tiebreakers.every(isTiebreaker) &&
    new Set(tiebreakers).size === tiebreakers.length
  ) {
    rules.tiebreakers = [...tiebreakers];
  }
  return rules;
}

/**
 * Restore a Live publication, dropping anything a stored document should never have carried.
 *
 * Read defensively rather than trusted, because a Director document can arrive from a portable
 * archive that another machine wrote. The one rule that matters is the last line: a management
 * credential is never read back out of a document, whatever the document claims to contain.
 */
function normalizeLivePublication(value: unknown): DirectorState['live'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Director storage contains an invalid QBSheet Live publication.');
  const publicationId = stringOrNull(value.publicationId);
  if (!publicationId) return null;
  const at = stringOrEmpty(value.createdAt) || new Date(0).toISOString();
  const base = emptyLivePublication(publicationId, at);
  const settings = isRecord(value.settings)
    ? { ...base.settings, ...(value.settings as Partial<typeof base.settings>) }
    : base.settings;
  const backendRecord = isRecord(value.backend) ? value.backend : null;
  const backend: LiveBackendDescriptor | null = backendRecord
    ? {
        kind: isLiveBackendKind(backendRecord.kind) ? backendRecord.kind : 'custom',
        origin: stringOrEmpty(backendRecord.origin),
        displayName: typeof backendRecord.displayName === 'string' ? backendRecord.displayName : undefined,
      }
    : null;
  return {
    ...base,
    lifecycle: isLiveLifecycle(value.lifecycle) ? value.lifecycle : base.lifecycle,
    settings,
    backend: backend && backend.origin ? backend : null,
    // A credential reference is a keychain pointer, not a secret, but a document from another
    // machine points at a keychain this machine does not have. Re-pairing is the only correct
    // recovery, so the reference is dropped rather than carried forward.
    credential: null,
    push: isRecord(value.push) ? { ...base.push, ...(value.push as object), credential: null } : base.push,
    sync: isRecord(value.sync) ? { ...base.sync, ...(value.sync as object) } : base.sync,
    outbox: arrayOrEmpty(value.outbox, 'live.outbox'),
    announcements: arrayOrEmpty(value.announcements, 'live.announcements'),
    publicUrl: stringOrNull(value.publicUrl),
    createdAt: at,
    updatedAt: stringOrEmpty(value.updatedAt) || at,
  };
}

function isLiveBackendKind(value: unknown): value is LiveBackendDescriptor['kind'] {
  return value === 'cloudflare' || value === 'custom' || value === 'local';
}

function isLiveLifecycle(value: unknown): value is NonNullable<DirectorState['live']>['lifecycle'] {
  return (
    value === 'disabled' ||
    value === 'configuring' ||
    value === 'live' ||
    value === 'final' ||
    value === 'unpublishing' ||
    value === 'unpublished' ||
    value === 'deleting'
  );
}

function migrateGames(value: unknown): GameRecord[] {
  return arrayOrEmpty<unknown>(value, 'games').map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Director storage contains an invalid games[${index}] entry.`);
    const game = entry as unknown as GameRecord;
    return game.detailedStats
      ? game
      : {
          ...game,
          detailedStats:
            game.source === 'manual' || game.source === 'paper'
              ? ('unknown' as const)
              : game.playerStats?.length
                ? ('incomplete' as const)
                : ('unknown' as const),
        };
  });
}

function migrateProtests(value: unknown): Protest[] {
  return arrayOrEmpty<unknown>(value, 'protests').map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Director storage contains an invalid protests[${index}] entry.`);
    const protest = entry as unknown as Protest & { scoreAdjustment?: unknown };
    if (typeof protest.scoreAdjustment !== 'number') return protest;
    const { scoreAdjustment, ...rest } = protest;
    return { ...rest, legacyScoreAdjustment: scoreAdjustment };
  });
}

function supersedeDuplicateAcceptedSubmissions(value: unknown): ResultSubmission[] {
  const submissions = arrayOrEmpty<unknown>(value, 'submissions').map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Director storage contains an invalid submissions[${index}] entry.`);
    return { ...(entry as unknown as ResultSubmission) };
  });
  const byGame = new Map<string, ResultSubmission[]>();
  for (const submission of submissions) {
    if (submission.status !== 'accepted') continue;
    const entries = byGame.get(submission.gameId) ?? [];
    entries.push(submission);
    byGame.set(submission.gameId, entries);
  }
  for (const entries of byGame.values()) {
    if (entries.length < 2) continue;
    entries.sort(
      (left, right) =>
        (left.acceptedAt ?? left.receivedAt).localeCompare(right.acceptedAt ?? right.receivedAt) ||
        left.id.localeCompare(right.id),
    );
    const current = entries.at(-1);
    if (!current) continue;
    for (const previous of entries.slice(0, -1)) {
      previous.status = 'superseded';
      previous.supersededBySubmissionId = current.id;
    }
    // Point to the immediately preceding accepted submission, not the oldest.
    const predecessor = entries.at(-2);
    if (predecessor) current.supersedesSubmissionId = predecessor.id;
  }
  return submissions;
}

function supersedeDuplicateScheduledSubmissions(state: DirectorState): ResultSubmission[] {
  const gameById = new Map(state.games.map((game) => [game.id, game]));
  const byScheduledGame = new Map<string, ResultSubmission[]>();
  for (const submission of state.submissions) {
    if (submission.status !== 'accepted') continue;
    const scheduledGameId = gameById.get(submission.gameId)?.scheduledGameId;
    if (!scheduledGameId) continue;
    const entries = byScheduledGame.get(scheduledGameId) ?? [];
    entries.push(submission);
    byScheduledGame.set(scheduledGameId, entries);
  }
  for (const entries of byScheduledGame.values()) {
    if (entries.length < 2) continue;
    entries.sort(
      (left, right) =>
        (left.acceptedAt ?? left.receivedAt).localeCompare(right.acceptedAt ?? right.receivedAt) ||
        left.id.localeCompare(right.id),
    );
    const current = entries.at(-1);
    if (!current) continue;
    for (const previous of entries.slice(0, -1)) {
      previous.status = 'superseded';
      previous.supersededBySubmissionId = current.id;
    }
    const predecessor = entries.at(-2);
    if (predecessor) current.supersedesSubmissionId = predecessor.id;
  }
  return state.submissions;
}

function canonicalizePacketReferences(state: DirectorState): Packet[] {
  const scheduledIds = new Set(state.scheduledGames.map((game) => game.id));
  const gameById = new Map(state.games.map((game) => [game.id, game]));
  const canonicalId = (id: string): string => gameById.get(id)?.scheduledGameId ?? id;
  const unique = (values: string[]): string[] => [...new Set(values.map(canonicalId))];
  const effectivePacketId = (game: DirectorState['scheduledGames'][number]): string | null => {
    if (game.packetId) return game.packetId;
    return state.rounds.find((round) => round.id === game.roundId)?.packetId ?? null;
  };
  return state.packets.map((packet) => {
    const assigned = unique(packet.assignedGameIds ?? []);
    const used = unique(packet.usedGameIds ?? []);
    for (const game of state.scheduledGames) {
      if (effectivePacketId(game) === packet.id && !assigned.includes(game.id)) assigned.push(game.id);
    }
    for (const game of state.games) {
      if (
        game.status === 'accepted' &&
        (game.packetId === packet.id || effectivePacketIdByGame(state, game) === packet.id)
      ) {
        if (!used.includes(game.scheduledGameId)) used.push(game.scheduledGameId);
      }
    }
    return {
      ...packet,
      assignedRoundIds: [
        ...new Set((packet.assignedRoundIds ?? []).filter((id): id is string => typeof id === 'string')),
      ],
      assignedGameIds: assigned.filter((id) => scheduledIds.has(id)),
      usedGameIds: used.filter((id) => scheduledIds.has(id)),
    };
  });
}

function effectivePacketIdByGame(state: DirectorState, game: GameRecord): string | null {
  if (game.packetId) return game.packetId;
  const scheduled = state.scheduledGames.find((candidate) => candidate.id === game.scheduledGameId);
  return scheduled?.packetId ?? state.rounds.find((round) => round.id === game.roundId)?.packetId ?? null;
}

function arrayOrEmpty<T>(value: unknown, label: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`Director storage contains invalid ${label}; expected an array.`);
  return value as T[];
}

function arrayOfRecords(value: unknown, label: string): Array<Record<string, unknown>> {
  return arrayOrEmpty<unknown>(value, label).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Director storage contains an invalid ${label}[${index}] entry.`);
    return entry;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= minimum;
}

function isTiebreaker(value: unknown): value is TournamentRules['tiebreakers'][number] {
  return (
    value === 'head-to-head' ||
    value === 'record' ||
    value === 'points' ||
    value === 'margin' ||
    value === 'powers' ||
    value === 'gets' ||
    value === 'playoff'
  );
}

function isTournamentStatus(value: unknown): value is NonNullable<DirectorState['tournament']>['status'] {
  return value === 'draft' || value === 'running' || value === 'complete' || value === 'archived';
}
