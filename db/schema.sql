-- familyHelp schema

CREATE TABLE IF NOT EXISTS family_members (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent', 'kid')),
  avatar_emoji TEXT DEFAULT '👤',
  created_at TIMESTAMPTZ DEFAULT now(),
  suite_member_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS ticket_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  guidance TEXT,
  ai_eligible BOOLEAN DEFAULT FALSE,
  sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_id INT REFERENCES ticket_categories(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'normal', 'long-term')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in-progress', 'waiting', 'resolved', 'closed')),
  created_by INT NOT NULL REFERENCES family_members(id),
  assigned_to INT REFERENCES family_members(id),
  link_url TEXT,
  ai_suggestion TEXT,
  ai_helped BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id INT REFERENCES family_members(id),
  body TEXT NOT NULL,
  is_system BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_by ON tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id SERIAL PRIMARY KEY,
  ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id INT REFERENCES ticket_comments(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INT NOT NULL,
  uploaded_by INT REFERENCES family_members(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id);

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

CREATE INDEX IF NOT EXISTS idx_member_notification_channels_member ON member_notification_channels(member_id);

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

CREATE INDEX IF NOT EXISTS idx_ticket_reminder_state_next ON ticket_reminder_state(next_reminder_at);
