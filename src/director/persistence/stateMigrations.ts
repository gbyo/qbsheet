import {
  directorSchemaVersion,
  emptyDirectorState,
  type DirectorState,
  type GameRecord,
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
    } else {
      throw new Error(`No Director migration exists for schema v${currentVersion}.`);
    }
    currentVersion += 1;
    current.schemaVersion = currentVersion;
  }
  return current;
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
    rounds: arrayOrEmpty(candidate.rounds, 'rounds'),
    scheduledGames: arrayOrEmpty(candidate.scheduledGames, 'scheduledGames'),
    games: migrateGames(candidate.games),
    submissions: supersedeDuplicateAcceptedSubmissions(candidate.submissions),
    protests: migrateProtests(candidate.protests),
    audit: arrayOrEmpty(candidate.audit, 'audit'),
    qbtcpSessions: arrayOrEmpty(candidate.qbtcpSessions, 'qbtcpSessions'),
    qbtcpHelpRequests: arrayOrEmpty(candidate.qbtcpHelpRequests, 'qbtcpHelpRequests'),
    qbtcpRosterAmendments: arrayOrEmpty(candidate.qbtcpRosterAmendments, 'qbtcpRosterAmendments'),
    transfers: normalizeTransferState(candidate.transfers),
  };
  state.submissions = supersedeDuplicateScheduledSubmissions(state);
  state.packets = canonicalizePacketReferences(state);
  return state;
}

function normalizeTournament(value: unknown): DirectorState['tournament'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error('Director storage contains an invalid tournament.');
  const rules = value.rules;
  if (!isRecord(rules)) throw new Error('Director storage contains invalid tournament rules.');
  const id = stringOrNull(value.id);
  if (!id) throw new Error('Director storage contains a tournament without an id.');
  return {
    id,
    name: stringOrEmpty(value.name),
    date: stringOrEmpty(value.date),
    venue: stringOrEmpty(value.venue),
    organizer: stringOrEmpty(value.organizer),
    status: isTournamentStatus(value.status) ? value.status : 'draft',
    rules: rules as unknown as TournamentRules,
    formatId: stringOrNull(value.formatId),
    currentPhaseId: stringOrNull(value.currentPhaseId),
    currentPacketId: stringOrNull(value.currentPacketId),
    currentRoundId: stringOrNull(value.currentRoundId),
    createdAt: stringOrEmpty(value.createdAt),
    updatedAt: stringOrEmpty(value.updatedAt),
  };
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
    entries.sort((left, right) =>
      (left.acceptedAt ?? left.receivedAt).localeCompare(right.acceptedAt ?? right.receivedAt),
    );
    const current = entries.at(-1);
    if (!current) continue;
    for (const previous of entries.slice(0, -1)) {
      previous.status = 'superseded';
      previous.supersededBySubmissionId = current.id;
      current.supersedesSubmissionId ??= previous.id;
    }
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
      current.supersedesSubmissionId ??= previous.id;
    }
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

function isTournamentStatus(value: unknown): value is NonNullable<DirectorState['tournament']>['status'] {
  return value === 'draft' || value === 'running' || value === 'complete' || value === 'archived';
}
