import { describe, expect, test } from 'vitest';
import { portableQbj } from '../src/game/PortableQbj';
import { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import type { IGameSessionHistory } from '../src/scorer/GameSession';
import {
  attachScorerRecovery,
  legacyScorerRecoveryVersion,
  inspectScorerRecovery,
  readScorerRecovery,
  scorerRecoveryIdentity,
  scorerRecoveryKey,
  scorerRecoveryVersion,
} from '../src/scorer/ScorerRecovery';
import { validPackage } from './packages';

const setup: IGameSetup = {
  left: { name: 'Left', players: ['Alice', 'Avery'] },
  right: { name: 'Right', players: ['Blake', 'Bailey'] },
};

const events: ScoreEvent[] = [{ id: 'dead-1', type: 'tossup-dead', questionNumber: 1 }];

const history = {
  undo: [1],
  redo: [[{ id: 'dead-2', type: 'tossup-dead' as const, questionNumber: 2 }]],
};

function recoveryOf(value: unknown): Record<string, unknown> {
  return (value as Record<string, unknown>)[scorerRecoveryKey] as Record<string, unknown>;
}

describe('the versioned private scorer recovery envelope', () => {
  test('writes and reads v2 action history without changing the event journal', () => {
    const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, history);

    expect(recoveryOf(qbj)).toEqual({
      version: scorerRecoveryVersion,
      setup,
      events,
      history,
    });
    expect(readScorerRecovery(qbj, setup, { allowLegacy: true })).toEqual({
      version: scorerRecoveryVersion,
      setup,
      events,
      history,
    });
  });

  test('continues reading v1 setup/events snapshots and does not invent history', () => {
    const qbj = {
      [scorerRecoveryKey]: {
        version: legacyScorerRecoveryVersion,
        setup,
        events,
        history: { undo: ['not-a-frame'], redo: [] },
      },
    };

    expect(readScorerRecovery(qbj, setup)).toBeNull();
    expect(inspectScorerRecovery(qbj, { leftTeamName: 'Left', rightTeamName: 'Right' })).toMatchObject({
      kind: 'review-required',
      reason: 'missing-stable-identity',
    });
    expect(readScorerRecovery(qbj, setup, { allowLegacy: true })).toEqual({
      version: legacyScorerRecoveryVersion,
      setup,
      events,
    });
  });

  test('serializes exact assignment identity without credentials', () => {
    const identity = {
      tournamentId: 'tournament-1',
      matchId: 'match-round-2',
      roundId: 'round-2',
      assignmentRevision: 3,
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    };
    const qbj = attachScorerRecovery(
      { type: 'Match', sessionToken: 'must-not-be-written', nested: { credentials: 'secret' } },
      setup,
      [{ ...events[0], sessionToken: 'event-secret' } as unknown as (typeof events)[number]],
      undefined,
      identity,
    );

    expect(recoveryOf(qbj)).toMatchObject({ version: scorerRecoveryVersion, identity });
    expect(JSON.stringify(qbj)).not.toContain('must-not-be-written');
    expect(JSON.stringify(qbj)).not.toContain('credentials');
    expect(JSON.stringify(qbj)).not.toContain('event-secret');
    expect(readScorerRecovery(qbj, identity)).toMatchObject({ identity });
  });

  test('derives the recovery identity from the scheduled package', () => {
    const packageValue = validPackage({
      qbjIdentity: {
        tournamentId: 'tournament-1',
        matchId: 'match-round-8',
        roundId: 'round-8',
        teamIds: { left: 'team-left', right: 'team-right' },
      },
    });
    expect(scorerRecoveryIdentity(packageValue, setup)).toEqual({
      tournamentId: 'tournament-1',
      matchId: 'match-round-8',
      roundId: 'round-8',
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    });
  });

  test.each([
    {
      label: 'different scheduled match',
      expected: { matchId: 'match-2' },
      reason: 'match-id-mismatch',
    },
    {
      label: 'different tournament',
      expected: { tournamentId: 'tournament-2' },
      reason: 'tournament-id-mismatch',
    },
  ])('$label cannot fall back to same team names', ({ expected, reason }) => {
    const identity = {
      tournamentId: 'tournament-1',
      matchId: 'match-1',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    };
    const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, identity);
    const inspected = inspectScorerRecovery(qbj, {
      ...identity,
      ...expected,
    });

    expect(inspected).toEqual({ kind: 'rejected', reason });
    expect(readScorerRecovery(qbj, { ...identity, ...expected })).toBeNull();
  });

  test('same tournament and match identity succeeds, including a rematch-shaped setup', () => {
    const identity = {
      tournamentId: 'tournament-1',
      matchId: 'round-8-match-17',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    };
    const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, identity);

    expect(readScorerRecovery(qbj, { ...identity })).not.toBeNull();
    expect(readScorerRecovery(qbj, { ...identity, matchId: 'round-2-match-4' })).toBeNull();
  });

  test('reversed team orientation remains incompatible', () => {
    const identity = {
      tournamentId: 'tournament-1',
      matchId: 'match-1',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    };
    const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, identity);
    expect(
      inspectScorerRecovery(qbj, {
        ...identity,
        leftTeamName: 'Right',
        rightTeamName: 'Left',
      }),
    ).toEqual({ kind: 'rejected', reason: 'team-mismatch' });
  });

  test('discards malformed auxiliary history while retaining valid events', () => {
    const qbj = {
      [scorerRecoveryKey]: {
        version: scorerRecoveryVersion,
        setup,
        events,
        history: {
          undo: [0],
          redo: [[{ id: 'bad-redo', type: 'not-a-score-event', questionNumber: 2 }]],
        },
      },
    };

    const recovered = readScorerRecovery(qbj, setup, { allowLegacy: true });
    expect(recovered?.events).toEqual(events);
    expect(recovered?.history).toBeUndefined();
  });

  test('does not write malformed auxiliary history', () => {
    const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, {
      undo: [events.length + 1],
      redo: [],
    } as unknown as IGameSessionHistory);

    expect(recoveryOf(qbj)).toEqual({
      version: scorerRecoveryVersion,
      setup,
      events,
    });
  });

  test('keeps a valid history stack when its sibling stack is malformed', () => {
    const qbj = {
      [scorerRecoveryKey]: {
        version: scorerRecoveryVersion,
        setup,
        events,
        history: {
          undo: [1],
          redo: [[{ id: 'bad-redo', type: 'not-a-score-event', questionNumber: 2 }]],
        },
      },
    };

    expect(readScorerRecovery(qbj, setup, { allowLegacy: true })?.history).toEqual({ undo: [1], redo: [] });
  });

  describe('definition identity (#670)', () => {
    const baseIdentity = {
      tournamentId: 'tournament-1',
      matchId: 'match-1',
      leftTeamName: 'Left',
      rightTeamName: 'Right',
    };

    test('derives the definition identity from the scheduled package', () => {
      const packageValue = validPackage({
        definition: { revision: 2, digest: 'digest-definition-b' },
      });
      expect(scorerRecoveryIdentity(packageValue, setup)).toMatchObject({
        definitionRevision: 2,
        definitionDigest: 'digest-definition-b',
      });
    });

    test('an exact digest match recovers normally', () => {
      const identity = {
        ...baseIdentity,
        definitionRevision: 2,
        definitionDigest: 'digest-definition-b',
      };
      const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, identity);
      expect(inspectScorerRecovery(qbj, identity)).toMatchObject({ kind: 'compatible' });
      expect(readScorerRecovery(qbj, identity)).not.toBeNull();
    });

    test('same match identity under a different definition is review-required, never compatible', () => {
      const identity = {
        ...baseIdentity,
        definitionRevision: 1,
        definitionDigest: 'digest-definition-a',
      };
      const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, identity);
      const expected = { ...identity, definitionRevision: 2, definitionDigest: 'digest-definition-b' };
      expect(inspectScorerRecovery(qbj, expected)).toMatchObject({
        kind: 'review-required',
        reason: 'definition-mismatch',
      });
      // Not even the trusted session-snapshot fallback may replay events scored under one
      // definition under another format.
      expect(readScorerRecovery(qbj, expected)).toBeNull();
      expect(readScorerRecovery(qbj, expected, { allowLegacy: true })).toBeNull();
    });

    test('a payload without definition identity is review-required against a bound game', () => {
      const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, baseIdentity);
      const expected = { ...baseIdentity, definitionRevision: 2, definitionDigest: 'digest-definition-b' };
      expect(inspectScorerRecovery(qbj, expected)).toMatchObject({
        kind: 'review-required',
        reason: 'missing-definition-identity',
      });
      expect(readScorerRecovery(qbj, expected, { allowLegacy: true })).toBeNull();
    });

    test('legacy payloads keep their legacy behavior when neither side is bound', () => {
      const qbj = attachScorerRecovery({ type: 'Match' }, setup, events, undefined, baseIdentity);
      expect(inspectScorerRecovery(qbj, baseIdentity)).toMatchObject({ kind: 'compatible' });
      expect(readScorerRecovery(qbj, baseIdentity)).not.toBeNull();
    });

    test('rejects a malformed definition identity instead of degrading silently', () => {
      const qbj = {
        [scorerRecoveryKey]: {
          version: scorerRecoveryVersion,
          setup,
          events,
          identity: { ...baseIdentity, definitionRevision: 0, definitionDigest: '   ' },
        },
      };
      expect(inspectScorerRecovery(qbj, baseIdentity)).toEqual({ kind: 'rejected', reason: 'invalid' });
    });
  });

  test('does not carry the v2 history into portable QBJ', () => {
    const qbj = attachScorerRecovery({ type: 'Match', match_teams: [] }, setup, events, {
      undo: [1],
      redo: [
        [
          {
            id: 'redo-with-secret',
            type: 'tossup-dead',
            questionNumber: 3,
            token: 'secret',
          } as unknown as ScoreEvent,
        ],
      ],
    });

    const portable = portableQbj(qbj, validPackage());
    expect(portable).not.toHaveProperty(scorerRecoveryKey);
    expect(JSON.stringify(portable)).not.toContain('redo-with-secret');
    expect(JSON.stringify(portable)).not.toContain('secret');
  });
});
