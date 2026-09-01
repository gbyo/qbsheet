use crate::model::*;
use crate::state::QbtcpState;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
pub struct DiscoveryDocument {
    pub protocol: &'static str,
    pub version: u32,
    pub capabilities: Vec<String>,
    pub qbj_version: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct HealthDocument {
    pub ok: bool,
    pub protocol: &'static str,
    pub version: u32,
    pub uptime_seconds: u64,
}

#[derive(Clone, Serialize)]
pub struct TournamentDocument {
    pub id: String,
    pub name: String,
    pub qbj_version: String,
}

/// Returned to the Director host when it asks for a new projector/QR pairing invitation.
///
/// The code is intentionally not a protocol response. A Tauri host may render it in its pairing
/// UI or embed it in the fragment-only launch URL described by `docs/QBTCP.md`.
pub struct PairingInvitation {
    pub room_id: String,
    pub room_name: String,
    pub code: String,
    pub expires_in: Duration,
}

#[derive(Clone, Serialize)]
pub struct PairingResponse {
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "roomName")]
    pub room_name: String,
    #[serde(rename = "roomDescription", skip_serializing_if = "Option::is_none")]
    pub room_description: Option<String>,
    pub token: String,
}

#[derive(Clone, Serialize)]
pub struct OpenSessionResponse {
    pub session_id: String,
    pub token: String,
    pub writer: bool,
}

#[derive(Clone, Serialize)]
pub struct ProgressResponse {
    pub accepted: bool,
    pub sequence: u64,
}

#[derive(Clone, Serialize)]
pub struct ResultReceipt {
    /// Kept for the pre-receipt client contract. `review_required` remains authoritative.
    pub accepted: bool,
    pub received: bool,
    pub review_required: bool,
    pub duplicate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_id: Option<String>,
    pub fingerprint: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub conflict: bool,
    pub result_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict_with: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Serialize)]
pub struct SessionDocument {
    pub session_id: String,
    pub match_id: String,
    pub status: SessionStatus,
    pub writer: bool,
    pub progress_sequence: Option<u64>,
    pub result_received: bool,
    pub updated_at: String,
}

#[derive(Clone, Serialize)]
pub struct RecoveryDocument {
    pub session_id: String,
    pub round_number: u32,
    pub left_team: String,
    pub right_team: String,
    pub status: SessionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignment_revision: Option<u64>,
    pub final_received: bool,
    pub latest_qbj: Option<Value>,
    pub roster_amendments: Vec<RosterAmendment>,
}

#[derive(Clone)]
struct PairingTicket {
    room_id: String,
    expires_at: Instant,
}

struct RoomTokenRecord {
    room_id: String,
}

struct SessionCredential {
    token: String,
    session_id: String,
    device_id: String,
}

struct ProgressSnapshot {
    sequence: u64,
}

struct SessionRecord {
    session_id: String,
    room_id: String,
    match_id: String,
    round_number: u32,
    left_team: Option<String>,
    right_team: Option<String>,
    round_revision: Option<u64>,
    assignment_revision: Option<u64>,
    status: SessionStatus,
    updated_at: String,
    last_activity: Instant,
    expires_at: Option<Instant>,
    credentials_by_device: HashMap<String, [u8; 32]>,
    writer_token: Option<[u8; 32]>,
    writer_device: Option<String>,
    latest_progress: Option<ProgressSnapshot>,
    latest_qbj: Option<Value>,
    final_fingerprint: Option<String>,
    final_result_id: Option<String>,
    roster_amendments: Vec<RosterAmendment>,
}

struct PresenceRecordInternal {
    view: PresenceView,
    observed_at: Instant,
}

struct HelpRecordInternal {
    request: HelpRequest,
}

#[derive(Default)]
struct RuntimeState {
    pairings: HashMap<[u8; 32], PairingTicket>,
    room_tokens: HashMap<[u8; 32], RoomTokenRecord>,
    sessions: HashMap<String, SessionRecord>,
    session_tokens: HashMap<[u8; 32], SessionCredential>,
    presences: HashMap<(String, String), PresenceRecordInternal>,
    helps: HashMap<(String, String), HelpRecordInternal>,
    pair_attempts: HashMap<String, VecDeque<Instant>>,
}

struct SessionAuth {
    token_hash: [u8; 32],
    session_id: String,
}

/// QBTCP's protocol/core implementation.
///
/// `QbtcpServer` is intentionally generic over state only at construction time. The HTTP handlers
/// call these methods, while a native host can call the same methods directly for projector pairing,
/// explicit abandon, or diagnostics without manufacturing HTTP requests.
pub struct QbtcpServer {
    pub(crate) state: Arc<dyn QbtcpState>,
    pub(crate) config: QbtcpConfig,
    runtime: Mutex<RuntimeState>,
    started_at: Instant,
}

impl QbtcpServer {
    pub fn new<S>(state: Arc<S>, config: QbtcpConfig) -> Result<Self, ConfigError>
    where
        S: QbtcpState + 'static,
    {
        config.validate()?;
        Ok(Self {
            state,
            config,
            runtime: Mutex::new(RuntimeState::default()),
            started_at: Instant::now(),
        })
    }

    pub fn config(&self) -> &QbtcpConfig {
        &self.config
    }

    /// Mount the canonical HTTP transport in an axum/Tauri listener.
    pub fn router(self: &Arc<Self>) -> axum::Router {
        crate::transport::router(Arc::clone(self))
    }

    /// Serve the router on a Tokio TCP listener. Tauri can instead mount [`Self::router`] into a
    /// listener it already owns.
    pub async fn serve(
        self: Arc<Self>,
        listener: tokio::net::TcpListener,
    ) -> Result<(), std::io::Error> {
        axum::serve(listener, self.router()).await
    }

    pub fn discovery(&self) -> Result<DiscoveryDocument, QbtcpError> {
        let tournament = self.tournament_info()?;
        Ok(DiscoveryDocument {
            protocol: "QBTCP",
            version: self.config.protocol_version,
            capabilities: self.config.capabilities.clone(),
            qbj_version: if tournament.qbj_version.is_empty() {
                self.config.qbj_version.clone()
            } else {
                tournament.qbj_version
            },
            name: if tournament.name.is_empty() {
                self.config.name.clone()
            } else {
                tournament.name
            },
        })
    }

    pub fn health(&self) -> HealthDocument {
        HealthDocument {
            ok: true,
            protocol: "QBTCP",
            version: self.config.protocol_version,
            uptime_seconds: self.started_at.elapsed().as_secs(),
        }
    }

    pub fn tournament(&self) -> Result<TournamentDocument, QbtcpError> {
        let tournament = self.tournament_info()?;
        Ok(TournamentDocument {
            id: tournament.id,
            name: tournament.name,
            qbj_version: tournament.qbj_version,
        })
    }

    pub fn rooms(&self) -> Result<Vec<RoomListEntry>, QbtcpError> {
        self.require_capability("pairing")?;
        self.state
            .rooms()
            .map_err(|_| QbtcpError::Internal)
            .map(|rooms| rooms.iter().map(RoomListEntry::from).collect())
    }

    /// Issue a fresh, short-lived code for a known enabled room.
    pub fn issue_pairing(&self, room_id: &str) -> Result<PairingInvitation, QbtcpError> {
        self.require_capability("pairing")?;
        let room = self
            .room_info(room_id)?
            .filter(|room| room.enabled)
            .ok_or(QbtcpError::NotFound("The requested room is not available."))?;
        self.sweep_expired();

        let mut runtime = self.lock_runtime()?;
        let mut code = pairing_code();
        let mut code_hash = digest_secret(&code);
        while runtime.pairings.contains_key(&code_hash) {
            code = pairing_code();
            code_hash = digest_secret(&code);
        }
        runtime.pairings.insert(
            code_hash,
            PairingTicket {
                room_id: room.id.clone(),
                expires_at: Instant::now() + self.config.pairing_code_ttl,
            },
        );
        Ok(PairingInvitation {
            room_id: room.id,
            room_name: room.name,
            code,
            expires_in: self.config.pairing_code_ttl,
        })
    }

    /// Exchange the one-time code for a room capability.
    pub fn pair(
        &self,
        code: &str,
        requested_room_id: Option<&str>,
        source: &str,
    ) -> Result<PairingResponse, QbtcpError> {
        self.require_capability("pairing")?;
        self.sweep_expired();

        let source = clean_advisory(source, 128).unwrap_or_else(|| "unknown".to_owned());
        let now = Instant::now();
        let code_hash = digest_secret(code);
        let mut runtime = self.lock_runtime()?;
        let attempts = runtime.pair_attempts.entry(source).or_default();
        while attempts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= self.config.pairing_rate_limit.window)
        {
            attempts.pop_front();
        }
        if attempts.len() >= self.config.pairing_rate_limit.max_attempts {
            let retry_after_secs = self.config.pairing_rate_limit.window.as_secs().max(1);
            return Err(QbtcpError::RateLimited { retry_after_secs });
        }
        attempts.push_back(now);

        // All malformed/unknown/mismatched/disabled codes converge on this one answer. The code is
        // never retained in an error or response.
        if code.len() != PAIRING_CODE_LENGTH || !code.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(QbtcpError::PairingRefused);
        }
        let Some(ticket) = runtime.pairings.get(&code_hash).cloned() else {
            return Err(QbtcpError::PairingRefused);
        };
        if ticket.expires_at <= now
            || requested_room_id.is_some_and(|room_id| room_id != ticket.room_id)
        {
            return Err(QbtcpError::PairingRefused);
        }
        drop(runtime);

        let room = self
            .room_info(&ticket.room_id)?
            .filter(|room| room.enabled)
            .ok_or(QbtcpError::PairingRefused)?;

        let token = random_secret();
        let token_hash = digest_secret(&token);
        let mut runtime = self.lock_runtime()?;
        // The ticket can only be spent once. A concurrent exchange that won the race receives the
        // same uniform pairing refusal on its second check.
        let Some(ticket) = runtime.pairings.remove(&code_hash) else {
            return Err(QbtcpError::PairingRefused);
        };
        if ticket.expires_at <= Instant::now() {
            return Err(QbtcpError::PairingRefused);
        }
        runtime.room_tokens.insert(
            token_hash,
            RoomTokenRecord {
                room_id: room.id.clone(),
            },
        );
        Ok(PairingResponse {
            room_id: room.id,
            room_name: room.name,
            room_description: room.description,
            token,
        })
    }

    pub fn assignment(&self, room_token: Option<&str>) -> Result<Option<Value>, QbtcpError> {
        self.require_capability("assignment")?;
        let room_id = self.authenticate_room(room_token)?;
        match self.assignment_state(&room_id)? {
            AssignmentState::Assigned(assignment) => Ok(Some(assignment.qbj)),
            AssignmentState::None(_)
            | AssignmentState::Blocked { .. }
            | AssignmentState::Held { .. } => Ok(None),
        }
    }

    pub fn assignment_status(
        &self,
        room_token: Option<&str>,
    ) -> Result<AssignmentStatusResponse, QbtcpError> {
        self.require_capability("assignment")?;
        let room_id = self.authenticate_room(room_token)?;
        let assignment = self.assignment_state(&room_id)?;
        let (state, meta, blocked_reason, blocked_message, match_id) = match &assignment {
            AssignmentState::Assigned(assignment) => (
                "assigned",
                assignment.meta.clone(),
                None,
                None,
                Some(assignment.match_id.clone()),
            ),
            AssignmentState::None(meta) => ("none", meta.clone(), None, None, None),
            AssignmentState::Blocked {
                reason,
                message,
                meta,
            } => (
                "blocked",
                meta.clone(),
                Some(reason.clone()),
                Some(message.clone()),
                None,
            ),
            AssignmentState::Held {
                reason,
                message,
                meta,
            } => (
                "held",
                meta.clone(),
                Some(reason.clone()),
                Some(message.clone()),
                None,
            ),
        };
        let session = match_id
            .as_deref()
            .and_then(|match_id| self.session_status_for(&room_id, match_id));
        Ok(AssignmentStatusResponse {
            state: state.to_owned(),
            blocked_reason,
            blocked_message,
            session,
            previous: meta.previous,
            next: meta.next,
            round_revision: meta.round_revision,
            assignment_revision: meta.assignment_revision,
            released_round: meta.released_round,
            hold_new_starts: meta.hold_new_starts,
        })
    }

    pub fn open_session(
        &self,
        room_token: Option<&str>,
        match_id: &str,
        device_id: Option<&str>,
    ) -> Result<OpenSessionResponse, QbtcpError> {
        self.require_capability("assignment")?;
        let room_id = self.authenticate_room(room_token)?;
        let device_key = normalize_identity(device_id)?;
        let assignment = self.assignment_state(&room_id)?;
        let AssignmentState::Assigned(assignment) = assignment else {
            return Err(QbtcpError::Conflict {
                message: "This room cannot start a game yet.",
                writer_device: None,
                can_take_over: false,
            });
        };
        if assignment.match_id != match_id {
            return Err(QbtcpError::Gone(
                "This game is no longer assigned to this room.",
            ));
        }

        self.sweep_expired();
        let now = Instant::now();
        let mut opened_event = None;
        let mut runtime = self.lock_runtime()?;
        let existing_session_id = runtime
            .sessions
            .values()
            .find(|session| {
                session.room_id == room_id
                    && session.match_id == match_id
                    && session.status != SessionStatus::Abandoned
            })
            .map(|session| session.session_id.clone());

        let session_id = if let Some(session_id) = existing_session_id {
            session_id
        } else {
            let session_id = random_id("sess");
            let token = random_secret();
            let token_hash = digest_secret(&token);
            let record = SessionRecord {
                session_id: session_id.clone(),
                room_id: room_id.clone(),
                match_id: match_id.to_owned(),
                round_number: assignment.round_number,
                left_team: assignment.left_team.clone(),
                right_team: assignment.right_team.clone(),
                round_revision: assignment.meta.round_revision,
                assignment_revision: assignment.meta.assignment_revision,
                status: SessionStatus::Open,
                updated_at: now_iso(),
                last_activity: now,
                expires_at: Some(now + self.config.session_idle_timeout),
                credentials_by_device: HashMap::from([(device_key.clone(), token_hash)]),
                writer_token: Some(token_hash),
                writer_device: Some(device_key.clone()),
                latest_progress: None,
                latest_qbj: None,
                final_fingerprint: None,
                final_result_id: None,
                roster_amendments: Vec::new(),
            };
            runtime.session_tokens.insert(
                token_hash,
                SessionCredential {
                    token,
                    session_id: session_id.clone(),
                    device_id: device_key.clone(),
                },
            );
            runtime.sessions.insert(session_id.clone(), record);
            opened_event = Some(SessionEvent::Opened {
                session_id: session_id.clone(),
                room_id: room_id.clone(),
                match_id: match_id.to_owned(),
            });
            session_id
        };

        let existing_token_hash = runtime
            .sessions
            .get(&session_id)
            .and_then(|session| session.credentials_by_device.get(&device_key).copied());
        let (token, writer) = if let Some(token_hash) = existing_token_hash {
            let credential = runtime
                .session_tokens
                .get(&token_hash)
                .ok_or(QbtcpError::Unauthorized)?;
            (
                credential.token.clone(),
                runtime
                    .sessions
                    .get(&session_id)
                    .and_then(|session| session.writer_token)
                    == Some(token_hash),
            )
        } else {
            let token = random_secret();
            let token_hash = digest_secret(&token);
            runtime.session_tokens.insert(
                token_hash,
                SessionCredential {
                    token: token.clone(),
                    session_id: session_id.clone(),
                    device_id: device_key.clone(),
                },
            );
            let session = runtime
                .sessions
                .get_mut(&session_id)
                .ok_or(QbtcpError::NotFound("The session is not available."))?;
            session.credentials_by_device.insert(device_key, token_hash);
            (token, session.writer_token == Some(token_hash))
        };
        drop(runtime);
        if let Some(event) = opened_event {
            let _ = self.state.record_session_event(event);
        }
        Ok(OpenSessionResponse {
            session_id,
            token,
            writer,
        })
    }

    pub fn take_writer(
        &self,
        session_id: &str,
        session_token: Option<&str>,
        device_id: Option<&str>,
        take_over: bool,
    ) -> Result<OpenSessionResponse, QbtcpError> {
        self.require_capability("assignment")?;
        if !take_over {
            return Err(QbtcpError::BadRequest(
                "A writer takeover must be explicit.",
            ));
        }
        let device_key = normalize_identity(device_id)?;
        let auth = self.authenticate_session(session_id, session_token)?;
        let mut runtime = self.lock_runtime()?;
        let (session_id, status) = {
            let session = runtime
                .sessions
                .get_mut(&auth.session_id)
                .ok_or(QbtcpError::Unauthorized)?;
            if session.status != SessionStatus::Open {
                return Err(QbtcpError::Conflict {
                    message: "This session is no longer accepting a writer.",
                    writer_device: None,
                    can_take_over: false,
                });
            }
            session.writer_token = Some(auth.token_hash);
            session.writer_device = Some(device_key.clone());
            session.updated_at = now_iso();
            session.last_activity = Instant::now();
            session.expires_at = Some(session.last_activity + self.config.session_idle_timeout);
            (session.session_id.clone(), session.status)
        };
        let credential = runtime
            .session_tokens
            .get_mut(&auth.token_hash)
            .ok_or(QbtcpError::Unauthorized)?;
        credential.device_id = device_key;
        let token = credential.token.clone();
        drop(runtime);
        let _ = self.state.record_session_event(SessionEvent::WriterTaken {
            session_id: session_id.clone(),
        });
        Ok(OpenSessionResponse {
            session_id,
            token,
            writer: status == SessionStatus::Open,
        })
    }

    pub fn session(
        &self,
        session_id: &str,
        session_token: Option<&str>,
    ) -> Result<SessionDocument, QbtcpError> {
        let auth = self.authenticate_session(session_id, session_token)?;
        let runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get(&auth.session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        Ok(SessionDocument {
            session_id: session.session_id.clone(),
            match_id: session.match_id.clone(),
            status: session.status,
            writer: session.writer_token == Some(auth.token_hash),
            progress_sequence: session
                .latest_progress
                .as_ref()
                .map(|progress| progress.sequence),
            result_received: session.final_result_id.is_some(),
            updated_at: session.updated_at.clone(),
        })
    }

    pub fn presence(&self, room_token: Option<&str>) -> Result<Option<PresenceView>, QbtcpError> {
        self.require_capability("presence")?;
        let room_id = self.authenticate_room(room_token)?;
        let runtime = self.lock_runtime()?;
        Ok(runtime
            .presences
            .values()
            .filter(|presence| presence.view.room_id == room_id)
            .max_by_key(|presence| presence.observed_at)
            .map(|presence| presence.view.clone()))
    }

    pub fn update_presence(
        &self,
        room_token: Option<&str>,
        device_id: Option<&str>,
        operator_name: Option<&str>,
        update: PresenceUpdate,
    ) -> Result<PresenceView, QbtcpError> {
        self.require_capability("presence")?;
        let room_id = self.authenticate_room(room_token)?;
        let room = self
            .room_info(&room_id)?
            .ok_or(QbtcpError::NotFound("The room is no longer available."))?;
        let device_id = normalize_identity(device_id)?;
        let operator_name = normalize_optional_identity(operator_name)?;
        let update = sanitize_presence(update)?;
        let view = PresenceView {
            room_id: room.id.clone(),
            room_name: room.name,
            device_id: display_identity(&device_id),
            operator_name,
            ready: update.ready,
            client: update.client.clone(),
            procedure_versions: update.procedure_versions.clone(),
            qbj_version: update.qbj_version.clone(),
            updated_at: now_iso(),
        };
        let record = PresenceRecord {
            room_id: room.id,
            room_name: view.room_name.clone(),
            device_id: display_identity(&device_id),
            operator_name: view.operator_name.clone(),
            update,
            observed_at: view.updated_at.clone(),
        };
        self.state
            .record_presence(record)
            .map_err(|_| QbtcpError::Internal)?;
        let mut runtime = self.lock_runtime()?;
        runtime.presences.insert(
            (room_id, device_id),
            PresenceRecordInternal {
                view: view.clone(),
                observed_at: Instant::now(),
            },
        );
        Ok(view)
    }

    pub fn progress(
        &self,
        session_id: &str,
        session_token: Option<&str>,
        sequence: u64,
        match_state: Value,
    ) -> Result<ProgressResponse, QbtcpError> {
        self.require_capability("progress")?;
        if !match_state.is_object() || !validate_json_tree(&match_state, 0) {
            return Err(QbtcpError::BadRequest(
                "The progress snapshot is not a valid JSON Match.",
            ));
        }
        let auth = self.authenticate_session(session_id, session_token)?;
        let now = Instant::now();
        let mut runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get_mut(&auth.session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        if session.status != SessionStatus::Open {
            return Err(QbtcpError::Conflict {
                message: "This session is not accepting progress.",
                writer_device: None,
                can_take_over: false,
            });
        }
        if session.writer_token != Some(auth.token_hash) {
            return Err(writer_conflict());
        }
        let accepted = session
            .latest_progress
            .as_ref()
            .map_or(true, |latest| sequence > latest.sequence);
        if accepted {
            let record = ProgressRecord {
                session_id: session.session_id.clone(),
                room_id: session.room_id.clone(),
                sequence,
                match_state: match_state.clone(),
                received_at: now_iso(),
            };
            self.state
                .record_progress(record)
                .map_err(|_| QbtcpError::Internal)?;
            session.latest_progress = Some(ProgressSnapshot { sequence });
            session.latest_qbj = Some(match_state);
            session.updated_at = now_iso();
            session.last_activity = now;
            session.expires_at = Some(now + self.config.session_idle_timeout);
        }
        Ok(ProgressResponse { accepted, sequence })
    }

    pub fn result(
        &self,
        session_id: &str,
        session_token: Option<&str>,
        qbj: Value,
        raw: Vec<u8>,
    ) -> Result<ResultReceipt, QbtcpError> {
        self.require_capability("result")?;
        if !is_qbj_like(&qbj) || !validate_json_tree(&qbj, 0) {
            return Err(QbtcpError::BadRequest(
                "The result is not a valid QBJ document.",
            ));
        }
        let auth = self.authenticate_session(session_id, session_token)?;
        let fingerprint = result_fingerprint(&qbj);
        let (submitted_tournament_id, submitted_match_id) = qbj_identity(&qbj);
        let submitted_round_revision = qbtcp_round_revision(&qbj);
        let now = Instant::now();
        let expected_tournament_id = self.tournament_info()?.id;

        let mut runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get_mut(&auth.session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        let late_after_abandon = session.status == SessionStatus::Abandoned;
        // A final already received is still allowed through this endpoint: a retry must be
        // idempotent, and a corrected authenticated final must be retained as a review candidate.
        // Only an open session enforces the active writer lock.
        if session.status == SessionStatus::Open && session.writer_token != Some(auth.token_hash) {
            return Err(writer_conflict());
        }
        let submission = ResultSubmission {
            session_id: session.session_id.clone(),
            room_id: session.room_id.clone(),
            expected_tournament_id,
            expected_match_id: session.match_id.clone(),
            expected_round_revision: session.round_revision,
            submitted_tournament_id: submitted_tournament_id.clone(),
            submitted_match_id: submitted_match_id.clone(),
            submitted_round_revision,
            fingerprint: fingerprint.clone(),
            qbj: qbj.clone(),
            raw,
            received_at: now_iso(),
            late_after_abandon,
        };
        let disposition = self
            .state
            .record_result(submission)
            .map_err(|_| QbtcpError::Internal)?;
        if session.status == SessionStatus::Open {
            session.status = SessionStatus::FinalReceived;
            session.writer_token = None;
            session.writer_device = None;
            session.expires_at = None;
        }
        session.latest_qbj = Some(qbj);
        session.final_fingerprint.get_or_insert(fingerprint.clone());
        session
            .final_result_id
            .get_or_insert(disposition.result_id.clone());
        session.updated_at = now_iso();
        session.last_activity = now;
        let event = SessionEvent::ResultRetained {
            session_id: session.session_id.clone(),
            result_id: disposition.result_id.clone(),
            review_required: disposition.review_required,
        };
        drop(runtime);
        let _ = self.state.record_session_event(event);

        Ok(ResultReceipt {
            accepted: true,
            received: true,
            review_required: disposition.review_required,
            duplicate: disposition.duplicate,
            match_id: submitted_match_id,
            fingerprint,
            warnings: disposition.warnings,
            conflict: disposition.conflict,
            result_id: disposition.result_id,
            conflict_with: disposition.conflict_with,
        })
    }

    pub fn recovery(
        &self,
        session_id: &str,
        session_token: Option<&str>,
    ) -> Result<RecoveryDocument, QbtcpError> {
        self.require_capability("recovery")?;
        let auth = self.authenticate_session(session_id, session_token)?;
        let runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get(&auth.session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        Ok(RecoveryDocument {
            session_id: session.session_id.clone(),
            round_number: session.round_number,
            left_team: session.left_team.clone().unwrap_or_default(),
            right_team: session.right_team.clone().unwrap_or_default(),
            status: session.status,
            round_revision: session.round_revision,
            assignment_revision: session.assignment_revision,
            final_received: session.final_result_id.is_some(),
            latest_qbj: session.latest_qbj.clone(),
            roster_amendments: session.roster_amendments.clone(),
        })
    }

    pub fn add_roster_player(
        &self,
        room_token: Option<&str>,
        session_id: &str,
        session_token: Option<&str>,
        request: RosterAmendmentRequest,
    ) -> Result<RosterAmendment, QbtcpError> {
        self.require_capability("roster")?;
        let room_id = self.authenticate_room(room_token)?;
        if request.session_id != session_id {
            return Err(QbtcpError::BadRequest(
                "The roster amendment names a different session.",
            ));
        }
        let auth = self.authenticate_session(session_id, session_token)?;
        let mut runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get_mut(&auth.session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        if session.room_id != room_id {
            return Err(QbtcpError::Unauthorized);
        }
        if session.status != SessionStatus::Open {
            return Err(QbtcpError::Conflict {
                message: "This session is no longer accepting roster changes.",
                writer_device: None,
                can_take_over: false,
            });
        }
        let amendment = self
            .state
            .add_roster_amendment(request)
            .map_err(|_| QbtcpError::Internal)?;
        if !session
            .roster_amendments
            .iter()
            .any(|existing| existing == &amendment)
        {
            session.roster_amendments.push(amendment.clone());
        }
        session.updated_at = now_iso();
        Ok(amendment)
    }

    pub fn help(
        &self,
        room_token: Option<&str>,
        device_id: Option<&str>,
    ) -> Result<Option<HelpRequest>, QbtcpError> {
        self.require_capability("help")?;
        let room_id = self.authenticate_room(room_token)?;
        let device_key = normalize_identity(device_id)?;
        let runtime = self.lock_runtime()?;
        Ok(runtime
            .helps
            .get(&(room_id, device_key))
            .filter(|record| record.request.status == HelpStatus::Open)
            .map(|record| record.request.clone()))
    }

    pub fn request_help(
        &self,
        room_token: Option<&str>,
        device_id: Option<&str>,
        operator_name: Option<&str>,
        category: String,
        message: String,
    ) -> Result<HelpRequest, QbtcpError> {
        self.require_capability("help")?;
        let room_id = self.authenticate_room(room_token)?;
        if !valid_help_category(&category) {
            return Err(QbtcpError::BadRequest(
                "That help category is not supported.",
            ));
        }
        if message.chars().count() > 500 {
            return Err(QbtcpError::BadRequest("The help message is too long."));
        }
        let device_key = normalize_identity(device_id)?;
        let operator_name = normalize_optional_identity(operator_name)?;
        let room = self
            .room_info(&room_id)?
            .ok_or(QbtcpError::NotFound("The room is no longer available."))?;
        let mut runtime = self.lock_runtime()?;
        let key = (room_id.clone(), device_key.clone());
        if let Some(existing) = runtime
            .helps
            .get(&key)
            .filter(|record| record.request.status == HelpStatus::Open)
        {
            return Ok(existing.request.clone());
        }
        let current_matchup = match self.assignment_state(&room_id) {
            Ok(AssignmentState::Assigned(assignment)) => Some(CurrentMatchup {
                round_number: assignment.round_number,
                round_name: assignment.round_name,
                left_team: assignment.left_team,
                right_team: assignment.right_team,
            }),
            _ => None,
        };
        let timestamp = now_iso();
        let request = HelpRequest {
            id: random_id("help"),
            room_id: room.id.clone(),
            room_name: room.name,
            category,
            message: clean_advisory(&message, 500).unwrap_or_default(),
            status: HelpStatus::Open,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            device_id: display_identity(&device_key),
            operator_name,
            current_matchup,
        };
        runtime.helps.insert(
            key,
            HelpRecordInternal {
                request: request.clone(),
            },
        );
        drop(runtime);
        let _ = self
            .state
            .record_help_event(HelpEvent::Opened(request.clone()));
        Ok(request)
    }

    pub fn cancel_help(
        &self,
        room_token: Option<&str>,
        device_id: Option<&str>,
        help_id: &str,
    ) -> Result<HelpRequest, QbtcpError> {
        self.require_capability("help")?;
        let room_id = self.authenticate_room(room_token)?;
        let device_key = normalize_identity(device_id)?;
        let mut runtime = self.lock_runtime()?;
        let record = runtime
            .helps
            .get_mut(&(room_id, device_key))
            .ok_or(QbtcpError::NotFound("The help request is no longer open."))?;
        if record.request.id != help_id || record.request.status != HelpStatus::Open {
            return Err(QbtcpError::NotFound("The help request is no longer open."));
        }
        record.request.status = HelpStatus::Cancelled;
        record.request.updated_at = now_iso();
        let request = record.request.clone();
        drop(runtime);
        let _ = self
            .state
            .record_help_event(HelpEvent::Cancelled(request.clone()));
        Ok(request)
    }

    /// Explicit native-host lifecycle action. It preserves progress/results and only revokes the
    /// writer, so a later final is retained as `late-after-abandon` rather than reopening the game.
    pub fn abandon_session(&self, session_id: &str) -> Result<(), QbtcpError> {
        self.sweep_expired();
        let mut runtime = self.lock_runtime()?;
        let session = runtime
            .sessions
            .get_mut(session_id)
            .ok_or(QbtcpError::NotFound("The session is not available."))?;
        if session.status == SessionStatus::Open {
            session.status = SessionStatus::Abandoned;
            session.writer_token = None;
            session.writer_device = None;
            session.expires_at = None;
            session.updated_at = now_iso();
            let room_id = session.room_id.clone();
            drop(runtime);
            let _ = self.state.record_session_event(SessionEvent::Expired {
                session_id: session_id.to_owned(),
                room_id,
            });
        }
        Ok(())
    }

    fn tournament_info(&self) -> Result<TournamentInfo, QbtcpError> {
        self.state.tournament().map_err(|_| QbtcpError::Internal)
    }

    fn room_info(&self, room_id: &str) -> Result<Option<RoomInfo>, QbtcpError> {
        self.state
            .rooms()
            .map_err(|_| QbtcpError::Internal)
            .map(|rooms| rooms.into_iter().find(|room| room.id == room_id))
    }

    fn assignment_state(&self, room_id: &str) -> Result<AssignmentState, QbtcpError> {
        self.state
            .assignment(room_id)
            .map_err(|_| QbtcpError::NotFound("The room is not available."))
    }

    fn require_capability(&self, capability: &str) -> Result<(), QbtcpError> {
        if self.config.supports(capability) {
            Ok(())
        } else {
            Err(QbtcpError::NotSupported)
        }
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, RuntimeState>, QbtcpError> {
        self.runtime.lock().map_err(|_| QbtcpError::Internal)
    }

    fn authenticate_room(&self, token: Option<&str>) -> Result<String, QbtcpError> {
        let token = token
            .filter(|token| !token.is_empty())
            .ok_or(QbtcpError::Unauthorized)?;
        let token_hash = digest_secret(token);
        let room_id = self
            .lock_runtime()?
            .room_tokens
            .get(&token_hash)
            .map(|record| record.room_id.clone())
            .ok_or(QbtcpError::Unauthorized)?;
        let room = self.room_info(&room_id)?;
        match room {
            Some(room) if room.enabled => Ok(room_id),
            _ => Err(QbtcpError::Unauthorized),
        }
    }

    fn authenticate_session(
        &self,
        session_id: &str,
        token: Option<&str>,
    ) -> Result<SessionAuth, QbtcpError> {
        self.sweep_expired();
        let token = token
            .filter(|token| !token.is_empty())
            .ok_or(QbtcpError::Unauthorized)?;
        let token_hash = digest_secret(token);
        let runtime = self.lock_runtime()?;
        let credential = runtime
            .session_tokens
            .get(&token_hash)
            .filter(|credential| credential.session_id == session_id)
            .ok_or(QbtcpError::Unauthorized)?;
        Ok(SessionAuth {
            token_hash,
            session_id: credential.session_id.clone(),
        })
    }

    fn session_status_for(&self, room_id: &str, match_id: &str) -> Option<SessionStatusView> {
        self.runtime.lock().ok().and_then(|runtime| {
            runtime
                .sessions
                .values()
                .find(|session| session.room_id == room_id && session.match_id == match_id)
                .map(|session| SessionStatusView {
                    session_id: session.session_id.clone(),
                    status: session.status,
                    resumable: session.status == SessionStatus::Open,
                    final_received: Some(session.final_result_id.is_some()),
                })
        })
    }

    fn sweep_expired(&self) {
        let now = Instant::now();
        let mut expired = Vec::new();
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.pairings.retain(|_, ticket| ticket.expires_at > now);
            for session in runtime.sessions.values_mut() {
                if session.status == SessionStatus::Open
                    && session
                        .expires_at
                        .is_some_and(|expires_at| expires_at <= now)
                {
                    session.status = SessionStatus::Abandoned;
                    session.writer_token = None;
                    session.writer_device = None;
                    session.expires_at = None;
                    session.updated_at = now_iso();
                    expired.push(SessionEvent::Expired {
                        session_id: session.session_id.clone(),
                        room_id: session.room_id.clone(),
                    });
                }
            }
            runtime.pair_attempts.retain(|_, attempts| {
                attempts
                    .retain(|at| now.duration_since(*at) < self.config.pairing_rate_limit.window);
                !attempts.is_empty()
            });
        }
        for event in expired {
            let _ = self.state.record_session_event(event);
        }
    }
}

fn writer_conflict() -> QbtcpError {
    QbtcpError::Conflict {
        message: "Another device is scoring this game.",
        writer_device: Some("another device"),
        can_take_over: true,
    }
}

fn normalize_identity(value: Option<&str>) -> Result<String, QbtcpError> {
    let Some(value) = value else {
        return Ok("anonymous".to_owned());
    };
    if value.chars().count() > 200 {
        return Err(QbtcpError::BadRequest("The device identity is too long."));
    }
    Ok(clean_advisory(value, 200).unwrap_or_else(|| "anonymous".to_owned()))
}

fn normalize_optional_identity(value: Option<&str>) -> Result<Option<String>, QbtcpError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().count() > 200 {
        return Err(QbtcpError::BadRequest("The operator name is too long."));
    }
    Ok(clean_advisory(value, 200))
}

fn display_identity(value: &str) -> String {
    if value == "anonymous" {
        "anonymous".to_owned()
    } else {
        value.to_owned()
    }
}
