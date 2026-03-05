/* familyHelp — Settings */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');

async function init() {
  if (currentMember) {
    document.getElementById('memberBadge').textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;
  }
  await checkAuth();
}

async function checkAuth() {
  const status = await api('api/settings/status');
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
  await api('api/settings/lock', { method: 'POST' });
  document.getElementById('settingsContent').style.display = 'none';
  document.getElementById('pinScreen').style.display = 'flex';
  document.getElementById('pinInput').value = '';
  document.getElementById('pinInput').focus();
}

async function showSettings() {
  document.getElementById('settingsContent').style.display = 'block';
  loadCategories();
  loadMembers();
  loadMagicHelpSettings();
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
    await api(`api/categories/${id}`, { method: 'DELETE' });
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

init();
