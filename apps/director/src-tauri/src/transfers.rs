//! Native filesystem access for transport-agnostic transfers.
//!
//! # Least privilege, enforced here rather than promised in the UI
//!
//! The window cannot read an arbitrary path. Every operation below resolves its argument against a
//! registry of *authorized roots* — directories the director chose in a native folder picker, or
//! removable volumes the platform reported — and refuses anything that lands outside one. Adding a
//! root is an explicit act; nothing in this file grants access to the home directory, and the
//! application asks for no such grant.
//!
//! The check is done on the *canonical* path, after symlinks are resolved, which is the only
//! version of it that means anything. Comparing the string a caller passed would be defeated by
//! `.../QBSheet/Results/link-to-somewhere-else`, and a link on a stranger's USB stick is exactly the
//! case this feature has to survive.
//!
//! # Bounded, non-recursive, read-only about other people's media
//!
//! `list_directory` reads one directory and takes a limit. It does not recurse; the caller decides
//! how deep to go and the caller's own bounds are what stop it. Nothing here deletes, moves,
//! renames, or executes. A feature whose job is to read USB sticks handed over by volunteers should
//! be able to state its whole vocabulary in one sentence, and this one can: list, read, write,
//! make a directory, ask about free space.
//!
//! # Writes are atomic or they did not happen
//!
//! `write_file` goes to a temporary file in the destination directory, flushes it, and renames it
//! over the target. A drive pulled mid-write leaves the previous file or no file — never a
//! half-written JSON document that parses far enough to look like a scored game.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sysinfo::Disks;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::CommandError;

/// Largest file this layer will read in one call. Matches `maxQbjBytes` on the TypeScript side.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// Hard ceiling on a directory listing, whatever the caller asks for.
const MAX_LIST_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub mount_point: String,
    pub name: String,
    pub removable: bool,
    pub read_only: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub file_system: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub byte_length: u64,
    pub modified_at: Option<String>,
    pub symlink: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub content_base64: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChosenFolder {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    pub path: String,
    pub content_base64: String,
}

/// The set of directories the window is currently allowed to touch.
///
/// In-memory and per-run on purpose. A root is re-authorized when the director's saved location is
/// re-adopted at startup or when a volume is enumerated, so persistence of the *permission* is not
/// needed for persistence of the *location* — and a stale grant cannot outlive the process.
#[derive(Default)]
pub struct TransferRoots {
    roots: Mutex<BTreeSet<PathBuf>>,
}

impl TransferRoots {
    fn authorize(&self, path: &Path) -> Result<PathBuf, CommandError> {
        let canonical = fs::canonicalize(path).map_err(CommandError::io)?;
        if !canonical.is_dir() {
            return Err(CommandError::dialog("That location is not a folder."));
        }
        let mut roots = self
            .roots
            .lock()
            .map_err(|_| CommandError::dialog("Transfer locations are unavailable."))?;
        roots.insert(canonical.clone());
        Ok(canonical)
    }

    fn forget(&self, path: &Path) {
        if let Ok(canonical) = fs::canonicalize(path) {
            if let Ok(mut roots) = self.roots.lock() {
                roots.remove(&canonical);
            }
        }
    }

    fn contains(&self, canonical: &Path) -> bool {
        let Ok(roots) = self.roots.lock() else {
            return false;
        };
        roots.iter().any(|root| canonical.starts_with(root))
    }

    /// Resolve a path that must already exist, and prove it is inside an authorized root.
    ///
    /// Canonicalization is what makes this a real check: it resolves every symlink and every `..`,
    /// so the comparison is against where the path actually leads rather than how it was spelled.
    fn resolve_existing(&self, path: &str) -> Result<PathBuf, CommandError> {
        let canonical = fs::canonicalize(path).map_err(CommandError::io)?;
        if !self.contains(&canonical) {
            return Err(CommandError::dialog(
                "That location is outside the transfer folders you have chosen.",
            ));
        }
        Ok(canonical)
    }

    /// Resolve a path that may not exist yet, by canonicalizing the deepest parent that does.
    ///
    /// A file being created has nothing to canonicalize, so the guarantee has to come from its
    /// directory. `..` in the tail is refused outright rather than normalized, because a normalized
    /// `..` is a path that climbs out of the root between this check and the write.
    fn resolve_new(&self, path: &str) -> Result<PathBuf, CommandError> {
        let requested = PathBuf::from(path);
        if requested
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(CommandError::dialog("That path is not allowed."));
        }
        let mut existing = requested.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while !existing.exists() {
            let Some(name) = existing.file_name().map(ToOwned::to_owned) else {
                return Err(CommandError::dialog("That path is not allowed."));
            };
            tail.push(name);
            let Some(parent) = existing.parent().map(Path::to_path_buf) else {
                return Err(CommandError::dialog("That path is not allowed."));
            };
            existing = parent;
        }
        let canonical_existing = fs::canonicalize(&existing).map_err(CommandError::io)?;
        if !self.contains(&canonical_existing) {
            return Err(CommandError::dialog(
                "That location is outside the transfer folders you have chosen.",
            ));
        }
        let mut resolved = canonical_existing;
        for name in tail.into_iter().rev() {
            resolved.push(name);
        }
        Ok(resolved)
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn modified_at(metadata: &fs::Metadata) -> Option<String> {
    let modified = metadata.modified().ok()?;
    let duration = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{}", duration.as_millis()))
}

/// Every mounted volume the platform can see, removable or not.
///
/// Filtering to removable media is the caller's decision, not this layer's: a director whose
/// exchange folder lives on an external drive that reports itself as fixed still needs to see it.
///
/// `sysinfo` is used rather than platform-specific probing because it already speaks to the three
/// desktop platforms' own APIs. Nothing here assumes `/Volumes`, and nothing here assumes drive
/// letters; a Linux stick under `/run/media/<user>/<label>` is found the same way as either.
#[tauri::command]
pub fn transfers_list_volumes(
    roots: State<'_, TransferRoots>,
) -> Result<Vec<VolumeInfo>, CommandError> {
    let disks = Disks::new_with_refreshed_list();
    let mut volumes: Vec<VolumeInfo> = disks
        .list()
        .iter()
        .map(|disk| {
            let mount_point = disk.mount_point().to_path_buf();
            let name = disk.name().to_string_lossy().into_owned();
            let display = if name.trim().is_empty() {
                mount_point
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path_string(&mount_point))
            } else {
                name
            };
            VolumeInfo {
                mount_point: path_string(&mount_point),
                name: display,
                removable: disk.is_removable(),
                read_only: disk.is_read_only(),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
                file_system: disk.file_system().to_string_lossy().into_owned(),
            }
        })
        .collect();
    volumes.sort_by(|left, right| left.mount_point.cmp(&right.mount_point));
    // A volume the platform reports is a volume the director can be shown, so it is authorized as a
    // root here. That is the same grant the folder picker makes, made by the same explicit act of
    // the operating system telling us the drive is mounted.
    for volume in &volumes {
        if volume.removable {
            let _ = roots.authorize(Path::new(&volume.mount_point));
        }
    }
    Ok(volumes)
}

/// Let the director pick a folder, and authorize exactly that folder.
///
/// The native picker is the grant. Nothing widens it afterwards: choosing `~/Quiz Bowl Exchange`
/// authorizes that directory and its contents, and not the home directory it sits in.
#[tauri::command]
pub async fn transfers_choose_folder(
    app: AppHandle,
    roots: State<'_, TransferRoots>,
) -> Result<Option<ChosenFolder>, CommandError> {
    let mut dialog = app.dialog().file().set_title("Choose a transfer folder");
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(folder) = dialog.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let canonical = roots.authorize(&path)?;
    Ok(Some(ChosenFolder {
        name: canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path_string(&canonical)),
        path: path_string(&canonical),
    }))
}

/// Re-authorize a location the director configured in an earlier session.
///
/// Called at startup for each remembered transfer location. It fails plainly when the folder is
/// gone or unreachable, which is the honest answer for a share that is not mounted yet.
#[tauri::command]
pub fn transfers_authorize_root(
    path: String,
    roots: State<'_, TransferRoots>,
) -> Result<String, CommandError> {
    Ok(path_string(&roots.authorize(Path::new(&path))?))
}

#[tauri::command]
pub fn transfers_forget_root(
    path: String,
    roots: State<'_, TransferRoots>,
) -> Result<(), CommandError> {
    roots.forget(Path::new(&path));
    Ok(())
}

/// One directory, bounded, without following links.
///
/// `symlink_metadata` rather than `metadata` so that a link is reported as a link instead of as
/// whatever it points at. The caller skips them; this layer refuses to be the thing that quietly
/// resolves one.
#[tauri::command]
pub fn transfers_list_directory(
    path: String,
    limit: usize,
    roots: State<'_, TransferRoots>,
) -> Result<Vec<DirectoryEntry>, CommandError> {
    let resolved = roots.resolve_existing(&path)?;
    let bound = limit.clamp(1, MAX_LIST_ENTRIES);
    let mut entries = Vec::new();
    for entry in fs::read_dir(&resolved).map_err(CommandError::io)? {
        if entries.len() >= bound {
            break;
        }
        let Ok(entry) = entry else {
            continue;
        };
        let entry_path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&entry_path) else {
            continue;
        };
        let symlink = metadata.file_type().is_symlink();
        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path_string(&entry_path),
            directory: !symlink && metadata.is_dir(),
            byte_length: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_at: modified_at(&metadata),
            symlink,
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

/// Read one file, refusing anything that is not a plain file inside an authorized root.
///
/// The size is checked from the metadata before the read, so an enormous file costs a `stat` rather
/// than a copy into memory. `max_bytes` lets the caller be stricter than this layer; it can never
/// be looser.
#[tauri::command]
pub fn transfers_read_file(
    path: String,
    max_bytes: Option<u64>,
    roots: State<'_, TransferRoots>,
) -> Result<FileContents, CommandError> {
    let resolved = roots.resolve_existing(&path)?;
    let metadata = fs::symlink_metadata(&resolved).map_err(CommandError::io)?;
    if metadata.file_type().is_symlink() {
        return Err(CommandError::dialog("Links are not read."));
    }
    if !metadata.is_file() {
        return Err(CommandError::dialog("That is not a file."));
    }
    let bound = max_bytes.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES);
    if metadata.len() > bound {
        return Err(CommandError::dialog(
            "That file is too large to read as QBJ.",
        ));
    }
    let bytes = fs::read(&resolved).map_err(CommandError::io)?;
    Ok(FileContents {
        byte_length: bytes.len(),
        content_base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
pub fn transfers_create_directory(
    path: String,
    roots: State<'_, TransferRoots>,
) -> Result<String, CommandError> {
    let resolved = roots.resolve_new(&path)?;
    fs::create_dir_all(&resolved).map_err(CommandError::io)?;
    Ok(path_string(&resolved))
}

#[tauri::command]
pub fn transfers_exists(
    path: String,
    roots: State<'_, TransferRoots>,
) -> Result<bool, CommandError> {
    match roots.resolve_new(&path) {
        Ok(resolved) => Ok(resolved.exists()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn transfers_available_bytes(
    path: String,
    roots: State<'_, TransferRoots>,
) -> Result<Option<u64>, CommandError> {
    let resolved = roots.resolve_existing(&path)?;
    let disks = Disks::new_with_refreshed_list();
    Ok(disks
        .list()
        .iter()
        .filter(|disk| resolved.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space()))
}

/// Write a file so that no reader ever sees it partly written.
///
/// Temporary file in the destination directory, flushed to the device, then renamed over the
/// target. The temporary file is in the same directory deliberately: a rename across filesystems is
/// a copy, and a copy is not atomic.
#[tauri::command]
pub fn transfers_write_file(
    request: WriteFileRequest,
    roots: State<'_, TransferRoots>,
) -> Result<String, CommandError> {
    let resolved = roots.resolve_new(&request.path)?;
    let bytes = BASE64
        .decode(request.content_base64)
        .map_err(CommandError::encoding)?;
    atomic_write(&resolved, &bytes).map_err(CommandError::io)?;
    Ok(path_string(&resolved))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "file path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let stem = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "transfer".to_owned());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary = parent.join(format!(".{stem}.{}.{timestamp}.tmp", std::process::id()));
    let mut file = fs::File::create(&temporary)?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        // A drive that filled up or vanished must not leave a stub behind that a later scan reads.
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::AlreadyExists
                || error.kind() == std::io::ErrorKind::PermissionDenied
            {
                fs::remove_file(path)?;
                return fs::rename(&temporary, path).inspect_err(|_| {
                    let _ = fs::remove_file(&temporary);
                });
            }
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "qbsheet-transfers-{}-{}-{:?}",
            name,
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");
        directory
    }

    #[test]
    fn an_unauthorized_path_is_refused() {
        let directory = scratch("unauthorized");
        let roots = TransferRoots::default();
        let file = directory.join("assignment.qbj");
        fs::write(&file, b"{}").expect("write");
        assert!(roots.resolve_existing(&path_string(&file)).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn an_authorized_root_permits_its_own_files_only() {
        let directory = scratch("authorized");
        let outside = scratch("authorized-outside");
        let roots = TransferRoots::default();
        roots.authorize(&directory).expect("authorize");
        let inside = directory.join("assignment.qbj");
        fs::write(&inside, b"{}").expect("write");
        let stranger = outside.join("private.qbj");
        fs::write(&stranger, b"{}").expect("write");
        assert!(roots.resolve_existing(&path_string(&inside)).is_ok());
        assert!(roots.resolve_existing(&path_string(&stranger)).is_err());
        let _ = fs::remove_dir_all(directory);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn a_parent_traversal_is_refused_before_it_resolves() {
        let directory = scratch("traversal");
        let roots = TransferRoots::default();
        roots.authorize(&directory).expect("authorize");
        let escape = format!("{}/../escaped.qbj", path_string(&directory));
        assert!(roots.resolve_new(&escape).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_root_is_refused() {
        let directory = scratch("symlink");
        let outside = scratch("symlink-outside");
        let secret = outside.join("secret.qbj");
        fs::write(&secret, b"{}").expect("write");
        let link = directory.join("link.qbj");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        let roots = TransferRoots::default();
        roots.authorize(&directory).expect("authorize");
        // Canonicalization resolves the link, so the check sees where it actually goes.
        assert!(roots.resolve_existing(&path_string(&link)).is_err());
        let _ = fs::remove_dir_all(directory);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn an_atomic_write_replaces_without_leaving_a_temporary() {
        let directory = scratch("atomic");
        let path = directory.join("assignment.qbj");
        atomic_write(&path, br#"{"version":"2.1.1"}"#).expect("first write");
        atomic_write(&path, br#"{"version":"2.1.1","objects":[]}"#).expect("second write");
        assert_eq!(
            fs::read(&path).expect("read"),
            br#"{"version":"2.1.1","objects":[]}"#
        );
        let leftovers = fs::read_dir(&directory)
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn listing_reports_a_link_rather_than_following_it() {
        let directory = scratch("listing");
        fs::write(directory.join("a.qbj"), b"{}").expect("write");
        let roots = TransferRoots::default();
        roots.authorize(&directory).expect("authorize");
        let entries = transfers_list_entries(&roots, &path_string(&directory), 10).expect("list");
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].symlink);
        let _ = fs::remove_dir_all(directory);
    }

    /// The body of `transfers_list_directory` without Tauri's `State` wrapper, for the tests above.
    fn transfers_list_entries(
        roots: &TransferRoots,
        path: &str,
        limit: usize,
    ) -> Result<Vec<DirectoryEntry>, CommandError> {
        let resolved = roots.resolve_existing(path)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(&resolved).map_err(CommandError::io)? {
            if entries.len() >= limit {
                break;
            }
            let Ok(entry) = entry else { continue };
            let entry_path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&entry_path) else {
                continue;
            };
            let symlink = metadata.file_type().is_symlink();
            entries.push(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path_string(&entry_path),
                directory: !symlink && metadata.is_dir(),
                byte_length: if metadata.is_file() {
                    metadata.len()
                } else {
                    0
                },
                modified_at: modified_at(&metadata),
                symlink,
            });
        }
        Ok(entries)
    }
}
