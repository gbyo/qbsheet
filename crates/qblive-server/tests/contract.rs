//! Observable QBLive behavior over the reference router.
//!
//! The same fixture-driven lifecycle the Cloudflare backend tests cover,
//! exercised against the hosting-neutral core: claim, snapshot, sections,
//! announcements, replay, resync, finalization, unpublish/gone,
//! delete/recreate, auth, validation, and cache headers.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use qblive_server::{routes::AppState, CapabilityProfile};
use serde_json::{json, Value};
use tower::ServiceExt;

const PUBLICATION: &str = "bcdfghjkmnpqrstvwxyz";

fn fixture_snapshot(revision: i64) -> Value {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/qblive-protocol/fixtures/snapshot-default.json"
    ));
    let mut snapshot: Value = serde_json::from_str(raw).expect("fixture");
    snapshot["publicationId"] = json!(PUBLICATION);
    snapshot["revision"] = json!(revision);
    snapshot
}

fn app() -> axum::Router {
    let state = AppState::new(CapabilityProfile::Full);
    // The claim route reads its setup secret from the environment in this
    // reference router; tests set it per process.
    qblive_server::full_router(state)
}

async fn call(
    app: &axum::Router,
    request: Request<Body>,
) -> (StatusCode, Value, axum::http::HeaderMap) {
    let response = app.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 26)
        .await
        .expect("body");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, headers)
}

fn json_request(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string())).expect("body")
}

async fn claim_token(app: &axum::Router) -> String {
    std::env::set_var("QBLIVE_SETUP_TOKEN", "test-setup-token");
    let (status, body, _) = call(
        app,
        json_request(
            "POST",
            "/qblive/v1/manage/claim",
            None,
            json!({ "setupToken": "test-setup-token", "publicationId": PUBLICATION }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["managementToken"].as_str().expect("token").to_owned()
}

#[tokio::test]
async fn full_lifecycle_matches_the_reference_backend() {
    let app = app();
    let token = claim_token(&app).await;

    // First publish serves manifest + snapshot.
    let (status, _, _) = call(
        &app,
        json_request(
            "PUT",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"),
            Some(&token),
            json!({ "snapshot": fixture_snapshot(1) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, manifest, _) = call(
        &app,
        Request::builder()
            .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/manifest"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["revision"], 1);
    assert_eq!(manifest["capabilities"]["stream"], true);

    // Snapshot carries ETag + CORS + no-cache.
    let (status, snapshot, headers) = call(
        &app,
        Request::builder()
            .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["revision"], 1);
    assert_eq!(
        headers
            .get("access-control-allow-origin")
            .map(|v| v.to_str().unwrap()),
        Some("*")
    );
    assert_eq!(
        headers.get("etag").map(|v| v.to_str().unwrap()),
        Some("\"1\"")
    );

    // Partial sections advance and preserve untouched sections.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            Some(&token),
            json!({
                "baseRevision": 1,
                "revision": 2,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "liveGames": [] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Stale base revisions conflict with the current revision.
    let (status, body, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            Some(&token),
            json!({
                "baseRevision": 1,
                "revision": 3,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "liveGames": [] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["currentRevision"], 2);

    // Announcements publish as section updates.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/announcements"),
            Some(&token),
            json!({
                "revision": 3,
                "announcement": {
                    "id": "a1",
                    "title": "Round 3",
                    "body": "Be in your rooms.",
                    "severity": "information",
                    "publishedAt": "2026-09-05T14:00:00-04:00",
                    "updatedAt": null,
                    "expiresAt": null,
                    "audienceTeamIds": [],
                },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Replay serves events after a revision.
    let (status, page, _) = call(
        &app,
        Request::builder()
            .uri(format!(
                "/qblive/v1/tournaments/{PUBLICATION}/events?after=1"
            ))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["currentRevision"], 3);
    assert_eq!(page["resyncRequired"], false);
    assert!(page["events"].as_array().unwrap().len() >= 2);

    // A cursor before the window admits a resync instead of a short page.
    let (status, page, _) = call(
        &app,
        Request::builder()
            .uri(format!(
                "/qblive/v1/tournaments/{PUBLICATION}/events?after=0"
            ))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // With only three revisions retained there is nothing to resync from yet.
    assert_eq!(page["resyncRequired"], false);

    // Finalize freezes the publication but keeps serving it.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/finalize"),
            Some(&token),
            json!({ "revision": 4, "snapshot": fixture_snapshot(4) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, manifest, _) = call(
        &app,
        Request::builder()
            .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/manifest"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["final"], true);

    // Further section updates are refused once final.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            Some(&token),
            json!({
                "baseRevision": 4,
                "revision": 5,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "liveGames": [] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn unpublish_hides_but_keeps_the_credential_valid() {
    let app = app();
    let token = claim_token(&app).await;
    let (status, _, _) = call(
        &app,
        json_request(
            "PUT",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"),
            Some(&token),
            json!({ "snapshot": fixture_snapshot(1) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = call(
        &app,
        Request::builder()
            .method("POST")
            .uri(format!(
                "/qblive/v1/manage/tournaments/{PUBLICATION}/unpublish"
            ))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body, _) = call(
        &app,
        Request::builder()
            .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(body["error"], "gone");

    // Recoverable with the same credential.
    let (status, _, _) = call(
        &app,
        json_request(
            "PUT",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"),
            Some(&token),
            json!({ "snapshot": fixture_snapshot(2) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn delete_revokes_the_credential() {
    let app = app();
    let token = claim_token(&app).await;
    let (status, _, _) = call(
        &app,
        json_request(
            "PUT",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"),
            Some(&token),
            json!({ "snapshot": fixture_snapshot(1) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = call(
        &app,
        Request::builder()
            .method("DELETE")
            .uri(format!("/qblive/v1/manage/tournaments/{PUBLICATION}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = call(
        &app,
        Request::builder()
            .uri(format!("/qblive/v1/tournaments/{PUBLICATION}/snapshot"))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn auth_and_validation_match_the_reference_backend() {
    let app = app();
    let token = claim_token(&app).await;
    let (status, _, _) = call(
        &app,
        json_request(
            "PUT",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"),
            Some(&token),
            json!({ "snapshot": fixture_snapshot(1) }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // No credential.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            None,
            json!({
                "baseRevision": 1,
                "revision": 2,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "liveGames": [] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Wrong credential.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            Some(&"0".repeat(64)),
            json!({
                "baseRevision": 1,
                "revision": 2,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "liveGames": [] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Malformed section.
    let (status, _, _) = call(
        &app,
        json_request(
            "POST",
            &format!("/qblive/v1/manage/tournaments/{PUBLICATION}/sections"),
            Some(&token),
            json!({
                "baseRevision": 1,
                "revision": 2,
                "generatedAt": "2026-09-05T14:31:00.000Z",
                "sections": { "teams": [{ "id": "x" }] },
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Nonsense cursors.
    for cursor in ["-1", "abc"] {
        let (status, _, _) = call(
            &app,
            Request::builder()
                .uri(format!(
                    "/qblive/v1/tournaments/{PUBLICATION}/events?after={cursor}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{cursor}");
    }

    // Forged publication ids never name storage.
    for forged in ["../etc", "AAAA", "aeiouaeiouaeiouaeiou"] {
        let (status, _, _) = call(
            &app,
            Request::builder()
                .uri(format!("/qblive/v1/tournaments/{forged}/snapshot"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{forged}");
    }
}

#[tokio::test]
async fn public_only_composition_exposes_no_management() {
    let state = AppState::new(CapabilityProfile::Local);
    let app = qblive_server::public_router(state);
    let (status, _, _) = call(
        &app,
        Request::builder()
            .method("PUT")
            .uri(format!(
                "/qblive/v1/manage/tournaments/{PUBLICATION}/snapshot"
            ))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
