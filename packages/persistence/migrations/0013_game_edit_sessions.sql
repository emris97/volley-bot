CREATE TABLE IF NOT EXISTS game_edit_sessions (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  expected_game_revision INTEGER NOT NULL,
  selected_field TEXT NOT NULL,
  interaction_revision INTEGER NOT NULL DEFAULT 0,
  pending_changes JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_edit_sessions_pkey PRIMARY KEY (group_id, actor_user_id),
  CONSTRAINT game_edit_sessions_game_revision_check
    CHECK (expected_game_revision >= 0),
  CONSTRAINT game_edit_sessions_interaction_revision_check
    CHECK (interaction_revision >= 0),
  CONSTRAINT game_edit_sessions_selected_field_check CHECK (
    selected_field IN (
      'name',
      'venue',
      'address',
      'startsAt',
      'durationMinutes',
      'capacity',
      'registrationOpensAt',
      'registrationClosesAt',
      'tentativePromptAt',
      'tentativeResponseDeadline',
      'reminderAt',
      'memberPriorityEnabled',
      'totalCostMinor',
      'currency',
      'roundingMode'
    )
  )
);

CREATE INDEX IF NOT EXISTS game_edit_sessions_actor_updated_idx
  ON game_edit_sessions(actor_user_id, active, updated_at);
