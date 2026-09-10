//! Hosting-neutral QBLive v1 protocol semantics.
//!
//! This module is the Rust side of the contract owned by
//! `packages/qblive-protocol` and `docs/QBLIVE.md`. It deliberately mirrors the
//! TypeScript validators' *bounds* (lengths, counts, shapes) rather than
//! re-implementing Director's projection: the projection constructs the public
//! document, this module checks the framing of what a server holds.
//!
//! A `packages/qblive-protocol/tests/rust-parity.test.ts` test asserts the
//! numeric limits below match `qbliveLimits` in TypeScript, and
//! `tests/fixtures.rs` asserts the shared JSON fixtures satisfy this module.
//! If either fails, the two interpretations have drifted.

use serde_json::Value;

/// The QBLive protocol version this core implements.
///
/// Must equal `QBLIVE_PROTOCOL_VERSION` in `packages/qblive-protocol/src/types.ts`.
pub const PROTOCOL_VERSION: i64 = 1;

/// Bounds mirrored from `qbliveLimits` in `packages/qblive-protocol/src/validate.ts`.
pub const MAX_TEAMS: usize = 512;
pub const MAX_PLAYERS_PER_TEAM: usize = 32;
pub const MAX_ROOMS: usize = 256;
pub const MAX_SCHEDULE_ENTRIES: usize = 8192;
pub const MAX_RESULTS: usize = 8192;
pub const MAX_LIVE_GAMES: usize = 256;
pub const MAX_TIMELINE_EVENTS: usize = 512;
pub const MAX_TABLES: usize = 64;
pub const MAX_TABLE_ROWS: usize = 2048;
pub const MAX_TABLE_COLUMNS: usize = 48;
pub const MAX_ANNOUNCEMENTS: usize = 256;
pub const MAX_STRING_LENGTH: usize = 4096;
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_EVENTS_PER_PAGE: usize = 256;

/// Replay windows by deployment profile.
///
/// The Cloudflare reference backend keeps 256 revisions; Director's
/// local-only server keeps 64. Both are conforming: the protocol requires the
/// server to *admit* when it cannot replay, not to keep any particular depth.
/// See `docs/QBLIVE_SERVER_CONTRACT.md`.
pub const REPLAY_WINDOW_FULL: usize = 256;
pub const REPLAY_WINDOW_LOCAL: usize = 64;

/// The named, independently replaceable parts of public state.
///
/// Must equal `qbliveSectionNames` in TypeScript.
pub const SECTION_NAMES: &[&str] = &[
    "tournament",
    "teams",
    "rooms",
    "timeline",
    "schedule",
    "results",
    "liveGames",
    "standings",
    "statistics",
    "announcements",
];

/// Local-only capabilities, mirrored from
/// `packages/qblive-protocol/src/local-capabilities.json`.
///
/// Director's local server advertises events but no WebSocket stream: the
/// laptop is running a tournament, not a socket server.
pub const LOCAL_CAPABILITIES_JSON: &str =
    r#"{"snapshot":true,"events":true,"stream":false,"applePush":false}"#;

/// Full remote-backend capabilities (Cloudflare reference, future QBServer).
pub const FULL_CAPABILITIES_JSON: &str =
    r#"{"snapshot":true,"events":true,"stream":true,"applePush":false}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityProfile {
    /// A full remote backend: snapshot + events + stream.
    Full,
    /// Director local-only mode: snapshot + events, no stream, no management API.
    Local,
    /// A static host: snapshot only.
    Basic,
}

impl CapabilityProfile {
    pub fn capabilities_json(&self) -> &'static str {
        match self {
            CapabilityProfile::Full => FULL_CAPABILITIES_JSON,
            CapabilityProfile::Local => LOCAL_CAPABILITIES_JSON,
            CapabilityProfile::Basic => {
                r#"{"snapshot":true,"events":false,"stream":false,"applePush":false}"#
            }
        }
    }

    pub fn advertises_events(&self) -> bool {
        !matches!(self, CapabilityProfile::Basic)
    }

    pub fn advertises_stream(&self) -> bool {
        matches!(self, CapabilityProfile::Full)
    }

    pub fn exposes_management(&self) -> bool {
        matches!(self, CapabilityProfile::Full)
    }
}

/// A publication id, validated before it becomes storage state.
///
/// Twenty characters from a fixed vowel-free alphabet. Mirrors
/// `isPublicationId` in TypeScript and `is_publication_id` in Director's
/// `live.rs`; the check is the only thing between a URL a stranger
/// constructed and a storage entry named after it.
pub fn is_publication_id(value: &str) -> bool {
    value.len() == 20
        && value.chars().all(|c| {
            matches!(
                c,
                '0'..='9' | 'b'..='d' | 'f'..='h' | 'j'..='n' | 'p'..='t' | 'v'..='z'
            )
        })
}

/// An ISO 8601 instant carrying an explicit offset or `Z`.
///
/// A bare local time is rejected rather than assumed to be UTC: an
/// unqualified "13:30" published by one server and read by a phone in another
/// zone is exactly the class of bug the tournament timezone exists to prevent.
pub fn is_valid_timestamp(value: &str) -> bool {
    if value.len() > MAX_STRING_LENGTH {
        return false;
    }
    // Fast structural check for `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let digit = |i: usize| bytes.get(i).is_some_and(|b| b.is_ascii_digit());
    for i in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
        if !digit(i) {
            return false;
        }
    }
    if bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return false;
    }
    let rest = &value[19..];
    let offset = if let Some(stripped) = rest.strip_prefix('.') {
        let digits: String = stripped
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if digits.is_empty() || digits.len() > 9 {
            return false;
        }
        &stripped[digits.len()..]
    } else {
        rest
    };
    let offset_ok = offset == "Z"
        || (offset.len() == 6
            && (offset.as_bytes()[0] == b'+' || offset.as_bytes()[0] == b'-')
            && offset.as_bytes()[3] == b':'
            && offset[1..3].chars().all(|c| c.is_ascii_digit())
            && offset[4..6].chars().all(|c| c.is_ascii_digit()));
    if !offset_ok {
        return false;
    }
    // The structural check accepts impossible dates (month 13); the real
    // parse below does not.
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).is_ok()
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("bad-request: {0}")]
    BadRequest(String),
    #[error("payload-too-large: {0}")]
    TooLarge(String),
}

fn check_string_length(value: &Value, path: &str) -> Result<(), ValidationError> {
    match value {
        Value::String(s) if s.len() > MAX_STRING_LENGTH => Err(ValidationError::BadRequest(
            format!("{path}: string is too long"),
        )),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                check_string_length(item, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (k, v) in map {
                if k.len() > MAX_STRING_LENGTH {
                    return Err(ValidationError::BadRequest(format!(
                        "{path}.{k}: string is too long"
                    )));
                }
                check_string_length(v, &format!("{path}.{k}"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn require_array<'a>(
    value: &'a Value,
    path: &str,
    limit: usize,
) -> Result<&'a Vec<Value>, ValidationError> {
    match value {
        Value::Array(items) => {
            if items.len() > limit {
                return Err(ValidationError::BadRequest(format!(
                    "{path}: array has more than {limit} entries"
                )));
            }
            Ok(items)
        }
        _ => Err(ValidationError::BadRequest(format!(
            "{path}: expected an array"
        ))),
    }
}

/// Validate one named section at the framing level.
///
/// This checks JSON shapes and bounds, not every domain field: the full
/// field validators live in TypeScript (`parseSections`) and JSON Schema, and
/// the shared fixtures prove the two agree. What this must catch is a
/// malformed or oversized section a host would otherwise store and serve.
pub fn validate_section(name: &str, value: &Value) -> Result<(), ValidationError> {
    check_string_length(value, &format!("sections.{name}"))?;
    match name {
        "tournament" => {
            let obj = value.as_object().ok_or_else(|| {
                ValidationError::BadRequest("sections.tournament: expected an object".to_owned())
            })?;
            for key in ["id", "name", "timeZone", "status"] {
                if !obj.get(key).is_some_and(|v| v.is_string()) {
                    return Err(ValidationError::BadRequest(format!(
                        "sections.tournament.{key}: expected a string"
                    )));
                }
            }
            Ok(())
        }
        "teams" => {
            let teams = require_array(value, "sections.teams", MAX_TEAMS)?;
            for (i, team) in teams.iter().enumerate() {
                let obj = team.as_object().ok_or_else(|| {
                    ValidationError::BadRequest(format!("sections.teams[{i}]: expected an object"))
                })?;
                // The exact malformed case the backends must refuse: an entry
                // with an id but no name is not a team.
                for key in ["id", "name"] {
                    if !obj.get(key).is_some_and(|v| v.is_string()) {
                        return Err(ValidationError::BadRequest(format!(
                            "sections.teams[{i}].{key}: expected a string"
                        )));
                    }
                }
                if let Some(players) = obj.get("players") {
                    require_array(
                        players,
                        &format!("sections.teams[{i}].players"),
                        MAX_PLAYERS_PER_TEAM,
                    )?;
                }
            }
            Ok(())
        }
        "rooms" => {
            require_array(value, "sections.rooms", MAX_ROOMS)?;
            Ok(())
        }
        "timeline" => {
            require_array(value, "sections.timeline", MAX_TIMELINE_EVENTS)?;
            Ok(())
        }
        "schedule" => {
            require_array(value, "sections.schedule", MAX_SCHEDULE_ENTRIES)?;
            Ok(())
        }
        "results" => {
            require_array(value, "sections.results", MAX_RESULTS)?;
            Ok(())
        }
        "liveGames" => {
            let games = require_array(value, "sections.liveGames", MAX_LIVE_GAMES)?;
            for (i, game) in games.iter().enumerate() {
                let obj = game.as_object().ok_or_else(|| {
                    ValidationError::BadRequest(format!(
                        "sections.liveGames[{i}]: expected an object"
                    ))
                })?;
                for key in ["gameId", "roundId"] {
                    if !obj.get(key).is_some_and(|v| v.is_string()) {
                        return Err(ValidationError::BadRequest(format!(
                            "sections.liveGames[{i}].{key}: expected a string"
                        )));
                    }
                }
            }
            Ok(())
        }
        "standings" | "statistics" => {
            let tables = require_array(value, &format!("sections.{name}"), MAX_TABLES)?;
            for (i, table) in tables.iter().enumerate() {
                let obj = table.as_object().ok_or_else(|| {
                    ValidationError::BadRequest(format!("sections.{name}[{i}]: expected an object"))
                })?;
                let columns = obj.get("columns").ok_or_else(|| {
                    ValidationError::BadRequest(format!(
                        "sections.{name}[{i}].columns: expected an array"
                    ))
                })?;
                let columns = require_array(
                    columns,
                    &format!("sections.{name}[{i}].columns"),
                    MAX_TABLE_COLUMNS,
                )?;
                let rows = obj.get("rows").ok_or_else(|| {
                    ValidationError::BadRequest(format!(
                        "sections.{name}[{i}].rows: expected an array"
                    ))
                })?;
                let rows =
                    require_array(rows, &format!("sections.{name}[{i}].rows"), MAX_TABLE_ROWS)?;
                for row in rows {
                    let row_obj = row.as_object().ok_or_else(|| {
                        ValidationError::BadRequest(format!(
                            "sections.{name}[{i}].rows: expected an object"
                        ))
                    })?;
                    let cells = row_obj.get("cells").ok_or_else(|| {
                        ValidationError::BadRequest(format!(
                            "sections.{name}[{i}].rows.cells: expected an array"
                        ))
                    })?;
                    let cells = require_array(
                        cells,
                        &format!("sections.{name}[{i}].rows.cells"),
                        MAX_TABLE_COLUMNS,
                    )?;
                    if cells.len() != columns.len() {
                        return Err(ValidationError::BadRequest(format!(
                            "sections.{name}[{i}].rows.cells: row does not match the column count"
                        )));
                    }
                }
            }
            Ok(())
        }
        "announcements" => {
            let items = require_array(value, "sections.announcements", MAX_ANNOUNCEMENTS)?;
            for (i, item) in items.iter().enumerate() {
                let obj = item.as_object().ok_or_else(|| {
                    ValidationError::BadRequest(format!(
                        "sections.announcements[{i}]: expected an object"
                    ))
                })?;
                for key in ["id", "title", "body", "severity", "publishedAt"] {
                    if obj.get(key).is_none() {
                        return Err(ValidationError::BadRequest(format!(
                            "sections.announcements[{i}].{key}: required"
                        )));
                    }
                }
                if let Some(published_at) = obj.get("publishedAt").and_then(|v| v.as_str()) {
                    if !is_valid_timestamp(published_at) {
                        return Err(ValidationError::BadRequest(format!(
                            "sections.announcements[{i}].publishedAt: expected a timestamp with offset"
                        )));
                    }
                }
            }
            Ok(())
        }
        _ => Err(ValidationError::BadRequest(format!(
            "sections.{name}: unknown section"
        ))),
    }
}

/// Extract the publishable sections from a snapshot, mirroring
/// `sections_of` in Director's `live_server.rs` and the Cloudflare backend's
/// section writer.
pub fn sections_of(snapshot: &Value) -> Value {
    let mut sections = serde_json::Map::new();
    if let Some(obj) = snapshot.as_object() {
        for name in SECTION_NAMES {
            if let Some(value) = obj.get(*name) {
                sections.insert((*name).to_owned(), value.clone());
            }
        }
    }
    Value::Object(sections)
}

/// Validate a full snapshot document at the framing level.
pub fn validate_snapshot(value: &Value) -> Result<(), ValidationError> {
    let body_len = value.to_string().len();
    if body_len > MAX_BODY_BYTES {
        return Err(ValidationError::TooLarge(
            "that publication update is too large".to_owned(),
        ));
    }
    let obj = value
        .as_object()
        .ok_or_else(|| ValidationError::BadRequest("snapshot: expected an object".to_owned()))?;
    if obj.get("protocolVersion").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return Err(ValidationError::BadRequest(
            "snapshot.protocolVersion: unsupported QBLive protocol version".to_owned(),
        ));
    }
    let publication_id = obj
        .get("publicationId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ValidationError::BadRequest("snapshot.publicationId: expected a string".to_owned())
        })?;
    if !is_publication_id(publication_id) {
        return Err(ValidationError::BadRequest(
            "snapshot.publicationId: not a valid publication id".to_owned(),
        ));
    }
    if !obj.get("revision").is_some_and(|v| v.as_i64().is_some()) {
        return Err(ValidationError::BadRequest(
            "snapshot.revision: expected an integer".to_owned(),
        ));
    }
    let generated_at = obj
        .get("generatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ValidationError::BadRequest("snapshot.generatedAt: expected a string".to_owned())
        })?;
    if !is_valid_timestamp(generated_at) {
        return Err(ValidationError::BadRequest(
            "snapshot.generatedAt: expected an ISO 8601 timestamp with an explicit offset"
                .to_owned(),
        ));
    }
    if !obj.get("final").is_some_and(|v| v.is_boolean()) {
        return Err(ValidationError::BadRequest(
            "snapshot.final: expected a boolean".to_owned(),
        ));
    }
    for name in SECTION_NAMES {
        let section = obj
            .get(*name)
            .ok_or_else(|| ValidationError::BadRequest(format!("snapshot.{name}: required")))?;
        validate_section(name, section)?;
    }
    Ok(())
}

/// The absolute-or-relative endpoint set a manifest advertises.
pub fn manifest_endpoints(publication_id: &str) -> serde_json::Value {
    let base = format!("/qblive/v1/tournaments/{publication_id}");
    serde_json::json!({
        "snapshot": format!("{base}/snapshot"),
        "events": format!("{base}/events"),
        "stream": format!("{base}/stream"),
    })
}

/// A `hello` frame: the first thing a stream sends so a reconnecting client
/// can tell whether it has a gap.
pub fn hello_frame(publication_id: &str, revision: i64) -> Value {
    serde_json::json!({
        "type": "hello",
        "protocolVersion": PROTOCOL_VERSION,
        "publicationId": publication_id,
        "revision": revision,
    })
}

/// A `resync` frame: the answer to anything a spectator sends.
///
/// Spectator sockets are read-only. Nothing a spectator sends can change
/// published state; the one thing a client could legitimately want is the
/// current revision, which costs nothing.
pub fn resync_frame(current_revision: i64) -> Value {
    serde_json::json!({ "type": "resync", "currentRevision": current_revision })
}

/// An `event` broadcast frame.
pub fn event_frame(event: &Value) -> Value {
    serde_json::json!({ "type": "event", "event": event })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_ids_match_the_typescript_pattern() {
        assert!(is_publication_id("bcdfghjkmnpqrstvwxyz"));
        assert!(is_publication_id("0123456789bcdfghjkmn"));
        for bad in [
            "",
            "short",
            "AEIOUaeiouaeiouaeiou",
            "aeiouaeiouaeiouaeiou",
            "../etc",
            &"a".repeat(200),
        ] {
            assert!(!is_publication_id(bad), "{bad}");
        }
        // Vowels and lookalikes are excluded.
        assert!(!is_publication_id("aeioubcdfghjkmnpqrst"));
    }

    #[test]
    fn timestamps_require_an_explicit_offset() {
        assert!(is_valid_timestamp("2026-09-05T14:30:00.000Z"));
        assert!(is_valid_timestamp("2026-09-05T13:30:00-04:00"));
        assert!(!is_valid_timestamp("2026-09-05T14:30:00"));
        assert!(!is_valid_timestamp("not a time"));
        assert!(!is_valid_timestamp("2026-13-05T14:30:00.000Z"));
    }

    #[test]
    fn local_capabilities_match_the_shared_json() {
        let parsed: Value = serde_json::from_str(LOCAL_CAPABILITIES_JSON).unwrap();
        assert_eq!(parsed["snapshot"], true);
        assert_eq!(parsed["events"], true);
        assert_eq!(parsed["stream"], false);
        assert_eq!(parsed["applePush"], false);
    }
}
