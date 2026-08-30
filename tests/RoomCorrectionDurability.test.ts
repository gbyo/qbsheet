/**
 * @vitest-environment jsdom
 */

/**
 * A correction is one write from the room's point of view, or it did not happen.
 *
 * The hazard this file exists for: a correction that changed a player's name touches the event
 * history *and* the rosters those events refer to. Half of that landing is worse than none of it —
 * the reload afterwards would produce a game whose buzzes name somebody who is on no roster, which
 * `validateScoresheet` refuses and no dialog can undo.
 *
 * So both go through `saveEvents` together, the journal is the copy that decides whether the room
 * may be told anything, and a refused journal write leaves the device holding exactly the game it
 * had.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import { memoryGameStore } from '../src/game/GameStore';
import { loadGame } from '../src/scorer/GameSession';
import { setupFromPackage } from '../src/app/App';
import { validPackage } from './packages';
import { event } from './events';
import { ScoreEvent } from '../src/scoring/ScoreEvents';
import { correctPlayerName } from '../src/scoring/identityCorrection';
import deriveGame from '../src/scoring/deriveGame';
import { validateCorrectedHistory } from '../src/scoring/validateScoresheet';

const packageValue = validPackage();
const format = packageValue.scorekeeperFormat;
const correctType = format.answerTypes.find((answerType) => answerType.value > 0);
const correct = correctType?.index ?? 0;

async function startedGame() {
  const store = memoryGameStore();
  const setup = setupFromPackage(packageValue);
  const record = await store.create({ package: packageValue, setup, connected: false });
  // A read is what registers the journal key; the application always has one by this point.
  await store.get(record.id);
  const history: ScoreEvent[] = [
    event({
      type: 'tossup-buzz',
      questionNumber: 1,
      team: 'left',
      playerName: setup.left.players[0],
      answerTypeIndex: correct,
    }),
    event({ type: 'bonus', questionNumber: 1, team: 'left', controlledPoints: 10, bouncebackPoints: 0 }),
  ];
  expect(store.saveEvents(record.id, history)).toBe(true);
  return { store, record, setup, history };
}

beforeEach(() => window.localStorage.clear());

describe('a name correction survives a reload', () => {
  test('the rewritten history and the roster it refers to are journalled together', async () => {
    const { store, record, setup, history } = await startedGame();
    const original = setup.left.players[0];

    const corrected = correctPlayerName({ setup, events: history }, 'left', original, 'Corrected Name');
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error('unreachable');

    expect(store.saveEvents(record.id, corrected.events, corrected.setup)).toBe(true);

    const journalled = loadGame(record.gameKey);
    expect(journalled?.setup.left.players).toContain('Corrected Name');
    expect(journalled?.setup.left.players).not.toContain(original);
    const reloaded = deriveGame(format, journalled!.setup, journalled!.events);
    expect(reloaded.left.players.find((player) => player.name === 'Corrected Name')?.points).toBe(
      correctType?.value,
    );
    expect(validateCorrectedHistory(format, journalled!.setup, journalled!.events).blockers).toEqual([]);
  });

  test('the durable record catches up with the same pair', async () => {
    const { store, record, setup, history } = await startedGame();
    const corrected = correctPlayerName(
      { setup, events: history },
      'left',
      setup.left.players[0],
      'Corrected Name',
    );
    if (!corrected.ok) throw new Error('unreachable');
    store.saveEvents(record.id, corrected.events, corrected.setup);

    const stored = await store.get(record.id);
    expect(stored?.setup.left.players).toContain('Corrected Name');
    expect(
      stored?.events.some(
        (candidate) => candidate.type === 'tossup-buzz' && candidate.playerName === 'Corrected Name',
      ),
    ).toBe(true);
  });

  test('a second correction journals against the corrected roster, not the original one', async () => {
    const { store, record, setup, history } = await startedGame();
    const first = correctPlayerName({ setup, events: history }, 'left', setup.left.players[0], 'Once');
    if (!first.ok) throw new Error('unreachable');
    store.saveEvents(record.id, first.events, first.setup);

    const second = correctPlayerName({ setup: first.setup, events: first.events }, 'left', 'Once', 'Twice');
    if (!second.ok) throw new Error('unreachable');
    // No `setup` this time: the store must already be holding the corrected one.
    store.saveEvents(record.id, second.events);

    const journalled = loadGame(record.gameKey);
    expect(journalled?.setup.left.players).toContain('Once');
    expect(journalled?.setup.left.players).not.toContain(setup.left.players[0]);
  });
});

/*
 * A browser that refuses the write, for the duration of one call.
 *
 * Patched on the prototype, reached through the instance, because neither of the two obvious
 * spellings is portable.
 *
 * `window.localStorage.setItem = ...` looks like it shadows the method, and on some engines it
 * does -- but `localStorage` is a proxy with a named-property setter, so on others the assignment
 * is *stored as an item called `setItem`* while the real method keeps working, and the test then
 * asserts against a write that actually succeeded. That is what CI was catching on Node 20.
 *
 * `Storage.prototype` is no better: Node 22 added a `Storage` global of its own for its
 * experimental web storage, so under jsdom the bare name can resolve to a class that has nothing
 * to do with the `localStorage` in this window. Going through the instance asks the object itself
 * which prototype it has, which is true on every version.
 */
function withRefusedWrites<T>(body: () => T): T {
  const storage = Object.getPrototypeOf(window.localStorage) as Storage;
  const setItem = storage.setItem;
  storage.setItem = () => {
    throw new Error('quota');
  };
  try {
    return body();
  } finally {
    storage.setItem = setItem;
  }
}

describe('a refused local write', () => {
  test('is reported rather than absorbed, and leaves the device holding what it had', async () => {
    const { store, record, setup, history } = await startedGame();
    const before = loadGame(record.gameKey);

    const corrected = correctPlayerName(
      { setup, events: history },
      'left',
      setup.left.players[0],
      'Corrected Name',
    );
    if (!corrected.ok) throw new Error('unreachable');

    // A locked-down profile, a full quota, a browser that simply says no.
    expect(withRefusedWrites(() => store.saveEvents(record.id, corrected.events, corrected.setup))).toBe(
      false,
    );

    // Nothing moved. `ScoringScreen` turns that `false` into a throw, which keeps the dialog open
    // and stops the scoresheet redrawing under a definition that exists only in memory.
    expect(loadGame(record.gameKey)).toEqual(before);
  });

  test('a refused write does not leave the store journalling against a roster it never saved', async () => {
    const { store, record, setup, history } = await startedGame();
    const corrected = correctPlayerName(
      { setup, events: history },
      'left',
      setup.left.players[0],
      'Corrected Name',
    );
    if (!corrected.ok) throw new Error('unreachable');

    withRefusedWrites(() => store.saveEvents(record.id, corrected.events, corrected.setup));

    // The next ordinary save is against the roster this device actually has.
    expect(store.saveEvents(record.id, history)).toBe(true);
    expect(loadGame(record.gameKey)?.setup.left.players).toEqual(setup.left.players);
  });
});
