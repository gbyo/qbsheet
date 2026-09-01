use rusqlite::{params, OptionalExtension, Row};

use super::tournaments::ensure_tournament_exists;
use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{NewQbtcpRoom, NewQbtcpSession, QbtcpRoom, QbtcpSession};
use crate::util::{json_from_row, json_text, new_id, now};

pub struct QbtcpRoomRepository<'a> {
    store: &'a Store,
}

impl<'a> QbtcpRoomRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewQbtcpRoom) -> StoreResult<QbtcpRoom> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let room_tournament: Option<String> = self
            .store
            .connection()
            .query_row(
                "SELECT tournament_id FROM rooms WHERE id = ?1",
                params![input.room_id],
                |row| row.get(0),
            )
            .optional()?;
        if room_tournament.as_deref() != Some(input.tournament_id.as_str()) {
            return Err(StoreError::not_found("room", input.room_id));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO qbtcp_rooms
                    (id, tournament_id, room_id, room_code, pairing_code, status,
                     last_seen_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
                params![
                    id,
                    input.tournament_id,
                    input.room_id,
                    input.room_code,
                    input.pairing_code,
                    input.status,
                    timestamp,
                ],
            )?;
            Ok(QbtcpRoom {
                id,
                tournament_id: input.tournament_id,
                room_id: input.room_id,
                room_code: input.room_code,
                pairing_code: input.pairing_code,
                status: input.status,
                last_seen_at: None,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<QbtcpRoom>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, room_id, room_code, pairing_code, status,
                    last_seen_at, created_at, updated_at
             FROM qbtcp_rooms WHERE tournament_id = ?1 ORDER BY room_code, id",
        )?;
        let rows = statement.query_map(params![tournament_id], qbtcp_room_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_status(&self, id: &str, status: &str) -> StoreResult<QbtcpRoom> {
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE qbtcp_rooms SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, timestamp, id],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("QBTCP room", id));
            }
            transaction
                .query_row(qbtcp_room_select(), params![id], qbtcp_room_from_row)
                .map_err(StoreError::from)
        })
    }

    pub fn mark_seen(&self, id: &str) -> StoreResult<QbtcpRoom> {
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE qbtcp_rooms SET last_seen_at = ?1, status = 'connected', updated_at = ?1
                 WHERE id = ?2",
                params![timestamp, id],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("QBTCP room", id));
            }
            transaction
                .query_row(qbtcp_room_select(), params![id], qbtcp_room_from_row)
                .map_err(StoreError::from)
        })
    }
}

pub struct QbtcpSessionRepository<'a> {
    store: &'a Store,
}

impl<'a> QbtcpSessionRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewQbtcpSession) -> StoreResult<QbtcpSession> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let room_tournament: Option<String> = self
            .store
            .connection()
            .query_row(
                "SELECT tournament_id FROM qbtcp_rooms WHERE id = ?1",
                params![input.qbtcp_room_id],
                |row| row.get(0),
            )
            .optional()?;
        if room_tournament.as_deref() != Some(input.tournament_id.as_str()) {
            return Err(StoreError::not_found("QBTCP room", input.qbtcp_room_id));
        }
        let id = new_id();
        let capabilities = json_text(&input.capabilities)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO qbtcp_sessions
                    (id, tournament_id, qbtcp_room_id, client_id, protocol_version,
                     capabilities_json, token_digest, status, paired_at, last_seen_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
                params![
                    id,
                    input.tournament_id,
                    input.qbtcp_room_id,
                    input.client_id,
                    input.protocol_version,
                    capabilities,
                    input.token_digest,
                    input.status,
                    input.paired_at,
                    input.expires_at,
                ],
            )?;
            Ok(QbtcpSession {
                id,
                tournament_id: input.tournament_id,
                qbtcp_room_id: input.qbtcp_room_id,
                client_id: input.client_id,
                protocol_version: input.protocol_version,
                capabilities: input.capabilities,
                token_digest: input.token_digest,
                status: input.status,
                paired_at: input.paired_at,
                last_seen_at: None,
                expires_at: input.expires_at,
            })
        })
    }

    pub fn list_for_room(&self, qbtcp_room_id: &str) -> StoreResult<Vec<QbtcpSession>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, qbtcp_room_id, client_id, protocol_version,
                    capabilities_json, token_digest, status, paired_at, last_seen_at, expires_at
             FROM qbtcp_sessions WHERE qbtcp_room_id = ?1 ORDER BY paired_at DESC, id",
        )?;
        let rows = statement.query_map(params![qbtcp_room_id], qbtcp_session_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn mark_seen(&self, id: &str) -> StoreResult<QbtcpSession> {
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE qbtcp_sessions SET last_seen_at = ?1, status = 'connected'
                 WHERE id = ?2 AND status <> 'closed'
                   AND (expires_at IS NULL OR expires_at > ?1)",
                params![timestamp, id],
            )?;
            if changed == 0 {
                let state: Option<(String, Option<i64>)> = transaction
                    .query_row(
                        "SELECT status, expires_at FROM qbtcp_sessions WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                return match state {
                    None => Err(StoreError::not_found("QBTCP session", id)),
                    Some((status, _)) if status == "closed" => Err(StoreError::Conflict(format!(
                        "QBTCP session {id} is closed"
                    ))),
                    Some((_, Some(expires_at))) if expires_at <= timestamp => {
                        Err(StoreError::Conflict(format!("QBTCP session {id} has expired")))
                    }
                    Some(_) => Err(StoreError::Conflict(format!(
                        "QBTCP session {id} cannot be marked seen"
                    ))),
                };
            }
            transaction
                .query_row(qbtcp_session_select(), params![id], qbtcp_session_from_row)
                .map_err(StoreError::from)
        })
    }

    pub fn close(&self, id: &str) -> StoreResult<QbtcpSession> {
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE qbtcp_sessions SET status = 'closed' WHERE id = ?1",
                params![id],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("QBTCP session", id));
            }
            transaction
                .query_row(qbtcp_session_select(), params![id], qbtcp_session_from_row)
                .map_err(StoreError::from)
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<QbtcpSession>> {
        let mut statement = self.store.connection().prepare(qbtcp_session_select())?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(qbtcp_session_from_row(row)?)))
    }
}

fn qbtcp_room_select() -> &'static str {
    "SELECT id, tournament_id, room_id, room_code, pairing_code, status,
            last_seen_at, created_at, updated_at FROM qbtcp_rooms WHERE id = ?1"
}

fn qbtcp_session_select() -> &'static str {
    "SELECT id, tournament_id, qbtcp_room_id, client_id, protocol_version,
            capabilities_json, token_digest, status, paired_at, last_seen_at, expires_at
     FROM qbtcp_sessions WHERE id = ?1"
}

fn qbtcp_room_from_row(row: &Row<'_>) -> rusqlite::Result<QbtcpRoom> {
    Ok(QbtcpRoom {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        room_id: row.get(2)?,
        room_code: row.get(3)?,
        pairing_code: row.get(4)?,
        status: row.get(5)?,
        last_seen_at: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn qbtcp_session_from_row(row: &Row<'_>) -> rusqlite::Result<QbtcpSession> {
    Ok(QbtcpSession {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        qbtcp_room_id: row.get(2)?,
        client_id: row.get(3)?,
        protocol_version: row.get(4)?,
        capabilities: json_from_row(row, 5)?,
        token_digest: row.get(6)?,
        status: row.get(7)?,
        paired_at: row.get(8)?,
        last_seen_at: row.get(9)?,
        expires_at: row.get(10)?,
    })
}
