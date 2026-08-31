/**
 * A half-scored game surviving a reload, and not turning into two games.
 */
import { describe, expect, test } from 'vitest';
import {
  clearGame,
  gameSessionMaxAgeMs,
  gameSessionVersion,
  legacyGameSessionVersion,
  exportJournals,
  loadGame,
  saveGame,
} from '../src/scorer/GameSession';
import deriveGame, { IGameSetup } from '../src/scoring/deriveGame';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import scoringRulesToScorekeeperFormat from './rules';
import { CommonRuleSets, ScoringRules } from './rules';

function memoryStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    raw: store,
  };
}

const setup: IGameSetup = {
  left: { name: 'Ninety Six', players: ['Sarah', 'James'] },
  right: { name: 'Greenwood', players: ['Emma', 'Jordan'] },
};

const events: ScoreEvent[] = [
  { id: 'e1', type: 'tossup-buzz', questionNumber: 1, team: 'left', playerName: 'Sarah', answerTypeIndex: 0 },
  { id: 'e2', type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 20 },
];

const now = new Date('2026-08-08T14:00:00Z');

describe('saving and resuming', () => {
  test('a saved game comes back with its events intact', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    const loaded = loadGame('session-a', now, storage);

    expect(loaded?.events).toEqual(events);
    expect(loaded?.setup.left.name).toBe('Ninety Six');
  });

  test('an offline-added player survives reload with exact TUH and points', () => {
    const storage = memoryStorage();
    const rules = new ScoringRules(CommonRuleSets.AcfPowers);
    rules.maximumPlayersPerTeam = 1;
    const format = scoringRulesToScorekeeperFormat(rules);
    const ten = format.answerTypes.find((answerType) => answerType.value === 10)!.index;
    const offlineEvents: ScoreEvent[] = [
      { id: 'dead-1', type: 'tossup-dead', questionNumber: 1 },
      { id: 'add-1', type: 'roster-add', questionNumber: 2, team: 'left', playerName: 'Taylor' },
      { id: 'lineup-1', type: 'substitution', questionNumber: 2, team: 'left', activePlayers: ['Taylor'] },
      {
        id: 'buzz-2',
        type: 'tossup-buzz',
        questionNumber: 2,
        team: 'left',
        playerName: 'Taylor',
        answerTypeIndex: ten,
      },
      { id: 'bonus-2', type: 'bonus', questionNumber: 2, team: 'left', controlledPoints: 20 },
    ];
    saveGame('session-offline', setup, offlineEvents, now, storage);

    const loaded = loadGame('session-offline', now, storage)!;
    const game = deriveGame(format, loaded.setup, loaded.events);
    const taylor = game.left.players.find((player) => player.name === 'Taylor');

    expect(taylor?.tossupsHeard).toBe(1);
    expect(taylor?.points).toBe(10);
    expect(game.left.points).toBe(30);
  });

  test('saving twice replaces rather than accumulating, so a reload does not duplicate the game', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);
    saveGame('session-a', setup, events.concat(events[0]), now, storage);

    expect(loadGame('session-a', now, storage)?.events).toHaveLength(3);
    expect(Object.keys(storage.raw)).toHaveLength(1);
  });

  test('chooses the newest valid journal when transitional versioned keys coexist', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events.concat(events[0]), now, storage);
    storage.raw['yellowfruit.room.game.v2.session-a'] = JSON.stringify({
      version: gameSessionVersion,
      gameKey: 'session-a',
      setup,
      events,
      updatedAt: new Date(now.getTime() - 1_000).toISOString(),
    });

    expect(loadGame('session-a', now, storage)?.events).toHaveLength(3);
  });

  test('crash export keeps the newest transitional journal rather than a stale duplicate', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);
    storage.raw['yellowfruit.room.game.v2.session-a'] = JSON.stringify({
      version: gameSessionVersion,
      gameKey: 'session-a',
      setup,
      events: events.concat(events[0]),
      updatedAt: new Date(now.getTime() + 1_000).toISOString(),
    });

    expect(JSON.parse(exportJournals(storage)['session-a']).events).toHaveLength(3);
  });

  test('action-level history survives a reload alongside the event list', () => {
    const storage = memoryStorage();
    const history = {
      undo: [2],
      redo: [[{ id: 'redo-1', type: 'tossup-dead' as const, questionNumber: 2 }]],
    };
    saveGame('session-history', setup, events, now, storage, history);

    expect(loadGame('session-history', now, storage)?.history).toEqual(history);
  });

  test('a different game is a different key, so the next round starts empty', () => {
    // The failure this prevents is the worst kind: a plausible wrong result rather than a blank one.
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    expect(loadGame('session-b', now, storage)).toBeNull();
  });

  test('no saved game reads as null rather than throwing', () => {
    expect(loadGame('session-a', now, memoryStorage())).toBeNull();
  });

  test('clearing forgets the game', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    clearGame('session-a', storage);

    expect(loadGame('session-a', now, storage)).toBeNull();
  });
});

describe('what is refused', () => {
  test('a game from a previous tournament is too old to offer', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    const muchLater = new Date(now.getTime() + gameSessionMaxAgeMs + 1000);

    expect(loadGame('session-a', muchLater, storage)).toBeNull();
  });

  test('a game still within the window is offered', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    const laterSameDay = new Date(now.getTime() + gameSessionMaxAgeMs - 1000);

    expect(loadGame('session-a', laterSameDay, storage)).not.toBeNull();
  });

  test('a game saved by a different version is not guessed at', () => {
    const storage = memoryStorage({
      'yellowfruit.room.game.v1.session-a': JSON.stringify({
        version: gameSessionVersion + 1,
        gameKey: 'session-a',
        setup,
        events,
        updatedAt: now.toISOString(),
      }),
    });

    expect(loadGame('session-a', now, storage)).toBeNull();
  });

  test('corrupt storage reads as no saved game rather than crashing the page', () => {
    const storage = memoryStorage({ 'yellowfruit.room.game.v1.session-a': '{not json' });

    expect(loadGame('session-a', now, storage)).toBeNull();
  });

  test('a saved game missing its teams is refused', () => {
    const storage = memoryStorage({
      'yellowfruit.room.game.v1.session-a': JSON.stringify({
        version: gameSessionVersion,
        gameKey: 'session-a',
        setup: {},
        events,
        updatedAt: now.toISOString(),
      }),
    });

    expect(loadGame('session-a', now, storage)).toBeNull();
  });

  test('a saved game with an individually malformed event is refused', () => {
    const storage = memoryStorage({
      'yellowfruit.room.game.v1.session-a': JSON.stringify({
        version: gameSessionVersion,
        gameKey: 'session-a',
        setup,
        events: [
          {
            id: 'bad-event',
            type: 'tossup-buzz',
            questionNumber: 'one',
            team: 'left',
            playerName: 'Sarah',
            answerTypeIndex: 0,
          },
        ],
        updatedAt: now.toISOString(),
      }),
    });

    expect(loadGame('session-a', now, storage)).toBeNull();
  });

  test('malformed action metadata is discarded while usable events still recover', () => {
    const storage = memoryStorage({
      'yellowfruit.room.game.v1.session-a': JSON.stringify({
        version: gameSessionVersion,
        gameKey: 'session-a',
        setup,
        events,
        history: {
          undo: [1],
          redo: [[{ id: 'bad-redo', type: 'not-a-score-event', questionNumber: 1 }]],
        },
        updatedAt: now.toISOString(),
      }),
    });

    const loaded = loadGame('session-a', now, storage);
    expect(loaded?.events).toEqual(events);
    expect(loaded?.history).toEqual({ undo: [1], redo: [] });
  });

  test('legacy v1 journals still load without inventing action history', () => {
    const storage = memoryStorage({
      'yellowfruit.room.game.v1.legacy': JSON.stringify({
        version: legacyGameSessionVersion,
        gameKey: 'legacy',
        setup,
        events,
        updatedAt: now.toISOString(),
      }),
    });

    const loaded = loadGame('legacy', now, storage);
    expect(loaded?.version).toBe(gameSessionVersion);
    expect(loaded?.events).toEqual(events);
    expect(loaded?.history).toBeUndefined();
  });

  test('an empty key saves nothing, rather than sharing one bucket between games', () => {
    const storage = memoryStorage();

    expect(saveGame('', setup, events, now, storage)).toBe(false);
    expect(Object.keys(storage.raw)).toHaveLength(0);
  });
});

describe('storage that refuses to cooperate', () => {
  const hostile = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };

  test('a refused write is reported rather than silently assumed', () => {
    // The scorer promises the scorekeeper their game is saved. It only says so when it is true.
    expect(saveGame('session-a', setup, events, now, hostile)).toBe(false);
  });

  test('a refused read is survivable', () => {
    expect(loadGame('session-a', now, hostile)).toBeNull();
  });

  test('no storage at all is survivable', () => {
    expect(saveGame('session-a', setup, events, now, null)).toBe(false);
    expect(loadGame('session-a', now, null)).toBeNull();
  });
});

describe('what must not be stored', () => {
  test('nothing a caller passes carries a token, and the payload is only the game', () => {
    const storage = memoryStorage();
    saveGame('session-a', setup, events, now, storage);

    const raw = storage.raw['yellowfruit.room.game.v1.session-a'];
    const parsed = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual(['events', 'gameKey', 'setup', 'updatedAt', 'version']);
  });
});
