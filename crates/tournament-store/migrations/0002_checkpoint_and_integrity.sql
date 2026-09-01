CREATE TABLE IF NOT EXISTS store_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    label TEXT NOT NULL,
    database_path TEXT,
    wal_pages INTEGER,
    wal_checkpointed INTEGER,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS store_checkpoints_created_idx
    ON store_checkpoints(created_at DESC);

CREATE INDEX IF NOT EXISTS result_submissions_game_status_idx
    ON result_submissions(game_id, status, submitted_at);

CREATE INDEX IF NOT EXISTS game_player_stats_game_team_idx
    ON game_player_stats(game_id, team_id, player_id);
