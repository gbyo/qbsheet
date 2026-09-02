import type { FormatError, FormatReport, FormatWarning, JsonObject, PlayerRecord, TeamRecord } from './types';
import { cloneJson, error, fail, ok, slugId, warning } from './util';

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** RFC 4180-style CSV parser with quoted commas, newlines, escaped quotes, and BOM support. */
export function parseCsvTable(text: string): FormatReport<CsvTable> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const source = text.startsWith('\ufeff') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let quotedCell = false;
  let atCellStart = true;

  const pushCell = () => {
    row.push(cell);
    cell = '';
    quotedCell = false;
    atCellStart = true;
  };
  const pushRow = () => {
    pushCell();
    // A final newline is a record terminator, not an additional blank record.
    if (!(
      row.length === 1 &&
      row[0] === '' &&
      rows.length > 0 &&
      rows[rows.length - 1].length === 1 &&
      rows[rows.length - 1][0] === ''
    )) {
      rows.push(row);
    }
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          quotedCell = true;
          atCellStart = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') {
      if (!atCellStart || quotedCell) {
        errors.push(
          error('unexpected-quote', `csv[${rows.length + 1}]`, 'A quote may only start a CSV cell.'),
        );
      } else {
        inQuotes = true;
        quotedCell = true;
        atCellStart = false;
      }
    } else if (character === ',') {
      pushCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      cell += character;
      atCellStart = false;
    }
  }
  if (inQuotes)
    errors.push(error('unterminated-quote', 'csv', 'The CSV input has an unterminated quoted cell.'));
  if (cell !== '' || row.length > 0 || source.endsWith(',')) pushRow();
  if (errors.length > 0) return fail(errors, warnings);
  if (rows.length === 0 || rows[0].every((header) => header.trim() === '')) {
    return fail([error('missing-header', 'csv', 'CSV input must contain a header row.')], warnings);
  }
  const headers = rows[0].map((header) => header.trim());
  const seenHeaders = new Set<string>();
  headers.forEach((header, index) => {
    const key = header.toLocaleLowerCase();
    if (seenHeaders.has(key))
      warnings.push(
        warning(
          'duplicate-header',
          `csv[1][${index + 1}]`,
          `The CSV header ${header} occurs more than once.`,
        ),
      );
    seenHeaders.add(key);
  });
  const width = headers.length;
  const normalizedRows: string[][] = [];
  rows.slice(1).forEach((values, index) => {
    if (values.length !== width) {
      warnings.push(
        warning(
          'column-count-mismatch',
          `csv[${index + 2}]`,
          `Expected ${width} columns but found ${values.length}; missing cells were filled with empty strings.`,
        ),
      );
    }
    if (values.length > width) {
      errors.push(
        error(
          'too-many-columns',
          `csv[${index + 2}]`,
          `Expected ${width} columns but found ${values.length}.`,
        ),
      );
    }
    normalizedRows.push([
      ...values.slice(0, width),
      ...Array.from({ length: Math.max(0, width - values.length) }, () => ''),
    ]);
  });
  return errors.length > 0 ? fail(errors, warnings) : ok({ headers, rows: normalizedRows }, warnings);
}

export type CsvCell = string | number | boolean | null | undefined;

export function csvCell(value: CsvCell): string {
  const rawText = value === null || value === undefined ? '' : String(value);
  // Spreadsheet applications may evaluate cells beginning with these characters as formulas.
  // Prefix only string data: a numeric -5 is a legitimate score and must remain numeric on export.
  const text = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  if (headers.length === 0) throw new Error('CSV export requires at least one header.');
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach((row) => {
    if (row.length !== headers.length)
      throw new Error('Every CSV row must have the same number of cells as the header.');
    lines.push(row.map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}

export const teamCsvHeaders = [
  'team_id',
  'team_name',
  'organization_id',
  'letter',
  'seed',
  'status',
  'notes',
  'player_id',
  'player_name',
  'player_captain',
  'player_number',
] as const;

const teamHeaderAliases: Record<string, string> = {
  team: 'team_name',
  name: 'team_name',
  school: 'organization_id',
  organization: 'organization_id',
  player: 'player_name',
  playername: 'player_name',
  number: 'player_number',
};

function canonicalHeader(header: string): string {
  const compact = header
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/g, '_');
  return teamHeaderAliases[compact.replace(/_/g, '')] ?? compact;
}

function extensionObject(record: { extensions?: JsonObject }): JsonObject {
  const csv = record.extensions?.csv;
  return csv && typeof csv === 'object' && !Array.isArray(csv) ? cloneJson(csv as JsonObject) : {};
}

export interface TeamCsvExportOptions {
  players?: readonly PlayerRecord[];
}

export function exportTeamsCsvReport(
  teams: readonly TeamRecord[],
  options: TeamCsvExportOptions = {},
): FormatReport<string> {
  const warnings: FormatWarning[] = [];
  const playersById = new Map((options.players ?? []).map((player) => [player.id, player]));
  const extensionHeaders = new Set<string>();
  teams.forEach((team) => {
    Object.keys(extensionObject(team)).forEach((key) => extensionHeaders.add(`extension.team.${key}`));
    (team.players ?? []).forEach((player) =>
      Object.keys(extensionObject(player)).forEach((key) => extensionHeaders.add(`extension.player.${key}`)),
    );
  });
  const headers = [...teamCsvHeaders, ...[...extensionHeaders].sort()];
  const rows: CsvCell[][] = [];
  teams.forEach((team, teamIndex) => {
    const embedded = team.players ?? [];
    const referenced = (team.playerIds ?? [])
      .map((id) => playersById.get(id))
      .filter((player): player is PlayerRecord => Boolean(player));
    const players = embedded.length > 0 ? embedded : referenced;
    if (team.playerIds?.some((id) => !playersById.has(id)) && embedded.length === 0) {
      warnings.push(
        warning(
          'unresolved-player',
          `teams[${teamIndex}].playerIds`,
          `One or more player ids for ${team.name} were not available for CSV export.`,
        ),
      );
    }
    const rowsPlayers: (PlayerRecord | undefined)[] = players.length > 0 ? players : [undefined];
    rowsPlayers.forEach((player) => {
      const teamExtensions = extensionObject(team);
      const playerExtensions = player ? extensionObject(player) : {};
      rows.push([
        team.id,
        team.name,
        team.organizationId,
        team.letter,
        team.seed,
        team.status,
        team.notes,
        player?.id,
        player?.name,
        player?.captain,
        player?.rosterNumber,
        ...[...extensionHeaders].sort().map((header) => {
          const [, owner, key] = header.split('.');
          return owner === 'team'
            ? JSON.stringify(teamExtensions[key] ?? '')
            : JSON.stringify(playerExtensions[key] ?? '');
        }),
      ]);
    });
  });
  return ok(serializeCsv(headers, rows), warnings);
}

export function exportTeamsCsv(teams: readonly TeamRecord[], options: TeamCsvExportOptions = {}): string {
  const report = exportTeamsCsvReport(teams, options);
  if (!report.ok) throw new Error(report.errors.map((entry) => entry.message).join(' '));
  return report.value;
}

function rowValue(row: Map<string, string>, key: string): string {
  return row.get(key) ?? '';
}

function decodeExtensionCell(value: string): string | number | boolean | JsonObject {
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded === 'string' || typeof decoded === 'number' || typeof decoded === 'boolean')
      return decoded;
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) return decoded as JsonObject;
  } catch {
    // A plain CSV extension value is still data, not an invalid row.
  }
  return value;
}

export function importTeamsCsv(text: string): FormatReport<TeamRecord[]> {
  const parsed = parseCsvTable(text);
  if (!parsed.ok) return parsed;
  const warnings = [...parsed.warnings];
  const errors: FormatError[] = [];
  const canonicalHeaders = parsed.value.headers.map(canonicalHeader);
  const knownHeaders = new Set(teamCsvHeaders);
  const unknownHeaders = canonicalHeaders.filter(
    (header) => !knownHeaders.has(header as (typeof teamCsvHeaders)[number]),
  );
  [...new Set(unknownHeaders)].forEach((header) =>
    warnings.push(
      warning(
        'unsupported-column-preserved',
        `csv.header.${header}`,
        `The CSV column ${header} is not interpreted; its values were preserved in extensions.`,
      ),
    ),
  );

  const teams: TeamRecord[] = [];
  const byKey = new Map<string, TeamRecord>();
  // Slugging erases the boundaries between the parts it joins, so a generated id cannot be trusted
  // to be as distinct as the identity it came from: `Wren` + `` + `A-B` and `Wren` + `A` + `B` both
  // slug to team_wren-a-b. Teams the fallback identity kept apart must keep distinct ids, so every
  // generated id is made unique against the ids already in use -- including the explicit ids from
  // rows that have not been read yet, which are authoritative and are never renamed.
  const teamIdColumn = canonicalHeaders.indexOf('team_id');
  const usedIds = new Set<string>(
    teamIdColumn === -1
      ? []
      : parsed.value.rows
          .map((values) => (values[teamIdColumn] ?? '').trim())
          .filter((explicit) => explicit !== ''),
  );
  const uniqueId = (base: string): string => {
    let candidate = base;
    for (let suffix = 2; usedIds.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
    usedIds.add(candidate);
    return candidate;
  };
  parsed.value.rows.forEach((values, rowIndex) => {
    const row = new Map<string, string>();
    canonicalHeaders.forEach((header, index) => {
      if (!row.has(header)) row.set(header, values[index] ?? '');
      else
        warnings.push(
          warning(
            'duplicate-column-value',
            `csv[${rowIndex + 2}]`,
            `The duplicate ${header} column was preserved only in the first value.`,
          ),
        );
    });
    const name = rowValue(row, 'team_name').trim();
    if (!name) {
      errors.push(
        error(
          'missing-team-name',
          `csv[${rowIndex + 2}]`,
          'Every team row must have a team_name (or team) value.',
        ),
      );
      return;
    }
    const explicitId = rowValue(row, 'team_id').trim();
    const organizationId = rowValue(row, 'organization_id').trim();
    const letter = rowValue(row, 'letter').trim();
    const fallbackIdentity = JSON.stringify(
      [name, organizationId, letter].map((value) => value.toLocaleLowerCase()),
    );
    const key = explicitId ? `id:${explicitId}` : `identity:${fallbackIdentity}`;
    let team = byKey.get(key);
    if (!team) {
      const id = explicitId || uniqueId(slugId('team', name, organizationId, letter));
      if (!explicitId)
        warnings.push(
          warning(
            'generated-id',
            `csv[${rowIndex + 2}].team_id`,
            `Generated ${id} because the CSV did not provide a team id.`,
          ),
        );
      team = { id, name, players: [], playerIds: [] };
      byKey.set(key, team);
      teams.push(team);
    } else if (team.name !== name) {
      warnings.push(
        warning(
          'conflicting-team-name',
          `csv[${rowIndex + 2}].team_name`,
          `Rows for ${team.id} use more than one team name; the first name was retained.`,
        ),
      );
    }
    const seedText = rowValue(row, 'seed').trim();
    const seed = seedText === '' ? undefined : Number(seedText);
    if (seedText !== '' && !Number.isFinite(seed))
      warnings.push(
        warning(
          'invalid-number',
          `csv[${rowIndex + 2}].seed`,
          `The seed ${seedText} was preserved as an extension because it is not numeric.`,
        ),
      );
    Object.assign(team, {
      ...(organizationId ? { organizationId } : {}),
      ...(letter ? { letter } : {}),
      ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
      ...(rowValue(row, 'status') ? { status: rowValue(row, 'status') } : {}),
      ...(rowValue(row, 'notes') ? { notes: rowValue(row, 'notes') } : {}),
    });
    const teamCsvExtensions = extensionObject(team);
    const rowExtensions: JsonObject = {};
    canonicalHeaders.forEach((header, index) => {
      if (!knownHeaders.has(header as (typeof teamCsvHeaders)[number]))
        rowExtensions[header] = decodeExtensionCell(values[index] ?? '');
    });
    if (seedText !== '' && (seed === undefined || !Number.isFinite(seed))) rowExtensions.seed = seedText;
    if (Object.keys(rowExtensions).length > 0)
      team.extensions = { ...(team.extensions ?? {}), csv: { ...teamCsvExtensions, ...rowExtensions } };

    const playerName = rowValue(row, 'player_name').trim();
    if (!playerName) return;
    const playerId = rowValue(row, 'player_id').trim() || slugId('player', team.id, playerName);
    const player: PlayerRecord = {
      id: playerId,
      name: playerName,
      ...(rowValue(row, 'player_captain')
        ? { captain: rowValue(row, 'player_captain').toLocaleLowerCase() === 'true' }
        : {}),
      ...(rowValue(row, 'player_number') ? { rosterNumber: rowValue(row, 'player_number') } : {}),
    };
    const duplicate = team.players?.find(
      (entry) => entry.id === player.id || entry.name.toLocaleLowerCase() === playerName.toLocaleLowerCase(),
    );
    if (duplicate) {
      warnings.push(
        warning(
          'duplicate-player',
          `csv[${rowIndex + 2}].player_name`,
          `${playerName} is listed more than once for ${team.name}; the first roster entry was retained.`,
        ),
      );
      return;
    }
    const playerExtensions: JsonObject = {};
    canonicalHeaders.forEach((header, index) => {
      if (header.startsWith('extension.player.'))
        playerExtensions[header.slice('extension.player.'.length)] = decodeExtensionCell(values[index] ?? '');
    });
    if (Object.keys(playerExtensions).length > 0)
      player.extensions = { ...(player.extensions ?? {}), csv: playerExtensions };
    team.players?.push(player);
    team.playerIds?.push(player.id);
  });
  return errors.length > 0 ? fail(errors, warnings) : ok(teams, warnings);
}

export interface SqbsExportOptions {
  /** The SQBS file format has no field for this metadata; include it in warnings, never drop silently. */
  sourceLabel?: string;
}

export function exportSqbsTeamsReport(
  teams: readonly TeamRecord[],
  _options: SqbsExportOptions = {},
): FormatReport<string> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const lines = [String(teams.length)];
  teams.forEach((team, teamIndex) => {
    const players = team.players ?? [];
    lines.push(String(players.length + 1), team.name);
    if (
      team.organizationId ||
      team.letter ||
      team.seed !== undefined ||
      team.status ||
      team.notes ||
      team.extensions
    ) {
      warnings.push(
        warning(
          'unsupported-team-fields',
          `teams[${teamIndex}]`,
          `SQBS roster files cannot represent all metadata for ${team.name}; metadata was not encoded in the positional file.`,
        ),
      );
    }
    if (/[\r\n]/.test(team.name))
      errors.push(
        error('invalid-team-name', `teams[${teamIndex}].name`, 'SQBS team names cannot contain line breaks.'),
      );
    players.forEach((player, playerIndex) => {
      if (/[\r\n]/.test(player.name))
        errors.push(
          error(
            'invalid-player-name',
            `teams[${teamIndex}].players[${playerIndex}]`,
            'SQBS player names cannot contain line breaks.',
          ),
        );
      const number = player.rosterNumber === undefined ? '' : ` (${String(player.rosterNumber)})`;
      lines.push(`${player.name}${number}`);
      if (player.organizationId || player.grade || player.captain || player.notes || player.extensions) {
        warnings.push(
          warning(
            'unsupported-player-fields',
            `teams[${teamIndex}].players[${playerIndex}]`,
            `SQBS roster files cannot represent all metadata for ${player.name}; metadata was not encoded in the positional file.`,
          ),
        );
      }
    });
  });
  return errors.length > 0 ? fail(errors, warnings) : ok(`${lines.join('\r\n')}\r\n`, warnings);
}

export function exportSqbsTeams(teams: readonly TeamRecord[], options: SqbsExportOptions = {}): string {
  const report = exportSqbsTeamsReport(teams, options);
  if (!report.ok) throw new Error(report.errors.map((entry) => entry.message).join(' '));
  return report.value;
}

export function importSqbsTeams(text: string): FormatReport<TeamRecord[]> {
  const warnings: FormatWarning[] = [];
  const errors: FormatError[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const count = Number(lines[0]);
  if (!Number.isInteger(count) || count < 0)
    return fail(
      [error('invalid-team-count', 'sqbs[1]', 'The first SQBS line must be a non-negative team count.')],
      warnings,
    );
  const teams: TeamRecord[] = [];
  let cursor = 1;
  for (let teamIndex = 0; teamIndex < count; teamIndex += 1) {
    const size = Number(lines[cursor]);
    if (!Number.isInteger(size) || size < 1) {
      errors.push(
        error(
          'invalid-section-size',
          `sqbs[${cursor + 1}]`,
          'Each SQBS team section must have a positive size line.',
        ),
      );
      break;
    }
    cursor += 1;
    const teamName = lines[cursor];
    if (teamName === undefined) {
      errors.push(error('truncated-team', `sqbs[${cursor + 1}]`, 'The SQBS file ends before the team name.'));
      break;
    }
    cursor += 1;
    const playerCount = size - 1;
    const players: PlayerRecord[] = [];
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      const rawName = lines[cursor];
      if (rawName === undefined) {
        errors.push(
          error('truncated-roster', `sqbs[${cursor + 1}]`, `The roster for ${teamName} is incomplete.`),
        );
        break;
      }
      cursor += 1;
      if (rawName === '') {
        errors.push(
          error(
            'blank-player',
            `sqbs[${cursor}]`,
            `The roster for ${teamName} contains a blank player line.`,
          ),
        );
        continue;
      }
      const numbered = rawName.match(/^(.*)\s+\(([^()]*)\)$/);
      const name = (numbered?.[1] ?? rawName).trim();
      const number = numbered?.[2]?.trim();
      players.push({
        id: slugId('player', teamName, name),
        name,
        ...(number ? { rosterNumber: /^\d+$/.test(number) ? Number(number) : number } : {}),
        ...(numbered ? { extensions: { sqbs: { rawLine: rawName } } } : {}),
      });
    }
    const id = slugId('team', teamName);
    if (teams.some((team) => team.id === id))
      warnings.push(
        warning(
          'duplicate-team',
          `sqbs[${cursor}]`,
          `The SQBS file contains duplicate team name ${teamName}; generated ids collide.`,
        ),
      );
    teams.push({ id, name: teamName, playerIds: players.map((player) => player.id), players });
  }
  if (cursor < lines.length) {
    const trailingLines = lines.slice(cursor);
    warnings.push(
      warning(
        'trailing-data-preserved',
        `sqbs[${cursor + 1}]`,
        'Trailing SQBS lines were not interpreted and were preserved on the last team.',
      ),
    );
    const last = teams.at(-1);
    if (last) last.extensions = { ...(last.extensions ?? {}), sqbs: { trailingLines } };
  }
  return errors.length > 0 ? fail(errors, warnings) : ok(teams, warnings);
}

export const parseSqbsTeamFile = importSqbsTeams;
export const serializeSqbsTeamFile = exportSqbsTeams;
