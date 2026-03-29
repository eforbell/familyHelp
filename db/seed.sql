-- familyHelp seed data

INSERT INTO family_members (name, role, avatar_emoji) VALUES
  ('Eric',   'parent', '👨'),
  ('Alex',    'parent', '👩'),
  ('Jordan',   'kid',    '🧑'),
  ('Casey', 'kid',    '👧')
ON CONFLICT DO NOTHING;

INSERT INTO ticket_categories (name, guidance, ai_eligible, sort_order) VALUES
  ('IT / Tech',          'Describe what you see on screen, what you expected to happen, and what you already tried.', TRUE,  1),
  ('Homework',           'What subject? What specific problem or concept are you stuck on? Show your work so far.', TRUE,  2),
  ('Chores',             'What needs to be done, where, and by when?', FALSE, 3),
  ('House Maintenance',  'Describe the issue, where in the house, and how urgent it is. Include photos if possible.', FALSE, 4),
  ('Errands',            'What needs to happen, where, and any deadlines?', FALSE, 5),
  ('Other',              'Give as much detail as you can so someone can help.', FALSE, 6)
ON CONFLICT (name) DO NOTHING;

INSERT INTO app_config (key, value) VALUES
  ('magic_help_enabled', 'false'),
  ('magic_help_prompt', 'You are a helpful family assistant. For IT issues, provide clear troubleshooting steps. For homework, explain concepts and guide toward the answer without giving it directly. For house issues, provide practical advice but recommend a professional for anything involving electricity, plumbing, or structural work. Keep responses concise and friendly.'),
  ('reminders_enabled', 'false'),
  ('reminder_brrr_interruption_level', 'active'),
  ('reminder_base_url', ''),
  ('reminder_threshold_hours_urgent', '4'),
  ('reminder_threshold_hours_normal', '24'),
  ('reminder_threshold_hours_long_term', '168'),
  ('reminder_repeat_hours_urgent', '24'),
  ('reminder_repeat_hours_normal', '48'),
  ('reminder_repeat_hours_long_term', '168')
ON CONFLICT (key) DO NOTHING;
