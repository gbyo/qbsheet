use crate::core::QbtcpServer;
use crate::model::{
    HelpEnvelope, PresenceView, QbtcpError, RosterAmendmentRequest, DEVICE_ID_HEADER,
    OPERATOR_NAME_HEADER, QBTCP_PREFIX, ROOM_TOKEN_HEADER, SESSION_TOKEN_HEADER,
};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

/// Build the canonical QBTCP v1 router.
///
/// The router is deliberately usable without a particular Tauri runtime. A host can mount it in
/// its own listener, or call [`QbtcpServer::serve`] with a Tokio TCP listener.
pub fn router(server: Arc<QbtcpServer>) -> Router {
    Router::new()
        .route("/qbtcp/v1", get(get_discovery))
        .route("/qbtcp/v1/health", get(get_health))
        .route("/qbtcp/v1/tournament", get(get_tournament))
        .route("/qbtcp/v1/rooms", get(get_rooms))
        .route("/qbtcp/v1/pair", post(post_pair))
        .route("/qbtcp/v1/assignment", get(get_assignment))
        .route("/qbtcp/v1/assignment/status", get(get_assignment_status))
        .route("/qbtcp/v1/sessions", post(post_session))
        .route("/qbtcp/v1/sessions/{session_id}", get(get_session))
        .route("/qbtcp/v1/sessions/{session_id}/writer", post(post_writer))
        .route(
            "/qbtcp/v1/sessions/{session_id}/progress",
            put(put_progress),
        )
        .route("/qbtcp/v1/sessions/{session_id}/result", post(post_result))
        .route(
            "/qbtcp/v1/sessions/{session_id}/recovery",
            get(get_recovery),
        )
        .route("/qbtcp/v1/presence", get(get_presence).post(post_presence))
        .route("/qbtcp/v1/help", get(get_help).post(post_help))
        .route("/qbtcp/v1/help/{help_id}", delete(delete_help))
        .route("/qbtcp/v1/roster/players", post(post_roster_player))
        .layer(DefaultBodyLimit::max(server.config.max_body_bytes))
        .layer(middleware::from_fn_with_state(
            Arc::clone(&server),
            cors_and_limits,
        ))
        .with_state(server)
}

async fn get_discovery(State(server): State<Arc<QbtcpServer>>) -> Result<Response, QbtcpError> {
    Ok(json_response(StatusCode::OK, server.discovery()?))
}

async fn get_health(State(server): State<Arc<QbtcpServer>>) -> Response {
    json_response(StatusCode::OK, server.health())
}

async fn get_tournament(State(server): State<Arc<QbtcpServer>>) -> Result<Response, QbtcpError> {
    Ok(json_response(StatusCode::OK, server.tournament()?))
}

async fn get_rooms(State(server): State<Arc<QbtcpServer>>) -> Result<Response, QbtcpError> {
    #[derive(serde::Serialize)]
    struct RoomsResponse {
        rooms: Vec<crate::model::RoomListEntry>,
    }
    Ok(json_response(
        StatusCode::OK,
        RoomsResponse {
            rooms: server.rooms()?,
        },
    ))
}

#[derive(Deserialize)]
struct PairBody {
    code: Option<String>,
    #[serde(alias = "room_id")]
    room_id: Option<String>,
}

async fn post_pair(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    // Pairing failures must not distinguish malformed from unknown/mismatched codes. A malformed
    // JSON body still gets the same safe pairing refusal rather than an oracle-shaped parse error.
    let body = parse_object::<PairBody>(&body).map_err(|_| QbtcpError::PairingRefused)?;
    let source = header_value(&headers, "x-forwarded-for").unwrap_or("unknown");
    let paired = server.pair(
        body.code.as_deref().unwrap_or_default(),
        body.room_id.as_deref(),
        source,
    )?;
    Ok(json_response(StatusCode::OK, paired))
}

async fn get_assignment(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    let assignment = server.assignment(header_value(&headers, ROOM_TOKEN_HEADER))?;
    match assignment {
        Some(value) => Ok(qbj_response(StatusCode::OK, &value)),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn get_assignment_status(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    Ok(json_response(
        StatusCode::OK,
        server.assignment_status(header_value(&headers, ROOM_TOKEN_HEADER))?,
    ))
}

#[derive(Deserialize)]
struct OpenSessionBody {
    match_id: Option<String>,
    #[serde(alias = "deviceId")]
    device_id: Option<String>,
}

async fn post_session(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let body = parse_object::<OpenSessionBody>(&body)?;
    let match_id = body
        .match_id
        .filter(|value| !value.trim().is_empty())
        .ok_or(QbtcpError::BadRequest(
            "The session request is missing a match id.",
        ))?;
    let device_id = body
        .device_id
        .as_deref()
        .or_else(|| header_value(&headers, DEVICE_ID_HEADER));
    Ok(json_response(
        StatusCode::OK,
        server.open_session(
            header_value(&headers, ROOM_TOKEN_HEADER),
            &match_id,
            device_id,
        )?,
    ))
}

async fn get_session(
    State(server): State<Arc<QbtcpServer>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    Ok(json_response(
        StatusCode::OK,
        server.session(&session_id, header_value(&headers, SESSION_TOKEN_HEADER))?,
    ))
}

#[derive(Deserialize)]
struct WriterBody {
    #[serde(alias = "deviceId")]
    device_id: Option<String>,
    #[serde(default)]
    take_over: bool,
}

async fn post_writer(
    State(server): State<Arc<QbtcpServer>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let body = parse_object::<WriterBody>(&body)?;
    let device_id = body
        .device_id
        .as_deref()
        .or_else(|| header_value(&headers, DEVICE_ID_HEADER));
    Ok(json_response(
        StatusCode::OK,
        server.take_writer(
            &session_id,
            header_value(&headers, SESSION_TOKEN_HEADER),
            device_id,
            body.take_over,
        )?,
    ))
}

async fn get_presence(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    #[derive(serde::Serialize)]
    struct PresenceEnvelope {
        presence: Option<PresenceView>,
    }
    Ok(json_response(
        StatusCode::OK,
        PresenceEnvelope {
            presence: server.presence(header_value(&headers, ROOM_TOKEN_HEADER))?,
        },
    ))
}

async fn post_presence(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let update = parse_object(&body)?;
    let view = server.update_presence(
        header_value(&headers, ROOM_TOKEN_HEADER),
        header_value(&headers, DEVICE_ID_HEADER),
        header_value(&headers, OPERATOR_NAME_HEADER),
        update,
    )?;
    #[derive(serde::Serialize)]
    struct PresenceEnvelope {
        presence: PresenceView,
    }
    Ok(json_response(
        StatusCode::OK,
        PresenceEnvelope { presence: view },
    ))
}

#[derive(Deserialize)]
struct ProgressBody {
    sequence: Option<u64>,
    #[serde(rename = "match")]
    match_state: Option<Value>,
}

async fn put_progress(
    State(server): State<Arc<QbtcpServer>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let body = parse_object::<ProgressBody>(&body)?;
    let sequence = body.sequence.ok_or(QbtcpError::BadRequest(
        "The progress envelope is missing a sequence.",
    ))?;
    let match_state = body.match_state.ok_or(QbtcpError::BadRequest(
        "The progress envelope is missing a Match.",
    ))?;
    Ok(json_response(
        StatusCode::OK,
        server.progress(
            &session_id,
            header_value(&headers, SESSION_TOKEN_HEADER),
            sequence,
            match_state,
        )?,
    ))
}

async fn post_result(
    State(server): State<Arc<QbtcpServer>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let value: Value = parse_value(&body)?;
    Ok(json_response(
        StatusCode::OK,
        server.result(
            &session_id,
            header_value(&headers, SESSION_TOKEN_HEADER),
            value,
            body.to_vec(),
        )?,
    ))
}

async fn get_recovery(
    State(server): State<Arc<QbtcpServer>>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    Ok(json_response(
        StatusCode::OK,
        server.recovery(&session_id, header_value(&headers, SESSION_TOKEN_HEADER))?,
    ))
}

#[derive(Deserialize)]
struct HelpBody {
    category: Option<String>,
    message: Option<String>,
}

async fn get_help(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    Ok(json_response(
        StatusCode::OK,
        HelpEnvelope {
            request: server.help(
                header_value(&headers, ROOM_TOKEN_HEADER),
                header_value(&headers, DEVICE_ID_HEADER),
            )?,
        },
    ))
}

async fn post_help(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let body = parse_object::<HelpBody>(&body)?;
    let category = body
        .category
        .filter(|value| !value.trim().is_empty())
        .ok_or(QbtcpError::BadRequest(
            "The help request is missing a category.",
        ))?;
    let request = server.request_help(
        header_value(&headers, ROOM_TOKEN_HEADER),
        header_value(&headers, DEVICE_ID_HEADER),
        header_value(&headers, OPERATOR_NAME_HEADER),
        category,
        body.message.unwrap_or_default(),
    )?;
    Ok(json_response(
        StatusCode::OK,
        HelpEnvelope {
            request: Some(request),
        },
    ))
}

async fn delete_help(
    State(server): State<Arc<QbtcpServer>>,
    Path(help_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, QbtcpError> {
    let request = server.cancel_help(
        header_value(&headers, ROOM_TOKEN_HEADER),
        header_value(&headers, DEVICE_ID_HEADER),
        &help_id,
    )?;
    Ok(json_response(
        StatusCode::OK,
        HelpEnvelope {
            request: Some(request),
        },
    ))
}

#[derive(Deserialize)]
struct RosterBody {
    #[serde(alias = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    #[serde(rename = "team_id", alias = "teamId")]
    team_id: Option<String>,
    #[serde(rename = "teamName", alias = "team_name")]
    team_name: Option<String>,
    #[serde(rename = "playerName", alias = "player_name")]
    player_name: Option<String>,
    #[serde(rename = "question_number", alias = "questionNumber")]
    question_number: Option<u32>,
}

async fn post_roster_player(
    State(server): State<Arc<QbtcpServer>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, QbtcpError> {
    let body = parse_object::<RosterBody>(&body)?;
    let session_id = body
        .session_id
        .filter(|value| !value.trim().is_empty())
        .ok_or(QbtcpError::BadRequest(
            "The roster amendment is missing a session.",
        ))?;
    let team_name = body
        .team_name
        .filter(|value| !value.trim().is_empty())
        .ok_or(QbtcpError::BadRequest(
            "The roster amendment is missing a team.",
        ))?;
    let player_name = body
        .player_name
        .filter(|value| !value.trim().is_empty())
        .ok_or(QbtcpError::BadRequest(
            "The roster amendment is missing a player.",
        ))?;
    let amendment = server.add_roster_player(
        header_value(&headers, ROOM_TOKEN_HEADER),
        session_id.as_str(),
        header_value(&headers, SESSION_TOKEN_HEADER),
        RosterAmendmentRequest {
            session_id: session_id.clone(),
            team_id: body.team_id,
            team_name,
            player_name,
            question_number: body.question_number,
        },
    )?;
    Ok(json_response(StatusCode::OK, amendment))
}

fn parse_object<T: DeserializeOwned>(body: &[u8]) -> Result<T, QbtcpError> {
    let value = parse_value(body)?;
    if !value.is_object() {
        return Err(QbtcpError::BadRequest(
            "Request body must be a JSON object.",
        ));
    }
    serde_json::from_value(value)
        .map_err(|_| QbtcpError::BadRequest("Request body has an invalid shape."))
}

fn parse_value(body: &[u8]) -> Result<Value, QbtcpError> {
    serde_json::from_slice(body)
        .map_err(|_| QbtcpError::BadRequest("Request body is not valid JSON."))
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn json_response<T: serde::Serialize>(status: StatusCode, value: T) -> Response {
    let body = serde_json::to_vec(&value)
        .unwrap_or_else(|_| b"{\"error\":\"Could not encode response.\"}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn qbj_response(status: StatusCode, value: &Value) -> Response {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, crate::model::QBJ_MEDIA_TYPE)
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

impl IntoResponse for QbtcpError {
    fn into_response(self) -> Response {
        let (status, code, message, retry_after, conflict) = match self {
            QbtcpError::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                "invalid_request",
                message,
                None,
                None,
            ),
            QbtcpError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "invalid_credential",
                "The supplied credential is not valid.",
                None,
                None,
            ),
            QbtcpError::PairingRefused => (
                StatusCode::UNAUTHORIZED,
                "pairing_refused",
                "The pairing code is not valid.",
                None,
                None,
            ),
            QbtcpError::Forbidden(message) => {
                (StatusCode::FORBIDDEN, "forbidden", message, None, None)
            }
            QbtcpError::NotFound(message) => {
                (StatusCode::NOT_FOUND, "not_found", message, None, None)
            }
            QbtcpError::NotSupported => (
                StatusCode::NOT_FOUND,
                "capability_not_supported",
                "This QBTCP capability is not available.",
                None,
                None,
            ),
            QbtcpError::Conflict {
                message,
                writer_device,
                can_take_over,
            } => (
                StatusCode::CONFLICT,
                "conflict",
                message,
                None,
                Some((writer_device, can_take_over)),
            ),
            QbtcpError::Gone(message) => (StatusCode::GONE, "superseded", message, None, None),
            QbtcpError::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "The request body is too large.",
                None,
                None,
            ),
            QbtcpError::RateLimited { retry_after_secs } => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many pairing attempts. Try again shortly.",
                Some(retry_after_secs),
                None,
            ),
            QbtcpError::OriginNotAllowed => (
                StatusCode::FORBIDDEN,
                "origin_not_allowed",
                "This browser origin is not approved.",
                None,
                None,
            ),
            QbtcpError::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "server_error",
                "Tournament control could not save this request.",
                None,
                None,
            ),
        };

        #[derive(serde::Serialize)]
        struct ErrorBody<'a> {
            error: &'a str,
            code: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            writer_device: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            can_take_over: Option<bool>,
        }
        let (writer_device, can_take_over) = conflict
            .map_or((None, None), |(device, take_over)| {
                (device, Some(take_over))
            });
        let mut response = json_response(
            status,
            ErrorBody {
                error: message,
                code,
                writer_device,
                can_take_over,
            },
        );
        if let Some(retry_after) = retry_after {
            if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        response
    }
}

async fn cors_and_limits(
    State(server): State<Arc<QbtcpServer>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let origin = origin.map(ToOwned::to_owned);
    let is_qbtcp = request.uri().path().starts_with(QBTCP_PREFIX);
    if is_qbtcp {
        if let Some(origin) = origin.as_deref() {
            if !server
                .config
                .allowed_origins
                .iter()
                .any(|allowed| allowed == origin)
            {
                return QbtcpError::OriginNotAllowed.into_response();
            }
        }
        if request.method() == Method::OPTIONS {
            return apply_cors(
                StatusCode::NO_CONTENT.into_response(),
                origin.as_deref(),
                request
                    .headers()
                    .get("access-control-request-private-network")
                    .and_then(|value| value.to_str().ok())
                    == Some("true"),
            );
        }
        if request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > server.config.max_body_bytes)
        {
            return apply_cors(
                QbtcpError::TooLarge.into_response(),
                origin.as_deref(),
                false,
            );
        }
    }

    let response = next.run(request).await;
    if is_qbtcp {
        apply_cors(response, origin.as_deref(), false)
    } else {
        response
    }
}

fn apply_cors(mut response: Response, origin: Option<&str>, private_network: bool) -> Response {
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin.and_then(|value| HeaderValue::from_str(value).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                "Accept, Content-Type, x-yf-room-token, x-yf-session-token, x-yf-device-id, x-yf-operator-name, Access-Control-Request-Private-Network",
            ),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        if private_network {
            response.headers_mut().insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
        }
    }
    response
}
