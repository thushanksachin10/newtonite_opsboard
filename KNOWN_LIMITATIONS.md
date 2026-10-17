# Known limitations

- **Single app process.** SSE fan-out and the outbox worker run inside the API process. Several API instances would need shared pub/sub (e.g. Redis or Mongo change streams) for SSE, and the worker as its own process (the lease logic already supports several workers).
- **Auth is demo-grade.** scrypt passwords and stateless HMAC tokens: no refresh, revocation, lockout/rate limiting, SSO or MFA. The SSE stream takes the token in the query string (EventSource cannot set headers); it should become a short-lived stream ticket. Set `TOKEN_SECRET`.
- **No user/team management UI.** Memberships are seeded or set via `PUT /api/teams/:id/members` (admin only). No self-registration.
- **History immutability is enforced by the application**, not by the database. Restrict the app's Atlas user to `find`/`insert` on `item_events` for real enforcement.
- **Notifications** are in-app only: no email/Slack sender, preferences, mentions or watchers.
- **Pagination under mutation.** Lists sort by `updated_at`, so an item edited while you page can move and be repeated or skipped until refresh (an SSE banner prompts a refresh).
- **Text search** uses a `$text` index: whole-word, stemmed, no prefix or typo tolerance, title/description only. Atlas Search would be the upgrade.
- **"Stale" rule** uses a fixed 3-day threshold; no per-team SLAs or auto-escalation.
- **Housekeeping.** Finished/dead outbox documents are never pruned; dead jobs have no admin UI.
- **Frontend** is deliberately plain: no offline mode, no browser-level automated tests, light accessibility work. The tests target the backend, where incorrect behaviour is most dangerous.
- No deletion of items (closing instead); members cannot reopen closed items.
