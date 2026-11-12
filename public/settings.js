// Ignore verification replies superseded by another save, clear, or check.
const pushRegistrationRequests = new Map();
/* familyHelp — Settings */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');
let notificationChannels = [];

async function init() {
  await loadSuiteMe();
  if (currentMember) {
    document.getElementById('memberBadge').textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;
  }
  await checkAuth();
}

async function checkAuth() {
  const status = await api('api/settings/status');
  // Tailnet mode: no PIN. The directory's parent role opens Settings, so instead of Lock, a parent gets the page that
  // links household accounts to HelpDesk members.
  if (status.tailnet) {
    const linkPage = document.createElement('a');
    linkPage.href = 'link';
    linkPage.className = 'btn btn-secondary btn-small';
    linkPage.textContent = 'Household accounts';
    document.querySelector('button[onclick="lock()"]')?.replaceWith(linkPage);
    if (status.unlocked) showSettings();
    return;
  }
  if (!status.configured) {
    document.getElementById('pinSetup').style.display = 'flex';
    return;
  }
  if (status.unlocked) {
    showSettings();
    return;
  }
  document.getElementById('pinScreen').style.display = 'flex';
  document.getElementById('pinInput').focus();
}

async function setupPin() {
  const pin = document.getElementById('newPinInput').value.trim();
  const errEl = document.getElementById('setupError');
  if (pin.length < 4) { errEl.textContent = 'PIN must be at least 4 characters'; return; }
  try {
    await api('api/settings/setup-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    document.getElementById('pinSetup').style.display = 'none';
    showSettings();
  } catch (err) { errEl.textContent = err.message; }
}

async function unlock() {
  const pin = document.getElementById('pinInput').value.trim();
  const errEl = document.getElementById('pinError');
  try {
    await api('api/settings/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    document.getElementById('pinScreen').style.display = 'none';
    showSettings();
  } catch (err) { errEl.textContent = err.message; }
}

async function lock() {
  await api('api/settings/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  document.getElementById('settingsContent').style.display = 'none';
  document.getElementById('pinScreen').style.display = 'flex';
  document.getElementById('pinInput').value = '';
  document.getElementById('pinInput').focus();
}

async function showSettings() {
  document.getElementById('settingsContent').style.display = 'block';
  await Promise.all([
    loadCategories(),
    loadMembers(),
    loadMagicHelpSettings(),
    loadReminderSettings(),
    loadNotificationChannels()
  ]);
}

async function loadCategories() {
  const cats = await api('api/categories');
  const el = document.getElementById('categoryList');
  el.innerHTML = cats.map(c => `
    <div class="cat-row">
      <span class="cat-name">${esc(c.name)}</span>
      <label style="font-size:0.8rem; color:var(--text-muted); display:flex; align-items:center; gap:0.3rem;">
        <input type="checkbox" ${c.ai_eligible ? 'checked' : ''} onchange="toggleAiEligible(${c.id}, this.checked)">
        AI
      </label>
      <button class="btn btn-danger btn-small" onclick="deleteCategory(${c.id})" style="padding:0.2rem 0.4rem; font-size:0.75rem;">Remove</button>
    </div>
  `).join('');
}

async function addCategory() {
  const name = document.getElementById('newCatName').value.trim();
  if (!name) return;
  try {
    await api('api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    document.getElementById('newCatName').value = '';
    loadCategories();
  } catch (err) { alert(err.message); }
}

async function toggleAiEligible(id, enabled) {
  try {
    await api(`api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_eligible: enabled })
    });
  } catch (err) { alert(err.message); loadCategories(); }
}

async function deleteCategory(id) {
  if (!confirm('Remove this category?')) return;
  try {
    await api(`api/categories/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    loadCategories();
  } catch (err) { alert(err.message); }
}

async function loadMembers() {
  const members = await api('api/members');
  const el = document.getElementById('memberList');
  el.innerHTML = members.map(m => `
    <div class="cat-row">
      <span>${m.avatar_emoji} ${esc(m.name)}</span>
      <span style="color:var(--text-muted); font-size:0.8rem;">${m.role}</span>
    </div>
  `).join('');
}

async function loadReminderSettings() {
  try {
    const config = await api('api/config');
    document.getElementById('remindersEnabled').checked = config.reminders_enabled === 'true';
    document.getElementById('reminderInterruptionLevel').value = config.reminder_brrr_interruption_level || 'active';
    document.getElementById('reminderBaseUrl').value = config.reminder_base_url || '';
  } catch (err) {
    console.error('Failed to load reminder settings:', err.message);
  }
}

async function saveReminderSettings() {
  const statusEl = document.getElementById('reminderSaveStatus');
  statusEl.textContent = 'Saving...';
  try {
    const enabled = document.getElementById('remindersEnabled').checked;
    const interruptionLevel = document.getElementById('reminderInterruptionLevel').value;
    const baseUrl = document.getElementById('reminderBaseUrl').value.trim();
    await Promise.all([
      api('api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'reminders_enabled', value: enabled ? 'true' : 'false' })
      }),
      api('api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'reminder_brrr_interruption_level', value: interruptionLevel })
      }),
      api('api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'reminder_base_url', value: baseUrl })
      })
    ]);
    statusEl.textContent = 'Saved';
    setTimeout(() => statusEl.textContent = '', 2000);
  } catch (err) {
    statusEl.textContent = '';
    alert(err.message);
  }
}

async function loadNotificationChannels() {
  try {
    notificationChannels = await api('api/notification-channels');
    renderNotificationChannels();
  } catch (err) {
    console.error('Failed to load notification channels:', err.message);
  }
}

function renderNotificationChannels() {
  const el = document.getElementById('notificationChannelList');
  el.innerHTML = notificationChannels.map(channel => `
    <div class="cat-row" style="display:block; padding:0.9rem;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">${channel.member_avatar} ${esc(channel.member_name)}</div>
          <div style="color:var(--text-muted); font-size:0.8rem;">${esc(channel.member_role)}${channel.has_secret ? ` • saved ${esc(channel.secret_mask)}` : ' • no brrr secret saved'}</div>
        </div>
        <label style="font-size:0.85rem; display:flex; align-items:center; gap:0.4rem;">
          <input type="checkbox" id="notifyEnabled-${channel.member_id}" ${channel.enabled ? 'checked' : ''}>
          Enabled
        </label>
      </div>
      <div style="margin-top:0.8rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
        <input type="text" id="notifyLabel-${channel.member_id}" placeholder="Label (optional)" value="${escAttr(channel.label || '')}" style="flex:1; min-width:180px;">
        <input type="password" id="notifySecret-${channel.member_id}" placeholder="${channel.has_secret ? 'Leave blank to keep saved secret/webhook' : 'Paste brrr secret or webhook URL'}" autocomplete="off" style="flex:2; min-width:220px;">
        <button class="btn btn-primary btn-small" onclick="saveNotificationChannel(${channel.member_id})">Save</button>
        ${channel.has_secret ? `<button class="btn btn-small" onclick="checkNotificationChannel(${channel.member_id})">Verify saved secret (no push)</button>` : ''}
        ${channel.has_secret ? `<button class="btn btn-danger btn-small" onclick="clearNotificationChannel(${channel.member_id})">Clear</button>` : ''}
      </div>
      <div id="notify-status-${channel.member_id}" role="status" aria-live="polite"></div>
    </div>
  `).join('');
}

async function saveNotificationChannel(memberId) {
  const verificationRequest = Symbol();
  pushRegistrationRequests.set(memberId, verificationRequest);
  const enabled = document.getElementById(`notifyEnabled-${memberId}`).checked;
  const label = document.getElementById(`notifyLabel-${memberId}`).value.trim();
  const secret = document.getElementById(`notifySecret-${memberId}`).value.trim();
  try {
    const saved = await api(`api/notification-channels/${memberId}/brrr`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        label,
        ...(secret ? { secret } : {})
      })
    });
    if (pushRegistrationRequests.get(memberId) !== verificationRequest) return;
    document.getElementById(`notifySecret-${memberId}`).value = '';
    await loadNotificationChannels();
    if (pushRegistrationRequests.get(memberId) !== verificationRequest) return;
    document.getElementById(`notify-status-${memberId}`).textContent = `Saved. ${saved.verification.message}`;
  } catch (err) {
    if (pushRegistrationRequests.get(memberId) !== verificationRequest) return; alert(err.message); }
}

async function clearNotificationChannel(memberId) {
  if (!confirm('Clear the saved brrr secret for this member?')) return;
  const verificationRequest = Symbol();
  pushRegistrationRequests.set(memberId, verificationRequest);
  try {
    await api(`api/notification-channels/${memberId}/brrr`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    if (pushRegistrationRequests.get(memberId) !== verificationRequest) return;
    await loadNotificationChannels();
  } catch (err) {
    if (pushRegistrationRequests.get(memberId) !== verificationRequest) return; alert(err.message); }
}

async function loadMagicHelpSettings() {
  try {
    const config = await api('api/config');
    document.getElementById('magicHelpEnabled').checked = config.magic_help_enabled === 'true';
    document.getElementById('magicHelpPrompt').value = config.magic_help_prompt || '';
  } catch (err) {
    console.error('Failed to load AI settings:', err.message);
  }
}

async function saveMagicHelpSettings() {
  const statusEl = document.getElementById('aiSaveStatus');
  statusEl.textContent = 'Saving...';
  try {
    const enabled = document.getElementById('magicHelpEnabled').checked;
    const prompt = document.getElementById('magicHelpPrompt').value.trim();
    await Promise.all([
      api('api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'magic_help_enabled', value: enabled ? 'true' : 'false' })
      }),
      api('api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'magic_help_prompt', value: prompt })
      })
    ]);
    statusEl.textContent = 'Saved';
    setTimeout(() => statusEl.textContent = '', 2000);
  } catch (err) {
    statusEl.textContent = '';
    alert(err.message);
  }
}

// Tailnet mode: the household account (api/me) is who this is, so there is no picker to switch, and a kid has no
// Settings. Local mode keeps the picker's choice, as before.
async function loadSuiteMe() {
  const me = await api('api/me');
  if (me.mode !== 'tailnet' || !me.member) return false;
  currentMember = me.member;
  if (me.member.role !== 'parent') document.querySelector('nav a[href$="settings"]')?.remove();
  return true;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;');
}

init();

async function checkNotificationChannel(memberId) {
  const verificationRequest = Symbol();
  pushRegistrationRequests.set(memberId, verificationRequest);
  const el = document.getElementById(`notify-status-${memberId}`);
  el.classList.remove('hidden');
  el.textContent = 'Checking saved secret (no notification)…';
  try {
    const data = await api(`api/notification-channels/${memberId}/brrr/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (pushRegistrationRequests.get(memberId) === verificationRequest) el.textContent = data.message;
  } catch (err) { if (pushRegistrationRequests.get(memberId) === verificationRequest) el.textContent = err.message; }
}
