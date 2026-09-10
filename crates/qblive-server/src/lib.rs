//! Hosting-neutral QBLive v1 server core.
//!
//! A standalone native QBServer, Director local mode where behavior overlaps,
//! and tests/conformance fixtures all build on this crate. The protocol —
//! not Cloudflare and not Director process memory — is the source of truth
//! for server behavior. See `docs/QBLIVE_SERVER_CONTRACT.md`.
//!
//! # Route composition
//!
//! [`routes::public_router`] serves the unauthenticated public surface only.
//! [`routes::full_router`] adds the authenticated management API. Shared code
//! never forces Director local-only mode to expose management authority: that
//! host simply does not mount the management router.

pub mod protocol;
pub mod replay;
pub mod routes;
pub mod storage;

pub use protocol::{
    is_publication_id, is_valid_timestamp, sections_of, validate_section, validate_snapshot,
    CapabilityProfile, ValidationError, FULL_CAPABILITIES_JSON, LOCAL_CAPABILITIES_JSON,
    MAX_ANNOUNCEMENTS, MAX_BODY_BYTES, MAX_EVENTS_PER_PAGE, MAX_LIVE_GAMES, MAX_PLAYERS_PER_TEAM,
    MAX_RESULTS, MAX_ROOMS, MAX_SCHEDULE_ENTRIES, MAX_STRING_LENGTH, MAX_TABLES, MAX_TABLE_COLUMNS,
    MAX_TABLE_ROWS, MAX_TEAMS, MAX_TIMELINE_EVENTS, PROTOCOL_VERSION, REPLAY_WINDOW_FULL,
    REPLAY_WINDOW_LOCAL, SECTION_NAMES,
};
pub use replay::{clamp_limit, parse_after, resync_required};
pub use routes::{full_router, public_router, router_for_profile, AppState};
pub use storage::{
    generate_token, hash_token, timing_safe_equal, Lifecycle, MemoryStorage, PublicationStorage,
    StorageError,
};
