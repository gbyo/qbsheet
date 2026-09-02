import { describe, expect, it } from 'vitest';
import {
  bracketAwards,
  bracketGamesDependingOn,
  placeBracketRounds,
  planSingleEliminationBracket,
  resolveBracket,
  seedOrder,
  type BracketGameOutcome,
  type BracketPlan,
  type BracketSlotSource,
} from '../src/brackets';

function describeSlot(source: BracketSlotSource): string {
  return source.kind === 'seed' ? `#${source.seed}` : `${source.kind}(${source.gameKey})`;
}

function pairings(plan: BracketPlan, roundIndex: number): string[] {
  return plan.nodes
    .filter((node) => node.roundIndex === roundIndex)
    .sort((left, right) => left.sequence - right.sequence)
    .map((node) => `${describeSlot(node.slotA)} vs ${describeSlot(node.slotB)}`);
}

function seedsWithByes(plan: BracketPlan, roundIndex = 0): number[] {
  return plan.byes
    .filter((bye) => bye.roundIndex === roundIndex)
    .map((bye) => bye.seed)
    .sort((left, right) => left - right);
}

describe('seedOrder', () => {
  it('mirrors the draw so the best seed always meets the worst remaining seed', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('pairs every seed with its complement', () => {
    const order = seedOrder(16);
    for (let index = 0; index < order.length; index += 2) {
      expect(order[index] + order[index + 1]).toBe(17);
    }
  });
});

describe('six-team division', () => {
  const plan = planSingleEliminationBracket(6);

  it('gives first-round byes to exactly the top two seeds', () => {
    expect(seedsWithByes(plan)).toEqual([1, 2]);
    expect(plan.byes.every((bye) => bye.protectedSeed)).toBe(true);
  });

  it('plays 3–6 and 4–5 in the first playoff round and never 1–6 or 2–5', () => {
    expect(pairings(plan, 0)).toEqual(['#4 vs #5', '#3 vs #6']);
    expect(pairings(plan, 0)).not.toContain('#1 vs #6');
    expect(pairings(plan, 0)).not.toContain('#2 vs #5');
  });

  it('sends the top seeds against the first-round winners in the semifinals', () => {
    const first = plan.nodes.filter((node) => node.roundIndex === 0);
    const gameA = first.find((node) => describeSlot(node.slotA) === '#4')?.key;
    const gameB = first.find((node) => describeSlot(node.slotA) === '#3')?.key;
    expect(pairings(plan, 1)).toEqual([`#1 vs winner(${gameA})`, `#2 vs winner(${gameB})`]);
  });

  it('finishes with one championship game between the two semifinal winners', () => {
    const semifinals = plan.nodes.filter((node) => node.roundIndex === 1).map((node) => node.key);
    expect(pairings(plan, 2)).toEqual([`winner(${semifinals[0]}) vs winner(${semifinals[1]})`]);
    expect(plan.nodes.filter((node) => node.roundIndex === 2)).toHaveLength(1);
    expect(plan.nodes.at(-1)?.label).toBe('Championship');
  });

  it('draws five games for six teams and needs three rounds', () => {
    expect(plan.nodes).toHaveLength(5);
    expect(plan.roundCount).toBe(3);
    expect(plan.bracketSize).toBe(8);
  });
});

describe('five-team division', () => {
  const plan = planSingleEliminationBracket(5);

  it('states plainly that three first-round byes are required', () => {
    expect(seedsWithByes(plan)).toEqual([1, 2, 3]);
    expect(plan.notes.join(' ')).toContain('3 first-round byes are required by the bracket size');
  });

  it('separates the protected byes from the extra one the bracket size forces', () => {
    expect(plan.byes.filter((bye) => bye.protectedSeed).map((bye) => bye.seed)).toEqual([1, 2]);
    expect(plan.byes.filter((bye) => !bye.protectedSeed).map((bye) => bye.seed)).toEqual([3]);
    expect(plan.notes.join(' ')).toContain('Additional bracket bye');
  });

  it('plays only 4 v 5 in the first round', () => {
    expect(pairings(plan, 0)).toEqual(['#4 vs #5']);
  });

  it('plays #1 against the 4/5 winner and #2 against #3 in the semifinals', () => {
    const gameA = plan.nodes.find((node) => node.roundIndex === 0)?.key;
    expect(pairings(plan, 1)).toEqual([`#1 vs winner(${gameA})`, `#2 vs #3`]);
  });

  it('ends with a single final', () => {
    expect(plan.nodes.filter((node) => node.roundIndex === 2)).toHaveLength(1);
    expect(plan.nodes).toHaveLength(4);
  });
});

describe('four-team division', () => {
  const plan = planSingleEliminationBracket(4);

  it('plays semifinals with no byes and then a final', () => {
    expect(plan.byes).toHaveLength(0);
    expect(pairings(plan, 0)).toEqual(['#1 vs #4', '#2 vs #3']);
    expect(plan.nodes.filter((node) => node.roundIndex === 1)).toHaveLength(1);
    expect(plan.roundCount).toBe(2);
  });

  it('says so when the protected seeds cannot receive byes', () => {
    expect(plan.issues.map((issue) => issue.code)).toContain('protected-bye-unavailable');
    expect(plan.notes.join(' ')).toContain('the bracket is full');
  });
});

describe('other division sizes', () => {
  it.each([
    [2, 2, 1, [] as number[]],
    [3, 4, 2, [1]],
    [7, 8, 3, [1]],
    [8, 8, 3, []],
    [9, 16, 4, [1, 2, 3, 4, 5, 6, 7]],
    [12, 16, 4, [1, 2, 3, 4]],
    [16, 16, 4, []],
  ])('draws %i teams into a bracket of %i over %i rounds', (teams, size, rounds, byeSeeds) => {
    const plan = planSingleEliminationBracket(teams);
    expect(plan.bracketSize).toBe(size);
    expect(plan.roundCount).toBe(rounds);
    expect(seedsWithByes(plan)).toEqual(byeSeeds);
    // Single elimination always plays exactly one game per team eliminated.
    expect(plan.nodes).toHaveLength(teams - 1);
  });

  it('never pairs two absent seeds and never repeats a seed in the first round', () => {
    for (let teams = 2; teams <= 32; teams += 1) {
      const plan = planSingleEliminationBracket(teams);
      const firstRoundSeeds = plan.nodes
        .filter((node) => node.roundIndex === 0)
        .flatMap((node) => [node.slotA, node.slotB])
        .map((slot) => (slot.kind === 'seed' ? slot.seed : -1));
      const byeSeeds = plan.byes.map((bye) => bye.seed);
      const claimed = [...firstRoundSeeds, ...byeSeeds];
      expect(claimed.every((seed) => seed >= 1 && seed <= teams)).toBe(true);
      expect(new Set(claimed).size).toBe(teams);
    }
  });

  it('reports a one-team division rather than drawing a ghost opponent', () => {
    const plan = planSingleEliminationBracket(1);
    expect(plan.nodes).toHaveLength(0);
    expect(plan.notes.join(' ')).toContain('champion by default');
  });

  it('refuses an empty division', () => {
    expect(planSingleEliminationBracket(0).issues.map((issue) => issue.code)).toContain('empty-division');
  });
});

describe('third-place games', () => {
  it('are absent unless asked for', () => {
    expect(planSingleEliminationBracket(6).nodes.some((node) => node.kind === 'third-place')).toBe(false);
  });

  it('depend on the losers of both semifinals when enabled', () => {
    const plan = planSingleEliminationBracket(6, { thirdPlaceGame: true });
    const third = plan.nodes.find((node) => node.kind === 'third-place');
    expect(third?.slotA.kind).toBe('loser');
    expect(third?.slotB.kind).toBe('loser');
    expect(third?.roundIndex).toBe(2);
  });
});

describe('placeBracketRounds', () => {
  it('numbers a three-round bracket 6, 7, 8 in a five-round-prelim tournament', () => {
    const placed = placeBracketRounds(3, [6, 7, 8]);
    expect(placed.placements.map((entry) => entry.roundNumber)).toEqual([6, 7, 8]);
    expect(placed.unusedRoundNumbers).toEqual([]);
  });

  it('lets a four-team division play semifinals in round 6 and the final in round 8', () => {
    const placed = placeBracketRounds(2, [6, 7, 8], 'championship-last');
    expect(placed.placements.map((entry) => entry.roundNumber)).toEqual([6, 8]);
    expect(placed.unusedRoundNumbers).toEqual([7]);
  });

  it('lets the same division play late instead, when that is the configured policy', () => {
    const placed = placeBracketRounds(2, [6, 7, 8], 'latest');
    expect(placed.placements.map((entry) => entry.roundNumber)).toEqual([7, 8]);
    expect(placed.unusedRoundNumbers).toEqual([6]);
  });

  it('refuses to squeeze a bracket into fewer rounds than it needs', () => {
    const placed = placeBracketRounds(3, [6, 7]);
    expect(placed.issues.map((issue) => issue.code)).toEqual(['insufficient-rounds']);
    expect(placed.placements).toEqual([]);
  });
});

describe('resolveBracket', () => {
  const plan = planSingleEliminationBracket(6);
  const seeding = Array.from({ length: 6 }, (_, index) => ({
    seed: index + 1,
    teamId: `team-${index + 1}`,
  }));
  const rounds = placeBracketRounds(3, [6, 7, 8]).placements;
  const gameA = plan.nodes.filter((node) => node.roundIndex === 0)[0];
  const gameB = plan.nodes.filter((node) => node.roundIndex === 0)[1];

  it('marks only the games with two known teams as ready', () => {
    const resolved = resolveBracket({ plan, seeding, roundPlacements: rounds });
    expect(resolved.games.filter((game) => game.ready).map((game) => game.key)).toEqual([
      gameA.key,
      gameB.key,
    ]);
    expect(resolved.games.filter((game) => game.roundNumber === 7).every((game) => !game.ready)).toBe(true);
  });

  it('numbers bracket games with the tournament round, not a phase-local one', () => {
    const resolved = resolveBracket({ plan, seeding, roundPlacements: rounds });
    expect([...new Set(resolved.games.map((game) => game.roundNumber))].sort()).toEqual([6, 7, 8]);
    expect(resolved.byes.every((bye) => bye.roundNumber === 6)).toBe(true);
  });

  it('writes a readable placeholder rather than blank data for an unresolved slot', () => {
    const resolved = resolveBracket({ plan, seeding, roundPlacements: rounds });
    const semifinal = resolved.games.find((game) => game.roundNumber === 7);
    expect(semifinal?.slotA.placeholder).toBe('#1');
    expect(semifinal?.slotB.placeholder).toBe('Winner of #4 / #5');
  });

  it('includes team names in the detailed placeholder for a team schedule', () => {
    const teamNames = new Map(seeding.map((entry) => [entry.teamId, `Squad ${entry.seed}`]));
    const resolved = resolveBracket({ plan, seeding, roundPlacements: rounds, teamNames });
    const semifinal = resolved.games.find((game) => game.roundNumber === 7);
    expect(semifinal?.slotB.placeholderDetail).toBe('Winner of #4 Squad 4 / #5 Squad 5');
  });

  it('carries a first-round winner into the semifinal automatically', () => {
    const outcomes: BracketGameOutcome[] = [
      { gameKey: gameA.key, winnerTeamId: 'team-4', loserTeamId: 'team-5' },
    ];
    const resolved = resolveBracket({ plan, seeding, outcomes, roundPlacements: rounds });
    const semifinal = resolved.games.find((game) => game.roundNumber === 7 && game.slotA.teamId === 'team-1');
    expect(semifinal?.slotB.teamId).toBe('team-4');
    expect(semifinal?.ready).toBe(true);
  });

  it('changes the semifinal participant when the first-round winner is corrected', () => {
    const corrected = resolveBracket({
      plan,
      seeding,
      outcomes: [{ gameKey: gameA.key, winnerTeamId: 'team-5', loserTeamId: 'team-4' }],
      roundPlacements: rounds,
    });
    const semifinal = corrected.games.find(
      (game) => game.roundNumber === 7 && game.slotA.teamId === 'team-1',
    );
    expect(semifinal?.slotB.teamId).toBe('team-5');
  });

  it('names a division champion and runner-up once the final is accepted', () => {
    const semifinals = plan.nodes.filter((node) => node.roundIndex === 1);
    const final = plan.nodes.find((node) => node.roundIndex === 2) as { key: string };
    const outcomes: BracketGameOutcome[] = [
      { gameKey: gameA.key, winnerTeamId: 'team-4', loserTeamId: 'team-5' },
      { gameKey: gameB.key, winnerTeamId: 'team-3', loserTeamId: 'team-6' },
      { gameKey: semifinals[0].key, winnerTeamId: 'team-1', loserTeamId: 'team-4' },
      { gameKey: semifinals[1].key, winnerTeamId: 'team-3', loserTeamId: 'team-2' },
      { gameKey: final.key, winnerTeamId: 'team-3', loserTeamId: 'team-1' },
    ];
    const resolved = resolveBracket({ plan, seeding, outcomes, roundPlacements: rounds });
    expect(resolved.championTeamId).toBe('team-3');
    expect(resolved.runnerUpTeamId).toBe('team-1');
    expect(resolved.complete).toBe(true);
    expect(bracketAwards(resolved)).toEqual([
      { place: 'champion', teamId: 'team-3' },
      { place: 'runner-up', teamId: 'team-1' },
    ]);
  });

  it('leaves a one-team division with a champion and no runner-up', () => {
    const solo = planSingleEliminationBracket(1);
    const resolved = resolveBracket({ plan: solo, seeding: [{ seed: 1, teamId: 'team-1' }] });
    expect(resolved.championTeamId).toBe('team-1');
    expect(resolved.runnerUpTeamId).toBeNull();
  });
});

describe('bracketGamesDependingOn', () => {
  it('names every later game a first-round result can reach', () => {
    const plan = planSingleEliminationBracket(6);
    const gameA = plan.nodes.filter((node) => node.roundIndex === 0)[0];
    const dependents = bracketGamesDependingOn(plan, gameA.key);
    expect(dependents.map((node) => node.roundIndex)).toEqual([1, 2]);
    expect(dependents).toHaveLength(2);
  });

  it('names nothing for the final', () => {
    const plan = planSingleEliminationBracket(6);
    const final = plan.nodes.find((node) => node.roundIndex === 2) as { key: string };
    expect(bracketGamesDependingOn(plan, final.key)).toEqual([]);
  });
});
