use rusqlite::{params, OptionalExtension, Row, Transaction};

use super::tournaments::ensure_tournament_exists;
use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{
    Game, NewManualGame, NewProtest, NewResultSubmission, PlayerGameStat, Protest,
    ResultSubmission, StoredPlayerGameStat, SubmittedGameResult,
};
use crate::util::{json_from_row, json_text, new_id, now};

pub struct GameRepository<'a> {
    store: &'a Store,
}

impl<'a> GameRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewManualGame) -> StoreResult<Game> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            if let Some(scheduled_game_id) = &input.scheduled_game_id {
                let scheduled_tournament: Option<String> = transaction
                    .query_row(
                        "SELECT tournament_id FROM scheduled_games WHERE id = ?1",
                        params![scheduled_game_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match scheduled_tournament {
                    Some(scheduled_tournament) if scheduled_tournament == input.tournament_id => {}
                    Some(_) => {
                        return Err(StoreError::Conflict(
                            "scheduled game belongs to a different tournament".to_owned(),
                        ))
                    }
                    None => return Err(StoreError::not_found("scheduled game", scheduled_game_id)),
                }
            }
            transaction.execute(
                "INSERT INTO games
                    (id, tournament_id, scheduled_game_id, status, team_a_score, team_b_score,
                     winner_team_id, result_type, notes, started_at, completed_at, accepted_at,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, NULL, ?10, ?10)",
                params![
                    id,
                    input.tournament_id,
                    input.scheduled_game_id,
                    input.status,
                    input.team_a_score,
                    input.team_b_score,
                    input.winner_team_id,
                    input.result_type,
                    input.notes,
                    timestamp,
                ],
            )?;
            Ok(Game {
                id,
                tournament_id: input.tournament_id,
                scheduled_game_id: input.scheduled_game_id,
                status: input.status,
                team_a_score: input.team_a_score,
                team_b_score: input.team_b_score,
                winner_team_id: input.winner_team_id,
                result_type: input.result_type,
                notes: input.notes,
                started_at: None,
                completed_at: None,
                accepted_at: None,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Game>> {
        let mut statement = self.store.connection().prepare(game_select())?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(game_from_row(row)?)))
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Game>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, scheduled_game_id, status, team_a_score, team_b_score,
                    winner_team_id, result_type, notes, started_at, completed_at, accepted_at,
                    created_at, updated_at
             FROM games WHERE tournament_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map(params![tournament_id], game_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn stats(&self, game_id: &str) -> StoreResult<Vec<StoredPlayerGameStat>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, game_id, player_id, team_id, tossups_heard, powers, gets, negs,
                    bonus_points, bonuses_heard, bouncebacks, points
             FROM game_player_stats WHERE game_id = ?1
             ORDER BY team_id, player_id, id",
        )?;
        let rows = statement.query_map(params![game_id], |row| {
            Ok(StoredPlayerGameStat {
                id: row.get(0)?,
                game_id: row.get(1)?,
                stats: PlayerGameStat {
                    player_id: row.get(2)?,
                    team_id: row.get(3)?,
                    tossups_heard: row.get(4)?,
                    powers: row.get(5)?,
                    gets: row.get(6)?,
                    negs: row.get(7)?,
                    bonus_points: row.get(8)?,
                    bonuses_heard: row.get(9)?,
                    bouncebacks: row.get(10)?,
                    points: row.get(11)?,
                },
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct SubmissionRepository<'a> {
    store: &'a Store,
}

impl<'a> SubmissionRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewResultSubmission) -> StoreResult<ResultSubmission> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.fingerprint.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "result submission fingerprint cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let submitted_at = now();
        let payload = json_text(&input.payload)?;
        self.store.write_transaction(|transaction| {
            let game_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM games WHERE id = ?1",
                    params![input.game_id],
                    |row| row.get(0),
                )
                .optional()?;
            match game_tournament {
                Some(game_tournament) if game_tournament == input.tournament_id => {}
                Some(_) => {
                    return Err(StoreError::Conflict(
                        "game belongs to a different tournament".to_owned(),
                    ))
                }
                None => return Err(StoreError::not_found("game", &input.game_id)),
            }
            transaction.execute(
                "INSERT INTO result_submissions
                    (id, tournament_id, game_id, qbtcp_session_id, fingerprint, payload_json,
                     status, submitted_at, reviewed_at, reviewed_by, review_note)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'received', ?7, NULL, NULL, NULL)",
                params![
                    id,
                    input.tournament_id,
                    input.game_id,
                    input.qbtcp_session_id,
                    input.fingerprint,
                    payload,
                    submitted_at,
                ],
            )?;
            Ok(ResultSubmission {
                id,
                tournament_id: input.tournament_id,
                game_id: input.game_id,
                qbtcp_session_id: input.qbtcp_session_id,
                fingerprint: input.fingerprint,
                payload: input.payload,
                status: "received".to_owned(),
                submitted_at,
                reviewed_at: None,
                reviewed_by: None,
                review_note: None,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<ResultSubmission>> {
        let mut statement = self.store.connection().prepare(submission_select())?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(submission_from_row(row)?)))
    }

    pub fn list_for_review(&self, tournament_id: &str) -> StoreResult<Vec<ResultSubmission>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, game_id, qbtcp_session_id, fingerprint, payload_json,
                    status, submitted_at, reviewed_at, reviewed_by, review_note
             FROM result_submissions WHERE tournament_id = ?1 AND status IN ('received', 'review')
             ORDER BY submitted_at, id",
        )?;
        let rows = statement.query_map(params![tournament_id], submission_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct ResultRepository<'a> {
    store: &'a Store,
}

impl<'a> ResultRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn accept_submission(
        &self,
        submission_id: &str,
        actor: Option<&str>,
        note: Option<&str>,
    ) -> StoreResult<Game> {
        self.store.write_transaction(|transaction| {
            let submission: ResultSubmission = transaction.query_row(
                submission_select(),
                params![submission_id],
                submission_from_row,
            )?;
            let game: Game = transaction.query_row(game_select(), params![submission.game_id], game_from_row)?;
            if submission.status == "accepted" {
                return Ok(game);
            }
            if !matches!(submission.status.as_str(), "received" | "review") {
                return Err(StoreError::Conflict(format!(
                    "result submission is {}, not reviewable",
                    submission.status
                )));
            }

            let submitted: SubmittedGameResult = serde_json::from_value(submission.payload.clone())?;
            validate_result(&submitted, transaction, &game)?;
            let accepted_at = now();
            let result_type = submitted
                .result_type
                .clone()
                .unwrap_or_else(|| "regular".to_owned());
            transaction.execute(
                "UPDATE games SET status = 'accepted', team_a_score = ?1, team_b_score = ?2,
                    winner_team_id = ?3, result_type = ?4, notes = ?5,
                    completed_at = COALESCE(completed_at, ?6), accepted_at = ?6, updated_at = ?6
                 WHERE id = ?7",
                params![
                    submitted.team_a_score,
                    submitted.team_b_score,
                    submitted.winner_team_id,
                    result_type,
                    submitted.notes,
                    accepted_at,
                    game.id,
                ],
            )?;
            transaction.execute(
                "DELETE FROM game_player_stats WHERE game_id = ?1",
                params![game.id],
            )?;
            for stat in &submitted.player_stats {
                validate_stat(stat, transaction, &game)?;
                transaction.execute(
                    "INSERT INTO game_player_stats
                        (id, game_id, team_id, player_id, tossups_heard, powers, gets, negs,
                         bonus_points, bonuses_heard, bouncebacks, points)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        new_id(),
                        game.id,
                        stat.team_id,
                        stat.player_id,
                        stat.tossups_heard,
                        stat.powers,
                        stat.gets,
                        stat.negs,
                        stat.bonus_points,
                        stat.bonuses_heard,
                        stat.bouncebacks,
                        stat.points,
                    ],
                )?;
            }
            transaction.execute(
                "UPDATE result_submissions SET status = 'accepted', reviewed_at = ?1,
                    reviewed_by = ?2, review_note = ?3 WHERE id = ?4",
                params![accepted_at, actor, note, submission.id],
            )?;
            transaction.execute(
                "UPDATE scheduled_games SET status = 'completed', completed_at = COALESCE(completed_at, ?1),
                    updated_at = ?1
                 WHERE id = (SELECT scheduled_game_id FROM games WHERE id = ?2)",
                params![accepted_at, game.id],
            )?;
            let audit_payload = serde_json::json!({
                "submission_id": submission.id,
                "game_id": game.id,
                "note": note,
            });
            transaction.execute(
                "INSERT INTO audit_events
                    (id, tournament_id, event_type, entity_type, entity_id, actor,
                     payload_json, created_at)
                 VALUES (?1, ?2, 'result.accepted', 'game', ?3, ?4, ?5, ?6)",
                params![
                    new_id(),
                    submission.tournament_id,
                    game.id,
                    actor,
                    json_text(&audit_payload)?,
                    accepted_at,
                ],
            )?;
            transaction.query_row(game_select(), params![game.id], game_from_row)
                .map_err(StoreError::from)
        })
    }
}

pub struct ProtestRepository<'a> {
    store: &'a Store,
}

impl<'a> ProtestRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewProtest) -> StoreResult<Protest> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.issue.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "protest issue cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            if let Some(game_id) = &input.game_id {
                let game_tournament: Option<String> = transaction
                    .query_row(
                        "SELECT tournament_id FROM games WHERE id = ?1",
                        params![game_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if game_tournament.as_deref() != Some(input.tournament_id.as_str()) {
                    return Err(StoreError::not_found("game", game_id));
                }
            }
            transaction.execute(
                "INSERT INTO protests
                    (id, tournament_id, game_id, submitted_by, issue, status, ruling, notes,
                     created_at, resolved_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, NULL, ?8)",
                params![
                    id,
                    input.tournament_id,
                    input.game_id,
                    input.submitted_by,
                    input.issue,
                    input.status,
                    input.notes,
                    timestamp,
                ],
            )?;
            Ok(Protest {
                id,
                tournament_id: input.tournament_id,
                game_id: input.game_id,
                submitted_by: input.submitted_by,
                issue: input.issue,
                status: input.status,
                ruling: None,
                notes: input.notes,
                created_at: timestamp,
                resolved_at: None,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Protest>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, game_id, submitted_by, issue, status, ruling, notes,
                    created_at, resolved_at, updated_at
             FROM protests WHERE tournament_id = ?1 ORDER BY created_at, id",
        )?;
        let rows = statement.query_map(params![tournament_id], protest_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn resolve(
        &self,
        protest_id: &str,
        ruling: &str,
        notes: Option<&str>,
        actor: Option<&str>,
    ) -> StoreResult<Protest> {
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            let changed = transaction.execute(
                "UPDATE protests SET status = 'resolved', ruling = ?1, notes = COALESCE(?2, notes),
                    resolved_at = ?3, updated_at = ?3 WHERE id = ?4",
                params![ruling, notes, timestamp, protest_id],
            )?;
            if changed == 0 {
                return Err(StoreError::not_found("protest", protest_id));
            }
            let protest: Protest = transaction.query_row(
                "SELECT id, tournament_id, game_id, submitted_by, issue, status, ruling, notes,
                        created_at, resolved_at, updated_at
                 FROM protests WHERE id = ?1",
                params![protest_id],
                protest_from_row,
            )?;
            let payload = serde_json::json!({
                "protest_id": protest.id,
                "ruling": ruling,
                "notes": notes,
            });
            transaction.execute(
                "INSERT INTO audit_events
                    (id, tournament_id, event_type, entity_type, entity_id, actor,
                     payload_json, created_at)
                 VALUES (?1, ?2, 'protest.resolved', 'protest', ?3, ?4, ?5, ?6)",
                params![
                    new_id(),
                    protest.tournament_id,
                    protest.id,
                    actor,
                    json_text(&payload)?,
                    timestamp,
                ],
            )?;
            Ok(protest)
        })
    }
}

fn game_select() -> &'static str {
    "SELECT id, tournament_id, scheduled_game_id, status, team_a_score, team_b_score,
            winner_team_id, result_type, notes, started_at, completed_at, accepted_at,
            created_at, updated_at
     FROM games WHERE id = ?1"
}

fn game_from_row(row: &Row<'_>) -> rusqlite::Result<Game> {
    Ok(Game {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        scheduled_game_id: row.get(2)?,
        status: row.get(3)?,
        team_a_score: row.get(4)?,
        team_b_score: row.get(5)?,
        winner_team_id: row.get(6)?,
        result_type: row.get(7)?,
        notes: row.get(8)?,
        started_at: row.get(9)?,
        completed_at: row.get(10)?,
        accepted_at: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn submission_select() -> &'static str {
    "SELECT id, tournament_id, game_id, qbtcp_session_id, fingerprint, payload_json,
            status, submitted_at, reviewed_at, reviewed_by, review_note
     FROM result_submissions WHERE id = ?1"
}

fn submission_from_row(row: &Row<'_>) -> rusqlite::Result<ResultSubmission> {
    Ok(ResultSubmission {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        game_id: row.get(2)?,
        qbtcp_session_id: row.get(3)?,
        fingerprint: row.get(4)?,
        payload: json_from_row(row, 5)?,
        status: row.get(6)?,
        submitted_at: row.get(7)?,
        reviewed_at: row.get(8)?,
        reviewed_by: row.get(9)?,
        review_note: row.get(10)?,
    })
}

fn protest_from_row(row: &Row<'_>) -> rusqlite::Result<Protest> {
    Ok(Protest {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        game_id: row.get(2)?,
        submitted_by: row.get(3)?,
        issue: row.get(4)?,
        status: row.get(5)?,
        ruling: row.get(6)?,
        notes: row.get(7)?,
        created_at: row.get(8)?,
        resolved_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn validate_result(
    submitted: &SubmittedGameResult,
    transaction: &Transaction<'_>,
    game: &Game,
) -> StoreResult<()> {
    if submitted.team_a_score < 0 || submitted.team_b_score < 0 {
        return Err(StoreError::InvalidInput(
            "accepted game scores cannot be negative".to_owned(),
        ));
    }
    if game.scheduled_game_id.is_some() {
        if let Some(winner_team_id) = &submitted.winner_team_id {
            let expected: bool = transaction.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM scheduled_games
                    WHERE id = (SELECT scheduled_game_id FROM games WHERE id = ?1)
                      AND (team_a_id = ?2 OR team_b_id = ?2)
                )",
                params![game.id, winner_team_id],
                |row| row.get(0),
            )?;
            if !expected {
                return Err(StoreError::InvalidInput(
                    "winner is not one of the scheduled teams".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_stat(
    stat: &PlayerGameStat,
    transaction: &Transaction<'_>,
    game: &Game,
) -> StoreResult<()> {
    let nonnegative = [
        stat.tossups_heard,
        stat.powers,
        stat.gets,
        stat.negs,
        stat.bonus_points,
        stat.bonuses_heard,
        stat.bouncebacks,
        stat.points,
    ]
    .iter()
    .all(|value| *value >= 0);
    if !nonnegative {
        return Err(StoreError::InvalidInput(
            "player statistics cannot be negative".to_owned(),
        ));
    }
    let is_expected_team: bool = transaction.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM scheduled_games
            WHERE id = (SELECT scheduled_game_id FROM games WHERE id = ?1)
              AND (team_a_id = ?2 OR team_b_id = ?2)
        )",
        params![game.id, stat.team_id],
        |row| row.get(0),
    )?;
    if game.scheduled_game_id.is_some() && !is_expected_team {
        return Err(StoreError::InvalidInput(
            "player statistics reference a team outside the scheduled game".to_owned(),
        ));
    }
    Ok(())
}
