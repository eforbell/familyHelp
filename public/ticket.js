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

  renderMagicHelp();
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

// ── MagicHelp ─────────────────────────────────────────────────────────────

function renderMagicHelp() {
  const el = document.getElementById('magicHelp');
  if (!el) return;

  if (ticket.ai_suggestion) {
    const canFollowUp = ticket.status === 'open' || ticket.status === 'in-progress' || ticket.status === 'waiting';

    const feedbackHtml = ticket.ai_helped === null && (ticket.status === 'open') ? `
      <div class="magic-help-feedback">
        <span>Did this help?</span>
        <button class="btn btn-primary btn-small" onclick="magicHelpFeedback(true)">Yes, resolved!</button>
        <button class="btn btn-secondary btn-small" onclick="magicHelpFeedback(false)">I still need help</button>
      </div>
    ` : ticket.ai_helped === true ? `
      <div class="magic-help-feedback"><span style="color:var(--accent);">Marked as helpful</span></div>
    ` : ticket.ai_helped === false ? `
      <div class="magic-help-feedback"><span style="color:var(--text-muted);">Human help requested</span></div>
    ` : '';

    const followUpHtml = canFollowUp ? `
      <div class="magic-help-followup">
        <div class="magic-help-followup-toggle">
          <button class="btn btn-secondary btn-small" onclick="toggleFollowUp()">Ask a follow-up</button>
        </div>
        <div class="magic-help-followup-form" id="followUpForm" style="display:none;">
          <input type="text" id="followUpInput" placeholder="I get that, but how do I..." minlength="5">
          <button class="btn btn-primary btn-small" id="followUpBtn" onclick="submitFollowUp()">Send</button>
        </div>
      </div>
    ` : '';

    el.innerHTML = `
      <div class="magic-help-box">
        <div class="magic-help-header">MagicHelp AI</div>
        <div class="magic-help-body">${formatMagicHelp(ticket.ai_suggestion)}</div>
        ${feedbackHtml}
        ${followUpHtml}
      </div>
    `;
  } else if (ticket.status === 'open') {
    el.innerHTML = `
      <button class="btn btn-secondary btn-small" id="askMagicBtn" onclick="askMagicHelp()">Ask MagicHelp AI</button>
    `;
  } else {
    el.innerHTML = '';
  }
}

function formatMagicHelp(text) {
  // Convert markdown-ish numbered lists and line breaks to HTML
  return esc(text).replace(/\n/g, '<br>');
}

async function askMagicHelp() {
  const btn = document.getElementById('askMagicBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Thinking...'; }
  try {
    const result = await api(`../api/tickets/${ticket.id}/magic-help`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    // Refresh ticket to get updated ai_suggestion
    ticket = await api(`../api/tickets/${ticket.id}`);
    renderMagicHelp();
    loadComments();
  } catch (err) {
    alert(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Ask MagicHelp AI'; }
  }
}

function toggleFollowUp() {
  const form = document.getElementById('followUpForm');
  if (!form) return;
  const visible = form.style.display !== 'none';
  form.style.display = visible ? 'none' : 'flex';
  if (!visible) document.getElementById('followUpInput').focus();
}

async function submitFollowUp() {
  const input = document.getElementById('followUpInput');
  const btn = document.getElementById('followUpBtn');
  const question = input.value.trim();
  if (question.length < 5) return;

  btn.disabled = true;
  btn.textContent = 'Thinking...';
  try {
    await api(`../api/tickets/${ticket.id}/magic-help-followup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    ticket = await api(`../api/tickets/${ticket.id}`);
    renderMagicHelp();
    loadComments();
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

async function magicHelpFeedback(helped) {
  try {
    await api(`../api/tickets/${ticket.id}/magic-help-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helped })
    });
    ticket = await api(`../api/tickets/${ticket.id}`);
    renderTicket();
    loadComments();
  } catch (err) {
    alert(err.message);
  }
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
