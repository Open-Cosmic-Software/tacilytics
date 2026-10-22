'use strict';
// TRUST_PROXY > 0 but no HTTP proxy in front (socat / ssh -L): requests arrive without
// X-Forwarded-For → exactly one warning in the log. Requests with XFF never warn.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WARN = /without X-Forwarded-For/g;

async function run(trust, requests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-tp-'));
  const PORT = 40000 + Math.floor(Math.random() * 1000);
  const env = { PATH: process.env.PATH, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), WEB_PASSWORD: 'tp-test-' + Date.now(), TRUST_PROXY: String(trust) };
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; p.stderr.on('data', (d) => (err += d));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/auth/status`, { headers: { 'X-Forwarded-For': '203.0.113.1' } }); up = true; } catch { await sleep(100); }
    }
    assert.ok(up, 'server did not start: ' + err);
    for (const xff of requests) await fetch(`http://127.0.0.1:${PORT}/auth/status`, { headers: xff ? { 'X-Forwarded-For': xff } : {} });
    await sleep(100);
    return (err.match(WARN) || []).length;
  } finally {
    p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('TRUST_PROXY=1, requests without XFF → warning exactly once', async () => {
  assert.strictEqual(await run(1, [null, null, null]), 1);
});
test('TRUST_PROXY=1, every request through a proxy (XFF set) → no warning', async () => {
  assert.strictEqual(await run(1, ['198.51.100.1', '198.51.100.2']), 0);
});
test('TRUST_PROXY=0 → no warning, even without XFF', async () => {
  assert.strictEqual(await run(0, [null, null]), 0);
});
