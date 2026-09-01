use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Map, Value};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 2;
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

    /// Load the document-shaped state used by the Director React application.
    ///
    /// The normalized operational tables remain the durable schema boundary. The document is kept
    /// separately so the React model can evolve without exposing SQLite rows or making the native
    /// shell duplicate TypeScript domain types.
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

    /// Save a complete Director document in one SQLite transaction.
    pub fn save_state(&self, state: &Value) -> Result<(), StoreError> {
        let state_json = encode_state(state)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, state)?;
        transaction.commit()?;
        Ok(())
    }

    /// Save state and record the operation checkpoint atomically before flushing the WAL.
    pub fn checkpoint_state(&self, state: &Value, reason: &str) -> Result<StoreStatus, StoreError> {
        let state_json = encode_state(state)?;
        let connection = self.connection.lock().map_err(|_| StoreError::Poisoned)?;
        let transaction = connection.unchecked_transaction()?;
        upsert_state(&transaction, &state_json)?;
        sync_normalized_state(&transaction, state)?;
        let checkpoint_id = format!("checkpoint-{}-{}", unix_timestamp_ms(), std::process::id());
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
         DELETE FROM audit_events;
         DELETE FROM application_metadata;",
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
                (id, name, short_name, status, rules_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                id,
                text(tournament, "name").unwrap_or_else(|| "QBSheet Director".to_owned()),
                "",
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
                (id, organization_id, display_name, graduation_year, notes, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
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
                (id, name, building, floor, accessibility_notes, directions, status, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                text(room, "name").unwrap_or_else(|| id.clone()),
                text(room, "building").unwrap_or_default(),
                text(room, "floor").unwrap_or_default(),
                text(room, "accessibility").unwrap_or_default(),
                text(room, "directions").unwrap_or_default(),
                text(room, "status").unwrap_or_else(|| "available".to_owned()),
                text(room, "notes").unwrap_or_default(),
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
                if used { "used" } else { "available" },
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
                text(phase, "status").unwrap_or_else(|| "planned".to_owned()),
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
                "{}",
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
                (id, phase_id, name, sequence, revision, status, packet_policy_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                text(round, "phaseId").unwrap_or_default(),
                text(round, "name").unwrap_or_else(|| id.clone()),
                integer(round.get("number")).unwrap_or(0),
                integer(round.get("revision")).unwrap_or(0),
                text(round, "status").unwrap_or_else(|| "planned".to_owned()),
                packet_policy,
            ],
        )?;
    }

    for (sequence, game) in objects(state, "scheduledGames").into_iter().enumerate() {
        let Some(id) = text(game, "id") else { continue };
        transaction.execute(
            "INSERT INTO scheduled_games
                (id, round_id, room_id, packet_id, home_team_id, away_team_id, sequence, status, assignment_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
            ],
        )?;
    }

    let mut first_game_for_schedule = HashMap::new();
    for game in objects(state, "games") {
        let Some(id) = text(game, "id") else { continue };
        let scheduled_id = text(game, "scheduledGameId").and_then(|scheduled_id| {
            if first_game_for_schedule.contains_key(&scheduled_id) {
                None
            } else {
                first_game_for_schedule.insert(scheduled_id.clone(), id.clone());
                Some(scheduled_id)
            }
        });
        transaction.execute(
            "INSERT INTO games
                (id, scheduled_game_id, session_id, started_at, finished_at, status, notes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                scheduled_id,
                text(game, "sessionId"),
                text(game, "startedAt"),
                text(game, "finishedAt"),
                text(game, "status").unwrap_or_else(|| "not_started".to_owned()),
                text(game, "note").unwrap_or_default(),
            ],
        )?;
    }

    for game in objects(state, "games") {
        let Some(game_id) = text(game, "id") else {
            continue;
        };
        let submission = objects(state, "submissions")
            .into_iter()
            .rev()
            .find(|submission| text(submission, "gameId").as_deref() == Some(game_id.as_str()));
        let result_id = format!("result-{game_id}");
        let player_stats = game
            .get("playerStats")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        transaction.execute(
            "INSERT INTO game_results
                (id, game_id, source, raw_submission_json, canonical_result_json, validation_json, review_state, accepted_at, accepted_by, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                result_id,
                game_id,
                text(game, "source").unwrap_or_else(|| "manual".to_owned()),
                submission
                    .map(|value| json_text(&Value::Object(value.clone())))
                    .unwrap_or_else(|| "{}".to_owned()),
                json_text(&Value::Object(game.clone())),
                submission
                    .and_then(|value| value.get("warnings"))
                    .map(json_text)
                    .unwrap_or_else(|| "[]".to_owned()),
                submission
                    .and_then(|value| text(value, "status"))
                    .unwrap_or_else(|| "pending".to_owned()),
                text(game, "acceptedAt"),
                submission.and_then(|value| text(value, "acceptedBy")),
                text(game, "note").unwrap_or_default(),
            ],
        )?;
        for (order, player_stat) in player_stats.iter().enumerate() {
            let Some(player_stat) = player_stat.as_object() else {
                continue;
            };
            let Some(player_id) = text(player_stat, "playerId") else {
                continue;
            };
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

    for session in objects(state, "qbtcpSessions") {
        let Some(id) = text(session, "sessionId") else {
            continue;
        };
        let game_id = text(session, "gameId").or_else(|| {
            text(session, "roomId").and_then(|room_id| {
                objects(state, "scheduledGames")
                    .into_iter()
                    .find(|game| text(game, "roomId").as_deref() == Some(room_id.as_str()))
                    .and_then(|game| text(game, "id"))
                    .and_then(|scheduled_id| first_game_for_schedule.get(&scheduled_id).cloned())
            })
        });
        transaction.execute(
            "INSERT INTO qbtcp_sessions
                (id, room_id, game_id, device_id, state, assignment_revision, last_seen_at, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                text(session, "roomId"),
                game_id,
                text(session, "deviceId").unwrap_or_default(),
                text(session, "state").unwrap_or_else(|| "paired".to_owned()),
                0_i64,
                text(session, "lastSeenAt"),
                json_text(session.get("progress").unwrap_or(&Value::Null)),
            ],
        )?;
    }

    for submission in objects(state, "submissions") {
        let Some(id) = text(submission, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO result_submissions
                (id, session_id, game_id, fingerprint, raw_payload_json, received_at, state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                text(submission, "sessionId"),
                text(submission, "gameId"),
                text(submission, "fingerprint").unwrap_or_default(),
                json_text(submission.get("rawSubmission").unwrap_or(&Value::Null)),
                text(submission, "receivedAt").unwrap_or_else(|| saved_at.clone()),
                text(submission, "status").unwrap_or_else(|| "received".to_owned()),
            ],
        )?;
    }

    for protest in objects(state, "protests") {
        let Some(id) = text(protest, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO protests
                (id, game_id, question_reference, description, status, ruling, notes, created_at, resolved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                text(protest, "gameId"),
                text(protest, "category").unwrap_or_default(),
                text(protest, "description").unwrap_or_default(),
                text(protest, "status").unwrap_or_else(|| "open".to_owned()),
                text(protest, "ruling").unwrap_or_default(),
                "",
                text(protest, "createdAt").unwrap_or_else(|| saved_at.clone()),
                text(protest, "updatedAt"),
            ],
        )?;
    }

    for event in objects(state, "audit") {
        let Some(id) = text(event, "id") else {
            continue;
        };
        transaction.execute(
            "INSERT INTO audit_events
                (id, entity_type, entity_id, action, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                "director",
                text(event, "entityId").unwrap_or_else(|| "director".to_owned()),
                text(event, "type").unwrap_or_else(|| "changed".to_owned()),
                json_text(event.get("details").unwrap_or(&Value::Null)),
                text(event, "at").unwrap_or_else(|| saved_at.clone()),
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

fn integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn bool_value(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
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
        assert_eq!(status.migration_count, 2);
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

        assert_eq!(second.status().expect("status reads").migration_count, 2);
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
}
