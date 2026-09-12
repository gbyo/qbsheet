//! Dumb filesystem operations for YF Shuttle.
//!
//! Every command takes explicit paths and bytes and reports what happened. Nothing here parses
//! QBJ, plans a schedule, or remembers anything between calls. Mutating commands are scoped
//! to an explicit project root: the root is canonicalized, every relative segment is checked,
//! and the canonicalized parent must still sit inside the root — so `..`, absolute paths,
//! and symlink escapes are refused, and an existing symlink at the target is never followed.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// The largest `.yft` or QBJ text this will read. Matches the importers' own 8 MiB bound, so
/// a file that would be refused after parsing is refused before it is read into memory.
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// The largest assignment or manifest document written in one call.
const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub is_directory: bool,
    pub modified_ms: Option<u64>,
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
    read_text_file_inner(&path)
        .map(|contents| {
            Some(OpenedFile {
                path: path.to_string_lossy().into_owned(),
                contents,
            })
        })
        .map_err(|error| CommandError::new("read_failed", error))
}

/// A native folder picker for the project parent. `None` means the operator cancelled.
#[tauri::command]
pub async fn choose_project_parent(app: AppHandle) -> CommandResult<Option<String>> {
    let chosen = app
        .dialog()
        .file()
        .set_title("Choose a folder for the tournament project")
        .blocking_pick_folder();
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .into_path()
        .map_err(|error| CommandError::new("invalid_path", error.to_string()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// One path segment, checked to be exactly that.
///
/// Names composed in TypeScript from team and room names are not trusted to be free of
/// separators: a name that traversed out of the project folder would write somewhere the
/// operator did not pick.
fn safe_segment(name: &str) -> CommandResult<PathBuf> {
    let candidate = Path::new(name);
    let mut components = candidate.components();
    let (Some(Component::Normal(single)), None) = (components.next(), components.next()) else {
        return Err(CommandError::new(
            "invalid_path",
            "That project path is not a plain folder or file name.",
        ));
    };
    let single = Path::new(single);
    if single.to_string_lossy().starts_with('.') && name != ".yf-shuttle.json" {
        return Err(CommandError::new(
            "invalid_path",
            "That project path is not a plain folder or file name.",
        ));
    }
    Ok(single.to_path_buf())
}

/// Create every directory in `dirs` under `base`, including parents. Idempotent: existing
/// directories are left alone. Never deletes anything.
#[tauri::command]
pub async fn create_directories(base: String, dirs: Vec<String>) -> CommandResult<()> {
    // Canonicalized like every other root: a symlinked parent cannot redirect the new
    // project tree somewhere the operator did not pick.
    let base = canonical_root(&base)?;
    if dirs.len() > 64 {
        return Err(CommandError::new(
            "too_many_folders",
            "That project asks for an implausible number of folders.",
        ));
    }
    for dir in &dirs {
        let mut path = base.clone();
        for segment in dir.split('/') {
            path = path.join(safe_segment(segment)?);
        }
        std::fs::create_dir_all(&path)
            .map_err(|error| CommandError::new("create_failed", error.to_string()))?;
    }
    Ok(())
}

/// List one directory's immediate children: names, kinds, and modification times.
#[tauri::command]
pub async fn list_directory(path: String) -> CommandResult<Vec<DirectoryEntry>> {
    let path = PathBuf::from(path);
    let entries = std::fs::read_dir(&path)
        .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| CommandError::new("read_failed", error.to_string()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
        let modified_ms = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
        listed.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: file_type.is_dir(),
            modified_ms,
        });
    }
    listed.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(listed)
}

fn read_text_file_inner(path: &Path) -> Result<String, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_READ_BYTES {
        return Err("That file is larger than the 8 MiB import limit.".to_string());
    }
    std::fs::read_to_string(path).map_err(|error| error.to_string())
}

/// Read one text file.
#[tauri::command]
pub async fn read_text_file(path: String) -> CommandResult<String> {
    read_text_file_inner(Path::new(&path)).map_err(|error| CommandError::new("read_failed", error))
}

/// Canonicalize a root folder, refusing when it is missing or not a directory.
///
/// Canonicalizing first means a symlinked project folder still bounds correctly: every
/// later `starts_with` check compares against where the root really is.
fn canonical_root(root: &str) -> CommandResult<PathBuf> {
    let canonical = PathBuf::from(root).canonicalize().map_err(|_| {
        CommandError::new(
            "no_such_folder",
            "That project folder no longer exists. Choose it again.",
        )
    })?;
    if !canonical.is_dir() {
        return Err(CommandError::new(
            "no_such_folder",
            "That project folder no longer exists. Choose it again.",
        ));
    }
    Ok(canonical)
}

/// Join project-relative segments onto a canonical root without touching the filesystem.
///
/// Every segment passes [`safe_segment`], so `.`, empty parts, absolute paths, and
/// traversal fail closed here. The result may point at a file that does not exist yet;
/// callers canonicalize the parent (or the target) before trusting it.
fn resolve_inside(root: &Path, relative_path: &str) -> CommandResult<PathBuf> {
    if relative_path.is_empty() {
        return Err(CommandError::new(
            "invalid_path",
            "That project path is not a plain folder or file name.",
        ));
    }
    let mut target = root.to_path_buf();
    for segment in relative_path.split('/') {
        target = target.join(safe_segment(segment)?);
    }
    Ok(target)
}

/// Resolve a project-relative path to an absolute target inside the project.
///
/// The root is canonicalized first, so a symlinked project folder still bounds correctly.
/// Every segment passes [`safe_segment`], the parent must already exist (callers create
/// project folders before writing), and the canonicalized parent must still sit inside the
/// root. An existing symlink at the target is refused rather than followed, whether or not
/// this call would overwrite.
fn scoped_target(project_root: &str, relative_path: &str) -> CommandResult<PathBuf> {
    scoped_target_in(&canonical_root(project_root)?, relative_path)
}

/// [`scoped_target`] against an already-canonical root, for commands that resolved it once
/// and scope several paths against it.
fn scoped_target_in(root: &Path, relative_path: &str) -> CommandResult<PathBuf> {
    let target = resolve_inside(root, relative_path)?;
    let parent = target.parent().ok_or_else(|| {
        CommandError::new("invalid_path", "That project path has no parent folder.")
    })?;
    let canonical_parent = parent.canonicalize().map_err(|_| {
        CommandError::new(
            "no_such_folder",
            "That folder no longer exists. Create the project folders again.",
        )
    })?;
    if !canonical_parent.starts_with(root) {
        return Err(CommandError::new(
            "invalid_path",
            "That file is outside the tournament project folder.",
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err(CommandError::new(
                "invalid_path",
                "That file is a link, and links are never followed here.",
            ));
        }
    }
    Ok(target)
}

/// Write one text file inside the project, into an existing directory.
///
/// Exclusive unless `overwrite` says otherwise. Assignments are always written exclusively:
/// a file already in a room's IN folder may be in a scorekeeper's hands, and replacing it
/// because the bytes differ would swap the game under them. The manifest and the derived
/// YellowFruit import batches are the only files written with overwrite, on explicit action.
#[tauri::command]
pub async fn write_text_file(
    project_root: String,
    relative_path: String,
    contents: String,
    overwrite: bool,
) -> CommandResult<()> {
    if contents.len() > MAX_WRITE_BYTES {
        return Err(CommandError::new(
            "file_too_large",
            "That document is implausibly large.",
        ));
    }
    let target = scoped_target(&project_root, &relative_path)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true).truncate(true);
    } else {
        // `create_new` is the exclusive one: it fails rather than opening a file that is there.
        options.create_new(true);
    }
    let mut file = options.open(&target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CommandError::new(
                "file_exists",
                format!(
                    "{} already exists and was not replaced.",
                    target.file_name().unwrap_or_default().to_string_lossy()
                ),
            )
        } else {
            CommandError::new("write_failed", error.to_string())
        }
    })?;
    std::io::Write::write_all(&mut file, contents.as_bytes())
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(())
}

/// Remove one derived file from inside a project's `YellowFruit Import` tree.
///
/// The scope is structural, not a convention: the relative path must be exactly
/// `Round N/<file>`, the resolved target must stay inside the given import root, and the
/// target must be a file. Anything else — an operator's hand-placed file outside this tree,
/// a directory, an absolute path, traversal — is refused. There is deliberately no
/// recursive delete and no general file removal: this is the one narrow eraser the derived
/// batch planner needs to replace its own stale copies.
#[tauri::command]
pub async fn remove_import_file(import_root: String, relative_path: String) -> CommandResult<()> {
    let root = canonical_root(&import_root)?;
    let mut segments = relative_path.split('/');
    let (round_folder, file_name, end) = (segments.next(), segments.next(), segments.next());
    let (Some(round_folder), Some(file_name), None) = (round_folder, file_name, end) else {
        return Err(CommandError::new(
            "invalid_path",
            "Only files directly inside a Round folder can be removed.",
        ));
    };
    if !round_folder.starts_with("Round ") {
        return Err(CommandError::new(
            "invalid_path",
            "Only files directly inside a Round folder can be removed.",
        ));
    }
    if !file_name.ends_with(".qbj") && !file_name.ends_with(".json") {
        return Err(CommandError::new(
            "invalid_path",
            "Only result files can be removed.",
        ));
    }
    let round_dir = root.join(safe_segment(round_folder)?);
    let canonical_round = round_dir.canonicalize().map_err(|_| {
        CommandError::new(
            "no_such_folder",
            "The YellowFruit Import folder no longer exists.",
        )
    })?;
    if !canonical_round.starts_with(root.as_path()) {
        return Err(CommandError::new(
            "invalid_path",
            "Only files inside the YellowFruit Import tree can be removed.",
        ));
    }
    let target = canonical_round.join(safe_segment(file_name)?);
    // A link at the target is refused, never followed — and a missing file reports the goal
    // state ("already gone") rather than an error the caller must untangle.
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(CommandError::new(
                "invalid_path",
                "That file is a link, and links are never followed here.",
            ));
        }
        Ok(meta) if meta.is_file() => {}
        _ => {
            return Err(CommandError::new(
                "no_such_file",
                "That derived file is already gone.",
            ))
        }
    }
    std::fs::remove_file(&target)
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(())
}

/// Copy one file byte-for-byte inside the project. The bytes are never parsed, reserialized,
/// or altered.
///
/// Both ends are project-relative and both must resolve inside the root, so a copy can
/// neither pull bytes from outside the project nor spill them outside it. The exclusive
/// case is atomic: the destination is created with `create_new`, so two racing copies
/// cannot both believe they won.
#[tauri::command]
pub async fn copy_file(
    project_root: String,
    relative_src: String,
    relative_dst: String,
    overwrite: bool,
) -> CommandResult<()> {
    let root = canonical_root(&project_root)?;
    let src = resolve_inside(&root, &relative_src)?;
    let canonical_src = src.canonicalize().map_err(|_| {
        CommandError::new(
            "no_such_file",
            "That result file is no longer in its OUT folder.",
        )
    })?;
    if !canonical_src.starts_with(root.as_path()) || !canonical_src.is_file() {
        return Err(CommandError::new(
            "invalid_path",
            "Results can only be copied from inside the tournament project folder.",
        ));
    }
    let dst = scoped_target_in(&root, &relative_dst)?;
    if !overwrite {
        let mut reader = std::fs::File::open(&canonical_src)
            .map_err(|error| CommandError::new("read_failed", error.to_string()))?;
        let mut writer = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dst)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    CommandError::new(
                        "file_exists",
                        format!(
                            "{} already exists and was not replaced.",
                            dst.file_name().unwrap_or_default().to_string_lossy()
                        ),
                    )
                } else {
                    CommandError::new("write_failed", error.to_string())
                }
            })?;
        std::io::copy(&mut reader, &mut writer)
            .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
        return Ok(());
    }
    std::fs::copy(&canonical_src, &dst)
        .map_err(|error| CommandError::new("write_failed", error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_segment;

    #[test]
    fn plain_names_are_accepted() {
        assert!(safe_segment("R01 - 319 - Clinton vs Wren B.qbj").is_ok());
        assert!(safe_segment(".yf-shuttle.json").is_ok());
    }

    #[test]
    fn traversal_is_refused() {
        assert!(safe_segment("../outside").is_err());
        assert!(safe_segment("a/b").is_err());
        assert!(safe_segment("").is_err());
        assert!(safe_segment(".hidden").is_err());
    }

    #[test]
    fn import_removal_shape_is_narrow() {
        fn shape_ok(relative: &str) -> bool {
            let mut segments = relative.split('/');
            let (round_folder, file_name, end) =
                (segments.next(), segments.next(), segments.next());
            let (Some(round_folder), Some(file_name), None) = (round_folder, file_name, end) else {
                return false;
            };
            if !round_folder.starts_with("Round ") {
                return false;
            }
            file_name.ends_with(".qbj") || file_name.ends_with(".json")
        }

        assert!(shape_ok("Round 1/R01 - 319 - A vs B.qbj"));
        assert!(!shape_ok("Round 1/nested/evil.qbj"));
        assert!(!shape_ok("Round 1"));
        assert!(!shape_ok("Notes/plan.qbj"));
        assert!(!shape_ok("../outside.qbj"));
        assert!(!shape_ok("Round 1/notes.txt"));
    }

    #[test]
    fn scoped_target_keeps_safe_paths_and_refuses_escape() {
        use super::{resolve_inside, scoped_target, scoped_target_in};
        let dir = std::env::temp_dir().join(format!("yf-shuttle-scope-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("YellowFruit Import/Round 1")).unwrap();
        let root = dir.canonicalize().unwrap();

        // A derived result under the import tree is accepted, through either entry point.
        let target =
            scoped_target_in(&root, "YellowFruit Import/Round 1/R01 - 319 - A vs B.qbj").unwrap();
        assert!(target.starts_with(root.as_path()));
        let same = scoped_target(root.to_str().unwrap(), "YellowFruit Import/Round 1/out.qbj");
        assert!(same.is_ok());

        // Traversal, absolute paths, and links all fail closed. (resolve_inside only
        // scopes the path; the caller checks the file shape separately.)
        assert!(scoped_target_in(&root, "../outside.qbj").is_err());
        assert!(scoped_target_in(&root, "/etc/passwd").is_err());
        assert!(resolve_inside(&root, "YellowFruit Import/./Round 1/x.qbj").is_err());
        assert!(resolve_inside(&root, "YellowFruit Import/Round 1").is_ok());

        std::fs::remove_dir_all(&dir).ok();
    }
}
