BEGIN;

CREATE TABLE IF NOT EXISTS attendance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  finalized BOOLEAN NOT NULL DEFAULT FALSE,
  excluded_registration_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  roster_candidates JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_snapshots_revision_check CHECK (revision > 0),
  CONSTRAINT attendance_snapshots_game_revision_unique UNIQUE (game_id, revision)
);

CREATE INDEX IF NOT EXISTS attendance_snapshots_group_game_revision_idx
  ON attendance_snapshots(group_id, game_id, revision);

ALTER TABLE attendance_snapshots
  ADD COLUMN IF NOT EXISTS roster_candidates JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE TABLE IF NOT EXISTS attendance_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES attendance_snapshots(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_ref TEXT NOT NULL,
  source_registration_id UUID REFERENCES registrations(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  billable BOOLEAN NOT NULL,
  added_manually BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_entries_snapshot_participant_unique
    UNIQUE (snapshot_id, participant_ref),
  CONSTRAINT attendance_entries_manual_source_check
    CHECK (
      (added_manually AND source_registration_id IS NULL)
      OR (NOT added_manually AND source_registration_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS attendance_entries_group_snapshot_idx
  ON attendance_entries(group_id, snapshot_id);

INSERT INTO volley_schema_migrations (name)
VALUES ('0009_attendance')
ON CONFLICT (name) DO NOTHING;

COMMIT;
