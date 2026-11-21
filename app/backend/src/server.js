import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { config } from './config.js';
import * as bookmarks from './bookmarks.js';
import * as bulk from './bulk.js';
import * as profile from './profile.js';
import { RequestError, serialize } from './util.js';
import { tagList } from './limits.js';
import { currentUser } from './identity.js';
import { authorizeUrl, connect, disconnect, exchangeCode, generation, NotConnectedError } from './oauth.js';
import { beginConnectionChange, cancelSync, ensureSnapshot, syncNow } from './sync.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const STATE_MS = 10 * 60 * 1000;
// The page loads only its own scripts, styles, fonts and API. No inline script, no third-party request.
// The one inline style is the colour of a domain tile (style attribute), so style attributes are allowed.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) throw new RequestError(413, 'The request is too large.');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestError(400, 'The request body is not valid JSON.');
  }
}

async function sendFile(res, file) {
  let data;
  try {
    data = await readFile(file);
  } catch (err) {
    // A missing file or a folder is a 404, not a server error.
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return sendJson(res, 404, { error: 'not found' });
    throw err;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(data);
}

async function staticFile(res, rel) {
  const file = normalize(join(config.frontendDir, rel));
  if (!file.startsWith(config.frontendDir + sep)) return sendJson(res, 404, { error: 'not found' });
  return sendFile(res, file);
}

// Start the Raindrop approval for the signed-in user.
function oauthStart(req, res, svc) {
  const userId = currentUser(req);
  if (!userId) return sendJson(res, 401, { error: 'Sign in first.' });
  const state = randomBytes(24).toString('hex');
  svc.states.set(state, { userId, at: Date.now(), gen: generation(svc, userId) });
  res.writeHead(302, { Location: authorizeUrl(state) });
  res.end();
}

// Raindrop sends the browser here after the approval.
async function oauthCallback(url, req, res, svc) {
  const failed = url.searchParams.get('error');
  if (failed) {
    res.writeHead(302, { Location: `/?oauth_error=${encodeURIComponent(failed)}` });
    return res.end();
  }
  const state = url.searchParams.get('state') ?? '';
  const entry = svc.states.get(state);
  svc.states.delete(state); // each approval can be used once
  if (!entry || Date.now() - entry.at > STATE_MS) return sendJson(res, 400, { error: 'Unknown or old approval. Try again.' });
  // The approval must finish as the user that started it. Admintools sends only the email,
  // so the check binds the user, not one browser session.
  if (currentUser(req) !== entry.userId) return sendJson(res, 403, { error: 'This approval belongs to another user.' });
  // A disconnect after the approval started cancels it, including during the code exchange.
  const changed = () => sendJson(res, 409, { error: 'The connection changed. Start the approval again.' });
  if (generation(svc, entry.userId) !== entry.gen) return changed();
  const code = url.searchParams.get('code');
  if (!code) return sendJson(res, 400, { error: 'Raindrop sent no code.' });

  const tokens = await exchangeCode(code);
  if (generation(svc, entry.userId) !== entry.gen) return changed();
  if (config.bookmarkStore) {
    // A new connection starts with an empty stored copy. Rows of an earlier connection (for example one that
    // Raindrop revoked) must not show for another Raindrop account. The delete and the new connection are
    // one queue turn, in this order. No other turn writes the copy in between, and a read cannot see the new
    // tokens while the old rows exist. The generation is checked again, because the turn can wait for a long time.
    const connected = await serialize(entry.userId, async () => {
      // No sync starts until the new tokens are saved: connect() changes the generation first.
      const end = beginConnectionChange(svc, entry.userId);
      try {
        if (generation(svc, entry.userId) !== entry.gen) return false;
        await svc.store.deleteBookmarkStore(entry.userId);
        // A disconnect can come during the delete. It does not use the queue. Connect only if nothing changed.
        if (generation(svc, entry.userId) !== entry.gen) return false;
        await connect(svc, entry.userId, tokens);
        bookmarks.forget(svc, entry.userId);
        return true;
      } finally {
        end();
      }
    });
    if (!connected) return changed();
  } else {
    await connect(svc, entry.userId, tokens);
    bookmarks.forget(svc, entry.userId);
  }
  res.writeHead(302, { Location: '/' });
  res.end();
}

async function goLink(path, req, res, svc) {
  const userId = currentUser(req);
  if (!userId) return sendJson(res, 401, { error: 'Sign in first.' });
  // The stored copy is made before the turn, never inside it (docs/bookmark-store-plan.md, section 3).
  if (await svc.store.getTokens(userId)) await ensureSnapshot(svc, userId);
  // Counts a visit, so it takes the user's queue: a visit cannot be written after delete-my-data.
  const link = await serialize(userId, () => bookmarks.go(svc, userId, path.slice('/go/'.length)));
  if (!link) return sendJson(res, 404, { error: 'bookmark not found' });
  res.writeHead(302, { Location: link });
  res.end();
}

async function api(method, path, url, req, res, svc) {
  const userId = currentUser(req);
  if (method === 'GET' && path === '/api/me') {
    // logoutUrl is null when no sign-out address is configured. version is the release id.
    const meta = { logoutUrl: config.adminLogoutUrl || null, version: config.version, lastChecked: null };
    if (!userId) return sendJson(res, 200, { user: null, connected: false, raindrop: null, ...meta });
    await svc.store.ensureUser(userId);
    let raindrop = null;
    if (await svc.store.getTokens(userId)) {
      try {
        raindrop = await bookmarks.account(svc, userId);
      } catch {
        raindrop = null; // an expired connection is removed by the check, so it is not reported
      }
    }
    // Read the status after the check. The check can remove an expired connection.
    const connected = Boolean(await svc.store.getTokens(userId));
    if (!connected) raindrop = null;
    // If the migration has not run yet, the column is missing. /api/me still answers, with null.
    const lastChecked = await svc.store.lastChecked(userId).catch(() => null);
    // With the stored copy: when the last full sync ended, and the error of the last try, if it failed.
    const sync = config.bookmarkStore && connected ? await svc.store.getSyncState(userId).catch(() => null) : null;
    // The two fields exist only with the stored copy, so the answer is the same as before when it is off.
    const syncFields = config.bookmarkStore ? { syncedAt: sync?.lastFullAt ?? null, syncError: sync?.lastError ?? null } : {};
    return sendJson(res, 200, { user: userId, connected, raindrop, ...meta, lastChecked, ...syncFields });
  }
  if (!userId) return sendJson(res, 401, { error: 'Sign in first.' });

  if (method === 'POST' && path === '/api/disconnect') {
    // disconnect() changes the connection generation first. A sync or a write that started before it
    // then finds the change and writes nothing. The rows go in a queue turn, after the writes in progress.
    await disconnect(svc, userId);
    bookmarks.forget(svc, userId);
    bulk.forgetJobs(svc, userId);
    cancelSync(svc, userId);
    if (config.bookmarkStore) await serialize(userId, () => svc.store.deleteBookmarkStore(userId));
    return sendJson(res, 200, { ok: true });
  }
  // Removes everything the app keeps about this user: the connection, the visits, the New and known
  // lists, the change log with bookmark titles, and the profile. The bookmarks themselves stay in Raindrop.
  // It takes the user's queue. Every write of the user's rows (job steps, saves, visits, checks) is in that
  // queue, so each one either finished before this starts or runs after it and finds nothing to write to.
  if (method === 'POST' && path === '/api/delete-data') {
    await serialize(userId, async () => {
      await disconnect(svc, userId);
      bookmarks.forget(svc, userId);
      bulk.forgetJobs(svc, userId);
      cancelSync(svc, userId);
      await svc.store.deleteUserData(userId);
    });
    return sendJson(res, 200, { ok: true });
  }
  // The profile holds no Raindrop data, so its routes work without a Raindrop connection (docs/profile-plan.md).
  if (method === 'GET' && path === '/api/profile') return sendJson(res, 200, await profile.view(svc, userId));
  if (method === 'POST' && path === '/api/profile/entry') {
    const input = await readJson(req);
    const entry = profile.parseEntry(input);
    // A new or changed tag is compared with the Raindrop tags. They are read here, before the queue turn,
    // because the read can start the first sync. The turn checks again that the entry did not change.
    let tags;
    if (entry.tag) {
      const stored = entry.id ? (await svc.store.profile(userId)).find((e) => e.id === entry.id) : null;
      if (profile.setsNewTag(entry, stored)) tags = await profile.raindropTags(svc, userId);
    }
    const saved = await serialize(userId, () => profile.save(svc, userId, entry, { tags, reuseTag: input?.reuseTag === true }));
    return sendJson(res, saved.tagExists ? 409 : 200, saved);
  }
  if (method === 'POST' && path === '/api/profile/entry/delete') {
    const id = profile.entryId((await readJson(req))?.id);
    return sendJson(res, 200, await serialize(userId, () => profile.remove(svc, userId, id)));
  }
  if (!(await svc.store.getTokens(userId))) {
    return sendJson(res, 409, { error: 'Connect Raindrop first.', connect: true });
  }

  // With the stored copy, the first request of a user makes the copy. It runs here, before any queue turn.
  // The progress route must not wait: the loading bar polls it while the first sync runs.
  // A sync request has its own step. Job status and cancel read the jobs in memory.
  const needsCopy = !(method === 'GET' && path === '/api/progress')
    && !(method === 'POST' && path === '/api/pull')
    && !path.startsWith('/api/bulk/');
  if (needsCopy) await ensureSnapshot(svc, userId);

  if (method === 'GET' && path === '/api/meta') {
    return sendJson(res, 200, await bookmarks.meta(svc, userId, url.searchParams.get('tz') ?? ''));
  }
  if (method === 'GET' && path === '/api/bookmarks') {
    return sendJson(res, 200, await bookmarks.search(svc, userId, Object.fromEntries(url.searchParams)));
  }
  if (method === 'GET' && path === '/api/progress') return sendJson(res, 200, bookmarks.progress(svc, userId));
  // The quick check reads only. It takes no queue turn.
  if (method === 'GET' && path === '/api/changes') return sendJson(res, 200, await bookmarks.changes(svc, userId));
  if (method === 'POST' && path === '/api/pull') {
    // With the stored copy, the full sync runs first, outside the queue. The check then reads the new copy
    // inside its turn. Without the copy, pull loads from Raindrop inside the turn, as before.
    if (config.bookmarkStore) await syncNow(svc, userId);
    // The check writes the user's rows, so it takes the user's queue (see delete-my-data).
    const result = await serialize(userId, async () => {
      const found = await bookmarks.pull(svc, userId);
      bookmarks.forgetChanges(svc, userId); // the next quick check compares with the new bookmarks
      // Written only after the check succeeds. A failed check keeps the earlier time.
      // A failed save of the time must not fail a check that worked. The check is still done.
      await svc.store.setLastChecked(userId, new Date().toISOString()).catch((err) => {
        console.error('Could not save the last check time:', err.message);
      });
      return found;
    });
    return sendJson(res, 200, result);
  }

  const body = method === 'POST' ? await readJson(req) : {};
  if (method === 'POST' && path === '/api/suggest') {
    return sendJson(res, 200, await bookmarks.suggest(svc, userId, Number(body.id)));
  }
  if (method === 'POST' && path === '/api/save') {
    // Saves share the queue with bulk jobs, so they cannot overwrite each other's tags.
    const saved = await serialize(userId, () => bookmarks.save(svc, userId, Number(body.id), Number(body.folderId), tagList(body.tags)));
    return sendJson(res, 200, saved);
  }
  if (method === 'POST' && path === '/api/folder') {
    // A turn of the user's queue, so the database write of the new folder cannot come after a disconnect.
    return sendJson(res, 200, await serialize(userId, () => bookmarks.createFolder(svc, userId, body.name ?? '')));
  }
  if (method === 'POST' && (path === '/api/duplicates/keep' || path === '/api/duplicates/unkeep')) {
    // "Keep all" on a duplicate group, and its Undo. A turn of the user's queue, like the other writes of the user's rows.
    const keep = path === '/api/duplicates/keep';
    return sendJson(res, 200, await serialize(userId, () => bookmarks.keepDuplicates(svc, userId, body.section, body.key, keep)));
  }
  if (method === 'POST' && path === '/api/bulk') {
    if (body.action === 'apply' && body.from === undefined) throw new RequestError(400, 'Apply needs the review it came from.');
    return sendJson(res, 200, bulk.jobView(await bulk.startJob(svc, userId, body)));
  }
  const job = path.match(/^\/api\/bulk\/([0-9a-f-]{36})(\/cancel|\/undo)?$/);
  if (job && method === 'GET' && !job[2]) {
    const found = bulk.getJob(svc, userId, job[1]);
    return found ? sendJson(res, 200, bulk.jobView(found)) : sendJson(res, 404, { error: 'job not found' });
  }
  if (job && method === 'POST' && job[2] === '/cancel') {
    const found = bulk.cancelJob(svc, userId, job[1]);
    return found ? sendJson(res, 200, bulk.jobView(found)) : sendJson(res, 404, { error: 'job not found' });
  }
  if (job && method === 'POST' && job[2] === '/undo') {
    return sendJson(res, 200, bulk.jobView(await bulk.startUndo(svc, userId, job[1])));
  }
  return sendJson(res, 404, { error: 'not found' });
}

// Refuse writes that another site started. The browser marks these with Sec-Fetch-Site.
// Writes must also send JSON. A plain HTML form cannot send JSON, so it cannot write.
function writeAllowed(req) {
  if (req.method === 'GET') return true;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return String(req.headers['content-type'] ?? '').startsWith('application/json');
}

// The check has a deadline. A full pool or a stalled database gives 503, not a hang.
const HEALTH_MS = 2000;
async function healthz(res, svc) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), HEALTH_MS);
  });
  try {
    await Promise.race([svc.store.ping(), deadline]);
    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 503, { ok: false });
  } finally {
    clearTimeout(timer);
  }
}

async function route(req, res, svc) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;

  // Health check for the deploy script. It needs no session. It reports only up or down.
  if (method === 'GET' && path === '/healthz') return healthz(res, svc);

  if (path.startsWith('/api/') && !writeAllowed(req)) {
    return sendJson(res, 403, { error: 'This request must come from this app and send JSON.' });
  }

  if (method === 'GET' && path === '/') return sendFile(res, join(config.frontendDir, 'index.html'));
  if (method === 'GET' && path.startsWith('/static/')) return staticFile(res, path.slice('/static/'.length));
  if (method === 'GET' && path === '/oauth/start') return oauthStart(req, res, svc);
  if (method === 'GET' && path === '/oauth/callback') return oauthCallback(url, req, res, svc);
  if (method === 'GET' && path.startsWith('/go/')) return goLink(path, req, res, svc);
  if (path.startsWith('/api/')) return api(method, path, url, req, res, svc);
  return sendJson(res, 404, { error: 'not found' });
}

// Build the HTTP server. Errors become JSON. A missing Raindrop connection gives 409.
// An unexpected error gives a generic 500 with a reference. The full error goes to the server log
// with the same reference, so the log entry can be found from the message in the browser.
// Raindrop revoked the authorization of a user (oauth.js calls this after it deleted the tokens). It works like a
// disconnect (plan, decision D8). It does not wait. The row delete takes a queue turn and checks the tokens again,
// because the user can connect again before the turn runs.
function onRevoked(svc, userId) {
  if (!config.bookmarkStore) return;
  bookmarks.forget(svc, userId);
  bulk.forgetJobs(svc, userId);
  cancelSync(svc, userId);
  serialize(userId, async () => {
    if (await svc.store.getTokens(userId)) return;
    await svc.store.deleteBookmarkStore(userId);
  }).catch((err) => console.error(`Could not delete the stored copy of ${userId} after a revoke:`, err.message));
}

export function createApp(svc) {
  svc.onRevoked ??= (userId) => onRevoked(svc, userId);
  return createServer(async (req, res) => {
    // No other site may show the app in a frame (#73). writeHead keeps these headers on every response.
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    try {
      await route(req, res, svc);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof RequestError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof NotConnectedError) return sendJson(res, 409, { error: err.message, connect: true });
      const ref = randomBytes(4).toString('hex');
      console.error(`[${ref}] ${req.method} ${req.url}:`, err);
      sendJson(res, 500, { error: `Something went wrong. Reference: ${ref}.` });
    }
  });
}
