use rusqlite::{params, OptionalExtension, Row};

use super::tournaments::ensure_tournament_exists;
use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{
    NewPacket, NewPhase, NewPhaseTeam, NewPool, NewRound, NewScheduledGame, Packet,
    PacketAssignment, Phase, PhaseTeam, Pool, Round, ScheduledGame,
};
use crate::util::{json_from_row, json_text, new_id, now};

pub struct PacketRepository<'a> {
    store: &'a Store,
}

impl<'a> PacketRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewPacket) -> StoreResult<Packet> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO packets
                    (id, tournament_id, name, packet_type, status, nominal_round_id,
                     replacement_for_id, security_notes, used_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
                params![
                    id,
                    input.tournament_id,
                    input.name,
                    input.packet_type,
                    input.status,
                    input.nominal_round_id,
                    input.replacement_for_id,
                    input.security_notes,
                    timestamp,
                ],
            )?;
            Ok(Packet {
                id,
                tournament_id: input.tournament_id,
                name: input.name,
                packet_type: input.packet_type,
                status: input.status,
                nominal_round_id: input.nominal_round_id,
                replacement_for_id: input.replacement_for_id,
                security_notes: input.security_notes,
                used_at: None,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Packet>> {
        let mut statement = self.store.connection().prepare(packet_select())?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(packet_from_row(row)?)))
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Packet>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, name, packet_type, status, nominal_round_id,
                    replacement_for_id, security_notes, used_at, created_at, updated_at
             FROM packets WHERE tournament_id = ?1 ORDER BY name, id",
        )?;
        let rows = statement.query_map(params![tournament_id], packet_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn assign_to_round(
        &self,
        packet_id: &str,
        round_id: &str,
    ) -> StoreResult<PacketAssignment> {
        self.store.write_transaction(|transaction| {
            let packet = packet_tournament(transaction, packet_id)?
                .ok_or_else(|| StoreError::not_found("packet", packet_id))?;
            let round = round_tournament(transaction, round_id)?
                .ok_or_else(|| StoreError::not_found("round", round_id))?;
            if packet != round {
                return Err(StoreError::Conflict(
                    "packet and round belong to different tournaments".to_owned(),
                ));
            }
            let existing: Option<(String, Option<String>)> = transaction
                .query_row(
                    "SELECT packet_id, scheduled_game_id FROM packet_assignments
                     WHERE packet_id = ?1",
                    params![packet_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((_, scheduled_game_id)) = existing {
                if scheduled_game_id.is_some() {
                    return Err(StoreError::Conflict(
                        "packet is already assigned to a scheduled game".to_owned(),
                    ));
                }
                return Err(StoreError::Conflict(
                    "packet is already assigned to a round".to_owned(),
                ));
            }
            let assigned_at = now();
            transaction.execute(
                "INSERT INTO packet_assignments
                    (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES (?1, ?2, NULL, ?3)",
                params![packet_id, round_id, assigned_at],
            )?;
            transaction.execute(
                "UPDATE packets SET status = 'assigned', updated_at = ?1 WHERE id = ?2",
                params![assigned_at, packet_id],
            )?;
            Ok(PacketAssignment {
                packet_id: packet_id.to_owned(),
                round_id: Some(round_id.to_owned()),
                scheduled_game_id: None,
                assigned_at,
            })
        })
    }

    pub fn assign_to_game(
        &self,
        packet_id: &str,
        scheduled_game_id: &str,
    ) -> StoreResult<PacketAssignment> {
        self.store.write_transaction(|transaction| {
            let packet = packet_tournament(transaction, packet_id)?
                .ok_or_else(|| StoreError::not_found("packet", packet_id))?;
            let game = scheduled_game_tournament(transaction, scheduled_game_id)?
                .ok_or_else(|| StoreError::not_found("scheduled game", scheduled_game_id))?;
            if packet != game {
                return Err(StoreError::Conflict(
                    "packet and scheduled game belong to different tournaments".to_owned(),
                ));
            }
            let existing: Option<(Option<String>, Option<String>)> = transaction
                .query_row(
                    "SELECT round_id, scheduled_game_id FROM packet_assignments
                     WHERE packet_id = ?1",
                    params![packet_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((round_id, existing_game_id)) = existing {
                if existing_game_id.as_deref() != Some(scheduled_game_id) {
                    return Err(StoreError::Conflict(format!(
                        "packet is already assigned to {}",
                        round_id
                            .map(|round| format!("round {round}"))
                            .unwrap_or_else(|| "another scheduled game".to_owned())
                    )));
                }
                return Ok(PacketAssignment {
                    packet_id: packet_id.to_owned(),
                    round_id,
                    scheduled_game_id: existing_game_id,
                    assigned_at: now(),
                });
            }
            let assigned_at = now();
            transaction.execute(
                "INSERT INTO packet_assignments
                    (packet_id, round_id, scheduled_game_id, assigned_at)
                 VALUES (?1, NULL, ?2, ?3)",
                params![packet_id, scheduled_game_id, assigned_at],
            )?;
            transaction.execute(
                "UPDATE scheduled_games SET packet_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![packet_id, assigned_at, scheduled_game_id],
            )?;
            transaction.execute(
                "UPDATE packets SET status = 'assigned', updated_at = ?1 WHERE id = ?2",
                params![assigned_at, packet_id],
            )?;
            Ok(PacketAssignment {
                packet_id: packet_id.to_owned(),
                round_id: None,
                scheduled_game_id: Some(scheduled_game_id.to_owned()),
                assigned_at,
            })
        })
    }

    pub fn mark_used(&self, packet_id: &str) -> StoreResult<Packet> {
        let timestamp = now();
        let changed = self.store.connection().execute(
            "UPDATE packets SET status = 'used', used_at = COALESCE(used_at, ?1), updated_at = ?1
             WHERE id = ?2",
            params![timestamp, packet_id],
        )?;
        if changed == 0 {
            return Err(StoreError::not_found("packet", packet_id));
        }
        self.get(packet_id)?
            .ok_or_else(|| StoreError::not_found("packet", packet_id))
    }
}

pub struct PhaseRepository<'a> {
    store: &'a Store,
}

impl<'a> PhaseRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewPhase) -> StoreResult<Phase> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let id = new_id();
        let timestamp = now();
        let rules = json_text(&input.rules)?;
        let advancement = json_text(&input.advancement)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO phases
                    (id, tournament_id, name, phase_type, sequence, status, rules_json,
                     advancement_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    id,
                    input.tournament_id,
                    input.name,
                    input.phase_type,
                    input.sequence,
                    input.status,
                    rules,
                    advancement,
                    timestamp,
                ],
            )?;
            Ok(Phase {
                id,
                tournament_id: input.tournament_id,
                name: input.name,
                phase_type: input.phase_type,
                sequence: input.sequence,
                status: input.status,
                rules: input.rules,
                advancement: input.advancement,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Phase>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, name, phase_type, sequence, status, rules_json,
                    advancement_json, created_at, updated_at
             FROM phases WHERE tournament_id = ?1 ORDER BY sequence, id",
        )?;
        let rows = statement.query_map(params![tournament_id], phase_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn assign_team(&self, input: NewPhaseTeam) -> StoreResult<PhaseTeam> {
        self.store.write_transaction(|transaction| {
            let phase_tournament = phase_tournament(transaction, &input.phase_id)?
                .ok_or_else(|| StoreError::not_found("phase", &input.phase_id))?;
            let team_tournament = team_tournament(transaction, &input.team_id)?
                .ok_or_else(|| StoreError::not_found("team", &input.team_id))?;
            if phase_tournament != team_tournament {
                return Err(StoreError::Conflict(
                    "phase and team belong to different tournaments".to_owned(),
                ));
            }
            if let Some(pool_id) = &input.pool_id {
                let pool_phase: Option<String> = transaction
                    .query_row(
                        "SELECT phase_id FROM pools WHERE id = ?1",
                        params![pool_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if pool_phase.as_deref() != Some(input.phase_id.as_str()) {
                    return Err(StoreError::Conflict(
                        "pool does not belong to the selected phase".to_owned(),
                    ));
                }
            }
            transaction.execute(
                "INSERT INTO phase_teams (phase_id, team_id, pool_id, seed, standing)
                 VALUES (?1, ?2, ?3, ?4, NULL)
                 ON CONFLICT(phase_id, team_id) DO UPDATE SET
                    pool_id = excluded.pool_id,
                    seed = excluded.seed",
                params![input.phase_id, input.team_id, input.pool_id, input.seed],
            )?;
            Ok(PhaseTeam {
                phase_id: input.phase_id,
                team_id: input.team_id,
                pool_id: input.pool_id,
                seed: input.seed,
                standing: None,
            })
        })
    }

    pub fn teams(&self, phase_id: &str) -> StoreResult<Vec<PhaseTeam>> {
        let mut statement = self.store.connection().prepare(
            "SELECT phase_id, team_id, pool_id, seed, standing
             FROM phase_teams WHERE phase_id = ?1 ORDER BY COALESCE(seed, 2147483647), team_id",
        )?;
        let rows = statement.query_map(params![phase_id], |row| {
            Ok(PhaseTeam {
                phase_id: row.get(0)?,
                team_id: row.get(1)?,
                pool_id: row.get(2)?,
                seed: row.get(3)?,
                standing: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct PoolRepository<'a> {
    store: &'a Store,
}

impl<'a> PoolRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewPool) -> StoreResult<Pool> {
        let phase_exists: bool = self.store.connection().query_row(
            "SELECT EXISTS(SELECT 1 FROM phases WHERE id = ?1)",
            params![input.phase_id],
            |row| row.get(0),
        )?;
        if !phase_exists {
            return Err(StoreError::not_found("phase", input.phase_id));
        }
        let id = new_id();
        let timestamp = now();
        let rules = json_text(&input.rules)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO pools
                    (id, phase_id, name, sequence, rules_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    id,
                    input.phase_id,
                    input.name,
                    input.sequence,
                    rules,
                    timestamp
                ],
            )?;
            Ok(Pool {
                id,
                phase_id: input.phase_id,
                name: input.name,
                sequence: input.sequence,
                rules: input.rules,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, phase_id: &str) -> StoreResult<Vec<Pool>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, phase_id, name, sequence, rules_json, created_at, updated_at
             FROM pools WHERE phase_id = ?1 ORDER BY sequence, id",
        )?;
        let rows = statement.query_map(params![phase_id], pool_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct RoundRepository<'a> {
    store: &'a Store,
}

impl<'a> RoundRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewRound) -> StoreResult<Round> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let phase_tournament: Option<String> = self
            .store
            .connection()
            .query_row(
                "SELECT tournament_id FROM phases WHERE id = ?1",
                params![input.phase_id],
                |row| row.get(0),
            )
            .optional()?;
        let phase_tournament =
            phase_tournament.ok_or_else(|| StoreError::not_found("phase", &input.phase_id))?;
        if phase_tournament != input.tournament_id {
            return Err(StoreError::Conflict(
                "phase and round belong to different tournaments".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO rounds
                    (id, tournament_id, phase_id, name, sequence, round_number, status,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    input.tournament_id,
                    input.phase_id,
                    input.name,
                    input.sequence,
                    input.round_number,
                    input.status,
                    timestamp,
                ],
            )?;
            Ok(Round {
                id,
                tournament_id: input.tournament_id,
                phase_id: input.phase_id,
                name: input.name,
                sequence: input.sequence,
                round_number: input.round_number,
                status: input.status,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Round>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, phase_id, name, sequence, round_number, status,
                    created_at, updated_at
             FROM rounds WHERE tournament_id = ?1 ORDER BY round_number, id",
        )?;
        let rows = statement.query_map(params![tournament_id], round_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_status(&self, id: &str, status: &str) -> StoreResult<Round> {
        let changed = self.store.connection().execute(
            "UPDATE rounds SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::not_found("round", id));
        }
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, phase_id, name, sequence, round_number, status,
                    created_at, updated_at FROM rounds WHERE id = ?1",
        )?;
        statement
            .query_row(params![id], round_from_row)
            .map_err(StoreError::from)
    }
}

pub struct ScheduleRepository<'a> {
    store: &'a Store,
}

impl<'a> ScheduleRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewScheduledGame) -> StoreResult<ScheduledGame> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let round_tournament = round_tournament(transaction, &input.round_id)?
                .ok_or_else(|| StoreError::not_found("round", &input.round_id))?;
            if round_tournament != input.tournament_id {
                return Err(StoreError::Conflict(
                    "round and scheduled game belong to different tournaments".to_owned(),
                ));
            }
            if let Some(room_id) = &input.room_id {
                let room_tournament: Option<String> = transaction
                    .query_row(
                        "SELECT tournament_id FROM rooms WHERE id = ?1",
                        params![room_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if room_tournament.as_deref() != Some(input.tournament_id.as_str()) {
                    return Err(StoreError::not_found("room", room_id));
                }
                let room_booked: bool = transaction.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM scheduled_games
                        WHERE round_id = ?1 AND room_id = ?2 AND status <> 'cancelled'
                    )",
                    params![input.round_id, room_id],
                    |row| row.get(0),
                )?;
                if room_booked {
                    return Err(StoreError::Conflict(
                        "room is already booked in this round".to_owned(),
                    ));
                }
            }
            if let Some(packet_id) = &input.packet_id {
                let packet_tournament = packet_tournament(transaction, packet_id)?
                    .ok_or_else(|| StoreError::not_found("packet", packet_id))?;
                if packet_tournament != input.tournament_id {
                    return Err(StoreError::Conflict(
                        "packet and scheduled game belong to different tournaments".to_owned(),
                    ));
                }
                let already_assigned: bool = transaction.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM packet_assignments WHERE packet_id = ?1
                    )",
                    params![packet_id],
                    |row| row.get(0),
                )?;
                if already_assigned {
                    return Err(StoreError::Conflict(format!(
                        "packet {packet_id} is already assigned"
                    )));
                }
            }
            for team_id in [&input.team_a_id, &input.team_b_id].into_iter().flatten() {
                let team_tournament: Option<String> = transaction
                    .query_row(
                        "SELECT tournament_id FROM teams WHERE id = ?1",
                        params![team_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if team_tournament.as_deref() != Some(input.tournament_id.as_str()) {
                    return Err(StoreError::not_found("team", team_id));
                }
                let team_booked: bool = transaction.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM scheduled_games
                        WHERE round_id = ?1 AND status <> 'cancelled'
                          AND (team_a_id = ?2 OR team_b_id = ?2)
                    )",
                    params![input.round_id, team_id],
                    |row| row.get(0),
                )?;
                if team_booked {
                    return Err(StoreError::Conflict(format!(
                        "team {team_id} is already scheduled in this round"
                    )));
                }
            }
            if input.team_a_id.is_some() && input.team_a_id == input.team_b_id {
                return Err(StoreError::InvalidInput(
                    "a scheduled game cannot pair a team with itself".to_owned(),
                ));
            }
            transaction.execute(
                "INSERT INTO scheduled_games
                    (id, tournament_id, round_id, room_id, packet_id, team_a_id, team_b_id,
                     game_number, status, scheduled_at, started_at, completed_at, notes,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11, ?12, ?12)",
                params![
                    id,
                    input.tournament_id,
                    input.round_id,
                    input.room_id,
                    input.packet_id,
                    input.team_a_id,
                    input.team_b_id,
                    input.game_number,
                    input.status,
                    input.scheduled_at,
                    input.notes,
                    timestamp,
                ],
            )?;
            if let Some(packet_id) = &input.packet_id {
                transaction.execute(
                    "INSERT INTO packet_assignments
                        (packet_id, round_id, scheduled_game_id, assigned_at)
                     VALUES (?1, NULL, ?2, ?3)",
                    params![packet_id, id, timestamp],
                )?;
                transaction.execute(
                    "UPDATE packets SET status = 'assigned', updated_at = ?1 WHERE id = ?2",
                    params![timestamp, packet_id],
                )?;
            }
            Ok(ScheduledGame {
                id,
                tournament_id: input.tournament_id,
                round_id: input.round_id,
                room_id: input.room_id,
                packet_id: input.packet_id,
                team_a_id: input.team_a_id,
                team_b_id: input.team_b_id,
                game_number: input.game_number,
                status: input.status,
                scheduled_at: input.scheduled_at,
                started_at: None,
                completed_at: None,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<ScheduledGame>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, round_id, room_id, packet_id, team_a_id, team_b_id,
                    game_number, status, scheduled_at, started_at, completed_at, notes,
                    created_at, updated_at
             FROM scheduled_games WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(scheduled_game_from_row(row)?)))
    }

    pub fn list_for_round(&self, round_id: &str) -> StoreResult<Vec<ScheduledGame>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, round_id, room_id, packet_id, team_a_id, team_b_id,
                    game_number, status, scheduled_at, started_at, completed_at, notes,
                    created_at, updated_at
             FROM scheduled_games WHERE round_id = ?1 ORDER BY game_number, id",
        )?;
        let rows = statement.query_map(params![round_id], scheduled_game_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_status(&self, id: &str, status: &str) -> StoreResult<ScheduledGame> {
        let timestamp = now();
        let changed = self.store.connection().execute(
            "UPDATE scheduled_games SET status = ?1, updated_at = ?2,
                    started_at = CASE WHEN ?1 = 'playing' THEN COALESCE(started_at, ?2) ELSE started_at END,
                    completed_at = CASE WHEN ?1 IN ('completed', 'cancelled') THEN COALESCE(completed_at, ?2) ELSE completed_at END
             WHERE id = ?3",
            params![status, timestamp, id],
        )?;
        if changed == 0 {
            return Err(StoreError::not_found("scheduled game", id));
        }
        self.get(id)?
            .ok_or_else(|| StoreError::not_found("scheduled game", id))
    }
}

fn packet_select() -> &'static str {
    "SELECT id, tournament_id, name, packet_type, status, nominal_round_id,
            replacement_for_id, security_notes, used_at, created_at, updated_at
     FROM packets WHERE id = ?1"
}

fn packet_from_row(row: &Row<'_>) -> rusqlite::Result<Packet> {
    Ok(Packet {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        name: row.get(2)?,
        packet_type: row.get(3)?,
        status: row.get(4)?,
        nominal_round_id: row.get(5)?,
        replacement_for_id: row.get(6)?,
        security_notes: row.get(7)?,
        used_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn phase_from_row(row: &Row<'_>) -> rusqlite::Result<Phase> {
    Ok(Phase {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        name: row.get(2)?,
        phase_type: row.get(3)?,
        sequence: row.get(4)?,
        status: row.get(5)?,
        rules: json_from_row(row, 6)?,
        advancement: json_from_row(row, 7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn pool_from_row(row: &Row<'_>) -> rusqlite::Result<Pool> {
    Ok(Pool {
        id: row.get(0)?,
        phase_id: row.get(1)?,
        name: row.get(2)?,
        sequence: row.get(3)?,
        rules: json_from_row(row, 4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn round_from_row(row: &Row<'_>) -> rusqlite::Result<Round> {
    Ok(Round {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        phase_id: row.get(2)?,
        name: row.get(3)?,
        sequence: row.get(4)?,
        round_number: row.get(5)?,
        status: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn scheduled_game_from_row(row: &Row<'_>) -> rusqlite::Result<ScheduledGame> {
    Ok(ScheduledGame {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        round_id: row.get(2)?,
        room_id: row.get(3)?,
        packet_id: row.get(4)?,
        team_a_id: row.get(5)?,
        team_b_id: row.get(6)?,
        game_number: row.get(7)?,
        status: row.get(8)?,
        scheduled_at: row.get(9)?,
        started_at: row.get(10)?,
        completed_at: row.get(11)?,
        notes: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn phase_tournament(
    transaction: &rusqlite::Transaction<'_>,
    phase_id: &str,
) -> rusqlite::Result<Option<String>> {
    transaction
        .query_row(
            "SELECT tournament_id FROM phases WHERE id = ?1",
            params![phase_id],
            |row| row.get(0),
        )
        .optional()
}

fn team_tournament(
    transaction: &rusqlite::Transaction<'_>,
    team_id: &str,
) -> rusqlite::Result<Option<String>> {
    transaction
        .query_row(
            "SELECT tournament_id FROM teams WHERE id = ?1",
            params![team_id],
            |row| row.get(0),
        )
        .optional()
}

fn packet_tournament(
    transaction: &rusqlite::Transaction<'_>,
    packet_id: &str,
) -> rusqlite::Result<Option<String>> {
    transaction
        .query_row(
            "SELECT tournament_id FROM packets WHERE id = ?1",
            params![packet_id],
            |row| row.get(0),
        )
        .optional()
}

fn round_tournament(
    transaction: &rusqlite::Transaction<'_>,
    round_id: &str,
) -> rusqlite::Result<Option<String>> {
    transaction
        .query_row(
            "SELECT tournament_id FROM rounds WHERE id = ?1",
            params![round_id],
            |row| row.get(0),
        )
        .optional()
}

fn scheduled_game_tournament(
    transaction: &rusqlite::Transaction<'_>,
    scheduled_game_id: &str,
) -> rusqlite::Result<Option<String>> {
    transaction
        .query_row(
            "SELECT tournament_id FROM scheduled_games WHERE id = ?1",
            params![scheduled_game_id],
            |row| row.get(0),
        )
        .optional()
}
