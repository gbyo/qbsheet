import type { RoundReportData, RoundReportRow } from '@qbsheet/tournament-formats';
import {
  acceptedGameRecords,
  gameDetailedCountsKnown,
  orderDayItems,
  type DirectorState,
  type GameRecord,
} from '../domain';
import { matchObject, topLevelObject } from '../transfers/parse';

export interface RoundReportScope {
  phaseId?: string;
  poolId?: string;
  label: string;
}

type JsonRecord = Record<string, unknown>;
type AnswerRole = 'superpower' | 'power' | 'get' | 'neg' | 'other';

interface HistoricalDefinition {
  regulationTossups: number | null;
  maximumBonusScore: number | null;
  powerApplicable: boolean;
  superpowerApplicable: boolean;
  bonusesApplicable: boolean;
  bouncebacksApplicable: boolean;
  lightningApplicable: boolean;
  answerTypes: JsonRecord[];
  fingerprint: string;
}

interface HistoricalGameFacts {
  game: GameRecord;
  teamCount: number;
  points: number;
  tossupsRead: number | null;
  definition: HistoricalDefinition | null;
  answerCountsKnown: boolean;
  positiveConversions: number | null;
  powers: number | null;
  superpowers: number | null;
  negs: number | null;
  lightningPoints: number | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function maximumBonusScore(rules: JsonRecord): number | null {
  const explicit = finite(rules.maximum_bonus_score);
  if (explicit !== null && explicit > 0) return explicit;
  const perPart = finite(rules.points_per_bonus_part);
  const parts = positiveInteger(rules.maximum_parts_per_bonus);
  return perPart !== null && perPart > 0 && parts !== null ? perPart * parts : null;
}

function semanticRole(answerType: JsonRecord): AnswerRole {
  const value = finite(answerType.value);
  const words = [text(answerType.id), text(answerType.label), text(answerType.short_label)]
    .filter((entry): entry is string => entry !== null)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  if (/\bsuper\s*power\b/.test(words) || words.includes('superpower')) return 'superpower';
  if (/\bpower\b/.test(words)) return 'power';
  if (value !== null && value < 0) return 'neg';
  if (value !== null && value > 0) return 'get';
  return 'other';
}

function historicalDefinition(game: GameRecord): HistoricalDefinition | null {
  const rules = topLevelObject(game.rawQbj, 'ScoringRules');
  if (!rules) return null;
  const regulationTossups = positiveInteger(rules.regulation_tossup_count);
  const answerTypes = Array.isArray(rules.answer_types)
    ? rules.answer_types.filter((entry): entry is JsonRecord => isRecord(entry))
    : [];
  const maxBonus = maximumBonusScore(rules);
  const powerApplicable = answerTypes.some((entry) => semanticRole(entry) === 'power');
  const superpowerApplicable = answerTypes.some((entry) => semanticRole(entry) === 'superpower');
  const bonusesApplicable = maxBonus !== null;
  const bouncebacksApplicable = bonusesApplicable && rules.bonuses_bounce_back === true;
  const lightningCount = nonNegativeInteger(rules.lightning_count_per_team);
  const lightningApplicable = lightningCount !== null && lightningCount > 0;
  const normalizedAnswers = answerTypes.map((entry) => ({
    id: text(entry.id),
    label: text(entry.label),
    shortLabel: text(entry.short_label),
    value: finite(entry.value),
    awardsBonus: typeof entry.awards_bonus === 'boolean' ? entry.awards_bonus : null,
    role: semanticRole(entry),
  }));
  return {
    regulationTossups,
    maximumBonusScore: maxBonus,
    powerApplicable,
    superpowerApplicable,
    bonusesApplicable,
    bouncebacksApplicable,
    lightningApplicable,
    answerTypes,
    fingerprint: JSON.stringify({
      regulationTossups,
      answerTypes: normalizedAnswers,
      maximumBonusScore: maxBonus,
      bouncebacksApplicable,
      lightningCount,
    }),
  };
}

function resolveAnswerType(inline: JsonRecord, definition: HistoricalDefinition | null): JsonRecord {
  if (!definition) return inline;
  const reference = text(inline.$ref) ?? text(inline.id);
  if (!reference) return inline;
  return definition.answerTypes.find((entry) => text(entry.id) === reference) ?? inline;
}

function answerFacts(match: JsonRecord | undefined, definition: HistoricalDefinition | null): {
  known: boolean;
  positive: number;
  powers: number;
  superpowers: number;
  negs: number;
} {
  if (!match || !Array.isArray(match.match_teams)) {
    return { known: false, positive: 0, powers: 0, superpowers: 0, negs: 0 };
  }
  let known = true;
  let positive = 0;
  let powers = 0;
  let superpowers = 0;
  let negs = 0;
  for (const team of match.match_teams) {
    if (!isRecord(team) || !Array.isArray(team.match_players)) {
      known = false;
      continue;
    }
    for (const player of team.match_players) {
      if (!isRecord(player) || !Array.isArray(player.answer_counts)) {
        known = false;
        continue;
      }
      for (const count of player.answer_counts) {
        if (!isRecord(count) || !isRecord(count.answer_type)) {
          known = false;
          continue;
        }
        const number = nonNegativeInteger(count.number);
        const resolved = resolveAnswerType(count.answer_type, definition);
        const value = finite(resolved.value) ?? finite(count.answer_type.value);
        if (number === null || value === null) {
          known = false;
          continue;
        }
        if (value > 0) positive += number;
        if (value < 0) negs += number;
        const role = semanticRole({ ...count.answer_type, ...resolved, value });
        if (role === 'power') powers += number;
        if (role === 'superpower') superpowers += number;
      }
    }
  }
  return { known, positive, powers, superpowers, negs };
}

function historicalGameFacts(game: GameRecord): HistoricalGameFacts {
  const match = matchObject(game.rawQbj);
  const definition = historicalDefinition(game);
  const answers = answerFacts(match, definition);
  const tossupsRead = match ? nonNegativeInteger(match.tossups_read) : null;
  const teamCount = Math.max(1, game.scores.length);
  const points = game.scores.reduce((sum, score) => sum + score.score, 0);
  const lightningApplicable = definition?.lightningApplicable === true;
  let lightningPoints: number | null = lightningApplicable ? 0 : null;
  if (lightningApplicable) {
    if (!match || !Array.isArray(match.match_teams) || match.match_teams.length !== teamCount) {
      lightningPoints = null;
    } else {
      for (const team of match.match_teams) {
        const value = isRecord(team) ? finite(team.lightning_points) : null;
        if (value === null) {
          lightningPoints = null;
          break;
        }
        lightningPoints = (lightningPoints ?? 0) + value;
      }
    }
  }
  return {
    game,
    teamCount,
    points,
    tossupsRead,
    definition,
    answerCountsKnown: answers.known,
    positiveConversions: answers.known ? answers.positive : null,
    powers: answers.known ? answers.powers : null,
    superpowers: answers.known ? answers.superpowers : null,
    negs: answers.known ? answers.negs : null,
    lightningPoints,
  };
}

function hasRecordedPlayDetail(game: GameRecord): boolean {
  if (game.detailedStats === 'complete' || game.playerStats.length > 0) return true;
  return game.scores.some(
    (score) =>
      score.superpowers > 0 ||
      score.powers > 0 ||
      score.gets > 0 ||
      score.negs > 0 ||
      score.bonuses > 0 ||
      score.bonusPoints > 0 ||
      score.bouncebacks > 0,
  );
}

function eligibleForScoringAggregates(game: GameRecord): boolean {
  return game.status !== 'forfeit' || hasRecordedPlayDetail(game);
}

function packetLabel(state: DirectorState, games: GameRecord[]): string | null {
  const scheduled = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const packets = new Map(state.packets.map((packet) => [packet.id, packet.name]));
  const labels = games.map((game) => {
    const packetId = game.packetId ?? scheduled.get(game.scheduledGameId)?.packetId ?? null;
    return packetId ? (packets.get(packetId) ?? packetId) : 'Unassigned';
  });
  const unique = [...new Set(labels)];
  if (unique.length === 0 || (unique.length === 1 && unique[0] === 'Unassigned')) return null;
  if (unique.length === 1) return unique[0]!;
  return `Mixed (${unique.join(', ')})`;
}

function aggregateRow(
  state: DirectorState,
  games: GameRecord[],
  identity: { roundId: string; roundName: string; phaseId?: string; phaseName?: string },
): RoundReportRow {
  const playedGames = games.filter(eligibleForScoringAggregates);
  const facts = playedGames.map(historicalGameFacts);
  const detailGames = playedGames.filter(gameDetailedCountsKnown).length;
  const definitionGames = facts.filter((entry) => entry.definition !== null).length;
  const definitionKeys = new Set(
    facts.map((entry) => entry.definition?.fingerprint).filter((key): key is string => Boolean(key)),
  );
  const mixedDefinitions = definitionKeys.size > 1;
  const exactRegulation = facts.map((entry) => entry.definition?.regulationTossups ?? null);
  const regulationTossups =
    exactRegulation.length > 0 &&
    exactRegulation.every((value): value is number => value !== null) &&
    new Set(exactRegulation).size === 1
      ? exactRegulation[0]!
      : null;

  const normalizationKnown =
    facts.length > 0 &&
    facts.every(
      (entry) =>
        entry.tossupsRead !== null &&
        entry.tossupsRead > 0 &&
        entry.definition?.regulationTossups !== null &&
        entry.definition?.regulationTossups !== undefined,
    );
  const teamRegulationEquivalents = normalizationKnown
    ? facts.reduce(
        (sum, entry) =>
          sum +
          entry.teamCount *
            ((entry.tossupsRead as number) / (entry.definition?.regulationTossups as number)),
        0,
      )
    : null;
  const tossupRegulationEquivalents = normalizationKnown
    ? facts.reduce(
        (sum, entry) =>
          sum + (entry.tossupsRead as number) / (entry.definition?.regulationTossups as number),
        0,
      )
    : null;
  const points = facts.reduce((sum, entry) => sum + entry.points, 0);

  const conversionsKnown =
    facts.length > 0 && facts.every((entry) => entry.answerCountsKnown && entry.tossupsRead !== null && entry.tossupsRead > 0);
  const positiveConversions = conversionsKnown
    ? facts.reduce((sum, entry) => sum + (entry.positiveConversions ?? 0), 0)
    : null;
  const tossupsRead = conversionsKnown
    ? facts.reduce((sum, entry) => sum + (entry.tossupsRead ?? 0), 0)
    : null;

  const powerStates = facts.map((entry) => entry.definition?.powerApplicable ?? null);
  const powerApplicable = powerStates.some((value) => value === true);
  const powerComparable =
    powerApplicable &&
    powerStates.every((value) => value !== null) &&
    new Set(powerStates).size === 1 &&
    conversionsKnown;
  const powers = powerComparable ? facts.reduce((sum, entry) => sum + (entry.powers ?? 0), 0) : null;

  const superpowerStates = facts.map((entry) => entry.definition?.superpowerApplicable ?? null);
  const superpowerApplicable = superpowerStates.some((value) => value === true);
  const superpowerComparable =
    superpowerApplicable &&
    superpowerStates.every((value) => value !== null) &&
    new Set(superpowerStates).size === 1 &&
    conversionsKnown;
  const superpowers = superpowerComparable
    ? facts.reduce((sum, entry) => sum + (entry.superpowers ?? 0), 0)
    : null;

  const negsKnown = normalizationKnown && facts.every((entry) => entry.answerCountsKnown);
  const negs = negsKnown ? facts.reduce((sum, entry) => sum + (entry.negs ?? 0), 0) : null;

  const bonusDetailKnown = playedGames.length > 0 && detailGames === playedGames.length;
  const bonusesHeard = bonusDetailKnown
    ? playedGames.reduce(
        (sum, game) => sum + game.scores.reduce((gameSum, score) => gameSum + score.bonuses, 0),
        0,
      )
    : null;
  const bonusPoints = bonusDetailKnown
    ? playedGames.reduce(
        (sum, game) => sum + game.scores.reduce((gameSum, score) => gameSum + score.bonusPoints, 0),
        0,
      )
    : null;
  const bonusesApplicable = facts.some((entry) => entry.definition?.bonusesApplicable === true);

  let bonusPossible = 0;
  let bonusConversionKnown = bonusDetailKnown;
  for (const entry of facts) {
    const heard = entry.game.scores.reduce((sum, score) => sum + score.bonuses, 0);
    if (heard === 0) continue;
    const maximum = entry.definition?.maximumBonusScore ?? null;
    if (maximum === null) {
      bonusConversionKnown = false;
      break;
    }
    bonusPossible += heard * maximum;
  }

  const bouncebacksApplicable = facts.some((entry) => entry.definition?.bouncebacksApplicable === true);
  let bouncebackPoints = 0;
  let bouncebackPossible = 0;
  let bouncebackKnown = bonusDetailKnown;
  for (const entry of facts) {
    if (entry.definition?.bouncebacksApplicable !== true) continue;
    const maximum = entry.definition.maximumBonusScore;
    if (maximum === null) {
      bouncebackKnown = false;
      break;
    }
    const heard = entry.game.scores.reduce((sum, score) => sum + score.bonuses, 0);
    const controlled = entry.game.scores.reduce((sum, score) => sum + score.bonusPoints, 0);
    bouncebackPoints += entry.game.scores.reduce((sum, score) => sum + score.bouncebacks, 0);
    bouncebackPossible += Math.max(0, heard * maximum - controlled);
  }

  const lightningApplicable = facts.some((entry) => entry.definition?.lightningApplicable === true);
  const lightningEntries = facts.filter((entry) => entry.definition?.lightningApplicable === true);
  const lightningKnown =
    lightningEntries.length > 0 && lightningEntries.every((entry) => entry.lightningPoints !== null);
  const lightningPoints = lightningKnown
    ? lightningEntries.reduce((sum, entry) => sum + (entry.lightningPoints ?? 0), 0)
    : null;
  const lightningTeams = lightningKnown
    ? lightningEntries.reduce((sum, entry) => sum + entry.teamCount, 0)
    : null;

  return {
    ...identity,
    packetLabel: identity.roundId === 'report-total' ? null : packetLabel(state, games),
    gameIds: games.map((game) => game.id),
    games: games.length,
    playedGames: playedGames.length,
    detailGames,
    definitionGames,
    regulationTossups,
    mixedDefinitions,
    pointsPerTeamPerXTuh:
      teamRegulationEquivalents !== null && teamRegulationEquivalents > 0
        ? points / teamRegulationEquivalents
        : null,
    powerRate:
      powers !== null && positiveConversions !== null && positiveConversions > 0
        ? powers / positiveConversions
        : null,
    superpowerRate:
      superpowers !== null && positiveConversions !== null && positiveConversions > 0
        ? superpowers / positiveConversions
        : null,
    tossupConversionRate:
      positiveConversions !== null && tossupsRead !== null && tossupsRead > 0
        ? positiveConversions / tossupsRead
        : null,
    negRatePerXTuh:
      negs !== null && tossupRegulationEquivalents !== null && tossupRegulationEquivalents > 0
        ? negs / tossupRegulationEquivalents
        : null,
    ppb:
      bonusesHeard !== null && bonusPoints !== null && bonusesHeard > 0
        ? bonusPoints / bonusesHeard
        : null,
    bonusConversionRate:
      bonusConversionKnown && bonusPoints !== null && bonusPossible > 0 ? bonusPoints / bonusPossible : null,
    bouncebackConversionRate:
      bouncebackKnown && bouncebackPossible > 0 ? bouncebackPoints / bouncebackPossible : null,
    lightningPointsPerTeamPerGame:
      lightningPoints !== null && lightningTeams !== null && lightningTeams > 0
        ? lightningPoints / lightningTeams
        : null,
    applicability: {
      power: powerApplicable,
      superpower: superpowerApplicable,
      bonuses: bonusesApplicable,
      bouncebacks: bouncebacksApplicable,
      lightning: lightningApplicable,
    },
  };
}

/**
 * Canonical Round Report data for one report scope.
 *
 * All historical-definition-dependent inputs come from each accepted game's persisted QBJ result.
 * The current tournament rule set is intentionally not a fallback: legacy games that cannot prove a
 * denominator produce null metrics and visible coverage instead of being reinterpreted.
 */
export function deriveRoundReportData(
  state: DirectorState,
  scope: RoundReportScope,
): RoundReportData {
  const options = {
    ...(scope.phaseId ? { phaseId: scope.phaseId } : {}),
    ...(scope.poolId ? { poolId: scope.poolId } : {}),
  };
  const games = acceptedGameRecords(state, options);
  const byRound = new Map<string, GameRecord[]>();
  for (const game of games) byRound.set(game.roundId, [...(byRound.get(game.roundId) ?? []), game]);

  const dayIndex = new Map<string, number>();
  orderDayItems(state.rounds, state.timeline).forEach((entry, index) => {
    if (entry.kind === 'round' && entry.round) dayIndex.set(entry.round.id, index);
  });
  const phaseName = new Map(state.phases.map((phase) => [phase.id, phase.name]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  const rows = [...byRound.entries()]
    .sort(
      ([left], [right]) =>
        (dayIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (dayIndex.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right),
    )
    .map(([roundId, roundGames]) => {
      const round = roundById.get(roundId);
      return aggregateRow(state, roundGames, {
        roundId,
        roundName: round?.name ?? roundId,
        ...(round?.phaseId ? { phaseId: round.phaseId, phaseName: phaseName.get(round.phaseId) ?? round.phaseId } : {}),
      });
    });

  return {
    scopeLabel: scope.label,
    rows,
    total: aggregateRow(state, games, { roundId: 'report-total', roundName: 'Tournament total' }),
  };
}
