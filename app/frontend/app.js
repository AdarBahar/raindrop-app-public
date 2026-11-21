// The page script, part 9 of 9: The synced text, the checks for new bookmarks, logout, delete my data, the phone filter sheet and the start-up.
// index.html loads the parts in this order: core.js → filters.js → list.js → bulk.js → review.js → bulk-drawer.js → keys.js → context.js → app.js. The parts share one global scope.

// ---- Synced text (docs/ui-elements.md, section 6.2) ----
// The footer shows how old the stored copy is. Only the stored copy has it: without the field, nothing shows.
function showSynced() {
  const view = syncedView(me, ago);
  const time = $('syncedAt'), warn = $('syncWarn');
  time.hidden = warn.hidden = true;
  if (!view) return;
  time.textContent = view.text;
  if (view.datetime) { time.setAttribute('datetime', view.datetime); time.title = view.title; }
  else { time.removeAttribute('datetime'); time.removeAttribute('title'); }
  time.hidden = false;
  warn.textContent = view.warning;
  warn.hidden = !view.warning;
}
// Read the sync status again and show it. Call it when a sync may have finished or failed: after the first load
// and after a check, in both outcomes. It never throws, so it cannot hide the result of the action before it.
async function refreshSynced() {
  try {
    const fresh = await api('/api/me');
    if (fresh.connected) me = fresh;
    showSynced();
  } catch { /* keep the old text */ }
}
// The age changes while the page stays open. Compute it again each minute, and when the tab shows again.
setInterval(() => { if (!document.hidden && me?.connected) showSynced(); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && me?.connected) showSynced(); });

// ---- Check for new bookmarks ----
// The full check: a sync, then the "New" labels. It returns true when it worked. The page load runs it by
// itself when the quick check finds new bookmarks. During the session, only a click runs it.
let pulling = false;
async function pullNow() {
  pulling = true;
  $('pull').disabled = true;
  $('pull').innerHTML = '<span class="spin" aria-hidden="true"></span> Checking for new bookmarks...';
  $('status').textContent = 'Checking for new bookmarks...';
  try {
    const d = await postJson('/api/pull');
    $('status').textContent = d.message;
    $('lastChecked').textContent = 'Last checked: ' + localDateTime(new Date().toISOString());
    $('lastChecked').hidden = false;
    await refreshMeta({followDefault: true});
    await run();
    return true;
  } catch (e) {
    if (e.connect) throw e;
    $('status').textContent = 'Error: Check failed: ' + e.message;
    return false;
  } finally {
    pulling = false;
    quickAt = Date.now();
    $('pull').disabled = false;
    $('pull').textContent = 'Check for new bookmarks';
    // The check runs a full sync. It can change the synced time or record an error, so read the status in both cases.
    await refreshSynced();
  }
}
$('pull').onclick = () => pullNow().catch(e => { if (e.connect) connectAgain(e); });

// ---- Quick check for new bookmarks (section 4.8) ----
// Every 3 minutes, while the tab shows and the browser is online, the page asks the server for new bookmarks
// in Raindrop. It never loads them and never reloads the list. It only puts a label on the check button.
// The user clicks the button when it suits them.
const QUICK_MS = 3 * 60 * 1000;
let quickAt = 0;
async function quickCheck() {
  quickAt = Date.now();
  try { return await api('/api/changes'); } catch { return null; }
}
function showPullLabel(d) {
  if (pulling || !d) return;
  const n = d.more ? `${d.added}+` : String(d.added);
  if (d.added) $('pull').innerHTML = `Check for new bookmarks <span class="badge new pull-new">${n} new</span>`;
  else $('pull').textContent = 'Check for new bookmarks';
}
async function quickTick() {
  if (!loaded || !me?.connected || pulling || document.hidden || !navigator.onLine) return;
  if (Date.now() - quickAt < QUICK_MS) return;
  showPullLabel(await quickCheck());
}
setInterval(quickTick, 30000);
document.addEventListener('visibilitychange', quickTick);
window.addEventListener('online', quickTick);

// ---- Logout dialog (section 4.2) ----
// Option 1 removes the Raindrop connection. Options 2 and 3 need the Admintools sign-out address
// from the server (me.logoutUrl). Without it, only option 1 and Cancel are shown.
const dlg = $('logout');
$('logoutBtn').onclick = () => {
  $('logoutErr').textContent = ''; $('logoutBusy').hidden = true;
  const admintools = Boolean(me?.logoutUrl);
  document.querySelector('[data-logout="raindrop"]').hidden = !me?.connected;
  document.querySelector('[data-logout="admintools"]').hidden = !admintools;
  $('logoutHelp').hidden = !admintools;
  document.querySelector('[data-logout="both"]').hidden = !(admintools && me?.connected);
  dlg.showModal();
  // The default choice is the one that signs out of both, when it is offered.
  const first = document.querySelector('[data-logout="both"]:not([hidden])') ?? $('logoutCancel');
  first.focus();
};
$('logoutCancel').onclick = () => dlg.close();
dlg.addEventListener('close', () => $('logoutBtn').focus());
document.querySelectorAll('[data-logout]').forEach(b => b.onclick = async () => {
  const which = b.dataset.logout;
  dlg.querySelectorAll('button').forEach(x => x.disabled = true);
  $('logoutBusy').hidden = false; $('logoutErr').textContent = '';
  try {
    if (which === 'raindrop' || which === 'both') await postJson('/api/disconnect');
  } catch (err) {
    dlg.querySelectorAll('button').forEach(x => x.disabled = false);
    $('logoutBusy').hidden = true;
    $('logoutErr').textContent = 'Error: Raindrop logout failed: ' + err.message;
    return; // option 3 stops here; it does not sign out of Admintools
  }
  // The Admintools sign-out must be a full-page visit. A fetch call does not sign the person out.
  if (which === 'raindrop') location.reload();
  else location.assign(me.logoutUrl);
});

// ---- Delete my data. Removes the connection and the app's own records about the user. ----
$('deleteBtn').onclick = () => {
  $('deleteErr').textContent = '';
  $('deleteDlg').showModal();
  $('deleteCancel').focus();
};
$('deleteCancel').onclick = () => $('deleteDlg').close();
$('deleteOk').onclick = async () => {
  $('deleteOk').disabled = true;
  try {
    await postJson('/api/delete-data');
    location.reload(); // the page starts again, and asks to connect
  } catch (err) {
    $('deleteOk').disabled = false;
    $('deleteErr').textContent = 'Error: Delete failed: ' + err.message;
  }
};

// ---- Phone filter sheet: the toolbar moves into the sidebar while the sheet is open ----
function openSheet() {
  $('sheetSlot').appendChild($('toolbar'));
  document.body.classList.add('filters-open');
  $('filtersBtn').setAttribute('aria-expanded', 'true');
  $('sort').focus();
}
function closeSheet() {
  $('appMain').insertBefore($('toolbar'), $('folderRow'));
  document.body.classList.remove('filters-open');
  $('filtersBtn').setAttribute('aria-expanded', 'false');
  $('filtersBtn').focus();
}
$('filtersBtn').onclick = openSheet;
$('sheetClose').onclick = closeSheet;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('filters-open')) closeSheet();
});
window.matchMedia('(max-width: 599px)').addEventListener('change', m => {
  if (!m.matches && document.body.classList.contains('filters-open')) closeSheet();
});

// ---- Sign-in, Raindrop connection and start-up ----
function showGate(part) {
  $('gate').hidden = false;
  $('app').hidden = true;
  $('signinPart').hidden = part !== 'signin';
  $('connectPart').hidden = part !== 'connect';
}

// The Raindrop connection is gone. Show the connect screen with the reason, once, without reloading.
function connectAgain(err) {
  // The page state follows the server. The "My context" view reads it for its note about the tag check.
  if (me) me.connected = false;
  $('connectErr').textContent = 'Error: ' + err.message;
  showGate('connect');
}

let loading = true;
async function showLoadProgress() {
  $('loadbar').hidden = false;
  while (loading) {
    try {
      const p = await (await fetch('/api/progress')).json();
      if (loading) {
        $('count').textContent = p.total ? `Loading bookmarks ${p.loaded}/${p.total}` : 'Loading bookmarks...';
        $('loadbar').firstElementChild.style.width = p.total ? `${Math.round(100 * p.loaded / p.total)}%` : '0';
      }
    } catch (e) { /* the server may be busy, try again */ }
    await new Promise(r => setTimeout(r, 300));
  }
  $('loadbar').hidden = true;
}

async function boot() {
  me = await api('/api/me');
  if (!me.user) return showGate('signin');
  if (!me.connected) {
    const oauthError = new URLSearchParams(location.search).get('oauth_error');
    if (oauthError) $('connectErr').textContent = 'Error: Raindrop did not connect: ' + oauthError;
    return showGate('connect');
  }
  $('gate').hidden = true;
  $('app').hidden = false;
  // The footer shows the time this page loaded. A check replaces it with the check time.
  $('lastChecked').textContent = 'Page loaded: ' + localDateTime(new Date().toISOString());
  $('lastChecked').hidden = false;
  showSynced();
  const who = String(me.raindrop?.name || me.user);
  const shown = who.length > 40 ? who.slice(0, 40) + '…' : who;
  const email = me.raindrop?.email ? `<small>${esc(me.raindrop.email)}</small>` : '';
  $('account').innerHTML = `<b>${esc(shown)}</b>${email}`;
  $('account').title = `Signed in to the app as ${me.user}${who !== shown ? ` (${who})` : ''}`;
  $('list').innerHTML = '<li class="empty">Loading...</li>';
  showLoadProgress();
  // A page load or a refresh loads new bookmarks by itself: the quick check runs first, and when it finds new
  // bookmarks, the full check runs before the list shows. A failed quick check loads the list as before.
  (async () => {
    const d = await quickCheck();
    if (d?.added && await pullNow()) return;
    await refreshMeta({followDefault: true});
    await run();
  })().catch(e => {
    if (e.connect) return connectAgain(e);
    $('count').textContent = 'Error: Load failed: ' + e.message;
  }).finally(() => {
    loading = false;
    // The first sync of a new user runs while the list loads. The answer of /api/me from before it is old now.
    refreshSynced();
  });
}

boot().catch(e => {
  if (e.connect) return connectAgain(e);
  $('count').textContent = 'Error: Start failed: ' + e.message;
});
