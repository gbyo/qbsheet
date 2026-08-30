/**
 * The one-game spreadsheet/clipboard representation.
 *
 * This is deliberately a scoring-layer module rather than a React component. The ordered event
 * history is the canonical game, and this format is a human-readable envelope around that history,
 * the setup that gives it meaning, and the rules/procedure it was scored under.
 *
 * The cells are plain TSV. User-controlled strings are prefixed and escaped so a spreadsheet cannot
 * mistake a name, note, or identifier for a formula, a number, a date, or a delimiter. Numbers and
 * booleans stay in their ordinary textual forms and are interpreted by the named table columns.
 */
import {
  GameDefinitionOrigin,
  IQbjIdentity,
} from '../game/GameDefinition';
import { IGamePackage, IGamePackageTeam } from '../game/GamePackage';
import { validateGamePackage } from '../game/GamePackageValidation';
import deriveGame, { IGameSetup, IDerivedGame, ITeamSetup } from './deriveGame';
import {
  IScorekeeperAnswerType,
  IScorekeeperFormat,
  scorekeeperFormatProblems,
} from './ScorekeeperFormat';
import {
  IRoomBreak,
  IRoomProcedure,
  isKnownRoomProcedureVersion,
  readableRoomProcedureVersions,
} from './RoomProcedure';
import { ScoreEvent } from './ScoreEvents';
import { IQbjMatchMeta } from './toQbjMatch';

export const spreadsheetGameMarker = 'QBSHEET_GAME';
export const spreadsheetEndMarker = 'QBSHEET_END';
export const spreadsheetGameEndMarker = spreadsheetEndMarker;
export const spreadsheetSectionMarker = 'SECTION';
export const spreadsheetSchemaVersion = 1;
export const spreadsheetGameSchemaVersion = spreadsheetSchemaVersion;

/** A visible prefix is intentional: it survives spreadsheet round-trips and is easy to diagnose. */
export const spreadsheetTextPrefix = 'QBSHEET_TEXT:';
export const spreadsheetJsonPrefix = 'QBSHEET_JSON:';

export const spreadsheetOccupiedWarning =
  '⚠ THIS TAB IS OCCUPIED — ONE QBSHEET GAME PER TAB — DO NOT PASTE ANOTHER GAME HERE';
export const spreadsheetNewTabWarning = 'If you are trying to paste a different game, create a NEW BLANK TAB first.';

/**
 * A package plus the definition-only facts that are not part of `IGamePackage`'s internal shape.
 * They are optional because old/manual records do not have provenance or QBJ identities.
 */
export interface ISpreadsheetGamePackage extends IGamePackage {
  qbjIdentity?: IQbjIdentity;
  origin?: GameDefinitionOrigin;
  assumptions?: string[];
}

/** Safe operational metadata. Credentials, session keys, and the final QBJ are intentionally absent. */
export interface ISpreadsheetGameMetadata {
  recordIdentity?: string;
  attempt?: number;
  connected?: boolean;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  scorekeeper?: string;
  moderator?: string;
  notes?: string;
  qbjMatchMeta?: IQbjMatchMeta;
  serverDelivery?: 'none' | 'pending' | 'sent' | 'rejected';
  serverDeliveryDetail?: string;
  serverDeliveryLedger?: unknown;
  qbjDownloadedAt?: string;
  handoffAcknowledgedAt?: string;
}

export interface ISpreadsheetGameSnapshot {
  /** Durable identity; it is never inferred from a tab name or a display label. */
  gameId: string;
  package: ISpreadsheetGamePackage;
  setup: IGameSetup;
  events: ScoreEvent[];
  metadata?: ISpreadsheetGameMetadata;
}

export interface CreateSpreadsheetGameSnapshotInput
  extends Omit<ISpreadsheetGameSnapshot, 'gameId' | 'package' | 'events' | 'metadata'> {
  package: ISpreadsheetGamePackage;
  events: ScoreEvent[];
  gameId?: string;
  metadata?: ISpreadsheetGameMetadata;
}

export interface ISpreadsheetParseError {
  code: string;
  message: string;
  section?: string;
  row?: number;
  column?: string;
}

export type SpreadsheetParseResult =
  | { ok: true; value: ISpreadsheetGameSnapshot }
  | { ok: false; errors: ISpreadsheetParseError[] };

export interface ISpreadsheetSerialization {
  grid: string[][];
  tsv: string;
}

/** The exact event columns. Adding a union member without adding its fields fails at compile time. */
const eventPropertyKeys = {
  'tossup-buzz': ['team', 'playerName', 'answerTypeIndex'],
  'tossup-no-penalty': ['team', 'playerName'],
  'tossup-reading-resumed': [],
  'tossup-readout': [],
  'tossup-dead': [],
  bonus: ['team', 'parts', 'controlledPoints', 'bouncebackPoints'],
  lightning: ['team', 'points'],
  substitution: ['team', 'activePlayers'],
  'roster-add': ['team', 'playerName'],
  'end-regulation': ['lastRegulationQuestion'],
  'half-break': ['lastQuestion'],
  'half-resume': [],
  'begin-overtime': [],
  'begin-sudden-death': [],
  timeout: ['team'],
  'timeout-start': ['team', 'startedAt'],
  'timeout-resume': [],
  protest: ['team', 'subject', 'description', 'status', 'resolution'],
  'question-void': ['scope', 'reason'],
  'end-game-early': ['reason', 'tossupsRead'],
  adjustment: ['team', 'points', 'reason'],
  forfeit: ['teams'],
  note: ['text', 'flagged'],
} satisfies Record<ScoreEvent['type'], readonly string[]>;

const eventColumns = [
  'order',
  'event_id',
  'question_number',
  'type',
  'team',
  'player_name',
  'answer_type_index',
  'points',
  'controlled_points',
  'bounceback_points',
  'parts',
  'active_players',
  'last_regulation_question',
  'last_question',
  'subject',
  'description',
  'status',
  'resolution',
  'scope',
  'reason',
  'tossups_read',
  'text',
  'flagged',
  'teams',
  'started_at',
  'extras',
] as const;

const spreadsheetGridWidth = eventColumns.length;

export const spreadsheetEventColumns = eventColumns;
export const spreadsheetGameSections = ['GAME', 'RECORD', 'TEAMS', 'PLAYERS', 'SCORING_RULES', 'PROCEDURE', 'EVENTS'] as const;

const origins: readonly GameDefinitionOrigin[] = [
  'qbj',
  'qbj-match-only',
  'qbg',
  'legacy-assignment',
  'manual',
];

const serverDeliveries = ['none', 'pending', 'sent', 'rejected'] as const;

const gameKeys = [
  'game_id',
  'package_format',
  'package_version',
  'producer',
  'tournament_key',
  'tournament_name',
  'scheduled_match_id',
  'round_number',
  'round_name',
  'round_revision',
  'packet_name',
  'room_id',
  'room_name',
  'handoff_instruction',
  'definition_origin',
  'assumptions',
  'qbj_identity',
  'procedure_present',
] as const;

const recordKeys = [
  'record_identity',
  'attempt',
  'connected',
  'created_at',
  'updated_at',
  'completed_at',
  'scorekeeper',
  'moderator',
  'notes',
  'qbj_match_meta',
  'server_delivery',
  'server_delivery_detail',
  'server_delivery_ledger',
  'qbj_downloaded_at',
  'handoff_acknowledged_at',
] as const;

const formatKeys = [
  'version',
  'name',
  'regulation.timed',
  'regulation.tossupCount',
  'regulation.maximumTossupCount',
  'bonus.enabled',
  'bonus.bounceBack',
  'bonus.regular',
  'bonus.divisor',
  'bonus.minimumParts',
  'bonus.maximumParts',
  'bonus.pointsPerPart',
  'bonus.maximumScore',
  'overtime.minimumQuestionCount',
  'overtime.suddenDeath',
  'overtime.includesBonuses',
  'lightning.enabled',
  'lightning.countPerTeam',
  'lightning.divisor',
  'players.maximumActive',
  'totalDivisor',
] as const;

const procedureKeys = [
  'present',
  'version',
  'halves',
  'halfLengthMinutes',
  'timeoutsPerTeam',
  'timeoutDurationSeconds',
  'protestCheckpoints',
  'substitutionPolicy',
] as const;

const answerTypeColumns = ['index', 'value', 'label', 'short_label', 'is_power', 'is_neg', 'awards_bonus', 'qbj_id'] as const;

const teamColumns = ['side', 'package_name', 'setup_name', 'package_starting_lineup', 'setup_starting_lineup'] as const;
const playerColumns = ['side', 'source', 'order', 'player_name'] as const;
const breakColumns = ['after_tossup', 'label'] as const;

function assertNever(value: never): never {
  throw new Error(`Unhandled spreadsheet value: ${String(value)}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(stableJsonValue(value));
  if (encoded === undefined) throw new Error('A spreadsheet JSON value could not be encoded.');
  return encoded;
}

/** Stable JSON and cell aliases kept discoverable for future importers and tests. */
export const stableSpreadsheetJson = stableJson;

/** Every string cell starts with this prefix, including ordinary names, so formula safety is structural. */
export function encodeSpreadsheetText(value: string): string {
  return `${spreadsheetTextPrefix}${JSON.stringify(value)}`;
}

export const encodeSpreadsheetCell = encodeSpreadsheetText;

function encodeOptionalText(value: string | undefined): string {
  return value === undefined ? '' : encodeSpreadsheetText(value);
}

function encodeOptionalJson(value: unknown): string {
  return value === undefined ? '' : `${spreadsheetJsonPrefix}${stableJson(value)}`;
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('A spreadsheet number must be finite.');
  return String(value);
}

function encodeOptionalNumber(value: number | undefined): string {
  return value === undefined ? '' : encodeNumber(value);
}

function encodeBoolean(value: boolean): string {
  return value ? 'true' : 'false';
}

function encodeOptionalBoolean(value: boolean | undefined): string {
  return value === undefined ? '' : encodeBoolean(value);
}

function trimTrailingCells(row: readonly string[]): string[] {
  const trimmed = [...row];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

function tsvFromGrid(grid: readonly (readonly string[])[]): string {
  return grid
    .map((row) =>
      row
        .map((cell) => {
          if (/[\t\r\n]/.test(cell)) throw new Error('A spreadsheet cell contains an unescaped delimiter.');
          return cell;
        })
        .join('\t'),
    )
    .join('\n');
}

function sectionMarker(name: string, gameId: string): string[] {
  return [spreadsheetSectionMarker, name, String(spreadsheetSchemaVersion), encodeSpreadsheetText(gameId)];
}

function pushKeyValueSection(grid: string[][], values: readonly (readonly [string, string])[]): void {
  grid.push(['key', 'value']);
  for (const [key, value] of values) grid.push([key, value]);
}

function packagePlayerNames(team: IGamePackageTeam): string[] {
  return team.players.map((player) => player.name);
}

/** Validate the canonical package/setup/event history and return QBSheet's derived game. */
export function deriveSpreadsheetGame(snapshot: ISpreadsheetGameSnapshot): IDerivedGame {
  if (typeof snapshot.gameId !== 'string' || snapshot.gameId.trim() === '')
    throw new Error('A spreadsheet game needs a durable game ID.');
  const packageProblems = validateGamePackage(snapshot.package);
  if (!packageProblems.ok) throw new Error(packageProblems.errors.join(' '));
  const formatProblems = scorekeeperFormatProblems(snapshot.package.scorekeeperFormat);
  if (formatProblems.length > 0) throw new Error(formatProblems.join(' '));
  for (const side of ['left', 'right'] as const) {
    if (snapshot.setup[side].name !== snapshot.package[side].name)
      throw new Error(`The ${side} setup and package team names do not agree.`);
  }
  return deriveGame(snapshot.package.scorekeeperFormat, snapshot.setup, snapshot.events);
}

function displaySummary(snapshot: ISpreadsheetGameSnapshot): string {
  const game = deriveSpreadsheetGame(snapshot);
  return `${snapshot.package.round.name} · ${snapshot.package.left.name} ${game.left.points}–${game.right.points} ${snapshot.package.right.name}`;
}

function suggestedTabName(snapshot: ISpreadsheetGameSnapshot): string {
  const game = deriveSpreadsheetGame(snapshot);
  const round = snapshot.package.round.number > 0 ? `R${String(snapshot.package.round.number).padStart(2, '0')}` : 'Game';
  return `${round} ${snapshot.package.left.name}–${snapshot.package.right.name} ${game.left.points}-${game.right.points}`;
}

function gameSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  const packageValue = snapshot.package;
  const qbjIdentity = packageValue.qbjIdentity;
  grid.push(sectionMarker('GAME', snapshot.gameId));
  pushKeyValueSection(grid, [
    ['game_id', encodeSpreadsheetText(snapshot.gameId)],
    ['package_format', encodeSpreadsheetText(packageValue.format)],
    ['package_version', encodeNumber(packageValue.version)],
    ['producer', encodeOptionalText(packageValue.producer)],
    ['tournament_key', encodeOptionalText(packageValue.tournament.key)],
    ['tournament_name', encodeSpreadsheetText(packageValue.tournament.name)],
    ['scheduled_match_id', encodeOptionalText(packageValue.scheduledMatchId)],
    ['round_number', encodeNumber(packageValue.round.number)],
    ['round_name', encodeSpreadsheetText(packageValue.round.name)],
    ['round_revision', encodeNumber(packageValue.round.revision)],
    ['packet_name', encodeOptionalText(packageValue.round.packetName)],
    ['room_id', encodeOptionalText(packageValue.room?.id)],
    ['room_name', encodeOptionalText(packageValue.room?.name)],
    ['handoff_instruction', encodeOptionalText(packageValue.handoffInstruction)],
    ['definition_origin', encodeOptionalText(packageValue.origin)],
    ['assumptions', encodeOptionalJson(packageValue.assumptions)],
    ['qbj_identity', encodeOptionalJson(qbjIdentity)],
    ['procedure_present', encodeBoolean(packageValue.procedure !== undefined)],
  ]);
  grid.push([]);
}

function recordSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  const metadata = snapshot.metadata ?? {};
  grid.push(sectionMarker('RECORD', snapshot.gameId));
  pushKeyValueSection(grid, [
    ['record_identity', encodeOptionalText(metadata.recordIdentity)],
    ['attempt', encodeOptionalNumber(metadata.attempt)],
    ['connected', encodeOptionalBoolean(metadata.connected)],
    ['created_at', encodeOptionalText(metadata.createdAt)],
    ['updated_at', encodeOptionalText(metadata.updatedAt)],
    ['completed_at', encodeOptionalText(metadata.completedAt)],
    ['scorekeeper', encodeOptionalText(metadata.scorekeeper)],
    ['moderator', encodeOptionalText(metadata.moderator)],
    ['notes', encodeOptionalText(metadata.notes)],
    ['qbj_match_meta', encodeOptionalJson(metadata.qbjMatchMeta)],
    ['server_delivery', encodeOptionalText(metadata.serverDelivery)],
    ['server_delivery_detail', encodeOptionalText(metadata.serverDeliveryDetail)],
    ['server_delivery_ledger', encodeOptionalJson(metadata.serverDeliveryLedger)],
    ['qbj_downloaded_at', encodeOptionalText(metadata.qbjDownloadedAt)],
    ['handoff_acknowledged_at', encodeOptionalText(metadata.handoffAcknowledgedAt)],
  ]);
  grid.push([]);
}

function teamsSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  grid.push(sectionMarker('TEAMS', snapshot.gameId));
  grid.push([...teamColumns]);
  for (const side of ['left', 'right'] as const) {
    const packageTeam = snapshot.package[side];
    const setupTeam = snapshot.setup[side];
    grid.push([
      side,
      encodeSpreadsheetText(packageTeam.name),
      encodeSpreadsheetText(setupTeam.name),
      encodeOptionalJson(packageTeam.startingLineup),
      encodeOptionalJson(setupTeam.startingLineup),
    ]);
  }
  grid.push([]);
}

function playersSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  grid.push(sectionMarker('PLAYERS', snapshot.gameId));
  grid.push([...playerColumns]);
  for (const side of ['left', 'right'] as const) {
    const packagePlayers = packagePlayerNames(snapshot.package[side]);
    const setupPlayers = snapshot.setup[side].players;
    packagePlayers.forEach((name, index) => grid.push([side, 'package', String(index + 1), encodeSpreadsheetText(name)]));
    setupPlayers.forEach((name, index) => grid.push([side, 'setup', String(index + 1), encodeSpreadsheetText(name)]));
  }
  grid.push([]);
}

function scoringRulesSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  const format = snapshot.package.scorekeeperFormat;
  grid.push(sectionMarker('SCORING_RULES', snapshot.gameId));
  pushKeyValueSection(grid, [
    ['version', encodeNumber(format.version)],
    ['name', encodeSpreadsheetText(format.name)],
    ['regulation.timed', encodeBoolean(format.regulation.timed)],
    ['regulation.tossupCount', encodeNumber(format.regulation.tossupCount)],
    ['regulation.maximumTossupCount', encodeNumber(format.regulation.maximumTossupCount)],
    ['bonus.enabled', encodeBoolean(format.bonus.enabled)],
    ['bonus.bounceBack', encodeBoolean(format.bonus.bounceBack)],
    ['bonus.regular', encodeBoolean(format.bonus.regular)],
    ['bonus.divisor', encodeNumber(format.bonus.divisor)],
    ['bonus.minimumParts', encodeNumber(format.bonus.minimumParts)],
    ['bonus.maximumParts', encodeNumber(format.bonus.maximumParts)],
    ['bonus.pointsPerPart', encodeOptionalNumber(format.bonus.pointsPerPart)],
    ['bonus.maximumScore', encodeNumber(format.bonus.maximumScore)],
    ['overtime.minimumQuestionCount', encodeNumber(format.overtime.minimumQuestionCount)],
    ['overtime.suddenDeath', encodeBoolean(format.overtime.suddenDeath)],
    ['overtime.includesBonuses', encodeBoolean(format.overtime.includesBonuses)],
    ['lightning.enabled', encodeBoolean(format.lightning.enabled)],
    ['lightning.countPerTeam', encodeNumber(format.lightning.countPerTeam)],
    ['lightning.divisor', encodeNumber(format.lightning.divisor)],
    ['players.maximumActive', encodeNumber(format.players.maximumActive)],
    ['totalDivisor', encodeNumber(format.totalDivisor)],
  ]);
  grid.push([]);
  grid.push(['ANSWER_TYPES']);
  grid.push([...answerTypeColumns]);
  for (const answerType of format.answerTypes) {
    grid.push([
      encodeNumber(answerType.index),
      encodeNumber(answerType.value),
      encodeSpreadsheetText(answerType.label),
      encodeSpreadsheetText(answerType.shortLabel),
      encodeBoolean(answerType.isPower),
      encodeBoolean(answerType.isNeg),
      encodeBoolean(answerType.awardsBonus),
      encodeSpreadsheetText(answerType.qbjId),
    ]);
  }
  grid.push([]);
}

function procedureSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  const procedure = snapshot.package.procedure;
  grid.push(sectionMarker('PROCEDURE', snapshot.gameId));
  pushKeyValueSection(grid, [
    ['present', encodeBoolean(procedure !== undefined)],
    ['version', encodeOptionalNumber(procedure?.version)],
    ['halves', procedure ? encodeBoolean(procedure.halves) : ''],
    ['halfLengthMinutes', encodeOptionalNumber(procedure?.halfLengthMinutes)],
    ['timeoutsPerTeam', encodeOptionalNumber(procedure?.timeoutsPerTeam)],
    ['timeoutDurationSeconds', encodeOptionalNumber(procedure?.timeoutDurationSeconds)],
    ['protestCheckpoints', encodeOptionalText(procedure?.protestCheckpoints)],
    ['substitutionPolicy', encodeOptionalText(procedure?.substitutionPolicy)],
  ]);
  grid.push([]);
  grid.push(['BREAKS']);
  grid.push([...breakColumns]);
  for (const roomBreak of procedure?.breaks ?? []) {
    grid.push([encodeNumber(roomBreak.afterTossup), encodeOptionalText(roomBreak.label)]);
  }
  grid.push([]);
}

function eventExtras(event: ScoreEvent): Record<string, unknown> {
  const known = new Set<string>(['id', 'type', 'questionNumber', ...eventPropertyKeys[event.type]]);
  const raw = event as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.keys(raw).filter((key) => !known.has(key)).sort().map((key) => [key, raw[key]]));
}

function eventCell(event: ScoreEvent, column: (typeof eventColumns)[number]): string {
  const raw = event as unknown as Record<string, unknown>;
  switch (column) {
    case 'order':
      return '';
    case 'event_id':
      return encodeSpreadsheetText(event.id);
    case 'question_number':
      return encodeNumber(event.questionNumber);
    case 'type':
      return event.type;
    case 'team':
    case 'subject':
    case 'status':
    case 'scope':
      return raw[column === 'team' ? 'team' : column] === undefined
        ? ''
        : String(raw[column === 'team' ? 'team' : column]);
    case 'player_name':
    case 'description':
    case 'resolution':
    case 'reason':
    case 'text':
      return encodeOptionalText(raw[column === 'player_name' ? 'playerName' : column] as string | undefined);
    case 'answer_type_index':
    case 'points':
    case 'controlled_points':
    case 'bounceback_points':
    case 'last_regulation_question':
    case 'last_question':
    case 'tossups_read':
    case 'started_at':
      return encodeOptionalNumber(
        raw[
          ({
            answer_type_index: 'answerTypeIndex',
            controlled_points: 'controlledPoints',
            bounceback_points: 'bouncebackPoints',
            last_regulation_question: 'lastRegulationQuestion',
            last_question: 'lastQuestion',
            tossups_read: 'tossupsRead',
            started_at: 'startedAt',
            points: 'points',
          } as Record<string, string>)[column]
        ] as number | undefined,
      );
    case 'parts':
      return encodeOptionalJson(raw.parts);
    case 'active_players':
      return encodeOptionalJson(raw.activePlayers);
    case 'flagged':
      return encodeOptionalBoolean(raw.flagged as boolean | undefined);
    case 'teams':
      return encodeOptionalJson(raw.teams);
    case 'extras': {
      const extras = eventExtras(event);
      return Object.keys(extras).length === 0 ? '' : encodeOptionalJson(extras);
    }
    default:
      return assertNever(column);
  }
}

function eventsSection(snapshot: ISpreadsheetGameSnapshot, grid: string[][]): void {
  grid.push(sectionMarker('EVENTS', snapshot.gameId));
  grid.push([...eventColumns]);
  snapshot.events.forEach((event, index) => {
    grid.push(eventColumns.map((column) => (column === 'order' ? String(index + 1) : eventCell(event, column))));
  });
  grid.push([]);
}

/** Build the canonical rectangular grid. No current timestamp is introduced here. */
export function buildSpreadsheetGameGrid(snapshot: ISpreadsheetGameSnapshot): string[][] {
  deriveSpreadsheetGame(snapshot);
  const grid: string[][] = [
    [spreadsheetGameMarker, String(spreadsheetSchemaVersion), encodeSpreadsheetText(snapshot.gameId)],
    [spreadsheetOccupiedWarning],
    [spreadsheetNewTabWarning],
    ['GAME', encodeSpreadsheetText(displaySummary(snapshot))],
    ['SUGGESTED TAB NAME', encodeSpreadsheetText(suggestedTabName(snapshot))],
    ['WORKFLOW', encodeSpreadsheetText('Create a NEW BLANK TAB, click A1, and paste. Never paste into an occupied QBSheet tab.')],
    [],
  ];
  gameSection(snapshot, grid);
  recordSection(snapshot, grid);
  teamsSection(snapshot, grid);
  playersSection(snapshot, grid);
  scoringRulesSection(snapshot, grid);
  procedureSection(snapshot, grid);
  eventsSection(snapshot, grid);
  grid.push([spreadsheetEndMarker, String(spreadsheetSchemaVersion), encodeSpreadsheetText(snapshot.gameId), String(snapshot.events.length)]);
  return grid.map((row) => [...row, ...Array.from({ length: spreadsheetGridWidth - row.length }, () => '')]);
}

export function serializeSpreadsheetGame(snapshot: ISpreadsheetGameSnapshot): string {
  return tsvFromGrid(buildSpreadsheetGameGrid(snapshot));
}

export function serializeSpreadsheetGameWithGrid(snapshot: ISpreadsheetGameSnapshot): ISpreadsheetSerialization {
  const grid = buildSpreadsheetGameGrid(snapshot);
  return { grid, tsv: tsvFromGrid(grid) };
}

/** Use the strongest identity available, with the record's local identity as the manual-game fallback. */
export function spreadsheetGameId(packageValue: ISpreadsheetGamePackage, localIdentity?: string): string {
  const qbjMatchId = packageValue.qbjIdentity?.matchId;
  if (qbjMatchId) return `match:${qbjMatchId}`;
  if (packageValue.scheduledMatchId) return `match:${packageValue.scheduledMatchId}`;
  if (localIdentity?.trim()) return localIdentity;
  throw new Error('A spreadsheet game needs an existing stable local identity when it has no assignment ID.');
}

export const spreadsheetGameIdentity = spreadsheetGameId;
export const stableSpreadsheetGameIdentity = spreadsheetGameId;

/** Build the export snapshot from the durable package, current setup, and canonical event log. */
export function createSpreadsheetGameSnapshot(
  input: CreateSpreadsheetGameSnapshotInput,
): ISpreadsheetGameSnapshot {
  return {
    gameId: spreadsheetGameId(input.package, input.gameId),
    package: input.package,
    setup: input.setup,
    events: input.events.slice(),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

/** Descriptive alias for callers building a game export from the current scorer state. */
export const buildSpreadsheetGameSnapshot = createSpreadsheetGameSnapshot;

function parseGrid(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.split('\t'));
}

class SpreadsheetDataError extends Error {
  constructor(public readonly detail: ISpreadsheetParseError) {
    super(detail.message);
  }
}

function dataError(
  code: string,
  message: string,
  context: { section?: string; row?: number; column?: string } = {},
): never {
  throw new SpreadsheetDataError({ code, message, ...context });
}

function decodeText(cell: string, context: { section?: string; row?: number; column?: string }): string {
  if (!cell.startsWith(spreadsheetTextPrefix))
    dataError('malformed-text', 'A canonical text cell is missing the QBSheet text prefix.', context);
  const payload = cell.slice(spreadsheetTextPrefix.length);
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== 'string') dataError('malformed-text', 'A text cell does not contain a string.', context);
    return value;
  } catch {
    dataError('malformed-text', 'A text cell has invalid escaped text.', context);
  }
}

function decodeOptionalText(cell: string, context: { section?: string; row?: number; column?: string }): string | undefined {
  return cell === '' ? undefined : decodeText(cell, context);
}

function decodeJson(cell: string, context: { section?: string; row?: number; column?: string }): unknown {
  if (!cell.startsWith(spreadsheetJsonPrefix)) {
    dataError('malformed-json', 'A JSON cell is missing the QBSheet JSON prefix.', context);
  }
  try {
    return JSON.parse(cell.slice(spreadsheetJsonPrefix.length));
  } catch {
    dataError('malformed-json', 'A JSON cell is not valid JSON.', context);
  }
}

function decodeOptionalJson(cell: string, context: { section?: string; row?: number; column?: string }): unknown {
  return cell === '' ? undefined : decodeJson(cell, context);
}

function decodeNumber(cell: string, context: { section?: string; row?: number; column?: string }): number {
  if (cell.trim() === '' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cell.trim())) {
    dataError('malformed-number', `Expected a finite number, got ${cell || 'blank'}.`, context);
  }
  const value = Number(cell);
  if (!Number.isFinite(value)) dataError('malformed-number', `Expected a finite number, got ${cell}.`, context);
  return value;
}

function decodeOptionalNumber(cell: string, context: { section?: string; row?: number; column?: string }): number | undefined {
  return cell.trim() === '' ? undefined : decodeNumber(cell, context);
}

function decodeBoolean(cell: string, context: { section?: string; row?: number; column?: string }): boolean {
  const normalized = cell.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  dataError('malformed-boolean', `Expected true or false, got ${cell || 'blank'}.`, context);
}

function decodeOptionalBoolean(cell: string, context: { section?: string; row?: number; column?: string }): boolean | undefined {
  return cell.trim() === '' ? undefined : decodeBoolean(cell, context);
}

function requiredCell(
  row: readonly string[],
  index: number,
  context: { section?: string; row?: number; column?: string },
): string {
  const value = row[index] ?? '';
  if (value === '') dataError('missing-cell', `The required ${context.column ?? 'value'} cell is blank.`, context);
  return value;
}

function valueAt(row: readonly string[], index: number): string {
  return row[index] ?? '';
}

function expectHeader(row: readonly string[], expected: readonly string[], section: string, rowNumber: number): void {
  const actual = trimTrailingCells(row);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    dataError(
      'malformed-header',
      `The ${section} section has an unexpected header.`,
      { section, row: rowNumber },
    );
  }
}

function expectRowWidth(row: readonly string[], expected: number, section: string, rowNumber: number): string[] {
  const actual = trimTrailingCells(row);
  if (actual.length > expected) {
    dataError('extra-cell', `The ${section} row has more cells than its header.`, { section, row: rowNumber });
  }
  return [...actual, ...Array.from({ length: expected - actual.length }, () => '')];
}

interface ParsedSection {
  name: string;
  rows: { row: string[]; rowNumber: number }[];
}

function scanSections(rows: string[][], gameId: string): { sections: Map<string, ParsedSection>; end: string[] } {
  const sections = new Map<string, ParsedSection>();
  let current: ParsedSection | undefined;
  let end: string[] | undefined;
  let seenSection = false;
  let previousSectionIndex = -1;
  const sectionOrder = ['GAME', 'RECORD', 'TEAMS', 'PLAYERS', 'SCORING_RULES', 'PROCEDURE', 'EVENTS'] as const;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 1;
    if (row.every((cell) => cell === '')) continue;
    if (row[0] === spreadsheetSectionMarker) {
      if (end) dataError('data-after-end', 'The spreadsheet has data after its end marker.', { row: rowNumber });
      const marker = trimTrailingCells(row);
      if (marker.length !== 4 || marker[1] === '' || marker[2] === '' || marker[3] === '')
        dataError('malformed-section-marker', 'A section marker is missing its name, version, or game ID.', { row: rowNumber });
      const sectionName = marker[1];
      const sectionIndex = sectionOrder.indexOf(sectionName as (typeof sectionOrder)[number]);
      if (sectionIndex < 0) dataError('unknown-section', `The ${sectionName} section is not supported.`, { row: rowNumber, section: sectionName });
      if (sections.has(sectionName))
        dataError('duplicate-section', `The ${sectionName} section appears more than once.`, { section: sectionName, row: rowNumber });
      if (sectionIndex <= previousSectionIndex)
        dataError('section-order', `The ${sectionName} section is duplicated or out of order.`, { row: rowNumber, section: sectionName });
      const version = decodeNumber(marker[2], { row: rowNumber, column: 'version' });
      if (version !== spreadsheetSchemaVersion)
        dataError('unsupported-version', `The ${sectionName} section is schema version ${version}; this build reads version ${spreadsheetSchemaVersion}.`, { row: rowNumber, section: sectionName, column: 'version' });
      const markerId = decodeText(marker[3], { row: rowNumber, column: 'game_id' });
      if (markerId !== gameId) {
        dataError(
          'section-game-id-mismatch',
          `The ${sectionName} section belongs to game ${markerId}, not ${gameId}.`,
          { section: sectionName, row: rowNumber, column: 'game_id' },
        );
      }
      previousSectionIndex = sectionIndex;
      current = { name: sectionName, rows: [] };
      sections.set(sectionName, current);
      seenSection = true;
      continue;
    }
    if (row[0] === spreadsheetEndMarker) {
      if (!current || !seenSection) dataError('end-before-sections', 'The end marker appears before the game sections.', { row: rowNumber });
      if (end) dataError('duplicate-end-marker', 'The spreadsheet has more than one end marker.', { row: rowNumber });
      end = row;
      current = undefined;
      continue;
    }
    if (!current) {
      // The first few rows are fixed human guidance. Once a section has started, stray data is
      // corruption; unknown preamble rows are rejected so a truncated/mixed paste is not accepted.
      if (seenSection) dataError('data-outside-section', 'Data appears outside a named section.', { row: rowNumber });
      if (
        ![
          'GAME',
          'SUGGESTED TAB NAME',
          'WORKFLOW',
          spreadsheetOccupiedWarning,
          spreadsheetNewTabWarning,
        ].includes(row[0])
      )
        dataError('data-before-section', 'Unexpected data appears before the first named section.', { row: rowNumber });
      continue;
    }
    current.rows.push({ row, rowNumber });
  }
  if (!end) dataError('missing-end-marker', 'The spreadsheet is missing its QBSHEET_END marker.');
  return { sections, end };
}

function sectionOrError(sections: Map<string, ParsedSection>, name: string): ParsedSection {
  const section = sections.get(name);
  if (!section) dataError('missing-section', `The ${name} section is missing.`, { section: name });
  return section;
}

function keyValueMap(section: ParsedSection, expectedKeys: readonly string[]): Map<string, string> {
  const rows = section.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  if (rows.length === 0) dataError('missing-header', `The ${section.name} section is empty.`, { section: section.name });
  expectHeader(rows[0].row, ['key', 'value'], section.name, rows[0].rowNumber);
  const expected = new Set(expectedKeys);
  const result = new Map<string, string>();
  for (const entry of rows.slice(1)) {
    const row = expectRowWidth(entry.row, 2, section.name, entry.rowNumber);
    const key = row[0];
    if (!expected.has(key)) dataError('unknown-key', `The ${section.name} section has an unknown key ${key}.`, { section: section.name, row: entry.rowNumber, column: 'key' });
    if (result.has(key)) dataError('duplicate-key', `The ${section.name} section repeats ${key}.`, { section: section.name, row: entry.rowNumber, column: 'key' });
    result.set(key, row[1]);
  }
  for (const key of expectedKeys) {
    if (!result.has(key)) dataError('missing-key', `The ${section.name} section is missing ${key}.`, { section: section.name, column: key });
  }
  return result;
}

function parseGameIdAndMetadata(
  gameSection: ParsedSection,
  topGameId: string,
): { gameValues: Map<string, string>; gameId: string } {
  const values = keyValueMap(gameSection, gameKeys);
  const gameId = decodeText(values.get('game_id')!, { section: 'GAME', column: 'game_id' });
  if (gameId !== topGameId) dataError('game-id-mismatch', 'The GAME section does not match the A1 game ID.', { section: 'GAME', column: 'game_id' });
  return { gameValues: values, gameId };
}

function parseQbjIdentity(value: unknown): IQbjIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) dataError('malformed-qbj-identity', 'The QBJ identity must be an object.');
  const allowed = new Set(['tournamentId', 'matchId', 'phaseId', 'roundId', 'roundQbjName', 'phaseName', 'scoringRulesId', 'teamIds', 'playerIds', 'registrationIds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) dataError('unknown-qbj-identity-field', `The QBJ identity has an unknown field ${key}.`);
  const stringField = (key: string): string | undefined => {
    const field = value[key];
    if (field === undefined) return undefined;
    if (typeof field !== 'string') dataError('malformed-qbj-identity', `The QBJ identity field ${key} is not text.`);
    return field;
  };
  const readSideIds = (key: 'teamIds' | 'registrationIds'): { left?: string; right?: string } | undefined => {
    const field = value[key];
    if (field === undefined) return undefined;
    if (!isPlainObject(field)) dataError('malformed-qbj-identity', `The QBJ identity field ${key} is not an object.`);
    for (const side of Object.keys(field)) if (side !== 'left' && side !== 'right') dataError('malformed-qbj-identity', `The QBJ identity field ${key} has an unknown side.`);
    const result: { left?: string; right?: string } = {};
    for (const side of ['left', 'right'] as const) {
      if (field[side] !== undefined) {
        if (typeof field[side] !== 'string') dataError('malformed-qbj-identity', `The QBJ identity field ${key}.${side} is not text.`);
        result[side] = field[side] as string;
      }
    }
    return result;
  };
  let playerIds: Record<string, string> | undefined;
  if (value.playerIds !== undefined) {
    if (!isPlainObject(value.playerIds)) dataError('malformed-qbj-identity', 'The QBJ player IDs are not an object.');
    playerIds = {};
    for (const [key, playerId] of Object.entries(value.playerIds)) {
      if (typeof playerId !== 'string') dataError('malformed-qbj-identity', `The QBJ player ID for ${key} is not text.`);
      playerIds[key] = playerId;
    }
  }
  return {
    ...(stringField('tournamentId') !== undefined ? { tournamentId: stringField('tournamentId') } : {}),
    ...(stringField('matchId') !== undefined ? { matchId: stringField('matchId') } : {}),
    ...(stringField('phaseId') !== undefined ? { phaseId: stringField('phaseId') } : {}),
    ...(stringField('roundId') !== undefined ? { roundId: stringField('roundId') } : {}),
    ...(stringField('roundQbjName') !== undefined ? { roundQbjName: stringField('roundQbjName') } : {}),
    ...(stringField('phaseName') !== undefined ? { phaseName: stringField('phaseName') } : {}),
    ...(stringField('scoringRulesId') !== undefined ? { scoringRulesId: stringField('scoringRulesId') } : {}),
    ...(readSideIds('teamIds') !== undefined ? { teamIds: readSideIds('teamIds') } : {}),
    ...(playerIds !== undefined ? { playerIds } : {}),
    ...(readSideIds('registrationIds') !== undefined ? { registrationIds: readSideIds('registrationIds') } : {}),
  };
}

function parseTeamsAndPlayers(
  teamSection: ParsedSection,
  playersSectionValue: ParsedSection,
): { packageTeams: Record<'left' | 'right', IGamePackageTeam>; setup: IGameSetup } {
  const teamRows = teamSection.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  if (teamRows.length < 1) dataError('missing-header', 'The TEAMS section is empty.', { section: 'TEAMS' });
  expectHeader(teamRows[0].row, teamColumns, 'TEAMS', teamRows[0].rowNumber);
  const teams = new Map<'left' | 'right', { packageName: string; setupName: string; packageLineup?: string[]; setupLineup?: string[] }>();
  for (const entry of teamRows.slice(1)) {
    const row = expectRowWidth(entry.row, teamColumns.length, 'TEAMS', entry.rowNumber);
    if (row[0] !== 'left' && row[0] !== 'right') dataError('invalid-team-side', `Unknown team side ${row[0]}.`, { section: 'TEAMS', row: entry.rowNumber, column: 'side' });
    const side = row[0] as 'left' | 'right';
    if (teams.has(side)) dataError('duplicate-team-side', `The TEAMS section repeats ${side}.`, { section: 'TEAMS', row: entry.rowNumber, column: 'side' });
    const packageName = decodeText(requiredCell(row, 1, { section: 'TEAMS', row: entry.rowNumber, column: 'package_name' }), { section: 'TEAMS', row: entry.rowNumber, column: 'package_name' });
    const setupName = decodeText(requiredCell(row, 2, { section: 'TEAMS', row: entry.rowNumber, column: 'setup_name' }), { section: 'TEAMS', row: entry.rowNumber, column: 'setup_name' });
    const packageLineup = decodeOptionalJson(row[3], { section: 'TEAMS', row: entry.rowNumber, column: 'package_starting_lineup' });
    const setupLineup = decodeOptionalJson(row[4], { section: 'TEAMS', row: entry.rowNumber, column: 'setup_starting_lineup' });
    const readLineup = (value: unknown, column: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) dataError('malformed-lineup', `The ${column} lineup is not a list of names.`, { section: 'TEAMS', row: entry.rowNumber, column });
      return [...(value as string[])];
    };
    teams.set(side, { packageName, setupName, packageLineup: readLineup(packageLineup, 'package_starting_lineup'), setupLineup: readLineup(setupLineup, 'setup_starting_lineup') });
  }
  for (const side of ['left', 'right'] as const) if (!teams.has(side)) dataError('missing-team-side', `The TEAMS section is missing ${side}.`, { section: 'TEAMS', column: 'side' });

  const playerRows = playersSectionValue.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  if (playerRows.length < 1) dataError('missing-header', 'The PLAYERS section is empty.', { section: 'PLAYERS' });
  expectHeader(playerRows[0].row, playerColumns, 'PLAYERS', playerRows[0].rowNumber);
  const names: Record<'left' | 'right', { package: string[]; setup: string[] }> = {
    left: { package: [], setup: [] },
    right: { package: [], setup: [] },
  };
  const nextOrder = new Map<string, number>();
  for (const entry of playerRows.slice(1)) {
    const row = expectRowWidth(entry.row, playerColumns.length, 'PLAYERS', entry.rowNumber);
    if (row[0] !== 'left' && row[0] !== 'right') dataError('invalid-player-side', `Unknown player side ${row[0]}.`, { section: 'PLAYERS', row: entry.rowNumber, column: 'side' });
    if (row[1] !== 'package' && row[1] !== 'setup') dataError('invalid-player-source', `Unknown player source ${row[1]}.`, { section: 'PLAYERS', row: entry.rowNumber, column: 'source' });
    const side = row[0] as 'left' | 'right';
    const source = row[1] as 'package' | 'setup';
    const order = decodeNumber(requiredCell(row, 2, { section: 'PLAYERS', row: entry.rowNumber, column: 'order' }), { section: 'PLAYERS', row: entry.rowNumber, column: 'order' });
    if (!Number.isInteger(order) || order < 1) dataError('invalid-player-order', 'A player order must be a positive integer.', { section: 'PLAYERS', row: entry.rowNumber, column: 'order' });
    const orderKey = `${side}:${source}`;
    if (order !== (nextOrder.get(orderKey) ?? 0) + 1) dataError('invalid-player-order', `The ${side} ${source} player order is not contiguous.`, { section: 'PLAYERS', row: entry.rowNumber, column: 'order' });
    nextOrder.set(orderKey, order);
    const name = decodeText(requiredCell(row, 3, { section: 'PLAYERS', row: entry.rowNumber, column: 'player_name' }), { section: 'PLAYERS', row: entry.rowNumber, column: 'player_name' });
    names[side][source].push(name);
  }
  const packageTeams = {} as Record<'left' | 'right', IGamePackageTeam>;
  const setup = {} as IGameSetup;
  for (const side of ['left', 'right'] as const) {
    const team = teams.get(side)!;
    packageTeams[side] = {
      name: team.packageName,
      players: names[side].package.map((name) => ({ name })),
      ...(team.packageLineup !== undefined ? { startingLineup: team.packageLineup } : {}),
    };
    setup[side] = {
      name: team.setupName,
      players: names[side].setup,
      ...(team.setupLineup !== undefined ? { startingLineup: team.setupLineup } : {}),
    };
  }
  return { packageTeams, setup };
}

function parseFormat(section: ParsedSection): IScorekeeperFormat {
  const nonblank = section.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  if (nonblank.length < 1) dataError('missing-header', 'The SCORING_RULES section is empty.', { section: section.name });
  const answerMarker = nonblank.findIndex(({ row }) => row[0] === 'ANSWER_TYPES');
  if (answerMarker < 0) dataError('missing-answer-types', 'The SCORING_RULES section has no ANSWER_TYPES table.', { section: section.name });
  const settings = keyValueMap({ name: section.name, rows: nonblank.slice(0, answerMarker) }, formatKeys);
  const answerHeader = nonblank[answerMarker + 1];
  if (!answerHeader) dataError('missing-header', 'The answer types table has no header.', { section: section.name });
  expectHeader(answerHeader.row, answerTypeColumns, section.name, answerHeader.rowNumber);
  const answerTypes: IScorekeeperAnswerType[] = [];
  for (const entry of nonblank.slice(answerMarker + 2)) {
    const row = expectRowWidth(entry.row, answerTypeColumns.length, section.name, entry.rowNumber);
    const index = decodeNumber(requiredCell(row, 0, { section: section.name, row: entry.rowNumber, column: 'index' }), { section: section.name, row: entry.rowNumber, column: 'index' });
    if (!Number.isInteger(index) || index !== answerTypes.length) dataError('invalid-answer-type-order', 'Answer type indexes must be contiguous and ordered.', { section: section.name, row: entry.rowNumber, column: 'index' });
    answerTypes.push({
      index,
      value: decodeNumber(requiredCell(row, 1, { section: section.name, row: entry.rowNumber, column: 'value' }), { section: section.name, row: entry.rowNumber, column: 'value' }),
      label: decodeText(requiredCell(row, 2, { section: section.name, row: entry.rowNumber, column: 'label' }), { section: section.name, row: entry.rowNumber, column: 'label' }),
      shortLabel: decodeText(requiredCell(row, 3, { section: section.name, row: entry.rowNumber, column: 'short_label' }), { section: section.name, row: entry.rowNumber, column: 'short_label' }),
      isPower: decodeBoolean(requiredCell(row, 4, { section: section.name, row: entry.rowNumber, column: 'is_power' }), { section: section.name, row: entry.rowNumber, column: 'is_power' }),
      isNeg: decodeBoolean(requiredCell(row, 5, { section: section.name, row: entry.rowNumber, column: 'is_neg' }), { section: section.name, row: entry.rowNumber, column: 'is_neg' }),
      awardsBonus: decodeBoolean(requiredCell(row, 6, { section: section.name, row: entry.rowNumber, column: 'awards_bonus' }), { section: section.name, row: entry.rowNumber, column: 'awards_bonus' }),
      qbjId: decodeText(requiredCell(row, 7, { section: section.name, row: entry.rowNumber, column: 'qbj_id' }), { section: section.name, row: entry.rowNumber, column: 'qbj_id' }),
    });
  }
  const readNumber = (key: (typeof formatKeys)[number]): number => decodeNumber(requiredCell([settings.get(key) ?? ''], 0, { section: section.name, column: key }), { section: section.name, column: key });
  const readBool = (key: (typeof formatKeys)[number]): boolean => decodeBoolean(requiredCell([settings.get(key) ?? ''], 0, { section: section.name, column: key }), { section: section.name, column: key });
  const format: IScorekeeperFormat = {
    version: readNumber('version'),
    name: decodeText(settings.get('name')!, { section: section.name, column: 'name' }),
    answerTypes,
    regulation: {
      timed: readBool('regulation.timed'),
      tossupCount: readNumber('regulation.tossupCount'),
      maximumTossupCount: readNumber('regulation.maximumTossupCount'),
    },
    bonus: {
      enabled: readBool('bonus.enabled'),
      bounceBack: readBool('bonus.bounceBack'),
      regular: readBool('bonus.regular'),
      divisor: readNumber('bonus.divisor'),
      minimumParts: readNumber('bonus.minimumParts'),
      maximumParts: readNumber('bonus.maximumParts'),
      pointsPerPart: decodeOptionalNumber(settings.get('bonus.pointsPerPart')!, { section: section.name, column: 'bonus.pointsPerPart' }),
      maximumScore: readNumber('bonus.maximumScore'),
    },
    overtime: {
      minimumQuestionCount: readNumber('overtime.minimumQuestionCount'),
      suddenDeath: readBool('overtime.suddenDeath'),
      includesBonuses: readBool('overtime.includesBonuses'),
    },
    lightning: {
      enabled: readBool('lightning.enabled'),
      countPerTeam: readNumber('lightning.countPerTeam'),
      divisor: readNumber('lightning.divisor'),
    },
    players: { maximumActive: readNumber('players.maximumActive') },
    totalDivisor: readNumber('totalDivisor'),
  };
  const problems = scorekeeperFormatProblems(format);
  if (problems.length > 0) dataError('invalid-scoring-rules', problems[0], { section: section.name });
  return format;
}

function parseProcedure(section: ParsedSection): IRoomProcedure | undefined {
  const nonblank = section.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  const breakMarker = nonblank.findIndex(({ row }) => row[0] === 'BREAKS');
  if (breakMarker < 0) dataError('missing-breaks-table', 'The PROCEDURE section has no BREAKS table.', { section: section.name });
  const settings = keyValueMap({ name: section.name, rows: nonblank.slice(0, breakMarker) }, procedureKeys);
  const present = decodeBoolean(settings.get('present')!, { section: section.name, column: 'present' });
  const breakHeader = nonblank[breakMarker + 1];
  if (!breakHeader) dataError('missing-header', 'The BREAKS table has no header.', { section: section.name });
  expectHeader(breakHeader.row, breakColumns, section.name, breakHeader.rowNumber);
  const breaks: IRoomBreak[] = [];
  for (const entry of nonblank.slice(breakMarker + 2)) {
    const row = expectRowWidth(entry.row, breakColumns.length, section.name, entry.rowNumber);
    const afterTossup = decodeNumber(requiredCell(row, 0, { section: section.name, row: entry.rowNumber, column: 'after_tossup' }), { section: section.name, row: entry.rowNumber, column: 'after_tossup' });
    if (!Number.isInteger(afterTossup) || afterTossup < 1 || (breaks.at(-1)?.afterTossup ?? 0) >= afterTossup) dataError('invalid-break-order', 'Room breaks must be distinct positive integers in ascending order.', { section: section.name, row: entry.rowNumber, column: 'after_tossup' });
    const label = decodeOptionalText(row[1], { section: section.name, row: entry.rowNumber, column: 'label' });
    breaks.push({ afterTossup, ...(label !== undefined ? { label } : {}) });
  }
  if (!present) return undefined;
  const version = decodeNumber(requiredCell([settings.get('version') ?? ''], 0, { section: section.name, column: 'version' }), { section: section.name, column: 'version' });
  if (!Number.isInteger(version) || !isKnownRoomProcedureVersion(version) || !readableRoomProcedureVersions.includes(version)) dataError('unsupported-procedure-version', `The room procedure version ${String(version)} is not supported.`, { section: section.name, column: 'version' });
  const halves = decodeBoolean(settings.get('halves')!, { section: section.name, column: 'halves' });
  const halfLengthMinutes = decodeOptionalNumber(settings.get('halfLengthMinutes')!, { section: section.name, column: 'halfLengthMinutes' });
  const timeoutsPerTeam = decodeNumber(requiredCell([settings.get('timeoutsPerTeam') ?? ''], 0, { section: section.name, column: 'timeoutsPerTeam' }), { section: section.name, column: 'timeoutsPerTeam' });
  const timeoutDurationSeconds = decodeOptionalNumber(settings.get('timeoutDurationSeconds')!, { section: section.name, column: 'timeoutDurationSeconds' });
  if (!Number.isInteger(timeoutsPerTeam) || timeoutsPerTeam < 0) dataError('invalid-procedure-value', 'timeoutsPerTeam must be a nonnegative integer.', { section: section.name, column: 'timeoutsPerTeam' });
  const protestCheckpoints = decodeOptionalText(settings.get('protestCheckpoints')!, { section: section.name, column: 'protestCheckpoints' });
  if (protestCheckpoints !== undefined && protestCheckpoints !== 'none' && protestCheckpoints !== 'phase-boundaries' && protestCheckpoints !== 'strict-overtime') dataError('invalid-procedure-value', 'The protest checkpoint policy is unknown.', { section: section.name, column: 'protestCheckpoints' });
  const substitutionPolicy = decodeOptionalText(settings.get('substitutionPolicy')!, { section: section.name, column: 'substitutionPolicy' });
  if (substitutionPolicy !== undefined && substitutionPolicy !== 'any-boundary' && substitutionPolicy !== 'breaks-timeouts-overtime') dataError('invalid-procedure-value', 'The substitution policy is unknown.', { section: section.name, column: 'substitutionPolicy' });
  return {
    version,
    halves,
    ...(breaks.length > 0 ? { breaks } : {}),
    ...(halfLengthMinutes !== undefined ? { halfLengthMinutes } : {}),
    timeoutsPerTeam,
    ...(timeoutDurationSeconds !== undefined ? { timeoutDurationSeconds } : {}),
    ...(protestCheckpoints !== undefined ? { protestCheckpoints: protestCheckpoints as IRoomProcedure['protestCheckpoints'] } : {}),
    ...(substitutionPolicy !== undefined ? { substitutionPolicy: substitutionPolicy as IRoomProcedure['substitutionPolicy'] } : {}),
  };
}

function eventKnownKeys(type: ScoreEvent['type']): Set<string> {
  return new Set(['id', 'type', 'questionNumber', ...eventPropertyKeys[type]]);
}

function validBonusPart(value: unknown): boolean {
  return isPlainObject(value) && typeof value.controlledPoints === 'number' && Number.isFinite(value.controlledPoints) && (value.bouncebackPoints === undefined || (typeof value.bouncebackPoints === 'number' && Number.isFinite(value.bouncebackPoints)));
}

function validScoreEvent(value: unknown): value is ScoreEvent {
  if (!isPlainObject(value)) return false;
  const id = value.id;
  const eventType = value.type;
  const questionNumber = value.questionNumber;
  if (
    typeof id !== 'string' ||
    id.trim() === '' ||
    typeof eventType !== 'string' ||
    !Object.hasOwn(eventPropertyKeys, eventType) ||
    typeof questionNumber !== 'number' ||
    !Number.isInteger(questionNumber) ||
    questionNumber < 1
  ) return false;
  const team = (candidate: unknown): candidate is 'left' | 'right' => candidate === 'left' || candidate === 'right';
  switch (eventType) {
    case 'tossup-buzz': {
      const answerTypeIndex = value.answerTypeIndex;
      return team(value.team) && typeof value.playerName === 'string' && value.playerName.trim() !== '' && typeof answerTypeIndex === 'number' && Number.isInteger(answerTypeIndex) && answerTypeIndex >= 0;
    }
    case 'tossup-no-penalty': return team(value.team) && (value.playerName === undefined || (typeof value.playerName === 'string' && value.playerName.trim() !== ''));
    case 'tossup-reading-resumed':
    case 'tossup-readout':
    case 'tossup-dead':
    case 'half-resume':
    case 'begin-overtime':
    case 'begin-sudden-death':
    case 'timeout-resume': return true;
    case 'bonus': return team(value.team) && (value.parts === undefined || (Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every(validBonusPart))) && (value.controlledPoints !== undefined || value.parts !== undefined) && (value.controlledPoints === undefined || (typeof value.controlledPoints === 'number' && Number.isFinite(value.controlledPoints))) && (value.bouncebackPoints === undefined || (typeof value.bouncebackPoints === 'number' && Number.isFinite(value.bouncebackPoints)));
    case 'lightning':
    case 'adjustment': return team(value.team) && typeof value.points === 'number' && Number.isFinite(value.points);
    case 'substitution': return team(value.team) && Array.isArray(value.activePlayers) && value.activePlayers.length > 0 && new Set(value.activePlayers).size === value.activePlayers.length && value.activePlayers.every((name) => typeof name === 'string' && name.trim() !== '');
    case 'roster-add': return team(value.team) && typeof value.playerName === 'string' && value.playerName.trim() !== '';
    case 'end-regulation': {
      const lastRegulationQuestion = value.lastRegulationQuestion;
      return lastRegulationQuestion === undefined || (typeof lastRegulationQuestion === 'number' && Number.isInteger(lastRegulationQuestion) && lastRegulationQuestion >= 0);
    }
    case 'half-break': {
      const lastQuestion = value.lastQuestion;
      return typeof lastQuestion === 'number' && Number.isInteger(lastQuestion) && lastQuestion >= 0;
    }
    case 'timeout': return team(value.team);
    case 'timeout-start': {
      const startedAt = value.startedAt;
      return team(value.team) && (startedAt === undefined || (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0));
    }
    case 'protest': {
      const subject = value.subject;
      const status = value.status;
      return team(value.team) && typeof subject === 'string' && ['tossup-answer', 'bonus-answer', 'question', 'procedure', 'other'].includes(subject) && typeof status === 'string' && ['open', 'upheld', 'declined', 'withdrawn'].includes(status) && typeof value.description === 'string' && (value.resolution === undefined || typeof value.resolution === 'string');
    }
    case 'question-void': return (value.scope === 'tossup' || value.scope === 'bonus') && typeof value.reason === 'string';
    case 'end-game-early': {
      const tossupsRead = value.tossupsRead;
      return typeof value.reason === 'string' && typeof tossupsRead === 'number' && Number.isInteger(tossupsRead) && tossupsRead >= 0;
    }
    case 'forfeit': return Array.isArray(value.teams) && value.teams.length > 0 && new Set(value.teams).size === value.teams.length && value.teams.every(team);
    case 'note': return typeof value.text === 'string' && (value.flagged === undefined || typeof value.flagged === 'boolean');
    default: return false;
  }
}

function parseEvent(row: string[], rowNumber: number): ScoreEvent {
  const section = 'EVENTS';
  const type = requiredCell(row, 3, { section, row: rowNumber, column: 'type' });
  if (!Object.hasOwn(eventPropertyKeys, type)) dataError('unknown-event-type', `The event type ${type} is not supported.`, { section, row: rowNumber, column: 'type' });
  const eventType = type as ScoreEvent['type'];
  const known = eventKnownKeys(eventType);
  const propertyByColumn: Partial<Record<(typeof eventColumns)[number], string>> = {
    team: 'team',
    player_name: 'playerName',
    answer_type_index: 'answerTypeIndex',
    points: 'points',
    controlled_points: 'controlledPoints',
    bounceback_points: 'bouncebackPoints',
    parts: 'parts',
    active_players: 'activePlayers',
    last_regulation_question: 'lastRegulationQuestion',
    last_question: 'lastQuestion',
    subject: 'subject',
    description: 'description',
    status: 'status',
    resolution: 'resolution',
    scope: 'scope',
    reason: 'reason',
    tossups_read: 'tossupsRead',
    text: 'text',
    flagged: 'flagged',
    teams: 'teams',
    started_at: 'startedAt',
  };
  for (const [index, column] of eventColumns.entries()) {
    const property = propertyByColumn[column];
    if (property !== undefined && !known.has(property) && valueAt(row, index) !== '')
      dataError('unexpected-event-field', `The ${eventType} event has data in unrelated column ${column}.`, {
        section,
        row: rowNumber,
        column,
      });
  }
  const id = decodeText(requiredCell(row, 1, { section, row: rowNumber, column: 'event_id' }), { section, row: rowNumber, column: 'event_id' });
  const questionNumber = decodeNumber(requiredCell(row, 2, { section, row: rowNumber, column: 'question_number' }), { section, row: rowNumber, column: 'question_number' });
  const raw: Record<string, unknown> = { id, type: eventType, questionNumber };
  const readTeam = () => {
    const team = requiredCell(row, 4, { section, row: rowNumber, column: 'team' });
    if (team !== 'left' && team !== 'right') dataError('invalid-team', `The event team ${team} is unknown.`, { section, row: rowNumber, column: 'team' });
    return team;
  };
  const readOptionalNumber = (index: number, column: string) => decodeOptionalNumber(valueAt(row, index), { section, row: rowNumber, column });
  const readOptionalText = (index: number, column: string) => decodeOptionalText(valueAt(row, index), { section, row: rowNumber, column });
  switch (eventType) {
    case 'tossup-buzz': raw.team = readTeam(); raw.playerName = decodeText(requiredCell(row, 5, { section, row: rowNumber, column: 'player_name' }), { section, row: rowNumber, column: 'player_name' }); raw.answerTypeIndex = readOptionalNumber(6, 'answer_type_index'); break;
    case 'tossup-no-penalty': raw.team = readTeam(); raw.playerName = readOptionalText(5, 'player_name'); break;
    case 'tossup-reading-resumed':
    case 'tossup-readout':
    case 'tossup-dead':
    case 'half-resume':
    case 'begin-overtime':
    case 'begin-sudden-death':
    case 'timeout-resume': break;
    case 'bonus': raw.team = readTeam(); raw.parts = decodeOptionalJson(valueAt(row, 10), { section, row: rowNumber, column: 'parts' }); raw.controlledPoints = readOptionalNumber(8, 'controlled_points'); raw.bouncebackPoints = readOptionalNumber(9, 'bounceback_points'); break;
    case 'lightning': raw.team = readTeam(); raw.points = readOptionalNumber(7, 'points'); break;
    case 'substitution': raw.team = readTeam(); raw.activePlayers = decodeOptionalJson(valueAt(row, 11), { section, row: rowNumber, column: 'active_players' }); break;
    case 'roster-add': raw.team = readTeam(); raw.playerName = decodeText(requiredCell(row, 5, { section, row: rowNumber, column: 'player_name' }), { section, row: rowNumber, column: 'player_name' }); break;
    case 'end-regulation': raw.lastRegulationQuestion = readOptionalNumber(12, 'last_regulation_question'); break;
    case 'half-break': raw.lastQuestion = readOptionalNumber(13, 'last_question'); break;
    case 'timeout': raw.team = readTeam(); break;
    case 'timeout-start': raw.team = readTeam(); raw.startedAt = readOptionalNumber(24, 'started_at'); break;
    case 'protest': raw.team = readTeam(); raw.subject = requiredCell(row, 14, { section, row: rowNumber, column: 'subject' }); raw.description = decodeText(requiredCell(row, 15, { section, row: rowNumber, column: 'description' }), { section, row: rowNumber, column: 'description' }); raw.status = requiredCell(row, 16, { section, row: rowNumber, column: 'status' }); raw.resolution = readOptionalText(17, 'resolution'); break;
    case 'question-void': raw.scope = requiredCell(row, 18, { section, row: rowNumber, column: 'scope' }); raw.reason = decodeText(requiredCell(row, 19, { section, row: rowNumber, column: 'reason' }), { section, row: rowNumber, column: 'reason' }); break;
    case 'end-game-early': raw.reason = decodeText(requiredCell(row, 19, { section, row: rowNumber, column: 'reason' }), { section, row: rowNumber, column: 'reason' }); raw.tossupsRead = readOptionalNumber(20, 'tossups_read'); break;
    case 'adjustment': raw.team = readTeam(); raw.points = readOptionalNumber(7, 'points'); raw.reason = readOptionalText(19, 'reason'); break;
    case 'forfeit': raw.teams = decodeOptionalJson(valueAt(row, 23), { section, row: rowNumber, column: 'teams' }); break;
    case 'note': raw.text = decodeText(requiredCell(row, 21, { section, row: rowNumber, column: 'text' }), { section, row: rowNumber, column: 'text' }); raw.flagged = decodeOptionalBoolean(valueAt(row, 22), { section, row: rowNumber, column: 'flagged' }); break;
    default: assertNever(eventType);
  }
  const extrasValue = decodeOptionalJson(row[25] ?? '', { section, row: rowNumber, column: 'extras' });
  if (extrasValue !== undefined) {
    if (!isPlainObject(extrasValue)) dataError('malformed-extras', 'Event extras must be an object.', { section, row: rowNumber, column: 'extras' });
    for (const key of Object.keys(extrasValue)) if (known.has(key)) dataError('conflicting-extra', `Event extras repeat known field ${key}.`, { section, row: rowNumber, column: 'extras' });
    Object.assign(raw, extrasValue);
  }
  if (!validScoreEvent(raw)) dataError('malformed-event', `Event ${id} has invalid required data.`, { section, row: rowNumber });
  return raw;
}

function parseEvents(section: ParsedSection, expectedCount: number): ScoreEvent[] {
  const rows = section.rows.filter(({ row }) => !row.every((cell) => cell === ''));
  if (rows.length < 1) dataError('missing-header', 'The EVENTS section is empty.', { section: section.name });
  expectHeader(rows[0].row, eventColumns, section.name, rows[0].rowNumber);
  const events: ScoreEvent[] = [];
  const ids = new Set<string>();
  for (const entry of rows.slice(1)) {
    const row = expectRowWidth(entry.row, eventColumns.length, section.name, entry.rowNumber);
    const order = decodeNumber(requiredCell(row, 0, { section: section.name, row: entry.rowNumber, column: 'order' }), { section: section.name, row: entry.rowNumber, column: 'order' });
    if (!Number.isInteger(order) || order !== events.length + 1) dataError('invalid-event-order', 'Event order must be contiguous and match row order.', { section: section.name, row: entry.rowNumber, column: 'order' });
    const event = parseEvent(row, entry.rowNumber);
    if (ids.has(event.id)) dataError('duplicate-event-id', `Event ID ${event.id} appears more than once.`, { section: section.name, row: entry.rowNumber, column: 'event_id' });
    ids.add(event.id);
    events.push(event);
  }
  if (events.length !== expectedCount) dataError('event-count-mismatch', `The end marker says ${expectedCount} events, but the table contains ${events.length}.`, { section: section.name });
  return events;
}

function parseRecord(section: ParsedSection): ISpreadsheetGameMetadata | undefined {
  const values = keyValueMap(section, recordKeys);
  const result: ISpreadsheetGameMetadata = {};
  const textField = (key: (typeof recordKeys)[number], property: keyof ISpreadsheetGameMetadata) => {
    const value = decodeOptionalText(values.get(key)!, { section: section.name, column: key });
    if (value !== undefined) (result as Record<string, unknown>)[property] = value;
  };
  textField('record_identity', 'recordIdentity');
  const attempt = decodeOptionalNumber(values.get('attempt')!, { section: section.name, column: 'attempt' });
  if (attempt !== undefined) {
    if (!Number.isInteger(attempt) || attempt < 1) dataError('invalid-record-metadata', 'The record attempt must be a positive integer.', { section: section.name, column: 'attempt' });
    result.attempt = attempt;
  }
  const connected = decodeOptionalBoolean(values.get('connected')!, { section: section.name, column: 'connected' });
  if (connected !== undefined) result.connected = connected;
  textField('created_at', 'createdAt');
  textField('updated_at', 'updatedAt');
  textField('completed_at', 'completedAt');
  textField('scorekeeper', 'scorekeeper');
  textField('moderator', 'moderator');
  textField('notes', 'notes');
  const qbjMatchMeta = decodeOptionalJson(values.get('qbj_match_meta')!, { section: section.name, column: 'qbj_match_meta' });
  if (qbjMatchMeta !== undefined) {
    if (!isPlainObject(qbjMatchMeta)) dataError('invalid-record-metadata', 'QBJ match metadata must be an object.', { section: section.name, column: 'qbj_match_meta' });
    const checked = qbjMatchMeta as unknown;
    if (typeof (checked as Record<string, unknown>).round !== 'undefined' && !Number.isInteger((checked as Record<string, unknown>).round)) dataError('invalid-record-metadata', 'QBJ match metadata round must be an integer.', { section: section.name, column: 'qbj_match_meta' });
    for (const key of ['location', 'moderator', 'scorekeeper', 'notes']) {
      const value = (checked as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== 'string') dataError('invalid-record-metadata', `QBJ match metadata ${key} must be text.`, { section: section.name, column: 'qbj_match_meta' });
    }
    result.qbjMatchMeta = checked as IQbjMatchMeta;
  }
  const delivery = decodeOptionalText(values.get('server_delivery')!, { section: section.name, column: 'server_delivery' });
  if (delivery !== undefined) {
    if (!(serverDeliveries as readonly string[]).includes(delivery)) dataError('invalid-record-metadata', `The delivery state ${delivery} is unknown.`, { section: section.name, column: 'server_delivery' });
    result.serverDelivery = delivery as ISpreadsheetGameMetadata['serverDelivery'];
  }
  textField('server_delivery_detail', 'serverDeliveryDetail');
  const ledger = decodeOptionalJson(values.get('server_delivery_ledger')!, { section: section.name, column: 'server_delivery_ledger' });
  if (ledger !== undefined) result.serverDeliveryLedger = ledger;
  textField('qbj_downloaded_at', 'qbjDownloadedAt');
  textField('handoff_acknowledged_at', 'handoffAcknowledgedAt');
  return Object.keys(result).length === 0 ? undefined : result;
}

function parseEndMarker(row: string[], gameId: string): number {
  const values = expectRowWidth(row, 4, 'END', 0);
  if (values[0] !== spreadsheetEndMarker) dataError('missing-end-marker', 'The spreadsheet is missing its end marker.');
  const version = decodeNumber(values[1], { section: 'END', column: 'version' });
  if (version !== spreadsheetSchemaVersion) dataError('unsupported-version', `This spreadsheet schema is version ${version}; this build reads version ${spreadsheetSchemaVersion}.`, { section: 'END', column: 'version' });
  const endGameId = decodeText(values[2], { section: 'END', column: 'game_id' });
  if (endGameId !== gameId) dataError('end-game-id-mismatch', 'The end marker belongs to a different game.', { section: 'END', column: 'game_id' });
  const count = decodeNumber(values[3], { section: 'END', column: 'event_count' });
  if (!Number.isInteger(count) || count < 0) dataError('invalid-event-count', 'The end marker has an invalid event count.', { section: 'END', column: 'event_count' });
  return count;
}

function parsePackage(
  gameValues: Map<string, string>,
  packageTeams: Record<'left' | 'right', IGamePackageTeam>,
  format: IScorekeeperFormat,
  procedure: IRoomProcedure | undefined,
): ISpreadsheetGamePackage {
  const context = { section: 'GAME' };
  const readText = (key: (typeof gameKeys)[number]): string => decodeText(requiredCell([gameValues.get(key) ?? ''], 0, { ...context, column: key }), { ...context, column: key });
  const readOptional = (key: (typeof gameKeys)[number]): string | undefined => decodeOptionalText(gameValues.get(key)!, { ...context, column: key });
  const raw: Record<string, unknown> = {
    format: readText('package_format'),
    version: decodeNumber(gameValues.get('package_version')!, { ...context, column: 'package_version' }),
    tournament: {
      name: readText('tournament_name'),
      ...(readOptional('tournament_key') !== undefined ? { key: readOptional('tournament_key') } : {}),
    },
    ...(readOptional('producer') !== undefined ? { producer: readOptional('producer') } : {}),
    ...(readOptional('scheduled_match_id') !== undefined ? { scheduledMatchId: readOptional('scheduled_match_id') } : {}),
    round: {
      number: decodeNumber(gameValues.get('round_number')!, { ...context, column: 'round_number' }),
      name: readText('round_name'),
      revision: decodeNumber(gameValues.get('round_revision')!, { ...context, column: 'round_revision' }),
      ...(readOptional('packet_name') !== undefined ? { packetName: readOptional('packet_name') } : {}),
    },
    ...(readOptional('room_id') !== undefined || readOptional('room_name') !== undefined
      ? { room: { ...(readOptional('room_id') !== undefined ? { id: readOptional('room_id') } : {}), ...(readOptional('room_name') !== undefined ? { name: readOptional('room_name') } : {}) } }
      : {}),
    left: packageTeams.left,
    right: packageTeams.right,
    scorekeeperFormat: format,
    ...(procedure !== undefined ? { procedure } : {}),
    ...(readOptional('handoff_instruction') !== undefined ? { handoffInstruction: readOptional('handoff_instruction') } : {}),
  };
  const validated = validateGamePackage(raw);
  if (!validated.ok) dataError('invalid-game-package', validated.errors[0], { section: 'GAME' });
  const assumptionsValue = decodeOptionalJson(gameValues.get('assumptions')!, { section: 'GAME', column: 'assumptions' });
  if (assumptionsValue !== undefined && (!Array.isArray(assumptionsValue) || !assumptionsValue.every((value) => typeof value === 'string'))) dataError('malformed-assumptions', 'Assumptions must be a JSON array of strings.', { section: 'GAME', column: 'assumptions' });
  const origin = readOptional('definition_origin');
  if (origin !== undefined && !(origins as readonly string[]).includes(origin)) dataError('invalid-definition-origin', `The definition origin ${origin} is unknown.`, { section: 'GAME', column: 'definition_origin' });
  const identity = parseQbjIdentity(decodeOptionalJson(gameValues.get('qbj_identity')!, { section: 'GAME', column: 'qbj_identity' }));
  return {
    ...validated.value,
    ...(identity !== undefined ? { qbjIdentity: identity } : {}),
    ...(origin !== undefined ? { origin: origin as GameDefinitionOrigin } : {}),
    ...(assumptionsValue !== undefined ? { assumptions: assumptionsValue as string[] } : {}),
  };
}

function parseTopMarker(rows: string[][]): { gameId: string; version: number } {
  if (rows[0]?.[0]?.startsWith('\ufeff')) rows[0][0] = rows[0][0].slice(1);
  if (rows.length === 0 || rows[0][0] !== spreadsheetGameMarker) dataError('wrong-marker', 'A1 is not the QBSHEET_GAME marker.', { row: 1, column: 'A1' });
  const top = expectRowWidth(rows[0], 3, 'HEADER', 1);
  const version = decodeNumber(top[1], { section: 'HEADER', row: 1, column: 'version' });
  if (version !== spreadsheetSchemaVersion) dataError('unsupported-version', `This spreadsheet schema is version ${version}; this build reads version ${spreadsheetSchemaVersion}.`, { section: 'HEADER', row: 1, column: 'version' });
  const gameId = decodeText(top[2], { section: 'HEADER', row: 1, column: 'game_id' });
  if (gameId.trim() === '') dataError('missing-game-id', 'The QBSHEET_GAME marker has no game ID.', { section: 'HEADER', row: 1, column: 'game_id' });
  return { gameId, version };
}

function validateSetup(setup: IGameSetup): void {
  for (const side of ['left', 'right'] as const) {
    const team: ITeamSetup = setup[side];
    if (typeof team.name !== 'string' || team.name.trim() === '' || !Array.isArray(team.players) || !team.players.every((name) => typeof name === 'string' && name.trim() !== '')) dataError('invalid-setup', `The ${side} setup is not a usable roster.`, { section: 'TEAMS', column: 'setup_name' });
    if (team.startingLineup !== undefined && (!Array.isArray(team.startingLineup) || new Set(team.startingLineup).size !== team.startingLineup.length || !team.startingLineup.every((name) => team.players.includes(name)))) dataError('invalid-setup', `The ${side} starting lineup is not a subset of its roster.`, { section: 'TEAMS', column: 'setup_starting_lineup' });
  }
}

/** Parse one copied QBSheet range, without depending on tab names, formatting, or workbook state. */
export function parseSpreadsheetGame(text: string): SpreadsheetParseResult {
  try {
    const rows = parseGrid(text);
    const top = parseTopMarker(rows);
    const scanned = scanSections(rows, top.gameId);
    const expectedSections = ['GAME', 'TEAMS', 'PLAYERS', 'SCORING_RULES', 'EVENTS'];
    for (const name of expectedSections) sectionOrError(scanned.sections, name);
    const { gameValues, gameId } = parseGameIdAndMetadata(sectionOrError(scanned.sections, 'GAME'), top.gameId);
    const { packageTeams, setup } = parseTeamsAndPlayers(sectionOrError(scanned.sections, 'TEAMS'), sectionOrError(scanned.sections, 'PLAYERS'));
    validateSetup(setup);
    const format = parseFormat(sectionOrError(scanned.sections, 'SCORING_RULES'));
    const procedure = scanned.sections.has('PROCEDURE')
      ? parseProcedure(sectionOrError(scanned.sections, 'PROCEDURE'))
      : undefined;
    const procedurePresent = decodeBoolean(gameValues.get('procedure_present')!, {
      section: 'GAME',
      column: 'procedure_present',
    });
    if (procedurePresent !== (procedure !== undefined))
      dataError('procedure-section-mismatch', 'GAME and PROCEDURE disagree about whether a room procedure is present.', {
        section: 'PROCEDURE',
      });
    const packageValue = parsePackage(gameValues, packageTeams, format, procedure);
    const eventCount = parseEndMarker(scanned.end, top.gameId);
    const events = parseEvents(sectionOrError(scanned.sections, 'EVENTS'), eventCount);
    // Derivation is the existing interpretation check. A malformed canonical snapshot must not
    // reach a future importer merely because its cells happened to have the right primitive types.
    try {
      deriveGame(packageValue.scorekeeperFormat, setup, events);
    } catch {
      dataError('invalid-game-history', 'The event history cannot be interpreted by the scoring engine.');
    }
    const metadata = scanned.sections.has('RECORD')
      ? parseRecord(sectionOrError(scanned.sections, 'RECORD'))
      : undefined;
    return {
      ok: true,
      value: {
        gameId,
        package: packageValue,
        setup,
        events,
        ...(metadata ? { metadata } : {}),
      },
    };
  } catch (error) {
    if (error instanceof SpreadsheetDataError) return { ok: false, errors: [error.detail] };
    return { ok: false, errors: [{ code: 'unreadable-spreadsheet', message: 'The spreadsheet payload could not be read.' }] };
  }
}
