BEGIN;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS outbox_events_claimable_idx
  ON outbox_events(occurred_at)
  WHERE published_at IS NULL;

INSERT INTO volley_schema_migrations (name)
VALUES ('0006_outbox_leases')
ON CONFLICT (name) DO NOTHING;

COMMIT;
