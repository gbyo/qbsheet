//! QBSheet Live: durable publication state and the management credential.
//!
//! # What is here and what is not
//!
//! The *derivation* of the public projection is TypeScript, in
//! `packages/qblive-projection`, and it stays there: it is a pure function over the tournament
//! document, and a second implementation in Rust would be a second thing to keep correct with the
//! privacy tests only covering one of them.
//!
//! What Rust owns is the two things TypeScript cannot do safely:
//!
//! 1. **The credential.** A management credential must not be in the tournament document, because
//!    a Director file gets emailed and opened on a co-director's laptop. It goes in the operating
//!    system's credential store.
//! 2. **The outbox's durability.** The outbox travels inside the document and is therefore already
//!    written in the same transaction as the change that produced it. This module adds the
//!    normalized projection of it — queryable rows, so a Director who lost power mid-tournament can
//!    be told what was pending, and so a recovery tool has something to read.
//!
//! See `docs/QBLIVE.md#8-the-durable-outbox`.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

/// The keychain service every QBSheet Live credential is filed under.
pub const CREDENTIAL_SERVICE: &str = "com.qbsheet.director.qblive";

#[derive(Debug, thiserror::Error)]
pub enum LiveError {
    #[error("the QBSheet Live credential store is unavailable: {0}")]
    CredentialStore(String),
    #[error("that is not a valid QBSheet Live publication identifier")]
    InvalidPublicationId,
    #[error("QBSheet Live database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// A publication id, validated before it becomes a keychain account or a SQL parameter.
///
/// Twenty characters from a fixed vowel-free alphabet. The check is cheap and it is the only thing
/// between a value that arrived over the Tauri bridge and a keychain entry named after it.
pub fn is_publication_id(value: &str) -> bool {
    value.len() == 20
        && value
            .chars()
            .all(|character| matches!(character, '0'..='9' | 'b'..='d' | 'f'..='h' | 'j'..='n' | 'p'..='t' | 'v'..='z'))
}

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

/// Store a management credential in the OS credential store.
///
/// # Why this is a trait rather than a direct call
///
/// The desktop platforms each have a different credential store, and CI has none. Keeping the
/// boundary explicit means the SQLite and outbox logic below is testable without a keychain, and
/// means a platform without one degrades to a clear error rather than to a silent plaintext file.
pub trait CredentialStore: Send + Sync {
    fn store(&self, account: &str, secret: &str) -> Result<(), LiveError>;
    fn read(&self, account: &str) -> Result<Option<String>, LiveError>;
    fn forget(&self, account: &str) -> Result<(), LiveError>;
}

/// The macOS keychain, reached through `security(1)`.
///
/// Shelling out rather than linking a crate: this is three operations on a desktop app's own
/// keychain, `security` is present on every macOS install, and it avoids adding a dependency that
/// would also have to be audited for a tournament-control application. The secret is passed with
/// `-w` and is therefore visible in this process's argv for the life of one short command — a
/// tradeoff noted here rather than hidden, and the reason a future move to the Security framework
/// would be an improvement rather than a rewrite.
#[cfg(target_os = "macos")]
pub struct KeychainCredentialStore;

#[cfg(target_os = "macos")]
impl CredentialStore for KeychainCredentialStore {
    fn store(&self, account: &str, secret: &str) -> Result<(), LiveError> {
        let output = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-s",
                CREDENTIAL_SERVICE,
                "-a",
                account,
                "-w",
                secret,
                // Replace an existing entry rather than failing: re-pairing a backend is ordinary.
                "-U",
            ])
            .output()
            .map_err(|error| LiveError::CredentialStore(error.to_string()))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(LiveError::CredentialStore(
                String::from_utf8_lossy(&output.stderr).trim().to_string(),
            ))
        }
    }

    fn read(&self, account: &str) -> Result<Option<String>, LiveError> {
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                CREDENTIAL_SERVICE,
                "-a",
                account,
                "-w",
            ])
            .output()
            .map_err(|error| LiveError::CredentialStore(error.to_string()))?;
        if output.status.success() {
            Ok(Some(
                String::from_utf8_lossy(&output.stdout).trim().to_string(),
            ))
        } else {
            // `security` exits non-zero for "not found" as well as for a real failure. Treating a
            // missing entry as absent rather than as an error is right: a fresh machine has none.
            Ok(None)
        }
    }

    fn forget(&self, account: &str) -> Result<(), LiveError> {
        let _ = std::process::Command::new("security")
            .args([
                "delete-generic-password",
                "-s",
                CREDENTIAL_SERVICE,
                "-a",
                account,
            ])
            .output();
        Ok(())
    }
}

/// Windows and Linux.
///
/// Not yet implemented, and deliberately an error rather than a file. A credential written to disk
/// in plaintext because the platform's store was inconvenient is worse than a Director being told
/// to re-enter it: the first is a silent, permanent disclosure and the second is an annoyance.
#[cfg(not(target_os = "macos"))]
pub struct KeychainCredentialStore;

#[cfg(not(target_os = "macos"))]
impl CredentialStore for KeychainCredentialStore {
    fn store(&self, _account: &str, _secret: &str) -> Result<(), LiveError> {
        Err(LiveError::CredentialStore(
            "This build cannot store a QBSheet Live credential securely on this platform. \
             The credential is kept for this session only and will need re-entering."
                .to_string(),
        ))
    }

    fn read(&self, _account: &str) -> Result<Option<String>, LiveError> {
        Ok(None)
    }

    fn forget(&self, _account: &str) -> Result<(), LiveError> {
        Ok(())
    }
}

/// An in-memory store, for tests.
///
/// Not offered as a runtime fallback: a credential that survives only until the process exits, on a
/// platform where the Director expected it to persist, is a confusing failure. The platform without
/// a keychain gets an explicit error instead.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore {
    entries: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn store(&self, account: &str, secret: &str) -> Result<(), LiveError> {
        self.entries
            .lock()
            .map_err(|_| LiveError::CredentialStore("poisoned".into()))?
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn read(&self, account: &str) -> Result<Option<String>, LiveError> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| LiveError::CredentialStore("poisoned".into()))?
            .get(account)
            .cloned())
    }

    fn forget(&self, account: &str) -> Result<(), LiveError> {
        self.entries
            .lock()
            .map_err(|_| LiveError::CredentialStore("poisoned".into()))?
            .remove(account);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The normalized projection of publication state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePublicationRow {
    pub publication_id: String,
    pub backend_kind: String,
    pub backend_origin: String,
    pub lifecycle: String,
    pub local_revision: i64,
    pub acknowledged_revision: i64,
    pub pending_items: i64,
    pub last_success_at: Option<String>,
    pub last_error: Option<String>,
}

/// Create the QBSheet Live tables.
///
/// Called from the store's migration chain. Separate from `store.rs`'s migrations only in where the
/// SQL lives; the version number is the store's.
pub fn create_tables(transaction: &rusqlite::Transaction<'_>) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS live_publications (
            publication_id TEXT PRIMARY KEY,
            backend_kind TEXT NOT NULL DEFAULT 'custom',
            backend_origin TEXT NOT NULL DEFAULT '',
            lifecycle TEXT NOT NULL DEFAULT 'disabled',
            enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
            settings_json TEXT NOT NULL DEFAULT '{}',
            local_revision INTEGER NOT NULL DEFAULT 0,
            acknowledged_revision INTEGER NOT NULL DEFAULT 0,
            last_success_at TEXT,
            last_error TEXT,
            public_url TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Deliberately no credential column. A management credential lives in the operating
        -- system's credential store, never in the tournament database, because the database is
        -- copied to USB sticks and emailed between co-directors.

        CREATE TABLE IF NOT EXISTS live_outbox (
            id TEXT PRIMARY KEY,
            publication_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_attempt_at TEXT,
            next_attempt_at TEXT,
            last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS live_outbox_pending_idx
            ON live_outbox(publication_id, state, next_attempt_at);

        CREATE TABLE IF NOT EXISTS live_announcements (
            id TEXT PRIMARY KEY,
            publication_id TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'information',
            audience_json TEXT NOT NULL DEFAULT '[]',
            published_at TEXT NOT NULL,
            updated_at TEXT,
            expires_at TEXT,
            withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS live_announcements_publication_idx
            ON live_announcements(publication_id, published_at);
        ",
    )
}

/// Project the document's `live` block into the normalized tables.
///
/// Called from `sync_normalized_state`, inside the same transaction as the document write. That is
/// the whole point: Director cannot save an accepted result and lose the knowledge that the result
/// needs publishing, because both are one commit.
pub fn sync_publication(
    transaction: &rusqlite::Transaction<'_>,
    state: &Value,
) -> Result<(), rusqlite::Error> {
    transaction.execute_batch(
        "DELETE FROM live_outbox; DELETE FROM live_announcements; DELETE FROM live_publications;",
    )?;

    let Some(live) = state.get("live").filter(|value| value.is_object()) else {
        return Ok(());
    };
    let Some(publication_id) = live.get("publicationId").and_then(Value::as_str) else {
        return Ok(());
    };
    if !is_publication_id(publication_id) {
        return Ok(());
    }

    let settings = live.get("settings").cloned().unwrap_or(Value::Null);
    let sync = live.get("sync").cloned().unwrap_or(Value::Null);
    let backend = live.get("backend").cloned().unwrap_or(Value::Null);

    transaction.execute(
        "INSERT INTO live_publications (
            publication_id, backend_kind, backend_origin, lifecycle, enabled, settings_json,
            local_revision, acknowledged_revision, last_success_at, last_error, public_url,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            publication_id,
            backend
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("custom"),
            backend.get("origin").and_then(Value::as_str).unwrap_or(""),
            live.get("lifecycle")
                .and_then(Value::as_str)
                .unwrap_or("disabled"),
            i64::from(
                settings
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            ),
            settings.to_string(),
            sync.get("localRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            sync.get("acknowledgedRevision")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            sync.get("lastSuccessAt").and_then(Value::as_str),
            sync.get("lastError").and_then(Value::as_str),
            live.get("publicUrl").and_then(Value::as_str),
            live.get("createdAt").and_then(Value::as_str).unwrap_or(""),
            live.get("updatedAt").and_then(Value::as_str).unwrap_or(""),
        ],
    )?;

    if let Some(items) = live.get("outbox").and_then(Value::as_array) {
        for item in items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            transaction.execute(
                "INSERT INTO live_outbox (
                    id, publication_id, revision, kind, payload_json, state, attempts,
                    created_at, last_attempt_at, next_attempt_at, last_error
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    publication_id,
                    item.get("revision").and_then(Value::as_i64).unwrap_or(0),
                    item.get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("sections"),
                    item.get("payload")
                        .cloned()
                        .unwrap_or(Value::Null)
                        .to_string(),
                    item.get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("pending"),
                    item.get("attempts").and_then(Value::as_i64).unwrap_or(0),
                    item.get("createdAt").and_then(Value::as_str).unwrap_or(""),
                    item.get("lastAttemptAt").and_then(Value::as_str),
                    item.get("nextAttemptAt").and_then(Value::as_str),
                    item.get("lastError").and_then(Value::as_str),
                ],
            )?;
        }
    }

    if let Some(announcements) = live.get("announcements").and_then(Value::as_array) {
        for announcement in announcements {
            let Some(id) = announcement.get("id").and_then(Value::as_str) else {
                continue;
            };
            transaction.execute(
                "INSERT INTO live_announcements (
                    id, publication_id, title, body, severity, audience_json,
                    published_at, updated_at, expires_at, withdrawn
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    publication_id,
                    announcement
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    announcement
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    announcement
                        .get("severity")
                        .and_then(Value::as_str)
                        .unwrap_or("information"),
                    announcement
                        .get("audienceTeamIds")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]))
                        .to_string(),
                    announcement
                        .get("publishedAt")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    announcement.get("updatedAt").and_then(Value::as_str),
                    announcement.get("expiresAt").and_then(Value::as_str),
                    i64::from(
                        announcement
                            .get("withdrawn")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    ),
                ],
            )?;
        }
    }

    Ok(())
}

/// The publication as the normalized tables see it.
///
/// Used by diagnostics and by recovery tooling: after a crash, this answers "what had Director not
/// yet published" without having to parse the whole document.
pub fn read_publication(
    connection: &Connection,
) -> Result<Option<LivePublicationRow>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT p.publication_id, p.backend_kind, p.backend_origin, p.lifecycle,
                    p.local_revision, p.acknowledged_revision,
                    (SELECT COUNT(*) FROM live_outbox o WHERE o.publication_id = p.publication_id
                       AND o.state != 'done'),
                    p.last_success_at, p.last_error
               FROM live_publications p LIMIT 1",
            [],
            |row| {
                Ok(LivePublicationRow {
                    publication_id: row.get(0)?,
                    backend_kind: row.get(1)?,
                    backend_origin: row.get(2)?,
                    lifecycle: row.get(3)?,
                    local_revision: row.get(4)?,
                    acknowledged_revision: row.get(5)?,
                    pending_items: row.get(6)?,
                    last_success_at: row.get(7)?,
                    last_error: row.get(8)?,
                })
            },
        )
        .optional()
}

/// Whether a database file has QBSheet Live tables.
///
/// Used by the diagnostics bundle, which reports on a database file the application may not have
/// open — a backup, or a copy a Director was asked to send in.
pub fn tables_exist(path: &Path) -> bool {
    let Ok(connection) = Connection::open(path) else {
        return false;
    };
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'live_publications'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open() -> Connection {
        let connection = Connection::open_in_memory().expect("open");
        let transaction = connection.unchecked_transaction().expect("transaction");
        create_tables(&transaction).expect("create");
        transaction.commit().expect("commit");
        connection
    }

    fn document(pending: usize) -> Value {
        json!({
            "live": {
                "publicationId": "bcdfghjkmnpqrstvwxyz",
                "lifecycle": "live",
                "settings": { "enabled": true, "liveScores": false },
                "backend": { "kind": "cloudflare", "origin": "https://x.example" },
                "sync": {
                    "localRevision": 41,
                    "acknowledgedRevision": 40,
                    "pendingItems": pending,
                    "lastSuccessAt": "2026-09-05T14:00:00Z",
                    "lastError": null
                },
                "outbox": (0..pending)
                    .map(|index| json!({
                        "id": format!("outbox-{index}"),
                        "revision": 41 + index,
                        "kind": "sections",
                        "payload": { "sections": { "liveGames": [] } },
                        "state": "pending",
                        "attempts": 0,
                        "createdAt": "2026-09-05T14:00:00Z"
                    }))
                    .collect::<Vec<_>>(),
                "announcements": [{
                    "id": "announcement-1",
                    "title": "Round 2",
                    "body": "Be in your rooms.",
                    "severity": "important",
                    "audienceTeamIds": [],
                    "publishedAt": "2026-09-05T13:50:00Z"
                }],
                "publicUrl": "https://live.qbsheet.com/t/bcdfghjkmnpqrstvwxyz?b=https%3A%2F%2Fx.example&v=1",
                "createdAt": "2026-09-05T12:00:00Z",
                "updatedAt": "2026-09-05T14:00:00Z"
            }
        })
    }

    #[test]
    fn publication_state_projects_into_queryable_rows() {
        let connection = open();
        let transaction = connection.unchecked_transaction().expect("transaction");
        sync_publication(&transaction, &document(3)).expect("sync");
        transaction.commit().expect("commit");

        let row = read_publication(&connection)
            .expect("read")
            .expect("a publication");
        assert_eq!(row.publication_id, "bcdfghjkmnpqrstvwxyz");
        assert_eq!(row.backend_kind, "cloudflare");
        assert_eq!(row.local_revision, 41);
        assert_eq!(row.acknowledged_revision, 40);
        // The count comes from the rows, not from the document's own tally: after a crash the
        // rows are what survived, and a stale counter would be a lie.
        assert_eq!(row.pending_items, 3);
    }

    #[test]
    fn a_document_without_live_projects_nothing() {
        let connection = open();
        let transaction = connection.unchecked_transaction().expect("transaction");
        sync_publication(&transaction, &json!({ "live": null })).expect("sync");
        transaction.commit().expect("commit");
        assert!(read_publication(&connection).expect("read").is_none());
    }

    #[test]
    fn the_projection_is_replaced_rather_than_accumulated() {
        let connection = open();
        for pending in [5, 2] {
            let transaction = connection.unchecked_transaction().expect("transaction");
            sync_publication(&transaction, &document(pending)).expect("sync");
            transaction.commit().expect("commit");
        }
        assert_eq!(
            read_publication(&connection)
                .expect("read")
                .unwrap()
                .pending_items,
            2
        );
    }

    #[test]
    fn no_credential_column_exists() {
        // The rule this enforces is the whole reason the credential lives elsewhere: a tournament
        // database gets copied to a USB stick. A future migration that added a convenient
        // `credential` column would break it silently, so the schema itself is asserted.
        let connection = open();
        let mut statement = connection
            .prepare("SELECT name FROM pragma_table_info('live_publications')")
            .expect("prepare");
        let columns: Vec<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert!(
            !columns
                .iter()
                .any(|column| column.contains("credential") || column.contains("token")),
            "the QBSheet Live tables must never hold a credential: {columns:?}"
        );
    }

    #[test]
    fn a_forged_publication_id_is_refused() {
        assert!(is_publication_id("bcdfghjkmnpqrstvwxyz"));
        assert!(!is_publication_id("../../etc/passwd"));
        assert!(!is_publication_id("BCDFGHJKMNPQRSTVWXYZ"));
        assert!(!is_publication_id("aeiouaeiouaeiouaeiou"));
        assert!(!is_publication_id("short"));

        let connection = open();
        let transaction = connection.unchecked_transaction().expect("transaction");
        let mut forged = document(1);
        forged["live"]["publicationId"] = json!("../../etc/passwd");
        sync_publication(&transaction, &forged).expect("sync");
        transaction.commit().expect("commit");
        assert!(read_publication(&connection).expect("read").is_none());
    }

    #[test]
    fn the_memory_credential_store_round_trips() {
        let store = MemoryCredentialStore::default();
        assert_eq!(store.read("pub").expect("read"), None);
        store.store("pub", "secret").expect("store");
        assert_eq!(store.read("pub").expect("read").as_deref(), Some("secret"));
        store.forget("pub").expect("forget");
        assert_eq!(store.read("pub").expect("read"), None);
    }
}
