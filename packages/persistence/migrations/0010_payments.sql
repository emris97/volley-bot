CREATE TABLE IF NOT EXISTS payment_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_revision INTEGER NOT NULL,
  total_amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  rounding_mode TEXT NOT NULL,
  finalized_settlement_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_drafts_attendance_revision_check
    CHECK (attendance_revision > 0),
  CONSTRAINT payment_drafts_total_amount_check
    CHECK (total_amount ~ '^[0-9]+(\.[0-9]{1,2})?$'),
  CONSTRAINT payment_drafts_currency_check CHECK (currency IN ('RUB')),
  CONSTRAINT payment_drafts_rounding_mode_check
    CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50'))
);

CREATE INDEX IF NOT EXISTS payment_drafts_group_expires_idx
  ON payment_drafts(group_id, expires_at);

ALTER TABLE payment_drafts
  ADD COLUMN IF NOT EXISTS finalized_settlement_id UUID;

CREATE TABLE IF NOT EXISTS payment_input_sessions (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_revision INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rounding_mode TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_input_sessions_actor_unique UNIQUE (actor_user_id),
  CONSTRAINT payment_input_sessions_attendance_revision_check
    CHECK (attendance_revision > 0),
  CONSTRAINT payment_input_sessions_currency_check CHECK (currency IN ('RUB')),
  CONSTRAINT payment_input_sessions_rounding_mode_check
    CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50'))
);

CREATE INDEX IF NOT EXISTS payment_input_sessions_group_expires_idx
  ON payment_input_sessions(group_id, expires_at);

CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  attendance_snapshot_id UUID NOT NULL REFERENCES attendance_snapshots(id) ON DELETE RESTRICT,
  attendance_revision INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  total_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  rounding_mode TEXT NOT NULL,
  allocation_order JSONB NOT NULL,
  collected_minor BIGINT NOT NULL,
  surplus_minor BIGINT NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlements_game_revision_unique UNIQUE (game_id, revision),
  CONSTRAINT settlements_revision_check CHECK (revision > 0),
  CONSTRAINT settlements_attendance_revision_check CHECK (attendance_revision > 0),
  CONSTRAINT settlements_amounts_check CHECK (
    total_minor >= 0 AND collected_minor >= 0 AND surplus_minor >= 0
    AND collected_minor = total_minor + surplus_minor
  ),
  CONSTRAINT settlements_currency_check CHECK (currency IN ('RUB')),
  CONSTRAINT settlements_rounding_mode_check
    CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50'))
);

CREATE INDEX IF NOT EXISTS settlements_group_game_revision_idx
  ON settlements(group_id, game_id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_active_game_unique
  ON settlements(game_id) WHERE superseded_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_drafts_finalized_settlement_fk'
  ) THEN
    ALTER TABLE payment_drafts
      ADD CONSTRAINT payment_drafts_finalized_settlement_fk
      FOREIGN KEY (finalized_settlement_id)
      REFERENCES settlements(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS settlement_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id UUID NOT NULL REFERENCES settlements(id) ON DELETE RESTRICT,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  participant_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  added_manually BOOLEAN NOT NULL,
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNPAID',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_charges_settlement_participant_unique
    UNIQUE (settlement_id, participant_ref),
  CONSTRAINT settlement_charges_amount_check CHECK (amount_minor >= 0),
  CONSTRAINT settlement_charges_status_check
    CHECK (status IN ('UNPAID', 'PAID', 'WAIVED'))
);

CREATE INDEX IF NOT EXISTS settlement_charges_group_settlement_idx
  ON settlement_charges(group_id, settlement_id);

CREATE TABLE IF NOT EXISTS charge_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  charge_id UUID NOT NULL REFERENCES settlement_charges(id) ON DELETE RESTRICT,
  previous_status TEXT,
  status TEXT NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT charge_status_events_previous_status_check CHECK (
    previous_status IS NULL OR previous_status IN ('UNPAID', 'PAID', 'WAIVED')
  ),
  CONSTRAINT charge_status_events_status_check
    CHECK (status IN ('UNPAID', 'PAID', 'WAIVED'))
);

CREATE INDEX IF NOT EXISTS charge_status_events_group_charge_occurred_idx
  ON charge_status_events(group_id, charge_id, occurred_at);
