//! Minimal embedder for conformance fixtures.
//!
//! Starts the hosting-neutral [`qblive_server::full_router`] on
//! `127.0.0.1:8799` so `packages/qblive-conformance` can run against a
//! non-Cloudflare Rust backend:
//!
//! ```bash
//! QBLIVE_SETUP_TOKEN=test-setup cargo run -p qblive-server --example conformance-server &
//! node packages/qblive-conformance/dist/cli.js \
//!   --origin http://127.0.0.1:8799 --publication bcdfghjkmnpqrstvwxyz \
//!   --setup-token test-setup --initial-snapshot /tmp/publish.json
//! ```
//!
//! QBServer (#778) replaces this in-memory store with SQLite behind the same
//! `PublicationStorage` trait; the route semantics stay identical.

use qblive_server::{routes::AppState, CapabilityProfile};

#[tokio::main]
async fn main() {
    let state = AppState::new(CapabilityProfile::Full);
    let app = qblive_server::full_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8799")
        .await
        .expect("bind conformance server");
    println!("qblive conformance server on http://127.0.0.1:8799");
    axum::serve(listener, app).await.expect("serve");
}
