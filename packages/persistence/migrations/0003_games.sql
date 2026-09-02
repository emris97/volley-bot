CREATE TABLE IF NOT EXISTS game_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  address TEXT,
  starts_at_local_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  registration_opens_minutes_before INTEGER NOT NULL,
  registration_closes_minutes_before INTEGER,
  tentative_prompt_minutes_before INTEGER NOT NULL,
  tentative_response_minutes INTEGER NOT NULL,
  reminder_minutes_before INTEGER NOT NULL,
  member_priority_enabled BOOLEAN NOT NULL,
  default_total_cost_minor BIGINT,
  currency TEXT NOT NULL DEFAULT 'RUB',
  rounding_mode TEXT NOT NULL DEFAULT 'EXACT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_templates_capacity_check CHECK (capacity > 0),
  CONSTRAINT game_templates_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT game_templates_timing_check CHECK (
    registration_opens_minutes_before >= 0 AND
    (registration_closes_minutes_before IS NULL OR registration_closes_minutes_before >= 0) AND
    tentative_prompt_minutes_before >= 0 AND
    tentative_response_minutes >= 0 AND
    reminder_minutes_before >= 0
  ),
  CONSTRAINT game_templates_currency_check CHECK (currency IN ('RUB')),
  CONSTRAINT game_templates_rounding_mode_check CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50')),
  CONSTRAINT game_templates_cost_check CHECK (default_total_cost_minor IS NULL OR default_total_cost_minor >= 0)
);

CREATE INDEX IF NOT EXISTS game_templates_group_id_idx ON game_templates(group_id);

CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_template_id UUID REFERENCES game_templates(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  venue TEXT NOT NULL,
  address TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  time_zone TEXT NOT NULL,
  registration_opens_at TIMESTAMPTZ NOT NULL,
  registration_closes_at TIMESTAMPTZ,
  tentative_prompt_at TIMESTAMPTZ NOT NULL,
  tentative_response_deadline TIMESTAMPTZ NOT NULL,
  reminder_at TIMESTAMPTZ NOT NULL,
  member_priority_enabled BOOLEAN NOT NULL,
  total_cost_minor BIGINT,
  currency TEXT NOT NULL DEFAULT 'RUB',
  rounding_mode TEXT NOT NULL DEFAULT 'EXACT',
  state TEXT NOT NULL DEFAULT 'DRAFT',
  schedule_revision INTEGER NOT NULL DEFAULT 0,
  canonical_telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT games_capacity_check CHECK (capacity > 0),
  CONSTRAINT games_duration_check CHECK (duration_minutes > 0),
  CONSTRAINT games_state_check CHECK (state IN ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT games_schedule_revision_check CHECK (schedule_revision >= 0),
  CONSTRAINT games_currency_check CHECK (currency IN ('RUB')),
  CONSTRAINT games_rounding_mode_check CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50')),
  CONSTRAINT games_cost_check CHECK (total_cost_minor IS NULL OR total_cost_minor >= 0),
  CONSTRAINT games_time_order_check CHECK (
    registration_opens_at <= starts_at AND
    (registration_closes_at IS NULL OR
      (registration_closes_at >= registration_opens_at AND registration_closes_at <= starts_at)) AND
    tentative_prompt_at <= tentative_response_deadline AND
    tentative_response_deadline <= starts_at AND
    reminder_at <= starts_at
  )
);

CREATE INDEX IF NOT EXISTS games_group_starts_at_idx ON games(group_id, starts_at);
