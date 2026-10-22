'use strict';
// Alerts end to end: rules via the API, evaluation via the test hook, delivery to a local receiver.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-alerts-'));
const DB_PATH = path.join(dir, 'analytics.db');
const PORT = 42000 + Math.floor(Math.random() * 1000);
const HOOK_PORT = PORT + 1000;
const HOOK = `http://127.0.0.1:${HOOK_PORT}/hook`;
const KEY = 'alerts-test-key-' + crypto.randomBytes(4).toString('hex');
const ENV = {
  // DIGEST_WEBHOOK_URL: 'off' instead of '' — the .env loader treats '' as unset and would pull the
  // live webhook from .env. The server reads 'off' as "no default webhook".
  ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 'alerts-salt', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'alerts-pass-1234', TRUST_PROXY: '0',
  TACILYTICS_TEST_HOOKS: '1', TACILYTICS_TEST_WEBHOOK_BASE: `http://127.0.0.1:${HOOK_PORT}/`, TACILYTICS_ALERT_TICK: 'off',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const got = [];
const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
let proc = null;
async function start() {
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); return; } catch { await sleep(100); } }
  throw new Error('server did not start: ' + err);
}
async function call(method, p, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const H = 3600e3;
// put events straight into the DB at chosen times (the collector always stamps "now")
function events(siteId, list) {
  const d = new Database(DB_PATH);
  const ins = d.prepare('INSERT INTO events (site_id, ts, day, path, name, vh) VALUES (?, ?, ?, ?, ?, ?)');
  d.transaction(() => { for (const e of list) ins.run(siteId, e.ts, new Date(e.ts).toISOString().slice(0, 10), '/', e.name || null, e.vh); })();
  d.close();
}

test('alerts', async (t) => {
  await new Promise((r) => receiver.listen(HOOK_PORT, '127.0.0.1', r));
  t.after(async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } receiver.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const site = (await call('POST', '/api/sites', { domain: 'shop.test' })).j;
  const now = Date.UTC(2026, 9, 15, 12, 30);

  await t.test('webhook guard: http, private and local targets are refused', async () => {
    for (const w of ['http://example.com/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://[::1]/x', 'https://intranet/x', 'https://foo.internal/x']) {
      const r = await call('POST', '/api/alerts', { site: 'shop.test', kind: 'spike', webhook: w });
      assert.strictEqual(r.status, 400, w + ' → ' + JSON.stringify(r.j));
    }
  });
  await t.test('without a webhook and without DIGEST_WEBHOOK_URL a rule is refused', async () =>
    assert.strictEqual((await call('POST', '/api/alerts', { site: 'shop.test', kind: 'spike' })).status, 400));
  await t.test('goal rule needs a name, threshold and a known window', async () => {
    assert.strictEqual((await call('POST', '/api/alerts', { site: 'shop.test', kind: 'goal', threshold: 3, webhook: HOOK })).status, 400);
    assert.strictEqual((await call('POST', '/api/alerts', { site: 'shop.test', kind: 'goal', goal: 'Purchase', threshold: 0, webhook: HOOK })).status, 400);
    assert.strictEqual((await call('POST', '/api/alerts', { site: 'shop.test', kind: 'goal', goal: 'Purchase', threshold: 3, window_hours: 5, webhook: HOOK })).status, 400);
  });

  const spike = (await call('POST', '/api/alerts', { site: 'shop.test', kind: 'spike', webhook: HOOK })).j;
  const drop = (await call('POST', '/api/alerts', { site: 'shop.test', kind: 'drop', webhook: HOOK })).j;
  const goal = (await call('POST', '/api/alerts', { site: 'shop.test', kind: 'goal', goal: 'Purchase', threshold: 3, window_hours: 24, webhook: HOOK })).j;
  await t.test('rules listed, webhook shown as host only', async () => {
    const l = (await call('GET', '/api/alerts?site=shop.test')).j;
    assert.strictEqual(l.alerts.length, 3);
    assert.ok(l.alerts.every((a) => a.webhook === '127.0.0.1'));
  });

  // history: 20 visitors in the same hour on each of the last 14 days → baseline 20
  const hist = [];
  for (let d = 1; d <= 14; d++) for (let v = 0; v < 20; v++) hist.push({ ts: now - H + 60000 - d * 864e5, vh: `h${d}-${v}` });
  events(site.id, hist);

  await t.test('normal hour: nothing fires', async () => {
    events(site.id, Array.from({ length: 22 }, (_, i) => ({ ts: now - H / 2, vh: 'n' + i })));
    got.length = 0;
    const f = (await call('POST', '/api/_test/alert-tick', { now })).j;
    assert.deepStrictEqual(f, []);
  });
  await t.test('spike: 80 visitors vs ~20 → one message', async () => {
    events(site.id, Array.from({ length: 60 }, (_, i) => ({ ts: now - H / 3, vh: 's' + i })));
    got.length = 0;
    const f = (await call('POST', '/api/_test/alert-tick', { now })).j;
    assert.deepStrictEqual(f.map((x) => x.kind), ['spike']);
    await sleep(200);
    assert.strictEqual(got.length, 1);
    assert.match(got[0].content, /shop\.test.*spike.*82.*~20/);
  });
  await t.test('spike cooldown: the same spike on the next tick stays quiet', async () => {
    // same clock → the traffic picture is identical (still a spike); only the cooldown may stop it
    got.length = 0;
    assert.deepStrictEqual((await call('POST', '/api/_test/alert-tick', { now: now + 1 })).j, []);
  });
  await t.test('goal: 2 purchases → quiet, 3rd → fires once, 4th in the same window → quiet', async () => {
    events(site.id, [{ ts: now - 2 * H, vh: 'p1', name: 'Purchase' }, { ts: now - H, vh: 'p2', name: 'Purchase' }]);
    assert.deepStrictEqual((await call('POST', '/api/_test/alert-tick', { now: now + 20 * 60000 })).j, []);
    events(site.id, [{ ts: now, vh: 'p3', name: 'Purchase' }]);
    got.length = 0;
    const f = (await call('POST', '/api/_test/alert-tick', { now: now + 30 * 60000 })).j;
    assert.deepStrictEqual(f.map((x) => x.kind), ['goal']);
    await sleep(200);
    assert.match(got[0].content, /goal reached.*3× Purchase/);
    events(site.id, [{ ts: now + 31 * 60000, vh: 'p4', name: 'Purchase' }]);
    assert.deepStrictEqual((await call('POST', '/api/_test/alert-tick', { now: now + 40 * 60000 })).j, []);
  });
  await t.test('drop: next day, same hour, 2 visitors vs ~20 → fires', async () => {
    const later = now + 864e5;
    events(site.id, [{ ts: later - H / 2, vh: 'd1' }, { ts: later - H / 2, vh: 'd2' }]);
    const f = (await call('POST', '/api/_test/alert-tick', { now: later })).j;
    assert.ok(f.some((x) => x.kind === 'drop'), JSON.stringify(f));
  });
  await t.test('paused site: the same drop stays quiet (it would only announce the pause, Tyto 2.3.0)', async () => {
    const later = now + 2 * 864e5; // a fresh day, outside the drop cooldown
    events(site.id, [{ ts: later - H / 2, vh: 'q1' }]);
    assert.strictEqual((await call('PATCH', '/api/sites/' + site.id, { paused: true })).status, 200);
    const f = (await call('POST', '/api/_test/alert-tick', { now: later })).j;
    assert.deepStrictEqual(f, [], JSON.stringify(f));
    assert.strictEqual((await call('PATCH', '/api/sites/' + site.id, { paused: false })).status, 200);
    const g = (await call('POST', '/api/_test/alert-tick', { now: later + 1 })).j;
    assert.ok(g.some((x) => x.kind === 'drop'), 'resumed: fires again ' + JSON.stringify(g));
  });
  await t.test('disabled rule does not fire', async () => {
    await call('PATCH', '/api/alerts/' + spike.id, { enabled: false });
    events(site.id, Array.from({ length: 90 }, (_, i) => ({ ts: now + 3 * 864e5 - H / 3, vh: 'x' + i })));
    const f = (await call('POST', '/api/_test/alert-tick', { now: now + 3 * 864e5 })).j;
    assert.ok(!f.some((x) => x.kind === 'spike'), JSON.stringify(f));
  });
  await t.test('test message reaches the webhook', async () => {
    got.length = 0;
    assert.strictEqual((await call('POST', `/api/alerts/${goal.id}/test`)).status, 200);
    await sleep(200);
    assert.match(got[0].content, /test message/);
  });
  await t.test('delete removes the rule', async () => {
    await call('DELETE', '/api/alerts/' + drop.id);
    assert.strictEqual((await call('GET', '/api/alerts?site=shop.test')).j.alerts.length, 2);
  });
});
