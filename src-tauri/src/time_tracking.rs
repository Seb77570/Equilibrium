// Lightweight per-project time tracking. Each entry is a single session of
// "I was working on project X from start_ms to end_ms". Entries are stored
// as a flat list in <config_dir>/time_tracking.json. Even a power user
// running this for years stays in the low-MB range — a single entry is
// ~150 bytes.
//
// Crash semantics: a running entry's `end_ms` is checkpointed from the
// frontend roughly every minute, so an unclean shutdown loses at most ~60s
// of the current session instead of the whole thing. On next launch,
// `time_entries_get_all` finalizes any leftover `running=true` by clearing
// the flag (option A: timers auto-stop on close — the entry keeps its last
// checkpointed `end_ms` as its final time).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
pub struct TimeEntry {
    pub id: String,
    pub project_path: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub running: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Storage {
    entries: Vec<TimeEntry>,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::project::config_dir(app)?.join("time_tracking.json"))
}

fn load_raw(app: &AppHandle) -> Storage {
    path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, storage: &Storage) -> Result<(), String> {
    let p = path(app)?;
    let json = serde_json::to_string_pretty(storage).map_err(|e| e.to_string())?;
    fs::write(p, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn time_entries_get_all(app: AppHandle) -> Result<Vec<TimeEntry>, String> {
    let mut storage = load_raw(&app);
    let mut changed = false;
    for e in &mut storage.entries {
        if e.running {
            e.running = false;
            changed = true;
        }
    }
    if changed {
        save(&app, &storage)?;
    }
    Ok(storage.entries)
}

/// Upsert by id. Used for start (new), checkpoint tick (end_ms update),
/// stop (running=false), and manual edits from the UI.
#[tauri::command]
pub fn time_entry_save(app: AppHandle, entry: TimeEntry) -> Result<(), String> {
    let mut storage = load_raw(&app);
    if let Some(existing) = storage.entries.iter_mut().find(|e| e.id == entry.id) {
        *existing = entry;
    } else {
        storage.entries.push(entry);
    }
    save(&app, &storage)
}

#[tauri::command]
pub fn time_entry_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut storage = load_raw(&app);
    storage.entries.retain(|e| e.id != id);
    save(&app, &storage)
}

// ── Settings ────────────────────────────────────────────────────────────────
// Kept in a SEPARATE file from the entries because the two have very
// different lifecycles: entries grow indefinitely (and are read in bulk on
// every Time view open), settings are tiny and almost never change. Mixing
// them would force a full entries rewrite every time the user nudges a
// threshold, and a settings-only read every time we just want one number.

#[derive(Serialize, Deserialize, Clone)]
pub struct TimeSettings {
    // Idle threshold in MILLISECONDS. The UI talks minutes; conversion lives
    // on the frontend so the on-disk shape stays unit-explicit.
    pub idle_threshold_ms: u64,
    // Play a short beep when the idle auto-stop fires.
    pub idle_sound: bool,
}

impl Default for TimeSettings {
    fn default() -> Self {
        Self {
            idle_threshold_ms: 15 * 60_000, // 15 min
            idle_sound: true,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::project::config_dir(app)?.join("time_settings.json"))
}

#[tauri::command]
pub fn time_settings_get(app: AppHandle) -> Result<TimeSettings, String> {
    let s = settings_path(&app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<TimeSettings>(&s).ok())
        .unwrap_or_default();
    Ok(s)
}

#[tauri::command]
pub fn time_settings_save(app: AppHandle, settings: TimeSettings) -> Result<(), String> {
    let path = settings_path(&app)?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
