'use strict';
// Outbox worker. Delivery is AT-LEAST-ONCE; handlers must be idempotent.
// - Jobs are inserted in the same transaction as the state change (no lost side effects).
// - A job is leased atomically (findOneAndUpdate) with an expiry; a crashed worker's lease lapses and the job is retried.
// - Failures retry with exponential backoff; after MAX_ATTEMPTS the job is parked as 'dead' for inspection.
const { toOid } = require('./db');
const MAX_ATTEMPTS = 5;
const LEASE_MS = 30_000;

function buildHandlers(c, bus) {
  const MSG = { created: 'created', assigned: 'changed the assignee of', status_changed: 'changed the status of', updated: 'edited',
    comment: 'commented on', approval_requested: 'requested approval for', approval_approved: 'approved', approval_rejected: 'rejected' };
  return {
    async notify({ event_id }) {
      const e = await c.events.findOne({ _id: event_id });
      const item = e && await c.items.findOne({ _id: e.item_id });
      if (!e || !item) return; // gone: idempotent no-op
      const s = (v) => (v == null ? null : String(v));
      let to = new Set();
      if (e.type === 'created') to = new Set();                          // the actor already knows
      else if (e.type === 'approval_requested') (await c.memberships.find({ team_id: item.team_id, role: { $in: ['manager', 'admin'] } }).toArray()).forEach((m) => to.add(s(m.user_id)));
      else if (e.type.startsWith('approval_')) to = new Set([s(item.approval_requested_by), s(item.assignee_id)]);
      else to = new Set([s(item.assignee_id), s(item.reporter_id)]);
      if (e.type === 'assigned') { const a = e.data.assignee_id; if (a && typeof a === 'object') { to.add(a.from); to.add(a.to); } else to.add(a); }
      to.delete(s(e.actor_id)); to.delete(null);
      const actor = e.actor_id && await c.users.findOne({ _id: e.actor_id }, { projection: { name: 1 } });
      const msg = `${actor?.name ?? 'Someone'} ${MSG[e.type] || e.type} “${item.title}”`;
      // Unique (user_id,event_id) + upsert: running this job twice yields the same single notification.
      await Promise.all([...to].map((u) => c.notifications.updateOne({ user_id: toOid(u), event_id: e._id },
        { $setOnInsert: { item_id: item._id, message: msg, read: false, created_at: new Date().toISOString() } }, { upsert: true })));
      bus.emit('notify', [...to]);
    },
  };
}

function createWorker(c, handlers, { maxAttempts = MAX_ATTEMPTS, clock = Date.now } = {}) {
  let timer, running = false;
  const worker = {
    async runOnce() {
      const n = clock(); let processed = 0;
      for (let i = 0; i < 25; i++) {
        const job = await c.outbox.findOneAndUpdate(
          { $or: [{ status: 'pending', run_at: { $lte: n } }, { status: 'processing', locked_until: { $lt: n } }] },
          { $set: { status: 'processing', locked_until: n + LEASE_MS }, $inc: { attempts: 1 } },
          { sort: { run_at: 1 }, returnDocument: 'after' });
        if (!job) break;
        try { await handlers[job.kind](job.payload); await c.outbox.updateOne({ _id: job._id }, { $set: { status: 'done', locked_until: null } }); }
        catch (err) {
          const dead = job.attempts >= maxAttempts;
          await c.outbox.updateOne({ _id: job._id }, { $set: { status: dead ? 'dead' : 'pending', run_at: n + 1000 * 2 ** job.attempts, locked_until: null, last_error: String(err.message || err) } });
        }
        processed++;
      }
      return processed;
    },
    start(ms = 500) {
      timer = setInterval(async () => { if (running) return; running = true;
        try { while ((await worker.runOnce()) > 0); } catch (e) { console.error('worker', e); } finally { running = false; } }, ms);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
  return worker;
}
module.exports = { createWorker, buildHandlers };
