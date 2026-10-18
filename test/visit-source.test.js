'use strict';
// Visit source (2.5): the source belongs to the visit, like GA / Plausible / Matomo. Internal clicks
// (referrer = own domain) and reloads (no referrer) inherit the source of the same visitor's previous
// page view within 30 minutes, instead of being counted as "Direct". Server-side only (visitor hash),
// so strict mode works the same and reads nothing new on the device.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-vsrc-'));
const DB_PATH = path.join(dir, 'a.db');
const PORT = 47000 + Math.floor(Math.random() * 1000);
const KEY = 'k-visit-source-test';
const ENV = { ...process.env, DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off',
  DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-visit-source',
  TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const ua = (n) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/13${n}.0 Safari/537.36`;

async function j(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const collect = (n, body) => fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': ua(n) }, body: JSON.stringify({ d: 'shop.test', ...body }) });
const src = (p) => { const db = new Database(DB_PATH, { readonly: true }); const r = db.prepare('SELECT source FROM events WHERE path = ? ORDER BY id DESC LIMIT 1').get(p); db.close(); return r && r.source; };

test('visit source', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/nyx.js'); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started ' + err);
  assert.strictEqual((await j('POST', '/api/sites', { domain: 'shop.test' }, { Authorization: 'Bearer ' + KEY })).status < 300, true, 'site created');

  await t.test('internal click and reload keep the search engine of the landing page', async () => {
    await collect(1, { p: '/landing', r: 'https://www.bing.com/search?q=x' });
    await collect(1, { p: '/second', r: 'https://shop.test/landing' });
    await collect(1, { p: '/third', r: '' });
    assert.strictEqual(src('/landing'), 'bing.com');
    assert.strictEqual(src('/second'), 'bing.com', 'own-domain referrer is not Direct');
    assert.strictEqual(src('/third'), 'bing.com', 'reload / no referrer inside the visit is not Direct');
  });

  await t.test('strict mode inherits the same way (nothing read on the device)', async () => {
    await collect(2, { p: '/s-landing', r: 'https://duckduckgo.com/', st: 1 });
    await collect(2, { p: '/s-next', r: 'https://shop.test/s-landing', st: 1 });
    assert.strictEqual(src('/s-next'), 'duckduckgo.com');
  });

  await t.test('another visitor without referrer stays Direct', async () => {
    await collect(3, { p: '/fresh', r: '' });
    assert.strictEqual(src('/fresh'), 'Direct');
  });

  await t.test('a new third-party referrer or UTM starts a new source', async () => {
    await collect(1, { p: '/via-utm', s: 'newsletter' });
    assert.strictEqual(src('/via-utm'), 'newsletter');
    await collect(1, { p: '/after-utm', r: 'https://shop.test/via-utm' });
    assert.strictEqual(src('/after-utm'), 'newsletter');
    await collect(1, { p: '/via-google', r: 'https://www.google.com/' });
    assert.strictEqual(src('/via-google'), 'google.com');
  });

  await t.test('after 30 minutes without a page view the visit is over', async () => {
    await collect(4, { p: '/old-landing', r: 'https://www.bing.com/' });
    const db = new Database(DB_PATH);
    db.prepare("UPDATE events SET ts = ts - 31 * 60000 WHERE path = '/old-landing'").run();
    db.close();
    await collect(4, { p: '/much-later', r: '' });
    assert.strictEqual(src('/much-later'), 'Direct');
  });

  await t.test('custom events do not decide the source of the next page view', async () => {
    await collect(5, { p: '/e-land', r: '' });
    await collect(5, { p: '/e-land', n: 'Signup', r: '' });
    await collect(5, { p: '/e-next', r: 'https://shop.test/e-land' });
    assert.strictEqual(src('/e-next'), 'Direct');
  });

  await t.test('UTM medium and campaign travel with the inherited source', async () => {
    await collect(7, { p: '/u-land', s: 'newsletter', um: 'email', uc: 'herbst' });
    await collect(7, { p: '/u-next', r: 'https://shop.test/u-land' });
    const db = new Database(DB_PATH, { readonly: true });
    const r = db.prepare("SELECT source, utm_medium, utm_campaign FROM events WHERE path = '/u-next'").get();
    db.close();
    assert.deepStrictEqual({ ...r }, { source: 'newsletter', utm_medium: 'email', utm_campaign: 'herbst' });
  });

  await t.test('a return from PayPal keeps the real source of the visit', async () => {
    await collect(8, { p: '/p-land', r: 'https://www.bing.com/' });
    await collect(8, { p: '/p-thanks', r: 'https://www.paypal.com/checkoutnow' });
    await collect(8, { p: '/p-after', r: 'https://shop.test/p-thanks' });
    assert.strictEqual(src('/p-thanks'), 'bing.com');
    assert.strictEqual(src('/p-after'), 'bing.com');
    await collect(9, { p: '/p-only', r: 'https://www.paypal.com/' });
    assert.strictEqual(src('/p-only'), 'paypal.com', 'without an earlier page the payment host stays (dashboard lists it separately)');
  });

  await t.test('server mode (/api/v1/hit) inherits too', async () => {
    const hit = (body) => j('POST', '/api/v1/hit', { domain: 'shop.test', ua: ua(6), ip: '198.51.100.9', ...body }, { Authorization: 'Bearer ' + KEY });
    assert.ok((await hit({ path: '/h-land', referrer: 'https://ecosia.org/' })).status < 300);
    await hit({ path: '/h-next', referrer: 'https://shop.test/h-land' });
    assert.strictEqual(src('/h-next'), 'ecosia.org');
  });
});
