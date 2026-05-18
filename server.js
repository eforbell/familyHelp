require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const { generateMagicHelp, followUpMagicHelp, hasOpenAI } = require('./lib/openai');
const { buildAssignedTicketNotificationPayload, sendBrrrNotification } = require('./lib/notifications');
const { getReminderConfig, ticketUrl } = require('./lib/reminder-rules');

const app = express();
const PORT = process.env.PORT || 3002;
const DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL = 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;600;700&display=swap';
const DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap';

function buildSovereignFontsCss() {
  const source = String(process.env.SOVEREIGN_FONT_SOURCE || 'google').trim().toLowerCase();
  if (source === 'off') return '/* Sovereign fonts disabled via SOVEREIGN_FONT_SOURCE=off */\n';

  const isLocal = source === 'local';
  const sansUrl = (isLocal ? process.env.SOVEREIGN_FONT_SANS_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_SANS_CSS_URL)
    || DEFAULT_SOVEREIGN_FONT_SANS_CSS_URL;
  const monoUrl = (isLocal ? process.env.SOVEREIGN_FONT_MONO_CSS_URL_LOCAL : process.env.SOVEREIGN_FONT_MONO_CSS_URL)
    || DEFAULT_SOVEREIGN_FONT_MONO_CSS_URL;

  return [
    '/* Generated from environment: /sovereign-fonts.css */',
    `@import url('${sansUrl}');`,
    `@import url('${monoUrl}');`,
    '',
  ].join('\n');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SETTINGS_SESSION_COOKIE = 'fh_settings_session';
const SETTINGS_SESSION_MINUTES = 480; // 8 hours
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());

// ── Config helpers ──────────────────────────────────────────────────────────

async function cfg(key, queryable = pool) {
  const r = await queryable.query('SELECT value FROM app_config WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}

async function setCfg(key, value, queryable = pool) {
  await queryable.query(
    'INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

// ── PIN auth helpers ────────────────────────────────────────────────────────

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPinAgainstHash(pin, encoded) {
  if (!encoded) return false;
  const [salt, expectedHex] = String(encoded).split(':');
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(pin), salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = value;
  }
  return out;
}

function signPayload(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readSignedPayload(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function settingsCookieOptions(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  return { httpOnly: true, sameSite: 'lax', secure: req.secure || forwardedProto === 'https', maxAge: SETTINGS_SESSION_MINUTES * 60 * 1000, path: '/' };
}

async function settingsPinConfigured(queryable = pool) {
  const hash = await cfg('settings_pin_hash', queryable);
  return !!hash;
}

async function settingsSessionInfo(req) {
  const cookies = parseCookies(req);
  const token = cookies[SETTINGS_SESSION_COOKIE];
  const configured = await settingsPinConfigured();
  if (!token) return { configured, unlocked: false };
  const [secret, version] = await Promise.all([cfg('settings_auth_secret'), cfg('settings_pin_version')]);
  const payload = readSignedPayload(token, secret);
  const now = Date.now();
  if (!payload || !payload.exp || !payload.ver || payload.exp <= now || String(payload.ver) !== String(version || '1')) return { configured, unlocked: false };
  return { configured, unlocked: true, expiresAt: payload.exp };
}

async function issueSettingsSession(req, res) {
  const [secret, version] = await Promise.all([cfg('settings_auth_secret'), cfg('settings_pin_version')]);
  const exp = Date.now() + (SETTINGS_SESSION_MINUTES * 60 * 1000);
  const token = signPayload({ exp, ver: String(version || '1') }, secret);
  res.cookie(SETTINGS_SESSION_COOKIE, token, settingsCookieOptions(req));
  return exp;
}

function clearSettingsSession(req, res) {
  res.clearCookie(SETTINGS_SESSION_COOKIE, settingsCookieOptions(req));
}

async function requireSettingsAuth(req, res, next) {
  try {
    const session = await settingsSessionInfo(req);
    if (!session.configured) return res.status(428).json({ error: 'Settings PIN not set up yet', code: 'pin_not_configured' });
    if (!session.unlocked) { clearSettingsSession(req, res); return res.status(401).json({ error: 'Settings PIN required', code: 'settings_locked' }); }
    return next();
  } catch (err) { return res.status(500).json({ error: err.message }); }
}

// ── Bootstrap PIN on first start ────────────────────────────────────────────

async function bootstrapPin() {
  const existing = await cfg('settings_pin_hash');
  if (existing) return;
  const envPin = process.env.SETTINGS_PIN;
  if (!envPin) { console.log('No SETTINGS_PIN in env and no PIN configured. Settings will require PIN setup.'); return; }
  const secret = crypto.randomBytes(32).toString('hex');
  await setCfg('settings_auth_secret', secret);
  await setCfg('settings_pin_hash', hashPin(envPin));
  await setCfg('settings_pin_version', '1');
  console.log('Settings PIN bootstrapped from environment.');
}

const DEFAULT_TICKET_CATEGORIES = [
  ['IT / Tech', 'Describe what you see on screen, what you expected to happen, and what you already tried.', true, 1],
  ['Homework', 'What subject? What specific problem or concept are you stuck on? Show your work so far.', true, 2],
  ['Chores', 'What needs to be done, where, and by when?', false, 3],
  ['House Maintenance', 'Describe the issue, where in the house, and how urgent it is. Include photos if possible.', false, 4],
  ['Errands', 'What needs to happen, where, and any deadlines?', false, 5],
  ['Other', 'Give as much detail as you can so someone can help.', false, 6],
];

const DEFAULT_APP_CONFIG = [
  ['magic_help_enabled', 'false'],
  ['magic_help_prompt', 'You are a helpful family assistant. For IT issues, provide clear troubleshooting steps. For homework, explain concepts and guide toward the answer without giving it directly. For house issues, provide practical advice but recommend a professional for anything involving electricity, plumbing, or structural work. Keep responses concise and friendly.'],
  ['reminders_enabled', 'false'],
  ['reminder_brrr_interruption_level', 'active'],
  ['reminder_base_url', ''],
  ['reminder_threshold_hours_urgent', '4'],
  ['reminder_threshold_hours_normal', '24'],
  ['reminder_threshold_hours_long_term', '168'],
  ['reminder_repeat_hours_urgent', '24'],
  ['reminder_repeat_hours_normal', '48'],
  ['reminder_repeat_hours_long_term', '168'],
];

async function memberCount(queryable = pool) {
  const { rows } = await queryable.query('SELECT COUNT(*)::int AS count FROM family_members');
  return Number(rows[0]?.count || 0);
}

async function categoryCount(queryable = pool) {
  const { rows } = await queryable.query('SELECT COUNT(*)::int AS count FROM ticket_categories');
  return Number(rows[0]?.count || 0);
}

async function bootstrapState(queryable = pool) {
  const [members, categories, pinConfigured] = await Promise.all([
    memberCount(queryable),
    categoryCount(queryable),
    settingsPinConfigured(queryable),
  ]);
  const needsHousehold = members === 0;
  const needsAuth = !pinConfigured;
  const needsStarterContent = categories === 0;
  return {
    status: needsHousehold || needsAuth || needsStarterContent ? 'needs_setup' : 'ready',
    app: 'family-help',
    version: '1.0.0',
    bootstrap: {
      needs_household: needsHousehold,
      needs_auth: needsAuth,
      needs_starter_content: needsStarterContent,
      ready: !needsHousehold && !needsAuth && !needsStarterContent,
    },
    counts: {
      family_members: members,
      ticket_categories: categories,
    },
  };
}

async function withPoolTransaction(fn) {
  if (typeof pool.connect !== 'function') return fn(pool);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

const BOOTSTRAP_PARENT_AVATARS = ['👨', '👩', '🧑'];
const BOOTSTRAP_KID_AVATARS = ['🧒', '👧', '👦'];

function normalizeBootstrapMembers(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  let parentIndex = 0;
  let kidIndex = 0;

  return input
    .map(member => ({
      name: String(member?.name || '').trim(),
      role: member?.role === 'kid' ? 'kid' : 'parent',
    }))
    .filter(member => member.name)
    .filter(member => {
      const key = member.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(member => {
      const index = member.role === 'parent' ? parentIndex++ : kidIndex++;
      const avatars = member.role === 'parent' ? BOOTSTRAP_PARENT_AVATARS : BOOTSTRAP_KID_AVATARS;
      return { ...member, avatar_emoji: avatars[index % avatars.length] };
    });
}

async function installStarterContent(queryable = pool) {
  for (const [name, guidance, aiEligible, sortOrder] of DEFAULT_TICKET_CATEGORIES) {
    await queryable.query(
      `INSERT INTO ticket_categories (name, guidance, ai_eligible, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (name) DO NOTHING`,
      [name, guidance, aiEligible, sortOrder]
    );
  }

  for (const [key, value] of DEFAULT_APP_CONFIG) {
    await queryable.query(
      `INSERT INTO app_config (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

async function bootstrapSetupFromEnv() {
  await bootstrapPin();
}

async function redirectToSetupIfNeeded(req, res, target = 'setup') {
  try {
    const state = await bootstrapState();
    if (state.bootstrap.needs_household) {
      res.redirect(target);
      return true;
    }
    return false;
  } catch (err) {
    res.status(500).json({ error: err.message });
    return true;
  }
}

const PAGE_BOOTSTRAP_TARGETS = new Map([
  ['/', 'setup'],
  ['/index.html', 'setup'],
  ['/new', 'setup'],
  ['/new.html', 'setup'],
  ['/board', 'setup'],
  ['/board.html', 'setup'],
  ['/settings', 'setup'],
  ['/settings.html', 'setup'],
]);

app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/setup' || req.path === '/setup.html') return next();
  if (req.path.startsWith('/uploads/')) return next();
  if (req.path.startsWith('/ticket/')) {
    if (await redirectToSetupIfNeeded(req, res, '../setup')) return;
    return next();
  }

  const target = PAGE_BOOTSTRAP_TARGETS.get(req.path);
  if (!target) return next();
  if (await redirectToSetupIfNeeded(req, res, target)) return;
  return next();
});

app.get('/sovereign-fonts.css', (_req, res) => {
  res.set('content-type', 'text/css; charset=utf-8');
  res.set('cache-control', 'public, max-age=300');
  res.send(buildSovereignFontsCss());
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Touch updated_at helper ─────────────────────────────────────────────────

async function touchTicket(id) {
  await pool.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [id]);
}

async function addSystemComment(ticketId, body) {
  await pool.query('INSERT INTO ticket_comments (ticket_id, body, is_system) VALUES ($1, $2, TRUE)', [ticketId, body]);
}

async function memberById(id) {
  if (!id) return null;
  const r = await pool.query('SELECT id, name, role FROM family_members WHERE id = $1', [id]);
  return r.rows[0] || null;
}

function maskSecret(secret) {
  if (!secret) return null;
  const value = String(secret).trim();
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

async function sendAssignedTicketNotification(ticket, actorName, assigneeId) {
  if (!assigneeId) return false;

  const [{ rows: channelRows }, reminderBaseUrl, reminderInterruptionLevel] = await Promise.all([
    pool.query(`
      SELECT target_secret
      FROM member_notification_channels
      WHERE member_id = $1
        AND channel_type = 'brrr'
        AND enabled = TRUE
        AND target_secret IS NOT NULL
    `, [assigneeId]),
    cfg('reminder_base_url'),
    cfg('reminder_brrr_interruption_level')
  ]);

  const targetSecret = channelRows[0]?.target_secret;
  if (!targetSecret) return false;

  const reminderConfig = getReminderConfig({
    reminder_base_url: reminderBaseUrl,
    reminder_brrr_interruption_level: reminderInterruptionLevel
  });

  const payload = buildAssignedTicketNotificationPayload(ticket, {
    actorName,
    defaultInterruptionLevel: reminderConfig.interruptionLevel,
    openUrl: ticketUrl(ticket.id, reminderConfig)
  });

  await sendBrrrNotification(targetSecret, payload);
  return true;
}

async function canMemberViewTicket(ticketId, memberId) {
  const member = await memberById(memberId);
  if (!member) return { ok: false, code: 400, error: 'Valid member_id is required' };
  if (member.role === 'parent') return { ok: true, member };

  const t = await pool.query('SELECT id FROM tickets WHERE id = $1 AND (created_by = $2 OR assigned_to = $2)', [ticketId, memberId]);
  if (!t.rows.length) return { ok: false, code: 403, error: 'Not authorized for this ticket' };
  return { ok: true, member };
}

async function canManageTicketReminders(ticketId, memberId) {
  const member = await memberById(memberId);
  if (!member) return { ok: false, code: 400, error: 'Valid member_id is required' };
  if (member.role === 'parent') return { ok: true, member };

  const r = await pool.query('SELECT assigned_to FROM tickets WHERE id = $1', [ticketId]);
  if (!r.rows.length) return { ok: false, code: 404, error: 'Ticket not found' };
  if (String(r.rows[0].assigned_to || '') !== String(memberId)) {
    return { ok: false, code: 403, error: 'Only the assignee or a parent can manage reminder snooze' };
  }
  return { ok: true, member };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── Health / readiness / bootstrap ─────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'family-help',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      app: 'family-help',
      checks: { db: 'ok' },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      app: 'family-help',
      checks: { db: 'error' },
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/bootstrap', async (_req, res) => {
  try {
    res.json(await bootstrapState());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bootstrap/starter-content', async (_req, res) => {
  try {
    if ((await categoryCount()) > 0) {
      return res.status(409).json({ error: 'Starter content already installed', code: 'starter_content_exists' });
    }
    await withPoolTransaction(installStarterContent);
    res.status(201).json({ ok: true, bootstrap: (await bootstrapState()).bootstrap });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bootstrap/household', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (!state.bootstrap.needs_household) {
      return res.status(409).json({ error: 'Household already initialized', code: 'household_already_initialized' });
    }

    const members = normalizeBootstrapMembers(req.body?.members);
    const pin = String(req.body?.settings_pin || '').trim();
    const installStarter = req.body?.install_starter_content !== false;

    if (!members.length) {
      return res.status(400).json({ error: 'At least one household member is required', code: 'members_required' });
    }
    if (!members.some(member => member.role === 'parent')) {
      return res.status(400).json({ error: 'At least one parent is required', code: 'parent_required' });
    }
    if (pin && pin.length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 characters', code: 'invalid_pin' });
    }

    const result = await withPoolTransaction(async (queryable) => {
      const createdMembers = [];
      for (const member of members) {
        const { rows } = await queryable.query(`
          INSERT INTO family_members (name, role, avatar_emoji)
          VALUES ($1, $2, $3)
          RETURNING id, name, role, avatar_emoji
        `, [member.name, member.role, member.avatar_emoji]);
        createdMembers.push(rows[0]);
      }

      const pinWasConfigured = await settingsPinConfigured(queryable);
      if (pin && !pinWasConfigured) {
        await setCfg('settings_auth_secret', crypto.randomBytes(32).toString('hex'), queryable);
        await setCfg('settings_pin_hash', hashPin(pin), queryable);
        await setCfg('settings_pin_version', '1', queryable);
      }

      if (installStarter) {
        await installStarterContent(queryable);
      }

      return {
        members: createdMembers,
        pin_configured: pin ? true : pinWasConfigured,
      };
    });

    if (pin) {
      await issueSettingsSession(req, res);
    }

    res.status(201).json({
      ok: true,
      created_members: result.members,
      pin_configured: result.pin_configured,
      bootstrap: (await bootstrapState()).bootstrap,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Members ─────────────────────────────────────────────────────────────────

app.get('/api/members', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, role, avatar_emoji FROM family_members ORDER BY id');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Categories ──────────────────────────────────────────────────────────────

app.get('/api/categories', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, guidance, ai_eligible FROM ticket_categories ORDER BY sort_order');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Tickets ─────────────────────────────────────────────────────────────────

app.get('/api/tickets', async (req, res) => {
  try {
    const { status, assigned_to, created_by, category_id, priority, member_id } = req.query;
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });
    const member = await memberById(member_id);
    if (!member) return res.status(400).json({ error: 'Valid member_id is required' });

    let sql = `
      SELECT t.*,
        c.name AS category_name,
        fm_creator.name AS creator_name, fm_creator.avatar_emoji AS creator_avatar,
        fm_assignee.name AS assignee_name, fm_assignee.avatar_emoji AS assignee_avatar,
        (SELECT COUNT(*)::int FROM ticket_comments WHERE ticket_id = t.id) AS comment_count
      FROM tickets t
      LEFT JOIN ticket_categories c ON c.id = t.category_id
      LEFT JOIN family_members fm_creator ON fm_creator.id = t.created_by
      LEFT JOIN family_members fm_assignee ON fm_assignee.id = t.assigned_to
      WHERE 1=1
    `;
    const params = [];
    let pi = 0;

    if (status) { params.push(status); sql += ` AND t.status = $${++pi}`; }
    if (assigned_to) { params.push(assigned_to); sql += ` AND t.assigned_to = $${++pi}`; }
    if (created_by) { params.push(created_by); sql += ` AND t.created_by = $${++pi}`; }
    if (category_id) { params.push(category_id); sql += ` AND t.category_id = $${++pi}`; }
    if (priority) { params.push(priority); sql += ` AND t.priority = $${++pi}`; }

    // Kid filter: only see tickets they created or are assigned to
    if (member.role === 'kid') {
      params.push(member_id, member_id);
      sql += ` AND (t.created_by = $${++pi} OR t.assigned_to = $${++pi})`;
    }

    sql += ' ORDER BY CASE t.priority WHEN \'urgent\' THEN 0 WHEN \'normal\' THEN 1 WHEN \'long-term\' THEN 2 END, t.updated_at DESC';

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const { title, description, category_id, priority, created_by, assigned_to, link_url } = req.body;
    if (!title || title.trim().length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!description || description.trim().length < 30) return res.status(400).json({ error: 'Description must be at least 30 characters' });
    if (!created_by) return res.status(400).json({ error: 'created_by is required' });

    const creator = await memberById(created_by);
    if (!creator) return res.status(400).json({ error: 'Valid created_by is required' });

    const nextAssigneeId = assigned_to || null;
    if (nextAssigneeId && creator.role !== 'parent') {
      return res.status(403).json({ error: 'Only parents can assign a ticket during creation' });
    }

    const assignee = nextAssigneeId ? await memberById(nextAssigneeId) : null;
    if (nextAssigneeId && !assignee) return res.status(400).json({ error: 'Valid assigned_to is required' });

    const r = await pool.query(
      `INSERT INTO tickets (title, description, category_id, priority, created_by, assigned_to, link_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title.trim(), description.trim(), category_id || null, priority || 'normal', created_by, nextAssigneeId, link_url || null]
    );

    const ticket = r.rows[0];
    await addSystemComment(ticket.id, `Ticket created by ${creator.name || 'Unknown'}`);
    if (assignee) {
      await addSystemComment(ticket.id, `${creator.name || 'Someone'} assigned this to ${assignee.name}`);
    }

    // Fire-and-forget MagicHelp for AI-eligible categories
    tryAutoMagicHelp(ticket).catch(err => console.error('MagicHelp auto error:', err.message));
    res.status(201).json(ticket);
    if (assignee) {
      sendAssignedTicketNotification(ticket, creator.name, assignee.id)
        .catch(err => console.error(`Assigned-ticket notification failed for #${ticket.id}:`, err.message));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const { member_id } = req.query;
    const access = await canMemberViewTicket(req.params.id, member_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const r = await pool.query(`
      SELECT t.*,
        c.name AS category_name, c.guidance AS category_guidance,
        fm_creator.name AS creator_name, fm_creator.avatar_emoji AS creator_avatar,
        fm_assignee.name AS assignee_name, fm_assignee.avatar_emoji AS assignee_avatar,
        trs.last_reminded_at, trs.next_reminder_at, trs.reminder_stage, trs.snooze_until, trs.last_delivery_error
      FROM tickets t
      LEFT JOIN ticket_categories c ON c.id = t.category_id
      LEFT JOIN family_members fm_creator ON fm_creator.id = t.created_by
      LEFT JOIN family_members fm_assignee ON fm_assignee.id = t.assigned_to
      LEFT JOIN ticket_reminder_state trs ON trs.ticket_id = t.id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tickets/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { status, assigned_to, priority, member_id } = req.body;
    if (!member_id) return res.status(400).json({ error: 'member_id is required' });

    // Fetch current ticket
    const cur = await pool.query('SELECT * FROM tickets WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = cur.rows[0];
    const actor = await memberById(member_id);
    if (!actor) return res.status(400).json({ error: 'Valid member_id is required' });
    if (actor.role === 'kid' && String(ticket.created_by) !== String(member_id) && String(ticket.assigned_to) !== String(member_id)) {
      return res.status(403).json({ error: 'Not authorized for this ticket' });
    }

    // Role check for assignment
    if (assigned_to !== undefined) {
      if (actor.role === 'kid' && assigned_to !== null && String(assigned_to) !== String(member_id)) {
        return res.status(403).json({ error: 'Kids can only self-assign tickets' });
      }
    }
    if (priority !== undefined && actor.role === 'kid') {
      return res.status(403).json({ error: 'Only parents can change priority' });
    }

    const updates = [];
    const params = [];
    let pi = 0;

    if (status !== undefined) {
      params.push(status); updates.push(`status = $${++pi}`);
      if (status === 'resolved' || status === 'closed') {
        updates.push(`resolved_at = COALESCE(resolved_at, now())`);
      }
      if (status === 'open' && (ticket.status === 'resolved' || ticket.status === 'closed')) {
        updates.push('resolved_at = NULL');
      }
    }
    if (assigned_to !== undefined) {
      params.push(assigned_to || null); updates.push(`assigned_to = $${++pi}`);
    }
    if (priority !== undefined) {
      params.push(priority); updates.push(`priority = $${++pi}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    updates.push('updated_at = now()');
    params.push(id);
    const sql = `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${++pi} RETURNING *`;
    const r = await pool.query(sql, params);

    // System comments for changes
    const actorName = actor.name || 'Someone';

    if (status !== undefined && status !== ticket.status) {
      await addSystemComment(id, `${actorName} changed status to ${status}`);
    }
    if (assigned_to !== undefined && String(assigned_to) !== String(ticket.assigned_to)) {
      if (assigned_to) {
        const assignee = await pool.query('SELECT name FROM family_members WHERE id=$1', [assigned_to]);
        await addSystemComment(id, `${actorName} assigned this to ${assignee.rows[0]?.name || 'Unknown'}`);
      } else {
        await addSystemComment(id, `${actorName} unassigned this ticket`);
      }
    }
    if (priority !== undefined && priority !== ticket.priority) {
      await addSystemComment(id, `${actorName} changed priority to ${priority}`);
    }

    if ((assigned_to !== undefined && String(assigned_to) !== String(ticket.assigned_to))
      || (status !== undefined && ['resolved', 'closed'].includes(status))) {
      await pool.query(`
        INSERT INTO ticket_reminder_state (ticket_id, snooze_until, next_reminder_at, reminder_stage, last_ticket_updated_at, updated_at)
        VALUES ($1, NULL, NULL, 0, $2, now())
        ON CONFLICT (ticket_id)
        DO UPDATE SET
          snooze_until = NULL,
          next_reminder_at = NULL,
          reminder_stage = 0,
          last_ticket_updated_at = $2,
          updated_at = now()
      `, [id, r.rows[0].updated_at]);
    }

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/:id/snooze', async (req, res) => {
  try {
    const { member_id, until } = req.body || {};
    const access = await canManageTicketReminders(req.params.id, member_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    if (!until) return res.status(400).json({ error: 'until is required' });
    const untilDate = new Date(until);
    if (Number.isNaN(untilDate.getTime())) return res.status(400).json({ error: 'Invalid until timestamp' });
    if (untilDate.getTime() <= Date.now()) return res.status(400).json({ error: 'Snooze time must be in the future' });

    const ticketRow = await pool.query('SELECT updated_at FROM tickets WHERE id = $1', [req.params.id]);
    if (!ticketRow.rows.length) return res.status(404).json({ error: 'Ticket not found' });

    await pool.query(`
      INSERT INTO ticket_reminder_state (ticket_id, snooze_until, next_reminder_at, reminder_stage, last_ticket_updated_at, updated_at)
      VALUES ($1, $2, $2, 0, $3, now())
      ON CONFLICT (ticket_id)
      DO UPDATE SET
        snooze_until = EXCLUDED.snooze_until,
        next_reminder_at = EXCLUDED.next_reminder_at,
        reminder_stage = 0,
        last_ticket_updated_at = EXCLUDED.last_ticket_updated_at,
        updated_at = now()
    `, [req.params.id, untilDate.toISOString(), ticketRow.rows[0].updated_at]);

    await addSystemComment(req.params.id, `${access.member.name} snoozed reminders until ${untilDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
    res.json({ ok: true, snooze_until: untilDate.toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tickets/:id/snooze', async (req, res) => {
  try {
    const { member_id } = req.body || {};
    const access = await canManageTicketReminders(req.params.id, member_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const ticketRow = await pool.query('SELECT updated_at FROM tickets WHERE id = $1', [req.params.id]);
    if (!ticketRow.rows.length) return res.status(404).json({ error: 'Ticket not found' });

    await pool.query(`
      INSERT INTO ticket_reminder_state (ticket_id, snooze_until, next_reminder_at, reminder_stage, last_ticket_updated_at, updated_at)
      VALUES ($1, NULL, NULL, 0, $2, now())
      ON CONFLICT (ticket_id)
      DO UPDATE SET
        snooze_until = NULL,
        next_reminder_at = NULL,
        reminder_stage = 0,
        last_ticket_updated_at = EXCLUDED.last_ticket_updated_at,
        updated_at = now()
    `, [req.params.id, ticketRow.rows[0].updated_at]);

    await addSystemComment(req.params.id, `${access.member.name} cleared the reminder snooze`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Comments ────────────────────────────────────────────────────────────────

app.get('/api/tickets/:id/comments', async (req, res) => {
  try {
    const { member_id } = req.query;
    const access = await canMemberViewTicket(req.params.id, member_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const r = await pool.query(`
      SELECT tc.*, fm.name AS author_name, fm.avatar_emoji AS author_avatar
      FROM ticket_comments tc
      LEFT JOIN family_members fm ON fm.id = tc.author_id
      WHERE tc.ticket_id = $1
      ORDER BY tc.created_at ASC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/:id/comments', async (req, res) => {
  try {
    const { body, author_id } = req.body;
    if (!body || body.trim().length < 10) return res.status(400).json({ error: 'Comment must be at least 10 characters' });
    if (!author_id) return res.status(400).json({ error: 'author_id is required' });
    const access = await canMemberViewTicket(req.params.id, author_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const r = await pool.query(
      'INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, author_id, body.trim()]
    );
    await touchTicket(req.params.id);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stats ───────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const { member_id } = req.query;
    const isKid = member_id ? (await pool.query('SELECT role FROM family_members WHERE id=$1', [member_id])).rows[0]?.role === 'kid' : false;

    let filter = '';
    const params = [];
    if (isKid && member_id) {
      params.push(member_id, member_id);
      filter = 'AND (created_by = $1 OR assigned_to = $2)';
    }

    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE status = 'in-progress') AS in_progress_count,
        COUNT(*) FILTER (WHERE status = 'waiting') AS waiting_count,
        COUNT(*) FILTER (WHERE status IN ('resolved', 'closed')) AS resolved_count,
        COUNT(*) FILTER (WHERE status IN ('resolved', 'closed') AND resolved_at > now() - interval '7 days') AS resolved_this_week
      FROM tickets WHERE 1=1 ${filter}
    `, params);

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings auth routes ────────────────────────────────────────────────────

app.get('/api/settings/status', async (req, res) => {
  try {
    const session = await settingsSessionInfo(req);
    res.json(session);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/setup-pin', async (req, res) => {
  try {
    const configured = await settingsPinConfigured();
    if (configured) return res.status(409).json({ error: 'PIN already configured' });
    const pin = String(req.body.pin || '').trim();
    if (pin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters' });
    const secret = crypto.randomBytes(32).toString('hex');
    await setCfg('settings_auth_secret', secret);
    await setCfg('settings_pin_hash', hashPin(pin));
    await setCfg('settings_pin_version', '1');
    const expiresAt = await issueSettingsSession(req, res);
    res.json({ ok: true, expires_at: expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/unlock', async (req, res) => {
  try {
    const pin = String(req.body.pin || '').trim();
    const encoded = await cfg('settings_pin_hash');
    if (!encoded) return res.status(428).json({ error: 'Settings PIN not set up yet', code: 'pin_not_configured' });
    if (!verifyPinAgainstHash(pin, encoded)) { clearSettingsSession(req, res); return res.status(401).json({ error: 'Incorrect PIN', code: 'bad_pin' }); }
    const expiresAt = await issueSettingsSession(req, res);
    res.json({ ok: true, expires_at: expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/lock', (req, res) => {
  clearSettingsSession(req, res);
  res.json({ ok: true });
});

// ── Protected settings routes ───────────────────────────────────────────────

app.get('/api/config', requireSettingsAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM app_config');
    const config = {};
    for (const row of r.rows) config[row.key] = row.value;
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/config', requireSettingsAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });
    // Don't allow overwriting auth secrets via this endpoint
    if (key.includes('pin') || key.includes('secret')) return res.status(403).json({ error: 'Cannot modify auth keys' });
    await setCfg(key, value);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notification-channels', requireSettingsAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        fm.id AS member_id,
        fm.name AS member_name,
        fm.role AS member_role,
        fm.avatar_emoji AS member_avatar,
        mnc.id,
        mnc.channel_type,
        mnc.label,
        mnc.enabled,
        mnc.target_secret,
        mnc.updated_at
      FROM family_members fm
      LEFT JOIN member_notification_channels mnc
        ON mnc.member_id = fm.id AND mnc.channel_type = 'brrr'
      ORDER BY fm.id
    `);

    res.json(r.rows.map(row => ({
      member_id: row.member_id,
      member_name: row.member_name,
      member_role: row.member_role,
      member_avatar: row.member_avatar,
      channel_type: 'brrr',
      label: row.label || '',
      enabled: !!row.enabled,
      has_secret: !!row.target_secret,
      secret_mask: maskSecret(row.target_secret),
      updated_at: row.updated_at
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/notification-channels/:memberId/brrr', requireSettingsAuth, async (req, res) => {
  try {
    const memberId = req.params.memberId;
    const member = await memberById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const enabled = req.body?.enabled === true;
    const label = String(req.body?.label || '').trim() || null;
    const secret = req.body?.secret;

    const existing = await pool.query(
      'SELECT target_secret FROM member_notification_channels WHERE member_id = $1 AND channel_type = $2',
      [memberId, 'brrr']
    );

    const existingSecret = existing.rows[0]?.target_secret || null;
    const nextSecret = secret === undefined ? existingSecret : String(secret || '').trim() || null;

    if (enabled && !nextSecret) {
      return res.status(400).json({ error: 'A brrr secret is required before notifications can be enabled for this member' });
    }

    if (nextSecret && nextSecret.length < 12) {
      return res.status(400).json({ error: 'brrr secret looks too short' });
    }

    const r = await pool.query(`
      INSERT INTO member_notification_channels (member_id, channel_type, label, target_secret, enabled, updated_at)
      VALUES ($1, 'brrr', $2, $3, $4, now())
      ON CONFLICT (member_id, channel_type)
      DO UPDATE SET
        label = EXCLUDED.label,
        target_secret = EXCLUDED.target_secret,
        enabled = EXCLUDED.enabled,
        updated_at = now()
      RETURNING member_id, channel_type, label, enabled, target_secret, updated_at
    `, [memberId, label, nextSecret, enabled]);

    res.json({
      member_id: Number(memberId),
      channel_type: 'brrr',
      label: r.rows[0].label || '',
      enabled: !!r.rows[0].enabled,
      has_secret: !!r.rows[0].target_secret,
      secret_mask: maskSecret(r.rows[0].target_secret),
      updated_at: r.rows[0].updated_at
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/notification-channels/:memberId/brrr', requireSettingsAuth, async (req, res) => {
  try {
    const memberId = req.params.memberId;
    await pool.query('DELETE FROM member_notification_channels WHERE member_id = $1 AND channel_type = $2', [memberId, 'brrr']);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/categories', requireSettingsAuth, async (req, res) => {
  try {
    const { name, guidance, ai_eligible } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required' });
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ticket_categories');
    const r = await pool.query(
      'INSERT INTO ticket_categories (name, guidance, ai_eligible, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), guidance || null, ai_eligible || false, maxOrder.rows[0].next]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Category already exists' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categories/:id', requireSettingsAuth, async (req, res) => {
  try {
    const { name, guidance, ai_eligible } = req.body;
    const r = await pool.query(
      'UPDATE ticket_categories SET name = COALESCE($1, name), guidance = COALESCE($2, guidance), ai_eligible = COALESCE($3, ai_eligible) WHERE id = $4 RETURNING *',
      [name, guidance, ai_eligible, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/categories/:id', requireSettingsAuth, async (req, res) => {
  try {
    // Don't delete if tickets reference this category
    const used = await pool.query('SELECT COUNT(*)::int AS cnt FROM tickets WHERE category_id = $1', [req.params.id]);
    if (used.rows[0].cnt > 0) return res.status(409).json({ error: `Category is used by ${used.rows[0].cnt} ticket(s). Reassign them first.` });
    await pool.query('DELETE FROM ticket_categories WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MagicHelp AI ────────────────────────────────────────────────────────────

async function tryAutoMagicHelp(ticket) {
  if (!hasOpenAI()) return;
  const enabled = await cfg('magic_help_enabled');
  if (enabled !== 'true') return;
  if (!ticket.category_id) return;

  const cat = await pool.query('SELECT name, ai_eligible FROM ticket_categories WHERE id=$1', [ticket.category_id]);
  if (!cat.rows[0]?.ai_eligible) return;

  const prompt = await cfg('magic_help_prompt') || '';
  const result = await generateMagicHelp({
    title: ticket.title,
    description: ticket.description,
    category_name: cat.rows[0].name,
  }, prompt);

  await pool.query('UPDATE tickets SET ai_suggestion = $1, updated_at = now() WHERE id = $2', [result.suggestion, ticket.id]);

  const confidenceNote = result.needs_human
    ? `MagicHelp responded (confidence: ${result.confidence}) but recommends human help: ${result.human_reason}`
    : `MagicHelp responded (confidence: ${result.confidence})`;
  await addSystemComment(ticket.id, confidenceNote);
}

app.post('/api/tickets/:id/magic-help', async (req, res) => {
  try {
    const memberId = req.body?.member_id;
    const access = await canMemberViewTicket(req.params.id, memberId);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    if (!hasOpenAI()) return res.status(503).json({ error: 'OpenAI API key not configured' });
    const enabled = await cfg('magic_help_enabled');
    if (enabled !== 'true') return res.status(503).json({ error: 'MagicHelp is not enabled. Enable it in Settings.' });

    const ticket = await pool.query(`
      SELECT t.*, c.name AS category_name
      FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!ticket.rows.length) return res.status(404).json({ error: 'Ticket not found' });

    const prompt = await cfg('magic_help_prompt') || '';
    const result = await generateMagicHelp(ticket.rows[0], prompt);

    await pool.query('UPDATE tickets SET ai_suggestion = $1, ai_helped = NULL, updated_at = now() WHERE id = $2', [result.suggestion, req.params.id]);

    const confidenceNote = result.needs_human
      ? `MagicHelp responded (confidence: ${result.confidence}) but recommends human help: ${result.human_reason}`
      : `MagicHelp responded (confidence: ${result.confidence})`;
    await addSystemComment(req.params.id, confidenceNote);

    res.json({ suggestion: result.suggestion, confidence: result.confidence, needs_human: result.needs_human, human_reason: result.human_reason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/:id/magic-help-followup', async (req, res) => {
  try {
    const memberId = req.body?.member_id;
    const access = await canMemberViewTicket(req.params.id, memberId);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    if (!hasOpenAI()) return res.status(503).json({ error: 'OpenAI API key not configured' });
    const enabled = await cfg('magic_help_enabled');
    if (enabled !== 'true') return res.status(503).json({ error: 'MagicHelp is not enabled' });

    const { question } = req.body;
    if (!question || question.trim().length < 5) return res.status(400).json({ error: 'Follow-up question must be at least 5 characters' });

    const ticket = await pool.query(`
      SELECT t.*, c.name AS category_name
      FROM tickets t LEFT JOIN ticket_categories c ON c.id = t.category_id
      WHERE t.id = $1
    `, [req.params.id]);
    if (!ticket.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    if (!ticket.rows[0].ai_suggestion) return res.status(400).json({ error: 'No previous AI response to follow up on' });

    const prompt = await cfg('magic_help_prompt') || '';
    const result = await followUpMagicHelp(ticket.rows[0], ticket.rows[0].ai_suggestion, question.trim(), prompt);

    // Append follow-up to ai_suggestion with separator
    const updated = ticket.rows[0].ai_suggestion + '\n\n---\nFollow-up: ' + question.trim() + '\n\n' + result.suggestion;
    await pool.query('UPDATE tickets SET ai_suggestion = $1, ai_helped = NULL, updated_at = now() WHERE id = $2', [updated, req.params.id]);
    await addSystemComment(req.params.id, `MagicHelp follow-up (confidence: ${result.confidence})`);

    res.json({ suggestion: result.suggestion, full_suggestion: updated, confidence: result.confidence, needs_human: result.needs_human });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets/:id/magic-help-feedback', async (req, res) => {
  try {
    const memberId = req.body?.member_id;
    const access = await canMemberViewTicket(req.params.id, memberId);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const { helped } = req.body;
    await pool.query('UPDATE tickets SET ai_helped = $1, updated_at = now() WHERE id = $2', [helped, req.params.id]);

    if (helped) {
      await pool.query("UPDATE tickets SET status = 'resolved', resolved_at = COALESCE(resolved_at, now()), updated_at = now() WHERE id = $1 AND status = 'open'", [req.params.id]);
      await addSystemComment(req.params.id, 'MagicHelp resolved this ticket');
    } else {
      await addSystemComment(req.params.id, 'MagicHelp was not sufficient -- needs human help');
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Attachments ─────────────────────────────────────────────────────────────

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!match) return reject(new Error('No multipart boundary'));
    const boundary = match[1] || match[2];

    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_FILE_SIZE + 1024 * 10) { // file + field overhead
        req.destroy();
        return reject(new Error(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`));
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parts = {};
      const sep = Buffer.from('--' + boundary);

      let pos = 0;
      while (pos < buf.length) {
        const start = buf.indexOf(sep, pos);
        if (start === -1) break;
        const nextStart = buf.indexOf(sep, start + sep.length + 2);
        if (nextStart === -1) break;

        const partBuf = buf.slice(start + sep.length + 2, nextStart);
        const headerEnd = partBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) { pos = nextStart; continue; }

        const headers = partBuf.slice(0, headerEnd).toString('utf8');
        const body = partBuf.slice(headerEnd + 4, partBuf.length - 2); // trim trailing \r\n

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const typeMatch = headers.match(/Content-Type:\s*(\S+)/i);

        if (nameMatch) {
          if (filenameMatch) {
            parts[nameMatch[1]] = { filename: filenameMatch[1], type: typeMatch?.[1] || 'application/octet-stream', data: body };
          } else {
            parts[nameMatch[1]] = body.toString('utf8');
          }
        }
        pos = nextStart;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

app.post('/api/tickets/:id/attachments', async (req, res) => {
  try {
    const parts = await parseMultipart(req);
    const file = parts.file;
    const uploadedBy = parts.uploaded_by;

    if (!file || !file.data || !file.data.length) return res.status(400).json({ error: 'No file provided' });
    if (!uploadedBy) return res.status(400).json({ error: 'uploaded_by is required' });
    const access = await canMemberViewTicket(req.params.id, uploadedBy);
    if (!access.ok) return res.status(access.code).json({ error: access.error });
    if (!ALLOWED_MIME.has(file.type)) return res.status(400).json({ error: `File type ${file.type} not allowed. Use JPG, PNG, WebP, GIF, or PDF.` });
    if (file.data.length > MAX_FILE_SIZE) return res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });

    // Verify ticket exists
    const t = await pool.query('SELECT id FROM tickets WHERE id=$1', [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket not found' });

    const ext = path.extname(file.filename).toLowerCase() || '.bin';
    const uuid = crypto.randomUUID();
    const filename = uuid + ext;
    const filePath = path.join(UPLOADS_DIR, filename);

    fs.writeFileSync(filePath, file.data);

    const r = await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, filename, file.filename, file.type, file.data.length, uploadedBy]
    );
    await touchTicket(req.params.id);

    const uploader = await pool.query('SELECT name FROM family_members WHERE id=$1', [uploadedBy]);
    await addSystemComment(req.params.id, `${uploader.rows[0]?.name || 'Someone'} attached ${file.filename}`);

    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tickets/:id/attachments', async (req, res) => {
  try {
    const { member_id } = req.query;
    const access = await canMemberViewTicket(req.params.id, member_id);
    if (!access.ok) return res.status(access.code).json({ error: access.error });

    const r = await pool.query(`
      SELECT ta.*, fm.name AS uploader_name
      FROM ticket_attachments ta
      LEFT JOIN family_members fm ON fm.id = ta.uploaded_by
      WHERE ta.ticket_id = $1
      ORDER BY ta.created_at ASC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attachments/:id', async (req, res) => {
  try {
    const memberId = req.query.member_id;
    const actor = await memberById(memberId);
    if (!actor) return res.status(400).json({ error: 'Valid member_id is required' });
    if (actor.role !== 'parent') return res.status(403).json({ error: 'Only parents can remove attachments' });

    const r = await pool.query('SELECT * FROM ticket_attachments WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Attachment not found' });

    const att = r.rows[0];
    const filePath = path.join(UPLOADS_DIR, att.filename);
    try { fs.unlinkSync(filePath); } catch {}

    await pool.query('DELETE FROM ticket_attachments WHERE id=$1', [req.params.id]);
    await addSystemComment(att.ticket_id, `Attachment removed: ${att.original_name}`);

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HTML page routes (serve files for clean URLs) ───────────────────────────

app.get('/', async (req, res) => {
  if (await redirectToSetupIfNeeded(req, res, 'setup')) return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/setup', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (!state.bootstrap.needs_household) return res.redirect('./');
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  } catch (err) {
    res.status(500).send(err.message);
  }
});
app.get('/new', (req, res) => res.sendFile(path.join(__dirname, 'public', 'new.html')));
app.get('/ticket/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticket.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

// ── Start ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  bootstrapSetupFromEnv().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`familyHelp listening on port ${PORT}`);
    });
  });
}

module.exports = { app, pool };
