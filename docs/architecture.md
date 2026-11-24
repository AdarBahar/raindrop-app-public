# Architecture

This text moved here from the root `README.md`. It lists the modules of the web app and the rules of its data.

## Structure

- `app/backend/`: Node.js server. It has one npm package, `pg`.
  - `server.js`: the routes, the security headers and the OAuth flow. `index.js` starts the server and the sync timer.
  - Bookmarks: `bookmarks.js` holds the changes (pull, quick check, suggest, save, new folder). `library.js` loads the bookmarks and keeps the cache. `listing.js` holds search, filters and meta. Its `parseFilter()` checks the filter input for search and for bulk jobs. Other code imports from `bookmarks.js`.
  - Bulk jobs: `bulk.js` starts the jobs and runs the move, tag and apply changes. `bulk-jobs.js` (job list), `bulk-input.js` (input checks), `bulk-state.js`, `bulk-suggest.js` and `bulk-undo.js` hold the parts. Other code imports from `bulk.js`.
  - Stored copy: `sync.js` (full sync), `effects.js` (the changes that the copy applies), `sync-timer.js` (the timer), `store-bookmarks.js` (the tables of the copy).
  - Other: `store.js` (users, tokens, visits, log), `raindrop.js` and `raindrop-fetch.js` (Raindrop API), `oauth.js`, `llm.js`, `dupes.js`, `limits.js`, `config.js`, `util.js`.
- `app/frontend/`: HTML, CSS and JavaScript. The backend serves these files. `index.html` and `styles.css` are the page. The page script is in nine parts that share one global scope, loaded in this order: `core.js` (state, helpers, API client), `filters.js`, `list.js`, `bulk.js`, `review.js`, `bulk-drawer.js`, `keys.js`, `context.js` (the "My context" view), `app.js` (start-up). A new part must go into `index.html` and into `deploy/build-release.sh`. `datetime.js` and `rules.js` hold small helpers that the tests load too.
- `docs/`: the UI specification, the design samples and the deployment plan (see "Documentation" in the root `README.md`).

## Design

The design is dark first. It follows the system setting for light. On phones the sidebar becomes a filter sheet. The app serves the IBM Plex fonts itself (`app/frontend/fonts`). The page makes no request to another site.

## Data and security rules

- The data is in the PostgreSQL database `raindrop`. It holds per-user settings, visits, New labels and a log of saved changes. The log keeps bookmark titles for 90 days. For a save that changes a note, it also keeps the note before and after the change. With `BOOKMARK_STORE=on`, it also holds the stored copy of the bookmarks and folders (titles, notes and links), and the nightly backups hold it too.
- The runtime role `raindrop_app` reads and writes rows only. It cannot create or change tables.
- Raindrop tokens are stored encrypted with AES-256-GCM.
- The encryption key is in `app/backend/data/.key`. The file has mode 600. Keep a backup of this file, separate from the database.
- The app runs as one process. Its rate limits and bulk jobs are in memory. With `BOOKMARK_STORE=off`, the bookmark cache is in memory too and lasts 5 minutes.
- "Delete my data" and "Disconnect Raindrop" remove the stored copy. A new Raindrop connection starts with an empty copy.
- Admintools signs people in. It sends the signed-in email in the `X-Admintools-Email` header. The app reads no other sign-in data. The app listens on `127.0.0.1` only, so only the reverse proxy can send this header. The gateway must remove any `X-Admintools-*` header that a client sends. Run `admintools verify` after each change, and check the `forged` result.
- `GET /healthz` returns `{"ok": true}` with HTTP 200 when the database answers. It returns HTTP 503 otherwise. The check gives up after 2 seconds, so a full pool or a stalled database cannot hang it. It needs no sign-in.
- Writes to `/api/` must send JSON and must not come from another site. The app refuses other writes with HTTP 403.
