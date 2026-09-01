//! QBTCP v1 server core and HTTP transport.
//!
//! The crate deliberately stops at the tournament-control boundary. [`QbtcpState`] is the
//! interface a Tauri host implements over its durable tournament store; this crate owns the
//! protocol, capability credentials, session lifecycle, and transport semantics, but it does not
//! decide how teams are scheduled or how standings are calculated.

mod core;
mod model;
mod state;
mod transport;

pub use core::{PairingInvitation, QbtcpServer};
pub use model::*;
pub use state::*;
pub use transport::router;
