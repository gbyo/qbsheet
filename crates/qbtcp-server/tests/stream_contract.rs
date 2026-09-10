//! The realtime/relay compatibility contract, independent of any relay vendor (#770).
//!
//! These tests pin the Rust side of `docs/QBTCP-STREAM.md` against the same canonical wire
//! fixtures the TypeScript suite reads: discovery/descriptor validation, frame validation,
//! revision recency, progress coalescing, final idempotency, reconnect backoff, relay receipt
//! semantics, and untouched HTTP interop for servers without the `stream` capability.

use qbtcp_server::{
    is_assignment_newer, is_duplicate_final, progress_wins, read_stream_descriptor,
    reconnect_delay_ms, validate_stream_frame, RelayReceipt, StreamDescriptor,
    StreamDescriptorError, StreamFrameError, ValidatedStreamFrame, DEFAULT_MAX_STREAM_FRAME_BYTES,
    STREAM_CAPABILITY, STREAM_FRAME_VERSION, STREAM_RECONNECT_BASE_MS, STREAM_RECONNECT_MAX_MS,
    STREAM_SUBPROTOCOL,
};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = match name {
        "hello" => include_str!("../../../tests/fixtures/qbtcp-stream/hello.json"),
        "assignment-changed" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/assignment-changed.json")
        }
        "session-changed" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/session-changed.json")
        }
        "help-changed" => include_str!("../../../tests/fixtures/qbtcp-stream/help-changed.json"),
        "resync-required" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/resync-required.json")
        }
        "shutdown" => include_str!("../../../tests/fixtures/qbtcp-stream/shutdown.json"),
        "authenticate" => include_str!("../../../tests/fixtures/qbtcp-stream/authenticate.json"),
        "progress" => include_str!("../../../tests/fixtures/qbtcp-stream/progress.json"),
        "final" => include_str!("../../../tests/fixtures/qbtcp-stream/final.json"),
        "receipt" => include_str!("../../../tests/fixtures/qbtcp-stream/receipt.json"),
        "discovery" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/discovery-with-stream.json")
        }
        "discovery-unknown-replay" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/discovery-with-unknown-replay.json")
        }
        "unsupported-version" => {
            include_str!("../../../tests/fixtures/qbtcp-stream/frame-unsupported-version.json")
        }
        "malformed" => include_str!("../../../tests/fixtures/qbtcp-stream/frame-malformed.json"),
        _ => panic!("unknown stream fixture {name}"),
    };
    serde_json::from_str(path).expect("stream fixture must parse")
}

#[test]
fn constants_match_the_typescript_contract() {
    assert_eq!(STREAM_CAPABILITY, "stream");
    assert_eq!(STREAM_FRAME_VERSION, 1);
    assert_eq!(STREAM_SUBPROTOCOL, "qbtcp.stream.v1");
    assert_eq!(DEFAULT_MAX_STREAM_FRAME_BYTES, 1_048_576);
    assert_eq!(STREAM_RECONNECT_BASE_MS, 500);
    assert_eq!(STREAM_RECONNECT_MAX_MS, 30_000);
}

#[test]
fn discovery_fixture_advertises_a_complete_descriptor() {
    let discovery = fixture("discovery");
    let descriptor = read_stream_descriptor(&discovery)
        .expect("descriptor must read")
        .expect("descriptor must be present");
    assert_eq!(
        descriptor,
        StreamDescriptor {
            endpoint: "/qbtcp/v1/stream".to_owned(),
            frames: STREAM_FRAME_VERSION,
            retains_finals: true,
            mirrors_assignment: true,
            replay: vec!["sequence".to_owned(), "resync".to_owned()],
            max_frame_bytes: 1_048_576,
            ticket: false,
        }
    );
}

#[test]
fn unknown_replay_feature_rejects_the_whole_descriptor() {
    // Shared conformance fixture: TypeScript must reject this exact document too (#806).
    assert!(matches!(
        read_stream_descriptor(&fixture("discovery-unknown-replay")),
        Err(StreamDescriptorError::Malformed(_))
    ));
    let discovery = fixture("discovery");
    // Known subsets stay usable, including the empty subset.
    for replay in [
        serde_json::json!(["sequence"]),
        serde_json::json!(["resync"]),
        serde_json::json!(["sequence", "resync"]),
        serde_json::json!([]),
    ] {
        let mut patched = discovery.clone();
        patched["stream"]["replay"] = replay;
        assert!(
            read_stream_descriptor(&patched).unwrap().is_some(),
            "known replay subset must stay usable"
        );
    }
    // Unknown strings mixed with known values and non-string entries are all rejected,
    // matching the TypeScript mirror exactly.
    for replay in [
        serde_json::json!(["sequence", "future-replay-mode"]),
        serde_json::json!(["future-replay-mode"]),
        serde_json::json!(["sequence", 42]),
        serde_json::json!(["sequence", null]),
        serde_json::json!([["sequence"]]),
        serde_json::json!("sequence"),
    ] {
        let mut patched = discovery.clone();
        patched["stream"]["replay"] = replay;
        assert!(
            read_stream_descriptor(&patched).is_err(),
            "unknown replay value must reject the descriptor"
        );
    }
    // Duplicate known entries carry no new meaning and stay usable on both sides.
    let mut patched = discovery.clone();
    patched["stream"]["replay"] = serde_json::json!(["sequence", "sequence"]);
    assert!(read_stream_descriptor(&patched).unwrap().is_some());
}

#[test]
fn absent_stream_capability_means_http_only() {
    let discovery = serde_json::json!({
        "protocol": "QBTCP",
        "version": 1,
        "capabilities": ["pairing", "assignment", "progress", "result"],
    });
    assert_eq!(read_stream_descriptor(&discovery).unwrap(), None);
}

#[test]
fn descriptor_with_credential_shaped_keys_is_rejected() {
    let mut discovery = fixture("discovery");
    for poison in ["token", "roomToken", "pairing_code", "secret", "password"] {
        let mut poisoned = discovery.clone();
        poisoned["stream"][poison] = Value::from("abc");
        assert_eq!(
            read_stream_descriptor(&poisoned),
            Err(StreamDescriptorError::CredentialLeak),
            "key {poison} must be rejected"
        );
    }
    // The valid fixture itself stays readable.
    assert!(read_stream_descriptor(&discovery).unwrap().is_some());
    discovery["stream"]["token"] = Value::Null;
    assert!(read_stream_descriptor(&discovery).is_err());
}

#[test]
fn absolute_or_parameterized_endpoints_are_refused() {
    let discovery = fixture("discovery");
    for endpoint in [
        "wss://relay.example/stream?token=abc",
        "/qbtcp/v1/stream?token=abc",
        "/qbtcp/v1/stream#token=abc",
        "/qbtcp/v1/stream@evil",
        "qbtcp/v1/stream",
    ] {
        let mut patched = discovery.clone();
        patched["stream"]["endpoint"] = Value::from(endpoint);
        assert!(
            read_stream_descriptor(&patched).is_err(),
            "endpoint {endpoint} must be refused"
        );
    }
}

#[test]
fn descriptor_with_future_frame_version_is_unusable() {
    let mut discovery = fixture("discovery");
    discovery["stream"]["frames"] = Value::from(2);
    assert_eq!(
        read_stream_descriptor(&discovery),
        Err(StreamDescriptorError::UnsupportedFrames(2))
    );
}

#[test]
fn canonical_server_frames_validate() {
    for name in [
        "hello",
        "assignment-changed",
        "session-changed",
        "help-changed",
        "resync-required",
        "shutdown",
        "receipt",
    ] {
        let outcome = validate_stream_frame(&fixture(name), DEFAULT_MAX_STREAM_FRAME_BYTES);
        assert!(
            matches!(outcome, Ok(ValidatedStreamFrame::Frame(_))),
            "{name} must validate"
        );
    }
}

#[test]
fn scorer_frames_validate() {
    for name in ["authenticate", "progress", "final"] {
        let outcome = validate_stream_frame(&fixture(name), DEFAULT_MAX_STREAM_FRAME_BYTES);
        let Ok(ValidatedStreamFrame::Frame(frame)) = outcome else {
            panic!("{name} must validate");
        };
        assert_eq!(frame.version, STREAM_FRAME_VERSION);
    }
}

#[test]
fn malformed_and_future_frames_fail_safely() {
    assert!(matches!(
        validate_stream_frame(&fixture("malformed"), DEFAULT_MAX_STREAM_FRAME_BYTES),
        Err(StreamFrameError::Malformed(_))
    ));
    assert_eq!(
        validate_stream_frame(
            &fixture("unsupported-version"),
            DEFAULT_MAX_STREAM_FRAME_BYTES
        ),
        Err(StreamFrameError::UnsupportedVersion)
    );
    // No frame type performs a writer takeover: unknown types are ignored, never honored.
    assert_eq!(
        validate_stream_frame(
            &serde_json::json!({"version": 1, "type": "writer-takeover", "session_id": "sess-1"}),
            DEFAULT_MAX_STREAM_FRAME_BYTES
        ),
        Ok(ValidatedStreamFrame::Ignored)
    );
}

#[test]
fn oversize_frames_fail_before_they_are_read() {
    let frame =
        serde_json::json!({"version": 1, "type": "hello", "payload": {"pad": "x".repeat(100)}});
    assert!(matches!(
        validate_stream_frame(&frame, 32),
        Err(StreamFrameError::TooLarge { .. })
    ));
}

#[test]
fn stale_revisions_never_supersede() {
    let current = (Some(4), Some(9));
    assert!(!is_assignment_newer(current, (Some(3), Some(12))));
    assert!(!is_assignment_newer(current, (Some(4), Some(8))));
    assert!(!is_assignment_newer(current, (Some(4), Some(9))));
    assert!(is_assignment_newer(current, (Some(4), Some(10))));
    assert!(is_assignment_newer(current, (Some(5), Some(1))));
    assert!(!is_assignment_newer(current, (None, None)));
    // An unnumbered holder adopts the first numbered revision it sees.
    assert!(is_assignment_newer((None, None), (Some(4), Some(9))));
}

#[test]
fn progress_coalesces_to_current_state() {
    assert!(progress_wins(None, 41));
    assert!(progress_wins(Some(41), 42));
    assert!(!progress_wins(Some(42), 41));
    // Ties keep the held snapshot: the first arrival wins.
    assert!(!progress_wins(Some(42), 42));
}

#[test]
fn duplicate_finals_are_idempotent_across_transports() {
    let known = (Some("t-1"), Some("sm-4471"), "fp-1", Some("retry-6f2a"));
    assert!(!is_duplicate_final((None, None, "fp-1", None), known));
    assert!(is_duplicate_final(known, known));
    // Same game retried without the key is still the same result.
    assert!(is_duplicate_final(
        known,
        (Some("t-1"), Some("sm-4471"), "fp-1", None)
    ));
    // Same game corrected is not a duplicate.
    assert!(!is_duplicate_final(
        known,
        (Some("t-1"), Some("sm-4471"), "fp-2", Some("retry-7"))
    ));
    // A different game is never a duplicate, even with identical statistics.
    assert!(!is_duplicate_final(
        known,
        (Some("t-1"), Some("sm-4472"), "fp-1", Some("retry-7"))
    ));
    // The tournament scopes the comparison, before the retry key is consulted.
    assert!(!is_duplicate_final(
        known,
        (Some("t-2"), Some("sm-4471"), "fp-1", Some("retry-6f2a"))
    ));
    // A final racing across both paths retains exactly one semantic result, either order.
    let via_lan = (Some("t-1"), Some("sm-4471"), "fp-1", Some("retry-lan"));
    assert!(is_duplicate_final(known, via_lan));
    assert!(is_duplicate_final(via_lan, known));
    // Without match identity the key plus identical bytes still match, but key reuse
    // across different bytes is a new submission, not a retry.
    let legacy = (Some("t-1"), None, "fp-1", Some("retry-6f2a"));
    assert!(is_duplicate_final(legacy, legacy));
    assert!(!is_duplicate_final(
        legacy,
        (Some("t-1"), None, "fp-9", Some("retry-6f2a"))
    ));
}

#[test]
fn reconnect_backoff_doubles_with_a_cap_and_full_jitter() {
    assert_eq!(reconnect_delay_ms(0, 500), 250);
    assert_eq!(reconnect_delay_ms(1, 500), 500);
    assert_eq!(reconnect_delay_ms(3, 250), 1000);
    assert!(reconnect_delay_ms(100, 999) <= STREAM_RECONNECT_MAX_MS);
    assert!(reconnect_delay_ms(100, 999) > STREAM_RECONNECT_MAX_MS - 60);
    assert_eq!(reconnect_delay_ms(100, 0), 0);
}

#[test]
fn relay_receipt_separates_durability_from_director_acceptance() {
    let receipt = RelayReceipt::retained(
        true,
        false,
        Some("sm-4471".to_owned()),
        "9f2ac411".to_owned(),
        "result-31".to_owned(),
    );
    assert!(receipt.received);
    assert!(receipt.review_required);
    // A relay never accepts results on Director's behalf: there is no parameter for it.
    assert!(!receipt.accepted_by_director);
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["received"], true);
    assert_eq!(wire["accepted_by_director"], false);
    // The canonical receipt fixture agrees: received, reviewable, not accepted.
    let canonical = fixture("receipt");
    assert_eq!(canonical["payload"]["received"], true);
    assert_eq!(canonical["payload"]["accepted_by_director"], false);
}
