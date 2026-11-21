import { config } from './config.js';
import { loadOrCreateKey } from './crypto.js';
import { createApp } from './server.js';
import { openStore, retentionCutoff } from './store.js';
import { startSyncTimer } from './sync-timer.js';

if (!config.raindrop.clientId || !config.raindrop.clientSecret) {
  console.warn('RAINDROP_CLIENT_ID or RAINDROP_CLIENT_SECRET is missing. Raindrop connections will fail.');
}

// Shared services. Each request gets its user from the identity module.
const store = openStore(config.database);
const svc = {
  store,
  key: loadOrCreateKey(config.keyFile),
  cache: new Map(),
  profiles: new Map(),
  generations: new Map(),
  states: new Map(),
  refreshing: new Map(),
  syncs: new Map(),
  logSyncs: true, // one log line for each sync of the stored copy
};

// Change-log rows older than the retention time are removed at start and then once a day.
async function pruneLog() {
  try {
    const removed = await store.pruneLog(retentionCutoff(config.logRetentionDays));
    if (removed) console.log(`Removed ${removed} change-log rows older than ${config.logRetentionDays} days.`);
  } catch (err) {
    console.error('Could not prune the change log:', err.message);
  }
}
pruneLog();
setInterval(pruneLog, 24 * 60 * 60 * 1000).unref();

createApp(svc).listen(config.port, config.host, () => {
  console.log(`Open http://${config.host}:${config.port}`);
});

// The background sync of the stored copy. It does nothing when BOOKMARK_STORE is off.
startSyncTimer(svc);
