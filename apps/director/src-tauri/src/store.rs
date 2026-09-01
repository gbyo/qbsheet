use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("could not create the Director data directory: {0}")]
    CreateDirectory(#[source] std::io::Error),
    #[error("could not open the Director SQLite database: {0}")]
    Open(#[source] rusqlite::Error),
    #[error("Director database error: {0}")]
    Sqlite(#[source] rusqlite::Error),
    #[error("Director database schema version {0} is newer than this application supports")]
    UnsupportedSchema(i64),
    #[error("Director database path has no parent directory")]
    MissingParent,
    #[error("Director database lock is poisoned")]
    Poisoned,
}

impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub database_path: String,
    pub schema_version: i64,
    pub journal_mode: String,
    pub foreign_keys: bool,
    pub migration_count: i64,
}

pub struct DirectorStore {
    database_path: PathBuf,
    connection: Mutex<Connection>,
}

impl DirectorStore {
    pub fn open(database_path: PathBuf) -> Result<Self, StoreError> {
        database_path
            .parent()
            .ok_or(StoreError::MissingParent)
            .and_then(|parent| fs::create_dir_all(parent).map_err(StoreError::CreateDirectory))?;

        let mut connection = Connection::open(&database_path).map_err(StoreError::Open)?;
        configure_connection(&connection)?;
        migrate(&mut connection)?;

        Ok(Self {
            database_path,
            connection: Mutex::new(connection),
        })
    }

    pub fn status(&self) -> Result<StoreStatus, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        status_for(&connection, &self.database_path)
    }

    pub fn checkpoint(&self, reason: &str) -> Result<StoreStatus, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let checkpoint_id = format!("checkpoint-{}-{}", unix_timestamp_ms(), std::process::id());
        connection.execute(
            "INSERT INTO audit_events (id, entity_type, entity_id, action, payload_json)
             VALUES (?1, 'application', 'director', 'checkpoint', ?2)",
            params![
                checkpoint_id,
                serde_json::json!({ "reason": reason }).to_string()
            ],
        )?;
        connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        status_for(&connection, &self.database_path)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), StoreError> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "busy_timeout", 5000)?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;

    let current: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if current > SCHEMA_VERSION {
        return Err(StoreError::UnsupportedSchema(current));
    }

    if current < 1 {
        transaction.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS application_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                short_name TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tournaments (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                short_name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                rules_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS teams (
                id TEXT PRIMARY KEY,
                organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                display_name TEXT NOT NULL,
                team_letter TEXT NOT NULL DEFAULT '',
                seed INTEGER,
                status TEXT NOT NULL DEFAULT 'confirmed',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS players (
                id TEXT PRIMARY KEY,
                organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
                display_name TEXT NOT NULL,
                graduation_year INTEGER,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS registrations (
                id TEXT PRIMARY KEY,
                tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
                team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
                seed INTEGER,
                status TEXT NOT NULL DEFAULT 'active',
                notes TEXT NOT NULL DEFAULT '',
                UNIQUE (tournament_id, team_id)
            );

            CREATE TABLE IF NOT EXISTS team_players (
                team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
                roster_order INTEGER NOT NULL DEFAULT 0,
                captain INTEGER NOT NULL DEFAULT 0 CHECK (captain IN (0, 1)),
                PRIMARY KEY (team_id, player_id)
            );

            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                building TEXT NOT NULL DEFAULT '',
                floor TEXT NOT NULL DEFAULT '',
                accessibility_notes TEXT NOT NULL DEFAULT '',
                directions TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'available',
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS staff (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL,
                availability_json TEXT NOT NULL DEFAULT '{}',
                notes TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
            );

            CREATE TABLE IF NOT EXISTS equipment (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                label TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'available',
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS packets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                packet_type TEXT NOT NULL DEFAULT 'regular',
                source TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'available',
                security_notes TEXT NOT NULL DEFAULT '',
                used_at TEXT
            );

            CREATE TABLE IF NOT EXISTS phases (
                id TEXT PRIMARY KEY,
                tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                phase_type TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                rules_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'planned'
            );

            CREATE TABLE IF NOT EXISTS pools (
                id TEXT PRIMARY KEY,
                phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                rules_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS rounds (
                id TEXT PRIMARY KEY,
                phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
                pool_id TEXT REFERENCES pools(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'planned',
                packet_policy_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS scheduled_games (
                id TEXT PRIMARY KEY,
                round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
                room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
                packet_id TEXT REFERENCES packets(id) ON DELETE SET NULL,
                home_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
                away_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
                sequence INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'scheduled',
                assignment_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS games (
                id TEXT PRIMARY KEY,
                scheduled_game_id TEXT UNIQUE REFERENCES scheduled_games(id) ON DELETE SET NULL,
                session_id TEXT,
                started_at TEXT,
                finished_at TEXT,
                status TEXT NOT NULL DEFAULT 'not_started',
                notes TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS game_results (
                id TEXT PRIMARY KEY,
                game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                source TEXT NOT NULL DEFAULT 'manual',
                raw_submission_json TEXT NOT NULL DEFAULT '{}',
                canonical_result_json TEXT NOT NULL DEFAULT '{}',
                validation_json TEXT NOT NULL DEFAULT '{}',
                review_state TEXT NOT NULL DEFAULT 'pending',
                accepted_at TEXT,
                accepted_by TEXT,
                note TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS player_statistics (
                id TEXT PRIMARY KEY,
                game_result_id TEXT NOT NULL REFERENCES game_results(id) ON DELETE CASCADE,
                player_id TEXT NOT NULL REFERENCES players(id) ON DELETE RESTRICT,
                statistics_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE (game_result_id, player_id)
            );

            CREATE TABLE IF NOT EXISTS qbtcp_sessions (
                id TEXT PRIMARY KEY,
                room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
                game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
                device_id TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT 'paired',
                assignment_revision INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );

            CREATE TABLE IF NOT EXISTS result_submissions (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES qbtcp_sessions(id) ON DELETE SET NULL,
                game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
                fingerprint TEXT NOT NULL,
                raw_payload_json TEXT NOT NULL,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                state TEXT NOT NULL DEFAULT 'received',
                UNIQUE (fingerprint)
            );

            CREATE TABLE IF NOT EXISTS protests (
                id TEXT PRIMARY KEY,
                game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
                question_reference TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                ruling TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                action TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS registrations_tournament_idx ON registrations(tournament_id);
            CREATE INDEX IF NOT EXISTS phases_tournament_idx ON phases(tournament_id, sequence);
            CREATE INDEX IF NOT EXISTS rounds_phase_idx ON rounds(phase_id, sequence);
            CREATE INDEX IF NOT EXISTS games_round_idx ON scheduled_games(round_id);
            CREATE INDEX IF NOT EXISTS games_room_idx ON scheduled_games(room_id);
            CREATE INDEX IF NOT EXISTS results_game_idx ON game_results(game_id);
            CREATE INDEX IF NOT EXISTS submissions_game_idx ON result_submissions(game_id);
            CREATE INDEX IF NOT EXISTS protests_game_idx ON protests(game_id);
            CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_events(entity_type, entity_id, created_at);
            ",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![SCHEMA_VERSION],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

fn status_for(connection: &Connection, database_path: &Path) -> Result<StoreStatus, StoreError> {
    let schema_version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    let migration_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })?;
    let journal_mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    let foreign_keys: i64 = connection.query_row("PRAGMA foreign_keys", [], |row| row.get(0))?;

    Ok(StoreStatus {
        database_path: database_path.to_string_lossy().into_owned(),
        schema_version,
        journal_mode,
        foreign_keys: foreign_keys != 0,
        migration_count,
    })
}

fn unix_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_database_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "qbsheet-director-{name}-{}-{}.sqlite",
            std::process::id(),
            unix_timestamp_ms()
        ))
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite-shm"));
    }

    #[test]
    fn opens_wal_database_and_applies_versioned_schema() {
        let path = temporary_database_path("schema");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let status = store.status().expect("status reads");

        assert_eq!(status.schema_version, SCHEMA_VERSION);
        assert_eq!(status.migration_count, 1);
        assert_eq!(status.journal_mode.to_lowercase(), "wal");
        assert!(status.foreign_keys);

        let connection = store.connection.lock().expect("database lock");
        for table in [
            "tournaments",
            "teams",
            "players",
            "scheduled_games",
            "game_results",
            "qbtcp_sessions",
            "result_submissions",
            "protests",
            "audit_events",
        ] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get(0),
                )
                .expect("table lookup");
            assert_eq!(exists, 1, "{table} should exist");
        }
        drop(connection);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn migration_is_idempotent_and_checkpoint_is_audited() {
        let path = temporary_database_path("checkpoint");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let second = DirectorStore::open(path.clone()).expect("database reopens");

        assert_eq!(second.status().expect("status reads").migration_count, 1);
        store
            .checkpoint("before phase transition")
            .expect("checkpoint writes");
        let connection = store.connection.lock().expect("database lock");
        let action: String = connection
            .query_row(
                "SELECT action FROM audit_events ORDER BY created_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("audit event reads");
        assert_eq!(action, "checkpoint");
        drop(connection);
        drop(second);
        drop(store);
        cleanup(&path);
    }
}
