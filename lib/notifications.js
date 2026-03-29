'use strict';

function normalizeBrrrTarget(secretOrUrl) {
  const raw = String(secretOrUrl || '').trim();
  if (!raw) throw new Error('Missing brrr target');
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return `https://api.brrr.now/v1/${raw}`;
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

module.exports = { normalizeBrrrTarget, sendBrrrNotification };
