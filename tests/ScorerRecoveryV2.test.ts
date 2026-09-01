import { describe, expect, test } from 'vitest';
import { portableQbj } from '../src/game/PortableQbj';
import { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import type { IGameSessionHistory } from '../src/scorer/GameSession';
import {
  attachScorerRecovery,
  legacyScorerRecoveryVersion,
  readScorerRecovery,
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
    expect(readScorerRecovery(qbj, setup)).toEqual({
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

    expect(readScorerRecovery(qbj, setup)).toEqual({
      version: legacyScorerRecoveryVersion,
      setup,
      events,
    });
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

    const recovered = readScorerRecovery(qbj, setup);
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

    expect(readScorerRecovery(qbj, setup)?.history).toEqual({ undo: [1], redo: [] });
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
