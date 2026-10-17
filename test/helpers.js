'use strict';
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { ObjectId } = require('../src/db');

// Tests need a MongoDB *replica set* (transactions). Use MONGODB_URI (Atlas or local rs) if set,
// otherwise start an in-memory replica set via mongodb-memory-server. Each setup() uses its own throw-away database.
let mem;
async function getUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  if (!mem) { const { MongoMemoryReplSet } = require('mongodb-memory-server'); mem = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); }
  return mem.getUri();
}
async function shutdown() { if (mem) { await mem.stop(); mem = null; } }

// Team "Support": alice(admin) bob(manager) carol(member) dave(member) vic(viewer) mia(manager).  Team "Engineering": eve(member) -> outsider for Support.
async function setup(opts = {}) {
  const dbName = 'opsboard_test_' + crypto.randomBytes(5).toString('hex');
  const ctx = await createApp({ uri: await getUri(), dbName, ...opts });
  const { c } = ctx; const pw = hashPassword('pw');
  const support = new ObjectId(), eng = new ObjectId();
  await c.teams.insertMany([{ _id: support, name: 'Support' }, { _id: eng, name: 'Engineering' }]);
  const people = { alice: ['admin', support], bob: ['manager', support], carol: ['member', support], dave: ['member', support], vic: ['viewer', support], eve: ['member', eng], mia: ['manager', support] };
  const ids = {};
  for (const [n, [role, team]] of Object.entries(people)) {
    const r = await c.users.insertOne({ email: `${n}@t.io`, name: n, password_hash: pw, created_at: new Date() });
    ids[n] = String(r.insertedId);
    await c.memberships.insertOne({ user_id: r.insertedId, team_id: team, role });
  }
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const tokens = {};
  for (const n of Object.keys(people)) tokens[n] = (await call(null, 'POST', '/api/auth/login', { email: `${n}@t.io`, password: 'pw' })).body.token;
  const as = (n) => ({ get: (u) => call(tokens[n], 'GET', u), post: (u, b, h) => call(tokens[n], 'POST', u, b ?? {}, h), patch: (u, b, h) => call(tokens[n], 'PATCH', u, b, h) });
  const team1 = String(support), team2 = String(eng);
  const mk = async (who = 'carol', extra = {}) => (await as(who).post('/api/items', { team_id: team1, title: 'Refund stuck', ...extra })).body;
  return { ...ctx, port, tokenFor: (n) => tokens[n], ids, team1, team2, as, mk, oid: (s) => new ObjectId(s),
    close: async () => { ctx.worker.stop(); server.close(); await ctx.db.dropDatabase(); await ctx.client.close(); } };
}
const drain = async (worker) => { while (await worker.runOnce()); };
module.exports = { setup, shutdown, drain };
