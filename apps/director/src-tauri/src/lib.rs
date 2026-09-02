#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod live;
mod live_server;
mod server;
mod store;
mod transfers;

use tauri::{Manager, Wry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::<Wry>::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let paths = commands::app_paths(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::other(error.message))
            })?;
            let store =
                store::DirectorStore::open(paths.database.clone().into()).map_err(|error| {
                    Box::<dyn std::error::Error>::from(std::io::Error::other(error.to_string()))
                })?;
            std::fs::create_dir_all(&paths.backups).map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::other(error.to_string()))
            })?;
            app.manage(store);
            app.manage(server::ServerRuntime::default());
            app.manage(transfers::TransferRoots::default());
            // The QBSheet Live management credential goes to the operating system's credential
            // store, never to the tournament database. See `live.rs`.
            app.manage(commands::LiveCredentials::default());
            app.manage(live_server::LiveServerRuntime::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_application_paths,
            commands::get_store_status,
            commands::director_load_state,
            commands::director_save_state,
            commands::director_checkpoint,
            commands::director_server_status,
            commands::director_server_snapshot,
            commands::director_issue_qbtcp_pairing,
            commands::director_store_live_credential,
            commands::director_read_live_credential,
            commands::director_forget_live_credential,
            commands::director_live_status,
            commands::director_start_live_server,
            commands::director_stop_live_server,
            commands::director_live_server_status,
            commands::director_publish_local_live,
            commands::director_start_qbtcp_server,
            commands::director_stop_qbtcp_server,
            commands::checkpoint_store,
            commands::open_tournament_file,
            commands::save_tournament_file,
            commands::get_diagnostics_snapshot,
            commands::save_diagnostics_bundle,
            transfers::transfers_list_volumes,
            transfers::transfers_choose_folder,
            transfers::transfers_authorize_root,
            transfers::transfers_forget_root,
            transfers::transfers_list_directory,
            transfers::transfers_read_file,
            transfers::transfers_write_file,
            transfers::transfers_create_directory,
            transfers::transfers_exists,
            transfers::transfers_available_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QBSheet Director");
}
