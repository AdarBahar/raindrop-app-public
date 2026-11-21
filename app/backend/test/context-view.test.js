// Static checks of the "My context" view (docs/ui-elements.md, section 11). They read the page files as text.
// A browser check is still needed for the layout and the focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScript, pageScriptFiles } from './helpers/frontend.js';

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../frontend/styles.css', import.meta.url), 'utf8');
const js = pageScript();
const view = html.slice(html.indexOf('<dialog id="profileDlg"'), html.indexOf('<dialog id="failDlg"'));

test('the view is a named dialog, and two buttons open it', () => {
  assert.match(html, /<dialog id="profileDlg" class="wide" aria-labelledby="profileH">\s*<h2 id="profileH" tabindex="-1">My context<\/h2>/);
  assert.match(html, /<button id="profileBtn" class="btn quiet sm" aria-haspopup="dialog">My context<\/button>/);
  // The second button is in the connect message, so the view works without a Raindrop connection.
  const connect = html.slice(html.indexOf('id="connectPart"'), html.indexOf('<div id="app"'));
  assert.match(connect, /<button id="profileGateBtn" class="btn quiet sm" aria-haspopup="dialog">My context<\/button>/);
  assert.match(js, /\$\('profileBtn'\)\.onclick = \(\) => openProfile\(\$\('profileBtn'\)\);/);
  assert.match(js, /\$\('profileGateBtn'\)\.onclick = \(\) => openProfile\(\$\('profileGateBtn'\)\);/);
});

test('the script of the view loads before app.js', () => {
  const files = pageScriptFiles();
  assert.ok(files.includes('context.js'));
  assert.ok(files.indexOf('context.js') < files.indexOf('app.js'));
});

test('the view says what happens to the data, and that the model gets the active entries', () => {
  assert.match(view, /The app gives the active entries to the language model/);
  assert.match(view, /The profile is stored in the database of this app\./);
  assert.match(view, /The app sends the active entries to the language model with each suggestion request/);
  assert.match(view, /An entry that is not active is not sent\./);
  assert.match(view, /becomes a normal tag in Raindrop\. For a confidential project, use a tag that does not show its name\./);
  assert.match(view, /"Logout from Raindrop account" keeps the profile\. "Delete my data" removes it\./);
  assert.match(view, /Do not write passwords or other secrets here\./);
});

test('"Delete my data" names the profile', () => {
  assert.match(html, /the log of changes with bookmark titles, and your profile \("My context"\)\. Your bookmarks in Raindrop are not changed\./);
});

test('every field of the view has a label, and the errors are alerts', () => {
  for (const id of ['pfAbout', 'pfKind', 'pfName', 'pfDesc', 'pfTag']) {
    assert.match(view, new RegExp(`<label for="${id}">`), `${id} has no label`);
    assert.match(view, new RegExp(`id="${id}"`));
  }
  assert.match(view, /<label class="pf-check"><input type="checkbox" id="pfActive" checked>/);
  for (const id of ['pfLoadErr', 'pfAboutErr', 'pfErr']) assert.match(view, new RegExp(`id="${id}" class="err" role="alert"`));
  assert.match(view, /id="pfBudgetText" role="status" aria-live="polite"/);
  assert.match(view, /id="pfSummary" class="muted" role="status"/);
  assert.match(view, /aria-describedby="pfTagHelp pfErr"/);
});

test('the three states have their names', () => {
  assert.match(js, /function pfStateOf\(active, tag\) \{ return !active \? 'Inactive' : tag \? 'Context and tag' : 'Context only'; \}/);
});

test('the budget line says that the total is the limit for active entries', () => {
  assert.match(js, /The active entries use \$\{pfNumber\(budget\.used\)\} of \$\{pfNumber\(budget\.max\)\} characters\. This total is the limit for active entries\./);
});

test('the default tag of a project is proj: and the name, and the user selects it', () => {
  assert.match(js, /\('proj:' \+ slug\)/);
  assert.match(js, /\$\('pfKind'\)\.value === 'project' && !tag \? pfDefaultTag\(\$\('pfName'\)\.value\) : ''/);
  // The row hides with the button, so an empty row adds no gap to the form.
  assert.match(view, /<div id="pfTagDefaultRow" class="line" hidden><button id="pfTagDefault" class="btn sm" type="button"><\/button><\/div>/);
  assert.match(js, /\$\('pfTagDefaultRow'\)\.hidden = !offer;/);
});

test('a tag that is already a Raindrop tag needs a second, explicit click', () => {
  // The API client keeps the flag of the 409 answer.
  assert.match(js, /err\.tagExists = Boolean\(d\?\.tagExists\);/);
  assert.match(js, /if \(reuse\) body\.reuseTag = true;/);
  assert.match(js, /\$\('pfSave'\)\.onclick = \(\) => savePfEntry\(\);/);
  assert.match(js, /\$\('pfReuseOk'\)\.onclick = \(\) => savePfEntry\(true\);/);
  assert.match(view, /<button id="pfReuseOk" class="btn sm">Use this tag anyway<\/button>/);
  // A change in the form hides the question, so the confirmation cannot apply to a different tag.
  assert.match(js, /\$\('pfForm'\)\.addEventListener\('input', \(\) => \{ pfDirty = true; \$\('pfReuse'\)\.hidden = true;/);
});

test('without a connection, the form says that the tag cannot be checked', () => {
  assert.match(view, /id="pfTagNote" class="muted" hidden>Raindrop is not connected\. The app cannot check if this tag is already a tag in Raindrop\./);
  assert.match(js, /\$\('pfTagNote'\)\.hidden = Boolean\(me\?\.connected\);/);
});

test('entry text goes into the page through esc()', () => {
  assert.match(js, /<span class="pf-name" dir="auto">\$\{esc\(e\.name\)\}<\/span>/);
  assert.match(js, /<div class="pf-desc" dir="auto">\$\{esc\(e\.description\)\}<\/div>/);
  assert.match(js, /<span class="err" role="alert">\$\{esc\(pfAskErr\)\}<\/span>/);
  assert.match(js, /tag "\$\{esc\(e\.tag\)\}"/);
  assert.match(js, /aria-label="Edit \$\{esc\(e\.name\)\}"/);
  assert.match(js, /aria-label="Delete \$\{esc\(e\.name\)\}"/);
});

test('delete asks first, and the focus goes to the safe choice', () => {
  assert.match(js, /data-pf="deleteOk"[^>]*>Delete the entry<\/button>/);
  assert.match(js, /data-pf="deleteNo"[^>]*>Keep the entry<\/button>/);
  assert.match(js, /if \(act === 'delete'\) \{ pfAsk = id; pfAskErr = ''; renderProfile\(\); return document\.querySelector\(`\[data-pf="deleteNo"\]\[data-id="\$\{id\}"\]`\)\.focus\(\); \}/);
});

test('the focus moves into the form, back to the entry, and back to the opener', () => {
  assert.match(js, /\$\('pfForm'\)\.hidden = false;\n\s+\$\('pfAdd'\)\.hidden = true;\n\s+\$\('pfAdd'\)\.setAttribute\('aria-expanded', 'true'\);\n\s+\$\('pfName'\)\.focus\(\);/);
  assert.match(js, /\(document\.querySelector\(`\[data-pf="edit"\]\[data-id="\$\{focusId\}"\]`\) \?\? \$\('pfAdd'\)\)\.focus\(\);/);
  assert.match(js, /\$\('profileDlg'\)\.addEventListener\('close', \(\) => pfOpener\?\.focus\(\)\);/);
});

test('a change that is not saved keeps the view open', () => {
  assert.match(js, /if \(pfEditId === null \|\| !pfDirty\) return false;/);
  assert.match(js, /The entry has changes\. Select "Save the entry" or "Cancel"\./);
  assert.match(js, /\$\('profileClose'\)\.onclick = \(\) => \{ if \(!pfBlocked\(\)\) \$\('profileDlg'\)\.close\(\); \};/);
});

test('nothing can be saved before the profile is loaded', () => {
  assert.match(js, /\$\('pfAdd'\)\.disabled = \$\('pfAboutSave'\)\.disabled = true;\n\s+\$\('profileDlg'\)\.showModal\(\);/);
});

test('the wide dialog scrolls, and a text area has the look of the other fields', () => {
  assert.match(css, /dialog\.wide \{ width: min\(640px, 94vw\); max-height: 92vh; overflow-y: auto; \}/);
  assert.match(css, /textarea \{ font: inherit; color: inherit;/);
});

test('a failed load says how to recover, and a failed delete shows in the row of the entry', () => {
  assert.match(js, /'Error: Load failed: ' \+ err\.message \+ ' Close this view and open it again\.'/);
  assert.match(js, /pfAskErr = 'Error: Delete failed: ' \+ err\.message;\n\s+renderProfile\(\);/);
  assert.doesNotMatch(js, /\$\('pfLoadErr'\)\.textContent = 'Error: Delete failed/);
});

test('text that the user writes gets its direction from the text, for Hebrew', () => {
  for (const id of ['pfAbout', 'pfName', 'pfDesc']) assert.match(view, new RegExp(`id="${id}"[^>]*dir="auto"`), `${id} has no dir="auto"`);
});

// Review of PR #140: an entry save, a delete and "Keep the entry" render the view again. That must not
// replace a text about the user that is not saved.
test('a text about the user that is not saved is not replaced when the view renders again', () => {
  assert.match(js, /let pfAboutDirty = false;/);
  assert.match(js, /if \(!pfAboutDirty\) \$\('pfAbout'\)\.value = about\?\.description \?\? '';/);
  // The write no longer depends on the focus, which a button click moves away.
  assert.doesNotMatch(js, /document\.activeElement !== \$\('pfAbout'\)/);
  assert.match(js, /\$\('pfAbout'\)\.addEventListener\('input', \(\) => \{ pfAboutDirty = true;/);
  // The flag clears after a save that worked, and when the view opens.
  assert.match(js, /if \(!ok\) return;\n\s+pfAboutDirty = false;/);
  assert.match(js, /pfAsk = null; pfAskErr = '';\n\s+\/\/ The text about the user starts from the stored text each time the view opens\.\n\s+pfAboutDirty = false;/);
});

test('a failed load after a good save is not shown as a failed save', () => {
  assert.match(js, /async function reloadProfile\(\) \{\n\s+try \{\n\s+await loadProfile\(\);\n\s+return true;\n\s+\} catch \(err\) \{/);
  assert.match(js, /Error: The change is saved, but the view did not load again: /);
  // Each save and delete sends its request in a try block that has no load in it.
  assert.match(js, /saved = \(await postJson\('\/api\/profile\/entry', body\)\)\.entry;\n\s+\} catch \(err\) \{/);
  assert.match(js, /await postJson\('\/api\/profile\/entry\/delete', \{id\}\);\n\s+\} catch \(err\) \{/);
  assert.doesNotMatch(js, /await postJson\([^\n]*\n\s+await loadProfile\(\);/);
  assert.match(js, /if \(!saved\) return;[\s\S]{0,120}await reloadProfile\(\);\n\s+closePfForm\(saved\.id\);/);
});

test('an entry form with a change stays when the view opens again, and the add button says if the form is open', () => {
  assert.match(js, /if \(!\(pfEditId !== null && pfDirty\)\) \{\n\s+pfEditId = null; pfDirty = false;\n\s+\$\('pfForm'\)\.hidden = true;\n\s+\$\('pfAdd'\)\.hidden = false;\n\s+\$\('pfAdd'\)\.setAttribute\('aria-expanded', 'false'\);/);
});

test('when the Raindrop connection is gone, the page state says so', () => {
  assert.match(js, /function connectAgain\(err\) \{\n[^\n]*\n\s+if \(me\) me\.connected = false;/);
});
