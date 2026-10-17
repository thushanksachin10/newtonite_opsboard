# Engineering decisions

## 0. Assumptions
Each work item belongs to exactly one team; roles are per team. A *reporter* files an item, an *assignee* owns it. Approval is an optional gate per item (payments, compliance, …) and must come from a *different* manager. Another team's data should be indistinguishable from "does not exist". One-day scope, so a modular monolith rather than services.

## 1. MongoDB Atlas: documents for work items, a separate collection for history
**Choice.** `work_items` holds the current state of an item as one document (status, owner, priority, approval state, `version`). Activity lives in a separate `item_events` collection (one document per change or comment, referencing the item), not embedded in the item.
**Why.** An item's state is read and written as a unit, so a document fits. History is unbounded and grows forever ("a large and continually growing history"): embedding it would bloat every list read and risk the 16 MB document limit, whereas a separate collection indexed on `{item_id, _id:-1}` pages cheaply. Atlas gives managed replication, which also provides what the correctness features need: multi-document transactions.
**Trade-off.** Cross-collection consistency is not free in Mongo, so every command runs in one transaction (item + event + outbox row). Transactions on a very hot document can hit write conflicts; the driver retries them and the business rule then re-evaluates against fresh data, which is exactly the behaviour I want for contested items.

## 2. Concurrency: optimistic versions for edits, an atomic conditional update for claims
- Every item has a `version`. Edits, transitions, assignment and approvals must send the version they saw; the write is `findOneAndUpdate({_id, version}, {$set…, $inc:{version:1}})`. No match → **409 with the current item**, so the UI refreshes and the user retries deliberately. No last-write-wins.
- *Claim* is different: the intent is "take it if nobody has", so the filter is `{_id, assignee_id: null}` regardless of version. Two simultaneous claimers give one 200, one 409 `already_assigned`, and exactly one `assigned` event. Re-claiming your own item is a harmless no-op.
- Comments do not bump `version`: they are insert-only and cannot conflict with field edits.
- UI: claim is applied **optimistically**, then reconciled with the server response (rolled back on 409, showing the winner). Everything else waits for the server. SSE signals trigger refetches, so users usually see changes before they conflict.

## 3. Idempotency for retried or double-submitted requests
Clients send an `Idempotency-Key` per user action (reused across automatic network retries). The key, a request hash and the response are stored **in the same transaction as the effect**. A unique index on `(user_id, key)` is what makes *concurrent* duplicates safe: if two identical requests race, one transaction fails with a duplicate-key error and is retried, at which point it finds the stored result and replays it (`Idempotent-Replay: true`). The same key with a different body gives 422. Failed requests are not stored, so a permission error cannot poison a key. A TTL index expires records after 24 h.

## 4. Authorization is a pure function, enforced in the service layer
`policy.permissionsFor(role, item, userId)` is the single source of truth, used both to enforce every command and to tell the UI what to render. It includes resource-level rules: a member edits or progresses only items they report or own; only managers assign, close, or decide approvals; an approver cannot approve their own request; only team admins manage membership. Every item lookup is scoped by the caller's team membership and returns **404, not 403**, to outsiders, and list queries are always constrained to the caller's teams, so existence cannot leak. Malformed ids are also 404. Tests cover the role matrix and cross-team probing.
**Trade-off.** Roles are coarse and per team. Tokens are stateless HMAC (12 h), so revocation means expiry, but role changes apply immediately because membership is read on every request.

## 5. History is insert-only; side effects go through a transactional outbox
- `item_events` records who did what with before/after values and the item version. No code path updates or deletes events. For defence in depth the application's Atlas database user should only be granted `find`/`insert` on that collection via a custom role (noted in limitations, since it is deployment config rather than code).
- Notifications are secondary work. The request writes an outbox document in the same transaction; a worker leases jobs atomically (`findOneAndUpdate` with a `locked_until` expiry), retries with exponential backoff and dead-letters after 5 attempts. Delivery is **at-least-once**, so the handler is idempotent (unique `(user_id, event_id)` + upsert); a crashed worker's lease expires and the job is retried. A broken notifier never fails or slows the user's action (tested).
- Workflow rules are server-side: only legal transitions; no progress without an owner; an approval-gated item cannot be resolved until approved; editing title/description after approval voids it, because the approval was for different content.

## 6. Scale-aware reads
Keyset pagination on `(updated_at,_id)` and `(priority_rank,updated_at,_id)` with matching compound indexes (team first, then sort keys), so deep pages cost the same as page 1. Text search uses a `$text` index (all words must match). Counts use one indexed aggregation. The browser only holds loaded pages and the timeline is paginated too. "Needs attention" is a single `$or` query built from explicit rules, not a notion of "unread".

## Deliberately not built
Co-editing/presence, attachments, email/Slack delivery (the outbox handler is the seam), auto-escalating SLA timers, admin UI, rate limiting, Atlas Search (for prefix/fuzzy matching), a frontend framework/build step (a plain SPA keeps the review surface small).
