'use strict';
// Footer version (Fabian, 2.2.0) — but only behind auth (Tyto): /api/me carries package.json's version;
// /auth/status, share-info and the static page carry none.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-ver-'));
const PORT = 45000 + Math.floor(Math.random() * 1000);
const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 's', API_KEY: 'k-ver-test', SESSION_SECRET: 'sess-ver-test', WEB_PASSWORD: 'pass-ver-test', TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (p) => `http://127.0.0.1:${PORT}${p}`;
const H = { Authorization: 'Bearer ' + 'k-ver-test', 'Content-Type': 'application/json' };

test('version: in /api/me (auth) only — never in public answers', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(U('/nyx.js')); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started');

  const me = await (await fetch(U('/api/me'), { headers: H })).json();
  assert.strictEqual(me.version, VERSION, '/api/me.version = package.json');
  assert.strictEqual((await fetch(U('/api/me'))).status, 401, '/api/me needs auth');

  await fetch(U('/api/sites'), { method: 'POST', headers: H, body: JSON.stringify({ domain: 'v.test' }) });
  const site = (await (await fetch(U('/api/sites'), { headers: H })).json()).find((s) => s.domain === 'v.test');
  const share = await (await fetch(U('/api/shares'), { method: 'POST', headers: H, body: JSON.stringify({ site_id: site.id, site: 'v.test' }) })).json();
  const tok = share.token || (share.url || '').split('/').pop();
  assert.match(tok || '', /^[a-f0-9]{32,64}$/, 'share token created: ' + JSON.stringify(share));

  const esc = VERSION.replace(/\./g, '\\.');
  const leak = new RegExp(`"version"|${esc}`);
  for (const p of ['/auth/status', '/api/share-info/' + tok, '/', '/share/' + tok, '/nyx.js', '/api/does-not-exist']) {
    const r = await fetch(U(p)); const body = await r.text();
    assert.doesNotMatch(body, leak, `${p} must not reveal the version`);
    assert.doesNotMatch(r.headers.get('x-powered-by') || '', /\d/, `${p} header`);
  }
});

test('footer: the version slot is empty in the HTML and filled only from /api/me', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /<span id="appVersion"><\/span>/);
  const acc = fs.readFileSync(path.join(ROOT, 'public', 'account.js'), 'utf8');
  assert.match(acc, /showVersion\(m\.version\)/);
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /function showLogin\(\)[^\n]*appVersion[^\n]*textContent = ''/, 'logout/401 clears the version');
});
