// Per-project to-do lists. Stored as a flat list in <config_dir>/todos.json —
// i.e. %APPDATA%\com.equilibrium.dashboard on Windows, NOT the install
// directory and NOT the project folders themselves. That placement is the
// whole point:
//   * the installer never touches the app-data dir, so upgrading (or
//     reinstalling) a build keeps every task;
//   * the app-data dir is per Windows user, so two people running the same
//     build on the same machine — or sharing the same project folder over
//     git — each keep their own private list;
//   * uninstalling is non-destructive: the file simply stays behind.
//
// A task belongs to a project via `project_path`, matching the registry key
// used everywhere else (projects.json, time_tracking.json). An empty string
// means "not attached to any project" — the Inbox.
//
// Size: a task is ~200 bytes. Even a few thousand of them stay well under a
// megabyte, so the whole file is read and rewritten on every mutation rather
// than maintaining an index.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: String,
    /// Registry path of the owning project; "" = Inbox (no project).
    pub project_path: String,
    pub text: String,
    pub done: bool,
    /// true = flagged as important. Kept as a bool rather than an enum so the
    /// UI stays a single toggle; a richer scale can be added later without
    /// breaking the file (serde defaults absent fields).
    #[serde(default)]
    pub priority: bool,
    pub created_ms: u64,
    /// Last time the task itself was edited (text, done, priority, project).
    /// Manual drag-reordering deliberately does NOT bump it — that's a change
    /// to the view, not to the task. Defaults to 0 for files written before
    /// this field existed; `todos_get_all` backfills those from `created_ms`.
    #[serde(default)]
    pub updated_ms: u64,
    pub done_ms: Option<u64>,
    /// Manual sort position within its project. Lower comes first.
    #[serde(default)]
    pub order: i64,
}

#[derive(Serialize, Deserialize, Default)]
struct Storage {
    todos: Vec<Todo>,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::project::config_dir(app)?.join("todos.json"))
}

// A missing or corrupt file is treated as "no tasks yet" rather than an
// error: the file is created lazily on the first save, so a fresh install
// never writes anything until the user actually adds a task.
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
pub fn todos_get_all(app: AppHandle) -> Result<Vec<Todo>, String> {
    let mut todos = load_raw(&app).todos;
    // Backfill for tasks created before `updated_ms` existed, so sorting by
    // "last updated" never sees a 1970 timestamp.
    for t in &mut todos {
        if t.updated_ms == 0 {
            t.updated_ms = t.created_ms;
        }
    }
    Ok(todos)
}

/// Upsert by id — covers create, rename, tick/untick and priority toggle.
#[tauri::command]
pub fn todo_save(app: AppHandle, todo: Todo) -> Result<(), String> {
    let mut storage = load_raw(&app);
    if let Some(existing) = storage.todos.iter_mut().find(|t| t.id == todo.id) {
        *existing = todo;
    } else {
        storage.todos.push(todo);
    }
    save(&app, &storage)
}

#[tauri::command]
pub fn todo_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut storage = load_raw(&app);
    storage.todos.retain(|t| t.id != id);
    save(&app, &storage)
}

/// Rewrites `order` to match the given id sequence. Ids not present in the
/// file are ignored, and tasks not listed keep their current order — so a
/// drag inside one project can't disturb another's ordering.
#[tauri::command]
pub fn todos_reorder(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut storage = load_raw(&app);
    for (index, id) in ids.iter().enumerate() {
        if let Some(t) = storage.todos.iter_mut().find(|t| &t.id == id) {
            t.order = index as i64;
        }
    }
    save(&app, &storage)
}

/// Drops every completed task, optionally scoped to one project.
/// `project_path = None` clears completed tasks everywhere.
#[tauri::command]
pub fn todos_clear_done(app: AppHandle, project_path: Option<String>) -> Result<(), String> {
    let mut storage = load_raw(&app);
    match project_path {
        Some(p) => storage.todos.retain(|t| !(t.done && t.project_path == p)),
        None => storage.todos.retain(|t| !t.done),
    }
    save(&app, &storage)
}

/// Detaches every task of a removed project instead of deleting them, so
/// forgetting a project from the dashboard never silently destroys work.
/// Called when a project is removed from the registry.
pub fn orphan_project_todos(app: &AppHandle, project_path: &str) {
    let mut storage = load_raw(app);
    let mut changed = false;
    for t in &mut storage.todos {
        if t.project_path == project_path {
            t.project_path = String::new();
            changed = true;
        }
    }
    if changed {
        let _ = save(app, &storage);
    }
}
