// The profile of a user: projects, interests, and one text about the user. See docs/profile-plan.md.
// The user owns it. Nothing here writes an entry without a request of the user.
import { config } from './config.js';
import { loadAll } from './library.js';
import { checkTagFormat } from './limits.js';
import { ensureSnapshot } from './sync.js';
import { RequestError } from './util.js';

const { limits } = config;
const KINDS = ['about', 'project', 'interest'];
const ENTRY_ID = /^[1-9][0-9]{0,17}$/; // a BIGINT as decimal text
const LONGEST_ID = '9'.repeat(18); // a new entry has no ID yet. The budget counts the longest one.
const same = (a, b) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

// The ID of an entry, as the browser sends it: decimal text. It is never made a number.
export function entryId(value) {
  if (typeof value !== 'string' || !ENTRY_ID.test(value)) throw new RequestError(400, 'The entry ID is not valid.');
  return value;
}

// Check the entry that the browser sends. Returns { id, kind, name, description, tag, active }.
// id is null for a new entry. tag is null for an entry that is context only.
export function parseEntry(body) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  const kind = body?.kind;
  if (!KINDS.includes(kind)) throw new RequestError(400, 'The kind must be about, project or interest.');
  const about = kind === 'about';
  const name = about ? '' : text(body.name);
  if (!about && !name) throw new RequestError(400, 'The name is empty.');
  if (name.length > limits.profileName) {
    throw new RequestError(400, `The name can have at most ${limits.profileName} characters.`);
  }
  const description = text(body.description);
  if (!description) throw new RequestError(400, 'The description is empty.');
  const most = about ? limits.profileAbout : limits.profileDescription;
  if (description.length > most) throw new RequestError(400, `The description can have at most ${most} characters.`);
  // A tag of spaces only is refused. No tag at all (null or missing) means context only.
  let tag = null;
  if (body.tag !== undefined && body.tag !== null) {
    if (typeof body.tag !== 'string') throw new RequestError(400, 'The tag must be text.');
    tag = body.tag.trim();
    if (!tag) throw new RequestError(400, 'The tag is empty.');
    if (about) throw new RequestError(400, 'The text about you cannot have a tag.');
    checkTagFormat([tag]);
  }
  if (body.active !== undefined && typeof body.active !== 'boolean') throw new RequestError(400, 'active must be true or false.');
  const id = body.id === undefined || body.id === null ? null : entryId(body.id);
  return { id, kind, name, description, tag, active: body.active ?? true };
}

// The key of an entry in the prompt and in the reply of the model. A model cannot write it as a number.
export const promptKey = (id) => `p${id}`;

// The profile block for the prompt: the active entries only. Null when no entry is active.
export function blockOf(entries) {
  const active = entries.filter((e) => e.active);
  if (active.length === 0) return null;
  return {
    about: active.find((e) => e.kind === 'about')?.description ?? '',
    entries: active.filter((e) => e.kind !== 'about').map((e) => ({ id: promptKey(e.id), name: e.name, description: e.description, tag: e.tag })),
  };
}

// The characters of the JSON text that goes to the model, with its keys and punctuation.
export function budgetUsed(entries) {
  const block = blockOf(entries);
  return block ? JSON.stringify(block).length : 0;
}

// The profile as one suggestion request or one suggest job uses it. Read it one time, at the start.
// block: the JSON for the prompt, or null when no entry is active. byKey: prompt key to active entry.
// reserved: the tags of all entries, active or not, in lower case. Null when the user has no entry.
export async function contextFor(svc, userId) {
  const entries = await svc.store.profile(userId);
  if (entries.length === 0) return null;
  return {
    block: blockOf(entries),
    byKey: new Map(entries.filter((e) => e.active && e.kind !== 'about').map((e) => [promptKey(e.id), e])),
    reserved: new Set(entries.filter((e) => e.tag).map((e) => e.tag.toLowerCase())),
  };
}

// What the "My context" view shows.
export async function view(svc, userId) {
  const entries = await svc.store.profile(userId);
  return {
    entries,
    budget: { used: budgetUsed(entries), max: limits.profileBudget },
    limits: { entries: limits.profileEntries, name: limits.profileName, description: limits.profileDescription, about: limits.profileAbout, tag: limits.tagLength },
  };
}

// All Raindrop tags of the user, in lower case. Null when Raindrop is not connected: there is nothing to read.
// It can start the first sync, so call it before the queue turn, never inside it.
// Tags that cannot be read are never treated as "no tags": the caller gets an error.
export async function raindropTags(svc, userId) {
  if (!(await svc.store.getTokens(userId))) return null;
  try {
    await ensureSnapshot(svc, userId);
    const c = await loadAll(svc, userId);
    return new Set(c.items.flatMap((item) => item.tags ?? []).map((t) => t.toLowerCase()));
  } catch {
    throw new RequestError(503, 'The tag cannot be checked now. Try again in a moment.');
  }
}

// True when a save of `entry` sets a tag that the stored entry does not have. Letter case is ignored.
export function setsNewTag(entry, stored) {
  return Boolean(entry.tag) && !same(entry.tag, stored?.tag);
}

// Save one entry. Call it inside the queue turn of the user.
// tags: the result of raindropTags(), or undefined when the caller did not read the tags.
// Returns { entry }, or { tagExists: true, error } when the tag is a Raindrop tag and the user did not confirm.
export async function save(svc, userId, entry, { tags, reuseTag = false } = {}) {
  await svc.store.ensureUser(userId);
  const current = await svc.store.profile(userId);
  const stored = entry.id ? current.find((e) => e.id === entry.id) : null;
  if (entry.id && !stored) throw new RequestError(404, 'Entry not found.');
  if (!stored && current.length >= limits.profileEntries) {
    throw new RequestError(400, `A profile can have at most ${limits.profileEntries} entries.`);
  }
  if (setsNewTag(entry, stored)) {
    // The entry changed between the read of the tags and this turn. The tags were not read for this tag.
    if (tags === undefined) throw new RequestError(409, 'The profile changed. Try again.');
    if (tags?.has(entry.tag.toLowerCase()) && !reuseTag) {
      return { tagExists: true, error: `The tag "${entry.tag}" is already a tag in Raindrop. Use a different tag, or confirm that this entry uses the same tag.` };
    }
  }
  const next = stored ? current.map((e) => (e.id === stored.id ? { ...e, ...entry } : e)) : [...current, { ...entry, id: LONGEST_ID }];
  if (budgetUsed(next) > limits.profileBudget) {
    throw new RequestError(400, `The active entries are too long for the model: at most ${limits.profileBudget} characters together. Make an entry shorter or inactive.`);
  }
  try {
    const saved = await svc.store.saveEntry(userId, entry);
    if (!saved) throw new RequestError(404, 'Entry not found.');
    return { entry: saved };
  } catch (err) {
    // The unique indexes of migrations/005_profile.sql.
    if (err.code === '23505' && err.constraint === 'profile_entries_tag') throw new RequestError(400, 'Another entry already has this tag.');
    if (err.code === '23505' && err.constraint === 'profile_entries_one_about') throw new RequestError(400, 'The profile already has a text about you.');
    throw err;
  }
}

// Delete one entry. Call it inside the queue turn of the user.
export async function remove(svc, userId, id) {
  if (!(await svc.store.deleteEntry(userId, id))) throw new RequestError(404, 'Entry not found.');
  return { ok: true };
}
