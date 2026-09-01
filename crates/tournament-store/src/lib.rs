//! Durable, modular SQLite persistence for QBSheet Director.
//!
//! The crate deliberately keeps database access behind focused repositories. A
//! Tauri command layer can own one [`Store`] and hand out the repository it
//! needs without exposing SQLite rows to the React application.

mod db;
mod error;
mod migrations;
pub mod models;
pub mod repositories;
mod util;

pub use db::{BackupReport, CheckpointMode, CheckpointReport, Store};
pub use error::{StoreError, StoreResult};
pub use migrations::CURRENT_SCHEMA_VERSION;
pub use models::*;
pub use repositories::*;

impl Store {
    pub fn tournaments(&self) -> TournamentRepository<'_> {
        TournamentRepository::new(self)
    }

    pub fn organizations(&self) -> OrganizationRepository<'_> {
        OrganizationRepository::new(self)
    }

    pub fn teams(&self) -> TeamRepository<'_> {
        TeamRepository::new(self)
    }

    pub fn players(&self) -> PlayerRepository<'_> {
        PlayerRepository::new(self)
    }

    pub fn rooms(&self) -> RoomRepository<'_> {
        RoomRepository::new(self)
    }

    pub fn staff(&self) -> StaffRepository<'_> {
        StaffRepository::new(self)
    }

    pub fn equipment(&self) -> EquipmentRepository<'_> {
        EquipmentRepository::new(self)
    }

    pub fn packets(&self) -> PacketRepository<'_> {
        PacketRepository::new(self)
    }

    pub fn phases(&self) -> PhaseRepository<'_> {
        PhaseRepository::new(self)
    }

    pub fn pools(&self) -> PoolRepository<'_> {
        PoolRepository::new(self)
    }

    pub fn rounds(&self) -> RoundRepository<'_> {
        RoundRepository::new(self)
    }

    pub fn schedule(&self) -> ScheduleRepository<'_> {
        ScheduleRepository::new(self)
    }

    pub fn games(&self) -> GameRepository<'_> {
        GameRepository::new(self)
    }

    pub fn submissions(&self) -> SubmissionRepository<'_> {
        SubmissionRepository::new(self)
    }

    pub fn results(&self) -> ResultRepository<'_> {
        ResultRepository::new(self)
    }

    pub fn protests(&self) -> ProtestRepository<'_> {
        ProtestRepository::new(self)
    }

    pub fn audit(&self) -> AuditRepository<'_> {
        AuditRepository::new(self)
    }

    pub fn metadata(&self) -> MetadataRepository<'_> {
        MetadataRepository::new(self)
    }

    pub fn qbtcp_rooms(&self) -> QbtcpRoomRepository<'_> {
        QbtcpRoomRepository::new(self)
    }

    pub fn qbtcp_sessions(&self) -> QbtcpSessionRepository<'_> {
        QbtcpSessionRepository::new(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{CheckpointMode, NewTournament, Store, CURRENT_SCHEMA_VERSION};

    #[test]
    fn new_store_has_durable_pragmas_and_current_schema() {
        let store = Store::open_in_memory().expect("open store");
        assert_eq!(
            store.schema_version().expect("schema version"),
            CURRENT_SCHEMA_VERSION
        );
        assert!(store.foreign_keys_enabled().expect("foreign keys"));
        assert_eq!(store.journal_mode().expect("journal mode"), "memory");

        let tournament = store
            .tournaments()
            .create(NewTournament::new("Unit test tournament"))
            .expect("create tournament");
        assert_eq!(
            store.tournaments().require(&tournament.id).unwrap().name,
            "Unit test tournament"
        );

        let checkpoint = store
            .checkpoint(CheckpointMode::Passive)
            .expect("checkpoint");
        assert_eq!(checkpoint.mode, CheckpointMode::Passive);
    }
}
