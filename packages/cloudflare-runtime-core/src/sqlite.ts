/**
 * Minimal SQLite helpers shared by QBSheet's Durable Object backends.
 *
 * # What is here
 *
 * A narrow `SqlDatabase` interface (the slice of the SQLite storage API the helpers
 * need, so both workerd and unit-test fakes satisfy it) plus small typed row readers.
 * Service schemas stay in each service: this file must never learn a table name.
 */

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlResult<T extends SqlRow = SqlRow> {
  toArray(): T[];
}

/** The slice of Durable Object SQLite storage these helpers use. */
export interface SqlDatabase {
  exec<T extends SqlRow = SqlRow>(sql: string, ...params: unknown[]): SqlResult<T>;
}

/** The first row of a query, or null when the query returns nothing. */
export function selectOne<T extends SqlRow>(db: SqlDatabase, sql: string, ...params: unknown[]): T | null {
  return db.exec<T>(sql, ...params).toArray()[0] ?? null;
}

/** A `COUNT(*)` query as a number (0 when the row is missing). */
export function countRows(db: SqlDatabase, table: string, where = '1 = 1'): number {
  // Table and predicate are caller-owned constants, never user input: this helper does
  // not quote identifiers, and must only ever be called with static fragments.
  return (
    selectOne<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)?.count ?? 0
  );
}
