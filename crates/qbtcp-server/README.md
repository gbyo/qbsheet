# qbtcp-server

`qbtcp-server` is the native QBTCP v1 server boundary for QBSheet Director. It
contains the protocol state machine and an Axum HTTP transport, while the
tournament application supplies the `QbtcpState` implementation.

The transport does not know about SQLite rows, scheduling, standings, or other
tournament business rules. A Tauri host should provide a state adapter backed by
its repositories and construct the server once during application startup:

```rust,no_run
use std::sync::Arc;
use tokio::net::TcpListener;
use qbtcp_server::{QbtcpConfig, QbtcpServer, QbtcpState};

async fn run_qbtcp(
    state: Arc<dyn QbtcpState>,
    config: QbtcpConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let server = Arc::new(QbtcpServer::new(state, config)?);
    let listener = TcpListener::bind(("0.0.0.0", 0)).await?;
    server.serve(listener).await?;
    Ok(())
}
```

The host owns the chosen port and publishes the listener's LAN address. It
issues one-time pairing codes for enabled rooms with
`QbtcpServer::issue_pairing(room_id)`, and may use `QbtcpServer::router` when
it needs to mount the transport into an existing Tauri-managed listener.

The server implements discovery and health, scoped pairing and tokens,
assignment and session lifecycle, writer takeover, presence, progress, raw QBJ
result retention, duplicate/fingerprint conflict detection, recovery, roster
amendments, help requests, and session expiry. It follows the canonical
`/qbtcp/v1` paths and headers described in `docs/QBTCP.md`. Session credentials
are sent in headers only; the pairing code is one-time and is never returned in
an error. CORS is an explicit allowlist and request bodies are bounded.

`MemoryState` is intentionally only a small reference backend used by the
contract tests and local protocol experiments. It is not a persistence layer.
The Director Tauri host must implement `QbtcpState` over its durable storage
and use the state hooks to persist progress, submissions, presence, help, and
session events.
