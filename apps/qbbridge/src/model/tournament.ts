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
  type GameRecord,
  type FormatWarning,
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

/**
 * A concrete, unplayed Match that YellowFruit already put in the file.
 *
 * This is a suggestion only. QBBridge never treats it as a room assignment, never generates the
 * missing games in a round-robin, and still publishes through its ordinary manual assignment path.
 */
export interface BridgeGameSuggestion {
  id: string;
  roundId: string;
  phaseId: string;
  teamIds: [string, string];
  /** A source location/room label, when the Match carried one. It is never guessed from position. */
  location?: string;
  poolId?: string;
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
  /** Concrete unplayed source Matches, for optional manual prefill in the Rooms view. */
  suggestedGames: BridgeGameSuggestion[];
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

function stringField(source: JsonObject | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function objectField(source: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = source?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function sourceLocation(game: GameRecord): string | undefined {
  // `source` is the original Match object retained by the formats importer. Prefer its explicit
  // location before `_qbtcp.room_id`, whose value may be an internal id rather than a display name.
  return (
    stringField(game.source, ['location', 'room', 'room_name', 'roomName']) ??
    stringField(game.extensions, ['location', 'room', 'room_name', 'roomName']) ??
    stringField(objectField(game.source, '_qbtcp'), ['room_id', 'roomId']) ??
    game.roomId
  );
}

function unplayedGameSuggestion(game: GameRecord, teamIds: ReadonlySet<string>): BridgeGameSuggestion | null {
  // The QBJ importer marks a Match with any tossup/score detail as complete (or forfeit). Keep the
  // status check as a second guard so a custom importer cannot turn a scored game into a suggestion.
  const status = game.status?.toLocaleLowerCase();
  if (game.result !== undefined || (status !== undefined && !['scheduled', 'released'].includes(status))) {
    return null;
  }
  const [leftId, rightId] = game.teamIds;
  if (
    !game.roundId ||
    !game.phaseId ||
    typeof leftId !== 'string' ||
    typeof rightId !== 'string' ||
    leftId === rightId ||
    !teamIds.has(leftId) ||
    !teamIds.has(rightId)
  ) {
    return null;
  }
  const location = sourceLocation(game);
  return {
    id: game.id,
    roundId: game.roundId,
    phaseId: game.phaseId,
    teamIds: [leftId, rightId],
    ...(location === undefined ? {} : { location }),
    ...(game.poolId === undefined ? {} : { poolId: game.poolId }),
  };
}

const bridgeWarningCodes = new Set([
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

const bridgeWarningMetadata =
  /(?:advancement|standings?|ranking|rank|schedule|pool|position|tournament_site|start_date|end_date|yfdata|kind|carryover|tiebreaker|final rank)/i;
const bridgeWarningIdentityOrScoring = /(?:scoring|answer|team|player|registration|match|round|identity)/i;

/**
 * General Director migration warnings are not automatically QBBridge warnings.
 *
 * The formats package still reports every preserved YFT extension, which is valuable to a general
 * importer but noisy and misleading for a one-game bridge. Keep identity/scoring hazards and omit
 * metadata that QBBridge intentionally leaves with YellowFruit, including schedule and standings.
 */
export function bridgeRelevantWarnings(entries: readonly FormatWarning[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => {
          if (bridgeWarningCodes.has(entry.code)) return true;
          if (entry.code !== 'unsupported-field-preserved' && entry.code !== 'unsupported-object-type')
            return false;
          const context = `${entry.path} ${entry.message}`;
          if (bridgeWarningMetadata.test(context)) return false;
          return bridgeWarningIdentityOrScoring.test(context);
        })
        .map((entry) => entry.message),
    ),
  ];
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

  const teamIds = new Set(teams.map((team) => team.id));
  const suggestedGames = imported.games
    .map((game) => unplayedGameSuggestion(game, teamIds))
    .filter((game): game is BridgeGameSuggestion => game !== null);

  // The importer reports one warning per unread extension field, which on a real file is dozens
  // of copies of the same sentence. The operator needs to know what was left behind once.
  const warnings = bridgeRelevantWarnings(report.warnings);

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
      suggestedGames,
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
