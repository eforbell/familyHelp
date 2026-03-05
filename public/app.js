/* familyHelp — Dashboard */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');
let members = [];

async function init() {
  members = await api('api/members');
  if (!currentMember) {
    openMemberPicker();
    return;
  }
  updateMemberBadge();
  loadDashboard();
}

function updateMemberBadge() {
  const badge = document.getElementById('memberBadge');
  if (currentMember) {
    badge.textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;
  }
}

function openMemberPicker() {
  const grid = document.getElementById('memberGrid');
  grid.innerHTML = '';
  for (const m of members) {
    const div = document.createElement('div');
    div.className = 'member-option';
    div.innerHTML = `<span class="emoji">${m.avatar_emoji}</span><span class="name">${m.name}</span>`;
    div.onclick = () => selectMember(m);
    grid.appendChild(div);
  }
  document.getElementById('memberPicker').style.display = 'flex';
}

function selectMember(m) {
  currentMember = m;
  localStorage.setItem('fh_member', JSON.stringify(m));
  document.getElementById('memberPicker').style.display = 'none';
  updateMemberBadge();
  loadDashboard();
}

async function loadDashboard() {
  const [assigned, created] = await Promise.all([
    api(`api/tickets?assigned_to=${currentMember.id}&member_id=${currentMember.id}`),
    api(`api/tickets?created_by=${currentMember.id}&member_id=${currentMember.id}`)
  ]);

  const activeAssigned = assigned.filter(t => !['resolved', 'closed'].includes(t.status));
  const activeCreated = created.filter(t => !['resolved', 'closed'].includes(t.status));

  document.getElementById('assignedCount').textContent = activeAssigned.length;
  document.getElementById('myCount').textContent = activeCreated.length;

  renderTicketList('assignedList', activeAssigned, 'No tickets assigned to you');
  renderTicketList('myList', activeCreated, 'You haven\'t filed any requests');
}

function renderTicketList(containerId, tickets, emptyMsg) {
  const el = document.getElementById(containerId);
  if (!tickets.length) {
    el.innerHTML = `<div class="empty">${emptyMsg}</div>`;
    return;
  }
  el.innerHTML = tickets.map(t => `
    <a href="ticket/${t.id}" class="card" style="display:block; text-decoration:none; color:inherit;">
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-meta">
        <span class="badge badge-${t.priority}">${t.priority}</span>
        <span class="badge badge-${t.status}">${t.status}</span>
        <span>${t.category_name || 'Uncategorized'}</span>
        <span>${timeAgo(t.created_at)}</span>
        ${t.comment_count > 0 ? `<span>${t.comment_count} comment${t.comment_count > 1 ? 's' : ''}</span>` : ''}
      </div>
    </a>
  `).join('');
}

// ── Utilities ─────────────────────────────────────────────────────────────

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
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

init();
