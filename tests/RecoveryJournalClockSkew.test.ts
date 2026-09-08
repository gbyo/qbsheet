import { expect, test } from 'vitest';
import { inspectJournal } from '../src/app/RecoveryJournal';
import { gameSessionVersion } from '../src/scorer/GameSession';
import { validPackage } from './packages';

const now = new Date('2026-08-20T14:00:00.000Z');
const gamePackage = validPackage();
const setup = {
  left: { name: gamePackage.left.name, players: gamePackage.left.players.map((player) => player.name) },
  right: { name: gamePackage.right.name, players: gamePackage.right.players.map((player) => player.name) },
};

function journal(updatedAt: string): string {
  return JSON.stringify({
    version: gameSessionVersion,
    gameKey: 'session-a',
    setup,
    events: [],
    updatedAt,
  });
}

test('treats a future journal timestamp as fresh after a backward clock correction', () => {
  const raw = journal(new Date(now.getTime() + 60 * 60 * 1000).toISOString());

  expect(inspectJournal('session-a', raw, now)).toMatchObject({
    status: 'valid',
    updatedAt: '2026-08-20T15:00:00.000Z',
  });
});
