use axum::body::{to_bytes, Body};
use axum::http::{HeaderMap, Method, Request, StatusCode};
use qbtcp_server::{
    AssignedAssignment, AssignmentMeta, AssignmentState, MemoryState, QbtcpConfig, QbtcpServer,
    RoomInfo, TournamentInfo, DEVICE_ID_HEADER, OPERATOR_NAME_HEADER, QBTCP_PREFIX,
    ROOM_TOKEN_HEADER, SESSION_TOKEN_HEADER,
};
use serde_json::{json, Value};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tower::ServiceExt;

fn fixture() -> (Arc<QbtcpServer>, Arc<MemoryState>) {
    let state = Arc::new(MemoryState::new(
        TournamentInfo {
            id: "tournament-1".to_owned(),
            name: "Contract Tournament".to_owned(),
            qbj_version: "2.1.1".to_owned(),
        },
        vec![RoomInfo {
            id: "room-1".to_owned(),
            name: "Room 1".to_owned(),
            description: Some("North wing".to_owned()),
            enabled: true,
        }],
    ));
    state.set_assignment(
        "room-1",
        AssignmentState::Assigned(AssignedAssignment {
            match_id: "match-1".to_owned(),
            qbj: assignment_qbj(),
            round_number: 1,
            round_name: Some("Round 1".to_owned()),
            left_team: Some("Northview A".to_owned()),
            right_team: Some("Riverside A".to_owned()),
            label: Some("Round 1 · Northview A vs Riverside A".to_owned()),
            meta: AssignmentMeta {
                round_revision: Some(1),
                assignment_revision: Some(1),
                next: Some(qbtcp_server::AssignmentLabel {
                    label: "Round 2".to_owned(),
                }),
                released_round: Some(1),
                ..AssignmentMeta::default()
            },
        }),
    );

    let mut config = QbtcpConfig {
        allowed_origins: vec!["https://qbsheet.com".to_owned()],
        pairing_rate_limit: qbtcp_server::PairingRateLimit {
            max_attempts: 16,
            window: Duration::from_secs(60),
        },
        ..QbtcpConfig::default()
    };
    config.name = "Contract Server".to_owned();
    let server = Arc::new(QbtcpServer::new(state.clone(), config).unwrap());
    (server, state)
}

fn assignment_qbj() -> Value {
    json!({
        "version": "2.1.1",
        "objects": [
            {"type": "Tournament", "id": "tournament-1", "name": "Contract Tournament"},
            {"type": "Round", "id": "round-1", "name": "1"},
            {
                "type": "Match",
                "id": "match-1",
                "location": "Room 1",
                "_qbtcp": {"version": 1, "round_revision": 1, "assignment_revision": 1},
                "match_teams": [{"team": {"name": "Northview A"}}, {"team": {"name": "Riverside A"}}]
            }
        ]
    })
}

fn result_qbj(left_points: u64, extra_transport: bool) -> Value {
    let mut value = json!({
        "version": "2.1.1",
        "objects": [
            {"type": "Tournament", "id": "tournament-1", "name": "Contract Tournament"},
            {"type": "Match", "id": "match-1", "match_teams": [
                {"team": {"name": "Northview A"}, "points": left_points},
                {"team": {"name": "Riverside A"}, "points": 80}
            ]}
        ]
    });
    if extra_transport {
        value["objects"][1]["_qbtcp"] = json!({
            "version": 1,
            "round_revision": 1,
            "assignment_revision": 9,
            "room_id": "room-1"
        });
        value["_qbsheet_source"] = json!({"server_url": "must-not-affect-fingerprint"});
    }
    value
}

async fn request(
    server: &Arc<QbtcpServer>,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Vec<u8>>,
) -> (StatusCode, HeaderMap, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let request = builder.body(Body::from(body.unwrap_or_default())).unwrap();
    let response = server.router().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}))
    };
    (status, headers, value)
}

async fn pair(server: &Arc<QbtcpServer>, source: &str) -> (String, String) {
    let invitation = server.issue_pairing("room-1").unwrap();
    let body = serde_json::to_vec(&json!({"code": invitation.code, "roomId": "room-1"})).unwrap();
    let (status, _, value) = request(
        server,
        Method::POST,
        "/qbtcp/v1/pair",
        &[
            ("x-forwarded-for", source),
            ("content-type", "application/json"),
        ],
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (
        value["roomId"].as_str().unwrap().to_owned(),
        value["token"].as_str().unwrap().to_owned(),
    )
}

async fn open_session(
    server: &Arc<QbtcpServer>,
    room_token: &str,
    device: &str,
) -> (String, String, bool) {
    let body = serde_json::to_vec(&json!({"match_id": "match-1", "device_id": device})).unwrap();
    let (status, _, value) = request(
        server,
        Method::POST,
        "/qbtcp/v1/sessions",
        &[
            (ROOM_TOKEN_HEADER, room_token),
            ("content-type", "application/json"),
        ],
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (
        value["session_id"].as_str().unwrap().to_owned(),
        value["token"].as_str().unwrap().to_owned(),
        value["writer"].as_bool().unwrap(),
    )
}

#[tokio::test]
async fn discovery_health_capabilities_and_cors_are_explicit() {
    let (server, _) = fixture();
    let (status, headers, discovery) = request(
        &server,
        Method::GET,
        QBTCP_PREFIX,
        &[("origin", "https://qbsheet.com")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(discovery["protocol"], "QBTCP");
    assert_eq!(discovery["version"], 1);
    assert!(discovery["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "progress"));
    assert_eq!(
        headers.get("access-control-allow-origin").unwrap(),
        "https://qbsheet.com"
    );

    let (status, headers, _) = request(
        &server,
        Method::OPTIONS,
        "/qbtcp/v1/assignment",
        &[
            ("origin", "https://qbsheet.com"),
            ("access-control-request-private-network", "true"),
        ],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        headers.get("access-control-allow-private-network").unwrap(),
        "true"
    );
    assert!(headers
        .get("access-control-allow-headers")
        .unwrap()
        .to_str()
        .unwrap()
        .contains(ROOM_TOKEN_HEADER));

    let (status, _, _) = request(
        &server,
        Method::OPTIONS,
        "/qbtcp/v1/assignment",
        &[("origin", "https://not-approved.example")],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, health) = request(&server, Method::GET, "/qbtcp/v1/health", &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["ok"], true);
}

#[tokio::test]
async fn pairing_is_uniform_and_tokens_scope_assignment() {
    let (server, _) = fixture();
    let invitation = server.issue_pairing("room-1").unwrap();
    let valid_body =
        serde_json::to_vec(&json!({"code": invitation.code, "roomId": "room-1"})).unwrap();
    let (bad_status, _, bad) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/pair",
        &[
            ("x-forwarded-for", "bad-one"),
            ("content-type", "application/json"),
        ],
        Some(serde_json::to_vec(&json!({"code": "not-a-code"})).unwrap()),
    )
    .await;
    let (mismatch_status, _, mismatch) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/pair",
        &[
            ("x-forwarded-for", "bad-two"),
            ("content-type", "application/json"),
        ],
        Some(serde_json::to_vec(&json!({"code": "12345678", "roomId": "wrong-room"})).unwrap()),
    )
    .await;
    assert_eq!(bad_status, StatusCode::UNAUTHORIZED);
    assert_eq!(mismatch_status, StatusCode::UNAUTHORIZED);
    assert_eq!(bad, mismatch);

    let (status, _, paired) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/pair",
        &[
            ("x-forwarded-for", "valid"),
            ("content-type", "application/json"),
        ],
        Some(valid_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = paired["token"].as_str().unwrap();
    let (missing_status, _, missing) =
        request(&server, Method::GET, "/qbtcp/v1/assignment", &[], None).await;
    let (invalid_status, _, invalid) = request(
        &server,
        Method::GET,
        "/qbtcp/v1/assignment",
        &[(ROOM_TOKEN_HEADER, "invalid")],
        None,
    )
    .await;
    assert_eq!(missing_status, StatusCode::UNAUTHORIZED);
    assert_eq!(invalid_status, StatusCode::UNAUTHORIZED);
    assert_eq!(missing, invalid);

    let (status, headers, assignment) = request(
        &server,
        Method::GET,
        "/qbtcp/v1/assignment",
        &[(ROOM_TOKEN_HEADER, token)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with(qbtcp_server::QBJ_MEDIA_TYPE));
    assert_eq!(assignment["objects"][2]["id"], "match-1");
}

#[tokio::test]
async fn sessions_progress_writer_conflicts_takeover_and_recovery_work() {
    let (server, state) = fixture();
    let (_, room_token) = pair(&server, "room-source").await;
    let (session_id, first_token, first_writer) =
        open_session(&server, &room_token, "device-a").await;
    assert!(first_writer);
    let (_, second_token, second_writer) = open_session(&server, &room_token, "device-b").await;
    assert!(!second_writer);
    assert_ne!(first_token, second_token);

    let progress = serde_json::to_vec(
        &json!({"sequence": 7, "match": {"type": "Match", "id": "match-1", "points": 100}}),
    )
    .unwrap();
    let (status, _, _) = request(
        &server,
        Method::PUT,
        &format!("/qbtcp/v1/sessions/{session_id}/progress"),
        &[
            (SESSION_TOKEN_HEADER, &first_token),
            ("content-type", "application/json"),
        ],
        Some(progress.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state.progress(&session_id).unwrap().sequence, 7);

    let (status, _, conflict) = request(
        &server,
        Method::PUT,
        &format!("/qbtcp/v1/sessions/{session_id}/progress"),
        &[
            (SESSION_TOKEN_HEADER, &second_token),
            ("content-type", "application/json"),
        ],
        Some(progress),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["can_take_over"], true);

    let takeover =
        serde_json::to_vec(&json!({"device_id": "device-b", "take_over": true})).unwrap();
    let (status, _, value) = request(
        &server,
        Method::POST,
        &format!("/qbtcp/v1/sessions/{session_id}/writer"),
        &[
            (SESSION_TOKEN_HEADER, &second_token),
            ("content-type", "application/json"),
        ],
        Some(takeover),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["writer"], true);

    let (status, _, _) = request(
        &server,
        Method::PUT,
        &format!("/qbtcp/v1/sessions/{session_id}/progress"),
        &[
            (SESSION_TOKEN_HEADER, &first_token),
            ("content-type", "application/json"),
        ],
        Some(
            serde_json::to_vec(
                &json!({"sequence": 8, "match": {"type": "Match", "id": "match-1"}}),
            )
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, _, recovery) = request(
        &server,
        Method::GET,
        &format!("/qbtcp/v1/sessions/{session_id}/recovery"),
        &[(SESSION_TOKEN_HEADER, &second_token)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recovery["session_id"], session_id);
    assert_eq!(recovery["latest_qbj"]["id"], "match-1");
    assert_eq!(recovery["status"], "open");
}

#[tokio::test]
async fn results_are_retained_idempotent_and_conflicts_are_reviewable() {
    let (server, state) = fixture();
    let (_, room_token) = pair(&server, "result-source").await;
    let (session_id, token, _) = open_session(&server, &room_token, "device-result").await;
    let first = result_qbj(100, false);
    let first_raw = serde_json::to_vec(&first).unwrap();
    let path = format!("/qbtcp/v1/sessions/{session_id}/result");
    let (status, _, receipt) = request(
        &server,
        Method::POST,
        &path,
        &[
            (SESSION_TOKEN_HEADER, &token),
            ("content-type", qbtcp_server::QBJ_MEDIA_TYPE),
        ],
        Some(first_raw.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt["received"], true);
    assert_eq!(receipt["review_required"], false);
    assert_eq!(receipt["duplicate"], false);
    assert_eq!(state.result_summaries().len(), 1);
    assert_eq!(
        state
            .raw_result(receipt["result_id"].as_str().unwrap())
            .unwrap(),
        first_raw
    );

    let (status, _, duplicate) = request(
        &server,
        Method::POST,
        &path,
        &[
            (SESSION_TOKEN_HEADER, &token),
            ("content-type", qbtcp_server::QBJ_MEDIA_TYPE),
        ],
        Some(serde_json::to_vec(&result_qbj(100, true)).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(state.result_summaries().len(), 1);

    let (status, _, conflict) = request(
        &server,
        Method::POST,
        &path,
        &[
            (SESSION_TOKEN_HEADER, &token),
            ("content-type", qbtcp_server::QBJ_MEDIA_TYPE),
        ],
        Some(serde_json::to_vec(&result_qbj(110, false)).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(conflict["duplicate"], false);
    assert_eq!(conflict["review_required"], true);
    assert_eq!(conflict["conflict"], true);
    assert!(conflict["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning == "result-conflict"));
    assert_eq!(state.result_summaries().len(), 2);
    assert!(state
        .result_summaries()
        .iter()
        .any(|result| result.conflict_with.is_some()));

    let (status, _, invalid) = request(
        &server,
        Method::POST,
        &path,
        &[
            (SESSION_TOKEN_HEADER, &token),
            ("content-type", "application/json"),
        ],
        Some(serde_json::to_vec(&json!({"not": "a QBJ"})).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid["code"], "invalid_request");
}

#[tokio::test]
async fn presence_help_and_roster_amendments_are_scoped_and_persisted() {
    let (server, state) = fixture();
    let (_, room_token) = pair(&server, "ops-source").await;
    let (session_id, session_token, _) = open_session(&server, &room_token, "device-ops").await;

    let (status, _, presence) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/presence",
        &[
            (ROOM_TOKEN_HEADER, &room_token),
            (DEVICE_ID_HEADER, "device-ops"),
            (OPERATOR_NAME_HEADER, "Alex"),
            ("content-type", "application/json"),
        ],
        Some(
            serde_json::to_vec(&json!({
                "ready": true,
                "client": {"name": "QBSheet", "version": "4.2.0"},
                "procedure_versions": [1, 2, 3],
                "qbj_version": "2.1.1"
            }))
            .unwrap(),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(presence["presence"]["ready"], true);
    assert_eq!(
        state.presence("room-1", "device-ops").unwrap().update.ready,
        Some(true)
    );

    let help_body = serde_json::to_vec(&json!({
        "category": "equipment-technical",
        "message": "The buzzer is not responding."
    }))
    .unwrap();
    let help_headers = [
        (ROOM_TOKEN_HEADER, room_token.as_str()),
        (DEVICE_ID_HEADER, "device-ops"),
        (OPERATOR_NAME_HEADER, "Alex"),
        ("content-type", "application/json"),
    ];
    let (status, _, help) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/help",
        &help_headers,
        Some(help_body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let help_id = help["request"]["id"].as_str().unwrap().to_owned();
    assert_eq!(help["request"]["status"], "open");
    let (status, _, same_help) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/help",
        &help_headers,
        Some(help_body),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(same_help["request"]["id"], help_id);
    let (status, _, _) = request(
        &server,
        Method::DELETE,
        &format!("/qbtcp/v1/help/{help_id}"),
        &help_headers[..3],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, idle) = request(
        &server,
        Method::GET,
        "/qbtcp/v1/help",
        &help_headers[..2],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(idle["request"].is_null());

    let roster = serde_json::to_vec(&json!({
        "sessionId": session_id,
        "team_id": "team-1",
        "teamName": "Northview A",
        "playerName": "Jamie Example",
        "question_number": 4
    }))
    .unwrap();
    let (status, _, amendment) = request(
        &server,
        Method::POST,
        "/qbtcp/v1/roster/players",
        &[
            (ROOM_TOKEN_HEADER, &room_token),
            (SESSION_TOKEN_HEADER, &session_token),
            ("content-type", "application/json"),
        ],
        Some(roster),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(amendment["playerName"], "Jamie Example");

    let (status, _, recovery) = request(
        &server,
        Method::GET,
        &format!("/qbtcp/v1/sessions/{session_id}/recovery"),
        &[(SESSION_TOKEN_HEADER, &session_token)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        recovery["roster_amendments"][0]["playerName"],
        "Jamie Example"
    );
}

#[tokio::test]
async fn expiry_abandons_without_deleting_recovery_and_accepts_late_review() {
    let server = fixture_with_timeout(Duration::from_millis(5));
    let (_, room_token) = pair(&server, "expiry-source").await;
    let (session_id, token, _) = open_session(&server, &room_token, "device-expiry").await;
    thread::sleep(Duration::from_millis(20));

    let path = format!("/qbtcp/v1/sessions/{session_id}/recovery");
    let (status, _, recovery) = request(
        &server,
        Method::GET,
        &path,
        &[(SESSION_TOKEN_HEADER, &token)],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recovery["status"], "abandoned");
    assert_eq!(recovery["final_received"], false);

    let result_path = format!("/qbtcp/v1/sessions/{session_id}/result");
    let (status, _, receipt) = request(
        &server,
        Method::POST,
        &result_path,
        &[
            (SESSION_TOKEN_HEADER, &token),
            ("content-type", qbtcp_server::QBJ_MEDIA_TYPE),
        ],
        Some(serde_json::to_vec(&result_qbj(100, false)).unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(receipt["review_required"], true);
    assert!(receipt["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|warning| warning == "late-after-abandon"));
}

#[tokio::test]
async fn advertised_capabilities_gate_requests() {
    let (_, state) = fixture();
    let config = QbtcpConfig {
        capabilities: vec![
            "pairing".to_owned(),
            "assignment".to_owned(),
            "result".to_owned(),
        ],
        ..QbtcpConfig::default()
    };
    let server = Arc::new(QbtcpServer::new(state, config).unwrap());
    let (status, _, discovery) = request(&server, Method::GET, QBTCP_PREFIX, &[], None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!discovery["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "progress"));
}

fn fixture_with_timeout(timeout: Duration) -> Arc<QbtcpServer> {
    let (_, state) = fixture();
    let config = QbtcpConfig {
        session_idle_timeout: timeout,
        ..QbtcpConfig::default()
    };
    Arc::new(QbtcpServer::new(state, config).unwrap())
}
