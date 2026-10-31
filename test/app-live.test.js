'use strict';
// "Live only for the app" (2.6): realtime + the live number in /stats follow the segment filters,
// platform=app selects every native app together (web excluded), and /realtime reports who is
// online per platform (always unfiltered, so the dashboard can use it as a switch).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-applive-'));
const PORT = 48000 + Math.floor(Math.random() * 1000);
const KEY = 'k-app-live-test';
const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off',
  DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-app-live',
  TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: 'Bearer ' + KEY };
const ua = (n) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/13${n}.0 Safari/537.36`;
const appUa = 'Dart/3.5 (dart:io)';
const get = async (p) => { const r = await fetch(base + p, { headers: AUTH }); return { status: r.status, data: await r.json() }; };
const collect = (headersUa, body) => fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': headersUa }, body: JSON.stringify({ d: 'shop.test', ...body }) });

test('app live', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/nyx.js'); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started ' + err);
  const site = await fetch(base + '/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ domain: 'shop.test' }) });
  assert.ok(site.status < 300, 'site created');

  // 3 web visitors, 2 Android, 1 iOS
  for (const n of [1, 2, 3]) await collect(ua(n), { p: '/web-' + n });
  await collect(appUa, { p: '/home', pf: 'android', sid: 'sess-android-0001', av: '2.0.0' });
  await collect(appUa, { p: '/cart', pf: 'android', sid: 'sess-android-0002', av: '2.0.0' });
  await collect(appUa, { p: '/home', pf: 'ios', sid: 'sess-ios-00000001', av: '2.0.0' });

  await t.test('unfiltered live counts everyone and splits per platform', async () => {
    const r = await get('/api/v1/realtime?site=shop.test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.online, 6);
    assert.strictEqual(r.data.appOnline, 3);
    const pf = Object.fromEntries(r.data.platforms.map((x) => [x.name, x.visitors]));
    assert.deepStrictEqual(pf, { web: 3, android: 2, ios: 1 });
    assert.strictEqual(r.data.recent.length, 6);
  });

  await t.test('platform=app: only app visitors, feed + pulse too, split stays unfiltered', async () => {
    const r = await get('/api/v1/realtime?site=shop.test&platform=app');
    assert.strictEqual(r.data.online, 3);
    assert.ok(r.data.recent.every((e) => e.platform), 'feed holds app events only');
    assert.strictEqual(r.data.recent.length, 3);
    assert.strictEqual(r.data.minutes.reduce((a, m) => a + m.pageviews, 0), 3);
    assert.strictEqual(r.data.platforms.length, 3, 'split ignores the filter');
  });

  await t.test('single platforms and web', async () => {
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=android')).data.online, 2);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=ios')).data.online, 1);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=web')).data.online, 3);
  });

  await t.test('other segment filters reach live as well, goal is ignored there', async () => {
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&page=/home')).data.online, 2);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=app&page=/cart')).data.online, 1);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&goal=Nope')).data.online, 6);
  });

  await t.test('/stats: platform=app filters every panel, live number follows, appVisitors reported', async () => {
    const all = (await get('/api/v1/stats?site=shop.test&period=today')).data;
    assert.strictEqual(all.realtime, 6);
    assert.strictEqual(all.appVisitors, 3);
    const app = (await get('/api/v1/stats?site=shop.test&period=today&platform=app')).data;
    assert.strictEqual(app.realtime, 3);
    assert.strictEqual(app.totals ? app.totals.visitors : app.visitors, 3);
    assert.ok(!(app.platforms || []).some((p) => p.name === 'web'), 'no web row under platform=app');
    const web = (await get('/api/v1/stats?site=shop.test&period=today&platform=web')).data;
    assert.strictEqual(web.realtime, 3);
    assert.strictEqual(web.appVisitors, null);
  });

  await t.test('one spelling everywhere: upper case and ipados', async () => {
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=Android')).data.online, 2);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=APP')).data.online, 3);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=ipados')).data.online, 1);
    assert.strictEqual((await get('/api/v1/stats?site=shop.test&period=today&platform=iPadOS')).data.realtime, 1);
  });

  await t.test('platform=app combines with the app version filter', async () => {
    await collect(appUa, { p: '/home', pf: 'android', sid: 'sess-android-0003', av: '1.9.0' });
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=app&version=1.9.0')).data.online, 1);
    assert.strictEqual((await get('/api/v1/realtime?site=shop.test&platform=app&version=2.0.0')).data.online, 3);
  });

  await t.test('appVisitors is only computed when it is shown', async () => {
    assert.strictEqual((await get('/api/v1/stats?site=shop.test&period=today&platform=android')).data.appVisitors, null);
    await fetch(base + '/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ domain: 'web.test' }) });
    await fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': ua(9) }, body: JSON.stringify({ d: 'web.test', p: '/' }) });
    const w = (await get('/api/v1/stats?site=web.test&period=today')).data;
    assert.strictEqual(w.appVisitors, null, 'web-only site: no app scan');
    const r = (await get('/api/v1/realtime?site=web.test')).data;
    assert.deepStrictEqual(r.platforms.map((x) => x.name), ['web']);
    assert.strictEqual(r.appOnline, 0);
  });

  await t.test('an unknown platform value matches nothing (bound parameter, no injection)', async () => {
    const r = await get("/api/v1/realtime?site=shop.test&platform=" + encodeURIComponent("x' OR 1=1 --"));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.online, 0);
  });
});
