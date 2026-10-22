'use strict';
// DASHBOARD_EXTRA_SCRIPT (hosting banner): only a same-origin path is ever added to the dashboard page.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWith(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-xs-'));
  const PORT = 48500 + Math.floor(Math.random() * 400);
  const env = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH: path.join(dir, 'a.db'), PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0',
    INGEST_SALT: 's', SESSION_SECRET: '***', TACILYTICS_ALERT_TICK: 'off', TRUST_PROXY: '0' };
  if (extra !== undefined) env.DASHBOARD_EXTRA_SCRIPT = extra; else delete env.DASHBOARD_EXTRA_SCRIPT;
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  try {
    let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); up = true; } catch { await sleep(100); } }
    const pages = [];
    for (const u of ['/', '/index.html', '/settings']) pages.push(await (await fetch(`http://127.0.0.1:${PORT}${u}`)).text());
    return pages;
  } finally { p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('extra dashboard script: same-origin path only, on every dashboard URL', async () => {
  for (const html of await pageWith('/cloud/ui.js')) assert.ok(html.includes('<script src="/cloud/ui.js" defer></script>'), 'added');
  for (const html of await pageWith(undefined)) assert.ok(!/cloud\/ui\.js/.test(html) && html.includes('</body>'), 'default: nothing');
  for (const bad of ['https://evil.example/x.js', '//evil.example/x.js', '/../x.js', '/x.js"><script>alert(1)</script>', 'cloud/ui.js']) {
    for (const html of await pageWith(bad)) assert.ok(!html.includes('evil') && !html.includes('alert(1)') && !/<script src="[^"]*x\.js/.test(html) && !html.includes('cloud/ui.js"'), 'refused: ' + bad);
  }
});
