'use strict';

// The link page (tailnet mode): a parent matches each Family Help member to their household account in Home Base.
let linkState = null;

document.addEventListener('DOMContentLoaded', () => loadLinks());

function setLinkStatus(message, isError = false) {
  const el = document.getElementById('linkStatus');
  el.textContent = message;
  el.className = isError ? 'setup-status setup-error' : 'setup-status setup-info';
}

// Reloads the list from the server, which is what the pickers show; problem, if given, is shown after it.
async function loadLinks(problem) {
  try {
    const res = await fetch('api/suite/links', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load household members');
    linkState = data;
    renderLinks();
    if (problem) setLinkStatus(problem, true);
  } catch (err) {
    setLinkStatus(problem || err.message, true);
    // Leave the pickers usable, so the parent can try again.
    document.querySelectorAll('#linkRows select').forEach(select => { select.disabled = false; });
  }
}

function roleLabel(role) {
  return role === 'parent' ? 'parent' : 'kid';
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'link-note';
  p.textContent = text;
  return p;
}

function renderLinks() {
  const { you, directory, members } = linkState;
  const rows = document.getElementById('linkRows');
  rows.replaceChildren();
  const linked = new Map(members.filter(m => m.suite_member_id).map(m => [m.suite_member_id, m.id]));

  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'link-row';

    const who = document.createElement('span');
    who.className = 'link-who';
    const avatar = document.createElement('span');
    avatar.textContent = member.avatar_emoji || '👤';
    const name = document.createElement('span');
    name.className = 'link-name';
    name.textContent = member.name;
    const role = document.createElement('span');
    role.className = 'link-role';
    role.textContent = roleLabel(member.role);
    who.append(avatar, name, role);

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Household account for ${member.name}`);
    select.append(new Option('Not linked', ''));
    for (const person of directory) {
      const takenBy = linked.get(person.memberId);
      if (takenBy && takenBy !== member.id) continue;
      // A kid's account never takes a parent's row; the server refuses it too.
      if (person.role === 'kid' && member.role !== 'kid') continue;
      const label = `${person.name} (${person.role}${person.memberId === you ? ', you' : ''})`;
      select.append(new Option(label, person.memberId, false, person.memberId === member.suite_member_id));
    }
    select.addEventListener('change', () => saveLink(member, select));
    row.append(who, select);

    const account = directory.find(person => person.memberId === member.suite_member_id);
    if (member.suite_member_id && !account) {
      row.append(note('Linked to a household account that no longer has access to Family HelpDesk.'));
    } else if (account && roleLabel(member.role) !== account.role) {
      row.append(note(`Home Base lists ${account.name} as a ${account.role}, but here they are a ${roleLabel(member.role)}.`));
    }
    rows.append(row);
  }

  const youLinked = linked.has(you);
  const done = document.getElementById('linkDone');
  document.getElementById('linkDoneCard').style.display = youLinked || !members.length ? 'flex' : 'none';
  if (!members.length) {
    done.textContent = 'Set up the household';
    done.href = 'setup';
    setLinkStatus('Family HelpDesk has no members yet. Set up the household first.');
  } else if (!youLinked) {
    setLinkStatus('Start with yourself: pick which HelpDesk member you are.');
  } else {
    setLinkStatus('Changes save as you pick them.');
  }
}

async function saveLink(member, select) {
  select.disabled = true;
  try {
    const res = await fetch(`api/suite/links/${member.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suite_member_id: select.value || null }),
    });
    const data = await res.json();
    // Refused or not, the server's list is what the pickers show next, so a refused choice doesn't linger.
    await loadLinks(res.ok ? undefined : (data.error || 'Could not save'));
  } catch (err) {
    await loadLinks(err.message);
  }
}
