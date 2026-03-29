-- Migration 004: reminder engine state and config

CREATE TABLE IF NOT EXISTS ticket_reminder_state (
  ticket_id INT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  last_reminded_at TIMESTAMPTZ,
  next_reminder_at TIMESTAMPTZ,
  reminder_stage INT NOT NULL DEFAULT 0,
  snooze_until TIMESTAMPTZ,
  last_ticket_updated_at TIMESTAMPTZ,
  last_delivery_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_reminder_state_next
  ON ticket_reminder_state(next_reminder_at);

INSERT INTO app_config (key, value) VALUES
  ('reminder_base_url', ''),
  ('reminder_threshold_hours_urgent', '4'),
  ('reminder_threshold_hours_normal', '24'),
  ('reminder_threshold_hours_long_term', '168'),
  ('reminder_repeat_hours_urgent', '24'),
  ('reminder_repeat_hours_normal', '48'),
  ('reminder_repeat_hours_long_term', '168')
ON CONFLICT (key) DO NOTHING;
