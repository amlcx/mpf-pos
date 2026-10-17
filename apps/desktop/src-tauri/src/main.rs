// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use pos_native::{Db, Row, Statement};
use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, ResourceId, State, Url, Webview};
use tauri_plugin_updater::UpdaterExt;

// Thin wrappers only: the logic lives in pos-native (testable without a
// webview) and in the TypeScript under ../src/lib. `async` keeps disk and
// printer work off the UI thread.

#[tauri::command(async)]
fn db_select(db: State<'_, Db>, sql: String, params: Vec<Value>) -> Result<Vec<Row>, String> {
    db.select(&sql, &params)
}

#[tauri::command(async)]
fn db_batch(db: State<'_, Db>, statements: Vec<Statement>) -> Result<(), String> {
    db.batch(&statements)
}

#[tauri::command(async)]
fn print_raw(target: String, bytes: Vec<u8>) -> Result<(), String> {
    pos_native::print_raw(&target, &bytes)
}

#[tauri::command(async)]
fn save_export(app: tauri::AppHandle, filename: String, contents: String) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    pos_native::write_export(&dir, &filename, &contents)
}

/// Same shape as the updater plugin's own check result, so the JS `Update`
/// class can download and install what this finds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: Value,
}

/// Why this exists: the update endpoint is the server chosen in Setup, so it
/// cannot be written in tauri.conf.json, and the plugin's JS `check()` takes
/// no endpoint. This asks that server with the terminal token, then clears
/// the headers so the token is never sent to GitHub, where the installer is
/// downloaded from.
#[tauri::command]
async fn check_update(
    webview: Webview,
    endpoint: String,
    terminal_token: String,
) -> Result<Option<UpdateMetadata>, String> {
    let endpoint = Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let updater = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|b| b.header("Authorization", format!("Bearer {terminal_token}")))
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    update.headers.clear();
    // The installer is tens of megabytes on a shop's connection.
    update.timeout = Some(Duration::from_secs(15 * 60));
    let date = update.raw_json.get("pub_date").and_then(Value::as_str).map(String::from);
    Ok(Some(UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db::open(&dir.join("register.sqlite"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_select, db_batch, print_raw, save_export, check_update])
        .run(tauri::generate_context!())
        .expect("error while running the register");
}
