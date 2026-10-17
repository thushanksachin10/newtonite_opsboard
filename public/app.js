'use strict';
// State lives in one object; server is the source of truth. Optimistic UI is limited to "claim"
// (the contended action) and is always reconciled with the server response.
const S = { token: localStorage.token, me: null, teams: [], view: 'attention', items: [], cursor: null, sel: null, detail: null, members: [], loading: false };
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => crypto.randomUUID();

async function api(method, url, body, { idem } = {}) {
  const res = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }), ...(idem && { 'Idempotency-Key': idem }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { logout(); }
  if (!res.ok) throw Object.assign(new Error(data.message || res.statusText), { status: res.status, data });
  return data;
}
// A user action = one logical operation => one idempotency key, reused across automatic retries.
async function mutate(method, url, body) {
  const idem = uid();
  for (let attempt = 0; ; attempt++) {
    try { return await api(method, url, body, { idem }); }
    catch (e) { if (e.status || attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); } // network error only
  }
}
function toast(msg, bad) { const d = document.createElement('div'); d.className = 'toast' + (bad ? ' bad' : ''); d.textContent = msg; $('#toasts').append(d); setTimeout(() => d.remove(), 4000); }

// ---------- auth ----------
async function boot() {
  if (!S.token) return showLogin();
  try { const m = await api('GET', '/me'); S.me = m.user; S.teams = m.teams; } catch { return showLogin(); }
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#who').textContent = `${S.me.name} · ` + S.teams.map((t) => `${t.name} (${t.role})`).join(', ');
  const opt = (a, f) => a.map(f).join('');
  $('#fTeam').innerHTML = '<option value="">All teams</option>' + opt(S.teams, (t) => `<option value="${t.id}">${esc(t.name)}</option>`);
  $('#fStatus').innerHTML = '<option value="">Any status</option>' + opt(['open', 'in_progress', 'blocked', 'resolved', 'closed'], (s) => `<option>${s}</option>`);
  $('#fPrio').innerHTML = '<option value="">Any priority</option>' + opt(['critical', 'high', 'medium', 'low'], (s) => `<option>${s}</option>`);
  const writable = S.teams.filter((t) => t.role !== 'viewer');
  $('#nTeam').innerHTML = opt(writable, (t) => `<option value="${t.id}">${esc(t.name)}</option>`); $('#newBtn').disabled = !writable.length;
  connectStream(); reload(); refreshSummary(); refreshNotifs();
}
async function showLogin() {
  S.token = null; delete localStorage.token; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
  const d = await fetch('/api/demo-users').then((r) => r.json()).catch(() => []);
  $('#demo').innerHTML = d.map((u) => `<button type="button" data-e="${u.email}">${esc(u.name)}</button>`).join('');
}
$('#demo').onclick = (e) => { if (e.target.dataset.e) { $('#loginForm').email.value = e.target.dataset.e; $('#loginForm').password.value = 'password'; } };
$('#loginForm').onsubmit = async (e) => { e.preventDefault(); const f = e.target;
  try { const r = await api('POST', '/auth/login', { email: f.email.value, password: f.password.value }); S.token = localStorage.token = r.token; boot(); }
  catch (err) { $('#loginErr').textContent = err.message; } };
function logout() { if (S.es) S.es.close(); showLogin(); }
$('#logout').onclick = logout;

// ---------- list ----------
const VIEWS = [['attention', 'Needs attention'], ['mine', 'My work'], ['unassigned', 'Unassigned'], ['all', 'All items']];
async function refreshSummary() {
  const s = await api('GET', '/summary').catch(() => null); if (!s) return;
  const cnt = { mine: s.mine, unassigned: s.unassigned, all: Object.values(s.by_status).reduce((a, b) => a + b, 0) };
  $('#views').innerHTML = VIEWS.map(([k, l]) => `<button data-v="${k}" class="${S.view === k ? 'on' : ''}">${l}<span class="n ${k === 'attention' && s.overdue ? 'hot' : ''}">${k === 'attention' ? (s.overdue ? s.overdue + ' overdue' : '') : cnt[k]}</span></button>`).join('');
}
$('#views').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.view = b.dataset.v; refreshSummary(); reload(); } };
function params() {
  const p = new URLSearchParams({ view: S.view, limit: 25 });
  for (const [k, el] of [['team_id', '#fTeam'], ['status', '#fStatus'], ['priority', '#fPrio'], ['q', '#q']]) if ($(el).value) p.set(k, $(el).value);
  if (S.cursor) p.set('cursor', S.cursor); return p;
}
let reqSeq = 0;
async function reload() { S.cursor = null; S.items = []; await loadPage(); }
async function loadPage() {
  const seq = ++reqSeq; // ignore out-of-order responses when the user types/filters quickly
  try { const r = await api('GET', '/items?' + params()); if (seq !== reqSeq) return;
    S.items = S.items.concat(r.items); S.cursor = r.next_cursor; renderList(); }
  catch (e) { toast(e.message, true); }
}
function renderList(flashId) {
  $('#list').innerHTML = S.items.map((i) => `<li data-id="${i.id}" class="${S.sel === i.id ? 'sel' : ''} ${flashId === i.id ? 'flash' : ''}">
    <div><span class="t">${esc(i.title)}</span></div>
    <div><span class="tag p-${i.priority}">${i.priority}</span><span class="tag s-${i.status}">${i.status.replace('_', ' ')}</span></div>
    <div class="meta">#${i.id} · ${esc(i.team_name)} · ${i.assignee_name ? esc(i.assignee_name) : '<b>unassigned</b>'}${i.due_at ? ` · <span class="${i.overdue ? 'overdue' : ''}">due ${new Date(i.due_at).toLocaleDateString()}</span>` : ''}${i.approval_status === 'pending' ? ' · ⏳ approval pending' : ''}</div>
    <div class="meta">${i.can?.claim ? `<button data-claim="${i.id}" class="primary">Take it</button>` : ''}</div></li>`).join('');
  $('#more').classList.toggle('hidden', !S.cursor); $('#empty').classList.toggle('hidden', S.items.length > 0);
}
$('#more').onclick = loadPage;
let qt; $('#q').oninput = () => { clearTimeout(qt); qt = setTimeout(reload, 250); };
['#fTeam', '#fStatus', '#fPrio'].forEach((s) => ($(s).onchange = reload));
$('#list').onclick = (e) => { const c = e.target.closest('[data-claim]'); if (c) { e.stopPropagation(); return claim(c.dataset.claim); }
  const li = e.target.closest('li'); if (li) openDetail(li.dataset.id); };

// ---------- optimistic claim with reconciliation ----------
async function claim(id) {
  const idx = S.items.findIndex((i) => i.id === id), before = S.items[idx];
  if (idx >= 0) { S.items[idx] = { ...before, assignee_name: S.me.name + ' …', assignee_id: S.me.id, status: before.status === 'open' ? 'in_progress' : before.status, can: { ...before.can, claim: false } }; renderList(); }
  try { const fresh = await mutate('POST', `/items/${id}/claim`); replaceItem(fresh); toast('You own this now'); }
  catch (e) { if (idx >= 0) { S.items[idx] = e.data?.current ? { ...before, ...e.data.current, can: { ...before.can, claim: false } } : before; renderList(); }
    toast(e.status === 409 ? 'Too late — someone else just took it.' : e.message, true); }
  refreshSummary(); if (S.sel === id) openDetail(id);
}
function replaceItem(fresh) { const i = S.items.findIndex((x) => x.id === fresh.id); if (i >= 0) S.items[i] = { ...S.items[i], ...fresh }; renderList(fresh.id); }

// ---------- detail ----------
async function openDetail(id) {
  S.sel = id;
  try { S.detail = await api('GET', `/items/${id}`); S.members = await api('GET', `/teams/${S.detail.item.team_id}/members`).catch(() => []); renderDetail(); renderList(); }
  catch (e) { toast(e.message, true); closeDetail(); }
}
function closeDetail() { S.sel = null; S.detail = null; $('#detail').classList.add('hidden'); renderList(); }
function evText(e) { const d = e.data;
  switch (e.type) {
    case 'created': return 'created this item';
    case 'comment': return `commented: “${esc(d.body)}”`;
    case 'status_changed': return `moved ${d.status.from} → <b>${d.status.to}</b>${d.reason ? ' (' + esc(d.reason) + ')' : ''}`;
    case 'assigned': { const n = (id) => S.members.find((m) => m.id === id)?.name || '#' + id;
      return d.assignee_id && typeof d.assignee_id === 'object' ? `reassigned ${d.assignee_id.from ? n(d.assignee_id.from) : 'nobody'} → <b>${d.assignee_id.to ? n(d.assignee_id.to) : 'nobody'}</b>` : `took the item (${d.via})`; }
    case 'updated': return 'edited ' + Object.entries(d).map(([k, v]) => `${k}${k === 'priority' || k === 'due_at' ? ` ${esc(v.from)} → ${esc(v.to)}` : ''}${v.reason ? ' (' + v.reason + ')' : ''}`).join(', ');
    default: return e.type.replace('_', ' ');
  } }
function renderDetail() {
  const { item: i, events } = S.detail, c = i.can, el = $('#detail'); el.classList.remove('hidden');
  el.innerHTML = `<div class="row"><span class="muted">#${i.id} · ${esc(i.team_name)} · you are <b>${i.role}</b> · v${i.version}</span><button class="link" id="x">✕</button></div>
  <h3>${esc(i.title)}</h3><p>${esc(i.description) || '<i class="muted">No description</i>'}</p>
  <div><span class="tag p-${i.priority}">${i.priority}</span><span class="tag s-${i.status}">${i.status.replace('_', ' ')}</span>
  ${i.approval_required ? `<span class="tag">approval: ${i.approval_status}</span>` : ''} <span class="meta">Owner: <b>${esc(i.assignee_name || 'unassigned')}</b> · reported by ${esc(i.reporter_name)}${i.due_at ? ` · <span class="${i.overdue ? 'overdue' : ''}">due ${new Date(i.due_at).toLocaleString()}</span>` : ''}</span></div>
  <div class="actions">
    ${c.claim ? '<button class="primary" data-a="claim">Take it</button>' : ''}
    ${c.transitions.map((t) => `<button data-a="to" data-to="${t}">→ ${t.replace('_', ' ')}</button>`).join('')}
    ${c.requestApproval ? '<button data-a="appr" data-act="request">Request approval</button>' : ''}
    ${c.decideApproval ? '<button class="primary" data-a="appr" data-act="approve">Approve</button><button class="danger" data-a="appr" data-act="reject">Reject</button>' : ''}
    ${c.edit ? `<select id="prio">${['critical', 'high', 'medium', 'low'].map((p) => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>` : ''}
    ${c.assign ? `<select id="asg"><option value="">Assign to…</option><option value="none">(unassign)</option>${S.members.filter((m) => m.role !== 'viewer').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
  </div>
  ${c.comment ? '<textarea id="cm" placeholder="Add a comment…"></textarea><div class="row"><button id="cmBtn">Comment</button></div>' : ''}
  <h4>History</h4><ul class="tl">${events.map((e) => `<li><b>${esc(e.actor_name || 'system')}</b> ${evText(e)}<div class="meta">${new Date(e.created_at).toLocaleString()}</div></li>`).join('')}</ul>
  ${S.detail.has_more_events ? '<button class="link" id="olderEv">Load older history</button>' : ''}`;
  $('#x').onclick = closeDetail;
  el.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => act(b.dataset)));
  if ($('#prio')) $('#prio').onchange = (e) => act({ a: 'prio', v: e.target.value });
  if ($('#asg')) $('#asg').onchange = (e) => e.target.value && act({ a: 'asg', v: e.target.value });
  if ($('#cmBtn')) $('#cmBtn').onclick = () => act({ a: 'cm' });
  if ($('#olderEv')) $('#olderEv').onclick = async () => { const last = events[events.length - 1].id; const r = await api('GET', `/items/${i.id}?before=${last}`); S.detail.events.push(...r.events); S.detail.has_more_events = r.has_more_events; renderDetail(); };
}
// Every write carries the version the user last saw; a 409 refreshes the view and tells the user why.
async function act(d) {
  const i = S.detail.item, v = i.version, base = `/items/${i.id}`;
  try {
    let fresh;
    if (d.a === 'claim') return claim(i.id);
    if (d.a === 'to') fresh = await mutate('POST', base + '/transition', { to: d.to, version: v });
    else if (d.a === 'appr') fresh = await mutate('POST', base + '/approval', { action: d.act, version: v });
    else if (d.a === 'prio') fresh = await mutate('PATCH', base, { priority: d.v, version: v });
    else if (d.a === 'asg') fresh = await mutate('POST', base + '/assign', { assignee_id: d.v === 'none' ? null : d.v, version: v });
    else if (d.a === 'cm') { const b = $('#cm').value.trim(); if (!b) return; await mutate('POST', base + '/comments', { body: b }); }
    if (fresh) replaceItem(fresh); await openDetail(i.id); refreshSummary();
  } catch (e) {
    if (e.status === 409) { toast('Someone changed this item first — showing the latest. Please retry.', true); await openDetail(i.id); reload(); }
    else toast(e.message, true);
  }
}

// ---------- create ----------
$('#newBtn').onclick = () => $('#newDlg').showModal();
$('#newForm').onsubmit = async (e) => { if (e.submitter?.value !== 'ok') return; const f = e.target;
  const body = { team_id: f.team_id.value, title: f.title.value, description: f.description.value, priority: f.priority.value, approval_required: f.approval_required.checked, due_at: f.due_at.value ? new Date(f.due_at.value).toISOString() : null };
  try { const it = await mutate('POST', '/items', body); f.reset(); toast('Created #' + it.id); await reload(); refreshSummary(); openDetail(it.id); } catch (err) { toast(err.message, true); } };

// ---------- live updates + notifications ----------
function connectStream() {
  if (S.es) S.es.close();
  const es = S.es = new EventSource('/api/stream?token=' + encodeURIComponent(S.token));
  let t; es.addEventListener('item', (m) => { const e = JSON.parse(m.data);
    if (e.actor_id === S.me.id && S.sel !== e.item_id) { /* own change: UI already reconciled */ }
    clearTimeout(t); t = setTimeout(async () => { refreshSummary();
      const inList = S.items.find((i) => i.id === e.item_id);
      if (inList) { try { const f = await api('GET', `/items/${e.item_id}`); replaceItem(f.item); } catch { /* lost access */ } }
      else if (S.view !== 'all' || !S.cursor) { $('#banner').innerHTML = 'New activity. <button class="link" id="rf">Refresh list</button>'; $('#banner').classList.remove('hidden'); $('#rf').onclick = () => { $('#banner').classList.add('hidden'); reload(); }; }
      if (S.sel === e.item_id && e.actor_id !== S.me.id) { toast('This item was just updated by someone else'); openDetail(e.item_id); } }, 150); });
  es.addEventListener('notify', refreshNotifs);
}
async function refreshNotifs() { const n = await api('GET', '/notifications').catch(() => null); if (!n) return; S.notifs = n.items; $('#unread').textContent = n.unread || ''; }
$('#bell').onclick = async () => { const box = $('#notifs'); if (!box.classList.contains('hidden')) return box.classList.add('hidden');
  await refreshNotifs(); box.innerHTML = (S.notifs.map((n) => `<div class="${n.read ? '' : 'un'}" data-i="${n.item_id}">${esc(n.message)}<div class="meta">${n.created_at}</div></div>`).join('')) || '<div class="muted">No notifications</div>';
  box.classList.remove('hidden'); await api('POST', '/notifications/read', {}); $('#unread').textContent = ''; };
$('#notifs').onclick = (e) => { const d = e.target.closest('[data-i]'); if (d) { openDetail(d.dataset.i); $('#notifs').classList.add('hidden'); } };
boot();
