use rusqlite::params;
use serde_json::Value;

use crate::db::Store;
use crate::error::StoreResult;
use crate::models::MetadataEntry;
use crate::util::{json_text, now};

pub struct MetadataRepository<'a> {
    store: &'a Store,
}

impl<'a> MetadataRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn get(&self, key: &str) -> StoreResult<Option<MetadataEntry>> {
        let mut statement = self.store.connection().prepare(
            "SELECT key, value_json, updated_at FROM application_metadata WHERE key = ?1",
        )?;
        let mut rows = statement.query(params![key])?;
        rows.next()?.map_or(Ok(None), |row| {
            let value_json: String = row.get(1)?;
            Ok(Some(MetadataEntry {
                key: row.get(0)?,
                value: serde_json::from_str(&value_json)?,
                updated_at: row.get(2)?,
            }))
        })
    }

    pub fn set(&self, key: &str, value: &Value) -> StoreResult<MetadataEntry> {
        let value_json = json_text(value)?;
        let entry = MetadataEntry {
            key: key.to_owned(),
            value: value.clone(),
            updated_at: now(),
        };
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO application_metadata (key, value_json, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at",
                params![entry.key, value_json, entry.updated_at],
            )?;
            Ok(entry)
        })
    }

    pub fn delete(&self, key: &str) -> StoreResult<bool> {
        Ok(self.store.connection().execute(
            "DELETE FROM application_metadata WHERE key = ?1",
            params![key],
        )? > 0)
    }

    pub fn list(&self) -> StoreResult<Vec<MetadataEntry>> {
        let mut statement = self
            .store
            .connection()
            .prepare("SELECT key, value_json, updated_at FROM application_metadata ORDER BY key")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(key, value_json, updated_at)| {
                Ok(MetadataEntry {
                    key,
                    value: serde_json::from_str(&value_json)?,
                    updated_at,
                })
            })
            .collect()
    }
}
