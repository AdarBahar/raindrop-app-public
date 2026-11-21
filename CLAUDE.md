# raindrop-app

Two tools for Raindrop.io bookmarks: the web app in `app/` (Node.js backend, plain HTML/CSS/JS frontend) and the sync script `sync.py`.

- UI specification: `docs/ui-elements.md`. The frontend and the backend follow it.
- Design samples: `docs/ui-samples/`. Sample A (`a-ledger.html`) is the chosen design.
- Tests: `cd app/backend && npm test`. Some tests read the frontend files as text. The database tests need `TEST_DATABASE_URL` (role `raindrop_app`) and `TEST_DATABASE_ADMIN_URL` (a role that can create a schema). Without them, these tests skip, and the run shows fewer tests.
- Stored copy of the bookmarks: `docs/bookmark-store-plan.md` (status, rules, runbook). The flag `BOOKMARK_STORE` is off by default. Do not turn it on in production before decision D6 is resolved.
- Queue rule for the stored copy: code inside a `serialize(userId, …)` turn never calls `serialize` for the same user (the call fails at once) and never calls `syncNow`. Store functions take no queue. Routes call `ensureSnapshot` before they take a turn.

Project orientation note (Obsidian vault): `Projects/Dev/raindrop-app/raindrop-app.md`
