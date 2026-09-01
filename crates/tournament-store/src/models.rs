use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Id = String;
pub type UnixTimestamp = i64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tournament {
    pub id: Id,
    pub name: String,
    pub short_name: Option<String>,
    pub organization_id: Option<Id>,
    pub location: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub status: String,
    pub rules: Value,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
    pub archived_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewTournament {
    pub name: String,
    pub short_name: Option<String>,
    pub organization_id: Option<Id>,
    pub location: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub status: String,
    pub rules: Value,
}

impl NewTournament {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            short_name: None,
            organization_id: None,
            location: None,
            start_date: None,
            end_date: None,
            status: "draft".to_owned(),
            rules: serde_json::json!({}),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TournamentUpdate {
    pub name: Option<String>,
    pub short_name: Option<String>,
    pub location: Option<String>,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub status: Option<String>,
    pub rules: Option<Value>,
    pub archived_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Organization {
    pub id: Id,
    pub name: String,
    pub abbreviation: Option<String>,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewOrganization {
    pub name: String,
    pub abbreviation: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Team {
    pub id: Id,
    pub tournament_id: Id,
    pub organization_id: Option<Id>,
    pub name: String,
    pub display_name: String,
    pub team_letter: Option<String>,
    pub seed: Option<i64>,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
    pub archived_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewTeam {
    pub tournament_id: Id,
    pub organization_id: Option<Id>,
    pub name: String,
    pub display_name: Option<String>,
    pub team_letter: Option<String>,
    pub seed: Option<i64>,
    pub status: String,
    pub notes: Option<String>,
}

impl NewTeam {
    pub fn new(tournament_id: impl Into<Id>, name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            tournament_id: tournament_id.into(),
            organization_id: None,
            display_name: Some(name.clone()),
            name,
            team_letter: None,
            seed: None,
            status: "active".to_owned(),
            notes: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TeamUpdate {
    pub organization_id: Option<Id>,
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub team_letter: Option<String>,
    pub seed: Option<i64>,
    pub status: Option<String>,
    pub notes: Option<String>,
    pub archived_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Player {
    pub id: Id,
    pub tournament_id: Id,
    pub organization_id: Option<Id>,
    pub name: String,
    pub graduation_year: Option<i64>,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
    pub archived_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewPlayer {
    pub tournament_id: Id,
    pub organization_id: Option<Id>,
    pub name: String,
    pub graduation_year: Option<i64>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamPlayer {
    pub team_id: Id,
    pub player_id: Id,
    pub captain: bool,
    pub roster_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamRosterMember {
    pub player: Player,
    pub captain: bool,
    pub roster_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Room {
    pub id: Id,
    pub tournament_id: Id,
    pub name: String,
    pub building: Option<String>,
    pub floor: Option<String>,
    pub accessible: bool,
    pub directions: Option<String>,
    pub notes: Option<String>,
    pub status: String,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewRoom {
    pub tournament_id: Id,
    pub name: String,
    pub building: Option<String>,
    pub floor: Option<String>,
    pub accessible: bool,
    pub directions: Option<String>,
    pub notes: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StaffMember {
    pub id: Id,
    pub tournament_id: Id,
    pub display_name: String,
    pub role: String,
    pub availability: Value,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewStaffMember {
    pub tournament_id: Id,
    pub display_name: String,
    pub role: String,
    pub availability: Value,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EquipmentResource {
    pub id: Id,
    pub tournament_id: Id,
    pub kind: String,
    pub name: String,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewEquipmentResource {
    pub tournament_id: Id,
    pub kind: String,
    pub name: String,
    pub status: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Packet {
    pub id: Id,
    pub tournament_id: Id,
    pub name: String,
    pub packet_type: String,
    pub status: String,
    pub nominal_round_id: Option<Id>,
    pub replacement_for_id: Option<Id>,
    pub security_notes: Option<String>,
    pub used_at: Option<UnixTimestamp>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewPacket {
    pub tournament_id: Id,
    pub name: String,
    pub packet_type: String,
    pub status: String,
    pub nominal_round_id: Option<Id>,
    pub replacement_for_id: Option<Id>,
    pub security_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Phase {
    pub id: Id,
    pub tournament_id: Id,
    pub name: String,
    pub phase_type: String,
    pub sequence: i64,
    pub status: String,
    pub rules: Value,
    pub advancement: Value,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewPhase {
    pub tournament_id: Id,
    pub name: String,
    pub phase_type: String,
    pub sequence: i64,
    pub status: String,
    pub rules: Value,
    pub advancement: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Pool {
    pub id: Id,
    pub phase_id: Id,
    pub name: String,
    pub sequence: i64,
    pub rules: Value,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewPool {
    pub phase_id: Id,
    pub name: String,
    pub sequence: i64,
    pub rules: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhaseTeam {
    pub phase_id: Id,
    pub team_id: Id,
    pub pool_id: Option<Id>,
    pub seed: Option<i64>,
    pub standing: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewPhaseTeam {
    pub phase_id: Id,
    pub team_id: Id,
    pub pool_id: Option<Id>,
    pub seed: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Round {
    pub id: Id,
    pub tournament_id: Id,
    pub phase_id: Id,
    pub name: String,
    pub sequence: i64,
    pub round_number: i64,
    pub status: String,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewRound {
    pub tournament_id: Id,
    pub phase_id: Id,
    pub name: String,
    pub sequence: i64,
    pub round_number: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScheduledGame {
    pub id: Id,
    pub tournament_id: Id,
    pub round_id: Id,
    pub room_id: Option<Id>,
    pub packet_id: Option<Id>,
    pub team_a_id: Option<Id>,
    pub team_b_id: Option<Id>,
    pub game_number: i64,
    pub status: String,
    pub scheduled_at: Option<UnixTimestamp>,
    pub started_at: Option<UnixTimestamp>,
    pub completed_at: Option<UnixTimestamp>,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewScheduledGame {
    pub tournament_id: Id,
    pub round_id: Id,
    pub room_id: Option<Id>,
    pub packet_id: Option<Id>,
    pub team_a_id: Option<Id>,
    pub team_b_id: Option<Id>,
    pub game_number: i64,
    pub status: String,
    pub scheduled_at: Option<UnixTimestamp>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PacketAssignment {
    pub packet_id: Id,
    pub round_id: Option<Id>,
    pub scheduled_game_id: Option<Id>,
    pub assigned_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Game {
    pub id: Id,
    pub tournament_id: Id,
    pub scheduled_game_id: Option<Id>,
    pub status: String,
    pub team_a_score: Option<i64>,
    pub team_b_score: Option<i64>,
    pub winner_team_id: Option<Id>,
    pub result_type: Option<String>,
    pub notes: Option<String>,
    pub started_at: Option<UnixTimestamp>,
    pub completed_at: Option<UnixTimestamp>,
    pub accepted_at: Option<UnixTimestamp>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewManualGame {
    pub tournament_id: Id,
    pub scheduled_game_id: Option<Id>,
    pub status: String,
    pub team_a_score: Option<i64>,
    pub team_b_score: Option<i64>,
    pub winner_team_id: Option<Id>,
    pub result_type: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlayerGameStat {
    pub player_id: Option<Id>,
    pub team_id: Id,
    pub tossups_heard: i64,
    pub powers: i64,
    pub gets: i64,
    pub negs: i64,
    pub bonus_points: i64,
    pub bonuses_heard: i64,
    pub bouncebacks: i64,
    pub points: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoredPlayerGameStat {
    pub id: Id,
    pub game_id: Id,
    pub stats: PlayerGameStat,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubmittedGameResult {
    pub team_a_score: i64,
    pub team_b_score: i64,
    pub winner_team_id: Option<Id>,
    pub result_type: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub player_stats: Vec<PlayerGameStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResultSubmission {
    pub id: Id,
    pub tournament_id: Id,
    pub game_id: Id,
    pub qbtcp_session_id: Option<Id>,
    pub fingerprint: String,
    pub payload: Value,
    pub status: String,
    pub submitted_at: UnixTimestamp,
    pub reviewed_at: Option<UnixTimestamp>,
    pub reviewed_by: Option<String>,
    pub review_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewResultSubmission {
    pub tournament_id: Id,
    pub game_id: Id,
    pub qbtcp_session_id: Option<Id>,
    pub fingerprint: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Protest {
    pub id: Id,
    pub tournament_id: Id,
    pub game_id: Option<Id>,
    pub submitted_by: Option<String>,
    pub issue: String,
    pub status: String,
    pub ruling: Option<String>,
    pub notes: Option<String>,
    pub created_at: UnixTimestamp,
    pub resolved_at: Option<UnixTimestamp>,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewProtest {
    pub tournament_id: Id,
    pub game_id: Option<Id>,
    pub submitted_by: Option<String>,
    pub issue: String,
    pub status: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEvent {
    pub id: Id,
    pub tournament_id: Option<Id>,
    pub event_type: String,
    pub entity_type: String,
    pub entity_id: Option<Id>,
    pub actor: Option<String>,
    pub payload: Value,
    pub created_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetadataEntry {
    pub key: String,
    pub value: Value,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QbtcpRoom {
    pub id: Id,
    pub tournament_id: Id,
    pub room_id: Id,
    pub room_code: String,
    pub pairing_code: Option<String>,
    pub status: String,
    pub last_seen_at: Option<UnixTimestamp>,
    pub created_at: UnixTimestamp,
    pub updated_at: UnixTimestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewQbtcpRoom {
    pub tournament_id: Id,
    pub room_id: Id,
    pub room_code: String,
    pub pairing_code: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QbtcpSession {
    pub id: Id,
    pub tournament_id: Id,
    pub qbtcp_room_id: Id,
    pub client_id: String,
    pub protocol_version: String,
    pub capabilities: Value,
    pub token_digest: String,
    pub status: String,
    pub paired_at: UnixTimestamp,
    pub last_seen_at: Option<UnixTimestamp>,
    pub expires_at: Option<UnixTimestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewQbtcpSession {
    pub tournament_id: Id,
    pub qbtcp_room_id: Id,
    pub client_id: String,
    pub protocol_version: String,
    pub capabilities: Value,
    pub token_digest: String,
    pub status: String,
    pub paired_at: UnixTimestamp,
    pub expires_at: Option<UnixTimestamp>,
}
