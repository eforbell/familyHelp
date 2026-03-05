/* familyHelp — Ticket Detail */

let currentMember = JSON.parse(localStorage.getItem('fh_member') || 'null');
let ticket = null;
let members = [];

function getTicketId() {
  const parts = window.location.pathname.split('/');
  return parts[parts.length - 1];
}

async function init() {
  if (!currentMember) { window.location.href = '../'; return; }
  document.getElementById('memberBadge').textContent = `${currentMember.avatar_emoji} ${currentMember.name}`;

  document.getElementById('commentText').addEventListener('input', updateCommentCount);

  const ticketId = getTicketId();
  const [t, m] = await Promise.all([
    api(`../api/tickets/${ticketId}`),
    api('../api/members')
  ]);
  ticket = t;
  members = m;

  renderTicket();
  loadComments();
}

function renderTicket() {
  const hdr = document.getElementById('ticketHeader');
  hdr.innerHTML = `
    <h2>${esc(ticket.title)}</h2>
    <div class="card-meta">
      <span class="badge badge-${ticket.priority}">${ticket.priority}</span>
      <span class="badge badge-${ticket.status}">${ticket.status}</span>
      <span>${ticket.category_name || 'Uncategorized'}</span>
      <span>Filed by ${esc(ticket.creator_name)} ${timeAgo(ticket.created_at)}</span>
      ${ticket.assignee_name ? `<span>Assigned to ${esc(ticket.assignee_name)}</span>` : '<span>Unassigned</span>'}
    </div>
  `;

  document.getElementById('ticketBody').textContent = ticket.description;

  const linkEl = document.getElementById('ticketLink');
  if (ticket.link_url) {
    linkEl.innerHTML = `<a href="${esc(ticket.link_url)}" target="_blank" rel="noopener">Reference link</a>`;
  } else {
    linkEl.innerHTML = '';
  }

  renderActions();
}

function renderActions() {
  const el = document.getElementById('ticketActions');
  const isParent = currentMember.role === 'parent';
  const isAssignedToMe = ticket.assigned_to === currentMember.id;
  const btns = [];

  // Assignment
  if (isParent) {
    let assignHtml = '<select id="assignSelect" class="btn btn-secondary btn-small" style="padding:0.3rem 0.5rem;">';
    assignHtml += '<option value="">Unassigned</option>';
    for (const m of members) {
      const sel = ticket.assigned_to === m.id ? 'selected' : '';
      assignHtml += `<option value="${m.id}" ${sel}>${m.avatar_emoji} ${m.name}</option>`;
    }
    assignHtml += '</select>';
    btns.push(assignHtml);
  } else if (!ticket.assigned_to) {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="assignToMe()">I'll take this</button>`);
  }

  // Status transitions
  if (ticket.status === 'open') {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('in-progress')">Start Working</button>`);
  }
  if (ticket.status === 'in-progress') {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('waiting')">Waiting on Info</button>`);
    btns.push(`<button class="btn btn-primary btn-small" onclick="setStatus('resolved')">Mark Resolved</button>`);
  }
  if (ticket.status === 'waiting') {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('in-progress')">Resume</button>`);
    btns.push(`<button class="btn btn-primary btn-small" onclick="setStatus('resolved')">Mark Resolved</button>`);
  }
  if (ticket.status === 'resolved') {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('open')">Reopen</button>`);
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('closed')">Close</button>`);
  }
  if (ticket.status === 'closed') {
    btns.push(`<button class="btn btn-secondary btn-small" onclick="setStatus('open')">Reopen</button>`);
  }

  // Priority (parents only)
  if (isParent) {
    let prioHtml = '<select id="prioSelect" class="btn btn-secondary btn-small" style="padding:0.3rem 0.5rem;">';
    for (const p of ['urgent', 'normal', 'long-term']) {
      const sel = ticket.priority === p ? 'selected' : '';
      prioHtml += `<option value="${p}" ${sel}>${p}</option>`;
    }
    prioHtml += '</select>';
    btns.push(prioHtml);
  }

  el.innerHTML = btns.join('');

  // Bind assignment dropdown
  const assignSel = document.getElementById('assignSelect');
  if (assignSel) {
    assignSel.addEventListener('change', () => assignTo(assignSel.value || null));
  }

  const prioSel = document.getElementById('prioSelect');
  if (prioSel) {
    prioSel.addEventListener('change', () => setPriority(prioSel.value));
  }
}

async function setStatus(status) {
  ticket = await api(`../api/tickets/${ticket.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, member_id: currentMember.id })
  });
  renderTicket();
  loadComments();
}

async function assignTo(memberId) {
  ticket = await api(`../api/tickets/${ticket.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigned_to: memberId, member_id: currentMember.id })
  });
  renderTicket();
  loadComments();
}

async function assignToMe() {
  await assignTo(currentMember.id);
}

async function setPriority(priority) {
  ticket = await api(`../api/tickets/${ticket.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority, member_id: currentMember.id })
  });
  renderTicket();
  loadComments();
}

// ── Comments ──────────────────────────────────────────────────────────────

async function loadComments() {
  const comments = await api(`../api/tickets/${ticket.id}/comments`);
  const el = document.getElementById('commentList');
  if (!comments.length) {
    el.innerHTML = '<div class="empty">No comments yet</div>';
    return;
  }
  el.innerHTML = comments.map(c => {
    if (c.is_system) {
      return `<div class="comment-system">${esc(c.body)} &middot; ${timeAgo(c.created_at)}</div>`;
    }
    return `
      <div class="comment">
        <div class="comment-header">
          <span>${c.author_avatar || ''}</span>
          <span class="comment-author">${esc(c.author_name || 'Unknown')}</span>
          <span class="comment-time">${timeAgo(c.created_at)}</span>
        </div>
        <div class="comment-body">${esc(c.body)}</div>
      </div>
    `;
  }).join('');
}

function updateCommentCount() {
  const len = document.getElementById('commentText').value.length;
  const el = document.getElementById('commentCount');
  el.textContent = len < 10 ? `${len} / 10 min` : `${len}`;
  el.className = len < 10 ? 'char-count short' : 'char-count';
}

async function addComment(e) {
  e.preventDefault();
  const text = document.getElementById('commentText').value.trim();
  if (text.length < 10) return;

  const btn = document.getElementById('commentBtn');
  btn.disabled = true;
  try {
    await api(`../api/tickets/${ticket.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, author_id: currentMember.id })
    });
    document.getElementById('commentText').value = '';
    updateCommentCount();
    loadComments();
  } catch (err) {
    alert(err.message);
  }
  btn.disabled = false;
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
  d.textContent = s || '';
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
