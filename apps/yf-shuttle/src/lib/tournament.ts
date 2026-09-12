/**
 * The YellowFruit file, read once, as much of it as room assignments need and no more.
 *
 * # One parser, and it is not this one
 *
 * The file is read through QBSheet's existing importer (`readYellowFruitTournament` in
 * `@qbsheet/tournament-formats`), exactly as QBBridge does. This module picks the handful of
 * things an assignment is built from out of what that importer returns, and drops the rest.
 *
 * Dropped deliberately: standings, rankings, calculated advancement, final placements,
 * statistics, and every game already in the file. The schedule template is retained as read-only
 * context; YellowFruit remains the authority on everything that has been played.
 *
 * # Raw access, for pools and prelim results only
 *
 * Two things the canonical record model does not carry by shape are read from the raw `.yft`
 * tournament object instead: prelim-pool membership (pool `position` values are not unique, so
 * membership is matched by seed sets) and the scored prelim matches used to *suggest* playoff
 * slot order (see `playoffs.ts`). Both are read-only. Nothing here is ever written back; the
 * source `.yft` is read-only to YF Shuttle.
 */

import {
  readYellowFruitTournament,
  yellowFruitScoringRules,
  type FormatWarning,
  type JsonObject,
  type RoundRecord,
  type YellowFruitScheduleDescription,
} from '@qbsheet/tournament-formats';

export interface ShuttlePlayer {
  id: string;
  name: string;
}

export interface ShuttleTeam {
  id: string;
  name: string;
  /** The school registration this team belongs to, preserved from the file. */
  registrationId: string;
  registrationName: string;
  players: ShuttlePlayer[];
  /** Overall seed (1-based) from the tournament seed order, when the file states one. */
  seed?: number;
}

export interface ShuttleRound {
  id: string;
  /**
   * The name serialized into an assignment's QBJ `Round.name`.
   *
   * Stock YellowFruit resolves a round by running `parseInt` over this field. When YellowFruit
   * supplies a numeric round number, that number wins over a display label.
   */
  qbjName: string;
  /** YellowFruit's display name, which may be nonnumeric. */
  displayName: string;
  /** The numeric identity supplied by YellowFruit, when there was one. */
  number?: number;
  phaseId: string;
  phaseName: string;
}

export interface ShuttlePool {
  id: string;
  name: string;
  phaseId: string;
  phaseName: string;
  teamIds: string[];
}

export interface ShuttlePhase {
  id: string;
  name: string;
  kind: string;
}

export interface ShuttleTournament {
  id: string;
  name: string;
  /** The completed QBJ `ScoringRules` every assignment carries. */
  rules: JsonObject;
  /** YellowFruit's schedule-template metadata, for context only; this app never executes it. */
  schedule: YellowFruitScheduleDescription;
  /** YellowFruit's timed flag, or null when the file did not state it. */
  timed: boolean | null;
  /** What the rules helper derived rather than read. Shown, never hidden. */
  ruleNotes: string[];
  teams: ShuttleTeam[];
  rounds: ShuttleRound[];
  pools: ShuttlePool[];
  phases: ShuttlePhase[];
  playerCount: number;
  /**
   * The raw `.yft` tournament object, parsed but unmodified.
   *
   * Carries pool membership and scored prelim matches for playoff-slot work. Read-only: never
   * mutated, never written anywhere.
   */
  rawTournament: JsonObject;
}

export type LoadTournamentResult =
  | { ok: true; tournament: ShuttleTournament; warnings: string[] }
  | { ok: false; errors: string[] };

const scoringRulesId = 'ScoringRules_YFShuttle';

function registrationIndex(objects: JsonObject[]): Map<string, { id: string; name: string }> {
  const byTeam = new Map<string, { id: string; name: string }>();
  const consider = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const registration = entry as JsonObject;
    if (registration.type !== 'Registration') return;
    const id = typeof registration.id === 'string' ? registration.id : null;
    if (!id) return;
    const name = typeof registration.name === 'string' ? registration.name : id;
    for (const teamRef of Array.isArray(registration.teams) ? registration.teams : []) {
      const teamId =
        typeof teamRef === 'string'
          ? teamRef
          : teamRef && typeof teamRef === 'object' && !Array.isArray(teamRef)
            ? ((teamRef as JsonObject).$ref ?? (teamRef as JsonObject).id)
            : null;
      if (typeof teamId === 'string' && !byTeam.has(teamId)) byTeam.set(teamId, { id, name });
    }
  };
  for (const object of objects) {
    consider(object);
    // YellowFruit nests its registrations inside the Tournament rather than hoisting them.
    if (object.type === 'Tournament' && Array.isArray(object.registrations)) {
      for (const nested of object.registrations) consider(nested);
    }
  }
  return byTeam;
}

function refId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const ref = (value as JsonObject).$ref;
    if (typeof ref === 'string') return ref;
    const id = (value as JsonObject).id;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

/** Overall seed order from the tournament `YfData.seeds` sidecar, as team ids in seed order. */
export function seedOrderOf(rawTournament: JsonObject): string[] {
  const data = rawTournament.YfData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const seeds = (data as JsonObject).seeds;
  if (!Array.isArray(seeds)) return [];
  const order: string[] = [];
  for (const entry of seeds) {
    const id = refId(entry);
    if (id && !order.includes(id)) order.push(id);
  }
  return order;
}

const shuttleWarningCodes = new Set([
  'ambiguous-player-name',
  'ambiguous-team-name',
  'dangling-reference',
  'duplicate-preserved-object',
  'incomplete-answer-counts',
  'invalid-match-teams',
  'missing-tossups-heard',
  'missing-scoring-rules',
  'missing-tournament',
  'multiple-registration-teams',
  'name-fallback',
  'team-answer-counts-not-standard',
  'unresolved-player-reference',
  'unresolved-team-reference',
]);

/** Keep identity/scoring hazards; omit metadata this app intentionally leaves with YellowFruit. */
export function shuttleRelevantWarnings(entries: readonly FormatWarning[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => shuttleWarningCodes.has(entry.code))
        .map((entry) => entry.message),
    ),
  ];
}

/** Read a stock YellowFruit `.yft`. Nothing here is written back; the file is never modified. */
export function loadShuttleTournament(contents: string): LoadTournamentResult {
  const report = readYellowFruitTournament(contents);
  if (!report.ok) return { ok: false, errors: report.errors.map((entry) => entry.message) };

  const imported = report.value.tournament;
  const rulesResult = yellowFruitScoringRules(imported.rules, { id: scoringRulesId });
  if (!rulesResult.ok) return { ok: false, errors: [rulesResult.error] };

  const registrations = registrationIndex(report.value.document.objects);
  const phaseName = new Map(imported.phases.map((phase) => [phase.id, phase.name]));
  const phaseKind = new Map(imported.phases.map((phase) => [phase.id, phase.kind ?? '']));

  let rawTournament: JsonObject;
  try {
    const parsed: unknown = JSON.parse(contents);
    const root = parsed as JsonObject;
    const objects = Array.isArray(root.objects) ? (root.objects as JsonObject[]) : [];
    const found = objects.find((entry) => entry?.type === 'Tournament') ?? objects[0];
    if (!found || typeof found !== 'object') return { ok: false, errors: ['That file has no tournament in it.'] };
    rawTournament = found;
  } catch {
    return { ok: false, errors: ['That file is not valid JSON.'] };
  }

  const seedOrder = seedOrderOf(rawTournament);
  const seedByTeam = new Map<string, number>();
  seedOrder.forEach((id, index) => {
    if (!seedByTeam.has(id)) seedByTeam.set(id, index + 1);
  });

  const playersByTeam = new Map<string, ShuttlePlayer[]>();
  for (const team of imported.teams) {
    playersByTeam.set(
      team.id,
      (team.players ?? []).map((player) => ({ id: player.id, name: player.name })),
    );
  }

  const teams: ShuttleTeam[] = imported.teams.map((team) => {
    const registration = registrations.get(team.id);
    return {
      id: team.id,
      name: team.displayName ?? team.name,
      // A team whose file carried no registration still needs one in an assignment; name it after
      // the team rather than inventing a school the file does not claim.
      registrationId: registration?.id ?? `Registration_${team.id}`,
      registrationName: registration?.name ?? team.displayName ?? team.name,
      players: playersByTeam.get(team.id) ?? [],
      ...(seedByTeam.has(team.id) ? { seed: seedByTeam.get(team.id) } : {}),
    };
  });

  const rounds: ShuttleRound[] = imported.rounds.map((round: RoundRecord) => ({
    id: round.id,
    // Stock YellowFruit's importer only has the serialized name when it resolves the result. A
    // source display label such as "Finals" must therefore use the imported numeric identity.
    qbjName:
      round.number !== undefined && Number.isSafeInteger(round.number)
        ? String(round.number)
        : (round.qbjName ?? round.name),
    displayName: round.name,
    ...(round.number !== undefined ? { number: round.number } : {}),
    phaseId: round.phaseId ?? '',
    phaseName: round.phaseId ? (phaseName.get(round.phaseId) ?? '') : '',
  }));

  const pools: ShuttlePool[] = imported.pools.map((pool) => ({
    id: pool.id,
    name: pool.name,
    phaseId: pool.phaseId ?? '',
    phaseName: pool.phaseId ? (phaseName.get(pool.phaseId) ?? '') : '',
    teamIds: pool.teamIds ?? [],
  }));

  const phases: ShuttlePhase[] = imported.phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    kind: phaseKind.get(phase.id) ?? '',
  }));

  const warnings = shuttleRelevantWarnings(report.warnings);

  return {
    ok: true,
    tournament: {
      id: imported.tournament.id,
      name: imported.tournament.name,
      rules: rulesResult.value.rules,
      schedule: report.value.schedule,
      timed: rulesResult.value.timed,
      ruleNotes: rulesResult.value.notes,
      teams,
      rounds,
      pools,
      phases,
      playerCount: teams.reduce((total, team) => total + team.players.length, 0),
      rawTournament,
    },
    warnings,
  };
}

/** A short fingerprint of the tournament identity: which event this is, not its results. */
export function tournamentIdentityFingerprint(tournament: ShuttleTournament): string {
  const teamIds = [...tournament.teams.map((team) => team.id)].sort();
  const seeds = tournament.teams
    .map((team) => `${team.id}=${team.seed ?? 0}`)
    .sort()
    .join(',');
  return `${tournament.id}::${teamIds.join(',')}::${seeds}`;
}
