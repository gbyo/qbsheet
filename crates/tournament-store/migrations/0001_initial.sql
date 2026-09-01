CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    abbreviation TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    short_name TEXT,
    organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    location TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    team_letter TEXT,
    seed INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (tournament_id, name, team_letter)
);

CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    graduation_year INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'registered',
    seed INTEGER,
    notes TEXT,
    registered_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (tournament_id, team_id)
);

CREATE TABLE IF NOT EXISTS team_players (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    captain INTEGER NOT NULL DEFAULT 0 CHECK (captain IN (0, 1)),
    roster_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, player_id)
);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    building TEXT,
    floor TEXT,
    accessible INTEGER NOT NULL DEFAULT 0 CHECK (accessible IN (0, 1)),
    directions TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (tournament_id, name)
);

CREATE TABLE IF NOT EXISTS staff (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    availability_json TEXT NOT NULL DEFAULT '{}',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_staff_assignments (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    PRIMARY KEY (room_id, staff_id, role)
);

CREATE TABLE IF NOT EXISTS room_equipment_assignments (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    equipment_id TEXT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    PRIMARY KEY (room_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS phases (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phase_type TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    rules_json TEXT NOT NULL DEFAULT '{}',
    advancement_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (tournament_id, sequence)
);

CREATE TABLE IF NOT EXISTS pools (
    id TEXT PRIMARY KEY NOT NULL,
    phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    rules_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (phase_id, sequence)
);

CREATE TABLE IF NOT EXISTS phase_teams (
    phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    pool_id TEXT REFERENCES pools(id) ON DELETE SET NULL,
    seed INTEGER,
    standing INTEGER,
    PRIMARY KEY (phase_id, team_id)
);

CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    phase_id TEXT NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    round_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (phase_id, sequence),
    UNIQUE (tournament_id, round_number)
);

CREATE TABLE IF NOT EXISTS packets (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    packet_type TEXT NOT NULL DEFAULT 'regular',
    status TEXT NOT NULL DEFAULT 'available',
    nominal_round_id TEXT REFERENCES rounds(id) ON DELETE SET NULL,
    replacement_for_id TEXT REFERENCES packets(id) ON DELETE SET NULL,
    security_notes TEXT,
    used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS packet_assignments (
    packet_id TEXT PRIMARY KEY NOT NULL REFERENCES packets(id) ON DELETE CASCADE,
    round_id TEXT UNIQUE REFERENCES rounds(id) ON DELETE CASCADE,
    scheduled_game_id TEXT UNIQUE REFERENCES scheduled_games(id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL,
    CHECK ((round_id IS NOT NULL) <> (scheduled_game_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS scheduled_games (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
    packet_id TEXT REFERENCES packets(id) ON DELETE SET NULL,
    team_a_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    team_b_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    game_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (team_a_id IS NULL OR team_b_id IS NULL OR team_a_id <> team_b_id),
    UNIQUE (round_id, game_number)
);

CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    scheduled_game_id TEXT UNIQUE REFERENCES scheduled_games(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    team_a_score INTEGER,
    team_b_score INTEGER,
    winner_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
    result_type TEXT,
    notes TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    accepted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_player_stats (
    id TEXT PRIMARY KEY NOT NULL,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    player_id TEXT,
    tossups_heard INTEGER NOT NULL DEFAULT 0,
    powers INTEGER NOT NULL DEFAULT 0,
    gets INTEGER NOT NULL DEFAULT 0,
    negs INTEGER NOT NULL DEFAULT 0,
    bonus_points INTEGER NOT NULL DEFAULT 0,
    bonuses_heard INTEGER NOT NULL DEFAULT 0,
    bouncebacks INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS result_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    qbtcp_session_id TEXT,
    fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    submitted_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    review_note TEXT,
    UNIQUE (tournament_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS protests (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    game_id TEXT REFERENCES games(id) ON DELETE SET NULL,
    submitted_by TEXT,
    issue TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    ruling TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    actor TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS application_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS qbtcp_rooms (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL,
    pairing_code TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (tournament_id, room_code)
);

CREATE TABLE IF NOT EXISTS qbtcp_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    qbtcp_room_id TEXT NOT NULL REFERENCES qbtcp_rooms(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    protocol_version TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    token_digest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paired',
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS teams_tournament_status_idx
    ON teams(tournament_id, status, seed);
CREATE INDEX IF NOT EXISTS players_tournament_idx
    ON players(tournament_id, name);
CREATE INDEX IF NOT EXISTS registrations_tournament_status_idx
    ON registrations(tournament_id, status, seed);
CREATE INDEX IF NOT EXISTS rooms_tournament_status_idx
    ON rooms(tournament_id, status, name);
CREATE INDEX IF NOT EXISTS phases_tournament_sequence_idx
    ON phases(tournament_id, sequence);
CREATE INDEX IF NOT EXISTS phase_teams_pool_idx
    ON phase_teams(phase_id, pool_id, seed);
CREATE INDEX IF NOT EXISTS rounds_tournament_status_idx
    ON rounds(tournament_id, status, round_number);
CREATE INDEX IF NOT EXISTS scheduled_games_round_room_idx
    ON scheduled_games(round_id, room_id, status);
CREATE INDEX IF NOT EXISTS scheduled_games_team_idx
    ON scheduled_games(team_a_id, team_b_id, round_id);
CREATE INDEX IF NOT EXISTS games_tournament_status_idx
    ON games(tournament_id, status, accepted_at);
CREATE INDEX IF NOT EXISTS result_submissions_review_idx
    ON result_submissions(tournament_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS protests_status_idx
    ON protests(tournament_id, status, created_at);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx
    ON audit_events(tournament_id, entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS qbtcp_sessions_room_status_idx
    ON qbtcp_sessions(qbtcp_room_id, status, last_seen_at);
