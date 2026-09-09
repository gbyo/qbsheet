import type { StatsSnapshot } from '@qbsheet/tournament-formats';
import type { DirectorState } from '../domain';
import { buildCanonicalSnapshot, type CanonicalReportScope } from './canonicalReports';

export type StandingsReportSectionKind = 'final' | 'phase' | 'pool' | 'cumulative';

export interface StandingsReportSection {
  id: string;
  title: string;
  kind: StandingsReportSectionKind;
  scope: CanonicalReportScope;
  snapshot: StatsSnapshot;
  phaseId?: string;
  poolId?: string;
}

export interface CanonicalStandingsReport {
  sections: StandingsReportSection[];
}

function calculatedOverallSnapshot(state: DirectorState, generatedAt: string): StatsSnapshot {
  if (!state.tournament?.finalPlacement) {
    return buildCanonicalSnapshot(state, { label: 'All Games' }, generatedAt);
  }
  const { finalPlacement: _finalPlacement, ...tournament } = state.tournament;
  return buildCanonicalSnapshot({ ...state, tournament }, { label: 'All Games' }, generatedAt);
}

/**
 * Compose the standings sections a human should see in one printable report.
 *
 * This decides tournament progression and scope in Director code; the HTML
 * renderer only receives already-ranked canonical snapshots. A simple event
 * stays one table. Multi-stage events expose stages/pools in configured order,
 * plus a distinct final-ranking overlay and all-games calculated view when
 * those concepts differ.
 */
export function buildCanonicalStandingsReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): CanonicalStandingsReport {
  const phases = state.phases
    .filter((phase) => phase.archived !== true)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const poolsByPhase = new Map(
    phases.map((phase) => [
      phase.id,
      state.pools
        .filter(
          (pool) => pool.phaseId === phase.id && pool.archived !== true && phase.poolIds.includes(pool.id),
        )
        .slice()
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    ]),
  );
  const hasMeaningfulPoolSplit = phases.some((phase) => (poolsByPhase.get(phase.id)?.length ?? 0) > 1);
  const multiStage = phases.length > 1 || hasMeaningfulPoolSplit;

  if (!multiStage) {
    const scope: CanonicalReportScope = { label: 'Overall' };
    return {
      sections: [
        {
          id: 'standings-overall',
          title: state.tournament?.finalPlacement ? 'Final Rankings' : 'Standings',
          kind: state.tournament?.finalPlacement ? 'final' : 'cumulative',
          scope,
          snapshot: buildCanonicalSnapshot(state, scope, generatedAt),
        },
      ],
    };
  }

  const sections: StandingsReportSection[] = [];
  if (state.tournament?.finalPlacement) {
    const scope: CanonicalReportScope = { label: 'Final Rankings' };
    sections.push({
      id: 'standings-final',
      title: 'Final Rankings',
      kind: 'final',
      scope,
      snapshot: buildCanonicalSnapshot(state, scope, generatedAt),
    });
  }

  for (const phase of phases) {
    const pools = poolsByPhase.get(phase.id) ?? [];
    if (pools.length > 1) {
      for (const pool of pools) {
        const scope: CanonicalReportScope = {
          phaseId: phase.id,
          poolId: pool.id,
          label: `${phase.name} · ${pool.name}`,
        };
        sections.push({
          id: `standings-pool-${pool.id}`,
          title: `${phase.name} · ${pool.name}`,
          kind: 'pool',
          scope,
          phaseId: phase.id,
          poolId: pool.id,
          snapshot: buildCanonicalSnapshot(state, scope, generatedAt),
        });
      }
      continue;
    }

    const scope: CanonicalReportScope = { phaseId: phase.id, label: phase.name };
    sections.push({
      id: `standings-phase-${phase.id}`,
      title: phase.name,
      kind: 'phase',
      scope,
      phaseId: phase.id,
      snapshot: buildCanonicalSnapshot(state, scope, generatedAt),
    });
  }

  const cumulativeScope: CanonicalReportScope = { label: 'All Games' };
  sections.push({
    id: 'standings-cumulative',
    title: 'All Games',
    kind: 'cumulative',
    scope: cumulativeScope,
    snapshot: calculatedOverallSnapshot(state, generatedAt),
  });

  return { sections };
}
