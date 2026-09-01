use rusqlite::{params, Row};

use super::tournaments::ensure_tournament_exists;
use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{
    NewOrganization, NewPlayer, NewTeam, Organization, Player, Team, TeamRosterMember, TeamUpdate,
};
use crate::util::{bool_from_i64, bool_to_i64, new_id, now};

pub struct OrganizationRepository<'a> {
    store: &'a Store,
}

impl<'a> OrganizationRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewOrganization) -> StoreResult<Organization> {
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "organization name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO organizations
                    (id, name, abbreviation, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![id, input.name, input.abbreviation, input.notes, timestamp],
            )?;
            Ok(Organization {
                id,
                name: input.name,
                abbreviation: input.abbreviation,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Organization>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, name, abbreviation, notes, created_at, updated_at
             FROM organizations WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(organization_from_row(row)?)))
    }

    pub fn list(&self) -> StoreResult<Vec<Organization>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, name, abbreviation, notes, created_at, updated_at
             FROM organizations ORDER BY name, id",
        )?;
        let rows = statement.query_map([], organization_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct TeamRepository<'a> {
    store: &'a Store,
}

impl<'a> TeamRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewTeam) -> StoreResult<Team> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "team name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        let display_name = input
            .display_name
            .clone()
            .unwrap_or_else(|| input.name.clone());
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO teams
                    (id, tournament_id, organization_id, name, display_name, team_letter, seed,
                     status, notes, created_at, updated_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, NULL)",
                params![
                    id,
                    input.tournament_id,
                    input.organization_id,
                    input.name,
                    display_name,
                    input.team_letter,
                    input.seed,
                    input.status,
                    input.notes,
                    timestamp,
                ],
            )?;
            transaction.execute(
                "INSERT INTO registrations
                    (id, tournament_id, team_id, status, seed, notes, registered_at, updated_at)
                 VALUES (?1, ?2, ?3, 'registered', ?4, NULL, ?5, ?5)",
                params![new_id(), input.tournament_id, id, input.seed, timestamp],
            )?;
            Ok(Team {
                id,
                tournament_id: input.tournament_id,
                organization_id: input.organization_id,
                name: input.name,
                display_name,
                team_letter: input.team_letter,
                seed: input.seed,
                status: input.status,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
                archived_at: None,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Team>> {
        let mut statement = self.store.connection().prepare(team_select(None))?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(team_from_row(row)?)))
    }

    pub fn list(&self, tournament_id: &str, include_archived: bool) -> StoreResult<Vec<Team>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let sql = if include_archived {
            "SELECT id, tournament_id, organization_id, name, display_name, team_letter, seed,
                    status, notes, created_at, updated_at, archived_at
             FROM teams WHERE tournament_id = ?1 ORDER BY COALESCE(seed, 2147483647), name, id"
        } else {
            "SELECT id, tournament_id, organization_id, name, display_name, team_letter, seed,
                    status, notes, created_at, updated_at, archived_at
             FROM teams WHERE tournament_id = ?1 AND archived_at IS NULL
             ORDER BY COALESCE(seed, 2147483647), name, id"
        };
        let mut statement = self.store.connection().prepare(sql)?;
        let rows = statement.query_map(params![tournament_id], team_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update(&self, id: &str, update: TeamUpdate) -> StoreResult<Team> {
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE teams SET
                    organization_id = COALESCE(?1, organization_id),
                    name = COALESCE(?2, name),
                    display_name = COALESCE(?3, display_name),
                    team_letter = COALESCE(?4, team_letter),
                    seed = COALESCE(?5, seed),
                    status = COALESCE(?6, status),
                    notes = COALESCE(?7, notes),
                    archived_at = COALESCE(?8, archived_at),
                    updated_at = ?9
                 WHERE id = ?10",
                params![
                    update.organization_id,
                    update.name,
                    update.display_name,
                    update.team_letter,
                    update.seed,
                    update.status,
                    update.notes,
                    update.archived_at,
                    timestamp,
                    id,
                ],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("team", id));
            }
            let mut statement = transaction.prepare(team_select(None))?;
            statement
                .query_row(params![id], team_from_row)
                .map_err(StoreError::from)
        })
    }

    pub fn archive(&self, id: &str) -> StoreResult<Team> {
        self.update(
            id,
            TeamUpdate {
                archived_at: Some(now()),
                status: Some("dropped".to_owned()),
                ..TeamUpdate::default()
            },
        )
    }

    pub fn add_player(
        &self,
        team_id: &str,
        player_id: &str,
        captain: bool,
        roster_order: i64,
    ) -> StoreResult<()> {
        self.store.write_transaction(|transaction| {
            let team_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM teams WHERE id = ?1",
                    params![team_id],
                    |row| row.get(0),
                )
                .optional()?;
            let player_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM players WHERE id = ?1",
                    params![player_id],
                    |row| row.get(0),
                )
                .optional()?;
            match (team_tournament, player_tournament) {
                (Some(team_tournament), Some(player_tournament))
                    if team_tournament == player_tournament => {}
                (None, _) => return Err(StoreError::not_found("team", team_id)),
                (_, None) => return Err(StoreError::not_found("player", player_id)),
                _ => {
                    return Err(StoreError::Conflict(
                        "team and player belong to different tournaments".to_owned(),
                    ))
                }
            }
            transaction.execute(
                "INSERT INTO team_players (team_id, player_id, captain, roster_order)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(team_id, player_id) DO UPDATE SET
                    captain = excluded.captain,
                    roster_order = excluded.roster_order",
                params![team_id, player_id, bool_to_i64(captain), roster_order],
            )?;
            Ok(())
        })
    }

    pub fn remove_player(&self, team_id: &str, player_id: &str) -> StoreResult<bool> {
        Ok(self.store.connection().execute(
            "DELETE FROM team_players WHERE team_id = ?1 AND player_id = ?2",
            params![team_id, player_id],
        )? > 0)
    }

    pub fn roster(&self, team_id: &str) -> StoreResult<Vec<TeamRosterMember>> {
        let mut statement = self.store.connection().prepare(
            "SELECT p.id, p.tournament_id, p.organization_id, p.name, p.graduation_year,
                    p.notes, p.created_at, p.updated_at, p.archived_at,
                    tp.captain, tp.roster_order
             FROM team_players tp
             JOIN players p ON p.id = tp.player_id
             WHERE tp.team_id = ?1
             ORDER BY tp.roster_order, p.name, p.id",
        )?;
        let rows = statement.query_map(params![team_id], |row| {
            Ok(TeamRosterMember {
                player: player_from_row(row)?,
                captain: bool_from_i64(row.get(9)?),
                roster_order: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct PlayerRepository<'a> {
    store: &'a Store,
}

impl<'a> PlayerRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewPlayer) -> StoreResult<Player> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "player name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO players
                    (id, tournament_id, organization_id, name, graduation_year, notes,
                     created_at, updated_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL)",
                params![
                    id,
                    input.tournament_id,
                    input.organization_id,
                    input.name,
                    input.graduation_year,
                    input.notes,
                    timestamp,
                ],
            )?;
            Ok(Player {
                id,
                tournament_id: input.tournament_id,
                organization_id: input.organization_id,
                name: input.name,
                graduation_year: input.graduation_year,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
                archived_at: None,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Player>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, organization_id, name, graduation_year, notes,
                    created_at, updated_at, archived_at
             FROM players WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(player_from_row(row)?)))
    }

    pub fn list(&self, tournament_id: &str, include_archived: bool) -> StoreResult<Vec<Player>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let sql = if include_archived {
            "SELECT id, tournament_id, organization_id, name, graduation_year, notes,
                    created_at, updated_at, archived_at
             FROM players WHERE tournament_id = ?1 ORDER BY name, id"
        } else {
            "SELECT id, tournament_id, organization_id, name, graduation_year, notes,
                    created_at, updated_at, archived_at
             FROM players WHERE tournament_id = ?1 AND archived_at IS NULL ORDER BY name, id"
        };
        let mut statement = self.store.connection().prepare(sql)?;
        let rows = statement.query_map(params![tournament_id], player_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn organization_from_row(row: &Row<'_>) -> rusqlite::Result<Organization> {
    Ok(Organization {
        id: row.get(0)?,
        name: row.get(1)?,
        abbreviation: row.get(2)?,
        notes: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn team_select(_unused: Option<&str>) -> &'static str {
    "SELECT id, tournament_id, organization_id, name, display_name, team_letter, seed,
            status, notes, created_at, updated_at, archived_at
     FROM teams WHERE id = ?1"
}

fn team_from_row(row: &Row<'_>) -> rusqlite::Result<Team> {
    Ok(Team {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        organization_id: row.get(2)?,
        name: row.get(3)?,
        display_name: row.get(4)?,
        team_letter: row.get(5)?,
        seed: row.get(6)?,
        status: row.get(7)?,
        notes: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        archived_at: row.get(11)?,
    })
}

fn player_from_row(row: &Row<'_>) -> rusqlite::Result<Player> {
    Ok(Player {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        organization_id: row.get(2)?,
        name: row.get(3)?,
        graduation_year: row.get(4)?,
        notes: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived_at: row.get(8)?,
    })
}

use rusqlite::OptionalExtension;
