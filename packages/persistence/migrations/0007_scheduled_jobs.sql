ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS confirmation_revision INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'registrations_confirmation_revision_check'
  ) THEN
    ALTER TABLE registrations
      ADD CONSTRAINT registrations_confirmation_revision_check
      CHECK (confirmation_revision >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  deterministic_job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schedule_revision INTEGER NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scheduled_jobs_game_deterministic_id_unique
    UNIQUE (game_id, deterministic_job_id),
  CONSTRAINT scheduled_jobs_kind_check CHECK (
    kind IN (
      'OPEN_REGISTRATION',
      'CLOSE_REGISTRATION',
      'REQUEST_TENTATIVE_CONFIRMATION',
      'EXPIRE_TENTATIVE',
      'REMIND_PARTICIPANTS'
    )
  ),
  CONSTRAINT scheduled_jobs_schedule_revision_check
    CHECK (schedule_revision >= 0)
);

CREATE INDEX IF NOT EXISTS scheduled_jobs_group_run_at_idx
  ON scheduled_jobs(group_id, run_at);

CREATE INDEX IF NOT EXISTS scheduled_jobs_pending_idx
  ON scheduled_jobs(run_at);
