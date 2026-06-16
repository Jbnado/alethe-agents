mod agent_events;
mod agent_library;
mod backup;
mod claude_sessions;
mod claude_usage;
mod cli_resolver;
mod codex_sessions;
mod diagnostics;
mod economy_agents;
mod paths;
mod projects;
mod profiles;
mod pty;
mod spotify;
mod stats;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::pty::{PtySession, PtySessions};
#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();
    let sessions: PtySessions = Arc::new(Mutex::new(HashMap::<String, PtySession>::new()));

    tauri::Builder::default()
        .manage(sessions)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("(DEV) Alethe");
            }
            agent_events::start_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agent_events::agent_hooks_settings_path,
            agent_events::agent_hooks_endpoint,
            agent_library::list_installed_agents,
            agent_library::install_agent,
            agent_library::uninstall_agent,
            economy_agents::set_economy_agents,
            economy_agents::economy_agents_enabled,
            pty::spawn_pty,
            pty::attach_pty,
            pty::restart_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            pty::get_pty_cwd,
            projects::load_projects,
            projects::save_projects,
            profiles::list_profiles,
            profiles::get_active_profile,
            profiles::set_active_profile,
            profiles::create_profile,
            profiles::rename_profile,
            profiles::delete_profile,
            cli_resolver::find_cli_launcher,
            backup::export_backup,
            backup::import_backup,
            diagnostics::open_data_folder,
            diagnostics::open_spawn_log,
            diagnostics::open_in_file_explorer,
            diagnostics::open_in_vscode,
            diagnostics::open_in_browser,
            diagnostics::read_clipboard_text,
            diagnostics::write_clipboard_text,
            diagnostics::reset_app_data,
            stats::get_memory_stats,
            spotify::spotify_login,
            spotify::spotify_logout,
            spotify::spotify_status,
            spotify::spotify_get_current,
            claude_sessions::snapshot_claude_sessions,
            claude_sessions::list_claude_sessions,
            claude_sessions::get_claude_activity,
            codex_sessions::snapshot_codex_sessions,
            claude_usage::get_claude_usage,
            ping,
        ])
        .run(tauri::generate_context!())
        .expect("error while running alethe");
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rebuilt_path_is_non_empty_on_windows() {
        if !cfg!(windows) {
            return;
        }
        assert!(!cli_resolver::build_rebuilt_path().is_empty());
    }
}
