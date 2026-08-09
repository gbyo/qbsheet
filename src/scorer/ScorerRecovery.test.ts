import { describe, expect, it } from 'vitest';
import { gameSessionVersion, loadGame } from './GameSession';
import { readScorerRecovery, scorerRecoveryKey, scorerRecoveryVersion, validEvent } from './ScorerRecovery';

const validSetup = {
  left: { name: 'Left', players: ['Alice', 'Avery'] },
  right: { name: 'Right', players: ['Blake', 'Bailey'] },
};

function recoveryWithSetup(setup: unknown): object {
  return {
    [scorerRecoveryKey]: {
      version: scorerRecoveryVersion,
      setup,
      events: [],
    },
  };
}

describe('readScorerRecovery', () => {
  it('rejects recovery with a missing player list', () => {
    const setup = {
      left: { name: 'Left' },
      right: validSetup.right,
    };
    expect(readScorerRecovery(recoveryWithSetup(setup), validSetup)).toBeNull();
  });

  it.each([
    { label: 'non-array players', players: 'Alice' },
    { label: 'non-string player', players: ['Alice', 42] },
    { label: 'blank player', players: ['Alice', '   '] },
  ])('rejects recovery with $label', ({ players }) => {
    const setup = {
      left: { name: 'Left', players },
      right: validSetup.right,
    };
    expect(readScorerRecovery(recoveryWithSetup(setup), validSetup)).toBeNull();
  });
});

describe('loadGame', () => {
  it('rejects stored games with malformed player lists', () => {
    const now = new Date('2026-08-08T12:00:00.000Z');
    const stored = JSON.stringify({
      version: gameSessionVersion,
      gameKey: 'game-1',
      setup: {
        left: validSetup.left,
        right: { name: 'Right', players: ['Blake', ''] },
      },
      events: [],
      updatedAt: now.toISOString(),
    });
    const storage = {
      getItem: () => stored,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(loadGame('game-1', now, storage)).toBeNull();
  });
});

describe('validEvent', () => {
  const buzz = {
    id: 'buzz-1',
    type: 'tossup-buzz',
    questionNumber: 1,
    team: 'left',
    playerName: 'Alice',
    answerTypeIndex: 0,
  };

  it('rejects blank tossup player names', () => {
    expect(validEvent({ ...buzz, playerName: '   ' })).toBe(false);
  });

  it('rejects negative tossup answer type indexes', () => {
    expect(validEvent({ ...buzz, answerTypeIndex: -1 })).toBe(false);
  });
});
