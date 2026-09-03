/**
 * QBJ adapters for Director interchange.
 *
 * The wire format here follows the conventions already used by QBSheet's scorer: serialized QBJ is
 * `{ version: "2.1.1", objects: [...] }`; tournament data is carried by Tournament → Phase → Round
 * → Match; teams are referenced from Match.match_teams; and scored aggregates use the snake_case
 * QBJ names used by YellowFruit. This package owns no second scoring model. It maps those wire
 * objects to the Director interchange types and keeps the original object on every imported record.
 */
import type {
  DirectorTournament,
  DirectorTournamentInput,
  FormatError,
  FormatReport,
  FormatWarning,
  GamePlayerResult,
  GameRecord,
  GameResult,
  GameTeamResult,
  JsonObject,
  JsonValue,
  OrganizationRecord,
  PacketRecord,
  PhaseRecord,
  PlayerRecord,
  PoolRecord,
  RegistrationRecord,
  RoundRecord,
  ScheduledGameRecord,
  TeamRecord,
} from './types';
import { createTournamentData, normalizeTournamentData } from './tournament';
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
  mergeSourceAndExtensions,
  ok,
  preserveUnknownFields,
  slugId,
  warning,
} from './util';

export const qbjSerializationVersion = '2.1.1' as const;
export const supportedQbjVersions: readonly string[] = [qbjSerializationVersion];
export const qbjMimeType = 'application/vnd.quizbowl.qbj+json';
export const qbjFileExtension = '.qbj';
export const maxQbjBytes = 8 * 1024 * 1024;

export type QbjObject = JsonObject;

export interface QbjDocument {
  version: string;
  objects: QbjObject[];
  /** Non-standard document-level keys retained by an import and written back on export. */
  extensions?: JsonObject;
}

export type QbjInput = string | Uint8Array | QbjDocument | JsonObject;

export interface QbjImportValue {
  document: QbjDocument;
  tournament: DirectorTournament;
  /** True when the input was a bare Match object rather than an official envelope. */
  matchOnly: boolean;
  warnings: FormatWarning[];
}

export type QbjExportMode = 'tournament' | 'teams' | 'games' | 'results';

export interface QbjExportOptions {
  mode?: QbjExportMode;
  gameIds?: readonly string[];
  teamIds?: readonly string[];
  includeUnplayed?: boolean;
}

const rootKeys = new Set(['version', 'objects']);
const tournamentKeys = new Set([
  'type',
  'id',
  'name',
  'scoring_rules',
  'registrations',
  'phases',
  'organization',
  'school',
  'date',
  'endDate',
  'location',
  'questionSet',
  'notes',
]);
const organizationKeys = new Set(['type', 'id', 'name', 'city', 'state', 'country', 'notes']);
const playerKeys = new Set([
  'type',
  'id',
  'name',
  'first_name',
  'last_name',
  'grade',
  'year',
  'number',
  'captain',
  'notes',
]);
const rulesKeys = new Set([
  'type',
  'id',
  'name',
  'teams_per_match',
  'maximum_players_per_team',
  'regulation_tossup_count',
  'maximum_regulation_tossup_count',
  'minimum_overtime_question_count',
  'overtime_includes_bonuses',
  'answer_types',
  'total_divisor',
  'maximum_bonus_score',
  'bonus_divisor',
  'minimum_parts_per_bonus',
  'maximum_parts_per_bonus',
  'points_per_bonus_part',
  'bonuses_bounce_back',
  'lightning_count_per_team',
  'lightning_divisor',
]);
const teamKeys = new Set([
  'type',
  'id',
  'name',
  'players',
  'registration',
  'organization',
  'school',
  'letter',
  'seed',
  'status',
  'notes',
]);
const registrationKeys = new Set([
  'type',
  'id',
  'name',
  'teams',
  'organization',
  'school',
  'division',
  'seed',
  'status',
]);
const phaseKeys = new Set(['type', 'id', 'name', 'rounds', 'pools', 'order', 'advancement', 'carryovers']);
const poolKeys = new Set(['type', 'id', 'name', 'phase', 'teams', 'order']);
const roundKeys = new Set(['type', 'id', 'name', 'number', 'packets', 'matches', 'revision', 'status']);
const packetKeys = new Set(['type', 'id', 'name', 'round', 'used', 'replacement_for', 'tiebreaker', 'notes']);
const matchKeys = new Set([
  'type',
  'id',
  'location',
  'moderator',
  'scorekeeper',
  'notes',
  '_round',
  'match_teams',
  'match_questions',
  'tossups_read',
  'overtime_tossups_read',
  '_qbtcp',
]);
const matchTeamKeys = new Set([
  'team',
  'forfeit_loss',
  'points',
  'bonus_bounceback_points',
  'lightning_points',
  'correct_tossups_without_bonuses',
  'bonuses_heard',
  'bonus_points',
  'match_players',
  'YfData',
]);
const matchPlayerKeys = new Set([
  'player',
  'tossups_heard',
  'answer_counts',
  'points',
  'bonuses_heard',
  'bonus_points',
]);

function resolveRef(value: unknown, byId: ReadonlyMap<string, QbjObject>): QbjObject | null {
  if (typeof value === 'string') return byId.get(value) ?? null;
  if (!isJsonObject(value)) return null;
  const ref = asString(value.$ref);
  return ref ? (byId.get(ref) ?? null) : value;
}

function valueId(value: unknown, byId: ReadonlyMap<string, QbjObject>): string | undefined {
  if (typeof value === 'string') return asString(value);
  if (isJsonObject(value)) {
    const explicit = asString(value.$ref) ?? asString(value.id);
    if (explicit) return explicit;
  }
  const resolved = resolveRef(value, byId);
  return resolved ? asString(resolved.id) : asString(value);
}

function valueName(value: unknown, byId: ReadonlyMap<string, QbjObject>): string | undefined {
  const resolved = resolveRef(value, byId);
  return asString(resolved?.name) ?? (isJsonObject(value) ? asString(value.name) : undefined);
}

function objectType(value: JsonObject): string | undefined {
  return asString(value.type);
}

function isBareMatch(value: JsonObject): boolean {
  return value.type === 'Match' || Array.isArray(value.match_teams);
}

function parseQbjInput(input: QbjInput): FormatReport<{ value: QbjDocument; matchOnly: boolean }> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  let parsed: unknown = input;
  if (input instanceof Uint8Array) {
    if (input.byteLength > maxQbjBytes)
      return fail([error('qbj-too-large', '', 'The QBJ input exceeds the 8 MiB safety limit.')], warnings);
    try {
      parsed = JSON.parse(new TextDecoder().decode(input));
    } catch {
      return fail([error('invalid-json', '', 'The QBJ input is not valid UTF-8 JSON.')], warnings);
    }
  } else if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > maxQbjBytes)
      return fail([error('qbj-too-large', '', 'The QBJ input exceeds the 8 MiB safety limit.')], warnings);
    try {
      parsed = JSON.parse(input);
    } catch {
      return fail([error('invalid-json', '', 'The QBJ input is not valid JSON.')], warnings);
    }
  }
  if (!isJsonObject(parsed) || !isJsonValue(parsed))
    return fail([error('invalid-qbj', '', 'A QBJ document must be a JSON object.')], warnings);
  const root = parsed;
  if (Array.isArray(root.objects)) {
    const version = asString(root.version);
    if (!version)
      errors.push(
        error('missing-version', 'version', 'A serialized QBJ document must state its schema version.'),
      );
    else if (!supportedQbjVersions.includes(version))
      errors.push(
        error(
          'unsupported-version',
          'version',
          `This build reads QBJ ${qbjSerializationVersion}, not ${version}.`,
        ),
      );
    const objects: QbjObject[] = [];
    root.objects.forEach((entry, index) => {
      if (!isJsonObject(entry) || !isJsonValue(entry))
        errors.push(error('invalid-object', `objects[${index}]`, 'Every QBJ object must be a JSON object.'));
      else objects.push(entry);
    });
    const ids = new Set<string>();
    objects.forEach((entry, index) => {
      const id = asString(entry.id);
      if (id && ids.has(id))
        errors.push(
          error('duplicate-id', `objects[${index}].id`, `QBJ object id ${id} occurs more than once.`),
        );
      if (id) ids.add(id);
    });
    const rootExtensions = Object.fromEntries(
      Object.entries(root).filter(([key]) => !rootKeys.has(key)),
    ) as JsonObject;
    Object.keys(rootExtensions).forEach((key) =>
      warnings.push(
        warning(
          'unsupported-field-preserved',
          key,
          `The QBJ document field ${key} is not interpreted; it was preserved.`,
          rootExtensions[key],
        ),
      ),
    );
    if (errors.length > 0 || !version) return fail(errors, warnings);
    return ok(
      {
        value: {
          version,
          objects,
          ...(Object.keys(rootExtensions).length > 0 ? { extensions: rootExtensions } : {}),
        },
        matchOnly: false,
      },
      warnings,
    );
  }
  if (isBareMatch(root)) {
    warnings.push(
      warning(
        'match-only-compatibility',
        '',
        'This is a bare Match QBJ object; a synthetic tournament wrapper will be used for Director import.',
      ),
    );
    return ok({ value: { version: qbjSerializationVersion, objects: [root] }, matchOnly: true }, warnings);
  }
  return fail(
    [
      error(
        'invalid-qbj-shape',
        '',
        'QBJ must be a serialized {version, objects} document or a bare Match object.',
      ),
    ],
    warnings,
  );
}

function rawWithExtensions(
  raw: QbjObject,
  known: ReadonlySet<string>,
  path: string,
  warnings: FormatWarning[],
): { source: JsonObject; extensions?: JsonObject } {
  const extensions = preserveUnknownFields(raw, known, path, warnings);
  return {
    source: cloneJson(raw),
    ...(extensions ? { extensions } : {}),
  };
}

function playerFromRaw(
  raw: QbjObject,
  path: string,
  warnings: FormatWarning[],
  fallbackId: string,
): PlayerRecord {
  const id = asString(raw.id) ?? fallbackId;
  const name = asString(raw.name) ?? 'Unnamed player';
  const source = rawWithExtensions(raw, playerKeys, path, warnings);
  return {
    id,
    name,
    ...(asString(raw.grade) ? { grade: asString(raw.grade) } : {}),
    ...(asString(raw.number) || asFiniteNumber(raw.number) !== undefined
      ? { rosterNumber: (asString(raw.number) ?? asFiniteNumber(raw.number)) as string | number }
      : {}),
    ...(asBoolean(raw.captain) !== undefined ? { captain: asBoolean(raw.captain) } : {}),
    ...(asString(raw.notes) ? { notes: asString(raw.notes) } : {}),
    ...source,
  };
}

function identityNameKey(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase();
}

function addNamedIdentity<T extends { name: string }>(index: Map<string, T[]>, value: T): void {
  const key = identityNameKey(value.name);
  const values = index.get(key);
  const valueId = (value as T & { id?: string }).id;
  if (values) {
    if (!values.some((entry) => entry === value || (entry as T & { id?: string }).id === valueId))
      values.push(value);
  } else index.set(key, [value]);
}

function fallbackIdentityId(prefix: string, name: string, path: string): string {
  return slugId(prefix, name, path);
}

function registerPlayer(
  raw: QbjObject,
  fallbackId: string,
  path: string,
  byId: Map<string, PlayerRecord>,
  byName: Map<string, PlayerRecord[]>,
  players: PlayerRecord[],
  warnings: FormatWarning[],
): PlayerRecord {
  const parsed = playerFromRaw(raw, path, warnings, fallbackId);
  const existing = byId.get(parsed.id);
  if (existing) return existing;
  byId.set(parsed.id, parsed);
  players.push(parsed);
  addNamedIdentity(byName, parsed);
  return parsed;
}

function playerForReference(
  value: unknown,
  teamName: string,
  path: string,
  byId: ReadonlyMap<string, QbjObject>,
  playerById: Map<string, PlayerRecord>,
  playerByName: Map<string, PlayerRecord[]>,
  players: PlayerRecord[],
  warnings: FormatWarning[],
): PlayerRecord {
  const explicitId = valueId(value, byId);
  const resolved = resolveRef(value, byId);
  const rawObject = isJsonObject(value) ? value : undefined;
  const name = asString(resolved?.name) ?? asString(rawObject?.name) ?? explicitId ?? 'Unnamed player';

  if (explicitId) {
    const existing = playerById.get(explicitId);
    if (existing) return existing;
    if (!resolved && (typeof value === 'string' || rawObject?.$ref !== undefined)) {
      warnings.push(
        warning(
          'unresolved-player-reference',
          `${path}.player`,
          `The stable player reference ${explicitId} was not defined; its identity was retained with incomplete roster data.`,
        ),
      );
    }
    const raw = resolved ?? { ...(rawObject ?? {}), id: explicitId, name };
    return registerPlayer(raw, explicitId, `${path}.player`, playerById, playerByName, players, warnings);
  }

  const candidates = playerByName.get(identityNameKey(name)) ?? [];
  if (candidates.length === 1) {
    warnings.push(
      warning(
        'name-fallback',
        `${path}.player`,
        `The player was matched by the unique display name ${JSON.stringify(name)} because no stable id was provided.`,
      ),
    );
    return candidates[0];
  }
  if (candidates.length > 1) {
    warnings.push(
      warning(
        'ambiguous-player-name',
        `${path}.player`,
        `The display name ${JSON.stringify(name)} matches multiple players; no existing player was selected.`,
      ),
    );
  } else {
    warnings.push(
      warning(
        'name-fallback',
        `${path}.player`,
        `No stable player id was provided for ${JSON.stringify(name)}; a match-scoped identity was generated.`,
      ),
    );
  }
  const id = fallbackIdentityId('player', teamName, path);
  return registerPlayer(
    { ...(rawObject ?? {}), id, name },
    id,
    `${path}.player`,
    playerById,
    playerByName,
    players,
    warnings,
  );
}

function teamIdForReference(
  value: unknown,
  path: string,
  byId: ReadonlyMap<string, QbjObject>,
  teamByName: ReadonlyMap<string, TeamRecord[]>,
  warnings: FormatWarning[],
): string | undefined {
  const explicitId = valueId(value, byId);
  if (explicitId) return explicitId;
  const name = valueName(value, byId);
  if (!name) return undefined;
  const candidates = teamByName.get(identityNameKey(name)) ?? [];
  if (candidates.length === 1) {
    warnings.push(
      warning(
        'name-fallback',
        path,
        `The team was matched by the unique display name ${JSON.stringify(name)} because no stable id was provided.`,
      ),
    );
    return candidates[0].id;
  }
  if (candidates.length > 1)
    warnings.push(
      warning(
        'ambiguous-team-name',
        path,
        `The display name ${JSON.stringify(name)} matches multiple teams; no existing team was selected.`,
      ),
    );
  return undefined;
}

function organizationFromRaw(
  raw: QbjObject,
  path: string,
  warnings: FormatWarning[],
  fallbackId: string,
): OrganizationRecord {
  const source = rawWithExtensions(raw, organizationKeys, path, warnings);
  return {
    id: asString(raw.id) ?? fallbackId,
    name: asString(raw.name) ?? 'Unnamed organization',
    ...(asString(raw.city) ? { city: asString(raw.city) } : {}),
    ...(asString(raw.state) ? { state: asString(raw.state) } : {}),
    ...(asString(raw.country) ? { country: asString(raw.country) } : {}),
    ...(asString(raw.notes) ? { notes: asString(raw.notes) } : {}),
    ...source,
  };
}

function teamFromRaw(
  raw: QbjObject,
  path: string,
  byId: ReadonlyMap<string, QbjObject>,
  players: PlayerRecord[],
  playerById: Map<string, PlayerRecord>,
  playerByName: Map<string, PlayerRecord[]>,
  warnings: FormatWarning[],
  fallbackId: string,
): TeamRecord {
  const id = asString(raw.id) ?? fallbackId;
  const name = asString(raw.name) ?? 'Unnamed team';
  const embedded: PlayerRecord[] = [];
  for (const [index, value] of asJsonArray(raw.players).entries()) {
    embedded.push(
      playerForReference(
        value,
        name,
        `${path}.players[${index}]`,
        byId,
        playerById,
        playerByName,
        players,
        warnings,
      ),
    );
  }
  const organizationId = valueId(raw.organization ?? raw.school, byId);
  const source = rawWithExtensions(raw, teamKeys, path, warnings);
  return {
    id,
    name,
    ...(asString(raw.letter) ? { letter: asString(raw.letter) } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(asFiniteNumber(raw.seed) !== undefined ? { seed: asFiniteNumber(raw.seed) } : {}),
    ...(asString(raw.status) ? { status: asString(raw.status) } : {}),
    ...(asString(raw.notes) ? { notes: asString(raw.notes) } : {}),
    ...(embedded.length > 0 ? { playerIds: embedded.map((player) => player.id), players: embedded } : {}),
    ...source,
  };
}

function asJsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) && value.every((entry) => isJsonValue(entry)) ? value : [];
}

function collectNestedByType(root: QbjObject, type: string, output: QbjObject[], seen: Set<string>): void {
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJsonObject(value)) return;
    if (value.type === type) {
      const id = asString(value.id);
      const key = id ?? JSON.stringify(value);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(value);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(root);
}

function roundContext(
  document: QbjDocument,
  byId: ReadonlyMap<string, QbjObject>,
): Map<string, { roundId?: string; phaseId?: string; poolId?: string }> {
  const contexts = new Map<string, { roundId?: string; phaseId?: string; poolId?: string }>();
  const phases: QbjObject[] = [];
  const seenPhases = new Set<string>();
  document.objects
    .filter((entry) => entry.type === 'Tournament')
    .forEach((tournament) => collectNestedByType(tournament, 'Phase', phases, seenPhases));
  document.objects
    .filter((entry) => entry.type === 'Phase')
    .forEach((phase) => collectNestedByType(phase, 'Phase', phases, seenPhases));
  const indexPhase = (phase: QbjObject, phaseId?: string) => {
    const actualPhaseId = asString(phase.id) ?? phaseId;
    for (const roundValue of asJsonArray(phase.rounds)) {
      const round = resolveRef(roundValue, byId);
      if (!round) continue;
      const roundId = asString(round.id);
      for (const matchValue of asJsonArray(round.matches)) {
        const match = resolveRef(matchValue, byId);
        const matchId = match ? asString(match.id) : undefined;
        if (matchId) contexts.set(matchId, { roundId, phaseId: actualPhaseId });
      }
    }
  };
  phases.forEach((phase) => indexPhase(phase));
  document.objects.filter((entry) => entry.type === 'Phase').forEach((phase) => indexPhase(phase));
  return contexts;
}

function inferAnswerCounts(
  value: unknown,
  byId: ReadonlyMap<string, QbjObject>,
): { powers: number; gets: number; negs: number } | undefined {
  if (!Array.isArray(value) || !value.every(isJsonObject)) return undefined;
  let powers = 0;
  let gets = 0;
  let negs = 0;
  for (const entry of value) {
    const count = asFiniteNumber(entry.number);
    if (count === undefined || !Number.isInteger(count) || count < 0) return undefined;
    const answerType =
      resolveRef(entry.answer_type, byId) ?? (isJsonObject(entry.answer_type) ? entry.answer_type : null);
    if (!answerType) return undefined;
    const label =
      `${asString(answerType.label) ?? ''} ${asString(answerType.short_label) ?? ''} ${asString(answerType.name) ?? ''}`.toLocaleLowerCase();
    const answerValue = asFiniteNumber(answerType.value);
    if (!label.trim() && answerValue === undefined) return undefined;
    if (label.includes('neg') || (answerValue !== undefined && answerValue < 0)) negs += count;
    else if (label.includes('correct') || label.includes('get') || label.trim() === 'c') gets += count;
    else if (label.includes('power') || label.trim() === 'p') powers += count;
    else if (answerValue !== undefined && answerValue > 10) powers += count;
    else if (answerValue === 10) gets += count;
    else return undefined;
  }
  return { powers, gets, negs };
}

function playerResultFromRaw(
  raw: QbjObject,
  teamId: string,
  teamName: string,
  byId: ReadonlyMap<string, QbjObject>,
  playerById: Map<string, PlayerRecord>,
  playerByName: Map<string, PlayerRecord[]>,
  players: PlayerRecord[],
  path: string,
  warnings: FormatWarning[],
): GamePlayerResult {
  const player = playerForReference(
    raw.player,
    teamName,
    path,
    byId,
    playerById,
    playerByName,
    players,
    warnings,
  );
  const counts = inferAnswerCounts(raw.answer_counts, byId);
  if (raw.answer_counts !== undefined && !counts) {
    warnings.push(
      warning(
        'incomplete-answer-counts',
        `${path}.answer_counts`,
        'Answer counts were present but could not be safely classified; derived buzz statistics remain unknown.',
      ),
    );
  }
  const source = rawWithExtensions(raw, matchPlayerKeys, path, warnings);
  return {
    playerId: player.id,
    teamId,
    ...(asFiniteNumber(raw.tossups_heard) !== undefined
      ? { tossupsHeard: asFiniteNumber(raw.tossups_heard) }
      : {}),
    ...(counts ? { powers: counts.powers, gets: counts.gets, negs: counts.negs } : {}),
    ...(asFiniteNumber(raw.points) !== undefined ? { points: asFiniteNumber(raw.points) } : {}),
    ...(asFiniteNumber(raw.bonuses_heard) !== undefined
      ? { bonusesHeard: asFiniteNumber(raw.bonuses_heard) }
      : {}),
    ...(asFiniteNumber(raw.bonus_points) !== undefined
      ? { bonusPoints: asFiniteNumber(raw.bonus_points) }
      : {}),
    ...(raw.answer_counts !== undefined && isJsonValue(raw.answer_counts)
      ? { answerCounts: cloneJson(raw.answer_counts) }
      : {}),
    ...source,
  };
}

function resultFromMatch(
  match: QbjObject,
  teamIds: [string | null, string | null],
  teamNames: [string, string],
  byId: ReadonlyMap<string, QbjObject>,
  playerById: Map<string, PlayerRecord>,
  playerByName: Map<string, PlayerRecord[]>,
  players: PlayerRecord[],
  warnings: FormatWarning[],
): GameResult {
  const teamResults: GameTeamResult[] = [];
  const playerResults: GamePlayerResult[] = [];
  let statisticsIncomplete = false;
  const matchTeams = asJsonArray(match.match_teams).filter(isJsonObject);
  matchTeams.forEach((raw, index) => {
    const teamId = teamIds[index] ?? slugId('team', teamNames[index] ?? `side-${index + 1}`);
    const teamName = teamNames[index] ?? `Side ${index + 1}`;
    const teamPlayers = asJsonArray(raw.match_players)
      .filter(isJsonObject)
      .map((player, playerIndex) => {
        const result = playerResultFromRaw(
          player,
          teamId,
          teamName,
          byId,
          playerById,
          playerByName,
          players,
          `match.match_teams[${index}].match_players[${playerIndex}]`,
          warnings,
        );
        playerResults.push(result);
        return result;
      });
    const summed = teamPlayers.reduce(
      (total, player) => ({
        tossupsHeard:
          total.tossupsHeard !== undefined && player.tossupsHeard !== undefined
            ? total.tossupsHeard + player.tossupsHeard
            : undefined,
        powers:
          total.powers !== undefined && player.powers !== undefined
            ? total.powers + player.powers
            : undefined,
        gets: total.gets !== undefined && player.gets !== undefined ? total.gets + player.gets : undefined,
        negs: total.negs !== undefined && player.negs !== undefined ? total.negs + player.negs : undefined,
      }),
      {
        tossupsHeard: teamPlayers.length > 0 ? 0 : undefined,
        powers: teamPlayers.length > 0 ? 0 : undefined,
        gets: teamPlayers.length > 0 ? 0 : undefined,
        negs: teamPlayers.length > 0 ? 0 : undefined,
      },
    );
    if (summed.tossupsHeard === undefined) {
      statisticsIncomplete = true;
      warnings.push(
        warning(
          'missing-tossups-heard',
          `match.match_teams[${index}]`,
          'Tossups heard was not available for every player; the team total remains unknown.',
        ),
      );
    }
    if (summed.powers === undefined || summed.gets === undefined || summed.negs === undefined)
      statisticsIncomplete = true;
    const source = rawWithExtensions(raw, matchTeamKeys, `match.match_teams[${index}]`, warnings);
    teamResults.push({
      teamId,
      ...(asFiniteNumber(raw.points) !== undefined ? { points: asFiniteNumber(raw.points) } : {}),
      ...(asBoolean(raw.forfeit_loss) !== undefined ? { forfeitLoss: asBoolean(raw.forfeit_loss) } : {}),
      ...(asFiniteNumber(raw.bonus_bounceback_points) !== undefined
        ? { bonusBouncebackPoints: asFiniteNumber(raw.bonus_bounceback_points) }
        : {}),
      ...(asFiniteNumber(raw.lightning_points) !== undefined
        ? { lightningPoints: asFiniteNumber(raw.lightning_points) }
        : {}),
      ...(asFiniteNumber(raw.correct_tossups_without_bonuses) !== undefined
        ? { correctTossupsWithoutBonuses: asFiniteNumber(raw.correct_tossups_without_bonuses) }
        : {}),
      ...(asFiniteNumber(raw.bonuses_heard) !== undefined
        ? { bonusesHeard: asFiniteNumber(raw.bonuses_heard) }
        : {}),
      ...(asFiniteNumber(raw.bonus_points) !== undefined
        ? { bonusPoints: asFiniteNumber(raw.bonus_points) }
        : {}),
      ...(summed.tossupsHeard !== undefined ? { tossupsHeard: summed.tossupsHeard } : {}),
      ...(summed.powers !== undefined ? { powers: summed.powers } : {}),
      ...(summed.gets !== undefined ? { gets: summed.gets } : {}),
      ...(summed.negs !== undefined ? { negs: summed.negs } : {}),
      ...(raw.match_players !== undefined ? { answerCounts: cloneJson(raw.match_players) } : {}),
      ...source,
    });
  });
  const matchSource = rawWithExtensions(match, matchKeys, 'match', warnings);
  return {
    teams: teamResults,
    ...(playerResults.length > 0 ? { players: playerResults } : {}),
    ...(asFiniteNumber(match.tossups_read) !== undefined
      ? { tossupsRead: asFiniteNumber(match.tossups_read) }
      : {}),
    ...(asFiniteNumber(match.overtime_tossups_read) !== undefined
      ? { overtimeTossupsRead: asFiniteNumber(match.overtime_tossups_read) }
      : {}),
    ...(Array.isArray(match.match_questions)
      ? { questions: cloneJson(match.match_questions) as JsonValue[] }
      : {}),
    ...(asString(match.notes) ? { notes: asString(match.notes) } : {}),
    ...(asString(match.moderator) ? { moderator: asString(match.moderator) } : {}),
    ...(asString(match.scorekeeper) ? { scorekeeper: asString(match.scorekeeper) } : {}),
    forfeit: teamResults.some((team) => team.forfeitLoss === true),
    ...(statisticsIncomplete ? { statisticsIncomplete: true } : {}),
    rawSubmission: cloneJson(match),
    ...matchSource,
  };
}

function parseRound(
  raw: QbjObject,
  phaseId: string | undefined,
  index: number,
  warnings: FormatWarning[],
): RoundRecord {
  const id = asString(raw.id) ?? `round_${index + 1}`;
  const name = asString(raw.display_name) ?? asString(raw.name) ?? `Round ${index + 1}`;
  return {
    id,
    name,
    ...(phaseId ? { phaseId } : {}),
    ...(asFiniteNumber(raw.number) !== undefined ? { number: asFiniteNumber(raw.number) } : {}),
    ...(asString(raw.name) ? { qbjName: asString(raw.name) } : {}),
    ...(asFiniteNumber(raw.revision) !== undefined ? { revision: asFiniteNumber(raw.revision) } : {}),
    ...(asString(raw.status) ? { status: asString(raw.status) } : {}),
    ...rawWithExtensions(raw, roundKeys, `rounds[${index}]`, warnings),
  };
}

function importQbjValue(
  parsed: { value: QbjDocument; matchOnly: boolean },
  initialWarnings: FormatWarning[],
): FormatReport<QbjImportValue> {
  const warnings = [...initialWarnings];
  const errors: FormatError[] = [];
  const document = parsed.value;
  const byId = new Map<string, QbjObject>();
  document.objects.forEach((object) => {
    const id = asString(object.id);
    if (id) byId.set(id, object);
  });
  const organizations: OrganizationRecord[] = [];
  const organizationById = new Set<string>();
  document.objects
    .filter((entry) => entry.type === 'Organization' || entry.type === 'School')
    .forEach((raw, index) => {
      const organization = organizationFromRaw(
        raw,
        `organizations[${index}]`,
        warnings,
        `organization_${index + 1}`,
      );
      if (!organizationById.has(organization.id)) {
        organizationById.add(organization.id);
        organizations.push(organization);
      }
    });
  const players: PlayerRecord[] = [];
  const playerById = new Map<string, PlayerRecord>();
  const playerByName = new Map<string, PlayerRecord[]>();
  document.objects
    .filter((entry) => entry.type === 'Player')
    .forEach((raw, index) => {
      const player = playerFromRaw(raw, `players[${index}]`, warnings, `player_${index + 1}`);
      if (!playerById.has(player.id)) {
        playerById.set(player.id, player);
        players.push(player);
        addNamedIdentity(playerByName, player);
      }
    });
  const teams: TeamRecord[] = [];
  const teamById = new Map<string, TeamRecord>();
  document.objects
    .filter((entry) => entry.type === 'Team')
    .forEach((raw, index) => {
      const team = teamFromRaw(
        raw,
        `teams[${index}]`,
        byId,
        players,
        playerById,
        playerByName,
        warnings,
        `team_${index + 1}`,
      );
      if (teamById.has(team.id))
        errors.push(error('duplicate-team', `teams[${index}]`, `Team id ${team.id} occurs more than once.`));
      else {
        teamById.set(team.id, team);
        teams.push(team);
      }
    });
  const teamByName = new Map<string, TeamRecord[]>();
  teams.forEach((team) => addNamedIdentity(teamByName, team));
  const registrations: RegistrationRecord[] = [];
  document.objects
    .filter((entry) => entry.type === 'Registration')
    .forEach((raw, index) => {
      const registrationTeams = asJsonArray(raw.teams)
        .map((value, teamIndex) =>
          teamIdForReference(
            value,
            `registrations[${index}].teams[${teamIndex}]`,
            byId,
            teamByName,
            warnings,
          ),
        )
        .filter((id): id is string => Boolean(id));
      const teamId =
        registrationTeams[0] ??
        teamIdForReference(raw.team, `registrations[${index}].team`, byId, teamByName, warnings) ??
        '';
      if (registrationTeams.length > 1)
        warnings.push(
          warning(
            'multiple-registration-teams',
            `registrations[${index}].teams`,
            'Only the first team is normalized to a Director registration; the original list remains in source.',
          ),
        );
      registrations.push({
        id: asString(raw.id) ?? `registration_${index + 1}`,
        teamId,
        ...(valueId(raw.organization ?? raw.school, byId)
          ? { organizationId: valueId(raw.organization ?? raw.school, byId) }
          : {}),
        ...(asString(raw.division) ? { division: asString(raw.division) } : {}),
        ...(asFiniteNumber(raw.seed) !== undefined ? { seed: asFiniteNumber(raw.seed) } : {}),
        ...(asString(raw.status) ? { status: asString(raw.status) } : {}),
        ...rawWithExtensions(raw, registrationKeys, `registrations[${index}]`, warnings),
      });
    });
  const tournamentRaw = document.objects.find((entry) => entry.type === 'Tournament');
  if (!tournamentRaw)
    warnings.push(
      warning(
        'missing-tournament',
        'objects',
        'The QBJ document has no Tournament object; a synthetic tournament record was created.',
      ),
    );
  const tournament = {
    id: asString(tournamentRaw?.id) ?? 'tournament_imported',
    name:
      asString(tournamentRaw?.name) ?? (parsed.matchOnly ? 'Imported QBJ match' : 'Imported QBJ tournament'),
    ...(valueId(tournamentRaw?.organization ?? tournamentRaw?.school, byId)
      ? { organizationId: valueId(tournamentRaw?.organization ?? tournamentRaw?.school, byId) }
      : {}),
    ...(asString(tournamentRaw?.date) ? { date: asString(tournamentRaw?.date) } : {}),
    ...(asString(tournamentRaw?.endDate) ? { endDate: asString(tournamentRaw?.endDate) } : {}),
    ...(asString(tournamentRaw?.location) ? { location: asString(tournamentRaw?.location) } : {}),
    ...(asString(tournamentRaw?.questionSet) ? { questionSet: asString(tournamentRaw?.questionSet) } : {}),
    ...(asString(tournamentRaw?.notes) ? { notes: asString(tournamentRaw?.notes) } : {}),
    ...(tournamentRaw ? rawWithExtensions(tournamentRaw, tournamentKeys, 'tournament', warnings) : {}),
  };
  const rules = document.objects.find((entry) => entry.type === 'ScoringRules');
  if (!rules)
    warnings.push(
      warning(
        'missing-scoring-rules',
        'objects',
        'The QBJ document does not contain ScoringRules; Director can retain the tournament but cannot infer a ruleset.',
      ),
    );

  const phases: PhaseRecord[] = [];
  const pools: PoolRecord[] = [];
  const rounds: RoundRecord[] = [];
  const packets: PacketRecord[] = [];
  const phaseRawObjects: QbjObject[] = [];
  const seenPhase = new Set<string>();
  if (tournamentRaw) collectNestedByType(tournamentRaw, 'Phase', phaseRawObjects, seenPhase);
  document.objects
    .filter((entry) => entry.type === 'Phase')
    .forEach((raw) => collectNestedByType(raw, 'Phase', phaseRawObjects, seenPhase));
  const roundRawObjects: QbjObject[] = [];
  const seenRound = new Set<string>();
  phaseRawObjects.forEach((phase) => collectNestedByType(phase, 'Round', roundRawObjects, seenRound));
  document.objects
    .filter((entry) => entry.type === 'Round')
    .forEach((raw) => collectNestedByType(raw, 'Round', roundRawObjects, seenRound));
  const packetRawObjects: QbjObject[] = [];
  const seenPacket = new Set<string>();
  roundRawObjects.forEach((round) => collectNestedByType(round, 'Packet', packetRawObjects, seenPacket));
  document.objects
    .filter((entry) => entry.type === 'Packet')
    .forEach((raw) => collectNestedByType(raw, 'Packet', packetRawObjects, seenPacket));
  phaseRawObjects.forEach((raw, index) => {
    const phaseId = asString(raw.id) ?? `phase_${index + 1}`;
    const phase: PhaseRecord = {
      id: phaseId,
      name: asString(raw.name) ?? `Phase ${index + 1}`,
      ...(asString(raw.kind) ? { kind: asString(raw.kind) } : {}),
      ...(asFiniteNumber(raw.order) !== undefined ? { order: asFiniteNumber(raw.order) } : {}),
      ...(asJsonArray(raw.pools).length > 0
        ? {
            poolIds: asJsonArray(raw.pools).map(
              (value, poolIndex) => valueId(value, byId) ?? `pool_${index + 1}_${poolIndex + 1}`,
            ),
          }
        : {}),
      ...(asJsonArray(raw.rounds).length > 0
        ? {
            roundIds: asJsonArray(raw.rounds).map(
              (value, roundIndex) => valueId(value, byId) ?? `round_${index + 1}_${roundIndex + 1}`,
            ),
          }
        : {}),
      ...rawWithExtensions(raw, phaseKeys, `phases[${index}]`, warnings),
    };
    phases.push(phase);
    asJsonArray(raw.pools).forEach((value, poolIndex) => {
      const poolRaw = resolveRef(value, byId);
      if (!poolRaw) return;
      const poolId = asString(poolRaw.id) ?? `pool_${index + 1}_${poolIndex + 1}`;
      if (pools.some((pool) => pool.id === poolId)) return;
      pools.push({
        id: poolId,
        name: asString(poolRaw.name) ?? `Pool ${poolIndex + 1}`,
        phaseId,
        ...(asFiniteNumber(poolRaw.order) !== undefined ? { order: asFiniteNumber(poolRaw.order) } : {}),
        ...(asJsonArray(poolRaw.teams).length > 0
          ? {
              teamIds: asJsonArray(poolRaw.teams)
                .map((team) => valueId(team, byId))
                .filter((id): id is string => Boolean(id)),
            }
          : {}),
        ...rawWithExtensions(poolRaw, poolKeys, `pools[${pools.length}]`, warnings),
      });
    });
  });
  roundRawObjects.forEach((raw, index) => {
    const phaseId = phases.find((phase) => phase.roundIds?.includes(asString(raw.id) ?? ''))?.id;
    const round = parseRound(raw, phaseId, index, warnings);
    round.packetIds = asJsonArray(raw.packets)
      .map((packet) => valueId(packet, byId))
      .filter((id): id is string => Boolean(id));
    rounds.push(round);
  });
  packetRawObjects.forEach((raw, index) => {
    packets.push({
      id: asString(raw.id) ?? `packet_${index + 1}`,
      name: asString(raw.name) ?? `Packet ${index + 1}`,
      ...(valueId(raw.round, byId) ? { roundId: valueId(raw.round, byId) } : {}),
      ...(asBoolean(raw.used) !== undefined ? { used: asBoolean(raw.used) } : {}),
      ...(asString(raw.replacement_for) ? { replacementForId: asString(raw.replacement_for) } : {}),
      ...(asBoolean(raw.tiebreaker) !== undefined ? { tiebreaker: asBoolean(raw.tiebreaker) } : {}),
      ...(asString(raw.notes) ? { notes: asString(raw.notes) } : {}),
      ...rawWithExtensions(raw, packetKeys, `packets[${index}]`, warnings),
    });
  });

  const contexts = roundContext(document, byId);
  const scheduledGames: ScheduledGameRecord[] = [];
  const games: GameRecord[] = [];
  const matchObjects = document.objects.filter((entry) => entry.type === 'Match');
  matchObjects.forEach((match, index) => {
    const id = asString(match.id) ?? `game_${index + 1}`;
    const matchTeams = asJsonArray(match.match_teams).filter(isJsonObject);
    const teamIds: [string | null, string | null] = [null, null];
    const teamNames: [string, string] = ['Side 1', 'Side 2'];
    matchTeams.slice(0, 2).forEach((matchTeam, side) => {
      const teamRaw = resolveRef(matchTeam.team, byId);
      const name = asString(teamRaw?.name) ?? valueName(matchTeam.team, byId) ?? `Side ${side + 1}`;
      teamNames[side] = name;
      const referencedTeamId = valueId(matchTeam.team, byId);
      let teamId = referencedTeamId;
      if (!teamId) {
        const candidates = teamByName.get(identityNameKey(name)) ?? [];
        if (candidates.length === 1) {
          teamId = candidates[0].id;
          warnings.push(
            warning(
              'name-fallback',
              `objects[${index}].match_teams[${side}].team`,
              `The team was matched by the unique display name ${JSON.stringify(name)} because no stable id was provided.`,
            ),
          );
        } else {
          if (candidates.length > 1)
            warnings.push(
              warning(
                'ambiguous-team-name',
                `objects[${index}].match_teams[${side}].team`,
                `The display name ${JSON.stringify(name)} matches multiple teams; no existing team was selected.`,
              ),
            );
          else
            warnings.push(
              warning(
                'name-fallback',
                `objects[${index}].match_teams[${side}].team`,
                `No stable team id was provided for ${JSON.stringify(name)}; a match-scoped identity was generated.`,
              ),
            );
          teamId = fallbackIdentityId('team', name, `matches.${id}.match_teams.${side}`);
        }
      } else if (
        !teamRaw &&
        (typeof matchTeam.team === 'string' ||
          (isJsonObject(matchTeam.team) && matchTeam.team.$ref !== undefined))
      ) {
        warnings.push(
          warning(
            'unresolved-team-reference',
            `objects[${index}].match_teams[${side}].team`,
            `The stable team reference ${teamId} was not defined; its identity was retained with incomplete roster data.`,
          ),
        );
      }
      teamIds[side] = teamId;
      if (!teamById.has(teamId)) {
        const team = teamFromRaw(
          teamRaw ?? { ...(isJsonObject(matchTeam.team) ? matchTeam.team : {}), id: teamId, name },
          `teams.from-match[${index}].${side}`,
          byId,
          players,
          playerById,
          playerByName,
          warnings,
          teamId,
        );
        teamById.set(team.id, team);
        teams.push(team);
        addNamedIdentity(teamByName, team);
      }
    });
    if (matchTeams.length !== 2)
      warnings.push(
        warning(
          'invalid-match-teams',
          `objects[${index}].match_teams`,
          'The Match does not contain exactly two teams; missing sides were retained as null.',
        ),
      );
    const context = contexts.get(id);
    const poolId = pools.find((pool) => {
      const poolTeamIds = pool.teamIds ?? [];
      return (
        teamIds.some((teamId) => teamId !== null && poolTeamIds.includes(teamId)) &&
        teamIds.every((teamId) => teamId === null || poolTeamIds.includes(teamId))
      );
    })?.id;
    const qbtcp = asJsonObject(match._qbtcp);
    const roomId = asString(qbtcp?.room_id);
    const hasScoring =
      match.tossups_read !== undefined ||
      match.overtime_tossups_read !== undefined ||
      matchTeams.some(
        (team) =>
          team.points !== undefined || team.match_players !== undefined || team.forfeit_loss !== undefined,
      );
    const result = hasScoring
      ? resultFromMatch(match, teamIds, teamNames, byId, playerById, playerByName, players, warnings)
      : undefined;
    const source = rawWithExtensions(match, matchKeys, `games[${index}]`, warnings);
    const game: GameRecord = {
      id,
      ...(context?.phaseId ? { phaseId: context.phaseId } : {}),
      ...(context?.roundId ? { roundId: context.roundId } : {}),
      ...(poolId ? { poolId } : {}),
      ...(roomId ? { roomId } : {}),
      teamIds,
      status: hasScoring ? (result?.forfeit ? 'forfeit' : 'complete') : 'scheduled',
      ...(result ? { result } : {}),
      ...(hasScoring ? { rawSubmission: cloneJson(match) } : {}),
      ...source,
    };
    games.push(game);
    scheduledGames.push({
      id,
      ...(game.phaseId ? { phaseId: game.phaseId } : {}),
      ...(game.roundId ? { roundId: game.roundId } : {}),
      ...(poolId ? { poolId } : {}),
      ...(roomId ? { roomId } : {}),
      teamIds,
      status: hasScoring ? 'complete' : 'scheduled',
      ...source,
    });
  });
  rounds.forEach((round) => {
    const matches = matchObjects
      .filter((match) => contexts.get(asString(match.id) ?? '')?.roundId === round.id)
      .map((match) => asString(match.id))
      .filter((id): id is string => Boolean(id));
    if (matches.length > 0) round.extensions = { ...(round.extensions ?? {}), qbjMatchIds: matches };
  });

  const knownTypes = new Set([
    'Tournament',
    'ScoringRules',
    'Organization',
    'School',
    'Player',
    'Team',
    'Registration',
    'Phase',
    'Pool',
    'Round',
    'Packet',
    'Match',
    'AnswerType',
  ]);
  const unknownObjects = document.objects.filter((entry) => {
    const type = objectType(entry);
    if (type && knownTypes.has(type)) return false;
    warnings.push(
      warning(
        'unsupported-object-type',
        `objects[${document.objects.indexOf(entry)}]`,
        `QBJ object type ${type ?? '(missing type)'} is not interpreted; the original object was preserved.`,
      ),
    );
    return true;
  });
  const data = createTournamentData(tournament, {
    rules: rules ? cloneJson(rules) : undefined,
    organizations,
    players,
    teams,
    registrations,
    packets,
    phases,
    pools,
    rounds,
    scheduledGames,
    games,
    qbj: {
      version: document.version,
      ...(unknownObjects.length > 0 ? { unknownObjects: cloneJson(unknownObjects) } : {}),
      ...(document.extensions ? { extensions: cloneJson(document.extensions) } : {}),
    },
  });
  const normalized = normalizeTournamentData(data);
  if (!normalized.ok) return fail(normalized.errors, [...warnings, ...normalized.warnings]);
  return errors.length > 0
    ? fail(errors, warnings)
    : ok({ document, tournament: normalized.value, matchOnly: parsed.matchOnly, warnings }, warnings);
}

/** Validate and import a serialized QBJ document or a legacy bare Match object. */
export function importQbj(input: QbjInput): FormatReport<QbjImportValue> {
  const parsed = parseQbjInput(input);
  if (!parsed.ok) return parsed;
  return importQbjValue(parsed.value, parsed.warnings);
}

export const importQbjDocument = importQbj;

function baseFor(record: { source?: JsonObject; extensions?: JsonObject }, type: string): JsonObject {
  const source = record.source && record.source.type === type ? record.source : {};
  return mergeSourceAndExtensions(source, record.extensions);
}

function teamIdsInGames(games: readonly GameRecord[]): Set<string> {
  return new Set(games.flatMap((game) => game.teamIds.filter((id): id is string => Boolean(id))));
}

function playerForTeam(
  team: TeamRecord,
  playerId: string,
  data: DirectorTournament,
): PlayerRecord | undefined {
  return (
    team.players?.find((player) => player.id === playerId) ??
    data.players.find((player) => player.id === playerId)
  );
}

function playerObject(player: PlayerRecord): QbjObject {
  return {
    ...baseFor(player, 'Player'),
    type: 'Player',
    id: player.id,
    name: player.name,
    ...(player.grade !== undefined ? { grade: player.grade } : {}),
    ...(player.rosterNumber !== undefined ? { number: player.rosterNumber } : {}),
    ...(player.captain !== undefined ? { captain: player.captain } : {}),
    ...(player.notes !== undefined ? { notes: player.notes } : {}),
  };
}

function teamObject(team: TeamRecord, data: DirectorTournament): QbjObject {
  const ids = team.playerIds ?? team.players?.map((player) => player.id) ?? [];
  const players = ids
    .map((id) => playerForTeam(team, id, data))
    .filter((player): player is PlayerRecord => Boolean(player));
  return {
    ...baseFor(team, 'Team'),
    type: 'Team',
    id: team.id,
    name: team.name,
    ...(players.length > 0 ? { players: players.map(playerObject) } : {}),
    ...(team.organizationId ? { organization: { $ref: team.organizationId } } : {}),
    ...(team.letter !== undefined ? { letter: team.letter } : {}),
    ...(team.seed !== undefined ? { seed: team.seed } : {}),
    ...(team.status !== undefined ? { status: team.status } : {}),
    ...(team.notes !== undefined ? { notes: team.notes } : {}),
  };
}

function organizationObject(organization: OrganizationRecord): QbjObject {
  return {
    ...baseFor(organization, organization.source?.type === 'School' ? 'School' : 'Organization'),
    type: organization.source?.type === 'School' ? 'School' : 'Organization',
    id: organization.id,
    name: organization.name,
    ...(organization.city !== undefined ? { city: organization.city } : {}),
    ...(organization.state !== undefined ? { state: organization.state } : {}),
    ...(organization.country !== undefined ? { country: organization.country } : {}),
    ...(organization.notes !== undefined ? { notes: organization.notes } : {}),
  };
}

function registrationObject(registration: RegistrationRecord, teamId: string): QbjObject {
  return {
    ...baseFor(registration, 'Registration'),
    type: 'Registration',
    id: registration.id,
    ...(registration.organizationId ? { organization: { $ref: registration.organizationId } } : {}),
    teams: [{ $ref: teamId }],
    ...(registration.division !== undefined ? { division: registration.division } : {}),
    ...(registration.seed !== undefined ? { seed: registration.seed } : {}),
    ...(registration.status !== undefined ? { status: registration.status } : {}),
  };
}

function packetObject(packet: PacketRecord): QbjObject {
  return {
    ...baseFor(packet, 'Packet'),
    type: 'Packet',
    id: packet.id,
    name: packet.name,
    ...(packet.roundId ? { round: { $ref: packet.roundId } } : {}),
    ...(packet.used !== undefined ? { used: packet.used } : {}),
    ...(packet.replacementForId ? { replacement_for: packet.replacementForId } : {}),
    ...(packet.tiebreaker !== undefined ? { tiebreaker: packet.tiebreaker } : {}),
    ...(packet.notes !== undefined ? { notes: packet.notes } : {}),
  };
}

function playerMatchObject(
  player: GamePlayerResult,
  team: TeamRecord | undefined,
  data: DirectorTournament,
  original: QbjObject | undefined,
): QbjObject {
  const playerRecord = team
    ? playerForTeam(team, player.playerId, data)
    : data.players.find((entry) => entry.id === player.playerId);
  const playerValue: QbjObject = playerRecord ? { $ref: playerRecord.id } : { name: player.playerId };
  return {
    ...(original ? mergeSourceAndExtensions(original, player.extensions) : {}),
    player: playerValue,
    ...(player.tossupsHeard !== undefined ? { tossups_heard: player.tossupsHeard } : {}),
    ...(player.answerCounts !== undefined ? { answer_counts: cloneJson(player.answerCounts) } : {}),
    ...(player.points !== undefined ? { points: player.points } : {}),
    ...(player.bonusesHeard !== undefined ? { bonuses_heard: player.bonusesHeard } : {}),
    ...(player.bonusPoints !== undefined ? { bonus_points: player.bonusPoints } : {}),
  };
}

function matchTeamObject(
  teamResult: GameTeamResult | undefined,
  teamId: string | null,
  team: TeamRecord | undefined,
  game: GameRecord,
  data: DirectorTournament,
  side: number,
  warnings: FormatWarning[],
): QbjObject {
  const sourceMatch = game.source;
  const sourceTeams = sourceMatch && Array.isArray(sourceMatch.match_teams) ? sourceMatch.match_teams : [];
  const original = isJsonObject(sourceTeams[side]) ? sourceTeams[side] : undefined;
  const originalPlayers =
    original && Array.isArray(original.match_players) ? original.match_players.filter(isJsonObject) : [];
  const players = (game.result?.players ?? []).filter((player) => player.teamId === teamId);
  const matchPlayers = players.map((player) => {
    const originalPlayer = originalPlayers.find((value) => {
      const raw = isJsonObject(value.player) ? value.player : undefined;
      return (
        raw?.$ref === player.playerId ||
        raw?.id === player.playerId ||
        raw?.name === data.players.find((entry) => entry.id === player.playerId)?.name
      );
    });
    return playerMatchObject(player, team, data, originalPlayer);
  });
  const source = teamResult
    ? mergeSourceAndExtensions(original, teamResult.extensions)
    : original
      ? cloneJson(original)
      : {};
  const result: QbjObject = {
    ...source,
    ...(teamId ? { team: { $ref: teamId } } : {}),
    ...(teamResult?.forfeitLoss !== undefined ? { forfeit_loss: teamResult.forfeitLoss } : {}),
    ...(teamResult?.points !== undefined ? { points: teamResult.points } : {}),
    ...(teamResult?.bonusBouncebackPoints !== undefined
      ? { bonus_bounceback_points: teamResult.bonusBouncebackPoints }
      : {}),
    ...(teamResult?.lightningPoints !== undefined ? { lightning_points: teamResult.lightningPoints } : {}),
    ...(teamResult?.correctTossupsWithoutBonuses !== undefined
      ? { correct_tossups_without_bonuses: teamResult.correctTossupsWithoutBonuses }
      : {}),
    ...(teamResult?.bonusesHeard !== undefined ? { bonuses_heard: teamResult.bonusesHeard } : {}),
    ...(teamResult?.bonusPoints !== undefined ? { bonus_points: teamResult.bonusPoints } : {}),
    ...(game.result && players.length > 0 ? { match_players: matchPlayers } : {}),
  };
  if (teamResult?.answerCounts !== undefined && result.match_players === undefined) {
    warnings.push(
      warning(
        'team-answer-counts-not-standard',
        `games.${game.id}.result.teams.${side}`,
        'A team-level answerCounts value has no direct QBJ aggregate field; it was retained in the source extension.',
      ),
    );
  }
  if (teamResult?.extensions?.YfData !== undefined) result.YfData = cloneJson(teamResult.extensions.YfData);
  return result;
}

function matchObject(game: GameRecord, data: DirectorTournament, warnings: FormatWarning[]): QbjObject {
  const source = baseFor(game, 'Match');
  const teamResults = game.result?.teams ?? [];
  const teams = game.teamIds.map((teamId, side) =>
    matchTeamObject(
      teamResults.find((result) => result.teamId === teamId),
      teamId,
      teamId ? data.teams.find((team) => team.id === teamId) : undefined,
      game,
      data,
      side,
      warnings,
    ),
  );
  const result = game.result;
  const room = game.roomId ? data.rooms.find((entry) => entry.id === game.roomId) : undefined;
  const match: QbjObject = {
    ...source,
    type: 'Match',
    id: game.id,
    match_teams: teams,
    ...(room?.name ? { location: room.name } : {}),
    ...(result?.tossupsRead !== undefined ? { tossups_read: result.tossupsRead } : {}),
    ...(result?.overtimeTossupsRead !== undefined
      ? { overtime_tossups_read: result.overtimeTossupsRead }
      : {}),
    ...(result?.questions !== undefined ? { match_questions: cloneJson(result.questions) } : {}),
    ...(result?.notes !== undefined ? { notes: result.notes } : {}),
    ...(result?.moderator !== undefined ? { moderator: result.moderator } : {}),
    ...(result?.scorekeeper !== undefined ? { scorekeeper: result.scorekeeper } : {}),
  };
  if (!result) {
    delete match.tossups_read;
    delete match.overtime_tossups_read;
    delete match.match_questions;
  }
  return match;
}

function roundObject(
  round: RoundRecord,
  games: readonly GameRecord[],
  packets: readonly PacketRecord[],
): QbjObject {
  const matchIds = games.filter((game) => game.roundId === round.id).map((game) => game.id);
  const packetIds =
    round.packetIds ?? packets.filter((packet) => packet.roundId === round.id).map((packet) => packet.id);
  return {
    ...baseFor(round, 'Round'),
    type: 'Round',
    id: round.id,
    name: round.qbjName ?? (round.number !== undefined ? String(round.number) : round.name),
    ...(round.number !== undefined ? { number: round.number } : {}),
    ...(round.revision !== undefined ? { revision: round.revision } : {}),
    ...(round.status !== undefined ? { status: round.status } : {}),
    ...(packetIds.length > 0 ? { packets: packetIds.map((id) => ({ $ref: id })) } : {}),
    ...(matchIds.length > 0 ? { matches: matchIds.map((id) => ({ $ref: id })) } : {}),
  };
}

function phaseObject(phase: PhaseRecord, data: DirectorTournament, games: readonly GameRecord[]): QbjObject {
  const rounds = (
    phase.roundIds ?? data.rounds.filter((round) => round.phaseId === phase.id).map((round) => round.id)
  )
    .map((id) => data.rounds.find((round) => round.id === id))
    .filter((round): round is RoundRecord => Boolean(round))
    .map((round) => roundObject(round, games, data.packets));
  return {
    ...baseFor(phase, 'Phase'),
    type: 'Phase',
    id: phase.id,
    name: phase.name,
    ...(phase.kind !== undefined ? { kind: phase.kind } : {}),
    ...(phase.order !== undefined ? { order: phase.order } : {}),
    ...(rounds.length > 0 ? { rounds } : {}),
    ...(phase.poolIds && phase.poolIds.length > 0
      ? { pools: phase.poolIds.map((id) => ({ $ref: id })) }
      : {}),
    ...(phase.advancement ? { advancement: cloneJson(phase.advancement) } : {}),
    ...(phase.carryovers ? { carryovers: cloneJson(phase.carryovers) } : {}),
  };
}

function buildQbjDocument(
  data: DirectorTournament,
  options: QbjExportOptions,
  warnings: FormatWarning[],
): QbjDocument {
  const mode = options.mode ?? 'tournament';
  const requestedGames = options.gameIds
    ? data.games.filter((game) => options.gameIds?.includes(game.id))
    : data.games;
  const games =
    options.includeUnplayed === false
      ? requestedGames.filter((game) => Boolean(game.result))
      : requestedGames;
  const gameTeamIds = teamIdsInGames(games);
  const requestedTeams = options.teamIds
    ? data.teams.filter((team) => options.teamIds?.includes(team.id))
    : data.teams;
  const teams =
    mode === 'teams'
      ? requestedTeams
      : requestedTeams.filter((team) => mode === 'tournament' || gameTeamIds.has(team.id));
  const organizations = data.organizations.filter((organization) =>
    teams.some((team) => team.organizationId === organization.id),
  );
  const registrations = data.registrations.filter((registration) =>
    teams.some((team) => team.id === registration.teamId),
  );
  const effectiveRegistrations = teams.map(
    (team) =>
      registrations.find((registration) => registration.teamId === team.id) ?? {
        id: slugId('registration', team.id),
        teamId: team.id,
      },
  );
  const rules = data.rules
    ? {
        ...cloneJson(data.rules),
        type: data.rules.type ?? 'ScoringRules',
        id: data.rules.id ?? 'ScoringRules_Director',
      }
    : undefined;
  if (rules) preserveUnknownFields(rules, rulesKeys, 'rules', warnings);
  if (!rules && mode !== 'teams')
    warnings.push(
      warning(
        'missing-scoring-rules',
        'rules',
        'No ScoringRules object was available; the exported QBJ retains that omission.',
      ),
    );
  const gameObjects = mode === 'teams' ? [] : games.map((game) => matchObject(game, data, warnings));
  const phaseData = mode === 'tournament' || mode === 'games' || mode === 'results' ? data.phases : [];
  const phaseObjects = phaseData.map((phase) => phaseObject(phase, data, games));
  const tournamentObject: QbjObject = {
    ...baseFor(data.tournament, 'Tournament'),
    ...(data.qbj?.extensions ? cloneJson(data.qbj.extensions) : {}),
    type: 'Tournament',
    id: data.tournament.id,
    name: data.tournament.name,
    ...(rules ? { scoring_rules: { $ref: rules.id as string } } : {}),
    ...(effectiveRegistrations.length > 0
      ? { registrations: effectiveRegistrations.map((registration) => ({ $ref: registration.id })) }
      : {}),
    ...(phaseObjects.length > 0 ? { phases: phaseObjects } : {}),
    ...(data.tournament.organizationId ? { organization: { $ref: data.tournament.organizationId } } : {}),
    ...(data.tournament.date !== undefined ? { date: data.tournament.date } : {}),
    ...(data.tournament.endDate !== undefined ? { endDate: data.tournament.endDate } : {}),
    ...(data.tournament.location !== undefined ? { location: data.tournament.location } : {}),
    ...(data.tournament.questionSet !== undefined ? { questionSet: data.tournament.questionSet } : {}),
    ...(data.tournament.notes !== undefined ? { notes: data.tournament.notes } : {}),
  };
  const unknownObjects = data.qbj?.unknownObjects ?? [];
  const knownIds = new Set<string>();
  const objects: QbjObject[] = [
    tournamentObject,
    ...(rules ? [rules] : []),
    ...organizations.map(organizationObject),
    ...effectiveRegistrations.map((registration) => registrationObject(registration, registration.teamId)),
    ...teams.map((team) => teamObject(team, data)),
    ...data.packets
      .filter((packet) => games.some((game) => game.packetId === packet.id) || phaseObjects.length > 0)
      .map(packetObject),
    ...gameObjects,
  ];
  objects.forEach((object) => {
    if (typeof object.id === 'string') knownIds.add(object.id);
  });
  unknownObjects.forEach((object, index) => {
    const id = asString(object.id);
    if (id && knownIds.has(id)) {
      warnings.push(
        warning(
          'duplicate-preserved-object',
          `qbj.unknownObjects[${index}]`,
          `Preserved QBJ object ${id} conflicts with a normalized object; it was retained without changing the normalized object.`,
        ),
      );
    }
    objects.push(cloneJson(object));
  });
  return { version: qbjSerializationVersion, objects };
}

export function exportQbjDocumentReport(
  input: DirectorTournamentInput | DirectorTournament,
  options: QbjExportOptions = {},
): FormatReport<QbjDocument> {
  const normalized = normalizeTournamentData(input);
  if (!normalized.ok) return normalized;
  const warnings = [...normalized.warnings];
  const value = buildQbjDocument(normalized.value, options, warnings);
  return ok(value, warnings);
}

export function exportQbjDocument(
  input: DirectorTournamentInput | DirectorTournament,
  options: QbjExportOptions = {},
): QbjDocument {
  const report = exportQbjDocumentReport(input, options);
  if (!report.ok) throw new Error(report.errors.map((entry) => entry.message).join(' '));
  return report.value;
}

export function serializeQbjDocument(document: QbjDocument, pretty = true): string {
  const wire: JsonObject = {
    ...(document.extensions ? cloneJson(document.extensions) : {}),
    version: document.version,
    objects: cloneJson(document.objects),
  };
  return `${JSON.stringify(wire, null, pretty ? 2 : 0)}\n`;
}

export function exportQbjText(
  input: DirectorTournamentInput | DirectorTournament,
  options: QbjExportOptions = {},
): string {
  return serializeQbjDocument(exportQbjDocument(input, options));
}

export function exportQbjTextReport(
  input: DirectorTournamentInput | DirectorTournament,
  options: QbjExportOptions = {},
): FormatReport<string> {
  const report = exportQbjDocumentReport(input, options);
  return report.ok ? ok(serializeQbjDocument(report.value), report.warnings) : report;
}

export function exportTeamsToQbj(
  input: readonly TeamRecord[] | DirectorTournamentInput | DirectorTournament,
): QbjDocument {
  if (Array.isArray(input)) {
    const players = input.flatMap((team) => team.players ?? []);
    const data = createTournamentData(
      { id: 'tournament_teams_export', name: 'Team roster export' },
      { teams: input.slice(), players },
    );
    return exportQbjDocument(data, { mode: 'teams' });
  }
  return exportQbjDocument(input as DirectorTournamentInput | DirectorTournament, { mode: 'teams' });
}

export function exportGameToQbj(
  game: GameRecord,
  data: DirectorTournamentInput | DirectorTournament,
): QbjDocument {
  const normalized = normalizeTournamentData(data);
  if (!normalized.ok) throw new Error(normalized.errors.map((entry) => entry.message).join(' '));
  const scoped = {
    ...normalized.value,
    games: [game],
    scheduledGames: normalized.value.scheduledGames.filter(
      (scheduled) => scheduled.id === game.scheduledGameId || scheduled.id === game.id,
    ),
  };
  return exportQbjDocument(scoped, { mode: game.result ? 'results' : 'games', gameIds: [game.id] });
}

export const exportResultToQbj = exportGameToQbj;
export const exportTournamentToQbj = exportQbjDocument;
export const importQbjTournament = (input: QbjInput): FormatReport<DirectorTournament> => {
  const report = importQbj(input);
  return report.ok ? ok(report.value.tournament, report.warnings) : report;
};
export const importQbjTeams = (input: QbjInput): FormatReport<TeamRecord[]> => {
  const report = importQbj(input);
  return report.ok ? ok(report.value.tournament.teams, report.warnings) : report;
};
export const importQbjGames = (input: QbjInput): FormatReport<GameRecord[]> => {
  const report = importQbj(input);
  return report.ok ? ok(report.value.tournament.games, report.warnings) : report;
};
export const importQbjResults = (input: QbjInput): FormatReport<GameRecord[]> => {
  const report = importQbj(input);
  return report.ok
    ? ok(
        report.value.tournament.games.filter((game) => Boolean(game.result)),
        report.warnings,
      )
    : report;
};
