'use strict';

// Suite identity (Home Base Feature-10). SOVEREIGN_AUTH_MODE picks how Family Help knows who is asking: 'local' is
// the member picker on each device and the settings PIN, 'tailnet' the household member nginx names. Home Base
// writes the mode when it switches the app over; an install from before that has none, which means local.
const { createIdentity, createRequestGuard, createSnapshotReader, guardExpress } = require('sovereign-auth');

const APP_ID = 'family-help';

// SOVEREIGN_HOMEBASE_UID: the owner Home Base gives its directory snapshot. Never root.
function homeBaseUid(value) {
  const text = String(value ?? '').trim();
  const uid = /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : NaN;
  if (!(uid < 4294967295)) throw new Error(`SOVEREIGN_HOMEBASE_UID must be the Home Base user's uid, not '${text}'`);
  return uid;
}

// The origin every write must come from in tailnet mode: the address Home Base publishes the app at.
function publicOrigin(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error(`tailnet mode needs APP_PUBLIC_URL, the app's https address, not '${value ?? ''}'`);
  return url.origin;
}

// Where the app's pages live under that address (/help/). Plain path segments only, so a redirect built on it
// stays on this host: '//elsewhere/' would send the browser off it.
function publicPath(value) {
  const { pathname } = new URL(String(value));
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*(?:[A-Za-z0-9._~-]+)?$/.test(pathname)) {
    throw new Error(`APP_PUBLIC_URL must have a plain path such as /help/, not '${pathname}'`);
  }
  return pathname.replace(/\/?$/, '/');
}

// Requests that need no member, reads only: Home Base's health and readiness probes, which come over the socket
// without identity headers, and the page assets at the root (scripts, styles, icons: never data). Pages and uploaded
// files go through the gate.
const OPEN_PATHS = new Set(['/api/health', '/api/ready']);
const ASSET_PATH = /^\/[\w.-]+\.(?:css|js|svg|ico|png|woff2?)$/;
// What a parent nobody has linked yet may use: the link page and its API, and first-run setup while Family Help has
// no household (setup refuses once one exists, and its status says nothing more to an unlinked parent). Anything
// else sends them to the link page. Exact spellings: a spelling this doesn't know is refused.
const UNLINKED_PARENT_PATHS = new Set([
  '/link', '/api/suite/links', '/setup', '/api/bootstrap', '/api/bootstrap/household', '/api/bootstrap/starter-content', '/api/me',
]);
const LINK_ROUTE = /^\/api\/suite\/links\/[1-9][0-9]{0,9}$/;
// The attachment upload, the one write that is a multipart form. Exact: any other spelling is held to JSON.
const UPLOAD_ROUTE = /^\/api\/tickets\/[1-9][0-9]{0,9}\/attachments$/;

// What a kid may use, by method and exact path: what a kid can do in local mode, as the existing role rules allow.
// The pages they use (the dashboard, the board, a new request, a ticket), the reads those pages make, the uploaded
// files those reads list, and on a ticket they may see: opening it, changing its status or taking it, commenting,
// attaching, snoozing its reminders, and asking MagicHelp. Settings, configuration, notification channels,
// categories, removing attachments, linking and setup are a parent's. Each route here acts as the kid's own linked
// member, with the directory's role, whatever the request says (server.js). A spelling this doesn't know is refused:
// pages go to the main page, the API answers 403.
const ID = '[1-9][0-9]{0,9}';
const KID_ROUTES = {
  GET: [
    /^\/(?:board|new)?$/,
    new RegExp(`^/ticket/${ID}$`),
    /^\/api\/(?:me|members|categories|tickets)$/,
    new RegExp(`^/api/tickets/${ID}(?:/comments|/attachments)?$`),
    /^\/uploads\/[^/]+$/,
  ],
  POST: [
    /^\/api\/tickets$/,
    new RegExp(`^/api/tickets/${ID}/(?:comments|attachments|snooze|magic-help|magic-help-followup|magic-help-feedback)$`),
  ],
  PUT: [new RegExp(`^/api/tickets/${ID}$`)],
  DELETE: [new RegExp(`^/api/tickets/${ID}/snooze$`)],
};
function kidMayUse(req) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const routes = Object.hasOwn(KID_ROUTES, method) ? KID_ROUTES[method] : [];
  return routes.some((route) => route.test(req.path));
}

// Express matches routes in any letter case. A check that refuses something has to see every spelling that reaches
// the route, so whether a path is the API is decided without regard to case.
const isApiPath = (path) => /^\/api(?:\/|$)/i.test(path);

const REFUSALS = {
  directory: {
    status: 503,
    title: 'Family Help can\'t check who you are right now',
    text: 'It couldn\'t read the household directory from Home Base. Try again in a minute, and if this keeps happening, tell whoever runs Home Base.',
  },
  not_member: {
    status: 403,
    title: 'Family Help doesn\'t know you yet',
    text: 'Ask whoever runs Home Base to give you access to Family Help.',
  },
  not_linked: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account isn\'t linked to anyone in Family Help yet. Ask a parent to link you.',
  },
  stale_link: {
    status: 403,
    title: 'Almost there',
    text: 'Your household account is now a kid\'s, but it\'s still linked to a parent in Family Help. Ask a parent to link you again.',
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function askPage({ title, text }, name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Family Help</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    font: 16px/1.5 system-ui, -apple-system, sans-serif; background: #f4f5f7; color: #1f2933; }
  main { max-width: 28rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #52606d; }
  @media (prefers-color-scheme: dark) { body { background: #14171c; color: #e4e7eb; } p { color: #9aa5b1; } }
</style>
</head>
<body><main><h1>${escapeHtml(name ? `${title}, ${name}` : title)}</h1><p>${escapeHtml(text)}</p></main></body>
</html>
`;
}

function refuse(req, res, code, member) {
  const refusal = REFUSALS[code];
  res.status(refusal.status).set('Cache-Control', 'no-store');
  if (isApiPath(req.path)) return res.json({ error: refusal.title, code });
  return res.type('html').send(askPage(refusal, member?.name));
}

// createSuiteIdentity(env) checks the configuration once, at startup: an unknown mode, or tailnet mode off the app's
// socket or without Home Base's uid and the public address, refuses to start. findLinked(memberId) returns the
// family_members row a parent linked to that directory member, or null.
function createSuiteIdentity(env = process.env, { reader, findLinked } = {}) {
  const mode = env.SOVEREIGN_AUTH_MODE === undefined ? 'local' : env.SOVEREIGN_AUTH_MODE;
  const tailnet = String(mode).trim() === 'tailnet';
  const snapshotReader = tailnet ? reader || createSnapshotReader({ homeBaseUid: homeBaseUid(env.SOVEREIGN_HOMEBASE_UID) }) : null;
  const identity = createIdentity({ appId: APP_ID, mode, listen: env.SOVEREIGN_LISTEN, reader: snapshotReader });
  // In tailnet mode the member's identity rides on every request, like a cookie, so a write is accepted only as JSON
  // from Family Help's own origin (wire contract, section 4.2). Sibling hostnames are one browser site. Family Help
  // is a low-friction app on the shared hostname: the mutation guard only, no resource isolation. The attachment
  // upload also takes a multipart form; the Origin check still applies to it.
  let guard = (_req, _res, next) => next();
  if (tailnet) {
    const origin = publicOrigin(env.APP_PUBLIC_URL);
    const writes = guardExpress(createRequestGuard({ origin, isolate: false }), { mode: 'enforce' });
    const uploads = guardExpress(createRequestGuard({ origin, isolate: false, contentTypes: ['application/json', 'multipart/form-data'] }), { mode: 'enforce' });
    guard = (req, res, next) => (req.method === 'POST' && UPLOAD_ROUTE.test(req.path) ? uploads : writes)(req, res, next);
  }
  const basePath = tailnet ? publicPath(env.APP_PUBLIC_URL) : null;
  if (tailnet && typeof findLinked !== 'function') throw new Error('tailnet mode needs a way to find linked members');

  // The household members with access to Family Help, as the directory says now, or null without a snapshot.
  function directory() {
    const state = snapshotReader?.current();
    if (!state?.ok) return null;
    return state.snapshot.members
      .filter((member) => member.status === 'active' && member.apps.includes(APP_ID) && member.login !== 'tagged-devices')
      .map(({ memberId, name, role }) => ({ memberId, name, role }));
  }

  // In tailnet mode every request but the open ones needs a household member with access to Family Help, linked to
  // one of its family members; a parent nobody has linked yet goes to the link page, and anyone else gets a page
  // saying who to ask. Local mode keeps the picker.
  async function requireMember(req, res, next) {
    if (!tailnet) return next();
    if (['GET', 'HEAD'].includes(req.method) && (OPEN_PATHS.has(req.path) || ASSET_PATH.test(req.path))) return next();
    const isApi = isApiPath(req.path);
    // The API is for Family Help's own pages: a sibling hostname can navigate here with the member's identity.
    if (isApi && req.headers['sec-fetch-mode'] === 'navigate') {
      return res.status(403).set('Cache-Control', 'no-store').json({ error: 'This address is only for Family Help\'s own pages.', code: 'not_a_page' });
    }
    const { member, reason } = identity.identify(req.headers);
    if (!member) return refuse(req, res, reason === 'no_snapshot' ? 'directory' : 'not_member');
    let row;
    try {
      row = await findLinked(member.memberId);
    } catch (err) {
      return next(err);
    }
    const isParent = member.role === 'parent';
    if (!row && !isParent) return refuse(req, res, 'not_linked', member);
    // A kid's account opens only a kid's row. The directory can change a role at any time after the link was made,
    // so this is checked on every request.
    if (row && !isParent && row.role !== 'kid') return refuse(req, res, 'stale_link', member);
    if (!row && !UNLINKED_PARENT_PATHS.has(req.path) && !LINK_ROUTE.test(req.path)) {
      if (req.method === 'GET' && !isApi) return res.redirect(303, `${basePath}link`);
      return refuse(req, res, 'not_linked', member);
    }
    // The directory's role, read on every request, decides what they may do; the row's stored role never grants it.
    if (!isParent && !kidMayUse(req)) {
      res.set('Cache-Control', 'no-store');
      if (isApi) return res.status(403).json({ error: 'A parent does that', code: 'parent_only' });
      return res.redirect(303, basePath);
    }
    req.suiteMember = member;
    req.familyMember = row;
    return next();
  }

  return { mode: identity.mode, tailnet, identity, guard, requireMember, directory };
}

module.exports = { APP_ID, createSuiteIdentity, homeBaseUid, publicOrigin, publicPath };
