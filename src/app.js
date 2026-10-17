'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { openDb, toOid } = require('./db');
const { createService } = require('./service');
const { createWorker, buildHandlers } = require('./outbox');
const { verifyPassword, issueToken, readToken } = require('./auth');
const { HttpError } = require('./policy');

async function createApp({ uri, dbName, handlerOverrides } = {}) {
  const { client, db, c } = await openDb({ uri, dbName });
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const svc = createService(c);
  const worker = createWorker(c, { ...buildHandlers(c, bus), ...handlerOverrides });
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const pubUser = (u) => ({ _id: u._id, id: String(u._id), email: u.email, name: u.name });
  async function auth(req, _res, next) {
    const h = req.get('Authorization');
    const tok = h?.startsWith('Bearer ') ? h.slice(7) : req.query.token; // query token only for EventSource
    const d = readToken(tok); const oid = d && toOid(d.uid);
    const u = oid && await c.users.findOne({ _id: oid });
    if (!u) return next(new HttpError(401, 'unauthenticated', 'Sign in required'));
    req.user = pubUser(u); next();
  }

  // Runs fn inside ONE multi-document transaction. With an Idempotency-Key, the stored response is replayed on retry and
  // the key is recorded atomically with the effect, so "did it work?" retries cannot double-apply. If two identical
  // requests race, the unique index on (user_id,key) makes one transaction fail with E11000 and it retries as a replay.
  async function run(req, res, fn) {
    const key = req.get('Idempotency-Key');
    const hash = crypto.createHash('sha256').update(JSON.stringify([req.method, req.path, req.body])).digest('hex');
    for (let attempt = 0; ; attempt++) {
      const session = client.startSession();
      const x = { s: session, user: req.user, events: [] };
      let result;
      try {
        await session.withTransaction(async () => {
          x.events = []; result = undefined;
          if (key) {
            const row = await c.idempotency.findOne({ user_id: req.user._id, key }, { session });
            if (row) {
              if (row.request_hash !== hash) throw new HttpError(422, 'idempotency_key_reuse', 'Idempotency-Key was already used with a different request');
              result = { status: row.status, body: row.response, replay: true }; return;
            }
          }
          const r = await fn(x);
          result = { status: r.status || 200, body: r.body };
          if (key) await c.idempotency.insertOne({ user_id: req.user._id, key, request_hash: hash, status: result.status, response: result.body, created_at: new Date() }, { session });
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      } catch (e) {
        if (e.code === 11000 && key && attempt < 3) continue; // lost the race on the idempotency key: retry, will replay
        throw e;
      } finally { await session.endSession(); }
      if (!result.replay) x.events.forEach((e) => bus.emit('item', e));
      if (result.replay) res.set('Idempotent-Replay', 'true');
      return res.status(result.status).json(result.body);
    }
  }
  const write = (fn) => (req, res) => run(req, res, (x) => fn(x, req));   // Express 5 forwards rejected promises to the error handler

  app.get('/api/health', (_q, r) => r.json({ ok: true }));
  app.post('/api/auth/login', async (req, res) => {
    const u = await c.users.findOne({ email: String(req.body.email || '').toLowerCase() });
    if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'bad_credentials', 'Invalid email or password');
    res.json({ token: issueToken(String(u._id)), user: { id: String(u._id), name: u.name, email: u.email } });
  });
  app.get('/api/demo-users', async (_q, res) => res.json((await c.users.find({}, { projection: { email: 1, name: 1 } }).sort({ _id: 1 }).limit(12).toArray()).map((u) => ({ email: u.email, name: u.name }))));

  app.use('/api', auth);
  app.get('/api/me', async (req, res) => {
    const ms = await c.memberships.find({ user_id: req.user._id }).toArray();
    const ts = await c.teams.find({ _id: { $in: ms.map((m) => m.team_id) } }).toArray();
    const role = Object.fromEntries(ms.map((m) => [String(m.team_id), m.role]));
    res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email }, teams: ts.map((t) => ({ id: String(t._id), name: t.name, role: role[String(t._id)] })).sort((a, b) => a.name.localeCompare(b.name)) });
  });
  app.get('/api/summary', async (req, res) => res.json(await svc.summary(req.user)));
  app.get('/api/teams/:id/members', async (req, res) => res.json(await svc.teamMembers(req.user, req.params.id)));
  app.put('/api/teams/:id/members', write(async (x, req) => ({ body: await svc.setMember(x, req.params.id, req.body) })));

  app.get('/api/items', async (req, res) => res.json(await svc.listItems(req.user, req.query)));
  app.post('/api/items', write(async (x, req) => ({ status: 201, body: await svc.createItem(x, req.body) })));
  app.get('/api/items/:id', async (req, res) => res.json(await svc.getItem(req.user, req.params.id, req.query)));
  app.patch('/api/items/:id', write(async (x, req) => ({ body: await svc.patchItem(x, req.params.id, req.body) })));
  app.post('/api/items/:id/claim', write(async (x, req) => ({ body: await svc.claim(x, req.params.id) })));
  app.post('/api/items/:id/assign', write(async (x, req) => ({ body: await svc.assign(x, req.params.id, req.body) })));
  app.post('/api/items/:id/transition', write(async (x, req) => ({ body: await svc.transition(x, req.params.id, req.body) })));
  app.post('/api/items/:id/approval', write(async (x, req) => ({ body: await svc.approval(x, req.params.id, req.body) })));
  app.post('/api/items/:id/comments', write(async (x, req) => ({ status: 201, body: await svc.comment(x, req.params.id, req.body) })));

  app.get('/api/notifications', async (req, res) => res.json({
    unread: await c.notifications.countDocuments({ user_id: req.user._id, read: false }),
    items: (await c.notifications.find({ user_id: req.user._id }).sort({ _id: -1 }).limit(30).toArray()).map((n) => ({ id: String(n._id), item_id: String(n.item_id), message: n.message, read: n.read, created_at: n.created_at })) }));
  app.post('/api/notifications/read', async (req, res) => { await c.notifications.updateMany({ user_id: req.user._id, read: false }, { $set: { read: true } }); res.json({ ok: true }); });

  // Live updates: tiny "something changed" signals filtered by the user's teams; clients refetch via the normal (authorized) API.
  app.get('/api/stream', async (req, res) => {
    const teams = new Set((await c.memberships.find({ user_id: req.user._id }).toArray()).map((m) => String(m.team_id)));
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.flushHeaders();
    const onItem = (e) => teams.has(e.team_id) && res.write(`event: item\ndata: ${JSON.stringify(e)}\n\n`);
    const onNotify = (ids) => ids.includes(req.user.id) && res.write('event: notify\ndata: {}\n\n');
    bus.on('item', onItem); bus.on('notify', onNotify);
    const ka = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); bus.off('item', onItem); bus.off('notify', onNotify); });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (_q, _r, next) => next(new HttpError(404, 'not_found', 'No such endpoint')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'Malformed JSON' });
    console.error(err); res.status(500).json({ error: 'internal', message: 'Something went wrong' });
  });
  return { app, db, c, client, worker, bus };
}
module.exports = { createApp };
