// GENERATED FILE — do not edit.
//
// Copied from packages/qblive-protocol/src by scripts/sync-protocol.mjs so that this Worker is
// self-contained and deployable straight from the repository by "Deploy to Cloudflare", which
// cannot resolve monorepo workspace packages. Edit the original and re-run:
//
//     npm run sync-protocol --workspace=@qbsheet/qblive-backend-cloudflare
//
/**
 * Runtime validation for QBLive documents.
 *
 * # Why hand-written rather than a schema compiler
 *
 * Two reasons. The App Clip has a hard size budget and the Live Web bundle is loaded over a school
 * WiFi network, so neither can afford a validator runtime; and the failure this code exists to
 * catch — a hostile or broken tournament backend feeding a client — is better served by narrow
 * checks with explicit bounds than by a general one. The JSON Schema in `../schemas` is the
 * normative description for third parties, and `tests/schema.test.ts` checks the two agree on every
 * fixture.
 *
 * Everything here treats its input as untrusted. A QBLive server is somebody else's server.
 */

import {
  QBLIVE_PROTOCOL_VERSION,
  qbliveSectionNames,
  type QbliveAnnouncement,
  type QbliveCapabilities,
  type QbliveCell,
  type QbliveColumn,
  type QbliveDataTable,
  type QbliveEvent,
  type QbliveEventPage,
  type QbliveLiveGame,
  type QbliveManifest,
  type QblivePublicPlayer,
  type QblivePublicRoom,
  type QblivePublicTeam,
  type QblivePublicTournament,
  type QbliveResult,
  type QbliveScheduledGame,
  type QbliveSectionName,
  type QbliveSections,
  type QbliveSnapshot,
  type QbliveTimelineEvent,
} from './types.js';

/**
 * Bounds.
 *
 * These are not tuned to any tournament; they are the point past which a document stops being a
 * quiz bowl tournament and starts being an attack on a phone with 3 GB of RAM.
 */
export const qbliveLimits = {
  maxTeams: 512,
  maxPlayersPerTeam: 32,
  maxRooms: 256,
  maxScheduleEntries: 8192,
  maxResults: 8192,
  maxLiveGames: 256,
  maxTimelineEvents: 512,
  maxTables: 64,
  maxTableRows: 2048,
  maxTableColumns: 48,
  maxAnnouncements: 256,
  maxStringLength: 4096,
  maxBodyBytes: 8 * 1024 * 1024,
  maxEventsPerPage: 256,
} as const;

export class QbliveValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'QbliveValidationError';
    this.path = path;
  }
}

function fail(path: string, message: string): never {
  throw new QbliveValidationError(path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (value.length > qbliveLimits.maxStringLength) fail(path, 'string is too long');
  return value;
}

function optionalStr(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return str(value, path);
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value;
}

function optionalNum(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return num(value, path);
}

function int(value: unknown, path: string): number {
  const parsed = num(value, path);
  if (!Number.isInteger(parsed)) fail(path, 'expected an integer');
  return parsed;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

function list(value: unknown, path: string, limit: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  if (value.length > limit) fail(path, `array has more than ${limit} entries`);
  return value;
}

function ids(value: unknown, path: string, limit: number): string[] {
  return list(value, path, limit).map((entry, index) => str(entry, `${path}[${index}]`));
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const parsed = str(value, path);
  if (!(allowed as readonly string[]).includes(parsed)) fail(path, `expected one of ${allowed.join(', ')}`);
  return parsed as T;
}

/**
 * An ISO 8601 instant that carries an explicit offset.
 *
 * A bare local time is rejected rather than assumed to be UTC: an unqualified "13:30" published by
 * one server and read by a phone in another zone is exactly the class of bug the tournament
 * timezone exists to prevent.
 */
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: unknown, path: string): string {
  const parsed = str(value, path);
  if (!timestampPattern.test(parsed)) fail(path, 'expected an ISO 8601 timestamp with an explicit offset');
  if (Number.isNaN(Date.parse(parsed))) fail(path, 'timestamp is not a real instant');
  return parsed;
}

function optionalTimestamp(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return timestamp(value, path);
}

function protocolVersion(value: unknown, path: string): typeof QBLIVE_PROTOCOL_VERSION {
  const parsed = int(value, path);
  if (parsed !== QBLIVE_PROTOCOL_VERSION) fail(path, `unsupported QBLive protocol version ${parsed}`);
  return QBLIVE_PROTOCOL_VERSION;
}

export function parseCapabilities(value: unknown, path = 'capabilities'): QbliveCapabilities {
  const raw = record(value, path);
  if (raw.snapshot !== true) fail(`${path}.snapshot`, 'a QBLive server must serve snapshots');
  return {
    snapshot: true,
    events: raw.events === true,
    stream: raw.stream === true,
    applePush: raw.applePush === true,
    minimumReplayRevision:
      raw.minimumReplayRevision === undefined || raw.minimumReplayRevision === null
        ? undefined
        : int(raw.minimumReplayRevision, `${path}.minimumReplayRevision`),
  };
}

export function parseTournament(value: unknown, path = 'tournament'): QblivePublicTournament {
  const raw = record(value, path);
  return {
    id: str(raw.id, `${path}.id`),
    name: str(raw.name, `${path}.name`),
    date: optionalStr(raw.date, `${path}.date`),
    venue: optionalStr(raw.venue, `${path}.venue`),
    organizer: optionalStr(raw.organizer, `${path}.organizer`),
    timeZone: str(raw.timeZone, `${path}.timeZone`),
    status: oneOf(raw.status, `${path}.status`, ['upcoming', 'in-progress', 'complete'] as const),
  };
}

function parsePlayer(value: unknown, path: string): QblivePublicPlayer {
  const raw = record(value, path);
  return {
    id: str(raw.id, `${path}.id`),
    name: str(raw.name, `${path}.name`),
    teamId: str(raw.teamId, `${path}.teamId`),
  };
}

export function parseTeams(value: unknown, path = 'teams'): QblivePublicTeam[] {
  return list(value, path, qbliveLimits.maxTeams).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    const players =
      raw.players === undefined
        ? undefined
        : list(raw.players, `${at}.players`, qbliveLimits.maxPlayersPerTeam).map((player, playerIndex) =>
            parsePlayer(player, `${at}.players[${playerIndex}]`),
          );
    return {
      id: str(raw.id, `${at}.id`),
      name: str(raw.name, `${at}.name`),
      organization: optionalStr(raw.organization, `${at}.organization`),
      seed: optionalNum(raw.seed, `${at}.seed`),
      ...(players ? { players } : {}),
    };
  });
}

export function parseRooms(value: unknown, path = 'rooms'): QblivePublicRoom[] {
  return list(value, path, qbliveLimits.maxRooms).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      id: str(raw.id, `${at}.id`),
      name: str(raw.name, `${at}.name`),
      building: optionalStr(raw.building, `${at}.building`),
      directions: optionalStr(raw.directions, `${at}.directions`),
    };
  });
}

export function parseTimeline(value: unknown, path = 'timeline'): QbliveTimelineEvent[] {
  return list(value, path, qbliveLimits.maxTimelineEvents).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      id: str(raw.id, `${at}.id`),
      type: oneOf(raw.type, `${at}.type`, [
        'round',
        'lunch',
        'break',
        'check-in',
        'awards',
        'ceremony',
        'custom',
      ] as const),
      title: str(raw.title, `${at}.title`),
      description: optionalStr(raw.description, `${at}.description`),
      scheduledStart: optionalTimestamp(raw.scheduledStart, `${at}.scheduledStart`),
      scheduledEnd: optionalTimestamp(raw.scheduledEnd, `${at}.scheduledEnd`),
      teamIds: ids(raw.teamIds ?? [], `${at}.teamIds`, qbliveLimits.maxTeams),
      roomId: optionalStr(raw.roomId, `${at}.roomId`),
      location: optionalStr(raw.location, `${at}.location`),
    };
  });
}

export function parseSchedule(value: unknown, path = 'schedule'): QbliveScheduledGame[] {
  return list(value, path, qbliveLimits.maxScheduleEntries).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      id: str(raw.id, `${at}.id`),
      roundId: str(raw.roundId, `${at}.roundId`),
      roundName: str(raw.roundName, `${at}.roundName`),
      roundNumber: optionalNum(raw.roundNumber, `${at}.roundNumber`),
      phaseId: optionalStr(raw.phaseId, `${at}.phaseId`),
      phaseName: optionalStr(raw.phaseName, `${at}.phaseName`),
      poolId: optionalStr(raw.poolId, `${at}.poolId`),
      poolName: optionalStr(raw.poolName, `${at}.poolName`),
      teamIds: ids(raw.teamIds, `${at}.teamIds`, 2),
      roomId: optionalStr(raw.roomId, `${at}.roomId`),
      scheduledStart: optionalTimestamp(raw.scheduledStart, `${at}.scheduledStart`),
      state: oneOf(raw.state, `${at}.state`, ['upcoming', 'live', 'final', 'bye', 'cancelled'] as const),
    };
  });
}

function parseScores(value: unknown, path: string): { teamId: string; score: number }[] {
  return list(value, path, 2).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return { teamId: str(raw.teamId, `${at}.teamId`), score: num(raw.score, `${at}.score`) };
  });
}

export function parseResults(value: unknown, path = 'results'): QbliveResult[] {
  return list(value, path, qbliveLimits.maxResults).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      gameId: str(raw.gameId, `${at}.gameId`),
      roundId: str(raw.roundId, `${at}.roundId`),
      scores: parseScores(raw.scores, `${at}.scores`),
      outcome: oneOf(raw.outcome, `${at}.outcome`, ['played', 'forfeit', 'cancelled'] as const),
      acceptedAt: optionalTimestamp(raw.acceptedAt, `${at}.acceptedAt`),
    };
  });
}

export function parseLiveGames(value: unknown, path = 'liveGames'): QbliveLiveGame[] {
  return list(value, path, qbliveLimits.maxLiveGames).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      gameId: str(raw.gameId, `${at}.gameId`),
      roundId: str(raw.roundId, `${at}.roundId`),
      teamIds: ids(raw.teamIds, `${at}.teamIds`, 2),
      roomId: optionalStr(raw.roomId, `${at}.roomId`),
      ...(raw.scores === undefined ? {} : { scores: parseScores(raw.scores, `${at}.scores`) }),
      ...(raw.tossupsRead === undefined ? {} : { tossupsRead: int(raw.tossupsRead, `${at}.tossupsRead`) }),
    };
  });
}

function parseColumn(value: unknown, path: string): QbliveColumn {
  const raw = record(value, path);
  const alignment = raw.alignment;
  return {
    id: str(raw.id, `${path}.id`),
    label: str(raw.label, `${path}.label`),
    // An unrecognised kind is accepted as-is: a client that refused a future column kind would
    // break exactly when Director gained a new statistic, which is the failure the dynamic table
    // exists to avoid. Clients fall back to `display`.
    kind: str(raw.kind, `${path}.kind`) as QbliveColumn['kind'],
    ...(alignment === undefined || alignment === null
      ? {}
      : { alignment: oneOf(alignment, `${path}.alignment`, ['leading', 'center', 'trailing'] as const) }),
    ...(raw.precision === undefined || raw.precision === null
      ? {}
      : { precision: int(raw.precision, `${path}.precision`) }),
    ...(raw.description === undefined || raw.description === null
      ? {}
      : { description: str(raw.description, `${path}.description`) }),
  };
}

function parseCell(value: unknown, path: string): QbliveCell {
  const raw = record(value, path);
  const cellValue = raw.value;
  if (cellValue !== null && typeof cellValue !== 'string' && typeof cellValue !== 'number') {
    fail(`${path}.value`, 'expected a string, a number, or null');
  }
  if (typeof cellValue === 'string' && cellValue.length > qbliveLimits.maxStringLength) {
    fail(`${path}.value`, 'string is too long');
  }
  if (typeof cellValue === 'number' && !Number.isFinite(cellValue)) {
    fail(`${path}.value`, 'expected a finite number');
  }
  return {
    value: cellValue,
    ...(raw.display === undefined || raw.display === null
      ? {}
      : { display: str(raw.display, `${path}.display`) }),
    ...(raw.entityId === undefined || raw.entityId === null
      ? {}
      : { entityId: str(raw.entityId, `${path}.entityId`) }),
  };
}

export function parseTables(value: unknown, path: string): QbliveDataTable[] {
  return list(value, path, qbliveLimits.maxTables).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    const columns = list(raw.columns, `${at}.columns`, qbliveLimits.maxTableColumns).map(
      (column, columnIndex) => parseColumn(column, `${at}.columns[${columnIndex}]`),
    );
    const rows = list(raw.rows, `${at}.rows`, qbliveLimits.maxTableRows).map((row, rowIndex) => {
      const rowPath = `${at}.rows[${rowIndex}]`;
      const rawRow = record(row, rowPath);
      const cells = list(rawRow.cells, `${rowPath}.cells`, qbliveLimits.maxTableColumns).map(
        (cell, cellIndex) => parseCell(cell, `${rowPath}.cells[${cellIndex}]`),
      );
      // A ragged row would silently shift every value one column left on a client that zips the
      // two together, which is a wrong number presented as an official one.
      if (cells.length !== columns.length) fail(`${rowPath}.cells`, 'row does not match the column count');
      return {
        id: str(rawRow.id, `${rowPath}.id`),
        cells,
        ...(rawRow.teamId === undefined || rawRow.teamId === null
          ? {}
          : { teamId: str(rawRow.teamId, `${rowPath}.teamId`) }),
        ...(rawRow.playerId === undefined || rawRow.playerId === null
          ? {}
          : { playerId: str(rawRow.playerId, `${rowPath}.playerId`) }),
      };
    });
    return {
      id: str(raw.id, `${at}.id`),
      title: str(raw.title, `${at}.title`),
      scope: str(raw.scope, `${at}.scope`),
      ...(raw.scopeLabel === undefined || raw.scopeLabel === null
        ? {}
        : { scopeLabel: str(raw.scopeLabel, `${at}.scopeLabel`) }),
      columns,
      rows,
    };
  });
}

export function parseAnnouncements(value: unknown, path = 'announcements'): QbliveAnnouncement[] {
  return list(value, path, qbliveLimits.maxAnnouncements).map((entry, index) => {
    const at = `${path}[${index}]`;
    const raw = record(entry, at);
    return {
      id: str(raw.id, `${at}.id`),
      title: str(raw.title, `${at}.title`),
      body: str(raw.body, `${at}.body`),
      severity: oneOf(raw.severity, `${at}.severity`, ['information', 'important', 'urgent'] as const),
      publishedAt: timestamp(raw.publishedAt, `${at}.publishedAt`),
      updatedAt: optionalTimestamp(raw.updatedAt, `${at}.updatedAt`),
      expiresAt: optionalTimestamp(raw.expiresAt, `${at}.expiresAt`),
      audienceTeamIds: ids(raw.audienceTeamIds ?? [], `${at}.audienceTeamIds`, qbliveLimits.maxTeams),
    };
  });
}

const sectionParsers: { [K in QbliveSectionName]: (value: unknown, path: string) => QbliveSections[K] } = {
  tournament: parseTournament,
  teams: parseTeams,
  rooms: parseRooms,
  timeline: parseTimeline,
  schedule: parseSchedule,
  results: parseResults,
  liveGames: parseLiveGames,
  standings: parseTables,
  statistics: parseTables,
  announcements: parseAnnouncements,
};

export function parseSections(value: unknown, path = 'sections'): Partial<QbliveSections> {
  const raw = record(value, path);
  const sections: Partial<QbliveSections> = {};
  for (const name of qbliveSectionNames) {
    if (raw[name] === undefined) continue;
    // Assigning through a per-key parser keeps the map above exhaustive and the assignment typed.
    (sections as Record<string, unknown>)[name] = sectionParsers[name](raw[name], `${path}.${name}`);
  }
  return sections;
}

export function parseSnapshot(value: unknown, path = 'snapshot'): QbliveSnapshot {
  const raw = record(value, path);
  return {
    protocolVersion: protocolVersion(raw.protocolVersion, `${path}.protocolVersion`),
    publicationId: str(raw.publicationId, `${path}.publicationId`),
    revision: int(raw.revision, `${path}.revision`),
    generatedAt: timestamp(raw.generatedAt, `${path}.generatedAt`),
    capabilities: parseCapabilities(raw.capabilities, `${path}.capabilities`),
    final: bool(raw.final, `${path}.final`),
    tournament: parseTournament(raw.tournament, `${path}.tournament`),
    teams: parseTeams(raw.teams, `${path}.teams`),
    rooms: parseRooms(raw.rooms, `${path}.rooms`),
    timeline: parseTimeline(raw.timeline, `${path}.timeline`),
    schedule: parseSchedule(raw.schedule, `${path}.schedule`),
    results: parseResults(raw.results, `${path}.results`),
    liveGames: parseLiveGames(raw.liveGames, `${path}.liveGames`),
    standings: parseTables(raw.standings, `${path}.standings`),
    statistics: parseTables(raw.statistics, `${path}.statistics`),
    announcements: parseAnnouncements(raw.announcements, `${path}.announcements`),
  };
}

export function parseManifest(value: unknown, path = 'manifest'): QbliveManifest {
  const raw = record(value, path);
  const endpoints = record(raw.endpoints, `${path}.endpoints`);
  return {
    protocolVersion: protocolVersion(raw.protocolVersion, `${path}.protocolVersion`),
    publicationId: str(raw.publicationId, `${path}.publicationId`),
    revision: int(raw.revision, `${path}.revision`),
    generatedAt: timestamp(raw.generatedAt, `${path}.generatedAt`),
    tournament: parseTournament(raw.tournament, `${path}.tournament`),
    capabilities: parseCapabilities(raw.capabilities, `${path}.capabilities`),
    endpoints: {
      snapshot: str(endpoints.snapshot, `${path}.endpoints.snapshot`),
      ...(endpoints.events === undefined || endpoints.events === null
        ? {}
        : { events: str(endpoints.events, `${path}.endpoints.events`) }),
      ...(endpoints.stream === undefined || endpoints.stream === null
        ? {}
        : { stream: str(endpoints.stream, `${path}.endpoints.stream`) }),
    },
    final: bool(raw.final, `${path}.final`),
  };
}

export function parseEvent(value: unknown, path = 'event'): QbliveEvent {
  const raw = record(value, path);
  return {
    revision: int(raw.revision, `${path}.revision`),
    generatedAt: timestamp(raw.generatedAt, `${path}.generatedAt`),
    sections: parseSections(raw.sections, `${path}.sections`),
    ...(raw.final === undefined || raw.final === null ? {} : { final: bool(raw.final, `${path}.final`) }),
  };
}

export function parseEventPage(value: unknown, path = 'events'): QbliveEventPage {
  const raw = record(value, path);
  return {
    protocolVersion: protocolVersion(raw.protocolVersion, `${path}.protocolVersion`),
    publicationId: str(raw.publicationId, `${path}.publicationId`),
    currentRevision: int(raw.currentRevision, `${path}.currentRevision`),
    events: list(raw.events, `${path}.events`, qbliveLimits.maxEventsPerPage).map((entry, index) =>
      parseEvent(entry, `${path}.events[${index}]`),
    ),
    resyncRequired: bool(raw.resyncRequired, `${path}.resyncRequired`),
  };
}

/**
 * Apply an event's sections onto a snapshot, producing the next snapshot.
 *
 * Shared by every client so that Web, iOS and the conformance suite cannot disagree about what
 * "replace this section" means. Returns a new object; the input is not mutated.
 */
export function applyEvent(snapshot: QbliveSnapshot, event: QbliveEvent): QbliveSnapshot {
  return {
    ...snapshot,
    ...event.sections,
    revision: event.revision,
    generatedAt: event.generatedAt,
    final: event.final ?? snapshot.final,
  };
}
