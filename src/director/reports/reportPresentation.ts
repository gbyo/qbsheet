import {
  buildReportPresentation,
  defaultReportOptions,
  pointsPerX,
  semanticAnswerCounts,
  type ReportOptions,
  type ReportScoringDefinition,
  type StatsSnapshot,
} from '@qbsheet/tournament-formats';
import type { DirectorState, TournamentRules } from '../domain';

function scoringDefinition(rules: TournamentRules, id?: string): ReportScoringDefinition {
  return {
    ...(id ? { id } : {}),
    tossupValue: rules.tossupValue,
    superpowerValue: rules.superpowerValue,
    powerValue: rules.powerValue,
    negValue: rules.negValue,
    useBonuses: rules.useBonuses,
    tossupCount: rules.tossupCount,
    bouncebacks: rules.bouncebacks,
    lightning: rules.lightning,
    overtime: rules.overtime,
  };
}

/**
 * Every scoring truth any issued game was scored under (#671). The report renderer keys answer
 * columns by semantic tier and notes mixed values explicitly, so a tournament whose power moved
 * from 15 to 20 mid-event prints one Power column with both values rather than silently picking
 * the current default. Tournaments with no issued history fall back to live defaults.
 */
export function stateDefinitions(state: DirectorState): ReportScoringDefinition[] {
  if (state.gameDefinitions.length === 0) {
    const rules = state.tournament?.rules;
    return rules ? [scoringDefinition(rules)] : [];
  }
  const seen = new Set<string>();
  const definitions: ReportScoringDefinition[] = [];
  for (const snapshot of state.gameDefinitions) {
    if (seen.has(snapshot.digest)) continue;
    seen.add(snapshot.digest);
    definitions.push(scoringDefinition(snapshot.rules, snapshot.id));
  }
  return definitions;
}

export interface ReportPresentationInput {
  metadata: {
    tournamentName: string;
    startDate?: string;
    endDate?: string;
    venue?: string;
    questionSet?: string;
    organizer?: string;
    scopeLabel: string;
    generatedAt: string;
  };
  definitions: readonly ReportScoringDefinition[];
  options: ReportOptions;
  capabilities: {
    bouncebacksRecorded: boolean;
    packetRecorded: boolean;
    stageRecorded: boolean;
    lightningRecorded: boolean;
  };
}

/**
 * The shared presentation input for any report page, so the stage-aware Standings page consumes
 * the same definitions/options/capabilities as every other page instead of a second fixed
 * vocabulary (#751). Row enrichment stays with each page adapter; this is only the contract.
 */
export function describeReportInput(
  state: DirectorState,
  snapshot: StatsSnapshot,
  rawOptions: ReportOptions = defaultReportOptions,
  historicalDefinitions?: readonly ReportScoringDefinition[],
): ReportPresentationInput | null {
  const tournament = state.tournament;
  if (!tournament) return null;

  // Per-game issued definitions feed the renderer's mixed-value columns (#671). An explicit
  // override still wins when a caller scopes the report to a subset of history.
  const definitions =
    historicalDefinitions && historicalDefinitions.length > 0
      ? historicalDefinitions
      : stateDefinitions(state);
  const phaseIds = new Set(
    snapshot.games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)),
  );
  return {
    metadata: {
      tournamentName: tournament.name,
      ...(tournament.date ? { startDate: tournament.date } : {}),
      ...(tournament.endDate ? { endDate: tournament.endDate } : {}),
      ...(tournament.venue ? { venue: tournament.venue } : {}),
      ...(tournament.questionSet ? { questionSet: tournament.questionSet } : {}),
      ...(tournament.organizer ? { organizer: tournament.organizer } : {}),
      scopeLabel:
        typeof snapshot.extensions?.scopeLabel === 'string' ? snapshot.extensions.scopeLabel : 'Overall',
      generatedAt: snapshot.generatedAt,
    },
    definitions,
    options: rawOptions,
    capabilities: {
      // A canonical zero is still recorded data. Unknown/null is not.
      bouncebacksRecorded: snapshot.games.some((game) =>
        (game.teamStats ?? []).some((row) => typeof row.bouncebacks === 'number'),
      ),
      packetRecorded: snapshot.games.some((game) => Boolean(game.packetName)),
      stageRecorded: phaseIds.size > 1,
      // Same recorded-data rule as bouncebacks: a canonical number (even zero)
      // proves the breakdown survived; unknown/null does not.
      lightningRecorded: snapshot.games.some((game) =>
        (game.teamStats ?? []).some((row) => typeof row.lightningPoints === 'number'),
      ),
    },
  };
}

/**
 * Apply report-only presentation metadata without mutating competitive Director state.
 *
 * The canonical result rows remain the source of truth. This adapter adds only display semantics:
 * answer-tier identities, public event metadata, selected pages/columns, and derived presentation
 * values such as points-per-X. Report preferences never enter tournament persistence or audit.
 */
export function withReportPresentation(
  state: DirectorState,
  snapshot: StatsSnapshot,
  rawOptions: ReportOptions = defaultReportOptions,
  historicalDefinitions?: readonly ReportScoringDefinition[],
): StatsSnapshot {
  const input = describeReportInput(state, snapshot, rawOptions, historicalDefinitions);
  if (!input) return snapshot;
  const presentation = buildReportPresentation(input);
  const x = presentation.pointsNormalization?.tossups ?? null;

  return {
    ...snapshot,
    teams: snapshot.teams.map((row) => ({
      ...row,
      answerCounts: semanticAnswerCounts(row),
      pointsPerX: pointsPerX(row.pptuh, x),
    })),
    players: snapshot.players.map((row) => ({
      ...row,
      answerCounts: semanticAnswerCounts(row),
      pointsPerX: pointsPerX(row.pptuh, x),
    })),
    games: snapshot.games.map((game) => ({
      ...game,
      teamStats: game.teamStats?.map((row) => ({
        ...row,
        answerCounts: semanticAnswerCounts(row),
      })),
      playerStats: game.playerStats?.map((row) => ({
        ...row,
        answerCounts: semanticAnswerCounts(row),
      })),
    })),
    presentation,
  };
}
