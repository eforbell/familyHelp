'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('setupSubmitBtn').addEventListener('click', submitSetup);
  document.getElementById('setupPinConfirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitSetup();
  });
  await loadBootstrapState();
});

async function loadBootstrapState() {
  const statusEl = document.getElementById('setupBootstrapStatus');
  try {
    const res = await fetch('api/bootstrap', { cache: 'no-store' });
    const data = await res.json();
    if (data?.bootstrap?.needs_household === false) {
      window.location.replace('./');
      return;
    }
    setStatus(statusEl, 'This install needs a household before the help desk can be used.', 'info', true);
  } catch {
    setStatus(statusEl, 'Could not check setup state.', 'error', true);
  }
}

function parseKids(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function submitSetup() {
  const parent1 = document.getElementById('setupParent1').value.trim();
  const parent2 = document.getElementById('setupParent2').value.trim();
  const kids = parseKids(document.getElementById('setupKids').value);
  const pin = document.getElementById('setupPin').value.trim();
  const confirm = document.getElementById('setupPinConfirm').value.trim();
  const installStarter = document.getElementById('setupStarterContent').checked;
  const btn = document.getElementById('setupSubmitBtn');
  const statusEl = document.getElementById('setupSubmitStatus');

  const members = [];
  if (parent1) members.push({ name: parent1, role: 'parent' });
  if (parent2) members.push({ name: parent2, role: 'parent' });
  for (const kid of kids) members.push({ name: kid, role: 'kid' });

  if (!parent1) {
    setStatus(statusEl, 'Enter at least one parent/admin name.', 'error');
    return;
  }
  if (pin || confirm) {
    if (pin.length < 4) {
      setStatus(statusEl, 'PIN must be at least 4 characters.', 'error');
      return;
    }
    if (pin !== confirm) {
      setStatus(statusEl, 'PIN confirmation does not match.', 'error');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  setStatus(statusEl, 'Creating household…', 'info');

  try {
    const res = await fetch('api/bootstrap/household', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        members,
        install_starter_content: installStarter,
        ...(pin ? { settings_pin: pin } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not initialize household');

    const firstParent = (data.created_members || []).find(member => member.role === 'parent') || data.created_members?.[0];
    if (firstParent) localStorage.setItem('fh_member', JSON.stringify(firstParent));

    setStatus(statusEl, 'Household created. Opening Family HelpDesk…', 'ok');
    window.setTimeout(() => window.location.replace('./'), 250);
  } catch (err) {
    setStatus(statusEl, err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Household';
  }
}

function setStatus(el, message, kind, keepVisible = false) {
  el.textContent = message;
  el.className = `setup-status setup-${kind || 'info'}`;
  if (!keepVisible) el.style.display = 'block';
}
