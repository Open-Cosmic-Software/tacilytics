'use strict';
// Strict mode (data-strict, 2.4): the tracker reads nothing from the visitor's device beyond what the
// browser sends with every request anyway. Two parts:
//  1. tracker: run public/tacilytics.js in a sandbox whose localStorage / Intl / navigator.language /
//     screen size / navigator.doNotTrack THROW when touched. Strict must never touch them; the normal
//     mode does (proves the trap is armed, so a green strict run is not just a blind trap).
//  2. server: real server.js; strict beacons take the language from Accept-Language, store no timezone /
//     country / scroll depth, and with data-honor-dnt drop requests carrying DNT: 1 or Sec-GPC: 1.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TRACKER = fs.readFileSync(path.join(ROOT, 'public', 'tacilytics.js'), 'utf8');

// ── 1. tracker in a booby-trapped sandbox ──
function runTracker(attrs, search = '') {
  const touched = new Set();
  const sent = [];
  const infos = [];
  const trap = (name) => { touched.add(name); throw new Error('device read: ' + name); };
  const listeners = {};
  const script = {
    src: 'https://stats.example/tacilytics.js',
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
  };
  const navigator = {
    sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; },
  };
  for (const k of ['language', 'languages', 'doNotTrack', 'msDoNotTrack', 'globalPrivacyControl', 'userAgent', 'platform', 'hardwareConcurrency', 'deviceMemory']) {
    Object.defineProperty(navigator, k, { get: () => trap('navigator.' + k) });
  }
  const docEl = {};
  for (const k of ['scrollHeight', 'clientHeight', 'scrollTop', 'clientWidth']) Object.defineProperty(docEl, k, { get: () => trap('document.documentElement.' + k) });
  const document = {
    currentScript: script, visibilityState: 'visible', readyState: 'complete', referrer: '',
    documentElement: docEl, body: docEl,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
  };
  Object.defineProperty(document, 'cookie', { get: () => trap('document.cookie'), set: () => trap('document.cookie=') });
  const window = {
    addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); },
    history: { pushState() {}, replaceState() {} },
  };
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB', 'screen', 'innerWidth', 'innerHeight', 'pageYOffset', 'devicePixelRatio', 'doNotTrack']) {
    Object.defineProperty(window, k, { get: () => trap('window.' + k) });
  }
  const Intl = { DateTimeFormat: () => trap('Intl.DateTimeFormat') };
  const ctx = {
    window, document, navigator, Intl, history: window.history,
    location: { hostname: 'shop.example', pathname: '/p', search, protocol: 'https:', href: 'https://shop.example/p' + search, hash: '' },
    URL, URLSearchParams, Blob, JSON, Math, Date, String, Object, Array, setTimeout: () => 0, clearTimeout: () => {}, console: { info: (m) => infos.push(m) },
  };
  // bare globals the tracker uses resolve to the trapped window properties
  for (const k of ['localStorage', 'sessionStorage', 'screen']) Object.defineProperty(ctx, k, { get: () => trap('window.' + k) });
  vm.createContext(ctx);
  vm.runInContext(TRACKER, ctx);
  // leave the page → engagement beacon
  for (const fn of listeners.pagehide || []) fn();
  return { touched: [...touched].sort(), sent, infos };
}
const bodies = (sent) => sent.map((x) => x.blob);

test('tracker: strict mode reads nothing from the device', async () => {
  const strict = runTracker({ 'data-domain': 'shop.example', 'data-strict': '' }, '?tacilytics=off');
  assert.deepStrictEqual(strict.touched, [], 'strict touched: ' + strict.touched.join(', '));
  assert.ok(strict.sent.length >= 1, 'strict still sends the pageview');
  assert.ok(strict.infos.some((m) => /strict mode, \?tacilytics=off\/on is not supported/.test(m)), 'console hint for ?tacilytics=off in strict: ' + JSON.stringify(strict.infos));
  const strictDnt = runTracker({ 'data-domain': 'shop.example', 'data-strict': '', 'data-honor-dnt': '' });
  assert.deepStrictEqual(strictDnt.touched, [], 'strict + honor-dnt touched: ' + strictDnt.touched.join(', '));
});

test('tracker: the trap is armed (normal mode does read the device)', async () => {
  // each trap throws, so the normal tracker stops at the first read; check the reads one by one
  assert.ok(runTracker({ 'data-domain': 'shop.example', 'data-honor-dnt': '' }).touched.includes('navigator.doNotTrack'), 'DNT read');
  assert.ok(runTracker({ 'data-domain': 'shop.example' }).touched.includes('window.localStorage'), 'localStorage read');
  // localStorage is in a try block, so the tracker goes on to Intl (also caught) and navigator.language
  const t = runTracker({ 'data-domain': 'shop.example' }).touched;
  assert.ok(t.includes('Intl.DateTimeFormat'), 'Intl read (got ' + t.join(', ') + ')');
  assert.ok(t.includes('navigator.language'), 'language read (got ' + t.join(', ') + ')');
});

test('tracker: strict beacons carry st=1 and no tz / language / scroll', async () => {
  const { sent } = runTracker({ 'data-domain': 'shop.example', 'data-strict': '', 'data-honor-dnt': '' });
  const texts = await Promise.all(bodies(sent).map((b) => b.text()));
  const payloads = texts.map((t) => JSON.parse(t));
  const pv = payloads.find((p) => !p.e);
  assert.ok(pv, 'pageview sent');
  assert.strictEqual(pv.st, 1); assert.strictEqual(pv.hd, 1);
  assert.strictEqual(pv.tz, ''); assert.strictEqual(pv.l, '');
  for (const p of payloads.filter((x) => x.e === 'engagement')) { assert.ok(!('sc' in p), 'no scroll depth in strict'); assert.strictEqual(p.st, 1); }
});

// ── 2. server ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-strict-'));
const DB_PATH = path.join(dir, 'analytics.db');
const PORT = 41000 + Math.floor(Math.random() * 1000);
const ENV = {
  ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT),
  DIGEST_WEBHOOK_URL: 'http://127.0.0.1:9/', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 'strict-test-salt', API_KEY: 'strict-test-key', SESSION_SECRET: 'strict-test-session',
  WEB_PASSWORD: 'strict-' + Math.random().toString(36).slice(2),
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;

async function hit(body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': UA, 'X-Forwarded-For': '203.0.113.9', ...headers },
    body: JSON.stringify({ d: 'strict.test', ...body }),
  });
  assert.ok(r.status < 300, 'collect ' + r.status);
}
const rows = () => { const db = new Database(DB_PATH, { readonly: true }); const r = db.prepare('SELECT path, tz, country, lang, scroll FROM events ORDER BY id').all(); db.close(); return r; };

test('server: strict beacons (real server.js)', async (t) => {
  t.after(async () => { if (proc && proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/tacilytics.js`); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server did not start: ' + err);
  { const db = new Database(DB_PATH); db.prepare("INSERT INTO sites (domain, name, created) VALUES ('strict.test','s',?)").run(Date.now()); db.close(); }

  // strict: language from the header, a sent tz / l is ignored (a strict tracker never sends one, a forged one must not count)
  await hit({ p: '/strict', st: 1, tz: 'Europe/Berlin', l: 'fr' }, { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' });
  // normal: as before
  await hit({ p: '/normal', tz: 'Europe/Berlin', l: 'fr' }, { 'Accept-Language': 'de-DE' });
  // strict + honour DNT: DNT header → dropped; Sec-GPC → dropped; neither → counted
  await hit({ p: '/dnt', st: 1, hd: 1 }, { DNT: '1' });
  await hit({ p: '/gpc', st: 1, hd: 1 }, { 'Sec-GPC': '1' });
  await hit({ p: '/nosignal', st: 1, hd: 1 }, {});
  // strict without honour-dnt: DNT header alone does not drop (same as the normal tracker without the flag)
  await hit({ p: '/dnt-not-honoured', st: 1 }, { DNT: '1' });
  // strict engagement: a forged scroll value is not stored
  await hit({ p: '/strict', st: 1, e: 'engagement', dur: 5, sc: 80 });
  // a broken Accept-Language → no language
  await hit({ p: '/badlang', st: 1 }, { 'Accept-Language': '<script>' });

  const r = rows();
  const by = Object.fromEntries(r.map((x) => [x.path, x]));
  await t.test('strict: lang from Accept-Language, no tz, no country', () => {
    assert.deepStrictEqual({ tz: by['/strict'].tz, country: by['/strict'].country, lang: by['/strict'].lang }, { tz: null, country: null, lang: 'de-DE' });
  });
  await t.test('normal mode unchanged (tz → country, lang from the beacon)', () => {
    assert.deepStrictEqual({ tz: by['/normal'].tz, country: by['/normal'].country, lang: by['/normal'].lang }, { tz: 'Europe/Berlin', country: 'DE', lang: 'fr' });
  });
  await t.test('strict + honour DNT: DNT and Sec-GPC requests are dropped', () => {
    assert.ok(!by['/dnt'] && !by['/gpc'], JSON.stringify(r.map((x) => x.path)));
    assert.ok(by['/nosignal']);
  });
  await t.test('strict without honour DNT: DNT header alone does not drop', () => assert.ok(by['/dnt-not-honoured']));
  await t.test('strict engagement: duration yes, scroll depth no', () => assert.strictEqual(by['/strict'].scroll, null));
  await t.test('broken Accept-Language → no language', () => assert.strictEqual(by['/badlang'].lang, null));
});
