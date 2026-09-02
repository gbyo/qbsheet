import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pairQuizbowlSwiss, type QuizbowlSwissTeam } from '../src/swiss';

function teams(count: number, overrides: Partial<QuizbowlSwissTeam> = {}): QuizbowlSwissTeam[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `team-${index + 1}`,
    wins: index < Math.floor(count / 2) ? 1 : 0,
    losses: index < Math.floor(count / 2) ? 0 : 1,
    ties: 0,
    pointsFor: index < Math.floor(count / 2) ? 300 - index : 200 - index,
    margin: index < Math.floor(count / 2) ? 40 - index : -40 - index,
    seed: index + 1,
    organizationId: `school-${index + 1}`,
    previousOpponentIds: [],
    byeCount: 0,
    ...overrides,
  }));
}

function played(result: ReturnType<typeof pairQuizbowlSwiss>): Set<string> {
  return new Set(
    result.pairings
      .filter((pairing) => pairing.rightTeamId)
      .map((pairing) => [pairing.leftTeamId, pairing.rightTeamId!].sort().join('|')),
  );
}

describe('quizbowl Swiss pairing', () => {
  it('power-pairs by record and is deterministic', () => {
    const field = teams(8);
    const first = pairQuizbowlSwiss(field);
    const second = pairQuizbowlSwiss(field);
    expect(first).toEqual(second);
    expect(first.pairings).toHaveLength(4);
    expect(first.conflicts.some((conflict) => conflict.code === 'record-float')).toBe(false);
  });

  it('avoids rematches and same-school pairings when a complete clean matching exists', () => {
    const field = teams(4);
    field[0] = { ...field[0]!, previousOpponentIds: ['team-2'] };
    field[1] = { ...field[1]!, previousOpponentIds: ['team-1'] };
    field[0] = { ...field[0]!, organizationId: 'school-shared' };
    field[1] = { ...field[1]!, organizationId: 'school-shared' };
    const result = pairQuizbowlSwiss(field);
    expect(played(result)).not.toContain('team-1|team-2');
    expect(result.conflicts.some((conflict) => conflict.code === 'rematch')).toBe(false);
    expect(result.conflicts.some((conflict) => conflict.code === 'same-organization')).toBe(false);
  });

  it('gives an odd field one bye and avoids repeating a prior bye first', () => {
    const field = teams(5).map((team) => ({ ...team, byeCount: team.id === 'team-5' ? 1 : 0 }));
    const result = pairQuizbowlSwiss(field);
    expect(result.pairings).toHaveLength(3);
    expect(result.byeTeamId).toBe('team-4');
    expect(result.conflicts.some((conflict) => conflict.code === 'bye')).toBe(true);
  });

  it('excludes dropped teams without losing them from the caller’s history', () => {
    const field = [...teams(4), { ...teams(1)[0]!, id: 'dropped', dropped: true }];
    const result = pairQuizbowlSwiss(field);
    expect(result.orderedTeamIds).not.toContain('dropped');
    expect(result.conflicts.some((conflict) => conflict.code === 'dropped-team')).toBe(true);
  });

  it('blocks incomplete records unless the director explicitly opts into provisional pairing', () => {
    const field = teams(4).map((team, index) => (index === 0 ? { ...team, incomplete: true } : team));
    const blocked = pairQuizbowlSwiss(field);
    expect(blocked.hardFailure).toBe(true);
    const provisional = pairQuizbowlSwiss(field, { allowIncomplete: true });
    expect(provisional.hardFailure).toBe(false);
    expect(provisional.conflicts.some((conflict) => conflict.code === 'incomplete-standings')).toBe(true);
  });

  it('validates a manual override and reports intentional rematches', () => {
    const field = teams(4);
    field[0] = { ...field[0]!, previousOpponentIds: ['team-2'] };
    field[1] = { ...field[1]!, previousOpponentIds: ['team-1'] };
    const result = pairQuizbowlSwiss(field, {
      manualPairings: [
        { leftTeamId: 'team-1', rightTeamId: 'team-2' },
        { leftTeamId: 'team-3', rightTeamId: 'team-4' },
      ],
    });
    expect(result.hardFailure).toBe(false);
    expect(result.conflicts.some((conflict) => conflict.code === 'rematch')).toBe(true);
  });

  it('preserves the Swiss coverage invariants across generated field sizes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), (count) => {
        const field = teams(count);
        const result = pairQuizbowlSwiss(field);
        expect(result.hardFailure).toBe(false);
        const appearances = result.pairings.flatMap((pairing) =>
          pairing.rightTeamId === null ? [pairing.leftTeamId] : [pairing.leftTeamId, pairing.rightTeamId],
        );
        expect(new Set(appearances).size).toBe(count);
        expect([...new Set(appearances)].sort()).toEqual(field.map((team) => team.id).sort());
        expect(result.byeTeamId === null).toBe(count % 2 === 0);
        expect(pairQuizbowlSwiss(field)).toEqual(result);
      }),
      { numRuns: 80 },
    );
  });
});
