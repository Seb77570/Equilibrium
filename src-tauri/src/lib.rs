mod project;
mod dashboard;
mod pty;
mod claude_sessions;
mod time_tracking;

#[cfg(not(debug_assertions))]
mod static_server;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Disable WebView2's built-in browser accelerator keys (F5, Ctrl+R,
// Ctrl+Shift+R, Ctrl+F5, Ctrl+± zoom, Ctrl+0, Ctrl+F4, …) so they no longer
// reload or otherwise mess with the app — including when focus is inside the
// BrowserTab's cross-origin iframe, which is the case BlockReloadShortcuts.tsx
// can't reach from JS.
//
// The Refresh button in BrowserTab.tsx (handleReload via setUrl('about:blank')
// → re-set) still works because it's a pure React state change, not a WebView2
// accelerator. If a real issue surfaces (e.g. need the zoom shortcuts back),
// remove the call in setup(); this function has no other reachable callers.
#[cfg(target_os = "windows")]
fn disable_webview2_browser_accelerators(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let controller = webview.controller();
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(settings) = core.Settings() {
                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(pty::DetachedTabsState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            project::get_projects,
            project::add_project,
            project::remove_project,
            project::open_in_explorer,
            project::run_dev_command,
            project::open_url,
            project::open_antigravity,
            project::open_claude,
            project::is_port_open,
            project::open_path,
            project::list_dir,
            project::write_text_file,
            project::open_in_vscode,
            project::show_in_folder,
            project::save_project_config,
            project::save_clipboard_image,
            project::get_settings,
            project::save_settings,
            dashboard::get_dashboard_config,
            dashboard::save_dashboard_config,
            pty::spawn_terminal,
            pty::write_to_terminal,
            pty::resize_terminal,
            pty::get_terminal_buffer,
            pty::kill_terminal,
            claude_sessions::list_claude_sessions,
            claude_sessions::read_session_title,
            claude_sessions::set_session_label,
            pty::pty_ping,
            pty::open_detached_window,
            pty::get_detached_tab_data,
            pty::reattach_tab,
            time_tracking::time_entries_get_all,
            time_tracking::time_entry_save,
            time_tracking::time_entry_delete,
            time_tracking::time_settings_get,
            time_tracking::time_settings_save
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let _ = app.get_webview_window("main").unwrap().open_devtools();
            }

            #[cfg(target_os = "windows")]
            if let Some(main) = app.get_webview_window("main") {
                disable_webview2_browser_accelerators(&main);
            }

            // Release-only: start the local HTTP server and redirect the
            // main webview to it. We can't change the window's URL via
            // tauri.conf.json (it's compiled in), so we navigate it after
            // creation. The brief flash from tauri.localhost → localhost is
            // acceptable; the alternative is reconstructing all the window
            // config in Rust which adds maintenance cost.
            #[cfg(not(debug_assertions))]
            {
                let app_handle = app.handle().clone();
                match static_server::start(&app_handle) {
                    Ok(port) => {
                        if let Some(webview) = app.get_webview_window("main") {
                            let url = format!("http://localhost:{port}/");
                            match tauri::Url::parse(&url) {
                                Ok(parsed) => {
                                    if let Err(e) = webview.navigate(parsed) {
                                        eprintln!("Failed to navigate main webview: {e}");
                                    }
                                }
                                Err(e) => eprintln!("Failed to parse static server URL: {e}"),
                            }
                        }
                    }
                    Err(e) => eprintln!("Failed to start static server: {e}"),
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
