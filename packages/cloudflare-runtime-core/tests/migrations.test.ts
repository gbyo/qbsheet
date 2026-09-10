import { describe, expect, it } from 'vitest';
import { runMigrations, type Migration } from '../src/migrations';
import { countRows, selectOne, type SqlDatabase, type SqlRow } from '../src/sqlite';

/** A statement-recording fake behind the `SqlDatabase` interface. */
function fakeDb(): SqlDatabase & { statements: string[]; versions: Map<number, string> } {
  const versions = new Map<number, string>();
  const statements: string[] = [];
  return {
    statements,
    versions,
    exec<T extends SqlRow = SqlRow>(sql: string, ...params: unknown[]): { toArray(): T[] } {
      statements.push(sql);
      if (/^INSERT INTO schema_version/i.test(sql)) {
        versions.set(params[0] as number, params[1] as string);
        return { toArray: () => [] as T[] };
      }
      if (/^SELECT version FROM schema_version/i.test(sql)) {
        return {
          toArray: () =>
            [...versions.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([version]) => ({ version }) as unknown as T),
        };
      }
      if (/^SELECT COUNT\(\*\)/i.test(sql)) {
        return { toArray: () => [{ count: versions.size }] as unknown as T[] };
      }
      return { toArray: () => [] as T[] };
    },
  };
}

const migrations: Migration[] = [
  { version: 1, name: 'rooms', sql: ['CREATE TABLE room (id TEXT PRIMARY KEY)'] },
  { version: 2, name: 'sessions', sql: ['CREATE TABLE session (id TEXT PRIMARY KEY)'] },
];

describe('migrations', () => {
  it('applies pending migrations once, in order, and then reports current', () => {
    const db = fakeDb();
    expect(runMigrations(db, migrations)).toEqual({ applied: [1, 2], alreadyCurrent: false });
    expect(runMigrations(db, migrations)).toEqual({ applied: [], alreadyCurrent: true });
    const creates = db.statements.filter((statement) => statement.startsWith('CREATE TABLE room'));
    expect(creates).toHaveLength(1);
  });

  it('refuses forked sequences loudly', () => {
    expect(() =>
      runMigrations(fakeDb(), [
        { version: 1, name: 'a', sql: [] },
        { version: 1, name: 'b', sql: [] },
      ]),
    ).toThrow(/append-only/);
  });

  it('reads rows through the typed helpers', () => {
    const db = fakeDb();
    runMigrations(db, migrations);
    expect(selectOne<{ version: number }>(db, 'SELECT version FROM schema_version')).toEqual({ version: 1 });
    expect(countRows(db, 'schema_version')).toBe(2);
    expect(selectOne(db, 'SELECT nothing FROM nowhere')).toBeNull();
  });
});
