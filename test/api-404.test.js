'use strict';
// Kiro (2.2.0): an unknown /api path must be a JSON 404, never the SPA page with 200 —
// and the dashboard's call() must treat a non-JSON body as an error, never as {} or a string.
// (Live 2.1.0 answered /api/audit with index.html → "rows.map is not a function" in Settings → Activity.)
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-404-'));
const PORT = 44000 + Math.floor(Math.random() * 1000);
const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 's', API_KEY: 'k-404-test', SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-404-test', TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('unknown /api and /auth paths → 404 JSON; the SPA still serves its own paths', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started');
  const H = { Authorization: 'Bearer k-404-test' };
  for (const [m, p] of [['GET', '/api/does-not-exist'], ['GET', '/api/'], ['GET', '/api'], ['POST', '/api/nope'], ['DELETE', '/api/x/y'], ['GET', '/auth/nope']]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method: m, headers: H });
    assert.strictEqual(r.status, 404, `${m} ${p}`);
    assert.match(r.headers.get('content-type') || '', /json/, `${m} ${p} content-type`);
    assert.deepStrictEqual(await r.json(), { error: 'Not found' }, `${m} ${p}`);
  }
  // existing API routes and the SPA are untouched
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/api/sites`, { headers: H })).status, 200);
  assert.strictEqual((await fetch(`http://127.0.0.1:${PORT}/auth/status`)).status, 200);
  for (const p of ['/', '/settings', '/apiary', '/authors']) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
    assert.strictEqual(r.status, 200, p); assert.match(r.headers.get('content-type'), /html/, p);
  }
});

test('account.js call(): HTML or a broken body is an error, not {} (rows.map can never see a string)', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'account.js'), 'utf8');
  const body = src.slice(src.indexOf('  function readJson(r)'), src.indexOf('  // ── WebAuthn'));
  const mk = (status, ct, text) => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
    json: () => Promise.resolve().then(() => JSON.parse(text)) });
  let next;
  const ctx = { fetch: () => Promise.resolve(next), localStorage: { getItem: () => 't' }, JSON, Promise, Error, window: {} };
  vm.runInNewContext(body + '\nthis.call = call;', ctx);
  const html = '<!doctype html><html>…</html>';
  next = mk(200, 'text/html; charset=UTF-8', html);
  await assert.rejects(ctx.call('GET', '/api/audit'), /did not answer with JSON \(HTTP 200\)/);
  next = mk(200, 'application/json', '{broken');
  await assert.rejects(ctx.call('GET', '/api/audit'), /did not answer with JSON/);
  next = mk(502, 'text/html', '<h1>Bad gateway</h1>');
  await assert.rejects(ctx.call('GET', '/api/audit'), /HTTP 502/);
  next = mk(400, 'application/json; charset=utf-8', '{"error":"Nope"}');
  await assert.rejects(ctx.call('POST', '/api/me/password', {}), /^Error: Nope$/);
  next = mk(200, 'application/json; charset=utf-8', '[{"ts":1}]');
  assert.deepStrictEqual(await ctx.call('GET', '/api/audit'), [{ ts: 1 }]);
});

test('the fallbacks are registered after every other route (a later route would be dead)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const fallback = src.indexOf("app.all(/^\\/(api|auth)(\\/|$)/");
  assert.ok(fallback > 0, 'API 404 fallback present');
  const after = src.slice(fallback).split('\n').slice(2).filter((l) => /\bapp\.(get|post|put|patch|delete|use|all)\(/.test(l));
  assert.deepStrictEqual(after, []);
});

test('app.js api() and account.js post() use readJson too — no silent {} on the main path (Tyto)', async () => {
  const acc = fs.readFileSync(path.join(ROOT, 'public', 'account.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(acc + app, /\.json\(\)\.catch\(function \(\) \{ return \{\}; \}\)/, 'no json().catch(() => ({})) left');
  const mk = (status, ct, text) => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
    json: () => Promise.resolve().then(() => JSON.parse(text)) });
  let next; const win = {};
  const ctx = { fetch: () => Promise.resolve(next), localStorage: { getItem: () => 't' }, JSON, Promise, Error, window: win };
  const accBody = acc.slice(acc.indexOf('  function post('), acc.indexOf('  // ── WebAuthn'));
  vm.runInNewContext(accBody + '\nthis.post = post; this.readJson = readJson;', ctx);
  assert.strictEqual(typeof win.TaciReadJson, 'function', 'account.js exports readJson for app.js');
  const apiBody = app.slice(app.indexOf('  function api('), app.indexOf('  // ── flags / names'));
  const ctx2 = { fetch: () => Promise.resolve(next), window: win, TOKEN: 't', SHARE: '', showLogin: () => {}, Object, Promise, Error };
  vm.runInNewContext(apiBody + '\nthis.api = api;', ctx2);
  const html = '<!doctype html><html>…</html>';
  // api(): the dashboard's main path
  next = mk(200, 'text/html', html); await assert.rejects(ctx2.api('/api/stats?x'), /did not answer with JSON \(HTTP 200\)/);
  next = mk(502, 'text/html', '<h1>Bad gateway</h1>'); await assert.rejects(ctx2.api('/api/stats?x'), /HTTP 502/);
  next = mk(400, 'application/json', '{"error":"Unknown site"}'); assert.deepStrictEqual(await ctx2.api('/api/stats?x'), { error: 'Unknown site' }, 'JSON errors still come back as {error}');
  next = mk(200, 'application/json', '{"totals":{}}'); assert.deepStrictEqual(await ctx2.api('/api/stats?x'), { totals: {} });
  // post(): login / bootstrap / reset — a missing route is a visible error, not {}
  next = mk(200, 'text/html', html);
  let r = await ctx.post('/auth/login', {}); assert.strictEqual(r.ok, false); assert.match(r.j.error, /did not answer with JSON/);
  next = mk(401, 'application/json', '{"error":"Wrong password"}');
  r = await ctx.post('/auth/login', {}); assert.deepStrictEqual([r.ok, r.status, r.j.error], [false, 401, 'Wrong password']);
  // 204: no body by definition → null, never an exception (Kiro)
  next = mk(204, null, ''); assert.strictEqual(await ctx.readJson(next), null);
  r = await ctx.post('/x', {}); assert.deepStrictEqual([r.ok, r.status, JSON.stringify(r.j)], [true, 204, '{}']);
});
