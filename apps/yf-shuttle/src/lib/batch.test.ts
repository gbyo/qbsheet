/**
 * Derived-batch planning, proved against the failure it exists to prevent.
 *
 * The scenario from review: prepare at 5/6, the sixth result arrives, prepare again — the
 * folder must hold exactly 6 Shuttle-generated files, never 11. Preparing twice changes
 * nothing. A corrected duplicate choice replaces that Match's derived copy. OUT originals
 * are never an input to what gets overwritten, and hand-placed files are never removed.
 */

import { describe, expect, test } from 'vitest';
import { nextDerivedOwnership, planBatchUpdate } from './batch';

const ROUND = ['R01 - 319 - A vs B.qbj', 'R01 - 320 - C vs D.qbj'];

function expected(names: string[] = ROUND) {
  return names.map((destName, index) => ({ matchId: `m${index + 1}`, destName }));
}

describe('batch planning', () => {
  test('prepare at 5/6 then 6/6 converges on exactly the expected files', () => {
    const first = planBatchUpdate({
      expected: [expected()[0]],
      existingNames: [],
      ownedNames: {},
    });
    expect(first.writes.map((entry) => entry.destName)).toEqual([ROUND[0]]);
    expect(first.removals).toEqual([]);

    // Sixth result arrives; the folder holds the first derived copy plus a hand-placed note.
    const owned = nextDerivedOwnership({}, new Set(['m1', 'm2']), first.writes);
    const second = planBatchUpdate({
      expected: expected(),
      existingNames: [ROUND[0], 'read-me.txt'],
      ownedNames: owned,
    });
    expect(second.writes.map((entry) => entry.destName).sort()).toEqual([...ROUND].sort());
    expect(second.removals).toEqual([]);
    // The hand-placed file is reported, never removed, never overwritten.
    expect(second.unknownKept).toEqual(['read-me.txt']);
    expect(second.retained).toEqual([ROUND[0]]);
  });

  test('preparing twice changes nothing on disk', () => {
    const owned = { m1: ROUND[0], m2: ROUND[1] };
    const plan = planBatchUpdate({ expected: expected(), existingNames: [...ROUND], ownedNames: owned });
    expect(plan.writes.map((entry) => entry.destName).sort()).toEqual([...ROUND].sort());
    expect(plan.removals).toEqual([]);
    expect(plan.unknownKept).toEqual([]);
    // Writes are deterministic overwrites of the same names: no suffixed copies can appear.
    expect(new Set(plan.writes.map((entry) => entry.destName)).size).toBe(2);
  });

  test('a corrected duplicate choice replaces that Match’s derived copy', () => {
    // The Match was prepared under a name derived from old team names; the correction renames it.
    const owned = { m1: 'R01 - 319 - A vs B.qbj' };
    const plan = planBatchUpdate({
      expected: [{ matchId: 'm1', destName: 'R01 - 319 - A vs X.qbj' }],
      existingNames: ['R01 - 319 - A vs B.qbj'],
      ownedNames: owned,
    });
    expect(plan.removals).toEqual(['R01 - 319 - A vs B.qbj']);
    expect(plan.writes).toEqual([{ matchId: 'm1', destName: 'R01 - 319 - A vs X.qbj' }]);
    const next = nextDerivedOwnership(owned, new Set(['m1']), plan.writes);
    expect(next).toEqual({ m1: 'R01 - 319 - A vs X.qbj' });
  });

  test('stale ownership for other rounds survives a prepare', () => {
    const next = nextDerivedOwnership({ m9: 'R02 - 319 - E vs F.qbj' }, new Set(['m1']), [
      { matchId: 'm1', destName: ROUND[0] },
    ]);
    expect(next).toEqual({ m9: 'R02 - 319 - E vs F.qbj', m1: ROUND[0] });
  });

  test('the plan never names IN or OUT paths', () => {
    const plan = planBatchUpdate({ expected: expected(), existingNames: [], ownedNames: {} });
    for (const entry of [...plan.writes.map((w) => w.destName), ...plan.removals]) {
      expect(entry).not.toMatch(/\/|\\|\.\./);
      expect(entry.endsWith('.qbj')).toBe(true);
    }
  });
});
