require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3002;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SETTINGS_SESSION_COOKIE = 'fh_settings_session';
const SETTINGS_SESSION_MINUTES = 480; // 8 hours

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
