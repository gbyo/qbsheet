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

function scoringDefinition(rules: TournamentRules): ReportScoringDefinition {
  return {
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
  const tournament = state.tournament;
  if (!tournament) return snapshot;

  // GameRecord does not yet persist a historical rules snapshot (#671 owns that canonical storage).
  // The optional seam lets that work feed exact per-game definitions here later without changing any
  // renderer. Until then, the current tournament rules are the only definition we can assert.
  const definitions =
    historicalDefinitions && historicalDefinitions.length > 0
      ? historicalDefinitions
      : [scoringDefinition(tournament.rules)];
  const phaseIds = new Set(
    snapshot.games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)),
  );
  const presentation = buildReportPresentation({
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
      packetRecorded: snapshot.games.some((game) => Boolean(game.packetName)),
      stageRecorded: phaseIds.size > 1,
      // Director's canonical report DTO does not yet retain lightning statistics. A configured
      // lightning round is therefore not enough to print a permanent zero column.
      lightningRecorded: false,
    },
  });
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
