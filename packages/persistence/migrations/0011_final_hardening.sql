ALTER TABLE payment_drafts
  ADD COLUMN IF NOT EXISTS expected_active_settlement_id UUID,
  ADD COLUMN IF NOT EXISTS expected_active_settlement_revision INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_drafts_expected_active_settlement_fk'
  ) THEN
    ALTER TABLE payment_drafts
      ADD CONSTRAINT payment_drafts_expected_active_settlement_fk
      FOREIGN KEY (expected_active_settlement_id)
      REFERENCES settlements(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_drafts_expected_active_pair_check'
  ) THEN
    ALTER TABLE payment_drafts
      ADD CONSTRAINT payment_drafts_expected_active_pair_check CHECK (
        (expected_active_settlement_id IS NULL AND expected_active_settlement_revision IS NULL)
        OR
        (expected_active_settlement_id IS NOT NULL AND expected_active_settlement_revision IS NOT NULL)
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payment_reminder_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  charge_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_reminder_requests_group_key_unique
    UNIQUE (group_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS payment_reminder_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deterministic_job_id TEXT NOT NULL,
  charge_id UUID NOT NULL REFERENCES settlement_charges(id) ON DELETE RESTRICT,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  terminal_failure TEXT,
  CONSTRAINT payment_reminder_deliveries_job_charge_unique
    UNIQUE (deterministic_job_id, charge_id),
  CONSTRAINT payment_reminder_deliveries_terminal_failure_check CHECK (
    terminal_failure IS NULL
    OR terminal_failure IN ('NO_PRIVATE_RECIPIENT', 'PRIVATE_CHAT_UNAVAILABLE')
  )
);
