use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Type;
use rusqlite::Row;
use serde_json::Value;

use crate::error::StoreResult;

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn json_text(value: &Value) -> StoreResult<String> {
    Ok(serde_json::to_string(value)?)
}

pub(crate) fn json_from_row(row: &Row<'_>, column: usize) -> rusqlite::Result<Value> {
    let text: String = row.get(column)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
    })
}

pub(crate) fn bool_from_i64(value: i64) -> bool {
    value != 0
}

pub(crate) fn bool_to_i64(value: bool) -> i64 {
    i64::from(value)
}
