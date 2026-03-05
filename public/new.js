/* familyHelp — New Ticket */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');
let categories = [];

async function init() {
  if (!currentMember) { window.location.href = './'; return; }
  document.getElementById('memberBadge').textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;

  categories = await api('api/categories');
  const sel = document.getElementById('category');
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', updateGuidance);
  updateGuidance();

  document.getElementById('title').addEventListener('input', updateTitleCount);
  document.getElementById('description').addEventListener('input', updateDescCount);
}

function updateGuidance() {
  const sel = document.getElementById('category');
  const cat = categories.find(c => String(c.id) === sel.value);
  document.getElementById('categoryGuidance').textContent = cat?.guidance || '';
}

function updateTitleCount() {
  const len = document.getElementById('title').value.length;
  const el = document.getElementById('titleCount');
  el.textContent = len < 10 ? `${len} / 10 min` : `${len}`;
  el.className = len < 10 ? 'char-count short' : 'char-count';
}

function updateDescCount() {
  const len = document.getElementById('description').value.length;
  const el = document.getElementById('descCount');
  el.textContent = len < 30 ? `${len} / 30 min` : `${len}`;
  el.className = len < 30 ? 'char-count short' : 'char-count';
}

async function submitTicket(e) {
  e.preventDefault();
  const errEl = document.getElementById('formError');
  errEl.textContent = '';

  const title = document.getElementById('title').value.trim();
  const description = document.getElementById('description').value.trim();
  const category_id = document.getElementById('category').value;
  const priority = document.querySelector('input[name="priority"]:checked').value;
  const link_url = document.getElementById('linkUrl').value.trim() || null;

  if (title.length < 10) { errEl.textContent = 'Title needs at least 10 characters.'; return; }
  if (description.length < 30) { errEl.textContent = 'Description needs at least 30 characters. Help us help you!'; return; }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const ticket = await api('api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, category_id: Number(category_id), priority, created_by: currentMember.id, link_url })
    });
    window.location.href = `ticket/${ticket.id}`;
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Submit Request';
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

init();
