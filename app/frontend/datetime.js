// Dates and times on the bookmark cards, for example "17 Oct 2026, 13:05".
// Without a zone, the browser's own zone is used. The server sends UTC times.
function localDateTime(iso, zone) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: zone,
  }).format(new Date(iso));
}

// What the footer shows about the stored copy (docs/ui-elements.md, section 6.2). `me` is the answer of /api/me.
// `ago` makes the age text, for example "3 hours ago". It returns null when the answer has no `syncedAt` field:
// then the stored copy is off, and the footer shows nothing about it.
function syncedView(me, ago) {
  if (!me || !('syncedAt' in me)) return null;
  const warning = me.syncError ? 'The last sync failed. The data can be old.' : '';
  if (!me.syncedAt) return { text: 'Not synced yet', datetime: '', title: '', warning };
  return { text: 'Synced ' + ago(me.syncedAt), datetime: me.syncedAt, title: localDateTime(me.syncedAt), warning };
}
