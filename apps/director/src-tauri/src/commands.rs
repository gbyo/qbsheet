use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::server::{
    RoomPairingInvitation, ServerError, ServerRuntime, ServerSnapshot, ServerStatus,
};
use crate::store::{DirectorStore, StoreError, StoreStatus};

const MAX_NATIVE_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    pub(crate) fn io(error: std::io::Error) -> Self {
        Self {
            code: "io",
            message: error.to_string(),
        }
    }

    pub(crate) fn store(error: StoreError) -> Self {
        Self {
            code: "store",
            message: error.to_string(),
        }
    }

    pub(crate) fn dialog(message: impl Into<String>) -> Self {
        Self {
            code: "dialog",
            message: message.into(),
        }
    }

    pub(crate) fn encoding(error: base64::DecodeError) -> Self {
        Self {
            code: "encoding",
            message: error.to_string(),
        }
    }

    pub(crate) fn serialization(error: serde_json::Error) -> Self {
        Self {
            code: "serialization",
            message: error.to_string(),
        }
    }

    pub(crate) fn server(error: ServerError) -> Self {
        Self {
            code: "server",
            message: error.to_string(),
        }
    }

    fn file_too_large(size: u64, maximum: u64) -> Self {
        Self {
            code: "file_too_large",
            message: format!(
                "The selected file is {size} bytes; the maximum supported size is {maximum} bytes."
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationPaths {
    pub app_data: String,
    pub app_config: String,
    pub app_local_data: String,
    pub app_cache: String,
    pub app_log: String,
    pub database: String,
    pub backups: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFile {
    pub path: String,
    pub file_name: String,
    pub content_base64: String,
    pub byte_length: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    /// Whether this database carries QBSheet Live publication state.
    ///
    /// Reported so a support conversation about "the tournament is not publishing" can start from
    /// whether the schema is even there, rather than from a screenshot.
    pub live_tables: bool,
    pub app_version: String,
    pub protocol: String,
    pub qbj_version: String,
    pub target: String,
    pub os: String,
    pub arch: String,
    pub paths: ApplicationPaths,
    pub store: StoreStatus,
    pub server: ServerStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileRequest {
    pub default_name: Option<String>,
    pub content_base64: String,
}

pub fn app_paths(app: &AppHandle) -> Result<ApplicationPaths, CommandError> {
    let path = app.path();
    let app_data = path
        .app_data_dir()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let app_config = path
        .app_config_dir()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let app_local_data = path
        .app_local_data_dir()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let app_cache = path
        .app_cache_dir()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let app_log = path
        .app_log_dir()
        .map_err(|error| CommandError::dialog(error.to_string()))?;
    let database = app_data.join("database").join("director.sqlite");
    let backups = app_data.join("backups");

    Ok(ApplicationPaths {
        app_data: path_string(&app_data),
        app_config: path_string(&app_config),
        app_local_data: path_string(&app_local_data),
        app_cache: path_string(&app_cache),
        app_log: path_string(&app_log),
        database: path_string(&database),
        backups: path_string(&backups),
    })
}

#[tauri::command]
pub fn get_application_paths(app: AppHandle) -> Result<ApplicationPaths, CommandError> {
    app_paths(&app)
}

#[tauri::command]
pub fn get_store_status(store: State<'_, DirectorStore>) -> Result<StoreStatus, CommandError> {
    store.status().map_err(CommandError::store)
}

#[tauri::command]
pub fn director_load_state(store: State<'_, DirectorStore>) -> Result<Option<Value>, CommandError> {
    store.load_state().map_err(CommandError::store)
}

#[tauri::command]
pub fn director_list_tournaments(
    store: State<'_, DirectorStore>,
) -> Result<Vec<crate::store::TournamentCatalogEntry>, CommandError> {
    store.list_tournaments().map_err(CommandError::store)
}

#[tauri::command]
pub fn director_read_tournament(
    tournament_id: String,
    store: State<'_, DirectorStore>,
) -> Result<Value, CommandError> {
    store
        .read_tournament(tournament_id.trim())
        .map_err(CommandError::store)
}

#[tauri::command]
pub async fn director_open_tournament(
    tournament_id: String,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<Value, CommandError> {
    let restart_server = server.status().running;
    if restart_server {
        server.stop();
    }
    let state = store
        .open_tournament(tournament_id.trim())
        .map_err(CommandError::store)?;
    if restart_server {
        server
            .start_with_store(Some(state.clone()), std::sync::Arc::new((*store).clone()))
            .await
            .map_err(CommandError::server)?;
    }
    Ok(state)
}

#[tauri::command]
pub fn director_save_state(
    state: Value,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<StoreStatus, CommandError> {
    store.save_state(&state).map_err(CommandError::store)?;
    server.refresh_state(Some(&state));
    store.status().map_err(CommandError::store)
}

#[tauri::command]
pub fn director_save_document(
    state: Value,
    activate: bool,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<StoreStatus, CommandError> {
    store
        .save_document(&state, activate)
        .map_err(CommandError::store)?;
    if activate {
        server.refresh_state(Some(&state));
    }
    store.status().map_err(CommandError::store)
}

#[tauri::command]
pub fn director_list_checkpoints(
    tournament_id: String,
    store: State<'_, DirectorStore>,
) -> Result<Vec<crate::store::DirectorCheckpoint>, CommandError> {
    store
        .list_checkpoints(&tournament_id)
        .map_err(CommandError::store)
}

#[tauri::command]
pub fn director_read_checkpoint(
    tournament_id: String,
    checkpoint_id: String,
    store: State<'_, DirectorStore>,
) -> Result<Value, CommandError> {
    store
        .read_checkpoint(&tournament_id, &checkpoint_id)
        .map_err(CommandError::store)
}

#[tauri::command]
pub async fn director_restore_checkpoint(
    current: Value,
    checkpoint_id: String,
    restored: Value,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<Value, CommandError> {
    // Stop live sessions before replacing their authoritative assignments. New pairing
    // invitations after restart belong to the restored tournament, never stale sessions.
    let running = server.status().running;
    if running {
        server.stop();
    }
    let outcome = store.restore_checkpoint(&current, &checkpoint_id, &restored);
    if running {
        let document = match &outcome {
            Ok(document) => Some(document.clone()),
            Err(_) => store.load_state().map_err(CommandError::store)?,
        };
        if let Err(error) = server
            .start_with_store(document, std::sync::Arc::new((*store).clone()))
            .await
        {
            // Storage has already committed. Report server availability through its status;
            // returning a restore failure would leave the UI on the old document.
            eprintln!("QBTCP restart after recovery failed: {error}");
        }
    }
    outcome.map_err(CommandError::store)
}

#[tauri::command]
pub fn director_checkpoint(
    state: Value,
    reason: String,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<StoreStatus, CommandError> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(CommandError::dialog("A checkpoint reason is required."));
    }
    let status = store
        .checkpoint_state(&state, reason)
        .map_err(CommandError::store)?;
    server.refresh_state(Some(&state));
    Ok(status)
}

#[tauri::command]
pub fn director_server_status(
    server: State<'_, ServerRuntime>,
) -> Result<ServerStatus, CommandError> {
    Ok(server.status())
}

#[tauri::command]
pub fn director_server_snapshot(
    server: State<'_, ServerRuntime>,
) -> Result<ServerSnapshot, CommandError> {
    server.snapshot().map_err(CommandError::server)
}

#[tauri::command]
pub fn director_resolve_qbtcp_help(
    help_id: String,
    server: State<'_, ServerRuntime>,
) -> Result<qbtcp_server::HelpRequest, CommandError> {
    if help_id.trim().is_empty() {
        return Err(CommandError::dialog("A help request id is required."));
    }
    server
        .resolve_help(help_id.trim())
        .map_err(CommandError::server)
}

#[tauri::command]
pub fn director_issue_qbtcp_pairing(
    room_id: String,
    server: State<'_, ServerRuntime>,
) -> Result<RoomPairingInvitation, CommandError> {
    server
        .issue_pairing(room_id.trim())
        .map_err(CommandError::server)
}

#[tauri::command]
pub async fn director_start_qbtcp_server(
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<ServerStatus, CommandError> {
    let state = store.load_state().map_err(CommandError::store)?;
    server
        .start_with_store(state, std::sync::Arc::new((*store).clone()))
        .await
        .map_err(CommandError::server)
}

#[tauri::command]
pub fn director_stop_qbtcp_server(
    server: State<'_, ServerRuntime>,
) -> Result<ServerStatus, CommandError> {
    Ok(server.stop())
}

#[tauri::command]
pub fn checkpoint_store(
    reason: String,
    store: State<'_, DirectorStore>,
) -> Result<StoreStatus, CommandError> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(CommandError::dialog("A checkpoint reason is required."));
    }
    store.checkpoint(reason).map_err(CommandError::store)
}

#[tauri::command]
pub async fn open_tournament_file(app: AppHandle) -> Result<Option<SelectedFile>, CommandError> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Open QBSheet tournament")
        .add_filter("QBSheet, QBJ, and portable archive", &["qbst", "qbj"])
        .add_filter("JSON", &["json"])
        .add_filter("All files", &["*"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = file_path(file)?;
    let bytes = read_bounded_file(&path)?;
    Ok(Some(SelectedFile {
        path: path_string(&path),
        file_name: file_name(&path),
        byte_length: bytes.len(),
        content_base64: BASE64.encode(bytes),
    }))
}

#[tauri::command]
pub async fn save_tournament_file(
    app: AppHandle,
    request: SaveFileRequest,
) -> Result<Option<SavedFile>, CommandError> {
    let maximum_encoded_bytes = MAX_NATIVE_FILE_BYTES
        .saturating_add(2)
        .checked_div(3)
        .unwrap_or_default()
        .saturating_mul(4);
    if request.content_base64.len() as u64 > maximum_encoded_bytes {
        return Err(CommandError::file_too_large(
            request.content_base64.len() as u64,
            MAX_NATIVE_FILE_BYTES,
        ));
    }
    let bytes = BASE64
        .decode(request.content_base64)
        .map_err(CommandError::encoding)?;
    if bytes.len() as u64 > MAX_NATIVE_FILE_BYTES {
        return Err(CommandError::file_too_large(
            bytes.len() as u64,
            MAX_NATIVE_FILE_BYTES,
        ));
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save QBSheet tournament")
        .add_filter("QBSheet, QBJ, and portable archive", &["qbst", "qbj"])
        .add_filter("JSON", &["json"])
        .set_can_create_directories(true);
    if let Some(default_name) = request.default_name.as_deref() {
        dialog = dialog.set_file_name(default_name);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file_path(file)?;
    atomic_write(&path, &bytes).map_err(CommandError::io)?;
    Ok(Some(SavedFile {
        path: path_string(&path),
    }))
}

#[tauri::command]
pub fn get_diagnostics_snapshot(
    app: AppHandle,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<DiagnosticsSnapshot, CommandError> {
    diagnostics_snapshot(&app, &store, &server)
}

#[tauri::command]
pub async fn save_diagnostics_bundle(
    app: AppHandle,
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<Option<SavedFile>, CommandError> {
    let snapshot = diagnostics_snapshot(&app, &store, &server)?;
    let bytes = serde_json::to_vec_pretty(&snapshot).map_err(CommandError::serialization)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save QBSheet Director diagnostics")
        .add_filter("JSON", &["json"])
        .set_file_name("qbsheet-director-diagnostics.json")
        .set_can_create_directories(true);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(file) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = file_path(file)?;
    atomic_write(&path, &bytes).map_err(CommandError::io)?;
    Ok(Some(SavedFile {
        path: path_string(&path),
    }))
}

fn diagnostics_snapshot(
    app: &AppHandle,
    store: &DirectorStore,
    server: &ServerRuntime,
) -> Result<DiagnosticsSnapshot, CommandError> {
    Ok(DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        protocol: "QBTCP v1".to_string(),
        qbj_version: "2.1.1".to_string(),
        target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        paths: app_paths(app)?,
        live_tables: crate::live::tables_exist(std::path::Path::new(
            &store.status().map_err(CommandError::store)?.database_path,
        )),
        store: store.status().map_err(CommandError::store)?,
        server: server.status(),
    })
}

fn file_path(file: FilePath) -> Result<PathBuf, CommandError> {
    file.into_path()
        .map_err(|error| CommandError::dialog(error.to_string()))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tournament".to_string())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, CommandError> {
    let file = fs::File::open(path).map_err(CommandError::io)?;
    let size = file.metadata().map_err(CommandError::io)?.len();
    if size > MAX_NATIVE_FILE_BYTES {
        return Err(CommandError::file_too_large(size, MAX_NATIVE_FILE_BYTES));
    }
    let mut bytes = Vec::new();
    file.take(MAX_NATIVE_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(CommandError::io)?;
    if bytes.len() as u64 > MAX_NATIVE_FILE_BYTES {
        return Err(CommandError::file_too_large(
            bytes.len() as u64,
            MAX_NATIVE_FILE_BYTES,
        ));
    }
    Ok(bytes)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_stem = format!(".{}.{}.{}", file_name(path), std::process::id(), timestamp);
    let (temporary_path, mut temporary_file) = (0..16)
        .map(|attempt| {
            let temporary_path = parent.join(format!("{temporary_stem}.{attempt}.tmp"));
            let temporary_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path);
            (temporary_path, temporary_file)
        })
        .find_map(|(temporary_path, result)| match result {
            Ok(file) => Some(Ok((temporary_path, file))),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(error) => Some(Err(error)),
        })
        .unwrap_or_else(|| {
            Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "could not allocate a unique temporary file",
            ))
        })?;

    let result = (|| {
        temporary_file.write_all(contents)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        replace_path(&temporary_path, path)?;
        sync_parent_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

#[cfg(not(windows))]
fn replace_path(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_path(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), std::io::Error> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_a_file_without_leaving_a_temp_file() {
        let directory = std::env::temp_dir().join(format!(
            "qbsheet-director-command-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("test directory");
        let path = directory.join("diagnostics.json");
        atomic_write(&path, br#"{"version":1}"#).expect("first write");
        atomic_write(&path, br#"{"version":2}"#).expect("second write");
        assert_eq!(fs::read(&path).expect("read file"), br#"{"version":2}"#);
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(
            directory.join(format!(".diagnostics.json.{}.tmp", std::process::id())),
        );
        let _ = fs::remove_dir(directory);
    }

    #[test]
    fn bounded_file_read_rejects_oversized_input_before_loading_it() {
        let directory =
            std::env::temp_dir().join(format!("qbsheet-director-size-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("test directory");
        let path = directory.join("oversized.qbj");
        let file = fs::File::create(&path).expect("oversized file");
        file.set_len(MAX_NATIVE_FILE_BYTES + 1)
            .expect("sparse oversized file");

        let error = read_bounded_file(&path).expect_err("oversized input must be rejected");
        assert_eq!(error.code, "file_too_large");
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir(directory);
    }

    #[test]
    fn atomic_write_keeps_destination_and_cleans_temp_on_replace_failure() {
        let directory = std::env::temp_dir().join(format!(
            "qbsheet-director-atomic-failure-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("test directory");
        let destination = directory.join("diagnostics.json");
        fs::create_dir(&destination).expect("destination directory");

        assert!(atomic_write(&destination, b"new contents").is_err());
        assert!(destination.is_dir());
        assert!(fs::read_dir(&directory)
            .expect("directory entries")
            .filter_map(Result::ok)
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));

        let _ = fs::remove_dir(destination);
        let _ = fs::remove_dir(directory);
    }
}

// ---------------------------------------------------------------------------
// QBSheet Live
// ---------------------------------------------------------------------------

/// The credential store, held as Tauri state.
///
/// A struct rather than a bare `KeychainCredentialStore` so that a platform without a keychain, and
/// a test, can substitute one without the command layer knowing.
pub struct LiveCredentials {
    store: Box<dyn crate::live::CredentialStore>,
}

impl Default for LiveCredentials {
    fn default() -> Self {
        Self {
            store: Box::new(crate::live::KeychainCredentialStore),
        }
    }
}

/// Prove secure persistence is available before Director consumes a one-time setup token.
#[tauri::command]
pub fn director_probe_live_credential_store(
    credentials: State<'_, LiveCredentials>,
) -> Result<(), CommandError> {
    credentials.store.probe()?;
    Ok(())
}

impl LiveCredentials {
    #[cfg(test)]
    pub fn with_store(store: Box<dyn crate::live::CredentialStore>) -> Self {
        Self { store }
    }
}

impl From<crate::live::LiveError> for CommandError {
    fn from(value: crate::live::LiveError) -> Self {
        CommandError {
            code: "live",
            message: value.to_string(),
        }
    }
}

/// Store a QBSheet Live management credential.
///
/// The publication id is validated before it becomes a keychain account name: it arrives over the
/// bridge, and an unvalidated value would name an arbitrary keychain entry.
#[tauri::command]
pub fn director_store_live_credential(
    credentials: State<'_, LiveCredentials>,
    publication_id: String,
    token: String,
) -> Result<(), CommandError> {
    if !crate::live::is_publication_id(&publication_id) {
        return Err(crate::live::LiveError::InvalidPublicationId.into());
    }
    credentials.store.store(&publication_id, &token)?;
    Ok(())
}

#[tauri::command]
pub fn director_read_live_credential(
    credentials: State<'_, LiveCredentials>,
    publication_id: String,
) -> Result<Option<String>, CommandError> {
    if !crate::live::is_publication_id(&publication_id) {
        return Err(crate::live::LiveError::InvalidPublicationId.into());
    }
    Ok(credentials.store.read(&publication_id)?)
}

#[tauri::command]
pub fn director_forget_live_credential(
    credentials: State<'_, LiveCredentials>,
    publication_id: String,
) -> Result<(), CommandError> {
    if !crate::live::is_publication_id(&publication_id) {
        return Err(crate::live::LiveError::InvalidPublicationId.into());
    }
    credentials.store.forget(&publication_id)?;
    Ok(())
}

/// The publication as the normalized tables see it.
///
/// Read from the rows rather than from the document, so that after a crash this answers "what had
/// Director not yet published" from what actually survived to disk.
#[tauri::command]
pub fn director_live_status(
    store: State<'_, DirectorStore>,
) -> Result<Option<crate::live::LivePublicationRow>, CommandError> {
    store.live_status().map_err(CommandError::store)
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::live::MemoryCredentialStore;

    #[test]
    fn a_credential_round_trips_through_the_store() {
        let credentials = LiveCredentials::with_store(Box::new(MemoryCredentialStore::default()));
        let publication = "bcdfghjkmnpqrstvwxyz";
        assert_eq!(credentials.store.read(publication).expect("read"), None);
        credentials
            .store
            .store(publication, "token")
            .expect("store");
        assert_eq!(
            credentials
                .store
                .read(publication)
                .expect("read")
                .as_deref(),
            Some("token")
        );
        credentials.store.forget(publication).expect("forget");
        assert_eq!(credentials.store.read(publication).expect("read"), None);
    }

    #[test]
    fn a_credential_survives_reopening_the_store_abstraction() {
        let shared = MemoryCredentialStore::default();
        let first = LiveCredentials::with_store(Box::new(shared.clone()));
        first
            .store
            .store("bcdfghjkmnpqrstvwxyz", "restart-token")
            .expect("store before restart");
        drop(first);
        let reopened = LiveCredentials::with_store(Box::new(shared));
        assert_eq!(
            reopened
                .store
                .read("bcdfghjkmnpqrstvwxyz")
                .expect("read after restart")
                .as_deref(),
            Some("restart-token")
        );
    }

    /// A publication id arrives over the Tauri bridge. Nothing stops a compromised renderer from
    /// sending a path, so the command layer validates before the value names a keychain entry.
    #[test]
    fn a_forged_publication_id_never_reaches_the_credential_store() {
        for forged in ["../../etc/passwd", "", "short", "AEIOU"] {
            assert!(
                !crate::live::is_publication_id(forged),
                "{forged} must not be accepted as a publication id"
            );
        }
    }
}

/// The QBSheet Live local-network server.
///
/// A separate listener from QBTCP on purpose. QBTCP carries pairing codes and session tokens;
/// QBLive is a public read-only surface. Two listeners make "a spectator reached a QBTCP route"
/// impossible rather than merely unlikely. See `live_server.rs`.
#[tauri::command]
pub async fn director_start_live_server(
    runtime: State<'_, crate::live_server::LiveServerRuntime>,
    port: Option<u16>,
) -> Result<crate::live_server::LiveServerStatus, CommandError> {
    runtime
        .start(port.unwrap_or(DEFAULT_LIVE_PORT))
        .await
        .map_err(|error| CommandError {
            code: "live-server",
            message: error.to_string(),
        })
}

#[tauri::command]
pub fn director_stop_live_server(
    runtime: State<'_, crate::live_server::LiveServerRuntime>,
) -> Result<crate::live_server::LiveServerStatus, CommandError> {
    runtime.stop().map_err(|error| CommandError {
        code: "live-server",
        message: error.to_string(),
    })
}

#[tauri::command]
pub fn director_live_server_status(
    runtime: State<'_, crate::live_server::LiveServerRuntime>,
) -> crate::live_server::LiveServerStatus {
    runtime.status()
}

/// Hand the local server a sanitized snapshot.
///
/// The value is whatever Director's publication path produced — the same document it would send to
/// a remote backend. Nothing here inspects the tournament, which is what keeps the privacy boundary
/// in exactly one place.
#[tauri::command]
pub fn director_publish_local_live(
    runtime: State<'_, crate::live_server::LiveServerRuntime>,
    snapshot: Value,
) -> Result<crate::live_server::LiveServerStatus, CommandError> {
    runtime.publish(snapshot);
    Ok(runtime.status())
}

/// Clear a local publication. Unpublish retains a tombstone so open spectator tabs receive 410;
/// Delete forgets the id entirely. Neither command touches the separate QBTCP listener.
#[tauri::command]
pub fn director_clear_local_live(
    runtime: State<'_, crate::live_server::LiveServerRuntime>,
    remember_as_gone: bool,
) -> Result<crate::live_server::LiveServerStatus, CommandError> {
    runtime
        .clear(remember_as_gone)
        .map_err(|error| CommandError {
            code: "live-server",
            message: error.to_string(),
        })
}

/// The default port for the local QBSheet Live server.
///
/// Adjacent to QBTCP's 8787 so a Director explaining a firewall exception has two numbers next to
/// each other, and deliberately not the same one.
pub const DEFAULT_LIVE_PORT: u16 = 8790;
