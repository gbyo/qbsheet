use crate::model::{
    digest_secret, random_id, AssignmentState, HelpEvent, PresenceRecord, ProgressRecord,
    ResultDisposition, ResultSubmission, RetainedResultSummary, RoomInfo, RosterAmendment,
    RosterAmendmentRequest, SessionEvent, StateError, TournamentInfo,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// The durable boundary between protocol transport and tournament business logic.
///
/// A Tauri host should implement this trait over its SQLite-backed tournament store. The protocol
/// layer never sees database rows and never decides whether a game is valid for standings; it only
/// authenticates a room/session and passes a fully identified operation to this interface.
pub trait QbtcpState: Send + Sync {
    fn tournament(&self) -> Result<TournamentInfo, StateError>;
    fn rooms(&self) -> Result<Vec<RoomInfo>, StateError>;
    fn assignment(&self, room_id: &str) -> Result<AssignmentState, StateError>;

    fn record_presence(&self, _record: PresenceRecord) -> Result<(), StateError> {
        Ok(())
    }

    fn record_progress(&self, _record: ProgressRecord) -> Result<(), StateError> {
        Ok(())
    }

    /// Retain the raw result and return the durable deduplication/review disposition.
    fn record_result(&self, submission: ResultSubmission) -> Result<ResultDisposition, StateError>;

    fn add_roster_amendment(
        &self,
        request: RosterAmendmentRequest,
    ) -> Result<RosterAmendment, StateError>;

    fn record_session_event(&self, _event: SessionEvent) -> Result<(), StateError> {
        Ok(())
    }

    fn record_help_event(&self, _event: HelpEvent) -> Result<(), StateError> {
        Ok(())
    }
}

/// A complete, thread-safe reference state implementation for tests and small embedders.
///
/// It is intentionally an in-memory state implementation, not a pretend persistence layer. It is
/// useful for contract tests and local protocol experiments; a Director host that must survive a
/// process restart implements [`QbtcpState`] over its real SQLite store.
pub struct MemoryState {
    inner: RwLock<MemoryStateData>,
}

struct MemoryStateData {
    tournament: TournamentInfo,
    rooms: HashMap<String, RoomInfo>,
    assignments: HashMap<String, AssignmentState>,
    presences: HashMap<(String, String), PresenceRecord>,
    progresses: HashMap<String, ProgressRecord>,
    results: Vec<MemoryRetainedResult>,
    roster_amendments: Vec<RosterAmendmentRecord>,
    session_events: Vec<SessionEvent>,
    help_events: Vec<HelpEvent>,
}

/// The result record retained by [`MemoryState`], including the original body bytes.
pub struct MemoryRetainedResult {
    pub id: String,
    pub session_id: String,
    pub tournament_id: Option<String>,
    pub match_id: Option<String>,
    pub fingerprint: String,
    pub raw: Vec<u8>,
    pub qbj: Value,
    pub review_required: bool,
    pub warnings: Vec<String>,
    pub conflict_with: Option<String>,
}

pub struct RosterAmendmentRecord {
    pub session_id: String,
    pub amendment: RosterAmendment,
}

impl MemoryState {
    pub fn new(tournament: TournamentInfo, rooms: Vec<RoomInfo>) -> Self {
        let rooms = rooms
            .into_iter()
            .map(|room| (room.id.clone(), room))
            .collect::<HashMap<_, _>>();
        Self {
            inner: RwLock::new(MemoryStateData {
                tournament,
                rooms,
                assignments: HashMap::new(),
                presences: HashMap::new(),
                progresses: HashMap::new(),
                results: Vec::new(),
                roster_amendments: Vec::new(),
                session_events: Vec::new(),
                help_events: Vec::new(),
            }),
        }
    }

    pub fn set_assignment(&self, room_id: impl Into<String>, assignment: AssignmentState) {
        if let Ok(mut inner) = self.inner.write() {
            inner.assignments.insert(room_id.into(), assignment);
        }
    }

    pub fn set_room(&self, room: RoomInfo) {
        if let Ok(mut inner) = self.inner.write() {
            inner.rooms.insert(room.id.clone(), room);
        }
    }

    pub fn remove_room(&self, room_id: &str) {
        if let Ok(mut inner) = self.inner.write() {
            inner.rooms.remove(room_id);
            inner.assignments.remove(room_id);
        }
    }

    pub fn result_summaries(&self) -> Vec<RetainedResultSummary> {
        self.inner
            .read()
            .map(|inner| {
                inner
                    .results
                    .iter()
                    .map(|result| RetainedResultSummary {
                        id: result.id.clone(),
                        session_id: result.session_id.clone(),
                        tournament_id: result.tournament_id.clone(),
                        match_id: result.match_id.clone(),
                        fingerprint: result.fingerprint.clone(),
                        review_required: result.review_required,
                        warnings: result.warnings.clone(),
                        conflict_with: result.conflict_with.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn raw_result(&self, result_id: &str) -> Option<Vec<u8>> {
        self.inner.read().ok().and_then(|inner| {
            inner
                .results
                .iter()
                .find(|result| result.id == result_id)
                .map(|result| result.raw.clone())
        })
    }

    pub fn progress(&self, session_id: &str) -> Option<ProgressRecord> {
        self.inner
            .read()
            .ok()
            .and_then(|inner| inner.progresses.get(session_id).cloned())
    }

    pub fn presence(&self, room_id: &str, device_id: &str) -> Option<PresenceRecord> {
        self.inner.read().ok().and_then(|inner| {
            inner
                .presences
                .get(&(room_id.to_owned(), device_id.to_owned()))
                .cloned()
        })
    }

    pub fn roster_amendments(&self) -> Vec<RosterAmendmentRecordView> {
        self.inner
            .read()
            .map(|inner| {
                inner
                    .roster_amendments
                    .iter()
                    .map(|record| RosterAmendmentRecordView {
                        session_id: record.session_id.clone(),
                        amendment: record.amendment.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn session_events(&self) -> Vec<SessionEvent> {
        self.inner
            .read()
            .map(|inner| inner.session_events.clone())
            .unwrap_or_default()
    }

    pub fn help_events(&self) -> Vec<HelpEvent> {
        self.inner
            .read()
            .map(|inner| inner.help_events.clone())
            .unwrap_or_default()
    }

    fn read(&self) -> Result<RwLockReadGuard<'_, MemoryStateData>, StateError> {
        self.inner.read().map_err(|_| StateError::Unavailable)
    }

    fn write(&self) -> Result<RwLockWriteGuard<'_, MemoryStateData>, StateError> {
        self.inner.write().map_err(|_| StateError::Unavailable)
    }
}

#[derive(Clone)]
pub struct RosterAmendmentRecordView {
    pub session_id: String,
    pub amendment: RosterAmendment,
}

impl QbtcpState for MemoryState {
    fn tournament(&self) -> Result<TournamentInfo, StateError> {
        Ok(self.read()?.tournament.clone())
    }

    fn rooms(&self) -> Result<Vec<RoomInfo>, StateError> {
        let mut rooms = self.read()?.rooms.values().cloned().collect::<Vec<_>>();
        rooms.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(rooms)
    }

    fn assignment(&self, room_id: &str) -> Result<AssignmentState, StateError> {
        if !self.read()?.rooms.contains_key(room_id) {
            return Err(StateError::Rejected);
        }
        Ok(self
            .read()?
            .assignments
            .get(room_id)
            .cloned()
            .unwrap_or_else(|| AssignmentState::None(Default::default())))
    }

    fn record_presence(&self, record: PresenceRecord) -> Result<(), StateError> {
        let mut inner = self.write()?;
        inner
            .presences
            .insert((record.room_id.clone(), record.device_id.clone()), record);
        Ok(())
    }

    fn record_progress(&self, record: ProgressRecord) -> Result<(), StateError> {
        let mut inner = self.write()?;
        let should_replace = inner
            .progresses
            .get(&record.session_id)
            .is_none_or(|current| record.sequence > current.sequence);
        if should_replace {
            inner.progresses.insert(record.session_id.clone(), record);
        }
        Ok(())
    }

    fn record_result(&self, submission: ResultSubmission) -> Result<ResultDisposition, StateError> {
        let mut inner = self.write()?;

        if let Some(existing) = inner.results.iter().find(|result| {
            let same_session_retry = result.session_id == submission.session_id
                && result.fingerprint == submission.fingerprint;
            let same_match_retry = submission.submitted_tournament_id.is_some()
                && submission.submitted_match_id.is_some()
                && result.tournament_id == submission.submitted_tournament_id
                && result.match_id == submission.submitted_match_id
                && result.fingerprint == submission.fingerprint;
            same_session_retry || same_match_retry
        }) {
            return Ok(ResultDisposition {
                result_id: existing.id.clone(),
                duplicate: true,
                review_required: existing.review_required,
                conflict: false,
                warnings: existing.warnings.clone(),
                conflict_with: existing.conflict_with.clone(),
            });
        }

        let mut warnings = Vec::new();
        if submission.submitted_tournament_id.as_deref() != Some(&submission.expected_tournament_id)
        {
            if submission.submitted_tournament_id.is_some() {
                warnings.push("tournament-mismatch".to_owned());
            } else {
                warnings.push("missing-tournament-identity".to_owned());
            }
        }
        if submission.submitted_match_id.as_deref() != Some(&submission.expected_match_id) {
            if submission.submitted_match_id.is_some() {
                warnings.push("match-mismatch".to_owned());
            } else {
                warnings.push("missing-match-identity".to_owned());
            }
        }
        if let (Some(expected), Some(submitted)) = (
            submission.expected_round_revision,
            submission.submitted_round_revision,
        ) {
            if submitted < expected {
                warnings.push("stale-assignment".to_owned());
            }
        }
        if submission.late_after_abandon {
            warnings.push("late-after-abandon".to_owned());
        }

        let conflict_with = inner.results.iter().find_map(|result| {
            let same_match = submission.submitted_tournament_id.is_some()
                && submission.submitted_match_id.is_some()
                && result.tournament_id == submission.submitted_tournament_id
                && result.match_id == submission.submitted_match_id;
            same_match.then(|| result.id.clone())
        });
        let conflict = conflict_with.is_some();
        if conflict {
            warnings.push("result-conflict".to_owned());
        }

        let result_id = random_id("result");
        let review_required = !warnings.is_empty();
        inner.results.push(MemoryRetainedResult {
            id: result_id.clone(),
            session_id: submission.session_id.clone(),
            tournament_id: submission.submitted_tournament_id.clone(),
            match_id: submission.submitted_match_id.clone(),
            fingerprint: submission.fingerprint.clone(),
            raw: submission.raw,
            qbj: submission.qbj,
            review_required,
            warnings: warnings.clone(),
            conflict_with: conflict_with.clone(),
        });

        Ok(ResultDisposition {
            result_id,
            duplicate: false,
            review_required,
            conflict,
            warnings,
            conflict_with,
        })
    }

    fn add_roster_amendment(
        &self,
        request: RosterAmendmentRequest,
    ) -> Result<RosterAmendment, StateError> {
        let mut inner = self.write()?;
        let same = inner.roster_amendments.iter().find(|record| {
            record.session_id == request.session_id
                && record.amendment.player_name.as_deref() == Some(request.player_name.as_str())
                && record.amendment.team_id == request.team_id
                && record.amendment.team_name.as_deref() == Some(request.team_name.as_str())
        });
        if let Some(existing) = same {
            let mut amendment = existing.amendment.clone();
            amendment.created = false;
            amendment.question_number = request.question_number.or(amendment.question_number);
            return Ok(amendment);
        }

        let identity = format!(
            "{}\u{1f}{}\u{1f}{}",
            request.session_id,
            request.team_id.as_deref().unwrap_or(&request.team_name),
            request.player_name
        );
        let digest = digest_secret(&identity);
        let player_id = digest
            .iter()
            .take(12)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let amendment = RosterAmendment {
            player_id: Some(format!("player-{player_id}")),
            player_name: Some(request.player_name),
            team_id: request.team_id,
            team_name: Some(request.team_name),
            created: true,
            warning: None,
            question_number: request.question_number,
        };
        inner.roster_amendments.push(RosterAmendmentRecord {
            session_id: request.session_id,
            amendment: amendment.clone(),
        });
        Ok(amendment)
    }

    fn record_session_event(&self, event: SessionEvent) -> Result<(), StateError> {
        self.write()?.session_events.push(event);
        Ok(())
    }

    fn record_help_event(&self, event: HelpEvent) -> Result<(), StateError> {
        self.write()?.help_events.push(event);
        Ok(())
    }
}
