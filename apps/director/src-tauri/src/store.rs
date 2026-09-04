use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 8;
const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;

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
    #[error("Director state must be a JSON object")]
    InvalidStateShape,
    #[error("Recovery point is missing, incompatible, or belongs to a different tournament")]
    InvalidCheckpoint,
    #[error("Director state is too large")]
    StateTooLarge,
    #[error("Director state could not be serialized: {0}")]
    SerializeState(#[source] serde_json::Error),
    #[error("Director state could not be decoded: {0}")]
    DecodeState(#[source] serde_json::Error),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentCatalogEntry {
    pub id: String,
    pub name: String,
    pub date: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorCheckpoint {
    pub id: String,
    pub tournament_id: String,
    pub created_at: String,
    pub reason: String,
    pub schema_version: i64,
}

#[derive(Clone)]
pub struct DirectorStore {
    database_path: PathBuf,
    connection: Arc<Mutex<Connection>>,
}

pub struct StoredQbtcpResult {
    pub id: String,
    pub tournament_id: String,
    pub session_id: String,
    pub room_id: String,
    pub match_id: Option<String>,
    pub fingerprint: String,
    pub raw: Vec<u8>,
    pub qbj: Value,
    pub received_at: String,
    pub review_required: bool,
    pub warnings: Vec<String>,
    pub conflict_with: Option<String>,
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
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn status(&self) -> Result<StoreStatus, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        status_for(&connection, &self.database_path)
    }

    pub fn checkpoint(&self, reason: &str) -> Result<StoreStatus, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let checkpoint_id = format!(
            "checkpoint-{}-{}",
            unix_timestamp_ms(),
            CHECKPOINT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
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

    /// Load the document-shaped state used by the Director React application.
    ///
    /// `director_state` is the authoritative, versioned application document. The normalized
    /// operational tables are projections used for native queries and diagnostics; they are not
    /// independently sufficient to reconstruct the React document.
    pub fn load_state(&self) -> Result<Option<Value>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let state_json = connection
            .query_row(
                "SELECT state_json FROM director_state WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        state_json
            .map(|value| serde_json::from_str(&value).map_err(StoreError::DecodeState))
            .transpose()
    }

    pub fn list_tournaments(&self) -> Result<Vec<TournamentCatalogEntry>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT id, name, date, status, created_at, updated_at
             FROM tournament_documents
             ORDER BY CASE WHEN status = 'archived' THEN 1 ELSE 0 END,
                      updated_at DESC, name, id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TournamentCatalogEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                date: row.get(2)?,
                status: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn read_tournament(&self, tournament_id: &str) -> Result<Value, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let state_json: String = connection.query_row(
            "SELECT state_json FROM tournament_documents WHERE id = ?1",
            params![tournament_id],
            |row| row.get(0),
        )?;
        serde_json::from_str(&state_json).map_err(StoreError::DecodeState)
    }

    /// Atomically select a catalog document as the active Director document and rebuild all native
    /// projections from it. The previous document remains untouched in tournament_documents.
    pub fn open_tournament(&self, tournament_id: &str) -> Result<Value, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        let state_json: String = transaction.query_row(
            "SELECT state_json FROM tournament_documents WHERE id = ?1",
            params![tournament_id],
            |row| row.get(0),
        )?;
        let state = serde_json::from_str::<Value>(&state_json).map_err(StoreError::DecodeState)?;
        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, &state)?;
        set_current_tournament_id(&transaction, tournament_id)?;
        transaction.commit()?;
        Ok(state)
    }

    pub fn load_qbtcp_results(
        &self,
        tournament_id: &str,
    ) -> Result<Vec<StoredQbtcpResult>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT id, tournament_id, session_id, room_id, match_id, fingerprint,
                    raw_payload, qbj_json, received_at, review_required, warnings_json, conflict_with
             FROM qbtcp_results WHERE tournament_id = ?1
             AND NOT EXISTS (SELECT 1 FROM qbtcp_recovery_exclusions x WHERE x.tournament_id = qbtcp_results.tournament_id AND x.result_id = qbtcp_results.id)
             ORDER BY received_at, id",
        )?;
        let rows = statement.query_map(params![tournament_id], |row| {
            let qbj_json: String = row.get(7)?;
            let warnings_json: String = row.get(10)?;
            Ok(StoredQbtcpResult {
                id: row.get(0)?,
                tournament_id: row.get(1)?,
                session_id: row.get(2)?,
                room_id: row.get(3)?,
                match_id: row.get(4)?,
                fingerprint: row.get(5)?,
                raw: row.get(6)?,
                qbj: serde_json::from_str(&qbj_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        7,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                received_at: row.get(8)?,
                review_required: row.get::<_, i64>(9)? != 0,
                warnings: serde_json::from_str(&warnings_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        10,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                conflict_with: row.get(11)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn save_qbtcp_result(
        &self,
        tournament_id: &str,
        disposition: &qbtcp_server::ResultDisposition,
        submission: &qbtcp_server::ResultSubmission,
    ) -> Result<(), StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        connection.execute(
            "INSERT OR IGNORE INTO qbtcp_results
                (id, tournament_id, session_id, room_id, match_id, fingerprint, raw_payload,
                 qbj_json, received_at, review_required, warnings_json, conflict_with)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                disposition.result_id,
                tournament_id,
                submission.session_id,
                submission.room_id,
                submission.submitted_match_id,
                submission.fingerprint,
                submission.raw,
                json_text(&submission.qbj),
                submission.received_at,
                bool_int(Some(&Value::Bool(disposition.review_required))),
                json_text(&Value::Array(
                    disposition
                        .warnings
                        .iter()
                        .cloned()
                        .map(Value::String)
                        .collect(),
                )),
                disposition.conflict_with,
            ],
        )?;
        Ok(())
    }

    /// Save a complete Director document in one SQLite transaction.
    pub fn save_state(&self, state: &Value) -> Result<(), StoreError> {
        let state_json = encode_state(state)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, state)?;
        upsert_tournament_document(&transaction, state, &state_json)?;
        if let Some(tournament_id) = tournament_id_from_state(state) {
            set_current_tournament_id(&transaction, &tournament_id)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Persist a catalog document without activating it. This is used for edits to an archived or
    /// inactive tournament so its state can change without replacing the native active projection.
    pub fn save_document(&self, state: &Value, activate: bool) -> Result<(), StoreError> {
        let state_json = encode_state(state)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        upsert_tournament_document(&transaction, state, &state_json)?;
        if activate {
            upsert_state(&transaction, &state_json)?;
            sync_normalized_state(&transaction, state)?;
            if let Some(tournament_id) = tournament_id_from_state(state) {
                set_current_tournament_id(&transaction, &tournament_id)?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// The QBSheet Live publication, read from the normalized tables.
    pub fn live_status(&self) -> Result<Option<crate::live::LivePublicationRow>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        Ok(crate::live::read_publication(&connection)?)
    }

    /// Persist a historical document snapshot and the active document atomically.
    pub fn checkpoint_state(&self, state: &Value, reason: &str) -> Result<StoreStatus, StoreError> {
        let state_json = encode_state(state)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, state)?;
        upsert_tournament_document(&transaction, state, &state_json)?;
        if let Some(tournament_id) = tournament_id_from_state(state) {
            set_current_tournament_id(&transaction, &tournament_id)?;
        }
        insert_checkpoint(&transaction, state, reason)?;
        let checkpoint_id = format!(
            "checkpoint-{}-{}",
            unix_timestamp_ms(),
            CHECKPOINT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        transaction.execute(
            "INSERT INTO audit_events (id, entity_type, entity_id, action, payload_json)
             VALUES (?1, 'application', 'director', 'checkpoint', ?2)",
            params![
                checkpoint_id,
                serde_json::json!({ "reason": reason }).to_string()
            ],
        )?;
        transaction.commit()?;
        connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        status_for(&connection, &self.database_path)
    }
    pub fn list_checkpoints(
        &self,
        tournament_id: &str,
    ) -> Result<Vec<DirectorCheckpoint>, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT id, tournament_id, created_at, reason, schema_version FROM director_checkpoints
             WHERE tournament_id = ?1 ORDER BY rowid DESC",
        )?;
        let rows = statement.query_map(params![tournament_id], |row| {
            Ok(DirectorCheckpoint {
                id: row.get(0)?,
                tournament_id: row.get(1)?,
                created_at: row.get(2)?,
                reason: row.get(3)?,
                schema_version: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)
    }

    pub fn read_checkpoint(
        &self,
        tournament_id: &str,
        checkpoint_id: &str,
    ) -> Result<Value, StoreError> {
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        read_checkpoint(&connection, tournament_id, checkpoint_id).map(|(state, _)| state)
    }

    /// The recovery point of current state and restored document commit together. Normalized
    /// tables are rebuilt through the same path as ordinary saves, never independently patched.
    pub fn restore_checkpoint(
        &self,
        current: &Value,
        checkpoint_id: &str,
        restored: &Value,
    ) -> Result<Value, StoreError> {
        let tournament_id =
            tournament_id_from_state(current).ok_or(StoreError::InvalidCheckpoint)?;
        let state_json = encode_state(restored)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        let (snapshot, created_at) = read_checkpoint(&transaction, &tournament_id, checkpoint_id)?;
        // Frontend validation may migrate older documents, but may never restore another event
        // or an unsupported future version. For current-version snapshots require exact identity.
        if tournament_id_from_state(restored).as_deref() != Some(tournament_id.as_str())
            || snapshot.get("schemaVersion").and_then(Value::as_i64)
                > restored.get("schemaVersion").and_then(Value::as_i64)
            || (snapshot.get("schemaVersion") == restored.get("schemaVersion")
                && snapshot != *restored)
        {
            return Err(StoreError::InvalidCheckpoint);
        }
        insert_checkpoint(
            &transaction,
            current,
            &format!("Before restoring checkpoint from {created_at}"),
        )?;
        // Retain raw received packets, but do not replay post-checkpoint results into a
        // restored tournament on the next QBTCP poll or app restart.
        transaction.execute(
            "DELETE FROM qbtcp_recovery_exclusions WHERE tournament_id = ?1",
            params![tournament_id],
        )?;
        transaction.execute(
            "INSERT INTO qbtcp_recovery_exclusions(tournament_id, result_id)
             SELECT tournament_id, id FROM qbtcp_results WHERE tournament_id = ?1
             AND id NOT IN (SELECT value FROM json_each(
               (SELECT native_result_ids_json FROM director_checkpoints WHERE id = ?2)))",
            params![tournament_id, checkpoint_id],
        )?;

        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, restored)?;
        upsert_tournament_document(&transaction, restored, &state_json)?;
        set_current_tournament_id(&transaction, &tournament_id)?;
        transaction.commit()?;
        Ok(restored.clone())
    }
}

static CHECKPOINT_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn insert_checkpoint(
    connection: &Connection,
    state: &Value,
    reason: &str,
) -> Result<(), StoreError> {
    let tournament_id = tournament_id_from_state(state).ok_or(StoreError::InvalidCheckpoint)?;
    let state_json = encode_state(state)?;
    let schema_version = state
        .get("schemaVersion")
        .and_then(Value::as_i64)
        .ok_or(StoreError::InvalidCheckpoint)?;
    connection.execute(
        "INSERT INTO director_checkpoints (id, tournament_id, reason, state_json, schema_version, storage_version, native_result_ids_json)
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5,
           (SELECT json_group_array(id) FROM qbtcp_results WHERE tournament_id = ?1 AND NOT EXISTS
             (SELECT 1 FROM qbtcp_recovery_exclusions x WHERE x.tournament_id = ?1 AND x.result_id = qbtcp_results.id)))",
        params![tournament_id, reason, state_json, schema_version, SCHEMA_VERSION],
    )?;
    Ok(())
}

fn read_checkpoint(
    connection: &Connection,
    tournament_id: &str,
    checkpoint_id: &str,
) -> Result<(Value, String), StoreError> {
    let row: Option<(String, String, i64, i64)> = connection.query_row(
        "SELECT state_json, created_at, schema_version, storage_version FROM director_checkpoints
         WHERE id = ?1 AND tournament_id = ?2", params![checkpoint_id, tournament_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let (text, at, schema_version, storage_version) = row.ok_or(StoreError::InvalidCheckpoint)?;
    let state: Value = serde_json::from_str(&text).map_err(StoreError::DecodeState)?;
    if state.get("schemaVersion").and_then(Value::as_i64) != Some(schema_version)
        || storage_version > SCHEMA_VERSION
        || tournament_id_from_state(&state).as_deref() != Some(tournament_id)
    {
        return Err(StoreError::InvalidCheckpoint);
    }
    Ok((state, at))
}

fn encode_state(state: &Value) -> Result<String, StoreError> {
    if !state.is_object() {
        return Err(StoreError::InvalidStateShape);
    }
    let serialized = serde_json::to_string(state).map_err(StoreError::SerializeState)?;
    if serialized.len() > MAX_STATE_BYTES {
        return Err(StoreError::StateTooLarge);
    }
    Ok(serialized)
}

fn tournament_id_from_state(state: &Value) -> Option<String> {
    state
        .get("tournament")
        .and_then(Value::as_object)
        .and_then(|tournament| text(tournament, "id"))
}

fn upsert_tournament_document(
    transaction: &rusqlite::Transaction<'_>,
    state: &Value,
    state_json: &str,
) -> Result<(), StoreError> {
    let Some(tournament) = state.get("tournament").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(id) = text(tournament, "id") else {
        return Ok(());
    };
    transaction.execute(
        "INSERT INTO tournament_documents
            (id, name, date, status, created_at, updated_at, state_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            date = excluded.date,
            status = excluded.status,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            state_json = excluded.state_json",
        params![
            id,
            text(tournament, "name").unwrap_or_else(|| "Untitled tournament".to_owned()),
            text(tournament, "date").unwrap_or_default(),
            text(tournament, "status").unwrap_or_else(|| "draft".to_owned()),
            text(tournament, "createdAt").unwrap_or_else(now_sql),
            text(tournament, "updatedAt").unwrap_or_else(now_sql),
            state_json,
        ],
    )?;
    Ok(())
}

fn set_current_tournament_id(
    transaction: &rusqlite::Transaction<'_>,
    tournament_id: &str,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO application_metadata (key, value, updated_at)
         VALUES ('current_tournament_id', ?1, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        params![json_text(&Value::String(tournament_id.to_owned()))],
    )?;
    Ok(())
}

fn upsert_state(
    transaction: &rusqlite::Transaction<'_>,
    state_json: &str,
) -> Result<(), StoreError> {
    transaction.execute(
        "INSERT INTO director_state (id, schema_version, state_json, updated_at)
         VALUES (1, ?1, ?2, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           schema_version = excluded.schema_version,
           state_json = excluded.state_json,
           updated_at = CURRENT_TIMESTAMP",
        params![SCHEMA_VERSION, state_json],
    )?;
    Ok(())
}

/// Project the application document into the normalized operational tables in the same transaction
/// as the document write. React still consumes one boundary-shaped document, while SQLite keeps
/// queryable rows for diagnostics, recovery tools, future migrations, and native integrations.
/// Rebuilding this projection is intentional: the document is the versioned application boundary,
/// and a failed projection rolls the complete save back without leaving half a tournament graph.
fn sync_normalized_state(
    transaction: &rusqlite::Transaction<'_>,
    state: &Value,
) -> Result<(), StoreError> {
    // In the same transaction as the document write, which is what makes the QBSheet Live outbox
    // durable: Director cannot save an accepted result and lose the knowledge that it needs
    // publishing. See `docs/QBLIVE.md#8-the-durable-outbox`.
    crate::live::sync_publication(transaction, state)?;
    transaction.execute_batch(
        "DELETE FROM player_statistics;
         DELETE FROM game_results;
         DELETE FROM result_submissions;
         DELETE FROM protests;
         DELETE FROM qbtcp_sessions;
         DELETE FROM games;
         DELETE FROM scheduled_games;
         DELETE FROM rounds;
         DELETE FROM pools;
         DELETE FROM phases;
         DELETE FROM team_players;
         DELETE FROM registrations;
         DELETE FROM players;
         DELETE FROM teams;
         DELETE FROM organizations;
         DELETE FROM rooms;
         DELETE FROM staff;
         DELETE FROM equipment;
         DELETE FROM packets;
         DELETE FROM tournaments;
         -- Director audit rows are projected from the document on every save. Native application
         -- events (notably checkpoint records) are append-only and must survive that rebuild.
         DELETE FROM audit_events
          WHERE entity_type <> 'application' OR action <> 'checkpoint';
         DELETE FROM application_metadata WHERE key <> 'current_tournament_id';",
    )?;

    let saved_at = state
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| text(metadata, "lastSavedAt"))
        .unwrap_or_else(now_sql);
    let tournament = state.get("tournament").and_then(Value::as_object);
    let tournament_id = tournament.and_then(|value| text(value, "id"));

    if let Some(tournament) = tournament {
        let id = tournament_id.as_deref().unwrap_or("director");
        let rules = tournament
            .get("rules")
            .map(json_text)
            .unwrap_or_else(|| "{}".to_owned());
        transaction.execute(
            "INSERT INTO tournaments
                (id, name, short_name, date, venue, organizer, time_zone, status, rules_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                id,
                text(tournament, "name").unwrap_or_else(|| "QBSheet Director".to_owned()),
                "",
                text(tournament, "date").unwrap_or_default(),
                text(tournament, "venue").unwrap_or_default(),
                text(tournament, "organizer").unwrap_or_default(),
                text(tournament, "timeZone").unwrap_or_else(|| "UTC".to_owned()),
                text(tournament, "status").unwrap_or_else(|| "draft".to_owned()),
                rules,
                saved_at,
            ],
        )?;
    }

    for organization in objects(state, "organizations") {
        let Some(id) = text(organization, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO organizations
                (id, name, short_name, notes, archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                id,
                text(organization, "name").unwrap_or_else(|| id.clone()),
                text(organization, "shortName").unwrap_or_default(),
                text(organization, "notes").unwrap_or_default(),
                bool_int(organization.get("archived")),
                saved_at,
            ],
        )?;
    }

    let mut team_organizations = HashMap::new();
    for team in objects(state, "teams") {
        let Some(id) = text(team, "id") else { continue };
        let organization_id = text(team, "organizationId");
        team_organizations.insert(id.clone(), organization_id.clone());
        transaction.execute(
            "INSERT INTO teams
                (id, organization_id, display_name, team_letter, seed, status, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id,
                organization_id,
                text(team, "displayName").unwrap_or_else(|| "Unnamed team".to_owned()),
                text(team, "teamLetter").unwrap_or_default(),
                integer(team.get("seed")),
                text(team, "status").unwrap_or_else(|| "confirmed".to_owned()),
                text(team, "notes").unwrap_or_default(),
                text(team, "createdAt").unwrap_or_else(|| saved_at.clone()),
            ],
        )?;
    }

    for player in objects(state, "players") {
        let Some(id) = text(player, "id") else {
            continue;
        };
        let team_id = text(player, "teamId");
        transaction.execute(
            "INSERT INTO players
                (id, organization_id, display_name, graduation_year, notes, created_at, updated_at,
                 active, roster_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
            params![
                id,
                team_id
                    .as_ref()
                    .and_then(|team_id| team_organizations.get(team_id))
                    .cloned()
                    .flatten(),
                text(player, "name").unwrap_or_else(|| "Unnamed player".to_owned()),
                integer(player.get("graduationYear")),
                text(player, "notes").unwrap_or_default(),
                saved_at,
                bool_value_default(player.get("active"), true),
                text(player, "rosterNumber"),
            ],
        )?;
        if let Some(team_id) = team_id {
            transaction.execute(
                "INSERT INTO team_players (team_id, player_id, roster_order, captain)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    team_id,
                    id,
                    integer(player.get("rosterOrder")).unwrap_or(0),
                    bool_int(player.get("captain")),
                ],
            )?;
        }
    }

    if let Some(tournament_id) = tournament_id.as_deref() {
        for team in objects(state, "teams") {
            let Some(team_id) = text(team, "id") else {
                continue;
            };
            transaction.execute(
                "INSERT INTO registrations
                    (id, tournament_id, team_id, seed, status, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    format!("registration-{team_id}"),
                    tournament_id,
                    team_id,
                    integer(team.get("seed")),
                    text(team, "status").unwrap_or_else(|| "active".to_owned()),
                    text(team, "notes").unwrap_or_default(),
                ],
            )?;
        }
    }

    for room in objects(state, "rooms") {
        let Some(id) = text(room, "id") else { continue };
        transaction.execute(
            "INSERT INTO rooms
                (id, name, building, floor, accessibility_notes, directions, status, notes,
                 available, moderator_id, scorekeeper_id, equipment_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                text(room, "name").unwrap_or_else(|| id.clone()),
                text(room, "building").unwrap_or_default(),
                text(room, "floor").unwrap_or_default(),
                text(room, "accessibility").unwrap_or_default(),
                text(room, "directions").unwrap_or_default(),
                text(room, "status").unwrap_or_else(|| "available".to_owned()),
                text(room, "notes").unwrap_or_default(),
                bool_value_default(room.get("available"), true),
                text(room, "moderatorId"),
                text(room, "scorekeeperId"),
                text(room, "equipmentId"),
            ],
        )?;
    }

    for member in objects(state, "staff") {
        let Some(id) = text(member, "id") else {
            continue;
        };
        let roles = member
            .get("roles")
            .map(json_text)
            .unwrap_or_else(|| "[]".to_owned());
        transaction.execute(
            "INSERT INTO staff
                (id, display_name, role, availability_json, notes, active)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                text(member, "name").unwrap_or_else(|| id.clone()),
                member
                    .get("roles")
                    .and_then(Value::as_array)
                    .and_then(|roles| roles.first())
                    .and_then(Value::as_str)
                    .unwrap_or("moderator"),
                roles,
                text(member, "notes").unwrap_or_default(),
                bool_int(member.get("available")),
            ],
        )?;
    }

    for equipment in objects(state, "equipment") {
        let Some(id) = text(equipment, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO equipment (id, kind, label, status, notes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                text(equipment, "kind").unwrap_or_else(|| "other".to_owned()),
                text(equipment, "name").unwrap_or_else(|| id.clone()),
                if bool_value(equipment.get("available")) {
                    "available"
                } else {
                    "offline"
                },
                text(equipment, "notes").unwrap_or_default(),
            ],
        )?;
    }

    for packet in objects(state, "packets") {
        let Some(id) = text(packet, "id") else {
            continue;
        };
        let used = packet
            .get("usedGameIds")
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty());
        let retired = bool_value(packet.get("retired"));
        transaction.execute(
            "INSERT INTO packets
                (id, name, packet_type, source, status, security_notes, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                text(packet, "name").unwrap_or_else(|| id.clone()),
                if bool_value(packet.get("tiebreaker")) {
                    "tiebreaker"
                } else {
                    "regular"
                },
                text(packet, "source").unwrap_or_default(),
                if retired {
                    "retired"
                } else if used {
                    "used"
                } else {
                    "available"
                },
                text(packet, "notes").unwrap_or_default(),
                used.then(|| saved_at.clone()),
            ],
        )?;
    }

    let Some(tournament_id) = tournament_id.as_deref() else {
        insert_metadata(transaction, state, &saved_at)?;
        return Ok(());
    };

    for phase in objects(state, "phases") {
        let Some(id) = text(phase, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO phases
                (id, tournament_id, name, phase_type, sequence, rules_json, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                tournament_id,
                text(phase, "name").unwrap_or_else(|| id.clone()),
                text(phase, "kind").unwrap_or_else(|| "custom".to_owned()),
                integer(phase.get("order")).unwrap_or(0),
                json_text(phase.get("advancementRule").unwrap_or(&Value::Null)),
                if bool_value(phase.get("archived")) {
                    "archived".to_owned()
                } else {
                    text(phase, "status").unwrap_or_else(|| "planned".to_owned())
                },
            ],
        )?;
    }
    for pool in objects(state, "pools") {
        let Some(id) = text(pool, "id") else { continue };
        transaction.execute(
            "INSERT INTO pools (id, phase_id, name, sequence, rules_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                text(pool, "phaseId").unwrap_or_default(),
                text(pool, "name").unwrap_or_else(|| id.clone()),
                integer(pool.get("order")).unwrap_or(0),
                if bool_value(pool.get("archived")) {
                    "{\"archived\":true}".to_owned()
                } else {
                    "{}".to_owned()
                },
            ],
        )?;
    }
    for round in objects(state, "rounds") {
        let Some(id) = text(round, "id") else {
            continue;
        };
        let packet_policy = round
            .get("packetId")
            .map(|packet_id| json_text(&json!({ "packetId": packet_id })))
            .unwrap_or_else(|| "{}".to_owned());
        transaction.execute(
            "INSERT INTO rounds
                (id, phase_id, name, sequence, revision, status, packet_policy_json, started_at, closed_at,
                 scheduled_start, released_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                text(round, "phaseId").unwrap_or_default(),
                text(round, "name").unwrap_or_else(|| id.clone()),
                integer(round.get("number")).unwrap_or(0),
                integer(round.get("revision")).unwrap_or(0),
                text(round, "status").unwrap_or_else(|| "planned".to_owned()),
                packet_policy,
                text(round, "startedAt"),
                text(round, "closedAt"),
                text(round, "scheduledStart"),
                text(round, "releasedAt"),
            ],
        )?;
    }

    for (sequence, game) in objects(state, "scheduledGames").into_iter().enumerate() {
        let Some(id) = text(game, "id") else { continue };
        transaction.execute(
            "INSERT INTO scheduled_games
                (id, round_id, room_id, packet_id, home_team_id, away_team_id, sequence, status,
                 assignment_json, pool_id, bye, assignment_revision, moved_from_room_id, notes, scheduled_start)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                id,
                text(game, "roundId").unwrap_or_default(),
                text(game, "roomId"),
                text(game, "packetId"),
                text(game, "leftTeamId"),
                text(game, "rightTeamId"),
                sequence as i64,
                text(game, "status").unwrap_or_else(|| "scheduled".to_owned()),
                "{}",
                text(game, "poolId"),
                bool_value(game.get("bye")),
                integer_any(game, "assignmentRevision").unwrap_or_default(),
                text(game, "movedFromRoomId"),
                text(game, "notes")
                    .or_else(|| text(game, "note"))
                    .unwrap_or_default(),
                text(game, "scheduledStart"),
            ],
        )?;
    }

    for game in objects(state, "games") {
        let Some(id) = text(game, "id") else { continue };
        let scheduled_id = text(game, "scheduledGameId");
        transaction.execute(
            "INSERT INTO games
                (id, scheduled_game_id, session_id, started_at, finished_at, status, notes,
                 match_id, transport_result_id, raw_qbj_json, detailed_stats, accepted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                scheduled_id,
                text(game, "sessionId"),
                text(game, "startedAt"),
                text(game, "finishedAt"),
                text(game, "status").unwrap_or_else(|| "not_started".to_owned()),
                text(game, "note").unwrap_or_default(),
                text(game, "matchId"),
                text(game, "transportResultId"),
                game.get("rawQbj").map(json_text),
                text(game, "detailedStats"),
                text(game, "acceptedAt"),
            ],
        )?;
    }

    let mut game_ids = HashSet::new();
    let mut game_by_scheduled = HashMap::new();
    let mut game_by_session = HashMap::new();
    let mut game_by_match = HashMap::new();
    let mut game_by_room_revision = HashMap::new();
    for game in objects(state, "games") {
        let Some(game_id) = text(game, "id") else {
            continue;
        };
        game_ids.insert(game_id.clone());
        if let Some(scheduled_id) = text(game, "scheduledGameId") {
            remember_unique(&mut game_by_scheduled, scheduled_id, game_id.clone());
        }
        if let Some(session_id) = text(game, "sessionId") {
            remember_unique(&mut game_by_session, session_id, game_id.clone());
        }
        if let Some(match_id) = text(game, "matchId") {
            remember_unique(&mut game_by_match, match_id, game_id.clone());
        }
        if let Some(raw_qbj) = game.get("rawQbj") {
            let (_, match_id) = qbtcp_server::qbj_identity(raw_qbj);
            if let Some(match_id) = match_id {
                remember_unique(&mut game_by_match, match_id, game_id.clone());
            }
        }
    }
    for scheduled in objects(state, "scheduledGames") {
        let (Some(room_id), Some(assignment_revision), Some(scheduled_id)) = (
            text(scheduled, "roomId"),
            integer_any(scheduled, "assignmentRevision"),
            text(scheduled, "id"),
        ) else {
            continue;
        };
        if let Some(Some(game_id)) = game_by_scheduled.get(&scheduled_id) {
            remember_unique(
                &mut game_by_room_revision,
                (room_id, assignment_revision),
                game_id.clone(),
            );
        }
        if let Some(match_id) = text(scheduled, "matchId") {
            if let Some(Some(game_id)) = game_by_scheduled.get(&scheduled_id) {
                remember_unique(&mut game_by_match, match_id, game_id.clone());
            }
        }
    }

    // Build a set of known player IDs so stale references from imported/QBJ data do not
    // violate the player_statistics.player_id foreign key and roll back the entire save.
    let valid_player_ids: HashSet<String> = objects(state, "players")
        .iter()
        .filter_map(|player| text(player, "id"))
        .collect();
    for game in objects(state, "games") {
        let Some(game_id) = text(game, "id") else {
            continue;
        };
        let submissions: Vec<_> = objects(state, "submissions")
            .into_iter()
            .filter(|submission| text(submission, "gameId").as_deref() == Some(game_id.as_str()))
            .collect();
        let result_sources = if submissions.is_empty() {
            vec![None]
        } else {
            submissions
                .iter()
                .map(|submission| Some(*submission))
                .collect()
        };
        for (result_index, submission) in result_sources.into_iter().enumerate() {
            let submission_id = submission.and_then(|value| text(value, "id"));
            let result_id = if submissions.len() <= 1 {
                format!("result-{game_id}")
            } else {
                let result_suffix = submission_id
                    .clone()
                    .unwrap_or_else(|| result_index.to_string());
                format!("result-{game_id}-{result_suffix}")
            };
            let canonical_result = submission
                .and_then(|value| value.get("canonicalResult"))
                .map(json_text)
                .unwrap_or_else(|| json_text(&Value::Object(game.clone())));
            let player_stats = submission
                .and_then(|value| value.get("playerStats"))
                .and_then(Value::as_array)
                .cloned()
                .or_else(|| game.get("playerStats").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            transaction.execute(
                "INSERT INTO game_results
                (id, game_id, source, raw_submission_json, canonical_result_json, validation_json, review_state, accepted_at, accepted_by, note, submission_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    result_id,
                    game_id,
                    text(game, "source").unwrap_or_else(|| "manual".to_owned()),
                    submission
                        .and_then(|value| value.get("rawSubmission"))
                        .map(json_text)
                        .unwrap_or_else(|| "{}".to_owned()),
                    canonical_result,
                    submission
                        .and_then(|value| value.get("warnings"))
                        .map(json_text)
                        .unwrap_or_else(|| "[]".to_owned()),
                    submission
                        .and_then(|value| text(value, "status"))
                        .unwrap_or_else(|| "pending".to_owned()),
                    submission
                        .and_then(|value| text(value, "acceptedAt"))
                        .or_else(|| text(game, "acceptedAt")),
                    submission.and_then(|value| text(value, "acceptedBy")),
                    submission
                        .and_then(|value| text(value, "reason"))
                        .or_else(|| text(game, "note"))
                        .unwrap_or_default(),
                    submission_id,
                ],
            )?;
            for (order, player_stat) in player_stats.iter().enumerate() {
                let Some(player_stat) = player_stat.as_object() else {
                    continue;
                };
                let Some(player_id) = text(player_stat, "playerId") else {
                    continue;
                };
                if !valid_player_ids.contains(&player_id) {
                    continue;
                }
                transaction.execute(
                    "INSERT INTO player_statistics
                        (id, game_result_id, player_id, statistics_json)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        format!("{result_id}-{order}"),
                        result_id,
                        player_id,
                        json_text(&Value::Object(player_stat.clone())),
                    ],
                )?;
            }
        }
    }

    let mut session_game_ids = HashMap::new();
    for session in objects(state, "qbtcpSessions") {
        let Some(id) = text_any(session, &["sessionId", "id"]) else {
            continue;
        };
        let game_id = resolve_game_reference(
            session,
            &game_ids,
            &game_by_scheduled,
            &game_by_match,
            &game_by_session,
            &game_by_room_revision,
        );
        if let Some(game_id) = game_id.as_ref() {
            remember_unique(&mut session_game_ids, id.clone(), game_id.clone());
        }
        let association = json!({
            "status": if game_id.is_some() { "resolved" } else { "unknown" },
            "gameId": game_id.clone(),
            "assignmentId": text_any(session, &["assignmentId", "scheduledGameId"]),
            "matchId": text(session, "matchId"),
            "assignmentRevision": integer_any(session, "assignmentRevision")
        });
        let metadata = json!({
            "session": Value::Object(session.clone()),
            "association": association
        });
        transaction.execute(
            "INSERT INTO qbtcp_sessions
                (id, room_id, game_id, device_id, state, assignment_revision, last_seen_at, metadata_json,
                 match_id, operator_name, resumable, result_received, progress_sequence, progress_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                text(session, "roomId"),
                game_id,
                text(session, "deviceId").unwrap_or_default(),
                text(session, "state").unwrap_or_else(|| "paired".to_owned()),
                integer_any(session, "assignmentRevision").unwrap_or_default(),
                text(session, "lastSeenAt"),
                json_text(&metadata),
                text(session, "matchId"),
                text(session, "operatorName"),
                session.get("resumable").and_then(Value::as_bool),
                session.get("resultReceived").and_then(Value::as_bool),
                integer_any(session, "progressSequence"),
                session
                    .get("progress")
                    .map(json_text)
                    .unwrap_or_else(|| "null".to_owned()),
            ],
        )?;
    }

    for (session_id, game_id) in &session_game_ids {
        if let Some(game_id) = game_id {
            remember_unique(&mut game_by_session, session_id.clone(), game_id.clone());
        }
    }

    for submission in objects(state, "submissions") {
        let Some(id) = text(submission, "id") else {
            continue;
        };
        let game_id = resolve_game_reference(
            submission,
            &game_ids,
            &game_by_scheduled,
            &game_by_match,
            &game_by_session,
            &game_by_room_revision,
        );
        let status = text(submission, "status").unwrap_or_else(|| "received".to_owned());
        let status = if game_id.is_none() {
            "unmatched".to_owned()
        } else {
            status
        };
        transaction.execute(
            "INSERT INTO result_submissions
                (id, session_id, game_id, fingerprint, raw_payload_json, received_at, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                text(submission, "sessionId"),
                game_id,
                text(submission, "fingerprint").unwrap_or_default(),
                json_text(submission.get("rawSubmission").unwrap_or(&Value::Null)),
                text(submission, "receivedAt").unwrap_or_else(|| saved_at.clone()),
                status,
            ],
        )?;
    }

    for protest in objects(state, "protests") {
        let Some(id) = text(protest, "id") else {
            continue;
        };
        let status = text(protest, "status").unwrap_or_else(|| "open".to_owned());
        let created_at = text(protest, "createdAt").unwrap_or_else(|| saved_at.clone());
        let updated_at = text(protest, "updatedAt").unwrap_or_else(|| created_at.clone());
        let resolved_at =
            matches!(status.as_str(), "ruled" | "withdrawn").then_some(updated_at.clone());
        transaction.execute(
            "INSERT INTO protests
                (id, game_id, question_reference, description, status, ruling, notes, created_at,
                 resolved_at, updated_at, score_adjustment_json, correction_submission_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                text(protest, "gameId"),
                text(protest, "category").unwrap_or_default(),
                text(protest, "description").unwrap_or_default(),
                status,
                text(protest, "ruling").unwrap_or_default(),
                "",
                created_at,
                resolved_at,
                updated_at,
                protest.get("scoreAdjustment").map(json_text),
                text(protest, "correctionSubmissionId"),
            ],
        )?;
    }

    for event in objects(state, "audit") {
        let Some(id) = text(event, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO audit_events
                (id, entity_type, entity_id, action, payload_json, created_at, actor)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                "director",
                text(event, "entityId").unwrap_or_else(|| "director".to_owned()),
                text(event, "type").unwrap_or_else(|| "changed".to_owned()),
                json_text(event.get("details").unwrap_or(&Value::Null)),
                text(event, "at").unwrap_or_else(|| saved_at.clone()),
                text(event, "actor").unwrap_or_else(|| "Director".to_owned()),
            ],
        )?;
    }

    insert_metadata(transaction, state, &saved_at)?;
    Ok(())
}

fn insert_metadata(
    transaction: &rusqlite::Transaction<'_>,
    state: &Value,
    saved_at: &str,
) -> Result<(), StoreError> {
    let metadata = state.get("metadata").and_then(Value::as_object);
    for (key, value) in [
        ("schema_version", Value::from(SCHEMA_VERSION)),
        ("last_saved_at", metadata_value(metadata, "lastSavedAt")),
        (
            "last_checkpoint_at",
            metadata_value(metadata, "lastCheckpointAt"),
        ),
        ("archive_path", metadata_value(metadata, "archivePath")),
        ("projection_saved_at", Value::from(saved_at)),
    ] {
        if !value.is_null() {
            transaction.execute(
                "INSERT INTO application_metadata (key, value, updated_at)
                 VALUES (?1, ?2, CURRENT_TIMESTAMP)",
                params![key, json_text(&value)],
            )?;
        }
    }
    Ok(())
}

fn objects<'a>(state: &'a Value, key: &str) -> Vec<&'a Map<String, Value>> {
    state
        .get(key)
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn text_any(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| text(object, key))
}

fn integer_any(object: &Map<String, Value>, key: &str) -> Option<i64> {
    object
        .get(key)
        .and_then(Value::as_i64)
        .or_else(|| text(object, key).and_then(|value| value.parse().ok()))
}

fn remember_unique<K>(map: &mut HashMap<K, Option<String>>, key: K, value: String)
where
    K: Eq + std::hash::Hash,
{
    match map.entry(key) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(Some(value));
        }
        std::collections::hash_map::Entry::Occupied(mut entry) => {
            if entry
                .get()
                .as_deref()
                .is_some_and(|existing| existing != value)
            {
                entry.insert(None);
            }
        }
    }
}

fn unique_game_id(candidates: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let mut unique = None;
    for candidate in candidates.into_iter().flatten() {
        match unique.as_deref() {
            Some(existing) if existing != candidate => return None,
            Some(_) => {}
            None => unique = Some(candidate),
        }
    }
    unique
}

fn mapped_game_id(map: &HashMap<String, Option<String>>, key: Option<String>) -> Option<String> {
    key.and_then(|key| map.get(&key).cloned().flatten())
}

fn resolve_game_reference(
    object: &Map<String, Value>,
    game_ids: &HashSet<String>,
    game_by_scheduled: &HashMap<String, Option<String>>,
    game_by_match: &HashMap<String, Option<String>>,
    game_by_session: &HashMap<String, Option<String>>,
    game_by_room_revision: &HashMap<(String, i64), Option<String>>,
) -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(game_id) = text(object, "gameId").filter(|id| game_ids.contains(id)) {
        candidates.push(Some(game_id));
    }
    for key in ["scheduledGameId", "assignmentId"] {
        candidates.push(mapped_game_id(game_by_scheduled, text(object, key)));
    }
    candidates.push(mapped_game_id(game_by_match, text(object, "matchId")));
    candidates.push(mapped_game_id(game_by_session, text(object, "sessionId")));
    if let (Some(room_id), Some(assignment_revision)) = (
        text(object, "roomId"),
        integer_any(object, "assignmentRevision"),
    ) {
        candidates.push(
            game_by_room_revision
                .get(&(room_id, assignment_revision))
                .cloned()
                .flatten(),
        );
    }
    if let Some(raw) = ["rawSubmission", "rawQbj", "qbj"]
        .iter()
        .find_map(|key| object.get(*key))
        .filter(|value| qbtcp_server::is_qbj_like(value))
    {
        let (_, match_id) = qbtcp_server::qbj_identity(raw);
        candidates.push(mapped_game_id(game_by_match, match_id));
        if let Some(extension) = raw
            .get("objects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .find(|value| value.get("type").and_then(Value::as_str) == Some("Match"))
            .and_then(|value| value.get("_qbtcp"))
            .and_then(Value::as_object)
        {
            if let (Some(room_id), Some(assignment_revision)) = (
                text(extension, "room_id").or_else(|| text(extension, "roomId")),
                integer_any(extension, "assignment_revision")
                    .or_else(|| integer_any(extension, "assignmentRevision")),
            ) {
                candidates.push(
                    game_by_room_revision
                        .get(&(room_id, assignment_revision))
                        .cloned()
                        .flatten(),
                );
            }
        }
    }
    unique_game_id(candidates)
}

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn bool_value(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn bool_value_default(value: Option<&Value>, default: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(default)
}

fn bool_int(value: Option<&Value>) -> i64 {
    i64::from(bool_value(value))
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

fn metadata_value(metadata: Option<&Map<String, Value>>, key: &str) -> Value {
    metadata
        .and_then(|metadata| metadata.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

fn now_sql() -> String {
    unix_timestamp_ms().to_string()
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
            params![1_i64],
        )?;
    }

    if current < 2 {
        transaction.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS director_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                schema_version INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![2_i64],
        )?;
    }

    if current < 3 {
        transaction.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS qbtcp_results (
                id TEXT PRIMARY KEY,
                tournament_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                room_id TEXT NOT NULL,
                match_id TEXT,
                fingerprint TEXT NOT NULL,
                raw_payload BLOB NOT NULL,
                qbj_json TEXT NOT NULL,
                received_at TEXT NOT NULL,
                review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
                warnings_json TEXT NOT NULL DEFAULT '[]',
                conflict_with TEXT
            );
            CREATE INDEX IF NOT EXISTS qbtcp_results_tournament_idx
                ON qbtcp_results(tournament_id, received_at, id);
            CREATE INDEX IF NOT EXISTS qbtcp_results_fingerprint_idx
                ON qbtcp_results(tournament_id, fingerprint);
            ",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![3_i64],
        )?;
    }

    if current < 4 {
        transaction.execute_batch(
            "
            ALTER TABLE players ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
            ALTER TABLE players ADD COLUMN roster_number TEXT;

            ALTER TABLE rooms ADD COLUMN available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1));
            ALTER TABLE rooms ADD COLUMN moderator_id TEXT;
            ALTER TABLE rooms ADD COLUMN scorekeeper_id TEXT;
            ALTER TABLE rooms ADD COLUMN equipment_id TEXT;

            ALTER TABLE rounds ADD COLUMN started_at TEXT;
            ALTER TABLE rounds ADD COLUMN closed_at TEXT;

            ALTER TABLE scheduled_games ADD COLUMN pool_id TEXT;
            ALTER TABLE scheduled_games ADD COLUMN bye INTEGER NOT NULL DEFAULT 0 CHECK (bye IN (0, 1));
            ALTER TABLE scheduled_games ADD COLUMN assignment_revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE scheduled_games ADD COLUMN moved_from_room_id TEXT;
            ALTER TABLE scheduled_games ADD COLUMN notes TEXT NOT NULL DEFAULT '';

            ALTER TABLE games ADD COLUMN match_id TEXT;
            ALTER TABLE games ADD COLUMN transport_result_id TEXT;
            ALTER TABLE games ADD COLUMN raw_qbj_json TEXT;
            ALTER TABLE games ADD COLUMN detailed_stats TEXT;
            ALTER TABLE games ADD COLUMN accepted_at TEXT;

            ALTER TABLE game_results ADD COLUMN submission_id TEXT;

            ALTER TABLE qbtcp_sessions ADD COLUMN match_id TEXT;
            ALTER TABLE qbtcp_sessions ADD COLUMN operator_name TEXT;
            ALTER TABLE qbtcp_sessions ADD COLUMN resumable INTEGER CHECK (resumable IN (0, 1));
            ALTER TABLE qbtcp_sessions ADD COLUMN result_received INTEGER CHECK (result_received IN (0, 1));
            ALTER TABLE qbtcp_sessions ADD COLUMN progress_sequence INTEGER;
            ALTER TABLE qbtcp_sessions ADD COLUMN progress_json TEXT;

            -- SQLite does not allow a non-constant DEFAULT such as CURRENT_TIMESTAMP on
            -- ALTER TABLE ... ADD COLUMN when the table already has rows. Add the column without
            -- the NOT NULL constraint, backfill existing rows, and rely on the application to
            -- supply CURRENT_TIMESTAMP for new protests; the column remains nullable at the schema
            -- level but the projection always writes a timestamp.
            ALTER TABLE protests ADD COLUMN updated_at TEXT;
            UPDATE protests SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP) WHERE updated_at IS NULL;
            ALTER TABLE protests ADD COLUMN score_adjustment_json TEXT;
            ALTER TABLE protests ADD COLUMN correction_submission_id TEXT;

            ALTER TABLE audit_events ADD COLUMN actor TEXT NOT NULL DEFAULT 'Director';

            DROP INDEX IF EXISTS submissions_game_idx;
            ALTER TABLE result_submissions RENAME TO result_submissions_legacy;
            CREATE TABLE result_submissions (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES qbtcp_sessions(id) ON DELETE SET NULL,
                game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
                fingerprint TEXT NOT NULL,
                raw_payload_json TEXT NOT NULL,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                state TEXT NOT NULL DEFAULT 'received'
            );
            INSERT INTO result_submissions
                (id, session_id, game_id, fingerprint, raw_payload_json, received_at, state)
            SELECT id, session_id, game_id, fingerprint, raw_payload_json, received_at, state
              FROM result_submissions_legacy;
            DROP TABLE result_submissions_legacy;
            CREATE INDEX submissions_game_idx ON result_submissions(game_id);
            ",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![4_i64],
        )?;
    }

    if current < 5 {
        // QBSheet Live publication state. Its own module because the credential rule — that a
        // management credential never enters this database — is easier to keep true when the
        // schema that would have held one is written and tested in one place.
        crate::live::create_tables(&transaction)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![5_i64],
        )?;
    }

    if current < 6 {
        transaction.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS tournament_documents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                date TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                state_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tournament_documents_recent_idx
                ON tournament_documents(status, updated_at DESC, name);
            ",
        )?;
        // A v1-v5 database has exactly one useful document in director_state. Copy it into the
        // catalog before the first multi-document save so an upgrade cannot strand that event.
        let legacy_state: Option<String> = transaction
            .query_row(
                "SELECT state_json FROM director_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(state_json) = legacy_state {
            let state =
                serde_json::from_str::<Value>(&state_json).map_err(StoreError::DecodeState)?;
            if let Some(tournament_id) = tournament_id_from_state(&state) {
                upsert_tournament_document(&transaction, &state, &state_json)?;
                set_current_tournament_id(&transaction, &tournament_id)?;
            }
        }
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![6_i64],
        )?;
    }

    if current < 7 {
        // Keep the normalized native projection semantically aligned with the canonical document:
        // planned, released, and actual clocks are distinct facts. Existing databases receive
        // nullable columns so their historical values remain unknown instead of being guessed.
        transaction.execute_batch(
            "
            ALTER TABLE tournaments ADD COLUMN date TEXT NOT NULL DEFAULT '';
            ALTER TABLE tournaments ADD COLUMN venue TEXT NOT NULL DEFAULT '';
            ALTER TABLE tournaments ADD COLUMN organizer TEXT NOT NULL DEFAULT '';
            ALTER TABLE tournaments ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';
            ALTER TABLE rounds ADD COLUMN scheduled_start TEXT;
            ALTER TABLE rounds ADD COLUMN released_at TEXT;
            ALTER TABLE scheduled_games ADD COLUMN scheduled_start TEXT;
            ",
        )?;
        transaction.execute(
            "INSERT INTO schema_migrations (version) VALUES (?1)",
            params![7_i64],
        )?;
    }

    if current < 8 {
        transaction.execute_batch(
            "CREATE TABLE director_checkpoints (
                id TEXT PRIMARY KEY,
                tournament_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                reason TEXT NOT NULL,
                state_json TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                native_result_ids_json TEXT NOT NULL DEFAULT '[]',
                storage_version INTEGER NOT NULL
            );
            CREATE INDEX director_checkpoints_tournament ON director_checkpoints(tournament_id);
            CREATE TABLE qbtcp_recovery_exclusions (tournament_id TEXT NOT NULL, result_id TEXT NOT NULL, PRIMARY KEY(tournament_id, result_id));
            INSERT INTO schema_migrations(version) VALUES (8);"
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
    use serde_json::json;

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
        assert_eq!(status.migration_count, SCHEMA_VERSION);
        assert_eq!(status.journal_mode.to_lowercase(), "wal");
        assert!(status.foreign_keys);

        let connection = store.connection.lock().expect("database lock");
        for table in [
            "director_state",
            "tournaments",
            "teams",
            "players",
            "scheduled_games",
            "game_results",
            "qbtcp_sessions",
            "result_submissions",
            "qbtcp_results",
            "protests",
            "audit_events",
            "tournament_documents",
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

        assert_eq!(
            second.status().expect("status reads").migration_count,
            SCHEMA_VERSION
        );
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

    #[test]
    fn recovery_points_restore_exact_documents_survive_restart_and_are_scoped() {
        let path = temporary_database_path("real-recovery");
        let before = json!({"schemaVersion": 7, "tournament": {"id": "event-a", "name": "Saturday"},
            "teams": [{"id": "team-1", "displayName": "Original"}], "rounds": [],
            "submissions": [{"id": "submission-1", "gameId": "game-1", "status": "review", "rawSubmission": {"score": 100}}],
            "transfers": {"version": 1, "locations": [], "artifacts": [], "assignments": [], "events": []}});
        let store = DirectorStore::open(path.clone()).unwrap();
        store.checkpoint_state(&before, "Morning setup").unwrap();
        let point = store.list_checkpoints("event-a").unwrap().remove(0);
        let mut changed = before.clone();
        changed["teams"][0]["displayName"] = json!("Mistake");
        store.save_state(&changed).unwrap();
        let mut other = before.clone();
        other["tournament"]["id"] = json!("event-b");
        store.checkpoint_state(&other, "Other event").unwrap();
        assert!(store
            .restore_checkpoint(&other, &point.id, &before)
            .is_err());
        assert_eq!(store.list_checkpoints("event-b").unwrap().len(), 1);
        store.save_state(&changed).unwrap();
        drop(store);
        let store = DirectorStore::open(path.clone()).unwrap();
        assert_eq!(store.read_checkpoint("event-a", &point.id).unwrap(), before);
        assert_eq!(
            store
                .restore_checkpoint(&changed, &point.id, &before)
                .unwrap(),
            before
        );
        assert_eq!(store.load_state().unwrap(), Some(before.clone()));
        let points = store.list_checkpoints("event-a").unwrap();
        assert_eq!(points.len(), 2);
        assert!(points[0]
            .reason
            .starts_with("Before restoring checkpoint from"));
        assert_eq!(
            store.read_checkpoint("event-a", &points[0].id).unwrap(),
            changed
        );
        let connection = store.connection.lock().unwrap();
        let name: String = connection
            .query_row(
                "SELECT display_name FROM teams WHERE id = 'team-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Original");
        drop(connection);
        drop(store);
        let store = DirectorStore::open(path.clone()).unwrap();
        assert_eq!(store.load_state().unwrap(), Some(before));
        assert_eq!(store.list_checkpoints("event-a").unwrap().len(), 2);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn v7_upgrade_adds_recovery_storage_without_inventing_historical_snapshots() {
        let path = temporary_database_path("recovery-migration");
        let store = DirectorStore::open(path.clone()).unwrap();
        let document =
            json!({"schemaVersion": 7, "tournament": {"id": "event", "name": "Existing"}});
        store.save_state(&document).unwrap();
        store.connection.lock().unwrap().execute_batch("DROP TABLE director_checkpoints; DROP TABLE qbtcp_recovery_exclusions; DELETE FROM schema_migrations WHERE version = 8;").unwrap();
        drop(store);
        let store = DirectorStore::open(path.clone()).unwrap();
        assert_eq!(store.load_state().unwrap(), Some(document.clone()));
        assert!(store.list_checkpoints("event").unwrap().is_empty());
        store
            .checkpoint_state(&document, "First real recovery point")
            .unwrap();
        assert_eq!(store.list_checkpoints("event").unwrap().len(), 1);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn state_round_trip_is_transactional_and_reopens() {
        let path = temporary_database_path("state");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let state = json!({
            "schemaVersion": 1,
            "tournament": {"id": "tournament-1", "name": "Test event"},
            "teams": [{"id": "team-1", "displayName": "North"}]
        });

        store.save_state(&state).expect("state saves");
        assert_eq!(
            store.load_state().expect("state loads"),
            Some(state.clone())
        );
        store
            .checkpoint_state(&state, "before test transition")
            .expect("checkpoint saves state");

        let reopened = DirectorStore::open(path.clone()).expect("database reopens");
        assert_eq!(
            reopened.load_state().expect("reopened state loads"),
            Some(state)
        );
        drop(reopened);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn native_checkpoint_audit_survives_a_later_normal_save_and_reopen() {
        let path = temporary_database_path("checkpoint-preservation");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let state = json!({
            "schemaVersion": 1,
            "tournament": {"id": "tournament-1", "name": "Checkpoint test"}
        });

        store.save_state(&state).expect("initial save");
        store
            .checkpoint_state(&state, "before normal save")
            .expect("checkpoint saves");
        store.save_state(&state).expect("normal save");

        let reopened = DirectorStore::open(path.clone()).expect("database reopens");
        let connection = reopened.connection.lock().expect("database lock");
        let checkpoints: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'application' AND action = 'checkpoint'",
                [],
                |row| row.get(0),
            )
            .expect("checkpoint audit reads");
        assert!(checkpoints >= 1);
        drop(connection);
        drop(reopened);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn state_rejects_non_objects_and_oversized_documents() {
        let path = temporary_database_path("state-validation");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        assert!(matches!(
            store.save_state(&Value::Null),
            Err(StoreError::InvalidStateShape)
        ));
        let too_large = json!({ "payload": "x".repeat(MAX_STATE_BYTES) });
        assert!(matches!(
            store.save_state(&too_large),
            Err(StoreError::StateTooLarge)
        ));
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn v6_single_document_upgrade_copies_the_active_document_without_data_loss() {
        let path = temporary_database_path("v6-upgrade");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let legacy = json!({
            "schemaVersion": 4,
            "tournament": {
                "id": "legacy-tournament",
                "name": "Legacy event",
                "date": "2026-09-02",
                "venue": "Main hall",
                "organizer": "QBSheet",
                "status": "running",
                "timeZone": "UTC",
                "rules": {"tossupValue": 10},
                "createdAt": "2026-09-02T10:00:00Z",
                "updatedAt": "2026-09-02T11:00:00Z"
            },
            "teams": [{"id": "team-1", "displayName": "Northview", "status": "confirmed"}],
            "players": [{"id": "player-1", "teamId": "team-1", "name": "Ada", "active": true}],
            "rounds": [{"id": "round-1", "phaseId": "phase-1", "name": "Round 1", "number": 1,
                "status": "released", "scheduledStart": "2026-09-02T14:00:00Z",
                "releasedAt": "2026-09-02T13:50:00Z", "startedAt": null, "closedAt": null}],
            "scheduledGames": []
        });
        {
            let connection = store.connection.lock().expect("database lock");
            connection
                .execute_batch(
                    "
                    DELETE FROM schema_migrations WHERE version >= 6;
                    DROP TABLE IF EXISTS director_checkpoints;
                    DROP TABLE IF EXISTS qbtcp_recovery_exclusions;
                    DROP INDEX IF EXISTS tournament_documents_recent_idx;
                    DROP TABLE IF EXISTS tournament_documents;
                    ALTER TABLE tournaments DROP COLUMN date;
                    ALTER TABLE tournaments DROP COLUMN venue;
                    ALTER TABLE tournaments DROP COLUMN organizer;
                    ALTER TABLE tournaments DROP COLUMN time_zone;
                    ALTER TABLE rounds DROP COLUMN scheduled_start;
                    ALTER TABLE rounds DROP COLUMN released_at;
                    ALTER TABLE scheduled_games DROP COLUMN scheduled_start;
                    DELETE FROM director_state;
                    ",
                )
                .expect("v6 shape restored");
            connection
                .execute(
                    "INSERT INTO director_state (id, schema_version, state_json) VALUES (1, 4, ?1)",
                    params![legacy.to_string()],
                )
                .expect("legacy state inserted");
        }
        drop(store);

        let upgraded = DirectorStore::open(path.clone()).expect("v6 database upgrades");
        assert_eq!(
            upgraded.load_state().expect("upgraded state loads"),
            Some(legacy.clone())
        );
        let catalog = upgraded.list_tournaments().expect("catalog reads");
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, "legacy-tournament");
        assert_eq!(catalog[0].name, "Legacy event");
        assert_eq!(
            upgraded.status().expect("status reads").schema_version,
            SCHEMA_VERSION
        );
        drop(upgraded);
        cleanup(&path);
    }

    #[test]
    fn native_catalog_switching_keeps_inactive_documents_and_selected_id_durable() {
        let path = temporary_database_path("catalog-switch");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let document = |id: &str, name: &str| {
            json!({
                "schemaVersion": 5,
                "tournament": {
                    "id": id, "name": name, "date": "2026-09-02", "venue": "Hall",
                    "organizer": "QBSheet", "status": "draft", "timeZone": "UTC",
                    "rules": {}, "createdAt": "2026-09-02T10:00:00Z", "updatedAt": "2026-09-02T10:00:00Z"
                },
                "teams": [], "players": [], "organizations": [], "rooms": [], "staff": [], "equipment": [],
                "packets": [], "formats": [], "phases": [], "pools": [], "rounds": [], "scheduledGames": [],
                "games": [], "submissions": [], "protests": [], "audit": [], "qbtcpSessions": [],
                "qbtcpHelpRequests": [], "qbtcpRosterAmendments": [], "timeline": [], "live": null,
                "transfers": {"locations": [], "artifacts": []}, "metadata": {}
            })
        };
        let mut a = document("native-a", "Native A");
        let mut b = document("native-b", "Native B");
        store.save_document(&a, true).expect("A saves");
        store.save_document(&b, true).expect("B saves");
        b["tournament"]["venue"] = json!("B venue");
        store.save_document(&b, true).expect("B changes save");
        a["tournament"]["venue"] = json!("A venue");
        store
            .save_document(&a, false)
            .expect("inactive A changes save");
        assert_eq!(
            store.open_tournament("native-b").expect("B opens")["tournament"]["venue"],
            json!("B venue")
        );
        assert_eq!(
            store.open_tournament("native-a").expect("A opens")["tournament"]["venue"],
            json!("A venue")
        );
        drop(store);
        let reopened = DirectorStore::open(path.clone()).expect("database reopens");
        assert_eq!(
            reopened
                .load_state()
                .expect("selected document loads")
                .as_ref()
                .unwrap()["tournament"]["id"],
            json!("native-a")
        );
        let mut archived = a.clone();
        archived["tournament"]["status"] = json!("archived");
        reopened
            .save_document(&archived, false)
            .expect("archive saves");
        assert!(reopened
            .list_tournaments()
            .expect("catalog reads")
            .iter()
            .any(|entry| entry.id == "native-a" && entry.status == "archived"));
        archived["tournament"]["status"] = json!("draft");
        reopened
            .save_document(&archived, false)
            .expect("reopen saves");
        assert!(reopened
            .list_tournaments()
            .expect("catalog reads")
            .iter()
            .any(|entry| entry.id == "native-a" && entry.status == "draft"));
        drop(reopened);
        cleanup(&path);
    }

    #[test]
    fn qbtcp_result_ledger_round_trips_raw_payload_and_review_metadata() {
        let path = temporary_database_path("qbtcp-result-ledger");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let qbj = json!({
            "version": "2.1.1",
            "objects": [{"type": "Match", "id": "match-1"}]
        });
        let submission = qbtcp_server::ResultSubmission {
            session_id: "session-1".to_owned(),
            room_id: "room-1".to_owned(),
            expected_tournament_id: "tournament-1".to_owned(),
            expected_match_id: "match-1".to_owned(),
            expected_round_revision: Some(2),
            submitted_tournament_id: Some("tournament-1".to_owned()),
            submitted_match_id: Some("match-1".to_owned()),
            submitted_round_revision: Some(2),
            fingerprint: "fingerprint-1".to_owned(),
            qbj: qbj.clone(),
            raw: b"original-qbj-bytes".to_vec(),
            received_at: "2026-09-01T12:00:00Z".to_owned(),
            late_after_abandon: true,
        };
        let disposition = qbtcp_server::ResultDisposition {
            result_id: "result-1".to_owned(),
            duplicate: false,
            review_required: true,
            conflict: true,
            warnings: vec!["late-after-abandon".to_owned()],
            conflict_with: Some("result-0".to_owned()),
        };

        store
            .save_qbtcp_result("tournament-1", &disposition, &submission)
            .expect("result saves");
        let results = store
            .load_qbtcp_results("tournament-1")
            .expect("results load");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "result-1");
        assert_eq!(results[0].session_id, "session-1");
        assert_eq!(results[0].raw, b"original-qbj-bytes");
        assert_eq!(results[0].qbj, qbj);
        assert!(results[0].review_required);
        assert_eq!(results[0].warnings, vec!["late-after-abandon".to_owned()]);
        assert_eq!(results[0].conflict_with.as_deref(), Some("result-0"));

        // A pending raw native submission belongs to a checkpoint even before the frontend
        // imports it. Later submissions survive physically, but cannot leak into an old restore.
        let state =
            json!({"schemaVersion": 2, "tournament": {"id": "tournament-1", "name": "Test"}});
        store
            .checkpoint_state(&state, "One pending native result")
            .unwrap();
        let point = store.list_checkpoints("tournament-1").unwrap().remove(0);
        let mut later = disposition.clone();
        later.result_id = "result-2".to_owned();
        store
            .save_qbtcp_result("tournament-1", &later, &submission)
            .unwrap();
        store.restore_checkpoint(&state, &point.id, &state).unwrap();
        assert_eq!(store.load_qbtcp_results("tournament-1").unwrap().len(), 1);
        let undo = store
            .list_checkpoints("tournament-1")
            .unwrap()
            .into_iter()
            .find(|entry| entry.id != point.id)
            .unwrap();
        drop(store);
        let store = DirectorStore::open(path.clone()).unwrap();
        assert_eq!(
            store.load_qbtcp_results("tournament-1").unwrap()[0].id,
            "result-1"
        );
        store.restore_checkpoint(&state, &undo.id, &state).unwrap();
        assert_eq!(store.load_qbtcp_results("tournament-1").unwrap().len(), 2);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn normalized_projection_keeps_operational_fields_and_result_history() {
        let path = temporary_database_path("normalized-fidelity");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let state = json!({
            "schemaVersion": 2,
            "tournament": {"id": "tournament-1", "name": "Fidelity test"},
            "teams": [{"id": "team-1", "displayName": "North"}],
            "players": [{
                "id": "player-1",
                "teamId": "team-1",
                "name": "Inactive player",
                "active": false,
                "rosterNumber": "7"
            }],
            "rooms": [{
                "id": "room-1",
                "name": "Room 1",
                "available": false,
                "status": "offline",
                "moderatorId": "staff-1",
                "scorekeeperId": "staff-2",
                "equipmentId": "equipment-1"
            }],
            "staff": [
                {"id": "staff-1", "name": "Mod", "roles": ["moderator"], "available": true},
                {"id": "staff-2", "name": "Keeper", "roles": ["scorekeeper"], "available": true}
            ],
            "equipment": [{"id": "equipment-1", "name": "Buzzer", "kind": "buzzer", "available": true}],
            "phases": [{"id": "phase-1", "name": "Main", "order": 1}],
            "rounds": [{"id": "round-1", "phaseId": "phase-1", "name": "Round 1", "number": 1,
                "revision": 3, "startedAt": "2026-09-01T10:00:00Z", "closedAt": "2026-09-01T11:00:00Z"}],
            "scheduledGames": [{"id": "scheduled-1", "roundId": "round-1", "roomId": "room-1",
                "leftTeamId": "team-1", "rightTeamId": null, "bye": false, "assignmentRevision": 4}],
            "games": [{"id": "game-1", "scheduledGameId": "scheduled-1", "matchId": "match-1",
                "status": "accepted", "source": "manual", "acceptedAt": "2026-09-01T11:00:00Z",
                "playerStats": [{"playerId": "player-1", "teamId": "team-1", "powers": 1,
                    "gets": 2, "negs": 0, "bonusPoints": 10, "tossupsHeard": 3}]}],
            "submissions": [
                {"id": "submission-rejected", "gameId": "game-1", "fingerprint": "fp-1",
                    "status": "rejected", "rawSubmission": {"attempt": 1},
                    "receivedAt": "2026-09-01T10:55:00Z"},
                {"id": "submission-corrected", "gameId": "game-1", "fingerprint": "fp-2",
                    "status": "accepted", "acceptedBy": "director",
                    "acceptedAt": "2026-09-01T11:00:00Z", "rawSubmission": {"attempt": 2},
                    "receivedAt": "2026-09-01T11:00:00Z"}
            ],
            "protests": [{"id": "protest-1", "gameId": "game-1", "category": "procedure",
                "description": "Open protest", "status": "open",
                "createdAt": "2026-09-01T10:30:00Z", "updatedAt": "2026-09-01T10:31:00Z"}]
        });

        store.save_state(&state).expect("state saves");
        let connection = store.connection.lock().expect("database lock");
        let player: (i64, Option<String>) = connection
            .query_row(
                "SELECT active, roster_number FROM players WHERE id = 'player-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("player projection reads");
        let room: (i64, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT available, moderator_id, scorekeeper_id, equipment_id FROM rooms WHERE id = 'room-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("room projection reads");
        let result_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM game_results WHERE game_id = 'game-1'",
                [],
                |row| row.get(0),
            )
            .expect("result history reads");
        let linked_history: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM game_results WHERE submission_id IS NOT NULL AND game_id = 'game-1'",
                [],
                |row| row.get(0),
            )
            .expect("linked result history reads");
        let rejected: String = connection
            .query_row(
                "SELECT review_state FROM game_results WHERE submission_id = 'submission-rejected'",
                [],
                |row| row.get(0),
            )
            .expect("rejected result reads");
        let open_resolved_at: Option<String> = connection
            .query_row(
                "SELECT resolved_at FROM protests WHERE id = 'protest-1'",
                [],
                |row| row.get(0),
            )
            .expect("protest projection reads");

        assert_eq!(player, (0, Some("7".to_owned())));
        assert_eq!(
            room,
            (
                0,
                Some("staff-1".to_owned()),
                Some("staff-2".to_owned()),
                Some("equipment-1".to_owned())
            )
        );
        assert_eq!(result_count, 2);
        assert_eq!(linked_history, 2);
        assert_eq!(rejected, "rejected");
        assert!(open_resolved_at.is_none());

        drop(connection);
        drop(store);
        cleanup(&path);
    }

    #[test]
    fn qbtcp_projection_requires_explicit_game_association_when_rooms_are_reused() {
        let path = temporary_database_path("qbtcp-association");
        let store = DirectorStore::open(path.clone()).expect("database opens");
        let state = json!({
            "schemaVersion": 1,
            "tournament": {"id": "tournament-1", "name": "Association test"},
            "rooms": [{"id": "room-1", "name": "Room 1", "available": true}],
            "teams": [
                {"id": "team-a", "name": "Team A"},
                {"id": "team-b", "name": "Team B"},
                {"id": "team-c", "name": "Team C"},
                {"id": "team-d", "name": "Team D"}
            ],
            "phases": [{"id": "phase-1", "name": "Main", "order": 1}],
            "rounds": [
                {"id": "round-1", "phaseId": "phase-1", "name": "Round 1", "number": 1},
                {"id": "round-2", "phaseId": "phase-1", "name": "Round 2", "number": 2}
            ],
            "scheduledGames": [
                {
                    "id": "scheduled-old",
                    "roundId": "round-1",
                    "roomId": "room-1",
                    "leftTeamId": "team-a",
                    "rightTeamId": "team-b",
                    "assignmentRevision": 1,
                    "status": "accepted"
                },
                {
                    "id": "scheduled-new",
                    "roundId": "round-2",
                    "roomId": "room-1",
                    "leftTeamId": "team-c",
                    "rightTeamId": "team-d",
                    "assignmentRevision": 2,
                    "status": "released"
                }
            ],
            "games": [
                {"id": "game-old", "scheduledGameId": "scheduled-old", "status": "finished"},
                {"id": "game-new", "scheduledGameId": "scheduled-new", "status": "not_started"}
            ],
            "qbtcpSessions": [
                {
                    "sessionId": "session-old",
                    "roomId": "room-1",
                    "assignmentId": "scheduled-old",
                    "assignmentRevision": 1,
                    "deviceId": "device-old",
                    "state": "abandoned"
                },
                {
                    "sessionId": "session-room-only",
                    "roomId": "room-1",
                    "deviceId": "device-unknown",
                    "state": "paired"
                },
                {
                    "sessionId": "session-new",
                    "roomId": "room-1",
                    "assignmentRevision": 2,
                    "deviceId": "device-new",
                    "state": "live"
                }
            ],
            "submissions": [
                {
                    "id": "submission-old",
                    "sessionId": "session-old",
                    "fingerprint": "old-fingerprint",
                    "rawSubmission": {},
                    "receivedAt": "2026-09-01T00:00:00Z"
                },
                {
                    "id": "submission-unknown",
                    "sessionId": "session-room-only",
                    "fingerprint": "unknown-fingerprint",
                    "rawSubmission": {},
                    "receivedAt": "2026-09-01T00:00:00Z"
                }
            ]
        });

        store.save_state(&state).expect("state saves");
        let connection = store.connection.lock().expect("database lock");
        let session_old_game: Option<String> = connection
            .query_row(
                "SELECT game_id FROM qbtcp_sessions WHERE id = 'session-old'",
                [],
                |row| row.get(0),
            )
            .expect("old session lookup");
        let room_only_game: Option<String> = connection
            .query_row(
                "SELECT game_id FROM qbtcp_sessions WHERE id = 'session-room-only'",
                [],
                |row| row.get(0),
            )
            .expect("room-only session lookup");
        let new_game: Option<String> = connection
            .query_row(
                "SELECT game_id FROM qbtcp_sessions WHERE id = 'session-new'",
                [],
                |row| row.get(0),
            )
            .expect("new session lookup");
        let unknown_result_game: Option<String> = connection
            .query_row(
                "SELECT game_id FROM result_submissions WHERE id = 'submission-unknown'",
                [],
                |row| row.get(0),
            )
            .expect("unknown result lookup");
        let unknown_result_state: String = connection
            .query_row(
                "SELECT state FROM result_submissions WHERE id = 'submission-unknown'",
                [],
                |row| row.get(0),
            )
            .expect("unknown result state");
        assert_eq!(session_old_game.as_deref(), Some("game-old"));
        assert_eq!(new_game.as_deref(), Some("game-new"));
        assert!(room_only_game.is_none());
        assert!(unknown_result_game.is_none());
        assert_eq!(unknown_result_state, "unmatched");

        drop(connection);
        drop(store);
        cleanup(&path);
    }
}
