use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, Transaction, TransactionBehavior};

use crate::error::{StoreError, StoreResult};
use crate::migrations;
use crate::util::{new_id, now};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointMode {
    Passive,
    Full,
    Restart,
    Truncate,
}

impl CheckpointMode {
    fn as_sql(self) -> &'static str {
        match self {
            Self::Passive => "PASSIVE",
            Self::Full => "FULL",
            Self::Restart => "RESTART",
            Self::Truncate => "TRUNCATE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointReport {
    pub mode: CheckpointMode,
    pub busy: i64,
    pub wal_pages: i64,
    pub checkpointed_pages: i64,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupReport {
    pub destination: PathBuf,
    pub pages_copied: Option<i64>,
}

pub struct Store {
    connection: Connection,
    path: Option<PathBuf>,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        let path = path.as_ref().to_path_buf();
        let connection = Connection::open(&path)?;
        configure_connection(&connection, true)?;
        migrations::apply(&connection)?;
        Ok(Self {
            connection,
            path: Some(path),
        })
    }

    pub fn open_in_memory() -> StoreResult<Self> {
        let connection = Connection::open_in_memory()?;
        configure_connection(&connection, false)?;
        migrations::apply(&connection)?;
        Ok(Self {
            connection,
            path: None,
        })
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> StoreResult<u32> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| {
                row.get::<_, i64>(0).map(|version| version as u32)
            })?)
    }

    pub fn journal_mode(&self) -> StoreResult<String> {
        Ok(self
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }

    pub fn foreign_keys_enabled(&self) -> StoreResult<bool> {
        Ok(self
            .connection
            .query_row("PRAGMA foreign_keys", [], |row| {
                row.get::<_, i64>(0).map(|value| value != 0)
            })?)
    }

    pub fn checkpoint(&self, mode: CheckpointMode) -> StoreResult<CheckpointReport> {
        let (busy, wal_pages, checkpointed_pages): (i64, i64, i64) = self.connection.query_row(
            &format!("PRAGMA wal_checkpoint({})", mode.as_sql()),
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let recorded_at = now();
        self.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO store_checkpoints
                    (id, label, database_path, wal_pages, wal_checkpointed, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    new_id(),
                    format!("wal-{}", mode.as_sql().to_ascii_lowercase()),
                    self.path
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned()),
                    wal_pages,
                    checkpointed_pages,
                    recorded_at,
                ],
            )?;
            Ok(())
        })?;
        Ok(CheckpointReport {
            mode,
            busy,
            wal_pages,
            checkpointed_pages,
            recorded_at,
        })
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> StoreResult<BackupReport> {
        let destination = destination.as_ref().to_path_buf();
        if destination.exists() {
            return Err(StoreError::BackupDestinationExists(destination));
        }
        let parent = match destination.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            Some(_) => PathBuf::from("."),
            None => {
                return Err(StoreError::BackupDestinationHasNoParent(
                    destination.clone(),
                ))
            }
        };
        if !parent.exists() {
            return Err(StoreError::BackupDestinationHasNoParent(
                parent.to_path_buf(),
            ));
        }

        let file_name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("qbsheet-backup");
        let temporary = parent.join(format!(".{file_name}.{}.tmp", new_id()));
        let result = (|| -> StoreResult<BackupReport> {
            let mut target = Connection::open(&temporary)?;
            configure_connection(&target, false)?;
            let pages_copied = {
                let backup = Backup::new(&self.connection, &mut target)?;
                backup.run_to_completion(128, Duration::from_millis(10), None)?;
                backup.progress().pagecount as i64
            };
            target.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            target
                .close()
                .map_err(|(_, error)| StoreError::Database(error))?;

            sync_file(&temporary)?;
            commit_backup_no_replace(&temporary, &destination)?;
            sync_directory(&parent)?;
            Ok(BackupReport {
                destination: destination.clone(),
                pages_copied: Some(pages_copied),
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn write_transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let transaction =
            Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }
}

/// Publish a completed backup without replacing a destination that may have
/// appeared after the initial existence check. The temporary file is created
/// in the destination directory, so a hard link is an atomic no-replace
/// directory operation on the supported platforms/filesystems. Removing the
/// temporary name leaves the newly published destination in place.
fn commit_backup_no_replace(temporary: &Path, destination: &Path) -> StoreResult<()> {
    match fs::hard_link(temporary, destination) {
        Ok(()) => {
            fs::remove_file(temporary)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
            StoreError::BackupDestinationExists(destination.to_path_buf()),
        ),
        Err(error) => Err(StoreError::Filesystem(error)),
    }
}

fn configure_connection(connection: &Connection, enable_wal: bool) -> StoreResult<()> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    if enable_wal {
        connection.pragma_update(None, "journal_mode", "WAL")?;
    }
    Ok(())
}

fn sync_file(path: &Path) -> StoreResult<()> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    Ok(())
}

fn sync_directory(path: &Path) -> StoreResult<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::commit_backup_no_replace;
    use crate::error::StoreError;

    #[test]
    fn backup_commit_does_not_replace_a_destination_created_after_precheck() {
        let directory = tempdir().expect("temporary directory");
        let temporary = directory.path().join(".backup.tmp");
        let destination = directory.path().join("backup.sqlite3");
        fs::write(&temporary, b"new backup").expect("write temporary backup");
        fs::write(&destination, b"original backup").expect("create destination");

        let error = commit_backup_no_replace(&temporary, &destination).unwrap_err();
        assert!(matches!(error, StoreError::BackupDestinationExists(path) if path == destination));
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"original backup"
        );
        assert!(
            temporary.exists(),
            "failed commit should leave cleanup to caller"
        );
    }
}
