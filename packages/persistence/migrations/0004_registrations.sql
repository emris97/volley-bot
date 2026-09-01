BEGIN;

CREATE TABLE IF NOT EXISTS registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  guest_display_name TEXT,
  inviter_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  membership_priority INTEGER NOT NULL,
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  manual_rank INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT registrations_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT registrations_identity_check CHECK (
    (kind = 'MEMBER' AND user_id IS NOT NULL AND guest_display_name IS NULL) OR
    (kind = 'GUEST' AND user_id IS NULL AND guest_display_name IS NOT NULL AND inviter_user_id IS NOT NULL)
  ),
  CONSTRAINT registrations_state_check CHECK (state IN ('TENTATIVE', 'ROSTERED', 'WAITLISTED', 'CANCELLED')),
  CONSTRAINT registrations_kind_check CHECK (kind IN ('MEMBER', 'GUEST')),
  CONSTRAINT registrations_confirmation_check CHECK (
    (state = 'TENTATIVE' AND confirmed_at IS NULL) OR state <> 'TENTATIVE'
  )
);

CREATE INDEX IF NOT EXISTS registrations_group_game_idx
  ON registrations(group_id, game_id);

CREATE UNIQUE INDEX IF NOT EXISTS registrations_active_user_game_unique
  ON registrations(game_id, user_id)
  WHERE user_id IS NOT NULL AND state <> 'CANCELLED';

INSERT INTO volley_schema_migrations (name)
VALUES ('0004_registrations')
ON CONFLICT (name) DO NOTHING;

COMMIT;
