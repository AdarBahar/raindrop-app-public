import { config } from './config.js';
import { getAccessToken } from './oauth.js';
import { pace, sleep } from './util.js';

// A request that gives the same result when it runs twice. A GET reads. A PUT sets the full state.
// A POST creates something, so a repeat after a server error can create it twice.
function repeatable(method) {
  return method === 'GET' || method === 'PUT';
}

const DEFAULT_WAIT_MS = 10000;
const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 60000;

// The wait before a retry, in milliseconds. Retry-After is used when it is present.
// A 429 from Raindrop sends X-RateLimit-Reset instead: the end of the rate window, in UTC epoch seconds.
// The wait until that time is limited to one minute. Without both headers, the wait is ten seconds.
export function retryWait(headers, now = Date.now()) {
  const after = headers.get('retry-after');
  if (after !== null && Number.isFinite(Number(after))) return Math.max(0, Number(after)) * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (reset > 0) return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, reset * 1000 - now));
  return DEFAULT_WAIT_MS;
}

// One Raindrop API call made as one user. Retries rate limits for all methods.
// Retries server errors only for repeatable methods, because the server may have run the request.
export async function raindropCall(svc, userId, method, path, body, attempt = 0) {
  await pace(`raindrop:${userId}`, config.raindrop.minIntervalMs);
  const token = await getAccessToken(svc, userId);
  const res = await fetch(config.raindrop.apiBase + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  // The access token may be revoked early. Refresh it once and try again.
  if (res.status === 401 && attempt === 0) {
    await getAccessToken(svc, userId, { force: true });
    return raindropCall(svc, userId, method, path, body, 1);
  }
  const retry = res.status === 429 || (res.status >= 500 && repeatable(method));
  if (retry && attempt < 4) {
    await sleep(retryWait(res.headers));
    return raindropCall(svc, userId, method, path, body, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
