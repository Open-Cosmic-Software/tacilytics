'use strict';
// Server mode (2.4): the website's own server reports page views to POST /api/v1/hit — no script on the
// visitor's device. The visitor IP is only accepted from an authenticated write key, prefetch / bots / a
// missing IP are refused, and a site-limited key only reaches its own sites.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-srv-'));
const DB_PATH = path.join(dir, 'a.db');
const PORT = 46000 + Math.floor(Math.random() * 1000);
const KEY = 'k-server-mode-test';
const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off',
  DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-server-mode',
  TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA2 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function j(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const op = { Authorization: 'Bearer ' + KEY };
const rows = () => { const db = new Database(DB_PATH, { readonly: true }); const r = db.prepare('SELECT site_id, path, source, referrer, country, tz, lang, browser, device, name, utm_medium, vh FROM events ORDER BY id').all(); db.close(); return r; };

test('server mode: POST /api/v1/hit', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/nyx.js'); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started ' + err);

  const lg = await j('POST', '/auth/login', { password: 'pass-server-mode' });
  const boot = await j('POST', '/api/team/bootstrap', { username: 'operator', password: 'operator-pass-123' }, { 'x-session-token': lg.data.token });
  const owner = { 'x-session-token': boot.data.token };
  const a = (await j('POST', '/api/sites', { domain: 'alpha.test' }, owner)).data;
  const b = (await j('POST', '/api/sites', { domain: 'bravo.test' }, owner)).data;
  // customer: admin limited to alpha.test, with a write key and a read-only key
  const inv = await j('POST', '/api/team/invites', { role: 'admin', sites: [a.id] }, owner);
  const join = await j('POST', '/api/invite/' + inv.data.url.split('/').pop(), { username: 'alice', password: 'alice-pass-1234' });
  const alice = { 'x-session-token': join.data.token };
  const wk = (await j('POST', '/api/me/keys', { name: 'server', readOnly: false }, alice)).data.key;
  const rk = (await j('POST', '/api/me/keys', { name: 'read' }, alice)).data.key;
  assert.ok(wk && rk, 'keys created');
  const write = { Authorization: 'Bearer ' + wk };
  const hit = (body, headers = write) => j('POST', '/api/v1/hit', { domain: 'alpha.test', ua: UA, ip: '198.51.100.7', ...body }, headers);

  await t.test('no key → 401, read-only key → 403, nothing stored', async () => {
    assert.strictEqual((await hit({ path: '/nokey' }, {})).status, 401);
    assert.strictEqual((await hit({ path: '/readonly' }, { Authorization: 'Bearer ' + rk })).status, 403);
    assert.strictEqual((await hit({ path: '/wrongkey' }, { Authorization: 'Bearer tk_nope' })).status, 401);
    assert.ok(!rows().some((r) => ['/nokey', '/readonly', '/wrongkey'].includes(r.path)));
  });

  await t.test('the public /api/collect never takes an IP from the body', async () => {
    await fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': UA }, body: JSON.stringify({ d: 'alpha.test', p: '/c1', ip: '198.51.100.7' }) });
    await fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': UA }, body: JSON.stringify({ d: 'alpha.test', p: '/c2', ip: '203.0.113.99' }) });
    const r = rows().filter((x) => x.path === '/c1' || x.path === '/c2');
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].vh, r[1].vh, 'both hashed from the connection IP, the body ip was ignored');
  });

  await t.test('a page view: path, referrer → source, UTM, language from Accept-Language, no tz/country', async () => {
    assert.strictEqual((await hit({ path: '/shop/?utm_source=news&utm_medium=email', referrer: 'https://search.example/q', lang: 'de-DE,de;q=0.9' })).status, 204);
    const r = rows().find((x) => x.path === '/shop');
    assert.ok(r, JSON.stringify(rows()));
    assert.deepStrictEqual({ source: r.source, medium: r.utm_medium, lang: r.lang, tz: r.tz, country: r.country, browser: r.browser, referrer: r.referrer },
      { source: 'news', medium: 'email', lang: 'de-DE', tz: null, country: null, browser: 'Chrome', referrer: 'https://search.example/q' });
    await hit({ path: '/ref', referrer: 'https://other.example/x' });
    assert.strictEqual(rows().find((x) => x.path === '/ref').source, 'other.example');
  });

  await t.test('visitor hash: same IP+UA = one visitor, other IP or UA = another', async () => {
    await hit({ path: '/v1' }); await hit({ path: '/v2' });
    await hit({ path: '/v3', ip: '198.51.100.8' }); await hit({ path: '/v4', ua: UA2 });
    const by = Object.fromEntries(rows().map((x) => [x.path, x.vh]));
    assert.strictEqual(by['/v1'], by['/v2']);
    assert.notStrictEqual(by['/v1'], by['/v3']);
    assert.notStrictEqual(by['/v1'], by['/v4']);
  });

  await t.test('missing / invalid visitor IP → 400 (would merge all visitors)', async () => {
    assert.strictEqual((await hit({ path: '/noip', ip: undefined })).status, 400);
    assert.strictEqual((await hit({ path: '/badip', ip: 'not-an-ip' })).status, 400);
    assert.ok(!rows().some((r) => r.path === '/noip' || r.path === '/badip'));
  });

  await t.test('prefetch / prerender, bots, empty UA and forwarded DNT/GPC are dropped', async () => {
    assert.strictEqual((await hit({ path: '/pf1', purpose: 'prefetch' })).status, 204);
    assert.strictEqual((await hit({ path: '/pf2', purpose: 'prefetch;prerender' })).status, 204);
    assert.strictEqual((await hit({ path: '/bot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).status, 204);
    assert.strictEqual((await hit({ path: '/noua', ua: '' })).status, 204);
    assert.strictEqual((await hit({ path: '/dnt', dnt: true })).status, 204);
    assert.strictEqual((await hit({ path: '/gpc', gpc: '1' })).status, 204);
    const p = rows().map((r) => r.path);
    for (const x of ['/pf1', '/pf2', '/bot', '/noua', '/dnt', '/gpc']) assert.ok(!p.includes(x), x + ' stored');
  });

  await t.test('a limited key cannot report for a foreign site; the operator key can', async () => {
    assert.strictEqual((await hit({ domain: 'bravo.test', path: '/foreign' })).status, 404);
    assert.strictEqual((await hit({ domain: 'nope.test', path: '/unknown' })).status, 404);
    assert.strictEqual((await hit({ domain: 'bravo.test', path: '/opok' }, op)).status, 204);
    const r = rows();
    assert.ok(!r.some((x) => x.path === '/foreign'));
    assert.strictEqual(r.find((x) => x.path === '/opok').site_id, b.id);
  });

  await t.test('a paused site collects nothing via server mode either', async () => {
    const db = new Database(DB_PATH); db.prepare('UPDATE sites SET paused = 1 WHERE id = ?').run(a.id); db.close();
    assert.strictEqual((await hit({ path: '/paused' })).status, 202);
    assert.ok(!rows().some((x) => x.path === '/paused'));
    const db2 = new Database(DB_PATH); db2.prepare('UPDATE sites SET paused = 0 WHERE id = ?').run(a.id); db2.close();
  });

  // ── 2.4.1: server-mode (count only) keys ──
  const mk = async (body, who = alice) => j('POST', '/api/me/keys', { name: 'srv', ...body }, who);
  const hk = (await mk({ scope: 'hit', sites: [a.id] })).data.key;
  const hitH = { Authorization: 'Bearer ' + hk };

  await t.test('a hit key reports for its site', async () => {
    assert.strictEqual((await hit({ path: '/hk-ok' }, hitH)).status, 204);
    assert.ok(rows().some((r) => r.path === '/hk-ok' && r.site_id === a.id));
  });

  await t.test('a hit key gets 403 on every other route, reads included', async () => {
    const routes = [
      ['GET', '/api/sites'], ['GET', '/api/v1/sites'], ['GET', '/api/stats?site=alpha.test'], ['GET', '/api/v1/stats?site=alpha.test'],
      ['GET', '/api/realtime?site=alpha.test'], ['GET', '/api/v1/realtime?site=alpha.test'], ['GET', '/api/v1/usage'],
      ['GET', '/api/me'], ['GET', '/api/me/keys'], ['POST', '/api/me/keys'], ['GET', '/api/team'], ['POST', '/api/team/invites'],
      ['GET', '/api/shares?site=alpha.test'], ['POST', '/api/shares', { site: 'alpha.test' }],
      ['GET', '/api/alerts?site=alpha.test'], ['POST', '/api/alerts', { site: 'alpha.test', type: 'spike' }],
      ['GET', '/api/imports?site=alpha.test'], ['DELETE', '/api/imports/1'],
      ['GET', '/api/annotations?site=alpha.test'], ['POST', '/api/annotations', { site: 'alpha.test', day: '2026-10-15', text: 'x' }],
      ['GET', '/api/funnels?site=alpha.test'], ['POST', '/api/funnels', { site: 'alpha.test', name: 'f', steps: [] }],
      ['POST', '/api/sites', { domain: 'x.test' }], ['POST', '/api/v1/sites', { domain: 'x.test' }], ['PATCH', '/api/sites/' + a.id, { tz: 'Europe/Berlin' }],
      ['DELETE', '/api/sites/' + a.id], ['GET', '/api/audit'], ['POST', '/api/me/password', {}],
    ];
    for (const [m, u, body] of routes) {
      const r = await j(m, u, body, hitH);
      assert.strictEqual(r.status, 403, `${m} ${u} → ${r.status}`);
    }
    const r = await fetch(base + '/api/imports?site=alpha.test', { method: 'POST', headers: { ...hitH, 'Content-Type': 'application/octet-stream' }, body: 'x' });
    assert.strictEqual(r.status, 403, 'raw import upload');
  });

  await t.test('a hit key is bound to the sites it was created for', async () => {
    assert.strictEqual((await hit({ domain: 'bravo.test', path: '/hk-foreign' }, hitH)).status, 404);
    // the operator can bind one to bravo only → it cannot report for alpha
    const ob = (await mk({ scope: 'hit', sites: [b.id] }, owner)).data.key;
    assert.strictEqual((await hit({ domain: 'alpha.test', path: '/hk-ob-a' }, { Authorization: 'Bearer ' + ob })).status, 404);
    assert.strictEqual((await hit({ domain: 'bravo.test', path: '/hk-ob-b' }, { Authorization: 'Bearer ' + ob })).status, 204);
    assert.ok(!rows().some((r) => r.path === '/hk-foreign' || r.path === '/hk-ob-a'));
  });

  await t.test('a hit key can never cover more than its account', async () => {
    assert.strictEqual((await mk({ scope: 'hit', sites: [b.id] })).status, 403, 'alice cannot bind bravo');
    assert.strictEqual((await mk({ scope: 'hit', sites: [a.id, b.id] })).status, 403);
    assert.strictEqual((await mk({ scope: 'hit', sites: [] })).status, 400);
    assert.strictEqual((await mk({ scope: 'hit' })).status, 400);
    assert.strictEqual((await mk({ scope: 'hit', sites: [99999] })).status, 403);
    // narrowing the account later narrows its existing hit keys too
    const db = new Database(DB_PATH);
    const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
    db.prepare("INSERT INTO api_keys (key_hash, prefix, user_id, name, read_only, scope, sites, created) VALUES (?, 'tk_x', ?, 'forged', 1, 'hit', ?, ?)")
      .run(require('crypto').createHash('sha256').update('tk_forgedforgedforgedforged').digest('hex'), aliceId, JSON.stringify([a.id, b.id]), Date.now());
    db.close();
    assert.strictEqual((await hit({ domain: 'bravo.test', path: '/hk-forged' }, { Authorization: 'Bearer tk_forgedforgedforgedforged' })).status, 404);
  });

  await t.test('a viewer cannot create a hit key (it would let a read-only role add visitors)', async () => {
    const inv2 = await j('POST', '/api/team/invites', { role: 'viewer', sites: [a.id] }, owner);
    const vj = await j('POST', '/api/invite/' + inv2.data.url.split('/').pop(), { username: 'vera', password: 'vera-pass-12345' });
    assert.ok(vj.data.token, 'viewer joined: ' + JSON.stringify(inv2.data) + ' ' + JSON.stringify(vj.data));
    const vera = { 'x-session-token': vj.data.token };
    assert.strictEqual((await mk({ scope: 'hit', sites: [a.id] }, vera)).status, 403, 'viewer creates hit key');
    const db = new Database(DB_PATH, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) n FROM api_keys k JOIN users u ON u.id = k.user_id WHERE u.username = 'vera'").get().n;
    db.close();
    assert.strictEqual(n, 0, 'nothing stored');
    // and a viewer's read-only key still cannot report
    const vk = (await mk({}, vera)).data.key;
    assert.ok(vk, 'viewer read-only key');
    assert.strictEqual((await hit({ path: '/vera' }, { Authorization: 'Bearer ' + vk })).status, 403, 'viewer key on /hit');
  });

  await t.test('old keys keep exactly their rights; hits do not flood the audit log', async () => {
    const keys = (await j('GET', '/api/me/keys', undefined, alice)).data;
    assert.strictEqual(keys.find((k) => k.name === 'server').scope, '');
    assert.strictEqual(keys.find((k) => k.name === 'read').read_only, true);
    assert.strictEqual((await j('GET', '/api/v1/sites', undefined, { Authorization: 'Bearer ' + rk })).status, 200, 'read-only key still reads');
    assert.strictEqual((await hit({ path: '/wk-still' })).status, 204, 'write key still reports (2.4.0 compatible)');
    const db = new Database(DB_PATH, { readonly: true });
    const n = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE '%/api/v1/hit%'").get().n;
    const add = db.prepare("SELECT target FROM audit_log WHERE action = 'me.apikey.add' AND target LIKE '%server mode%'").all();
    db.close();
    assert.strictEqual(n, 0, 'page views are not audit events');
    assert.ok(add.length >= 1, 'creating a hit key is audited');
  });

  await t.test('rate limit is per key, not per web-server IP', async () => {
    const k1 = (await mk({ scope: 'hit', sites: [a.id] })).data.key;
    const k2 = (await mk({ scope: 'hit', sites: [a.id] })).data.key;
    const fire = (k) => fetch(base + '/api/v1/hit', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: JSON.stringify({ domain: 'alpha.test', path: '/rl', ip: '198.51.100.9', ua: UA }) }).then((r) => r.status);
    let last = 0;
    for (let i = 0; i < 6001; i += 200) { const st = await Promise.all(Array.from({ length: Math.min(200, 6001 - i) }, () => fire(k1))); last = st[st.length - 1]; }
    assert.strictEqual(last, 429, 'k1 exhausted');
    assert.strictEqual(await fire(k2), 204, 'k2 from the same IP is not affected');
  });

  await t.test('optional server-side goal with properties', async () => {
    await hit({ path: '/checkout/finish', name: 'Purchase', props: { value: 49.9, currency: 'EUR' } });
    const r = rows().find((x) => x.path === '/checkout/finish');
    assert.strictEqual(r.name, 'Purchase');
  });
});
