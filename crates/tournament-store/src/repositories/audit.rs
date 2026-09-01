use rusqlite::{params, Row};
use serde_json::Value;

use crate::db::Store;
use crate::error::StoreResult;
use crate::models::AuditEvent;
use crate::util::{json_from_row, json_text, new_id, now};

pub struct AuditRepository<'a> {
    store: &'a Store,
}

impl<'a> AuditRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn append(
        &self,
        tournament_id: Option<&str>,
        event_type: &str,
        entity_type: &str,
        entity_id: Option<&str>,
        actor: Option<&str>,
        payload: &Value,
    ) -> StoreResult<AuditEvent> {
        let event = AuditEvent {
            id: new_id(),
            tournament_id: tournament_id.map(str::to_owned),
            event_type: event_type.to_owned(),
            entity_type: entity_type.to_owned(),
            entity_id: entity_id.map(str::to_owned),
            actor: actor.map(str::to_owned),
            payload: payload.clone(),
            created_at: now(),
        };
        let payload_json = json_text(&event.payload)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO audit_events
                    (id, tournament_id, event_type, entity_type, entity_id, actor,
                     payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    event.id,
                    event.tournament_id,
                    event.event_type,
                    event.entity_type,
                    event.entity_id,
                    event.actor,
                    payload_json,
                    event.created_at,
                ],
            )?;
            Ok(event)
        })
    }

    pub fn list(&self, tournament_id: Option<&str>) -> StoreResult<Vec<AuditEvent>> {
        let mut statement = if tournament_id.is_some() {
            self.store.connection().prepare(
                "SELECT id, tournament_id, event_type, entity_type, entity_id, actor,
                        payload_json, created_at
                 FROM audit_events WHERE tournament_id = ?1 ORDER BY created_at DESC, id DESC",
            )?
        } else {
            self.store.connection().prepare(
                "SELECT id, tournament_id, event_type, entity_type, entity_id, actor,
                        payload_json, created_at
                 FROM audit_events ORDER BY created_at DESC, id DESC",
            )?
        };
        let rows = match tournament_id {
            Some(tournament_id) => statement.query_map(params![tournament_id], audit_from_row)?,
            None => statement.query_map([], audit_from_row)?,
        };
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn audit_from_row(row: &Row<'_>) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        event_type: row.get(2)?,
        entity_type: row.get(3)?,
        entity_id: row.get(4)?,
        actor: row.get(5)?,
        payload: json_from_row(row, 6)?,
        created_at: row.get(7)?,
    })
}
