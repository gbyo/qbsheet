use std::fs;

use qbsheet_tournament_store::{
    CheckpointMode, NewManualGame, NewPacket, NewPhase, NewResultSubmission, NewRoom, NewRound,
    NewScheduledGame, NewTeam, NewTournament, Store, StoreError, CURRENT_SCHEMA_VERSION,
};
use serde_json::json;
use tempfile::tempdir;
use uuid::Uuid;

#[test]
fn create_close_and_reopen_preserves_the_tournament_graph() {
    let directory = tempdir().expect("temporary directory");
    let path = directory.path().join("event.sqlite3");

    let tournament_id;
    let team_id;
    {
        let store = Store::open(&path).expect("open store");
        let tournament = store
            .tournaments()
            .create(NewTournament::new("Durable Invitational"))
            .expect("create tournament");
        tournament_id = tournament.id.clone();
        team_id = store
            .teams()
            .create(NewTeam::new(&tournament.id, "Northview A"))
            .expect("create team")
            .id;
        assert_eq!(store.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
        assert_eq!(store.journal_mode().unwrap(), "wal");
        assert!(store.foreign_keys_enabled().unwrap());
    }

    let reopened = Store::open(&path).expect("reopen store");
    let tournament = reopened
        .tournaments()
        .require(&tournament_id)
        .expect("find reopened tournament");
    assert_eq!(tournament.name, "Durable Invitational");
    assert_eq!(
        reopened.teams().list(&tournament_id, false).unwrap()[0].id,
        team_id
    );
}

#[test]
fn result_acceptance_is_atomic_and_keeps_the_raw_submission() {
    let store = Store::open_in_memory().expect("open store");
    let tournament = store
        .tournaments()
        .create(NewTournament::new("Result acceptance test"))
        .expect("create tournament");
    let team_a = store
        .teams()
        .create(NewTeam::new(&tournament.id, "Alpha"))
        .expect("create team A");
    let team_b = store
        .teams()
        .create(NewTeam::new(&tournament.id, "Beta"))
        .expect("create team B");
    let phase = store
        .phases()
        .create(NewPhase {
            tournament_id: tournament.id.clone(),
            name: "Preliminaries".to_owned(),
            phase_type: "round_robin".to_owned(),
            sequence: 1,
            status: "active".to_owned(),
            rules: json!({"tossup_value": 10}),
            advancement: json!({}),
        })
        .expect("create phase");
    let round = store
        .rounds()
        .create(NewRound {
            tournament_id: tournament.id.clone(),
            phase_id: phase.id,
            name: "Round 1".to_owned(),
            sequence: 1,
            round_number: 1,
            status: "released".to_owned(),
        })
        .expect("create round");
    let room = store
        .rooms()
        .create(NewRoom {
            tournament_id: tournament.id.clone(),
            name: "101".to_owned(),
            building: None,
            floor: None,
            accessible: true,
            directions: None,
            notes: None,
            status: "available".to_owned(),
        })
        .expect("create room");
    let scheduled = store
        .schedule()
        .create(NewScheduledGame {
            tournament_id: tournament.id.clone(),
            round_id: round.id,
            room_id: Some(room.id),
            packet_id: None,
            team_a_id: Some(team_a.id.clone()),
            team_b_id: Some(team_b.id.clone()),
            game_number: 1,
            status: "playing".to_owned(),
            scheduled_at: None,
            notes: None,
        })
        .expect("create scheduled game");
    let game = store
        .games()
        .create(NewManualGame {
            tournament_id: tournament.id.clone(),
            scheduled_game_id: Some(scheduled.id),
            status: "in_progress".to_owned(),
            team_a_score: None,
            team_b_score: None,
            winner_team_id: None,
            result_type: None,
            notes: None,
        })
        .expect("create game");
    let payload = json!({
        "team_a_score": 220,
        "team_b_score": 180,
        "winner_team_id": team_a.id,
        "result_type": "regular",
        "player_stats": []
    });
    let submission = store
        .submissions()
        .create(NewResultSubmission {
            tournament_id: tournament.id.clone(),
            game_id: game.id.clone(),
            qbtcp_session_id: None,
            fingerprint: "fingerprint-1".to_owned(),
            payload: payload.clone(),
        })
        .expect("create submission");

    let accepted = store
        .results()
        .accept_submission(&submission.id, Some("director"), Some("clean"))
        .expect("accept result");
    assert_eq!(accepted.status, "accepted");
    assert_eq!(accepted.team_a_score, Some(220));
    assert_eq!(accepted.winner_team_id, Some(team_a.id.clone()));
    assert_eq!(
        store
            .submissions()
            .get(&submission.id)
            .unwrap()
            .unwrap()
            .payload,
        payload
    );
    assert_eq!(
        store
            .submissions()
            .get(&submission.id)
            .unwrap()
            .unwrap()
            .status,
        "accepted"
    );

    let audit = store.audit().list(Some(&tournament.id)).unwrap();
    assert!(audit
        .iter()
        .any(|event| event.event_type == "result.accepted"));

    let invalid_game = store
        .games()
        .create(NewManualGame {
            tournament_id: tournament.id.clone(),
            scheduled_game_id: None,
            status: "in_progress".to_owned(),
            team_a_score: None,
            team_b_score: None,
            winner_team_id: None,
            result_type: None,
            notes: None,
        })
        .expect("create second game");
    let invalid_submission = store
        .submissions()
        .create(NewResultSubmission {
            tournament_id: tournament.id,
            game_id: invalid_game.id.clone(),
            qbtcp_session_id: None,
            fingerprint: "fingerprint-invalid".to_owned(),
            payload: json!({"team_a_score": -1, "team_b_score": 20}),
        })
        .expect("create invalid submission");
    assert!(matches!(
        store
            .results()
            .accept_submission(&invalid_submission.id, None, None),
        Err(StoreError::InvalidInput(_))
    ));
    assert_eq!(
        store.games().get(&invalid_game.id).unwrap().unwrap().status,
        "in_progress"
    );
    assert_eq!(
        store
            .submissions()
            .get(&invalid_submission.id)
            .unwrap()
            .unwrap()
            .status,
        "received"
    );
}

#[test]
fn checkpoint_and_online_backup_are_reopenable() {
    let directory = tempdir().expect("temporary directory");
    let source_path = directory.path().join("source.sqlite3");
    let backup_path = directory.path().join("backup.sqlite3");
    let store = Store::open(&source_path).expect("open source");
    store
        .tournaments()
        .create(NewTournament::new("Backup test"))
        .expect("create backup tournament");

    let checkpoint = store
        .checkpoint(CheckpointMode::Passive)
        .expect("checkpoint");
    assert_eq!(checkpoint.mode, CheckpointMode::Passive);
    let report = store.backup_to(&backup_path).expect("online backup");
    assert_eq!(report.destination, backup_path);
    assert!(fs::metadata(&backup_path).unwrap().len() > 0);

    let backup = Store::open(&backup_path).expect("open backup");
    assert_eq!(backup.tournaments().list(false).unwrap().len(), 1);
}

#[test]
fn backup_to_accepts_a_bare_relative_destination() {
    let store = Store::open_in_memory().expect("open store");
    let destination = format!("qbsheet-store-backup-{}.sqlite3", Uuid::new_v4());

    let report = store.backup_to(&destination).expect("relative backup");
    assert_eq!(report.destination, std::path::PathBuf::from(&destination));
    assert!(fs::metadata(&destination).expect("backup metadata").len() > 0);

    fs::remove_file(&destination).expect("remove relative backup");
}

#[test]
fn scheduled_game_packet_assignment_uses_only_the_game_target() {
    let store = Store::open_in_memory().expect("open store");
    let tournament = store
        .tournaments()
        .create(NewTournament::new("Packet target test"))
        .expect("create tournament");
    let phase = store
        .phases()
        .create(NewPhase {
            tournament_id: tournament.id.clone(),
            name: "Preliminaries".to_owned(),
            phase_type: "round_robin".to_owned(),
            sequence: 1,
            status: "planned".to_owned(),
            rules: json!({}),
            advancement: json!({}),
        })
        .expect("create phase");
    let round = store
        .rounds()
        .create(NewRound {
            tournament_id: tournament.id.clone(),
            phase_id: phase.id,
            name: "Round 1".to_owned(),
            sequence: 1,
            round_number: 1,
            status: "planned".to_owned(),
        })
        .expect("create round");
    let packet = store
        .packets()
        .create(NewPacket {
            tournament_id: tournament.id.clone(),
            name: "Packet 1".to_owned(),
            packet_type: "regular".to_owned(),
            status: "available".to_owned(),
            nominal_round_id: None,
            replacement_for_id: None,
            security_notes: None,
        })
        .expect("create packet");
    let scheduled = store
        .schedule()
        .create(NewScheduledGame {
            tournament_id: tournament.id,
            round_id: round.id,
            room_id: None,
            packet_id: Some(packet.id.clone()),
            team_a_id: None,
            team_b_id: None,
            game_number: 1,
            status: "scheduled".to_owned(),
            scheduled_at: None,
            notes: None,
        })
        .expect("create scheduled game");

    let assignment = store
        .packets()
        .assign_to_game(&packet.id, &scheduled.id)
        .expect("read existing game assignment");
    assert_eq!(assignment.round_id, None);
    assert_eq!(assignment.scheduled_game_id, Some(scheduled.id));
}

#[test]
fn schedule_repository_rejects_team_and_room_conflicts() {
    let store = Store::open_in_memory().expect("open store");
    let tournament = store
        .tournaments()
        .create(NewTournament::new("Conflict test"))
        .unwrap();
    let team_a = store
        .teams()
        .create(NewTeam::new(&tournament.id, "A"))
        .unwrap();
    let team_b = store
        .teams()
        .create(NewTeam::new(&tournament.id, "B"))
        .unwrap();
    let team_c = store
        .teams()
        .create(NewTeam::new(&tournament.id, "C"))
        .unwrap();
    let phase = store
        .phases()
        .create(NewPhase {
            tournament_id: tournament.id.clone(),
            name: "Prelim".to_owned(),
            phase_type: "round_robin".to_owned(),
            sequence: 1,
            status: "planned".to_owned(),
            rules: json!({}),
            advancement: json!({}),
        })
        .unwrap();
    let round = store
        .rounds()
        .create(NewRound {
            tournament_id: tournament.id.clone(),
            phase_id: phase.id,
            name: "Round 1".to_owned(),
            sequence: 1,
            round_number: 1,
            status: "planned".to_owned(),
        })
        .unwrap();
    let room = store
        .rooms()
        .create(NewRoom {
            tournament_id: tournament.id.clone(),
            name: "101".to_owned(),
            building: None,
            floor: None,
            accessible: false,
            directions: None,
            notes: None,
            status: "available".to_owned(),
        })
        .unwrap();
    store
        .schedule()
        .create(NewScheduledGame {
            tournament_id: tournament.id.clone(),
            round_id: round.id.clone(),
            room_id: Some(room.id.clone()),
            packet_id: None,
            team_a_id: Some(team_a.id.clone()),
            team_b_id: Some(team_b.id),
            game_number: 1,
            status: "scheduled".to_owned(),
            scheduled_at: None,
            notes: None,
        })
        .unwrap();

    let conflict = store.schedule().create(NewScheduledGame {
        tournament_id: tournament.id,
        round_id: round.id,
        room_id: Some(room.id),
        packet_id: None,
        team_a_id: Some(team_a.id),
        team_b_id: Some(team_c.id),
        game_number: 2,
        status: "scheduled".to_owned(),
        scheduled_at: None,
        notes: None,
    });
    assert!(matches!(conflict, Err(StoreError::Conflict(_))));
}
