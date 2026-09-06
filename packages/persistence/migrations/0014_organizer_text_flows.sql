CREATE TABLE IF NOT EXISTS organizer_text_flows (
  actor_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  reference TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT organizer_text_flows_kind_check CHECK (
    kind IN ('PAYMENT', 'ATTENDANCE', 'TEMPLATE', 'GAME_CREATION', 'GAME_EDIT')
  )
);

CREATE INDEX IF NOT EXISTS organizer_text_flows_group_idx
  ON organizer_text_flows(group_id, updated_at);
