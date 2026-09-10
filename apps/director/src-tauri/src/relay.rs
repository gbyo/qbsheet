//! Internet QBTCP: the relay management credential.
//!
//! # What is here and what is not
//!
//! This module owns exactly one thing: durable, OS-backed storage for the tournament relay's
//! management credential. The relay URL, tournament id, and sync state are TypeScript's
//! concern (`src/director/relay/`); the ongoing relay synchronization is #773's. What Rust
//! owns is what TypeScript cannot do safely — keep a secret out of the tournament document,
//! which gets emailed and opened on other machines — so the secret goes in the operating
//! system's credential store, under its own keychain service, separate from QBLive's.
//!
//! The keychain account is the relay tournament id, validated before it names an entry: it
//! arrives over the Tauri bridge, and an unvalidated value would name an arbitrary keychain
//! entry. The id rule mirrors the relay's own `isTournamentId`: 24 lowercase consonants and
//! digits.

/// The keychain service every Internet QBTCP relay credential is filed under.
///
/// Separate from QBSheet Live's (`com.qbsheet.director.qblive`) on purpose: the two
/// credentials authorize different backends, and one forget operation must never revoke the
/// other.
pub const CREDENTIAL_SERVICE: &str = "com.qbsheet.director.qbtcp-relay";

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("the relay credential store is unavailable: {0}")]
    CredentialStore(String),
    #[error("that is not a valid relay tournament identifier")]
    InvalidTournamentId,
}

/// A relay tournament id, validated before it becomes a keychain account.
///
/// Twenty-four characters from the relay's bounded alphabet. The check is cheap and it is the
/// only thing between a value that arrived over the Tauri bridge and a keychain entry named
/// after it.
pub fn is_tournament_id(value: &str) -> bool {
    if value.len() != 24 {
        return false;
    }
    value.chars().all(|character| {
        matches!(
            character,
            '0'..='9' | 'b'..='d' | 'f'..='h' | 'j'..='n' | 'p'..='t' | 'v'..='z'
        )
    })
}

// ---------------------------------------------------------------------------
// Credential storage
// ---------------------------------------------------------------------------

/// Store a relay management credential in the OS credential store.
///
/// # Why this is a trait rather than a direct call
///
/// The desktop platforms each have a different credential store, and CI has none. Keeping the
/// boundary explicit means the command layer is testable without a keychain, and means a
/// platform without one degrades to a clear error rather than to a silent plaintext file.
pub trait CredentialStore: Send + Sync {
    fn probe(&self) -> Result<(), RelayError>;
    fn store(&self, account: &str, secret: &str) -> Result<(), RelayError>;
    fn read(&self, account: &str) -> Result<Option<String>, RelayError>;
    fn forget(&self, account: &str) -> Result<(), RelayError>;
}

/// macOS Keychain, Windows Credential Manager and Linux Secret Service.
///
/// `keyring` selects the native credential backend at compile time. There is deliberately no
/// plaintext or in-memory runtime fallback: Director probes this store before consuming a
/// one-time relay setup secret, so an unavailable desktop keyring fails safely before the
/// claim.
#[derive(Default)]
pub struct KeychainCredentialStore;

impl CredentialStore for KeychainCredentialStore {
    fn probe(&self) -> Result<(), RelayError> {
        const ACCOUNT: &str = "credential-store-probe";
        self.store(ACCOUNT, "qbsheet-probe")?;
        let read = self.read(ACCOUNT)?;
        self.forget(ACCOUNT)?;
        if read.as_deref() == Some("qbsheet-probe") {
            Ok(())
        } else {
            Err(RelayError::CredentialStore(
                "the operating system credential store did not retain a test credential".into(),
            ))
        }
    }

    fn store(&self, account: &str, secret: &str) -> Result<(), RelayError> {
        keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|error| RelayError::CredentialStore(error.to_string()))
    }

    fn read(&self, account: &str) -> Result<Option<String>, RelayError> {
        match keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .and_then(|entry| entry.get_password())
        {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(RelayError::CredentialStore(error.to_string())),
        }
    }

    fn forget(&self, account: &str) -> Result<(), RelayError> {
        match keyring::Entry::new(CREDENTIAL_SERVICE, account)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(RelayError::CredentialStore(error.to_string())),
        }
    }
}

/// An in-memory store, for tests.
///
/// Not offered as a runtime fallback: a credential that survives only until the process exits,
/// on a platform where the Director expected it to persist, is a confusing failure. The
/// platform without a keychain gets an explicit error instead.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct MemoryCredentialStore {
    entries: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, String>>>,
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn probe(&self) -> Result<(), RelayError> {
        Ok(())
    }

    fn store(&self, account: &str, secret: &str) -> Result<(), RelayError> {
        self.entries
            .lock()
            .map_err(|_| RelayError::CredentialStore("poisoned".into()))?
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn read(&self, account: &str) -> Result<Option<String>, RelayError> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| RelayError::CredentialStore("poisoned".into()))?
            .get(account)
            .cloned())
    }

    fn forget(&self, account: &str) -> Result<(), RelayError> {
        self.entries
            .lock()
            .map_err(|_| RelayError::CredentialStore("poisoned".into()))?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tournament_id_rule_matches_the_relay() {
        assert!(is_tournament_id("bcdfghjkmnpqrstvwxyz1234"));
        assert!(is_tournament_id("000000000000000000000000"));
        for bad in [
            "",
            "short",
            "AAAAAAAAAAAAAAAAAAAAAAAA",
            "aeiouaeiouaeiouaeiouae12",
            "bcdfghjkmnpqrstvwxyz12345",
            "bcdfghjkmnpqrstvwxyz123!",
            "../etc/../etc/../etc/..",
        ] {
            assert!(!is_tournament_id(bad), "{bad:?} must not name a keychain entry");
        }
    }

    #[test]
    fn memory_store_round_trips_and_forgets() {
        let store = MemoryCredentialStore::default();
        store.probe().expect("probe");
        assert_eq!(store.read("bcdfghjkmnpqrstvwxyz1234").expect("read"), None);
        store
            .store("bcdfghjkmnpqrstvwxyz1234", "management-credential")
            .expect("store");
        assert_eq!(
            store.read("bcdfghjkmnpqrstvwxyz1234").expect("read"),
            Some("management-credential".to_string())
        );
        // A restart over the same store keeps the secret: clone shares the map.
        let after_restart = store.clone();
        assert_eq!(
            after_restart.read("bcdfghjkmnpqrstvwxyz1234").expect("read"),
            Some("management-credential".to_string())
        );
        after_restart
            .forget("bcdfghjkmnpqrstvwxyz1234")
            .expect("forget");
        assert_eq!(store.read("bcdfghjkmnpqrstvwxyz1234").expect("read"), None);
    }

    #[test]
    fn relay_and_live_services_do_not_collide() {
        assert_ne!(CREDENTIAL_SERVICE, crate::live::CREDENTIAL_SERVICE);
    }
}
