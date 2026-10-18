#!/usr/bin/env node
/* Tacilytics — privacy-first, cookieless analytics for web and apps.
   (tacit: we count, we don't tell.)
   Express + better-sqlite3. No cookies, no cross-site tracking, IPs never stored
   (only a daily, salted, one-way visitor hash). Region is inferred from the
   browser timezone, never from IP geolocation. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

// ── tiny .env loader (no dep) ───────────────────────────────────────────────
// Reads .env from the current directory first (npm/npx installs), then next to server.js (git checkout).
for (const dir of [...new Set([process.cwd(), __dirname])]) {
  try {
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const PORT = parseInt(process.env.PORT) || 3920;
// Bind address. Default loopback (put TLS in front); the Docker image sets HOST=0.0.0.0 inside the container.
const HOST = process.env.HOST || '127.0.0.1';
const WEB_PASSWORD = process.env.WEB_PASSWORD || 'tacilytics';
const API_KEY = process.env.API_KEY || ''; // for agents / CLI (Bearer token)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');
const INGEST_SALT = process.env.INGEST_SALT || 'tacilytics-salt'; // set your own in .env — changing it splits today's visitors
// Git checkout: data/ next to server.js (as always). npm install: data/ in the directory you start from,
// never inside node_modules (an update would wipe it).
const INSIDE_NODE_MODULES = __dirname.split(path.sep).includes('node_modules');
const DB_PATH = process.env.DB_PATH || path.join(INSIDE_NODE_MODULES ? process.cwd() : __dirname, 'data', 'analytics.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!process.env.WEB_PASSWORD) console.warn('⚠ WEB_PASSWORD is not set — the dashboard uses the default passphrase "tacilytics". Set your own in .env.');
// Webhook for the daily digest and the default alerts (Discord/Slack-compatible).
const DIGEST_WEBHOOK_URL = /^(off|none|false|0)$/i.test(process.env.DIGEST_WEBHOOK_URL || '') ? '' : (process.env.DIGEST_WEBHOOK_URL || ''); // 'off' disables it (an empty value would be refilled from .env)
const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS, 10) || 0; // 0 = keep forever; >0 purges older raw events (data minimisation)

// ── DB ──────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    name TEXT,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    day TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT,
    referrer TEXT,
    country TEXT,
    tz TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    lang TEXT,
    name TEXT,
    vh TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site_id, ts);
  CREATE INDEX IF NOT EXISTS idx_events_site_day ON events(site_id, day);
  CREATE INDEX IF NOT EXISTS idx_events_vh ON events(site_id, vh, day);
`);
// additive migrations: each column is added once for installs created before it existed.
function ensureColumn(name, decl) {
  if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${decl}`);
}
ensureColumn('name', 'TEXT'); // custom-event / goal name
ensureColumn('utm_medium', 'TEXT'); // campaign medium (utm_medium)
ensureColumn('utm_campaign', 'TEXT'); // campaign name (utm_campaign)
ensureColumn('dur', 'INTEGER'); // engagement seconds (set by a follow-up beacon on page leave)
ensureColumn('props', 'TEXT'); // custom event properties, JSON object as text
ensureColumn('scroll', 'INTEGER'); // max scroll depth in % (set by the engagement beacon)
ensureColumn('platform', 'TEXT'); // NULL = web (tracker script); native SDKs send android / ios / …
ensureColumn('app_version', 'TEXT'); // app build reported by native SDKs, NULL for web

// share links + funnels live in their own small tables (additive, safe on old installs)
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,
    site_id INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  -- visitors that touched an internal path (CMS preview etc.) are skipped for the rest of that day
  CREATE TABLE IF NOT EXISTS internal_vh (
    site_id INTEGER NOT NULL,
    vh TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (site_id, vh, day)
  );
  CREATE TABLE IF NOT EXISTS funnels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    steps TEXT NOT NULL, -- JSON array of {type:'page'|'goal', value}
    created INTEGER NOT NULL
  );
  -- imported history (Plausible / Google Analytics): daily aggregates, never visitor rows
  CREATE TABLE IF NOT EXISTS imported (
    import_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    dim TEXT NOT NULL,          -- '' totals · page · source · country · browser · os · device · event
    name TEXT NOT NULL,
    visitors INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    visits INTEGER NOT NULL DEFAULT 0,
    bounces INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_imported_site_dim_day ON imported(site_id, dim, day);
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    source TEXT NOT NULL,       -- 'plausible' | 'ga'
    first_day TEXT, last_day TEXT,
    rows INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    files TEXT,
    created_by TEXT,
    created INTEGER NOT NULL
  );
  -- chart annotations ("Newsletter sent", "Release 2.0") — one calendar day each
  CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    day TEXT NOT NULL,          -- YYYY-MM-DD (UTC, like events.day)
    text TEXT NOT NULL,
    created_by TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_annotations_site_day ON annotations(site_id, day);
`);

const norm = (d) => String(d || '').toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '').trim();
// per-site time zone (Fabian): only query boundaries move, stored days stay UTC (Tyto). Old installs → 'UTC'.
if (!db.prepare('PRAGMA table_info(sites)').all().some((c) => c.name === 'timezone')) db.exec("ALTER TABLE sites ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
// paused sites collect nothing (hosting: trial over / subscription ended). Only an unlimited admin or owner can pause.
if (!db.prepare('PRAGMA table_info(sites)').all().some((c) => c.name === 'paused')) db.exec('ALTER TABLE sites ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
const getSiteByDomain = db.prepare('SELECT * FROM sites WHERE domain = ?');
const insSite = db.prepare("INSERT OR IGNORE INTO sites (domain, name, created, timezone) VALUES (?, ?, ?, COALESCE(?, 'UTC'))");
const allSites = db.prepare('SELECT * FROM sites ORDER BY domain');
const insEvent = db.prepare(`INSERT INTO events (site_id, ts, day, path, source, referrer, country, tz, browser, os, device, lang, name, utm_medium, utm_campaign, dur, props, vh, platform, app_version)
  VALUES (@site_id, @ts, @day, @path, @source, @referrer, @country, @tz, @browser, @os, @device, @lang, @name, @utm_medium, @utm_campaign, @dur, @props, @vh, @platform, @app_version)`);
// visit source (2.5): like GA/Plausible/Matomo, the source belongs to the VISIT, not to each page view.
// A page view without an third-party referrer and without UTM (an internal click, a reload) inherits the
// source of the same visitor's previous page view within 30 minutes. Server-side only (visitor hash),
// so strict mode reads nothing new on the device.
const VISIT_GAP = 30 * 60000;
const lastSource = db.prepare('SELECT source FROM events WHERE site_id = ? AND vh = ? AND name IS NULL AND ts >= ? ORDER BY id DESC LIMIT 1');
function visitSource(siteId, vh, ts, utm, referrer, domain) {
  if (utm) return utm;
  if (referrer) {
    try { const h = norm(new URL(referrer).hostname); if (h && h !== domain) return h; } catch {}
  }
  const prev = lastSource.get(siteId, vh, ts - VISIT_GAP);
  return (prev && prev.source) || 'Direct';
}
// engagement: attach a visit duration (seconds) to the visitor's most recent pageview for that path.
const updDur = db.prepare(`UPDATE events SET dur = MAX(COALESCE(dur, 0), @dur), scroll = CASE WHEN @scroll IS NULL THEN scroll ELSE MAX(COALESCE(scroll, 0), @scroll) END WHERE id = (
  SELECT id FROM events WHERE site_id = @site_id AND vh = @vh AND name IS NULL AND path = @path AND ts >= @since
  ORDER BY id DESC LIMIT 1)`);

// ── internal traffic (13.10.2026) ────────────────────────────────────────────
// Paths that only the shop team opens (CMS preview, admin). A visitor who hits one is
// treated as internal for the rest of that day and no longer counted. Per-domain list,
// extend via INTERNAL_PATHS="domain:/prefix,domain:/prefix2".
const INTERNAL_PATHS = { 'pastaclean.tv': ['/rhweb/', '/admin', '/widgets/'] };
for (const part of String(process.env.INTERNAL_PATHS || '').split(',')) {
  const [d, pre] = part.split(':');
  if (d && pre) (INTERNAL_PATHS[d.trim()] || (INTERNAL_PATHS[d.trim()] = [])).push(pre.trim());
}
function backfillInternal() {
  for (const [d, prefixes] of Object.entries(INTERNAL_PATHS)) {
    const site = db.prepare('SELECT id FROM sites WHERE domain = ?').get(d);
    if (!site) continue;
    for (const pre of prefixes) {
      db.prepare(`INSERT OR IGNORE INTO internal_vh (site_id, vh, day) SELECT DISTINCT site_id, vh, day FROM events WHERE site_id = ? AND path >= ? AND path < ?`).run(site.id, pre, pre + '\uffff');
    }
  }
}
const insInternal = db.prepare('INSERT OR IGNORE INTO internal_vh (site_id, vh, day) VALUES (?, ?, ?)');
const isInternal = db.prepare('SELECT 1 FROM internal_vh WHERE site_id = ? AND vh = ? AND day = ?');

// ── payment providers (13.10.2026) ───────────────────────────────────────────
// Customers coming back from PayPal/Klarna are not a traffic source. Raw rows keep the
// host (no data loss); the sources panel hides them and shows them as a separate note.
const PAYMENT_HOSTS = ['paypal.com', 'klarna.com', 'js.klarna.com', 'x.klarnacdn.net', 'mollie.com', 'pay.amazon.com', 'payments.amazon.de', 'payments.amazon.com', 'stripe.com', 'checkout.stripe.com', 'sofort.com', 'giropay.de', 'paydirekt.de', 'ideal.nl', 'pay.google.com', 'unzer.com', 'computop-paygate.com', 'secure.ogone.com', 'ratepay.com', 'pay.payone.com', 'mollie.ideal.nl'];
backfillInternal();
const PAYMENT_SQL = PAYMENT_HOSTS.map(() => '?').join(',');
function isPaymentHost(h) { return PAYMENT_HOSTS.includes(h) || /(^|\.)(paypal|klarna|mollie|stripe|sofort|giropay|unzer|ratepay|payone)\./.test(h); }

// Custom event properties stay developer-defined and small — never a place for PII to pile up.
function sanitizeProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(raw)) {
    if (n++ >= 12) break; // cap key count
    const key = String(k).slice(0, 40).trim();
    if (!key) continue;
    const v = raw[k];
    if (v == null || typeof v === 'object') continue; // scalars only
    out[key] = String(v).slice(0, 80);
  }
  const keys = Object.keys(out);
  if (!keys.length) return null;
  const json = JSON.stringify(out);
  return json.length > 800 ? null : json; // hard cap on total size
}

// ── native apps (13.10.2026) ────────────────────────────────────────────────
// Apps send the same beacon as the web tracker plus `pf` (platform) and optionally `av`
// (app version), `dv` (mobile|tablet) and `cc` (2-letter region of the device locale, used
// only when the timezone gives no country). Web rows keep platform NULL, so old data is web.
const APP_PLATFORMS = { android: 'Android', ios: 'iOS', ipados: 'iOS', macos: 'macOS', windows: 'Windows', linux: 'Linux' };
const PLATFORM_SQL = "COALESCE(platform, 'web')";
function appPlatform(b) {
  const pf = String(b.pf || b.platform || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(APP_PLATFORMS, pf) ? (pf === 'ipados' ? 'ios' : pf) : null;
}

// ── UA parsing + bot filter ─────────────────────────────────────────────────
const BOT_RE = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternal|embedly|quora|pinterest|slackbot|telegrambot|whatsapp|twitter|discordbot|preview|monitor|uptime|pingdom|lighthouse|headless|phantom|curl|wget|python-requests|axios|node-fetch|go-http/i;
function parseUA(ua) {
  ua = ua || '';
  if (!ua || BOT_RE.test(ua)) return null; // drop bots/crawlers entirely
  let browser = 'Other', os = 'Other', device = 'Desktop';
  if (/iPad/i.test(ua) || (/Tablet/i.test(ua) && !/Mobile/i.test(ua))) device = 'Tablet';
  else if (/Mobi|Android|iPhone|iPod/i.test(ua)) device = 'Mobile';
  if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(ua)) browser = 'Samsung';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';
  return { browser, os, device };
}

// Rough timezone → ISO country (privacy-preserving alternative to IP geo).
const TZ_COUNTRY = require('./tz-country.js');
// first language of an Accept-Language header ("de-DE,de;q=0.9,en;q=0.8" → "de-DE"), or null
function acceptLang(h) {
  const m = String(h || '').split(',')[0].split(';')[0].trim().match(/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})?$/);
  return m ? m[0].slice(0, 12) : null;
}
function countryFromTz(tz) { return (tz && TZ_COUNTRY[tz]) || null; }

const { createDaySalt, dayStr } = require('./day-salt.js');
// Daily salt: fresh random secret per UTC day in data/.day-salt (0600), never in the DB.
// Rules and the single-process note live in day-salt.js.
const SALT_FILE = path.join(path.dirname(DB_PATH), '.day-salt');
const todaysSalt = createDaySalt(SALT_FILE);
// one-time cleanup of the short-lived DB table from 03934ed: zero the pages, flush the WAL
db.pragma('secure_delete = ON');
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_salt'").get()) {
  db.exec('DELETE FROM daily_salt; DROP TABLE daily_salt;');
  db.pragma('wal_checkpoint(TRUNCATE)');
}
function visitorHash(siteId, ip, ua, day) {
  const salt = day === dayStr(Date.now()) ? todaysSalt() : null;
  if (!salt) return crypto.randomBytes(12).toString('hex'); // unlinkable one-off visitor
  return crypto.createHash('sha256').update(`${INGEST_SALT}|${salt}|${day}|${siteId}|${ip}|${ua}`).digest('hex').slice(0, 24);
}
// The client writes the FIRST X-Forwarded-For entry itself, so it must never be used for rate limits.
// req.ip honours 'trust proxy': with TRUST_PROXY=1 (default, one reverse proxy in front) it is the
// entry that proxy appended. Set TRUST_PROXY=0 when the server is reachable without a proxy.
function clientIp(req) {
  return req.ip || req.socket.remoteAddress || '0.0.0.0';
}

// ── app ─────────────────────────────────────────────────────────────────────
const app = express();
const TRUST_PROXY = Number.isFinite(+process.env.TRUST_PROXY) && process.env.TRUST_PROXY !== '' && process.env.TRUST_PROXY != null ? +process.env.TRUST_PROXY : 1;
app.set('trust proxy', TRUST_PROXY);
// A real HTTP proxy always appends X-Forwarded-For. A request without it means something else
// (socat, ssh -L, a TCP forwarder) is in front: then the last XFF entry is client-written and the
// limits can be bypassed. Normal visitors never send XFF themselves, so they trigger this; an
// attacker who forges XFF does not, but the warning is already in the log by then. Warn once.
let warnedNoXff = false;
if (TRUST_PROXY > 0) {
  app.use((req, _res, next) => {
    if (!warnedNoXff && !req.headers['x-forwarded-for']) {
      warnedNoXff = true;
      console.warn(`⚠️  TRUST_PROXY=${TRUST_PROXY}, but a request arrived without X-Forwarded-For (from ${req.socket.remoteAddress}, ${req.method} ${req.path}, ${new Date().toISOString()}). Harmless for local health checks/CLI or an ssh -L to the dashboard. Only if ALL traffic comes through a TCP forwarder (socat, ssh -L), set TRUST_PROXY=0.`);
    }
    next();
  });
}
// Accept both application/json (dashboard) and text/plain (cross-origin beacons).
// /api/imports takes raw files (handled there); everything else is JSON (text/plain = cross-origin beacons)
const jsonBody = express.json({ limit: '32kb', type: ['application/json', 'text/plain'] });
app.use((req, res, next) => (req.path === '/api/imports' ? next() : jsonBody(req, res, next)));
app.disable('x-powered-by');

// Lightweight in-memory rate limiter (fixed window per key). No external dep.
const rl = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  let e = rl.get(key);
  if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; rl.set(key, e); }
  e.n++;
  return e.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rl) if (v.reset < now) rl.delete(k); }, 60000).unref();

// ── tracking script (served with permissive CORS so any site can embed) ──────
const TRACKER = fs.readFileSync(path.join(__dirname, 'public', 'tacilytics.js'), 'utf8');
// /nyx.js stays as an alias: sites embedded before the rename keep working unchanged.
app.get(['/tacilytics.js', '/nyx.js'], (_req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(TRACKER);
});

// ── collection endpoint ─────────────────────────────────────────────────────
function collect(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  // flood / stat-poisoning guard: cap events per IP per minute (legit SPA bursts fit easily)
  if (rateLimited('c:' + clientIp(req), 600, 60000)) return res.status(204).end();
  const b = req.method === 'GET' ? req.query : (req.body || {});
  const domain = norm(b.d || b.domain);
  if (!domain) return res.status(204).end();
  const site = getSiteByDomain.get(domain);
  if (!site || site.paused) return res.status(202).end(); // unknown or paused site → silently ignore
  const platform = appPlatform(b);
  // apps: the HTTP client's user agent says nothing about the device, so OS/device come from the beacon.
  // A bot-looking UA is still dropped, so the bot filter cannot be bypassed by just adding `pf`.
  const rawUa = req.headers['user-agent'] || '';
  let ua = parseUA(rawUa);
  if (platform && rawUa && !BOT_RE.test(rawUa)) {
    const dv = String(b.dv || '').toLowerCase();
    ua = { browser: 'App', os: APP_PLATFORMS[platform], device: dv === 'tablet' ? 'Tablet' : dv === 'desktop' ? 'Desktop' : (platform === 'android' || platform === 'ios') ? 'Mobile' : 'Desktop' };
  }
  if (!ua) return res.status(204).end(); // bot
  // strict mode (data-strict): the tracker read nothing on the device. Privacy signals and language come
  // from headers the browser sends with every request anyway.
  const strict = String(b.st || '') === '1';
  if (strict && String(b.hd || '') === '1' && (req.headers['dnt'] === '1' || req.headers['sec-gpc'] === '1')) return res.status(204).end();

  const ts = Date.now();
  const day = dayStr(ts);
  let pth = String(b.p || b.path || '/').slice(0, 512);
  try { pth = decodeURI(pth); } catch {}
  if (pth.length > 1) pth = pth.replace(/\/+$/, '') || '/';
  const ip = clientIp(req);
  // apps may send `sid`: a random id the SDK draws per app launch and never persists (no device id).
  // Mobile carriers put many phones behind one IP, so IP+UA alone would merge app users.
  const sid = platform ? String(b.sid || '').slice(0, 64) : '';
  const vh = sid && /^[A-Za-z0-9_-]{16,64}$/.test(sid)
    ? visitorHash(site.id, 'app:' + sid, platform, day)
    : visitorHash(site.id, ip, req.headers['user-agent'] || '', day);

  // internal visitor (CMS preview etc.): mark for the day and drop everything from them.
  const intern = INTERNAL_PATHS[domain] || [];
  if (intern.some((pre) => pth.startsWith(pre))) { insInternal.run(site.id, vh, day); return res.status(204).end(); }
  if (isInternal.get(site.id, vh, day)) return res.status(204).end();

  // engagement beacon: attach a visit duration (+ max scroll depth) to the visitor's latest pageview (no new row).
  if (b.e === 'engagement') {
    const dur = Math.max(0, Math.min(7200, parseInt(b.dur, 10) || 0)); // cap at 2h
    const sc = strict || b.sc == null || b.sc === '' ? null : Math.max(0, Math.min(100, parseInt(b.sc, 10) || 0));
    if (dur > 0 || sc != null) updDur.run({ site_id: site.id, vh, path: pth, dur, scroll: sc, since: ts - 6 * 3600000 });
    return res.status(204).end();
  }

  // referrer → source host
  let referrer = String(b.r || b.referrer || '').slice(0, 512);
  const utm = String(b.s || b.utm || '').slice(0, 60);
  const source = visitSource(site.id, vh, ts, utm, referrer, domain);
  const utmMedium = String(b.um || b.utm_medium || '').slice(0, 60).trim() || null;
  const utmCampaign = String(b.uc || b.utm_campaign || '').slice(0, 80).trim() || null;
  const tz = strict ? null : (String(b.tz || '').slice(0, 60) || null);
  const lang = strict ? acceptLang(req.headers['accept-language']) : (String(b.l || b.lang || '').slice(0, 12).split(',')[0] || null);
  const name = String(b.n || b.name || '').slice(0, 80).trim() || null; // custom event / goal
  const props = name ? sanitizeProps(b.pr) : null; // properties only attach to named events
  let country = countryFromTz(tz);
  if (!country && platform) { const cc = String(b.cc || '').toUpperCase(); if (/^[A-Z]{2}$/.test(cc)) country = cc; }
  const appVersion = platform ? (String(b.av || '').slice(0, 32).trim() || null) : null;
  insEvent.run({
    site_id: site.id, ts, day, path: pth, source, referrer: referrer || null,
    country, tz, browser: ua.browser, os: ua.os, device: ua.device,
    lang, name, utm_medium: utmMedium, utm_campaign: utmCampaign, dur: null, props, vh,
    platform, app_version: appVersion,
  });
  res.status(204).end();
}
app.options('/api/collect', (_req, res) => { res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').status(204).end(); });
app.post('/api/collect', collect);
app.get('/api/collect', collect);

// ── auth: accounts, team, optional 2FA + passkeys (auth.js) ───────────────────
const { setupAuth } = require('./auth');
const { auth, requireRole, siteAllowed, audit, grantSite, isLimited } = setupAuth({
  app, db, WEB_PASSWORD, API_KEY, rateLimited, clientIp,
  allSiteIds: () => db.prepare('SELECT id FROM sites').all().map((r) => r.id),
});
const adminOnly = requireRole('admin');
const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };

// share-token auth: read-only stats access scoped to exactly one site.
// Accepted as ?share=<token>; the handler must check siteOk(req, site).
const getShare = db.prepare('SELECT * FROM shares WHERE token = ?');
function authOrShare(req, res, next) {
  const tok = String(req.query.share || '');
  if (/^[a-f0-9]{32,64}$/.test(tok)) {
    const sh = getShare.get(tok);
    if (sh) { req.shareSiteId = sh.site_id; return next(); }
  }
  return auth(req, res, next);
}
// share links see exactly their site; viewers only the sites they were given
const siteOk = (req, site) => siteAllowed(req, site.id);
const NO_SITE = { error: 'You have no access to this site' };
function newToken() { return crypto.randomBytes(24).toString('hex'); }

// ── sites management ─────────────────────────────────────────────────────────
const sitesListHandler = (req, res) => res.json(allSites.all().filter((st) => siteAllowed(req, st.id)));
const sitesCreateHandler = (req, res) => {
  // a site-limited account (a hosting customer) never creates sites itself: the operator does, because sites are what
  // is billed and paused. Otherwise a paused customer could add a fresh, unpaused site and move the snippet (Kiro, 2.3.0).
  if (isLimited(req)) return res.status(403).json({ error: 'Your role does not allow this' });
  const rawDomain = norm(req.body && req.body.domain);
  let domain = rawDomain;
  let displayName = rawDomain; // keep Unicode original for a readable display name (e.g. ernährungs-plan.de)
  // IDN support: convert Unicode/umlaut domains to Punycode (stored), keep Unicode as display name
  if (domain && /[^\x00-\x7F]/.test(domain)) {
    try { domain = new URL('http://' + domain).hostname; } catch (_) { /* fall through to validation */ }
  }
  // Allow ASCII domains AND Punycode (xn--...). Unicode input was converted above.
  if (!domain || !/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return res.status(400).json({ error: 'Enter a valid domain, e.g. example.com' });
  const rawTz = req.body && req.body.timezone;
  const timezone = rawTz == null || rawTz === '' ? null : TZ.validTz(String(rawTz));
  if (rawTz != null && rawTz !== '' && !timezone) return res.status(400).json({ error: 'Unknown time zone' });
  const existing = getSiteByDomain.get(domain);
  if (existing) {
    // an account limited to some sites must never get a foreign site back (or added to its list) by naming its domain
    if (!siteAllowed(req, existing.id)) return res.status(409).json({ error: 'This domain is already registered' });
    return res.json(existing);
  }
  const info = insSite.run(domain, (req.body && req.body.name) || displayName, Date.now(), timezone);
  // defensive: if INSERT OR IGNORE did nothing (e.g. a second process sharing the DB won the domain), lastInsertRowid is
  // stale and must never be granted. Not reachable over HTTP in one process (the handler is synchronous), so no test.
  if (!info.changes) return res.status(409).json({ error: 'This domain is already registered' });
  grantSite(req, Number(info.lastInsertRowid));
  audit(res, 'site.add', domain);
  res.json(getSiteByDomain.get(domain));
};
app.get('/api/sites', auth, sitesListHandler);
app.post('/api/sites', adminOnly, sitesCreateHandler);
// change a site's time zone (IANA names only — anything Intl rejects is a 400, never stored)
app.patch('/api/sites/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!siteAllowed(req, id)) return res.status(403).json(NO_SITE);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  const b = req.body || {};
  if (b.paused !== undefined) {
    // pausing is the operator's switch (hosting: trial or subscription ended), never the customer's
    if (isLimited(req)) return res.status(403).json({ error: 'Your role does not allow this' });
    const paused = b.paused ? 1 : 0;
    db.prepare('UPDATE sites SET paused = ? WHERE id = ?').run(paused, id);
    if (paused !== site.paused) audit(res, paused ? 'site.pause' : 'site.resume', site.domain);
  }
  if (b.timezone !== undefined || b.paused === undefined) {
    const timezone = TZ.validTz(String(b.timezone || ''));
    if (!timezone) return res.status(400).json({ error: 'Unknown time zone' });
    db.prepare('UPDATE sites SET timezone = ? WHERE id = ?').run(timezone, id);
    if (timezone !== site.timezone) audit(res, 'site.timezone', site.domain + ': ' + site.timezone + ' → ' + timezone);
  }
  res.json(db.prepare('SELECT * FROM sites WHERE id = ?').get(id));
});
app.delete('/api/sites/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!siteAllowed(req, id)) return res.status(403).json(NO_SITE);
  // hard delete frees the domain and resets usage: only the operator (unlimited admin/owner) may do it (Tyto/Kiro, 2.3.0)
  if (isLimited(req)) return res.status(403).json({ error: 'Your role does not allow this' });
  const gone = db.prepare('SELECT domain FROM sites WHERE id = ?').get(id);
  audit(res, 'site.remove', gone ? gone.domain : '#' + id);
  db.prepare('DELETE FROM events WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM annotations WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM alerts WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM imported WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM imports WHERE site_id = ?').run(id);
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── /api/v1 — stable agent/CLI surface (Authorization: Bearer <API_KEY>) ──────
app.get('/api/v1', (_req, res) => res.json({
  name: 'Tacilytics API', version: '1',
  auth: 'Authorization: Bearer <API_KEY>',
  endpoints: {
    'GET /api/v1/sites': 'list tracked sites',
    'POST /api/v1/sites': 'add a site { domain }',
    'GET /api/v1/stats?site=&period=': 'aggregated stats (period: today|7d|30d|90d|12mo, or from=YYYY-MM-DD&to=YYYY-MM-DD)',
    'GET /api/v1/realtime?site=': 'online count, last-30-min pulse + recent events',
    'GET /api/v1/usage?month=YYYY-MM': 'page views per site in a calendar month (UTC), owner / server key only',
    'POST /api/v1/hit': 'server mode: report a page view from your web server { domain, path, ip, ua, referrer?, lang?, purpose?, name? } (server-mode key)',
  },
  filters: 'add any of country,source,page,browser,os,device,lang,medium,campaign,goal to /stats to segment',
}));
app.get('/api/v1/sites', auth, sitesListHandler);
// page views per site in one calendar month (UTC), for hosting volume checks. Operator only:
// owners or the server API key with access to all sites, never a site-limited account.
app.get('/api/v1/usage', requireRole('owner'), (req, res) => {
  if (isLimited(req)) return res.status(403).json({ error: 'Your role does not allow this' });
  const m = String(req.query.month || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const from = Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 1), to = Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1);
  res.json(db.prepare('SELECT s.id site_id, s.domain, COUNT(e.id) pageviews FROM sites s LEFT JOIN events e ON e.site_id = s.id AND e.ts >= ? AND e.ts < ? AND e.name IS NULL GROUP BY s.id ORDER BY s.id').all(from, to));
});
app.post('/api/v1/sites', adminOnly, sitesCreateHandler);

// ── server mode (2.4): the website's own server reports a page view, no script on the visitor's device ──
// The site's backend forwards what the visitor's request carried anyway: path, Referer, Accept-Language,
// User-Agent and the visitor IP. The IP is only taken from an authenticated write key (never from the
// public /api/collect), otherwise anyone could feed arbitrary IPs into the visitor hash. It is hashed
// exactly like a tracker hit and never stored.
const net = require('net');
const PREFETCH_RE = /prefetch|prerender/i;
// Who may report: a server-mode key (scope 'hit', recommended, bound to its sites and good for nothing else), or —
// as in 2.4.0 — a key / sign-in with write access (admin role). A read-only key is a viewer and gets 403.
app.post('/api/v1/hit', auth, (req, res) => {
  const p = req.principal;
  if (p.kind !== 'hitkey' && ROLE_RANK[p.role] < ROLE_RANK.admin) return res.status(403).json({ error: 'Use a server-mode key (Settings → API keys)' });
  // per key, not per web-server IP: many sites behind one shared-hosting IP must not starve each other
  if (rateLimited('h:' + (p.keyId != null ? 'k' + p.keyId : p.kind + ':' + (p.user ? p.user.id : '')), 6000, 60000)) return res.status(429).json({ error: 'Too many hits' });
  const b = req.body || {};
  const domain = norm(b.domain || b.d);
  const site = domain && getSiteByDomain.get(domain);
  if (!site || !siteAllowed(req, site.id)) return res.status(404).json({ error: 'Unknown site' });
  if (site.paused) return res.status(202).end();
  const ip = String(b.ip || '').trim();
  // without the visitor IP every visitor would fall onto one hash: refuse instead of counting wrong
  if (!net.isIP(ip)) return res.status(400).json({ error: 'ip (the visitor IP) is required for server mode' });
  // prefetch / prerender requests are not visits (Sec-Purpose / Purpose header of the visitor request)
  if (PREFETCH_RE.test(String(b.purpose || ''))) return res.status(204).end();
  const rawUa = String(b.ua || '').slice(0, 512);
  const ua = parseUA(rawUa);
  if (!ua) return res.status(204).end(); // bot, crawler, monitor or no user agent
  if (b.dnt === true || b.dnt === '1' || b.gpc === true || b.gpc === '1') return res.status(204).end(); // forwarded DNT / GPC (opt-in on the sending side)

  const ts = Date.now();
  const day = dayStr(ts);
  let url;
  try { url = new URL(String(b.path || b.p || '/').slice(0, 1024), 'http://x'); } catch { return res.status(400).json({ error: 'invalid path' }); }
  let pth = url.pathname.slice(0, 512);
  try { pth = decodeURI(pth); } catch {}
  if (pth.length > 1) pth = pth.replace(/\/+$/, '') || '/';
  const vh = visitorHash(site.id, ip, rawUa, day);
  const intern = INTERNAL_PATHS[domain] || [];
  if (intern.some((pre) => pth.startsWith(pre))) { insInternal.run(site.id, vh, day); return res.status(204).end(); }
  if (isInternal.get(site.id, vh, day)) return res.status(204).end();

  const referrer = String(b.referrer || b.r || '').slice(0, 512);
  const q = url.searchParams;
  const utm = String(q.get('utm_source') || q.get('ref') || '').slice(0, 60).trim();
  const source = visitSource(site.id, vh, ts, utm, referrer, domain);
  const name = String(b.name || b.n || '').slice(0, 80).trim() || null; // optional server-side goal (e.g. Purchase)
  insEvent.run({
    site_id: site.id, ts, day, path: pth, source, referrer: referrer || null,
    country: null, tz: null, browser: ua.browser, os: ua.os, device: ua.device,
    lang: acceptLang(b.lang), name,
    utm_medium: String(q.get('utm_medium') || '').slice(0, 60).trim() || null,
    utm_campaign: String(q.get('utm_campaign') || '').slice(0, 80).trim() || null,
    dur: null, props: name ? sanitizeProps(b.props) : null, vh, platform: null, app_version: null,
  });
  res.status(204).end();
});

// ── stats ────────────────────────────────────────────────────────────────────
const TZ = require('./tz');
const PERIODS = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12mo': 365 };
// Whole LOCAL days of the site's time zone: "7d" = today + the 6 full days before it, each day with
// its own boundaries (23/25 h on DST days). Starting at now - 7×24h would cut the oldest day off at the
// current clock time and undercount it.
function rangeFor(query, tz) {
  tz = tz || 'UTC';
  const now = Date.now();
  const today = TZ.localDay(tz, now);
  // custom range: from/to are local YYYY-MM-DD (inclusive)
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
  if (isDay(query.from)) {
    let fromDay = query.from, toDay = isDay(query.to) ? query.to : query.from;
    if (toDay < fromDay) toDay = fromDay;
    const start = TZ.dayStart(tz, fromDay);
    const end = Math.max(start + 1, Math.min(now, TZ.dayStart(tz, TZ.addDays(toDay, 1))));
    const days = Math.max(1, Math.round((Date.parse(toDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 864e5) + 1);
    const lastDay = TZ.localDay(tz, end - 1) < toDay ? TZ.localDay(tz, end - 1) : toDay;
    return { start, end, days: Math.min(days, Math.round((Date.parse(lastDay + 'T00:00:00Z') - Date.parse(fromDay + 'T00:00:00Z')) / 864e5) + 1), period: 'custom', hourly: days <= 1, tz, fromDay, toDay: lastDay };
  }
  const period = PERIODS[query.period] ? query.period : '7d';
  const days = PERIODS[period];
  const fromDay = TZ.addDays(today, -(days - 1));
  return { start: TZ.dayStart(tz, fromDay), end: now, days, period, hourly: period === 'today', tz, fromDay, toDay: today };
}

// Whitelisted segmentation filters — click any breakdown row in the dashboard to drill in.
// Every value is bound as a parameter; only these exact column names are ever interpolated.
const FILTER_COLS = { country: 'country', source: 'source', page: 'path', browser: 'browser', os: 'os', device: 'device', lang: 'lang', medium: 'utm_medium', campaign: 'utm_campaign', platform: PLATFORM_SQL, version: 'app_version' };
function buildFilters(query) {
  const clauses = [], params = [];
  for (const key of Object.keys(FILTER_COLS)) {
    const v = query[key];
    if (v != null && v !== '') { clauses.push(`${FILTER_COLS[key]} = ?`); params.push(String(v).slice(0, 200)); }
  }
  const goal = query.goal != null && query.goal !== '' ? String(query.goal).slice(0, 80) : null;
  return { clauses, params, goal };
}

// Validated values only (whitelist / strict pattern), so they can be inlined into event queries.
function eventPlatformFilter(query) {
  let f = '';
  const pf = String(query.platform || '').toLowerCase();
  if (pf === 'web' || Object.prototype.hasOwnProperty.call(APP_PLATFORMS, pf)) f += ` AND ${PLATFORM_SQL} = '${pf}'`;
  const v = String(query.version || '');
  if (/^[A-Za-z0-9._+-]{1,32}$/.test(v)) f += ` AND app_version = '${v}'`;
  return f;
}

// name shown as "created by" (same wording as the activity log)
function whoDid(req) {
  const p = req.principal;
  if (!p) return null;
  if (p.kind === 'user') return p.user.username;
  if (p.kind === 'userkey') return p.user.username + ' (API key)';
  if (p.kind === 'apikey') return 'API key';
  if (p.kind === 'legacy') return 'passphrase';
  return null;
}

// ── imported history helpers ──
const firstNativeTs = db.prepare('SELECT MIN(ts) t FROM events WHERE site_id = ?');
// first LOCAL day with own data in the site's time zone (import boundary — shown in the import dialog too)
function firstOwnDay(site) { const t = firstNativeTs.get(site.id).t; return t == null ? null : TZ.localDay(site.timezone || 'UTC', t); }
function importedFor(siteId, start, end, filtered, tz) {
  const exists = !!db.prepare('SELECT 1 FROM imports WHERE site_id = ? LIMIT 1').get(siteId);
  const off = { exists, on: false, filtered: exists && filtered, tot: { pageviews: 0, visitors: 0 }, days: [], top: () => [], until: null };
  if (!exists || filtered) return off;
  // imported days count only before the first LOCAL day with own data (events.day is the UTC day)
  const firstTs = firstNativeTs.get(siteId).t;
  const first = firstTs == null ? null : TZ.localDay(tz, firstTs);
  // imported rows are calendar days of the source; they are matched against the site's local days
  const from = TZ.localDay(tz, start);
  const lastDay = TZ.localDay(tz, end - 1);
  const to = first && first <= lastDay ? TZ.addDays(first, -1) : lastDay;
  if (to < from) return { ...off, until: first };
  const days = db.prepare("SELECT day, SUM(visitors) visitors, SUM(pageviews) pageviews FROM imported WHERE site_id = ? AND dim = '' AND day >= ? AND day <= ? GROUP BY day").all(siteId, from, to);
  const tot = days.reduce((a, r) => ({ pageviews: a.pageviews + r.pageviews, visitors: a.visitors + r.visitors }), { pageviews: 0, visitors: 0 });
  const top = (dim) => db.prepare('SELECT name, SUM(pageviews) pageviews, SUM(visitors) visitors FROM imported WHERE site_id = ? AND dim = ? AND day >= ? AND day <= ? GROUP BY name ORDER BY visitors DESC, pageviews DESC LIMIT 200').all(siteId, dim, from, to);
  return { exists, on: days.length > 0, filtered: false, tot, days, top, until: first };
}
function mergeTop(native, imported, limit) {
  const m = new Map();
  for (const r of native) m.set(r.name, { name: r.name, pageviews: r.pageviews, visitors: r.visitors });
  for (const r of imported) { const e = m.get(r.name) || { name: r.name, pageviews: 0, visitors: 0 }; e.pageviews += r.pageviews; e.visitors += r.visitors; m.set(r.name, e); }
  return [...m.values()].sort((a, b) => b.visitors - a.visitors || b.pageviews - a.pageviews).slice(0, limit);
}

function statsHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const sid = site.id;
  const { start, end, days, period, hourly, tz, fromDay, toDay } = rangeFor(req.query, site.timezone);
  const { clauses, params, goal } = buildFilters(req.query);
  const evf = eventPlatformFilter(req.query); // platform/version also narrow event panels (revenue, search, 404)

  // pageview WHERE = time window + segmentation filters. A goal filter narrows the visitor
  // set to those who fired that event in-range (so every breakdown reflects converters only).
  let where = 'site_id = ? AND ts >= ? AND ts < ? AND name IS NULL AND NOT EXISTS (SELECT 1 FROM internal_vh i WHERE i.site_id = events.site_id AND i.vh = events.vh AND i.day = events.day)';
  const args = [sid, start, end, ...params];
  if (clauses.length) where += ' AND ' + clauses.join(' AND ');
  if (goal) { where += ' AND vh IN (SELECT vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = ?)'; args.push(sid, start, end, goal); }

  const totals = db.prepare(`SELECT COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where}`).get(...args);
  // imported history counts only for days before the site's first own event (no double counting)
  // and only without segment filters (imported data is pre-aggregated per single dimension).
  const imp = importedFor(sid, start, end, clauses.length > 0 || !!goal || !!evf, tz);
  if (imp.on) { totals.pageviews += imp.tot.pageviews; totals.visitors += imp.tot.visitors; }
  const bounceRow = db.prepare(`SELECT COUNT(*) AS bounced FROM (SELECT vh, COUNT(*) c FROM events WHERE ${where} GROUP BY vh HAVING c = 1)`).get(...args);
  const bounce = totals.visitors ? Math.round((bounceRow.bounced / totals.visitors) * 100) : 0;
  const viewsPerVisitor = totals.visitors ? +(totals.pageviews / totals.visitors).toFixed(1) : 0;
  const durRow = db.prepare(`SELECT AVG(dur) d FROM events WHERE ${where} AND dur IS NOT NULL`).get(...args);
  const duration = durRow && durRow.d != null ? Math.round(durRow.d) : null; // avg engaged seconds

  // trend vs the previous equal-length window (same filters)
  const len = end - start;
  const prevArgs = args.slice(); prevArgs[1] = start - len; prevArgs[2] = start;
  if (goal) { prevArgs[prevArgs.length - 3] = start - len; prevArgs[prevArgs.length - 2] = start; }
  const prev = db.prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT vh) visitors FROM events WHERE ${where}`).get(...prevArgs);
  if (imp.on) { const pi = importedFor(sid, start - len, start, false, tz); if (pi.on) { prev.pageviews += pi.tot.pageviews; prev.visitors += pi.tot.visitors; } }
  const pct = (cur, was) => (was ? Math.round(((cur - was) / was) * 100) : null);

  // time series (per hour for a single day, else per day)
  let series;
  if (hourly) {
    // one bucket per real hour of the local day (23 or 25 on DST days), labelled with the local
    // hour. Buckets start at local midnight, so +5:45 zones are not cut at UTC hours.
    const dayEnd = TZ.dayStart(tz, TZ.addDays(fromDay, 1));
    const rows = db.prepare(`SELECT CAST(((ts - ${Math.trunc(start)}) / 3600000) AS INT) AS bucket, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${where} GROUP BY bucket`).all(...args);
    const map = new Map(rows.map((r) => [r.bucket, r]));
    const n = Math.round((dayEnd - start) / 3600000);
    series = Array.from({ length: n }, (_, i) => {
      const r = map.get(i);
      const t = start + i * 3600000;
      const lab = new Date(t + TZ.offsetMin(tz, t) * 60000).toISOString().slice(11, 13);
      return { label: lab, visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 };
    });
  } else {
    const rows = db.prepare(`SELECT ${TZ.daySql(tz, start, end)} AS lday, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE ${where} GROUP BY lday`).all(...args);
    const map = new Map(rows.map((r) => [r.lday, r]));
    if (imp.on) for (const r of imp.days) { const e = map.get(r.day) || { lday: r.day, pv: 0, v: 0 }; e.pv += r.pageviews; e.v += r.visitors; map.set(r.day, e); }
    series = Array.from({ length: days }, (_, i) => {
      const d = TZ.addDays(fromDay, i);
      const r = map.get(d);
      return { label: d.slice(5), day: d, visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 };
    });
  }

  // previous year: same window shifted by 364 days (same weekdays). Null until data reaches back that far.
  const yoyStart = TZ.dayStart(tz, TZ.addDays(fromDay, -364)), yoyEnd = yoyStart + (end - start);
  const firstTs = db.prepare('SELECT MIN(ts) t FROM events WHERE site_id = ?').get(sid).t;
  let yoy = null;
  if (firstTs != null && firstTs <= yoyStart) {
    const ya = args.slice(); ya[1] = yoyStart; ya[2] = yoyEnd;
    if (goal) { ya[ya.length - 3] = yoyStart; ya[ya.length - 2] = yoyEnd; }
    const y = db.prepare(`SELECT COUNT(*) pageviews, COUNT(DISTINCT vh) visitors FROM events WHERE ${where}`).get(...ya);
    yoy = { visitors: pct(totals.visitors, y.visitors), pageviews: pct(totals.pageviews, y.pageviews), was: y };
  }

  const topByRaw = (col, limit = 8) => db.prepare(
    `SELECT ${col} AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where} AND ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC LIMIT ${limit}`,
  ).all(...args);
  const IMP_DIM = { path: 'page', country: 'country', browser: 'browser', os: 'os', device: 'device' };
  // native + imported for the same dimension; visitors are summed per day-bucket (an approximation,
  // like every imported breakdown — imported data has no visitor identity to deduplicate)
  const topBy = (col, limit = 8) => (imp.on && IMP_DIM[col] ? mergeTop(topByRaw(col, 200), imp.top(IMP_DIM[col]), limit) : topByRaw(col, limit));

  // entry / exit pages: first / last pageview of each visit (vh,day), counted as visits.
  const edge = (dir, limit = 8) => db.prepare(
    `SELECT path AS name, COUNT(*) AS visitors, COUNT(*) AS pageviews FROM (
       SELECT path, ROW_NUMBER() OVER (PARTITION BY vh, day ORDER BY ts ${dir}, id ${dir}) rn FROM events WHERE ${where}
     ) WHERE rn = 1 GROUP BY path ORDER BY visitors DESC LIMIT ${limit}`,
  ).all(...args);

  // goals: conversion = unique converters / unique visitors in the (filtered) range.
  const goalRows = db.prepare(
    `SELECT name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name IS NOT NULL GROUP BY name ORDER BY visitors DESC, pageviews DESC LIMIT 12`,
  ).all(sid, start, end);
  const goalRowsAll = imp.on ? mergeTop(goalRows, imp.top('event'), 12) : goalRows;
  const goals = goalRowsAll.map((g) => ({ ...g, cr: totals.visitors ? +((g.visitors / totals.visitors) * 100).toFixed(1) : 0 }));

  // properties: only meaningful when drilled into a single goal — top values per property key.
  let properties = null;
  if (goal) {
    const rows = db.prepare(`SELECT props FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name = ? AND props IS NOT NULL`).all(sid, start, end, goal);
    const byKey = {};
    for (const r of rows) {
      let obj; try { obj = JSON.parse(r.props); } catch { continue; }
      for (const k of Object.keys(obj || {})) {
        (byKey[k] || (byKey[k] = {}));
        const val = String(obj[k]);
        byKey[k][val] = (byKey[k][val] || 0) + 1;
      }
    }
    properties = Object.keys(byKey).map((k) => ({
      key: k,
      values: Object.entries(byKey[k]).map(([name, pageviews]) => ({ name, pageviews, visitors: pageviews })).sort((a, b) => b.pageviews - a.pageviews).slice(0, 8),
    }));
  }

  // sources without payment providers (returning customers, not traffic) — shown separately
  // one source query; payment providers (returning customers, not traffic) are split off
  const srcAll = db.prepare(
    `SELECT source AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors FROM events WHERE ${where} AND source IS NOT NULL AND source != '' GROUP BY source ORDER BY visitors DESC, pageviews DESC LIMIT 40`,
  ).all(...args);
  if (imp.on) { const merged = mergeTop(srcAll, imp.top('source'), 40); srcAll.length = 0; srcAll.push(...merged); }
  const sourcesClean = srcAll.filter((r) => !isPaymentHost(r.name)).slice(0, 8);
  const paymentReturns = srcAll.filter((r) => isPaymentHost(r.name));

  // ── commerce (event "Purchase" with props.value) ──
  const purchases = db.prepare(
    `SELECT vh, day, ${PLATFORM_SQL} AS platform, CAST(json_extract(props, '$.value') AS REAL) AS value FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name = 'Purchase'`,
  ).all(sid, start, end);
  let commerce = null;
  if (purchases.length) {
    // first non-payment source per buying visit (vh, day) — one query instead of one per order
    const keys = [...new Set(purchases.map((x) => x.vh + '|' + x.day))];
    const days = [...new Set(purchases.map((x) => x.day))];
    const srcRows = db.prepare(
      `SELECT vh, day, source FROM (
         SELECT vh, day, source, ROW_NUMBER() OVER (PARTITION BY vh, day ORDER BY ts, id) rn
         FROM events WHERE site_id = ? AND day IN (${days.map(() => '?').join(',')}) AND name IS NULL AND source NOT IN (${PAYMENT_SQL})
           AND vh IN (SELECT vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name = 'Purchase')
       ) WHERE rn = 1`,
    ).all(sid, ...days, ...PAYMENT_HOSTS, sid, start, end);
    const srcOf = new Map(srcRows.map((r) => [r.vh + '|' + r.day, r.source]));
    void keys;
    const bySrc = new Map(), byPf = new Map();
    let revenue = 0;
    for (const pch of purchases) {
      const v = Number.isFinite(pch.value) ? pch.value : 0;
      revenue += v;
      const pf = byPf.get(pch.platform) || { name: pch.platform, orders: 0, revenue: 0 };
      pf.orders++; pf.revenue += v; byPf.set(pch.platform, pf);
      const src = srcOf.get(pch.vh + '|' + pch.day) || 'Direct';
      const e = bySrc.get(src) || { name: src, orders: 0, revenue: 0 };
      e.orders++; e.revenue += v; bySrc.set(src, e);
    }
    const prevRev = db.prepare(
      `SELECT COUNT(*) n, SUM(CAST(json_extract(props, '$.value') AS REAL)) r FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name = 'Purchase'`,
    ).get(sid, start - len, start);
    const orders = purchases.length;
    commerce = {
      orders, revenue: +revenue.toFixed(2), aov: +(revenue / orders).toFixed(2),
      cr: totals.visitors ? +((new Set(purchases.map((x) => x.vh + x.day)).size / totals.visitors) * 100).toFixed(2) : 0,
      // no trend against a near-empty baseline (e.g. the week tracking started) — a % of almost nothing is noise
      trend: prevRev.n >= 5 ? { orders: pct(orders, prevRev.n), revenue: pct(revenue, prevRev.r || 0) } : { orders: null, revenue: null },
      byPlatform: [...byPf.values()].map((x) => ({ ...x, revenue: +x.revenue.toFixed(2), visitors: x.orders })).sort((a, b) => b.revenue - a.revenue),
      bySource: [...bySrc.values()].map((x) => ({ ...x, revenue: +x.revenue.toFixed(2), visitors: x.orders })).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
    };
  }

  // ── site search (event "Search" with props.q + props.results) ──
  const searchRows = db.prepare(
    `SELECT LOWER(TRIM(json_extract(props, '$.q'))) q, CAST(json_extract(props, '$.results') AS INTEGER) n, vh FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name = 'Search' AND props IS NOT NULL`,
  ).all(sid, start, end);
  let search = null;
  if (searchRows.length) {
    const agg = new Map();
    for (const r of searchRows) {
      if (!r.q) continue;
      const e = agg.get(r.q) || { name: r.q, searches: 0, zero: 0, vhs: new Set() };
      e.searches++; if (r.n === 0) e.zero++; e.vhs.add(r.vh); agg.set(r.q, e);
    }
    const all = [...agg.values()].map((e) => ({ name: e.name, pageviews: e.searches, visitors: e.vhs.size, zero: e.zero }));
    search = {
      total: searchRows.length,
      zeroShare: +((searchRows.filter((r) => r.n === 0).length / searchRows.length) * 100).toFixed(1),
      top: all.slice().sort((a, b) => b.pageviews - a.pageviews).slice(0, 10),
      zeroResults: all.filter((e) => e.zero > 0).sort((a, b) => b.zero - a.zero).slice(0, 10).map((e) => ({ ...e, pageviews: e.zero, visitors: e.zero })),
    };
  }

  // ── broken pages (event "404" with props.url / props.from) ──
  const notFound = db.prepare(
    `SELECT json_extract(props, '$.url') AS name, COUNT(*) AS pageviews, COUNT(DISTINCT vh) AS visitors, MAX(json_extract(props, '$.from')) AS fromPage FROM events WHERE site_id = ? AND ts >= ? AND ts < ?${evf} AND name = '404' GROUP BY name ORDER BY pageviews DESC LIMIT 10`,
  ).all(sid, start, end);

  // ── scroll depth per page (pages with enough measured views) ──
  const scrollPages = db.prepare(
    `SELECT path AS name, COUNT(*) AS pageviews, ROUND(AVG(scroll)) AS avg, ROUND(100.0 * SUM(scroll >= 75) / COUNT(*)) AS deep FROM events WHERE ${where} AND scroll IS NOT NULL GROUP BY path HAVING COUNT(*) >= 5 ORDER BY pageviews DESC LIMIT 10`,
  ).all(...args).map((r) => ({ ...r, visitors: r.pageviews }));

  res.json({
    site: { domain: site.domain, name: site.name },
    period, timezone: tz, range: { from: fromDay, to: toDay },
    filters: Object.assign({}, ...Object.keys(FILTER_COLS).filter((k) => req.query[k]).map((k) => ({ [k]: req.query[k] })), goal ? { goal } : {}),
    totals: { visitors: totals.visitors, pageviews: totals.pageviews, bounce, viewsPerVisitor, duration },
    trend: { visitors: pct(totals.visitors, prev.visitors), pageviews: pct(totals.pageviews, prev.pageviews) },
    previous: { visitors: prev.visitors, pageviews: prev.pageviews },
    yoy,
    dataSince: firstTs ? TZ.localDay(tz, firstTs) : null,
    imported: imp.exists ? { included: imp.on, excludedByFilter: imp.filtered, until: imp.until } : null,
    series,
    annotations: db.prepare('SELECT id, day, text, created_by FROM annotations WHERE site_id = ? AND day >= ? AND day <= ? ORDER BY day, id')
      .all(sid, fromDay, toDay),
    pages: topBy('path', 10),
    entryPages: edge('ASC', 8),
    exitPages: edge('DESC', 8),
    sources: sourcesClean,
    sourcesAll: srcAll.slice(0, 8),
    paymentReturns,
    commerce,
    search,
    notFound,
    scrollPages,
    mediums: topBy('utm_medium', 8),
    campaigns: topBy('utm_campaign', 8),
    countries: topBy('country', 8),
    browsers: topBy('browser', 6),
    os: topBy('os', 6),
    devices: topBy('device', 4),
    platforms: topBy(PLATFORM_SQL, 6),
    appVersions: topBy('app_version', 6),
    languages: topBy('lang', 6),
    goals,
    properties,
    realtime: db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, Date.now() - 5 * 60000).v,
  });
}
app.get('/api/stats', authOrShare, statsHandler);
app.get('/api/v1/stats', authOrShare, statsHandler);

// ── realtime: live visitors + per-minute pulse + recent event feed (last 30 min) ──
function realtimeHandler(req, res) {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const sid = site.id, now = Date.now(), since = now - 30 * 60000;
  const online = db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ?').get(sid, now - 5 * 60000).v;
  const rows = db.prepare('SELECT CAST((ts/60000) AS INT) b, COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND name IS NULL AND ts >= ? GROUP BY b').all(sid, since);
  const map = new Map(rows.map((r) => [r.b, r]));
  const startB = Math.floor(since / 60000);
  const minutes = Array.from({ length: 30 }, (_, i) => { const r = map.get(startB + i + 1); return { visitors: r ? r.v : 0, pageviews: r ? r.pv : 0 }; });
  const recent = db.prepare('SELECT ts, path, country, tz, browser, os, device, source, lang, name, platform FROM events WHERE site_id = ? AND ts >= ? ORDER BY id DESC LIMIT 60').all(sid, since);
  res.json({ online, minutes, recent, now });
}
app.get('/api/realtime', authOrShare, realtimeHandler);
app.get('/api/v1/realtime', authOrShare, realtimeHandler);

// ── share links: create / list / revoke (owner only) + resolve (public) ──────────
app.get('/api/shares', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT s.token, s.created, s.site_id, st.domain FROM shares s JOIN sites st ON st.id = s.site_id ORDER BY s.created DESC').all()
    .filter((r) => siteAllowed(req, r.site_id)).map(({ site_id, ...r }) => r);
  res.json(rows);
});
app.post('/api/shares', adminOnly, (req, res) => {
  const site = getSiteByDomain.get(norm(req.body && req.body.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const token = newToken();
  db.prepare('INSERT INTO shares (token, site_id, created) VALUES (?, ?, ?)').run(token, site.id, Date.now());
  audit(res, 'share.add', site.domain);
  res.json({ token, domain: site.domain, url: '/share/' + token });
});
app.delete('/api/shares/:token', adminOnly, (req, res) => {
  const sh = getShare.get(String(req.params.token));
  if (sh && !siteAllowed(req, sh.site_id)) return res.status(403).json(NO_SITE);
  if (sh) { const st = db.prepare('SELECT domain FROM sites WHERE id = ?').get(sh.site_id); audit(res, 'share.revoke', st ? st.domain : null); }
  db.prepare('DELETE FROM shares WHERE token = ?').run(String(req.params.token));
  res.json({ ok: true });
});
// public: resolve a share token to its site (used by the read-only dashboard)
app.get('/api/share-info/:token', (req, res) => {
  const sh = getShare.get(String(req.params.token));
  if (!sh) return res.status(404).json({ error: 'Unknown or revoked share link' });
  const site = db.prepare('SELECT domain, name FROM sites WHERE id = ?').get(sh.site_id);
  res.json({ domain: site.domain, name: site.name });
});

// ── import history: Plausible export ZIP / CSVs, Google Analytics 4 CSVs (owner/admin) ──
const { parseImport } = require('./importers');
app.post('/api/imports', adminOnly, express.raw({ type: ['application/zip', 'application/octet-stream', 'text/csv', 'text/plain'], limit: '60mb' }), async (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const source = String(req.query.source || '');
  if (!['plausible', 'ga'].includes(source)) return res.status(400).json({ error: 'source must be plausible or ga' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Upload a .zip or .csv file' });
  const isZip = req.body.readUInt32LE(0) === 0x04034b50;
  let parsed;
  try { parsed = await parseImport(source, isZip ? { zip: req.body } : { files: [{ name: String(req.query.name || 'upload.csv').slice(0, 120), text: req.body.toString('utf8') }] }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const rows = parsed.rows.filter((r) => r.visitors || r.pageviews);
  if (!rows.length) return res.status(400).json({ error: 'The file contains no daily numbers' });
  if (rows.length > 2e6) return res.status(400).json({ error: 'Too many rows' });
  const daysTot = rows.filter((r) => r.dim === '').map((r) => r.day).sort();
  const first = firstOwnDay(site);
  const by = whoDid(req);
  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO imports (site_id, source, first_day, last_day, rows, pageviews, files, created_by, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(site.id, source, daysTot[0] || null, daysTot[daysTot.length - 1] || null, rows.length, rows.filter((r) => r.dim === '').reduce((a, r) => a + r.pageviews, 0), parsed.files.join(', ').slice(0, 500), by, Date.now());
    const ins = db.prepare('INSERT INTO imported (import_id, site_id, day, dim, name, visitors, pageviews, visits, bounces, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(info.lastInsertRowid, site.id, r.day, r.dim, r.name || '', r.visitors, r.pageviews, r.visits || 0, r.bounces || 0, r.duration || 0);
    return info.lastInsertRowid;
  })();
  const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  audit(res, 'import.add', `${site.domain}: ${source} ${imp.first_day || '?'} – ${imp.last_day || '?'} (${imp.pageviews} views)`);
  res.json({ ...imp, countsUntil: first, note: first && imp.last_day && imp.last_day >= first ? `Days from ${first} on already have own data — imported numbers count only before that day.` : null });
});
app.get('/api/imports', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  res.json({ countsUntil: firstOwnDay(site), imports: db.prepare('SELECT id, source, first_day, last_day, rows, pageviews, files, created_by, created FROM imports WHERE site_id = ? ORDER BY id DESC').all(site.id) });
});
app.delete('/api/imports/:id', adminOnly, (req, res) => {
  const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(Number(req.params.id));
  if (!imp) return res.json({ ok: true });
  if (!siteAllowed(req, imp.site_id)) return res.status(403).json(NO_SITE);
  db.transaction(() => { db.prepare('DELETE FROM imported WHERE import_id = ?').run(imp.id); db.prepare('DELETE FROM imports WHERE id = ?').run(imp.id); })();
  audit(res, 'import.remove', `${imp.source} ${imp.first_day || ''} – ${imp.last_day || ''}`);
  res.json({ ok: true });
});

// ── chart annotations: list for a site (any reader of the site), add/remove (admin) ──
app.get('/api/annotations', authOrShare, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  res.json(db.prepare('SELECT id, day, text, created_by, created FROM annotations WHERE site_id = ? ORDER BY day DESC, id DESC LIMIT 500').all(site.id));
});
app.post('/api/annotations', adminOnly, (req, res) => {
  const b = req.body || {};
  const site = getSiteByDomain.get(norm(b.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const day = String(b.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + 'T00:00:00Z')) || new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day) {
    return res.status(400).json({ error: 'day must be a date like 2026-10-15' });
  }
  const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!text) return res.status(400).json({ error: 'Write a short note' });
  const by = whoDid(req);
  const info = db.prepare('INSERT INTO annotations (site_id, day, text, created_by, created) VALUES (?, ?, ?, ?, ?)').run(site.id, day, text, by, Date.now());
  audit(res, 'note.add', `${site.domain} ${day}: ${text}`);
  res.json({ id: info.lastInsertRowid, day, text, created_by: by });
});
app.delete('/api/annotations/:id', adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM annotations WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.json({ ok: true });
  if (!siteAllowed(req, a.site_id)) return res.status(403).json(NO_SITE);
  db.prepare('DELETE FROM annotations WHERE id = ?').run(a.id);
  audit(res, 'note.remove', `${a.day}: ${a.text}`);
  res.json({ ok: true });
});

// ── funnels: ordered steps (pages or goals), conversion measured per visitor in-range ──
app.get('/api/funnels', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  res.json(db.prepare('SELECT id, name, steps, created FROM funnels WHERE site_id = ? ORDER BY id').all(site.id).map((f) => ({ ...f, steps: JSON.parse(f.steps) })));
});
app.post('/api/funnels', adminOnly, (req, res) => {
  const site = getSiteByDomain.get(norm(req.body && req.body.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const name = String((req.body && req.body.name) || '').slice(0, 80).trim();
  const raw = (req.body && req.body.steps) || [];
  if (!name) return res.status(400).json({ error: 'Funnel needs a name' });
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return res.status(400).json({ error: 'Funnel needs 2-8 steps' });
  const steps = raw.map((s) => ({
    type: s && s.type === 'goal' ? 'goal' : 'page',
    value: String((s && s.value) || '').slice(0, 200).trim(),
    label: String((s && (s.label || s.value)) || '').slice(0, 80).trim(),
  }));
  if (steps.some((s) => !s.value)) return res.status(400).json({ error: 'Every step needs a value' });
  const info = db.prepare('INSERT INTO funnels (site_id, name, steps, created) VALUES (?, ?, ?, ?)').run(site.id, name, JSON.stringify(steps), Date.now());
  audit(res, 'funnel.add', `${site.domain}: ${name}`);
  res.json({ id: info.lastInsertRowid, name, steps });
});
app.delete('/api/funnels/:id', adminOnly, (req, res) => {
  const f = db.prepare('SELECT site_id, name FROM funnels WHERE id = ?').get(Number(req.params.id));
  if (f && !siteAllowed(req, f.site_id)) return res.status(403).json(NO_SITE);
  if (f) audit(res, 'funnel.remove', f.name);
  db.prepare('DELETE FROM funnels WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
// funnel evaluation: strictly ordered — a visitor counts for step N only after matching step N-1.
app.get('/api/funnels/:id/stats', authOrShare, (req, res) => {
  const f = db.prepare('SELECT * FROM funnels WHERE id = ?').get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'Unknown funnel' });
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(f.site_id);
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const { start, end, fromDay, toDay } = rangeFor(req.query, site.timezone);
  const steps = JSON.parse(f.steps);
  // one pass per visitor: fetch matching events sorted by time, walk the step ladder.
  const conds = steps.map((s) => (s.type === 'goal' ? 'name = ?' : "(name IS NULL AND path = ?)"));
  const rows = db.prepare(
    `SELECT vh, ts, path, name FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND (${conds.join(' OR ')}) ORDER BY vh, ts, id`,
  ).all(f.site_id, start, end, ...steps.map((s) => s.value));
  const progress = new Map(); // vh → next step index the visitor still needs
  for (const r of rows) {
    const at = progress.get(r.vh) || 0;
    if (at >= steps.length) continue;
    const s = steps[at];
    const match = s.type === 'goal' ? r.name === s.value : r.name == null && r.path === s.value;
    if (match) progress.set(r.vh, at + 1);
  }
  const counts = steps.map(() => 0);
  for (const reached of progress.values()) for (let i = 0; i < reached; i++) counts[i]++;
  const out = steps.map((s, i) => ({
    label: s.label || s.value, type: s.type, value: s.value, visitors: counts[i],
    pctOfFirst: counts[0] ? +((counts[i] / counts[0]) * 100).toFixed(1) : 0,
    dropFromPrev: i > 0 && counts[i - 1] ? +((1 - counts[i] / counts[i - 1]) * 100).toFixed(1) : 0,
  }));
  res.json({ id: f.id, name: f.name, range: { from: fromDay, to: toDay }, steps: out });
});

// ── static dashboard ─────────────────────────────────────────────────────────
// Hosting (e.g. Tacilytics Cloud): DASHBOARD_EXTRA_SCRIPT="/cloud/ui.js" adds one same-origin script to the
// dashboard page (trial/billing banner). Only a plain local path is accepted, never a URL to another host.
const EXTRA_SCRIPT = /^\/[A-Za-z0-9._\/-]{1,120}$/.test(process.env.DASHBOARD_EXTRA_SCRIPT || '') && !/\.\.|\/\//.test(process.env.DASHBOARD_EXTRA_SCRIPT) ? process.env.DASHBOARD_EXTRA_SCRIPT : '';
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
function sendIndex(_req, res) {
  if (!EXTRA_SCRIPT) return res.sendFile(INDEX_HTML);
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace('</body>', `<script src="${EXTRA_SCRIPT}" defer></script>\n</body>`);
  res.type('html').set('Cache-Control', 'no-cache').send(html);
}
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(path.join(__dirname, 'public')));
// ── visitor journeys: session-based path transitions for a sankey flow ───────────
// A "session" = one visitor's pageviews with < 30 min between them.
// Returns the top N transitions per depth (entry → step 2 → step 3 …), plus exits.
app.get('/api/journeys', authOrShare, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  const { start, end } = rangeFor(req.query, site.timezone);
  const maxDepth = Math.min(5, Math.max(2, parseInt(req.query.depth, 10) || 4));
  const GAP = 30 * 60000;
  const rows = db.prepare('SELECT vh, ts, path FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL ORDER BY vh, ts, id').all(site.id, start, end);
  const links = new Map(); // "depth|from|to" → count   (to = path or "✖ exit")
  let sessions = 0;
  let cur = null; // { vh, lastTs, steps: [paths] }
  const flush = (s) => {
    if (!s) return;
    sessions++;
    const steps = s.steps.slice(0, maxDepth);
    for (let i = 0; i < steps.length; i++) {
      const from = steps[i];
      const to = i + 1 < steps.length ? steps[i + 1] : (s.steps.length > maxDepth ? '…' : '✖ exit');
      const k = i + '|' + from + '|' + to;
      links.set(k, (links.get(k) || 0) + 1);
    }
  };
  for (const r of rows) {
    if (!cur || cur.vh !== r.vh || r.ts - cur.lastTs > GAP) { flush(cur); cur = { vh: r.vh, lastTs: r.ts, steps: [r.path] }; continue; }
    cur.lastTs = r.ts;
    // collapse immediate self-loops (reloads) — they add noise, not insight
    if (cur.steps[cur.steps.length - 1] !== r.path) cur.steps.push(r.path);
  }
  flush(cur);
  // keep the top 12 links per depth so the sankey stays readable
  const byDepth = new Map();
  for (const [k, count] of links) {
    const [d, from, to] = k.split('|');
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push({ depth: +d, from, to, count });
  }
  const out = [];
  for (const arr of byDepth.values()) {
    arr.sort((a, b) => b.count - a.count);
    out.push(...arr.slice(0, 12));
  }
  res.json({ sessions, maxDepth, links: out });
});


// ── alerts: per-site rules (traffic spike / drop / goal reached), delivered to a webhook ──────────
// Rules live in the DB and are managed from the dashboard (admin+). Delivery: the rule's own webhook,
// else DIGEST_WEBHOOK_URL. Discord / Slack / generic JSON. Each rule has a cooldown so a long spike
// sends one message, not twelve.
db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    kind TEXT NOT NULL,          -- 'spike' | 'drop' | 'goal'
    goal TEXT,                   -- event name for kind = goal
    threshold INTEGER,           -- goal: events within the window; spike/drop: unused (baseline-based)
    window_hours INTEGER NOT NULL DEFAULT 24,
    webhook TEXT,                -- NULL = DIGEST_WEBHOOK_URL
    enabled INTEGER NOT NULL DEFAULT 1,
    last_fired INTEGER,
    created INTEGER NOT NULL
  );
`);
const ALERT_KINDS = ['spike', 'drop', 'goal'];
// SSRF guard (webhook.js): https only, public addresses only — checked when saved AND at
// connect time (the dialled IP itself), so DNS rebinding between check and send does not help.
const { webhookProblem, resolvesPublic: webhookResolvesPublic, postJson: postWebhook } = require('./webhook');
// tests only: a local http receiver (never set this in production)
const TEST_WEBHOOK_BASE = process.env.TACILYTICS_TEST_HOOKS === '1' ? (process.env.TACILYTICS_TEST_WEBHOOK_BASE || '') : '';
const isTestWebhook = (u) => !!TEST_WEBHOOK_BASE && String(u).startsWith(TEST_WEBHOOK_BASE);
// The operator's DIGEST_WEBHOOK_URL (.env) is trusted as before (may be internal, e.g. ntfy on localhost).
// Webhooks typed into the dashboard are checked, because a teammate must not reach internal services.
// tests only: a fake resolver (TACILYTICS_TEST_DNS='{"name":["1.2.3.4","127.0.0.1"]}' → answers in turn)
let webhookLookup = require('dns').lookup;
if (process.env.TACILYTICS_TEST_HOOKS === '1' && process.env.TACILYTICS_TEST_DNS) {
  const table = JSON.parse(process.env.TACILYTICS_TEST_DNS), seen = {};
  const real = webhookLookup;
  webhookLookup = (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!table[host]) return real(host, opts, cb);
    const list = table[host], i = Math.min(seen[host] = (seen[host] || 0) + 1, list.length) - 1;
    const address = list[i], family = address.includes(':') ? 6 : 4;
    return opts.all ? cb(null, [{ address, family }]) : cb(null, address, family);
  };
}
async function deliver(url, text) {
  const trusted = url && (url === DIGEST_WEBHOOK_URL || isTestWebhook(url));
  if (!url || (!trusted && (webhookProblem(url) || !(await webhookResolvesPublic(url, webhookLookup))))) { console.error('alert: webhook refused'); return false; }
  const isSlack = /hooks\.slack\.com/.test(url);
  const body = isSlack ? { text } : { username: 'Tacilytics', content: text, text };
  try {
    const r = trusted
      ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      : await postWebhook(url, body, { lookup: webhookLookup }); // no redirects, IP checked on connect
    if (!r.ok) console.error('alert webhook failed:', r.status);
    return r.ok;
  } catch (e) { console.error(e.code === 'EWEBHOOKPRIVATE' ? 'alert: webhook refused (resolved to a private address)' : 'alert webhook error: ' + e.message); return false; }
}
function publicAlert(a, domain) {
  return { id: a.id, site: domain, kind: a.kind, goal: a.goal, threshold: a.threshold, window_hours: a.window_hours,
    webhook: a.webhook ? new URL(a.webhook).hostname : null, enabled: !!a.enabled, last_fired: a.last_fired };
}
app.get('/api/alerts', auth, (req, res) => {
  const site = getSiteByDomain.get(norm(req.query.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  res.json({ fallbackWebhook: !!DIGEST_WEBHOOK_URL && !isLimited(req), alerts: db.prepare('SELECT * FROM alerts WHERE site_id = ? ORDER BY id').all(site.id).map((a) => publicAlert(a, site.domain)) });
});
app.post('/api/alerts', adminOnly, async (req, res) => {
  const b = req.body || {};
  const site = getSiteByDomain.get(norm(b.site));
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  if (!siteOk(req, site)) return res.status(403).json(NO_SITE);
  if (!ALERT_KINDS.includes(b.kind)) return res.status(400).json({ error: 'kind must be spike, drop or goal' });
  let goal = null, threshold = null, windowHours = 1;
  if (b.kind === 'goal') {
    goal = String(b.goal || '').trim().slice(0, 80);
    threshold = Math.floor(Number(b.threshold));
    windowHours = Math.floor(Number(b.window_hours) || 24);
    if (!goal) return res.status(400).json({ error: 'Name the goal (event name), e.g. Purchase' });
    if (!(threshold >= 1 && threshold <= 1e6)) return res.status(400).json({ error: 'Threshold must be at least 1' });
    if (![1, 24, 168].includes(windowHours)) return res.status(400).json({ error: 'Window must be 1, 24 or 168 hours' });
  }
  let webhook = null;
  if (b.webhook && isTestWebhook(b.webhook)) {
    webhook = String(b.webhook);
  } else if (b.webhook) {
    const prob = webhookProblem(b.webhook);
    if (prob) return res.status(400).json({ error: prob });
    if (!(await webhookResolvesPublic(b.webhook, webhookLookup))) return res.status(400).json({ error: 'Webhook must point to a public address' });
    webhook = String(b.webhook);
  } else if (!DIGEST_WEBHOOK_URL || isLimited(req)) {
    // the operator's webhook is for the operator: an account limited to some sites must bring its own
    return res.status(400).json({ error: 'Add a webhook URL' + (DIGEST_WEBHOOK_URL ? '' : ' (no default DIGEST_WEBHOOK_URL is set)') });
  }
  if (db.prepare('SELECT COUNT(*) n FROM alerts WHERE site_id = ?').get(site.id).n >= 20) return res.status(400).json({ error: 'At most 20 alerts per site' });
  const info = db.prepare('INSERT INTO alerts (site_id, kind, goal, threshold, window_hours, webhook, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(site.id, b.kind, goal, threshold, windowHours, webhook, Date.now());
  audit(res, 'alert.add', `${site.domain}: ${b.kind}${goal ? ' ' + goal + ' ≥ ' + threshold + '/' + windowHours + 'h' : ''}`);
  res.json(publicAlert(db.prepare('SELECT * FROM alerts WHERE id = ?').get(info.lastInsertRowid), site.domain));
});
app.patch('/api/alerts/:id', adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Unknown alert' });
  if (!siteAllowed(req, a.site_id)) return res.status(403).json(NO_SITE);
  db.prepare('UPDATE alerts SET enabled = ? WHERE id = ?').run((req.body || {}).enabled ? 1 : 0, a.id);
  audit(res, (req.body || {}).enabled ? 'alert.on' : 'alert.off', `${a.kind}${a.goal ? ' ' + a.goal : ''}`);
  res.json({ ok: true });
});
app.delete('/api/alerts/:id', adminOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.json({ ok: true });
  if (!siteAllowed(req, a.site_id)) return res.status(403).json(NO_SITE);
  db.prepare('DELETE FROM alerts WHERE id = ?').run(a.id);
  audit(res, 'alert.remove', `${a.kind}${a.goal ? ' ' + a.goal : ''}`);
  res.json({ ok: true });
});
app.post('/api/alerts/:id/test', adminOnly, async (req, res) => {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Unknown alert' });
  if (!siteAllowed(req, a.site_id)) return res.status(403).json(NO_SITE);
  if (rateLimited('alert-test:' + a.id, 5, 60 * 60000)) return res.status(429).json({ error: 'Max. 5 test messages per hour' });
  const site = db.prepare('SELECT domain FROM sites WHERE id = ?').get(a.site_id);
  const ok = await deliver(a.webhook || DIGEST_WEBHOOK_URL, `🔔 **${site.domain}** test message from Tacilytics — this alert works.`);
  res.status(ok ? 200 : 502).json(ok ? { ok: true } : { error: 'The webhook did not accept the message' });
});

// ── weekly report by e-mail ──────────────────────────────────────────────────────────────
// Every account can opt in (Settings → Security) with an address; it gets one mail per week
// (Monday, REPORT_HOUR_UTC) covering the sites it can see: last 7 days vs. the 7 before.
// Needs SMTP_URL (smtp://user:pass@host:587 or smtps://…:465) and REPORT_FROM in .env.
const SMTP_URL = process.env.SMTP_URL || '';
const REPORT_FROM = process.env.REPORT_FROM || '';
const REPORT_HOUR_UTC = Math.min(23, Math.max(0, parseInt(process.env.REPORT_HOUR_UTC, 10) || 6));
const PUBLIC_URL = (process.env.TACILYTICS_ORIGIN || '').replace(/\/$/, '');
for (const col of ['report_email TEXT', 'report_weekly INTEGER NOT NULL DEFAULT 0', 'report_last INTEGER', 'report_lang TEXT']) {
  const name = col.split(' ')[0];
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
}
let mailer = null;
function getMailer() {
  if (!SMTP_URL || !REPORT_FROM) return null;
  if (!mailer) mailer = require('nodemailer').createTransport(SMTP_URL);
  return mailer;
}
const validEmail = (e) => /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[A-Za-z]{2,}$/.test(e);
const { createReport, REPORT_LANGS } = require('./report');
const reporter = createReport(db);
function buildReport(user, now) {
  const sites = allSites.all().filter((st) => !st.paused && (!user.sites || JSON.parse(user.sites).includes(st.id)));
  return reporter.build(user, sites, now, { publicUrl: PUBLIC_URL, lang: REPORT_LANGS.includes(user.report_lang) ? user.report_lang : 'en' });
}
async function sendReport(user, now = Date.now()) {
  const m = getMailer();
  if (!m) throw new Error('E-mail is not configured on this server (SMTP_URL, REPORT_FROM)');
  const r = buildReport(user, now);
  if (!r) return { skipped: 'no traffic' };
  await m.sendMail({ from: REPORT_FROM, to: user.report_email, subject: r.subject, text: r.text, html: r.html });
  return { sent: true };
}
async function reportTick(now = Date.now()) {
  const d = new Date(now);
  if (d.getUTCDay() !== 1 || d.getUTCHours() !== REPORT_HOUR_UTC || !getMailer()) return [];
  const due = db.prepare('SELECT * FROM users WHERE report_weekly = 1 AND report_email IS NOT NULL AND (report_last IS NULL OR report_last < ?)').all(now - 6 * 864e5);
  const out = [];
  for (const u of due) {
    db.prepare('UPDATE users SET report_last = ? WHERE id = ?').run(now, u.id); // first: a crash must not mean two mails
    try { out.push({ user: u.username, ...(await sendReport(u, now)) }); } catch (e) { console.error('weekly report:', e.message); out.push({ user: u.username, error: e.message }); }
  }
  return out;
}
if (process.env.TACILYTICS_ALERT_TICK !== 'off') setInterval(() => { reportTick().catch((e) => console.error('reports:', e.message)); }, 10 * 60000).unref();

app.get('/api/me/report', auth, (req, res) => {
  if (!req.principal.user || req.principal.kind !== 'user') return res.status(400).json({ error: 'Sign in with an account' });
  const u = db.prepare('SELECT report_email, report_weekly, report_last, report_lang FROM users WHERE id = ?').get(req.principal.user.id);
  res.json({ configured: !!getMailer(), email: u.report_email, weekly: !!u.report_weekly, last: u.report_last, lang: u.report_lang || null });
});
app.post('/api/me/report', auth, (req, res) => {
  if (!req.principal.user || req.principal.kind !== 'user') return res.status(400).json({ error: 'Sign in with an account' });
  const b = req.body || {};
  const email = String(b.email || '').trim();
  if (b.weekly && !validEmail(email)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
  if (email && !validEmail(email)) return res.status(400).json({ error: 'Enter a valid e-mail address' });
  if (b.lang != null && !REPORT_LANGS.includes(b.lang)) return res.status(400).json({ error: 'Unknown language' });
  db.prepare('UPDATE users SET report_email = ?, report_weekly = ?, report_lang = COALESCE(?, report_lang) WHERE id = ?').run(email || null, b.weekly ? 1 : 0, b.lang || null, req.principal.user.id);
  audit(res, b.weekly ? 'me.report.on' : 'me.report.off');
  res.json({ ok: true });
});
app.post('/api/me/report/send', auth, async (req, res) => {
  if (!req.principal.user || req.principal.kind !== 'user') return res.status(400).json({ error: 'Sign in with an account' });
  if (rateLimited('report-now:' + req.principal.user.id, 3, 60 * 60000)) return res.status(429).json({ error: 'Max. 3 test reports per hour' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.principal.user.id);
  if (!u.report_email) return res.status(400).json({ error: 'Save an e-mail address first' });
  try { const r = await sendReport(u); res.json(r.skipped ? { error: 'No traffic in the last two weeks — nothing to report' } : { ok: true }); }
  catch (e) { res.status(502).json({ error: e.message.startsWith('E-mail is not') ? e.message : 'Sending failed: ' + e.message.slice(0, 120) }); }
});
if (process.env.TACILYTICS_TEST_HOOKS === '1') {
  app.post('/api/_test/report-tick', requireRole('owner'), async (req, res) => res.json(await reportTick(Number((req.body || {}).now) || Date.now())));
}


// ── data retention (privacy by design: minimise what we keep) ─────────────────
// When DATA_RETENTION_DAYS > 0, raw events older than the window are purged daily.
// Aggregates you've already exported stay yours; the raw rows simply don't linger.
const delOld = db.prepare('DELETE FROM events WHERE ts < ?');
function purgeOld() {
  if (RETENTION_DAYS <= 0) return;
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  const info = delOld.run(cutoff);
  if (info.changes) console.log(`Tacilytics retention: purged ${info.changes} events older than ${RETENTION_DAYS}d`);
}
if (RETENTION_DAYS > 0) { purgeOld(); setInterval(purgeOld, 24 * 3600 * 1000).unref(); }

// ── daily digest: one webhook message per day summarising every site (yesterday vs the day before).
// Configure DIGEST_WEBHOOK_URL (Discord-compatible) and optionally DIGEST_HOUR_UTC (default 7).
const DIGEST_HOUR_UTC = Math.min(23, Math.max(0, parseInt(process.env.DIGEST_HOUR_UTC, 10) || 7));
let lastDigestDay = null;
function digestBody(now = Date.now()) {
  // "yesterday" per site, in the site's time zone (23/25 h on DST days)
  const lines = [];
  let label = null;
  for (const site of allSites.all()) {
    const tz = site.timezone || 'UTC';
    const yDay = TZ.addDays(TZ.localDay(tz, now), -1);
    const yStart = TZ.dayStart(tz, yDay), yEnd = TZ.dayStart(tz, TZ.addDays(yDay, 1)), pStart = TZ.dayStart(tz, TZ.addDays(yDay, -1));
    if (!label) label = yDay;
    const cur = db.prepare('SELECT COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(site.id, yStart, yEnd);
    if (!cur.pv) continue; // silent sites stay out of the report
    const was = db.prepare('SELECT COUNT(*) pv, COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(site.id, pStart, yStart);
    const top = db.prepare("SELECT path, COUNT(*) c FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL GROUP BY path ORDER BY c DESC LIMIT 1").get(site.id, yStart, yEnd);
    const goals = db.prepare('SELECT COUNT(*) c FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NOT NULL').get(site.id, yStart, yEnd).c;
    const arrow = was.v ? (cur.v > was.v ? '⬆️' : cur.v < was.v ? '⬇️' : '➡️') : '✨';
    lines.push(`**${site.domain}**${yDay !== label ? ` (${yDay})` : ''} ${arrow} ${cur.v} visitors · ${cur.pv} views${goals ? ` · ${goals} events` : ''}${top ? ` · top \`${top.path}\`` : ''}`);
  }
  if (!lines.length) return null;
  return { username: 'Tacilytics', content: `📊 **Daily digest — ${label}**\n` + lines.join('\n') };
}
async function sendDigest(now = Date.now()) {
  const body = digestBody(now);
  if (!body) return;
  try {
    const r = await fetch(DIGEST_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('digest webhook failed:', r.status);
  } catch (e) { console.error('digest webhook error:', e.message); }
}
if (DIGEST_WEBHOOK_URL) {
  setInterval(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === DIGEST_HOUR_UTC && lastDigestDay !== today) { lastDigestDay = today; sendDigest(); }
  }, 5 * 60000).unref();
}

// ── alert engine: every 10 min. Spike/drop compare the last hour with the median of the same LOCAL
// hour (site time zone — after a DST switch that is 23/25 h away, not 24) over 14 days (avoids "every night is an incident"); goals count events in a rolling window.
// Sites without own rules keep the old behaviour when DIGEST_WEBHOOK_URL is set: spike + drop.
const WATCH_MIN_VISITORS = Math.max(1, parseInt(process.env.WATCH_MIN_VISITORS, 10) || 10);
const legacyFired = new Map(); // "siteId|kind" → ts, for the implicit default rules
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? (s[s.length >> 1] + s[(s.length - 1) >> 1]) / 2 : 0; }
function trafficVerdict(siteId, now, tz) {
  const hourStart = now - 3600e3;
  const cur = db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(siteId, hourStart, now).v;
  const hist = [];
  for (let d = 1; d <= 14; d++) {
    const s0 = TZ.sameLocalTime(tz || 'UTC', hourStart, d);
    hist.push(db.prepare('SELECT COUNT(DISTINCT vh) v FROM events WHERE site_id = ? AND ts >= ? AND ts < ? AND name IS NULL').get(siteId, s0, s0 + 3600e3).v);
  }
  const base = median(hist);
  // abstain when the baseline is too thin to mean anything — a default is not a measurement
  if (base < WATCH_MIN_VISITORS && cur < WATCH_MIN_VISITORS) return { cur, base, kind: null };
  if (base >= 1 && cur >= Math.max(3 * base, base + WATCH_MIN_VISITORS)) return { cur, base, kind: 'spike' };
  if (base >= WATCH_MIN_VISITORS && cur <= base * 0.2) return { cur, base, kind: 'drop' };
  return { cur, base, kind: null };
}
const COOLDOWN = { spike: 6 * 3600e3, drop: 6 * 3600e3 };
async function alertTick(now = Date.now()) {
  const fired = [];
  for (const site of allSites.all()) {
    if (site.paused) continue; // a paused site collects nothing: a 'drop' alert would only announce the pause (Tyto, 2.3.0)
    const rules = db.prepare('SELECT * FROM alerts WHERE site_id = ? AND enabled = 1').all(site.id);
    const hasOwn = db.prepare('SELECT COUNT(*) n FROM alerts WHERE site_id = ?').get(site.id).n > 0;
    let verdict = null;
    const traffic = () => verdict || (verdict = trafficVerdict(site.id, now, site.timezone));
    const msgFor = (kind, v) => kind === 'spike'
      ? `🚀 **${site.domain}** traffic spike: **${v.cur}** visitors in the last hour (usually ~${v.base})`
      : `📉 **${site.domain}** traffic drop: **${v.cur}** visitors in the last hour (usually ~${v.base}) — tracker offline?`;
    for (const r of rules) {
      let text = null;
      if (r.kind === 'goal') {
        // fire once per window: after firing, wait until the window has passed
        if (r.last_fired && now - r.last_fired < r.window_hours * 3600e3) continue;
        const n = db.prepare('SELECT COUNT(*) c FROM events WHERE site_id = ? AND name = ? AND ts >= ? AND ts < ?').get(site.id, r.goal, now - r.window_hours * 3600e3, now).c;
        if (n >= r.threshold) text = `🎯 **${site.domain}** goal reached: **${n}× ${r.goal}** in the last ${r.window_hours === 1 ? 'hour' : r.window_hours === 24 ? '24 hours' : '7 days'} (threshold ${r.threshold})`;
      } else {
        if (r.last_fired && now - r.last_fired < COOLDOWN[r.kind]) continue;
        const v = traffic();
        if (v.kind === r.kind) text = msgFor(r.kind, v);
      }
      if (!text) continue;
      db.prepare('UPDATE alerts SET last_fired = ? WHERE id = ?').run(now, r.id); // before sending: a slow webhook must not double-fire
      fired.push({ site: site.domain, kind: r.kind, text });
      await deliver(r.webhook || DIGEST_WEBHOOK_URL, text);
    }
    if (!hasOwn && DIGEST_WEBHOOK_URL) {
      const v = traffic();
      if (v.kind) {
        const key = site.id + '|' + v.kind;
        if (now - (legacyFired.get(key) || 0) >= COOLDOWN[v.kind]) {
          legacyFired.set(key, now);
          const text = msgFor(v.kind, v);
          fired.push({ site: site.domain, kind: v.kind, text, implicit: true });
          await deliver(DIGEST_WEBHOOK_URL, text);
        }
      }
    }
  }
  return fired;
}
if (process.env.TACILYTICS_ALERT_TICK !== 'off') setInterval(() => { alertTick().catch((e) => console.error('alerts:', e.message)); }, 10 * 60000).unref();
// test hook: run one evaluation on demand (only with the server API_KEY, only when enabled explicitly)
if (process.env.TACILYTICS_TEST_HOOKS === '1') {
  app.post('/api/_test/digest', requireRole('owner'), (req, res) => res.json(digestBody(Number((req.body || {}).now) || Date.now())));
  app.post('/api/_test/alert-tick', requireRole('owner'), async (req, res) => res.json(await alertTick(Number((req.body || {}).now) || Date.now())));
}

// ── fallbacks: LAST, after every route (a route registered below these would never be reached) ──
// unknown API paths are a 404 in JSON — never the SPA page. A client that asks an older/newer server for a
// route it doesn't have must get an error it can show, not HTML it would try to read as data (Kiro, 2.2.0).
app.all(/^\/(api|auth)(\/|$)/, (_req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', sendIndex);

app.listen(PORT, HOST, () => console.log(`Tacilytics on http://${HOST}:${PORT}${RETENTION_DAYS ? ` · retention ${RETENTION_DAYS}d` : ''}${DIGEST_WEBHOOK_URL ? ` · digest ${DIGEST_HOUR_UTC}:00 UTC` : ''}`));
