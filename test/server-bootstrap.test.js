'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, pool } = require('../server');

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_CONNECT = pool.connect.bind(pool);

class FakePool {
  constructor(initial = {}) {
    this.config = new Map(Object.entries(initial.config || {}));
    this.members = Array.isArray(initial.members) ? initial.members.map(member => ({ ...member })) : [];
    this.categories = Array.isArray(initial.categories) ? initial.categories.map(category => ({ ...category })) : [];
    this._nextMemberId = this.members.reduce((max, member) => Math.max(max, member.id || 0), 0) + 1;
    this._nextCategoryId = this.categories.reduce((max, category) => Math.max(max, category.id || 0), 0) + 1;
  }

  async query(sql, params = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (sql.trim() === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (sql.includes('SELECT COUNT(*)::int AS count FROM family_members')) {
      return { rows: [{ count: this.members.length }], rowCount: 1 };
    }

    if (sql.includes('SELECT COUNT(*)::int AS count FROM ticket_categories')) {
      return { rows: [{ count: this.categories.length }], rowCount: 1 };
    }

    if (sql.includes('SELECT value FROM app_config WHERE key=$1')) {
      const key = params[0];
      const value = this.config.has(key) ? this.config.get(key) : null;
      return { rows: value == null ? [] : [{ value }], rowCount: value == null ? 0 : 1 };
    }

    if (sql.includes('INSERT INTO app_config')) {
      const [key, value] = params;
      if (!sql.includes('DO NOTHING') || !this.config.has(key)) {
        this.config.set(key, value);
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO family_members')) {
      const [name, role, avatar_emoji] = params;
      const row = { id: this._nextMemberId++, name, role, avatar_emoji };
      this.members.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO ticket_categories')) {
      const [name, guidance, ai_eligible, sort_order] = params;
      if (!this.categories.some(category => category.name === name)) {
        this.categories.push({
          id: this._nextCategoryId++,
          name,
          guidance,
          ai_eligible,
          sort_order,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in fake pool: ${sql}`);
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }
}

function setFakePool(fake) {
  pool.query = fake.query.bind(fake);
  pool.connect = fake.connect.bind(fake);
  return () => {
    pool.query = ORIGINAL_QUERY;
    pool.connect = ORIGINAL_CONNECT;
  };
}

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('bootstrap endpoint reports fresh install needs household setup', async () => {
  const restore = setFakePool(new FakePool());
  try {
    await withServer(async base => {
      const res = await fetch(`${base}/api/bootstrap`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.bootstrap.needs_household, true);
      assert.equal(data.bootstrap.needs_auth, true);
      assert.equal(data.bootstrap.needs_starter_content, true);
      assert.equal(data.bootstrap.ready, false);
    });
  } finally {
    restore();
  }
});

test('root redirects to setup when household is missing', async () => {
  const restore = setFakePool(new FakePool());
  try {
    await withServer(async base => {
      const res = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), 'setup');
    });
  } finally {
    restore();
  }
});

test('bootstrap household creates members, PIN, and starter categories', async () => {
  const fake = new FakePool();
  const restore = setFakePool(fake);
  try {
    await withServer(async base => {
      const res = await fetch(`${base}/api/bootstrap/household`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members: [
            { name: 'Eric', role: 'parent' },
            { name: 'Alex', role: 'parent' },
            { name: 'Casey', role: 'kid' },
          ],
          settings_pin: '1234',
          install_starter_content: true,
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.created_members.length, 3);
      assert.equal(data.bootstrap.needs_household, false);
      assert.equal(data.bootstrap.needs_auth, false);
      assert.equal(data.bootstrap.needs_starter_content, false);
      assert.ok(fake.config.has('settings_pin_hash'));
      assert.ok(fake.categories.length >= 6);
    });
  } finally {
    restore();
  }
});

test('root stays on normal dashboard when household already exists', async () => {
  const restore = setFakePool(new FakePool({
    members: [{ id: 1, name: 'Eric', role: 'parent', avatar_emoji: '👨' }],
    categories: [{ id: 1, name: 'IT / Tech', guidance: '', ai_eligible: true, sort_order: 1 }],
    config: { settings_pin_hash: 'salt:hash' },
  }));
  try {
    await withServer(async base => {
      const res = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(res.status, 200);
    });
  } finally {
    restore();
  }
});
