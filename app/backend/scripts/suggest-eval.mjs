// The evaluation of the suggestions against a labeled set (docs/profile-plan.md, section 9).
// This version has the gate of PR 4: the older prompt and the v2 prompt, one bookmark for each request,
// against the labeled folders. It saves nothing to Raindrop and makes no Raindrop call.
//
//   node scripts/suggest-eval.mjs <set.json> [--score] [--only older|v2|profile]
//
// The script sends each bookmark of the set to the model endpoint of the app (the .env values), two times.
// The endpoint allows 10 requests each minute, so 60 bookmarks take about 13 minutes.
// The answers go to <set>.results.json. With --score, the script asks nothing and reads that file again,
// for example after a label changed. With --only, it asks one path again and keeps the saved answers of the other.
//
// The set holds private bookmarks. Keep it in app/backend/data/, which git ignores. Its format:
//   { "folders": [[<id>, "<name>"], ...],            the folders of the library, without Unsorted
//     "knownTags": ["<tag>", ...],                    the known tags, as the app sends them
//     "bookmarks": [{ "_id", "title", "link", "note", "excerpt", "tags", "collection": <folder id, -1 for Unsorted>,
//                     "rightFolder": "<folder label>" | "" }] }
// A folder label is the folder name. When two folders have the same name, it is "<name> (#<id>)", as in the app.
// scripts/suggest-label.mjs writes the labels in this form.
// rightFolder is the label of the owner. An empty text means "not labeled", and the bookmark is not scored.
//
// For the gate of PR 5, the set also has:
//   "profile": [{ "id", "kind", "name", "description", "tag", "active" }, ...]   the profile entries, as the app stores them
//   "gate": { "minPredicted": <number>, "minRecall": <0 to 1> }                  decision P7, set before the first run
//   in each bookmark: "rightEntries": ["<entry id>", ...] (the entries that fit, or none), and "unclear": true for a
//   bookmark that is not a clear case. The script then asks a third path, v2 with the profile.
//
// "The folder in the editor" is the folder that a Save would write when the user changes nothing.
// The older path always gave the folder of the model. The v2 path keeps the folder of a sorted bookmark.
import { readFileSync, writeFileSync } from 'node:fs';
import { editorSuggestion, folderOptions, promptItem } from '../src/bookmarks.js';
import { labelFor } from '../src/listing.js';
import { buildMessagesV2, chat, classifyV2, ReplyError } from '../src/llm.js';
import { contextFor } from '../src/profile.js';

const setPath = process.argv[2];
const scoreOnly = process.argv.includes('--score');
if (!setPath) {
  console.error('Usage: node scripts/suggest-eval.mjs <set.json> [--score]');
  process.exit(2);
}
const resultsPath = setPath.replace(/\.json$/, '') + '.results.json';
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const c = { collections: new Map([[-1, 'Unsorted'], ...set.folders]), items: [] };
const options = folderOptions(c);
const labels = options.map((o) => o.label);
const items = set.bookmarks.map((b) => ({ ...b, collection: { $id: b.collection } }));

// ---- The older prompt. It was in src/llm.js before PR 4. It stays here only as the baseline of this gate. ----
function olderMessages(item) {
  const one = { id: item._id, title: item.title ?? '', note: item.note ?? '', excerpt: (item.excerpt ?? '').slice(0, 300), url: item.link ?? '' };
  const system =
    'You sort saved web bookmarks. Reply with a JSON array only, no other text. ' +
    'Each element: {"id": number, "folder": string, "tags": [string, ...]}. ' +
    'folder must be exactly one of the allowed folders. Use 1 to 4 short tags. ' +
    'Prefer tags from the known tag list when they fit.';
  const user = `Allowed folders: ${JSON.stringify(labels)}\nKnown tags: ${JSON.stringify(set.knownTags)}\nBookmarks: ${JSON.stringify([one])}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// The older parser, as it was in src/llm.js: JSON first, then a pattern for a reply that is slightly malformed.
// Returns a Map of id to { folder }. An unknown folder becomes Misc when that folder exists.
function olderParse(text) {
  let entries = [];
  try {
    entries = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  } catch {
    const pattern = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"folder"\s*:\s*"([^"]*)"\s*,\s*"tags"\s*:\s*\[([^\]]*)\]/g;
    entries = [...text.matchAll(pattern)].map((m) => ({
      id: Number(m[1]),
      folder: m[2],
      tags: [...m[3].matchAll(/"([^"]*)"/g)].map((t) => t[1]),
    }));
  }
  if (!Array.isArray(entries) || entries.length === 0) throw new ReplyError('no usable suggestion in reply');
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    let folder = entry.folder ?? '';
    if (!labels.includes(folder)) {
      if (!labels.includes('Misc')) throw new ReplyError(`unknown folder: ${folder}`);
      folder = 'Misc';
    }
    // The older parser read the tags here. A tag field that is not a list made the request fail, with no retry.
    const tags = (entry.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
    result.set(Number(entry.id), { folder, tags });
  }
  if (result.size === 0) throw new ReplyError('no usable suggestion in reply');
  return result;
}

// The folder of the older path for one bookmark, or an error text. As the app did: a reply that cannot be
// read gets one more request, and the answer is the entry with the ID of the bookmark.
async function older(item) {
  const messages = olderMessages(item);
  // The size of the user message, as for v2. The system text is the same for each request.
  const size = messages[1].content.length;
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const entry = olderParse(await chat(messages, { who: 'eval' })).get(item._id);
      return entry ? { size, folder: entry.folder, error: '' } : { size, folder: null, error: 'The model returned no suggestion.' };
    } catch (err) {
      if (!(err instanceof ReplyError)) return { size, folder: null, error: err.message };
      error = `could not read the model reply: ${err.message}`;
    }
  }
  return { size, folder: null, error };
}

// The v2 path for one bookmark: the decision of the model, and the folder that the editor gets.
// `profile`: the snapshot of the profile of the set, or null for the path without a profile.
async function v2(item, profile = null) {
  const batch = [promptItem(item, c)];
  // The size of the user message. The system text is the same for each request of one path.
  const size = buildMessagesV2(batch, labels, set.knownTags, profile)[1].content.length;
  const usage = { prompt: 0, completion: 0 };
  const onUsage = (u) => { usage.prompt += u.prompt_tokens ?? 0; usage.completion += u.completion_tokens ?? 0; };
  try {
    const entry = (await classifyV2(batch, labels, set.knownTags, { who: 'eval', profile, onUsage })).get(item._id);
    if (!entry) return { size, usage, error: 'no answer for the bookmark' };
    const d = editorSuggestion(item, c, options, entry);
    return {
      size, usage, action: entry.folder.action, model: entry.folder.name, editor: d.folder, status: d.status, reason: d.reason,
      // The profile tags as the editor would offer them, and as the model proposed them before the row rules.
      entries: entry.profileTags.map((p) => p.entryId), offered: d.profileTags.map((p) => p.entryId), error: '',
    };
  } catch (err) {
    return { size, usage, error: err.message };
  }
}

// The profile of the set, as one suggestion request uses it. Null when the set has no profile.
const profile = set.profile?.length ? await contextFor({ store: { profile: async () => set.profile } }, 'eval') : null;

// --only older, --only v2, or --only profile: ask one path again and keep the saved answers of the other paths.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
let results;
if (scoreOnly) {
  results = JSON.parse(readFileSync(resultsPath, 'utf8'));
} else {
  results = only ? JSON.parse(readFileSync(resultsPath, 'utf8')) : {};
  for (const [i, item] of items.entries()) {
    process.stderr.write(`\r${i + 1} of ${items.length}`);
    const saved = results[item._id] ?? {};
    results[item._id] = {
      // A path that has no saved answer for this bookmark is asked also with --only for the other path.
      older: only && only !== 'older' && saved.older ? saved.older : await older(item),
      v2: only && only !== 'v2' && saved.v2 ? saved.v2 : await v2(item),
    };
    // The path with the profile, only for a set that has a profile.
    if (profile) results[item._id].profile = only && only !== 'profile' && saved.profile ? saved.profile : await v2(item, profile);
    writeFileSync(resultsPath, JSON.stringify(results, null, 1));
  }
  process.stderr.write('\n');
}

// ---- The report ----
const short = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const count = { labeled: 0, older: 0, v2: 0, olderErrors: 0, v2Errors: 0, sorted: 0, sortedKept: 0, differ: 0, missing: 0 };
const lines = [];
const badLabels = [];
for (const item of items) {
  const r = results[item._id];
  // The saved answers can be from an older set. A bookmark without the two answers is not scored.
  if (!r?.older || !r?.v2) { count.missing += 1; continue; }
  // The label of the app: a folder name that two folders have also shows the folder ID.
  const current = labelFor(c, item.collection.$id) || 'Unsorted';
  let right = item.rightFolder ?? '';
  // A label that is not a folder label of the set cannot be scored. An example is a name that two folders have.
  if (right && !labels.includes(right)) { badLabels.push(`#${item._id}: "${right}"`); right = ''; }
  const olderFolder = r.older.folder ?? `(error: ${r.older.error})`;
  const v2Editor = r.v2.error ? `(error: ${r.v2.error})` : r.v2.editor;
  if (r.older.error) count.olderErrors += 1;
  if (r.v2.error) count.v2Errors += 1;
  if (current !== 'Unsorted') {
    count.sorted += 1;
    if (v2Editor === current) count.sortedKept += 1;
  }
  let mark = '';
  if (right) {
    count.labeled += 1;
    if (olderFolder === right) count.older += 1;
    if (v2Editor === right) count.v2 += 1;
    mark = `${olderFolder === right ? 'older right' : 'older WRONG'}, ${v2Editor === right ? 'v2 right' : 'v2 WRONG'}`;
  }
  if (olderFolder !== v2Editor) count.differ += 1;
  const model = r.v2.error ? '' : r.v2.action === 'none' ? 'none' : `${r.v2.action}: ${r.v2.model}`;
  lines.push(
    `#${item._id} ${short(item.title || item.link || '', 70)}\n` +
    `   current: ${current} | labeled: ${right || '(not labeled)'}${mark ? ` | ${mark}` : ''}\n` +
    `   older editor: ${olderFolder} | v2 editor: ${v2Editor} | v2 model: ${model}${olderFolder !== v2Editor ? ' | DIFFERENT' : ''}\n` +
    `   request characters: older ${r.older.size}, v2 ${r.v2.size}${r.v2.reason ? ` | ${short(r.v2.reason, 120)}` : ''}`,
  );
}
console.log(lines.join('\n'));
console.log('\n---- Summary ----');
console.log(`Bookmarks: ${items.length}. With a label: ${count.labeled}.`);
if (count.missing) console.log(`Not scored, because an answer is missing: ${count.missing}. Run the script without --score.`);
console.log(`Folder in the editor is the labeled folder: older ${count.older} of ${count.labeled}, v2 ${count.v2} of ${count.labeled}.`);
console.log(`Sorted bookmarks that keep their folder in the v2 editor: ${count.sortedKept} of ${count.sorted}.`);
console.log(`The two paths give a different folder in the editor: ${count.differ}.`);
console.log(`Requests with no usable answer: older ${count.olderErrors}, v2 ${count.v2Errors}.`);
// ---- The profile (the gate of PR 5) ----
// A pair is one bookmark with one entry. Only entries with a tag count, because only they can give a profile tag.
// A bookmark with "unclear": true is not in the precision and recall figures.
let profileGate = '';
if (profile) {
  const tagged = new Set(set.profile.filter((e) => e.tag && e.active && e.kind !== 'about').map((e) => e.id));
  const name = new Map(set.profile.map((e) => [e.id, e.name]));
  const p = { tp: 0, fp: 0, fn: 0, clear: 0, unlabeled: 0, missing: 0, errors: 0, sortedMoved: 0, unsorted: 0, plainRight: 0, profileRight: 0, worse: 0, prompt: 0, completion: 0, plainPrompt: 0, plainCompletion: 0, size: 0, plainSize: 0, n: 0 };
  const rows = [];
  for (const item of items) {
    const r = results[item._id];
    if (!r?.profile || !r?.v2) { p.missing += 1; continue; }
    p.n += 1;
    p.size += r.profile.size; p.plainSize += r.v2.size;
    p.prompt += r.profile.usage?.prompt ?? 0; p.completion += r.profile.usage?.completion ?? 0;
    p.plainPrompt += r.v2.usage?.prompt ?? 0; p.plainCompletion += r.v2.usage?.completion ?? 0;
    if (r.profile.error) p.errors += 1;
    const current = labelFor(c, item.collection.$id) || 'Unsorted';
    if (current !== 'Unsorted' && !r.profile.error && r.profile.editor !== current) p.sortedMoved += 1;
    const right = labels.includes(item.rightFolder) ? item.rightFolder : '';
    if (current === 'Unsorted' && right) {
      p.unsorted += 1;
      const plainOk = r.v2.editor === right, profileOk = r.profile.editor === right;
      if (plainOk) p.plainRight += 1;
      if (profileOk) p.profileRight += 1;
      if (plainOk && !profileOk) p.worse += 1;
    }
    if (!Array.isArray(item.rightEntries)) { p.unlabeled += 1; continue; }
    const predicted = (r.profile.entries ?? []).filter((id) => tagged.has(id));
    const wanted = item.rightEntries.filter((id) => tagged.has(id));
    const tp = predicted.filter((id) => wanted.includes(id)), fp = predicted.filter((id) => !wanted.includes(id)), fn = wanted.filter((id) => !predicted.includes(id));
    if (!item.unclear) { p.clear += 1; p.tp += tp.length; p.fp += fp.length; p.fn += fn.length; }
    if (predicted.length || wanted.length) {
      const names = (ids) => ids.map((id) => name.get(id) ?? id).join(', ') || 'none';
      rows.push(`#${item._id} ${short(item.title || item.link || '', 60)}${item.unclear ? ' [unclear, not scored]' : ''}\n   labeled: ${names(wanted)} | model: ${names(predicted)}${fp.length ? ` | WRONG: ${names(fp)}` : ''}${fn.length ? ` | MISSED: ${names(fn)}` : ''}`);
    }
  }
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'no cases');
  const predictedAll = p.tp + p.fp;
  console.log('\n---- Profile tags ----');
  console.log(rows.join('\n'));
  console.log('\n---- Summary of the profile ----');
  console.log(`Bookmarks with the two answers: ${p.n}. Clear cases with entry labels: ${p.clear}. Without entry labels: ${p.unlabeled}. Requests with no usable answer: ${p.errors}.`);
  console.log(`Profile tags on the clear cases: ${p.tp} right, ${p.fp} wrong, ${p.fn} missed. Predicted matches: ${predictedAll}.`);
  console.log(`Precision: ${pct(p.tp, predictedAll)} (${p.tp} of ${predictedAll}). Recall: ${pct(p.tp, p.tp + p.fn)} (${p.tp} of ${p.tp + p.fn}).`);
  console.log(`Sorted bookmarks whose folder in the editor is not the current folder: ${p.sortedMoved}.`);
  console.log(`Unsorted bookmarks, folder in the editor is the labeled folder: without the profile ${p.plainRight} of ${p.unsorted}, with the profile ${p.profileRight} of ${p.unsorted}. Right without and wrong with: ${p.worse}.`);
  console.log(`Request characters, mean: without the profile ${Math.round(p.plainSize / (p.n || 1))}, with the profile ${Math.round(p.size / (p.n || 1))}.`);
  console.log(`Tokens that the endpoint reported, mean for each bookmark: without the profile ${Math.round(p.plainPrompt / (p.n || 1))} in and ${Math.round(p.plainCompletion / (p.n || 1))} out, with the profile ${Math.round(p.prompt / (p.n || 1))} in and ${Math.round(p.completion / (p.n || 1))} out. A zero means that the saved answers have no token figures.`);
  // The limits of decision P7. The owner writes them into the set before the first run with the profile.
  const g = set.gate ?? {};
  const have = Number.isFinite(g.minPredicted) && Number.isFinite(g.minRecall);
  const checks = [
    ['precision of 90% or more', predictedAll > 0 && p.tp / predictedAll >= 0.9],
    [`${g.minPredicted} predicted matches or more`, predictedAll >= g.minPredicted],
    [`recall of ${Math.round(g.minRecall * 100)}% or more`, p.tp + p.fn > 0 && p.tp / (p.tp + p.fn) >= g.minRecall],
    ['no sorted bookmark leaves its folder', p.sortedMoved === 0],
    ['no Unsorted bookmark is right without the profile and wrong with it', p.worse === 0],
  ];
  const incomplete = p.missing || p.unlabeled || !have;
  profileGate = incomplete
    ? `INCOMPLETE: ${[p.missing && `${p.missing} without an answer`, p.unlabeled && `${p.unlabeled} without entry labels`, !have && 'the set has no "gate": { "minPredicted", "minRecall" } (decision P7)'].filter(Boolean).join(', ')}.`
    : checks.every(([, ok]) => ok) ? 'PASS.' : `FAIL: ${checks.filter(([, ok]) => !ok).map(([text]) => text).join('; ')}.`;
  if (have) for (const [text, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`);
}

if (badLabels.length) console.log(`Labels that are not a folder label of the set, not scored: ${badLabels.join(', ')}. Label them again with scripts/suggest-label.mjs.`);
console.log(`Gate of PR 4: ${count.missing || badLabels.length ? 'INCOMPLETE, because an answer is missing or a label is not valid. The figures above are partial.' : count.labeled === 0 ? 'no labels, so no result.' : count.v2 >= count.older ? 'v2 is not worse on the labeled folders.' : 'v2 is WORSE on the labeled folders.'} The owner reads each DIFFERENT line.`);
if (profile) console.log(`Gate of PR 5: ${profileGate}`);
