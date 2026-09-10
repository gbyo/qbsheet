//! Cross-language fixture parity.
//!
//! The fixtures in `packages/qblive-protocol/fixtures` are emitted by
//! `@qbsheet/qblive-projection` from the real privacy fixture. TypeScript,
//! Swift, and this Rust core all read the same files: identical input must
//! produce equivalent observable behavior from every backend.

use qblive_server::{is_publication_id, is_valid_timestamp, validate_snapshot, PROTOCOL_VERSION};
use serde_json::Value;

fn load(name: &str) -> Value {
    let path = format!(
        "{}/../../packages/qblive-protocol/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("read {path}"));
    serde_json::from_str(&text).expect("parse fixture")
}

#[test]
fn every_snapshot_fixture_satisfies_the_rust_validator() {
    for name in [
        "snapshot-default.json",
        "snapshot-maximal.json",
        "snapshot-minimal.json",
    ] {
        let fixture = load(name);
        assert_eq!(fixture["protocolVersion"], PROTOCOL_VERSION, "{name}");
        let publication_id = fixture["publicationId"].as_str().expect("publicationId");
        assert!(is_publication_id(publication_id), "{name}");
        assert!(
            is_valid_timestamp(fixture["generatedAt"].as_str().unwrap_or("")),
            "{name}"
        );
        validate_snapshot(&fixture).unwrap_or_else(|_| panic!("{name} validates"));
    }
}

#[test]
fn every_protocol_section_appears_in_a_fixture() {
    let maximal = load("snapshot-maximal.json");
    for section in qblive_server::SECTION_NAMES {
        assert!(maximal.get(section).is_some(), "missing {section}");
    }
}

#[test]
fn manifest_and_event_fixtures_carry_the_same_publication() {
    let manifest = load("manifest.json");
    let events = load("events.json");
    assert_eq!(manifest["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(events["protocolVersion"], PROTOCOL_VERSION);
    assert!(is_publication_id(
        manifest["publicationId"].as_str().unwrap_or("")
    ));
    assert_eq!(manifest["publicationId"], events["publicationId"]);
}

#[test]
fn rust_limits_match_the_typescript_bounds() {
    // Mirrors `qbliveLimits` in `packages/qblive-protocol/src/validate.ts`.
    // `packages/qblive-protocol/tests/rust-parity.test.ts` asserts the same
    // numbers from the TypeScript side, so drift fails on both.
    assert_eq!(qblive_server::MAX_TEAMS, 512);
    assert_eq!(qblive_server::MAX_PLAYERS_PER_TEAM, 32);
    assert_eq!(qblive_server::MAX_ROOMS, 256);
    assert_eq!(qblive_server::MAX_SCHEDULE_ENTRIES, 8192);
    assert_eq!(qblive_server::MAX_RESULTS, 8192);
    assert_eq!(qblive_server::MAX_LIVE_GAMES, 256);
    assert_eq!(qblive_server::MAX_TIMELINE_EVENTS, 512);
    assert_eq!(qblive_server::MAX_TABLES, 64);
    assert_eq!(qblive_server::MAX_TABLE_ROWS, 2048);
    assert_eq!(qblive_server::MAX_TABLE_COLUMNS, 48);
    assert_eq!(qblive_server::MAX_ANNOUNCEMENTS, 256);
    assert_eq!(qblive_server::MAX_STRING_LENGTH, 4096);
    assert_eq!(qblive_server::MAX_BODY_BYTES, 8 * 1024 * 1024);
    assert_eq!(qblive_server::MAX_EVENTS_PER_PAGE, 256);
}

#[test]
fn local_capabilities_match_the_shared_json() {
    let shared = std::fs::read_to_string(format!(
        "{}/../../packages/qblive-protocol/src/local-capabilities.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("read local capabilities");
    let shared: Value = serde_json::from_str(&shared).expect("parse capabilities");
    let embedded: Value =
        serde_json::from_str(qblive_server::LOCAL_CAPABILITIES_JSON).expect("parse embedded");
    assert_eq!(shared, embedded);
}
