require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const { generateMagicHelp, followUpMagicHelp, hasOpenAI } = require('./lib/openai');

const app = express();
const PORT = process.env.PORT || 3002;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SETTINGS_SESSION_COOKIE = 'fh_settings_session';
const SETTINGS_SESSION_MINUTES = 480; // 8 hours
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// Ensure uploads dir exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Config helpers ──────────────────────────────────────────────────────────

async function cfg(key) {
  const r = await pool.query('SELECT value FROM app_config WHERE key=$1', [key]);
  return r.rows[0]?.value ?? null;
}

async function setCfg(key, value) {
  await pool.query(
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

async function settingsPinConfigured() {
  const hash = await cfg('settings_pin_hash');
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

// ── Touch updated_at helper ─────────────────────────────────────────────────

async function touchTicket(id) {
  await pool.query('UPDATE tickets SET updated_at = now() WHERE id = $1', [id]);
}

async function addSystemComment(ticketId, body) {
  await pool.query('INSERT INTO ticket_comments (ticket_id, body, is_system) VALUES ($1, $2, TRUE)', [ticketId, body]);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

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
    if (member_id) {
      const mem = await pool.query('SELECT role FROM family_members WHERE id=$1', [member_id]);
      if (mem.rows[0]?.role === 'kid') {
        params.push(member_id, member_id);
        sql += ` AND (t.created_by = $${++pi} OR t.assigned_to = $${++pi})`;
      }
    }

    sql += ' ORDER BY CASE t.priority WHEN \'urgent\' THEN 0 WHEN \'normal\' THEN 1 WHEN \'long-term\' THEN 2 END, t.updated_at DESC';

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const { title, description, category_id, priority, created_by, link_url } = req.body;
    if (!title || title.trim().length < 10) return res.status(400).json({ error: 'Title must be at least 10 characters' });
    if (!description || description.trim().length < 30) return res.status(400).json({ error: 'Description must be at least 30 characters' });
    if (!created_by) return res.status(400).json({ error: 'created_by is required' });

    const r = await pool.query(
      `INSERT INTO tickets (title, description, category_id, priority, created_by, link_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title.trim(), description.trim(), category_id || null, priority || 'normal', created_by, link_url || null]
    );

    const ticket = r.rows[0];
    const creator = await pool.query('SELECT name FROM family_members WHERE id=$1', [created_by]);
    await addSystemComment(ticket.id, `Ticket created by ${creator.rows[0]?.name || 'Unknown'}`);

    // Fire-and-forget MagicHelp for AI-eligible categories
    tryAutoMagicHelp(ticket).catch(err => console.error('MagicHelp auto error:', err.message));

    res.status(201).json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.*,
        c.name AS category_name, c.guidance AS category_guidance,
        fm_creator.name AS creator_name, fm_creator.avatar_emoji AS creator_avatar,
        fm_assignee.name AS assignee_name, fm_assignee.avatar_emoji AS assignee_avatar
      FROM tickets t
      LEFT JOIN ticket_categories c ON c.id = t.category_id
      LEFT JOIN family_members fm_creator ON fm_creator.id = t.created_by
      LEFT JOIN family_members fm_assignee ON fm_assignee.id = t.assigned_to
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

    // Fetch current ticket
    const cur = await pool.query('SELECT * FROM tickets WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = cur.rows[0];

    // Role check for assignment
    if (assigned_to !== undefined && member_id) {
      const actor = await pool.query('SELECT role FROM family_members WHERE id=$1', [member_id]);
      if (actor.rows[0]?.role === 'kid' && assigned_to !== null && String(assigned_to) !== String(member_id)) {
        return res.status(403).json({ error: 'Kids can only self-assign tickets' });
      }
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
    const actorR = member_id ? await pool.query('SELECT name FROM family_members WHERE id=$1', [member_id]) : null;
    const actorName = actorR?.rows[0]?.name || 'Someone';

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

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Comments ────────────────────────────────────────────────────────────────

app.get('/api/tickets/:id/comments', async (req, res) => {
  try {
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
    if (!ALLOWED_MIME.has(file.type)) return res.status(400).json({ error: `File type ${file.type} not allowed. Use JPG, PNG, WebP, or GIF.` });
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

app.get('/new', (req, res) => res.sendFile(path.join(__dirname, 'public', 'new.html')));
app.get('/ticket/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticket.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));

// ── Start ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  bootstrapPin().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`familyHelp listening on port ${PORT}`);
    });
  });
}

module.exports = { app, pool };
