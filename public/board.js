/* familyHelp — Board View */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');
let allTickets = [];
let members = [];
let categories = [];

async function init() {
  if (!currentMember) { window.location.href = './'; return; }
  document.getElementById('memberBadge').textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;

  [members, categories] = await Promise.all([
    api('api/members'),
    api('api/categories')
  ]);

  // Populate filter dropdowns
  const assignSel = document.getElementById('filterAssignee');
  for (const m of members) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.avatar_emoji} ${m.name}`;
    assignSel.appendChild(opt);
  }

  const catSel = document.getElementById('filterCategory');
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    catSel.appendChild(opt);
  }

  document.getElementById('filterAssignee').addEventListener('change', renderBoard);
  document.getElementById('filterCategory').addEventListener('change', renderBoard);
  document.getElementById('filterPriority').addEventListener('change', renderBoard);

  await loadTickets();
}

async function loadTickets() {
  allTickets = await api(`api/tickets?member_id=${currentMember.id}`);
  renderBoard();
}

function renderBoard() {
  const assignee = document.getElementById('filterAssignee').value;
  const category = document.getElementById('filterCategory').value;
  const priority = document.getElementById('filterPriority').value;

  let filtered = allTickets;
  if (assignee) filtered = filtered.filter(t => String(t.assigned_to) === assignee);
  if (category) filtered = filtered.filter(t => String(t.category_id) === category);
  if (priority) filtered = filtered.filter(t => t.priority === priority);

  const columns = [
    { status: 'open', label: 'Open', color: 'var(--open)' },
    { status: 'in-progress', label: 'In Progress', color: 'var(--inprogress)' },
    { status: 'waiting', label: 'Waiting', color: 'var(--waiting)' },
    { status: 'resolved', label: 'Resolved', color: 'var(--resolved)' }
  ];

  const board = document.getElementById('board');
  board.innerHTML = columns.map(col => {
    const tickets = filtered.filter(t => t.status === col.status);
    return `
      <div class="board-column">
        <div class="board-column-title">
          <span style="color:${col.color};">${col.label}</span>
          <span class="count" style="background:${col.color};">${tickets.length}</span>
        </div>
        ${tickets.length ? tickets.map(t => `
          <div class="board-ticket" onclick="window.location.href='ticket/${t.id}'">
            <div class="board-ticket-title">${esc(t.title)}</div>
            <div class="board-ticket-meta">
              <span class="badge badge-${t.priority}">${t.priority}</span>
              <span>${t.category_name || ''}</span>
              <span>${t.assignee_name ? t.assignee_avatar + ' ' + t.assignee_name : 'unassigned'}</span>
            </div>
          </div>
        `).join('') : '<div class="empty" style="padding:1rem;">None</div>'}
      </div>
    `;
  }).join('');
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
