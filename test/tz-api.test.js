'use strict';
// Per-site time zones end to end: validation (Kiro e), local day buckets incl. DST end 26.10.2025 (Tyto c;
// the API caps ranges at now, so the past switch — 25.10.2026 itself is covered in tz.test.js),
// +5:45 (Kiro d), stored day column untouched (Tyto a).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');

test('time zones: API', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-tz-'));
  const DB_PATH = path.join(dir, 'analytics.db');
  const PORT = 45000 + Math.floor(Math.random() * 1000);
  const KEY = 'tz-' + crypto.randomBytes(4).toString('hex');
  const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'tz-pass-12345', TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off', TACILYTICS_TEST_HOOKS: '1' };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };

  await t.test('validation: unknown names are a 400 and never stored (Kiro e)', async () => {
    assert.strictEqual((await call('POST', '/api/sites', { domain: 'bad.test', timezone: 'Mars/Base' })).status, 400);
    assert.strictEqual((await call('GET', '/api/sites')).j.some((s) => s.domain === 'bad.test'), false);
    const plain = (await call('POST', '/api/sites', { domain: 'plain.test' })).j;
    assert.strictEqual(plain.timezone, 'UTC', 'default stays UTC (existing behaviour)');
    assert.strictEqual((await call('PATCH', '/api/sites/' + plain.id, { timezone: 'Europe/Berlin; DROP TABLE sites' })).status, 400);
    assert.strictEqual((await call('PATCH', '/api/sites/' + plain.id, { timezone: 'Asia/Kathmandu' })).j.timezone, 'Asia/Kathmandu');
  });

  const ber = (await call('POST', '/api/sites', { domain: 'berlin.test', timezone: 'Europe/Berlin' })).j;
  const ktm = (await call('POST', '/api/sites', { domain: 'ktm.test', timezone: 'Asia/Kathmandu' })).j;
  const utc = (await call('POST', '/api/sites', { domain: 'utc.test' })).j;
  // the same instants on three sites; the stored day column is the UTC day, as before (Tyto a)
  const hits = ['2025-10-25T21:59:00Z', '2025-10-25T22:00:00Z', '2025-10-25T23:30:00Z', '2025-10-26T00:30:00Z', '2025-10-26T01:30:00Z', '2025-10-26T22:59:00Z', '2025-10-26T23:00:00Z', '2025-10-25T18:14:00Z', '2025-10-25T18:15:00Z'];
  { const d = new Database(DB_PATH); const ins = d.prepare('INSERT INTO events (site_id, ts, day, path, vh) VALUES (?, ?, ?, ?, ?)');
    for (const s of [ber, ktm, utc]) hits.forEach((h, i) => ins.run(s.id, Date.parse(h), h.slice(0, 10), '/', 'v' + i));
    d.close(); }
  const series = async (s, q) => { const r = await call('GET', `/api/stats?site=${s.domain}&${q}`); assert.strictEqual(r.status, 200); return r.j; };
  const byDay = (j) => Object.fromEntries(j.series.map((x) => [x.day, x.pageviews]));

  await t.test('Berlin: 23:30 UTC on 25.10. is 26.10. local; 26.10.2025 is a 25 h day', async () => {
    const j = await series(ber, 'from=2025-10-25&to=2025-10-27');
    assert.strictEqual(j.timezone, 'Europe/Berlin');
    assert.deepStrictEqual(j.range, { from: '2025-10-25', to: '2025-10-27' });
    // 24.10. local = 23.10. 22:00Z .. 24.10. 22:00Z → 21:59Z, 18:14Z, 18:15Z
    // 25.10. local = 24.10. 22:00Z .. 25.10. 23:00Z (25 h) → 22:00, 23:30, 00:30, 01:30, 22:59
    // 26.10. local from 25.10. 23:00Z → 23:00
    assert.deepStrictEqual(byDay(j), { '2025-10-25': 3, '2025-10-26': 5, '2025-10-27': 1 });
    const h = await series(ber, 'from=2025-10-26&to=2025-10-26');
    assert.strictEqual(h.series.length, 25, 'hourly view has 25 buckets on the DST-end day');
    assert.deepStrictEqual(h.series.slice(0, 5).map((x) => x.label), ['00', '01', '02', '02', '03'], 'the repeated hour shows twice');
    assert.strictEqual(h.series.reduce((a, x) => a + x.pageviews, 0), 5);
  });

  await t.test('Kathmandu +5:45: the day starts at 18:15 UTC, not at a whole hour (Kiro d)', async () => {
    const j = await series(ktm, 'from=2025-10-25&to=2025-10-27');
    // 25.10. local = 24.10. 18:15Z .. 25.10. 18:15Z → 18:15, 21:59, 22:00, 23:30, 00:30, 01:30 ; 18:14 is still 24.10.
    assert.deepStrictEqual(byDay(j), { '2025-10-25': 1, '2025-10-26': 6, '2025-10-27': 2 });
  });

  await t.test('UTC site unchanged', async () => {
    const j = await series(utc, 'from=2025-10-25&to=2025-10-27');
    assert.deepStrictEqual(byDay(j), { '2025-10-25': 5, '2025-10-26': 4, '2025-10-27': 0 });
  });

  await t.test('digest: yesterday per site in its own time zone', async () => {
    // 27.10.2025 06:00 UTC: yesterday is 26.10. in Berlin (25 h, 5 views) and in UTC (3 views: 00:30, 01:30, 22:59 → +23:00 = 4)
    const j = (await call('POST', '/api/_test/digest', { now: Date.parse('2025-10-27T06:00:00Z') })).j;
    assert.match(j.content, /berlin\.test\*\* .* 5 views/);
    assert.match(j.content, /utc\.test\*\* .* 4 views/);
  });

  await t.test('stored rows untouched', async () => {
    const d = new Database(DB_PATH, { readonly: true });
    assert.strictEqual(d.prepare("SELECT COUNT(*) n FROM events WHERE site_id = ? AND day = '2025-10-25'").get(ber.id).n, 5);
    d.close();
  });
});

test('time zones: imported history ends before the first LOCAL day with own data', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-tzi-'));
  const DB_PATH = path.join(dir, 'analytics.db');
  const PORT = 46000 + Math.floor(Math.random() * 1000);
  const KEY = 'tzi-' + crypto.randomBytes(4).toString('hex');
  const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'tz-pass-12345', TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const call = async (method, p, body) => (await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) })).json();
  const site = await call('POST', '/api/sites', { domain: 'imp.test', timezone: 'Europe/Berlin' });
  const d = new Database(DB_PATH);
  // own data starts 02.09. 23:30 UTC = 03.09. 01:30 Berlin → the local 02.09. still belongs to the import
  d.prepare("INSERT INTO events (site_id, ts, day, path, vh) VALUES (?, ?, '2025-09-02', '/', 'own')").run(site.id, Date.parse('2025-09-02T23:30:00Z'));
  const impId = d.prepare("INSERT INTO imports (site_id, source, created, first_day, last_day, rows) VALUES (?, 'ga', 0, '2025-09-01', '2025-09-03', 3)").run(site.id).lastInsertRowid;
  const ins = d.prepare("INSERT INTO imported (import_id, site_id, day, dim, name, visitors, pageviews) VALUES (?, ?, ?, '', '', ?, ?)");
  ins.run(impId, site.id, '2025-09-01', 10, 10); ins.run(impId, site.id, '2025-09-02', 20, 20); ins.run(impId, site.id, '2025-09-03', 30, 30);
  d.close();
  const j = await call('GET', '/api/stats?site=imp.test&from=2025-09-01&to=2025-09-03');
  assert.deepStrictEqual(j.series.map((x) => [x.day, x.pageviews]), [['2025-09-01', 10], ['2025-09-02', 20], ['2025-09-03', 1]]);
  assert.strictEqual((await call('GET', '/api/imports?site=imp.test')).countsUntil, '2025-09-03', 'the import dialog names the local day');
});
