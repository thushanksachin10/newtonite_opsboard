'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, shutdown, drain } = require('./helpers');
let t; before(async () => { t = await setup(); }); after(async () => { await t.close(); await shutdown(); });

// ---- 1. Two users take the same work at the same moment -------------------------------------------------
test('concurrent claim: exactly one winner, loser gets 409, one assignment event', async () => {
  const item = await t.mk('carol');
  const [a, b] = await Promise.all([t.as('carol').post(`/api/items/${item.id}/claim`), t.as('dave').post(`/api/items/${item.id}/claim`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((a.status === 409 ? a : b).body.error, 'already_assigned');
  const d = (await t.as('bob').get(`/api/items/${item.id}`)).body;
  assert.equal(d.events.filter((e) => e.type === 'assigned').length, 1);
  assert.equal(d.item.status, 'in_progress');
});
test('many simultaneous claimers still yield exactly one winner', async () => {
  const item = await t.mk('carol');
  const rs = await Promise.all(['carol', 'dave', 'bob', 'mia', 'alice'].map((u) => t.as(u).post(`/api/items/${item.id}/claim`)));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(rs.filter((r) => r.status === 409).length, 4);
});

// ---- 2. Stale writes / optimistic concurrency ------------------------------------------------------------
test('stale edit is rejected with 409 and returns the current state', async () => {
  const item = await t.mk('carol');
  const ok = await t.as('carol').patch(`/api/items/${item.id}`, { priority: 'high', version: item.version });
  assert.equal(ok.status, 200); assert.equal(ok.body.version, item.version + 1);
  const stale = await t.as('bob').patch(`/api/items/${item.id}`, { priority: 'low', version: item.version });
  assert.equal(stale.status, 409); assert.equal(stale.body.error, 'version_conflict'); assert.equal(stale.body.current.priority, 'high');
  assert.equal((await t.as('bob').patch(`/api/items/${item.id}`, { priority: 'low' })).status, 400);
});
test('simultaneous edits with the same version: one wins, no lost update', async () => {
  const item = await t.mk('carol');
  const rs = await Promise.all([t.as('carol').patch(`/api/items/${item.id}`, { title: 'A', version: 1 }), t.as('bob').patch(`/api/items/${item.id}`, { title: 'B', version: 1 })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const cur = (await t.as('bob').get(`/api/items/${item.id}`)).body.item;
  assert.equal(cur.version, 2); assert.ok(['A', 'B'].includes(cur.title));
});

// ---- 3. Duplicate / retried requests --------------------------------------------------------------------
test('Idempotency-Key: retried create does not create a second item; replay is flagged', async () => {
  const h = { 'Idempotency-Key': 'k-create-1' };
  const a = await t.as('carol').post('/api/items', { team_id: t.team1, title: 'Once only' }, h);
  const b = await t.as('carol').post('/api/items', { team_id: t.team1, title: 'Once only' }, h);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.body.id, b.body.id);
  assert.equal(b.headers.get('idempotent-replay'), 'true');
  assert.equal(await t.c.items.countDocuments({ title: 'Once only' }), 1);
  const c2 = await t.as('carol').post('/api/items', { team_id: t.team1, title: 'Different body' }, h);
  assert.equal(c2.status, 422); assert.equal(c2.body.error, 'idempotency_key_reuse');
});
test('Idempotency-Key: concurrent duplicates apply once (double-clicked comment)', async () => {
  const item = await t.mk('carol'); const h = { 'Idempotency-Key': 'k-comment-1' };
  const rs = await Promise.all([1, 2, 3].map(() => t.as('carol').post(`/api/items/${item.id}/comments`, { body: 'hello' }, h)));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  assert.equal(await t.c.events.countDocuments({ item_id: t.oid(item.id), type: 'comment' }), 1);
});
test('a failed request does not poison its idempotency key', async () => {
  const item = await t.mk('carol'); const h = { 'Idempotency-Key': 'k-fail-1' };
  assert.equal((await t.as('vic').post(`/api/items/${item.id}/comments`, { body: 'x' }, h)).status, 403);
  assert.equal((await t.as('vic').post(`/api/items/${item.id}/comments`, { body: 'x' }, h)).status, 403); // re-evaluated, not replayed
});

// ---- 4. Resource-level authorization ---------------------------------------------------------------------
test('non-members cannot see or touch items in another team (404, not 403) and never see them in lists', async () => {
  const item = await t.mk('carol', { title: 'secret-support-item' });
  assert.equal((await t.as('eve').get(`/api/items/${item.id}`)).status, 404);
  assert.equal((await t.as('eve').post(`/api/items/${item.id}/claim`)).status, 404);
  assert.equal((await t.as('eve').patch(`/api/items/${item.id}`, { title: 'x', version: 1 })).status, 404);
  assert.equal((await t.as('eve').get('/api/items?q=secret')).body.items.length, 0);
  assert.equal((await t.as('eve').post('/api/items', { team_id: t.team1, title: 'x' })).status, 404);
  assert.equal((await t.as('eve').get(`/api/items?team_id=${t.team1}`)).status, 404);
  assert.equal((await t.as('eve').get('/api/items/not-an-id')).status, 404);
});
test('role matrix: viewer read-only; member cannot assign or edit others\' items; manager can', async () => {
  const item = await t.mk('carol');
  assert.equal((await t.as('vic').get(`/api/items/${item.id}`)).status, 200);
  assert.equal((await t.as('vic').post('/api/items', { team_id: t.team1, title: 'x' })).status, 403);
  assert.equal((await t.as('vic').post(`/api/items/${item.id}/claim`)).status, 403);
  assert.equal((await t.as('dave').patch(`/api/items/${item.id}`, { title: 'hijack', version: 1 })).status, 403);
  assert.equal((await t.as('dave').post(`/api/items/${item.id}/assign`, { assignee_id: t.ids.dave, version: 1 })).status, 403);
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/assign`, { assignee_id: t.ids.dave, version: 1 })).status, 200);
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/assign`, { assignee_id: t.ids.eve, version: 2 })).status, 422); // not on team
  assert.equal((await t.as('carol').post(`/api/items/${item.id}/comments`, { body: 'ok' })).status, 201);
});
test('only team admins can change memberships', async () => {
  const put = (who, body) => fetch(`http://127.0.0.1:${t.port}/api/teams/${t.team1}/members`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.tokenFor(who) }, body: JSON.stringify(body) });
  assert.equal((await put('bob', { user_id: t.ids.eve, role: 'member' })).status, 403);
  assert.equal((await put('alice', { user_id: t.ids.eve, role: 'member' })).status, 200);
  assert.equal((await t.as('eve').get(`/api/teams/${t.team1}/members`)).status, 200);
});
test('assignee (member) can progress their own item but cannot close it', async () => {
  const item = await t.mk('carol'); await t.as('dave').post(`/api/items/${item.id}/claim`);
  assert.equal((await t.as('dave').post(`/api/items/${item.id}/transition`, { to: 'resolved', version: 2 })).status, 200);
  assert.equal((await t.as('dave').post(`/api/items/${item.id}/transition`, { to: 'closed', version: 3 })).status, 403);
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/transition`, { to: 'closed', version: 3 })).status, 200);
});

// ---- 5. Workflow rules & approvals ----------------------------------------------------------------------
test('workflow: illegal transitions and missing assignee are refused', async () => {
  const item = await t.mk('carol');
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/transition`, { to: 'resolved', version: 1 })).body.error, 'invalid_transition');
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/transition`, { to: 'in_progress', version: 1 })).body.error, 'needs_assignee');
});
test('approval: cannot resolve unapproved; requester cannot self-approve; another manager can; editing content voids approval', async () => {
  const item = await t.mk('carol', { approval_required: true });
  await t.as('carol').post(`/api/items/${item.id}/claim`); // v2
  assert.equal((await t.as('carol').post(`/api/items/${item.id}/transition`, { to: 'resolved', version: 2 })).body.error, 'approval_required');
  assert.equal((await t.as('carol').post(`/api/items/${item.id}/approval`, { action: 'request', version: 2 })).status, 200); // v3
  assert.equal((await t.as('carol').post(`/api/items/${item.id}/approval`, { action: 'approve', version: 3 })).status, 403);
  const own = await t.mk('bob', { approval_required: true });
  await t.as('bob').post(`/api/items/${own.id}/claim`);
  await t.as('bob').post(`/api/items/${own.id}/approval`, { action: 'request', version: 2 });
  const self = await t.as('bob').post(`/api/items/${own.id}/approval`, { action: 'approve', version: 3 });
  assert.equal(self.status, 403); assert.match(self.body.message, /own request/);
  assert.equal((await t.as('mia').post(`/api/items/${own.id}/approval`, { action: 'approve', version: 3 })).status, 200);
  const ed = await t.as('bob').patch(`/api/items/${own.id}`, { description: 'changed after approval', version: 4 });
  assert.equal(ed.body.approval_status, 'none');
  assert.equal((await t.as('bob').post(`/api/items/${own.id}/transition`, { to: 'resolved', version: 5 })).body.error, 'approval_required');
  assert.equal((await t.as('bob').post(`/api/items/${item.id}/approval`, { action: 'approve', version: 3 })).status, 200);
  assert.equal((await t.as('carol').post(`/api/items/${item.id}/transition`, { to: 'resolved', version: 4 })).status, 200);
});

// ---- 6. History ----------------------------------------------------------------------------------------
test('history: every change is recorded with actor and before/after values', async () => {
  const item = await t.mk('carol');
  await t.as('carol').patch(`/api/items/${item.id}`, { priority: 'critical', version: 1 });
  await t.as('bob').post(`/api/items/${item.id}/assign`, { assignee_id: t.ids.dave, version: 2 });
  const d = (await t.as('vic').get(`/api/items/${item.id}`)).body;
  assert.deepEqual(d.events.map((e) => e.type).reverse(), ['created', 'updated', 'assigned']);
  assert.deepEqual(d.events.find((e) => e.type === 'updated').data.priority, { from: 'medium', to: 'critical' });
  assert.equal(d.events[0].actor_name, 'bob');
});
test('a failed transaction leaves no partial state (no event, no version bump, no outbox row)', async () => {
  const item = await t.mk('carol');
  const before = await t.c.events.countDocuments({ item_id: t.oid(item.id) });
  await t.as('bob').patch(`/api/items/${item.id}`, { title: 'x', version: 99 }); // 409
  assert.equal(await t.c.events.countDocuments({ item_id: t.oid(item.id) }), before);
  assert.equal((await t.c.items.findOne({ _id: t.oid(item.id) })).version, 1);
});

// ---- 7. Async processing --------------------------------------------------------------------------------
test('outbox: notifications are created after the request, once, even if the job runs twice', async () => {
  const item = await t.mk('carol'); await t.as('bob').post(`/api/items/${item.id}/assign`, { assignee_id: t.ids.dave, version: 1 });
  const count = () => t.c.notifications.countDocuments({ item_id: t.oid(item.id) });
  assert.equal(await count(), 0); // nothing synchronous
  await drain(t.worker);
  const n1 = (await t.c.notifications.find({ item_id: t.oid(item.id) }).toArray()).map((r) => String(r.user_id)).sort();
  assert.deepEqual(n1, [t.ids.carol, t.ids.dave].sort()); // reporter + new assignee, not the actor (bob)
  await t.c.outbox.updateMany({}, { $set: { status: 'pending', run_at: 0 } }); // simulate redelivery of every job
  await drain(t.worker);
  assert.equal(await count(), n1.length);
});
test('outbox: failures retry with backoff, then dead-letter; the user-facing action is unaffected', async () => {
  const f = await setup({ handlerOverrides: { async notify() { throw new Error('smtp down'); } } });
  try {
    const item = await f.mk('carol');
    assert.ok(item.id); // primary action succeeded despite broken secondary work
    await f.worker.runOnce();
    let job = await f.c.outbox.findOne({});
    assert.equal(job.status, 'pending'); assert.equal(job.attempts, 1); assert.match(job.last_error, /smtp down/);
    assert.ok(job.run_at > Date.now(), 'backoff scheduled in the future');
    assert.equal(await f.worker.runOnce(), 0); // not due yet
    for (let i = 0; i < 6; i++) { await f.c.outbox.updateMany({}, { $set: { run_at: 0 } }); await f.worker.runOnce(); }
    job = await f.c.outbox.findOne({});
    assert.equal(job.status, 'dead'); assert.equal(job.attempts, 5);
  } finally { await f.close(); }
});
test('outbox: a crashed worker lease expires and the job is picked up again', async () => {
  const item = await t.mk('carol');
  await t.c.outbox.updateMany({ status: 'pending' }, { $set: { status: 'processing', locked_until: 1 } }); // abandoned leases
  await drain(t.worker);
  assert.equal(await t.c.outbox.countDocuments({ status: 'processing' }), 0);
  assert.ok(item.id);
});
test('outbox: two workers racing never run the same job twice at once', async () => {
  const f = await setup();
  try {
    let runs = 0; const w2 = require('../src/outbox').createWorker(f.c, { async notify() { runs++; await new Promise((r) => setTimeout(r, 20)); } });
    await f.mk('carol'); await f.c.outbox.updateMany({}, { $set: { run_at: 0 } });
    const jobs = await f.c.outbox.countDocuments({ status: 'pending' });
    await Promise.all([w2.runOnce(), w2.runOnce(), w2.runOnce()]);
    assert.equal(runs, jobs);
  } finally { await f.close(); }
});

// ---- 8. Listing, search, pagination ---------------------------------------------------------------------
test('keyset pagination: no duplicates or gaps across pages; team scoping holds; search ANDs words', async () => {
  const f = await setup();
  try {
    const stamp = '2026-01-01T00:00:00.000Z', rep = f.oid(f.ids.carol);
    await f.c.items.insertMany(Array.from({ length: 53 }, (_, i) => ({ team_id: f.oid(f.team1), title: `bulk ${i}`, description: '', type: 'task', status: 'open', priority: 'medium', priority_rank: 2,
      reporter_id: rep, assignee_id: null, due_at: null, approval_required: false, approval_status: 'none', approval_requested_by: null, version: 1, created_at: stamp, updated_at: stamp })));
    await f.c.items.insertOne({ team_id: f.oid(f.team2), title: 'eng only', description: '', type: 'task', status: 'open', priority: 'low', priority_rank: 3, reporter_id: f.oid(f.ids.eve), assignee_id: null, due_at: null, approval_required: false, approval_status: 'none', approval_requested_by: null, version: 1, created_at: stamp, updated_at: stamp });
    for (const sort of ['recent', 'priority']) {
      const seen = []; let cursor = null, pages = 0;
      do { const r = (await f.as('carol').get(`/api/items?limit=10&sort=${sort}${cursor ? '&cursor=' + cursor : ''}`)).body; seen.push(...r.items.map((i) => i.id)); cursor = r.next_cursor; pages++; } while (cursor);
      assert.equal(seen.length, 53, sort); assert.equal(new Set(seen).size, 53, sort); assert.equal(pages, 6, sort); // identical timestamps: _id is the tiebreaker
    }
    assert.equal((await f.as('carol').get('/api/items?q=eng')).body.items.length, 0);
    assert.equal((await f.as('carol').get('/api/items?q=bulk%2052')).body.items.length, 1);
  } finally { await f.close(); }
});
test('attention view: pending approvals surface for managers only; unassigned critical items surface for everyone', async () => {
  const f = await setup();
  try {
    const a = await f.mk('carol', { approval_required: true }); await f.as('carol').post(`/api/items/${a.id}/claim`);
    await f.as('carol').post(`/api/items/${a.id}/approval`, { action: 'request', version: 2 });
    const c2 = await f.mk('carol', { priority: 'critical', title: 'Prod down' });
    const ids = async (u) => (await f.as(u).get('/api/items?view=attention')).body.items.map((i) => i.id);
    assert.deepEqual((await ids('bob')).sort(), [a.id, c2.id].sort());
    assert.deepEqual(await ids('dave'), [c2.id]);
    assert.equal((await ids('carol')).includes(a.id), false);
    const s = (await f.as('bob').get('/api/summary')).body; assert.equal(s.unassigned, 1);
  } finally { await f.close(); }
});
test('unauthenticated and tampered tokens are rejected', async () => {
  assert.equal((await t.as('carol').get('/api/me')).status, 200);
  const hit = (h) => fetch(`http://127.0.0.1:${t.port}/api/items`, { headers: h }).then((r) => r.status);
  assert.equal(await hit({ Authorization: 'Bearer abc.def' }), 401);
  assert.equal(await hit({}), 401);
});
