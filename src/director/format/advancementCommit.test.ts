import { describe, expect, test } from 'vitest';
import { completeTargetPoolMembership } from './advancementCommit';

describe('complete advancement target membership', () => {
  test('makes omitted target pools explicitly empty on recommit', () => {
    const membership = completeTargetPoolMembership(
      ['pool-a', 'pool-b'],
      [
        { teamId: 'team-1', targetPoolId: 'pool-a' },
        { teamId: 'team-2', targetPoolId: 'pool-a' },
      ],
    );
    expect(membership.get('pool-a')).toEqual(['team-1', 'team-2']);
    expect(membership.get('pool-b')).toEqual([]);
  });

  test('moves a team without retaining it in the old pool', () => {
    const membership = completeTargetPoolMembership(
      ['pool-a', 'pool-b'],
      [{ teamId: 'team-1', targetPoolId: 'pool-b' }],
    );
    expect(membership.get('pool-a')).toEqual([]);
    expect(membership.get('pool-b')).toEqual(['team-1']);
  });
});
