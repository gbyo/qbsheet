import { describe, expect, test } from 'vitest';
import { databaseName, gameStoreName, openRecordStore } from '../src/persistence/GameDatabase';

interface ITestRecord {
  id: string;
  value: string;
}

async function seed(database: string, records: ITestRecord[]): Promise<void> {
  const opened = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(gameStoreName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  await new Promise<void>((resolve, reject) => {
    const transaction = opened.transaction(gameStoreName, 'readwrite');
    for (const record of records) transaction.objectStore(gameStoreName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  opened.close();
}

describe('the renamed database migration', () => {
  test('resumes after a prior startup copied only some legacy records', async () => {
    await seed('standalone-scorekeeper', [
      { id: 'already-copied', value: 'legacy version' },
      { id: 'stranded-one', value: 'recovered one' },
      { id: 'stranded-two', value: 'recovered two' },
    ]);
    await seed(databaseName, [{ id: 'already-copied', value: 'new database version' }]);

    const store = await openRecordStore<ITestRecord>();
    const records = new Map((await store.list()).map((record) => [record.id, record.value]));

    expect(records).toEqual(new Map([
      ['already-copied', 'new database version'],
      ['stranded-one', 'recovered one'],
      ['stranded-two', 'recovered two'],
    ]));
  });
});
