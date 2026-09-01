BEGIN;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

INSERT INTO volley_schema_migrations (name)
VALUES ('0006_outbox_leases')
ON CONFLICT (name) DO NOTHING;

COMMIT;
