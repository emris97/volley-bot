BEGIN;

SELECT pg_advisory_xact_lock(hashtext('volley-bot:schema-migrations'));

CREATE TABLE IF NOT EXISTS volley_schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL,
  display_name TEXT,
  dm_available_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_telegram_user_id_unique UNIQUE (telegram_user_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  onboarding_state TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_telegram_chat_id_unique UNIQUE (telegram_chat_id),
  CONSTRAINT groups_onboarding_state_check
    CHECK (onboarding_state IN ('PENDING', 'CONFIGURING', 'CONFIGURED'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  membership_status TEXT NOT NULL DEFAULT 'ACTIVE',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_members_role_check
    CHECK (role IN ('OWNER', 'ADMIN', 'ORGANIZER', 'MEMBER')),
  CONSTRAINT group_members_membership_status_check
    CHECK (membership_status IN ('ACTIVE', 'LEFT', 'BANNED'))
);

CREATE INDEX IF NOT EXISTS group_members_user_id_idx
  ON group_members(user_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_group_created_at_idx
  ON audit_events(group_id, created_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx
  ON outbox_events(occurred_at)
  WHERE published_at IS NULL;

INSERT INTO volley_schema_migrations (name)
VALUES ('0001_foundation')
ON CONFLICT (name) DO NOTHING;

COMMIT;
