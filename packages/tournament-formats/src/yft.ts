/**
 * Read-only YellowFruit (`.yft`) migration import.
 *
 * YellowFruit persists a nested JSON document whose objects carry no `type`
 * discriminator: phases, rounds, matches, pools, registrations, teams, and
 * players are identified by where they sit in the tree, and scoring rules use
 * snake_case keys. QBSheet's QBJ reader keys off `type` and reads teams,
 * players, matches, registrations, and scoring rules from the top-level
 * `objects` array. This module bridges the two without coupling QBSheet to
 * YellowFruit internals: it normalizes an observed `.yft` file into an
 * equivalent canonical QBJ document (stamping discriminators, hoisting
 * nested entities, synthesizing only the ids YellowFruit never stores) and
 * then delegates to the regular QBJ importer, so all downstream stats,
 * standings, and Director semantics stay canonical.
 *
 * The import is intentionally read-only: there is no `.yft` export. Anything
 * YellowFruit tracks that QBSheet cannot represent is reported as a warning,
 * never silently dropped.
 */

import { importQbj, qbjSerializationVersion, type QbjImportValue } from './qbj';
import type { FormatReport, JsonObject, JsonValue } from './types';
import { asJsonObject, asString, cloneJson, error, fail, ok, slugId, warning } from './util';

export interface YellowFruitImportSummary {
  teams: number;
  players: number;
  games: number;
  scoredGames: number;
  stages: number;
  /** Human-readable list of things present in the file that QBSheet did not carry over. */
  notCarriedOver: string[];
}

export type YellowFruitInput = string | Uint8Array | JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObjectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function refOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isObject(value)) {
    const ref = asString(value.$ref);
    if (ref) return ref;
    return asString(value.id);
  }
  return undefined;
}

/**
 * Conservative YellowFruit detection. The `.yft` extension is the primary
 * router; this only guards against feeding a canonical QBJ document through
 * the normalizer. `YfData` sidecars and `pool_teams` groupings do not exist
 * in canonical QBJ.
 */
export function isYellowFruitDocument(value: unknown): boolean {
  const root = isObject(value) ? value : null;
  const objects = root ? asObjectArray(root.objects) : [];
  if (objects.length === 0) return false;
  const tournament = objects.find((entry) => entry.type === 'Tournament') ?? objects[0];
  if (!isObject(tournament)) return false;
  if ('YfData' in tournament) return true;
  if (isObject(tournament.scoring_rules) && tournament.scoring_rules.$ref === undefined) return true;
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 4 || seen.has(node)) return false;
    if (Array.isArray(node)) {
      seen.add(node);
      return node.some((entry) => visit(entry, depth + 1));
    }
    if (!isObject(node)) return false;
    seen.add(node);
    if ('YfData' in node || 'pool_teams' in node) return true;
    return Object.values(node).some((entry) => visit(entry, depth + 1));
  };
  return visit(tournament, 0);
}

function phaseKindFromYellowFruit(phaseType: unknown): string {
  const normalized = (asString(phaseType) ?? '').trim().toLocaleLowerCase();
  if (normalized.includes('prelim')) return 'preliminary';
  if (normalized.includes('playoff')) return 'playoff';
  if (normalized.includes('final') || normalized.includes('champ')) return 'final';
  if (normalized.includes('place') || normalized.includes('consol')) return 'placement';
  return 'custom';
}

function roundNumberFromName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const match = /round\s+(\d+)/i.exec(name) ?? /^(\d+)$/.exec(name.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeYellowFruit(root: JsonObject): {
  document: { version: string; objects: JsonObject[] };
  summary: YellowFruitImportSummary;
} {
  const notCarriedOver: string[] = [];
  const objects = asObjectArray(root.objects);
  const tournament = objects.find((entry) => entry.type === 'Tournament') ?? objects[0];
  const doc: JsonObject[] = [];
  const hoisted: JsonObject[] = [];
  const hoistedIds = new Set<string>();
  const hoist = (entry: JsonObject): void => {
    const id = asString(entry.id);
    if (id) {
      if (hoistedIds.has(id)) return;
      hoistedIds.add(id);
    }
    hoisted.push(entry);
  };

  const tournamentClone = cloneJson(tournament) as JsonObject;
  tournamentClone.type = 'Tournament';
  if (asString(tournamentClone.id) === undefined) tournamentClone.id = 'Tournament_YellowFruit';
  doc.push(tournamentClone);

  // Tournament metadata: venue, date, question set. YellowFruit stores these
  // under its own keys; map them onto the canonical fields the QBJ reader
  // understands and leave the originals as extensions.
  const site = asJsonObject(tournamentClone.tournament_site);
  if (asString(tournamentClone.location) === undefined && site && asString(site.name) !== undefined)
    tournamentClone.location = asString(site.name) as JsonValue;
  if (asString(tournamentClone.date) === undefined && asString(tournamentClone.start_date) !== undefined)
    tournamentClone.date = tournamentClone.start_date;
  if (asString(tournamentClone.endDate) === undefined && asString(tournamentClone.end_date) !== undefined)
    tournamentClone.endDate = tournamentClone.end_date;
  if (asString(tournamentClone.questionSet) === undefined && asString(tournamentClone.question_set) !== undefined)
    tournamentClone.questionSet = tournamentClone.question_set;

  // Overall seed order lives in the tournament YfData sidecar.
  const tournamentData = asJsonObject(tournamentClone.YfData) ?? {};
  const seedOrder = (Array.isArray(tournamentData.seeds) ? tournamentData.seeds : [])
    .map((entry) => refOf(entry))
    .filter((id): id is string => typeof id === 'string');
  const seedByTeam = new Map<string, number>();
  seedOrder.forEach((id, index) => {
    if (!seedByTeam.has(id)) seedByTeam.set(id, index + 1);
  });

  // Scoring rules: YellowFruit's snake_case keys already match the canonical
  // ScoringRules vocabulary, so hoisting plus a discriminator is enough.
  const scoringRules = asJsonObject(tournamentClone.scoring_rules);
  if (scoringRules) {
    scoringRules.type = 'ScoringRules';
    if (asString(scoringRules.id) === undefined) scoringRules.id = 'ScoringRules_YellowFruit';
    if (asString(scoringRules.name) === undefined && asString(tournamentData.standardRuleSet) !== undefined)
      scoringRules.name = tournamentData.standardRuleSet as JsonValue;
    for (const answerType of asObjectArray(scoringRules.answer_types)) {
      answerType.type = 'AnswerType';
      hoist(answerType);
    }
    hoist(scoringRules);
    tournamentClone.scoring_rules = { $ref: scoringRules.id } as JsonObject;
  } else {
    notCarriedOver.push(
      'The file has no scoring-rules block; Director cannot infer a ruleset for the imported tournament.',
    );
  }

  const overallRankingId =
    asObjectArray(tournamentClone.rankings).find((ranking) => asString(ranking.name) === 'Overall')?.id ??
    'Ranking_Overall';
  const teamPlacements: { teamId: string; rankingId: string | undefined; position: unknown }[] = [];

  // Registrations carry the full roster tree. Hoist teams and players to the
  // top level and rewrite the nesting as references.
  let teamCount = 0;
  let playerCount = 0;
  for (const [index, registration] of asObjectArray(tournamentClone.registrations).entries()) {
    registration.type = 'Registration';
    if (asString(registration.id) === undefined)
      registration.id = slugId('Registration', asString(registration.name) ?? 'school', String(index + 1));
    const teamRefs: JsonObject[] = [];
    for (const team of asObjectArray(registration.teams)) {
      team.type = 'Team';
      const teamId = asString(team.id) ?? slugId('Team', asString(team.name) ?? `team-${teamCount + 1}`);
      team.id = teamId;
      const teamData = asJsonObject(team.YfData) ?? {};
      if (asString(team.letter) === undefined && asString(teamData.letter) !== undefined)
        team.letter = teamData.letter as JsonValue;
      if (typeof team.seed !== 'number' && seedByTeam.has(teamId))
        team.seed = seedByTeam.get(teamId) as number;
      const playerRefs: JsonObject[] = [];
      for (const player of asObjectArray(team.players)) {
        player.type = 'Player';
        if (asString(player.id) === undefined)
          player.id = slugId('Player', asString(player.name) ?? `player-${playerCount + 1}`);
        const playerData = asJsonObject(player.YfData) ?? {};
        // Director reads a structured school year from a plain-integer QBJ
        // grade; free-text year labels stay in YfData rather than being
        // fabricated into a year.
        const yearText =
          asString(playerData.yearString) ??
          (typeof player.year === 'number' ? String(player.year) : undefined);
        const yearDigits = yearText === undefined ? undefined : /^(\d{1,2})/.exec(yearText.trim())?.[1];
        if (asString(player.grade) === undefined && yearDigits !== undefined) player.grade = yearDigits;
        playerCount += 1;
        playerRefs.push({ $ref: player.id } as JsonObject);
        hoist(player);
      }
      team.players = playerRefs;
      for (const rank of asObjectArray(team.ranks)) {
        teamPlacements.push({ teamId, rankingId: refOf(rank.ranking), position: rank.position });
      }
      teamCount += 1;
      teamRefs.push({ $ref: teamId } as JsonObject);
      hoist(team);
    }
    registration.teams = teamRefs;
  }

  // Stages, pools, rounds, and games. YellowFruit phases nest pools, rounds,
  // and matches without ids on pools/rounds; synthesize deterministic ids so
  // pool membership and round context survive the import.
  let gameCount = 0;
  let scoredCount = 0;
  const phases = asObjectArray(tournamentClone.phases);
  phases.forEach((phase, phaseIndex) => {
    phase.type = 'Phase';
    const phaseData = asJsonObject(phase.YfData) ?? {};
    const phaseId =
      asString(phase.id) ??
      slugId('Phase', asString(phaseData.code) ?? asString(phase.name) ?? `stage-${phaseIndex + 1}`);
    phase.id = phaseId;
    phase.kind = phaseKindFromYellowFruit(phaseData.phaseType);
    if (typeof phase.order !== 'number') phase.order = phaseIndex + 1;
    if (Array.isArray(phaseData.wildCardAdvancementRules) && phaseData.wildCardAdvancementRules.length > 0)
      notCarriedOver.push(
        `Wildcard advancement on ${JSON.stringify(phase.name ?? phaseId)} is preserved in extensions but must be re-entered as a Director advancement rule.`,
      );
    for (const [poolIndex, pool] of asObjectArray(phase.pools).entries()) {
      pool.type = 'Pool';
      const position = typeof pool.position === 'number' ? pool.position : poolIndex;
      // NB: YellowFruit pool positions are not unique within a phase (both
      // prelim pools in the wild carry position 1), so the synthesized id
      // uses the pool's index while `order` keeps the file's position.
      if (asString(pool.id) === undefined) pool.id = `${phaseId}__pool_${poolIndex + 1}`;
      if (typeof pool.order !== 'number') pool.order = position + 1;
      pool.teams = asObjectArray(pool.pool_teams)
        .map((entry) => refOf(entry.team))
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({ $ref: id }) as JsonObject);
      delete pool.pool_teams;
      const poolData = asJsonObject(pool.YfData) ?? {};
      if (Array.isArray(poolData.autoAdvanceRules) && poolData.autoAdvanceRules.length > 0)
        notCarriedOver.push(
          `Automatic advancement out of ${JSON.stringify(pool.name ?? pool.id)} is preserved in extensions but must be re-entered as a Director advancement rule.`,
        );
      hoist(pool);
    }
    for (const [roundIndex, round] of asObjectArray(phase.rounds).entries()) {
      round.type = 'Round';
      const roundName = asString(round.name) ?? `Round ${roundIndex + 1}`;
      if (asString(round.id) === undefined) round.id = `${phaseId}__${slugId('round', roundName)}`;
      const roundNumber = roundNumberFromName(roundName);
      if (typeof round.number !== 'number' && roundNumber !== undefined) round.number = roundNumber;
      for (const match of asObjectArray(round.matches)) {
        match.type = 'Match';
        gameCount += 1;
        if (
          match.tossups_read !== undefined ||
          asObjectArray(match.match_teams).some((side) => side.points !== undefined)
        )
          scoredCount += 1;
        const sides = asObjectArray(match.match_teams);
        if (sides.length === 1 && sides[0].forfeit_loss === true)
          notCarriedOver.push(
            `Match ${JSON.stringify(match.id)} records a single-sided forfeit entry; review the generated game before publishing.`,
          );
        hoist(match);
      }
    }
  });

  // Final ranks: YellowFruit stores placements on the teams themselves
  // (team.ranks[] entries pointing at a ranking, with a position once known).
  // An in-progress file only carries ranking shells, which rank nothing.
  const finals = teamPlacements
    .filter((entry) => entry.rankingId === overallRankingId && typeof entry.position === 'number')
    .sort((left, right) => (left.position as number) - (right.position as number))
    .map((entry) => ({ rank: entry.position as number, team: entry.teamId }));
  if (finals.length > 0) tournamentClone.yftFinalRanks = finals as unknown as JsonValue;
  if (tournamentClone.yftFinalRanks === undefined)
    notCarriedOver.push('Final rankings are not stored in this file; Director uses calculated standings.');

  if (tournamentData.usingScheduleTemplate === true)
    notCarriedOver.push(
      'The YellowFruit schedule template is not carried over; pairings come from the imported games.',
    );
  const hasOvertimeDetail = (side: JsonObject): boolean =>
    (asJsonObject(side.YfData)?.overTimeBuzzes ?? undefined) !== undefined;
  const overtimeBuzzes =
    gameCount > 0 &&
    phases.some((phase) =>
      asObjectArray(phase.rounds).some((round) =>
        asObjectArray(round.matches).some((match) =>
          asObjectArray(match.match_teams).some(hasOvertimeDetail),
        ),
      ),
    );
  if (overtimeBuzzes)
    notCarriedOver.push(
      'Per-buzz overtime detail is preserved on the games but does not feed canonical stats.',
    );

  return {
    document: { version: qbjSerializationVersion, objects: [...doc, ...hoisted] },
    summary: {
      teams: teamCount,
      players: playerCount,
      games: gameCount,
      scoredGames: scoredCount,
      stages: phases.length,
      notCarriedOver: [...new Set(notCarriedOver)],
    },
  };
}

const MAX_YFT_BYTES = 8 * 1024 * 1024;

/** Read-only import of a YellowFruit `.yft` file into canonical QBJ records. */
export function readYellowFruitTournament(input: YellowFruitInput): FormatReport<QbjImportValue> {
  let parsed: unknown = input;
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_YFT_BYTES)
      return fail([error('yft-too-large', '', 'The YellowFruit input exceeds the 8 MiB safety limit.')], []);
    try {
      parsed = JSON.parse(new TextDecoder().decode(input));
    } catch {
      return fail([error('invalid-json', '', 'The YellowFruit input is not valid UTF-8 JSON.')], []);
    }
  } else if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_YFT_BYTES)
      return fail([error('yft-too-large', '', 'The YellowFruit input exceeds the 8 MiB safety limit.')], []);
    try {
      parsed = JSON.parse(input);
    } catch {
      return fail([error('invalid-json', '', 'The YellowFruit input is not valid JSON.')], []);
    }
  }
  if (!isObject(parsed))
    return fail([error('yft-not-yellowfruit', '', 'The input is not a YellowFruit tournament file.')], []);
  if (!isYellowFruitDocument(parsed))
    return fail(
      [
        error(
          'yft-not-yellowfruit',
          '',
          'The input does not look like a YellowFruit tournament file (no YellowFruit markers found).',
        ),
      ],
      [],
    );
  const { document, summary } = normalizeYellowFruit(parsed);
  const report = importQbj({ version: document.version, objects: document.objects });
  const warnings = [
    warning(
      'yft-import-summary',
      '',
      `YellowFruit import: ${summary.teams} teams, ${summary.players} players, ${summary.games} games (${summary.scoredGames} scored) across ${summary.stages} stage(s).`,
    ),
    ...summary.notCarriedOver.map((message) => warning('yft-not-carried-over', '', message)),
    ...report.warnings,
  ];
  if (!report.ok) return fail(report.errors, warnings);
  return ok(report.value, warnings);
}
