//! Privileged browser-origin readiness probe for Internet QBTCP.
//!
//! The Director UI runs inside a WebView, whose Fetch implementation owns the `Origin`
//! header. That makes a renderer-side CORS probe unsuitable as a readiness gate: the app
//! cannot prove that `https://qbsheet.com` is what was actually sent. This native probe sends
//! the exact browser preflight shape itself and returns only the status/CORS headers needed by
//! the renderer. It never sends scorer or management credentials.

use std::time::Duration;

use reqwest::header::{
    HeaderMap, HeaderValue, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
    ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_REQUEST_HEADERS, ACCESS_CONTROL_REQUEST_METHOD,
    ORIGIN,
};
use reqwest::{Client, Method, Url};
use serde::Serialize;

const SCORER_ORIGIN: &str = "https://qbsheet.com";
const SCORER_METHOD: &str = "POST";
const SCORER_HEADERS: &str = "x-yf-room-token,content-type,x-yf-device-id";
const MAX_RELAY_ORIGIN_LENGTH: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayScorerOriginProbe {
    pub status: u16,
    pub allow_origin: Option<String>,
    pub allow_methods: Option<String>,
    pub allow_headers: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RelayProbeError {
    pub code: &'static str,
    pub message: String,
}

impl RelayProbeError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_relay_probe",
            message: message.into(),
        }
    }

    fn network(error: reqwest::Error) -> Self {
        Self {
            code: "relay_probe_network",
            message: error.to_string(),
        }
    }
}

fn response_header(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn build_preflight_url(base_url: &str, tournament_id: &str) -> Result<Url, RelayProbeError> {
    if !crate::relay::is_tournament_id(tournament_id) {
        return Err(RelayProbeError::invalid(
            "That is not a valid relay tournament identifier.",
        ));
    }
    let base_url = base_url.trim();
    if base_url.is_empty() || base_url.len() > MAX_RELAY_ORIGIN_LENGTH {
        return Err(RelayProbeError::invalid(
            "The relay address is missing or too long.",
        ));
    }
    let mut url = Url::parse(base_url)
        .map_err(|_| RelayProbeError::invalid("The relay address is not a valid URL."))?;
    if url.scheme() != "https" {
        return Err(RelayProbeError::invalid(
            "The relay address must use https://.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RelayProbeError::invalid(
            "The relay address must not contain credentials.",
        ));
    }
    if (url.path() != "/" && !url.path().is_empty()) || url.query().is_some() || url.fragment().is_some() {
        return Err(RelayProbeError::invalid(
            "The relay address must be a bare origin with no path, query, or fragment.",
        ));
    }
    url.set_path(&format!(
        "/qbtcp/v1/tournaments/{tournament_id}/sessions"
    ));
    Ok(url)
}

async fn execute_preflight(
    client: &Client,
    url: Url,
) -> Result<RelayScorerOriginProbe, RelayProbeError> {
    let response = client
        .request(Method::OPTIONS, url)
        .header(ORIGIN, HeaderValue::from_static(SCORER_ORIGIN))
        .header(
            ACCESS_CONTROL_REQUEST_METHOD,
            HeaderValue::from_static(SCORER_METHOD),
        )
        .header(
            ACCESS_CONTROL_REQUEST_HEADERS,
            HeaderValue::from_static(SCORER_HEADERS),
        )
        .send()
        .await
        .map_err(RelayProbeError::network)?;

    let status = response.status().as_u16();
    let headers = response.headers();
    Ok(RelayScorerOriginProbe {
        status,
        allow_origin: response_header(headers, ACCESS_CONTROL_ALLOW_ORIGIN),
        allow_methods: response_header(headers, ACCESS_CONTROL_ALLOW_METHODS),
        allow_headers: response_header(headers, ACCESS_CONTROL_ALLOW_HEADERS),
    })
}

#[tauri::command]
pub async fn director_probe_relay_scorer_origin(
    base_url: String,
    tournament_id: String,
) -> Result<RelayScorerOriginProbe, RelayProbeError> {
    let url = build_preflight_url(&base_url, &tournament_id)?;
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(RelayProbeError::network)?;
    execute_preflight(&client, url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const TOURNAMENT_ID: &str = "bcdfghjkmnpqrstvwxyz1234";

    #[test]
    fn production_probe_url_is_https_and_tournament_scoped() {
        let url = build_preflight_url("https://example.workers.dev", TOURNAMENT_ID).expect("url");
        assert_eq!(url.scheme(), "https");
        assert_eq!(
            url.path(),
            "/qbtcp/v1/tournaments/bcdfghjkmnpqrstvwxyz1234/sessions"
        );
        for invalid in [
            "http://example.workers.dev",
            "https://user:pass@example.workers.dev",
            "https://example.workers.dev/path",
            "https://example.workers.dev?query=1",
            "https://example.workers.dev/#fragment",
        ] {
            assert!(build_preflight_url(invalid, TOURNAMENT_ID).is_err(), "{invalid}");
        }
        assert!(build_preflight_url("https://example.workers.dev", "bad").is_err());
    }

    #[tokio::test]
    async fn native_probe_sends_the_real_scorer_preflight_and_returns_cors_headers() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("listener");
        let address = listener.local_addr().expect("address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("timeout");
            let mut bytes = vec![0_u8; 8192];
            let read = stream.read(&mut bytes).expect("request");
            let request = String::from_utf8_lossy(&bytes[..read]).to_ascii_lowercase();
            assert!(request.starts_with("options /qbtcp/v1/tournaments/test/sessions "));
            assert!(request.contains("\r\norigin: https://qbsheet.com\r\n"));
            assert!(request.contains("\r\naccess-control-request-method: post\r\n"));
            assert!(request.contains(
                "\r\naccess-control-request-headers: x-yf-room-token,content-type,x-yf-device-id\r\n"
            ));
            stream
                .write_all(
                    b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: https://qbsheet.com\r\nAccess-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type, x-yf-room-token, x-yf-session-token, x-yf-device-id\r\nConnection: close\r\n\r\n",
                )
                .expect("response");
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client");
        let result = execute_preflight(
            &client,
            Url::parse(&format!(
                "http://{address}/qbtcp/v1/tournaments/test/sessions"
            ))
            .expect("test url"),
        )
        .await
        .expect("probe");

        server.join().expect("server");
        assert_eq!(result.status, 204);
        assert_eq!(result.allow_origin.as_deref(), Some(SCORER_ORIGIN));
        assert!(result.allow_methods.as_deref().is_some_and(|value| value.contains("POST")));
        assert!(result
            .allow_headers
            .as_deref()
            .is_some_and(|value| value.contains("x-yf-room-token")));
    }
}
