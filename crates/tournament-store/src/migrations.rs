use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::StoreResult;
use crate::util::now;

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_tournament_store",
        sql: include_str!("../migrations/0001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "checkpoint_and_integrity_indexes",
        sql: include_str!("../migrations/0002_checkpoint_and_integrity.sql"),
    },
];

pub fn apply(conn: &Connection) -> StoreResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY NOT NULL,
             name TEXT NOT NULL,
             applied_at INTEGER NOT NULL
         );",
    )?;

    let current: u32 = conn.query_row("PRAGMA user_version", [], |row| {
        row.get::<_, i64>(0).map(|version| version as u32)
    })?;

    if current > CURRENT_SCHEMA_VERSION {
        return Err(crate::error::StoreError::UnsupportedSchemaVersion {
            version: current,
            current: CURRENT_SCHEMA_VERSION,
        });
    }

    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current)
    {
        let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        transaction.execute_batch(migration.sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(version) DO UPDATE SET name = excluded.name, applied_at = excluded.applied_at",
            rusqlite::params![migration.version, migration.name, now()],
        )?;
        transaction.execute_batch(&format!("PRAGMA user_version = {};", migration.version))?;
        transaction.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{apply, CURRENT_SCHEMA_VERSION, MIGRATIONS};

    #[test]
    fn upgrades_a_v1_database_to_the_current_schema() {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                     version INTEGER PRIMARY KEY NOT NULL,
                     name TEXT NOT NULL,
                     applied_at INTEGER NOT NULL
                 );",
            )
            .expect("create migration table");
        connection
            .execute_batch(MIGRATIONS[0].sql)
            .expect("apply first migration");
        connection
            .execute_batch("INSERT INTO schema_migrations VALUES (1, 'initial_tournament_store', 1); PRAGMA user_version = 1;")
            .expect("record first migration");

        apply(&connection).expect("apply remaining migrations");

        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read schema version");
        assert_eq!(version as u32, CURRENT_SCHEMA_VERSION);

        let checkpoints: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_checkpoints'",
                [],
                |row| row.get(0),
            )
            .expect("check checkpoint table");
        assert_eq!(checkpoints, 1);
    }
}
