//! QBTCP v1 server core and HTTP transport.
//!
//! The crate deliberately stops at the tournament-control boundary. [`QbtcpState`] is the
//! interface a Tauri host implements over its durable tournament store; this crate owns the
//! protocol, capability credentials, session lifecycle, and transport semantics, but it does not
//! decide how teams are scheduled or how standings are calculated.

mod core;
mod model;
mod state;
pub mod stream;
mod transport;

pub use core::{
    PairingInvitation, QbtcpServer, RuntimeCredentialPersistence, RuntimeCredentialSnapshot,
};
pub use model::*;
pub use state::*;
pub use stream::{
    is_assignment_newer, is_duplicate_final, progress_wins, read_stream_descriptor,
    reconnect_delay_ms, validate_stream_frame, RelayReceipt, StreamDescriptor,
    StreamDescriptorError, StreamFrame, StreamFrameError, ValidatedStreamFrame,
    DEFAULT_MAX_STREAM_FRAME_BYTES, SCORER_FRAME_TYPES, SERVER_FRAME_TYPES, STREAM_CAPABILITY,
    STREAM_FRAME_VERSION, STREAM_RECONNECT_BASE_MS, STREAM_RECONNECT_MAX_MS,
    STREAM_REPLAY_FEATURES, STREAM_SUBPROTOCOL,
};
pub use transport::router;
