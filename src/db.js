'use strict';
const dns = require('node:dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { MongoClient, ObjectId } = require('mongodb');

async function openDb({ uri = process.env.MONGODB_URI, dbName = process.env.DB_NAME || 'opsboard' } = {}) {
  if (!uri) throw new Error('MONGODB_URI is not set. Put your Atlas connection string in .env or the environment (see README).');
  const client = new MongoClient(uri, { maxPoolSize: 50 });
  await client.connect();
  const db = client.db(dbName);
  const c = {
    users: db.collection('users'), teams: db.collection('teams'), memberships: db.collection('memberships'),
    items: db.collection('work_items'), events: db.collection('item_events'), idempotency: db.collection('idempotency'),
    outbox: db.collection('outbox'), notifications: db.collection('notifications'),
  };
  await Promise.all([
    c.users.createIndex({ email: 1 }, { unique: true }),
    c.teams.createIndex({ name: 1 }, { unique: true }),
    c.memberships.createIndex({ user_id: 1, team_id: 1 }, { unique: true }),
    c.memberships.createIndex({ team_id: 1 }),
    // List queries are always team-scoped and keyset-paginated: indexes match the sort orders exactly (ESR rule).
    c.items.createIndex({ team_id: 1, updated_at: -1, _id: -1 }),
    c.items.createIndex({ team_id: 1, priority_rank: 1, updated_at: -1, _id: -1 }),
    c.items.createIndex({ assignee_id: 1, status: 1 }),
    c.items.createIndex({ title: 'text', description: 'text' }),
    c.events.createIndex({ item_id: 1, _id: -1 }),
    // Idempotency: the unique key is what makes concurrent duplicates safe. TTL keeps the collection bounded.
    c.idempotency.createIndex({ user_id: 1, key: 1 }, { unique: true }),
    c.idempotency.createIndex({ created_at: 1 }, { expireAfterSeconds: 86400 }),
    c.outbox.createIndex({ dedupe_key: 1 }, { unique: true }),
    c.outbox.createIndex({ status: 1, run_at: 1 }),
    c.notifications.createIndex({ user_id: 1, event_id: 1 }, { unique: true }),   // exactly-once notification per event
    c.notifications.createIndex({ user_id: 1, read: 1, _id: -1 }),
  ]);
  return { client, db, c };
}
const ID_RE = /^[a-f0-9]{24}$/i;
// Parse a client-supplied id; malformed ids behave like "not found" rather than leaking a 500.
const toOid = (x) => (x instanceof ObjectId ? x : ID_RE.test(String(x)) ? new ObjectId(String(x)) : null);
module.exports = { openDb, toOid, ObjectId };
