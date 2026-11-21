import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { outsideTurns } from './util.js';

const DEFAULT_LIFETIME = 1209599; // seconds. The example value in the Raindrop docs.
const SAFETY_MARGIN = 300; // refresh five minutes before the token expires

export class NotConnectedError extends Error {}

// The page where the user approves the app.
export function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.raindrop.clientId,
    redirect_uri: config.raindrop.redirectUri,
    response_type: 'code',
    state,
  });
  return `${config.raindrop.oauthBase}/authorize?${params}`;
}

async function postToken(body) {
  const res = await fetch(`${config.raindrop.oauthBase}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      client_id: config.raindrop.clientId,
      client_secret: config.raindrop.clientSecret,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`token request failed with ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// The generation changes on every connect and disconnect of one user.
// A refresh that started earlier must not save its result after a change.
export function generation(svc, userId) {
  return svc.generations.get(userId) ?? 0;
}

function bump(svc, userId) {
  svc.generations.set(userId, generation(svc, userId) + 1);
  svc.refreshing.delete(userId);
}

// Run one step of token work for a user. Steps for the same user run one after another.
// A check of the generation and the write must not interleave with a disconnect.
const queues = new Map();
function locked(userId, step) {
  const run = (queues.get(userId) ?? Promise.resolve()).then(step);
  const tail = run.catch(() => {});
  queues.set(userId, tail);
  tail.then(() => {
    if (queues.get(userId) === tail) queues.delete(userId);
  });
  return run;
}

async function saveTokens(svc, userId, tokens, fallbackRefresh = null) {
  const refresh = tokens.refresh_token ?? fallbackRefresh;
  if (!tokens.access_token || !refresh) throw new Error('Raindrop did not return usable tokens.');
  const lifetime = (tokens.expires_in ?? DEFAULT_LIFETIME) - SAFETY_MARGIN;
  await svc.store.ensureUser(userId);
  await svc.store.saveTokens(
    userId,
    encrypt(tokens.access_token, svc.key),
    encrypt(refresh, svc.key),
    Date.now() + lifetime * 1000,
  );
}

// Store the tokens of a new connection. Refreshes of the old connection stop applying.
export function connect(svc, userId, tokens) {
  bump(svc, userId); // at once, so refreshes of the old connection stop now
  return locked(userId, () => saveTokens(svc, userId, tokens));
}

// Remove the connection of one user. Refreshes in progress are discarded.
export function disconnect(svc, userId) {
  bump(svc, userId); // at once, so refreshes in progress stop now
  return locked(userId, () => svc.store.deleteTokens(userId));
}

// Trade the code from the callback for tokens.
export function exchangeCode(code) {
  return postToken({ grant_type: 'authorization_code', code, redirect_uri: config.raindrop.redirectUri });
}

// Return a valid access token for one user. Refresh it when it is old or when forced.
export async function getAccessToken(svc, userId, { force = false } = {}) {
  // Read the generation before the first await. A disconnect during the read must count.
  const gen = generation(svc, userId);
  const row = await svc.store.getTokens(userId);
  if (!row) throw new NotConnectedError('Connect Raindrop first.');
  if (!force && row.expires_at > Date.now()) return decrypt(row.access_enc, svc.key);
  if (svc.refreshing.has(userId)) return svc.refreshing.get(userId);

  const refresh = decrypt(row.refresh_enc, svc.key);
  const job = (async () => {
    try {
      const tokens = await postToken({ grant_type: 'refresh_token', refresh_token: refresh });
      await locked(userId, async () => {
        if (generation(svc, userId) !== gen) {
          throw new NotConnectedError('The Raindrop connection changed. Try again.');
        }
        await saveTokens(svc, userId, tokens, refresh);
      });
      return tokens.access_token;
    } catch (err) {
      if (err instanceof NotConnectedError) throw err;
      if (err.status === 400 || err.status === 401) {
        let revoked = false;
        await locked(userId, async () => {
          if (generation(svc, userId) === gen) {
            bump(svc, userId);
            await svc.store.deleteTokens(userId);
            revoked = true;
          }
        });
        // Raindrop revoked the authorization. This is a disconnect (plan, decision D8). The caller can be inside
        // a queue turn of the user, so the cleanup starts outside every turn and nobody waits for it here.
        if (revoked) {
          try {
            outsideTurns(() => svc.onRevoked?.(userId));
          } catch (inner) {
            console.error(`The cleanup after a revoke failed for ${userId}:`, inner.message); // the caller still gets NotConnectedError
          }
        }
        throw new NotConnectedError('The Raindrop connection expired. Connect again.');
      }
      throw err;
    } finally {
      if (svc.refreshing.get(userId) === job) svc.refreshing.delete(userId);
    }
  })();
  svc.refreshing.set(userId, job);
  return job;
}
