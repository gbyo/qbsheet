//! The QBTCP v1 realtime/relay capability contract, server side.
//!
//! This module is the normative Rust side of `docs/QBTCP-STREAM.md`: the `stream` capability
//! name, the discovery descriptor shape, validation of the versioned frame envelope, and the
//! transport-neutral session rules (revision recency, progress coalescing, final idempotency,
//! reconnect backoff, relay receipt semantics). It owns no socket and names no relay vendor.
//!
//! The default server does not advertise `stream`: [`crate::model::QbtcpConfig::stream`] is
//! `None` unless a host that actually serves the WebSocket transport provides a descriptor.
//! A client therefore never infers stream support from anything but discovery, and an
//! HTTP-only server keeps working unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The discovery capability that advertises the realtime stream.
pub const STREAM_CAPABILITY: &str = "stream";
/// The only stream frame envelope version implemented here.
pub const STREAM_FRAME_VERSION: u32 = 1;
/// The WebSocket subprotocol naming the framing. It carries no credential.
pub const STREAM_SUBPROTOCOL: &str = "qbtcp.stream.v1";
/// Default bound on one decoded stream frame, in UTF-8 bytes.
pub const DEFAULT_MAX_STREAM_FRAME_BYTES: usize = 1024 * 1024;
/// Reconnect backoff base and cap, in milliseconds.
pub const STREAM_RECONNECT_BASE_MS: u64 = 500;
/// Reconnect backoff never exceeds this, however many attempts have failed.
pub const STREAM_RECONNECT_MAX_MS: u64 = 30_000;

/// Replay features a stream descriptor may advertise.
pub const STREAM_REPLAY_FEATURES: &[&str] = &["sequence", "resync"];

/// Frame types a server may send to a scorer. Unknown types are ignored, never fatal.
pub const SERVER_FRAME_TYPES: &[&str] = &[
    "hello",
    "assignment-changed",
    "session-changed",
    "help-changed",
    "resync-required",
    "shutdown",
    "receipt",
    "recovery",
    "error",
];

/// Frame types a scorer may send to a server.
pub const SCORER_FRAME_TYPES: &[&str] = &[
    "authenticate",
    "progress",
    "presence",
    "help-open",
    "help-cancel",
    "final",
    "recover",
];

/// The realtime endpoint and its properties, as carried by discovery.
///
/// Operational metadata, not authority: it carries no token, no pairing code, and no session
/// identifier. Deserialization goes through [`read_stream_descriptor`], which rejects anything
/// credential-shaped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamDescriptor {
    /// Relative path of the WebSocket endpoint, e.g. `/qbtcp/v1/stream`. Never a full URL.
    pub endpoint: String,
    /// Frame envelope version the server speaks.
    pub frames: u32,
    /// Whether the relay durably retains finals while Director is disconnected.
    pub retains_finals: bool,
    /// Whether the relay mirrors Director-published assignment/session state.
    pub mirrors_assignment: bool,
    /// Reconnect/replay features the server supports.
    #[serde(default)]
    pub replay: Vec<String>,
    /// Bound on one decoded frame, in UTF-8 bytes of the serialized JSON.
    pub max_frame_bytes: usize,
    /// Whether the server additionally offers a narrow pre-auth ticket exchange.
    #[serde(default)]
    pub ticket: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamDescriptorError {
    Missing,
    Malformed(&'static str),
    CredentialLeak,
    UnsupportedFrames(u32),
}

impl std::fmt::Display for StreamDescriptorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => write!(f, "no stream descriptor"),
            Self::Malformed(reason) => write!(f, "malformed stream descriptor: {reason}"),
            Self::CredentialLeak => write!(f, "stream descriptor carries credential-shaped data"),
            Self::UnsupportedFrames(version) => {
                write!(f, "unsupported stream frame version {version}")
            }
        }
    }
}

fn is_credential_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("token")
        || key.contains("code")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("credential")
        || key.contains("bearer")
}

/// Read and validate the `stream` member of a discovery document value.
///
/// Strict about the fields a client acts on and forgiving about the rest: unknown descriptor
/// fields are ignored so a future relay does not break this implementation. Anything
/// credential-shaped, an absolute or parameterized endpoint, or a frame version other than
/// [`STREAM_FRAME_VERSION`] is rejected.
pub fn read_stream_descriptor(
    discovery: &Value,
) -> Result<Option<StreamDescriptor>, StreamDescriptorError> {
    let Some(descriptor) = discovery.get("stream") else {
        return Ok(None);
    };
    let object = descriptor
        .as_object()
        .ok_or(StreamDescriptorError::Malformed(
            "the stream descriptor must be an object",
        ))?;
    if object.keys().any(|key| is_credential_key(key)) {
        return Err(StreamDescriptorError::CredentialLeak);
    }
    let endpoint = object
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|endpoint| {
            endpoint.starts_with('/')
                && endpoint.len() <= 200
                && !endpoint.contains(['?', '#', '@'])
                && endpoint.chars().all(|c| !c.is_control())
        })
        .ok_or(StreamDescriptorError::Malformed(
            "the stream endpoint must be a relative path",
        ))?;
    let frames = object
        .get("frames")
        .and_then(Value::as_u64)
        .filter(|frames| *frames == u64::from(STREAM_FRAME_VERSION))
        .ok_or_else(|| {
            object
                .get("frames")
                .and_then(Value::as_u64)
                .map(|frames| StreamDescriptorError::UnsupportedFrames(frames as u32))
                .unwrap_or(StreamDescriptorError::Malformed(
                    "the stream descriptor needs a frame version",
                ))
        })?;
    let retains_finals = object
        .get("retains_finals")
        .and_then(Value::as_bool)
        .ok_or(StreamDescriptorError::Malformed(
            "the stream descriptor must say whether it retains finals",
        ))?;
    let mirrors_assignment = object
        .get("mirrors_assignment")
        .and_then(Value::as_bool)
        .ok_or(StreamDescriptorError::Malformed(
            "the stream descriptor must say whether it mirrors assignments",
        ))?;
    let replay =
        object
            .get("replay")
            .and_then(Value::as_array)
            .ok_or(StreamDescriptorError::Malformed(
                "the stream descriptor must list replay features",
            ))?;
    let mut features = Vec::with_capacity(replay.len());
    for entry in replay {
        let feature = entry
            .as_str()
            .filter(|feature| STREAM_REPLAY_FEATURES.contains(feature))
            .ok_or(StreamDescriptorError::Malformed(
                "the stream descriptor lists an unknown replay feature",
            ))?;
        features.push(feature.to_owned());
    }
    let max_frame_bytes = object
        .get("max_frame_bytes")
        .and_then(Value::as_u64)
        .filter(|max| *max > 0 && *max <= 64 * 1024 * 1024)
        .ok_or(StreamDescriptorError::Malformed(
            "the stream descriptor needs a frame bound",
        ))? as usize;
    Ok(Some(StreamDescriptor {
        endpoint: endpoint.to_owned(),
        frames: frames as u32,
        retains_finals,
        mirrors_assignment,
        replay: features,
        max_frame_bytes,
        ticket: object
            .get("ticket")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }))
}

/// One validated stream frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StreamFrame {
    pub version: u32,
    pub frame_type: String,
    pub sequence: Option<u64>,
    pub session_id: Option<String>,
    pub payload: Option<Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamFrameError {
    Malformed(&'static str),
    UnsupportedVersion,
    TooLarge { size: usize, max_bytes: usize },
}

impl std::fmt::Display for StreamFrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(reason) => write!(f, "malformed stream frame: {reason}"),
            Self::UnsupportedVersion => write!(f, "unsupported stream frame version"),
            Self::TooLarge { size, max_bytes } => {
                write!(
                    f,
                    "stream frame is {size} bytes, above the {max_bytes}-byte bound"
                )
            }
        }
    }
}

/// The validation outcome: a usable frame, or an unknown type to ignore safely.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValidatedStreamFrame {
    Frame(StreamFrame),
    Ignored,
}

fn bounded_text(value: &Value, max_chars: usize) -> Option<String> {
    let text = value.as_str()?;
    if text.trim().is_empty() {
        return None;
    }
    let cleaned: String = text.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned.chars().count() > max_chars {
        return None;
    }
    Some(cleaned.to_owned())
}

/// Validate one decoded stream frame without touching any session state.
///
/// Unknown frame types validate as [`ValidatedStreamFrame::Ignored`] so a future server
/// cannot break this implementation. Anything structurally wrong — including a frame
/// version other than [`STREAM_FRAME_VERSION`] and any oversize frame — is an error the
/// caller must answer without mutating the game. The size bound is UTF-8 bytes of the
/// serialized JSON, matching the TypeScript mirror.
pub fn validate_stream_frame(
    value: &Value,
    max_bytes: usize,
) -> Result<ValidatedStreamFrame, StreamFrameError> {
    let size = serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if size > max_bytes {
        return Err(StreamFrameError::TooLarge { size, max_bytes });
    }
    let object = value.as_object().ok_or(StreamFrameError::Malformed(
        "a stream frame must be a JSON object",
    ))?;
    if object.get("version").and_then(Value::as_u64) != Some(u64::from(STREAM_FRAME_VERSION)) {
        return Err(StreamFrameError::UnsupportedVersion);
    }
    let frame_type = object
        .get("type")
        .and_then(|value| bounded_text(value, 64))
        .ok_or(StreamFrameError::Malformed("a stream frame needs a type"))?;
    if !SERVER_FRAME_TYPES.contains(&frame_type.as_str())
        && !SCORER_FRAME_TYPES.contains(&frame_type.as_str())
    {
        return Ok(ValidatedStreamFrame::Ignored);
    }
    let sequence = match object.get("sequence") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or(StreamFrameError::Malformed(
            "a frame sequence must be a non-negative integer",
        ))?),
    };
    let session_id = match object.get("session_id") {
        None => None,
        Some(value) => Some(bounded_text(value, 200).ok_or(StreamFrameError::Malformed(
            "a frame session id must be bounded text",
        ))?),
    };
    if let Some(payload) = object.get("payload") {
        if !payload.is_object() {
            return Err(StreamFrameError::Malformed(
                "a frame payload must be an object",
            ));
        }
    }
    Ok(ValidatedStreamFrame::Frame(StreamFrame {
        version: STREAM_FRAME_VERSION,
        frame_type,
        sequence,
        session_id,
        payload: object.get("payload").cloned(),
    }))
}

/// Whether an incoming assignment revision supersedes the one held.
///
/// Round revision wins first; within a round, assignment revision wins. A stale transport
/// must never overwrite newer state, on either transport. Revisions that are absent prove
/// nothing and never supersede.
pub fn is_assignment_newer(
    current: (Option<u64>, Option<u64>),
    incoming: (Option<u64>, Option<u64>),
) -> bool {
    let (Some(current_round), Some(current_assignment)) = current else {
        return incoming.0.is_some() && incoming.1.is_some();
    };
    let (Some(incoming_round), Some(incoming_assignment)) = incoming else {
        return false;
    };
    if incoming_round != current_round {
        return incoming_round > current_round;
    }
    incoming_assignment > current_assignment
}

/// Whether an incoming progress sequence replaces the held one.
///
/// Progress is a snapshot, not a delta. Equal sequences keep the held snapshot: the first
/// arrival wins a tie.
pub fn progress_wins(held: Option<u64>, incoming: u64) -> bool {
    held.map_or(true, |sequence| incoming > sequence)
}

/// Whether a final arriving over either transport duplicates a retained one.
///
/// Ordering follows the canonical ingest path: the tournament scopes the comparison, match
/// identity is compared first, and a retry key makes a transport retry idempotent without
/// replacing result identity.
pub fn is_duplicate_final(
    known: (Option<&str>, Option<&str>, &str, Option<&str>),
    incoming: (Option<&str>, Option<&str>, &str, Option<&str>),
) -> bool {
    let (known_tournament, known_match, known_fingerprint, known_key) = known;
    let (incoming_tournament, incoming_match, incoming_fingerprint, incoming_key) = incoming;
    if known_tournament != incoming_tournament {
        return false;
    }
    if let (Some(known_match), Some(incoming_match)) = (known_match, incoming_match) {
        if known_match != incoming_match {
            return false;
        }
        return known_fingerprint == incoming_fingerprint;
    }
    if let (Some(known_key), Some(incoming_key)) = (known_key, incoming_key) {
        return known_key == incoming_key && known_fingerprint == incoming_fingerprint;
    }
    known_fingerprint == incoming_fingerprint
}

/// Backoff before a stream reconnect attempt, with full jitter.
///
/// Doubles from the base per attempt up to the cap, then scales the caller-supplied uniform
/// sample in [0, 1000) into that window, so devices dropping together do not reconnect in
/// lockstep. The sample is a parameter — rather than a random draw — so the policy is
/// deterministic under test.
pub fn reconnect_delay_ms(attempt: u32, sample_per_mille: u64) -> u64 {
    let shift = attempt.min(10);
    let mut capped = STREAM_RECONNECT_BASE_MS
        .checked_shl(shift)
        .unwrap_or(STREAM_RECONNECT_MAX_MS);
    capped = capped.min(STREAM_RECONNECT_MAX_MS);
    capped * sample_per_mille.min(999) / 1000
}

/// A durable receipt for a final retained by a relay.
///
/// `received` says the bytes are safe on disk. `accepted_by_director` says Director has
/// imported the result into standings — and a relay receipt always answers false, because
/// a relay never accepts results on Director's behalf. Conflating the two strands the
/// scorer's retry logic and Director's review queue together.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayReceipt {
    pub received: bool,
    pub review_required: bool,
    pub accepted_by_director: bool,
    pub duplicate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_id: Option<String>,
    pub fingerprint: String,
    pub result_id: String,
}

impl RelayReceipt {
    /// Build the receipt a relay sends for a durably retained final.
    ///
    /// Director acceptance is not a parameter: there is no honest relay answer but false,
    /// and making it one would let a future caller claim standings authority it has not got.
    pub fn retained(
        review_required: bool,
        duplicate: bool,
        match_id: Option<String>,
        fingerprint: String,
        result_id: String,
    ) -> Self {
        Self {
            received: true,
            review_required,
            accepted_by_director: false,
            duplicate,
            match_id,
            fingerprint,
            result_id,
        }
    }
}
