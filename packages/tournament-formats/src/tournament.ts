import type {
  AuditEventRecord,
  DirectorTournament,
  DirectorTournamentInput,
  EquipmentRecord,
  ExtensibleRecord,
  FormatError,
  FormatReport,
  FormatWarning,
  GameRecord,
  JsonObject,
  JsonValue,
  OrganizationRecord,
  PacketRecord,
  PhaseRecord,
  PlayerRecord,
  PlayerStatisticRecord,
  PoolRecord,
  ProtestRecord,
  QbtcpSessionRecord,
  RegistrationRecord,
  ResultSubmissionRecord,
  RoomRecord,
  RoundRecord,
  ScheduledGameRecord,
  StaffRecord,
  TeamRecord,
  TournamentRecord,
} from './types';
import {
  asBoolean,
  asFiniteNumber,
  asJsonObject,
  asString,
  cloneJson,
  error,
  fail,
  isJsonObject,
  isJsonValue,
  ok,
  preserveUnknownFields,
  readRequiredString,
  warning,
} from './util';

const tournamentKeys = new Set([
  'id',
  'name',
  'date',
  'location',
  'organizationId',
  'notes',
  'extensions',
  'source',
]);
const organizationKeys = new Set(['id', 'name', 'city', 'state', 'country', 'notes', 'extensions', 'source']);
const playerKeys = new Set([
  'id',
  'name',
  'organizationId',
  'grade',
  'rosterNumber',
  'captain',
  'notes',
  'extensions',
  'source',
]);
const teamKeys = new Set([
  'id',
  'name',
  'displayName',
  'letter',
  'organizationId',
  'seed',
  'status',
  'notes',
  'playerIds',
  'players',
  'extensions',
  'source',
]);
const registrationKeys = new Set([
  'id',
  'teamId',
  'organizationId',
  'division',
  'seed',
  'status',
  'extensions',
  'source',
]);
const roomKeys = new Set([
  'id',
  'name',
  'building',
  'floor',
  'accessible',
  'directions',
  'notes',
  'moderatorId',
  'scorekeeperId',
  'equipmentIds',
  'available',
  'extensions',
  'source',
]);
const staffKeys = new Set([
  'id',
  'name',
  'role',
  'email',
  'phone',
  'availability',
  'notes',
  'extensions',
  'source',
]);
const equipmentKeys = new Set([
  'id',
  'name',
  'kind',
  'serialNumber',
  'available',
  'notes',
  'extensions',
  'source',
]);
const packetKeys = new Set([
  'id',
  'name',
  'roundId',
  'gameIds',
  'replacementForId',
  'tiebreaker',
  'used',
  'securityNotes',
  'notes',
  'extensions',
  'source',
]);
const phaseKeys = new Set([
  'id',
  'name',
  'kind',
  'order',
  'poolIds',
  'roundIds',
  'advancement',
  'carryovers',
  'extensions',
  'source',
]);
const poolKeys = new Set(['id', 'name', 'phaseId', 'order', 'teamIds', 'extensions', 'source']);
const roundKeys = new Set([
  'id',
  'name',
  'phaseId',
  'number',
  'qbjName',
  'packetIds',
  'revision',
  'status',
  'extensions',
  'source',
]);
const scheduledGameKeys = new Set([
  'id',
  'phaseId',
  'roundId',
  'poolId',
  'roomId',
  'packetId',
  'teamIds',
  'status',
  'sequence',
  'startsAt',
  'bye',
  'extensions',
  'source',
]);
const gameKeys = new Set([
  'id',
  'scheduledGameId',
  'phaseId',
  'roundId',
  'poolId',
  'roomId',
  'packetId',
  'teamIds',
  'status',
  'result',
  'rawSubmission',
  'submittedAt',
  'acceptedAt',
  'extensions',
  'source',
]);
const resultSubmissionKeys = new Set([
  'id',
  'gameId',
  'receivedAt',
  'status',
  'fingerprint',
  'raw',
  'validationWarnings',
  'reviewedAt',
  'reviewNote',
  'extensions',
  'source',
]);
const protestKeys = new Set([
  'id',
  'gameId',
  'questionNumber',
  'subject',
  'description',
  'status',
  'ruling',
  'notes',
  'createdAt',
  'resolvedAt',
  'extensions',
  'source',
]);
const auditKeys = new Set([
  'id',
  'at',
  'action',
  'actor',
  'entityType',
  'entityId',
  'reason',
  'details',
  'extensions',
  'source',
]);
const statKeys = new Set([
  'id',
  'playerId',
  'phaseId',
  'roundId',
  'games',
  'tossupsHeard',
  'powers',
  'gets',
  'negs',
  'points',
  'bonusesHeard',
  'bonusPoints',
  'extensions',
  'source',
]);
const sessionKeys = new Set([
  'id',
  'gameId',
  'roomId',
  'clientId',
  'status',
  'pairedAt',
  'lastSeenAt',
  'extensions',
  'source',
]);

const collectionKeys = new Set([
  'tournament',
  'rules',
  'organizations',
  'players',
  'teams',
  'registrations',
  'rooms',
  'staff',
  'equipment',
  'packets',
  'phases',
  'pools',
  'rounds',
  'scheduledGames',
  'games',
  'playerStatistics',
  'qbtcpSessions',
  'resultSubmissions',
  'protests',
  'auditEvents',
  'qbj',
  'extensions',
]);

const defaultTournamentId = 'tournament_imported';

function optionalString(raw: JsonObject, key: string): string | undefined {
  return asString(raw[key]);
}

function optionalNumber(raw: JsonObject, key: string): number | undefined {
  return asFiniteNumber(raw[key]);
}

function optionalBoolean(raw: JsonObject, key: string): boolean | undefined {
  return asBoolean(raw[key]);
}

function optionalStringArray(
  raw: JsonObject,
  key: string,
  path: string,
  errors: FormatError[],
): string[] | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    errors.push(error('invalid-array', `${path}.${key}`, `${key} must be an array of strings.`));
    return undefined;
  }
  return value.slice();
}

function optionalJsonObject(
  raw: JsonObject,
  key: string,
  path: string,
  errors: FormatError[],
): JsonObject | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  const object = asJsonObject(value);
  if (!object) errors.push(error('invalid-object', `${path}.${key}`, `${key} must be a JSON object.`));
  return object ?? undefined;
}

function sourceAndExtensions(
  raw: JsonObject,
  known: ReadonlySet<string>,
  path: string,
  warnings: FormatWarning[],
): ExtensibleRecord {
  const extensions = preserveUnknownFields(raw, known, path, warnings);
  const explicit = asJsonObject(raw.extensions);
  // Adapter imports may already carry the original foreign object in `source`. Keep that object
  // as the source of truth instead of wrapping it in another normalized record on every pass.
  const source = asJsonObject(raw.source) ?? cloneJson(raw);
  return {
    ...(extensions || explicit ? { extensions: { ...(extensions ?? {}), ...(explicit ?? {}) } } : {}),
    source,
  };
}

function objectArray(value: unknown, path: string, errors: FormatError[]): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(error('invalid-array', path, 'Expected an array of objects.'));
    return [];
  }
  const result: JsonObject[] = [];
  value.forEach((entry, index) => {
    if (!isJsonObject(entry) || !isJsonValue(entry)) {
      errors.push(error('invalid-record', `${path}[${index}]`, 'Expected a JSON object.'));
      return;
    }
    result.push(entry);
  });
  return result;
}

function requiredIdName(
  raw: JsonObject,
  path: string,
  errors: FormatError[],
  fallbackId: string,
  fallbackName: string,
): { id: string; name: string } {
  const id = asString(raw.id) ?? fallbackId;
  const name = asString(raw.name) ?? fallbackName;
  if (asString(raw.id) === undefined) {
    errors.push(
      error('missing-field', `${path}.id`, `id is required; generated ${fallbackId} for this import.`),
    );
  }
  if (asString(raw.name) === undefined)
    errors.push(error('missing-field', `${path}.name`, 'name is required.'));
  return { id, name };
}

function requiredId(raw: JsonObject, path: string, errors: FormatError[], fallbackId: string): string {
  const id = asString(raw.id) ?? fallbackId;
  if (asString(raw.id) === undefined) {
    errors.push(
      error('missing-field', `${path}.id`, `id is required; generated ${fallbackId} for this import.`),
    );
  }
  return id;
}

function readTournament(value: unknown, warnings: FormatWarning[], errors: FormatError[]): TournamentRecord {
  const raw = isJsonObject(value) && isJsonValue(value) ? value : {};
  const { id, name } = requiredIdName(raw, 'tournament', errors, defaultTournamentId, 'Imported tournament');
  return {
    id,
    name,
    ...(optionalString(raw, 'date') ? { date: optionalString(raw, 'date') } : {}),
    ...(optionalString(raw, 'location') ? { location: optionalString(raw, 'location') } : {}),
    ...(optionalString(raw, 'organizationId')
      ? { organizationId: optionalString(raw, 'organizationId') }
      : {}),
    ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
    ...sourceAndExtensions(raw, tournamentKeys, 'tournament', warnings),
  };
}

function readOrganizations(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): OrganizationRecord[] {
  return objectArray(value, 'organizations', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `organizations[${index}]`,
      errors,
      `organization_${index + 1}`,
      'Unnamed organization',
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'city') ? { city: optionalString(raw, 'city') } : {}),
      ...(optionalString(raw, 'state') ? { state: optionalString(raw, 'state') } : {}),
      ...(optionalString(raw, 'country') ? { country: optionalString(raw, 'country') } : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...sourceAndExtensions(raw, organizationKeys, `organizations[${index}]`, warnings),
    };
  });
}

function readPlayers(value: unknown, warnings: FormatWarning[], errors: FormatError[]): PlayerRecord[] {
  return objectArray(value, 'players', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `players[${index}]`,
      errors,
      `player_${index + 1}`,
      'Unnamed player',
    );
    const rosterNumber = raw.rosterNumber;
    return {
      id,
      name,
      ...(optionalString(raw, 'organizationId')
        ? { organizationId: optionalString(raw, 'organizationId') }
        : {}),
      ...(optionalString(raw, 'grade') ? { grade: optionalString(raw, 'grade') } : {}),
      ...(typeof rosterNumber === 'string' || typeof rosterNumber === 'number' ? { rosterNumber } : {}),
      ...(optionalBoolean(raw, 'captain') !== undefined ? { captain: optionalBoolean(raw, 'captain') } : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...sourceAndExtensions(raw, playerKeys, `players[${index}]`, warnings),
    };
  });
}

function readTeams(value: unknown, warnings: FormatWarning[], errors: FormatError[]): TeamRecord[] {
  return objectArray(value, 'teams', errors).map((raw, index) => {
    const { id, name } = requiredIdName(raw, `teams[${index}]`, errors, `team_${index + 1}`, 'Unnamed team');
    const embeddedPlayers = objectArray(raw.players, `teams[${index}].players`, errors).map(
      (player, playerIndex) => {
        const identity = requiredIdName(
          player,
          `teams[${index}].players[${playerIndex}]`,
          errors,
          `${id}_player_${playerIndex + 1}`,
          'Unnamed player',
        );
        return {
          id: identity.id,
          name: identity.name,
          ...(optionalString(player, 'grade') ? { grade: optionalString(player, 'grade') } : {}),
          ...(typeof player.rosterNumber === 'string' || typeof player.rosterNumber === 'number'
            ? { rosterNumber: player.rosterNumber }
            : {}),
          ...(optionalBoolean(player, 'captain') !== undefined
            ? { captain: optionalBoolean(player, 'captain') }
            : {}),
          ...sourceAndExtensions(player, playerKeys, `teams[${index}].players[${playerIndex}]`, warnings),
        } satisfies PlayerRecord;
      },
    );
    const playerIds =
      optionalStringArray(raw, 'playerIds', `teams[${index}]`, errors) ??
      embeddedPlayers.map((player) => player.id);
    return {
      id,
      name,
      ...(optionalString(raw, 'displayName') ? { displayName: optionalString(raw, 'displayName') } : {}),
      ...(optionalString(raw, 'letter') ? { letter: optionalString(raw, 'letter') } : {}),
      ...(optionalString(raw, 'organizationId')
        ? { organizationId: optionalString(raw, 'organizationId') }
        : {}),
      ...(optionalNumber(raw, 'seed') !== undefined ? { seed: optionalNumber(raw, 'seed') } : {}),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...(playerIds.length > 0 ? { playerIds } : {}),
      ...(embeddedPlayers.length > 0 ? { players: embeddedPlayers } : {}),
      ...sourceAndExtensions(raw, teamKeys, `teams[${index}]`, warnings),
    };
  });
}

function readRegistrations(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): RegistrationRecord[] {
  return objectArray(value, 'registrations', errors).map((raw, index) => {
    const id = asString(raw.id) ?? `registration_${index + 1}`;
    const teamId = readRequiredString(raw, 'teamId', `registrations[${index}]`, errors) ?? '';
    return {
      id,
      teamId,
      ...(optionalString(raw, 'organizationId')
        ? { organizationId: optionalString(raw, 'organizationId') }
        : {}),
      ...(optionalString(raw, 'division') ? { division: optionalString(raw, 'division') } : {}),
      ...(optionalNumber(raw, 'seed') !== undefined ? { seed: optionalNumber(raw, 'seed') } : {}),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...sourceAndExtensions(raw, registrationKeys, `registrations[${index}]`, warnings),
    };
  });
}

function readRooms(value: unknown, warnings: FormatWarning[], errors: FormatError[]): RoomRecord[] {
  return objectArray(value, 'rooms', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `rooms[${index}]`,
      errors,
      `room_${index + 1}`,
      `Room ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'building') ? { building: optionalString(raw, 'building') } : {}),
      ...(optionalString(raw, 'floor') ? { floor: optionalString(raw, 'floor') } : {}),
      ...(optionalBoolean(raw, 'accessible') !== undefined
        ? { accessible: optionalBoolean(raw, 'accessible') }
        : {}),
      ...(optionalString(raw, 'directions') ? { directions: optionalString(raw, 'directions') } : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...(optionalString(raw, 'moderatorId') ? { moderatorId: optionalString(raw, 'moderatorId') } : {}),
      ...(optionalString(raw, 'scorekeeperId')
        ? { scorekeeperId: optionalString(raw, 'scorekeeperId') }
        : {}),
      ...(optionalStringArray(raw, 'equipmentIds', `rooms[${index}]`, errors)
        ? { equipmentIds: optionalStringArray(raw, 'equipmentIds', `rooms[${index}]`, errors) }
        : {}),
      ...(optionalBoolean(raw, 'available') !== undefined
        ? { available: optionalBoolean(raw, 'available') }
        : {}),
      ...sourceAndExtensions(raw, roomKeys, `rooms[${index}]`, warnings),
    };
  });
}

function readStaff(value: unknown, warnings: FormatWarning[], errors: FormatError[]): StaffRecord[] {
  return objectArray(value, 'staff', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `staff[${index}]`,
      errors,
      `staff_${index + 1}`,
      `Staff ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'role') ? { role: optionalString(raw, 'role') } : {}),
      ...(optionalString(raw, 'email') ? { email: optionalString(raw, 'email') } : {}),
      ...(optionalString(raw, 'phone') ? { phone: optionalString(raw, 'phone') } : {}),
      ...(optionalJsonObject(raw, 'availability', `staff[${index}]`, errors)
        ? { availability: optionalJsonObject(raw, 'availability', `staff[${index}]`, errors) }
        : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...sourceAndExtensions(raw, staffKeys, `staff[${index}]`, warnings),
    };
  });
}

function readEquipment(value: unknown, warnings: FormatWarning[], errors: FormatError[]): EquipmentRecord[] {
  return objectArray(value, 'equipment', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `equipment[${index}]`,
      errors,
      `equipment_${index + 1}`,
      `Equipment ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'kind') ? { kind: optionalString(raw, 'kind') } : {}),
      ...(optionalString(raw, 'serialNumber') ? { serialNumber: optionalString(raw, 'serialNumber') } : {}),
      ...(optionalBoolean(raw, 'available') !== undefined
        ? { available: optionalBoolean(raw, 'available') }
        : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...sourceAndExtensions(raw, equipmentKeys, `equipment[${index}]`, warnings),
    };
  });
}

function readPackets(value: unknown, warnings: FormatWarning[], errors: FormatError[]): PacketRecord[] {
  return objectArray(value, 'packets', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `packets[${index}]`,
      errors,
      `packet_${index + 1}`,
      `Packet ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'roundId') ? { roundId: optionalString(raw, 'roundId') } : {}),
      ...(optionalStringArray(raw, 'gameIds', `packets[${index}]`, errors)
        ? { gameIds: optionalStringArray(raw, 'gameIds', `packets[${index}]`, errors) }
        : {}),
      ...(optionalString(raw, 'replacementForId')
        ? { replacementForId: optionalString(raw, 'replacementForId') }
        : {}),
      ...(optionalBoolean(raw, 'tiebreaker') !== undefined
        ? { tiebreaker: optionalBoolean(raw, 'tiebreaker') }
        : {}),
      ...(optionalBoolean(raw, 'used') !== undefined ? { used: optionalBoolean(raw, 'used') } : {}),
      ...(optionalString(raw, 'securityNotes')
        ? { securityNotes: optionalString(raw, 'securityNotes') }
        : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      ...sourceAndExtensions(raw, packetKeys, `packets[${index}]`, warnings),
    };
  });
}

function readPhases(value: unknown, warnings: FormatWarning[], errors: FormatError[]): PhaseRecord[] {
  return objectArray(value, 'phases', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `phases[${index}]`,
      errors,
      `phase_${index + 1}`,
      `Phase ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'kind') ? { kind: optionalString(raw, 'kind') } : {}),
      ...(optionalNumber(raw, 'order') !== undefined ? { order: optionalNumber(raw, 'order') } : {}),
      ...(optionalStringArray(raw, 'poolIds', `phases[${index}]`, errors)
        ? { poolIds: optionalStringArray(raw, 'poolIds', `phases[${index}]`, errors) }
        : {}),
      ...(optionalStringArray(raw, 'roundIds', `phases[${index}]`, errors)
        ? { roundIds: optionalStringArray(raw, 'roundIds', `phases[${index}]`, errors) }
        : {}),
      ...(optionalJsonObject(raw, 'advancement', `phases[${index}]`, errors)
        ? { advancement: optionalJsonObject(raw, 'advancement', `phases[${index}]`, errors) }
        : {}),
      ...(optionalJsonObject(raw, 'carryovers', `phases[${index}]`, errors)
        ? { carryovers: optionalJsonObject(raw, 'carryovers', `phases[${index}]`, errors) }
        : {}),
      ...sourceAndExtensions(raw, phaseKeys, `phases[${index}]`, warnings),
    };
  });
}

function readPools(value: unknown, warnings: FormatWarning[], errors: FormatError[]): PoolRecord[] {
  return objectArray(value, 'pools', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `pools[${index}]`,
      errors,
      `pool_${index + 1}`,
      `Pool ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'phaseId') ? { phaseId: optionalString(raw, 'phaseId') } : {}),
      ...(optionalNumber(raw, 'order') !== undefined ? { order: optionalNumber(raw, 'order') } : {}),
      ...(optionalStringArray(raw, 'teamIds', `pools[${index}]`, errors)
        ? { teamIds: optionalStringArray(raw, 'teamIds', `pools[${index}]`, errors) }
        : {}),
      ...sourceAndExtensions(raw, poolKeys, `pools[${index}]`, warnings),
    };
  });
}

function readRounds(value: unknown, warnings: FormatWarning[], errors: FormatError[]): RoundRecord[] {
  return objectArray(value, 'rounds', errors).map((raw, index) => {
    const { id, name } = requiredIdName(
      raw,
      `rounds[${index}]`,
      errors,
      `round_${index + 1}`,
      `Round ${index + 1}`,
    );
    return {
      id,
      name,
      ...(optionalString(raw, 'phaseId') ? { phaseId: optionalString(raw, 'phaseId') } : {}),
      ...(optionalNumber(raw, 'number') !== undefined ? { number: optionalNumber(raw, 'number') } : {}),
      ...(optionalString(raw, 'qbjName') ? { qbjName: optionalString(raw, 'qbjName') } : {}),
      ...(optionalStringArray(raw, 'packetIds', `rounds[${index}]`, errors)
        ? { packetIds: optionalStringArray(raw, 'packetIds', `rounds[${index}]`, errors) }
        : {}),
      ...(optionalNumber(raw, 'revision') !== undefined ? { revision: optionalNumber(raw, 'revision') } : {}),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...sourceAndExtensions(raw, roundKeys, `rounds[${index}]`, warnings),
    };
  });
}

function teamPair(value: unknown, path: string, errors: FormatError[]): [string | null, string | null] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => entry === null || typeof entry === 'string')
  ) {
    errors.push(
      error('invalid-team-pair', path, 'teamIds must contain exactly two team ids or null bye slots.'),
    );
    return [null, null];
  }
  return [value[0] as string | null, value[1] as string | null];
}

function readScheduledGames(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): ScheduledGameRecord[] {
  return objectArray(value, 'scheduledGames', errors).map((raw, index) => {
    const id = requiredId(raw, `scheduledGames[${index}]`, errors, `scheduled_game_${index + 1}`);
    return {
      id,
      ...(optionalString(raw, 'phaseId') ? { phaseId: optionalString(raw, 'phaseId') } : {}),
      ...(optionalString(raw, 'roundId') ? { roundId: optionalString(raw, 'roundId') } : {}),
      ...(optionalString(raw, 'poolId') ? { poolId: optionalString(raw, 'poolId') } : {}),
      ...(optionalString(raw, 'roomId') ? { roomId: optionalString(raw, 'roomId') } : {}),
      ...(optionalString(raw, 'packetId') ? { packetId: optionalString(raw, 'packetId') } : {}),
      teamIds: teamPair(raw.teamIds, `scheduledGames[${index}].teamIds`, errors),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...(optionalNumber(raw, 'sequence') !== undefined ? { sequence: optionalNumber(raw, 'sequence') } : {}),
      ...(optionalString(raw, 'startsAt') ? { startsAt: optionalString(raw, 'startsAt') } : {}),
      ...(optionalBoolean(raw, 'bye') !== undefined ? { bye: optionalBoolean(raw, 'bye') } : {}),
      ...sourceAndExtensions(raw, scheduledGameKeys, `scheduledGames[${index}]`, warnings),
    };
  });
}

function readGames(value: unknown, warnings: FormatWarning[], errors: FormatError[]): GameRecord[] {
  return objectArray(value, 'games', errors).map((raw, index) => {
    const id = requiredId(raw, `games[${index}]`, errors, `game_${index + 1}`);
    const result = asJsonObject(raw.result);
    return {
      id,
      ...(optionalString(raw, 'scheduledGameId')
        ? { scheduledGameId: optionalString(raw, 'scheduledGameId') }
        : {}),
      ...(optionalString(raw, 'phaseId') ? { phaseId: optionalString(raw, 'phaseId') } : {}),
      ...(optionalString(raw, 'roundId') ? { roundId: optionalString(raw, 'roundId') } : {}),
      ...(optionalString(raw, 'poolId') ? { poolId: optionalString(raw, 'poolId') } : {}),
      ...(optionalString(raw, 'roomId') ? { roomId: optionalString(raw, 'roomId') } : {}),
      ...(optionalString(raw, 'packetId') ? { packetId: optionalString(raw, 'packetId') } : {}),
      teamIds: teamPair(raw.teamIds, `games[${index}].teamIds`, errors),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...(result ? { result: result as unknown as GameRecord['result'] } : {}),
      ...(isJsonValue(raw.rawSubmission) ? { rawSubmission: cloneJson(raw.rawSubmission) } : {}),
      ...(optionalString(raw, 'submittedAt') ? { submittedAt: optionalString(raw, 'submittedAt') } : {}),
      ...(optionalString(raw, 'acceptedAt') ? { acceptedAt: optionalString(raw, 'acceptedAt') } : {}),
      ...sourceAndExtensions(raw, gameKeys, `games[${index}]`, warnings),
    };
  });
}

function readStats(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): PlayerStatisticRecord[] {
  return objectArray(value, 'playerStatistics', errors).map((raw, index) => {
    const id = requiredId(raw, `playerStatistics[${index}]`, errors, `player_stat_${index + 1}`);
    const playerId = readRequiredString(raw, 'playerId', `playerStatistics[${index}]`, errors) ?? '';
    return {
      id,
      playerId,
      ...(optionalString(raw, 'phaseId') ? { phaseId: optionalString(raw, 'phaseId') } : {}),
      ...(optionalString(raw, 'roundId') ? { roundId: optionalString(raw, 'roundId') } : {}),
      ...(optionalNumber(raw, 'games') !== undefined ? { games: optionalNumber(raw, 'games') } : {}),
      ...(optionalNumber(raw, 'tossupsHeard') !== undefined
        ? { tossupsHeard: optionalNumber(raw, 'tossupsHeard') }
        : {}),
      ...(optionalNumber(raw, 'powers') !== undefined ? { powers: optionalNumber(raw, 'powers') } : {}),
      ...(optionalNumber(raw, 'gets') !== undefined ? { gets: optionalNumber(raw, 'gets') } : {}),
      ...(optionalNumber(raw, 'negs') !== undefined ? { negs: optionalNumber(raw, 'negs') } : {}),
      ...(optionalNumber(raw, 'points') !== undefined ? { points: optionalNumber(raw, 'points') } : {}),
      ...(optionalNumber(raw, 'bonusesHeard') !== undefined
        ? { bonusesHeard: optionalNumber(raw, 'bonusesHeard') }
        : {}),
      ...(optionalNumber(raw, 'bonusPoints') !== undefined
        ? { bonusPoints: optionalNumber(raw, 'bonusPoints') }
        : {}),
      ...sourceAndExtensions(raw, statKeys, `playerStatistics[${index}]`, warnings),
    };
  });
}

function readSessions(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): QbtcpSessionRecord[] {
  return objectArray(value, 'qbtcpSessions', errors).map((raw, index) => {
    const id = requiredId(raw, `qbtcpSessions[${index}]`, errors, `qbtcp_session_${index + 1}`);
    return {
      id,
      ...(optionalString(raw, 'gameId') ? { gameId: optionalString(raw, 'gameId') } : {}),
      ...(optionalString(raw, 'roomId') ? { roomId: optionalString(raw, 'roomId') } : {}),
      ...(optionalString(raw, 'clientId') ? { clientId: optionalString(raw, 'clientId') } : {}),
      ...(optionalString(raw, 'status') ? { status: optionalString(raw, 'status') } : {}),
      ...(optionalString(raw, 'pairedAt') ? { pairedAt: optionalString(raw, 'pairedAt') } : {}),
      ...(optionalString(raw, 'lastSeenAt') ? { lastSeenAt: optionalString(raw, 'lastSeenAt') } : {}),
      ...sourceAndExtensions(raw, sessionKeys, `qbtcpSessions[${index}]`, warnings),
    };
  });
}

function readSubmissions(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): ResultSubmissionRecord[] {
  return objectArray(value, 'resultSubmissions', errors).map((raw, index) => {
    const id = requiredId(raw, `resultSubmissions[${index}]`, errors, `submission_${index + 1}`);
    const gameId = readRequiredString(raw, 'gameId', `resultSubmissions[${index}]`, errors) ?? '';
    const receivedAt = readRequiredString(raw, 'receivedAt', `resultSubmissions[${index}]`, errors) ?? '';
    const status = readRequiredString(raw, 'status', `resultSubmissions[${index}]`, errors) ?? 'pending';
    if (!isJsonValue(raw.raw))
      errors.push(error('invalid-json', `resultSubmissions[${index}].raw`, 'raw must be JSON data.'));
    return {
      id,
      gameId,
      receivedAt,
      status,
      ...(optionalString(raw, 'fingerprint') ? { fingerprint: optionalString(raw, 'fingerprint') } : {}),
      raw: isJsonValue(raw.raw) ? cloneJson(raw.raw) : null,
      ...(Array.isArray(raw.validationWarnings) &&
      raw.validationWarnings.every((entry) => typeof entry === 'string')
        ? { validationWarnings: raw.validationWarnings.slice() }
        : {}),
      ...(optionalString(raw, 'reviewedAt') ? { reviewedAt: optionalString(raw, 'reviewedAt') } : {}),
      ...(optionalString(raw, 'reviewNote') ? { reviewNote: optionalString(raw, 'reviewNote') } : {}),
      ...sourceAndExtensions(raw, resultSubmissionKeys, `resultSubmissions[${index}]`, warnings),
    };
  });
}

function readProtests(value: unknown, warnings: FormatWarning[], errors: FormatError[]): ProtestRecord[] {
  return objectArray(value, 'protests', errors).map((raw, index) => {
    const id = requiredId(raw, `protests[${index}]`, errors, `protest_${index + 1}`);
    const gameId = readRequiredString(raw, 'gameId', `protests[${index}]`, errors) ?? '';
    const description = readRequiredString(raw, 'description', `protests[${index}]`, errors) ?? '';
    const status = readRequiredString(raw, 'status', `protests[${index}]`, errors) ?? 'open';
    const createdAt = readRequiredString(raw, 'createdAt', `protests[${index}]`, errors) ?? '';
    return {
      id,
      gameId,
      ...(optionalNumber(raw, 'questionNumber') !== undefined
        ? { questionNumber: optionalNumber(raw, 'questionNumber') }
        : {}),
      ...(optionalString(raw, 'subject') ? { subject: optionalString(raw, 'subject') } : {}),
      description,
      status,
      ...(optionalString(raw, 'ruling') ? { ruling: optionalString(raw, 'ruling') } : {}),
      ...(optionalString(raw, 'notes') ? { notes: optionalString(raw, 'notes') } : {}),
      createdAt,
      ...(optionalString(raw, 'resolvedAt') ? { resolvedAt: optionalString(raw, 'resolvedAt') } : {}),
      ...sourceAndExtensions(raw, protestKeys, `protests[${index}]`, warnings),
    };
  });
}

function readAuditEvents(
  value: unknown,
  warnings: FormatWarning[],
  errors: FormatError[],
): AuditEventRecord[] {
  return objectArray(value, 'auditEvents', errors).map((raw, index) => {
    const id = requiredId(raw, `auditEvents[${index}]`, errors, `audit_${index + 1}`);
    const at = readRequiredString(raw, 'at', `auditEvents[${index}]`, errors) ?? '';
    const action = readRequiredString(raw, 'action', `auditEvents[${index}]`, errors) ?? '';
    return {
      id,
      at,
      action,
      ...(optionalString(raw, 'actor') ? { actor: optionalString(raw, 'actor') } : {}),
      ...(optionalString(raw, 'entityType') ? { entityType: optionalString(raw, 'entityType') } : {}),
      ...(optionalString(raw, 'entityId') ? { entityId: optionalString(raw, 'entityId') } : {}),
      ...(optionalString(raw, 'reason') ? { reason: optionalString(raw, 'reason') } : {}),
      ...(optionalJsonObject(raw, 'details', `auditEvents[${index}]`, errors)
        ? { details: optionalJsonObject(raw, 'details', `auditEvents[${index}]`, errors) }
        : {}),
      ...sourceAndExtensions(raw, auditKeys, `auditEvents[${index}]`, warnings),
    };
  });
}

function duplicateIds<T extends { id: string }>(
  values: readonly T[],
  collection: string,
  errors: FormatError[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.id))
      errors.push(
        error(
          'duplicate-id',
          `${collection}[${index}].id`,
          `${collection} contains duplicate id ${value.id}.`,
        ),
      );
    seen.add(value.id);
  });
}

function danglingReference(
  id: string | undefined,
  known: ReadonlySet<string>,
  path: string,
  warnings: FormatWarning[],
): void {
  if (id && !known.has(id))
    warnings.push(
      warning(
        'dangling-reference',
        path,
        `${id} is referenced but is not present in the imported collection.`,
      ),
    );
}

function validateReferences(data: DirectorTournament, warnings: FormatWarning[]): void {
  const teams = new Set(data.teams.map((team) => team.id));
  const players = new Set(data.players.map((player) => player.id));
  const orgs = new Set(data.organizations.map((organization) => organization.id));
  const rooms = new Set(data.rooms.map((room) => room.id));
  const equipment = new Set(data.equipment.map((item) => item.id));
  const phases = new Set(data.phases.map((phase) => phase.id));
  const pools = new Set(data.pools.map((pool) => pool.id));
  const rounds = new Set(data.rounds.map((round) => round.id));
  const packets = new Set(data.packets.map((packet) => packet.id));
  const games = new Set(data.games.map((game) => game.id));
  if (data.tournament.organizationId) {
    danglingReference(data.tournament.organizationId, orgs, 'tournament.organizationId', warnings);
  }
  data.players.forEach((player, index) =>
    danglingReference(player.organizationId, orgs, `players[${index}].organizationId`, warnings),
  );
  data.teams.forEach((team, index) => {
    danglingReference(team.organizationId, orgs, `teams[${index}].organizationId`, warnings);
    team.playerIds?.forEach((id, playerIndex) =>
      danglingReference(id, players, `teams[${index}].playerIds[${playerIndex}]`, warnings),
    );
  });
  data.registrations.forEach((registration, index) => {
    danglingReference(registration.teamId, teams, `registrations[${index}].teamId`, warnings);
    danglingReference(registration.organizationId, orgs, `registrations[${index}].organizationId`, warnings);
  });
  data.rooms.forEach((room, index) => {
    danglingReference(
      room.moderatorId,
      new Set(data.staff.map((staff) => staff.id)),
      `rooms[${index}].moderatorId`,
      warnings,
    );
    danglingReference(
      room.scorekeeperId,
      new Set(data.staff.map((staff) => staff.id)),
      `rooms[${index}].scorekeeperId`,
      warnings,
    );
    room.equipmentIds?.forEach((id, equipmentIndex) =>
      danglingReference(id, equipment, `rooms[${index}].equipmentIds[${equipmentIndex}]`, warnings),
    );
  });
  data.packets.forEach((packet, index) => {
    danglingReference(packet.roundId, rounds, `packets[${index}].roundId`, warnings);
    packet.gameIds?.forEach((id, gameIndex) =>
      danglingReference(id, games, `packets[${index}].gameIds[${gameIndex}]`, warnings),
    );
  });
  data.phases.forEach((phase, index) => {
    phase.poolIds?.forEach((id, poolIndex) =>
      danglingReference(id, pools, `phases[${index}].poolIds[${poolIndex}]`, warnings),
    );
    phase.roundIds?.forEach((id, roundIndex) =>
      danglingReference(id, rounds, `phases[${index}].roundIds[${roundIndex}]`, warnings),
    );
  });
  data.pools.forEach((pool, index) => {
    danglingReference(pool.phaseId, phases, `pools[${index}].phaseId`, warnings);
    pool.teamIds?.forEach((id, teamIndex) =>
      danglingReference(id, teams, `pools[${index}].teamIds[${teamIndex}]`, warnings),
    );
  });
  data.rounds.forEach((round, index) => {
    danglingReference(round.phaseId, phases, `rounds[${index}].phaseId`, warnings);
    round.packetIds?.forEach((id, packetIndex) =>
      danglingReference(id, packets, `rounds[${index}].packetIds[${packetIndex}]`, warnings),
    );
  });
  data.scheduledGames.forEach((game, index) => {
    danglingReference(game.phaseId, phases, `scheduledGames[${index}].phaseId`, warnings);
    danglingReference(game.roundId, rounds, `scheduledGames[${index}].roundId`, warnings);
    danglingReference(game.poolId, pools, `scheduledGames[${index}].poolId`, warnings);
    danglingReference(game.roomId, rooms, `scheduledGames[${index}].roomId`, warnings);
    danglingReference(game.packetId, packets, `scheduledGames[${index}].packetId`, warnings);
    game.teamIds.forEach((id, teamIndex) =>
      danglingReference(id ?? undefined, teams, `scheduledGames[${index}].teamIds[${teamIndex}]`, warnings),
    );
  });
  data.games.forEach((game, index) => {
    danglingReference(
      game.scheduledGameId,
      new Set(data.scheduledGames.map((scheduled) => scheduled.id)),
      `games[${index}].scheduledGameId`,
      warnings,
    );
    danglingReference(game.phaseId, phases, `games[${index}].phaseId`, warnings);
    danglingReference(game.roundId, rounds, `games[${index}].roundId`, warnings);
    danglingReference(game.poolId, pools, `games[${index}].poolId`, warnings);
    danglingReference(game.roomId, rooms, `games[${index}].roomId`, warnings);
    danglingReference(game.packetId, packets, `games[${index}].packetId`, warnings);
    game.teamIds.forEach((id, teamIndex) =>
      danglingReference(id ?? undefined, teams, `games[${index}].teamIds[${teamIndex}]`, warnings),
    );
  });
  data.resultSubmissions.forEach((submission, index) =>
    danglingReference(submission.gameId, games, `resultSubmissions[${index}].gameId`, warnings),
  );
  data.protests.forEach((protest, index) =>
    danglingReference(protest.gameId, games, `protests[${index}].gameId`, warnings),
  );
  data.playerStatistics.forEach((stat, index) =>
    danglingReference(stat.playerId, players, `playerStatistics[${index}].playerId`, warnings),
  );
}

/**
 * Normalize a small tournament input into the complete portable shape and validate structural
 * references. This is also the archive data boundary; React or a database repository never needs to
 * know which collections an archive happens to contain.
 */
export function normalizeTournamentData(
  input: DirectorTournamentInput | DirectorTournament,
): FormatReport<DirectorTournament> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  if (!isJsonObject(input))
    return fail([error('invalid-tournament', '', 'Tournament data must be a JSON-like object.')]);

  const tournament = readTournament(input.tournament, warnings, errors);
  const rules = asJsonObject(input.rules);
  const qbj = asJsonObject(input.qbj);
  const extensions = asJsonObject(input.extensions);
  const data: DirectorTournament = {
    tournament,
    ...(rules ? { rules } : {}),
    organizations: readOrganizations(input.organizations, warnings, errors),
    players: readPlayers(input.players, warnings, errors),
    teams: readTeams(input.teams, warnings, errors),
    registrations: readRegistrations(input.registrations, warnings, errors),
    rooms: readRooms(input.rooms, warnings, errors),
    staff: readStaff(input.staff, warnings, errors),
    equipment: readEquipment(input.equipment, warnings, errors),
    packets: readPackets(input.packets, warnings, errors),
    phases: readPhases(input.phases, warnings, errors),
    pools: readPools(input.pools, warnings, errors),
    rounds: readRounds(input.rounds, warnings, errors),
    scheduledGames: readScheduledGames(input.scheduledGames, warnings, errors),
    games: readGames(input.games, warnings, errors),
    playerStatistics: readStats(input.playerStatistics, warnings, errors),
    qbtcpSessions: readSessions(input.qbtcpSessions, warnings, errors),
    resultSubmissions: readSubmissions(input.resultSubmissions, warnings, errors),
    protests: readProtests(input.protests, warnings, errors),
    auditEvents: readAuditEvents(input.auditEvents, warnings, errors),
    ...(qbj ? { qbj: cloneJson(qbj) as DirectorTournament['qbj'] } : {}),
    ...(extensions ? { extensions: cloneJson(extensions) } : {}),
  };

  const unknownTopLevel = preserveUnknownFields(input, collectionKeys, '', warnings);
  if (unknownTopLevel) data.extensions = { ...(data.extensions ?? {}), ...unknownTopLevel };

  const collections: Array<[string, { id: string }[]]> = [
    ['organizations', data.organizations],
    ['players', data.players],
    ['teams', data.teams],
    ['registrations', data.registrations],
    ['rooms', data.rooms],
    ['staff', data.staff],
    ['equipment', data.equipment],
    ['packets', data.packets],
    ['phases', data.phases],
    ['pools', data.pools],
    ['rounds', data.rounds],
    ['scheduledGames', data.scheduledGames],
    ['games', data.games],
    ['playerStatistics', data.playerStatistics],
    ['qbtcpSessions', data.qbtcpSessions],
    ['resultSubmissions', data.resultSubmissions],
    ['protests', data.protests],
    ['auditEvents', data.auditEvents],
  ];
  collections.forEach(([name, values]) => duplicateIds(values, name, errors));
  validateReferences(data, warnings);
  return errors.length > 0 ? fail(errors, warnings) : ok(data, warnings);
}

/** A useful starting point for New Tournament and for adapter fixtures. */
export function createTournamentData(
  tournament: TournamentRecord,
  input: Omit<Partial<DirectorTournament>, 'tournament'> = {},
): DirectorTournament {
  return {
    tournament,
    organizations: input.organizations?.slice() ?? [],
    players: input.players?.slice() ?? [],
    teams: input.teams?.slice() ?? [],
    registrations: input.registrations?.slice() ?? [],
    rooms: input.rooms?.slice() ?? [],
    staff: input.staff?.slice() ?? [],
    equipment: input.equipment?.slice() ?? [],
    packets: input.packets?.slice() ?? [],
    phases: input.phases?.slice() ?? [],
    pools: input.pools?.slice() ?? [],
    rounds: input.rounds?.slice() ?? [],
    scheduledGames: input.scheduledGames?.slice() ?? [],
    games: input.games?.slice() ?? [],
    playerStatistics: input.playerStatistics?.slice() ?? [],
    qbtcpSessions: input.qbtcpSessions?.slice() ?? [],
    resultSubmissions: input.resultSubmissions?.slice() ?? [],
    protests: input.protests?.slice() ?? [],
    auditEvents: input.auditEvents?.slice() ?? [],
    ...(input.rules ? { rules: cloneJson(input.rules) } : {}),
    ...(input.qbj ? { qbj: cloneJson(input.qbj as unknown as JsonValue) as DirectorTournament['qbj'] } : {}),
    ...(input.extensions ? { extensions: cloneJson(input.extensions) } : {}),
  };
}
