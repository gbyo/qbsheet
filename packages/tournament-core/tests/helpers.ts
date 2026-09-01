import type { EntityId, GameResult, Pool, ScheduledMatch, Team } from '../src/model';
import { defaultRules } from '../src/rules';
import { fingerprintResult, makeTeamGameStat } from '../src/results';

export const fixedClock = {
  now: () => '2026-09-01T12:00:00.000Z',
};

export function makeTeam(id: EntityId, overrides: Partial<Team> = {}): Team {
  return {
    id,
    name: overrides.name ?? id,
    displayName: overrides.displayName ?? overrides.name ?? id,
    letter: overrides.letter ?? null,
    organizationId: overrides.organizationId ?? null,
    seed: overrides.seed ?? null,
    status: overrides.status ?? 'active',
    playerIds: overrides.playerIds ?? [],
    notes: overrides.notes ?? '',
    createdAt: overrides.createdAt ?? fixedClock.now(),
    updatedAt: overrides.updatedAt ?? fixedClock.now(),
  };
}

export function makeTeams(count: number, organizationIds: readonly EntityId[] = []): Team[] {
  return Array.from({ length: count }, (_, index) =>
    makeTeam(`team-${index + 1}`, {
      name: `Team ${index + 1}`,
      seed: index + 1,
      organizationId: organizationIds[index % Math.max(organizationIds.length, 1)] ?? null,
    }),
  );
}

export function makePool(id: EntityId, teamIds: readonly EntityId[], order = 0): Pool {
  return { id, phaseId: 'phase-1', name: id, order, teamIds, sourcePoolIds: [] };
}

export function makeAcceptedResult(
  game: ScheduledMatch,
  scoreA: number,
  scoreB: number,
  overrides: Partial<Pick<GameResult, 'id' | 'source' | 'acceptedAt' | 'acceptedBy' | 'revision'>> = {},
): GameResult {
  const teamScores = [
    makeTeamGameStat({
      teamId: game.teamAId,
      score: scoreA,
      tossupsHeard: 20,
      gets: 5,
      powers: 2,
      bonusesHeard: 8,
      bonusPoints: 50,
    }),
    makeTeamGameStat({
      teamId: game.teamBId,
      score: scoreB,
      tossupsHeard: 20,
      gets: 4,
      powers: 1,
      bonusesHeard: 8,
      bonusPoints: 40,
    }),
  ];
  const payload = {
    scheduledGameId: game.id,
    phaseId: game.phaseId,
    roundId: game.roundId,
    roomId: game.roomId,
    packetId: game.packetId,
    outcome: 'played' as const,
    teamScores,
    playerStats: [],
    notes: '',
  };
  return {
    ...payload,
    id: overrides.id ?? `result-${game.id}`,
    fingerprint: fingerprintResult(payload),
    source: overrides.source ?? 'manual',
    receivedAt: fixedClock.now(),
    acceptedAt: overrides.acceptedAt ?? fixedClock.now(),
    acceptedBy: overrides.acceptedBy ?? 'director',
    reviewStatus: 'accepted',
    revision: overrides.revision ?? 1,
    originalSubmissionId: null,
    supersedesResultId: null,
  };
}

export const rules = defaultRules('acf');
