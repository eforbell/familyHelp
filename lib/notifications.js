'use strict';

// The one brrr-compatible push service this install sends through (PUSH_BASE_URL, default brrr). A malformed
// value is an error, not a fallback: falling back would send a self-hosted service's secrets to brrr.
const DEFAULT_PUSH_BASE_URL = 'https://api.brrr.now';

function pushBaseUrl(value = process.env.PUSH_BASE_URL) {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_PUSH_BASE_URL;
  let url;
  try { url = new URL(raw); } catch { throw new Error('PUSH_BASE_URL is not a valid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    throw new Error('PUSH_BASE_URL must be a plain http(s) URL');
  }
  return url.href.replace(/\/+$/, '');
}

// A saved full URL must belong to the configured service. One left over from another service is refused
// rather than sent, so a switchover can't quietly leave someone on the old service.
function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new Error('Missing brrr target');
  const prefix = `${pushBaseUrl()}/v1/`;
  if (!/^https?:\/\//i.test(raw)) return `${prefix}${raw}`;
  let href = '';
  try { href = new URL(raw).href; } catch { /* refused below */ }
  if (!href.startsWith(prefix)) {
    throw new Error('This saved push target is for a different push service. Save a new secret from the current one.');
  }
  return raw;
}

function notificationInterruptionLevel(priority, fallback = 'active') {
  return priority === 'urgent'
    ? 'time-sensitive'
    : (String(fallback || 'active').trim() || 'active');
}

function buildAssignedTicketNotificationPayload(ticket, options = {}) {
  const actorName = String(options.actorName || 'Someone').trim() || 'Someone';
  const openUrl = String(options.openUrl || '').trim();
  const subtitleParts = [];

  if (ticket.category_name) subtitleParts.push(ticket.category_name);
  subtitleParts.push(`${ticket.priority || 'normal'} priority`);

  return {
    title: `FamilyHelp: ${ticket.title}`,
    subtitle: subtitleParts.join(' • '),
    message: `${actorName} created and assigned a new help ticket to you.`,
    ...(openUrl ? { open_url: openUrl } : {}),
    'interruption-level': notificationInterruptionLevel(ticket.priority, options.defaultInterruptionLevel)
  };
}

async function sendBrrrNotification(secretOrUrl, payload) {
  const targetUrl = normalizeBrrrTarget(secretOrUrl);
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`brrr send failed (${res.status}): ${text || res.statusText}`);
  }

  return res;
}

module.exports = {
  pushBaseUrl,
  buildAssignedTicketNotificationPayload,
  normalizeBrrrTarget,
  notificationInterruptionLevel,
  sendBrrrNotification
};
