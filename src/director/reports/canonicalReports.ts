/**
 * The canonical reporting adapter.
 *
 * Director, Live, CSV, HTML, advancement, and SQBS must never disagree about
 * who is first, so report surfaces are derived from the canonical standings
 * engine (`@qbsheet/tournament-domain`) and serialized through the shared
 * snapshot DTO. Round-level competitive aggregates are likewise delegated to
 * the pure tournament-domain derivation: this adapter only resolves canonical
 * per-game facts, including historical QBJ denominators, into that input.
 */

import {
  acceptedGameRecords,
  applyFinalPlacement,
  bonusPartsAreRegular,
  bouncebackPartsHeardForTeam,
  defaultRules,
  derivePlayerStandings,
  deriveTeamStandings,
  gameDetailedCountsKnown,
  orderDayItems,
  playerHasAppearance,
  playerPoints,
  regulationDerivationForTeam,
  rulesForGame,
  scoringValuesForGameRecord,
  type DirectorState,
  type GameRecord,
  type TeamGameScore,
  type TournamentRules,
} from '../domain';
import {
  deriveRoundStats,
  type GamePlayerStatsRow,
  type GameStatsRow,
  type GameTeamStatsRow,
  type PlayerStatsRow,
  type RoundStatDefinition,
  type StatsSnapshot,
  type TeamStatsRow,
} from '@qbsheet/tournament-formats';
import { classificationLabels, teamClassificationsOf } from '../standings/statsDisplay';

export interface CanonicalReportScope {
  phaseId?: string;
  poolId?: string;
  label: string;
}

export const overallReportScope: CanonicalReportScope = { label: 'Overall' };

/**
 * Canonical per-game team TUH: the exact match tossups-read count (#746).
 *
 * Both sides hear the same tossups, so this is a game fact. Summing player exposure here
 * would double-count shared tossups and shift with substitutions; a game without an exact
 * count reports null (unknown), never a fabricated partial sum.
 */
function teamTossupsHeard(game: GameRecord): number | null {
  return typeof game.tossupsRead === 'number' &&
    Number.isInteger(game.tossupsRead) &&
    Number.isFinite(game.tossupsRead) &&
    game.tossupsRead >= 0
    ? game.tossupsRead
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function qbjObjects(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.objects)) return value.objects.filter(isRecord);
  return [value];
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePositive(value: unknown): number | null {
  const number = finiteNonNegative(value);
  return number !== null && number > 0 ? number : null;
}

function refId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.$ref === 'string' && value.$ref.trim()) return value.$ref;
  if (typeof value.id === 'string' && value.id.trim()) return value.id;
  return null;
}

interface HistoricalGameDefinition {
  tossupsRead: number | null;
  overtimeTossupsRead: number | null;
  regulationTossupCount: number | null;
  maximumBonusScore: number | null;
  superpowerApplicable: boolean | null;
  powerApplicable: boolean | null;
  negApplicable: boolean | null;
  bonusApplicable: boolean | null;
}

function historicalGameDefinition(game: GameRecord): HistoricalGameDefinition {
  const objects = qbjObjects(game.rawQbj);
  const matches = objects.filter((entry) => entry.type === 'Match');
  const match =
    matches.find((entry) => entry.id === game.scheduledGameId || entry.id === game.id) ??
    (matches.length === 1 ? matches[0] : undefined);
  const tournament = objects.find((entry) => entry.type === 'Tournament');
  const scoringRef = refId(tournament?.scoring_rules);
  const scoringRules =
    (scoringRef
      ? objects.find((entry) => entry.type === 'ScoringRules' && entry.id === scoringRef)
      : undefined) ??
    (objects.filter((entry) => entry.type === 'ScoringRules').length === 1
      ? objects.find((entry) => entry.type === 'ScoringRules')
      : undefined);

  const answerTypes =
    scoringRules && Array.isArray(scoringRules.answer_types) ? scoringRules.answer_types : null;
  const resolvedAnswerTypes =
    answerTypes?.map((entry) => {
      if (isRecord(entry) && entry.type === 'AnswerType') return entry;
      const id = refId(entry);
      return id ? objects.find((object) => object.type === 'AnswerType' && object.id === id) : undefined;
    }) ?? [];
  const answerKind = (answer: Record<string, unknown> | undefined): 'superpower' | 'power' | 'neg' | null => {
    if (!answer) return null;
    const short = typeof answer.short_label === 'string' ? answer.short_label.trim().toUpperCase() : '';
    const label = typeof answer.label === 'string' ? answer.label.trim().toLowerCase() : '';
    if (short === 'SP' || label.includes('superpower')) return 'superpower';
    if (short === 'P' || label === 'power') return 'power';
    if (short === 'N' || label === 'neg' || label.includes('interrupt')) return 'neg';
    return null;
  };
  const kinds = resolvedAnswerTypes.map(answerKind);
  const answerApplicability = (kind: 'superpower' | 'power' | 'neg'): boolean | null => {
    if (!scoringRules || answerTypes === null) return null;
    return kinds.includes(kind);
  };

  let maximumBonusScore = finitePositive(scoringRules?.maximum_bonus_score);
  if (maximumBonusScore === null) {
    const perPart = finitePositive(scoringRules?.points_per_bonus_part);
    const parts = finitePositive(scoringRules?.maximum_parts_per_bonus);
    if (perPart !== null && parts !== null) maximumBonusScore = perPart * parts;
  }
  const bonusFields = [
    'maximum_bonus_score',
    'bonus_divisor',
    'minimum_parts_per_bonus',
    'maximum_parts_per_bonus',
    'points_per_bonus_part',
    'bonuses_bounce_back',
  ];
  const bonusApplicable = scoringRules
    ? bonusFields.some((field) => Object.prototype.hasOwnProperty.call(scoringRules, field))
    : null;

  return {
    tossupsRead: finiteNonNegative(match?.tossups_read),
    overtimeTossupsRead: finiteNonNegative(match?.overtime_tossups_read),
    regulationTossupCount: finitePositive(scoringRules?.regulation_tossup_count),
    maximumBonusScore,
    superpowerApplicable: answerApplicability('superpower'),
    powerApplicable: answerApplicability('power'),
    negApplicable: answerApplicability('neg'),
    bonusApplicable,
  };
}

/**
 * Per-team per-game bonus parts under the game's own historical definition
 * (#748, #751). The adapter resolves the definition once per game through the
 * domain engine; formats code only sums these facts, never re-derives them.
 * Every field is null when the game's detail is missing, its bonuses are
 * irregular, or its bounceback breakdown is unknown — never a fabricated zero.
 */
function teamGameParts(
  state: DirectorState,
  game: GameRecord,
  own: TeamGameScore,
  opponent: TeamGameScore | undefined,
): Pick<
  GameTeamStatsRow,
  'bouncebackPartsHeard' | 'bouncebackPartsConverted' | 'bonusPartsConverted' | 'bonusPartsHeard'
> {
  const declined = {
    bouncebackPartsHeard: null,
    bouncebackPartsConverted: null,
    bonusPartsConverted: null,
    bonusPartsHeard: null,
  };
  if (!gameDetailedCountsKnown(game) || !opponent) return declined;
  const rules = rulesForGame(state, game) ?? defaultRules;
  if (!bonusPartsAreRegular(rules) || !(rules.bonusValue > 0)) return declined;
  const ownParts = {
    bonusPartsConverted: own.bonusPoints / rules.bonusValue,
    bonusPartsHeard: own.bonuses * rules.bonusParts,
  };
  if (rules && !rules.bouncebacks && game.definitionDigest) {
    // The pinned historical definition defines no bouncebacks: bounceback parts
    // are N/A (null), while the team's own bonus parts remain known facts (#755).
    return { ...declined, ...ownParts };
  }
  if (own.bouncebacks === null) return declined;
  const heard = bouncebackPartsHeardForTeam(opponent.bonuses, opponent.bonusPoints, rules);
  if (heard === null) return declined;
  return {
    bouncebackPartsHeard: heard,
    bouncebackPartsConverted: (own.bouncebacks ?? 0) / rules.bonusValue,
    ...ownParts,
  };
}

/**
 * Project the per-game historical definition resolved from the game's own
 * evidence onto the round-stat derivation input. Fields the evidence cannot
 * prove stay null so the derivation declines the metric instead of guessing.
 * Provenance is reported as unknown until per-game definition storage (#671)
 * records where each historical definition came from.
 */
function roundStatDefinitionOf(
  historical: HistoricalGameDefinition,
  rules: TournamentRules | null,
): RoundStatDefinition {
  return {
    regulationTossups: historical.regulationTossupCount,
    regulationLengthFixed: null,
    overtimeEnabled: null,
    powers: historical.powerApplicable,
    superpowers: historical.superpowerApplicable,
    bonuses: historical.bonusApplicable,
    // Applicability for N/A-scoping comes from the resolved historical rules —
    // the same source the canonical aggregation uses — never a numeric probe of
    // the stored breakdowns (#755).
    bouncebacks: rules ? rules.bouncebacks : null,
    lightning: rules ? rules.lightning : null,
    maximumBonusScore: historical.maximumBonusScore,
    source: 'unknown',
  };
}

export function buildCanonicalSnapshot(
  state: DirectorState,
  scope: CanonicalReportScope = overallReportScope,
  generatedAt = new Date().toISOString(),
): StatsSnapshot {
  const scoped = {
    ...(scope.phaseId !== undefined ? { phaseId: scope.phaseId } : {}),
    ...(scope.poolId !== undefined ? { poolId: scope.poolId } : {}),
  };
  const isOverall = scope.phaseId === undefined && scope.poolId === undefined;
  const calculated = deriveTeamStandings(state, undefined, scoped);
  const calculatedRank = new Map(calculated.map((standing, index) => [standing.teamId, index + 1]));
  const ordered = isOverall ? applyFinalPlacement(calculated, state.tournament?.finalPlacement) : calculated;

  const roundName = new Map(state.rounds.map((round) => [round.id, round.name]));
  const roundPhase = new Map(state.rounds.map((round) => [round.id, round.phaseId]));
  const phaseName = new Map(state.phases.map((phase) => [phase.id, phase.name]));
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const packetName = new Map(state.packets.map((packet) => [packet.id, packet.name]));
  const teamName = (teamId: string | undefined): string =>
    state.teams.find((team) => team.id === teamId)?.displayName ?? teamId ?? '';
  const playerName = (playerId: string): string =>
    state.players.find((player) => player.id === playerId)?.name ?? playerId;
  const dayIndex = new Map<string, number>();
  orderDayItems(state.rounds, state.timeline).forEach((entry, index) => {
    if (entry.kind === 'round' && entry.round) dayIndex.set(entry.round.id, index);
  });

  const teams: TeamStatsRow[] = ordered.map((standing, index) => {
    const classifications = teamClassificationsOf(state, standing.teamId).map(
      (entry) => classificationLabels[entry],
    );
    return {
      rank: index + 1,
      ...(calculatedRank.get(standing.teamId) !== index + 1
        ? { calculatedRank: calculatedRank.get(standing.teamId) }
        : {}),
      teamId: standing.teamId,
      teamName: teamName(standing.teamId),
      ...(classifications.length > 0 ? { classifications } : {}),
      gamesPlayed: standing.gamesPlayed,
      wins: standing.wins,
      losses: standing.losses,
      ties: standing.ties,
      winPercentage: standing.winPercentage,
      pointsFor: standing.pointsFor,
      pointsAgainst: standing.pointsAgainst,
      ppg: standing.gamesPlayed > 0 ? standing.pointsFor / standing.gamesPlayed : 0,
      papg: standing.gamesPlayed > 0 ? standing.pointsAgainst / standing.gamesPlayed : 0,
      margin: standing.margin,
      superpowers: standing.superpowers,
      powers: standing.powers,
      gets: standing.gets,
      negs: standing.negs,
      // Unknown TUH is null, matching the player rows below: a partial sum must not
      // masquerade as a whole-scope zero for consumers that do not check the flag (#754).
      tossupsHeard: standing.tossupsHeardKnown ? standing.tossupsHeard : null,
      tossupsHeardKnown: standing.tossupsHeardKnown,
      tossupsHeardRegulation: standing.tossupsHeardRegulationKnown ? standing.tossupsHeardRegulation : null,
      regulationPoints: regulationDerivationForTeam(standing).regulationPoints,
      pptuh:
        standing.tossupsHeardKnown && standing.tossupsHeard > 0
          ? standing.pointsFor / standing.tossupsHeard
          : null,
      bonusPoints: standing.bonusPoints,
      bonusesHeard: standing.bonuses,
      ppb: standing.bonuses > 0 ? standing.bonusPoints / standing.bonuses : null,
      bouncebackPoints: standing.bouncebackPoints,
      bouncebacksKnown: standing.bouncebacksKnown,
      bouncebackPartsHeard: standing.bouncebackPartsHeard,
      bouncebackPartsConverted: standing.bouncebackPartsConverted,
      bouncebackConversion: standing.bouncebackConversion,
      totalBonusConversion: standing.totalBonusConversion,
      // YellowFruit parity (#747): null marks unknown lightning, never a fabricated zero.
      lightningPoints: standing.lightningKnown ? standing.lightningPoints : null,
      lightningKnown: standing.lightningKnown,
    };
  });

  const players: PlayerStatsRow[] = derivePlayerStandings(state, scoped)
    .filter(playerHasAppearance)
    .map((standing, index) => {
      const player = state.players.find((entry) => entry.id === standing.playerId);
      // Valued per game under each game's own definition inside derivePlayerStandings (#671);
      // revaluing the aggregate buckets with live defaults here would rewrite history.
      const points = standing.points;
      return {
        rank: index + 1,
        playerId: standing.playerId,
        playerName: player?.name ?? standing.playerId,
        teamId: standing.teamId,
        teamName: teamName(standing.teamId),
        ...(typeof player?.schoolYear === 'number' ? { schoolYear: player.schoolYear } : {}),
        // YellowFruit parity (#749): tri-state eligibility; unknown stays null, never false.
        undergraduateEligible:
          typeof player?.undergraduateEligible === 'boolean' ? player.undergraduateEligible : null,
        divisionTwoEligible:
          typeof player?.divisionTwoEligible === 'boolean' ? player.divisionTwoEligible : null,
        gamesPlayed: standing.gamesPlayed,
        gamesPlayedKnown: standing.gamesPlayedKnown,
        tossupsHeard: standing.tossupsHeardKnown ? standing.tossupsHeard : null,
        superpowers: standing.superpowers,
        powers: standing.powers,
        gets: standing.gets,
        negs: standing.negs,
        points,
        ppg: standing.gamesPlayedKnown && standing.gamesPlayed > 0 ? points / standing.gamesPlayed : null,
        pptuh:
          standing.tossupsHeardKnown && standing.tossupsHeard > 0 ? points / standing.tossupsHeard : null,
        // Director scoresheets record bonus points per player but not
        // bonuses heard, so individual PPB is declined (null) rather than
        // estimated. Team PPB above uses the real team-level count.
        bonusesHeard: 0,
        bonusPoints: standing.bonusPoints,
        ppb: null,
      };
    });

  const acceptedGames = acceptedGameRecords(state, scoped)
    .slice()
    .sort(
      (left, right) =>
        (dayIndex.get(left.roundId) ?? Number.MAX_SAFE_INTEGER) -
          (dayIndex.get(right.roundId) ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );
  const games: GameStatsRow[] = acceptedGames.map((game) => {
    const [left, right] = game.scores;
    const scheduled = scheduledById.get(game.scheduledGameId);
    const detailedCountsKnown = gameDetailedCountsKnown(game);
    const resolvedPacketId = game.packetId ?? scheduled?.packetId ?? undefined;
    const historical = historicalGameDefinition(game);
    const teamStats: GameTeamStatsRow[] = game.scores.map((score) => {
      const tossupsHeard = teamTossupsHeard(game);
      const opponent = game.scores.find((entry) => entry.teamId !== score.teamId);
      const parts = teamGameParts(state, game, score, opponent);
      // An absent overtime breakdown is a known zero when the game provably had
      // no overtime (recorded zero overtime tossups, or rules with no overtime
      // period); otherwise the game may predate overtime tracking. Matches the
      // domain regulation derivation and the round-report rule.
      const overtimePoints =
        typeof score.overtimePoints === 'number'
          ? score.overtimePoints
          : game.overtimeTossupsRead === 0 || rulesForGame(state, game)?.overtime === false
            ? 0
            : null;
      return {
        teamId: score.teamId,
        teamName: teamName(score.teamId),
        points: score.score,
        overtimePoints,
        superpowers: detailedCountsKnown ? score.superpowers : null,
        powers: detailedCountsKnown ? score.powers : null,
        gets: detailedCountsKnown ? score.gets : null,
        negs: detailedCountsKnown ? score.negs : null,
        tossupsHeard,
        bonusesHeard: detailedCountsKnown ? score.bonuses : null,
        bonusPoints: detailedCountsKnown ? score.bonusPoints : null,
        ppb: detailedCountsKnown && score.bonuses > 0 ? score.bonusPoints / score.bonuses : null,
        bouncebacks: detailedCountsKnown ? (score.bouncebacks ?? null) : null,
        lightningPoints: detailedCountsKnown ? (score.lightningPoints ?? null) : null,
        ...parts,
      };
    });
    const playerStats: GamePlayerStatsRow[] = game.playerStats.map((stat) => ({
      playerId: stat.playerId,
      playerName: playerName(stat.playerId),
      teamId: stat.teamId,
      teamName: teamName(stat.teamId),
      tossupsHeard: stat.tossupsHeard,
      superpowers: detailedCountsKnown ? stat.superpowers : null,
      powers: detailedCountsKnown ? stat.powers : null,
      gets: detailedCountsKnown ? stat.gets : null,
      negs: detailedCountsKnown ? stat.negs : null,
      bonusPoints: detailedCountsKnown ? stat.bonusPoints : null,
      points: detailedCountsKnown ? playerPoints(stat, scoringValuesForGameRecord(state, game)) : null,
    }));

    const phaseId = roundPhase.get(game.roundId);

    const phaseNameText = phaseId ? phaseName.get(phaseId) : undefined;
    return {
      gameId: game.id,
      roundStatDefinition: roundStatDefinitionOf(historical, rulesForGame(state, game) ?? null),
      ...(phaseId ? { phaseId } : {}),
      ...(phaseNameText ? { phaseName: phaseNameText } : {}),
      roundId: game.roundId,
      ...(scheduled?.poolId ? { poolId: scheduled.poolId } : {}),
      ...(roundName.get(game.roundId) ? { roundName: roundName.get(game.roundId) } : {}),
      ...(resolvedPacketId ? { packetId: resolvedPacketId } : {}),
      ...(resolvedPacketId && packetName.get(resolvedPacketId)
        ? { packetName: packetName.get(resolvedPacketId) }
        : {}),
      ...(game.forfeitedTeamId ? { forfeitedTeamId: game.forfeitedTeamId } : {}),
      teamOneId: left?.teamId ?? '',
      teamOneName: teamName(left?.teamId),
      ...(left?.score === undefined ? {} : { teamOnePoints: left.score }),
      teamTwoId: right?.teamId ?? '',
      teamTwoName: teamName(right?.teamId),
      ...(right?.score === undefined ? {} : { teamTwoPoints: right.score }),
      ...(left && right && left.score !== right.score
        ? { winnerId: left.score > right.score ? left.teamId : right.teamId }
        : {}),
      status: game.status,
      detail:
        game.detailedStats === 'incomplete' || game.detailedStats === 'unknown' ? 'partial' : 'complete',
      // Canonical match TUH lives on the game record; raw-QBJ mining covers legacy records (#746).
      tossupsRead: teamTossupsHeard(game) ?? historical.tossupsRead,
      overtimeTossupsRead:
        typeof game.overtimeTossupsRead === 'number'
          ? game.overtimeTossupsRead
          : historical.overtimeTossupsRead,
      teamStats,
      playerStats,
    };
  });
  const roundReport = deriveRoundStats(games);

  return {
    format: 'qbsheet-stats' as const,
    version: 1,
    generatedAt,
    tournament: {
      id: state.tournament?.id ?? 'tournament',
      name: state.tournament?.name ?? 'Tournament',
    },
    teams,
    players,
    games,
    roundStats: roundReport,
    extensions: {
      scopeLabel: scope.label,
      finalPlacementApplied: isOverall && state.tournament?.finalPlacement !== undefined,
      ...(isOverall && state.tournament?.finalPlacement?.reason
        ? { finalPlacementReason: state.tournament.finalPlacement.reason }
        : {}),
    },
  };
}
