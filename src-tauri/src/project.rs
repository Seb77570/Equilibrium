use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::net::TcpStream;
use std::time::Duration;
use tauri::{AppHandle, Manager};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// Where settings.json + dashboard.json live: the Tauri app data dir
// (%APPDATA%\com.equilibrium.dashboard on Windows). Stable across installs,
// independent of where the source repo lives, survives uninstall+reinstall.
pub fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create config dir failed: {}", e))?;
    }
    Ok(dir)
}

pub fn config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(name))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectLinks {
    pub github: Option<String>,
    pub vercel: Option<String>,
    pub aws: Option<String>,
    pub other: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub default_agent_command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub project_type: String,
    pub description: Option<String>,
    pub port: Option<u16>,
    pub instructions: Option<String>,
    pub dev_command: Option<String>,
    pub install_path: Option<String>,
    pub executable_path: Option<String>,
    pub claude_env: Option<String>,
    pub links: Option<ProjectLinks>,
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let settings_path = config_file(&app, "settings.json")?;
    if !settings_path.exists() {
        return Ok(AppSettings {
            default_agent_command: Some("claude --dangerously-skip-permissions".to_string()),
        });
    }
    let content = fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    let settings: AppSettings = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let settings_path = config_dir(&app)?.join("settings.json");
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(settings_path, content).map_err(|e| e.to_string())
}

// ── Workspace session persistence ───────────────────────────────────────────
// Backing store for the frontend's zustand `persist` (open workspaces, tab
// layout, Claude session ids…). It used to live in localStorage, but release
// builds serve the UI from http://localhost:<random port> — a DIFFERENT
// origin (hence an empty localStorage) on every launch, so restore silently
// never worked in installed builds. A file in the app-data dir is
// origin-independent and survives everything.
#[tauri::command]
pub fn session_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = config_file(&app, "workspace_session.json")?;
    match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => Ok(Some(s)),
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn session_save(app: AppHandle, value: String) -> Result<(), String> {
    let path = config_file(&app, "workspace_session.json")?;
    fs::write(path, value).map_err(|e| e.to_string())
}

// The project registry lives in the app data dir alongside settings.json /
// dashboard.json. It is the single source of truth for which projects exist:
// folders are added explicitly (no more scanning), and all metadata is stored
// here rather than in a per-project equilibrium.json.
fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("projects.json"))
}

fn read_registry(app: &AppHandle) -> Result<Vec<Project>, String> {
    let path = registry_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_registry(app: &AppHandle, projects: &[Project]) -> Result<(), String> {
    let path = registry_path(app)?;
    let content = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

// Build a full Project from a folder path by auto-detecting its metadata
// (equilibrium.json if present, else package.json / tauri.conf.json heuristics).
fn project_from_path(path: &Path) -> Project {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let (project_type, description, port, instructions, dev_command, install_path, executable_path, claude_env, links) =
        detect_project_info(path);
    Project {
        name,
        path: path.to_string_lossy().to_string(),
        project_type,
        description,
        port,
        instructions,
        dev_command,
        install_path,
        executable_path,
        claude_env,
        links,
    }
}

#[tauri::command]
pub async fn get_projects(app: AppHandle) -> Result<Vec<Project>, String> {
    read_registry(&app)
}

#[tauri::command]
pub async fn add_project(app: AppHandle, path: String) -> Result<Project, String> {
    let folder = Path::new(&path);
    if !folder.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }
    let mut projects = read_registry(&app)?;

    let normalized = folder.to_string_lossy().to_string();
    if projects.iter().any(|p| p.path == normalized) {
        return Err("This project is already added.".to_string());
    }

    let project = project_from_path(folder);
    projects.push(project.clone());
    write_registry(&app, &projects)?;
    Ok(project)
}

#[tauri::command]
pub async fn remove_project(app: AppHandle, path: String) -> Result<(), String> {
    let mut projects = read_registry(&app).unwrap_or_default();
    projects.retain(|p| p.path != path);
    write_registry(&app, &projects)
}

fn detect_project_info(path: &Path) -> (String, Option<String>, Option<u16>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<ProjectLinks>) {
    let mut p_type = "Unknown".to_string();
    let mut description = None;
    let mut port = None;
    let mut dev_command = None;
    let mut install_path = None;
    let mut executable_path = None;
    let mut claude_env = None;
    let mut links = None;

    // Check for Equilibrium override first
    if let Ok(content) = fs::read_to_string(path.join("equilibrium.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(p) = v["dev"]["port"].as_u64() {
                port = Some(p as u16);
            }
            if let Some(cmd) = v["dev"]["command"].as_str() {
                dev_command = Some(cmd.to_string());
            }
            
            // New installer and executable paths
            if let Some(ip) = v["install_path"].as_str() {
                install_path = Some(ip.to_string());
            }
            if let Some(ep) = v["executable_path"].as_str() {
                executable_path = Some(ep.to_string());
            }

            if let Some(desc) = v["description"].as_str() {
                description = Some(desc.to_string());
            }

            let detected_type = v["type"].as_str().or(v["project_type"].as_str());
            
            if let Some(t) = detected_type {
                p_type = t.to_string();
                let inst = v["instructions"].as_str().map(|s| s.to_string());

                if let Some(c) = v["claude_env"].as_str() {
                    claude_env = Some(c.to_string());
                } else if let Some(c) = v["claude"].as_str() {
                    claude_env = Some(c.to_string());
                }
                
                // Parse links
                if let Some(l_val) = v.get("links") {
                    if let Ok(l) = serde_json::from_value::<ProjectLinks>(l_val.clone()) {
                        links = Some(l);
                    }
                }

                return (p_type, description, port, inst, dev_command, install_path, executable_path, claude_env, links);
            }
        }
    }

    if path.join("src-tauri").exists() {
        p_type = "Tauri".to_string();
        if dev_command.is_none() {
            dev_command = Some("npm run tauri dev".to_string());
        }
        // Try to parse tauri.conf.json for port
        let mut tauri_config_path = path.join("src-tauri/tauri.conf.json");
        if !tauri_config_path.exists() {
             tauri_config_path = path.join("tauri.conf.json"); 
        }
        
        if let Ok(content) = fs::read_to_string(tauri_config_path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                // v2 schema
                if let Some(p) = v["build"]["devUrl"].as_str() {
                    if let Some(port_str) = p.split(':').last() {
                        port = port_str.parse::<u16>().ok();
                    }
                }
            }
        }
    } else if path.join("package.json").exists() {
        p_type = "Next.js/Node".to_string();
        if dev_command.is_none() {
            dev_command = Some("npm run dev".to_string());
        }
        if let Ok(content) = fs::read_to_string(path.join("package.json")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(dev_script) = v["scripts"]["dev"].as_str() {
                    if let Some(idx) = dev_script.find("-p ") {
                         let sub = &dev_script[idx+3..];
                         if let Some(p) = sub.split_whitespace().next() {
                             port = p.parse::<u16>().ok();
                         }
                    }
                }
            }
        }
    }

    (p_type, description, port, None, dev_command, install_path, executable_path, claude_env, links)
}

#[tauri::command]
pub async fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn run_dev_command(path: String, command: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/c", "start", "cmd", "/k", &command])
            .current_dir(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/c", "start", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_antigravity(path: String, _env: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Unified launcher: use the method that works for other projects
        // ignoring terminal-specific env for the agent launcher.
        std::process::Command::new("cmd")
            .args(&["/c", "start", "", "/b", "antigravity", "."])
            .current_dir(path)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn is_port_open(port: u16) -> bool {
    let v4_addr = format!("127.0.0.1:{}", port).parse();
    if let Ok(addr) = v4_addr {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok() {
            return true;
        }
    }
    let v6_addr = format!("[::1]:{}", port).parse();
    if let Ok(addr) = v6_addr {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(150)).is_ok() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn open_claude(path: String, env: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Normalize environment string (lowercase and handle empty/None)
        let env_norm = env.as_deref().unwrap_or("").to_lowercase();

        match env_norm.as_str() {
            "wsl" => {
                // Target Ubuntu specifically as requested
                // Using bash --login -i to ensure interactive PATH (node, aliases, etc.) is correctly loaded
                std::process::Command::new("cmd")
                    .args(&["/c", "start", "", "wsl", "-d", "Ubuntu", "--cd", &path, "bash", "--login", "-i", "-c", "claude --dangerously-skip-permissions; exec bash"])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            },
            "powershell" => {
                // Use powershell.exe directly instead of wt profile which is machine-dependent
                std::process::Command::new("cmd")
                    .args(&["/c", "start", "", "powershell", "-NoExit", "-Command", "claude --dangerously-skip-permissions"])
                    .current_dir(path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            },
            _ => {
                std::process::Command::new("cmd")
                    .args(&["/c", "start", "", "cmd", "/k", "claude --dangerously-skip-permissions"])
                    .current_dir(path)
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

// ── File explorer ───────────────────────────────────────────────────────────
// One level of a directory listing, for the retractable file-tree overlay.
// Lazy: the frontend calls this per folder as the user expands it, so we never
// walk huge trees (node_modules etc.) up front. Directories come before files,
// each group alphabetical (case-insensitive) — the familiar IDE order.

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

// Folders hidden by default — noisy/huge and rarely opened by hand.
const HIDDEN_DIRS: &[&str] = &[
    "node_modules", ".git", ".next", "target", "dist", "out", ".venv",
    "__pycache__", ".turbo", ".cache",
];

#[tauri::command]
pub async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<DirEntry>, String> {
    let rd = fs::read_dir(&path).map_err(|e| format!("read_dir failed: {}", e))?;
    let mut out: Vec<DirEntry> = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !show_hidden && is_dir && HIDDEN_DIRS.contains(&name.as_str()) {
            continue;
        }
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/c", "start", "", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Write a UTF-8 text file to an arbitrary path the user already picked via the
// native save dialog. Used by the Time view's CSV export.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("write failed: {}", e))
}

#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(&["/c", "code", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| format!("VS Code not found in PATH. Make sure VS Code is installed and 'code' is in your PATH. Error: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, 'explorer /select,PATH' opens the folder and highlights the file
        std::process::Command::new("explorer")
            .args(&["/select,", &path])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Persist edits made in the card's edit form. The frontend still sends the
// historical "equilibrium.json" JSON shape; we parse it and update the matching
// entry (by path) in the internal registry instead of writing a file into the
// project folder.
#[tauri::command]
pub async fn save_project_config(
    app: AppHandle,
    path: String,
    config_json: String,
) -> Result<(), String> {
    let v: serde_json::Value =
        serde_json::from_str(&config_json).map_err(|e| e.to_string())?;

    let str_field = |key: &str| v[key].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());

    // The frontend may submit a new `path` when the user renamed/moved the
    // project folder. The `path` *argument* is the current registry key.
    let new_path = str_field("path");
    let relocating = new_path.as_deref().map_or(false, |np| np != path);

    let mut projects = read_registry(&app).unwrap_or_default();

    // Don't let a relocation collapse two projects onto the same key.
    if relocating {
        if let Some(np) = new_path.as_deref() {
            if projects.iter().any(|p| p.path == np) {
                return Err(format!("Another project already uses that path: {np}"));
            }
        }
    }

    let project = projects
        .iter_mut()
        .find(|p| p.path == path)
        .ok_or_else(|| format!("Project not found in registry: {path}"))?;

    if let Some(name) = str_field("name") {
        project.name = name;
    }
    if let Some(t) = v["type"].as_str().or(v["project_type"].as_str()) {
        project.project_type = t.to_string();
    }
    project.description = str_field("description");
    project.port = v["dev"]["port"].as_u64().map(|p| p as u16);
    project.dev_command = v["dev"]["command"].as_str().filter(|s| !s.is_empty()).map(|s| s.to_string());
    project.instructions = str_field("instructions");
    project.install_path = str_field("install_path");
    project.executable_path = str_field("executable_path");
    project.claude_env = str_field("claude_env");
    project.links = v
        .get("links")
        .and_then(|l| serde_json::from_value::<ProjectLinks>(l.clone()).ok());
    if relocating {
        if let Some(ref np) = new_path {
            project.path = np.clone();
        }
    }

    write_registry(&app, &projects)?;

    // Keep dashboard section membership pointing at the project after a move.
    if relocating {
        if let Some(ref np) = new_path {
            migrate_dashboard_path(&app, &path, np);
        }
    }

    Ok(())
}

// Rewrite any dashboard section reference from `old_path` to `new_path` so a
// relocated project stays in the same group instead of falling out of every
// section. Best-effort: dashboard config is non-critical, so failures here are
// swallowed rather than aborting the (already-committed) registry update.
fn migrate_dashboard_path(app: &AppHandle, old_path: &str, new_path: &str) {
    let config_path = match config_file(app, "dashboard.json") {
        Ok(p) if p.exists() => p,
        _ => return,
    };
    let Ok(content) = fs::read_to_string(&config_path) else { return };
    let Ok(mut config) = serde_json::from_str::<crate::dashboard::DashboardConfig>(&content) else { return };

    let mut changed = false;
    for section in &mut config.sections {
        for p in &mut section.project_paths {
            if p == old_path {
                *p = new_path.to_string();
                changed = true;
            }
        }
    }
    if changed {
        if let Ok(out) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(&config_path, out);
        }
    }
}

// Save a clipboard image (raw bytes) to the OS temp dir. Returns the absolute
// path so the frontend can paste it into a terminal where Claude Code (or any
// CLI) can read it as an image input. Files accumulate in
// `%TEMP%\equilibrium-clipboard\paste-<uuid>.<ext>` and are not auto-cleaned
// — the OS's tmp policy + reboots are good enough for this use case.
#[tauri::command]
pub async fn save_clipboard_image(bytes: Vec<u8>, ext: String) -> Result<String, String> {
    use std::fs;
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let extension = if safe_ext.is_empty() { "png".to_string() } else { safe_ext };
    let mut dir = std::env::temp_dir();
    dir.push("equilibrium-clipboard");
    fs::create_dir_all(&dir).map_err(|e| format!("create temp dir failed: {e}"))?;
    let filename = format!("paste-{}.{}", uuid::Uuid::new_v4(), extension);
    let full = dir.join(filename);
    fs::write(&full, &bytes).map_err(|e| format!("write image failed: {e}"))?;
    Ok(full.to_string_lossy().to_string())
}
