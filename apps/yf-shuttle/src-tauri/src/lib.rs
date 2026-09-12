//! The native shell for YF Shuttle.
//!
//! Filesystem operations only, no application state, no background tasks, no server. Everything
//! that decides anything — what a pairing is, what an assignment says, which result speaks for
//! which game — is TypeScript. Rust is here for the things a web page cannot do well: a real
//! open dialog, a real folder picker, creating nested folders, and writing dozens of files
//! without a download prompt each.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::open_yellowfruit_file,
            commands::choose_project_parent,
            commands::create_directories,
            commands::list_directory,
            commands::read_text_file,
            commands::write_text_file,
            commands::copy_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running YF Shuttle");
}
