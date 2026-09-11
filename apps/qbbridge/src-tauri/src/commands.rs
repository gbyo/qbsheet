//! The four native operations.

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
            "That result file name is not a plain file name.",
        ));
    };
    let single = Path::new(single);
    if single.to_string_lossy().starts_with('.') {
        return Err(CommandError::new(
            "invalid_file_name",
            "A result file name may not begin with a dot.",
        ));
    }
    Ok(single.to_path_buf())
}

/// Write one result file into the chosen folder, and report the full path.
#[tauri::command]
pub async fn write_result_file(
    directory: String,
    file_name: String,
    contents: String,
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
            "That results folder no longer exists. Choose it again.",
        ));
    }
    let path = directory.join(safe_file_name(&file_name)?);
    std::fs::write(&path, contents)
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub status: u16,
    pub body: String,
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
    let bytes = response
        .bytes()
        .await
        .map_err(|error| CommandError::new("relay_unreachable", error.to_string()))?;
    if bytes.len() > MAX_RELAY_RESPONSE_BYTES {
        return Err(CommandError::new(
            "relay_response_too_large",
            "The relay answered with more data than QBSheet Bridge will read.",
        ));
    }
    Ok(RelayResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

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
}
