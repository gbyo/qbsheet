use std::path::PathBuf;

use thiserror::Error;

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("filesystem error: {0}")]
    Filesystem(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("not found: {entity} {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("unsupported schema version {version}; current version is {current}")]
    UnsupportedSchemaVersion { version: u32, current: u32 },

    #[error("backup destination already exists: {0}")]
    BackupDestinationExists(PathBuf),

    #[error("backup destination has no parent directory: {0}")]
    BackupDestinationHasNoParent(PathBuf),
}

impl StoreError {
    pub(crate) fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }
}
