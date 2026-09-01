/**
 * The one thing the arcade remembers, and what happens on a device that will not let it.
 *
 * The second half is the half that matters. A school Chromebook with a locked-down profile refuses
 * `localStorage`, and the required behaviour there is a working game with no memory — not a thrown
 * exception inside a dialog somebody opened to pass ten minutes between rounds.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  arcadeBestScoreKeys,
  clearBestScores,
  loadBestScore,
  saveBestScore,
  type IArcadeStorage,
} from '../src/arcade/arcadeScores';

/** A storage that refuses everything, the way a blocked profile's does. */
const refusing: IArcadeStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('where a best score lives', () => {
  test('the keys are namespaced to the arcade and to one game each', () => {
    expect(arcadeBestScoreKeys.qbbird).toBe('qbsheet.arcade.qbbird.bestScore');
    expect(arcadeBestScoreKeys.snake).toBe('qbsheet.arcade.snake.bestScore');
  });

  test('nothing it writes touches a key any other part of QBSheet reads', () => {
    saveBestScore('qbbird', 7);
    saveBestScore('snake', 3);
    const written = Array.from({ length: window.localStorage.length }, (_unused, index) =>
      window.localStorage.key(index),
    );
    expect(written).toHaveLength(2);
    written.forEach((key) => expect(key?.startsWith('qbsheet.arcade.')).toBe(true));
  });

  test('a best score survives being written and read back, per game', () => {
    expect(saveBestScore('qbbird', 12)).toBe(true);
    expect(loadBestScore('qbbird')).toBe(12);
    // The other game is untouched by it.
    expect(loadBestScore('snake')).toBe(0);
  });

  test('a device that has never played has a best of zero rather than nothing', () => {
    expect(loadBestScore('qbbird')).toBe(0);
    expect(loadBestScore('snake')).toBe(0);
  });

  test('a stored value that never meant anything reads as zero', () => {
    window.localStorage.setItem(arcadeBestScoreKeys.snake, 'not a number');
    expect(loadBestScore('snake')).toBe(0);
    window.localStorage.setItem(arcadeBestScoreKeys.snake, '-4');
    expect(loadBestScore('snake')).toBe(0);
    window.localStorage.setItem(arcadeBestScoreKeys.snake, '3.5');
    expect(loadBestScore('snake')).toBe(0);
  });

  test('a score that is not a whole count is refused rather than stored', () => {
    expect(saveBestScore('qbbird', 1.5)).toBe(false);
    expect(saveBestScore('qbbird', -1)).toBe(false);
    expect(window.localStorage.getItem(arcadeBestScoreKeys.qbbird)).toBeNull();
  });

  test('clearing forgets both', () => {
    saveBestScore('qbbird', 9);
    saveBestScore('snake', 4);
    clearBestScores();
    expect(loadBestScore('qbbird')).toBe(0);
    expect(loadBestScore('snake')).toBe(0);
  });
});

describe('a device with no storage at all', () => {
  test('reading answers zero instead of throwing', () => {
    expect(loadBestScore('qbbird', null)).toBe(0);
    expect(loadBestScore('qbbird', refusing)).toBe(0);
  });

  test('writing reports that it did not stick, and does not throw', () => {
    expect(saveBestScore('snake', 5, null)).toBe(false);
    expect(saveBestScore('snake', 5, refusing)).toBe(false);
  });

  test('clearing is a no-op rather than an error', () => {
    expect(() => clearBestScores(null)).not.toThrow();
    expect(() => clearBestScores(refusing)).not.toThrow();
  });
});
