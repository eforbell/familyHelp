'use strict';

// Under Home Base's suite identity (tailnet mode) every write must say it is JSON, even with no body (a DELETE, a
// POST that only triggers something), and come from Family Help's own origin. The one exception is the attachment
// upload, a real multipart form. A page write that forgets the header works in local mode and is refused only on a
// tailnet household, so every page write is checked here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');

// The end of the argument list that opens at text[open] ('('), skipping string and template literals (a ')' inside a
// URL or message is not syntax) and following ${...} inside templates.
function closingParen(text, open) {
  const stack = [')'];
  for (let i = open + 1; i < text.length; i += 1) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') i += 1;
      else if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') { stack.push('}'); i += 1; }
      continue;
    }
    if (c === "'" || c === '"') {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === '\\') i += 1;
      continue;
    }
    if (c === '`') stack.push('`');
    else if (c === '(') stack.push(')');
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === top) { stack.pop(); if (!stack.length) return i; }
  }
  return text.length - 1;
}

// Every request the text makes, with its whole argument list: fetch(...) and the pages' api(...) helper, which
// passes its arguments to fetch as they are. Not the helper's own definition.
function requestCalls(text) {
  const calls = [];
  for (const match of text.matchAll(/\b(?:fetch|api)\s*\(/g)) {
    if (/\bfunction\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
    const open = match.index + match[0].length - 1;
    calls.push(text.slice(match.index, closingParen(text, open) + 1));
  }
  return calls;
}

// The pages' helper: the one call allowed to pass options it can't show here, because every call to it is checked.
const HELPER = /async function api\(url, opts\) \{\n {2}const res = await fetch\(url, opts\);/;
// The attachment upload: a multipart form the browser builds, the one write that isn't JSON.
const UPLOAD = "fetch(`../api/tickets/${ticket.id}/attachments`, { method: 'POST', body: form })";

// A call that names a method at all (literal, shorthand `{ method }`, or built) is a write unless it is a literal GET.
const NAMES_METHOD = /\bmethod\b/;
const LITERAL_GET = /\bmethod:\s*['"`]GET['"`]/;
const JSON_TYPE = /'Content-Type':\s*'application\/json'/;

function pageSources() {
  return fs.readdirSync(PUBLIC).filter((name) => name.endsWith('.js') || name.endsWith('.html'))
    .map((name) => [name, fs.readFileSync(path.join(PUBLIC, name), 'utf8')]);
}

test('every page write says it is JSON, even with no body; only the attachment upload is multipart', () => {
  let writes = 0;
  let uploads = 0;
  for (const [name, text] of pageSources()) {
    for (const call of requestCalls(text)) {
      if (call === 'fetch(url, opts)') {
        assert.match(text, HELPER, `${name}: fetch(url, opts) only inside the api(url, opts) helper`);
        continue;
      }
      // Options must be written inline, where this can read them: a second argument that isn't an object literal
      // (options held in a variable) can't be checked, so it isn't allowed.
      const args = call.slice(call.indexOf('(') + 1);
      assert.ok(!/^[^,]*,\s*[A-Za-z_$]/.test(args) || /^[^,]*,\s*\{/.test(args), `${name}: request options must be inline: ${call.replace(/\s+/g, ' ')}`);
      if (!NAMES_METHOD.test(call) || LITERAL_GET.test(call)) continue;
      if (name === 'ticket.js' && call === UPLOAD) { uploads += 1; continue; }
      writes += 1;
      assert.match(call, JSON_TYPE, `${name}: ${call.replace(/\s+/g, ' ')}`);
    }
  }
  // Guards the scan itself: if it stopped finding writes, the assertions above would pass on nothing.
  assert.ok(writes >= 25, `found ${writes} page writes`);
  assert.equal(uploads, 1, 'the attachment upload is where this test expects it');
});

test('pages write only through fetch: no form posts or beacons, and FormData only for the upload', () => {
  for (const [name, text] of pageSources()) {
    assert.doesNotMatch(text, /<form[^>]*\bmethod\s*=/i, `${name}: a form that submits itself`);
    assert.doesNotMatch(text, /<form[^>]*\baction\s*=/i, `${name}: a form that submits itself`);
    assert.doesNotMatch(text, /\bformmethod\s*=|\bformaction\s*=/i, `${name}: a button that submits its form`);
    assert.doesNotMatch(text, /\bXMLHttpRequest\b|\bsendBeacon\b/, name);
    const formData = text.match(/\bnew FormData\b/g) || [];
    assert.equal(formData.length, name === 'ticket.js' ? 1 : 0, `${name}: FormData is for the attachment upload only`);
  }
});
