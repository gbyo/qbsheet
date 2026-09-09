import type { GamePlayerStatsRow, GameTeamStatsRow } from './reportDetail.js';
import type { PlayerStatsRow, StatsSnapshot, TeamStatsRow } from './stats.js';

export const reportUnknown = '—' as const;

export type ReportPageKey =
  | 'standings'
  | 'individuals'
  | 'games'
  | 'rounds'
  | 'teamDetail'
  | 'playerDetail';

export const reportPageOrder: readonly ReportPageKey[] = [
  'standings',
  'individuals',
  'games',
  'rounds',
  'teamDetail',
  'playerDetail',
];

export const reportPageFiles: Record<ReportPageKey, string> = {
  standings: 'standings.html',
  individuals: 'individuals.html',
  games: 'games.html',
  rounds: 'rounds.html',
  teamDetail: 'teamdetail.html',
  playerDetail: 'playerdetail.html',
};

export const reportPageLabels: Record<ReportPageKey, string> = {
  standings: 'Standings',
  individuals: 'Individuals',
  games: 'Games',
  rounds: 'Rounds',
  teamDetail: 'Teams',
  playerDetail: 'Players',
};

export type ReportPointsMetric = 'ppg' | 'pointsPerX';

export interface ReportOptions {
  pages: ReportPageKey[];
  showPointsForAgainstMargin: boolean;
  pointsMetric: ReportPointsMetric;
  showPapg: boolean;
  showClassifications: boolean;
  showPacket: boolean;
  showStage: boolean;
}

export const defaultReportOptions: ReportOptions = {
  pages: [...reportPageOrder],
  showPointsForAgainstMargin: true,
  pointsMetric: 'ppg',
  showPapg: false,
  showClassifications: true,
  showPacket: true,
  showStage: true,
};

export function normalizeReportOptions(value: unknown): ReportOptions {
  if (!value || typeof value !== 'object') return { ...defaultReportOptions, pages: [...reportPageOrder] };
  const input = value as Partial<ReportOptions>;
  const pages = Array.isArray(input.pages)
    ? reportPageOrder.filter((page) => input.pages!.includes(page))
    : [...reportPageOrder];
  return {
    pages: pages.length > 0 ? pages : [...reportPageOrder],
    showPointsForAgainstMargin:
      typeof input.showPointsForAgainstMargin === 'boolean'
        ? input.showPointsForAgainstMargin
        : defaultReportOptions.showPointsForAgainstMargin,
    pointsMetric:
      input.pointsMetric === 'pointsPerX' || input.pointsMetric === 'ppg'
        ? input.pointsMetric
        : defaultReportOptions.pointsMetric,
    showPapg: typeof input.showPapg === 'boolean' ? input.showPapg : defaultReportOptions.showPapg,
    showClassifications:
      typeof input.showClassifications === 'boolean'
        ? input.showClassifications
        : defaultReportOptions.showClassifications,
    showPacket: typeof input.showPacket === 'boolean' ? input.showPacket : defaultReportOptions.showPacket,
    showStage: typeof input.showStage === 'boolean' ? input.showStage : defaultReportOptions.showStage,
  };
}

export type ReportAnswerKey = 'superpower' | 'power' | 'get' | 'neg';

export interface ReportScoringDefinition {
  /** Stable canonical identity when one is available (for example a future per-game rules snapshot id). */
  id?: string;
  tossupValue: number;
  superpowerValue: number | null;
  powerValue: number | null;
  negValue: number | null;
  useBonuses: boolean;
  tossupCount: number;
  bouncebacks: boolean;
  lightning: boolean;
  overtime: boolean;
}

export interface ReportAnswerColumn {
  /** Semantic identity, never the numeric point value. */
  key: ReportAnswerKey;
  label: string;
  shortLabel: string;
  role: 'positive' | 'negative';
  /** One value when every included definition agrees; null when values differ. */
  pointValue: number | null;
  /** All point values observed for this semantic tier, sorted numerically. */
  pointValues: number[];
}

export interface ReportMetadata {
  tournamentName: string;
  startDate?: string;
  endDate?: string;
  venue?: string;
  questionSet?: string;
  organizer?: string;
  scopeLabel: string;
  generatedAt: string;
}

export interface ReportPresentationCapabilities {
  /** True only when the canonical report DTO can actually carry this statistic. */
  lightningRecorded?: boolean;
  packetRecorded?: boolean;
  stageRecorded?: boolean;
}

export interface ReportPresentation {
  metadata: ReportMetadata;
  options: ReportOptions;
  answerColumns: ReportAnswerColumn[];
  pointsNormalization: { tossups: number; label: string } | null;
  applicability: {
    bonuses: boolean;
    bouncebacks: boolean;
    lightning: boolean;
    overtime: boolean;
    packet: boolean;
    stage: boolean;
  };
  /** Present when one report spans scoring definitions that cannot share one numeric label/denominator. */
  mixedDefinitionNote?: string;
  precision: {
    percentage: number;
    ppg: number;
    rate: number;
    ppb: number;
  };
}

interface BuildReportPresentationInput {
  metadata: ReportMetadata;
  definitions: readonly ReportScoringDefinition[];
  options?: ReportOptions;
  capabilities?: ReportPresentationCapabilities;
}

const answerNames: Record<ReportAnswerKey, { label: string; shortLabel: string; role: 'positive' | 'negative' }> = {
  superpower: { label: 'Superpower', shortLabel: 'Super', role: 'positive' },
  power: { label: 'Power', shortLabel: 'Power', role: 'positive' },
  get: { label: 'Get', shortLabel: 'Get', role: 'positive' },
  neg: { label: 'Neg', shortLabel: 'Neg', role: 'negative' },
};

function valuesFor(definitions: readonly ReportScoringDefinition[], key: ReportAnswerKey): number[] {
  const values = definitions
    .map((definition) => {
      if (key === 'superpower') return definition.superpowerValue;
      if (key === 'power') return definition.powerValue;
      if (key === 'get') return definition.tossupValue;
      return definition.negValue;
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return [...new Set(values)].sort((left, right) => right - left);
}

function enabled(definitions: readonly ReportScoringDefinition[], key: ReportAnswerKey): boolean {
  if (key === 'get') return definitions.length > 0;
  return valuesFor(definitions, key).length > 0;
}

/**
 * Build the one rules-aware presentation contract consumed by every printable page.
 *
 * Answer tiers are keyed by canonical semantic identity, never point value. A mixed event where
 * `power` was 15 in one stage and 20 in another therefore remains one Power column with an explicit
 * mixed-value note rather than being silently split/merged by coincidence of numbers.
 */
export function buildReportPresentation({
  metadata,
  definitions,
  options: rawOptions,
  capabilities = {},
}: BuildReportPresentationInput): ReportPresentation {
  const options = normalizeReportOptions(rawOptions);
  const answerColumns = (['superpower', 'power', 'get', 'neg'] as const)
    .filter((key) => enabled(definitions, key))
    .map((key): ReportAnswerColumn => {
      const pointValues = valuesFor(definitions, key);
      const names = answerNames[key];
      return {
        key,
        ...names,
        pointValue: pointValues.length === 1 ? pointValues[0] : null,
        pointValues,
      };
    });
  const tossupCounts = [
    ...new Set(definitions.map((definition) => definition.tossupCount).filter((count) => count > 0)),
  ];
  const mixedAnswerValues = answerColumns.some((column) => column.pointValues.length > 1);
  const mixedDenominators = tossupCounts.length > 1;
  const mixedDefinitionNote =
    mixedAnswerValues || mixedDenominators
      ? 'Scoring definitions vary within this report. Answer counts stay grouped by stable semantic category; mixed point values are not merged by number, and points-per-X is omitted when regulation tossup counts disagree.'
      : undefined;
  const bonuses = definitions.some((definition) => definition.useBonuses);
  const bouncebacks = bonuses && definitions.some((definition) => definition.bouncebacks);
  const lightningConfigured = definitions.some((definition) => definition.lightning);
  const overtime = definitions.some((definition) => definition.overtime);
  return {
    metadata,
    options,
    answerColumns,
    pointsNormalization:
      tossupCounts.length === 1 ? { tossups: tossupCounts[0], label: `Pts/${tossupCounts[0]}` } : null,
    applicability: {
      bonuses,
      bouncebacks,
      // The rules enabling lightning are not evidence that a result stored lightning detail.
      lightning: lightningConfigured && capabilities.lightningRecorded === true,
      overtime,
      packet: options.showPacket && capabilities.packetRecorded === true,
      stage: options.showStage && capabilities.stageRecorded === true,
    },
    ...(mixedDefinitionNote ? { mixedDefinitionNote } : {}),
    precision: { percentage: 1, ppg: 1, rate: 2, ppb: 2 },
  };
}

export type ReportAnswerCounts = Partial<Record<ReportAnswerKey, number | null>>;

export function semanticAnswerCounts(row: {
  superpowers: number | null;
  powers: number | null;
  gets: number | null;
  negs: number | null;
}): ReportAnswerCounts {
  return {
    superpower: row.superpowers,
    power: row.powers,
    get: row.gets,
    neg: row.negs,
  };
}

export function answerCount(
  row: {
    answerCounts?: ReportAnswerCounts;
    superpowers?: number | null;
    powers?: number | null;
    gets?: number | null;
    negs?: number | null;
  },
  key: ReportAnswerKey,
): number | null {
  const dynamic = row.answerCounts?.[key];
  if (typeof dynamic === 'number' && Number.isFinite(dynamic)) return dynamic;
  const legacy =
    key === 'superpower'
      ? row.superpowers
      : key === 'power'
        ? row.powers
        : key === 'get'
          ? row.gets
          : row.negs;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null;
}

export function pointsPerX(pptuh: number | null | undefined, tossups: number | null | undefined): number | null {
  if (typeof pptuh !== 'number' || !Number.isFinite(pptuh) || typeof tossups !== 'number' || tossups <= 0) {
    return null;
  }
  return pptuh * tossups;
}

export function reportNumber(value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : reportUnknown;
}

export function reportPercent(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : reportUnknown;
}

function legacyPresentation(snapshot: StatsSnapshot): ReportPresentation {
  const hasSuperpowers =
    snapshot.teams.some((row) => row.superpowers > 0) ||
    snapshot.players.some((row) => row.superpowers > 0) ||
    snapshot.games.some(
      (game) =>
        (game.teamStats ?? []).some((row) => (row.superpowers ?? 0) > 0) ||
        (game.playerStats ?? []).some((row) => (row.superpowers ?? 0) > 0),
    );
  const phaseIds = new Set(
    snapshot.games.map((game) => game.phaseId).filter((value): value is string => Boolean(value)),
  );
  const answerColumns: ReportAnswerColumn[] = [
    ...(hasSuperpowers
      ? [{ key: 'superpower' as const, label: 'Superpower', shortLabel: 'Super', role: 'positive' as const, pointValue: null, pointValues: [] }]
      : []),
    { key: 'power', label: 'Power', shortLabel: 'Power', role: 'positive', pointValue: null, pointValues: [] },
    { key: 'get', label: 'Get', shortLabel: 'Get', role: 'positive', pointValue: null, pointValues: [] },
    { key: 'neg', label: 'Neg', shortLabel: 'Neg', role: 'negative', pointValue: null, pointValues: [] },
  ];
  return {
    metadata: {
      tournamentName: snapshot.tournament.name,
      scopeLabel: typeof snapshot.extensions?.scopeLabel === 'string' ? snapshot.extensions.scopeLabel : 'Overall',
      generatedAt: snapshot.generatedAt,
    },
    options: { ...defaultReportOptions, pages: [...reportPageOrder] },
    answerColumns,
    pointsNormalization: null,
    applicability: {
      bonuses: true,
      bouncebacks: snapshot.games.some((game) =>
        (game.teamStats ?? []).some((row) => typeof row.bouncebacks === 'number' && row.bouncebacks > 0),
      ),
      lightning: false,
      overtime: snapshot.games.some((game) => typeof game.overtimeTossupsRead === 'number'),
      packet: snapshot.games.some((game) => Boolean(game.packetName)),
      stage: phaseIds.size > 1,
    },
    precision: { percentage: 1, ppg: 1, rate: 2, ppb: 2 },
  };
}

export function reportPresentationOf(snapshot: StatsSnapshot): ReportPresentation {
  return snapshot.presentation ?? legacyPresentation(snapshot);
}

declare module './stats.js' {
  interface TeamStatsRow {
    answerCounts?: ReportAnswerCounts;
    pointsPerX?: number | null;
  }
  interface PlayerStatsRow {
    answerCounts?: ReportAnswerCounts;
    pointsPerX?: number | null;
  }
  interface StatsSnapshot {
    presentation?: ReportPresentation;
  }
}

declare module './reportDetail.js' {
  interface GameTeamStatsRow {
    answerCounts?: ReportAnswerCounts;
  }
  interface GamePlayerStatsRow {
    answerCounts?: ReportAnswerCounts;
  }
}

// Keep module augmentations alive in declaration emit while documenting their public targets.
export type RulesAwareRows = TeamStatsRow | PlayerStatsRow | GameTeamStatsRow | GamePlayerStatsRow;
