//! The native shell for QBSheet Bridge.
//!
//! Twelve commands, no state, no background tasks, no server. Everything that decides anything —
//! what a pairing is, what an assignment says, which results are new — is TypeScript. Rust is
//! here for the things a web page cannot do on a tournament morning: a real open dialog, a real
//! folder picker, writing a dozen files without a download prompt each, and an HTTP client with
//! no browser `Origin` attached.
//!
//! That last one is the only subtle reason. The relay validates `Origin` on every credentialed
//! route against the operator's allowlist. Making the management calls from the WebView would
//! mean adding a desktop application's origin to a list that exists to keep arbitrary pages away
//! from tournament control. A native request sends no `Origin`, needs no preflight, and changes
//! nothing about the relay's CORS policy.

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::open_yellowfruit_file,
            commands::choose_result_folder,
            commands::choose_assignment_folder,
            commands::open_recovery_package,
            commands::write_recovery_package,
            commands::store_relay_credential,
            commands::load_relay_credential,
            commands::delete_relay_credential,
            commands::write_result_file,
            commands::write_assignment_file,
            commands::probe_result_destination,
            commands::relay_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QBSheet Bridge");
}
