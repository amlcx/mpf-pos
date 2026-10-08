// No console window behind the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pos_native::{Db, Row, Statement};
use serde_json::Value;
use tauri::{Manager, State};

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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db::open(&dir.join("register.sqlite"))?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_select, db_batch, print_raw, save_export])
        .run(tauri::generate_context!())
        .expect("error while running the register");
}
