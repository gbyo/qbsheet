//! The minimum storage interface QBLive semantics require.
//!
//! Route logic in [`crate::routes`] speaks only to [`PublicationStorage`]:
//! atomic, durable transitions rather than SQL calls. A storage
//! implementation must never acknowledge a successful publication mutation
//! until it is durable according to its backend contract — a committed SQLite
//! transaction for QBServer, Durable Object storage for Cloudflare.
//!
//! The Cloudflare implementation may continue using direct Durable Object
//! SQLite where wrapping it would add complexity; what matters is that the
//! semantic state machine here is what QBServer implements faithfully. See
//! `docs/QBLIVE_SERVER_CONTRACT.md`.
//!
//! [`MemoryStorage`] is the reference in-memory implementation. Tests and
//! conformance fixtures run against it; QBServer's SQLite implementation (see
//! #778) implements the same trait with the same observable behavior.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::protocol::{
    is_publication_id, is_valid_timestamp, sections_of, validate_section, validate_snapshot,
    ValidationError, MAX_ANNOUNCEMENTS, MAX_BODY_BYTES, REPLAY_WINDOW_FULL,
};

/// Publication lifecycle.
///
/// - `live`: accepting updates and publicly readable.
/// - `final`: frozen and publicly readable; section updates are refused.
/// - `unpublished`: hidden (`410 gone`) but recoverable with the same credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Live,
    Final,
    Unpublished,
}

impl Lifecycle {
    pub fn as_str(&self) -> &'static str {
        match self {
            Lifecycle::Live => "live",
            Lifecycle::Final => "final",
            Lifecycle::Unpublished => "unpublished",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("not-found: {0}")]
    NotFound(String),
    #[error("gone: {0}")]
    Gone(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("conflict: {0}")]
    Conflict(String, i64),
    #[error("bad-request: {0}")]
    BadRequest(String),
    #[error("payload-too-large: {0}")]
    TooLarge(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl StorageError {
    pub fn status_code(&self) -> u16 {
        match self {
            StorageError::NotFound(_) => 404,
            StorageError::Gone(_) => 410,
            StorageError::Unauthorized(_) => 401,
            StorageError::Forbidden(_) => 403,
            StorageError::Conflict(_, _) => 409,
            StorageError::BadRequest(_) => 400,
            StorageError::TooLarge(_) => 413,
            StorageError::Internal(_) => 500,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            StorageError::NotFound(_) => "not-found",
            StorageError::Gone(_) => "gone",
            StorageError::Unauthorized(_) => "unauthorized",
            StorageError::Forbidden(_) => "forbidden",
            StorageError::Conflict(_, _) => "conflict",
            StorageError::BadRequest(_) => "bad-request",
            StorageError::TooLarge(_) => "payload-too-large",
            StorageError::Internal(_) => "internal",
        }
    }

    pub fn message(&self) -> String {
        match self {
            StorageError::NotFound(m)
            | StorageError::Gone(m)
            | StorageError::Unauthorized(m)
            | StorageError::Forbidden(m)
            | StorageError::Conflict(m, _)
            | StorageError::BadRequest(m)
            | StorageError::TooLarge(m)
            | StorageError::Internal(m) => m.clone(),
        }
    }

    pub fn current_revision(&self) -> Option<i64> {
        match self {
            StorageError::Conflict(_, revision) => Some(*revision),
            _ => None,
        }
    }
}

impl From<ValidationError> for StorageError {
    fn from(error: ValidationError) -> Self {
        match error {
            ValidationError::BadRequest(message) => StorageError::BadRequest(message),
            ValidationError::TooLarge(message) => StorageError::TooLarge(message),
        }
    }
}

/// Hash a management or setup token for storage.
///
/// Only the hash is stored: persistent state must never contain a copy of a
/// credential it accepts.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    hex_of(&digest)
}

fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Length-independent comparison of two hex digests.
pub fn timing_safe_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.bytes().zip(right.bytes()) {
        difference |= a ^ b;
    }
    difference == 0
}

/// A high-entropy management token (32 random bytes, hex).
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex_of(&bytes)
}

/// The atomic operations QBLive semantics require.
///
/// Each mutation must be atomic: a successful response never acknowledges a
/// partially persisted publication state. See the durability rule in
/// `docs/QBLIVE_SERVER_CONTRACT.md`.
pub trait PublicationStorage: Send + Sync + 'static {
    /// Exchange a one-time setup token for a durable management credential.
    ///
    /// The `expected_setup_hash` is the deployment's configured setup secret
    /// (hashed); how the deployment supplies it — environment variable, file,
    /// CLI flag — is host-specific and not part of the protocol. Fails when
    /// already claimed, even with the right token.
    fn claim(
        &mut self,
        publication_id: &str,
        setup_token: &str,
        expected_setup_hash: Option<&str>,
    ) -> Result<String, StorageError>;

    /// Replace the entire public state (first publish and conflict repair).
    fn put_snapshot(&mut self, token: &str, snapshot: Value) -> Result<(i64, bool), StorageError>;

    /// Advance the publication by replacing named sections.
    fn post_sections(
        &mut self,
        token: &str,
        base_revision: i64,
        revision: i64,
        generated_at: &str,
        sections: Value,
    ) -> Result<i64, StorageError>;

    /// Publish an announcement as an `announcements` section update.
    fn post_announcement(
        &mut self,
        token: &str,
        revision: i64,
        announcement: Value,
    ) -> Result<i64, StorageError>;

    /// Freeze the publication with its last public state.
    fn finalize(
        &mut self,
        token: &str,
        revision: i64,
        snapshot: Value,
    ) -> Result<i64, StorageError>;

    /// Hide the tournament publicly while keeping it recoverable.
    fn unpublish(&mut self, token: &str) -> Result<i64, StorageError>;

    /// Destroy the publication and revoke the credential.
    fn destroy(&mut self, token: &str) -> Result<(), StorageError>;

    /// The current public snapshot, or `None` before the first publish.
    fn snapshot(&self) -> Option<Value>;
    /// The current revision (0 before the first publish).
    fn revision(&self) -> i64;
    /// The current lifecycle.
    fn lifecycle(&self) -> Option<Lifecycle>;
    /// Events with `revision > after`, oldest first, bounded by `limit`.
    fn events_after(&self, after: i64, limit: usize) -> Vec<Value>;
    /// The oldest retained event revision, if any.
    fn oldest_event_revision(&self) -> Option<i64>;
    /// The publication id, if claimed.
    fn publication_id(&self) -> Option<String>;
}

/// Reference in-memory storage.
///
/// Single-process and test-only in the sense that it holds state in process
/// memory; the *semantics* are the contract a durable implementation must
/// match revision for revision, status for status.
#[derive(Debug, Default)]
pub struct MemoryStorage {
    publication_id: Option<String>,
    revision: i64,
    lifecycle: Option<Lifecycle>,
    generated_at: String,
    management_token_hash: Option<String>,
    setup_consumed: bool,
    sections: serde_json::Map<String, Value>,
    events: std::collections::VecDeque<Value>,
    replay_window: usize,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            replay_window: REPLAY_WINDOW_FULL,
            ..Self::default()
        }
    }

    pub fn with_replay_window(replay_window: usize) -> Self {
        Self {
            replay_window,
            ..Self::default()
        }
    }

    fn require_claimed(&self) -> Result<(), StorageError> {
        if self.publication_id.is_none() {
            return Err(StorageError::NotFound("No such tournament.".to_owned()));
        }
        Ok(())
    }

    fn authorize(&self, token: &str) -> Result<(), StorageError> {
        self.require_claimed()?;
        if token.is_empty() {
            return Err(StorageError::Unauthorized(
                "A management credential is required.".to_owned(),
            ));
        }
        match &self.management_token_hash {
            None => Err(StorageError::Forbidden(
                "This backend has not been claimed yet.".to_owned(),
            )),
            Some(hash) if timing_safe_equal(&hash_token(token), hash) => Ok(()),
            Some(_) => Err(StorageError::Unauthorized(
                "That management credential is not valid.".to_owned(),
            )),
        }
    }

    fn check_body_bytes(text: &str) -> Result<(), StorageError> {
        if text.len() > MAX_BODY_BYTES {
            return Err(StorageError::TooLarge(
                "That publication update is too large.".to_owned(),
            ));
        }
        Ok(())
    }

    fn append_event(&mut self, event: Value) {
        let revision = event.get("revision").and_then(Value::as_i64).unwrap_or(0);
        if let Some(pos) = self
            .events
            .iter()
            .position(|e| e.get("revision").and_then(Value::as_i64) == Some(revision))
        {
            self.events[pos] = event;
        } else {
            self.events.push_back(event);
        }
        while self.events.len() > self.replay_window {
            self.events.pop_front();
        }
    }

    fn current_snapshot(&self) -> Option<Value> {
        let publication_id = self.publication_id.clone()?;
        if self.sections.is_empty() {
            return None;
        }
        let mut out = Value::Object(serde_json::Map::new());
        out["protocolVersion"] = Value::from(1);
        out["publicationId"] = Value::from(publication_id);
        out["revision"] = Value::from(self.revision);
        out["generatedAt"] = Value::from(self.generated_at.clone());
        out["capabilities"] =
            serde_json::from_str(crate::protocol::FULL_CAPABILITIES_JSON).unwrap_or(Value::Null);
        out["final"] = Value::from(self.lifecycle == Some(Lifecycle::Final));
        for (k, v) in &self.sections {
            out[k] = v.clone();
        }
        Some(out)
    }
}

impl PublicationStorage for MemoryStorage {
    fn claim(
        &mut self,
        publication_id: &str,
        setup_token: &str,
        expected_setup_hash: Option<&str>,
    ) -> Result<String, StorageError> {
        if !is_publication_id(publication_id) {
            return Err(StorageError::BadRequest(
                "A valid publication id is required.".to_owned(),
            ));
        }
        let expected = expected_setup_hash.ok_or_else(|| {
            StorageError::Forbidden("This backend has no setup token configured.".to_owned())
        })?;
        if self.setup_consumed {
            return Err(StorageError::Forbidden(
                "This backend has already been claimed.".to_owned(),
            ));
        }
        if !timing_safe_equal(&hash_token(setup_token), expected) {
            return Err(StorageError::Unauthorized(
                "That setup token is not valid.".to_owned(),
            ));
        }
        let token = generate_token();
        let now = "2026-01-01T00:00:00Z".to_owned();
        self.publication_id = Some(publication_id.to_owned());
        self.management_token_hash = Some(hash_token(&token));
        self.setup_consumed = true;
        self.revision = 0;
        self.lifecycle = Some(Lifecycle::Live);
        self.generated_at = now;
        self.sections.clear();
        self.events.clear();
        Ok(token)
    }

    fn put_snapshot(&mut self, token: &str, snapshot: Value) -> Result<(i64, bool), StorageError> {
        Self::check_body_bytes(&snapshot.to_string())?;
        self.authorize(token)?;
        validate_snapshot(&snapshot)?;
        let publication_id = snapshot
            .get("publicationId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if Some(publication_id) != self.publication_id.as_deref() {
            return Err(StorageError::BadRequest(
                "That snapshot is for a different publication.".to_owned(),
            ));
        }
        let revision = snapshot
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        if revision <= self.revision {
            return Err(StorageError::Conflict(
                "That revision has already been published.".to_owned(),
                self.revision,
            ));
        }
        let generated_at = snapshot
            .get("generatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let is_final = snapshot
            .get("final")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let sections = sections_of(&snapshot);
        if let Some(obj) = sections.as_object() {
            for (name, value) in obj {
                validate_section(name, value)?;
                self.sections.insert(name.clone(), value.clone());
            }
        }
        self.revision = revision;
        self.generated_at = generated_at.clone();
        self.lifecycle = Some(if is_final {
            Lifecycle::Final
        } else {
            Lifecycle::Live
        });
        let event = if is_final {
            serde_json::json!({
                "revision": revision,
                "generatedAt": generated_at,
                "sections": sections,
                "final": true,
            })
        } else {
            serde_json::json!({
                "revision": revision,
                "generatedAt": generated_at,
                "sections": sections,
            })
        };
        self.append_event(event);
        Ok((revision, is_final))
    }

    fn post_sections(
        &mut self,
        token: &str,
        base_revision: i64,
        revision: i64,
        generated_at: &str,
        sections: Value,
    ) -> Result<i64, StorageError> {
        Self::check_body_bytes(&sections.to_string())?;
        self.authorize(token)?;
        if self.lifecycle != Some(Lifecycle::Live) {
            return Err(StorageError::Conflict(
                "This tournament is no longer accepting updates.".to_owned(),
                self.revision,
            ));
        }
        if !is_valid_timestamp(generated_at) {
            return Err(StorageError::BadRequest(
                "`generatedAt` is required.".to_owned(),
            ));
        }
        if revision <= self.revision {
            return Err(StorageError::Conflict(
                "That revision has already been published.".to_owned(),
                self.revision,
            ));
        }
        if base_revision != self.revision {
            return Err(StorageError::Conflict(
                "The publication has moved on.".to_owned(),
                self.revision,
            ));
        }
        let obj = sections.as_object().ok_or_else(|| {
            StorageError::BadRequest("A section update must name at least one section.".to_owned())
        })?;
        if obj.is_empty() {
            return Err(StorageError::BadRequest(
                "A section update must name at least one section.".to_owned(),
            ));
        }
        for (name, value) in obj {
            if !crate::protocol::SECTION_NAMES.contains(&name.as_str()) {
                return Err(StorageError::BadRequest(format!(
                    "sections.{name}: unknown section"
                )));
            }
            validate_section(name, value)?;
        }
        for (name, value) in obj {
            self.sections.insert(name.clone(), value.clone());
        }
        self.revision = revision;
        self.generated_at = generated_at.to_owned();
        self.append_event(serde_json::json!({
            "revision": revision,
            "generatedAt": generated_at,
            "sections": sections,
        }));
        Ok(revision)
    }

    fn post_announcement(
        &mut self,
        token: &str,
        revision: i64,
        announcement: Value,
    ) -> Result<i64, StorageError> {
        Self::check_body_bytes(&announcement.to_string())?;
        self.authorize(token)?;
        if self.lifecycle != Some(Lifecycle::Live) {
            return Err(StorageError::Conflict(
                "This tournament is no longer accepting updates.".to_owned(),
                self.revision,
            ));
        }
        if revision <= self.revision {
            return Err(StorageError::Conflict(
                "That revision has already been published.".to_owned(),
                self.revision,
            ));
        }
        validate_section("announcements", &Value::Array(vec![announcement.clone()]))?;
        let announcement_obj = announcement
            .as_object()
            .ok_or_else(|| StorageError::BadRequest("An announcement is required.".to_owned()))?;
        let id = announcement_obj
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| StorageError::BadRequest("An announcement is required.".to_owned()))?;
        let mut existing: Vec<Value> = self
            .sections
            .get("announcements")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        existing.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
        existing.insert(0, announcement);
        existing.truncate(MAX_ANNOUNCEMENTS);
        let generated_at = existing[0]
            .get("updatedAt")
            .and_then(Value::as_str)
            .or_else(|| existing[0].get("publishedAt").and_then(Value::as_str))
            .unwrap_or("2026-01-01T00:00:00Z")
            .to_owned();
        self.sections
            .insert("announcements".to_owned(), Value::Array(existing.clone()));
        self.revision = revision;
        self.generated_at = generated_at.clone();
        self.append_event(serde_json::json!({
            "revision": revision,
            "generatedAt": generated_at,
            "sections": { "announcements": existing },
        }));
        Ok(revision)
    }

    fn finalize(
        &mut self,
        token: &str,
        revision: i64,
        snapshot: Value,
    ) -> Result<i64, StorageError> {
        Self::check_body_bytes(&snapshot.to_string())?;
        self.authorize(token)?;
        validate_snapshot(&snapshot)?;
        if revision <= self.revision {
            return Err(StorageError::Conflict(
                "That revision has already been published.".to_owned(),
                self.revision,
            ));
        }
        let sections = sections_of(&snapshot);
        if let Some(obj) = sections.as_object() {
            for (name, value) in obj {
                self.sections.insert(name.clone(), value.clone());
            }
        }
        let generated_at = snapshot
            .get("generatedAt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        self.revision = revision;
        self.generated_at = generated_at.clone();
        self.lifecycle = Some(Lifecycle::Final);
        self.append_event(serde_json::json!({
            "revision": revision,
            "generatedAt": generated_at,
            "sections": sections,
            "final": true,
        }));
        Ok(revision)
    }

    fn unpublish(&mut self, token: &str) -> Result<i64, StorageError> {
        self.authorize(token)?;
        self.lifecycle = Some(Lifecycle::Unpublished);
        Ok(self.revision)
    }

    fn destroy(&mut self, token: &str) -> Result<(), StorageError> {
        self.authorize(token)?;
        self.publication_id = None;
        self.management_token_hash = None;
        self.revision = 0;
        self.lifecycle = None;
        self.sections.clear();
        self.events.clear();
        // The setup stays consumed: a deleted backend cannot be reclaimed
        // without its setup secret, matching the Cloudflare `deleteAll`
        // behavior where a later request needs the setup token again.
        Ok(())
    }

    fn snapshot(&self) -> Option<Value> {
        self.current_snapshot()
    }

    fn revision(&self) -> i64 {
        self.revision
    }

    fn lifecycle(&self) -> Option<Lifecycle> {
        self.lifecycle
    }

    fn events_after(&self, after: i64, limit: usize) -> Vec<Value> {
        self.events
            .iter()
            .filter(|e| {
                e.get("revision")
                    .and_then(Value::as_i64)
                    .is_some_and(|r| r > after)
            })
            .take(limit)
            .cloned()
            .collect()
    }

    fn oldest_event_revision(&self) -> Option<i64> {
        self.events
            .front()
            .and_then(|e| e.get("revision").and_then(Value::as_i64))
    }

    fn publication_id(&self) -> Option<String> {
        self.publication_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn setup_hash() -> String {
        hash_token("test-setup-token")
    }

    #[test]
    fn claim_is_one_time_and_hashes_credentials() {
        let mut store = MemoryStorage::new();
        let token = store
            .claim(
                "bcdfghjkmnpqrstvwxyz",
                "test-setup-token",
                Some(&setup_hash()),
            )
            .unwrap();
        assert_eq!(token.len(), 64);
        let second = store.claim(
            "bcdfghjkmnpqrstvwxyz",
            "test-setup-token",
            Some(&setup_hash()),
        );
        assert!(matches!(second, Err(StorageError::Forbidden(_))));
        let wrong =
            MemoryStorage::new().claim("bcdfghjkmnpqrstvwxyz", "wrong", Some(&setup_hash()));
        assert!(matches!(wrong, Err(StorageError::Unauthorized(_))));
    }

    #[test]
    fn tokens_compare_without_leaking_length() {
        assert!(timing_safe_equal(&hash_token("a"), &hash_token("a")));
        assert!(!timing_safe_equal(&hash_token("a"), &hash_token("b")));
        assert!(!timing_safe_equal("short", &hash_token("a")));
    }

    #[test]
    fn snapshot_round_trip_sets_revision_and_sections() {
        let mut store = MemoryStorage::new();
        let token = store
            .claim(
                "bcdfghjkmnpqrstvwxyz",
                "test-setup-token",
                Some(&setup_hash()),
            )
            .unwrap();
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/qblive-protocol/fixtures/snapshot-default.json"
        ));
        let mut snapshot: Value = serde_json::from_str(raw).unwrap();
        snapshot["revision"] = json!(1);
        let (revision, is_final) = store.put_snapshot(&token, snapshot).unwrap();
        assert_eq!(revision, 1);
        assert!(!is_final);
        assert_eq!(store.revision(), 1);
        assert!(store.snapshot().is_some());
    }

    #[test]
    fn stale_revisions_conflict_with_the_current_one() {
        let mut store = MemoryStorage::new();
        let token = store
            .claim(
                "bcdfghjkmnpqrstvwxyz",
                "test-setup-token",
                Some(&setup_hash()),
            )
            .unwrap();
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/qblive-protocol/fixtures/snapshot-default.json"
        ));
        let mut first: Value = serde_json::from_str(raw).unwrap();
        first["revision"] = json!(5);
        store.put_snapshot(&token, first).unwrap();
        let mut stale: Value = serde_json::from_str(raw).unwrap();
        stale["revision"] = json!(3);
        let error = store.put_snapshot(&token, stale).unwrap_err();
        assert!(matches!(error, StorageError::Conflict(_, 5)));
    }
}
