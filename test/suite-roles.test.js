'use strict';

// Suite identity: in tailnet mode the directory's role decides what each member may do, and what they do is done as
// their own linked member. The settings PIN gives way to the directory's parent role. Local mode keeps the picker
// and the PIN, as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, pool, setSuiteIdentityForTests } = require('../server');

const ORIGIN = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = {
  SOVEREIGN_AUTH_MODE: 'tailnet',
  SOVEREIGN_LISTEN: 'unix:/run/sovereign-apps/family-help/app.sock',
  SOVEREIGN_HOMEBASE_UID: '998',
  APP_PUBLIC_URL: `${ORIGIN}/help/`,
};
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['family-help'], role: 'parent', ...member }));
  return { current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const as = (userId, login) => ({ 'x-sovereign-user-id': userId, 'x-sovereign-login': login });
const PARENT_HEADERS = as('u-parent', 'parent@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const MEMBERS = [
  { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' },
  { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'Kid', role: 'kid' },
];

// Uploaded files on disk for the test: one on the kid's ticket, one on a ticket the kid can't see, one no ticket has.
const UPLOADS = path.join(__dirname, '..', 'uploads');
const tag = crypto.randomUUID();
const FILES = { kids: `${tag}-a.png`, others: `${tag}-b.png`, orphan: `${tag}-c.png` };
const UPLOADED = [];

// Postgres as the gate, the ticket routes, the uploads check and settings ask it; every write is recorded.
// Tickets: 10 is the kid's own, 11 is another kid's (assigned to 3), 12 is a parent's assigned to the kid, 13 a
// parent's, unassigned.
class Db {
  constructor() {
    this.members = [
      { id: 1, name: 'Parent', role: 'parent', avatar_emoji: '👤', suite_member_id: 'm_parent' },
      { id: 2, name: 'Kid', role: 'kid', avatar_emoji: '🧒', suite_member_id: 'm_kid' },
      { id: 3, name: 'Other kid', role: 'kid', avatar_emoji: '🧒', suite_member_id: null },
    ];
    this.tickets = [
      { id: 10, created_by: 2, assigned_to: null, status: 'open', priority: 'normal' },
      { id: 11, created_by: 1, assigned_to: 3, status: 'open', priority: 'normal' },
      { id: 12, created_by: 1, assigned_to: 2, status: 'open', priority: 'normal' },
      { id: 13, created_by: 1, assigned_to: null, status: 'open', priority: 'normal' },
    ];
    this.attachments = [{ filename: FILES.kids, ticket_id: 10 }, { filename: FILES.others, ticket_id: 11 }];
    this.config = new Map();
    this.writes = [];
    this.reads = [];
  }
  ticket(id) { return this.tickets.find((t) => String(t.id) === String(id)); }
  async query(sql, params = []) {
    sql = sql.replace(/\s+/g, ' ').trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM family_members WHERE suite_member_id = $1')) return { rows: this.members.filter((m) => m.suite_member_id === params[0]) };
    if (/FROM family_members WHERE id ?= ?\$1/.test(sql)) return { rows: this.members.filter((m) => String(m.id) === String(params[0])) };
    if (sql.includes('FROM family_members ORDER BY id')) return { rows: this.members };
    if (sql.includes('COUNT(*)::int AS count FROM family_members')) return { rows: [{ count: this.members.length }] };
    if (sql.includes('COUNT(*)::int AS count FROM')) return { rows: [{ count: 3 }] };
    if (sql.includes('SELECT value FROM app_config WHERE key=$1')) return { rows: this.config.has(params[0]) ? [{ value: this.config.get(params[0]) }] : [] };
    if (sql.startsWith('SELECT id FROM tickets WHERE id = $1 AND (created_by = $2 OR assigned_to = $2)')) {
      const t = this.ticket(params[0]);
      return { rows: t && (String(t.created_by) === String(params[1]) || String(t.assigned_to) === String(params[1])) ? [{ id: t.id }] : [] };
    }
    if (/^SELECT (assigned_to|updated_at|id|\*) FROM tickets WHERE id ?= ?\$1$/.test(sql)) {
      const t = this.ticket(params[0]);
      return { rows: t ? [{ ...t, updated_at: '2026-11-12T00:00:00Z' }] : [] };
    }
    if (sql.includes('FROM tickets t') && sql.includes('WHERE t.id = $1')) {
      const t = this.ticket(params[0]);
      return { rows: t ? [{ ...t }] : [] };
    }
    if (sql.includes('FROM tickets t') && sql.includes('WHERE 1=1')) { this.reads.push({ sql, params }); return { rows: [] }; }
    if (sql.includes('FROM tickets WHERE 1=1')) { this.reads.push({ sql, params }); return { rows: [{}] }; }
    if (sql.startsWith('SELECT ticket_id FROM ticket_attachments WHERE filename = $1')) {
      return { rows: this.attachments.filter((a) => a.filename === params[0]).map(({ ticket_id }) => ({ ticket_id })) };
    }
    if (sql.includes('COALESCE(MAX(sort_order)')) return { rows: [{ next: 7 }] };
    if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
      this.writes.push({ sql, params });
      if (sql.startsWith('INSERT INTO ticket_attachments')) UPLOADED.push(params[1]);
      if (sql.startsWith('INSERT INTO tickets')) return { rows: [{ id: 99, created_by: params[4], assigned_to: params[5] }] };
      if (sql.startsWith('UPDATE tickets SET') && sql.includes('RETURNING *')) return { rows: [{ ...this.ticket(params.at(-1)), updated_at: 'now' }] };
      if (sql.includes('RETURNING')) return { rows: [{ id: 1, params }] };
      return { rows: [] };
    }
    return { rows: [] };
  }
  written(table) { return this.writes.filter((write) => write.sql.startsWith(`INSERT INTO ${table}`)); }
}

const ORIGINAL_QUERY = pool.query;
const ORIGINAL_CONNECT = pool.connect;
async function withServer(env, db, fn) {
  setSuiteIdentityForTests(env, env.SOVEREIGN_AUTH_MODE ? { reader: snapshotOf(MEMBERS) } : {});
  pool.query = db.query.bind(db);
  pool.connect = async () => ({ query: db.query.bind(db), release() {} });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, route, headers, body) => fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: { ...headers, ...(method === 'GET' || method === 'HEAD' ? {} : { origin: ORIGIN, 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    call.base = base;
    await fn(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = ORIGINAL_QUERY;
    pool.connect = ORIGINAL_CONNECT;
    setSuiteIdentityForTests({});
  }
}

// A request exactly as written: fetch() normalizes dot segments and %2e.
function raw(base, method, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    http.request({ hostname, port, method, path: route, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject).end();
  });
}

function upload(base, ticketId, headers, uploadedBy) {
  const boundary = 'x-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="uploaded_by"\r\n\r\n${uploadedBy}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from('not really a png'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return fetch(`${base}/api/tickets/${ticketId}/attachments`, {
    method: 'POST',
    headers: { ...headers, origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

test.before(() => {
  for (const name of Object.values(FILES)) fs.writeFileSync(path.join(UPLOADS, name), 'png');
});
test.after(() => {
  for (const name of [...Object.values(FILES), ...UPLOADED]) fs.rmSync(path.join(UPLOADS, name), { force: true });
});

test('a kid may use the help desk as a kid does today, and nothing a parent does', async () => {
  const db = new Db();
  await withServer(TAILNET, db, async (call) => {
    const kid = (method, route, body) => call(method, route, KID_HEADERS, body);
    // Their pages.
    for (const route of ['/', '/board', '/new', '/ticket/10']) {
      assert.equal((await kid('GET', route)).status, 200, route);
    }
    // Every other page, and every other spelling, goes to the main page.
    for (const route of ['/settings', '/settings.html', '/link', '/setup', '/setup.html', '/index.html', '/board.html', '/new.html',
      '/ticket.html', '/Board', '/board/', '/NEW', '/ticket/010', '/ticket/10/', '/ticket/x', '/UPLOADS/x.png', '/uploads/a/b.png']) {
      const res = await kid('GET', route);
      assert.equal(res.status, 303, route);
      assert.equal(res.headers.get('location'), '/help/', route);
      assert.equal(res.headers.get('cache-control'), 'no-store', route);
    }
    // Allowed: through the gate to the handler.
    const allowed = [
      ['GET', '/api/me'], ['GET', '/api/members'], ['HEAD', '/api/members'], ['GET', '/api/categories'],
      ['GET', '/api/tickets'], ['GET', '/api/tickets/10'], ['GET', '/api/tickets/10/comments'], ['GET', '/api/tickets/10/attachments'],
      ['POST', '/api/tickets', { title: 'Printer is jammed again', description: 'The printer upstairs shows a paper jam light and nothing prints.' }],
      ['PUT', '/api/tickets/10', { status: 'in-progress' }],
      ['POST', '/api/tickets/10/comments', { body: 'Still broken this morning' }],
      ['POST', '/api/tickets/12/snooze', { until: new Date(Date.now() + 3600e3).toISOString() }],
      ['DELETE', '/api/tickets/12/snooze'],
      ['POST', '/api/tickets/10/magic-help', {}], ['POST', '/api/tickets/10/magic-help-followup', { question: 'And then what?' }],
      ['POST', '/api/tickets/10/magic-help-feedback', { helped: false }],
    ];
    for (const [method, route, body] of allowed) {
      const res = await kid(method, route, body);
      assert.notEqual(res.status, 303, `${method} ${route}`);
      assert.notEqual(res.status, 403, `${method} ${route}`);
      assert.ok(res.status < 500 || res.status === 503, `${method} ${route}: ${res.status}`);
    }
    assert.equal((await upload(call.base, 10, KID_HEADERS, 2)).status, 201);
    // Everything else is a parent's, in any spelling.
    const refused = [
      ['GET', '/api/stats'], ['GET', '/api/config'], ['GET', '/api/notification-channels'], ['GET', '/api/settings/status'],
      ['GET', '/api/bootstrap'], ['GET', '/api/suite/links'], ['GET', '/api/tickets/010'], ['GET', '/API/tickets'],
      ['GET', '/api/tickets/'], ['GET', '/api/tickets/10/comments/'], ['GET', '/api/Members'], ['GET', '/api/me/'],
      ['PUT', '/api/config', { key: 'magic_help_enabled', value: 'true' }],
      ['PUT', '/api/notification-channels/2/brrr', {}], ['DELETE', '/api/notification-channels/2/brrr'],
      ['POST', '/api/categories', { name: 'Games' }], ['PUT', '/api/categories/1', {}], ['DELETE', '/api/categories/1'],
      ['DELETE', '/api/attachments/1'], ['POST', '/api/settings/unlock', { pin: '1234' }], ['POST', '/api/settings/lock'],
      ['POST', '/api/settings/setup-pin', { pin: '1234' }], ['POST', '/api/bootstrap/household', {}],
      ['POST', '/api/bootstrap/starter-content'], ['PUT', '/api/suite/links/2', { suite_member_id: null }],
      ['POST', '/api/tickets/10'], ['DELETE', '/api/tickets/10'], ['PATCH', '/api/tickets/10', {}], ['PUT', '/api/tickets/10/comments', {}],
      ['POST', '/api/me'], ['POST', '/API/tickets', {}], ['POST', '/api/tickets/', {}], ['DELETE', '/api/tickets/10/snooze/'],
      ['POST', '/api/tickets/10/Comments', {}], ['PUT', '/api/tickets/010', {}], ['POST', '/api/tickets/10/magic-help/', {}],
      ['POST', '/api/tickets/10/attachments/', {}], ['PUT', '/api/tickets/10/snooze', {}],
    ];
    for (const [method, route, body] of refused) {
      const res = await kid(method, route, body);
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.equal(res.headers.get('cache-control'), 'no-store', `${method} ${route}`);
      assert.equal((await res.json()).code, 'parent_only', `${method} ${route}`);
    }
    // Dot segments and doubled slashes are spellings the allowlist doesn't know either.
    for (const route of ['/api/tickets/10/../11', '/api/tickets/./10', '//api/tickets', '/api/tickets/%2e%2e/stats', '/api//tickets']) {
      const res = await raw(call.base, 'GET', route, KID_HEADERS);
      assert.ok([303, 403].includes(res.status), `${route}: ${res.status}`);
    }
    // Nothing a parent does was written.
    assert.equal(db.writes.filter((write) => /app_config|ticket_categories|member_notification_channels|family_members/.test(write.sql)).length, 0);
  });
});

test('a parent may use everything, settings included, by the directory\'s role, not the row\'s', async () => {
  const db = new Db();
  db.members[0].role = 'kid';
  await withServer(TAILNET, db, async (call) => {
    const parent = (method, route, body) => call(method, route, PARENT_HEADERS, body);
    for (const route of ['/', '/board', '/new', '/ticket/11', '/settings']) assert.equal((await parent('GET', route)).status, 200, route);
    assert.equal((await parent('GET', '/api/config')).status, 200);
    assert.equal((await parent('PUT', '/api/config', { key: 'magic_help_enabled', value: 'true' })).status, 200);
    assert.equal((await parent('GET', '/api/notification-channels')).status, 200);
    assert.equal((await parent('POST', '/api/categories', { name: 'Games' })).status, 201);
    assert.equal((await parent('GET', '/api/stats')).status, 200);
    // A parent sees every ticket, whatever member the request names, and may remove an attachment.
    assert.equal((await parent('GET', '/api/tickets/11?member_id=2')).status, 200);
    assert.equal((await parent('PUT', '/api/tickets/13', { priority: 'urgent', member_id: 3 })).status, 200);
    assert.equal((await parent('DELETE', '/api/attachments/5?member_id=3')).status, 404, 'past the role check; no such attachment');
    // Their whole list: no kid filter.
    await parent('GET', '/api/tickets?member_id=2');
    assert.doesNotMatch(db.reads.at(-1).sql, /created_by = \$\d+ OR/);
    const me = await (await parent('GET', '/api/me')).json();
    assert.deepEqual(me, { mode: 'tailnet', member: { id: 1, name: 'Parent', avatar_emoji: '👤', role: 'parent' } });
    const status = await parent('GET', '/api/settings/status');
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), { configured: true, unlocked: true, tailnet: true });
  });
});

test('the settings PIN is local mode\'s: in tailnet mode its routes answer 409 and the stored PIN is never touched', async () => {
  const db = new Db();
  db.config.set('settings_pin_hash', 'salt:hash');
  db.config.set('settings_auth_secret', 'secret');
  await withServer(TAILNET, db, async (call) => {
    for (const route of ['/api/settings/setup-pin', '/api/settings/unlock', '/api/settings/lock']) {
      const res = await call('POST', route, PARENT_HEADERS, { pin: '1234' });
      assert.equal(res.status, 409, route);
      assert.equal(res.headers.get('cache-control'), 'no-store', route);
      assert.equal((await res.json()).code, 'tailnet_mode', route);
      assert.equal(res.headers.get('set-cookie'), null, route);
    }
    // Another spelling of a PIN route reaches the same answer.
    const res = await call('POST', '/API/settings/unlock/', PARENT_HEADERS, { pin: '1234' });
    assert.equal(res.status, 409);
    // A settings session from local mode grants a kid nothing.
    const cookie = { cookie: 'fh_settings_session=anything' };
    assert.equal((await call('GET', '/api/config', { ...KID_HEADERS, ...cookie })).status, 403);
    assert.equal((await call('GET', '/api/settings/status', { ...KID_HEADERS, ...cookie })).status, 403);
    assert.equal(db.writes.filter((write) => write.sql.includes('app_config')).length, 0);
    assert.equal(db.config.get('settings_pin_hash'), 'salt:hash');
  });
  // First-run setup in tailnet mode sets no PIN.
  const empty = new Db();
  empty.members = [];
  await withServer(TAILNET, empty, async (call) => {
    const res = await call('POST', '/api/bootstrap/household', PARENT_HEADERS, { members: [{ name: 'Parent', role: 'parent' }], settings_pin: '1234' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'tailnet_mode');
    assert.equal(empty.writes.length, 0);
  });
  // Local mode: the PIN, as before.
  await withServer({}, db, async (call) => {
    assert.equal((await call('GET', '/api/config', {})).status, 401);
    const status = await (await call('GET', '/api/settings/status', {})).json();
    assert.deepEqual(status, { configured: true, unlocked: false });
    const wrong = await call('POST', '/api/settings/unlock', {}, { pin: '0000' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'bad_pin');
  });
});

test('in tailnet mode what a kid does is their own, judged for them, whatever the request names', async () => {
  const db = new Db();
  await withServer(TAILNET, db, async (call) => {
    const kid = (method, route, body) => call(method, route, KID_HEADERS, body);
    // A ticket names the parent as its creator; it's the kid's, and a kid can't assign one.
    const ticket = { title: 'Printer is jammed again', description: 'The printer upstairs shows a paper jam light and nothing prints.', created_by: 1 };
    assert.equal((await kid('POST', '/api/tickets', ticket)).status, 201);
    assert.deepEqual(db.written('tickets').map((write) => write.params[4]), [2]);
    const assigning = await kid('POST', '/api/tickets', { ...ticket, assigned_to: 3 });
    assert.equal(assigning.status, 403);
    // Visibility is the kid's: naming the parent doesn't open another kid's ticket, its comments or attachments.
    for (const route of ['/api/tickets/11?member_id=1', '/api/tickets/11/comments?member_id=1', '/api/tickets/11/attachments?member_id=1', '/api/tickets/13']) {
      assert.equal((await kid('GET', route)).status, 403, route);
    }
    assert.equal((await kid('GET', '/api/tickets/10')).status, 200);
    assert.equal((await kid('GET', '/api/tickets/12?member_id=3')).status, 200);
    // Their list is filtered to them, not to whom the request names.
    await kid('GET', '/api/tickets?member_id=1');
    assert.match(db.reads.at(-1).sql, /AND \(t\.created_by = \$1 OR t\.assigned_to = \$2\)/);
    assert.deepEqual(db.reads.at(-1).params, [2, 2]);
    // Comments and uploads are signed with the kid's own member.
    assert.equal((await kid('POST', '/api/tickets/10/comments', { body: 'Still broken this morning', author_id: 1 })).status, 201);
    assert.deepEqual(db.written('ticket_comments (ticket_id, author_id').map((write) => write.params[1]), [2]);
    assert.equal((await kid('POST', '/api/tickets/11/comments', { body: 'Let me in on this one', author_id: 1 })).status, 403);
    const uploaded = await upload(call.base, 10, KID_HEADERS, 1);
    assert.equal(uploaded.status, 201);
    const [attachment] = db.written('ticket_attachments');
    assert.equal(attachment.params[5], 2);
    assert.equal((await upload(call.base, 11, KID_HEADERS, 1)).status, 403);
    // Changes are judged for the kid: no priority, no assigning others, only their own tickets.
    assert.equal((await kid('PUT', '/api/tickets/10', { priority: 'urgent', member_id: 1 })).status, 403);
    assert.equal((await kid('PUT', '/api/tickets/10', { assigned_to: 1, member_id: 1 })).status, 403);
    assert.equal((await kid('PUT', '/api/tickets/11', { status: 'resolved', member_id: 1 })).status, 403);
    assert.equal((await kid('PUT', '/api/tickets/12', { status: 'in-progress', member_id: 1 })).status, 200);
    assert.match(db.written('ticket_comments (ticket_id, body, is_system)').at(-1).params[1], /^Kid changed status/);
    // Snoozing is the assignee's: the kid's own assigned ticket, not another's, whoever the request names.
    const until = new Date(Date.now() + 3600e3).toISOString();
    assert.equal((await kid('POST', '/api/tickets/11/snooze', { until, member_id: 1 })).status, 403);
    assert.equal((await kid('POST', '/api/tickets/10/snooze', { until, member_id: 1 })).status, 403);
    assert.equal((await kid('POST', '/api/tickets/12/snooze', { until, member_id: 1 })).status, 200);
    assert.match(db.written('ticket_comments (ticket_id, body, is_system)').at(-1).params[1], /^Kid snoozed/);
    assert.equal((await kid('DELETE', '/api/tickets/11/snooze', { member_id: 1 })).status, 403);
    // MagicHelp only on a ticket they may see (503 here: no OpenAI key, or not enabled, which comes after the check).
    assert.equal((await kid('POST', '/api/tickets/11/magic-help', { member_id: 1 })).status, 403);
    assert.equal((await kid('POST', '/api/tickets/11/magic-help-feedback', { member_id: 1, helped: true })).status, 403);
    assert.equal((await kid('POST', '/api/tickets/11/magic-help-followup', { member_id: 1, question: 'And then what?' })).status, 403);
    assert.equal((await kid('POST', '/api/tickets/10/magic-help', { member_id: 3 })).status, 503);
    // A parent's change is signed with their own member, not the one the page sends.
    assert.equal((await call('PUT', '/api/tickets/13', PARENT_HEADERS, { status: 'waiting', member_id: 2 })).status, 200);
    assert.match(db.written('ticket_comments (ticket_id, body, is_system)').at(-1).params[1], /^Parent changed status/);
    const kidMe = await (await kid('GET', '/api/me')).json();
    assert.deepEqual(kidMe, { mode: 'tailnet', member: { id: 2, name: 'Kid', avatar_emoji: '🧒', role: 'kid' } });
  });

  // Local mode: the picker's choice, from the request, as before.
  const local = new Db();
  await withServer({}, local, async (call) => {
    assert.equal((await call('GET', '/api/tickets/11?member_id=2', {})).status, 403);
    assert.equal((await call('GET', '/api/tickets/11?member_id=1', {})).status, 200);
    assert.equal((await call('GET', '/api/tickets', {})).status, 400);
    assert.equal((await call('POST', '/api/tickets/10/comments', {}, { body: 'Picked from the picker', author_id: 1 })).status, 201);
    assert.deepEqual(local.written('ticket_comments (ticket_id, author_id').map((write) => write.params[1]), [1]);
    assert.deepEqual(await (await call('GET', '/api/me', {})).json(), { mode: 'local', member: null });
  });
});

test('an uploaded file is shown only to someone who may see its ticket', async () => {
  await withServer(TAILNET, new Db(), async (call) => {
    const get = (route, headers) => raw(call.base, 'GET', route, headers);
    assert.equal((await get(`/uploads/${FILES.kids}`, PARENT_HEADERS)).status, 200);
    assert.equal((await get(`/uploads/${FILES.others}`, PARENT_HEADERS)).status, 200);
    assert.equal((await get(`/uploads/${FILES.kids}`, KID_HEADERS)).status, 200);
    // Another kid's ticket's file, or a file no ticket has, isn't there, in any spelling.
    const missing = [
      [`/uploads/${FILES.others}`, KID_HEADERS], [`/uploads/${FILES.orphan}`, PARENT_HEADERS], [`/uploads/${FILES.orphan}`, KID_HEADERS],
      [`/uploads/${FILES.kids}/`, PARENT_HEADERS], [`/uploads/${FILES.kids.toUpperCase()}`, PARENT_HEADERS],
      [`/UPLOADS/${FILES.orphan}`, PARENT_HEADERS], [`/Uploads/${FILES.others}/`, PARENT_HEADERS],
      [`/uploads/%2e%2e/server.js`, PARENT_HEADERS], ['/uploads/x%2fy.png', PARENT_HEADERS], ['/uploads/%E0%A4%A', PARENT_HEADERS],
      ['/uploads/', PARENT_HEADERS], ['/uploads', PARENT_HEADERS], [`/uploads//${FILES.others}`, KID_HEADERS],
      [`/uploads/./${FILES.others}`, KID_HEADERS], [`/uploads/${encodeURIComponent(FILES.others)}`, KID_HEADERS],
    ];
    for (const [route, headers] of missing) {
      const res = await get(route, headers);
      assert.ok([303, 404].includes(res.status), `${route}: ${res.status}`);
      if (res.status === 404) assert.equal(res.headers['cache-control'], 'no-store', route);
    }
    // Another spelling of a file the asker may see is the same file, checked the same way.
    assert.equal((await get(`/UPLOADS/${FILES.others}`, PARENT_HEADERS)).status, 200);
    assert.equal((await get(`/uploads//${FILES.others}`, PARENT_HEADERS)).status, 200);
    // A link from the ticket page opens it (a navigation, not the API).
    assert.equal((await get(`/uploads/${FILES.kids}`, { ...KID_HEADERS, 'sec-fetch-mode': 'navigate' })).status, 200);
  });
  // Local mode serves the folder as before.
  await withServer({}, new Db(), async (call) => {
    assert.equal((await raw(call.base, 'GET', `/uploads/${FILES.orphan}`)).status, 200);
  });
});

test('in tailnet mode the pages show the household account: no picker, no PIN, no Settings for a kid', () => {
  const page = (name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
  for (const [name, prefix] of [['app.js', ''], ['board.js', ''], ['new.js', ''], ['ticket.js', '../'], ['settings.js', '']]) {
    const text = page(name);
    // Who am I comes first, before the picker's choice is read.
    assert.ok(text.includes(`const me = await api('${prefix}api/me');`), name);
    assert.match(text, /if \(me\.mode !== 'tailnet' \|\| !me\.member\) return false;\n {2}currentMember = me\.member;/, name);
    assert.match(text, /if \(me\.member\.role !== 'parent'\) document\.querySelector\('nav a\[href\$="settings"\]'\)\?\.remove\(\);/, name);
    const init = text.slice(text.indexOf('async function init()'));
    assert.ok(init.indexOf('loadSuiteMe()') !== -1 && init.indexOf('loadSuiteMe()') < init.indexOf('currentMember'), `${name}: api/me before the picker`);
  }
  // The dashboard's badge doesn't open the picker ("switch") in tailnet mode.
  assert.match(page('app.js'), /function openMemberPicker\(\) \{\n {2}if \(suiteTailnet\) return;/);
  // Settings: no PIN prompt or Lock in tailnet mode.
  assert.match(page('settings.js'), /if \(status\.tailnet\) \{[\s\S]*?replaceWith\(linkPage\);\n {4}if \(status\.unlocked\) showSettings\(\);\n {4}return;\n {2}\}\n {2}if \(!status\.configured\)/);
  // Setup: both PIN fields sit in the block tailnet mode hides.
  const setup = page('setup.html');
  const block = setup.slice(setup.indexOf('<div id="setupPinFields">'), setup.indexOf('id="setupStarterContent"'));
  assert.match(block, /id="setupPin"/);
  assert.match(block, /id="setupPinConfirm"/);
  assert.match(page('setup.js'), /if \(me\?\.mode === 'tailnet'\) document\.getElementById\('setupPinFields'\)\.style\.display = 'none';/);
});

test('if the gate ever let a kid past, the handlers still refuse a parent\'s work', async () => {
  // The kid allowlist refuses all of this first; this checks the handlers' own checks behind it.
  const db = new Db();
  const suite = setSuiteIdentityForTests(TAILNET, { reader: snapshotOf(MEMBERS) });
  const KID_MEMBER = { memberId: 'm_kid', name: 'Kid', role: 'kid' };
  suite.requireMember = (req, _res, next) => { req.suiteMember = KID_MEMBER; req.familyMember = db.members[1]; next(); };
  pool.query = db.query.bind(db);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, route, body) => fetch(`${base}${route}`, {
      method, redirect: 'manual', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });
    for (const [method, route, body] of [
      ['GET', '/api/config'], ['PUT', '/api/config', { key: 'magic_help_enabled', value: 'true' }], ['GET', '/api/notification-channels'],
      ['POST', '/api/categories', { name: 'Games' }], ['DELETE', '/api/categories/1'],
    ]) {
      const res = await call(method, route, body);
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.equal((await res.json()).code, 'parent_only', `${method} ${route}`);
    }
    assert.equal((await call('GET', '/api/suite/links')).status, 403);
    assert.equal((await call('PUT', '/api/suite/links/2', { suite_member_id: 'm_kid' })).status, 403);
    assert.equal((await call('GET', '/link')).status, 403);
    assert.equal((await call('DELETE', '/api/attachments/5?member_id=1')).status, 403);
    assert.deepEqual(await (await call('GET', '/api/settings/status')).json(), { configured: true, unlocked: false, tailnet: true });
    // A kid's counts are their own tickets'.
    assert.equal((await call('GET', '/api/stats?member_id=1')).status, 200);
    assert.match(db.reads.at(-1).sql, /AND \(created_by = \$1 OR assigned_to = \$2\)/);
    assert.deepEqual(db.reads.at(-1).params, [2, 2]);
    assert.equal(db.writes.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = ORIGINAL_QUERY;
    setSuiteIdentityForTests({});
  }
});
