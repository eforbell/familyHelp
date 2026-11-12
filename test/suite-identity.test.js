'use strict';

// Suite identity (Home Base Feature-10): the gate in front of every route in tailnet mode. Local mode is the rest of
// the suite, unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSuiteIdentity, homeBaseUid, publicPath } = require('../lib/suite-identity');
const { listenTarget } = require('../lib/listen');
const { app, pool, setSuiteIdentityForTests } = require('../server');

const SOCKET = 'unix:/run/sovereign-apps/family-help/app.sock';
const ORIGIN = 'https://smith-home.example-tailnet.ts.net';
const TAILNET = { SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_LISTEN: SOCKET, SOVEREIGN_HOMEBASE_UID: '998', APP_PUBLIC_URL: `${ORIGIN}/help/` };
const noSnapshot = { current: () => ({ ok: false, reason: 'missing', message: 'no snapshot' }) };
const unlinked = { findLinked: async () => null };

// A directory snapshot as the library hands it over: members by stable user ID.
function snapshotOf(members) {
  const list = members.map((member) => ({ status: 'active', epoch: 1, apps: ['family-help'], role: 'parent', ...member }));
  return { current: () => ({ ok: true, snapshot: { members: list, byUserId: new Map(list.map((member) => [member.userId, member])) } }) };
}
const as = (userId, login) => ({ 'x-sovereign-user-id': userId, 'x-sovereign-login': login });
const PARENT = { userId: 'u-parent', memberId: 'm_parent', login: 'parent@example.com', name: 'Parent' };
const KID = { userId: 'u-kid', memberId: 'm_kid', login: 'kid@example.com', name: '<b>Kid</b>', role: 'kid' };
const PARENT_HEADERS = as('u-parent', 'parent@example.com');
const KID_HEADERS = as('u-kid', 'kid@example.com');
const JSON_WRITE = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };

// Postgres as the gate, the member list, setup and the ticket routes ask it. Family members are kept; setup's
// inserts add to them; anything else reads as empty.
class Db {
  constructor(members, { categories = 6 } = {}) {
    this.members = members.map((member) => ({ ...member }));
    this.categories = categories;
    this.writes = [];
  }
  async query(sql, params = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('FROM family_members WHERE suite_member_id = $1')) return { rows: this.members.filter((row) => row.suite_member_id === params[0]) };
    if (sql.includes('FROM family_members ORDER BY id')) return { rows: this.members.map((row) => ({ ...row })) };
    if (sql.includes('FROM family_members WHERE id = $1') || sql.includes('FROM family_members WHERE id=$1')) {
      return { rows: this.members.filter((row) => String(row.id) === String(params[0])) };
    }
    if (sql.includes('COUNT(*)::int AS count FROM family_members')) return { rows: [{ count: this.members.length }] };
    if (sql.includes('COUNT(*)::int AS count FROM ticket_categories')) return { rows: [{ count: this.categories }] };
    if (sql.includes('INSERT INTO family_members')) {
      const row = { id: this.members.length + 1, name: params[0], role: params[1], avatar_emoji: params[2], suite_member_id: null };
      this.members.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.includes('INSERT INTO ticket_categories')) { this.categories += 1; return { rows: [] }; }
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql)) { this.writes.push({ sql, params }); return { rows: [] }; }
    return { rows: [] };
  }
}

const ORIGINAL_QUERY = pool.query;
const ORIGINAL_CONNECT = pool.connect;
async function withServer(env, db, fn) {
  setSuiteIdentityForTests(env.env, env.options);
  pool.query = db.query.bind(db);
  pool.connect = async () => ({ query: db.query.bind(db), release() {} });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = ORIGINAL_QUERY;
    pool.connect = ORIGINAL_CONNECT;
    setSuiteIdentityForTests({});
  }
}
const tailnet = (members) => ({ env: TAILNET, options: { reader: snapshotOf(members) } });
const household = () => new Db([
  { id: 1, name: 'Parent', role: 'parent', avatar_emoji: '👤', suite_member_id: 'm_parent' },
  { id: 2, name: 'Kid', role: 'kid', avatar_emoji: '👤', suite_member_id: 'm_kid' },
]);

// A request exactly as written: fetch() normalizes paths (dot segments, %2e) and sets Sec-Fetch-Mode itself.
function raw(base, method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = http.request({ hostname, port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('no SOVEREIGN_AUTH_MODE means local: installs from before Home Base set one keep the picker', () => {
  assert.equal(createSuiteIdentity({}).mode, 'local');
  assert.equal(createSuiteIdentity({ SOVEREIGN_AUTH_MODE: 'local' }).mode, 'local');
  assert.equal(createSuiteIdentity({}).tailnet, false);
});

test('a configuration the app cannot trust refuses to start', () => {
  for (const mode of ['', ' ', 'Tailnet', 'off', 'true']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_AUTH_MODE: mode }, unlinked), /SOVEREIGN_AUTH_MODE/, `mode '${mode}'`);
  }
  // Identity headers are trusted only on the app's socket, which only nginx can reach.
  for (const listen of [undefined, '', '127.0.0.1:3002']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_LISTEN: listen }, unlinked), /SOVEREIGN_LISTEN/);
  }
  for (const uid of [undefined, '', '0', '-1', '01', '1e3', '4294967295', '99999999999', 'homebase']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, SOVEREIGN_HOMEBASE_UID: uid }, unlinked), /SOVEREIGN_HOMEBASE_UID/, `uid '${uid}'`);
  }
  for (const url of [undefined, '', 'help', 'http://smith-home.example-tailnet.ts.net/help/']) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, unlinked), /APP_PUBLIC_URL/, `url '${url}'`);
  }
  // The link page redirect is built on the path, so it must stay on this host.
  for (const url of [`${ORIGIN}//evil.example/`, `${ORIGIN}/help//x/`, `${ORIGIN}/he%2Flp/`]) {
    assert.throws(() => createSuiteIdentity({ ...TAILNET, APP_PUBLIC_URL: url }, unlinked), /APP_PUBLIC_URL/, `url '${url}'`);
  }
  for (const [url, path] of [[`${ORIGIN}/help/`, '/help/'], [`${ORIGIN}/help`, '/help/'], [`${ORIGIN}/`, '/']]) {
    assert.equal(publicPath(url), path);
  }
  assert.equal(homeBaseUid('998'), 998);
  assert.throws(() => createSuiteIdentity(TAILNET), /find linked members/);
  assert.equal(createSuiteIdentity(TAILNET, unlinked).mode, 'tailnet');
});

test('tailnet mode always listens on the socket: the identity headers are trusted only there', () => {
  // The server listens where lib/listen.js says. Every configuration tailnet mode accepts names a socket there, and a
  // TCP listener (HOST/PORT) is never chosen while SOVEREIGN_LISTEN is set: a local process could forge the headers.
  assert.deepEqual(listenTarget({ ...TAILNET, HOST: '127.0.0.1', PORT: '3002' }), { socket: '/run/sovereign-apps/family-help/app.sock' });
  for (const listen of ['unix:/run/sovereign-apps/family-help/app.sock', 'unix:/tmp/x.sock']) {
    const env = { ...TAILNET, SOVEREIGN_LISTEN: listen };
    assert.equal(createSuiteIdentity(env, unlinked).mode, 'tailnet');
    assert.ok(listenTarget(env).socket, listen);
  }
});

test('tailnet mode takes writes only as JSON from the app\'s own origin', async () => {
  await withServer(tailnet([PARENT]), new Db([{ id: 1, name: 'Parent', role: 'parent', suite_member_id: null }]), async (base) => {
    // Setup is a write an unlinked parent may reach; once a household exists it refuses, after the guard.
    const setup = (headers) => fetch(`${base}/api/bootstrap/household`, { method: 'POST', headers: { ...PARENT_HEADERS, ...headers }, body: '{}' });
    const refusals = [
      [{}, 'origin_missing'],
      [{ origin: 'https://smith-pulse.example-tailnet.ts.net', 'content-type': 'application/json' }, 'origin_mismatch'],
      [{ origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 'fetch_site'],
      [{ origin: ORIGIN }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'text/plain' }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 'content_type'],
      [{ origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' }, 'content_type'],
    ];
    for (const [headers, reason] of refusals) {
      const res = await setup(headers);
      assert.equal(res.status, 403, reason);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal((await res.json()).reason, reason);
    }
    const res = await setup(JSON_WRITE);
    assert.equal(res.status, 409, 'through the guard and the gate to the handler');
    assert.equal((await res.json()).code, 'household_already_initialized');
  });
});

test('only the attachment upload, in its exact spelling, also takes a multipart form', async () => {
  await withServer(tailnet([PARENT]), household(), async (base) => {
    const multipart = { ...PARENT_HEADERS, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x' };
    // Through the guard and the gate: the handler finds no file in an empty form.
    const upload = await raw(base, 'POST', '/api/tickets/1/attachments', multipart, '--x--\r\n');
    assert.equal(upload.status, 400);
    assert.equal(upload.json().error, 'No file provided');
    // Still only from the app's own origin.
    for (const [headers, reason] of [
      [{ ...multipart, origin: 'https://smith-pulse.example-tailnet.ts.net' }, 'origin_mismatch'],
      [{ ...multipart, origin: undefined }, 'origin_missing'],
      [{ ...multipart, 'sec-fetch-site': 'same-site' }, 'fetch_site'],
      [{ ...multipart, 'content-type': 'text/plain' }, 'content_type'],
    ]) {
      if (headers.origin === undefined) delete headers.origin;
      const res = await raw(base, 'POST', '/api/tickets/1/attachments', headers, '--x--\r\n');
      assert.equal(res.status, 403, reason);
      assert.equal(res.json().reason, reason);
    }
    // Any other route or spelling, or any other method, is held to JSON.
    const others = [
      ['POST', '/api/tickets/1/attachments/'], ['POST', '/API/tickets/1/attachments'], ['POST', '/api/Tickets/1/Attachments'],
      ['POST', '/api/tickets/01/attachments'], ['POST', '//api/tickets/1/attachments'], ['POST', '/api/tickets/1/./attachments'],
      ['POST', '/api/tickets/x/../1/attachments'], ['POST', '/api/tickets/1/%2e%2e/1/attachments'],
      ['PUT', '/api/tickets/1/attachments'], ['DELETE', '/api/tickets/1/attachments'],
      ['POST', '/api/tickets/1/comments'], ['POST', '/api/tickets'], ['PUT', '/api/config'], ['POST', '/api/categories'],
    ];
    for (const [method, path] of others) {
      const res = await raw(base, method, path, multipart, '--x--\r\n');
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.json().reason, 'content_type', `${method} ${path}`);
    }
  });
});

test('tailnet mode lets in only a household member with access whom a parent has linked', async () => {
  const members = [
    PARENT,
    KID,
    { userId: 'u-away', memberId: 'm_away', login: 'away@example.com', name: 'Away', status: 'disabled' },
    { userId: 'u-other', memberId: 'm_other', login: 'other@example.com', name: 'Other', apps: ['family-plan'] },
    { userId: 'u-new', memberId: 'm_new', login: 'new@example.com', name: 'New kid', role: 'kid' },
  ];
  await withServer(tailnet(members), household(), async (base) => {
    const get = (route, headers = {}) => fetch(`${base}${route}`, { headers, redirect: 'manual' });
    // Linked: through to the app, parent and kid alike.
    assert.equal((await get('/api/members', PARENT_HEADERS)).status, 200);
    assert.equal((await get('/api/members', KID_HEADERS)).status, 200);
    assert.equal((await get('/board', PARENT_HEADERS)).status, 200);

    const refused = [
      [{}, 'not_member'],                                                     // no identity: tagged device, lookup failed
      [as('u-parent', 'someone@example.com'), 'not_member'],                  // the login must match the user ID
      [as('u-nobody', 'nobody@example.com'), 'not_member'],                   // not in the household
      [as('u-away', 'away@example.com'), 'not_member'],                       // disabled
      [as('u-other', 'other@example.com'), 'not_member'],                     // no access to Family Help
      [{ 'x-sovereign-user-id': 'u-parent', 'x-sovereign-login': 'tagged-devices' }, 'not_member'],
      [as('u-new', 'new@example.com'), 'not_linked'],                         // a kid nobody has linked yet
    ];
    for (const [headers, code] of refused) {
      for (const route of ['/api/members', '/API/members', '/api/members/', '/Api/Members/', '/api/health/', '/API/ready']) {
        const api = await get(route, headers);
        assert.equal(api.status, 403, `${code} ${route}`);
        assert.equal((await api.json()).code, code, route);
        assert.equal(api.headers.get('cache-control'), 'no-store');
      }
      for (const route of ['/', '/board', '/new', '/ticket/1', '/settings', '/setup', '/index.html', '/link', '/uploads/a.png']) {
        const page = await get(route, headers);
        assert.equal(page.status, 403, `${code} ${route}`);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.equal(page.headers.get('cache-control'), 'no-store');
      }
    }
    // Spellings no route or file knows go through the gate too.
    for (const path of ['//api/members', '/api/%2e%2e/api/members', '/%2e%2e/api/members', '/api/./members', '/UPLOADS/a.png',
      '/uploads//a.png', '/uploads/%2e%2e/server.js', '/ticket/style.css', '/x/style.css', '//style.css']) {
      const res = await raw(base, 'GET', path);
      assert.equal(res.status, 403, path);
      assert.equal(res.headers['cache-control'], 'no-store', path);
    }
    // The page names who is asking, as text.
    const kidPage = await (await get('/', as('u-new', 'new@example.com'))).text();
    assert.match(kidPage, /Ask a parent to link you/);
    assert.match(kidPage, /New kid/);
    // Health, readiness and page assets are open; data, pages and uploaded files are not.
    assert.equal((await get('/api/health')).status, 200);
    assert.equal((await get('/api/ready')).status, 200);
    assert.equal((await get('/style.css')).status, 200);
    assert.equal((await get('/app.js')).status, 200);
    assert.equal((await get('/favicon.svg')).status, 200);
    assert.equal((await get('/sovereign-fonts.css')).status, 200);
    assert.equal((await fetch(`${base}/style.css`, { method: 'HEAD' })).status, 200);
    assert.equal((await get('/api/bootstrap')).status, 403);
    assert.equal((await get('/api/categories')).status, 403);
    assert.equal((await fetch(`${base}/style.css`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' } })).status, 403);
    assert.equal((await fetch(`${base}/api/health`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' } })).status, 403);
  });

  // Without a snapshot nobody is a member: say so, and that it's not the asker's doing.
  await withServer({ env: TAILNET, options: { reader: noSnapshot } }, household(), async (base) => {
    const res = await fetch(`${base}/api/members`, { headers: PARENT_HEADERS });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).code, 'directory');
    const page = await fetch(`${base}/`, { headers: PARENT_HEADERS });
    assert.equal(page.status, 503);
    assert.match(await page.text(), /tell whoever runs Home Base/);
  });

  // Local mode ignores identity headers entirely.
  await withServer({ env: {} }, household(), async (base) => {
    assert.equal((await fetch(`${base}/api/members`)).status, 200);
    assert.equal((await fetch(`${base}/api/members`, { headers: as('u-nobody', 'nobody@example.com') })).status, 200);
  });
});

test('a kid\'s account opens only a kid\'s row, checked on every request', async () => {
  // Linked as a parent row; the directory has since made them a kid.
  const db = new Db([{ id: 1, name: 'Parent', role: 'parent', suite_member_id: 'm_kid' }]);
  await withServer(tailnet([KID]), db, async (base) => {
    for (const route of ['/api/members', '/api/categories', '/API/members/']) {
      const res = await fetch(`${base}${route}`, { headers: KID_HEADERS });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 'stale_link');
    }
    const page = await fetch(`${base}/`, { headers: KID_HEADERS });
    assert.equal(page.status, 403);
    const text = await page.text();
    assert.match(text, /Ask a parent to link you again/);
    // The page names who is asking, as text: a name is never markup.
    assert.match(text, /&lt;b&gt;Kid&lt;\/b&gt;/);
    assert.doesNotMatch(text, /<b>Kid/);
  });
});

test('a parent nobody has linked reaches the link page and setup, and nothing about the household', async () => {
  const db = new Db([{ id: 1, name: 'Parent', role: 'parent', suite_member_id: null }]);
  await withServer(tailnet([PARENT]), db, async (base) => {
    const get = (route) => fetch(`${base}${route}`, { headers: PARENT_HEADERS, redirect: 'manual' });
    for (const route of ['/', '/board', '/new', '/ticket/1', '/settings', '/index.html', '/link.html', '/setup.html',
      '/LINK', '/link/', '/setup/', '/Setup', '/uploads/a.png']) {
      const res = await get(route);
      assert.equal(res.status, 303, route);
      assert.equal(res.headers.get('location'), '/help/link', route);
    }
    for (const route of ['/api/members', '/API/me', '/api/me/', '/api/categories', '/api/tickets?member_id=1', '/api/settings/status',
      '/api/suite/links/01', '/API/suite/links', '/api/suite/links/', '/api/bootstrap/', '/API/bootstrap']) {
      const res = await get(route);
      assert.equal(res.status, 403, route);
      assert.equal((await res.json()).code, 'not_linked', route);
    }
    const write = (route, method = 'POST') => fetch(`${base}${route}`, { method, headers: { ...PARENT_HEADERS, ...JSON_WRITE }, body: '{}' });
    for (const route of ['/api/tickets', '/api/categories', '/api/settings/unlock', '/api/bootstrap/household/', '/API/bootstrap/starter-content']) {
      const res = await write(route);
      assert.equal(res.status, 403, route);
      assert.equal((await res.json()).code, 'not_linked', route);
    }
    // Admitted: the link page and its list (test/suite-links.test.js covers them), and a link route (no GET on it,
    // so 404 means the gate let it through).
    assert.equal((await get('/link')).status, 200);
    assert.equal((await get('/api/suite/links')).status, 200);
    assert.equal((await get('/api/suite/links/1')).status, 404);
    // Who am I: nobody yet, in tailnet mode (the setup page hides its PIN fields on that).
    assert.deepEqual(await (await get('/api/me')).json(), { mode: 'tailnet', member: null });
    // Setup redirects home once a household exists; the gate then sends them to the link page.
    assert.equal((await get('/setup')).headers.get('location'), './');
    // Setup's status says only whether a household is still needed: no counts, no PIN or starter-content state.
    const status = await get('/api/bootstrap');
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), { app: 'family-help', bootstrap: { needs_household: false } });
    // Setup's writes refuse once there is a household, starter content included (even with no categories).
    db.categories = 0;
    for (const route of ['/api/bootstrap/household', '/api/bootstrap/starter-content']) {
      const res = await write(route);
      assert.equal(res.status, 409, route);
      assert.equal((await res.json()).code, 'household_already_initialized', route);
    }
    assert.equal(db.categories, 0);
  });
  // Linked, the full status as before; and starter content is still first-run only.
  const linked = household();
  linked.categories = 0;
  await withServer(tailnet([PARENT]), linked, async (base) => {
    const body = await (await fetch(`${base}/api/bootstrap`, { headers: PARENT_HEADERS })).json();
    assert.equal(body.counts.family_members, 2);
    assert.equal(body.bootstrap.needs_starter_content, true);
    const res = await fetch(`${base}/api/bootstrap/starter-content`, { method: 'POST', headers: { ...PARENT_HEADERS, ...JSON_WRITE }, body: '{}' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'household_already_initialized');
  });
  // Local mode: starter content installs whenever there are no categories, as before.
  const local = household();
  local.categories = 0;
  await withServer({ env: {} }, local, async (base) => {
    const res = await fetch(`${base}/api/bootstrap/starter-content`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 201);
    assert.ok((await res.json()).bootstrap.ready !== undefined);
  });
});

test('first-run setup in tailnet mode: an unlinked parent creates the household and learns nothing else', async () => {
  const db = new Db([], { categories: 0 });
  await withServer(tailnet([PARENT]), db, async (base) => {
    const get = (route) => fetch(`${base}${route}`, { headers: PARENT_HEADERS, redirect: 'manual' });
    assert.equal((await get('/setup')).status, 200);
    assert.equal((await get('/')).headers.get('location'), '/help/link');
    assert.deepEqual(await (await get('/api/bootstrap')).json(), { app: 'family-help', bootstrap: { needs_household: true } });
    // Starter content first, while there is no household: what it answers is only whether a household is needed.
    const starter = await fetch(`${base}/api/bootstrap/starter-content`, { method: 'POST', headers: { ...PARENT_HEADERS, ...JSON_WRITE }, body: '{}' });
    assert.equal(starter.status, 201);
    assert.deepEqual(await starter.json(), { ok: true, bootstrap: { needs_household: true } });
    const res = await fetch(`${base}/api/bootstrap/household`, {
      method: 'POST',
      headers: { ...PARENT_HEADERS, ...JSON_WRITE },
      body: JSON.stringify({ members: [{ name: 'Parent', role: 'parent' }, { name: 'Kid', role: 'kid' }] }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['bootstrap', 'created_members', 'ok']);
    assert.deepEqual(body.bootstrap, { needs_household: false });
    assert.deepEqual(body.created_members.map((member) => member.name), ['Parent', 'Kid']);
    // Now there is a household: the parent links themself next.
    assert.equal((await get('/setup')).headers.get('location'), './');
    assert.equal((await get('/link')).status, 200);
  });
});

test('the API is for Family Help\'s own pages: a navigation to it is refused, in any spelling', async () => {
  await withServer(tailnet([PARENT]), household(), async (base) => {
    const navigate = (route) => raw(base, 'GET', route, { ...PARENT_HEADERS, 'sec-fetch-mode': 'navigate' });
    for (const route of ['/api/members', '/API/Members', '/api/members/', '/api/tickets?member_id=1', '/Api/config', '/api/me',
      '/api/%2e%2e/api/members', '/api', '/API/']) {
      const res = await navigate(route);
      assert.equal(res.status, 403, route);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.equal(res.json().code, 'not_a_page', route);
    }
    // The pages' own fetches are not navigations; pages and uploaded files may be navigated to.
    assert.equal((await fetch(`${base}/api/members`, { headers: { ...PARENT_HEADERS, 'sec-fetch-mode': 'cors' } })).status, 200);
    assert.equal((await navigate('/board')).status, 200);
    assert.equal((await navigate('/uploads/missing.png')).status, 404);
  });
});
