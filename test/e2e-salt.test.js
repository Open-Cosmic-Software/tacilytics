'use strict';
// End-to-end test of the daily salt (Tyto 🦉, 13.10.2026): a real server.js process,
// real requests to /api/collect, visitor hashes read back from the events table.
//
// Isolation: everything that could touch the live install is set explicitly, because the
// .env loader only fills variables that are still unset:
//   DB_PATH            → fresh tmp dir (so data/.day-salt is also in tmp, never the real one)
//   PORT               → random high port on 127.0.0.1
//   DIGEST_WEBHOOK_URL → 127.0.0.1:9 (discard), so a real webhook from .env can never fire
//   DATA_RETENTION_DAYS→ 0
//   INGEST_SALT, API_KEY, SESSION_SECRET → test values, so the live secrets from .env never
//                        go into hashes or tokens here (an empty string would not help: the
//                        loader treats '' as unset and fills it from .env)
// The test never reads or writes the repo's data/ directory.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'na-e2e-'));
const DB_PATH = path.join(dir, 'analytics.db');
const SALT = path.join(dir, '.day-salt');
const PORT = 39000 + Math.floor(Math.random() * 1000);
const ENV = {
  ...process.env, TACILYTICS_DATACENTER: 'off',
  DB_PATH, PORT: String(PORT),
  DIGEST_WEBHOOK_URL: 'http://127.0.0.1:9/', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 'e2e-test-salt', API_KEY: 'e2e-test-key', SESSION_SECRET: 'e2e-test-session',
  WEB_PASSWORD: 'e2e-' + Math.random().toString(36).slice(2),
};
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const UA2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Near midnight UTC the "today" of the test and of the server could differ. Skip then.
const msToMidnight = 86400000 - (Date.now() % 86400000);
const nearMidnight = msToMidnight < 60000;

let proc = null;
async function start() {
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); return; } catch { await sleep(100); }
  }
  throw new Error('server did not start: ' + err);
}
async function stop() {
  if (!proc) return;
  const p = proc; proc = null;
  if (p.exitCode !== null) return;
  p.kill('SIGTERM'); await new Promise((r) => p.on('exit', r));
}
async function hit(ua, pth = '/') {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'X-Forwarded-For': '203.0.113.7' },
    body: JSON.stringify({ d: 'e2e.test', p: pth }),
  });
  assert.ok(r.status < 300, 'collect status ' + r.status);
}
function vhs() {
  const db = new Database(DB_PATH, { readonly: true });
  const r = db.prepare('SELECT vh FROM events ORDER BY id').all().map((x) => x.vh);
  db.close(); return r;
}
function resetEvents() { const db = new Database(DB_PATH); db.prepare('DELETE FROM events').run(); db.close(); }
function writeSalt(s) { const b = Buffer.alloc(128, 0); b.write(s); fs.writeFileSync(SALT, b); }
const readSalt = () => fs.readFileSync(SALT, 'utf8').replace(/\0+$/, '');

test('day salt end to end (real server.js, real /api/collect)', { skip: nearMidnight && 'less than 60 s to UTC midnight' }, async (t) => {
  t.after(async () => { await stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const today = dayOf(Date.now());

  await start();
  { const db = new Database(DB_PATH); db.prepare("INSERT INTO sites (domain, name, created) VALUES ('e2e.test','e2e',?)").run(Date.now()); db.close(); }

  await hit(UA, '/a'); await hit(UA, '/b'); await hit(UA2, '/c');
  let v = vhs();
  await t.test('three requests land in the DB', () => assert.strictEqual(v.length, 3, JSON.stringify(v)));
  await t.test('same IP + UA → same visitor', () => assert.strictEqual(v[0], v[1]));
  await t.test('other UA → other visitor', () => assert.notStrictEqual(v[0], v[2]));
  const salt1 = readSalt();
  await t.test('salt file: today + 64 hex, 128 bytes, 0600', () => {
    assert.match(salt1, new RegExp(`^${today} [0-9a-f]{64}$`));
    assert.strictEqual(fs.statSync(SALT).size, 128);
    assert.strictEqual(fs.statSync(SALT).mode & 0o777, 0o600);
  });

  await stop(); await start();
  await hit(UA, '/d');
  v = vhs();
  await t.test('restart keeps the same visitor', () => assert.strictEqual(v[3], v[0]));

  await stop();
  const s = salt1.split(' ')[1];
  await t.test('salt is neither in the .db nor in the -wal', () => {
    for (const f of [DB_PATH, DB_PATH + '-wal'].filter((x) => fs.existsSync(x))) {
      assert.ok(!fs.readFileSync(f).toString('latin1').includes(s), 'salt bytes found in ' + path.basename(f));
    }
  });

  resetEvents(); writeSalt(`${today} abc`);
  await start(); await hit(UA); await hit(UA); await stop();
  v = vhs();
  await t.test("today's broken salt: same person = one visitor", () => {
    assert.strictEqual(v.length, 2); assert.strictEqual(v[0], v[1], JSON.stringify(v));
  });
  await t.test("today's broken salt is replaced", () => assert.match(readSalt().split(' ')[1] || '', /^[0-9a-f]{64}$/));

  resetEvents();
  const future = dayOf(Date.now() + 86400000); const fsalt = 'c'.repeat(64);
  writeSalt(`${future} ${fsalt}`);
  await start(); await hit(UA); await hit(UA); await stop();
  v = vhs();
  await t.test('salt file from a later day (clock went back) → unlinked one-off hashes', () => {
    assert.strictEqual(v.length, 2); assert.notStrictEqual(v[0], v[1]);
  });
  await t.test('salt file from a later day stays untouched', () => assert.ok(readSalt().startsWith(`${future} ${fsalt}`)));

  resetEvents();
  const yest = dayOf(Date.now() - 86400000); const ysalt = 'b'.repeat(64);
  writeSalt(`${yest} ${ysalt}`);
  await start(); await hit(UA); await hit(UA); await stop();
  v = vhs();
  await t.test("yesterday's salt is overwritten in place, one visitor", () => {
    assert.strictEqual(v[0], v[1]);
    const raw = fs.readFileSync(SALT).toString('latin1');
    assert.ok(!raw.includes(ysalt), 'old salt bytes still in the file');
    assert.ok(raw.startsWith(today));
  });
});
