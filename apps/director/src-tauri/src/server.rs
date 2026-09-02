use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use qbtcp_server::{
    AssignedAssignment, AssignmentMeta, AssignmentState, MemoryState, PresenceRecord,
    ProgressRecord, QbtcpConfig, QbtcpServer, QbtcpState, ResultDisposition, ResultSubmission,
    RoomInfo, RosterAmendment, RosterAmendmentRequest, SessionEvent, StateError, TournamentInfo,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::net::TcpListener;

pub const DEFAULT_QBTCP_PORT: u16 = 8787;
const SCORE_SHEET_URL: &str = "https://qbsheet.com/";

const ALLOWED_SCORE_SHEET_ORIGINS: &[&str] = &[
    "https://qbsheet.com",
    "https://www.qbsheet.com",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("QBTCP server is already running")]
    AlreadyRunning,
    #[error("could not bind the QBTCP listener: {0}")]
    Bind(#[source] std::io::Error),
    #[error("could not configure the QBTCP server: {0}")]
    Config(#[source] qbtcp_server::ConfigError),
    #[error("could not create a QBTCP pairing invitation: {0}")]
    Pairing(String),
    #[error("QBTCP server state is unavailable")]
    Unavailable,
    #[error("QBTCP server is not running")]
    NotRunning,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomPairingInvitation {
    pub room_id: String,
    pub room_name: String,
    pub pairing_code: String,
    pub pairing_url: Option<String>,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub paired_rooms: usize,
    pub pairing_invitations: Vec<RoomPairingInvitation>,
    /// Backward-compatible fields. They are populated only when exactly one room has an
    /// invitation; a multi-room server never exposes an ambiguous global code or URL.
    pub pairing_code: Option<String>,
    pub pairing_url: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerResultSnapshot {
    pub id: String,
    pub session_id: String,
    pub tournament_id: Option<String>,
    pub match_id: Option<String>,
    pub scheduled_game_id: Option<String>,
    pub fingerprint: String,
    pub review_required: bool,
    pub warnings: Vec<String>,
    pub conflict_with: Option<String>,
    pub qbj: Option<Value>,
    /// The exact request body, retained separately from the parsed QBJ for audit/reconciliation.
    pub raw_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProgressSnapshot {
    pub session_id: String,
    pub room_id: String,
    pub sequence: u64,
    pub match_state: Value,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPresenceSnapshot {
    pub room_id: String,
    pub room_name: String,
    pub device_id: String,
    pub operator_name: Option<String>,
    pub update: qbtcp_server::PresenceUpdate,
    pub observed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSessionSnapshot {
    pub session_id: String,
    pub room_id: String,
    pub match_id: Option<String>,
    pub device_id: Option<String>,
    pub operator_name: Option<String>,
    pub status: qbtcp_server::SessionStatus,
    pub resumable: bool,
    pub result_received: bool,
    pub progress_sequence: Option<u64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRosterAmendmentSnapshot {
    pub session_id: String,
    pub amendment: RosterAmendment,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSnapshot {
    pub results: Vec<ServerResultSnapshot>,
    pub progress: Vec<ServerProgressSnapshot>,
    pub presence: Vec<ServerPresenceSnapshot>,
    pub sessions: Vec<ServerSessionSnapshot>,
    pub help: Vec<qbtcp_server::HelpRequest>,
    pub roster_amendments: Vec<ServerRosterAmendmentSnapshot>,
}

#[derive(Default)]
struct ServerRuntimeState {
    status: ServerStatus,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    server: Option<Arc<QbtcpServer>>,
    state: Option<Arc<DirectorQbtcpState>>,
    running: Option<Arc<AtomicBool>>,
}

/// Owns the native listener and protocol runtime for the Director process.
///
/// The server is deliberately kept separate from the Tauri command layer. Commands only expose
/// lifecycle/status operations; QBTCP request authentication and protocol handling remain in the
/// shared `qbtcp-server` crate.
pub struct ServerRuntime {
    inner: Mutex<ServerRuntimeState>,
}

impl Default for ServerRuntime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ServerRuntimeState::default()),
        }
    }
}

impl ServerRuntime {
    pub fn status(&self) -> ServerStatus {
        let server = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.server.clone());
        if let Some(server) = server {
            server.refresh();
        }
        let Ok(inner) = self.inner.lock() else {
            return ServerStatus {
                message: Some("QBTCP server status is unavailable.".to_owned()),
                ..ServerStatus::default()
            };
        };
        let mut status = inner.status.clone();
        if let Some(running) = inner.running.as_ref() {
            status.running = running.load(Ordering::Acquire);
        }
        if let Some(state) = inner.state.as_ref() {
            status.paired_rooms = state.paired_room_count();
            let enabled_room_ids = state.enabled_room_ids();
            status
                .pairing_invitations
                .retain(|invitation| enabled_room_ids.contains(&invitation.room_id));
            let (pairing_code, pairing_url) = legacy_pairing_fields(&status.pairing_invitations);
            status.pairing_code = pairing_code;
            status.pairing_url = pairing_url;
        }
        status
    }

    pub async fn start_with_store(
        &self,
        document: Option<Value>,
        store: Arc<crate::store::DirectorStore>,
    ) -> Result<ServerStatus, ServerError> {
        self.start_on_port_with_store(document, DEFAULT_QBTCP_PORT, Some(store))
            .await
    }

    #[cfg(test)]
    async fn start_on_port(
        &self,
        document: Option<Value>,
        requested_port: u16,
    ) -> Result<ServerStatus, ServerError> {
        self.start_on_port_with_store(document, requested_port, None)
            .await
    }

    async fn start_on_port_with_store(
        &self,
        document: Option<Value>,
        requested_port: u16,
        store: Option<Arc<crate::store::DirectorStore>>,
    ) -> Result<ServerStatus, ServerError> {
        if self.status().running {
            let mut status = self.status();
            status.message = Some("QBTCP server is already running.".to_owned());
            return Ok(status);
        }

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, requested_port))
            .await
            .map_err(ServerError::Bind)?;
        let port = listener.local_addr().map_err(ServerError::Bind)?.port();
        let state = Arc::new(match store {
            Some(store) => DirectorQbtcpState::from_document_with_store(document.as_ref(), store),
            None => DirectorQbtcpState::from_document(document.as_ref()),
        });
        let config = QbtcpConfig {
            name: state.tournament_name(),
            allowed_origins: ALLOWED_SCORE_SHEET_ORIGINS
                .iter()
                .map(|origin| (*origin).to_owned())
                .collect(),
            ..QbtcpConfig::default()
        };
        let server =
            Arc::new(QbtcpServer::new(Arc::clone(&state), config).map_err(ServerError::Config)?);

        let address = detect_lan_address();
        let pairing_invitations = state
            .enabled_rooms()
            .into_iter()
            .map(|room| {
                server
                    .issue_pairing(&room.id)
                    .map(|invitation| pairing_invitation(address.as_deref(), port, invitation))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| ServerError::Pairing(format!("{error:?}")))?;
        let (pairing_code, pairing_url) = legacy_pairing_fields(&pairing_invitations);

        let running = Arc::new(AtomicBool::new(true));
        let task_running = Arc::clone(&running);
        let task_server = Arc::clone(&server);
        let task = tauri::async_runtime::spawn(async move {
            let _ = task_server.serve(listener).await;
            task_running.store(false, Ordering::Release);
        });

        let mut inner = self.inner.lock().map_err(|_| ServerError::Unavailable)?;
        if inner
            .running
            .as_ref()
            .is_some_and(|current| current.load(Ordering::Acquire))
        {
            task.abort();
            return Err(ServerError::AlreadyRunning);
        }

        inner.status = ServerStatus {
            running: true,
            address: address.clone(),
            port: Some(port),
            protocol: Some("QBTCP v1".to_owned()),
            paired_rooms: state.paired_room_count(),
            pairing_invitations,
            pairing_code,
            pairing_url,
            message: Some(match address {
                Some(_) => "QBTCP server started.".to_owned(),
                None => "QBTCP server started, but no non-loopback LAN address was found; pairing links are unavailable.".to_owned(),
            }),
        };
        inner.task = Some(task);
        inner.server = Some(server);
        inner.state = Some(state);
        inner.running = Some(running);
        Ok(inner.status.clone())
    }

    pub fn stop(&self) -> ServerStatus {
        let task = self.inner.lock().ok().and_then(|mut inner| {
            let task = inner.task.take();
            inner.server = None;
            inner.state = None;
            if let Some(running) = inner.running.take() {
                running.store(false, Ordering::Release);
            }
            inner.status = ServerStatus {
                message: Some("QBTCP server stopped.".to_owned()),
                ..ServerStatus::default()
            };
            task
        });
        if let Some(task) = task {
            task.abort();
        }
        self.status()
    }

    pub fn refresh_state(&self, document: Option<&Value>) {
        let Some((server, state)) = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| Some((inner.server.clone()?, inner.state.clone()?)))
        else {
            return;
        };
        state.refresh_from_document(document);
        server.refresh();
        if let Ok(mut inner) = self.inner.lock() {
            let enabled_room_ids = state.enabled_room_ids();
            inner
                .status
                .pairing_invitations
                .retain(|invitation| enabled_room_ids.contains(&invitation.room_id));
            let (pairing_code, pairing_url) =
                legacy_pairing_fields(&inner.status.pairing_invitations);
            inner.status.pairing_code = pairing_code;
            inner.status.pairing_url = pairing_url;
        }
    }

    pub fn issue_pairing(&self, room_id: &str) -> Result<RoomPairingInvitation, ServerError> {
        let (server, address, port) = {
            let inner = self.inner.lock().map_err(|_| ServerError::Unavailable)?;
            let server = inner.server.clone().ok_or(ServerError::NotRunning)?;
            let address = inner.status.address.clone();
            let port = inner.status.port.ok_or(ServerError::Unavailable)?;
            (server, address, port)
        };
        let invitation = server
            .issue_pairing(room_id)
            .map_err(|error| ServerError::Pairing(format!("{error:?}")))?;
        let invitation = pairing_invitation(address.as_deref(), port, invitation);
        let mut inner = self.inner.lock().map_err(|_| ServerError::Unavailable)?;
        inner
            .status
            .pairing_invitations
            .retain(|existing| existing.room_id != invitation.room_id);
        inner.status.pairing_invitations.push(invitation.clone());
        inner
            .status
            .pairing_invitations
            .sort_by(|left, right| left.room_id.cmp(&right.room_id));
        let (pairing_code, pairing_url) = legacy_pairing_fields(&inner.status.pairing_invitations);
        inner.status.pairing_code = pairing_code;
        inner.status.pairing_url = pairing_url;
        Ok(invitation)
    }

    pub fn snapshot(&self) -> Result<ServerSnapshot, ServerError> {
        let inner = self.inner.lock().map_err(|_| ServerError::Unavailable)?;
        inner
            .state
            .as_ref()
            .ok_or(ServerError::Unavailable)
            .and_then(|state| state.snapshot())
    }
}

impl Drop for ServerRuntime {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(task) = inner.task.take() {
                task.abort();
            }
            if let Some(running) = inner.running.take() {
                running.store(false, Ordering::Release);
            }
        }
    }
}

/// A live QBTCP view over the document saved by the Director React application.
///
/// Protocol operations are delegated to the shared reference state implementation for its
/// authentication, conflict, recovery, and validation semantics. The document is refreshed when
/// React saves so room pairing never depends on a stale startup snapshot.
pub struct DirectorQbtcpState {
    memory: MemoryState,
    qbtcp_store: Option<Arc<crate::store::DirectorStore>>,
    tournament: RwLock<TournamentInfo>,
    room_states: Mutex<HashMap<String, bool>>,
    assignment_keys: Mutex<HashMap<String, String>>,
    session_rooms: Mutex<HashMap<String, String>>,
    paired_rooms: Mutex<HashSet<String>>,
    progress: Mutex<HashMap<String, ProgressRecord>>,
    presence: Mutex<HashMap<(String, String), PresenceRecord>>,
    session_snapshots: Mutex<HashMap<String, ServerSessionSnapshot>>,
}

impl DirectorQbtcpState {
    pub fn from_document(document: Option<&Value>) -> Self {
        Self::from_document_inner(document, None)
    }

    pub fn from_document_with_store(
        document: Option<&Value>,
        store: Arc<crate::store::DirectorStore>,
    ) -> Self {
        Self::from_document_inner(document, Some(store))
    }

    fn from_document_inner(
        document: Option<&Value>,
        qbtcp_store: Option<Arc<crate::store::DirectorStore>>,
    ) -> Self {
        let tournament = tournament_from_document(document);
        let rooms = rooms_from_document(document);
        let assignments = assignments_from_document(document);
        let room_states = rooms
            .iter()
            .map(|room| (room.id.clone(), room.enabled))
            .collect();
        let assignment_keys = assignments
            .iter()
            .map(|(room_id, assignment)| (room_id.clone(), assignment_key(assignment)))
            .collect();
        let memory = MemoryState::new(tournament.clone(), rooms);
        for (room_id, assignment) in assignments {
            memory.set_assignment(room_id, AssignmentState::Assigned(assignment));
        }
        let state = Self {
            memory,
            qbtcp_store,
            tournament: RwLock::new(tournament),
            room_states: Mutex::new(room_states),
            assignment_keys: Mutex::new(assignment_keys),
            session_rooms: Mutex::new(HashMap::new()),
            paired_rooms: Mutex::new(HashSet::new()),
            progress: Mutex::new(HashMap::new()),
            presence: Mutex::new(HashMap::new()),
            session_snapshots: Mutex::new(HashMap::new()),
        };
        state.restore_qbtcp_results();
        state
    }

    fn restore_qbtcp_results(&self) {
        let Some(store) = self.qbtcp_store.as_ref() else {
            return;
        };
        let tournament_id = self
            .tournament
            .read()
            .map(|tournament| tournament.id.clone())
            .unwrap_or_else(|_| "director".to_owned());
        let results = match store.load_qbtcp_results(&tournament_id) {
            Ok(results) => results,
            Err(error) => {
                eprintln!("QBTCP retained results could not be restored: {error}");
                return;
            }
        };
        for result in results {
            let session_id = result.session_id.clone();
            self.memory
                .restore_result(qbtcp_server::MemoryRetainedResult {
                    id: result.id.clone(),
                    session_id: session_id.clone(),
                    tournament_id: Some(result.tournament_id.clone()),
                    match_id: result.match_id.clone(),
                    fingerprint: result.fingerprint.clone(),
                    raw: result.raw.clone(),
                    qbj: result.qbj.clone(),
                    review_required: result.review_required,
                    warnings: result.warnings.clone(),
                    conflict_with: result.conflict_with,
                });
            if let Ok(mut sessions) = self.session_snapshots.lock() {
                sessions
                    .entry(session_id.clone())
                    .or_insert(ServerSessionSnapshot {
                        session_id,
                        room_id: result.room_id,
                        match_id: result.match_id,
                        device_id: None,
                        operator_name: None,
                        status: qbtcp_server::SessionStatus::FinalReceived,
                        resumable: false,
                        result_received: true,
                        progress_sequence: None,
                        updated_at: result.received_at,
                    });
            }
        }
    }

    pub fn refresh_from_document(&self, document: Option<&Value>) {
        let tournament = tournament_from_document(document);
        if let Ok(mut current) = self.tournament.write() {
            *current = tournament;
        }

        let rooms = rooms_from_document(document);
        let assignments = assignments_from_document(document);
        let next_room_states: HashMap<String, bool> = rooms
            .iter()
            .map(|room| (room.id.clone(), room.enabled))
            .collect();
        let next_assignment_keys: HashMap<String, String> = assignments
            .iter()
            .map(|(room_id, assignment)| (room_id.clone(), assignment_key(assignment)))
            .collect();

        let previous_room_states = self
            .room_states
            .lock()
            .map(|states| states.clone())
            .unwrap_or_default();
        let previous_assignment_keys = self
            .assignment_keys
            .lock()
            .map(|keys| keys.clone())
            .unwrap_or_default();
        // A disabled/removed room loses all volatile tracking and terminal snapshots. A room
        // receiving a replacement assignment loses only its operational tracking; retained
        // terminal results remain available for Director audit and recovery.
        let mut cleanup_rooms = HashSet::new();
        let mut assignment_changed_rooms = HashSet::new();

        for (room_id, was_enabled) in &previous_room_states {
            if *was_enabled && !next_room_states.get(room_id).copied().unwrap_or(false) {
                cleanup_rooms.insert(room_id.clone());
            }
        }
        for room_id in previous_assignment_keys
            .keys()
            .chain(next_assignment_keys.keys())
        {
            if previous_assignment_keys.get(room_id) != next_assignment_keys.get(room_id) {
                assignment_changed_rooms.insert(room_id.clone());
            }
        }

        let previous_room_ids: HashSet<String> = previous_room_states.keys().cloned().collect();
        let next_room_ids: HashSet<String> = next_room_states.keys().cloned().collect();
        for removed in previous_room_ids.difference(&next_room_ids) {
            self.memory.remove_room(removed);
        }
        for room in &rooms {
            self.memory.set_room(room.clone());
        }

        let previous_assignment_ids: HashSet<String> =
            previous_assignment_keys.keys().cloned().collect();
        let next_assignment_ids: HashSet<String> = next_assignment_keys.keys().cloned().collect();
        for removed in previous_assignment_ids.difference(&next_assignment_ids) {
            self.memory.set_assignment(
                removed.clone(),
                AssignmentState::None(AssignmentMeta::default()),
            );
        }
        for (room_id, assignment) in assignments {
            self.memory
                .set_assignment(room_id, AssignmentState::Assigned(assignment));
        }

        if let Ok(mut states) = self.room_states.lock() {
            *states = next_room_states;
        }
        if let Ok(mut keys) = self.assignment_keys.lock() {
            *keys = next_assignment_keys;
        }
        let tracking_cleanup_rooms = cleanup_rooms
            .union(&assignment_changed_rooms)
            .cloned()
            .collect::<HashSet<_>>();
        let preserve_terminal_snapshots = assignment_changed_rooms
            .difference(&cleanup_rooms)
            .cloned()
            .collect::<HashSet<_>>();
        self.cleanup_room_tracking(&tracking_cleanup_rooms, &preserve_terminal_snapshots);
    }

    fn cleanup_room_tracking(
        &self,
        room_ids: &HashSet<String>,
        preserve_terminal_snapshots: &HashSet<String>,
    ) {
        if room_ids.is_empty() {
            return;
        }
        let progress_ids = self
            .progress
            .lock()
            .map(|mut progress| {
                let ids = progress
                    .values()
                    .filter(|record| room_ids.contains(&record.room_id))
                    .map(|record| record.session_id.clone())
                    .collect::<Vec<_>>();
                progress.retain(|_, record| !room_ids.contains(&record.room_id));
                ids
            })
            .unwrap_or_default();
        if let Ok(mut presence) = self.presence.lock() {
            presence.retain(|(room_id, _), _| !room_ids.contains(room_id));
        }
        if let Ok(mut sessions) = self.session_rooms.lock() {
            sessions.retain(|_, room_id| !room_ids.contains(room_id));
        }
        if let Ok(mut snapshots) = self.session_snapshots.lock() {
            snapshots.retain(|_, snapshot| {
                !room_ids.contains(&snapshot.room_id)
                    || (preserve_terminal_snapshots.contains(&snapshot.room_id)
                        && snapshot.status == qbtcp_server::SessionStatus::FinalReceived)
            });
        }
        if let Ok(mut paired) = self.paired_rooms.lock() {
            paired.retain(|room_id| !room_ids.contains(room_id));
        }
        for room_id in room_ids {
            self.memory.clear_presence(room_id, None);
        }
        for session_id in progress_ids {
            self.memory.clear_progress(&session_id);
        }
    }

    pub fn tournament_name(&self) -> String {
        self.tournament
            .read()
            .map(|value| value.name.clone())
            .unwrap_or_else(|_| "QBSheet Director".to_owned())
    }

    pub fn enabled_rooms(&self) -> Vec<RoomInfo> {
        <MemoryState as QbtcpState>::rooms(&self.memory)
            .unwrap_or_default()
            .into_iter()
            .filter(|room| room.enabled)
            .collect()
    }

    pub fn enabled_room_ids(&self) -> HashSet<String> {
        self.enabled_rooms()
            .into_iter()
            .map(|room| room.id)
            .collect()
    }

    pub fn paired_room_count(&self) -> usize {
        self.paired_rooms
            .lock()
            .map(|rooms| rooms.len())
            .unwrap_or_default()
    }

    pub fn snapshot(&self) -> Result<ServerSnapshot, ServerError> {
        let results = self
            .memory
            .result_summaries()
            .into_iter()
            .map(|summary| {
                let raw = self.memory.raw_result(&summary.id);
                ServerResultSnapshot {
                    id: summary.id,
                    session_id: summary.session_id,
                    tournament_id: summary.tournament_id,
                    match_id: summary.match_id,
                    scheduled_game_id: None,
                    fingerprint: summary.fingerprint,
                    review_required: summary.review_required,
                    warnings: summary.warnings,
                    conflict_with: summary.conflict_with,
                    qbj: raw
                        .as_deref()
                        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok()),
                    raw_base64: raw.map(|bytes| BASE64.encode(bytes)),
                }
            })
            .collect();
        let progress = self
            .progress
            .lock()
            .map_err(|_| ServerError::Unavailable)
            .map(|records| {
                records
                    .values()
                    .cloned()
                    .map(|record| ServerProgressSnapshot {
                        session_id: record.session_id,
                        room_id: record.room_id,
                        sequence: record.sequence,
                        match_state: record.match_state,
                        received_at: record.received_at,
                    })
                    .collect()
            })?;
        let presence = self
            .presence
            .lock()
            .map_err(|_| ServerError::Unavailable)
            .map(|records| {
                records
                    .values()
                    .cloned()
                    .map(|record| ServerPresenceSnapshot {
                        room_id: record.room_id,
                        room_name: record.room_name,
                        device_id: record.device_id,
                        operator_name: record.operator_name,
                        update: record.update,
                        observed_at: record.observed_at,
                    })
                    .collect()
            })?;
        let sessions = self
            .session_snapshots
            .lock()
            .map_err(|_| ServerError::Unavailable)
            .map(|records| {
                let mut values = records.values().cloned().collect::<Vec<_>>();
                values.sort_by(|left, right| left.session_id.cmp(&right.session_id));
                values
            })?;
        let help = latest_help_requests(&self.memory.help_events());
        let roster_amendments = self
            .memory
            .roster_amendments()
            .into_iter()
            .map(|record| ServerRosterAmendmentSnapshot {
                session_id: record.session_id,
                amendment: record.amendment,
            })
            .collect();
        Ok(ServerSnapshot {
            results,
            progress,
            presence,
            sessions,
            help,
            roster_amendments,
        })
    }

    fn recompute_paired_room(&self, room_id: &str) {
        let has_presence = self
            .presence
            .lock()
            .map(|presence| presence.keys().any(|(room, _)| room == room_id))
            .unwrap_or(false);
        let has_session = self
            .session_rooms
            .lock()
            .map(|sessions| sessions.values().any(|room| room == room_id))
            .unwrap_or(false);
        if let Ok(mut paired) = self.paired_rooms.lock() {
            if has_presence || has_session {
                paired.insert(room_id.to_owned());
            } else {
                paired.remove(room_id);
            }
        }
    }
}

impl QbtcpState for DirectorQbtcpState {
    fn tournament(&self) -> Result<TournamentInfo, StateError> {
        self.tournament
            .read()
            .map(|value| value.clone())
            .map_err(|_| StateError::Unavailable)
    }

    fn rooms(&self) -> Result<Vec<RoomInfo>, StateError> {
        <MemoryState as QbtcpState>::rooms(&self.memory)
    }

    fn assignment(&self, room_id: &str) -> Result<AssignmentState, StateError> {
        <MemoryState as QbtcpState>::assignment(&self.memory, room_id)
    }

    fn record_presence(&self, record: PresenceRecord) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_presence(&self.memory, record.clone())?;
        self.presence
            .lock()
            .map_err(|_| StateError::Unavailable)?
            .insert(
                (record.room_id.clone(), record.device_id.clone()),
                record.clone(),
            );
        if let Ok(mut rooms) = self.paired_rooms.lock() {
            rooms.insert(record.room_id.clone());
        }
        if let Ok(mut sessions) = self.session_snapshots.lock() {
            let open_session_ids = sessions
                .values()
                .filter(|session| {
                    session.room_id == record.room_id
                        && session.device_id.is_none()
                        && session.status == qbtcp_server::SessionStatus::Open
                })
                .map(|session| session.session_id.clone())
                .collect::<Vec<_>>();
            if let Some(session_id) = open_session_ids
                .first()
                .filter(|_| open_session_ids.len() == 1)
            {
                if let Some(session) = sessions.get_mut(session_id) {
                    session.device_id = Some(record.device_id);
                    session.operator_name = record.operator_name;
                    session.updated_at = record.observed_at;
                }
            }
        }
        Ok(())
    }

    fn record_progress(&self, record: ProgressRecord) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_progress(&self.memory, record.clone())?;
        let mut progress = self.progress.lock().map_err(|_| StateError::Unavailable)?;
        if progress
            .get(&record.session_id)
            .map_or(true, |current| record.sequence > current.sequence)
        {
            let session_id = record.session_id.clone();
            let room_id = record.room_id.clone();
            let sequence = record.sequence;
            let received_at = record.received_at.clone();
            progress.insert(session_id.clone(), record);
            if let Ok(mut sessions) = self.session_snapshots.lock() {
                let session = sessions
                    .entry(session_id.clone())
                    .or_insert(ServerSessionSnapshot {
                        session_id,
                        room_id,
                        match_id: None,
                        device_id: None,
                        operator_name: None,
                        status: qbtcp_server::SessionStatus::Open,
                        resumable: true,
                        result_received: false,
                        progress_sequence: None,
                        updated_at: received_at.clone(),
                    });
                if session
                    .progress_sequence
                    .map_or(true, |current| sequence > current)
                {
                    session.progress_sequence = Some(sequence);
                    session.updated_at = received_at;
                }
            }
        }
        Ok(())
    }

    fn clear_presence(&self, room_id: &str, device_id: Option<&str>) -> Result<(), StateError> {
        MemoryState::clear_presence(&self.memory, room_id, device_id);
        self.presence
            .lock()
            .map_err(|_| StateError::Unavailable)?
            .retain(|(presence_room, presence_device), _| {
                presence_room != room_id
                    || device_id.is_some_and(|device| device != presence_device)
            });
        self.recompute_paired_room(room_id);
        Ok(())
    }

    fn clear_progress(&self, session_id: &str) -> Result<(), StateError> {
        MemoryState::clear_progress(&self.memory, session_id);
        self.progress
            .lock()
            .map_err(|_| StateError::Unavailable)?
            .remove(session_id);
        Ok(())
    }

    fn record_result(&self, submission: ResultSubmission) -> Result<ResultDisposition, StateError> {
        let snapshot = submission.clone();
        let disposition = <MemoryState as QbtcpState>::record_result(&self.memory, submission)?;
        if let Some(store) = self.qbtcp_store.as_ref() {
            let tournament_id = self
                .tournament
                .read()
                .map(|tournament| tournament.id.clone())
                .map_err(|_| StateError::Unavailable)?;
            store
                .save_qbtcp_result(&tournament_id, &disposition, &snapshot)
                .map_err(|_| StateError::SaveFailed)?;
        }
        Ok(disposition)
    }

    fn add_roster_amendment(
        &self,
        request: RosterAmendmentRequest,
    ) -> Result<RosterAmendment, StateError> {
        <MemoryState as QbtcpState>::add_roster_amendment(&self.memory, request)
    }

    fn record_session_event(&self, event: SessionEvent) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_session_event(&self.memory, event.clone())?;
        let now = qbtcp_server::now_iso();
        let opened_presence = match &event {
            SessionEvent::Opened { room_id, .. } => {
                self.presence.lock().ok().and_then(|presence| {
                    let candidates = presence
                        .values()
                        .filter(|record| record.room_id == *room_id)
                        .collect::<Vec<_>>();
                    (candidates.len() == 1).then(|| {
                        let record = candidates[0];
                        (
                            record.device_id.clone(),
                            record.operator_name.clone(),
                            record.observed_at.clone(),
                        )
                    })
                })
            }
            SessionEvent::Expired { .. }
            | SessionEvent::ResultRetained { .. }
            | SessionEvent::WriterTaken { .. } => None,
        };
        let mut sessions = self
            .session_snapshots
            .lock()
            .map_err(|_| StateError::Unavailable)?;
        let mut clear_progress_session_id = None;
        let mut recompute_room_id = None;
        match &event {
            SessionEvent::Opened {
                session_id,
                room_id,
                match_id,
                ..
            } => {
                sessions.insert(
                    session_id.clone(),
                    ServerSessionSnapshot {
                        session_id: session_id.clone(),
                        room_id: room_id.clone(),
                        match_id: Some(match_id.clone()),
                        device_id: opened_presence.as_ref().map(|presence| presence.0.clone()),
                        operator_name: opened_presence
                            .as_ref()
                            .and_then(|presence| presence.1.clone()),
                        status: qbtcp_server::SessionStatus::Open,
                        resumable: true,
                        result_received: false,
                        progress_sequence: None,
                        updated_at: opened_presence
                            .as_ref()
                            .map(|presence| presence.2.clone())
                            .unwrap_or_else(|| now.clone()),
                    },
                );
                self.session_rooms
                    .lock()
                    .map_err(|_| StateError::Unavailable)?
                    .insert(session_id.clone(), room_id.clone());
                if let Ok(mut rooms) = self.paired_rooms.lock() {
                    rooms.insert(room_id.clone());
                }
            }
            SessionEvent::Expired {
                session_id,
                room_id,
            } => {
                let session = sessions
                    .entry(session_id.clone())
                    .or_insert(ServerSessionSnapshot {
                        session_id: session_id.clone(),
                        room_id: room_id.clone(),
                        match_id: None,
                        device_id: None,
                        operator_name: None,
                        status: qbtcp_server::SessionStatus::Abandoned,
                        resumable: true,
                        result_received: false,
                        progress_sequence: None,
                        updated_at: now.clone(),
                    });
                if !session.result_received {
                    session.status = qbtcp_server::SessionStatus::Abandoned;
                    session.resumable = true;
                    session.updated_at = now.clone();
                }
                self.session_rooms
                    .lock()
                    .map_err(|_| StateError::Unavailable)?
                    .remove(session_id);
                clear_progress_session_id = Some(session_id.clone());
                recompute_room_id = Some(room_id.clone());
            }
            SessionEvent::ResultRetained { session_id, .. } => {
                let session = sessions
                    .entry(session_id.clone())
                    .or_insert(ServerSessionSnapshot {
                        session_id: session_id.clone(),
                        room_id: String::new(),
                        match_id: None,
                        device_id: None,
                        operator_name: None,
                        status: qbtcp_server::SessionStatus::FinalReceived,
                        resumable: false,
                        result_received: true,
                        progress_sequence: None,
                        updated_at: now.clone(),
                    });
                session.status = qbtcp_server::SessionStatus::FinalReceived;
                session.resumable = false;
                session.result_received = true;
                session.updated_at = now.clone();
                let room_id = self
                    .session_rooms
                    .lock()
                    .map_err(|_| StateError::Unavailable)?
                    .remove(session_id);
                clear_progress_session_id = Some(session_id.clone());
                recompute_room_id = room_id;
            }
            SessionEvent::WriterTaken { .. } => {}
        }
        drop(sessions);
        if let Some(session_id) = clear_progress_session_id {
            self.clear_progress(&session_id)?;
        }
        if let Some(room_id) = recompute_room_id {
            self.recompute_paired_room(&room_id);
        }
        Ok(())
    }

    fn record_help_event(&self, event: qbtcp_server::HelpEvent) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_help_event(&self.memory, event)
    }
}

fn assignment_key(assignment: &AssignedAssignment) -> String {
    format!(
        "{}|{:?}|{:?}|{}",
        assignment.match_id,
        assignment.meta.round_revision,
        assignment.meta.assignment_revision,
        qbtcp_server::result_fingerprint(&assignment.qbj)
    )
}

fn latest_help_requests(events: &[qbtcp_server::HelpEvent]) -> Vec<qbtcp_server::HelpRequest> {
    let mut by_id = HashMap::new();
    for event in events {
        let request = match event {
            qbtcp_server::HelpEvent::Opened(request)
            | qbtcp_server::HelpEvent::Cancelled(request) => request,
        };
        by_id.insert(request.id.clone(), request.clone());
    }
    let mut requests = by_id.into_values().collect::<Vec<_>>();
    requests.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then(left.id.cmp(&right.id))
    });
    requests
}

fn tournament_from_document(document: Option<&Value>) -> TournamentInfo {
    let tournament = document
        .and_then(Value::as_object)
        .and_then(|root| root.get("tournament"))
        .and_then(Value::as_object);
    TournamentInfo {
        id: string_field(tournament, "id").unwrap_or_else(|| "director".to_owned()),
        name: string_field(tournament, "name").unwrap_or_else(|| "QBSheet Director".to_owned()),
        qbj_version: qbtcp_server::QBJ_VERSION.to_owned(),
    }
}

fn rooms_from_document(document: Option<&Value>) -> Vec<RoomInfo> {
    let Some(rooms) = document
        .and_then(Value::as_object)
        .and_then(|root| root.get("rooms"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    rooms
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|room| {
            let id = string_field(Some(room), "id")?;
            let name = string_field(Some(room), "name").unwrap_or_else(|| id.clone());
            let available = room
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let status = string_field(Some(room), "status");
            // `available` controls future assignment. Keep a live/help room enabled so changing
            // next-round availability cannot tear down an active scorer session.
            let enabled = status.as_deref() != Some("offline")
                && (available || matches!(status.as_deref(), Some("live" | "help")));
            let accessibility = string_field(Some(room), "accessibility").or_else(|| {
                room.get("accessible")
                    .and_then(Value::as_bool)
                    .filter(|accessible| *accessible)
                    .map(|_| "Accessible".to_owned())
            });
            let description = [
                string_field(Some(room), "building"),
                string_field(Some(room), "floor"),
                accessibility,
                string_field(Some(room), "directions"),
                // Explicitly named public fields are safe to project; arbitrary/internal notes are
                // intentionally not included in a scorekeeper-visible description.
                string_field(Some(room), "publicDescription")
                    .or_else(|| string_field(Some(room), "public_description")),
            ]
            .into_iter()
            .flatten()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
            Some(RoomInfo {
                id,
                name,
                description: (!description.is_empty()).then(|| description.join(" · ")),
                enabled,
            })
        })
        .collect()
}

/// Project a released scheduled game into the one-game QBJ assignment profile.
///
/// Imported assignments keep their original QBJ when one is present. Director-created schedules do
/// not have question text yet, but they do have enough durable information to issue a truthful,
/// playable assignment: scoring rules, rosters, phase/round context, packet identity, and the
/// unplayed Match. The scorer supplies the questions in the room, just as it does for a manual QBJ
/// assignment. No scores, question content, or credentials are invented here.
fn assignments_from_document(document: Option<&Value>) -> Vec<(String, AssignedAssignment)> {
    let Some(root) = document.and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(scheduled_games) = root.get("scheduledGames").and_then(Value::as_array) else {
        return Vec::new();
    };

    let eligible_rooms: HashSet<String> = rooms_from_document(document)
        .into_iter()
        .filter(|room| room.enabled)
        .map(|room| room.id)
        .collect();
    let rounds = root
        .get("rounds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|round| string_field(Some(round), "id").map(|id| (id, round)))
        .collect::<HashMap<_, _>>();
    let teams = root
        .get("teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|team| {
            let id = string_field(Some(team), "id")?;
            let name = string_field(Some(team), "displayName")
                .or_else(|| string_field(Some(team), "name"))
                .unwrap_or_else(|| id.clone());
            Some((id, name))
        })
        .collect::<HashMap<_, _>>();
    let games = root
        .get("games")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|game| string_field(Some(game), "scheduledGameId").map(|id| (id, game)))
        .collect::<HashMap<_, _>>();

    scheduled_games
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|scheduled| {
            let status = string_field(Some(scheduled), "status")?;
            if !matches!(status.as_str(), "released" | "live") {
                return None;
            }
            if scheduled
                .get("bye")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return None;
            }

            let scheduled_id = string_field(Some(scheduled), "id")?;
            let room_id = string_field(Some(scheduled), "roomId")?;
            if !eligible_rooms.contains(&room_id) {
                return None;
            }
            let round_id = string_field(Some(scheduled), "roundId")?;
            let round = rounds.get(&round_id)?;
            let round_number = u32_field(Some(round), "number").filter(|number| *number > 0)?;
            let left_team_id = string_field(Some(scheduled), "leftTeamId")?;
            let right_team_id = string_field(Some(scheduled), "rightTeamId")?;
            let left_team = teams
                .get(&left_team_id)
                .cloned()
                .unwrap_or_else(|| left_team_id.clone());
            let right_team = teams
                .get(&right_team_id)
                .cloned()
                .unwrap_or_else(|| right_team_id.clone());

            let qbj = games
                .get(&scheduled_id)
                .and_then(|game| game.get("rawQbj"))
                .filter(|value| qbtcp_server::is_qbj_like(value))
                .cloned()
                .or_else(|| {
                    ["assignmentQbj", "qbj", "assignment"]
                        .iter()
                        .filter_map(|key| scheduled.get(*key))
                        .find(|value| qbtcp_server::is_qbj_like(value))
                        .cloned()
                })
                .or_else(|| generated_assignment(root, scheduled, round, &room_id))?;
            let (_, qbj_match_id) = qbtcp_server::qbj_identity(&qbj);
            let mut assignment =
                AssignedAssignment::new(qbj_match_id.unwrap_or_else(|| scheduled_id.clone()), qbj);
            assignment.round_number = round_number;
            assignment.round_name = string_field(Some(round), "name");
            assignment.left_team = Some(left_team.clone());
            assignment.right_team = Some(right_team.clone());
            assignment.label = Some(format!("{left_team} vs {right_team}"));
            assignment.meta = AssignmentMeta {
                round_revision: u64_field(Some(round), "revision").filter(|revision| *revision > 0),
                assignment_revision: u64_field(Some(scheduled), "assignmentRevision")
                    .filter(|revision| *revision > 0),
                released_round: Some(round_number),
                ..AssignmentMeta::default()
            };
            Some((room_id, assignment))
        })
        .collect()
}

fn generated_assignment(
    root: &Map<String, Value>,
    scheduled: &Map<String, Value>,
    round: &Map<String, Value>,
    room_id: &str,
) -> Option<Value> {
    let tournament = root.get("tournament")?.as_object()?;
    let tournament_id = string_field(Some(tournament), "id")?;
    let tournament_name =
        string_field(Some(tournament), "name").unwrap_or_else(|| "QBSheet Director".to_owned());
    let scheduled_id = string_field(Some(scheduled), "id")?;
    let round_id = string_field(Some(round), "id")?;
    let round_number = u32_field(Some(round), "number").filter(|number| *number > 0)?;
    let phase_id = string_field(Some(round), "phaseId").unwrap_or_else(|| "phase-1".to_owned());
    let phase = root
        .get("phases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|phase| string_field(Some(phase), "id").as_deref() == Some(phase_id.as_str()));
    let phase_name = phase
        .and_then(|phase| string_field(Some(phase), "name"))
        .unwrap_or_else(|| "Tournament".to_owned());
    let round_name = string_field(Some(round), "name").unwrap_or_else(|| round_number.to_string());
    let left_id = string_field(Some(scheduled), "leftTeamId")?;
    let right_id = string_field(Some(scheduled), "rightTeamId")?;
    let left = generated_team(root, &left_id)?;
    let right = generated_team(root, &right_id)?;
    let left_name = left.get("name").and_then(Value::as_str)?.to_owned();
    let right_name = right.get("name").and_then(Value::as_str)?.to_owned();
    let left_registration_id = format!("registration-{left_id}");
    let right_registration_id = format!("registration-{right_id}");
    let rules_id = format!("scoring-rules-{tournament_id}");
    let room_name = root
        .get("rooms")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|room| string_field(Some(room), "id").as_deref() == Some(room_id))
        .and_then(|room| string_field(Some(room), "name"))
        .unwrap_or_else(|| room_id.to_owned());

    let packet_id =
        string_field(Some(scheduled), "packetId").or_else(|| string_field(Some(round), "packetId"));
    let packet = packet_id.as_ref().and_then(|id| {
        root.get("packets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .find(|packet| string_field(Some(packet), "id").as_deref() == Some(id.as_str()))
    });
    let packet_name = packet
        .and_then(|packet| string_field(Some(packet), "name"))
        .or_else(|| packet_id.clone());

    // Interchange documents keep rules at the root; the native Director state keeps them under
    // `tournament`. Accept both shapes without guessing a missing timed flag.
    let rules_value = root.get("rules").or_else(|| tournament.get("rules"));
    let rules = generated_scoring_rules(rules_value, &rules_id);
    let mut qbtcp_extension = json!({
        "version": 1,
        "round_revision": u64_field(Some(round), "revision").unwrap_or(1),
        "assignment_revision": u64_field(Some(scheduled), "assignmentRevision").unwrap_or(1),
        "room_id": room_id
    });
    if let Some(timed) = timed_from_rules(rules_value) {
        qbtcp_extension["scorekeeper"] = json!({"timed": timed});
    }
    let match_object = json!({
        "type": "Match",
        "id": scheduled_id,
        "location": room_name,
        "match_teams": [
            {"team": {"$ref": left_id}},
            {"team": {"$ref": right_id}}
        ],
        "_qbtcp": qbtcp_extension
    });
    let mut round_object = json!({
        "type": "Round",
        "id": round_id,
        "name": round_name,
        "number": round_number,
        "matches": [{"$ref": scheduled_id}]
    });
    if let (Some(packet_id), Some(packet_name)) = (packet_id.as_ref(), packet_name.as_ref()) {
        round_object["packet"] = json!({"type": "Packet", "id": packet_id, "name": packet_name});
    }
    let phase_object = json!({
        "type": "Phase",
        "id": phase_id,
        "name": phase_name,
        "rounds": [{"$ref": round_id}]
    });
    let mut objects = vec![
        json!({
            "type": "Tournament",
            "id": tournament_id,
            "name": tournament_name,
            "scoring_rules": {"$ref": rules_id},
            "registrations": [
                {"$ref": left_registration_id},
                {"$ref": right_registration_id}
            ],
            "phases": [{"$ref": phase_id}]
        }),
        rules,
        json!({
            "type": "Registration",
            "id": left_registration_id,
            "name": left_name,
            "teams": [{"$ref": left_id}]
        }),
        json!({
            "type": "Registration",
            "id": right_registration_id,
            "name": right_name,
            "teams": [{"$ref": right_id}]
        }),
        left,
        right,
        phase_object,
        round_object,
        match_object,
    ];
    if let (Some(packet_id), Some(packet_name)) = (packet_id, packet_name) {
        objects.push(json!({"type": "Packet", "id": packet_id, "name": packet_name}));
    }
    Some(json!({"version": qbtcp_server::QBJ_VERSION, "objects": objects}))
}

fn generated_team(root: &Map<String, Value>, team_id: &str) -> Option<Value> {
    let team = root
        .get("teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|team| string_field(Some(team), "id").as_deref() == Some(team_id))?;
    let name = string_field(Some(team), "displayName")
        .or_else(|| string_field(Some(team), "name"))
        .unwrap_or_else(|| team_id.to_owned());
    let players = root
        .get("players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter(|player| {
            string_field(Some(player), "teamId").as_deref() == Some(team_id)
                && player
                    .get("active")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
        })
        .filter_map(|player| {
            let id = string_field(Some(player), "id")?;
            let player_name = string_field(Some(player), "name")?;
            Some(json!({
                "type": "Player",
                "id": id,
                "name": player_name,
                "captain": player.get("captain").and_then(Value::as_bool).unwrap_or(false)
            }))
        })
        .collect::<Vec<_>>();
    Some(json!({
        "type": "Team",
        "id": team_id,
        "name": name,
        "registration": {"$ref": format!("registration-{team_id}")},
        "players": players
    }))
}

fn generated_scoring_rules(value: Option<&Value>, id: &str) -> Value {
    let rules = value.and_then(Value::as_object);
    let tossup = i64_field(rules, "tossupValue").unwrap_or(10);
    let power = i64_field(rules, "powerValue").unwrap_or(15);
    let neg = i64_field(rules, "negValue").unwrap_or(-5);
    let bonus = i64_field(rules, "bonusValue").unwrap_or(10).max(1);
    let tossup_count = u32_field(rules, "tossupCount")
        .filter(|value| *value > 0)
        .unwrap_or(20);
    let bonus_parts = u32_field(rules, "bonusParts")
        .filter(|value| *value > 0)
        .unwrap_or(3);
    let maximum_players = u32_field(rules, "maximumActivePlayers")
        .filter(|value| *value > 0)
        .unwrap_or(4);
    let bouncebacks = rules
        .and_then(|rules| rules.get("bouncebacks"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let overtime = rules
        .and_then(|rules| rules.get("overtime"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let lightning = rules
        .and_then(|rules| rules.get("lightning"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut output = json!({
        "type": "ScoringRules",
        "id": id,
        "name": "Director scoring rules",
        "teams_per_match": 2,
        "maximum_players_per_team": maximum_players,
        "regulation_tossup_count": tossup_count,
        "maximum_regulation_tossup_count": tossup_count,
        "minimum_overtime_question_count": 1,
        "overtime_includes_bonuses": overtime,
        "total_divisor": score_divisor(&[power, tossup, neg, bonus]),
        "answer_types": [
            {"type": "AnswerType", "id": "answer-power", "value": power, "label": "Power", "short_label": "P", "awards_bonus": true},
            {"type": "AnswerType", "id": "answer-correct", "value": tossup, "label": "Correct", "short_label": "C", "awards_bonus": true},
            {"type": "AnswerType", "id": "answer-neg", "value": neg, "label": "Neg", "short_label": "N", "awards_bonus": false}
        ],
        "maximum_bonus_score": bonus * i64::from(bonus_parts),
        "bonus_divisor": bonus,
        "minimum_parts_per_bonus": bonus_parts,
        "maximum_parts_per_bonus": bonus_parts,
        "points_per_bonus_part": bonus,
        "bonuses_bounce_back": bouncebacks
    });
    if lightning {
        output["lightning_count_per_team"] = json!(1);
        output["lightning_divisor"] = json!(10);
    }
    output
}

fn timed_from_rules(value: Option<&Value>) -> Option<bool> {
    let rules = value?.as_object()?;
    ["roomProcedure", "room_procedure", "procedure", "regulation"]
        .iter()
        .find_map(|key| {
            rules
                .get(*key)
                .and_then(Value::as_object)
                .and_then(|procedure| procedure.get("timed"))
                .and_then(Value::as_bool)
        })
        .or_else(|| rules.get("timed").and_then(Value::as_bool))
}

fn score_divisor(values: &[i64]) -> i64 {
    values
        .iter()
        .map(|value| value.abs())
        .filter(|value| *value > 0)
        .fold(0, gcd)
        .max(1)
}

fn gcd(left: i64, right: i64) -> i64 {
    if right == 0 {
        left
    } else {
        gcd(right, left % right)
    }
}

fn i64_field(object: Option<&Map<String, Value>>, key: &str) -> Option<i64> {
    object?.get(key).and_then(Value::as_i64)
}

fn string_field(object: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    object?
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn u64_field(object: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<u64> {
    object?.get(key).and_then(Value::as_u64)
}

fn u32_field(object: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<u32> {
    u64_field(object, key).and_then(|value| u32::try_from(value).ok())
}

pub(crate) fn detect_lan_address() -> Option<String> {
    if_addrs::get_if_addrs()
        .ok()
        .and_then(|interfaces| {
            select_lan_address(interfaces.into_iter().map(|interface| interface.ip()))
        })
        .map(|address| address.to_string())
}

fn select_lan_address<I>(addresses: I) -> Option<Ipv4Addr>
where
    I: IntoIterator<Item = IpAddr>,
{
    let mut fallback = None;
    for address in addresses {
        let IpAddr::V4(address) = address else {
            continue;
        };
        if address.is_unspecified() || address.is_loopback() {
            continue;
        }
        if address.is_private() {
            return Some(address);
        }
        fallback.get_or_insert(address);
    }
    fallback
}

fn pairing_url(address: Option<&str>, port: u16, code: &str, room_id: &str) -> Option<String> {
    let address = address?;
    let server = format!("http://{address}:{port}");
    Some(format!(
        "{SCORE_SHEET_URL}#qbtcp-pair?v=1&server={}&code={}&room={}",
        percent_encode(&server),
        percent_encode(code),
        percent_encode(room_id)
    ))
}

fn pairing_invitation(
    address: Option<&str>,
    port: u16,
    invitation: qbtcp_server::PairingInvitation,
) -> RoomPairingInvitation {
    RoomPairingInvitation {
        room_id: invitation.room_id.clone(),
        room_name: invitation.room_name,
        pairing_code: invitation.code.clone(),
        pairing_url: pairing_url(address, port, &invitation.code, &invitation.room_id),
        expires_in_seconds: invitation.expires_in.as_secs(),
    }
}

fn legacy_pairing_fields(
    invitations: &[RoomPairingInvitation],
) -> (Option<String>, Option<String>) {
    match invitations {
        [invitation] => (
            Some(invitation.pairing_code.clone()),
            invitation.pairing_url.clone(),
        ),
        _ => (None, None),
    }
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                vec![byte as char]
            } else {
                format!("%{byte:02X}").chars().collect()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn document_rooms_are_converted_without_exposing_credentials() {
        let state = DirectorQbtcpState::from_document(Some(&json!({
            "tournament": {"id": "t-1", "name": "Local Invitational"},
            "rooms": [
                {
                    "id": "room-101",
                    "name": "Room 101",
                    "building": "Main",
                    "directions": "Use the east entrance",
                    "notes": "Internal staffing note",
                    "available": true
                },
                {"id": "room-102", "name": "Room 102", "status": "offline", "available": true}
            ]
        })));

        assert_eq!(state.tournament_name(), "Local Invitational");
        assert_eq!(
            state.enabled_rooms().into_iter().next().map(|room| room.id),
            Some("room-101".to_owned())
        );
        let rooms = <DirectorQbtcpState as QbtcpState>::rooms(&state).expect("rooms");
        assert_eq!(
            rooms[0].description.as_deref(),
            Some("Main · Use the east entrance")
        );
        assert!(!rooms[0]
            .description
            .as_deref()
            .unwrap_or_default()
            .contains("Internal staffing note"));
        assert_eq!(state.paired_room_count(), 0);
    }

    #[test]
    fn disabling_a_room_removes_its_operational_session_snapshot() {
        let document = json!({
            "tournament": {"id": "t-1", "name": "Local Invitational"},
            "rooms": [{"id": "room-101", "name": "Room 101", "available": true}]
        });
        let state = DirectorQbtcpState::from_document(Some(&document));
        <DirectorQbtcpState as QbtcpState>::record_session_event(
            &state,
            SessionEvent::Opened {
                session_id: "session-1".to_owned(),
                room_id: "room-101".to_owned(),
                match_id: "match-1".to_owned(),
            },
        )
        .expect("session is recorded");
        assert_eq!(state.snapshot().expect("snapshot").sessions.len(), 1);

        let mut disabled = document;
        disabled["rooms"][0]["available"] = json!(false);
        state.refresh_from_document(Some(&disabled));

        assert!(state.snapshot().expect("snapshot").sessions.is_empty());
    }

    #[test]
    fn replacing_an_assignment_keeps_terminal_session_snapshot_for_an_enabled_room() {
        let document = json!({
            "tournament": {"id": "t-1", "name": "Local Invitational"},
            "rooms": [{"id": "room-101", "name": "Room 101", "available": true}],
            "teams": [
                {"id": "team-a", "displayName": "North A"},
                {"id": "team-b", "displayName": "South B"}
            ],
            "rounds": [{"id": "round-1", "name": "Round 1", "number": 1, "revision": 1}],
            "scheduledGames": [{
                "id": "scheduled-1",
                "roundId": "round-1",
                "roomId": "room-101",
                "leftTeamId": "team-a",
                "rightTeamId": "team-b",
                "bye": false,
                "status": "released",
                "assignmentRevision": 1
            }]
        });
        let state = DirectorQbtcpState::from_document(Some(&document));
        <DirectorQbtcpState as QbtcpState>::record_session_event(
            &state,
            SessionEvent::Opened {
                session_id: "session-1".to_owned(),
                room_id: "room-101".to_owned(),
                match_id: "scheduled-1".to_owned(),
            },
        )
        .expect("session is recorded");
        <DirectorQbtcpState as QbtcpState>::record_session_event(
            &state,
            SessionEvent::ResultRetained {
                session_id: "session-1".to_owned(),
                result_id: "result-1".to_owned(),
                review_required: true,
            },
        )
        .expect("terminal result is recorded");

        let mut replacement = document.clone();
        replacement["scheduledGames"][0]["id"] = json!("scheduled-2");
        state.refresh_from_document(Some(&replacement));

        let sessions = state.snapshot().expect("snapshot").sessions;
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].status,
            qbtcp_server::SessionStatus::FinalReceived
        );
    }

    #[test]
    fn released_games_with_qbj_are_projected_to_their_rooms() {
        let document = json!({
            "tournament": {"id": "t-1", "name": "Local Invitational"},
            "rules": {"roomProcedure": {"timed": true}},
            "rooms": [
                {"id": "room-101", "name": "Room 101", "available": true},
                {"id": "room-102", "name": "Room 102", "available": true}
            ],
            "teams": [
                {"id": "team-a", "displayName": "North A"},
                {"id": "team-b", "displayName": "South B"},
                {"id": "team-c", "displayName": "East C"},
                {"id": "team-d", "displayName": "West D"}
            ],
            "rounds": [{"id": "round-1", "name": "Round 1", "number": 1, "revision": 4}],
            "scheduledGames": [
                {
                    "id": "scheduled-1",
                    "roundId": "round-1",
                    "roomId": "room-101",
                    "leftTeamId": "team-a",
                    "rightTeamId": "team-b",
                    "bye": false,
                    "status": "released",
                    "assignmentRevision": 3
                },
                {
                    "id": "scheduled-2",
                    "roundId": "round-1",
                    "roomId": "room-102",
                    "leftTeamId": "team-c",
                    "rightTeamId": "team-d",
                    "bye": false,
                    "status": "released",
                    "assignmentRevision": 1
                }
            ],
            "games": [{
                "id": "game-1",
                "scheduledGameId": "scheduled-1",
                "status": "scheduled",
                "rawQbj": {
                    "version": "2.1.1",
                    "objects": [
                        {"type": "Tournament", "id": "t-1"},
                        {"type": "Match", "id": "match-1", "teams": []}
                    ]
                }
            }]
        });
        let state = DirectorQbtcpState::from_document(Some(&document));

        let assigned = <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-101")
            .expect("room assignment is available");
        match assigned {
            AssignmentState::Assigned(assignment) => {
                assert_eq!(assignment.match_id, "match-1");
                assert_eq!(assignment.round_number, 1);
                assert_eq!(assignment.round_name.as_deref(), Some("Round 1"));
                assert_eq!(assignment.left_team.as_deref(), Some("North A"));
                assert_eq!(assignment.right_team.as_deref(), Some("South B"));
                assert_eq!(assignment.meta.round_revision, Some(4));
                assert_eq!(assignment.meta.assignment_revision, Some(3));
            }
            AssignmentState::None(_)
            | AssignmentState::Blocked { .. }
            | AssignmentState::Held { .. } => {
                panic!("released QBJ game should be assigned")
            }
        }

        let generated = <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-102")
            .expect("Director-created games receive a QBJ assignment");
        match generated {
            AssignmentState::Assigned(assignment) => {
                assert_eq!(assignment.match_id, "scheduled-2");
                assert_eq!(assignment.left_team.as_deref(), Some("East C"));
                assert_eq!(assignment.right_team.as_deref(), Some("West D"));
                assert_eq!(assignment.qbj["version"], json!("2.1.1"));
                let objects = assignment.qbj["objects"]
                    .as_array()
                    .expect("serialized QBJ objects");
                assert!(objects
                    .iter()
                    .any(|object| object["type"] == json!("ScoringRules")));
                assert!(objects.iter().any(|object| object["type"] == json!("Team")));
                assert_eq!(
                    objects
                        .iter()
                        .find(|object| object["type"] == json!("Match"))
                        .and_then(|object| object["_qbtcp"]["scorekeeper"]["timed"].as_bool()),
                    Some(true)
                );
            }
            AssignmentState::None(_)
            | AssignmentState::Blocked { .. }
            | AssignmentState::Held { .. } => {
                panic!("released Director game should be assigned")
            }
        }

        let mut updated = document.clone();
        updated["scheduledGames"][0]["status"] = json!("scheduled");
        state.refresh_from_document(Some(&updated));
        let cleared = <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-101")
            .expect("room remains available after refresh");
        assert!(matches!(cleared, AssignmentState::None(_)));
        assert!(matches!(
            <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-102"),
            Ok(AssignmentState::Assigned(_))
        ));

        let mut untimed_document = document.clone();
        untimed_document["rules"]["roomProcedure"]["timed"] = json!(false);
        let untimed_state = DirectorQbtcpState::from_document(Some(&untimed_document));
        let untimed = <DirectorQbtcpState as QbtcpState>::assignment(&untimed_state, "room-102")
            .expect("untimed assignment");
        assert_eq!(
            assignment_match_object(&untimed)
                .and_then(|object| object["_qbtcp"]["scorekeeper"]["timed"].as_bool()),
            Some(false)
        );

        let mut nested_rules_document = document.clone();
        nested_rules_document
            .as_object_mut()
            .expect("object document")
            .remove("rules");
        nested_rules_document["tournament"]["rules"] = json!({
            "tossupValue": 7,
            "roomProcedure": {"timed": true}
        });
        let nested_rules_state = DirectorQbtcpState::from_document(Some(&nested_rules_document));
        let nested_rules =
            <DirectorQbtcpState as QbtcpState>::assignment(&nested_rules_state, "room-102")
                .expect("nested rules assignment");
        let nested_match = assignment_match_object(&nested_rules).expect("nested match object");
        assert_eq!(nested_match["_qbtcp"]["scorekeeper"]["timed"], json!(true));
        let nested_scoring = match &nested_rules {
            AssignmentState::Assigned(assignment) => {
                assignment.qbj["objects"].as_array().and_then(|objects| {
                    objects
                        .iter()
                        .find(|object| object["type"] == json!("ScoringRules"))
                })
            }
            AssignmentState::None(_)
            | AssignmentState::Blocked { .. }
            | AssignmentState::Held { .. } => None,
        };
        assert_eq!(
            nested_scoring.and_then(|rules| rules["answer_types"][1]["value"].as_i64()),
            Some(7)
        );

        let mut unknown_document = document.clone();
        unknown_document
            .as_object_mut()
            .expect("object document")
            .remove("rules");
        let unknown_state = DirectorQbtcpState::from_document(Some(&unknown_document));
        let unknown = <DirectorQbtcpState as QbtcpState>::assignment(&unknown_state, "room-102")
            .expect("unknown assignment");
        let unknown_match = assignment_match_object(&unknown).expect("match object");
        assert!(unknown_match["_qbtcp"].get("scorekeeper").is_none());
    }

    fn assignment_match_object(assignment: &AssignmentState) -> Option<&Value> {
        let AssignmentState::Assigned(assignment) = assignment else {
            return None;
        };
        assignment.qbj["objects"]
            .as_array()?
            .iter()
            .find(|object| object["type"] == json!("Match"))
    }

    #[test]
    fn pairing_url_keeps_the_code_in_the_fragment() {
        let url = pairing_url(Some("192.168.1.20"), 8787, "12345678", "room/101")
            .expect("a LAN address produces a pairing URL");

        assert!(url.starts_with("https://qbsheet.com/#qbtcp-pair?"));
        assert!(url.contains("code=12345678"));
        assert!(url.contains("room=room%2F101"));
        assert!(!url[..url.find('#').expect("fragment")].contains("12345678"));
    }

    #[test]
    fn lan_address_selection_prefers_private_non_loopback_and_has_no_loopback_fallback() {
        let selected = select_lan_address([
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 10)),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
        ]);
        assert_eq!(selected, Some(Ipv4Addr::new(192, 168, 1, 20)));
        assert_eq!(select_lan_address([IpAddr::V4(Ipv4Addr::LOCALHOST)]), None);
        assert!(pairing_url(None, 8787, "12345678", "room/101").is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn server_lifecycle_binds_a_real_listener_and_stops() {
        let runtime = ServerRuntime::default();
        let status = runtime
            .start_on_port(
                Some(json!({
                    "tournament": {"id": "t-1", "name": "Live test"},
                    "rooms": [{"id": "room-101", "name": "Room 101", "available": true}]
                })),
                0,
            )
            .await
            .expect("server starts");

        assert!(status.running);
        assert_eq!(status.protocol.as_deref(), Some("QBTCP v1"));
        assert!(status.port.is_some_and(|port| port > 0));
        assert!(status.pairing_code.is_some());
        assert_eq!(status.pairing_url.is_some(), status.address.is_some());
        if let Some(address) = status.address.as_deref() {
            assert_ne!(address, "127.0.0.1");
        }

        let stopped = runtime.stop();
        assert!(!stopped.running);
        assert_eq!(stopped.message.as_deref(), Some("QBTCP server stopped."));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn server_status_exposes_independent_pairing_invitations_per_room() {
        let runtime = ServerRuntime::default();
        let status = runtime
            .start_on_port(
                Some(json!({
                    "tournament": {"id": "t-1", "name": "Multi-room test"},
                    "rooms": [
                        {"id": "room-101", "name": "Room 101", "available": true},
                        {"id": "room-102", "name": "Room 102", "available": true}
                    ]
                })),
                0,
            )
            .await
            .expect("server starts");

        assert_eq!(status.pairing_invitations.len(), 2);
        assert!(status.pairing_code.is_none());
        assert!(status.pairing_url.is_none());
        assert_eq!(
            status
                .pairing_invitations
                .iter()
                .map(|invitation| invitation.room_id.as_str())
                .collect::<Vec<_>>(),
            vec!["room-101", "room-102"]
        );
        assert!(status.pairing_invitations.iter().all(|invitation| {
            invitation
                .pairing_url
                .as_deref()
                .is_none_or(|url| url.contains("room="))
        }));

        let mut disabled = json!({
            "tournament": {"id": "t-1", "name": "Multi-room test"},
            "rooms": [
                {"id": "room-101", "name": "Room 101", "available": true},
                {"id": "room-102", "name": "Room 102", "available": false}
            ]
        });
        runtime.refresh_state(Some(&disabled));
        assert_eq!(runtime.status().pairing_invitations.len(), 1);
        assert!(runtime.issue_pairing("room-102").is_err());

        disabled["rooms"][1]["available"] = json!(true);
        runtime.refresh_state(Some(&disabled));
        let replacement = runtime.issue_pairing("room-102").expect("room pairing");
        assert_eq!(replacement.room_id, "room-102");
        assert_eq!(runtime.status().pairing_invitations.len(), 2);
        runtime.stop();
    }
}
