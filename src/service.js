'use strict';
const { atLeast, PRIORITIES, HttpError, permissionsFor, TRANSITIONS } = require('./policy');
const { toOid, ObjectId } = require('./db');
const now = () => new Date().toISOString();
const STALE_DAYS = 3;
const REF_FIELDS = ['team_id', 'reporter_id', 'assignee_id', 'approval_requested_by'];

// Every command receives x = { s: ClientSession, user, events: [] } and runs inside ONE multi-document transaction
// (started by the caller in app.js). `x.events` collects change signals to publish only after commit.
const oidOr404 = (v) => toOid(v) || (() => { throw new HttpError(404, 'not_found', 'Not found'); })();
const out = (d) => { if (!d) return d; const o = { ...d, id: String(d._id) }; delete o._id; for (const f of REF_FIELDS) if (o[f] != null) o[f] = String(o[f]); return o; };
const publicItem = (i) => ({ ...i, overdue: !!(i.due_at && i.due_at < now() && !['resolved', 'closed'].includes(i.status)) });

function createService(c) {
  const roleOf = async (userId, teamId, s) =>
    (await c.memberships.findOne({ user_id: toOid(userId), team_id: toOid(teamId) }, { session: s }))?.role ?? null;

  // 404 (not 403) for non-members: never leak existence across teams.
  async function load(x, itemId) {
    const raw = await c.items.findOne({ _id: oidOr404(itemId) }, { session: x.s });
    const role = raw && await roleOf(x.user._id, raw.team_id, x.s);
    if (!raw || !role) throw new HttpError(404, 'not_found', 'Work item not found');
    const item = out(raw);
    return { raw, item, role, perms: permissionsFor(role, item, x.user.id) };
  }
  const forbid = (msg = 'You are not allowed to do that') => { throw new HttpError(403, 'forbidden', msg); };
  const view = (item, role, userId) => ({ ...publicItem(item), role, can: permissionsFor(role, item, userId) });

  async function logEvent(x, rawItem, type, data) {
    const r = await c.events.insertOne({ item_id: rawItem._id, actor_id: x.user._id, type, data, item_version: rawItem.version, created_at: now() }, { session: x.s });
    await queueNotify(x, r.insertedId);
    x.events.push({ item_id: String(rawItem._id), team_id: String(rawItem.team_id), version: rawItem.version, actor_id: x.user.id, type });
    return r.insertedId;
  }
  // Outbox row is written in the SAME transaction as the state change: it exists iff the change committed.
  const queueNotify = (x, eventId) => c.outbox.updateOne({ dedupe_key: `notify:${eventId}` },
    { $setOnInsert: { kind: 'notify', payload: { event_id: eventId }, status: 'pending', attempts: 0, run_at: Date.now(), locked_until: null, last_error: null, created_at: new Date() } },
    { upsert: true, session: x.s });

  async function conflict(x, id) {
    const cur = await c.items.findOne({ _id: id }, { session: x.s });
    return new HttpError(409, 'version_conflict', 'This item was changed by someone else. Reload and retry.', { current: cur && publicItem(out(cur)) });
  }
  // Compare-and-swap: the filter on `version` is the real guard against lost updates.
  async function save(x, before, changes, type, data) {
    const after = await c.items.findOneAndUpdate({ _id: before._id, version: before.version },
      { $set: { ...changes, updated_at: now() }, $inc: { version: 1 } }, { returnDocument: 'after', session: x.s });
    if (!after) throw await conflict(x, before._id);
    await logEvent(x, after, type, data);
    return after;
  }
  async function checkVersion(x, raw, expected) {
    if (!Number.isInteger(expected)) throw new HttpError(400, 'version_required', 'Send the item version you last saw ("version")');
    if (raw.version !== expected) throw await conflict(x, raw._id);
  }

  // ---------------- commands ----------------
  async function createItem(x, b) {
    const title = String(b.title || '').trim();
    if (!title || title.length > 200) throw new HttpError(400, 'invalid', 'title is required (max 200 chars)');
    const priority = b.priority || 'medium';
    if (!(priority in PRIORITIES)) throw new HttpError(400, 'invalid', 'invalid priority');
    const teamId = oidOr404(b.team_id);
    const role = await roleOf(x.user._id, teamId, x.s);
    if (!role) throw new HttpError(404, 'not_found', 'Team not found');
    if (!atLeast(role, 'member')) forbid('Viewers cannot create work items');
    const t = now();
    const doc = { team_id: teamId, title, description: String(b.description || ''), type: b.type || 'task', status: 'open', priority, priority_rank: PRIORITIES[priority],
      reporter_id: x.user._id, assignee_id: null, due_at: b.due_at || null, approval_required: !!b.approval_required, approval_status: 'none',
      approval_requested_by: null, version: 1, created_at: t, updated_at: t };
    const r = await c.items.insertOne(doc, { session: x.s });
    await logEvent(x, { ...doc, _id: r.insertedId }, 'created', { title, priority });
    return view(out({ ...doc, _id: r.insertedId }), role, x.user.id);
  }

  async function patchItem(x, id, b) {
    const { raw, item, role, perms } = await load(x, id);
    if (!perms.edit) forbid();
    const changes = {}, diff = {};
    const set = (f, v) => { if (v !== item[f]) { changes[f] = v; diff[f] = { from: item[f], to: v }; } };
    if ('title' in b) { const t = String(b.title).trim(); if (!t || t.length > 200) throw new HttpError(400, 'invalid', 'bad title'); set('title', t); }
    if ('description' in b) set('description', String(b.description));
    if ('due_at' in b) set('due_at', b.due_at || null);
    if ('priority' in b) {
      if (!(b.priority in PRIORITIES)) throw new HttpError(400, 'invalid', 'invalid priority');
      set('priority', b.priority); if (changes.priority) changes.priority_rank = PRIORITIES[b.priority];
    }
    if ('approval_required' in b) {
      if (!atLeast(role, 'manager')) forbid('Only managers can change approval requirements');
      set('approval_required', !!b.approval_required);
    }
    if (!Object.keys(changes).length) return view(item, role, x.user.id); // no-op: nothing to version
    await checkVersion(x, raw, b.version);
    // Approval is about specific content: material edits invalidate it.
    if (('title' in changes || 'description' in changes) && ['pending', 'approved'].includes(item.approval_status)) {
      changes.approval_status = 'none'; changes.approval_requested_by = null;
      diff.approval_status = { from: item.approval_status, to: 'none', reason: 'content edited' };
    }
    return view(out(await save(x, raw, changes, 'updated', diff)), role, x.user.id);
  }

  async function claim(x, id) {
    const { raw, item, role, perms } = await load(x, id);
    if (!atLeast(role, 'member')) forbid();
    if (item.assignee_id === x.user.id) return view(item, role, x.user.id); // idempotent re-claim
    if (item.status === 'closed') throw new HttpError(422, 'closed', 'Closed items cannot be claimed');
    const lost = () => new HttpError(409, 'already_assigned', 'Someone else already took this item', { current: publicItem(item) });
    if (!perms.claim) throw lost();
    // Atomic: matches only while still unassigned, whatever version the caller saw. Two concurrent claimers => one match.
    const after = await c.items.findOneAndUpdate({ _id: raw._id, assignee_id: null, status: { $ne: 'closed' } },
      { $set: { assignee_id: x.user._id, status: item.status === 'open' ? 'in_progress' : item.status, updated_at: now() }, $inc: { version: 1 } },
      { returnDocument: 'after', session: x.s });
    if (!after) { const cur = await c.items.findOne({ _id: raw._id }, { session: x.s }); throw new HttpError(409, 'already_assigned', 'Someone else already took this item', { current: publicItem(out(cur)) }); }
    await logEvent(x, after, 'assigned', { assignee_id: x.user.id, via: 'claim', status: { from: item.status, to: after.status } });
    return view(out(after), role, x.user.id);
  }

  async function assign(x, id, b) {
    const { raw, item, role, perms } = await load(x, id);
    if (!perms.assign) forbid('Only managers can assign work');
    await checkVersion(x, raw, b.version);
    const to = b.assignee_id == null ? null : toOid(b.assignee_id);
    if (b.assignee_id != null && (!to || !atLeast(await roleOf(to, raw.team_id, x.s), 'member'))) throw new HttpError(422, 'invalid_assignee', 'Assignee must be a member of this team');
    if ((to ? String(to) : null) === item.assignee_id) return view(item, role, x.user.id);
    const changes = { assignee_id: to };
    if (to && item.status === 'open') changes.status = 'in_progress';
    if (!to && item.status === 'in_progress') changes.status = 'open';
    return view(out(await save(x, raw, changes, 'assigned', { assignee_id: { from: item.assignee_id, to: to ? String(to) : null }, via: 'assign' })), role, x.user.id);
  }

  async function transition(x, id, b) {
    const { raw, item, role, perms } = await load(x, id);
    const to = b.to;
    if (!(TRANSITIONS[item.status] || []).includes(to)) throw new HttpError(422, 'invalid_transition', `Cannot move from ${item.status} to ${to}`);
    if (!perms.transitions.includes(to)) forbid('You cannot make this transition');
    await checkVersion(x, raw, b.version);
    if (['in_progress', 'blocked', 'resolved'].includes(to) && !item.assignee_id) throw new HttpError(422, 'needs_assignee', 'Assign the item before moving it forward');
    if (to === 'resolved' && item.approval_required && item.approval_status !== 'approved') throw new HttpError(422, 'approval_required', 'This item needs an approval before it can be resolved');
    const changes = { status: to };
    if (to === 'open') changes.assignee_id = null; // released back to the pool
    return view(out(await save(x, raw, changes, 'status_changed', { status: { from: item.status, to }, reason: b.reason || null })), role, x.user.id);
  }

  async function approval(x, id, b) {
    const { raw, item, role, perms } = await load(x, id);
    await checkVersion(x, raw, b.version);
    if (b.action === 'request') {
      if (!perms.requestApproval) throw new HttpError(perms.edit ? 422 : 403, 'cannot_request', 'Approval cannot be requested now');
      return view(out(await save(x, raw, { approval_status: 'pending', approval_requested_by: x.user._id }, 'approval_requested', {})), role, x.user.id);
    }
    if (b.action === 'approve' || b.action === 'reject') {
      if (!perms.decideApproval) {
        if (item.approval_status !== 'pending') throw new HttpError(422, 'not_pending', 'No approval is pending');
        forbid(item.approval_requested_by === x.user.id ? 'You cannot approve your own request' : 'Only managers can decide approvals');
      }
      const st = b.action === 'approve' ? 'approved' : 'rejected';
      return view(out(await save(x, raw, { approval_status: st }, 'approval_' + st, { comment: b.comment || null })), role, x.user.id);
    }
    throw new HttpError(400, 'invalid', 'action must be request|approve|reject');
  }

  async function comment(x, id, b) {
    const { raw, perms } = await load(x, id);
    if (!perms.comment) forbid('Viewers cannot comment');
    const body = String(b.body || '').trim();
    if (!body || body.length > 5000) throw new HttpError(400, 'invalid', 'comment body required (max 5000)');
    // Comments don't bump the item version: they can never conflict with field edits.
    const r = await c.events.insertOne({ item_id: raw._id, actor_id: x.user._id, type: 'comment', data: { body }, item_version: raw.version, created_at: now() }, { session: x.s });
    await queueNotify(x, r.insertedId);
    await c.items.updateOne({ _id: raw._id }, { $set: { updated_at: now() } }, { session: x.s });
    x.events.push({ item_id: String(raw._id), team_id: String(raw.team_id), version: raw.version, actor_id: x.user.id, type: 'comment' });
    return { id: String(r.insertedId), type: 'comment', actor_id: x.user.id, data: { body } };
  }

  // ---------------- queries (no transaction needed) ----------------
  const names = async (ids) => {
    const uniq = [...new Set(ids.filter(Boolean).map(String))].map(toOid);
    const rows = uniq.length ? await c.users.find({ _id: { $in: uniq } }, { projection: { name: 1 } }).toArray() : [];
    return Object.fromEntries(rows.map((r) => [String(r._id), r.name]));
  };

  async function getItem(user, id, { before, limit = 30 } = {}) {
    const x = { s: undefined, user };
    const { item, role } = await load(x, id);
    const lim = Math.min(Number(limit) || 30, 100);
    const q = { item_id: toOid(item.id) };
    if (before) { const b = toOid(before); if (!b) throw new HttpError(400, 'invalid', 'bad cursor'); q._id = { $lt: b }; }
    const evs = await c.events.find(q).sort({ _id: -1 }).limit(lim + 1).toArray();
    const more = evs.length > lim; if (more) evs.pop();
    const nm = await names([item.assignee_id, item.reporter_id, ...evs.map((e) => e.actor_id)]);
    const team = await c.teams.findOne({ _id: toOid(item.team_id) });
    return {
      item: { ...view(item, role, user.id), assignee_name: nm[item.assignee_id] ?? null, reporter_name: nm[item.reporter_id], team_name: team?.name },
      events: evs.map((e) => ({ id: String(e._id), type: e.type, data: e.data, item_version: e.item_version, created_at: e.created_at, actor_id: e.actor_id && String(e.actor_id), actor_name: nm[String(e.actor_id)] })),
      has_more_events: more,
    };
  }

  async function listItems(user, p) {
    const memberships = await c.memberships.find({ user_id: user._id }).toArray();
    const roles = Object.fromEntries(memberships.map((m) => [String(m.team_id), m.role]));
    let teamIds = memberships.map((m) => m.team_id);
    if (p.team_id) { if (!roles[p.team_id]) throw new HttpError(404, 'not_found', 'Team not found'); teamIds = [toOid(p.team_id)]; }
    if (!teamIds.length) return { items: [], next_cursor: null };
    const and = [{ team_id: { $in: teamIds } }];
    const nowIso = now(), staleIso = new Date(Date.now() - STALE_DAYS * 864e5).toISOString();
    const active = { status: { $nin: ['resolved', 'closed'] } };
    const csv = (s) => String(s).split(',').filter(Boolean);
    if (p.status) and.push({ status: { $in: csv(p.status) } });
    if (p.priority) and.push({ priority: { $in: csv(p.priority) } });
    if (p.assignee === 'me') and.push({ assignee_id: user._id });
    else if (p.assignee === 'none') and.push({ assignee_id: null });
    else if (p.assignee) { const a = toOid(p.assignee); and.push({ assignee_id: a || '__none__' }); }
    if (p.view === 'mine') and.push({ assignee_id: user._id }, active);
    if (p.view === 'unassigned') and.push({ assignee_id: null }, active);
    if (p.view === 'attention') {
      const mgrTeams = teamIds.filter((t) => atLeast(roles[String(t)], 'manager'));
      const ors = [
        { ...active, due_at: { $lt: nowIso } },                                            // overdue (null never matches a string range)
        { assignee_id: null, priority: { $in: ['critical', 'high'] }, status: 'open' },    // urgent and nobody on it
        { assignee_id: user._id, status: 'blocked' },                                      // my blocked work
        { status: 'in_progress', updated_at: { $lt: staleIso } },                          // possibly forgotten
      ];
      if (mgrTeams.length) ors.push({ approval_status: 'pending', approval_requested_by: { $ne: user._id }, team_id: { $in: mgrTeams } });
      and.push({ $or: ors });
    }
    if (p.q && String(p.q).trim()) { // every word must match ("phrase" terms are ANDed by $text)
      and.push({ $text: { $search: String(p.q).trim().split(/\s+/).slice(0, 8).map((t) => `"${t.replace(/"/g, '')}"`).join(' ') } });
    }
    const sort = p.sort === 'priority' || p.view === 'attention' ? 'priority' : 'recent';
    if (p.cursor) {
      let k; try { k = JSON.parse(Buffer.from(p.cursor, 'base64url').toString()); } catch { throw new HttpError(400, 'invalid', 'bad cursor'); }
      if (sort === 'priority') { const id = toOid(k[2]); and.push({ $or: [{ priority_rank: { $gt: k[0] } }, { priority_rank: k[0], updated_at: { $lt: k[1] } }, { priority_rank: k[0], updated_at: k[1], _id: { $lt: id } }] }); }
      else { const id = toOid(k[1]); and.push({ $or: [{ updated_at: { $lt: k[0] } }, { updated_at: k[0], _id: { $lt: id } }] }); }
    }
    const limit = Math.min(Math.max(Number(p.limit) || 25, 1), 100);
    const order = sort === 'priority' ? { priority_rank: 1, updated_at: -1, _id: -1 } : { updated_at: -1, _id: -1 };
    const rows = await c.items.find({ $and: and }).sort(order).limit(limit + 1).toArray();
    const hasMore = rows.length > limit; if (hasMore) rows.pop();
    const last = rows[rows.length - 1];
    const cur = !hasMore ? null : Buffer.from(JSON.stringify(sort === 'priority' ? [last.priority_rank, last.updated_at, String(last._id)] : [last.updated_at, String(last._id)])).toString('base64url');
    const nm = await names(rows.flatMap((r) => [r.assignee_id, r.reporter_id]));
    const teams = await c.teams.find({ _id: { $in: [...new Set(rows.map((r) => String(r.team_id)))].map(toOid) } }).toArray();
    const tn = Object.fromEntries(teams.map((t) => [String(t._id), t.name]));
    return { items: rows.map((r) => ({ ...view(out(r), roles[String(r.team_id)], user.id), assignee_name: r.assignee_id ? nm[String(r.assignee_id)] : null, reporter_name: nm[String(r.reporter_id)], team_name: tn[String(r.team_id)] })), next_cursor: cur };
  }

  async function summary(user) {
    const ids = (await c.memberships.find({ user_id: user._id }).toArray()).map((m) => m.team_id);
    if (!ids.length) return { by_status: {}, overdue: 0, unassigned: 0, mine: 0 };
    const act = { $not: [{ $in: ['$status', ['resolved', 'closed']] }] };
    const rows = await c.items.aggregate([
      { $match: { team_id: { $in: ids } } },
      { $group: { _id: '$status', n: { $sum: 1 },
        overdue: { $sum: { $cond: [{ $and: [act, { $eq: [{ $type: '$due_at' }, 'string'] }, { $lt: ['$due_at', now()] }] }, 1, 0] } },
        unassigned: { $sum: { $cond: [{ $and: [act, { $eq: [{ $ifNull: ['$assignee_id', null] }, null] }] }, 1, 0] } },
        mine: { $sum: { $cond: [{ $and: [act, { $eq: ['$assignee_id', user._id] }] }, 1, 0] } } } },
    ]).toArray();
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    return { by_status: Object.fromEntries(rows.map((r) => [r._id, r.n])), overdue: sum('overdue'), unassigned: sum('unassigned'), mine: sum('mine') };
  }

  async function teamMembers(user, teamId) {
    const tid = oidOr404(teamId);
    if (!(await roleOf(user._id, tid))) throw new HttpError(404, 'not_found', 'Team not found');
    const ms = await c.memberships.find({ team_id: tid }).toArray();
    const nm = await names(ms.map((m) => m.user_id));
    return ms.map((m) => ({ id: String(m.user_id), name: nm[String(m.user_id)], role: m.role })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async function setMember(x, teamId, b) {
    const tid = oidOr404(teamId);
    if ((await roleOf(x.user._id, tid, x.s)) !== 'admin') forbid('Team admin only');
    if (!['admin', 'manager', 'member', 'viewer'].includes(b.role)) throw new HttpError(400, 'invalid', 'bad role');
    const uid = toOid(b.user_id); if (!uid || !(await c.users.findOne({ _id: uid }, { session: x.s }))) throw new HttpError(422, 'invalid', 'Unknown user');
    await c.memberships.updateOne({ user_id: uid, team_id: tid }, { $set: { role: b.role } }, { upsert: true, session: x.s });
    return { ok: true };
  }

  return { createItem, patchItem, claim, assign, transition, approval, comment, getItem, listItems, summary, teamMembers, setMember, roleOf };
}
module.exports = { createService, out, ObjectId };
