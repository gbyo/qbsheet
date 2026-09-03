import { recommendPoolPrelimPlayoffPlan, type PoolPrelimPlayoffPlan } from '@qbsheet/tournament-core';

/**
 * A tournament plan recommendation, expressed the way a director thinks:
 * how many rounds, how many games per team, and what the structural
 * consequences are. Machine-readable fields carry everything
 * `applyTournamentPlan` needs; nothing here duplicates the pairing engines.
 */
export type TournamentPlanId =
  'full-round-robin' | 'pools-playoffs' | 'double-round-robin' | 'swiss' | 'manual';

export interface TournamentPlanStage {
  name: string;
  kind: 'preliminary' | 'playoff' | 'final' | 'placement' | 'custom';
  /** Round numbers belonging to this stage, in day order. */
  roundNumbers: number[];
  /** Pools to create in this stage. Prelim pools are filled immediately. */
  poolNames: string[];
  /** Distribute the current active teams across this stage's pools now. */
  assignTeams: boolean;
}

export interface TournamentPlanRecommendation {
  id: TournamentPlanId;
  title: string;
  summary: string;
  consequences: string[];
  /** Stage/round/pool structure `applyTournamentPlan` materializes. */
  stages: TournamentPlanStage[];
  poolPlan?: PoolPrelimPlayoffPlan;
}

export interface TournamentPlanSet {
  teamCount: number;
  recommended: TournamentPlanRecommendation;
  alternatives: TournamentPlanRecommendation[];
}

const MAX_FULL_ROUND_ROBIN_TEAMS = 12;

function range(from: number, count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => from + index);
}

function fullRoundRobin(teamCount: number): TournamentPlanRecommendation {
  const rounds = teamCount % 2 === 0 ? teamCount - 1 : teamCount;
  const gamesPerTeam = teamCount - 1;
  const consequences = [
    `${rounds} round${rounds === 1 ? '' : 's'} · ${gamesPerTeam} games per team`,
    'Every team plays every other team once.',
  ];
  if (teamCount % 2 === 1) {
    consequences.push('One bye per round: each team sits out once.');
  }
  return {
    id: 'full-round-robin',
    title: 'Full round robin',
    summary: 'Every team plays every other team once.',
    consequences,
    stages: [
      {
        name: 'Tournament',
        kind: 'preliminary',
        roundNumbers: range(1, rounds),
        poolNames: [],
        assignTeams: false,
      },
    ],
  };
}

function poolsPlayoffs(teamCount: number): TournamentPlanRecommendation {
  const plan = recommendPoolPrelimPlayoffPlan(teamCount);
  const poolSizes = plan.poolSizes.join(', ');
  const playoffRounds = plan.playoffRoundNumbers.length;
  const divisions = plan.divisions.map((division) => division.name).join(', ');
  const prelimGames = plan.prelimGamesPerTeam.join(' or ');
  const consequences = [
    `Morning: ${plan.prelimRounds} preliminary rounds in ${plan.poolCount} pools of ${poolSizes}`,
    `Afternoon: ${playoffRounds} playoff rounds across ${plan.divisions.length} divisions (${divisions})`,
    `Each team gets ${prelimGames} preliminary game${plan.prelimGamesPerTeam.every((games) => games === 1) ? '' : 's'}.`,
  ];
  for (const issue of plan.rotation.issues) {
    consequences.push(issue.message);
  }
  return {
    id: 'pools-playoffs',
    title: `${plan.poolCount} pools into playoff divisions`,
    summary: `Preliminary pools, then playoffs in ${plan.divisions.length} divisions.`,
    consequences,
    stages: [
      {
        name: 'Prelims',
        kind: 'preliminary',
        roundNumbers: [...plan.prelimRoundNumbers],
        poolNames: [...plan.poolNames],
        assignTeams: true,
      },
      {
        name: 'Playoffs',
        kind: 'playoff',
        roundNumbers: [...plan.playoffRoundNumbers],
        poolNames: plan.divisions.map((division) => division.name),
        assignTeams: false,
      },
    ],
    poolPlan: plan,
  };
}

function doubleRoundRobin(teamCount: number): TournamentPlanRecommendation {
  const rounds = (teamCount % 2 === 0 ? teamCount - 1 : teamCount) * 2;
  return {
    id: 'double-round-robin',
    title: 'Double round robin',
    summary: 'Every team plays every other team twice.',
    consequences: [
      `${rounds} rounds · ${teamCount - 1} games per team per rotation`,
      'Twice the rounds of a single round robin.',
    ],
    stages: [
      {
        name: 'Tournament',
        kind: 'preliminary',
        roundNumbers: range(1, rounds),
        poolNames: [],
        assignTeams: false,
      },
    ],
  };
}

function swiss(): TournamentPlanRecommendation {
  return {
    id: 'swiss',
    title: 'Swiss / power matching',
    summary: 'Each round pairs teams with similar records.',
    consequences: [
      'You decide how many rounds to play; pairings follow results.',
      'No pools and no byes unless the field is odd.',
    ],
    stages: [
      { name: 'Tournament', kind: 'preliminary', roundNumbers: [], poolNames: [], assignTeams: false },
    ],
  };
}

function manual(): TournamentPlanRecommendation {
  return {
    id: 'manual',
    title: 'Manual pairings',
    summary: 'You pair every round by hand.',
    consequences: ['Full control, round by round.', 'No automatic structure to preview.'],
    stages: [
      { name: 'Tournament', kind: 'preliminary', roundNumbers: [], poolNames: [], assignTeams: false },
    ],
  };
}

/**
 * Recommend a tournament plan for a field of `teamCount` confirmed teams.
 * Small fields get a full round robin; larger fields get pool prelims into
 * playoff divisions. Returns null when the field is too small to plan for.
 */
export function recommendTournamentPlan(teamCount: number): TournamentPlanSet | null {
  if (!Number.isInteger(teamCount) || teamCount < 2) return null;
  if (teamCount <= MAX_FULL_ROUND_ROBIN_TEAMS) {
    return {
      teamCount,
      recommended: fullRoundRobin(teamCount),
      alternatives: [doubleRoundRobin(teamCount), swiss(), manual()],
    };
  }
  return {
    teamCount,
    recommended: poolsPlayoffs(teamCount),
    alternatives: [fullRoundRobin(teamCount), swiss(), manual()],
  };
}
