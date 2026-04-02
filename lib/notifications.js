'use strict';

function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new Error('Missing brrr target');
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return `https://api.brrr.now/v1/${raw}`;
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
  buildAssignedTicketNotificationPayload,
  normalizeBrrrTarget,
  notificationInterruptionLevel,
  sendBrrrNotification
};
