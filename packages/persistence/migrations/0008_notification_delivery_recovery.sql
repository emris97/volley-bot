ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DROP INDEX IF EXISTS scheduled_jobs_pending_idx;

CREATE INDEX scheduled_jobs_pending_idx
  ON scheduled_jobs(run_at)
  WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deterministic_job_id TEXT NOT NULL,
  registration_id UUID NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT notification_deliveries_job_registration_unique
    UNIQUE (deterministic_job_id, registration_id)
);

ALTER TABLE notification_deliveries
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ALTER COLUMN delivered_at DROP NOT NULL,
  ALTER COLUMN delivered_at DROP DEFAULT;
