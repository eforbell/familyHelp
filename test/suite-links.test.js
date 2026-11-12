'use strict';

// Suite identity: a parent links each Family Help member to the household member they are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const PARTNER_HEADERS = as('u-partner', 'partner@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const MEMBERS = [
  { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' },
  { userId: 'u-partner', memberId: 'm_partner', login: 'partner@example.com', name: 'Partner' },
  { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: 'Kid', role: 'kid' },
  { userId: 'u-away', memberId: 'm_away', login: 'away@example.com', name: 'Away', status: 'disabled' },
  { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'Other', apps: ['family-plan'] },
  { userId: 'u-tagged', memberId: 'm_tagged', login: 'tagged-devices', name: 'Tagged devices' },
];

// family_members as Postgres would answer the gate, the link list and the link UPDATE (unique suite_member_id).
class MembersDb {
  constructor(rows) { this.rows = rows; }
  async query(sql, params = []) {
    if (sql.includes('FROM family_members WHERE suite_member_id = $1')) return { rows: this.rows.filter((row) => row.suite_member_id === params[0]) };
    if (sql.includes('FROM family_members ORDER BY id')) return { rows: this.rows.map((row) => ({ ...row })) };
    if (sql.includes('SELECT id FROM family_members WHERE id = $1')) return { rows: this.rows.filter((row) => row.id === params[0]).map(({ id }) => ({ id })) };
    if (sql.startsWith('UPDATE family_members SET suite_member_id = $1 WHERE id = $2')) {
      const [suiteMemberId, id] = params;
      const kidOnly = sql.includes("AND role = 'kid'");
      const row = this.rows.find((candidate) => candidate.id === id && (!kidOnly || candidate.role === 'kid'));
      if (row && suiteMemberId !== null && this.rows.some((other) => other.suite_member_id === suiteMemberId && other.id !== id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      if (row) row.suite_member_id = suiteMemberId;
      return { rows: row ? [{ ...row }] : [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

const ORIGINAL_QUERY = pool.query;
async function withServer(env, options, db, fn) {
  setSuiteIdentityForTests(env, options);
  pool.query = db.query.bind(db);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = ORIGINAL_QUERY;
    setSuiteIdentityForTests({});
  }
}

const household = () => new MembersDb([
  { id: 1, name: 'Parent', role: 'parent', avatar_emoji: '👤', suite_member_id: null },
  { id: 2, name: 'Partner', role: 'parent', avatar_emoji: '👤', suite_member_id: null },
  { id: 3, name: 'Kid', role: 'kid', avatar_emoji: '👤', suite_member_id: null },
]);

test('a parent links Family Help members to household members; nobody else can', async (t) => {
  // Each link change is logged with who made it, by member ID, never a name.
  const logged = [];
  t.mock.method(console, 'log', (line) => logged.push(String(line)));
  const db = household();
  await withServer(TAILNET, { reader: snapshotOf(MEMBERS) }, db, async (base) => {
    const get = (route, headers) => fetch(`${base}${route}`, { headers, redirect: 'manual' });
    const link = (id, suiteMemberId, headers = PARENT_HEADERS) => fetch(`${base}/api/suite/links/${id}`, {
      method: 'PUT',
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ suite_member_id: suiteMemberId }),
    });

    // The page's file is never served as a static page, around the route's check: it redirects to the route.
    for (const headers of [PARENT_HEADERS, KID_HEADERS, {}]) {
      const file = await get('/link.html', headers);
      assert.notEqual(file.status, 200);
    }
    // A parent nobody has linked opens the link page and its list.
    const page = await get('/link', PARENT_HEADERS);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /link\.js/);

    // The directory lists only active members with access; the tagged-devices login is never one.
    const listed = await get('/api/suite/links', PARENT_HEADERS);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const body = await listed.json();
    assert.equal(body.you, 'm_parent');
    assert.deepEqual(body.directory, [
      { memberId: 'm_parent', name: 'Parent', role: 'parent' },
      { memberId: 'm_partner', name: 'Partner', role: 'parent' },
      { memberId: 'm_kid', name: 'Kid', role: 'kid' },
    ]);
    assert.deepEqual(body.members.map((member) => member.id), [1, 2, 3]);

    // Only someone with access, and only once.
    for (const value of ['m_away', 'm_other', 'm_tagged', 'm_nobody', 7, undefined, '', { memberId: 'm_parent' }]) {
      const res = await link(1, value);
      assert.equal(res.status, 400, String(value));
      assert.equal((await res.json()).code, 'unknown_member');
    }
    assert.equal((await link(1, 'm_parent')).status, 200);
    assert.ok(logged.includes('[suite-link] m_parent linked member 1 to m_parent'), logged.join('\n'));
    // Linked, the parent passes the gate with any spelling; the route still takes only a plain row ID.
    for (const id of ['99', '0', '01', 'abc', '1.5']) assert.equal((await link(id, 'm_parent')).status, 404, id);
    assert.equal(db.rows[0].suite_member_id, 'm_parent');
    const twice = await link(2, 'm_parent');
    assert.equal(twice.status, 409);
    assert.equal((await twice.json()).code, 'already_linked');
    // Linked now: through to the app.
    assert.equal((await get('/api/members', PARENT_HEADERS)).status, 200);

    // A kid's account never takes a parent's row, and the row stays as it was.
    const kidOnParent = await link(2, 'm_kid');
    assert.equal(kidOnParent.status, 409);
    assert.equal((await kidOnParent.json()).code, 'kid_to_parent');
    assert.equal(db.rows[1].suite_member_id, null);
    assert.equal((await link(99, 'm_kid')).status, 404);

    // A kid, linked or not, can't link anyone, even themself, or see the list.
    assert.equal((await link(3, 'm_kid', KID_HEADERS)).status, 403);
    assert.equal((await link(3, 'm_kid')).status, 200);
    assert.equal((await get('/api/members', KID_HEADERS)).status, 200);
    const kidLink = await link(3, null, KID_HEADERS);
    assert.equal(kidLink.status, 403);
    assert.equal((await get('/api/suite/links', KID_HEADERS)).status, 403);
    assert.notEqual((await get('/link', KID_HEADERS)).status, 200);
    assert.equal(db.rows[2].suite_member_id, 'm_kid');

    // Another parent, linked by the first, may change links too; unlinking frees the household member.
    assert.equal((await link(2, 'm_partner')).status, 200);
    assert.equal((await link(3, null, PARTNER_HEADERS)).status, 200);
    assert.ok(logged.includes('[suite-link] m_partner unlinked member 3'), logged.join('\n'));
    assert.equal(db.rows[2].suite_member_id, null);
    assert.equal((await get('/api/members', KID_HEADERS)).status, 403);
    // No log line carries a name.
    assert.ok(logged.filter((line) => line.startsWith('[suite-link]')).every((line) => !/Parent|Partner|Kid/.test(line)));
  });
});

test('the link page is tailnet-only, and needs the directory', async () => {
  // Local mode has no link page: the picker is how people say who they are.
  await withServer({}, {}, household(), async (base) => {
    assert.equal((await fetch(`${base}/api/suite/links`)).status, 404);
    const put = await fetch(`${base}/api/suite/links/1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"suite_member_id":"m_parent"}' });
    assert.equal(put.status, 404);
    assert.equal((await fetch(`${base}/link`)).status, 404);
    assert.equal((await fetch(`${base}/link.html`, { redirect: 'manual' })).status, 303);
  });
  // The directory went away after the gate let the parent in (a snapshot that reads once, then fails).
  let reads = 0;
  const flaky = snapshotOf(MEMBERS);
  const reader = { current: () => (reads++ % 2 === 0 ? flaky.current() : { ok: false, reason: 'missing' }) };
  await withServer(TAILNET, { reader }, household(), async (base) => {
    const res = await fetch(`${base}/api/suite/links`, { headers: PARENT_HEADERS });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'directory');
    reads = 0;
    const put = await fetch(`${base}/api/suite/links/1`, {
      method: 'PUT',
      headers: { ...PARENT_HEADERS, origin: ORIGIN, 'content-type': 'application/json' },
      body: '{"suite_member_id":"m_parent"}',
    });
    assert.equal(put.status, 503);
  });
});

test('the link page works on a phone: every picker it adds is at least 16px', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'link.html'), 'utf8');
  assert.match(html, /\.link-row select \{[^}]*font-size: 1rem/);
  assert.match(html, /@media \(max-width: 520px\)/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
});
