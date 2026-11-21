// Shared sample data and helpers for the Raindrop UI samples.
// Every sample inlines this file. The rules follow docs/ui-elements.md.
const NOW = new Date("2026-10-17T14:30:00");
const PAGE_SIZE = 25;
const FOLDERS = [
  { id: -1, name: "Unsorted" },
  { id: 1, name: "Dev tools" },
  { id: 2, name: "Design" },
  { id: 3, name: "Finance" },
  { id: 4, name: "Home lab" },
  { id: 5, name: "Reading" },
  { id: 6, name: "Recipes" },
];
const BOOKMARKS = [
  { id: 1, title: "Cloudflare R2: S3 API compatibility", link: "https://developers.cloudflare.com/r2/api/s3/api/", domain: "developers.cloudflare.com", folder: 4, tags: ["cloudflare", "backup", "s3"], created: "2026-10-17T09:12:00", visits: 3, lastVisit: "2026-10-17T13:05:00", excerpt: "R2 implements the S3 API, so most S3 clients work with a change of endpoint and credentials.", note: "Used for the key backup job.", isNew: true },
  { id: 2, title: "SQLite WAL mode explained", link: "https://sqlite.org/wal.html", domain: "sqlite.org", folder: 1, tags: ["sqlite", "database"], created: "2026-10-16T22:40:00", visits: 7, lastVisit: "2026-10-17T08:50:00", excerpt: "Write-ahead logging gives more concurrency, because readers do not block writers and a writer does not block readers.", note: "", isNew: false },
  { id: 3, title: "Hetzner Cloud: firewall rules reference", link: "https://docs.hetzner.com/cloud/firewalls/overview", domain: "docs.hetzner.com", folder: 4, tags: ["hetzner", "firewall"], created: "2026-10-15T08:05:00", visits: 12, lastVisit: "2026-10-16T19:20:00", excerpt: "Cloud firewalls filter traffic before it reaches the server. Rules apply per direction and per protocol.", note: "", isNew: false },
  { id: 4, title: "Node.js 22 release notes", link: "https://nodejs.org/en/blog/release/v22.0.0", domain: "nodejs.org", folder: 1, tags: ["nodejs", "release"], created: "2026-10-14T19:30:00", visits: 2, lastVisit: "2026-10-14T19:31:00", excerpt: "Node.js 22 ships with the V8 12.4 engine, a stable watch mode and a built-in WebSocket client.", note: "", isNew: false },
  { id: 5, title: "Shakshuka with feta", link: "https://www.seriouseats.com/shakshuka-recipe", domain: "seriouseats.com", folder: 6, tags: ["recipe", "breakfast"], created: "2026-10-13T07:45:00", visits: 5, lastVisit: "2026-10-15T07:30:00", excerpt: "Eggs poached in a spiced tomato and pepper sauce. Serve with bread and crumbled feta.", note: "", isNew: false },
  { id: 6, title: "Raindrop.io API: Raindrops", link: "https://developer.raindrop.io/v1/raindrops", domain: "developer.raindrop.io", folder: 1, tags: ["raindrop", "api"], created: "2026-10-12T14:20:00", visits: 21, lastVisit: "2026-10-17T10:12:00", excerpt: "Endpoints to get, create, update and remove raindrops. Bulk updates append tags.", note: "Single update replaces tags. See issue #26.", isNew: false },
  { id: 7, title: "Why your bookmarks app needs full-text search", link: "https://blog.example.net/bookmarks-search", domain: "blog.example.net", folder: -1, tags: [], created: "2026-10-17T11:02:00", visits: 0, lastVisit: null, excerpt: "A list you cannot search is a list you do not use. Search across title, excerpt and tags at once.", note: "", isNew: true },
  { id: 8, title: "Caddy reverse proxy quick start", link: "https://caddyserver.com/docs/quick-starts/reverse-proxy", domain: "caddyserver.com", folder: 4, tags: ["caddy", "proxy", "docker"], created: "2026-10-10T16:10:00", visits: 4, lastVisit: "2026-10-11T09:00:00", excerpt: "Caddy proxies to a backend with one line of config and manages HTTPS certificates for you.", note: "", isNew: false },
  { id: 9, title: "Index funds for Europeans", link: "https://www.bogleheads.org/wiki/EU_investing", domain: "bogleheads.org", folder: 3, tags: ["etf", "investing"], created: "2026-10-09T21:00:00", visits: 1, lastVisit: "2026-10-09T21:02:00", excerpt: "A guide to low-cost index funds, accumulating versus distributing shares, and tax residency.", note: "", isNew: false },
  { id: 10, title: "A practical guide to CSS container queries", link: "https://web.dev/articles/cq-stable", domain: "web.dev", folder: 2, tags: ["css", "responsive"], created: "2026-10-08T10:30:00", visits: 6, lastVisit: "2026-10-12T15:40:00", excerpt: "Container queries let a component respond to the size of its parent, not the viewport.", note: "", isNew: false },
  { id: 11, title: "Systemd timers instead of cron", link: "https://wiki.archlinux.org/title/Systemd/Timers", domain: "wiki.archlinux.org", folder: 4, tags: ["systemd", "linux"], created: "2026-10-07T09:00:00", visits: 9, lastVisit: "2026-10-16T08:10:00", excerpt: "Timers are systemd units that start other units on a schedule. They log to the journal and can catch up after downtime.", note: "", isNew: false },
  { id: 12, title: "Restic backups to Backblaze B2", link: "https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html", domain: "restic.readthedocs.io", folder: 4, tags: ["backup", "restic"], created: "2026-10-06T13:15:00", visits: 3, lastVisit: "2026-10-06T13:40:00", excerpt: "Create a repository on B2, set the credentials in the environment, then run the first snapshot.", note: "", isNew: false },
  { id: 13, title: "Lemon pasta in 20 minutes", link: "https://www.bonappetit.com/recipe/lemon-pasta", domain: "bonappetit.com", folder: 6, tags: ["recipe", "pasta"], created: "2026-10-05T18:40:00", visits: 2, lastVisit: "2026-10-05T18:45:00", excerpt: "Butter, lemon zest, parmesan and pasta water make the sauce. No cream.", note: "", isNew: false },
  { id: 14, title: "The grug brained developer", link: "https://grugbrain.dev/", domain: "grugbrain.dev", folder: 5, tags: ["essay", "programming"], created: "2026-10-04T23:10:00", visits: 8, lastVisit: "2026-10-14T22:00:00", excerpt: "Complexity is the enemy. Grug says: say no, use fewer tools, and keep the code close to the problem.", note: "", isNew: false },
  { id: 15, title: "WCAG 2.2 quick reference", link: "https://www.w3.org/WAI/WCAG22/quickref/", domain: "w3.org", folder: 2, tags: ["accessibility", "wcag"], created: "2026-10-03T11:20:00", visits: 14, lastVisit: "2026-10-17T09:30:00", excerpt: "A filterable list of all WCAG 2.2 success criteria with techniques and failures.", note: "Check 2.5.8 target size.", isNew: false },
  { id: 16, title: "Docker Compose healthchecks", link: "https://docs.docker.com/compose/how-tos/startup-order/", domain: "docs.docker.com", folder: 1, tags: ["docker", "compose"], created: "2026-10-01T15:50:00", visits: 5, lastVisit: "2026-10-02T10:00:00", excerpt: "Use depends_on with condition: service_healthy so a service waits until its dependency is ready.", note: "", isNew: false },
  { id: 17, title: "Python asyncio cheat sheet", link: "https://gist.github.com/example/asyncio-cheatsheet", domain: "gist.github.com", folder: 1, tags: ["python", "asyncio"], created: "2026-09-28T20:00:00", visits: 3, lastVisit: "2026-09-30T20:00:00", excerpt: "gather, create_task, timeouts and cancellation in one page.", note: "", isNew: false },
  { id: 18, title: "Tailscale: subnet routers", link: "https://tailscale.com/kb/1019/subnets", domain: "tailscale.com", folder: 4, tags: ["tailscale", "vpn"], created: "2026-09-25T08:30:00", visits: 7, lastVisit: "2026-10-10T18:00:00", excerpt: "A subnet router gives the tailnet access to devices that cannot run Tailscale themselves.", note: "", isNew: false },
  { id: 19, title: "How to read a balance sheet", link: "https://www.investopedia.com/terms/b/balancesheet.asp", domain: "investopedia.com", folder: 3, tags: ["accounting"], created: "2026-09-22T12:00:00", visits: 0, lastVisit: null, excerpt: "Assets equal liabilities plus equity. The sheet is a snapshot at one date, not a period.", note: "", isNew: false },
  { id: 20, title: "Fermented hot sauce", link: "https://www.noma.dk/guide/fermented-hot-sauce", domain: "noma.dk", folder: 6, tags: ["recipe", "fermentation"], created: "2026-09-20T17:25:00", visits: 1, lastVisit: "2026-09-20T17:30:00", excerpt: "Chillies, salt and time. A two-week lacto-ferment, then blend with vinegar.", note: "", isNew: false },
  { id: 21, title: "Choosing a monospace font", link: "https://www.programmingfonts.org/", domain: "programmingfonts.org", folder: 2, tags: ["typography", "fonts"], created: "2026-09-18T22:00:00", visits: 4, lastVisit: "2026-09-19T08:00:00", excerpt: "Compare coding fonts side by side with your own sample text.", note: "", isNew: false },
  { id: 22, title: "OAuth 2.0 refresh token rotation", link: "https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation", domain: "auth0.com", folder: 1, tags: ["oauth", "security"], created: "2026-09-15T10:10:00", visits: 6, lastVisit: "2026-10-13T11:00:00", excerpt: "Each refresh returns a new refresh token and invalidates the old one. Reuse of an old token revokes the family.", note: "", isNew: false },
  { id: 23, title: "Hetzner Storage Box with rclone", link: "https://community.hetzner.com/tutorials/storage-box-rclone", domain: "community.hetzner.com", folder: 4, tags: ["hetzner", "rclone", "backup"], created: "2026-09-12T09:45:00", visits: 2, lastVisit: "2026-09-12T10:00:00", excerpt: "Mount or sync a Storage Box over SFTP with rclone. Includes a systemd unit example.", note: "", isNew: false },
  { id: 24, title: "On Writing Well: a summary", link: "https://www.readwise.io/summaries/on-writing-well", domain: "readwise.io", folder: 5, tags: ["writing", "book"], created: "2026-09-10T21:30:00", visits: 1, lastVisit: "2026-09-10T21:35:00", excerpt: "Clutter is the disease of writing. Strip every sentence to its cleanest components.", note: "", isNew: false },
  { id: 25, title: "Pi-hole v6 upgrade notes", link: "https://pi-hole.net/blog/2025/02/18/introducing-pi-hole-v6/", domain: "pi-hole.net", folder: 4, tags: ["dns", "pihole"], created: "2026-09-05T19:15:00", visits: 3, lastVisit: "2026-09-06T08:00:00", excerpt: "Version 6 removes lighttpd and PHP. The web interface and API run in the FTL binary.", note: "", isNew: false },
  { id: 26, title: "Cloudflare Workers KV versus D1", link: "https://developers.cloudflare.com/workers/platform/storage-options/", domain: "developers.cloudflare.com", folder: 1, tags: ["cloudflare", "database"], created: "2026-08-30T14:00:00", visits: 2, lastVisit: "2026-08-30T14:05:00", excerpt: "KV is eventually consistent and read-heavy. D1 is SQLite with transactions. Pick by access pattern.", note: "", isNew: false },
  { id: 27, title: "Overnight oats, five ways", link: "https://cookieandkate.com/overnight-oats-recipe/", domain: "cookieandkate.com", folder: 6, tags: ["recipe", "breakfast"], created: "2026-08-25T07:20:00", visits: 0, lastVisit: null, excerpt: "A base ratio of oats to milk, then five flavour variations.", note: "", isNew: false },
  { id: 28, title: "Grid by Example", link: "https://gridbyexample.com/examples/", domain: "gridbyexample.com", folder: 2, tags: ["css", "grid"], created: "2026-08-20T16:35:00", visits: 10, lastVisit: "2026-10-08T10:00:00", excerpt: "Small, copyable examples of CSS Grid layouts, from the basics to named areas.", note: "", isNew: false },
  { id: 29, title: "Expense tracking in a plain spreadsheet", link: "https://www.example.org/expense-sheet", domain: "example.org", folder: -1, tags: [], created: "2026-08-15T12:00:00", visits: 0, lastVisit: null, excerpt: "One sheet, three columns: date, amount, category. A pivot table does the rest.", note: "", isNew: false },
  { id: 30, title: "SSH certificates with step-ca", link: "https://smallstep.com/docs/step-ca/", domain: "smallstep.com", folder: 4, tags: ["ssh", "security"], created: "2026-08-10T10:00:00", visits: 2, lastVisit: "2026-08-10T10:30:00", excerpt: "Issue short-lived SSH certificates from a private CA instead of copying public keys to each host.", note: "", isNew: false },
  { id: 31, title: "JavaScript Temporal API primer", link: "https://tc39.es/proposal-temporal/docs/", domain: "tc39.es", folder: 1, tags: ["javascript", "dates"], created: "2026-08-02T18:30:00", visits: 5, lastVisit: "2026-09-01T18:30:00", excerpt: "Temporal replaces Date with immutable types for instants, plain dates and zoned date-times.", note: "", isNew: false },
  { id: 32, title: "Capital gains tax in Israel: FAQ", link: "https://www.gov.il/en/departments/faq/capital-gains", domain: "gov.il", folder: 3, tags: ["tax", "israel"], created: "2026-07-20T09:00:00", visits: 1, lastVisit: "2026-07-20T09:10:00", excerpt: "Rates, exemptions and the reporting deadline for the sale of securities.", note: "", isNew: false },
  { id: 33, title: "Chicken shawarma, oven method", link: "https://www.recipetineats.com/chicken-sharwama-middle-eastern/", domain: "recipetineats.com", folder: 6, tags: ["recipe", "dinner"], created: "2026-07-12T19:00:00", visits: 3, lastVisit: "2026-09-18T18:00:00", excerpt: "A yoghurt and spice marinade, then a hot oven. Serve with pita and pickles.", note: "", isNew: false },
  { id: 34, title: "Postgres versus SQLite for small apps", link: "https://blog.example.dev/postgres-vs-sqlite", domain: "blog.example.dev", folder: 5, tags: ["sqlite", "postgres", "essay"], created: "2026-06-30T22:15:00", visits: 4, lastVisit: "2026-07-02T22:00:00", excerpt: "For one server and one writer, SQLite removes a whole service from the stack.", note: "", isNew: false },
  { id: 35, title: "Uptime Kuma", link: "https://github.com/louislam/uptime-kuma", domain: "github.com", folder: 4, tags: ["monitoring", "docker"], created: "2026-06-10T11:40:00", visits: 6, lastVisit: "2026-10-01T11:00:00", excerpt: "A self-hosted monitoring tool with status pages and notifications.", note: "", isNew: false },
  { id: 36, title: "Design Tokens Community Group: format draft", link: "https://tr.designtokens.org/format/", domain: "tr.designtokens.org", folder: 2, tags: ["design-tokens", "css"], created: "2026-05-22T15:00:00", visits: 2, lastVisit: "2026-05-22T15:20:00", excerpt: "A JSON format for colour, dimension and typography tokens that tools can exchange.", note: "", isNew: false },
  { id: 37, title: "The Twelve-Factor App", link: "https://12factor.net/", domain: "12factor.net", folder: 5, tags: ["architecture"], created: "2026-04-15T20:00:00", visits: 11, lastVisit: "2026-09-29T20:00:00", excerpt: "Twelve principles for apps that deploy cleanly: config in the environment, stateless processes, logs as streams.", note: "", isNew: false },
  { id: 38, title: "Tahini cookies", link: "https://www.ottolenghi.co.uk/recipes/tahini-cookies", domain: "ottolenghi.co.uk", folder: 6, tags: ["recipe", "baking"], created: "2026-03-08T16:00:00", visits: 1, lastVisit: "2026-03-08T16:05:00", excerpt: "Soft, nutty cookies with tahini in the dough and sesame seeds on top.", note: "", isNew: false },
  { id: 39, title: "Flask to FastAPI migration notes", link: "https://www.example.io/flask-to-fastapi", domain: "example.io", folder: -1, tags: ["python"], created: "2026-02-14T10:30:00", visits: 0, lastVisit: null, excerpt: "Routes, dependency injection and Pydantic models, mapped one to one.", note: "", isNew: false },
  { id: 40, title: "Bash strict mode", link: "http://redsymbol.net/articles/unofficial-bash-strict-mode/", domain: "redsymbol.net", folder: 1, tags: ["bash"], created: "2025-11-20T09:00:00", visits: 9, lastVisit: "2026-10-05T09:00:00", excerpt: "set -euo pipefail, and what each flag protects you from.", note: "", isNew: false },
  { id: 41, title: "Keyboard shortcuts for Raindrop", link: "https://help.raindrop.io/shortcuts", domain: "help.raindrop.io", folder: -1, tags: [], created: "2026-10-16T15:33:00", visits: 0, lastVisit: null, excerpt: "Every shortcut in the web app and the desktop app.", note: "", isNew: true },
  { id: 42, title: "Hetzner price list 2026", link: "https://www.hetzner.com/cloud/pricing", domain: "hetzner.com", folder: 3, tags: ["hetzner", "pricing"], created: "2026-10-11T08:00:00", visits: 2, lastVisit: "2026-10-11T08:05:00", excerpt: "Cloud, dedicated and storage prices by location.", note: "", isNew: false },
];

// Date and time in the user's local time, for example "17 Oct 2026, 13:05".
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

// Age text per section 5.3 of docs/ui-elements.md.
function ageText(iso) {
  const ms = NOW - new Date(iso);
  const min = Math.max(1, Math.floor(ms / 60000));
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 21) return `${d} day${d === 1 ? "" : "s"} ago`;
  if (d < 183) { const w = Math.floor(d / 7); return `${w} week${w === 1 ? "" : "s"} ago`; }
  return "more than 6 months ago";
}

function visitText(b) {
  return b.visits > 0 ? `visited ${b.visits}× (last ${fmtDate(b.lastVisit)})` : "not visited";
}

function folderName(id) {
  const f = FOLDERS.find(f => f.id === id);
  return f ? f.name : "Unsorted";
}

function needsSort(b) {
  return b.folder === -1 || b.tags.length === 0;
}

// Start of the local day, n days before today.
function dayStart(daysBack) {
  const d = new Date(NOW); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysBack); return d;
}

function presetRange(preset, from, to) {
  if (preset === "today") return [dayStart(0), null];
  if (preset === "last7") return [dayStart(6), null];
  if (preset === "last30") return [dayStart(29), null];
  if (preset === "custom") {
    const a = from ? new Date(from + "T00:00:00") : null;
    const b = to ? new Date(to + "T23:59:59") : null;
    return [a, b];
  }
  return [null, null];
}

// Filter rules from sections 4.3 to 4.11. f = { q, folder, tags, status, visited, preset, from, to }.
function matches(b, f) {
  const words = (f.q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay = [b.title, b.excerpt, b.note, b.link, b.domain, b.tags.join(" "), folderName(b.folder)].join(" ").toLowerCase();
    if (!words.every(w => hay.includes(w))) return false;
  }
  if (f.folder !== undefined && f.folder !== null && f.folder !== "" && b.folder !== Number(f.folder)) return false;
  const tags = (f.tags || []).map(t => t.toLowerCase()).filter(Boolean);
  if (tags.length && !tags.every(t => b.tags.map(x => x.toLowerCase()).includes(t))) return false;
  if (f.status === "new" && !b.isNew) return false;
  if (f.status === "needs" && !needsSort(b)) return false;
  if (f.visited === "yes" && b.visits === 0) return false;
  if (f.visited === "no" && b.visits > 0) return false;
  const [from, to] = presetRange(f.preset, f.from, f.to);
  const c = new Date(b.created);
  if (from && c < from) return false;
  if (to && c > to) return false;
  return true;
}

function sortBookmarks(list, sort) {
  const byNewest = (a, b) => b.created.localeCompare(a.created);
  const copy = list.slice();
  switch (sort) {
    case "oldest": return copy.sort((a, b) => a.created.localeCompare(b.created));
    case "az": return copy.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    case "za": return copy.sort((a, b) => b.title.localeCompare(a.title, undefined, { sensitivity: "base" }));
    case "folder": return copy.sort((a, b) => folderName(a.folder).localeCompare(folderName(b.folder)) || byNewest(a, b));
    case "visits": return copy.sort((a, b) => b.visits - a.visits || byNewest(a, b));
    default: return copy.sort(byNewest);
  }
}

// Counts that ignore the other filters (section 2).
function presetCounts() {
  const out = {};
  for (const p of ["all", "today", "last7", "last30"]) out[p] = BOOKMARKS.filter(b => matches(b, { preset: p })).length;
  return out;
}
function folderCounts() {
  const out = {};
  for (const f of FOLDERS) out[f.id] = BOOKMARKS.filter(b => b.folder === f.id).length;
  return out;
}
function tagCounts() {
  const out = {};
  for (const b of BOOKMARKS) for (const t of b.tags) out[t] = (out[t] || 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
