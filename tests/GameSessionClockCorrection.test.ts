import { describe, expect, test } from 'vitest';
import { inspectGameJournal, loadGame, saveGame } from '../src/scorer/GameSession';
import type { IGameSetup } from '../src/scoring/deriveGame';
import type { ScoreEvent } from '../src/scoring/ScoreEvents';

function memoryStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah'] },
  right: { name: 'Greenwood', players: ['Emma'] },
};

const events: ScoreEvent[] = [
  { id: 'dead-1', type: 'tossup-dead', questionNumber: 1 },
  {
    id: 'buzz-2',
    type: 'tossup-buzz',
    questionNumber: 2,
    team: 'left',
    playerName: 'Sarah',
    answerTypeIndex: 0,
  },
];

describe('game journal clock corrections', () => {
  test('a backward device-clock correction does not hide a freshly saved game', () => {
    const storage = memoryStorage();
    const savedAt = new Date('2026-09-06T18:00:00Z');

    expect(saveGame('session-a', setup, events, savedAt, storage)).toBe(true);

    const correctedNow = new Date('2026-09-06T17:00:00Z');
    expect(loadGame('session-a', correctedNow, storage)?.events).toEqual(events);

    const inspection = inspectGameJournal('session-a', correctedNow, storage);
    expect(inspection.status).toBe('valid');
    expect(inspection.value?.events).toEqual(events);
    expect(inspection.copies).toEqual([
      expect.objectContaining({ key: 'current', status: 'valid' }),
    ]);
  });
});
