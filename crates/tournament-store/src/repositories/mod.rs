use rusqlite::{params, OptionalExtension, Transaction};

use crate::error::{StoreError, StoreResult};

mod audit;
mod catalog;
mod competition;
mod metadata;
mod qbtcp;
mod results;
mod tournaments;
mod venue;

pub use audit::AuditRepository;
pub use catalog::{OrganizationRepository, PlayerRepository, TeamRepository};
pub use competition::{
    PacketRepository, PhaseRepository, PoolRepository, RoundRepository, ScheduleRepository,
};
pub use metadata::MetadataRepository;
pub use qbtcp::{QbtcpRoomRepository, QbtcpSessionRepository};
pub use results::{GameRepository, ProtestRepository, ResultRepository, SubmissionRepository};
pub use tournaments::TournamentRepository;
pub use venue::{EquipmentRepository, RoomRepository, StaffRepository};

pub(crate) fn ensure_same_tournament(
    transaction: &Transaction<'_>,
    left_table: &'static str,
    left_label: &'static str,
    left_id: &str,
    right_table: &'static str,
    right_label: &'static str,
    right_id: &str,
) -> StoreResult<()> {
    let left_tournament: Option<String> = transaction
        .query_row(
            &format!("SELECT tournament_id FROM {left_table} WHERE id = ?1"),
            params![left_id],
            |row| row.get(0),
        )
        .optional()?;
    let right_tournament: Option<String> = transaction
        .query_row(
            &format!("SELECT tournament_id FROM {right_table} WHERE id = ?1"),
            params![right_id],
            |row| row.get(0),
        )
        .optional()?;

    match (left_tournament, right_tournament) {
        (Some(left_tournament), Some(right_tournament)) if left_tournament == right_tournament => {
            Ok(())
        }
        (None, _) => Err(StoreError::not_found(left_label, left_id)),
        (_, None) => Err(StoreError::not_found(right_label, right_id)),
        _ => Err(StoreError::Conflict(format!(
            "{left_label} and {right_label} belong to different tournaments"
        ))),
    }
}
