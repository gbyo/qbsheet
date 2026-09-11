import {
  deriveRoundStats,
  type GameStatsRow,
  type RoundStatDefinition,
  type StatsSnapshot,
} from '@qbsheet/tournament-formats';
import type { DirectorState, GameRecord } from '../domain';
import { buildCanonicalSnapshot, overallReportScope, type CanonicalReportScope } from './canonicalReports';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const valueNumber = finiteNumber(value);
  return valueNumber !== null && valueNumber > 0 ? valueNumber : null;
}

function parseRawQbj(value: unknown): UnknownRecord | null {
  if (typeof value !== 'string') return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function qbjObjects(value: unknown): UnknownRecord[] {
  const root = parseRawQbj(value);
  if (!root) return [];
  const objects = Array.isArray(root.objects)
    ? root.objects.map(record).filter((entry): entry is UnknownRecord => entry !== null)
    : [];
  if (objects.length > 0) return objects;
  // A few external tools emit a match-only QBJ object rather than a document
  // wrapper. Accept it as source evidence without making renderers know that.
  return typeof root.type === 'string' ? [root] : [];
}

function objectOfType(objects: readonly UnknownRecord[], type: string): UnknownRecord | null {
  return objects.find((entry) => entry.type === type) ?? null;
}

function qbjMatchFacts(game: GameRecord): {
  tossupsRead: number | null;
  overtimeTossupsRead: number | null;
} {
  const match = objectOfType(qbjObjects(game.rawQbj), 'Match');
  if (!match) return { tossupsRead: null, overtimeTossupsRead: null };
  const tossupsRead = finiteNumber(match.tossups_read);
  const overtimeTossupsRead = finiteNumber(match.overtime_tossups_read);
  return {
    tossupsRead: tossupsRead !== null && tossupsRead >= 0 ? tossupsRead : null,
    overtimeTossupsRead:
      overtimeTossupsRead !== null && overtimeTossupsRead >= 0 ? overtimeTossupsRead : null,
  };
}

function answerTypeLabels(rules: UnknownRecord): string[] {
  if (!Array.isArray(rules.answer_types)) return [];
  return rules.answer_types
    .map(record)
    .filter((entry): entry is UnknownRecord => entry !== null)
    .flatMap((entry) => [entry.label, entry.short_label])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLocaleLowerCase());
}

/**
 * Resolve the strongest historical scoring definition the accepted result
 * itself carries. This intentionally reads raw QBJ only at the canonical report
 * adapter boundary; the static renderer never reopens or interprets source
 * documents.
 */
function qbjRoundDefinition(game: GameRecord): RoundStatDefinition | null {
  const rules = objectOfType(qbjObjects(game.rawQbj), 'ScoringRules');
  if (!rules) return null;
  const regulation = positiveNumber(rules.regulation_tossup_count);
  const maximumRegulation = positiveNumber(rules.maximum_regulation_tossup_count);
  const labels = answerTypeLabels(rules);
  const superpowers = labels.some((label) => /super\s*power/.test(label));
  const powers = labels.some((label) => /power/.test(label) && !/super\s*power/.test(label));
  const maximumBonusScore = positiveNumber(rules.maximum_bonus_score);
  const maximumBonusParts = positiveNumber(rules.maximum_parts_per_bonus);
  const pointsPerBonusPart = positiveNumber(rules.points_per_bonus_part);
  const inferredMaximumBonusScore =
    maximumBonusScore ??
    (maximumBonusParts !== null && pointsPerBonusPart !== null
      ? maximumBonusParts * pointsPerBonusPart
      : null);
  const bonuses =
    inferredMaximumBonusScore !== null ||
    rules.bonuses_bounce_back === true ||
    positiveNumber(rules.minimum_parts_per_bonus) !== null;
  const minimumOvertime = finiteNumber(rules.minimum_overtime_question_count);
  const bouncebacks =
    rules.bonuses_bounce_back === true ? true : rules.bonuses_bounce_back === false ? false : null;
  const lightningCount = positiveNumber(rules.lightning_count_per_team);
  const lightning = lightningCount === null ? null : lightningCount > 0;

  return {
    regulationTossups: regulation,
    regulationLengthFixed:
      regulation === null ? null : maximumRegulation === null ? null : regulation === maximumRegulation,
    overtimeEnabled: minimumOvertime === null ? null : minimumOvertime > 0,
    powers,
    superpowers,
    bonuses,
    bouncebacks,
    lightning,
    maximumBonusScore: bonuses ? inferredMaximumBonusScore : null,
    source: 'qbj',
  };
}

/**
 * A historical definition that cannot be proven stays unknown.
 *
 * In particular, this function never consults `state.tournament.rules`: those
 * are defaults for future/unissued games and issue #686 explicitly forbids
 * reinterpreting an accepted game with whatever defaults happen to be current
 * at report-generation time. #671 can later supply a pinned/corrected or stable
 * legacy-inferred definition at this one adapter boundary.
 */
function unknownHistoricalDefinition(): RoundStatDefinition {
  return {
    regulationTossups: null,
    regulationLengthFixed: null,
    overtimeEnabled: null,
    powers: null,
    superpowers: null,
    bonuses: null,
    bouncebacks: null,
    lightning: null,
    maximumBonusScore: null,
    source: 'unknown',
  };
}

function enrichGame(game: GameStatsRow, source: GameRecord | undefined, state: DirectorState): GameStatsRow {
  const phaseName = game.phaseId ? state.phases.find((phase) => phase.id === game.phaseId)?.name : undefined;
  if (!source) {
    return {
      ...game,
      ...(phaseName ? { phaseName } : {}),
      roundStatDefinition: unknownHistoricalDefinition(),
    };
  }
  const match = qbjMatchFacts(source);
  const definition = qbjRoundDefinition(source) ?? unknownHistoricalDefinition();
  return {
    ...game,
    ...(phaseName ? { phaseName } : {}),
    // #682 carries exact normalized fields when the domain knows them. Raw QBJ
    // is only a stronger fallback for older accepted records where those fields
    // are still null in the canonical GameRecord.
    tossupsRead: game.tossupsRead ?? match.tossupsRead,
    // Absent overtime is a known zero only under definitions with no overtime period.
    overtimeTossupsRead:
      game.overtimeTossupsRead ??
      match.overtimeTossupsRead ??
      (definition.overtimeEnabled === false ? 0 : undefined),
    roundStatDefinition: definition,
  };
}

/**
 * Build the canonical snapshot used for printable reports, with round
 * statistics already derived. Scope is applied by buildCanonicalSnapshot /
 * acceptedGameRecords before this function aggregates anything, which keeps
 * phase/pool/carryover semantics identical to the rest of Director reporting.
 */
export function buildCanonicalRoundStatsSnapshot(
  state: DirectorState,
  scope: CanonicalReportScope = overallReportScope,
  generatedAt = new Date().toISOString(),
): StatsSnapshot {
  const base = buildCanonicalSnapshot(state, scope, generatedAt);
  const sourceById = new Map(state.games.map((game) => [game.id, game]));
  const games = base.games.map((game) => enrichGame(game, sourceById.get(game.gameId), state));
  return {
    ...base,
    games,
    roundStats: deriveRoundStats(games),
  };
}
