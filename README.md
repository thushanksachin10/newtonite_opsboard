# Opsboard — Operations Under Pressure

A web app that lets teams coordinate operational work reliably: incidents, payment investigations, compliance requests and approvals, all in one place instead of scattered across chat, email and spreadsheets.

Built for the Newtonite Software Engineering Challenge. The brief deliberately leaves decisions open, so this README explains not just *what* the system does but *why* it behaves the way it does when users collide, requests are retried, and things fail.

## Highlights

- **Correct under contention.** Two people claiming the same item produce exactly one winner. Two people editing from stale views never silently overwrite each other.
- **Safe to retry.** Double-clicks and network retries never create duplicate items, comments or actions.
- **Authorization enforced by the server, per resource.** Roles are per team; people outside a team can't even tell an item exists.
- **Complete history.** Every change records who did what, with before/after values. Nothing important disappears.
- **Reliable background work.** Notifications go through a transactional outbox with retries, backoff and dead-lettering. A broken notifier never affects the user's action.
- **Built to grow.** Cursor pagination, matching indexes, server-side search and filtering. The browser never loads the whole dataset.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js, Express 5 |
| Database | MongoDB Atlas (official driver, multi-document transactions) |
| Frontend | Vanilla JavaScript single-page app, no build step |
| Live updates | Server-Sent Events |
| Tests | `node:test` |

## Architecture

```
Browser SPA ──REST/JSON──▶ Express ──▶ service.js ── policy.js (who may do what)
     ▲  └──SSE (change signals)──┘          │
     │                                      │ ONE transaction per command:
     │                                      │   work_items   (current state + version)
     │                                      │   item_events  (insert-only history)
     │                                      │   outbox       (pending side effects)
     └──────────────────────── outbox worker ──▶ notifications (idempotent)
```

**Collections:** `users`, `teams`, `memberships`, `work_items`, `item_events`, `idempotency` (24 h TTL), `outbox`, `notifications`. Indexes are created automatically on startup (`src/db.js`).

## Quick start

**Requirements:** Node.js 20.12+ and a MongoDB Atlas cluster (the free M0 tier works).

1. **Atlas setup:** create a cluster, add a database user, allow your IP under *Network Access*, and copy the connection string (*Connect → Drivers*).
2. **Configure and run:**
```bash
   cp .env.example .env      # paste your MONGODB_URI and set TOKEN_SECRET
   npm install
   npm run seed              # 7 users, 4 teams, 300 items (npm run seed -- 50000 for a scale demo)
   npm start                 # http://localhost:3000
```
3. **Tests:**
```bash
   npm test                  # uses MONGODB_URI, or an in-memory replica set if it is not set
```
   Each test uses a throw-away database (`opsboard_test_*`) that is dropped afterwards, so your demo data is never touched.

| Variable | Purpose | Default |
|---|---|---|
| `MONGODB_URI` | Atlas connection string (**required**) | – |
| `DB_NAME` | Database name | `opsboard` |
| `TOKEN_SECRET` | Signs login tokens (**set a long random value**) | dev-only fallback |
| `PORT` | HTTP port | `3000` |
| `DNS_SERVERS` | Optional, e.g. `8.8.8.8,1.1.1.1` if your network can't resolve `mongodb+srv://` | – |

### Troubleshooting
- **`querySrv ECONNREFUSED`:** your machine's DNS can't resolve Atlas SRV records. Set `DNS_SERVERS=8.8.8.8,1.1.1.1` in `.env`, or use the standard `mongodb://` connection string from Atlas.
- **Timeout or authentication failure:** check your IP is in Atlas *Network Access*, and URL-encode special characters in the password.

## Demo accounts

Click a name on the sign-in page (every password is `password`):

| User | Access |
|---|---|
| Alice | Admin in all 4 teams |
| Bob | Manager in Support, Engineering |
| Carol | Member in Support, Compliance |
| Dave | Member in Engineering |
| Erin | Member in Payments |
| Frank | **Viewer** in Support, Engineering (read-only) |
| Gina | Member in Support, manager in Engineering, member in Payments |

Every user sees only items from teams they belong to. Within a team, everyone can see who owns what.

## Try the interesting behaviours (2 minutes)

Use two browser windows (one private) signed in as different users.

1. **Claim race:** as Carol and Dave, click *Take it* on the same unassigned item. One wins; the other sees "Too late" and the optimistic UI rolls back.
2. **Stale edit:** open the same item as Bob and Carol. Change the priority in one window, then try in the other. The second change is refused with a conflict message and the view refreshes.
3. **Approval gate:** as Carol, take an item marked "needs approval" and request approval. Bob sees it under *Needs attention*. Carol can't approve her own request; Bob approves; only then can Carol resolve the item.
4. **Permissions:** sign in as Frank. There are no action buttons, and the API refuses direct requests too.
5. **Isolation:** sign in as Erin (Payments only). Support and Engineering items are invisible.

## Features

- **Work items:** title, description, priority, due date, owner, status and an optional approval requirement.
- **Workflow:** `open → in_progress ⇄ blocked → resolved → closed`. Illegal jumps are refused, work can't progress without an owner, and an approval-gated item can't be resolved until a *different* manager approves it. Editing the title or description after approval voids the approval.
- **Overview:** *Needs attention* (overdue, unassigned critical/high, my blocked work, in-progress items with no activity for 3 days, approvals waiting on me), *My work*, *Unassigned*, *All*.
- **Find things fast:** filter by team, status and priority, sort by recency or priority, full-text search, "Load more" pagination.
- **Collaboration:** comments, reassignment, a full activity timeline, in-app notifications.
- **Live:** changes by other users appear without refreshing.

## Correctness: the situations that need more than CRUD

| Situation | How it is handled |
|---|---|
| Two users claim the same work | One conditional update (`assignee_id: null` in the filter). Exactly one succeeds; the loser gets 409 with the current state. |
| Edit from a stale view | Every edit carries the version the user saw; the write only applies if it still matches (compare-and-swap). Otherwise 409 with the current item. |
| Retried or double-submitted request | `Idempotency-Key` stored in the same transaction as the effect, with a unique index so even concurrent duplicates apply once. |
| Workflow and approval rules | Enforced in the service layer: legal transitions only, owner required, four-eyes approval. |
| Resource-level authorization | One pure function (`policy.js`) decides what's allowed; the server enforces it and the UI only reads it. |
| Optimistic UI vs server decision | Claiming updates the UI immediately, then reconciles with the server response and rolls back on conflict. |
| Reliable async processing | Transactional outbox: the job is saved with the change, leased by a worker, retried with backoff, dead-lettered after 5 attempts, and the handler is idempotent. |

## What happens when things fail

| Failure | Behaviour |
|---|---|
| Server crashes mid-action | The transaction means the change, its history entry and its background job are saved together or not at all. |
| Notification handler throws | The user's action already succeeded. The job retries with exponential backoff, then is parked as `dead` for inspection. |
| Worker crashes while processing | Its lease expires after 30 s and another worker picks the job up. |
| Same job runs twice | A unique index on (user, event) makes the second run a no-op. |
| User retries after a timeout | The idempotency key replays the original result instead of repeating the action. |
| Request is rejected after partial work | Nothing is persisted: no history entry, no version bump, no job (tested). |

## Data model and performance

- A work item is one document holding its current state. History lives in a separate insert-only collection because it grows without bound; embedding it would bloat every list read.
- **Keyset (cursor) pagination** on `(updated_at, _id)` and `(priority_rank, updated_at, _id)`, with matching compound indexes that start with the team, so deep pages cost about the same as the first.
- Queries are always scoped to the caller's teams; counts use one indexed aggregation; the browser only holds the pages it has loaded.

## API overview

All routes are under `/api` and use a Bearer token.

```
POST /auth/login                      GET  /me          GET /summary
GET  /items?view=&team_id=&status=&priority=&assignee=&q=&sort=&cursor=&limit=
POST /items                           GET  /items/:id?before=       PATCH /items/:id
POST /items/:id/claim | assign | transition | approval | comments
GET  /teams/:id/members               PUT  /teams/:id/members  (admin)
GET  /notifications                   POST /notifications/read      GET /stream  (SSE)
```

Mutations accept an `Idempotency-Key` header. Edits, transitions, assignments and approvals require the `version` last seen. Errors are `{ error, message }` with 400, 401, 403, 404, 409 or 422.

## Testing strategy

The tests target the behaviours that would be most dangerous if wrong (`test/critical.test.js`, 22 tests):

- **Concurrency:** simultaneous claims (2 and 5 users), simultaneous edits, stale edits.
- **Retries:** idempotent create, concurrent duplicate comments, failed requests not poisoning keys.
- **Authorization:** cross-team probing returns 404, the full role matrix, admin-only membership changes.
- **Workflow and approvals:** illegal transitions, four-eyes approval, approval voided by edits.
- **History and atomicity:** audit trail contents; a rejected request leaves no partial state.
- **Async processing:** notifications created once even when jobs run twice, retry and dead-letter, lease recovery, two workers racing.
- **Reads:** cursor pagination with no gaps or duplicates, team scoping, search, the attention view.

## Project structure

```
src/
  server.js     entry point (loads .env, starts API and worker)
  app.js        routes, auth, transactions, idempotency, live updates
  db.js         Atlas connection, indexes, id helpers
  service.js    all commands and queries
  policy.js     roles, workflow transitions, permission rules
  outbox.js     background worker and notification handler
  auth.js       password hashing and signed tokens
public/         the web app (index.html, app.js, style.css)
scripts/seed.js demo users, teams and items
test/           helpers and the critical-behaviour tests
```

## Documentation

- [ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md): the key decisions and trade-offs.
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): what is deliberately missing.

## If this grew, or with another week

- **Scale out:** run the worker as its own process, use shared pub/sub for live updates, and move search to Atlas Search for prefix and fuzzy matching.
- **Security:** token refresh and revocation, login rate limiting, SSO/MFA, short-lived tickets for the live-update stream, and an insert-only database role for the history collection.
- **Product:** email/Slack notifications, per-team SLAs with auto-escalation, a team admin screen, attachments, and browser-level tests.
