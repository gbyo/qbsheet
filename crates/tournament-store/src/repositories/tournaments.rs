use rusqlite::{params, Row};

use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{Id, NewTournament, Tournament, TournamentUpdate};
use crate::util::{json_from_row, json_text, new_id, now};

pub struct TournamentRepository<'a> {
    store: &'a Store,
}

impl<'a> TournamentRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewTournament) -> StoreResult<Tournament> {
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "tournament name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        let rules = json_text(&input.rules)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO tournaments
                    (id, name, short_name, organization_id, location, start_date, end_date,
                     status, rules_json, created_at, updated_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)",
                params![
                    id,
                    input.name,
                    input.short_name,
                    input.organization_id,
                    input.location,
                    input.start_date,
                    input.end_date,
                    input.status,
                    rules,
                    timestamp,
                ],
            )?;
            Ok(Tournament {
                id,
                name: input.name,
                short_name: input.short_name,
                organization_id: input.organization_id,
                location: input.location,
                start_date: input.start_date,
                end_date: input.end_date,
                status: input.status,
                rules: input.rules,
                created_at: timestamp,
                updated_at: timestamp,
                archived_at: None,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Tournament>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, name, short_name, organization_id, location, start_date, end_date,
                    status, rules_json, created_at, updated_at, archived_at
             FROM tournaments WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(tournament_from_row(row)?)))
    }

    pub fn require(&self, id: &str) -> StoreResult<Tournament> {
        self.get(id)?
            .ok_or_else(|| StoreError::not_found("tournament", id))
    }

    pub fn list(&self, include_archived: bool) -> StoreResult<Vec<Tournament>> {
        let sql = if include_archived {
            "SELECT id, name, short_name, organization_id, location, start_date, end_date,
                    status, rules_json, created_at, updated_at, archived_at
             FROM tournaments ORDER BY created_at, name"
        } else {
            "SELECT id, name, short_name, organization_id, location, start_date, end_date,
                    status, rules_json, created_at, updated_at, archived_at
             FROM tournaments WHERE archived_at IS NULL ORDER BY created_at, name"
        };
        let mut statement = self.store.connection().prepare(sql)?;
        let rows = statement.query_map([], tournament_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update(&self, id: &str, update: TournamentUpdate) -> StoreResult<Tournament> {
        let short_name_changed = update.short_name.is_some();
        let short_name = update.short_name.flatten();
        let location_changed = update.location.is_some();
        let location = update.location.flatten();
        let start_date_changed = update.start_date.is_some();
        let start_date = update.start_date.flatten();
        let end_date_changed = update.end_date.is_some();
        let end_date = update.end_date.flatten();
        let archived_at_changed = update.archived_at.is_some();
        let archived_at = update.archived_at.flatten();
        let rules = update.rules.as_ref().map(json_text).transpose()?;
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE tournaments SET
                    name = COALESCE(?1, name),
                    short_name = CASE WHEN ?2 <> 0 THEN ?3 ELSE short_name END,
                    location = CASE WHEN ?4 <> 0 THEN ?5 ELSE location END,
                    start_date = CASE WHEN ?6 <> 0 THEN ?7 ELSE start_date END,
                    end_date = CASE WHEN ?8 <> 0 THEN ?9 ELSE end_date END,
                    status = COALESCE(?10, status),
                    rules_json = COALESCE(?11, rules_json),
                    archived_at = CASE WHEN ?12 <> 0 THEN ?13 ELSE archived_at END,
                    updated_at = ?14
                 WHERE id = ?15",
                params![
                    update.name,
                    short_name_changed,
                    short_name,
                    location_changed,
                    location,
                    start_date_changed,
                    start_date,
                    end_date_changed,
                    end_date,
                    update.status,
                    rules,
                    archived_at_changed,
                    archived_at,
                    timestamp,
                    id,
                ],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("tournament", id));
            }
            let mut statement = transaction.prepare(
                "SELECT id, name, short_name, organization_id, location, start_date, end_date,
                        status, rules_json, created_at, updated_at, archived_at
                 FROM tournaments WHERE id = ?1",
            )?;
            statement
                .query_row(params![id], tournament_from_row)
                .map_err(StoreError::from)
        })
    }

    pub fn archive(&self, id: &str) -> StoreResult<Tournament> {
        self.update(
            id,
            TournamentUpdate {
                archived_at: Some(Some(now())),
                status: Some("archived".to_owned()),
                ..TournamentUpdate::default()
            },
        )
    }
}

fn tournament_from_row(row: &Row<'_>) -> rusqlite::Result<Tournament> {
    Ok(Tournament {
        id: row.get(0)?,
        name: row.get(1)?,
        short_name: row.get(2)?,
        organization_id: row.get(3)?,
        location: row.get(4)?,
        start_date: row.get(5)?,
        end_date: row.get(6)?,
        status: row.get(7)?,
        rules: json_from_row(row, 8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        archived_at: row.get(11)?,
    })
}

pub(crate) fn ensure_tournament_exists(store: &Store, id: &Id) -> StoreResult<()> {
    let exists: bool = store.connection().query_row(
        "SELECT EXISTS(SELECT 1 FROM tournaments WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(StoreError::not_found("tournament", id))
    }
}
