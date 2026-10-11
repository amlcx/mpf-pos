use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde::Deserialize;
use serde_json::{Map, Value};

#[cfg(windows)]
mod spooler;

pub type Row = Map<String, Value>;

#[derive(Debug, Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

/// The register's local database. All SQL is written on the TypeScript side
/// (apps/desktop/src/lib); this only executes it.
pub struct Db(Mutex<Connection>);

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn bind(params: &[Value]) -> Result<Vec<SqlValue>, String> {
    params
        .iter()
        .map(|p| match p {
            Value::Null => Ok(SqlValue::Null),
            Value::Bool(b) => Ok(SqlValue::Integer(*b as i64)),
            Value::String(s) => Ok(SqlValue::Text(s.clone())),
            Value::Number(n) => n
                .as_i64()
                .map(SqlValue::Integer)
                .or_else(|| n.as_f64().map(SqlValue::Real))
                .ok_or_else(|| format!("unsupported number: {n}")),
            other => Err(format!("unsupported parameter: {other}")),
        })
        .collect()
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::configure(Connection::open(path).map_err(err)?)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::configure(Connection::open_in_memory().map_err(err)?)
    }

    fn configure(conn: Connection) -> Result<Self, String> {
        // synchronous = FULL: a sale that was confirmed on screen must
        // survive the PC losing power a moment later.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;",
        )
        .map_err(err)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn select(&self, sql: &str, params: &[Value]) -> Result<Vec<Row>, String> {
        let conn = self.0.lock().map_err(err)?;
        let mut stmt = conn.prepare(sql).map_err(err)?;
        let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
        let mut rows = stmt.query(params_from_iter(bind(params)?)).map_err(err)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(err)? {
            let mut object = Row::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i).map_err(err)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(f) => Value::from(f),
                    ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
                    ValueRef::Blob(_) => return Err(format!("column {name}: blobs are not supported")),
                };
                object.insert(name.clone(), value);
            }
            out.push(object);
        }
        Ok(out)
    }

    /// Runs every statement in one transaction: all of them apply, or none.
    pub fn batch(&self, statements: &[Statement]) -> Result<(), String> {
        let mut conn = self.0.lock().map_err(err)?;
        let tx = conn.transaction().map_err(err)?;
        for statement in statements {
            tx.execute(&statement.sql, params_from_iter(bind(&statement.params)?))
                .map_err(|e| format!("{e} (in: {})", statement.sql))?;
        }
        tx.commit().map_err(err)
    }
}

/// Sends raw ESC/POS bytes to the printer.
///
/// On Windows `target` is the printer's name as Windows shows it, and the
/// bytes go through the spooler as a RAW job. A path with a drive letter is
/// written as a file instead.
///
/// Elsewhere `target` is a path the OS exposes the printer at, e.g.
/// `/dev/usb/lp0` on Linux. A regular file works too, which is handy for
/// looking at the bytes during development.
pub fn print_raw(target: &str, bytes: &[u8]) -> Result<(), String> {
    #[cfg(windows)]
    if target.as_bytes().get(1) != Some(&b':') {
        return spooler::print_raw(target, bytes);
    }
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(target)
        .map_err(|e| format!("cannot open printer {target}: {e}"))?;
    file.write_all(bytes).map_err(err)?;
    file.flush().map_err(err)
}

/// Writes an export (e.g. a CSV report) into `dir` and returns its full path.
/// `filename` must be a bare file name: the webview chooses it, and it must
/// not be able to write anywhere else.
pub fn write_export(dir: &Path, filename: &str, contents: &str) -> Result<String, String> {
    let bare = Path::new(filename).file_name().and_then(|n| n.to_str()) == Some(filename);
    if !bare || filename.starts_with('.') || filename.contains(['/', '\\', ':']) {
        return Err(format!("invalid file name: {filename}"));
    }
    std::fs::create_dir_all(dir).map_err(err)?;
    let path = dir.join(filename);
    std::fs::write(&path, contents).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn statement(sql: &str, params: Value) -> Statement {
        serde_json::from_value(json!({ "sql": sql, "params": params })).unwrap()
    }

    #[test]
    fn round_trips_values() {
        let db = Db::open_in_memory().unwrap();
        db.batch(&[
            statement("create table t (id text primary key, n integer, flag integer, note text)", json!([])),
            statement("insert into t values (?, ?, ?, ?)", json!(["a", 42, true, null])),
        ])
        .unwrap();
        let rows = db.select("select id, n, flag, note from t where id = ?", &[json!("a")]).unwrap();
        assert_eq!(Value::Array(rows.into_iter().map(Value::Object).collect()), json!([{ "id": "a", "n": 42, "flag": 1, "note": null }]));
    }

    #[test]
    fn batch_is_all_or_nothing() {
        let db = Db::open_in_memory().unwrap();
        db.batch(&[statement("create table t (id text primary key)", json!([]))]).unwrap();
        let result = db.batch(&[
            statement("insert into t values ('a')", json!([])),
            statement("insert into t values ('a')", json!([])),
        ]);
        assert!(result.is_err());
        assert!(db.select("select id from t", &[]).unwrap().is_empty());
    }

    #[test]
    fn exports_only_inside_the_given_folder() {
        let dir = std::env::temp_dir().join(format!("pos-native-export-{}", std::process::id()));
        let path = write_export(&dir, "pedidos.csv", "a;b\r\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a;b\r\n");
        for bad in ["../x.csv", "/tmp/x.csv", "a/b.csv", "..", "", ".hidden", "c:x.csv", "a\\b.csv"] {
            assert!(write_export(&dir, bad, "x").is_err(), "{bad} should be rejected");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prints_to_a_file() {
        let path = std::env::temp_dir().join(format!("pos-native-test-{}.bin", std::process::id()));
        let target = path.to_str().unwrap();
        print_raw(target, &[0x1b, 0x40]).unwrap();
        print_raw(target, b"hi\n").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"\x1b\x40hi\n");
        std::fs::remove_file(&path).unwrap();
    }
}
