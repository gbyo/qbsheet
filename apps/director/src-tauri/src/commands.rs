use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::server::{ServerError, ServerRuntime, ServerSnapshot, ServerStatus};
use crate::store::{DirectorStore, StoreError, StoreStatus};

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    fn io(error: std::io::Error) -> Self {
        Self {
            code: "io",
            message: error.to_string(),
        }
    }

    fn store(error: StoreError) -> Self {
        Self {
            code: "store",
            message: error.to_string(),
        }
    }

    fn dialog(message: impl Into<String>) -> Self {
        Self {
            code: "dialog",
            message: message.into(),
        }
    }

    fn encoding(error: base64::DecodeError) -> Self {
        Self {
            code: "encoding",
            message: error.to_string(),
        }
    }

    fn serialization(error: serde_json::Error) -> Self {
        Self {
            code: "serialization",
            message: error.to_string(),
        }
    }

    fn server(error: ServerError) -> Self {
        Self {
            code: "server",
            message: error.to_string(),
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
    Ok(server.snapshot())
}

#[tauri::command]
pub async fn director_start_qbtcp_server(
    store: State<'_, DirectorStore>,
    server: State<'_, ServerRuntime>,
) -> Result<ServerStatus, CommandError> {
    let state = store.load_state().map_err(CommandError::store)?;
    server.start(state).await.map_err(CommandError::server)
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
        .add_filter(
            "QBSheet, QBJ, and portable archive",
            &["qbst", "qbj", "qbsheet", "qbs"],
        )
        .add_filter("JSON and SQBS", &["json", "sqbs"])
        .add_filter("All files", &["*"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let Some(file) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = file_path(file)?;
    let bytes = fs::read(&path).map_err(CommandError::io)?;
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
    let bytes = BASE64
        .decode(request.content_base64)
        .map_err(CommandError::encoding)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save QBSheet tournament")
        .add_filter(
            "QBSheet, QBJ, and portable archive",
            &["qbst", "qbj", "qbsheet", "qbs"],
        )
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

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "file path has no parent")
    })?;
    fs::create_dir_all(parent)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name(path),
        std::process::id(),
        timestamp
    ));
    let mut temporary_file = fs::File::create(&temporary_path)?;
    temporary_file.write_all(contents)?;
    temporary_file.sync_all()?;
    drop(temporary_file);

    match fs::rename(&temporary_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            #[cfg(windows)]
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                fs::remove_file(path)?;
                return fs::rename(&temporary_path, path).or_else(|rename_error| {
                    let _ = fs::remove_file(&temporary_path);
                    Err(rename_error)
                });
            }
            let _ = fs::remove_file(&temporary_path);
            Err(error)
        }
    }
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
}
