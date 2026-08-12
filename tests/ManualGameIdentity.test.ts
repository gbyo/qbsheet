/**
 * What a record is filed under, and the one case where the package cannot say.
 *
 * `gamePackageIdentity` answers "which scheduled game is this", and for a file or a connected
 * assignment that is exactly the right question: opening the same file twice must find the game
 * already in progress rather than start a second copy of it. Nothing here loosens that.
 *
 * A practice has no answer to that question. Two games between the same two teams on the same
 * afternoon share every field the identity is built from, and they are two games. The fields that
 * would tell them apart — a scheduled match id, a tournament key — mean something outside this
 * device, so the fix is a local identity the store is handed rather than a fabricated one it
 * derives.
 */
import { describe, expect, test } from 'vitest';
import { memoryGameStore } from '../src/game/GameStore';
import { gamePackageIdentity } from '../src/game/GamePackage';
import { defineManualGame, newManualRecordIdentity } from '../src/game/ManualGame';
import { basicScoringRulesDefaults } from '../src/qbj/BasicScoringRules';
import { manualRoundOptionDefaults } from '../src/game/ManualGame';
import { setupFromPackage } from '../src/app/App';
import { validPackage } from './packages';

function manualDefinition(label = 'Practice game') {
  const result = defineManualGame({
    gameLabel: label,
    left: { name: 'Ninety Six', players: 'Sarah\nJames' },
    right: { name: 'Greenwood', players: 'Emma\nJordan' },
    rules: { ...basicScoringRulesDefaults },
    options: { ...manualRoundOptionDefaults },
  });
  if (!result.ok) throw new Error('fixture does not define a game');
  return result.definition;
}

describe('creating a record without a local identity', () => {
  test('still files it under the package identity, exactly as before', async () => {
    const store = memoryGameStore();
    const packageValue = validPackage();

    const created = await store.create({
      package: packageValue,
      setup: setupFromPackage(packageValue),
      connected: false,
    });

    expect(created.identity).toBe(gamePackageIdentity(packageValue));
    expect(await store.findByIdentity(gamePackageIdentity(packageValue))).toHaveLength(1);
  });

  test('the same file opened twice is still one identity, which is what resume is built on', async () => {
    const store = memoryGameStore();
    const packageValue = validPackage();
    const setup = setupFromPackage(packageValue);

    await store.create({ package: packageValue, setup, connected: false });
    await store.create({ package: packageValue, setup, connected: false, attempt: 2 });

    const found = await store.findByIdentity(gamePackageIdentity(packageValue));
    expect(found).toHaveLength(2);
    expect(found.map((record) => record.attempt).sort()).toEqual([1, 2]);
  });
});

describe('creating a record with a local identity', () => {
  test('overrides only where the record is filed', async () => {
    const store = memoryGameStore();
    const packageValue = validPackage();
    const identity = 'manual:fixed-for-this-test';

    const created = await store.create({
      package: packageValue,
      setup: setupFromPackage(packageValue),
      connected: false,
      recordIdentity: identity,
    });

    expect(created.identity).toBe(identity);
    expect(created.id).toBe(identity);
    // The package is untouched: the override is a filing decision, not a change to the game.
    expect(created.package).toEqual(packageValue);
    expect(await store.findByIdentity(gamePackageIdentity(packageValue))).toHaveLength(0);
  });

  test('the local identity is not written into the package, and so cannot reach a QBJ', async () => {
    const store = memoryGameStore();
    const definition = manualDefinition();
    const identity = newManualRecordIdentity();

    const created = await store.create({
      package: definition,
      setup: setupFromPackage(definition),
      connected: false,
      recordIdentity: identity,
    });

    expect(JSON.stringify(created.package)).not.toContain(identity);
    expect(JSON.stringify(created.package)).not.toContain('manual:');
  });

  test('two practices with identical teams, label and rules are two independent records', async () => {
    const store = memoryGameStore();
    const first = manualDefinition();
    const second = manualDefinition();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const one = await store.create({
      package: first,
      setup: setupFromPackage(first),
      connected: false,
      recordIdentity: newManualRecordIdentity(),
    });
    const two = await store.create({
      package: second,
      setup: setupFromPackage(second),
      connected: false,
      recordIdentity: newManualRecordIdentity(),
    });

    expect(one.id).not.toBe(two.id);
    expect(one.gameKey).not.toBe(two.gameKey);
    expect(await store.list()).toHaveLength(2);

    // And their event journals are separate, which is the thing the identity is actually protecting.
    expect(store.saveEvents(one.id, [])).toBeDefined();
    const listed = await store.list();
    expect(new Set(listed.map((record) => record.gameKey)).size).toBe(2);
  });

  test('a manual record survives being looked up the ordinary way', async () => {
    const store = memoryGameStore();
    const definition = manualDefinition();
    const identity = newManualRecordIdentity();

    const created = await store.create({
      package: definition,
      setup: setupFromPackage(definition),
      connected: false,
      recordIdentity: identity,
    });

    expect((await store.get(created.id))?.identity).toBe(identity);
    expect(await store.findByIdentity(identity)).toHaveLength(1);
  });
});
