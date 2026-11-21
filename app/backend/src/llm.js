import { config } from './config.js';
import { checkTagFormat } from './limits.js';
import { sleep, takeTurn } from './util.js';
import { addHebrewTag } from './rules.js';

// A reply that cannot be read. classifyV2() retries only on this error.
export class ReplyError extends Error {}

// Send one chat request to the OpenAI-compatible endpoint. Return the reply text.
// `who` is the user the call is made for. Users take turns for the shared endpoint.
// `onUsage` gets the token use that the endpoint reports, when it reports one. The evaluation script uses it.
// A timeout or an abort. These are not retried.
function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// Release the body of an answer that is not used, so the connection is free again.
async function releaseBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // The body is already closed or broken. Nothing to release.
  }
}

// The pause before the next try of a failed request. It grows with each try. The tests set it to zero.
function retryWait(attempt) {
  return (config.llm.retryWaitMs ?? 2000) * (attempt + 1);
}

export async function chat(messages, { model, maxTokens = 1500, who = '', onUsage = null } = {}) {
  const { endpoint, token } = config.llm;
  if (!endpoint || !token) throw new Error('API_Endpoint or token is missing in the env file');
  const body = {
    model: model || config.llm.model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.1,
    chat_template_kwargs: { enable_thinking: false },
  };
  let data = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await takeTurn('llm', who, config.llm.minIntervalMs);
    let res;
    try {
      res = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
    } catch (err) {
      // A timeout is not retried: each try can take 180 seconds. A connection failure is retried.
      if (isTimeout(err) || attempt === 3) throw err;
      await sleep(retryWait(attempt));
      continue;
    }
    // The status is checked before the body is read. A retried answer leaves its body unread.
    if (res.status === 429) {
      await releaseBody(res);
      await sleep(15000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await releaseBody(res);
      await sleep(retryWait(attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM request failed with ${res.status}: ${text.slice(0, 300)}`);
    }
    // A connection that drops while the body of a successful answer is read is retried.
    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (isTimeout(err) || attempt === 3) throw err;
      await sleep(retryWait(attempt));
      continue;
    }
    data = JSON.parse(text);
    break;
  }
  if (!data) throw new Error('LLM request failed after retries');

  if (onUsage && data.usage) onUsage(data.usage);
  const choice = data.choices[0];
  const text = (choice.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new Error(`empty reply (finish_reason=${choice.finish_reason})`);
  return text;
}

// The text from the first "[" to the last "]": the JSON array in a reply that can have other text around it.
function arrayText(text) {
  return text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
}

// Run fn() up to `attempts` times. Retry only when the reply cannot be read (ReplyError).
async function withReplyRetry(attempts, fn) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ReplyError)) throw err;
      lastError = err;
    }
  }
  throw new Error(`could not read the model reply: ${lastError.message}`);
}

// ---- Suggestions, contract v2 (docs/ui-elements.md, sections 5.4 and 5.6) ----
// The batch suggestion and the single-bookmark suggestion use this prompt. The single one sends a batch of one.
// The model may propose a folder or tags. A proposed folder stays a proposal until the user chooses it.
// A proposed new tag is selected in the review at first. The user can remove it before apply.
const V2_SYSTEM = `You are a bookmark organization assistant.

Your task is to recommend the best folder and tags for each bookmark, based only on the information provided.

FOLDER RULES
1. Prefer an existing folder when it clearly matches the bookmark's primary topic.
2. If no existing folder fits, propose a new folder only when it represents a useful, reusable category for multiple bookmarks.
3. Prefer broad, stable folder categories over highly specific ones.
4. Use "Misc" for a known topic that does not justify a dedicated folder.
5. If the bookmark's topic cannot be reliably determined, set folder.action to "none" and status to "needs_review".
6. Never invent information about a bookmark.

TAG RULES
1. Recommend 1 to 4 relevant tags in total, excluding existing bookmark tags already present.
2. Prefer existing tags when they accurately describe the bookmark.
3. Suggest new tags when they add useful specificity or cover topics missing from the vocabulary.
4. Prefer concise topic, technology, product, or purpose tags.
5. Avoid generic tags such as "interesting", "website", or "article".
6. Do not repeat tags, including case-insensitive duplicates.
7. Do not suggest tags that are unsupported by the available information.
8. Preserve the spelling of reused tags.

STATUS, SUBJECT, AND DOCS TAGS
9. Never suggest a status word as a tag. "to watch" is a status, not a topic. File the bookmark by its topic. Video links are handled by the app, not by you.
10. For a bookmark about images, use one subject tag: "photography" for camera work, "image-prompts" for AI image prompts, or "image-editing" for editing images. Never suggest the tag "image".
11. Use the tag "docs" only for documentation of code, a product, or a process. An article about work, product, or management is not documentation.
12. Do not suggest "prompt", "video creation", or "video edit". Use "prompts" and "video" instead.

FOLDERS FOR LANGUAGE
13. Hebrew is a tag, never a folder. The app adds the tag "hebrew" to Hebrew titles. Do not propose a folder for the language.

UNCERTAINTY
- Base decisions on title, URL, note, and excerpt.
- Do not assume you have visited or read the URL.
- Do not infer the meaning of unknown acronyms.
- If the title is empty or is only a file name (for example "5f3dc51e.jpg (539×2034)"), use the URL's domain and path to determine the topic. A domain that names a known company, product, or service is enough for a decision.
- If the available information is insufficient, use status "needs_review" and do not guess.

OUTPUT
Return only a valid JSON array with exactly one object for each input bookmark.

Each object must have:
{
  "id": number,
  "folder": {
    "action": "existing" | "propose" | "none",
    "name": string | null
  },
  "tags": {
    "existing": string[],
    "new": string[]
  },
  "status": "ready" | "needs_review",
  "reason": string
}

Rules:
- Use only supplied bookmark IDs.
- For action "existing", name must match an allowed folder exactly.
- For action "propose", name must be a concise, reusable category not already represented.
- For action "none", name must be null and status must be "needs_review".
- Explain each decision in one short sentence.
- No Markdown, comments, or text outside the JSON array.`;

// ---- The profile in the prompt (docs/profile-plan.md, section 7.1) ----
// Without a profile, the system message is V2_SYSTEM, with no change. With a profile, three parts change:
// the tag limit, a new section, and one more field in the reply.
const TOPIC_LIMIT = '1. Recommend 1 to 4 relevant tags in total, excluding existing bookmark tags already present.';
const TOPIC_LIMIT_PROFILE =
  '1. Recommend 1 to 4 relevant topic tags, excluding existing bookmark tags already present. Profile tags are separate: at most 2 in addition (see PERSONAL CONTEXT).';
const PERSONAL_CONTEXT = `PERSONAL CONTEXT
The input has a "profile": a text about the user, and entries for the user's projects and interests. Each entry has an id, a name, a description, and a tag or null.
1. A topic tag says what the bookmark is about. A profile tag says that the bookmark belongs to one project or interest of the user. They are different decisions.
2. Propose a profile tag only when the bookmark is clearly about the subject of that entry. The same language, library, or framework is not enough. A shared common word is not enough. A general subject overlap is not enough. The name of a site, a product, or a service in a description is not enough: the bookmark must be about the work that the entry describes.
3. Use at most 2 entries for each bookmark. When in doubt, use none.
4. List the id of each entry that you used in "context", for example ["p17"]. Use [] when you used none.
5. The app adds the "tag" of each entry in "context" to the suggestion. Do not put the tag of an entry in tags.existing or in tags.new.
6. The profile does not change the folder rules.

`;
const OUTPUT_HEAD = 'OUTPUT\nReturn only a valid JSON array';
const STATUS_FIELD = '  "status": "ready" | "needs_review",';
function profileSystem() {
  const parts = [TOPIC_LIMIT, OUTPUT_HEAD, STATUS_FIELD];
  for (const part of parts) if (V2_SYSTEM.split(part).length !== 2) throw new Error('the system prompt does not have the expected text');
  return V2_SYSTEM
    .replace(TOPIC_LIMIT, TOPIC_LIMIT_PROFILE)
    .replace(OUTPUT_HEAD, PERSONAL_CONTEXT + OUTPUT_HEAD)
    .replace(STATUS_FIELD, `  "context": string[],\n${STATUS_FIELD}`);
}

// The most tokens of a reply. With a profile, an entry can have "context" and 2 more tags.
const MAX_TOKENS = 2000;
const MAX_TOKENS_PROFILE = 4000;
export const maxTokensV2 = (profile) => (profile?.block ? MAX_TOKENS_PROFILE : MAX_TOKENS);

// The prompt for one batch. Each bookmark also carries its current folder and tags.
// `batch` items: { id, title, url, note, excerpt, currentFolder, currentTags }.
// `profile`: the snapshot of profile.contextFor, or null. Without a block to send, the messages are the
// messages of a user with no profile, byte for byte.
export function buildMessagesV2(batch, folders, vocab, profile = null) {
  const bookmarks = batch.map((b) => ({
    id: b.id,
    title: b.title ?? '',
    url: b.url ?? '',
    note: (b.note ?? '').slice(0, 300),
    excerpt: (b.excerpt ?? '').slice(0, 300),
    currentFolder: b.currentFolder,
    currentTags: b.currentTags ?? [],
  }));
  if (!profile?.block) {
    return [
      { role: 'system', content: V2_SYSTEM },
      { role: 'user', content: JSON.stringify({ folders, knownTags: vocab, bookmarks }) },
    ];
  }
  // The model sees the tag of an entry only in the profile, not as a known tag.
  const knownTags = vocab.filter((t) => !profile.reserved.has(t.toLowerCase()));
  return [
    { role: 'system', content: profileSystem() },
    { role: 'user', content: JSON.stringify({ folders, knownTags, profile: profile.block, bookmarks }) },
  ];
}

// Read the v2 reply. Returns a Map of id to an entry. A reply that is not an array, or that lists
// a bookmark twice, is refused so the caller can retry. A bad entry becomes "needs_review" for its bookmark.
// Entries for ids that were not sent are ignored.
export function parseRepliesV2(text, ids, folders, vocab, profile = null) {
  let entries;
  try {
    entries = JSON.parse(arrayText(text));
  } catch {
    throw new ReplyError('the reply is not valid JSON');
  }
  if (!Array.isArray(entries)) throw new ReplyError('the reply is not a JSON array');
  const wanted = new Set(ids);
  const result = new Map();
  for (const entry of entries) {
    const id = Number(entry?.id);
    if (!entry || typeof entry !== 'object' || !wanted.has(id)) continue;
    if (result.has(id)) throw new ReplyError(`bookmark ${id} is listed twice`);
    result.set(id, normalizeEntry(entry, folders, vocab, profile));
  }
  return result;
}

// The folder decision, and the tags split into existing, new and profile tags. Returns the entry the app keeps.
// `profile`: the snapshot of profile.contextFor, or null. See docs/profile-plan.md, section 7.2, for the order of the tag checks.
function normalizeEntry(e, folders, vocab, profile) {
  const reason = (typeof e.reason === 'string' ? e.reason.trim() : '').slice(0, 300) || 'The model gave no reason.';
  const unsure = (why) => ({
    status: 'needs_review',
    folder: { action: 'none', name: null },
    existingTags: [],
    newTags: [],
    profileTags: [],
    reason: why ?? reason,
  });
  const f = e.folder && typeof e.folder === 'object' ? e.folder : {};
  const name = typeof f.name === 'string' ? f.name.trim() : '';
  let folder;
  if (f.action === 'existing') {
    const match = folders.find((x) => x === name);
    if (!match) return unsure('The model named a folder that does not exist.');
    folder = { action: 'existing', name: match };
  } else if (f.action === 'propose') {
    if (!name || name.length > config.limits.folderName) return unsure('The model proposed a folder without a usable name.');
    // A proposal that matches an existing folder, ignoring case, is an existing folder.
    const match = folders.find((x) => x.toLowerCase() === name.toLowerCase());
    folder = match ? { action: 'existing', name: match } : { action: 'propose', name };
  } else if (f.action === 'none') {
    folder = { action: 'none', name: null };
  } else {
    return unsure();
  }

  // 1. All tags of the two lists. A tag that apply would refuse (too long, or with a comma) is dropped: the
  //    review selects the new tags, so a bad tag would make the card fail in "Apply all". No duplicates.
  const distinct = [];
  for (const t of [...listOf(e.tags?.existing), ...listOf(e.tags?.new)]) {
    if (!validTag(t)) continue;
    if (!distinct.some((d) => d.toLowerCase() === t.toLowerCase())) distinct.push(t);
  }
  // 2. The entries that the model used: only a text that is exactly the key of an active entry. The first 2 stay.
  const used = [];
  if (profile && Array.isArray(e.context)) {
    for (const key of e.context) {
      if (typeof key === 'string' && profile.byKey.has(key) && !used.includes(key) && used.length < 2) used.push(key);
    }
  }
  // 3 to 5. Each used entry that has a tag gives its tag: the app takes the tag from the snapshot, and the model
  // does not have to repeat it. A reserved tag is the tag of an entry of the user, active or not. In the lists
  // of the model it is dropped, and it never becomes a topic tag. The first 4 other tags are the topic tags.
  const reserved = profile?.reserved ?? new Set();
  const profileTags = [];
  for (const key of used) {
    const entry = profile.byKey.get(key);
    if (entry.tag) profileTags.push({ tag: entry.tag, entryId: entry.id, entryName: entry.name });
  }
  const topic = [];
  for (const t of distinct) {
    if (!reserved.has(t.toLowerCase()) && topic.length < 4) topic.push(t);
  }
  // A topic tag that is in the known list keeps the list's spelling.
  const existingTags = [];
  const newTags = [];
  for (const t of topic) {
    const known = vocab.find((v) => v.toLowerCase() === t.toLowerCase());
    if (known) existingTags.push(known);
    else newTags.push(t);
  }
  // Only a bookmark with a folder can be ready. "none" always needs review.
  const status = e.status === 'ready' && folder.action !== 'none' ? 'ready' : 'needs_review';
  return { status, folder, existingTags, newTags, profileTags, reason };
}

// True when apply accepts the text of the tag.
function validTag(tag) {
  try {
    checkTagFormat([tag]);
    return true;
  } catch {
    return false;
  }
}

// The text strings of a list. Other values are ignored.
function listOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
}

// Ask the model for the v2 suggestions. Retry once when the reply cannot be read.
// `profile`: the snapshot of profile.contextFor for this user, or null.
export async function classifyV2(batch, folders, vocab, { model, attempts = 2, who, profile = null, onUsage = null } = {}) {
  const messages = buildMessagesV2(batch, folders, vocab, profile);
  const ids = batch.map((b) => b.id);
  return withReplyRetry(attempts, async () => {
    const replies = parseRepliesV2(await chat(messages, { model, maxTokens: maxTokensV2(profile), who, onUsage }), ids, folders, vocab, profile);
    // The code adds the rules that do not need the model (rules.js). Hebrew titles get the Hebrew tag.
    const out = new Map(replies);
    for (const b of batch) if (out.has(b.id)) out.set(b.id, addHebrewTag(out.get(b.id), b.title, vocab, profile?.reserved, b.currentTags));
    return out;
  });
}
