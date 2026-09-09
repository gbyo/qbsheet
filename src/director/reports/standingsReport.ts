import type {
  CanonicalStandingsReport,
  StandingsAdvancementCell,
  StandingsContextGame,
  StandingsReportSection,
} from '@qbsheet/tournament-formats';
import {
  acceptedGameRecords,
  canonicalCompetitionRanks,
  deriveTeamStandings,
  phaseCompetitiveField,
  previewAdvancement,
  type DirectorState,
  type GameRecord,
  type Phase,
  type Pool,
} from '../domain';
import { buildCanonicalSnapshot, type CanonicalReportScope } from './canonicalReports';

interface BuiltSection {
  section: StandingsReportSection;
  games: GameRecord[];
  phase?: Phase;
}

function calculatedOverallSnapshot(state: DirectorState, generatedAt: string) {
  if (!state.tournament?.finalPlacement) {
    return buildCanonicalSnapshot(state, { label: 'All Games' }, generatedAt);
  }
  const { finalPlacement: _finalPlacement, ...tournament } = state.tournament;
  return buildCanonicalSnapshot({ ...state, tournament }, { label: 'All Games' }, generatedAt);
}

function activePhases(state: DirectorState): Phase[] {
  return state.phases
    .filter((phase) => phase.archived !== true)
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function phasePools(state: DirectorState, phase: Phase): Pool[] {
  return state.pools
    .filter(
      (pool) => pool.phaseId === phase.id && pool.archived !== true && phase.poolIds.includes(pool.id),
    )
    .slice()
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function gamePhaseId(state: DirectorState, game: GameRecord): string | undefined {
  return state.rounds.find((round) => round.id === game.roundId)?.phaseId;
}

function gamePoolId(state: DirectorState, game: GameRecord): string | undefined {
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  return scheduled?.poolId ?? undefined;
}

function fieldTeamIds(state: DirectorState, phase: Phase, pool?: Pool): string[] {
  if (pool) return [...pool.teamIds];
  return phaseCompetitiveField(state, phase.id).teams.map((team) => team.id);
}

function carryoverGames(state: DirectorState, phase: Phase, pool?: Pool): GameRecord[] {
  const field = new Set(fieldTeamIds(state, phase, pool));
  const phases = new Map(state.phases.map((entry) => [entry.id, entry]));
  return acceptedGameRecords(state).filter((game) => {
    const gamePhase = phases.get(gamePhaseId(state, game) ?? '');
    if (!gamePhase) return false;
    const teams = game.scores.map((score) => score.teamId);
    if (teams.length < 2 || teams.some((teamId) => !field.has(teamId))) return false;
    if (gamePhase.id === phase.id) return pool ? gamePoolId(state, game) === pool.id : true;
    return gamePhase.order < phase.order;
  });
}

function carryoverSnapshot(
  state: DirectorState,
  phase: Phase,
  pool: Pool | undefined,
  label: string,
  generatedAt: string,
): { snapshot: ReturnType<typeof buildCanonicalSnapshot>; games: GameRecord[] } {
  const games = carryoverGames(state, phase, pool);
  const gameIds = new Set(games.map((game) => game.id));
  const teamIds = new Set(fieldTeamIds(state, phase, pool));
  const tournament = state.tournament
    ? (({ finalPlacement: _finalPlacement, ...rest }) => rest)(state.tournament)
    : null;
  const narrowed: DirectorState = {
    ...state,
    tournament,
    teams: state.teams.filter((team) => teamIds.has(team.id)),
    games: state.games.filter((game) => gameIds.has(game.id)),
  };
  return { snapshot: buildCanonicalSnapshot(narrowed, { label }, generatedAt), games };
}

function normalSectionSnapshot(
  state: DirectorState,
  scope: CanonicalReportScope,
  generatedAt: string,
): { snapshot: ReturnType<typeof buildCanonicalSnapshot>; games: GameRecord[] } {
  const snapshot = buildCanonicalSnapshot(state, scope, generatedAt);
  const gameIds = new Set(snapshot.games.map((game) => game.gameId));
  return { snapshot, games: acceptedGameRecords(state).filter((game) => gameIds.has(game.id)) };
}

function latestAdvancementCommit(state: DirectorState, sourcePhaseId: string) {
  return state.audit
    .filter(
      (event) =>
        event.type === 'advancement-committed' &&
        event.details?.sourcePhaseId === sourcePhaseId &&
        event.entityId,
    )
    .slice()
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id))
    .at(-1);
}

function assignmentTeamIds(event: ReturnType<typeof latestAdvancementCommit>): Map<string, string | undefined> {
  const assignments = new Map<string, string | undefined>();
  const raw = event?.details?.assignments;
  if (!Array.isArray(raw)) return assignments;
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const teamId = 'teamId' in value && typeof value.teamId === 'string' ? value.teamId : undefined;
    const poolId =
      'targetPoolId' in value && typeof value.targetPoolId === 'string' ? value.targetPoolId : undefined;
    if (teamId) assignments.set(teamId, poolId);
  }
  return assignments;
}

function nextPhase(phases: readonly Phase[], source: Phase): Phase | undefined {
  return phases.find((phase) => phase.order > source.order);
}

function committedDestinations(
  state: DirectorState,
  source: Phase,
  sectionTeams: readonly string[],
): Record<string, StandingsAdvancementCell> | undefined {
  const event = latestAdvancementCommit(state, source.id);
  const target = event?.entityId ? state.phases.find((phase) => phase.id === event.entityId) : undefined;
  if (!target) return undefined;

  const assignments = assignmentTeamIds(event);
  const poolByTeam = new Map<string, Pool>();
  for (const poolId of target.poolIds) {
    const pool = state.pools.find((entry) => entry.id === poolId);
    if (!pool) continue;
    for (const teamId of pool.teamIds) poolByTeam.set(teamId, pool);
  }
  const targetTeams = new Set(target.teamIds ?? []);
  for (const [teamId, poolId] of assignments) {
    if (poolId) {
      const pool = state.pools.find((entry) => entry.id === poolId);
      if (pool) poolByTeam.set(teamId, pool);
    } else targetTeams.add(teamId);
  }

  return Object.fromEntries(
    sectionTeams.map((teamId) => {
      const pool = poolByTeam.get(teamId);
      const advanced = pool !== undefined || targetTeams.has(teamId);
      return [
        teamId,
        advanced
          ? {
              status: 'committed' as const,
              target: pool ? `${target.name} · ${pool.name}` : target.name,
            }
          : { status: 'eliminated' as const },
      ];
    }),
  );
}

function provisionalDestinations(
  state: DirectorState,
  phases: readonly Phase[],
  source: Phase,
  sectionTeams: readonly string[],
): Record<string, StandingsAdvancementCell> | undefined {
  if (!source.advancementRule) return undefined;
  const target = nextPhase(phases, source);
  if (!target) return undefined;
  const preview = previewAdvancement(state, source);
  const qualifierIds = new Set(preview.qualifiers.map((team) => team.id));
  const unresolved = new Map<string, string>();
  for (const group of preview.unresolved) {
    for (const teamId of group.teamIds) unresolved.set(teamId, group.reason);
  }
  return Object.fromEntries(
    sectionTeams.map((teamId) => {
      const unresolvedReason = unresolved.get(teamId);
      if (unresolvedReason) {
        return [teamId, { status: 'unresolved' as const, note: unresolvedReason }];
      }
      return [
        teamId,
        qualifierIds.has(teamId)
          ? { status: 'provisional' as const, target: target.name }
          : { status: 'eliminated' as const },
      ];
    }),
  );
}

function advancementForSection(
  state: DirectorState,
  phases: readonly Phase[],
  phase: Phase | undefined,
  teamIds: readonly string[],
): Record<string, StandingsAdvancementCell> | undefined {
  if (!phase) return undefined;
  return (
    committedDestinations(state, phase, teamIds) ?? provisionalDestinations(state, phases, phase, teamIds)
  );
}

function gameReference(
  state: DirectorState,
  game: GameRecord,
  kind: StandingsContextGame['kind'],
  label: string,
): StandingsContextGame {
  const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
  const left = game.scores.find((score) => score.teamId === scheduled?.leftTeamId) ?? game.scores[0];
  const right = game.scores.find((score) => score.teamId === scheduled?.rightTeamId) ?? game.scores[1];
  const teamName = (teamId: string | undefined) =>
    state.teams.find((team) => team.id === teamId)?.displayName ?? teamId ?? 'Team';
  return {
    gameId: game.id,
    kind,
    label,
    roundName: state.rounds.find((round) => round.id === game.roundId)?.name,
    teamOneName: teamName(left?.teamId),
    ...(left ? { teamOnePoints: left.score } : {}),
    teamTwoName: teamName(right?.teamId),
    ...(right ? { teamTwoPoints: right.score } : {}),
    ...(game.forfeitedTeamId ? { forfeitedTeamName: teamName(game.forfeitedTeamId) } : {}),
  };
}

function explicitFinalResults(state: DirectorState): Array<{ phaseId?: string; game: StandingsContextGame }> {
  const accepted = acceptedGameRecords(state);
  const format = state.formats.find((entry) => entry.id === state.tournament?.formatId);
  const bracketNodes = new Map((format?.bracket?.nodes ?? []).map((node) => [node.key, node]));
  return accepted.flatMap((game) => {
    const phaseId = gamePhaseId(state, game);
    const phase = state.phases.find((entry) => entry.id === phaseId);
    const scheduled = state.scheduledGames.find((entry) => entry.id === game.scheduledGameId);
    const node = scheduled?.bracketKey ? bracketNodes.get(scheduled.bracketKey) : undefined;
    const explicitlyFinal = phase?.kind === 'final' || node?.label === 'Championship';
    const explicitlyPlacement =
      phase?.kind === 'placement' || node?.kind === 'third-place' || node?.kind === 'placement';
    if (!explicitlyFinal && !explicitlyPlacement) return [];
    const kind = explicitlyPlacement ? ('placement' as const) : ('final' as const);
    const label = node?.label ?? phase?.name ?? 'Final';
    return [{ phaseId, game: gameReference(state, game, kind, label) }];
  });
}

function tiebreakerResults(
  state: DirectorState,
): Array<{ phaseId?: string; poolId?: string; game: StandingsContextGame }> {
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet]));
  const scheduledById = new Map(state.scheduledGames.map((game) => [game.id, game]));
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));
  return acceptedGameRecords(state).flatMap((game) => {
    const scheduled = scheduledById.get(game.scheduledGameId);
    const round = roundById.get(game.roundId);
    const packetId = game.packetId ?? scheduled?.packetId ?? round?.packetId ?? undefined;
    const packet = packetId ? packetById.get(packetId) : undefined;
    if (!packet?.tiebreaker) return [];
    return [
      {
        phaseId: round?.phaseId,
        poolId: scheduled?.poolId ?? undefined,
        game: gameReference(state, game, 'tiebreaker', packet.name),
      },
    ];
  });
}

function attachContextGames(state: DirectorState, sections: BuiltSection[]): void {
  const finals = explicitFinalResults(state);
  const finalRanking = sections.find((entry) => entry.section.kind === 'final');
  if (finalRanking) {
    finalRanking.section.contextGames = finals.map((entry) => entry.game);
  } else {
    for (const result of finals) {
      const target = sections.find((entry) => entry.phase?.id === result.phaseId);
      if (target) target.section.contextGames = [...(target.section.contextGames ?? []), result.game];
    }
  }

  for (const result of tiebreakerResults(state)) {
    const target =
      sections.find(
        (entry) =>
          entry.section.phaseId === result.phaseId &&
          entry.section.poolId !== undefined &&
          entry.section.poolId === result.poolId,
      ) ??
      sections.find(
        (entry) => entry.section.phaseId === result.phaseId && entry.section.poolId === undefined,
      );
    if (target) target.section.contextGames = [...(target.section.contextGames ?? []), result.game];
  }
}

function addDisplayRanks(
  state: DirectorState,
  built: readonly BuiltSection[],
  displayRanks: Record<string, number>,
): void {
  const rules = state.tournament?.rules.tiebreakers;
  for (const entry of built) {
    if (entry.section.kind === 'final') continue;
    const teamIds = entry.section.teams.map((row) => row.teamId);
    if (teamIds.length === 0) continue;
    const standings = deriveTeamStandings(state, entry.games, { teamIds });
    const ranks = canonicalCompetitionRanks(standings, entry.games, rules);
    for (const [teamId, rank] of ranks) displayRanks[`${entry.section.id}:${teamId}`] = rank;
  }
}

function builtSection(
  state: DirectorState,
  phases: readonly Phase[],
  phase: Phase,
  pool: Pool | undefined,
  generatedAt: string,
): BuiltSection {
  const title = pool ? `${phase.name} · ${pool.name}` : phase.name;
  const label = phase.carryover ? `${title} · including carryover` : title;
  const resolved = phase.carryover
    ? carryoverSnapshot(state, phase, pool, label, generatedAt)
    : normalSectionSnapshot(
        state,
        {
          phaseId: phase.id,
          ...(pool ? { poolId: pool.id } : {}),
          label,
        },
        generatedAt,
      );
  const section: StandingsReportSection = {
    id: pool ? `standings-pool-${pool.id}` : `standings-phase-${phase.id}`,
    title,
    kind: pool ? 'pool' : 'phase',
    scopeLabel: label,
    teams: resolved.snapshot.teams,
    phaseId: phase.id,
    ...(pool ? { poolId: pool.id } : {}),
    ...(phase.carryover ? { carryover: true } : {}),
  };
  section.advancement = advancementForSection(
    state,
    phases,
    phase,
    section.teams.map((row) => row.teamId),
  );
  return { section, games: resolved.games, phase };
}

/**
 * Compose the complete printable standings document from canonical Director facts.
 *
 * The HTML serializer receives already-ranked rows, explicit stage/pool order, advancement state,
 * carryover game sets, and explicit final/tiebreaker result references. It never inspects raw
 * Director state or invents tournament progression.
 */
export function buildCanonicalStandingsReport(
  state: DirectorState,
  generatedAt = new Date().toISOString(),
): CanonicalStandingsReport {
  const phases = activePhases(state);
  const poolsByPhase = new Map(phases.map((phase) => [phase.id, phasePools(state, phase)]));
  const hasPoolSplit = phases.some((phase) => (poolsByPhase.get(phase.id)?.length ?? 0) > 1);
  const multiStage = phases.length > 1 || hasPoolSplit;
  const overall = buildCanonicalSnapshot(state, { label: 'Overall' }, generatedAt);
  const teamDetailRanks = Object.fromEntries(overall.teams.map((row) => [row.teamId, row.rank]));
  const built: BuiltSection[] = [];

  if (!multiStage) {
    const section: StandingsReportSection = {
      id: 'standings-overall',
      title: state.tournament?.finalPlacement ? 'Final Rankings' : 'Standings',
      kind: state.tournament?.finalPlacement ? 'final' : 'cumulative',
      scopeLabel: 'Overall',
      teams: overall.teams,
    };
    const phase = phases[0];
    section.advancement = advancementForSection(
      state,
      phases,
      phase,
      section.teams.map((row) => row.teamId),
    );
    built.push({ section, games: acceptedGameRecords(state), phase });
  } else {
    if (state.tournament?.finalPlacement) {
      const finalSnapshot = buildCanonicalSnapshot(state, { label: 'Final Rankings' }, generatedAt);
      built.push({
        section: {
          id: 'standings-final',
          title: 'Final Rankings',
          kind: 'final',
          scopeLabel: 'Final Rankings',
          teams: finalSnapshot.teams,
        },
        games: acceptedGameRecords(state),
      });
    }

    for (const phase of phases) {
      const pools = poolsByPhase.get(phase.id) ?? [];
      if (pools.length > 1) {
        for (const pool of pools) built.push(builtSection(state, phases, phase, pool, generatedAt));
      } else {
        built.push(builtSection(state, phases, phase, undefined, generatedAt));
      }
    }

    const cumulative = calculatedOverallSnapshot(state, generatedAt);
    built.push({
      section: {
        id: 'standings-cumulative',
        title: 'All Games',
        kind: 'cumulative',
        scopeLabel: 'All Games',
        teams: cumulative.teams,
      },
      games: acceptedGameRecords(state),
    });
  }

  attachContextGames(state, built);
  const displayRanks: Record<string, number> = {};
  addDisplayRanks(state, built, displayRanks);
  return {
    tournament: overall.tournament,
    generatedAt,
    sections: built.map((entry) => entry.section),
    teamDetailRanks,
    displayRanks,
  };
}
