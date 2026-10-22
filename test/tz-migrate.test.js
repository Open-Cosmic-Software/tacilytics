'use strict';
// Tyto 5: sites that existed before time zones must stay on UTC after the upgrade, so old numbers do not
// shift silently. Build the 2.1.0 schema from the live worktree's server (master), then start this server on it.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');

async function boot(cwd, env) {
  const p = spawn(process.execPath, [path.join(cwd, 'server.js')], { cwd, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${env.PORT}/nyx.js`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  return p;
}
const stop = (p) => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); });

test('existing sites default to UTC after the upgrade (Tyto 5)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-mig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const DB_PATH = path.join(dir, 'a.db');
  // the real 2.1.0 server (tag v2.1.0, pinned: master moves on with every release) creates the DB and a site, then this server opens it
  const wt = path.join(dir, 'old');
  execFileSync('git', ['worktree', 'add', '--detach', wt, 'v2.1.0'], { cwd: ROOT, stdio: 'ignore' });
  t.after(() => execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT, stdio: 'ignore' }));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(wt, 'node_modules'));
  assert.ok(!/timezone/.test(fs.readFileSync(path.join(wt, 'server.js'), 'utf8').match(/CREATE TABLE IF NOT EXISTS sites \([^;]*/)[0]), 'v2.1.0 has no timezone column');
  const env = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(46000 + Math.floor(Math.random() * 1000)), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', SESSION_SECRET: 'x', TACILYTICS_ALERT_TICK: 'off' };
  const p0 = await boot(wt, env);
  const db0 = new Database(DB_PATH);
  db0.prepare('INSERT INTO sites (domain, created) VALUES (?, ?)').run('old.test', Date.now());
  db0.close(); await stop(p0);
  assert.ok(!new Database(DB_PATH, { readonly: true }).prepare('PRAGMA table_info(sites)').all().some((c) => c.name === 'timezone'), '2.1.0 DB has no timezone yet');
  const p = await boot(ROOT, env); await stop(p);
  const db = new Database(DB_PATH, { readonly: true });
  assert.ok(db.prepare('PRAGMA table_info(sites)').all().some((c) => c.name === 'timezone'), 'column added');
  assert.strictEqual(db.prepare("SELECT timezone FROM sites WHERE domain = 'old.test'").get().timezone, 'UTC');
  db.close();
});
