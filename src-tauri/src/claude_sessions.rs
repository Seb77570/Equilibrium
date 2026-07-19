// Claude Code conversation discovery.
//
// Claude stores one JSONL transcript per session at
//   <home>/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where <encoded-cwd> is the absolute working directory with every
// non-alphanumeric character replaced by '-'.
//
// Crucially the location AND the encoding differ per environment, because the
// project lives at a different absolute path in each:
//   • PowerShell / Windows : %USERPROFILE%\.claude\projects\C--Users-...
//   • WSL                  : \\wsl.localhost\<distro>\home\<user>\.claude\projects\-mnt-c-...
// So a single project can have two completely separate histories. The `env`
// argument ("powershell" | "wsl") selects which one we read.

use serde::Serialize;
use std::fs;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::AppHandle;

use crate::pty::windows_to_wsl_path;

#[derive(Serialize, Clone)]
pub struct SessionMeta {
    pub session_id: String,
    pub title: String, // Claude's auto-generated ai-title (fallback: first user msg)
    pub label: Option<String>, // Equilibrium user override, if the user renamed it
    // Claude Code's own `/rename` value (stored in <home>/.claude/sessions/<pid>.json
    // as `"name"`). Highest-priority display name when present, because it's the
    // most direct expression of user intent — the user typed it inside Claude.
    pub claude_name: Option<String>,
    pub last_activity: Option<String>, // ISO timestamp of the last transcript line
    pub git_branch: Option<String>,
    pub env: String,
    pub mtime: Option<u64>, // file mtime (epoch secs) — used for sorting
}

// ── Equilibrium session labels (user renames) ───────────────────────────────
// Claude rewrites its own ai-title every turn and stores any /rename in an
// undocumented internal place, so we keep our own durable label store keyed by
// session id. The frontend shows `label ?? title`.

fn labels_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::project::config_dir(app)?.join("claude_session_labels.json"))
}

fn read_labels(app: &AppHandle) -> HashMap<String, String> {
    labels_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

/// Set (or clear, when `label` is empty) the Equilibrium label for a session.
#[tauri::command]
pub fn set_session_label(app: AppHandle, session_id: String, label: String) -> Result<(), String> {
    let mut labels = read_labels(&app);
    let trimmed = label.trim();
    if trimmed.is_empty() {
        labels.remove(&session_id);
    } else {
        labels.insert(session_id, trimmed.to_string());
    }
    let path = labels_path(&app)?;
    let json = serde_json::to_string_pretty(&labels).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

// ── Claude's native `/rename` ───────────────────────────────────────────────
// Claude writes one runtime metadata file per PID at
//   <home>/.claude/sessions/<pid>.json
// shape: { pid, sessionId, cwd, startedAt, name?, updatedAt, … }
// When the user runs `/rename foo` inside Claude, the new title is persisted
// to that file under `name`. We scan the dir once per call and pick the
// highest `updatedAt` per sessionId so a resumed session (new PID, new file)
// reflects the latest rename rather than the oldest.
fn read_session_names(env: &str) -> HashMap<String, String> {
    let dir = match projects_base(env).and_then(|p| p.parent().map(|x| x.join("sessions"))) {
        Some(d) => d,
        None => return HashMap::new(),
    };
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };
    // sessionId → (updatedAt, name) — keeps the most recently updated entry
    // when several PID files exist for the same session.
    let mut latest: HashMap<String, (u64, String)> = HashMap::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let sid = match v.get("sessionId").and_then(|s| s.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let name = match v.get("name").and_then(|s| s.as_str()) {
            Some(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        let updated = v.get("updatedAt").and_then(|n| n.as_u64()).unwrap_or(0);
        let slot = latest.entry(sid).or_insert((0, String::new()));
        if updated >= slot.0 {
            *slot = (updated, name);
        }
    }
    latest.into_iter().map(|(k, (_, n))| (k, n)).collect()
}

// Claude's project-dir encoding: every non-alphanumeric char becomes '-'.
fn encode_project_dir(p: &str) -> String {
    p.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

// Resolve `<home>/.claude/projects` for the given environment.
fn projects_base(env: &str) -> Option<PathBuf> {
    if env == "wsl" {
        wsl_projects_base()
    } else {
        // powershell / default → the Windows user profile.
        let up = std::env::var("USERPROFILE").ok()?;
        Some(PathBuf::from(up).join(".claude").join("projects"))
    }
}

// Build (and cache) the UNC base for the default WSL distro:
//   \\wsl.localhost\<distro>\<home>\.claude\projects
fn wsl_projects_base() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let distro = wsl_default_distro()?;
            let home = wsl_home()?; // e.g. "/home/sebastien"
            let home_win = home.trim_start_matches('/').replace('/', "\\");
            let base = format!(
                r"\\wsl.localhost\{}\{}\.claude\projects",
                distro, home_win
            );
            Some(PathBuf::from(base))
        })
        .clone()
}

#[cfg(target_os = "windows")]
fn wsl_default_distro() -> Option<String> {
    use std::os::windows::process::CommandExt;
    // `wsl -l -q` lists distro names; the first is the default. Output is
    // UTF-16LE on Windows, so decode it explicitly.
    let out = std::process::Command::new("wsl.exe")
        .args(["-l", "-q"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    let u16s: Vec<u16> = out
        .stdout
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    let s = String::from_utf16_lossy(&u16s);
    s.lines()
        .map(|l| l.trim().trim_matches('\0').trim())
        .find(|l| !l.is_empty())
        .map(|l| l.to_string())
}

#[cfg(target_os = "windows")]
fn wsl_home() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("wsl.exe")
        .args(["-e", "bash", "-lc", "echo $HOME"])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

// Non-Windows builds (e.g. Linux dev) can't reach a Windows-side WSL distro.
#[cfg(not(target_os = "windows"))]
fn wsl_default_distro() -> Option<String> {
    None
}
#[cfg(not(target_os = "windows"))]
fn wsl_home() -> Option<String> {
    None
}

// The `.claude/projects/<encoded>` dir for this project in this environment.
fn project_dir(env: &str, project_path: &str) -> Option<PathBuf> {
    let base = projects_base(env)?;
    let encoded = if env == "wsl" {
        encode_project_dir(&windows_to_wsl_path(project_path))
    } else {
        encode_project_dir(project_path)
    };
    Some(base.join(encoded))
}

// Read the first `head_n` and last `tail_n` bytes, dropping partial lines at
// the split boundaries. Avoids loading multi-MB transcripts in full: the
// current ai-title and last timestamp live near the end, the first user
// message near the start.
fn read_head_tail(path: &Path, head_n: u64, tail_n: u64) -> std::io::Result<(String, String)> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();

    let hn = head_n.min(len);
    let mut hbuf = vec![0u8; hn as usize];
    f.read_exact(&mut hbuf)?;
    let mut head = String::from_utf8_lossy(&hbuf).into_owned();
    if len > hn {
        if let Some(idx) = head.rfind('\n') {
            head.truncate(idx);
        }
    }

    let tn = tail_n.min(len);
    f.seek(SeekFrom::Start(len - tn))?;
    let mut tbuf = vec![0u8; tn as usize];
    f.read_exact(&mut tbuf)?;
    let mut tail = String::from_utf8_lossy(&tbuf).into_owned();
    if len > tn {
        if let Some(idx) = tail.find('\n') {
            tail = tail[idx + 1..].to_string();
        }
    }

    Ok((head, tail))
}

// Pull a plain-text preview from a `user` transcript line whose message
// content is either a string or an array of content blocks.
fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let content = &v["message"]["content"];
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        for item in arr {
            if item["type"] == "text" {
                if let Some(t) = item["text"].as_str() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

fn sanitize_title(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = collapsed.chars().take(100).collect();
    if trimmed.is_empty() {
        "(untitled)".to_string()
    } else {
        trimmed
    }
}

fn parse_session_file(path: &Path, env: &str) -> Option<SessionMeta> {
    let session_id = path.file_stem()?.to_string_lossy().to_string();
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    let (head, tail) = read_head_tail(path, 16 * 1024, 96 * 1024).ok()?;

    let mut title: Option<String> = None;
    let mut last_activity: Option<String> = None;
    let mut git_branch: Option<String> = None;

    // Scan the tail: the most recent ai-title, last timestamp, git branch.
    for line in tail.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v["type"] == "ai-title" {
            if let Some(t) = v["aiTitle"].as_str() {
                title = Some(t.to_string());
            }
        }
        if let Some(ts) = v["timestamp"].as_str() {
            last_activity = Some(ts.to_string());
        }
        if git_branch.is_none() {
            if let Some(b) = v["gitBranch"].as_str() {
                if !b.is_empty() {
                    git_branch = Some(b.to_string());
                }
            }
        }
    }

    // No AI title yet → fall back to the first real user message, skipping
    // command/caveat tags Claude injects (they start with '<').
    if title.is_none() {
        for line in head.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v["type"] == "user" {
                if let Some(t) = extract_user_text(&v) {
                    let t = t.trim_start();
                    if !t.starts_with('<') {
                        title = Some(t.to_string());
                        break;
                    }
                }
            }
        }
    }

    Some(SessionMeta {
        session_id,
        title: sanitize_title(&title.unwrap_or_default()),
        label: None, // filled in by the caller from the labels store
        claude_name: None, // filled in by the caller from the sessions/ scan
        last_activity,
        git_branch,
        env: env.to_string(),
        mtime,
    })
}

/// List all Claude conversations for `project_path` under environment `env`
/// ("powershell" | "wsl"). Returns most-recent first. An empty list (rather
/// than an error) is returned when there is simply no history yet.
// async so the (potentially slow, UNC/SMB) file reads run off Tauri's main
// thread and don't delay terminal keystroke commands / pty-output delivery.
#[tauri::command]
pub async fn list_claude_sessions(
    app: AppHandle,
    env: String,
    project_path: String,
) -> Result<Vec<SessionMeta>, String> {
    let dir = match project_dir(&env, &project_path) {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let rd = match fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(vec![]), // dir doesn't exist → no sessions
    };
    let labels = read_labels(&app);
    // One sessions/ scan per list call — cheap, even with hundreds of PID files.
    let claude_names = read_session_names(&env);
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Some(mut meta) = parse_session_file(&path, &env) {
            meta.label = labels.get(&meta.session_id).cloned();
            meta.claude_name = claude_names.get(&meta.session_id).cloned();
            out.push(meta);
        }
    }

    // Durably capture Claude's native `/rename` into our own label store.
    // Claude keeps a `/rename` only in a per-PID sessions/<pid>.json that
    // vanishes when the process exits — so on the next launch claude_name is
    // gone and the name would revert to the ai-title. Mirroring it into our
    // labels store makes a `/rename` survive restarts with no pencil needed.
    // Display precedence (claude_name || label || title) is unchanged: while
    // claude_name is live it wins; after a restart the persisted label takes
    // over seamlessly.
    let mut labels_mut = labels.clone();
    let mut labels_changed = false;
    for meta in &out {
        if let Some(cn) = &meta.claude_name {
            if labels_mut.get(&meta.session_id) != Some(cn) {
                labels_mut.insert(meta.session_id.clone(), cn.clone());
                labels_changed = true;
            }
        }
    }
    if labels_changed {
        if let (Ok(path), Ok(json)) =
            (labels_path(&app), serde_json::to_string_pretty(&labels_mut))
        {
            let _ = fs::write(path, json);
        }
    }

    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    Ok(out)
}

/// Quick metadata for a single known session — used to refresh an open tab's
/// title as Claude (re)generates the ai-title.
#[tauri::command]
pub async fn read_session_title(
    app: AppHandle,
    env: String,
    project_path: String,
    session_id: String,
) -> Result<Option<SessionMeta>, String> {
    let dir = match project_dir(&env, &project_path) {
        Some(d) => d,
        None => return Ok(None),
    };
    let path = dir.join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Ok(None);
    }
    let mut meta = match parse_session_file(&path, &env) {
        Some(m) => m,
        None => return Ok(None),
    };
    meta.label = read_labels(&app).get(&session_id).cloned();
    meta.claude_name = read_session_names(&env).remove(&session_id);
    Ok(Some(meta))
}
