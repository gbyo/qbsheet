use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use qbtcp_server::{
    AssignedAssignment, AssignmentMeta, AssignmentState, MemoryState, PresenceRecord,
    ProgressRecord, QbtcpConfig, QbtcpServer, QbtcpState, ResultDisposition, ResultSubmission,
    RoomInfo, RosterAmendment, RosterAmendmentRequest, SessionEvent, StateError, TournamentInfo,
};
use serde::Serialize;
use serde_json::Value;
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
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub protocol: Option<String>,
    pub paired_rooms: usize,
    pub pairing_code: Option<String>,
    pub pairing_url: Option<String>,
    pub message: Option<String>,
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
        }
        status
    }

    pub async fn start(&self, document: Option<Value>) -> Result<ServerStatus, ServerError> {
        self.start_on_port(document, DEFAULT_QBTCP_PORT).await
    }

    async fn start_on_port(
        &self,
        document: Option<Value>,
        requested_port: u16,
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
        let state = Arc::new(DirectorQbtcpState::from_document(document.as_ref()));
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
        let invitation = state
            .first_enabled_room()
            .map(|room| server.issue_pairing(&room.id))
            .transpose()
            .map_err(|error| ServerError::Pairing(format!("{error:?}")))?;
        let (pairing_code, pairing_url) = invitation
            .as_ref()
            .map(|value| {
                (
                    Some(value.code.clone()),
                    Some(pairing_url(&address, port, &value.code, &value.room_id)),
                )
            })
            .unwrap_or((None, None));

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
            address: Some(address),
            port: Some(port),
            protocol: Some("QBTCP v1".to_owned()),
            paired_rooms: state.paired_room_count(),
            pairing_code,
            pairing_url,
            message: Some("QBTCP server started.".to_owned()),
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
        if let Ok(inner) = self.inner.lock() {
            if let Some(state) = inner.state.as_ref() {
                state.refresh_from_document(document);
            }
        }
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
    tournament: RwLock<TournamentInfo>,
    room_ids: Mutex<HashSet<String>>,
    assignment_room_ids: Mutex<HashSet<String>>,
    paired_rooms: Mutex<HashSet<String>>,
}

impl DirectorQbtcpState {
    pub fn from_document(document: Option<&Value>) -> Self {
        let tournament = tournament_from_document(document);
        let rooms = rooms_from_document(document);
        let assignments = assignments_from_document(document);
        let room_ids = rooms.iter().map(|room| room.id.clone()).collect();
        let assignment_room_ids = assignments
            .iter()
            .map(|(room_id, _)| room_id.clone())
            .collect();
        let memory = MemoryState::new(tournament.clone(), rooms);
        for (room_id, assignment) in assignments {
            memory.set_assignment(room_id, AssignmentState::Assigned(assignment));
        }
        Self {
            memory,
            tournament: RwLock::new(tournament),
            room_ids: Mutex::new(room_ids),
            assignment_room_ids: Mutex::new(assignment_room_ids),
            paired_rooms: Mutex::new(HashSet::new()),
        }
    }

    pub fn refresh_from_document(&self, document: Option<&Value>) {
        let tournament = tournament_from_document(document);
        if let Ok(mut current) = self.tournament.write() {
            *current = tournament;
        }

        let rooms = rooms_from_document(document);
        if let Ok(mut known_ids) = self.room_ids.lock() {
            let next_ids: HashSet<String> = rooms.iter().map(|room| room.id.clone()).collect();
            for removed in known_ids.difference(&next_ids) {
                self.memory.remove_room(removed);
            }
            for room in &rooms {
                self.memory.set_room(room.clone());
            }
            *known_ids = next_ids;
        }

        let assignments = assignments_from_document(document);
        if let Ok(mut known_ids) = self.assignment_room_ids.lock() {
            let next_ids: HashSet<String> = assignments
                .iter()
                .map(|(room_id, _)| room_id.clone())
                .collect();
            for room_id in known_ids.iter() {
                self.memory.set_assignment(
                    room_id.clone(),
                    AssignmentState::None(AssignmentMeta::default()),
                );
            }
            for (room_id, assignment) in assignments {
                self.memory
                    .set_assignment(room_id, AssignmentState::Assigned(assignment));
            }
            *known_ids = next_ids;
        }
    }

    pub fn tournament_name(&self) -> String {
        self.tournament
            .read()
            .map(|value| value.name.clone())
            .unwrap_or_else(|_| "QBSheet Director".to_owned())
    }

    pub fn first_enabled_room(&self) -> Option<RoomInfo> {
        <MemoryState as QbtcpState>::rooms(&self.memory)
            .ok()?
            .into_iter()
            .find(|room| room.enabled)
    }

    pub fn paired_room_count(&self) -> usize {
        self.paired_rooms
            .lock()
            .map(|rooms| rooms.len())
            .unwrap_or_default()
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
        if let Ok(mut rooms) = self.paired_rooms.lock() {
            rooms.insert(record.room_id.clone());
        }
        <MemoryState as QbtcpState>::record_presence(&self.memory, record)
    }

    fn record_progress(&self, record: ProgressRecord) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_progress(&self.memory, record)
    }

    fn record_result(&self, submission: ResultSubmission) -> Result<ResultDisposition, StateError> {
        <MemoryState as QbtcpState>::record_result(&self.memory, submission)
    }

    fn add_roster_amendment(
        &self,
        request: RosterAmendmentRequest,
    ) -> Result<RosterAmendment, StateError> {
        <MemoryState as QbtcpState>::add_roster_amendment(&self.memory, request)
    }

    fn record_session_event(&self, event: SessionEvent) -> Result<(), StateError> {
        if let Ok(mut rooms) = self.paired_rooms.lock() {
            match &event {
                SessionEvent::Opened { room_id, .. } => {
                    rooms.insert(room_id.clone());
                }
                SessionEvent::Expired { room_id, .. } => {
                    rooms.remove(room_id);
                }
                SessionEvent::WriterTaken { .. } | SessionEvent::ResultRetained { .. } => {}
            }
        }
        <MemoryState as QbtcpState>::record_session_event(&self.memory, event)
    }

    fn record_help_event(&self, event: qbtcp_server::HelpEvent) -> Result<(), StateError> {
        <MemoryState as QbtcpState>::record_help_event(&self.memory, event)
    }
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
            let enabled = available && status.as_deref() != Some("offline");
            let description = ["building", "floor", "accessibility", "directions", "notes"]
                .iter()
                .filter_map(|key| string_field(Some(room), key))
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

/// Project only a real QBJ document attached to a released scheduled game.
///
/// A schedule contains the operational pairing but not the questions. The native shell must not
/// manufacture a packet that the scorer could not actually score, so a game is released over
/// QBTCP only when its saved document carries a QBJ assignment (normally `GameRecord.rawQbj`, or
/// an explicit `assignmentQbj` on the scheduled game). This keeps room pairing honest while
/// allowing imported QBJ tournaments and future packet loaders to work without another transport
/// adapter.
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
                })?;
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

fn detect_lan_address() -> String {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0));
    if let Ok(socket) = socket {
        if socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).is_ok() {
            if let Ok(IpAddr::V4(address)) = socket.local_addr().map(|value| value.ip()) {
                if !address.is_unspecified() {
                    return address.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_owned()
}

fn pairing_url(address: &str, port: u16, code: &str, room_id: &str) -> String {
    let server = format!("http://{address}:{port}");
    format!(
        "{SCORE_SHEET_URL}#qbtcp-pair?v=1&server={}&code={}&room={}",
        percent_encode(&server),
        percent_encode(code),
        percent_encode(room_id)
    )
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
                {"id": "room-101", "name": "Room 101", "building": "Main", "available": true},
                {"id": "room-102", "name": "Room 102", "status": "offline", "available": true}
            ]
        })));

        assert_eq!(state.tournament_name(), "Local Invitational");
        assert_eq!(
            state.first_enabled_room().map(|room| room.id),
            Some("room-101".to_owned())
        );
        assert_eq!(state.paired_room_count(), 0);
    }

    #[test]
    fn released_games_with_qbj_are_projected_to_their_rooms() {
        let document = json!({
            "tournament": {"id": "t-1", "name": "Local Invitational"},
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

        let empty_room = <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-102")
            .expect("room without QBJ remains usable");
        assert!(matches!(empty_room, AssignmentState::None(_)));

        let mut updated = document;
        updated["scheduledGames"][0]["status"] = json!("scheduled");
        state.refresh_from_document(Some(&updated));
        let cleared = <DirectorQbtcpState as QbtcpState>::assignment(&state, "room-101")
            .expect("room remains available after refresh");
        assert!(matches!(cleared, AssignmentState::None(_)));
    }

    #[test]
    fn pairing_url_keeps_the_code_in_the_fragment() {
        let url = pairing_url("192.168.1.20", 8787, "12345678", "room/101");

        assert!(url.starts_with("https://qbsheet.com/#qbtcp-pair?"));
        assert!(url.contains("code=12345678"));
        assert!(url.contains("room=room%2F101"));
        assert!(!url[..url.find('#').expect("fragment")].contains("12345678"));
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
        assert!(status.pairing_url.is_some());

        let stopped = runtime.stop();
        assert!(!stopped.running);
        assert_eq!(stopped.message.as_deref(), Some("QBTCP server stopped."));
    }
}
