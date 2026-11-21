import { AsyncLocalStorage } from 'node:async_hooks';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reserve the next free time slot for a key. Calls with the same key stay minMs apart.
const nextSlot = new Map();
export async function pace(key, minMs) {
  const now = Date.now();
  const slot = Math.max(now, (nextSlot.get(key) ?? 0) + minMs);
  nextSlot.set(key, slot);
  if (slot > now) await sleep(slot - now);
}

// Like pace(), but callers take turns. Each caller (for example a user) waits in its own line,
// and the lines are served one after another. All calls with the same key stay minMs apart,
// so one caller with many waiting calls cannot hold up the others.
const turns = new Map();
export function takeTurn(key, who, minMs) {
  let line = turns.get(key);
  if (!line) {
    line = { waiting: new Map(), last: 0, timer: null };
    turns.set(key, line);
  }
  return new Promise((resolve) => {
    const queue = line.waiting.get(who);
    if (queue) queue.push(resolve);
    else line.waiting.set(who, [resolve]);
    serveNext(line, minMs);
  });
}

function serveNext(line, minMs) {
  if (line.timer || line.waiting.size === 0) return;
  line.timer = setTimeout(() => {
    line.timer = null;
    // The first line in the map is served, then moves to the end if it still has calls waiting.
    const [who, queue] = line.waiting.entries().next().value;
    line.waiting.delete(who);
    const resolve = queue.shift();
    if (queue.length) line.waiting.set(who, queue);
    line.last = Date.now();
    resolve();
    serveNext(line, minMs);
  }, Math.max(0, line.last + minMs - Date.now()));
}

export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Trim tags and drop duplicates. The first spelling wins.
export function cleanTags(tags) {
  const seen = new Set();
  const out = [];
  for (const raw of tags ?? []) {
    const tag = String(raw).trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

// Run async work one at a time for each key. A later call waits for the earlier ones.
//
// The queue is not reentrant. Code that runs inside a turn must not call serialize() with the
// same key: the new call would wait for the turn that waits for it, and neither would end.
// The turns store holds the keys of the turns that the current async code runs in. A nested call
// with the same key fails at once with an error. A call with another key is allowed.
// Work that starts inside a turn and runs after it keeps the keys of that turn. It must not call
// serialize() with the same key either. Start such work outside the turn.
const queues = new Map();
const heldKeys = new AsyncLocalStorage();
export function serialize(key, fn) {
  if (heldKeys.getStore()?.has(key)) {
    return Promise.reject(new Error(`serialize(${key}) was called inside a turn of the same key. It would wait for itself.`));
  }
  const held = new Set([...(heldKeys.getStore() ?? []), key]);
  const run = (queues.get(key) ?? Promise.resolve()).then(() => heldKeys.run(held, fn));
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// Run fn outside of every queue turn of the current async code. Work that fn starts keeps no turn keys,
// so it can call serialize() for a key that the caller holds. It then waits for the turn of the caller to end.
// Do not await the result inside the turn of the same key. The turn would wait for itself.
export function outsideTurns(fn) {
  return heldKeys.exit(fn);
}

// An error with the HTTP status to return. Other errors become 500.
export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The title of a bookmark as the logs and the job rows keep it: at most 80 characters, never null.
export function titleOf(item) {
  return (item.title ?? '').slice(0, 80);
}

// True when both lists hold the same tags, ignoring case.
export function sameTagSet(a, b) {
  const lower = (list) => new Set((list ?? []).map((t) => String(t).toLowerCase()));
  const x = lower(a);
  const y = lower(b);
  return x.size === y.size && [...x].every((t) => y.has(t));
}
