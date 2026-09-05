ALTER TABLE game_templates
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_pin_failed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'game_templates_revision_check'
  ) THEN
    ALTER TABLE game_templates
      ADD CONSTRAINT game_templates_revision_check CHECK (revision >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'games_revision_check'
  ) THEN
    ALTER TABLE games
      ADD CONSTRAINT games_revision_check CHECK (revision >= 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS game_templates_active_name_unique
  ON game_templates (group_id, LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS organizer_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_wizard_drafts (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, actor_user_id)
);
