use rusqlite::{params, OptionalExtension, Row};

use super::tournaments::ensure_tournament_exists;
use crate::db::Store;
use crate::error::{StoreError, StoreResult};
use crate::models::{
    EquipmentResource, NewEquipmentResource, NewRoom, NewStaffMember, Room, StaffMember,
};
use crate::util::{bool_from_i64, bool_to_i64, json_from_row, json_text, new_id, now};

pub struct RoomRepository<'a> {
    store: &'a Store,
}

impl<'a> RoomRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewRoom) -> StoreResult<Room> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "room name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO rooms
                    (id, tournament_id, name, building, floor, accessible, directions, notes,
                     status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    id,
                    input.tournament_id,
                    input.name,
                    input.building,
                    input.floor,
                    bool_to_i64(input.accessible),
                    input.directions,
                    input.notes,
                    input.status,
                    timestamp,
                ],
            )?;
            Ok(Room {
                id,
                tournament_id: input.tournament_id,
                name: input.name,
                building: input.building,
                floor: input.floor,
                accessible: input.accessible,
                directions: input.directions,
                notes: input.notes,
                status: input.status,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn get(&self, id: &str) -> StoreResult<Option<Room>> {
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, name, building, floor, accessible, directions, notes,
                    status, created_at, updated_at
             FROM rooms WHERE id = ?1",
        )?;
        let mut rows = statement.query(params![id])?;
        rows.next()?
            .map_or(Ok(None), |row| Ok(Some(room_from_row(row)?)))
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<Room>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, name, building, floor, accessible, directions, notes,
                    status, created_at, updated_at
             FROM rooms WHERE tournament_id = ?1 ORDER BY name, id",
        )?;
        let rows = statement.query_map(params![tournament_id], room_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn set_status(&self, id: &str, status: &str) -> StoreResult<Room> {
        let changed = self.store.connection().execute(
            "UPDATE rooms SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now(), id],
        )?;
        if changed == 0 {
            return Err(StoreError::not_found("room", id));
        }
        self.get(id)?
            .ok_or_else(|| StoreError::not_found("room", id))
    }

    pub fn assign_staff(&self, room_id: &str, staff_id: &str, role: &str) -> StoreResult<()> {
        self.store.write_transaction(|transaction| {
            let room_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM rooms WHERE id = ?1",
                    params![room_id],
                    |row| row.get(0),
                )
                .optional()?;
            let staff_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM staff WHERE id = ?1",
                    params![staff_id],
                    |row| row.get(0),
                )
                .optional()?;
            match (room_tournament, staff_tournament) {
                (Some(room_tournament), Some(staff_tournament))
                    if room_tournament == staff_tournament => {}
                (None, _) => return Err(StoreError::not_found("room", room_id)),
                (_, None) => return Err(StoreError::not_found("staff member", staff_id)),
                _ => {
                    return Err(StoreError::Conflict(
                        "room and staff member belong to different tournaments".to_owned(),
                    ))
                }
            }
            transaction.execute(
                "INSERT INTO room_staff_assignments (room_id, staff_id, role)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(room_id, staff_id, role) DO NOTHING",
                params![room_id, staff_id, role],
            )?;
            Ok(())
        })
    }

    pub fn assign_equipment(&self, room_id: &str, equipment_id: &str) -> StoreResult<()> {
        self.store.write_transaction(|transaction| {
            let room_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM rooms WHERE id = ?1",
                    params![room_id],
                    |row| row.get(0),
                )
                .optional()?;
            let equipment_tournament: Option<String> = transaction
                .query_row(
                    "SELECT tournament_id FROM equipment WHERE id = ?1",
                    params![equipment_id],
                    |row| row.get(0),
                )
                .optional()?;
            match (room_tournament, equipment_tournament) {
                (Some(room_tournament), Some(equipment_tournament))
                    if room_tournament == equipment_tournament => {}
                (None, _) => return Err(StoreError::not_found("room", room_id)),
                (_, None) => return Err(StoreError::not_found("equipment", equipment_id)),
                _ => {
                    return Err(StoreError::Conflict(
                        "room and equipment belong to different tournaments".to_owned(),
                    ))
                }
            }
            transaction.execute(
                "INSERT INTO room_equipment_assignments (room_id, equipment_id)
                 VALUES (?1, ?2)
                 ON CONFLICT(room_id, equipment_id) DO NOTHING",
                params![room_id, equipment_id],
            )?;
            Ok(())
        })
    }
}

pub struct StaffRepository<'a> {
    store: &'a Store,
}

impl<'a> StaffRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewStaffMember) -> StoreResult<StaffMember> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        if input.display_name.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "staff member name cannot be empty".to_owned(),
            ));
        }
        let id = new_id();
        let timestamp = now();
        let availability = json_text(&input.availability)?;
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO staff
                    (id, tournament_id, display_name, role, availability_json, notes,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    input.tournament_id,
                    input.display_name,
                    input.role,
                    availability,
                    input.notes,
                    timestamp,
                ],
            )?;
            Ok(StaffMember {
                id,
                tournament_id: input.tournament_id,
                display_name: input.display_name,
                role: input.role,
                availability: input.availability,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<StaffMember>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, display_name, role, availability_json, notes,
                    created_at, updated_at
             FROM staff WHERE tournament_id = ?1 ORDER BY display_name, id",
        )?;
        let rows = statement.query_map(params![tournament_id], staff_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

pub struct EquipmentRepository<'a> {
    store: &'a Store,
}

impl<'a> EquipmentRepository<'a> {
    pub(crate) fn new(store: &'a Store) -> Self {
        Self { store }
    }

    pub fn create(&self, input: NewEquipmentResource) -> StoreResult<EquipmentResource> {
        ensure_tournament_exists(self.store, &input.tournament_id)?;
        let id = new_id();
        let timestamp = now();
        self.store.write_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO equipment
                    (id, tournament_id, kind, name, status, notes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    input.tournament_id,
                    input.kind,
                    input.name,
                    input.status,
                    input.notes,
                    timestamp,
                ],
            )?;
            Ok(EquipmentResource {
                id,
                tournament_id: input.tournament_id,
                kind: input.kind,
                name: input.name,
                status: input.status,
                notes: input.notes,
                created_at: timestamp,
                updated_at: timestamp,
            })
        })
    }

    pub fn list(&self, tournament_id: &str) -> StoreResult<Vec<EquipmentResource>> {
        ensure_tournament_exists(self.store, &tournament_id.to_owned())?;
        let mut statement = self.store.connection().prepare(
            "SELECT id, tournament_id, kind, name, status, notes, created_at, updated_at
             FROM equipment WHERE tournament_id = ?1 ORDER BY kind, name, id",
        )?;
        let rows = statement.query_map(params![tournament_id], equipment_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

fn room_from_row(row: &Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        name: row.get(2)?,
        building: row.get(3)?,
        floor: row.get(4)?,
        accessible: bool_from_i64(row.get(5)?),
        directions: row.get(6)?,
        notes: row.get(7)?,
        status: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn staff_from_row(row: &Row<'_>) -> rusqlite::Result<StaffMember> {
    Ok(StaffMember {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        display_name: row.get(2)?,
        role: row.get(3)?,
        availability: json_from_row(row, 4)?,
        notes: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn equipment_from_row(row: &Row<'_>) -> rusqlite::Result<EquipmentResource> {
    Ok(EquipmentResource {
        id: row.get(0)?,
        tournament_id: row.get(1)?,
        kind: row.get(2)?,
        name: row.get(3)?,
        status: row.get(4)?,
        notes: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
