'use strict';
// usage: node scripts/seed.js [itemCount]   (default 300; try 50000 to see list/search performance)
try { process.loadEnvFile?.(); } catch { /* optional .env */ }
const { openDb, ObjectId } = require('../src/db');
const { hashPassword } = require('../src/auth');
(async () => {
  const { client, c } = await openDb();
  const N = Number(process.argv[2] || 300);
  if (await c.users.countDocuments()) { console.log('Database already seeded (drop the database to reseed).'); return client.close(); }
  const pw = hashPassword('password');
  const people = [['alice', 'Alice Admin'], ['bob', 'Bob Manager'], ['carol', 'Carol Support'], ['dave', 'Dave Engineer'], ['erin', 'Erin Payments'], ['frank', 'Frank Viewer'], ['gina', 'Gina Multi-team']];
  const teamNames = ['Support', 'Engineering', 'Payments', 'Compliance'];
  const M = { alice: [[0, 'admin'], [1, 'admin'], [2, 'admin'], [3, 'admin']], bob: [[0, 'manager'], [1, 'manager']], carol: [[0, 'member'], [3, 'member']],
    dave: [[1, 'member']], erin: [[2, 'member']], frank: [[0, 'viewer'], [1, 'viewer']], gina: [[0, 'member'], [1, 'manager'], [2, 'member']] };
  const teams = teamNames.map((name) => ({ _id: new ObjectId(), name }));
  const users = people.map(([k, name]) => ({ _id: new ObjectId(), key: k, email: `${k}@example.com`, name, password_hash: pw, created_at: new Date() }));
  await c.teams.insertMany(teams);
  await c.users.insertMany(users.map(({ key, ...u }) => u));
  const mem = []; users.forEach((u) => M[u.key].forEach(([t, role]) => mem.push({ user_id: u._id, team_id: teams[t]._id, role })));
  await c.memberships.insertMany(mem);
  const subjects = ['Refund stuck in processing', 'Checkout 500 errors', 'Chargeback review', 'Prod DB latency spike', 'Customer cannot log in', 'GDPR export request',
    'Vendor invoice mismatch', 'Webhook retries failing', 'Access review overdue', 'Payout batch delayed', 'Duplicate charge reported', 'Certificate expiring'];
  const pr = ['critical', 'high', 'medium', 'medium', 'low'], rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const st = ['open', 'open', 'in_progress', 'in_progress', 'blocked', 'resolved', 'closed'];
  const rnd = (n) => Math.floor(Math.random() * n);
  const byTeam = teams.map((_, t) => mem.filter((m) => String(m.team_id) === String(teams[t]._id) && m.role !== 'viewer').map((m) => m.user_id));
  let items = [], events = [];
  const flush = async () => { if (items.length) { await c.items.insertMany(items); await c.events.insertMany(events); items = []; events = []; } };
  for (let i = 0; i < N; i++) {
    const t = rnd(4), members = byTeam[t];
    let s = st[rnd(st.length)]; const p = pr[rnd(pr.length)], when = new Date(Date.now() - rnd(20 * 864e5)).toISOString();
    let assignee = s === 'open' && rnd(3) ? null : members[rnd(members.length)];
    if (s === 'open' && assignee) s = 'in_progress';
    if (s !== 'open' && !assignee) assignee = members[rnd(members.length)];
    const _id = new ObjectId(), reporter = members[rnd(members.length)];
    items.push({ _id, team_id: teams[t]._id, title: `${subjects[rnd(subjects.length)]} #${i + 1}`, description: `Ticket ${i + 1} raised by ops. Needs investigation and follow-up.`, type: 'task',
      status: s, priority: p, priority_rank: rank[p], reporter_id: reporter, assignee_id: assignee, due_at: rnd(3) ? new Date(Date.now() + (rnd(14) - 5) * 864e5).toISOString() : null,
      approval_required: rnd(4) === 0, approval_status: 'none', approval_requested_by: null, version: 1, created_at: when, updated_at: when });
    events.push({ item_id: _id, actor_id: reporter, type: 'created', data: {}, item_version: 1, created_at: when });
    if (items.length >= 2000) await flush();
  }
  await flush();
  console.log(`Seeded ${people.length} users, ${teams.length} teams, ${N} items. Login with <name>@example.com / password`);
  await client.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
