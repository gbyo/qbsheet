/**
 * The YellowFruit file, read once, as much of it as a room needs and no more.
 *
 * # One parser, and it is not this one
 *
 * `readYellowFruitTournament` in `@qbsheet/tournament-formats` already turns a stock `.yft` into
 * canonical QBJ records. QBBridge writes no second `.yft` parser; this module picks the handful of
 * things an assignment is built from out of what that importer returns, and drops the rest.
 *
 * Dropped deliberately: standings, rankings, calculated advancement, final placements, statistics,
 * and every game already in the file. The imported schedule template is retained as read-only
 * context; QBBridge publishes rounds that have not been played and YellowFruit remains the authority
 * on everything that has.
 *
 * # Two views of the same import
 *
 * The importer returns both a typed record model and the canonical QBJ document it built. Most of
 * what QBBridge needs is in the record model. `Registration` objects are the exception: they stay
 * nested under the Tournament in the document, so the record model reports none, and an assignment
 * that invented registration ids would lose identity that the file actually carries. Those are
 * read from the document.
 */

import {
  readYellowFruitTournament,
  yellowFruitScoringRules,
  type JsonObject,
  type YellowFruitScheduleDescription,
} from '@qbsheet/tournament-formats';

export interface BridgePlayer {
  id: string;
  name: string;
}

export interface BridgeTeam {
  id: string;
  name: string;
  /** The school registration this team belongs to, preserved from the file. */
  registrationId: string;
  registrationName: string;
  players: BridgePlayer[];
  /** Pool names this team sits in, for display and filtering only. Never a pairing rule. */
  poolNames: string[];
}

export interface BridgeRound {
  id: string;
  /**
   * `Round.name` exactly as YellowFruit spelled it — usually a bare number.
   *
   * Not a display string. Stock YellowFruit's importer resolves a round by running `parseInt` over
   * this field, so rewriting `"4"` into `"Round 4"` produces a result file that looks right and
   * imports as "couldn't find a round". See `TournamentManager.importMatchesFromWholeQbj`.
   */
  qbjName: string;
  /** The number parsed out of the name, when there was one. Display and filenames only. */
  number?: number;
  phaseId: string;
  phaseName: string;
}

export interface BridgeTournament {
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
  teams: BridgeTeam[];
  rounds: BridgeRound[];
  playerCount: number;
}

export type LoadTournamentResult =
  { ok: true; tournament: BridgeTournament; warnings: string[] } | { ok: false; errors: string[] };

const scoringRulesId = 'ScoringRules_QBBridge';

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

/** Read a stock YellowFruit `.yft`. Nothing here is written back; the file is never modified. */
export function loadYellowFruitTournament(contents: string): LoadTournamentResult {
  const report = readYellowFruitTournament(contents);
  if (!report.ok) return { ok: false, errors: report.errors.map((entry) => entry.message) };

  const imported = report.value.tournament;
  const rulesResult = yellowFruitScoringRules(imported.rules, { id: scoringRulesId });
  if (!rulesResult.ok) return { ok: false, errors: [rulesResult.error] };

  const registrations = registrationIndex(report.value.document.objects);
  const phaseName = new Map(imported.phases.map((phase) => [phase.id, phase.name]));
  const poolsByTeam = new Map<string, string[]>();
  for (const pool of imported.pools) {
    for (const teamId of pool.teamIds ?? []) {
      poolsByTeam.set(teamId, [...(poolsByTeam.get(teamId) ?? []), pool.name]);
    }
  }
  const playersByTeam = new Map<string, BridgePlayer[]>();
  for (const team of imported.teams) {
    const roster = (team.players ?? []).map((player) => ({ id: player.id, name: player.name }));
    playersByTeam.set(team.id, roster);
  }

  const teams: BridgeTeam[] = imported.teams.map((team) => {
    const registration = registrations.get(team.id);
    return {
      id: team.id,
      name: team.displayName ?? team.name,
      // A team whose file carried no registration still needs one in an assignment; name it after
      // the team rather than inventing a school the file does not claim.
      registrationId: registration?.id ?? `Registration_${team.id}`,
      registrationName: registration?.name ?? team.displayName ?? team.name,
      players: playersByTeam.get(team.id) ?? [],
      poolNames: poolsByTeam.get(team.id) ?? [],
    };
  });

  const rounds: BridgeRound[] = imported.rounds.map((round) => ({
    id: round.id,
    qbjName: round.qbjName ?? round.name,
    ...(round.number !== undefined ? { number: round.number } : {}),
    phaseId: round.phaseId ?? '',
    phaseName: round.phaseId ? (phaseName.get(round.phaseId) ?? '') : '',
  }));

  // The importer reports one warning per unread extension field, which on a real file is dozens
  // of copies of the same sentence. The operator needs to know what was left behind once.
  const warnings = [
    ...new Set(
      report.warnings.filter((entry) => entry.code !== 'yft-import-summary').map((entry) => entry.message),
    ),
  ];

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
      playerCount: teams.reduce((total, team) => total + team.players.length, 0),
    },
    warnings,
  };
}

/** A one-line description of the format, for the setup panel. Display only. */
export function formatSummary(tournament: BridgeTournament): string[] {
  const rules = tournament.rules;
  const answerTypes = (rules.answer_types as unknown as JsonObject[]) ?? [];
  const values = answerTypes.map((entry) => String(entry.value)).join(' / ');
  const lines = [
    typeof rules.name === 'string' && rules.name ? rules.name : 'Scoring rules',
    tournament.timed === null ? 'Timed setting not stated' : tournament.timed ? 'Timed' : 'Untimed',
    `${rules.maximum_regulation_tossup_count} max tossups`,
    values,
  ];
  if (rules.maximum_bonus_score !== undefined) {
    const parts =
      rules.minimum_parts_per_bonus === rules.maximum_parts_per_bonus
        ? `${rules.maximum_parts_per_bonus}`
        : `${rules.minimum_parts_per_bonus}–${rules.maximum_parts_per_bonus}`;
    lines.push(`${rules.maximum_bonus_score}-point bonuses, ${parts} parts`);
    if (rules.bonuses_bounce_back === true) lines.push('Bouncebacks');
  } else {
    lines.push('No bonuses');
  }
  if (typeof rules.lightning_count_per_team === 'number' && rules.lightning_count_per_team > 0) {
    lines.push(`${rules.lightning_count_per_team} lightning rounds per team`);
  }
  return lines;
}
