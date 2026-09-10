/**
 * Versioned SQLite migrations shared by QBSheet's Durable Object backends.
 *
 * # What is here
 *
 * An ordered migration runner over the `SqlDatabase` interface from `sqlite.ts`, with a
 * `schema_version` journal so each migration applies exactly once — including across
 * hibernation restarts, where the constructor re-runs. Versions must be unique and
 * strictly increasing; statements run in order inside the caller's transaction
 * discipline (Durable Object `storage.transaction` where atomicity across statements
 * matters).
 *
 * # What is deliberately NOT here
 *
 * Schemas. Each service owns its tables, indexes, and retention rules; this runner
 * never sees a `CREATE TABLE` it was not handed.
 */
import type { SqlDatabase } from './sqlite';

export interface Migration {
  /** Unique, strictly increasing schema version. */
  version: number;
  /** Short human name for logs and diagnostics. */
  name: string;
  /** Ordered DDL/DML statements. */
  sql: string[];
}

export interface MigrationResult {
  applied: number[];
  alreadyCurrent: boolean;
}

function readAppliedVersions(db: SqlDatabase): Set<number> {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  return new Set(
    db
      .exec<{ version: number }>('SELECT version FROM schema_version ORDER BY version ASC')
      .toArray()
      .map((row) => row.version),
  );
}

/**
 * Apply every migration not yet journaled, in version order.
 *
 * Throws on duplicate versions or a version that is not newer than all previously seen
 * in the input: migrations are append-only history, and a forked sequence must fail
 * loudly rather than apply half a schema.
 */
export function runMigrations(db: SqlDatabase, migrations: Migration[]): MigrationResult {
  const versions = migrations.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error('Duplicate migration version: migrations are append-only.');
  }
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index].version <= migrations[index - 1].version) {
      throw new Error('Migration versions must be strictly increasing.');
    }
  }
  const applied = readAppliedVersions(db);
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    for (const statement of migration.sql) {
      db.exec(statement);
    }
    db.exec(
      'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
      migration.version,
      migration.name,
      new Date().toISOString(),
    );
    newlyApplied.push(migration.version);
  }
  return { applied: newlyApplied, alreadyCurrent: newlyApplied.length === 0 };
}