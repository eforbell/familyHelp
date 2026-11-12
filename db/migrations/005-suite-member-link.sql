-- Migration 005: the household member each Family Help member is, in tailnet mode (Home Base suite identity).
-- A parent links them once on the link page. Unique: one household member is one Family Help member.

ALTER TABLE family_members ADD COLUMN IF NOT EXISTS suite_member_id TEXT UNIQUE;
