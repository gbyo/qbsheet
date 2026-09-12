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

/// Counter that keeps temporary result names unique within this process.
static RESULT_TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Write one completed result durably, and report the full path.
///
/// The bytes go to a temporary file in the same folder first, are flushed and fsynced, and only
/// then are atomically renamed onto the final name; the folder itself is synced afterwards where
/// the platform allows. Crash ordering is the point: a crash before the rename leaves only a
/// leftover temporary file beside the final name, and a crash after it leaves the complete
/// final file. There is no window in which the final name holds a partial result.
///
/// Exclusivity matches `write_result_file`: an existing final file is refused unless `overwrite`
/// says otherwise, so a corrected final still cannot quietly replace the original.
#[tauri::command]
pub async fn write_result_file_durable(
    directory: String,
    file_name: String,
    contents: String,
    overwrite: bool,
) -> CommandResult<String> {
    if contents.len() > MAX_RESULT_BYTES {
        return Err(CommandError::new(
            "result_too_large",
            "That result document is implausibly large.",
        ));
    }
    let directory = PathBuf::from(directory);
    if !directory.is_dir() {
        return Err(CommandError::new(
            "no_such_folder",
            "That result output folder no longer exists. Choose it again.",
        ));
    }
    let safe_name = safe_file_name(&file_name)?;
    let final_path = directory.join(&safe_name);
    let exists_error = || {
        CommandError::new(
            "result_file_exists",
            format!(
                "{} already exists in that folder and was not replaced. \
                 Move or rename it, or choose another output folder.",
                final_path.file_name().unwrap_or_default().to_string_lossy()
            ),
        )
    };
    if !overwrite && final_path.exists() {
        return Err(exists_error());
    }
    // Same folder, so the rename below is atomic: no copy across filesystems, no partial final.
    // The suffix keeps the temporary name a plain file name that can never collide with a real
    // result, and the counter plus process id keep concurrent saves from sharing one.
    let temporary_name = format!(
        "{}.qbbridge-tmp-{}-{}",
        safe_name.to_string_lossy(),
        std::process::id(),
        RESULT_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let temporary_path = directory.join(temporary_name);
    let outcome = (|| -> CommandResult<()> {
        let mut temporary = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
        std::io::Write::write_all(&mut temporary, contents.as_bytes())
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
        temporary
            .sync_all()
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
        drop(temporary);
        // Set when an overwrite landed a replacement while a preserved copy still sits
        // beside it. The backup is removed only after the sync below proves the new
        // directory entry durable — never as part of error cleanup.
        let mut pending_backup: Option<PathBuf> = None;
        if overwrite {
            // Preserve the replaced bytes under a unique backup name until the replacement
            // lands. Remove-then-rename leaves a window holding neither copy; two renames
            // always leave one complete copy on disk (and the ledger holds the QBJ either
            // way). Overwrite only ever re-saves one result over its own path. A final
            // that was never there is not an error — there is simply nothing to preserve.
            let backup_name = format!(
                "{}.qbbridge-bak-{}-{}",
                safe_name.to_string_lossy(),
                std::process::id(),
                RESULT_TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let backup_path = directory.join(backup_name);
            publish_durable_replacement(
                &directory,
                &temporary_path,
                &final_path,
                &backup_path,
                &|from, to| std::fs::rename(from, to),
            )?;
            // The replacement landed and the directory entry is synced below; only now is
            // the preserved copy redundant. Its absence is never an error — a crash between
            // the sync and this removal simply leaves evidence behind.
            pending_backup = Some(backup_path);
        } else {
            // Atomic no-replace publish: link(2) fails when the final name exists instead
            // of replacing it, closing the check-then-rename race between concurrent saves.
            // Same folder, so always the same filesystem on every platform; the upfront
            // exists() check above stays as the friendly fast path.
            std::fs::hard_link(&temporary_path, &final_path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    exists_error()
                } else {
                    CommandError::new("write_failed", error.to_string())
                }
            })?;
            // The temporary name served its purpose; the final name holds the only link
            // now. The outer error path removes the temporary name on failure either way.
            let _ = std::fs::remove_file(&temporary_path);
        }
        sync_directory(&directory)?;
        if let Some(backup) = pending_backup {
            let _ = std::fs::remove_file(backup);
        }
        Ok(())
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    outcome?;
    Ok(final_path.to_string_lossy().into_owned())
}

/// Swap an fsynced temporary result onto its final name without ever destroying the
/// only known-good copy.
///
/// The previous final (when there is one) is renamed aside to `backup_path` first, so a
/// crash or error between the two renames always leaves one complete copy on disk. The
/// backup is deliberately *not* removed here: the caller deletes it only after the sync
/// that follows proves the new directory entry durable. On replacement failure the backup
/// is rolled back onto the final name; when the rollback itself fails the backup is left
/// in place and the error names it, so the previous result stays recoverable by hand.
///
/// `rename` is a hook rather than a direct call so tests can fault-inject the second
/// rename. Production always passes `std::fs::rename`.
fn publish_durable_replacement(
    directory: &Path,
    temporary_path: &Path,
    final_path: &Path,
    backup_path: &Path,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> CommandResult<()> {
    if let Err(error) = rename(final_path, backup_path) {
        if error.kind() == std::io::ErrorKind::NotFound {
            // Nothing to preserve: a first write wearing overwrite's clothes.
            return rename(temporary_path, final_path)
                .map_err(|error| CommandError::new("write_failed", error.to_string()));
        }
        return Err(CommandError::new("write_failed", error.to_string()));
    }
    if let Err(error) = rename(temporary_path, final_path) {
        // The replacement did not land, so the only complete copy is the backup. Put it
        // back before reporting, and re-sync best-effort so the restored name is durable.
        if let Err(rollback) = rename(backup_path, final_path) {
            return Err(CommandError::new(
                "write_failed",
                format!(
                    "The replacement result could not be published ({error}), and restoring \
                     the previous result also failed ({rollback}). The previous result is \
                     preserved as {}; move it back to {} before saving again.",
                    backup_path.display(),
                    final_path.display(),
                ),
            ));
        }
        let _ = sync_directory(directory);
        return Err(CommandError::new("write_failed", error.to_string()));
    }
    Ok(())
}

/// Directory sync after a durable rename. The file fsync above orders the bytes; this syncs
/// the name itself, and a failure fails the save: reporting success (and relay-acknowledging)
/// while the directory entry may not survive a crash would hollow out the durability this
/// command exists to provide.
fn sync_directory(directory: &Path) -> CommandResult<()> {
    #[cfg(unix)]
    {
        let handle = std::fs::File::open(directory)
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
        handle
            .sync_all()
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
    }
    Ok(())
}

/// Read one result file back, bounded like every other bridge read.
///
/// The caller compares the bytes against what it meant to write. A missing or unreadable file
/// is an error, never an empty document: silence here would turn a lost game into a saved one.
#[tauri::command]
pub async fn read_result_file(path: String) -> CommandResult<String> {
    let oversize = || {
        CommandError::new(
            "result_unreadable",
            "That result file is larger than any result QBBridge writes. It was left unsaved.",
        )
    };
    // Bound the read before allocating: take at most one byte past the limit, so a racing
    // grower can cost no more than the limit plus one no matter how large the file becomes
    // between the open and the read. A metadata pre-check alone could not do that — the
    // file may grow after the metadata is read but before the bytes are allocated.
    let mut file = std::fs::File::open(&path).map_err(|_| {
        CommandError::new(
            "result_unreadable",
            "That result file could not be read back. It was left unsaved.",
        )
    })?;
    let mut bytes = Vec::new();
    use std::io::Read as _;
    file.by_ref()
        .take(MAX_RESULT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            CommandError::new(
                "result_unreadable",
                "That result file could not be read back. It was left unsaved.",
            )
        })?;
    if bytes.len() > MAX_RESULT_BYTES {
        return Err(oversize());
    }
    String::from_utf8(bytes).map_err(|_| {
        CommandError::new(
            "result_unreadable",
            "That result file is not valid text. It was left unsaved.",
        )
    })
}

/// Remove one result file, so a proven-bad write never wedges its own retry.
///
/// This only ever runs against paths the ledger already attributes to a result — our own
/// residue from a write whose readback failed, or a ledger slot whose bytes no longer match.
/// A foreign file that merely collides with a result name is refused by the exclusive write
/// and is never removed here: deleting what QBBridge did not write would destroy evidence.
/// Missing files are fine; cleanup is idempotent by design.
#[tauri::command]
pub async fn remove_result_file(path: String) -> CommandResult<()> {
    let file_name = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !file_name.ends_with(".result.qbj") {
        return Err(CommandError::new(
            "refused",
            "Only result files can be removed this way.",
        ));
    }
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::new("write_failed", error.to_string())),
    }
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
        append_relay_response_chunk, safe_file_name, write_result_file, MAX_RELAY_RESPONSE_BYTES,
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

    fn durable_test_dir(name: &str) -> (std::path::PathBuf, tokio::runtime::Runtime) {
        let directory = std::env::temp_dir().join(format!(
            "qbbridge-durable-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        (directory, runtime)
    }

    #[test]
    fn a_durable_write_reads_back_exactly_what_was_sent() {
        use super::{read_result_file, write_result_file_durable};
        let (directory, runtime) = durable_test_dir("roundtrip");
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();
        let contents = "{\"final\":true,\"points\":[10,20]}".to_owned();

        let path = runtime
            .block_on(write_result_file_durable(
                folder,
                name,
                contents.clone(),
                false,
            ))
            .expect("the durable write should succeed");
        assert_eq!(
            runtime.block_on(read_result_file(path)).unwrap(),
            contents,
            "readback must be byte-identical to what was sent"
        );
        // No temporary file survives a successful write.
        let leftovers: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(".qbbridge-tmp-")
            })
            .collect();
        assert!(leftovers.is_empty(), "temporary files must be renamed away");

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_durable_write_keeps_exclusivity_and_overwrite_semantics() {
        use super::write_result_file_durable;
        let (directory, runtime) = durable_test_dir("exclusive");
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();

        runtime
            .block_on(write_result_file_durable(
                folder.clone(),
                name.clone(),
                "{\"first\":true}".to_owned(),
                false,
            ))
            .expect("the first durable write should succeed");
        let refused = runtime
            .block_on(write_result_file_durable(
                folder.clone(),
                name.clone(),
                "{\"second\":true}".to_owned(),
                false,
            ))
            .expect_err("a colliding durable write should be refused");
        assert_eq!(refused.code, "result_file_exists");
        runtime
            .block_on(write_result_file_durable(
                folder,
                name,
                "{\"second\":true}".to_owned(),
                true,
            ))
            .expect("an explicit durable overwrite should succeed");

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn concurrent_exclusive_writes_publish_exactly_once() {
        use super::write_result_file_durable;
        let (directory, _runtime) = durable_test_dir("concurrent");
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();
        // Hammer the same final name from several threads at once: the losers must be
        // refused with result_file_exists, never silently replace the winner. Each thread
        // drives its own runtime because the publish fence lives in the filesystem, not
        // in any await point.
        let outcomes: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|index| {
                    let folder = folder.clone();
                    let name = name.clone();
                    scope.spawn(move || {
                        let runtime = tokio::runtime::Builder::new_current_thread()
                            .build()
                            .unwrap();
                        runtime.block_on(write_result_file_durable(
                            folder,
                            name,
                            format!("{{\"writer\":{index}}}"),
                            false,
                        ))
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("a writer thread must not panic"))
                .collect()
        });
        let succeeded = outcomes.iter().filter(|outcome| outcome.is_ok()).count();
        assert_eq!(succeeded, 1, "exactly one concurrent writer must win");
        for outcome in &outcomes {
            if let Err(error) = outcome {
                assert_eq!(error.code, "result_file_exists");
            }
        }
        let bytes = std::fs::read(directory.join(&name)).unwrap();
        assert!(
            bytes.starts_with(b"{\"writer\":"),
            "the winner's bytes must survive intact"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_durable_overwrite_preserves_a_copy_until_the_replacement_lands() {
        use super::write_result_file_durable;
        let (directory, runtime) = durable_test_dir("overwrite");
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();

        runtime
            .block_on(write_result_file_durable(
                folder.clone(),
                name.clone(),
                "{\"first\":true}".to_owned(),
                false,
            ))
            .expect("the first durable write should succeed");
        let path = runtime
            .block_on(write_result_file_durable(
                folder,
                name,
                "{\"second\":true}".to_owned(),
                true,
            ))
            .expect("an explicit durable overwrite should succeed");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"second\":true}",
            "the replacement must hold the new bytes"
        );
        // Neither the temporary file nor the preserved backup survives a success.
        let leftovers: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.contains(".qbbridge-tmp-") || name.contains(".qbbridge-bak-")
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "no working files must survive a success"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_failed_replacement_rolls_the_preserved_copy_back() {
        use super::publish_durable_replacement;
        let (directory, _runtime) = durable_test_dir("overwrite-rollback");
        let final_path = directory.join("R04_Room-101_A_vs_B_a81f3c.result.qbj");
        let temporary_path = directory.join("replacement.qbbridge-tmp-0");
        let backup_path = directory.join("previous.qbbridge-bak-0");
        std::fs::write(&final_path, "{\"first\":true}").unwrap();
        std::fs::write(&temporary_path, "{\"second\":true}").unwrap();

        // Fail exactly the temp-to-final rename; every other rename really runs.
        let rename = |from: &std::path::Path, to: &std::path::Path| {
            if from == temporary_path.as_path() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected temp-to-final failure",
                ));
            }
            std::fs::rename(from, to)
        };

        let error = publish_durable_replacement(
            &directory,
            &temporary_path,
            &final_path,
            &backup_path,
            &rename,
        )
        .expect_err("a failed replacement must report, not pretend");
        assert_eq!(error.code, "write_failed");
        assert_eq!(
            std::fs::read_to_string(&final_path).unwrap(),
            "{\"first\":true}",
            "the previous result must be rolled back onto the final name"
        );
        assert!(
            !backup_path.exists(),
            "a restored backup must not linger beside the final"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_failed_rollback_preserves_the_backup_and_names_it() {
        use super::publish_durable_replacement;
        let (directory, _runtime) = durable_test_dir("overwrite-rollback-failed");
        let final_path = directory.join("R04_Room-101_A_vs_B_a81f3c.result.qbj");
        let temporary_path = directory.join("replacement.qbbridge-tmp-0");
        let backup_path = directory.join("previous.qbbridge-bak-0");
        std::fs::write(&final_path, "{\"first\":true}").unwrap();
        std::fs::write(&temporary_path, "{\"second\":true}").unwrap();

        // Fail the temp-to-final rename and the backup-to-final rollback alike.
        let rename = |from: &std::path::Path, to: &std::path::Path| {
            if from == temporary_path.as_path() || from == backup_path.as_path() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected replacement and rollback failure",
                ));
            }
            std::fs::rename(from, to)
        };

        let error = publish_durable_replacement(
            &directory,
            &temporary_path,
            &final_path,
            &backup_path,
            &rename,
        )
        .expect_err("a doubly failed replacement must report loudly");
        assert_eq!(error.code, "write_failed");
        // The backup is the only complete copy left: it must survive with the old bytes,
        // and the message must say exactly where it is so the operator can recover it.
        assert_eq!(
            std::fs::read_to_string(&backup_path).unwrap(),
            "{\"first\":true}",
            "the previous result must stay recoverable in the preserved backup"
        );
        let backup_display = backup_path.display().to_string();
        assert!(
            error.message.contains(&backup_display),
            "the error must name the preserved backup, got: {}",
            error.message
        );
        assert!(
            !final_path.exists(),
            "nothing complete may masquerade as the final result"
        );

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_durable_overwrite_without_a_prior_file_behaves_like_a_first_write() {
        use super::write_result_file_durable;
        let (directory, runtime) = durable_test_dir("overwrite-missing");
        let folder = directory.to_string_lossy().into_owned();

        let path = runtime
            .block_on(write_result_file_durable(
                folder,
                "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned(),
                "{\"only\":true}".to_owned(),
                true,
            ))
            .expect("overwrite with nothing to preserve should succeed");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"only\":true}");

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn a_durable_write_to_a_missing_folder_fails_before_touching_anything() {
        use super::write_result_file_durable;
        let (_directory, runtime) = durable_test_dir("missing");
        let missing = std::env::temp_dir().join(format!(
            "qbbridge-durable-gone-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let error = runtime
            .block_on(write_result_file_durable(
                missing.to_string_lossy().into_owned(),
                "R04_A_vs_B.result.qbj".to_owned(),
                "{}".to_owned(),
                false,
            ))
            .expect_err("a write without a folder should fail");
        assert_eq!(error.code, "no_such_folder");
    }

    #[test]
    fn reading_a_missing_result_is_an_error_never_an_empty_document() {
        use super::read_result_file;
        let (directory, runtime) = durable_test_dir("readback");
        let missing = directory.join("never-written.result.qbj");
        let error = runtime
            .block_on(read_result_file(missing.to_string_lossy().into_owned()))
            .expect_err("a missing file should be an error");
        assert_eq!(error.code, "result_unreadable");

        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn removing_a_result_clears_proven_bad_bytes_but_never_foreign_files() {
        use super::{remove_result_file, write_result_file_durable};
        let (directory, runtime) = durable_test_dir("remove");
        let folder = directory.to_string_lossy().into_owned();
        let name = "R04_Room-101_A_vs_B_a81f3c.result.qbj".to_owned();

        let path = runtime
            .block_on(write_result_file_durable(
                folder,
                name,
                "{\"final\":true}".to_owned(),
                false,
            ))
            .expect("the durable write should succeed");
        runtime
            .block_on(remove_result_file(path.clone()))
            .expect("removing our own residue should succeed");
        assert!(
            !std::path::Path::new(&path).exists(),
            "the proven-bad file must be gone so a retry starts clean"
        );
        // Cleanup is idempotent: a second remove is fine, not an error.
        runtime
            .block_on(remove_result_file(path))
            .expect("removing a missing result should succeed");

        let error = runtime
            .block_on(remove_result_file(
                directory.join("notes.txt").to_string_lossy().into_owned(),
            ))
            .expect_err("a non-result file must be refused");
        assert_eq!(error.code, "refused");

        std::fs::remove_dir_all(&directory).ok();
    }
}
