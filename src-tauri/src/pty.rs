use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};

/// Translate a Windows path like `C:\Users\foo\bar baz` to its WSL Linux
/// equivalent `/mnt/c/Users/foo/bar baz`. Drive letter is lowercased.
/// Anything not matching the `<letter>:\…` shape is returned unchanged so
/// already-Linux paths or UNC paths pass through intact.
pub fn windows_to_wsl_path(win_path: &str) -> String {
    let bytes = win_path.as_bytes();
    if bytes.len() >= 3
        && (bytes[0] as char).is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = &win_path[2..].replace('\\', "/");
        format!("/mnt/{}{}", drive, rest)
    } else {
        win_path.to_string()
    }
}
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub struct PtySession {
    pub pty: Box<dyn portable_pty::MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child_pid: Option<u32>,
    // Capped copy of everything the reader thread has read from the PTY.
    // Tauri `emit`s from the reader thread can be dropped before the webview's
    // JS listener is live (WebView2 IPC is congested at startup — the first
    // prompt bytes are the usual victim). This buffer is the source of truth
    // so the frontend can replay output that never reached xterm. Shared with
    // the reader thread via Arc.
    pub output_log: Arc<Mutex<Vec<u8>>>,
}

// Keep at most this many bytes of scrollback for replay. We only ever replay
// to recover the *initial* screen on a missed-event race, so the tail is all
// that matters; this caps memory at ~256 KB per live terminal.
const OUTPUT_LOG_CAP: usize = 256 * 1024;

// Kill the child process and any descendants it spawned.
// Critical for dev workspaces where `npm run dev` forks `node`: killing only
// the shell leaves `node` orphaned with the dev port still bound.
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW — don't flash a console
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Negative PID targets the process group, which catches children
        // started by the shell.
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{}", pid)])
            .output();
        // Give the group a moment, then SIGKILL anything still alive.
        std::thread::sleep(std::time::Duration::from_millis(150));
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{}", pid)])
            .output();
    }
}

pub struct PtyState {
    pub sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[tauri::command]
pub fn spawn_terminal(
    app_handle: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    shell: Option<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<bool, String> { // true = new session, false = reconnected
    eprintln!("[PTY:{}] spawn_terminal ENTER (shell={:?} cwd={:?} size={:?}x{:?})", id, shell, cwd, cols, rows);

    // If session already exists, tell the frontend to reconnect (no new command needed)
    {
        let sessions = match state.sessions.lock() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[PTY:{}] sessions lock POISONED at entry: {}", id, e);
                return Err(format!("PtyState lock poisoned: {}", e));
            }
        };
        if sessions.contains_key(&id) {
            eprintln!("[PTY:{}] Session already exists, reconnecting.", id);
            return Ok(false); // false = existing session
        }
    }

    let default_shell = if cfg!(windows) { "powershell.exe" } else { "bash" };
    let shell_cmd = shell.unwrap_or_else(|| default_shell.to_string());

    // Default to a sane minimum if the frontend hasn't measured xterm yet.
    // Windows ConPTY → WSL has flaky SIGWINCH propagation, so getting the
    // size right at PTY creation is more important than later resize calls.
    let initial_rows = rows.unwrap_or(24).max(2);
    let initial_cols = cols.unwrap_or(80).max(20);

    eprintln!("[PTY:{}] Spawning '{}' in CWD: {:?} at {}x{}", id, shell_cmd, cwd, initial_cols, initial_rows);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_rows,
            cols: initial_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            eprintln!("[PTY:{}] openpty failed: {}", id, e);
            e.to_string()
        })?;
    eprintln!("[PTY:{}] openpty OK", id);

    let mut cmd = CommandBuilder::new(&shell_cmd);
    // Windows + WSL quirk: passing a Windows CWD via CommandBuilder::cwd()
    // (or via `wsl --cd <winpath>`) makes WSL invoke its own wslpath
    // translation during distro init. That blows up with
    //   "Catastrophic failure / Wsl/Service/E_UNEXPECTED"
    // when the path lives under OneDrive (reparse points) or contains
    // characters the in-distro translator hates.
    //
    // Fix: do the C:\…  →  /mnt/c/…  translation ourselves and hand WSL the
    // already-Linux path. `wsl --cd` accepts Linux paths fine.
    let is_wsl = cfg!(windows)
        && (shell_cmd.eq_ignore_ascii_case("wsl") || shell_cmd.eq_ignore_ascii_case("wsl.exe"));
    if let Some(ref dir) = cwd {
        if is_wsl {
            let linux_path = windows_to_wsl_path(dir);
            cmd.arg("--cd");
            cmd.arg(&linux_path);
            eprintln!("[PTY:{}] WSL --cd '{}' (translated from '{}')", id, linux_path, dir);
        } else {
            cmd.cwd(dir);
        }
    }
    // Set terminal capability env vars explicitly. Without TERM, Ink-based
    // TUIs (Claude Code, modern CLI apps) fall back to broken rendering —
    // boxes drawn with garbage chars, cursor positioning off, lines
    // overlapping. xterm.js advertises full xterm-256color support so
    // declaring it matches reality.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let child_pid = match pair.slave.spawn_command(cmd) {
        Ok(child) => {
            let pid = child.process_id();
            eprintln!("[PTY:{}] Process spawned successfully (pid: {:?}).", id, pid);
            pid
        }
        Err(e) => {
            eprintln!("[PTY:{}] spawn_command failed: {}", id, e);
            return Err(e.to_string());
        }
    };

    let mut reader = pair.master.try_clone_reader().map_err(|e| {
        eprintln!("[PTY:{}] try_clone_reader failed: {}", id, e);
        e.to_string()
    })?;

    let writer = pair.master.take_writer().map_err(|e| {
        eprintln!("[PTY:{}] take_writer failed: {}", id, e);
        e.to_string()
    })?;

    let output_log: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

    match state.sessions.lock() {
        Ok(mut sessions) => {
            sessions.insert(id.clone(), PtySession {
                pty: pair.master,
                writer,
                child_pid,
                output_log: output_log.clone(),
            });
        }
        Err(e) => {
            eprintln!("[PTY:{}] sessions lock POISONED before insert: {}", id, e);
            return Err(format!("PtyState lock poisoned: {}", e));
        }
    }

    eprintln!("[PTY:{}] Session registered, starting reader thread.", id);

    let id_clone = id.clone();
    let app_clone = app_handle.clone();
    let log_clone = output_log.clone();
    thread::spawn(move || { // reader thread
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    eprintln!("[PTY:{}] Reader got EOF — process likely exited.", id_clone);
                    break;
                }
                Ok(n) => {
                    // Record raw bytes BEFORE emitting, so a dropped emit is
                    // still recoverable via get_terminal_buffer. Cap to the
                    // last OUTPUT_LOG_CAP bytes.
                    if let Ok(mut log) = log_clone.lock() {
                        log.extend_from_slice(&buf[..n]);
                        let overflow = log.len().saturating_sub(OUTPUT_LOG_CAP);
                        if overflow > 0 {
                            log.drain(..overflow);
                        }
                    }
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&format!("pty-output:{}", id_clone), PtyOutputEvent {
                        id: id_clone.clone(),
                        data,
                    });
                }
                Err(e) => {
                    eprintln!("[PTY:{}] Reader error: {}", id_clone, e);
                    break;
                }
            }
        }
    });

    eprintln!("[PTY:{}] spawn_terminal RETURN Ok(true)", id);
    Ok(true) // true = new session
}

#[tauri::command]
pub fn write_to_terminal(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    match sessions.get_mut(&id) {
        Some(session) => {
            session.writer.write_all(data.as_bytes()).map_err(|e| {
                eprintln!("[PTY:{}] write_all failed: {}", id, e);
                e.to_string()
            })?;
        }
        None => {
            eprintln!("[PTY:{}] write_to_terminal: session not found!", id);
            return Err(format!("Terminal session '{}' not found", id));
        }
    }
    Ok(())
}

// Returns everything the reader thread has captured so far (capped to the
// last OUTPUT_LOG_CAP bytes). The frontend calls this as a safety net when no
// PTY output reached xterm after spawn — recovering a prompt whose live
// `pty-output` event was dropped by a congested WebView2 IPC bridge.
#[tauri::command]
pub fn get_terminal_buffer(
    state: tauri::State<'_, PtyState>,
    id: String,
) -> Result<String, String> {
    let sessions = state.sessions.lock().map_err(|e| format!("PtyState lock poisoned: {}", e))?;
    match sessions.get(&id) {
        Some(session) => {
            let log = session.output_log.lock().map_err(|e| format!("output_log lock poisoned: {}", e))?;
            Ok(String::from_utf8_lossy(&log).to_string())
        }
        None => Ok(String::new()),
    }
}

#[tauri::command]
pub fn resize_terminal(
    state: tauri::State<'_, PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().unwrap().get(&id) {
        session.pty
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Sanity check: lets the frontend confirm Rust IPC is responsive before
// blaming the rest of the stack. Returns the current sessions count and a
// caller-supplied tag echoed back, so a hung IPC bridge produces a clearly
// missing log line instead of a silent stall.
#[tauri::command]
pub fn pty_ping(state: tauri::State<'_, PtyState>, tag: String) -> Result<String, String> {
    let n = state.sessions.lock().map_err(|e| format!("PtyState lock poisoned: {}", e))?.len();
    Ok(format!("pong tag={} sessions={}", tag, n))
}

// ── Detached tab windows ────────────────────────────────────────────────
//
// Tab "tear-off": we open a fresh WebviewWindow that loads our static
// frontend. Detection of "am I a detached window?" happens client-side via
// the window label (anything that isn't "main"). Tab data is stashed in
// DetachedTabsState by label and fetched by the new window via
// get_detached_tab_data — passing it through the URL is fragile because
// Tauri's WebviewUrl::App URL-encodes the path and eats the query string.

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DetachedTabData {
    pub workspace_id: String,
    pub pane_id: String,
    pub tab_json: String,
}

pub struct DetachedTabsState {
    pub tabs: Arc<Mutex<HashMap<String, DetachedTabData>>>,
}

impl Default for DetachedTabsState {
    fn default() -> Self {
        Self { tabs: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[tauri::command]
pub fn open_detached_window(
    app_handle: AppHandle,
    state: tauri::State<'_, DetachedTabsState>,
    label: String,
    title: String,
    workspace_id: String,
    pane_id: String,
    tab_json: String,
) -> Result<(), String> {
    eprintln!("[detach:{}] ENTER open_detached_window", label);

    if app_handle.get_webview_window(&label).is_some() {
        eprintln!("[detach:{}] label collision, aborting", label);
        return Err(format!("A detached window with label '{}' is already open", label));
    }
    eprintln!("[detach:{}] no label collision", label);

    // Stash data BEFORE opening the window so it's there when the new
    // window's React mounts and calls get_detached_tab_data.
    match state.tabs.lock() {
        Ok(mut tabs) => {
            tabs.insert(label.clone(), DetachedTabData { workspace_id, pane_id, tab_json });
            eprintln!("[detach:{}] state stashed", label);
        }
        Err(e) => {
            eprintln!("[detach:{}] DetachedTabsState lock POISONED: {}", label, e);
            return Err(format!("DetachedTabsState lock poisoned: {}", e));
        }
    }

    // In dev mode, create the URL via External pointing explicitly at the
    // Next dev server. WebviewUrl::App on a second window in Tauri 2 RC
    // has known crash modes on Windows/WebView2. External works around this
    // and IPC still functions because the URL origin matches the dev URL
    // configured in tauri.conf.json (Tauri injects __TAURI__ on matching
    // origins regardless of WebviewUrl kind).
    //
    // In prod, App() loads from the bundled assets (tauri://localhost/...)
    // which doesn't have the dev-mode race.
    let webview_url = if cfg!(debug_assertions) {
        match "http://localhost:4321/".parse() {
            Ok(u) => {
                eprintln!("[detach:{}] using External(http://localhost:4321/) [dev]", label);
                WebviewUrl::External(u)
            }
            Err(e) => {
                eprintln!("[detach:{}] dev URL parse failed: {:?}", label, e);
                let _ = state.tabs.lock().map(|mut t| t.remove(&label));
                return Err(format!("URL parse failed: {:?}", e));
            }
        }
    } else {
        eprintln!("[detach:{}] using App(\"\") [prod]", label);
        WebviewUrl::App(std::path::PathBuf::from(""))
    };

    eprintln!("[detach:{}] calling WebviewWindowBuilder.build()...", label);
    let result = WebviewWindowBuilder::new(&app_handle, &label, webview_url)
        .title(&title)
        .inner_size(900.0, 650.0)
        .min_inner_size(400.0, 300.0)
        .build();
    eprintln!("[detach:{}] WebviewWindowBuilder.build() returned", label);

    let window = match result {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[detach:{}] WebviewWindowBuilder failed: {}", label, e);
            let _ = state.tabs.lock().map(|mut t| t.remove(&label));
            return Err(e.to_string());
        }
    };
    eprintln!("[detach:{}] window opened OK", label);

    // Defer devtools open to a background thread with a delay.
    // Calling open_devtools() synchronously right after build() races with
    // the webview's internal initialization on Windows and can crash the
    // whole Tauri process. The 800ms delay gives WebView2 time to settle.
    #[cfg(debug_assertions)]
    {
        let win = window.clone();
        let label_clone = label.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(800));
            eprintln!("[detach:{}] opening devtools (delayed)", label_clone);
            win.open_devtools();
        });
    }
    let _ = window;

    eprintln!("[detach:{}] EXIT open_detached_window OK", label);
    Ok(())
}

#[tauri::command]
pub fn get_detached_tab_data(
    window: tauri::Window,
    state: tauri::State<'_, DetachedTabsState>,
) -> Result<DetachedTabData, String> {
    let label = window.label().to_string();
    state.tabs.lock().unwrap()
        .get(&label)
        .cloned()
        .ok_or_else(|| format!("No detached data for window '{}'", label))
}

#[tauri::command]
pub fn reattach_tab(
    app_handle: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, DetachedTabsState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let data = state.tabs.lock().unwrap()
        .remove(&label)
        .ok_or_else(|| format!("No detached data for window '{}'", label))?;

    if let Some(main) = app_handle.get_webview_window("main") {
        main.emit("tab-reattached", data).map_err(|e| e.to_string())?;
    } else {
        return Err("Main window not found".to_string());
    }
    // Close ourselves. Don't kill the PTY — the main window is about to
    // reconnect to it.
    let _ = window.close();
    Ok(())
}

#[tauri::command]
pub fn kill_terminal(
    state: tauri::State<'_, PtyState>,
    id: String,
) -> Result<(), String> {
    // Take the session out of the map first so the lock is released before
    // we run taskkill (which can take 100+ms on Windows).
    let session = state.sessions.lock().unwrap().remove(&id);
    match session {
        Some(s) => {
            if let Some(pid) = s.child_pid {
                eprintln!("[PTY:{}] Killing process tree (pid {})…", id, pid);
                kill_process_tree(pid);
            } else {
                eprintln!("[PTY:{}] No PID recorded; dropping PTY only.", id);
            }
            // Dropping `s` releases the master PTY + writer.
            drop(s);
            eprintln!("[PTY:{}] Session killed.", id);
        }
        None => {
            eprintln!("[PTY:{}] kill_terminal: session not found (already dead?).", id);
        }
    }
    Ok(())
}
