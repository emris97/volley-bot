CREATE TABLE IF NOT EXISTS game_creation_drafts (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_creation_drafts_pkey PRIMARY KEY (group_id, actor_user_id)
);

CREATE TABLE IF NOT EXISTS guest_registration_drafts (
  telegram_user_id BIGINT PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
