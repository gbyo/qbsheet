import { describe, expect, test } from 'vitest';
import { acceptedGameRecords, emptyDirectorState, type GameRecord } from '../src/index.js';

function result(id: string, score: number): GameRecord {
  return {
    id,
    scheduledGameId: 'scheduled-1',
    roundId: 'round-1',
    packetId: null,
    status: 'accepted',
    scores: [
      {
        teamId: 'a',
        score,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
      },
      {
        teamId: 'b',
        score: 100,
        superpowers: 0,
        powers: 0,
        gets: 0,
        negs: 0,
        bonuses: 0,
        bonusPoints: 0,
        bouncebacks: 0,
      },
    ],
    playerStats: [],
    source: 'manual',
  };
}

describe('acceptedGameRecords', () => {
  test('chooses the newest correction by instant across UTC offsets', () => {
    const state = emptyDirectorState();
    state.games = [result('older', 200), result('newer', 300)];
    state.submissions = [
      {
        id: 'submission-older',
        gameId: 'older',
        receivedAt: '2026-09-05T14:15:00Z',
        fingerprint: 'older',
        status: 'accepted',
        rawSubmission: {},
        acceptedAt: '2026-09-05T14:15:00Z',
      },
      {
        id: 'submission-newer',
        gameId: 'newer',
        receivedAt: '2026-09-05T10:30:00-04:00',
        fingerprint: 'newer',
        status: 'accepted',
        rawSubmission: {},
        acceptedAt: '2026-09-05T10:30:00-04:00',
      },
    ];

    const accepted = acceptedGameRecords(state);

    expect(accepted.map((game) => game.id)).toEqual(['newer']);
  });
});
