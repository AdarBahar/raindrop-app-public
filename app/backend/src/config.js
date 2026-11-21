import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = resolve(BACKEND, '..', 'frontend');

// Read KEY=VALUE lines. Missing file means no values.
function loadEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

// Values from the real environment win over the env file.
const envPath = process.env.RAINDROP_ENV_FILE || join(BACKEND, '.env');
const file = loadEnvFile(envPath);
const get = (name, fallback = '') => process.env[name] ?? file[name] ?? fallback;

const port = Number(get('PORT', '8100'));

// The release id. deploy/build-release.sh writes it into the release as VERSION. A dev checkout has none.
function versionOf() {
  const file = join(BACKEND, '..', '..', 'VERSION');
  if (!existsSync(file)) return 'dev';
  const text = readFileSync(file, 'utf8').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(text) ? text : 'dev';
}

const logoutUrl = get('ADMINTOOLS_LOGOUT_URL'); // the Admintools sign-out page. Only https is accepted.

export const config = {
  host: '127.0.0.1',
  version: versionOf(),
  adminLogoutUrl: /^https:\/\/\S+$/.test(logoutUrl) ? logoutUrl : '',
  port,
  frontendDir: FRONTEND,
  dataDir: get('DATA_DIR', join(BACKEND, 'data')),
  database: {
    url: get('DATABASE_URL'), // runtime role, for the app
    adminUrl: get('DATABASE_ADMIN_URL'), // admin role, for migrations only
  },
  keyFile: get('DATA_KEY_FILE', join(BACKEND, 'data', '.key')),
  cacheMs: 5 * 60 * 1000,
  pageSize: 50,
  // The stored copy of the bookmarks (docs/bookmark-store-plan.md). Off: the app loads from Raindrop, as before.
  // On: the app reads the database copy and a full sync fills it. Turn it on only after the privacy decision (D6).
  bookmarkStore: get('BOOKMARK_STORE', 'off') === 'on',
  sync: {
    writeTries: 3, // database writes of one accepted change before the change is left to the next sync
    writeRetryMs: 200, // wait between two of these writes
    tries: 3, // fetches of the snapshot before the sync fails
    retryWaitMs: 5000, // wait between two fetches of one sync
    emptyRecheckMs: 60 * 1000, // wait before an empty answer for a populated library is checked again
    timerMs: 15 * 60 * 1000, // the timer looks for due users this often
    staleMs: 20 * 60 * 60 * 1000, // a copy that is older than this gets a background sync
    spreadMs: 5000, // most random wait between the syncs of two users in one timer run
    statsMs: 60 * 60 * 1000, // the timer writes the summary log line this often
    failureAlert: 3, // an error goes to the log when a user reaches this number of failures in a row
  },
  listPageSizes: [25, 50, 100], // sizes the bookmark list accepts
  listPageDefault: 50,
  logRetentionDays: 90, // the change log keeps bookmark titles only this long
  bulkMax: 1000, // most bookmarks one bulk action can change
  bulkBatch: 100, // most ids in one bulk Raindrop call
  suggestBatch: 10, // most bookmarks in one model request for a batch suggestion
  limits: {
    searchLength: 200, // characters in the search box
    tagLength: 50, // characters in one tag
    tagsPerBookmark: 20,
    tagsPerFilter: 10, // tags in the tag filter
    folderName: 100, // characters in a folder name
    // The profile of a user (docs/profile-plan.md, section 5).
    profileEntries: 40, // entries for each user
    profileName: 60, // characters in the name of an entry
    profileDescription: 300, // characters in the description of a project or an interest
    profileAbout: 600, // characters in the text about the user
    profileBudget: 8000, // characters of the JSON text of the active entries that goes to the model
  },
  raindrop: {
    apiBase: get('RAINDROP_API_BASE', 'https://api.raindrop.io/rest/v1'),
    oauthBase: get('RAINDROP_OAUTH_BASE', 'https://raindrop.io/oauth'),
    clientId: get('RAINDROP_CLIENT_ID'),
    clientSecret: get('RAINDROP_CLIENT_SECRET'),
    redirectUri: get('RAINDROP_REDIRECT_URI', `http://127.0.0.1:${port}/oauth/callback`),
    minIntervalMs: 700, // keeps each user under 120 calls per minute
  },
  llm: {
    endpoint: get('API_Endpoint').replace(/\/+$/, ''),
    token: get('token'),
    model: get('llm_model'),
    minIntervalMs: 6500, // the endpoint allows 10 requests per 60 seconds per key
  },
};
