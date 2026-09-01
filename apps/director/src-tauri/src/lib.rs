use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::{Migration, MigrationKind};

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppDataPaths {
    pub app_data: String,
    pub app_config: String,
    pub app_local_data: String,
    pub app_cache: String,
    pub app_log: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTournamentFile {
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostics {
    schema_version: u8,
    generated_at_unix_seconds: u64,
    app_version: String,
    target_os: &'static str,
    target_arch: &'static str,
    paths: AppDataPaths,
}

fn path_string(path: tauri::Result<PathBuf>, label: &str) -> Result<String, String> {
    path.map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("could not resolve {label}: {error}"))
}

fn selected_path(file_path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    file_path
        .into_path()
        .map_err(|error| format!("the selected location is not a local file: {error:?}"))
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn file_name_for(prefix: &str, timestamp: u64) -> String {
    format!("{prefix}-{timestamp}.json")
}

fn safe_file_name(candidate: &str, fallback: &str) -> String {
    let leaf = candidate
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty() && *value != "." && *value != "..");
    let Some(leaf) = leaf else {
        return fallback.to_string();
    };
    if leaf.to_ascii_lowercase().ends_with(".json") {
        leaf.to_string()
    } else {
        format!("{leaf}.json")
    }
}

fn ensure_file_size(size: u64) -> Result<(), String> {
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "files larger than {MAX_FILE_BYTES} bytes are not supported"
        ));
    }
    Ok(())
}

fn director_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_director_shell_events",
        sql: "CREATE TABLE IF NOT EXISTS director_shell_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, recorded_at TEXT NOT NULL);",
        kind: MigrationKind::Up,
    }]
}

#[tauri::command]
fn get_app_data_paths(app: AppHandle) -> Result<AppDataPaths, String> {
    let resolver = app.path();
    Ok(AppDataPaths {
        app_data: path_string(resolver.app_data_dir(), "app data directory")?,
        app_config: path_string(resolver.app_config_dir(), "app config directory")?,
        app_local_data: path_string(resolver.app_local_data_dir(), "local app data directory")?,
        app_cache: path_string(resolver.app_cache_dir(), "app cache directory")?,
        app_log: path_string(resolver.app_log_dir(), "app log directory")?,
    })
}

#[tauri::command]
async fn open_tournament_file(app: AppHandle) -> Result<Option<OpenedTournamentFile>, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("QBSheet tournament files", &["qbj", "qbg", "json"])
        .set_title("Open QBSheet tournament file")
        .blocking_pick_file()
    else {
        return Ok(None);
    };

    let path = selected_path(file_path)?;
    let size = fs::metadata(&path)
        .map_err(|error| format!("could not inspect the selected file: {error}"))?
        .len();
    ensure_file_size(size)?;
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("could not read the selected file: {error}"))?;

    Ok(Some(OpenedTournamentFile {
        path: path.to_string_lossy().into_owned(),
        contents,
    }))
}

#[tauri::command(rename_all = "camelCase")]
async fn save_tournament_snapshot(
    app: AppHandle,
    contents: String,
    default_name: String,
) -> Result<Option<String>, String> {
    ensure_file_size(contents.len() as u64)?;
    let default_name = safe_file_name(&default_name, "qbsheet-director-snapshot.json");
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("QBSheet JSON snapshot", &["json"])
        .set_file_name(default_name)
        .set_title("Save QBSheet Director snapshot")
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let path = selected_path(file_path)?;
    fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("could not save the snapshot: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn diagnostics_json(app: &AppHandle) -> Result<String, String> {
    let diagnostics = RuntimeDiagnostics {
        schema_version: 1,
        generated_at_unix_seconds: unix_seconds(),
        app_version: app.package_info().version.to_string(),
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
        paths: get_app_data_paths(app.clone())?,
    };
    serde_json::to_string_pretty(&diagnostics)
        .map(|json| format!("{json}\n"))
        .map_err(|error| format!("could not serialize diagnostics: {error}"))
}

#[tauri::command]
fn write_diagnostics(app: AppHandle) -> Result<String, String> {
    let timestamp = unix_seconds();
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| format!("could not resolve diagnostics directory: {error}"))?;
    fs::create_dir_all(&log_dir)
        .map_err(|error| format!("could not create diagnostics directory: {error}"))?;
    let path = log_dir.join(file_name_for("qbsheet-director-diagnostics", timestamp));
    let contents = diagnostics_json(&app)?;
    fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("could not write diagnostics: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_diagnostics(app: AppHandle) -> Result<Option<String>, String> {
    let timestamp = unix_seconds();
    let default_name = file_name_for("qbsheet-director-diagnostics", timestamp);
    let Some(file_path) = app
        .dialog()
        .file()
        .add_filter("QBSheet diagnostics", &["json"])
        .set_file_name(default_name)
        .set_title("Save QBSheet Director diagnostics")
        .blocking_save_file()
    else {
        return Ok(None);
    };

    let path = selected_path(file_path)?;
    let contents = diagnostics_json(&app)?;
    fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("could not export diagnostics: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(desktop)]
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(|error| format!("updater is not configured: {error}"))?
        .check()
        .await
        .map_err(|error| format!("could not check for updates: {error}"))?;

    Ok(UpdateCheckResult {
        available: update.is_some(),
        version: update.map(|value| value.version),
        current_version,
    })
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance must be registered first so a second launch cannot race the other plugins.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder = builder.plugin(tauri_plugin_dialog::init()).plugin(
        tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:director.sqlite", director_migrations())
            .build(),
    );

    builder
        .invoke_handler(tauri::generate_handler![
            get_app_data_paths,
            open_tournament_file,
            save_tournament_snapshot,
            write_diagnostics,
            export_diagnostics,
            #[cfg(desktop)]
            check_for_updates,
        ])
        .setup(|app| {
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running QBSheet Director");
}

#[cfg(test)]
mod tests {
    use super::{ensure_file_size, file_name_for, MAX_FILE_BYTES};

    #[test]
    fn rejects_oversized_native_payloads() {
        assert!(ensure_file_size(MAX_FILE_BYTES).is_ok());
        assert!(ensure_file_size(MAX_FILE_BYTES + 1).is_err());
    }

    #[test]
    fn diagnostics_names_are_stable_and_scoped() {
        assert_eq!(
            file_name_for("qbsheet-director-diagnostics", 42),
            "qbsheet-director-diagnostics-42.json"
        );
    }

    #[test]
    fn save_names_cannot_escape_the_native_picker_filename_field() {
        assert_eq!(
            super::safe_file_name("../../unsafe", "fallback.json"),
            "unsafe.json"
        );
        assert_eq!(super::safe_file_name("", "fallback.json"), "fallback.json");
    }
}
