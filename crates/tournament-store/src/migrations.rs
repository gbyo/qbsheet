use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::StoreResult;
use crate::util::now;

pub const CURRENT_SCHEMA_VERSION: u32 = 3;

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
    Migration {
        version: 3,
        name: "packet_assignment_integrity",
        sql: include_str!("../migrations/0003_packet_assignment_integrity.sql"),
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

    fn seed_assignment_graph(connection: &Connection) {
        connection
            .execute_batch(
                "INSERT INTO tournaments (id, name, created_at, updated_at)
                 VALUES ('tournament-1', 'Test tournament', 1, 1);
                 INSERT INTO teams
                     (id, tournament_id, name, display_name, created_at, updated_at)
                 VALUES ('team-1', 'tournament-1', 'Team 1', 'Team 1', 1, 1);
                 INSERT INTO phases
                     (id, tournament_id, name, phase_type, sequence, created_at, updated_at)
                 VALUES ('phase-1', 'tournament-1', 'Preliminaries', 'round_robin', 1, 1, 1);
                 INSERT INTO rounds
                     (id, tournament_id, phase_id, name, sequence, round_number, created_at, updated_at)
                 VALUES ('round-1', 'tournament-1', 'phase-1', 'Round 1', 1, 1, 1, 1);
                 INSERT INTO packets
                     (id, tournament_id, name, created_at, updated_at)
                 VALUES ('packet-1', 'tournament-1', 'Packet 1', 1, 1),
                        ('packet-2', 'tournament-1', 'Packet 2', 1, 1);
                 INSERT INTO scheduled_games
                     (id, tournament_id, round_id, game_number, created_at, updated_at)
                 VALUES ('game-1', 'tournament-1', 'round-1', 1, 1, 1);",
            )
            .expect("seed assignment graph");
    }

    fn current_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        apply(&connection).expect("apply current migrations");
        seed_assignment_graph(&connection);
        connection
    }

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

    #[test]
    fn upgrades_legacy_packet_assignments_without_dropping_rows() {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("enable foreign keys");
        connection
            .execute_batch(MIGRATIONS[0].sql)
            .expect("apply initial migration");
        connection
            .execute_batch(MIGRATIONS[1].sql)
            .expect("apply checkpoint migration");
        seed_assignment_graph(&connection);
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                     version INTEGER PRIMARY KEY NOT NULL,
                     name TEXT NOT NULL,
                     applied_at INTEGER NOT NULL
                 );
                 INSERT INTO schema_migrations VALUES
                     (1, 'initial_tournament_store', 1),
                     (2, 'checkpoint_and_integrity_indexes', 1);
                 PRAGMA user_version = 2;
                 INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', 'round-1', 'game-1', 10),
                        ('packet-1', 'round-1', NULL, 11),
                        ('packet-1', 'round-1', NULL, 12),
                        ('packet-1', NULL, NULL, 13),
                        ('packet-1', NULL, 'missing-game', 14),
                        ('packet-2', NULL, 'game-1', 15);",
            )
            .expect("seed legacy packet assignments");

        apply(&connection).expect("apply packet assignment migration");

        let canonical_game: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT round_id, scheduled_game_id
                 FROM packet_assignments
                 WHERE packet_id = 'packet-1' AND scheduled_game_id = 'game-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read canonical game assignment");
        assert_eq!(canonical_game, (None, Some("game-1".to_owned())));

        let canonical_rounds: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM packet_assignments
                 WHERE packet_id = 'packet-1' AND round_id = 'round-1'",
                [],
                |row| row.get(0),
            )
            .expect("count canonical round assignments");
        assert_eq!(canonical_rounds, 1);

        let quarantined: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM packet_assignment_migration_quarantine",
                [],
                |row| row.get(0),
            )
            .expect("count quarantined assignments");
        assert_eq!(quarantined, 4);

        let legacy_table: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'packet_assignments_legacy'",
                [],
                |row| row.get(0),
            )
            .expect("check legacy table removal");
        assert_eq!(legacy_table, 0);
    }

    #[test]
    fn packet_assignment_constraints_reject_invalid_targets_and_duplicates() {
        let connection = current_connection();

        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', NULL, NULL, 1)",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', 'round-1', 'game-1', 1)",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', NULL, 'missing-game', 1)",
                [],
            )
            .is_err());

        connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', 'round-1', NULL, 1)",
                [],
            )
            .expect("insert round assignment");
        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', 'round-1', NULL, 2)",
                [],
            )
            .is_err());

        connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', NULL, 'game-1', 3)",
                [],
            )
            .expect("insert game assignment");
        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-1', NULL, 'game-1', 4)",
                [],
            )
            .is_err());
        assert!(connection
            .execute(
                "INSERT INTO packet_assignments
                     (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES ('packet-2', NULL, 'game-1', 5)",
                [],
            )
            .is_err());
    }
}
