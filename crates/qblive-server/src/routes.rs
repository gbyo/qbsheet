//! Axum route composition over [`crate::storage::MemoryStorage`].
//!
//! The shared core allows host-specific composition: a full remote backend
//! (QBServer, Cloudflare-equivalent) mounts public + management routes,
//! while Director local-only mode mounts public routes only. Shared code
//! never forces local mode to expose management authority — there is simply
//! no management router in that composition.
//!
//! Observable behavior matches `docs/QBLIVE_SERVER_CONTRACT.md`: CORS `*` on
//! every response, `no-cache` on public reads, `ETag: "<revision>"` on
//! snapshots, `404` for unknown publications, `410` for unpublished ones,
//! `resyncRequired` instead of a misleading short page, `hello` first on the
//! stream, and spectator frames answered with `resync` rather than applied.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{broadcast, RwLock};

use crate::{
    protocol::{is_publication_id, CapabilityProfile, PROTOCOL_VERSION},
    replay::{clamp_limit, parse_after, resync_required},
    storage::{Lifecycle, MemoryStorage, PublicationStorage, StorageError},
};

/// Shared server state for the reference router.
///
/// QBServer (#778) will replace the inner storage with SQLite behind the same
/// [`PublicationStorage`] trait; the route semantics stay identical.
#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<RwLock<MemoryStorage>>,
    pub profile: CapabilityProfile,
    pub events: broadcast::Sender<Value>,
}

impl AppState {
    pub fn new(profile: CapabilityProfile) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            storage: Arc::new(RwLock::new(MemoryStorage::new())),
            profile,
            events,
        }
    }

    pub fn with_storage(storage: MemoryStorage, profile: CapabilityProfile) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            storage: Arc::new(RwLock::new(storage)),
            profile,
            events,
        }
    }
}

fn public_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/qblive/v1/tournaments/{publication_id}/manifest",
            get(manifest),
        )
        .route(
            "/qblive/v1/tournaments/{publication_id}/snapshot",
            get(snapshot),
        )
        .route(
            "/qblive/v1/tournaments/{publication_id}/events",
            get(events),
        )
        .route(
            "/qblive/v1/tournaments/{publication_id}/stream",
            get(stream),
        )
        .route("/health", get(health))
}

fn management_routes() -> Router<AppState> {
    Router::new()
        .route("/qblive/v1/manage/claim", axum::routing::post(claim))
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}/snapshot",
            axum::routing::put(put_snapshot),
        )
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}/sections",
            axum::routing::post(post_sections),
        )
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}/announcements",
            axum::routing::post(post_announcement),
        )
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}/finalize",
            axum::routing::post(finalize),
        )
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}/unpublish",
            axum::routing::post(unpublish),
        )
        .route(
            "/qblive/v1/manage/tournaments/{publication_id}",
            axum::routing::delete(destroy),
        )
}

/// Public routes only: manifest, snapshot, events, stream, health.
///
/// This is the composition Director local-only mode uses. There is no
/// management route here at all.
pub fn public_router(state: AppState) -> Router {
    public_routes().with_state(state)
}

/// Full remote-backend router: public routes plus authenticated management.
///
/// Claim lives at `/qblive/v1/manage/claim` (the backend does not yet know
/// which tournament it is for); every other management route is scoped to a
/// publication id.
pub fn full_router(state: AppState) -> Router {
    // Axum's default 2 MiB body cap would reject the conformance suite's
    // deliberate 9 MiB oversized upload before the handler can answer a
    // protocol `413` — and Node's fetch reports that early close as a network
    // failure rather than a status. Disable the framework cap and enforce the
    // 8 MiB protocol limit in `read_body_limited`, which drains the 9 MiB
    // probe body fully before answering so every client observes the 413.
    public_routes()
        .merge(management_routes())
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(state)
}

/// Build a router for a capability profile.
///
/// `Full` mounts management; `Local` and `Basic` mount public routes only.
pub fn router_for_profile(state: AppState) -> Router {
    match state.profile {
        CapabilityProfile::Full => full_router(state),
        CapabilityProfile::Local | CapabilityProfile::Basic => public_router(state),
    }
}

fn ok_json(value: Value) -> Response {
    let mut response = Json(value).into_response();
    insert_cors(response.headers_mut());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn ok_json_with_etag(value: Value, revision: i64) -> Response {
    let mut response = ok_json(value);
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{revision}\"")) {
        response.headers_mut().insert(header::ETAG, etag);
    }
    response.headers_mut().insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("etag"),
    );
    response
}

fn insert_cors(headers: &mut axum::http::HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
}

fn error_json(error: StorageError) -> Response {
    let status =
        StatusCode::from_u16(error.status_code()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut body = json!({ "error": error.code(), "message": error.message() });
    if let Some(revision) = error.current_revision() {
        body["currentRevision"] = json!(revision);
    }
    let mut response = (status, Json(body)).into_response();
    insert_cors(response.headers_mut());
    response
}

fn bad_request(message: &str) -> Response {
    error_json(StorageError::BadRequest(message.to_owned()))
}

async fn health() -> Response {
    ok_json(json!({ "service": "qblive", "protocolVersion": PROTOCOL_VERSION }))
}

#[allow(clippy::result_large_err)]
fn require_id_format(publication_id: &str) -> Result<(), Response> {
    if !is_publication_id(publication_id) {
        return Err(error_json(StorageError::NotFound(
            "No such tournament.".to_owned(),
        )));
    }
    Ok(())
}

async fn manifest(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let guard = state.storage.read().await;
    let Some(publication_id) = guard.publication_id() else {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    };
    if publication_id != id {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    if guard.lifecycle() == Some(Lifecycle::Unpublished) {
        return error_json(StorageError::Gone(
            "This tournament is no longer published.".to_owned(),
        ));
    }
    let Some(snapshot) = guard.snapshot() else {
        return error_json(StorageError::NotFound(
            "This tournament has not published yet.".to_owned(),
        ));
    };
    let revision = guard.revision();
    let capabilities: Value = serde_json::from_str(state.profile.capabilities_json()).unwrap_or(
        json!({ "snapshot": true, "events": false, "stream": false, "applePush": false }),
    );
    let base = format!("/qblive/v1/tournaments/{id}");
    let mut endpoints = json!({ "snapshot": format!("{base}/snapshot") });
    if state.profile.advertises_events() {
        endpoints["events"] = json!(format!("{base}/events"));
    }
    if state.profile.advertises_stream() {
        endpoints["stream"] = json!(format!("{base}/stream"));
    }
    ok_json(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "publicationId": id,
        "revision": revision,
        "generatedAt": snapshot.get("generatedAt").cloned().unwrap_or(Value::Null),
        "tournament": snapshot.get("tournament").cloned().unwrap_or(Value::Null),
        "capabilities": capabilities,
        "endpoints": endpoints,
        "final": guard.lifecycle() == Some(Lifecycle::Final),
    }))
}

async fn snapshot(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let guard = state.storage.read().await;
    let Some(publication_id) = guard.publication_id() else {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    };
    if publication_id != id {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    if guard.lifecycle() == Some(Lifecycle::Unpublished) {
        return error_json(StorageError::Gone(
            "This tournament is no longer published.".to_owned(),
        ));
    }
    match guard.snapshot() {
        Some(snapshot) => {
            let revision = guard.revision();
            ok_json_with_etag(snapshot, revision)
        }
        None => error_json(StorageError::NotFound(
            "This tournament has not published yet.".to_owned(),
        )),
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<String>,
    limit: Option<String>,
}

async fn events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    if !state.profile.advertises_events() {
        return error_json(StorageError::NotFound("No such QBLive route.".to_owned()));
    }
    let after = match parse_after(query.after.as_deref()) {
        Ok(after) => after,
        Err(message) => return bad_request(&message),
    };
    let limit = clamp_limit(query.limit.as_deref());
    let guard = state.storage.read().await;
    let Some(publication_id) = guard.publication_id() else {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    };
    if publication_id != id {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    if guard.lifecycle() == Some(Lifecycle::Unpublished) {
        return error_json(StorageError::Gone(
            "This tournament is no longer published.".to_owned(),
        ));
    }
    if guard.snapshot().is_none() {
        return error_json(StorageError::NotFound(
            "This tournament has not published yet.".to_owned(),
        ));
    }
    let current_revision = guard.revision();
    let oldest = guard.oldest_event_revision();
    let resync = resync_required(after, current_revision, oldest);
    let list = if resync {
        vec![]
    } else {
        guard.events_after(after, limit)
    };
    ok_json(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "publicationId": id,
        "currentRevision": current_revision,
        "events": list,
        "resyncRequired": resync,
    }))
}

async fn stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    request: axum::extract::Request,
) -> Response {
    use axum::extract::FromRequest;
    let (parts, body) = request.into_parts();
    // Reconstruct the request for the upgrade extractor after peeking at the
    // headers: a non-WebSocket GET must answer 400 JSON, not Axum's default.
    let is_websocket = parts
        .headers
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let request = axum::extract::Request::from_parts(parts, body);
    let ws = if is_websocket {
        axum::extract::ws::WebSocketUpgrade::from_request(request, &state)
            .await
            .ok()
    } else {
        None
    };
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    if !state.profile.advertises_stream() {
        return error_json(StorageError::NotFound("No such QBLive route.".to_owned()));
    }
    {
        let guard = state.storage.read().await;
        let Some(publication_id) = guard.publication_id() else {
            return error_json(StorageError::NotFound("No such tournament.".to_owned()));
        };
        if publication_id != id {
            return error_json(StorageError::NotFound("No such tournament.".to_owned()));
        }
        if guard.lifecycle() == Some(Lifecycle::Unpublished) {
            return error_json(StorageError::Gone(
                "This tournament is no longer published.".to_owned(),
            ));
        }
        if guard.snapshot().is_none() {
            return error_json(StorageError::NotFound(
                "This tournament has not published yet.".to_owned(),
            ));
        }
    }
    let Some(upgrade) = ws else {
        return bad_request("The stream endpoint requires a WebSocket upgrade.");
    };
    let revision = state.storage.read().await.revision();
    let receiver = state.events.subscribe();
    Response::from(
        upgrade.on_upgrade(move |socket| serve_stream(socket, id, revision, receiver, state)),
    )
}

async fn serve_stream(
    mut socket: axum::extract::ws::WebSocket,
    publication_id: String,
    revision: i64,
    mut receiver: broadcast::Receiver<Value>,
    state: AppState,
) {
    use axum::extract::ws::Message;
    let hello = crate::protocol::hello_frame(&publication_id, revision);
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    // Spectator frames are read-only: answer with the current
                    // revision and change nothing.
                    Some(Ok(_)) => {
                        let current = state.storage.read().await.revision();
                        let frame = crate::protocol::resync_frame(current);
                        if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                    _ => return,
                }
            }
            broadcasted = receiver.recv() => {
                match broadcasted {
                    Ok(event) => {
                        let frame = crate::protocol::event_frame(&event);
                        if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let current = state.storage.read().await.revision();
                        let frame = crate::protocol::resync_frame(current);
                        if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

fn bearer_token(headers: &axum::http::HeaderMap) -> String {
    let raw = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let trimmed = raw.trim();
    if let Some(token) = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
    {
        return token.trim().to_owned();
    }
    String::new()
}

#[allow(clippy::result_large_err)]
async fn read_body_limited(body: Body) -> Result<Value, Response> {
    use axum::body::to_bytes;
    // Drain up to 16 MiB so the conformance suite's 9 MiB probe is fully
    // consumed before the 8 MiB protocol `413` is answered. Answering from a
    // partially read body closes the connection early, which Node's fetch
    // reports as a network failure rather than the status the server sent.
    let bytes = to_bytes(body, 16 * 1024 * 1024).await.map_err(|_| {
        error_json(StorageError::TooLarge(
            "That publication update is too large.".to_owned(),
        ))
    })?;
    if bytes.len() > crate::protocol::MAX_BODY_BYTES {
        return Err(error_json(StorageError::TooLarge(
            "That publication update is too large.".to_owned(),
        )));
    }
    serde_json::from_slice(&bytes).map_err(|_| bad_request("That request body is not valid JSON."))
}

// The setup secret source is host-specific (environment, file, CLI) and not
// part of the protocol. For the reference router it is fixed at startup via
// the `QBLIVE_SETUP_TOKEN` environment variable; tests inject it directly.
// A missing configuration is `403`: there is nothing to claim against.
fn expected_setup_hash() -> Option<String> {
    std::env::var("QBLIVE_SETUP_TOKEN")
        .ok()
        .map(|token| crate::storage::hash_token(&token))
}

async fn claim(State(state): State<AppState>, body: Body) -> Response {
    let value = match read_body_limited(body).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let setup_token = value
        .get("setupToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    let publication_id = value
        .get("publicationId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if setup_token.is_empty() || publication_id.is_empty() {
        return bad_request("A setup token and a publication id are required.");
    }
    let expected = expected_setup_hash();
    let mut guard = state.storage.write().await;
    match guard.claim(publication_id, setup_token, expected.as_deref()) {
        Ok(token) => ok_json(json!({
            "publicationId": publication_id,
            "managementToken": token,
            "origin": "",
        })),
        Err(error) => error_json(error),
    }
}

async fn put_snapshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let value = match read_body_limited(body).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let snapshot = value.get("snapshot").cloned().unwrap_or(value);
    if snapshot.get("publicationId").and_then(Value::as_str) != Some(id.as_str()) {
        // A snapshot for another publication is a client bug, not a conflict.
        if snapshot.get("publicationId").is_some() {
            return bad_request("That snapshot is for a different publication.");
        }
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    if guard.publication_id().as_deref() != Some(id.as_str()) && guard.publication_id().is_some() {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    match guard.put_snapshot(&token, snapshot) {
        Ok((revision, is_final)) => {
            let event = guard.events_after(revision - 1, 1).into_iter().next();
            if let Some(event) = event {
                let _ = state.events.send(event);
            }
            ok_json(json!({ "publicationId": id, "revision": revision, "final": is_final }))
        }
        Err(error) => error_json(error),
    }
}

async fn post_sections(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let value = match read_body_limited(body).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (Some(base_revision), Some(revision), Some(generated_at), Some(sections)) = (
        value.get("baseRevision").and_then(Value::as_i64),
        value.get("revision").and_then(Value::as_i64),
        value
            .get("generatedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        value.get("sections").cloned(),
    ) else {
        return bad_request("`baseRevision` and `revision` are required.");
    };
    if guard_publication_mismatch(&state, &id).await {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    match guard.post_sections(&token, base_revision, revision, &generated_at, sections) {
        Ok(revision) => {
            if let Some(event) = guard.events_after(revision - 1, 1).into_iter().next() {
                let _ = state.events.send(event);
            }
            ok_json(json!({ "publicationId": id, "revision": revision, "final": false }))
        }
        Err(error) => error_json(error),
    }
}

async fn guard_publication_mismatch(state: &AppState, id: &str) -> bool {
    state.storage.read().await.publication_id().as_deref() != Some(id)
}

async fn post_announcement(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let value = match read_body_limited(body).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (Some(revision), Some(announcement)) = (
        value.get("revision").and_then(Value::as_i64),
        value.get("announcement").cloned(),
    ) else {
        return bad_request("A revision and an announcement are required.");
    };
    if guard_publication_mismatch(&state, &id).await {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    match guard.post_announcement(&token, revision, announcement) {
        Ok(revision) => {
            if let Some(event) = guard.events_after(revision - 1, 1).into_iter().next() {
                let _ = state.events.send(event);
            }
            ok_json(json!({ "publicationId": id, "revision": revision, "final": false }))
        }
        Err(error) => error_json(error),
    }
}

async fn finalize(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    let value = match read_body_limited(body).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (Some(revision), Some(snapshot)) = (
        value.get("revision").and_then(Value::as_i64),
        value.get("snapshot").cloned(),
    ) else {
        return bad_request("A revision and a snapshot are required.");
    };
    if guard_publication_mismatch(&state, &id).await {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    match guard.finalize(&token, revision, snapshot) {
        Ok(revision) => {
            ok_json(json!({ "publicationId": id, "revision": revision, "final": true }))
        }
        Err(error) => error_json(error),
    }
}

async fn unpublish(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    if guard_publication_mismatch(&state, &id).await {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    match guard.unpublish(&token) {
        Ok(revision) => {
            ok_json(json!({ "publicationId": id, "revision": revision, "final": false }))
        }
        Err(error) => error_json(error),
    }
}

async fn destroy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(response) = require_id_format(&id) {
        return response;
    }
    if guard_publication_mismatch(&state, &id).await {
        return error_json(StorageError::NotFound("No such tournament.".to_owned()));
    }
    let token = bearer_token(&headers);
    let mut guard = state.storage.write().await;
    match guard.destroy(&token) {
        Ok(()) => ok_json(json!({ "publicationId": id, "revision": 0, "final": false })),
        Err(error) => error_json(error),
    }
}
