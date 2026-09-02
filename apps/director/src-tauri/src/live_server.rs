//! QBSheet Live over the local network, with no internet.
//!
//! # Why this exists
//!
//! A gym with no usable WiFi uplink is an ordinary tournament venue. Director is already on that
//! network serving QBTCP to the scoring devices; serving the public projection alongside it costs
//! one more listener and gives every phone in the building a schedule, standings, and results.
//!
//! # What it is not
//!
//! It is not the QBTCP server, and its routes are not on the QBTCP port. QBTCP is private
//! operational infrastructure with pairing codes and session tokens in it; QBLive is a public
//! read-only surface. Two listeners rather than one router is the cheapest way to make "a spectator
//! reached a QBTCP route" impossible rather than merely unlikely.
//!
//! The App Clip cannot be invoked offline — the association lookup needs the internet — so local
//! mode is web-only, and Director says so rather than printing a QR that will not work. See
//! `docs/QBLIVE.md#14-local-only-mode`.

use std::collections::VecDeque;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;

/// How many superseded revisions to keep for replay.
///
/// Smaller than the Cloudflare backend's window on purpose: local mode runs in one building where a
/// client that falls behind can simply refetch the snapshot over a fast local link, and Director's
/// memory is a tournament laptop's rather than a data centre's.
const REPLAY_WINDOW: usize = 64;

/// A production-built, self-contained Live Web application.
///
/// The bundle is checked in so native-only builds never need Node, and regenerated with
/// `npm run live:bundle-local` whenever Live Web changes. It contains no remote assets or URLs.
const LIVE_WEB_HTML: &str = include_str!("../assets/live-web.html");
const LIVE_WEB_JS: &[u8] = include_bytes!("../assets/live-web/app.js");
const LIVE_WEB_CSS: &[u8] = include_bytes!("../assets/live-web/styles.css");

/// Shared verbatim with Director's TypeScript projection.
const LOCAL_CAPABILITIES_JSON: &str =
    include_str!("../../../../packages/qblive-protocol/src/local-capabilities.json");

#[derive(Debug, thiserror::Error)]
pub enum LiveServerError {
    #[error("the QBSheet Live local server is already running")]
    AlreadyRunning,
    #[error("could not bind the QBSheet Live listener: {0}")]
    Bind(#[source] std::io::Error),
    #[error("the QBSheet Live local server is unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveServerStatus {
    pub running: bool,
    pub address: Option<String>,
    pub port: Option<u16>,
    pub publication_id: Option<String>,
    /// The URL to put on a printed page. Web only; the App Clip needs the internet.
    pub public_url: Option<String>,
    pub revision: i64,
}

/// The published state, as the local server holds it.
///
/// Only ever written by Director's own publication path, and only ever read by spectators. There is
/// no management API here at all: locally, Director *is* the management API, and exposing one would
/// be an authenticated surface with nothing to authenticate against.
#[derive(Default)]
struct Published {
    publication_id: Option<String>,
    gone_publication_id: Option<String>,
    revision: i64,
    snapshot: Option<Value>,
    events: VecDeque<Value>,
}

#[derive(Default)]
pub struct LiveServerRuntime {
    published: Arc<RwLock<Published>>,
    inner: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    running: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
    address: Option<String>,
    port: u16,
}

impl LiveServerRuntime {
    pub fn status(&self) -> LiveServerStatus {
        let published = self.published.read().ok();
        let publication_id = published.as_ref().and_then(|p| p.publication_id.clone());
        let revision = published.as_ref().map(|p| p.revision).unwrap_or(0);
        let Ok(inner) = self.inner.lock() else {
            return LiveServerStatus::default();
        };
        match inner.as_ref() {
            Some(server) if server.running.load(Ordering::Acquire) => LiveServerStatus {
                running: true,
                address: server.address.clone(),
                port: Some(server.port),
                public_url: match (&server.address, &publication_id) {
                    (Some(address), Some(id)) => {
                        Some(format!("http://{address}:{}/live/{id}", server.port))
                    }
                    _ => None,
                },
                publication_id,
                revision,
            },
            _ => LiveServerStatus {
                publication_id,
                revision,
                ..LiveServerStatus::default()
            },
        }
    }

    /// Replace the published state.
    ///
    /// Called by Director's publication worker with the same sanitized snapshot it would send to a
    /// remote backend. The projection has already happened; nothing here inspects the tournament.
    pub fn publish(&self, snapshot: Value) {
        let Ok(mut published) = self.published.write() else {
            return;
        };
        let revision = snapshot
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or(published.revision + 1);
        let publication_id = snapshot
            .get("publicationId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        published.events.push_back(json!({
            "revision": revision,
            "generatedAt": snapshot.get("generatedAt").cloned().unwrap_or(Value::Null),
            "sections": sections_of(&snapshot),
        }));
        while published.events.len() > REPLAY_WINDOW {
            published.events.pop_front();
        }
        published.revision = revision;
        published.publication_id = publication_id;
        published.gone_publication_id = None;
        published.snapshot = Some(snapshot);
    }

    /// Remove the current public document without crossing into QBTCP state.
    pub fn clear(&self, remember_as_gone: bool) -> Result<LiveServerStatus, LiveServerError> {
        let mut published = self
            .published
            .write()
            .map_err(|_| LiveServerError::Unavailable)?;
        let previous = published.publication_id.take();
        published.gone_publication_id = remember_as_gone.then_some(previous).flatten();
        published.revision = 0;
        published.snapshot = None;
        published.events.clear();
        drop(published);
        Ok(self.status())
    }

    pub async fn start(&self, requested_port: u16) -> Result<LiveServerStatus, LiveServerError> {
        self.start_with_address(requested_port, None).await
    }

    async fn start_with_address(
        &self,
        requested_port: u16,
        address_override: Option<String>,
    ) -> Result<LiveServerStatus, LiveServerError> {
        if self.status().running {
            return Err(LiveServerError::AlreadyRunning);
        }
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, requested_port))
            .await
            .map_err(LiveServerError::Bind)?;
        let port = listener.local_addr().map_err(LiveServerError::Bind)?.port();
        let router = router(Arc::clone(&self.published));
        let running = Arc::new(AtomicBool::new(true));
        let task_running = Arc::clone(&running);
        let handle = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router).await;
            task_running.store(false, Ordering::Release);
        });

        let address = address_override.or_else(crate::server::detect_lan_address);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| LiveServerError::Unavailable)?;
        *inner = Some(RunningServer {
            running,
            handle,
            address,
            port,
        });
        drop(inner);
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<LiveServerStatus, LiveServerError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| LiveServerError::Unavailable)?;
        if let Some(server) = inner.take() {
            server.running.store(false, Ordering::Release);
            server.handle.abort();
        }
        drop(inner);
        Ok(self.status())
    }
}

fn sections_of(snapshot: &Value) -> Value {
    const SECTIONS: &[&str] = &[
        "tournament",
        "teams",
        "rooms",
        "timeline",
        "schedule",
        "results",
        "liveGames",
        "standings",
        "statistics",
        "announcements",
    ];
    let mut sections = serde_json::Map::new();
    for name in SECTIONS {
        if let Some(value) = snapshot.get(*name) {
            sections.insert((*name).to_owned(), value.clone());
        }
    }
    Value::Object(sections)
}

type Shared = Arc<RwLock<Published>>;

fn router(published: Shared) -> Router {
    Router::new()
        .route("/live/{publication_id}", get(live_web))
        .route("/live/{publication_id}/assets/{asset}", get(live_asset))
        .route("/live/{publication_id}/{*path}", get(live_web_fallback))
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
        .route("/health", get(health))
        .with_state(published)
}

async fn live_web(State(published): State<Shared>, Path(id): Path<String>) -> Response {
    if let Err(response) = require(&published, &id) {
        return *response;
    }
    let publication_id = serde_json::to_string(&id).unwrap_or_else(|_| "null".to_owned());
    let bootstrap = format!(
        "<script>window.__QBSHEET_LIVE_LOCAL__={{publicationId:{publication_id},backendOrigin:window.location.origin}};</script>"
    );
    let html = LIVE_WEB_HTML
        .replace("<!--QBSHEET_LOCAL_BASE-->", &format!("/live/{id}/"))
        .replace("<!--QBSHEET_LOCAL_BOOTSTRAP-->", &bootstrap);
    let mut response = Html(html).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn live_web_fallback(
    State(published): State<Shared>,
    Path((id, _path)): Path<(String, String)>,
) -> Response {
    live_web(State(published), Path(id)).await
}

async fn live_asset(
    State(published): State<Shared>,
    Path((id, asset)): Path<(String, String)>,
) -> Response {
    if let Err(response) = require(&published, &id) {
        return *response;
    }
    let (bytes, content_type): (&'static [u8], &'static str) = match asset.as_str() {
        "app.js" => (LIVE_WEB_JS, "text/javascript; charset=utf-8"),
        "styles.css" => (LIVE_WEB_CSS, "text/css; charset=utf-8"),
        _ => return error_json(StatusCode::NOT_FOUND, "not-found", "No such Live asset."),
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

/// CORS for every response.
///
/// `*`, because this is public tournament data read by browsers on a network where nobody knows
/// what origin the Live Web client was served from — it may be a Director-hosted copy, a cached
/// one, or a phone that kept a tab open. No credentials are honoured, so there is nothing a
/// cross-origin read can learn that a direct read could not.
fn ok_json(value: Value) -> Response {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

fn error_json(status: StatusCode, code: &str, message: &str) -> Response {
    let mut response = (status, Json(json!({ "error": code, "message": message }))).into_response();
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

async fn health() -> Response {
    ok_json(json!({ "service": "qblive", "protocolVersion": 1 }))
}

/// Read the published state for a publication id, or the QBLive error to return instead.
///
/// The error side is a boxed `Response` because an axum `Response` is large and this `Result` is
/// returned from every handler; an unboxed one makes the success path pay for the failure path's
/// size on every request.
fn require(published: &Shared, publication_id: &str) -> Result<Value, Box<Response>> {
    let refuse =
        |status: StatusCode, code: &str, message: &str| Box::new(error_json(status, code, message));
    if !crate::live::is_publication_id(publication_id) {
        return Err(refuse(
            StatusCode::NOT_FOUND,
            "not-found",
            "No such tournament.",
        ));
    }
    let guard = published.read().map_err(|_| {
        refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Unavailable.",
        )
    })?;
    if guard.publication_id.as_deref() != Some(publication_id) {
        if guard.gone_publication_id.as_deref() == Some(publication_id) {
            return Err(refuse(
                StatusCode::GONE,
                "gone",
                "This tournament is no longer published.",
            ));
        }
        return Err(refuse(
            StatusCode::NOT_FOUND,
            "not-found",
            "No such tournament.",
        ));
    }
    guard.snapshot.clone().ok_or_else(|| {
        refuse(
            StatusCode::NOT_FOUND,
            "not-found",
            "This tournament has not published yet.",
        )
    })
}

async fn manifest(State(published): State<Shared>, Path(id): Path<String>) -> Response {
    let snapshot = match require(&published, &id) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let base = format!("/qblive/v1/tournaments/{id}");
    let capabilities: Value = serde_json::from_str(LOCAL_CAPABILITIES_JSON)
        .expect("local QBLive capabilities must be valid JSON");
    ok_json(json!({
        "protocolVersion": 1,
        "publicationId": id,
        "revision": snapshot.get("revision").cloned().unwrap_or(json!(0)),
        "generatedAt": snapshot.get("generatedAt").cloned().unwrap_or(Value::Null),
        "tournament": snapshot.get("tournament").cloned().unwrap_or(Value::Null),
        "capabilities": capabilities,
        "endpoints": {
            "snapshot": format!("{base}/snapshot"),
            "events": format!("{base}/events")
        },
        "final": snapshot.get("final").cloned().unwrap_or(json!(false))
    }))
}

async fn snapshot(State(published): State<Shared>, Path(id): Path<String>) -> Response {
    match require(&published, &id) {
        Ok(value) => ok_json(value),
        Err(response) => *response,
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    after: Option<i64>,
    limit: Option<usize>,
}

async fn events(
    State(published): State<Shared>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Response {
    if let Err(response) = require(&published, &id) {
        return *response;
    }
    let after = query.after.unwrap_or(0);
    if after < 0 {
        return error_json(
            StatusCode::BAD_REQUEST,
            "bad-request",
            "`after` must be a non-negative integer.",
        );
    }
    let limit = query.limit.unwrap_or(64).clamp(1, 256);
    let Ok(guard) = published.read() else {
        return error_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "Unavailable.",
        );
    };
    let oldest = guard
        .events
        .front()
        .and_then(|event| event.get("revision").and_then(Value::as_i64));
    // A client asking from before the window cannot be caught up by any page we could send, and a
    // short page would look to it like being caught up. Say so instead.
    let resync_required = after < guard.revision && oldest.is_some_and(|oldest| after < oldest - 1);
    let events: Vec<Value> = if resync_required {
        vec![]
    } else {
        guard
            .events
            .iter()
            .filter(|event| {
                event
                    .get("revision")
                    .and_then(Value::as_i64)
                    .is_some_and(|revision| revision > after)
            })
            .take(limit)
            .cloned()
            .collect()
    };
    ok_json(json!({
        "protocolVersion": 1,
        "publicationId": id,
        "currentRevision": guard.revision,
        "events": events,
        "resyncRequired": resync_required
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    const PUBLICATION: &str = "bcdfghjkmnpqrstvwxyz";

    fn snapshot_at(revision: i64) -> Value {
        json!({
            "protocolVersion": 1,
            "publicationId": PUBLICATION,
            "revision": revision,
            "generatedAt": "2026-09-05T14:30:00Z",
            "capabilities": { "snapshot": true, "events": true, "stream": false, "applePush": false },
            "final": false,
            "tournament": { "id": "t", "name": "Saturday Invitational", "date": null, "venue": null,
                            "organizer": null, "timeZone": "America/New_York", "status": "in-progress" },
            "teams": [], "rooms": [], "timeline": [], "schedule": [], "results": [],
            "liveGames": [], "standings": [], "statistics": [], "announcements": []
        })
    }

    async fn get(runtime: &LiveServerRuntime, path: &str) -> (StatusCode, Value) {
        let app = router(Arc::clone(&runtime.published));
        let response = app
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .expect("response");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn serves_the_published_snapshot_and_manifest() {
        let runtime = LiveServerRuntime::default();
        runtime.publish(snapshot_at(1));

        let (status, manifest) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/manifest"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(manifest["revision"], 1);
        // Local mode advertises no stream: Director's laptop is running a tournament, not a
        // socket server.
        assert_eq!(manifest["capabilities"]["stream"], false);
        assert_eq!(
            manifest["capabilities"],
            serde_json::from_str::<Value>(LOCAL_CAPABILITIES_JSON).unwrap()
        );

        let (status, snapshot) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(snapshot["tournament"]["name"], "Saturday Invitational");
    }

    #[tokio::test]
    async fn returned_public_url_serves_offline_live_web_and_local_api() {
        let runtime = LiveServerRuntime::default();
        let started = runtime
            .start_with_address(0, Some("127.0.0.1".to_owned()))
            .await
            .expect("start local QBLive server");
        assert!(started.running);
        runtime.publish(snapshot_at(1));
        let status = runtime.status();
        let public_url = status.public_url.expect("exact Director public URL");

        let page = reqwest::get(&public_url).await.expect("GET public URL");
        assert_eq!(page.status(), reqwest::StatusCode::OK);
        let html = page.text().await.expect("Live Web HTML");
        assert!(html.contains("qbsheet-live-local-bundle"));
        assert!(html.contains("__QBSHEET_LIVE_LOCAL__"));
        assert!(html.contains(PUBLICATION));
        assert!(html.contains(&format!("<base href=\"/live/{PUBLICATION}/\">")));
        assert!(html.contains("backendOrigin:window.location.origin"));
        assert!(html.contains("<script type=\"module\" src=\"./assets/app.js\"></script>"));
        assert!(html.contains("<link rel=\"stylesheet\" href=\"./assets/styles.css\">"));

        let origin = format!(
            "http://{}:{}",
            status.address.expect("address"),
            status.port.expect("port")
        );
        for path in ["manifest", "snapshot", "events?after=0"] {
            let response = reqwest::get(format!(
                "{origin}/qblive/v1/tournaments/{PUBLICATION}/{path}"
            ))
            .await
            .expect("local API request");
            assert_eq!(response.status(), reqwest::StatusCode::OK, "{path}");
        }
        let javascript = reqwest::get(format!("{origin}/live/{PUBLICATION}/assets/app.js"))
            .await
            .expect("local JavaScript asset");
        assert_eq!(javascript.status(), reqwest::StatusCode::OK);
        assert_eq!(
            javascript.headers()[reqwest::header::CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        assert!(javascript
            .text()
            .await
            .expect("JavaScript body")
            .contains("QBSheet Live"));
        let stylesheet = reqwest::get(format!("{origin}/live/{PUBLICATION}/assets/styles.css"))
            .await
            .expect("local stylesheet asset");
        assert_eq!(stylesheet.status(), reqwest::StatusCode::OK);
        assert_eq!(
            stylesheet.headers()[reqwest::header::CONTENT_TYPE],
            "text/css; charset=utf-8"
        );
        let deep_link = reqwest::get(format!("{origin}/live/{PUBLICATION}/standings"))
            .await
            .expect("local Live deep link");
        assert_eq!(deep_link.status(), reqwest::StatusCode::OK);
        assert!(deep_link
            .text()
            .await
            .expect("deep link body")
            .contains("qbsheet-live-local-bundle"));
        let unknown_asset = reqwest::get(format!("{origin}/live/{PUBLICATION}/assets/secret.txt"))
            .await
            .expect("unknown local asset");
        assert_eq!(unknown_asset.status(), reqwest::StatusCode::NOT_FOUND);
        runtime.stop().expect("stop server");
    }

    #[tokio::test]
    async fn clearing_a_publication_returns_gone_without_stopping_qbtcp_or_live_listener() {
        let runtime = LiveServerRuntime::default();
        runtime.publish(snapshot_at(1));
        runtime.clear(true).expect("clear");
        let (status, body) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"),
        )
        .await;
        assert_eq!(status, StatusCode::GONE);
        assert_eq!(body["error"], "gone");
    }

    #[tokio::test]
    async fn a_publication_that_has_not_published_is_not_found() {
        let runtime = LiveServerRuntime::default();
        let (status, body) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "not-found");
    }

    #[tokio::test]
    async fn a_forged_publication_id_is_refused() {
        let runtime = LiveServerRuntime::default();
        runtime.publish(snapshot_at(1));
        for forged in ["AEIOU", "short", "aeiouaeiouaeiouaeiou"] {
            let (status, _) = get(
                &runtime,
                &format!("/qblive/v1/tournaments/{forged}/snapshot"),
            )
            .await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{forged}");
        }
    }

    #[tokio::test]
    async fn replay_returns_events_after_a_revision() {
        let runtime = LiveServerRuntime::default();
        for revision in 1..=4 {
            runtime.publish(snapshot_at(revision));
        }
        let (status, page) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/events?after=1"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["currentRevision"], 4);
        assert_eq!(page["resyncRequired"], false);
        let revisions: Vec<i64> = page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["revision"].as_i64().unwrap())
            .collect();
        assert_eq!(revisions, vec![2, 3, 4]);
    }

    #[tokio::test]
    async fn replay_admits_when_it_cannot_help() {
        let runtime = LiveServerRuntime::default();
        for revision in 1..=(REPLAY_WINDOW as i64 + 10) {
            runtime.publish(snapshot_at(revision));
        }
        let (_, page) = get(
            &runtime,
            &format!("/qblive/v1/tournaments/{PUBLICATION}/events?after=1"),
        )
        .await;
        assert_eq!(page["resyncRequired"], true);
        assert!(page["events"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn there_is_no_management_surface_at_all() {
        // Locally, Director *is* the management API. A write route here would be an authenticated
        // surface with nothing to authenticate against.
        let runtime = LiveServerRuntime::default();
        runtime.publish(snapshot_at(1));
        let app = router(Arc::clone(&runtime.published));
        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!(
                        "/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"
                    ))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn every_response_allows_cross_origin_reads() {
        let runtime = LiveServerRuntime::default();
        runtime.publish(snapshot_at(1));
        let app = router(Arc::clone(&runtime.published));
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("response");
        assert_eq!(
            response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .map(|value| value.to_str().unwrap()),
            Some("*")
        );
    }
}
