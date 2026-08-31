/**
 * A game saved by one build, opened by the next one.
 *
 * This is the test for the failure mode that a version number invites. The old `GameStore` read
 * records whose version matched exactly and ignored the rest, so the first commit to bump the constant
 * would have made every saved game — the unfinished round included — disappear from the welcome screen
 * on the morning it was deployed. Nothing would have failed. The games would simply not have been
 * there.
 *
 * So the cases below are deliberately about *data surviving*, not about the reader returning the right
 * enum. An in-progress game must come back with the same events, against the same rosters, at the same
 * score; and a record this build genuinely cannot read must still be sitting in storage afterwards.
 */
import { describe, expect, test } from 'vitest';
import {
  RawRecord,
  UpgradeStep,
  gameRecordVersion,
  readStoredRecord,
  upgradeSteps,
} from '../src/game/GameRecordUpgrade';
import { GameRecordConflictError, GameStore, IStoredGameRecord, isActive } from '../src/game/GameStore';
import { IRecordStore, MemoryRecordStore } from '../src/persistence/GameDatabase';
import deriveGame from '../src/scoring/deriveGame';
import { validPackage } from './packages';
import { setupFromPackage } from '../src/app/App';
import { unreadableNotice } from '../src/app/WelcomeScreen';

/** A record as a build at `version` would have written it, mid-game. */
function storedGame(version: number, extra: RawRecord = {}): RawRecord {
  const packageValue = validPackage();
  return {
    version,
    id: 'spring:round-3:room-204',
    identity: 'spring:round-3:room-204',
    attempt: 1,
    gameKey: 'spring_round-3_room-204',
    package: packageValue,
    setup: setupFromPackage(packageValue),
    events: [],
    connected: false,
    createdAt: '2026-04-11T14:00:00.000Z',
    updatedAt: '2026-04-11T14:12:00.000Z',
    serverDelivery: 'none',
    ...extra,
  };
}

class DelayedRecordStore implements IRecordStore<IStoredGameRecord> {
  readonly durable = false;

  private readonly records = new MemoryRecordStore<IStoredGameRecord>();

  private delay:
    | {
        started: () => void;
        wait: Promise<void>;
      }
    | undefined;

  list(): Promise<IStoredGameRecord[]> {
    return this.records.list();
  }

  get(id: string): Promise<IStoredGameRecord | null> {
    return this.records.get(id);
  }

  async put(record: IStoredGameRecord): Promise<boolean> {
    const delay = this.delay;
    if (delay) {
      this.delay = undefined;
      delay.started();
      await delay.wait;
    }
    return this.records.put(record);
  }

  delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  delayNextPut(): { started: Promise<void>; release: () => void } {
    let markStarted: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.delay = { started: markStarted, wait };
    return { started, release };
  }
}

describe('a record written by this build', () => {
  test('reads back as current, untouched', () => {
    const read = readStoredRecord(storedGame(gameRecordVersion));

    expect(read.readability).toBe('current');
    expect(read.record?.id).toBe('spring:round-3:room-204');
  });

  test('a record with fields this build has never heard of keeps them', () => {
    // The rollback case seen from the other side: a device that ran a newer build, was rolled back,
    // and will be rolled forward again after lunch. Dropping the unknown field would silently destroy
    // whatever the newer build was tracking.
    const read = readStoredRecord(storedGame(gameRecordVersion, { deliveryAttempts: 3 }));

    expect((read.record as unknown as RawRecord).deliveryAttempts).toBe(3);
  });

  test.each([
    ['attempt', { attempt: undefined }],
    ['connected', { connected: undefined }],
    ['serverDelivery', { serverDelivery: undefined }],
    ['package', { package: {} }],
    ['setup', { setup: {} }],
  ])('a record missing a required %s shape is unreadable', (_field, replacement) => {
    const read = readStoredRecord(storedGame(gameRecordVersion, replacement));

    expect(read.readability).toBe('unreadable');
    expect(read.record).toBeNull();
  });
});

describe('a record written by an older build', () => {
  /** One breaking change, as a future commit would write it. */
  const steps: Readonly<Record<number, UpgradeStep>> = {
    1: (record) => ({ ...record, serverDelivery: record.serverDelivery ?? 'none', deliveryAttempts: 0 }),
  };

  test('is migrated forward rather than discarded', () => {
    const read = readStoredRecord(storedGame(1), { target: 2, steps });

    expect(read.readability).toBe('upgraded');
    expect(read.storedVersion).toBe(1);
    expect(read.record?.version).toBe(2);
    expect((read.record as unknown as RawRecord).deliveryAttempts).toBe(0);
  });

  test('the game itself survives the migration: same events, same rosters, same score', () => {
    const packageValue = validPackage();
    const setup = setupFromPackage(packageValue);
    const before = deriveGame(packageValue.scorekeeperFormat, setup, []);

    const read = readStoredRecord(storedGame(1, { package: packageValue, setup }), { target: 2, steps });
    const record = read.record as IStoredGameRecord;
    const after = deriveGame(record.package.scorekeeperFormat, record.setup, record.events);

    expect(after.left.points).toBe(before.left.points);
    expect(after.right.points).toBe(before.right.points);
    expect(after.tossupsRead).toBe(before.tossupsRead);
    expect(record.setup).toEqual(setup);
  });

  test('several versions are walked one step at a time, in order', () => {
    const trail: number[] = [];
    const chain: Readonly<Record<number, UpgradeStep>> = {
      1: (record) => {
        trail.push(1);
        return record;
      },
      2: (record) => {
        trail.push(2);
        return record;
      },
      3: (record) => {
        trail.push(3);
        return record;
      },
    };

    const read = readStoredRecord(storedGame(1), { target: 4, steps: chain });

    expect(trail).toEqual([1, 2, 3]);
    expect(read.record?.version).toBe(4);
  });

  test('a missing step refuses rather than guessing', () => {
    // A build that changed the schema and did not say how to read the old shape. Refusing to open the
    // game is recoverable; opening it against a shape the engine will misread is not.
    const read = readStoredRecord(storedGame(1), { target: 3, steps: { 1: (record) => record } });

    expect(read.readability).toBe('unreadable');
    expect(read.record).toBeNull();
  });

  test('a step that throws refuses rather than crashing the welcome screen', () => {
    const read = readStoredRecord(storedGame(1), {
      target: 2,
      steps: {
        1: () => {
          throw new Error('written in a hurry the night before');
        },
      },
    });

    expect(read.readability).toBe('unreadable');
    expect(read.record).toBeNull();
  });

  test('a step that returns something that is no longer a game is caught', () => {
    const read = readStoredRecord(storedGame(1), { target: 2, steps: { 1: () => ({ id: 'x' }) } });

    expect(read.readability).toBe('unreadable');
  });

  test('no steps have shipped yet, because every change so far has been additive', () => {
    // Guards the comment in `GameRecordUpgrade`: if this fails, somebody bumped the version and the
    // table needs the step that goes with it.
    expect(Object.keys(upgradeSteps)).toHaveLength(gameRecordVersion - 1);
  });
});

describe('a record written by a newer build', () => {
  test('is reported as too new, not as absent', () => {
    const read = readStoredRecord(storedGame(gameRecordVersion + 1));

    expect(read.readability).toBe('too-new');
    expect(read.storedVersion).toBe(gameRecordVersion + 1);
    expect(read.record).toBeNull();
  });
});

describe('things that are not game records', () => {
  test.each([
    ['null', null],
    ['a string', 'not a record'],
    ['an array', []],
    ['an object with no version', { id: 'a' }],
    ['a fractional version', { version: 1.5, id: 'a' }],
    ['a zero version', { version: 0, id: 'a' }],
  ])('%s is unreadable', (_label, value) => {
    expect(readStoredRecord(value).record).toBeNull();
  });

  test('a versioned object that is not a game is unreadable', () => {
    expect(readStoredRecord({ version: gameRecordVersion, id: 'a' }).readability).toBe('unreadable');
  });
});

describe('the store, across a version change', () => {
  /**
   * A store belonging to the build *after* this one.
   *
   * This is the whole test. Everything above proves the reader migrates a record; this proves the
   * store actually uses it — which is where the original bug was, and which no amount of testing the
   * reader would have caught. The old `list()` compared versions for equality and dropped anything
   * else, so this store would have returned nothing at all for a game saved twenty minutes earlier.
   */
  const nextBuild = {
    version: gameRecordVersion + 1,
    steps: { [gameRecordVersion]: (record: RawRecord) => ({ ...record, deliveryAttempts: 0 }) },
  };

  test('N+1 lists an unfinished game saved by N, and it is still resumable', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    const store = new GameStore(records, nextBuild);

    const listed = await store.list();

    expect(listed).toHaveLength(1);
    expect(isActive(listed[0])).toBe(true);
    expect(listed[0].version).toBe(gameRecordVersion + 1);
    expect(await store.get('spring:round-3:room-204')).not.toBeNull();
  });

  test('N+1 comes back to the same score and the same rosters', async () => {
    const packageValue = validPackage();
    const setup = setupFromPackage(packageValue);
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(
      storedGame(gameRecordVersion, { package: packageValue, setup }) as unknown as IStoredGameRecord,
    );

    const resumed = (await new GameStore(records, nextBuild).list())[0];
    const game = deriveGame(resumed.package.scorekeeperFormat, resumed.setup, resumed.events);

    expect(resumed.setup).toEqual(setup);
    expect(game.left.points).toBe(0);
    expect(game.tossupsRead).toBe(0);
  });

  test('N+1 writes the migration back, so the upgrade is paid once', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    const store = new GameStore(records, nextBuild);

    await store.list();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stored = (await records.list())[0] as unknown as RawRecord;
    expect(stored.version).toBe(gameRecordVersion + 1);
    expect(stored.deliveryAttempts).toBe(0);
  });

  test('an update cannot race and overwrite a delayed migration write-back', async () => {
    const records = new DelayedRecordStore();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    const store = new GameStore(records, nextBuild);
    const delayedMigration = records.delayNextPut();

    const listed = await store.list();
    expect((listed[0] as unknown as RawRecord).deliveryAttempts).toBe(0);
    await delayedMigration.started;

    const update = store.update('spring:round-3:room-204', { serverDeliveryDetail: 'accepted after retry' });
    delayedMigration.release();
    await update;

    const persisted = (await records.get('spring:round-3:room-204')) as unknown as RawRecord;
    expect(persisted.version).toBe(gameRecordVersion + 1);
    expect(persisted.deliveryAttempts).toBe(0);
    expect(persisted.serverDeliveryDetail).toBe('accepted after retry');
  });

  test('update migrates an old stored record even when it was never listed first', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    const store = new GameStore(records, nextBuild);

    const updated = await store.update('spring:round-3:room-204', {
      serverDeliveryDetail: 'updated directly',
    });

    expect(updated?.version).toBe(gameRecordVersion + 1);
    expect((updated as unknown as RawRecord).deliveryAttempts).toBe(0);
  });

  test('an unfinished game from this build is listed and is still resumable', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    const store = new GameStore(records);

    const listed = await store.list();

    expect(listed).toHaveLength(1);
    expect(isActive(listed[0])).toBe(true);
    expect(await store.get('spring:round-3:room-204')).not.toBeNull();
  });

  test('a game started under N+1 is written at N+1', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    const packageValue = validPackage();

    const created = await new GameStore(records, nextBuild).create({
      package: packageValue,
      setup: setupFromPackage(packageValue),
      connected: false,
    });

    expect(created.version).toBe(gameRecordVersion + 1);
  });

  test('a record this build cannot read is left in storage, not deleted', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion + 99) as unknown as IStoredGameRecord);
    const store = new GameStore(records);

    const listed = await store.list();

    // Not offered — this build cannot promise to score it correctly.
    expect(listed).toEqual([]);
    // But still there, so the build that wrote it finds it again. This is the assertion the old
    // implementation would have failed at the next prune.
    expect(await records.list()).toHaveLength(1);
  });

  test('a create cannot overwrite an unreadable record that owns its local id', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    const packageValue = validPackage();
    const setup = setupFromPackage(packageValue);
    const seeded = await new GameStore(records).create({
      package: packageValue,
      setup,
      connected: false,
    });
    // Simulate a later build having written the same record. `list()` will intentionally omit it,
    // but an import that picked the same first-attempt id must still leave its raw bytes alone.
    await records.put({ ...seeded, version: gameRecordVersion + 99 });

    await expect(
      new GameStore(records).create({ package: packageValue, setup, connected: false }),
    ).rejects.toEqual(expect.objectContaining({ name: 'GameRecordConflictError', recordId: seeded.id }));
    await expect(
      new GameStore(records).create({ package: packageValue, setup, connected: false }),
    ).rejects.toBeInstanceOf(GameRecordConflictError);
    expect(await records.get(seeded.id)).toMatchObject({ id: seeded.id, version: gameRecordVersion + 99 });
  });

  test('a record this build cannot read survives a prune', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(
      storedGame(gameRecordVersion + 99, {
        completedAt: '2020-01-01T00:00:00.000Z',
      }) as unknown as IStoredGameRecord,
    );
    const store = new GameStore(records);

    await store.prune(new Date('2026-08-11T00:00:00.000Z'));

    expect(await records.list()).toHaveLength(1);
  });

  test('an unreadable game produces a message, so it never just vanishes', () => {
    expect(unreadableNotice([])).toBeNull();

    const tooNew = unreadableNotice([{ id: 'a', readability: 'too-new', storedVersion: 2 }]);
    expect(tooNew).toContain('newer version of QBSheet');
    // The sentence that stops somebody concluding the round was lost.
    expect(tooNew).toContain('Nothing has been deleted');

    const broken = unreadableNotice([{ id: 'a', readability: 'unreadable', storedVersion: 1 }]);
    expect(broken).toContain('cannot read');
    expect(broken).toContain('Nothing has been deleted');

    const mixed = unreadableNotice([
      { id: 'a', readability: 'too-new', storedVersion: 2 },
      { id: 'b', readability: 'unreadable', storedVersion: 1 },
    ]);
    expect(mixed).toContain('cannot be opened');
    expect(mixed).not.toContain('were saved by a newer version');
    expect(mixed).not.toContain('are in a format');
  });

  test('the store says what it could not read, so the room can be told', async () => {
    const records = new MemoryRecordStore<IStoredGameRecord>();
    await records.put(storedGame(gameRecordVersion) as unknown as IStoredGameRecord);
    await records.put({
      ...storedGame(gameRecordVersion + 1),
      id: 'from-tomorrow',
    } as unknown as IStoredGameRecord);
    const store = new GameStore(records);

    await store.list();

    expect(store.unreadable).toEqual([
      { id: 'from-tomorrow', readability: 'too-new', storedVersion: gameRecordVersion + 1 },
    ]);
  });
});
