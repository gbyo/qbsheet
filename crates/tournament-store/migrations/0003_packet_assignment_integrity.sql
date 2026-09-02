-- Migration 0001 shipped a nullable composite primary key and did not add a
-- foreign key for scheduled_game_id. Rebuild the table after scheduled_games
-- exists so the target invariants are enforced by SQLite itself.

CREATE TABLE packet_assignment_migration_quarantine (
    id INTEGER PRIMARY KEY,
    legacy_rowid INTEGER NOT NULL,
    packet_id TEXT,
    round_id TEXT,
    scheduled_game_id TEXT,
    assigned_at INTEGER,
    reason TEXT NOT NULL,
    quarantined_at INTEGER NOT NULL
);

ALTER TABLE packet_assignments RENAME TO packet_assignments_legacy;

-- Keep legacy rows that cannot be represented by the constrained table. A
-- failed or ambiguous reference must remain available for recovery/audit
-- rather than being silently discarded during the upgrade.
WITH invalid AS (
    SELECT
        legacy.rowid AS legacy_rowid,
        legacy.packet_id,
        legacy.round_id,
        legacy.scheduled_game_id,
        legacy.assigned_at,
        CASE
            WHEN NOT EXISTS (
                SELECT 1 FROM packets AS packet WHERE packet.id = legacy.packet_id
            ) THEN 'packet_id does not reference an existing packet'
            WHEN legacy.round_id IS NULL AND legacy.scheduled_game_id IS NULL
                THEN 'assignment has no target'
            WHEN legacy.round_id IS NOT NULL AND legacy.scheduled_game_id IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM rounds AS round WHERE round.id = legacy.round_id
                ) THEN 'round_id does not reference an existing round'
            WHEN legacy.round_id IS NULL AND legacy.scheduled_game_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM scheduled_games AS game
                    WHERE game.id = legacy.scheduled_game_id
                ) THEN 'scheduled_game_id does not reference an existing scheduled game'
            WHEN legacy.round_id IS NOT NULL AND legacy.scheduled_game_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM scheduled_games AS game
                    WHERE game.id = legacy.scheduled_game_id
                      AND game.round_id = legacy.round_id
                ) THEN 'round_id and scheduled_game_id do not identify the same round'
            ELSE NULL
        END AS reason
    FROM packet_assignments_legacy AS legacy
)
INSERT INTO packet_assignment_migration_quarantine
    (legacy_rowid, packet_id, round_id, scheduled_game_id, assigned_at, reason, quarantined_at)
SELECT legacy_rowid, packet_id, round_id, scheduled_game_id, assigned_at, reason,
       CAST(strftime('%s', 'now') AS INTEGER)
FROM invalid
WHERE reason IS NOT NULL;

-- A nullable legacy primary key could contain duplicate packet/round or
-- packet/game targets. It could also contain multiple packets for one game.
-- Preserve the extra copies before retaining the first row for each target.
WITH valid AS (
    SELECT
        legacy.rowid AS legacy_rowid,
        legacy.packet_id,
        legacy.round_id,
        legacy.scheduled_game_id,
        legacy.assigned_at
    FROM packet_assignments_legacy AS legacy
    WHERE EXISTS (
        SELECT 1 FROM packets AS packet WHERE packet.id = legacy.packet_id
    )
      AND (
          (
              legacy.round_id IS NOT NULL
              AND legacy.scheduled_game_id IS NULL
              AND EXISTS (
                  SELECT 1 FROM rounds AS round WHERE round.id = legacy.round_id
              )
          )
          OR (
              legacy.round_id IS NULL
              AND legacy.scheduled_game_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM scheduled_games AS game
                  WHERE game.id = legacy.scheduled_game_id
              )
          )
          OR (
              legacy.round_id IS NOT NULL
              AND legacy.scheduled_game_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM scheduled_games AS game
                  WHERE game.id = legacy.scheduled_game_id
                    AND game.round_id = legacy.round_id
              )
          )
      )
)
INSERT INTO packet_assignment_migration_quarantine
    (legacy_rowid, packet_id, round_id, scheduled_game_id, assigned_at, reason, quarantined_at)
SELECT current.legacy_rowid, current.packet_id, current.round_id, current.scheduled_game_id,
       current.assigned_at, 'duplicate packet or scheduled-game target assignment',
       CAST(strftime('%s', 'now') AS INTEGER)
FROM valid AS current
WHERE EXISTS (
    SELECT 1
    FROM valid AS earlier
    WHERE earlier.legacy_rowid < current.legacy_rowid
      AND (
          (
              current.scheduled_game_id IS NOT NULL
              AND earlier.scheduled_game_id = current.scheduled_game_id
          )
          OR (
              earlier.packet_id = current.packet_id
              AND current.scheduled_game_id IS NULL
              AND earlier.scheduled_game_id IS NULL
              AND earlier.round_id = current.round_id
          )
      )
);

CREATE TABLE packet_assignments (
    packet_id TEXT NOT NULL REFERENCES packets(id) ON DELETE CASCADE,
    round_id TEXT REFERENCES rounds(id) ON DELETE CASCADE,
    scheduled_game_id TEXT REFERENCES scheduled_games(id) ON DELETE CASCADE,
    assigned_at INTEGER NOT NULL,
    CHECK ((round_id IS NOT NULL) <> (scheduled_game_id IS NOT NULL))
);

-- Store the more specific scheduled-game target as the canonical target when
-- upgrading legacy rows that redundantly carried both round and game IDs.
WITH valid AS (
    SELECT
        legacy.rowid AS legacy_rowid,
        legacy.packet_id,
        legacy.round_id,
        legacy.scheduled_game_id,
        legacy.assigned_at
    FROM packet_assignments_legacy AS legacy
    WHERE EXISTS (
        SELECT 1 FROM packets AS packet WHERE packet.id = legacy.packet_id
    )
      AND (
          (
              legacy.round_id IS NOT NULL
              AND legacy.scheduled_game_id IS NULL
              AND EXISTS (
                  SELECT 1 FROM rounds AS round WHERE round.id = legacy.round_id
              )
          )
          OR (
              legacy.round_id IS NULL
              AND legacy.scheduled_game_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM scheduled_games AS game
                  WHERE game.id = legacy.scheduled_game_id
              )
          )
          OR (
              legacy.round_id IS NOT NULL
              AND legacy.scheduled_game_id IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM scheduled_games AS game
                  WHERE game.id = legacy.scheduled_game_id
                    AND game.round_id = legacy.round_id
              )
          )
      )
), canonical AS (
    SELECT current.*
    FROM valid AS current
    WHERE NOT EXISTS (
        SELECT 1
        FROM valid AS earlier
        WHERE earlier.legacy_rowid < current.legacy_rowid
          AND (
              (
                  current.scheduled_game_id IS NOT NULL
                  AND earlier.scheduled_game_id = current.scheduled_game_id
              )
              OR (
                  earlier.packet_id = current.packet_id
                  AND current.scheduled_game_id IS NULL
                  AND earlier.scheduled_game_id IS NULL
                  AND earlier.round_id = current.round_id
              )
          )
    )
)
INSERT INTO packet_assignments (packet_id, round_id, scheduled_game_id, assigned_at)
SELECT packet_id,
       CASE WHEN scheduled_game_id IS NULL THEN round_id ELSE NULL END,
       scheduled_game_id,
       assigned_at
FROM canonical;

CREATE UNIQUE INDEX packet_assignments_packet_round_unique
    ON packet_assignments(packet_id, round_id)
    WHERE round_id IS NOT NULL;

CREATE UNIQUE INDEX packet_assignments_packet_game_unique
    ON packet_assignments(packet_id, scheduled_game_id)
    WHERE scheduled_game_id IS NOT NULL;

-- A scheduled game has one packet slot, so it cannot have two assignment
-- rows with different packet IDs.
CREATE UNIQUE INDEX packet_assignments_scheduled_game_unique
    ON packet_assignments(scheduled_game_id)
    WHERE scheduled_game_id IS NOT NULL;

DROP TABLE packet_assignments_legacy;
