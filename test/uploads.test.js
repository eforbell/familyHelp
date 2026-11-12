'use strict';

// An attachment is stored as the type its bytes show, under that type's extension, and a stored file of any other
// kind is handed over as a download. Otherwise a file named .html and declared an image would be served as a page on
// the app's own address, and its script would act as whoever opened it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, pool } = require('../server');

const UPLOADS = path.join(__dirname, '..', 'uploads');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PAGE = Buffer.from('<script>fetch("../api/config", { method: "PUT" })</script>');
const stored = [];

// Postgres as the upload route asks it, in local mode: member 1 is a parent, ticket 1 exists.
const ORIGINAL_QUERY = pool.query;
async function fakeQuery(sql, params = []) {
  if (sql.includes('FROM family_members WHERE id')) return { rows: [{ id: 1, name: 'Parent', role: 'parent' }] };
  if (sql.startsWith('SELECT id FROM tickets')) return { rows: [{ id: 1 }] };
  if (sql.includes('INSERT INTO ticket_attachments')) {
    stored.push(params[1]);
    return { rows: [{ id: 1, ticket_id: 1, filename: params[1], original_name: params[2], mime_type: params[3] }] };
  }
  return { rows: [] };
}

async function withServer(fn) {
  pool.query = fakeQuery;
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    pool.query = ORIGINAL_QUERY;
  }
}

function upload(base, { filename, type, data }) {
  const boundary = 'x-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="uploaded_by"\r\n\r\n1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return fetch(`${base}/api/tickets/1/attachments`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
}

test.after(() => { for (const name of stored) fs.rmSync(path.join(UPLOADS, name), { force: true }); });

test('a file that is not the type it declares is refused, and nothing is stored', async () => {
  await withServer(async (base) => {
    for (const attempt of [
      { filename: 'proof.html', type: 'image/png', data: PAGE },
      { filename: 'proof.png', type: 'image/png', data: PAGE },
      { filename: 'proof.pdf', type: 'application/pdf', data: PNG },
      { filename: 'proof.gif', type: 'image/gif', data: Buffer.from('GIF') },
    ]) {
      const res = await upload(base, attempt);
      assert.equal(res.status, 400, attempt.filename);
    }
    assert.deepEqual(stored, []);
    assert.equal((await upload(base, { filename: 'proof.html', type: 'text/html', data: PAGE })).status, 400);
  });
});

test('a real image is stored under its type\'s extension, whatever its name says, and served as that type', async () => {
  await withServer(async (base) => {
    for (const filename of ['photo.png', 'photo.html', 'photo', 'photo.PNG.svg']) {
      const res = await upload(base, { filename, type: 'image/png', data: PNG });
      assert.equal(res.status, 201, filename);
      const name = stored.at(-1);
      assert.match(name, /^[0-9a-f-]{36}\.png$/, filename);
      const served = await fetch(`${base}/uploads/${name}`);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(served.headers.get('content-disposition'), null);
    }
  });
});

test('a file stored before this rule under another extension is a download, never a page', async () => {
  const legacy = ['html', 'svg', 'js', 'bin'].map((ext) => `${crypto.randomUUID()}.${ext}`);
  for (const name of legacy) fs.writeFileSync(path.join(UPLOADS, name), PAGE);
  stored.push(...legacy);
  await withServer(async (base) => {
    for (const name of legacy) {
      const res = await fetch(`${base}/uploads/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', name);
      assert.equal(res.headers.get('content-disposition'), 'attachment', name);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
    }
  });
});
