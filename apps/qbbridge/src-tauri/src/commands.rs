//! Native file, secure relay-credential storage, and HTTP operations.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// The largest `.yft` this will read. Matches the importer's own 8 MiB bound, so a file that
/// would be refused after parsing is refused before it is read into memory.
const MAX_YFT_BYTES: u64 = 8 * 1024 * 1024;
/// The largest result document written in one call. A completed game is a few tens of kilobytes.
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const RELAY_TIMEOUT: Duration = Duration::from_secs(20);
/// The largest relay response read. `manage/mirror` accepts 8 MiB; a results page can approach it.
const MAX_RELAY_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECOVERY_PACKAGE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl CommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub path: String,
    pub contents: String,
}

/// A native open dialog filtered to YellowFruit files, and the file's text.
///
/// `None` means the operator cancelled, which is not an error and must not read as one.
#[tauri::command]
pub async fn open_yellowfruit_file(app: AppHandle) -> CommandResult<Option<OpenedFile>> {
    let chosen = app
        .dialog()
        .file()
        .add_filter("YellowFruit tournament", &["yft", "json"])
        .set_title("Open YellowFruit tournament")
        .blocking_pick_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| CommandError::new("invalid_path", error.to_string()))?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
    if metadata.len() > MAX_YFT_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "That file is larger than the 8 MiB YellowFruit import limit.",
        ));
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
    Ok(Some(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        contents,
    }))
}

/// A native folder picker for the results directory.
#[tauri::command]
pub async fn choose_result_folder(app: AppHandle) -> CommandResult<Option<String>> {
    let chosen = app
        .dialog()
        .file()
        .set_title("Choose a folder for saved results")
        .blocking_pick_folder();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| CommandError::new("invalid_path", error.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A native folder picker for per-room fallback assignments.
#[tauri::command]
pub async fn choose_assignment_folder(app: AppHandle) -> CommandResult<Option<String>> {
    let chosen = app
        .dialog()
        .file()
        .set_title("Choose a folder for fallback assignments")
        .blocking_pick_folder();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| CommandError::new("invalid_path", error.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Read an encrypted recovery package. The native layer treats it as opaque bytes: it never
/// parses, logs, decrypts, or places a management credential in a file path or diagnostic.
#[tauri::command]
pub async fn open_recovery_package(app: AppHandle) -> CommandResult<Option<OpenedFile>> {
    let chosen = app
        .dialog()
        .file()
        .add_filter("QBSheet encrypted recovery package", &["qbr"])
        .set_title("Open QBSheet recovery package")
        .blocking_pick_file();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| CommandError::new("invalid_path", error.to_string()))?;
    let metadata = std::fs::metadata(&path)
        .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
    if metadata.len() > MAX_RECOVERY_PACKAGE_BYTES as u64 {
        return Err(CommandError::new(
            "recovery_package_too_large",
            "That recovery package is larger than the 2 MiB limit.",
        ));
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
    Ok(Some(OpenedFile {
        path: path.to_string_lossy().into_owned(),
        contents,
    }))
}

/// Choose a folder and write one encrypted recovery package exclusively into it.
#[tauri::command]
pub async fn write_recovery_package(
    app: AppHandle,
    directory: String,
    file_name: String,
    contents: String,
) -> CommandResult<String> {
    if contents.len() > MAX_RECOVERY_PACKAGE_BYTES {
        return Err(CommandError::new(
            "recovery_package_too_large",
            "That recovery package is larger than the 2 MiB limit.",
        ));
    }
    let directory = if directory.is_empty() {
        let chosen = app
            .dialog()
            .file()
            .set_title("Choose a folder for the encrypted QBSheet recovery package")
            .blocking_pick_folder();
        let Some(chosen) = chosen else {
            return Err(CommandError::new(
                "cancelled",
                "No recovery-package folder was chosen.",
            ));
        };
        chosen
            .into_path()
            .map_err(|error| CommandError::new("invalid_path", error.to_string()))?
    } else {
        PathBuf::from(directory)
    };
    if !directory.is_dir() {
        return Err(CommandError::new(
            "no_such_folder",
            "That recovery-package folder no longer exists. Choose it again.",
        ));
    }
    let path = directory.join(safe_file_name(&file_name)?);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CommandError::new(
                    "recovery_package_exists",
                    "That recovery package file already exists and was not replaced.",
                )
            } else {
                CommandError::new("write_failed", error.to_string())
            }
        })?;
    std::io::Write::write_all(&mut file, contents.as_bytes())
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

const RELAY_CREDENTIAL_SERVICE: &str = "com.qbsheet.bridge.relay";

fn relay_credential_entry(key: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(RELAY_CREDENTIAL_SERVICE, key)
        .map_err(|error| CommandError::new("secure_storage_unavailable", error.to_string()))
}

/// Store the management credential in Windows Credential Manager/macOS Keychain. The value is
/// intentionally never returned, logged, serialized into BridgeState, or included in a package.
#[tauri::command]
pub async fn store_relay_credential(key: String, token: String) -> CommandResult<()> {
    if key.is_empty() || key.len() > 512 || token.is_empty() || token.len() > 1024 {
        return Err(CommandError::new(
            "invalid_credential",
            "The relay credential could not be stored.",
        ));
    }
    relay_credential_entry(&key)?
        .set_password(&token)
        .map_err(|error| CommandError::new("secure_storage_unavailable", error.to_string()))
}

/// Load a management credential from platform secure storage. `None` means that this relay has no
/// credential on this user profile; it is not an error and does not reveal a secret.
#[tauri::command]
pub async fn load_relay_credential(key: String) -> CommandResult<Option<String>> {
    if key.is_empty() || key.len() > 512 {
        return Err(CommandError::new(
            "invalid_credential",
            "The relay credential could not be loaded.",
        ));
    }
    match relay_credential_entry(&key)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CommandError::new(
            "secure_storage_unavailable",
            error.to_string(),
        )),
    }
}

/// Delete one relay credential from platform secure storage. Missing entries are already gone.
#[tauri::command]
pub async fn delete_relay_credential(key: String) -> CommandResult<()> {
    if key.is_empty() || key.len() > 512 {
        return Err(CommandError::new(
            "invalid_credential",
            "The relay credential could not be deleted.",
        ));
    }
    match relay_credential_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CommandError::new(
            "secure_storage_unavailable",
            error.to_string(),
        )),
    }
}

/// A filename, checked to be exactly that.
///
/// The name is composed in TypeScript from a team name and a room name that came out of a
/// tournament file, so it is not trusted to be free of separators: a name that traversed out of
/// the chosen folder would write a file somewhere the operator did not pick.
fn safe_file_name(name: &str) -> CommandResult<PathBuf> {
    let candidate = Path::new(name);
    let mut components = candidate.components();
    let (Some(Component::Normal(single)), None) = (components.next(), components.next()) else {
        return Err(CommandError::new(
            "invalid_file_name",
            "That bridge file name is not a plain file name.",
        ));
    };
    let single = Path::new(single);
    if single.to_string_lossy().starts_with('.') {
        return Err(CommandError::new(
            "invalid_file_name",
            "A bridge file name may not begin with a dot.",
        ));
    }
    Ok(single.to_path_buf())
}

/// Write one result file into the chosen folder, and report the full path.
///
/// Refuses an existing file unless `overwrite` says otherwise. A saved result is a completed game
/// that may not have been imported yet, and the relay can legitimately hold two results for one
/// match — a correction and the original. Replacing one with the other because their descriptive
/// names matched would destroy a game with nothing on screen to say so, so the create is
/// exclusive and a collision comes back as an error the operator can read.
#[tauri::command]
async fn write_bridge_file(
    directory: String,
    file_name: String,
    contents: String,
    overwrite: bool,
    kind: &'static str,
) -> CommandResult<String> {
    if contents.len() > MAX_RESULT_BYTES {
        return Err(CommandError::new(
            if kind == "result" {
                "result_too_large"
            } else {
                "assignment_too_large"
            },
            format!("That {kind} document is implausibly large."),
        ));
    }
    let directory = PathBuf::from(directory);
    if !directory.is_dir() {
        return Err(CommandError::new(
            "no_such_folder",
            format!("That {kind} output folder no longer exists. Choose it again."),
        ));
    }
    let path = directory.join(safe_file_name(&file_name)?);

    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true).truncate(true);
    } else {
        // `create_new` is the exclusive one: it fails rather than opening a file that is there.
        options.create_new(true);
    }
    let mut file = options.open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CommandError::new(
                if kind == "result" {
                    "result_file_exists"
                } else {
                    "assignment_file_exists"
                },
                format!(
                    "{} already exists in that folder and was not replaced. \
                     Move or rename it, or choose another output folder.",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ),
            )
        } else {
            CommandError::new("write_failed", error.to_string())
        }
    })?;
    std::io::Write::write_all(&mut file, contents.as_bytes())
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write one completed result. Re-saving is the only operation allowed to overwrite its own path.
#[tauri::command]
pub async fn write_result_file(
    directory: String,
    file_name: String,
    contents: String,
    overwrite: bool,
) -> CommandResult<String> {
    write_bridge_file(directory, file_name, contents, overwrite, "result").await
}

/// Write one unplayed QBJ assignment for the relay-outage fallback. Assignment exports are always
/// exclusive: exporting again must not replace a file a scorekeeper may already have opened.
#[tauri::command]
pub async fn write_assignment_file(
    directory: String,
    file_name: String,
    contents: String,
) -> CommandResult<String> {
    write_bridge_file(directory, file_name, contents, false, "assignment").await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationProbe {
    /// Bytes the probe wrote and read back intact.
    pub probe_bytes: u64,
    /// Bytes available to unprivileged writers on the destination volume, if reported.
    pub free_bytes: Option<u64>,
}

/// Prove the configured result destination can take a result file before Round 1.
///
/// Writes a uniquely named probe with an exclusive create, fsyncs it, renames it, reads it
/// back byte-for-byte, then deletes it, leaving nothing behind. The name can never collide
/// with a real result, and a failed probe removes its own partial file. A full disk or a
/// vanished folder fails here with the operating system's reason instead of mid-tournament.
fn probe_destination_inner(
    directory: &Path,
    first: &Path,
    second: &Path,
    mut file: std::fs::File,
) -> CommandResult<DestinationProbe> {
    const PROBE_BYTES: &[u8] = b"qbsheet-bridge readiness probe";
    std::io::Write::write_all(&mut file, PROBE_BYTES)
        .map_err(|error| CommandError::new("probe_write_failed", error.to_string()))?;
    file.sync_all()
        .map_err(|error| CommandError::new("probe_sync_failed", error.to_string()))?;
    drop(file);
    std::fs::rename(first, second)
        .map_err(|error| CommandError::new("probe_rename_failed", error.to_string()))?;
    let read_back = std::fs::read(second)
        .map_err(|error| CommandError::new("probe_read_failed", error.to_string()))?;
    if read_back.as_slice() != PROBE_BYTES {
        return Err(CommandError::new(
            "probe_mismatch",
            "The result folder returned different bytes than were written.",
        ));
    }
    Ok(DestinationProbe {
        probe_bytes: PROBE_BYTES.len() as u64,
        free_bytes: fs2::free_space(directory).ok(),
    })
}

#[tauri::command]
pub async fn probe_result_destination(directory: String) -> CommandResult<DestinationProbe> {
    let directory = PathBuf::from(directory);
    if !directory.is_dir() {
        return Err(CommandError::new(
            "no_such_folder",
            "That result output folder no longer exists. Choose it again.",
        ));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let first = directory.join(format!(".readiness-probe-{pid}-{stamp}.tmp"));
    let second = directory.join(format!(".readiness-probe-{pid}-{stamp}.verified"));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&first)
        .map_err(|error| CommandError::new("probe_write_failed", error.to_string()))?;
    let outcome = probe_destination_inner(&directory, &first, &second, file);
    // A failed probe removes its own partial file either way; the `.verified` name only
    // exists after a successful rename, and a passed probe removes both names.
    std::fs::remove_file(&first).ok();
    std::fs::remove_file(&second).ok();
    outcome
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub status: u16,
    pub body: String,
}

fn relay_response_too_large() -> CommandError {
    CommandError::new(
        "relay_response_too_large",
        "The relay answered with more data than QBSheet Bridge will read.",
    )
}

fn append_relay_response_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> CommandResult<()> {
    if chunk.len() > MAX_RELAY_RESPONSE_BYTES.saturating_sub(body.len()) {
        return Err(relay_response_too_large());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_relay_response_body(mut response: reqwest::Response) -> CommandResult<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| CommandError::new("relay_unreachable", error.to_string()))?
    {
        append_relay_response_chunk(&mut body, &chunk)?;
    }
    Ok(body)
}

/// One HTTP call to the relay.
///
/// Deliberately dumb: it does not know what a mirror is, retries nothing, and interprets no status
/// code. Every relay semantic lives in `src/model/relay.ts` next to the rest of the protocol
/// knowledge, so there is one place to read and one place to be wrong.
#[tauri::command]
pub async fn relay_request(
    method: String,
    url: String,
    bearer: Option<String>,
    body: Option<String>,
) -> CommandResult<RelayResponse> {
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| CommandError::new("invalid_url", "That relay address is not a valid URL."))?;
    if parsed.scheme() != "https"
        && parsed.host_str() != Some("127.0.0.1")
        && parsed.host_str() != Some("localhost")
    {
        // A management credential must not travel in the clear. `wrangler dev` on the loopback is
        // the one exception, because there is no network for it to travel over.
        return Err(CommandError::new(
            "insecure_url",
            "A relay address must use https.",
        ));
    }
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        other => {
            return Err(CommandError::new(
                "invalid_method",
                format!("QBSheet Bridge does not make {other} requests."),
            ))
        }
    };

    let client = reqwest::Client::builder()
        .timeout(RELAY_TIMEOUT)
        .build()
        .map_err(|error| CommandError::new("client_failed", error.to_string()))?;
    let mut request = client.request(method, parsed);
    if let Some(bearer) = bearer {
        request = request.header(reqwest::header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    if let Some(body) = body {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| CommandError::new("relay_unreachable", error.to_string()))?;
    let status = response.status().as_u16();
    let bytes = read_relay_response_body(response).await?;
    Ok(RelayResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_relay_response_chunk, probe_result_destination, safe_file_name, write_result_file,
        MAX_RELAY_RESPONSE_BYTES,
    };

    #[test]
    fn relay_response_under_bound_is_accepted() {
        let mut body = Vec::new();
        append_relay_response_chunk(&mut body, b"{}")
            .expect("a response under the bound should be accepted");
        assert_eq!(body, b"{}");
    }

    #[test]
    fn relay_response_at_bound_is_accepted() {
        let mut body = Vec::new();
        let chunk = vec![b'x'; MAX_RELAY_RESPONSE_BYTES];

        append_relay_response_chunk(&mut body, &chunk)
            .expect("a response at the bound should be accepted");
        assert_eq!(body.len(), MAX_RELAY_RESPONSE_BYTES);
    }

    #[test]
    fn relay_response_over_bound_is_rejected_before_appending() {
        let mut body = vec![b'x'; MAX_RELAY_RESPONSE_BYTES - 1];

        let error = append_relay_response_chunk(&mut body, b"xx")
            .expect_err("a response over the bound should be refused");
        assert_eq!(error.code, "relay_response_too_large");
        assert_eq!(body.len(), MAX_RELAY_RESPONSE_BYTES - 1);
    }

    #[test]
    fn plain_names_are_accepted() {
        assert_eq!(
            safe_file_name("R04_Room-101_Wren-A_vs_Dorman.result.qbj")
                .unwrap()
                .to_string_lossy(),
            "R04_Room-101_Wren-A_vs_Dorman.result.qbj"
        );
    }

    #[test]
    fn traversal_and_absolute_names_are_refused() {
        for name in [
            "../escaped.qbj",
            "nested/inside.qbj",
            "/absolute.qbj",
            "..",
            "",
            ".hidden.qbj",
        ] {
            assert!(safe_file_name(name).is_err(), "{name} should be refused");
        }
    }

    #[test]
    fn an_existing_result_is_not_replaced_unless_asked() {
        let directory = std::env::temp_dir().join(format!(
            "qbbridge-write-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let first = runtime
            .block_on(write_result_file(
                folder.clone(),
                name.clone(),
                "{\"first\":true}".to_owned(),
                false,
            ))
            .expect("the first write should succeed");

        // A second result whose descriptive name collided must not land on top of the first.
        let refused = runtime
            .block_on(write_result_file(
                folder.clone(),
                name.clone(),
                "{\"second\":true}".to_owned(),
                false,
            ))
            .expect_err("a colliding write should be refused");
        assert_eq!(refused.code, "result_file_exists");
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            "{\"first\":true}",
            "the original result must be untouched"
        );

        // Re-saving one result deliberately does replace its own file.
        runtime
            .block_on(write_result_file(
                folder,
                name,
                "{\"second\":true}".to_owned(),
                true,
            ))
            .expect("an explicit overwrite should succeed");
        assert_eq!(
            std::fs::read_to_string(&first).unwrap(),
            "{\"second\":true}"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    fn probe_temp_dir() -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "qbbridge-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_destination_probe_leaves_nothing_behind() {
        let directory = probe_temp_dir();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let report = runtime
            .block_on(probe_result_destination(
                directory.to_string_lossy().into_owned(),
            ))
            .expect("a writable folder should pass the probe");
        assert!(report.probe_bytes > 0);
        assert!(
            report.free_bytes.unwrap_or(0) > 0,
            "the temp volume should report free space"
        );
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            0,
            "the probe must remove its own files"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_vanished_folder_fails_the_probe_with_its_name() {
        let missing = std::env::temp_dir().join(format!(
            "qbbridge-probe-missing-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();

        let error = runtime
            .block_on(probe_result_destination(
                missing.to_string_lossy().into_owned(),
            ))
            .expect_err("a vanished folder must fail the probe");
        assert_eq!(error.code, "no_such_folder");
    }
}
