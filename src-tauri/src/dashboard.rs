use serde::{Deserialize, Serialize};
use std::fs;
use tauri::AppHandle;

use crate::project::{config_dir, config_file};

fn default_section_color() -> String {
    "#3b82f6".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectSection {
    pub id: String,
    pub title: String,
    #[serde(default = "default_section_color")]
    pub color: String, // Hex color for the section accent
    pub project_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DashboardConfig {
    pub sections: Vec<ProjectSection>,
}

#[tauri::command]
pub async fn get_dashboard_config(app: AppHandle) -> Result<DashboardConfig, String> {
    let config_path = config_file(&app, "dashboard.json")?;
    if !config_path.exists() {
        return Ok(DashboardConfig {
            sections: vec![ProjectSection {
                id: "default".to_string(),
                title: "Personal Projects".to_string(),
                color: "#3b82f6".to_string(),
                project_paths: vec![],
            }],
        });
    }

    let content = fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let config: DashboardConfig = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
pub async fn save_dashboard_config(app: AppHandle, config: DashboardConfig) -> Result<(), String> {
    let config_path = config_dir(&app)?.join("dashboard.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path, content).map_err(|e| e.to_string())
}
