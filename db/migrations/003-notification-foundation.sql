-- Migration 003: reminders & notifications foundation

CREATE TABLE IF NOT EXISTS member_notification_channels (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('brrr')),
  label TEXT,
  target_secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_member_notification_channels_member
  ON member_notification_channels(member_id);

INSERT INTO app_config (key, value) VALUES
  ('reminders_enabled', 'false'),
  ('reminder_brrr_interruption_level', 'active')
ON CONFLICT (key) DO NOTHING;
