'use strict';
// Hosting several customers on one instance (Tacilytics Cloud): an admin limited to some sites
// must stay inside them — sites, stats, alerts, shares — and a paused site must collect nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-ten-'));
const PORT = 45000 + Math.floor(Math.random() * 1000);
const KEY = 'k-tenancy-test';
const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), DIGEST_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/operator',
  DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-tenancy-test',
  TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function j(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const op = { Authorization: 'Bearer ' + KEY };

test('site-limited admins stay inside their sites; paused sites collect nothing', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/nyx.js'); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started ' + err);

  // operator: first owner + two customer sites
  const lg = await j('POST', '/auth/login', { password: 'pass-tenancy-test' });
  const legacy = { 'x-session-token': lg.data.token };
  const boot = await j('POST', '/api/team/bootstrap', { username: 'operator', password: 'operator-pass-123' }, legacy);
  assert.strictEqual(boot.status, 200);
  const owner = { 'x-session-token': boot.data.token };
  const a = (await j('POST', '/api/sites', { domain: 'alpha.test' }, owner)).data;
  const b = (await j('POST', '/api/sites', { domain: 'bravo.test' }, owner)).data;

  // invite an admin limited to alpha.test (the cloud's "customer")
  const inv = await j('POST', '/api/team/invites', { role: 'admin', sites: [a.id] }, owner);
  assert.strictEqual(inv.status, 200, JSON.stringify(inv.data));
  const join = await j('POST', '/api/invite/' + inv.data.url.split('/').pop(), { username: 'alice', password: 'alice-pass-1234' });
  assert.strictEqual(join.status, 200);
  const alice = { 'x-session-token': join.data.token };

  // 1) she sees only her site
  const list = await j('GET', '/api/sites', undefined, alice);
  assert.deepStrictEqual(list.data.map((s) => s.domain), ['alpha.test']);
  // 2) she cannot create sites at all (sites are billed and paused by the operator): new, foreign or her own domain
  for (const d of ['charlie.test', 'bravo.test', 'alpha.test']) {
    const r = await j('POST', '/api/sites', { domain: d }, alice);
    assert.strictEqual(r.status, 403, d);
    assert.ok(!r.data.id, 'no site returned for ' + d);
  }
  assert.strictEqual((await j('POST', '/api/v1/sites', { domain: 'charlie.test' }, alice)).status, 403, 'v1 route too');
  assert.deepStrictEqual((await j('GET', '/api/sites', undefined, alice)).data.map((s) => s.domain), ['alpha.test']);
  // 3) the operator adds a second site for her; it stays hers only
  const c = await j('POST', '/api/sites', { domain: 'charlie.test' }, op);
  assert.strictEqual(c.status, 200);
  const aliceUid = (await j('GET', '/api/team', undefined, owner)).data.users.find((u) => u.username === 'alice').id;
  assert.strictEqual((await j('PATCH', '/api/team/users/' + aliceUid, { sites: [a.id, c.data.id] }, owner)).status, 200);
  assert.deepStrictEqual((await j('GET', '/api/sites', undefined, alice)).data.map((s) => s.domain).sort(), ['alpha.test', 'charlie.test']);
  // 4) no access to the foreign site anywhere
  assert.strictEqual((await j('GET', '/api/stats?site=bravo.test&period=7d', undefined, alice)).status, 403);
  assert.strictEqual((await j('DELETE', '/api/sites/' + b.id, undefined, alice)).status, 403);
  assert.strictEqual((await j('POST', '/api/shares', { site: 'bravo.test' }, alice)).status, 403);
  assert.strictEqual((await j('GET', '/api/stats?site=alpha.test&period=7d', undefined, alice)).status, 200);
  // 5) no team, no audit (operator only)
  assert.strictEqual((await j('GET', '/api/team', undefined, alice)).status, 403);
  assert.strictEqual((await j('GET', '/api/audit', undefined, alice)).status, 403);
  // 6) the operator's webhook is not hers: an alert without her own webhook is refused, and the UI is told so
  const al = await j('POST', '/api/alerts', { site: 'alpha.test', kind: 'spike' }, alice);
  assert.strictEqual(al.status, 400);
  assert.strictEqual((await j('GET', '/api/alerts?site=alpha.test', undefined, alice)).data.fallbackWebhook, false);
  assert.strictEqual((await j('GET', '/api/alerts?site=alpha.test', undefined, owner)).data.fallbackWebhook, true);
  assert.strictEqual((await j('POST', '/api/alerts', { site: 'alpha.test', kind: 'spike' }, owner)).status, 200, 'owner still uses the fallback');
  // 7) she cannot pause (the operator's switch), not even her own site
  assert.strictEqual((await j('PATCH', '/api/sites/' + a.id, { paused: true }, alice)).status, 403);
  assert.strictEqual((await j('PATCH', '/api/sites/' + a.id, { timezone: 'Europe/Berlin' }, alice)).status, 200, 'time zone is hers');

  // 8) paused: collect ignores it, resume counts again
  const hit = (d) => fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ d, p: '/' }) });
  assert.strictEqual((await hit('alpha.test')).status, 204);
  assert.strictEqual((await j('PATCH', '/api/sites/' + a.id, { paused: true }, op)).status, 200);
  assert.strictEqual((await hit('alpha.test')).status, 202);
  const st = await j('GET', '/api/stats?site=alpha.test&period=today', undefined, owner);
  assert.strictEqual(st.data.totals.pageviews, 1, 'the paused hit was not stored');
  const site = (await j('GET', '/api/sites', undefined, owner)).data.find((s) => s.domain === 'alpha.test');
  assert.strictEqual(site.paused, 1);
  assert.strictEqual(site.timezone, 'Europe/Berlin', 'pausing kept the time zone');
  await j('PATCH', '/api/sites/' + a.id, { paused: false }, op);
  assert.strictEqual((await hit('alpha.test')).status, 204);

  // 9) usage per month: operator only (the server key / an owner), counts page views, not events
  await fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify({ d: 'alpha.test', p: '/x', n: 'Purchase' }) });
  const month = new Date().toISOString().slice(0, 7);
  const use = await j('GET', '/api/v1/usage?month=' + month, undefined, op);
  assert.strictEqual(use.status, 200);
  assert.strictEqual(use.data.find((u) => u.domain === 'alpha.test').pageviews, 2, 'two page views, the Purchase event not counted');
  assert.strictEqual(use.data.find((u) => u.domain === 'bravo.test').pageviews, 0);
  assert.strictEqual((await j('GET', '/api/v1/usage?month=' + month, undefined, alice)).status, 403, 'customers cannot see other sites\' volume');
  assert.strictEqual((await j('GET', '/api/v1/usage?month=2026-13', undefined, op)).status, 400);
  assert.strictEqual((await j('GET', '/api/v1/usage?month=1999-01', undefined, op)).data[0].pageviews, 0);

  // 9b) a limited account cannot hard-delete its OWN site either: that would end the pause and reset usage (Tyto/Kiro 2.3.0)
  assert.strictEqual((await j('PATCH', '/api/sites/' + a.id, { paused: true }, op)).status, 200);
  assert.strictEqual((await j('DELETE', '/api/sites/' + a.id, undefined, alice)).status, 403);
  const kept = (await j('GET', '/api/sites', undefined, owner)).data.find((s) => s.domain === 'alpha.test');
  assert.ok(kept && kept.paused === 1, 'site still there and still paused');
  assert.strictEqual((await j('GET', '/api/v1/usage?month=' + month, undefined, op)).data.find((u) => u.domain === 'alpha.test').pageviews, 2, 'usage unchanged');
  // Kiro: paused, she adds a fresh unpaused site and moves data-domain → refused
  assert.strictEqual((await j('POST', '/api/sites', { domain: 'shop.beispiel.de' }, alice)).status, 403);
  assert.ok(!(await j('GET', '/api/sites', undefined, owner)).data.some((s) => s.domain === 'shop.beispiel.de'), 'no new site exists');
  await j('PATCH', '/api/sites/' + a.id, { paused: false }, op);
  // the operator still deletes (cloud.js uses the server key)
  const tmp = (await j('POST', '/api/sites', { domain: 'delete-me.test' }, owner)).data;
  assert.strictEqual((await j('DELETE', '/api/sites/' + tmp.id, undefined, op)).status, 200);

  // 10) the owner can widen or narrow an admin's sites; an unlimited admin sees everything
  const team = (await j('GET', '/api/team', undefined, owner)).data.users;
  const aliceId = team.find((u) => u.username === 'alice').id;
  const aliceSites = team.find((u) => u.username === 'alice').sites;
  assert.ok([a.id, c.data.id].every((x) => aliceSites.includes(x)) && !aliceSites.includes(b.id), JSON.stringify(aliceSites));
  assert.strictEqual((await j('PATCH', '/api/team/users/' + aliceId, { sites: null }, owner)).status, 200);
  assert.strictEqual((await j('GET', '/api/sites', undefined, alice)).data.length, (await j('GET', '/api/sites', undefined, owner)).data.length, 'unlimited: sees everything');
  // an owner is never limited
  const up2 = await j('PATCH', '/api/team/users/' + aliceId, { role: 'owner', sites: [a.id] }, owner);
  assert.strictEqual(up2.data.sites, null);
});
