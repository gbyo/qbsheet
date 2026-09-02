use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::Duration;
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

/// The only protocol version implemented by this crate.
pub const QBTCP_VERSION: u32 = 1;
/// The QBJ version used by the QBSheet web client in this repository.
pub const QBJ_VERSION: &str = "2.1.1";
/// The canonical QBTCP route prefix.
pub const QBTCP_PREFIX: &str = "/qbtcp/v1";
/// The media type used for assignment and result documents.
pub const QBJ_MEDIA_TYPE: &str = "application/vnd.quizbowl.qbj+json";

/// Credential headers retained for compatibility with the existing QBSheet web client.
pub const ROOM_TOKEN_HEADER: &str = "x-yf-room-token";
pub const SESSION_TOKEN_HEADER: &str = "x-yf-session-token";
pub const DEVICE_ID_HEADER: &str = "x-yf-device-id";
pub const OPERATOR_NAME_HEADER: &str = "x-yf-operator-name";

/// Capabilities implemented by the default server.
pub const DEFAULT_CAPABILITIES: &[&str] = &[
    "pairing",
    "assignment",
    "progress",
    "result",
    "recovery",
    "help",
    "presence",
    "roster",
];

/// The short, human-entered pairing secret is deliberately separate from bearer tokens.
pub const PAIRING_CODE_LENGTH: usize = 8;

/// Configuration for the QBTCP protocol and transport.
#[derive(Clone)]
pub struct QbtcpConfig {
    pub protocol_version: u32,
    pub qbj_version: String,
    pub max_body_bytes: usize,
    pub name: String,
    pub capabilities: Vec<String>,
    /// Exact browser origins allowed to make cross-origin requests.
    ///
    /// An empty list still permits native/non-browser requests with no `Origin` header, but it
    /// rejects all browser origins. The server never uses `*` for authenticated endpoints.
    pub allowed_origins: Vec<String>,
    pub pairing_code_ttl: Duration,
    pub pairing_rate_limit: PairingRateLimit,
    /// Inactivity timeout. Expiry abandons a session while preserving its recovery state and audit
    /// records; it never deletes a session or its submitted result.
    pub session_idle_timeout: Duration,
}

impl Default for QbtcpConfig {
    fn default() -> Self {
        Self {
            protocol_version: QBTCP_VERSION,
            qbj_version: QBJ_VERSION.to_owned(),
            max_body_bytes: 8 * 1024 * 1024,
            name: "QBSheet Director".to_owned(),
            capabilities: DEFAULT_CAPABILITIES
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            allowed_origins: Vec::new(),
            pairing_code_ttl: Duration::from_secs(15 * 60),
            pairing_rate_limit: PairingRateLimit::default(),
            session_idle_timeout: Duration::from_secs(24 * 60 * 60),
        }
    }
}

impl QbtcpConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.protocol_version != QBTCP_VERSION {
            return Err(ConfigError::UnsupportedProtocolVersion(
                self.protocol_version,
            ));
        }
        if self.name.trim().is_empty() || self.name.len() > 200 {
            return Err(ConfigError::InvalidName);
        }
        if self.qbj_version.trim().is_empty() || self.qbj_version.len() > 50 {
            return Err(ConfigError::InvalidQbjVersion);
        }
        if self.max_body_bytes == 0 || self.max_body_bytes > 64 * 1024 * 1024 {
            return Err(ConfigError::InvalidBodyLimit);
        }
        if self.pairing_code_ttl.is_zero() {
            return Err(ConfigError::InvalidPairingCodeTtl);
        }
        if self.session_idle_timeout.is_zero() {
            return Err(ConfigError::InvalidSessionTimeout);
        }
        if self.pairing_rate_limit.max_attempts == 0 || self.pairing_rate_limit.window.is_zero() {
            return Err(ConfigError::InvalidRateLimit);
        }
        if self
            .capabilities
            .iter()
            .any(|capability| capability.trim().is_empty() || capability.len() > 80)
        {
            return Err(ConfigError::InvalidCapability);
        }
        if self
            .allowed_origins
            .iter()
            .any(|origin| origin.trim().is_empty() || origin.len() > 512)
        {
            return Err(ConfigError::InvalidOrigin);
        }
        Ok(())
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|value| value == capability)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ConfigError {
    #[error("unsupported QBTCP protocol version {0}")]
    UnsupportedProtocolVersion(u32),
    #[error("invalid server name")]
    InvalidName,
    #[error("invalid QBJ version")]
    InvalidQbjVersion,
    #[error("invalid request body limit")]
    InvalidBodyLimit,
    #[error("invalid pairing-code lifetime")]
    InvalidPairingCodeTtl,
    #[error("invalid session timeout")]
    InvalidSessionTimeout,
    #[error("invalid pairing rate limit")]
    InvalidRateLimit,
    #[error("invalid capability")]
    InvalidCapability,
    #[error("invalid browser origin")]
    InvalidOrigin,
}

#[derive(Clone)]
pub struct PairingRateLimit {
    pub max_attempts: usize,
    pub window: Duration,
}

impl Default for PairingRateLimit {
    fn default() -> Self {
        Self {
            max_attempts: 8,
            window: Duration::from_secs(60),
        }
    }
}

/// Tournament information exposed by discovery and the optional identity endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TournamentInfo {
    pub id: String,
    pub name: String,
    pub qbj_version: String,
}

/// Stored room metadata. Pairing codes and room tokens are intentionally absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct RoomListEntry {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl From<&RoomInfo> for RoomListEntry {
    fn from(room: &RoomInfo) -> Self {
        Self {
            id: room.id.clone(),
            name: room.name.clone(),
            description: room.description.clone(),
        }
    }
}

/// A compact label used by assignment status. It is operational copy, not QBJ data.
#[derive(Clone, Debug, Default, Serialize)]
pub struct AssignmentLabel {
    pub label: String,
}

#[derive(Clone, Debug, Default)]
pub struct AssignmentMeta {
    pub round_revision: Option<u64>,
    pub assignment_revision: Option<u64>,
    pub previous: Option<AssignmentLabel>,
    pub next: Option<AssignmentLabel>,
    pub released_round: Option<u32>,
    pub hold_new_starts: bool,
}

/// An assignment that is currently released to a room.
#[derive(Clone)]
pub struct AssignedAssignment {
    pub match_id: String,
    /// Official serialized QBJ or a bare Match object accepted by the existing web client.
    pub qbj: Value,
    pub round_number: u32,
    pub round_name: Option<String>,
    pub left_team: Option<String>,
    pub right_team: Option<String>,
    pub label: Option<String>,
    pub meta: AssignmentMeta,
}

impl AssignedAssignment {
    pub fn new(match_id: impl Into<String>, qbj: Value) -> Self {
        Self {
            match_id: match_id.into(),
            qbj,
            round_number: 0,
            round_name: None,
            left_team: None,
            right_team: None,
            label: None,
            meta: AssignmentMeta::default(),
        }
    }
}

/// The state interface supplies this operational state; QBTCP only serializes it and enforces
/// capability/session rules around it.
#[derive(Clone)]
pub enum AssignmentState {
    Assigned(AssignedAssignment),
    None(AssignmentMeta),
    Blocked {
        reason: String,
        message: String,
        meta: AssignmentMeta,
    },
    Held {
        reason: String,
        message: String,
        meta: AssignmentMeta,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Open,
    FinalReceived,
    Abandoned,
}

#[derive(Clone, Debug, Serialize)]
pub struct SessionStatusView {
    pub session_id: String,
    pub status: SessionStatus,
    pub resumable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_received: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AssignmentStatusResponse {
    pub state: String,
    pub blocked_reason: Option<String>,
    pub blocked_message: Option<String>,
    pub session: Option<SessionStatusView>,
    pub previous: Option<AssignmentLabel>,
    pub next: Option<AssignmentLabel>,
    pub round_revision: Option<u64>,
    pub assignment_revision: Option<u64>,
    pub released_round: Option<u32>,
    pub hold_new_starts: bool,
}

/// Presence metadata is advisory and must never be treated as authentication.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClientDiagnostics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresenceUpdate {
    #[serde(default)]
    pub ready: Option<bool>,
    #[serde(default)]
    pub client: Option<ClientDiagnostics>,
    #[serde(default, rename = "procedure_versions", alias = "procedureVersions")]
    pub procedure_versions: Option<Vec<u32>>,
    #[serde(default, rename = "qbj_version", alias = "qbjVersion")]
    pub qbj_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PresenceView {
    pub room_id: String,
    pub room_name: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientDiagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procedure_versions: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qbj_version: Option<String>,
    pub updated_at: String,
}

pub const HELP_CATEGORIES: &[&str] = &[
    "wrong-matchup",
    "team-missing",
    "protest",
    "question-packet",
    "roster-change",
    "equipment-technical",
    "rules-question",
    "scoring-problem",
    "device-network",
    "wrong-room",
    "other",
];

pub fn valid_help_category(value: &str) -> bool {
    HELP_CATEGORIES.contains(&value)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HelpStatus {
    Open,
    Cancelled,
    Resolved,
}

#[derive(Clone, Debug, Serialize)]
pub struct CurrentMatchup {
    pub round_number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_team: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HelpRequest {
    pub id: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "roomName")]
    pub room_name: String,
    pub category: String,
    pub message: String,
    pub status: HelpStatus,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "operatorName", skip_serializing_if = "Option::is_none")]
    pub operator_name: Option<String>,
    #[serde(rename = "currentMatchup", skip_serializing_if = "Option::is_none")]
    pub current_matchup: Option<CurrentMatchup>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HelpEnvelope {
    pub request: Option<HelpRequest>,
}

#[derive(Clone, Debug)]
pub struct RosterAmendmentRequest {
    pub session_id: String,
    pub team_id: Option<String>,
    pub team_name: String,
    pub player_name: String,
    pub question_number: Option<u32>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RosterAmendment {
    #[serde(rename = "playerId", skip_serializing_if = "Option::is_none")]
    pub player_id: Option<String>,
    #[serde(rename = "playerName", skip_serializing_if = "Option::is_none")]
    pub player_name: Option<String>,
    #[serde(rename = "teamId", skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(rename = "teamName", skip_serializing_if = "Option::is_none")]
    pub team_name: Option<String>,
    pub created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(rename = "question_number", skip_serializing_if = "Option::is_none")]
    pub question_number: Option<u32>,
}

#[derive(Clone)]
pub struct ProgressRecord {
    pub session_id: String,
    pub room_id: String,
    pub sequence: u64,
    pub match_state: Value,
    pub received_at: String,
}

#[derive(Clone)]
pub struct PresenceRecord {
    pub room_id: String,
    pub room_name: String,
    pub device_id: String,
    pub operator_name: Option<String>,
    pub update: PresenceUpdate,
    pub observed_at: String,
}

/// The complete, authenticated result handed to the state implementation.
///
/// `raw` is kept separately from the parsed JSON so a durable implementation can preserve the
/// original submission bytes for audit and later reconciliation.
#[derive(Clone)]
pub struct ResultSubmission {
    pub session_id: String,
    pub room_id: String,
    pub expected_tournament_id: String,
    pub expected_match_id: String,
    pub expected_round_revision: Option<u64>,
    pub submitted_tournament_id: Option<String>,
    pub submitted_match_id: Option<String>,
    pub submitted_round_revision: Option<u64>,
    pub fingerprint: String,
    pub qbj: Value,
    pub raw: Vec<u8>,
    pub received_at: String,
    pub late_after_abandon: bool,
}

#[derive(Clone, Debug)]
pub struct ResultDisposition {
    pub result_id: String,
    pub duplicate: bool,
    pub review_required: bool,
    pub conflict: bool,
    pub warnings: Vec<String>,
    pub conflict_with: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RetainedResultSummary {
    pub id: String,
    pub session_id: String,
    pub tournament_id: Option<String>,
    pub match_id: Option<String>,
    pub fingerprint: String,
    pub review_required: bool,
    pub warnings: Vec<String>,
    pub conflict_with: Option<String>,
}

#[derive(Clone, Debug)]
pub enum SessionEvent {
    Opened {
        session_id: String,
        room_id: String,
        match_id: String,
    },
    WriterTaken {
        session_id: String,
    },
    Expired {
        session_id: String,
        room_id: String,
    },
    ResultRetained {
        session_id: String,
        result_id: String,
        review_required: bool,
    },
}

#[derive(Clone, Debug)]
pub enum HelpEvent {
    Opened(HelpRequest),
    Cancelled(HelpRequest),
}

#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum StateError {
    #[error("state unavailable")]
    Unavailable,
    #[error("state rejected the operation")]
    Rejected,
    #[error("state could not save the operation")]
    SaveFailed,
}

#[derive(Clone, Debug)]
pub enum QbtcpError {
    BadRequest(&'static str),
    Unauthorized,
    PairingRefused,
    Forbidden(&'static str),
    NotFound(&'static str),
    NotSupported,
    Conflict {
        message: &'static str,
        writer_device: Option<&'static str>,
        can_take_over: bool,
    },
    Gone(&'static str),
    TooLarge,
    RateLimited {
        retry_after_secs: u64,
    },
    OriginNotAllowed,
    Internal,
}

/// An opaque token generated from the operating-system random source.
pub fn random_secret() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Random ids are not credentials, but they are intentionally unguessable so they are safe to use
/// as audit/session handles in URLs.
pub fn random_id(prefix: &str) -> String {
    format!(
        "{}-{}",
        prefix,
        random_secret().chars().take(22).collect::<String>()
    )
}

pub fn digest_secret(value: &str) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(value.as_bytes());
    digest.finalize().into()
}

pub fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_owned())
}

pub fn pairing_code() -> String {
    let mut bytes = [0_u8; 8];
    OsRng.fill_bytes(&mut bytes);
    let value = u64::from_le_bytes(bytes) % 100_000_000;
    format!("{value:08}")
}

/// Validate a JSON value before it crosses the protocol boundary.
pub fn validate_json_tree(value: &Value, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match value {
        Value::Array(values) => values
            .iter()
            .all(|value| validate_json_tree(value, depth + 1)),
        Value::Object(values) => values.iter().all(|(key, value)| {
            !matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                && validate_json_tree(value, depth + 1)
        }),
        _ => true,
    }
}

/// The QBSheet client accepts either an official QBJ envelope or a bare Match object. The server
/// uses this small shape check for final submissions without taking on QBJ's tournament semantics.
pub fn is_qbj_like(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if let Some(objects) = object.get("objects") {
        return object
            .get("version")
            .and_then(Value::as_str)
            .is_some_and(|version| !version.trim().is_empty())
            && objects
                .as_array()
                .is_some_and(|entries| entries.iter().all(Value::is_object));
    }
    object.get("type").and_then(Value::as_str) == Some("Match")
        || object.contains_key("match_teams")
}

fn top_level_objects(value: &Value) -> Vec<&Map<String, Value>> {
    if let Some(objects) = value.get("objects").and_then(Value::as_array) {
        return objects.iter().filter_map(Value::as_object).collect();
    }
    value.as_object().into_iter().collect()
}

/// Extract only the standard QBJ identities. No tournament/business interpretation belongs here.
pub fn qbj_identity(value: &Value) -> (Option<String>, Option<String>) {
    let mut tournament_id = None;
    let mut match_id = None;
    for object in top_level_objects(value) {
        match object.get("type").and_then(Value::as_str) {
            Some("Tournament") if tournament_id.is_none() => {
                tournament_id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            Some("Match") if match_id.is_none() => {
                match_id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }
    if match_id.is_none() && value.get("type").and_then(Value::as_str) == Some("Match") {
        match_id = value
            .get("id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    (tournament_id, match_id)
}

pub fn qbtcp_round_revision(value: &Value) -> Option<u64> {
    top_level_objects(value).into_iter().find_map(|object| {
        if object.get("type").and_then(Value::as_str) != Some("Match") {
            return None;
        }
        object
            .get("_qbtcp")
            .and_then(Value::as_object)
            .and_then(|extension| extension.get("round_revision"))
            .and_then(Value::as_u64)
    })
}

/// Return the optional assignment revision carried by a QBJ Match's QBTCP extension.
pub fn qbtcp_assignment_revision(value: &Value) -> Option<u64> {
    top_level_objects(value).into_iter().find_map(|object| {
        if object.get("type").and_then(Value::as_str) != Some("Match") {
            return None;
        }
        object
            .get("_qbtcp")
            .and_then(Value::as_object)
            .and_then(|extension| extension.get("assignment_revision"))
            .and_then(Value::as_u64)
    })
}

/// Stable statistical fingerprint. Transport/source extensions are omitted recursively and object
/// keys are sorted, so a QBJ backup and its QBTCP arrival compare equal.
pub fn result_fingerprint(value: &Value) -> String {
    let canonical = canonical_without_transport(value);
    let mut digest = Sha256::new();
    digest.update(canonical.as_bytes());
    let bytes: [u8; 32] = digest.finalize().into();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn canonical_without_transport(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_without_transport)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries: BTreeMap<&str, &Value> = BTreeMap::new();
            for (key, value) in values {
                if is_transport_key(key) {
                    continue;
                }
                entries.insert(key.as_str(), value);
            }
            let body = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned());
                    format!("{key}:{}", canonical_without_transport(value))
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
    }
}

fn is_transport_key(key: &str) -> bool {
    matches!(
        key,
        "_qbtcp" | "_qbsheet_source" | "_scoresheet_source" | "_yf_scorekeeper_recovery"
    )
}

/// Normalize an advisory string by removing control characters and bounding UTF-8 characters.
pub fn clean_advisory(value: &str, max_chars: usize) -> Option<String> {
    let cleaned: String = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}

pub fn sanitize_presence(update: PresenceUpdate) -> Result<PresenceUpdate, QbtcpError> {
    let client = update.client.map(|client| ClientDiagnostics {
        name: client
            .name
            .as_deref()
            .and_then(|value| clean_advisory(value, 100)),
        version: client
            .version
            .as_deref()
            .and_then(|value| clean_advisory(value, 100)),
        build: client
            .build
            .as_deref()
            .and_then(|value| clean_advisory(value, 100)),
        commit: client
            .commit
            .as_deref()
            .and_then(|value| clean_advisory(value, 100)),
    });
    let client = client.filter(|value| {
        value.name.is_some()
            || value.version.is_some()
            || value.build.is_some()
            || value.commit.is_some()
    });
    let versions = update.procedure_versions.map(|values| {
        values
            .into_iter()
            .filter(|value| *value > 0)
            .take(16)
            .collect::<Vec<_>>()
    });
    let versions = versions.filter(|values| !values.is_empty());
    let qbj_version = update
        .qbj_version
        .as_deref()
        .and_then(|value| clean_advisory(value, 50));
    Ok(PresenceUpdate {
        ready: update.ready,
        client,
        procedure_versions: versions,
        qbj_version,
    })
}
