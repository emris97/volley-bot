ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS onboarding_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS member_priority_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tentative_prompt_minutes_before integer NOT NULL DEFAULT 1440,
  ADD COLUMN IF NOT EXISTS tentative_response_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS reminder_minutes_before integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'RUB',
  ADD COLUMN IF NOT EXISTS rounding_mode text NOT NULL DEFAULT 'EXACT',
  ADD COLUMN IF NOT EXISTS pin_game_messages boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_currency_check') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_currency_check CHECK (currency IN ('RUB'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_rounding_mode_check') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_rounding_mode_check CHECK (rounding_mode IN ('EXACT', 'UP_1', 'UP_10', 'UP_50'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_timing_values_check') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_timing_values_check CHECK (
      tentative_prompt_minutes_before >= 0 AND
      tentative_response_minutes >= 0 AND
      reminder_minutes_before >= 0
    );
  END IF;
END $$;
