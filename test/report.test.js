'use strict';
// Weekly e-mail report: settings API, Monday tick, content, opt-out — with a tiny local SMTP sink.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-report-'));
const DB_PATH = path.join(dir, 'analytics.db');
const PORT = 43000 + Math.floor(Math.random() * 1000);
const SMTP_PORT = PORT + 1000;
const KEY = 'report-key-' + crypto.randomBytes(4).toString('hex');

// minimal SMTP server: accepts everything, keeps the DATA part
const mails = [];
const smtp = net.createServer((sock) => {
  let buf = '', inData = false, data = '', rcpt = [];
  sock.write('220 sink ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; mails.push({ rcpt, data }); data = ''; rcpt = []; sock.write('250 queued\r\n'); }
        else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250 OK\r\n');
      else if (cmd === 'RCPT') { rcpt.push(line.replace(/^RCPT TO:\s*/i, '')); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
});

const ENV = {
  ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0',
  INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'report-pass-1234', TRUST_PROXY: '0',
  TACILYTICS_TEST_HOOKS: '1', TACILYTICS_ALERT_TICK: 'off', TACILYTICS_ORIGIN: 'https://analytics.example.com',
  SMTP_URL: `smtp://127.0.0.1:${SMTP_PORT}?ignoreTLS=true`, REPORT_FROM: 'Tacilytics <reports@example.com>', REPORT_HOUR_UTC: '6',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null;
async function start() {
  proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => (err += d));
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); return; } catch { await sleep(100); } }
  throw new Error('server did not start: ' + err);
}
async function call(method, p, { token, body, key } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['x-session-token'] = token;
  if (key) h.Authorization = 'Bearer ' + key;
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
function events(siteId, list) {
  const d = new Database(DB_PATH);
  const ins = d.prepare('INSERT INTO events (site_id, ts, day, path, source, name, vh, country, device, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  d.transaction(() => { for (const e of list) ins.run(siteId, e.ts, new Date(e.ts).toISOString().slice(0, 10), e.path || '/', e.source || null, e.name || null, e.vh, e.country || null, e.device || null, e.props || null); })();
  d.close();
}
// quoted-printable soft breaks + =XX → plain text, enough for assertions
// (bytes → UTF-8, so € / Ö / flags survive). Base64 parts are decoded too.
const qp = (s) => {
  const out = s.replace(/=\n/g, '').replace(/(?:=[0-9A-F]{2})+/g, (m) => Buffer.from(m.split('=').slice(1).map((h) => parseInt(h, 16))).toString('utf8'));
  return out.replace(/Content-Transfer-Encoding: base64\n\n([A-Za-z0-9+/=\n]+)/g, (_, b) => Buffer.from(b.replace(/\n/g, ''), 'base64').toString('utf8'));
};

test('weekly report', async (t) => {
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  t.after(async () => { if (proc) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await start();
  const a = (await call('POST', '/api/sites', { key: KEY, body: { domain: 'a.test' } })).j;
  const b = (await call('POST', '/api/sites', { key: KEY, body: { domain: 'b.test' } })).j;
  const legacy = (await call('POST', '/auth/login', { body: { password: 'report-pass-1234' } })).j.token;
  const owner = (await call('POST', '/api/team/bootstrap', { token: legacy, body: { username: 'fabi', password: 'owner-password-1' } })).j.token;
  const inv = (await call('POST', '/api/team/invites', { token: owner, body: { role: 'viewer', sites: [a.id] } })).j.url.split('/').pop();
  const viewer = (await call('POST', '/api/invite/' + inv, { body: { username: 'vera', password: 'viewer-password-1' } })).j.token;

  const monday = Date.UTC(2026, 9, 19, 6, 5); // Mon 19 Oct 2026, 06:05 UTC
  const day = 864e5;
  // this week: a.test 30 visitors, b.test 5; week before: a.test 20
  events(a.id, Array.from({ length: 30 }, (_, i) => ({ ts: monday - 3 * day, vh: 'a' + i, path: i < 20 ? '/pasta' : '/', source: i < 10 ? 'google.com' : null, country: i < 24 ? 'AT' : 'CH', device: i < 18 ? 'Mobile' : 'Desktop' })));
  events(a.id, Array.from({ length: 20 }, (_, i) => ({ ts: monday - 10 * day, vh: 'p' + i })));
  events(a.id, [{ ts: monday - 2 * day, vh: 'a1', name: 'Purchase', props: '{"value":19.9}' }, { ts: monday - 2 * day, vh: 'a2', name: 'Purchase', props: '{"value":30.1}' }, { ts: monday - 2 * day, vh: 'a3', name: 'Signup' }]);
  { const d = new Database(DB_PATH); d.prepare('INSERT INTO annotations (site_id, day, text, created_by, created) VALUES (?, ?, ?, ?, ?)').run(a.id, new Date(monday - 3 * day).toISOString().slice(0, 10), 'Newsletter <b>sent</b>', 'fabi', Date.now()); d.prepare('INSERT INTO annotations (site_id, day, text, created_by, created) VALUES (?, ?, ?, ?, ?)').run(a.id, new Date(monday - 20 * day).toISOString().slice(0, 10), 'old note', 'fabi', Date.now()); d.close(); }
  events(b.id, Array.from({ length: 5 }, (_, i) => ({ ts: monday - 2 * day, vh: 'b' + i })));
  // own visits (internal_vh) must not show up in the report
  events(a.id, [{ ts: monday - 3 * day, vh: 'me', path: '/admin-only' }]);
  { const d = new Database(DB_PATH); d.prepare('INSERT INTO internal_vh (site_id, vh, day) VALUES (?, ?, ?)').run(a.id, 'me', new Date(monday - 3 * day).toISOString().slice(0, 10)); d.close(); }

  await t.test('settings: off by default, mail configured', async () => {
    const r = (await call('GET', '/api/me/report', { token: owner })).j;
    assert.deepStrictEqual([r.configured, r.weekly, r.email], [true, false, null]);
  });
  await t.test('settings: bad address rejected, API keys and passphrase cannot use it', async () => {
    assert.strictEqual((await call('POST', '/api/me/report', { token: owner, body: { email: 'nope', weekly: true } })).status, 400);
    assert.strictEqual((await call('POST', '/api/me/report', { token: owner, body: { email: 'x@y.de\r\nBcc: evil@z.de', weekly: true } })).status, 400);
    assert.strictEqual((await call('GET', '/api/me/report', { key: KEY })).status, 400);
  });
  await call('POST', '/api/me/report', { token: owner, body: { email: 'fabi@example.com', weekly: true } });
  await call('POST', '/api/me/report', { token: viewer, body: { email: 'vera@example.com', weekly: true } });

  await t.test('not Monday 06 UTC → nothing', async () => {
    assert.deepStrictEqual((await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday - day } })).j, []);
    assert.deepStrictEqual((await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday + 3600e3 } })).j, []);
  });
  mails.length = 0;
  const run = (await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday } })).j;
  await sleep(300);
  await t.test('Monday 06 UTC → one mail per opted-in account', () => {
    assert.deepStrictEqual(run.map((x) => x.user + ':' + x.sent).sort(), ['fabi:true', 'vera:true']);
    assert.strictEqual(mails.length, 2);
  });
  const toFabi = qp(mails.find((m) => m.rcpt.join().includes('fabi@')).data);
  const toVera = qp(mails.find((m) => m.rcpt.join().includes('vera@')).data);
  await t.test('content: numbers, change vs. week before, top page, source, goal, link', () => {
    assert.match(toFabi, /a\.test/);
    assert.match(toFabi, /Visitors\s+30 \(\+50 %\)/);
    assert.match(toFabi, /\/pasta \(20\)/);
    assert.match(toFabi, /google\.com \(10\)/);
    assert.match(toFabi, /Signup \(1\)/);
    assert.ok(!/admin-only/.test(toFabi), 'an internal visit was counted');
    assert.match(toFabi, /Orders 2/);
    assert.match(toFabi, /€50\.00/);
    assert.match(toFabi, /Austria \(24\)/);
    assert.match(toFabi, /Subject: 2 sites: 35 visitors last week \(\+75 %\)/);
    assert.match(toFabi, /https:\/\/analytics\.example\.com\/\?site=a\.test/);
    assert.match(toFabi, /b\.test/);
    assert.match(toFabi, /From: Tacilytics <reports@example\.com>/);
  });
  await t.test('HTML part: chart, highlights, notes of this week only, escaped, devices', () => {
    const html = toFabi.slice(toFabi.indexOf('<!doctype html>'));
    assert.match(html, /Day by day/);
    assert.match(html, /Best day:/);
    assert.match(html, /New source:<\/b> google\.com/);
    assert.match(html, /First time:<\/b> Signup/);
    assert.match(html, /Newsletter &lt;b&gt;sent&lt;\/b&gt;/, 'note text must be escaped');
    assert.ok(!/old note/.test(html), 'a note from another week leaked in');
    assert.match(html, /Mobile <b>60 %<\/b>/);
    assert.match(html, /🇦🇹 Austria/);
    assert.match(html, /Hi fabi,/);
    assert.ok(!/<style/i.test(html), 'mail clients drop <style>: inline only');
  });
  await t.test('report.js directly: German country names and numbers', () => {
    const Database2 = require('better-sqlite3');
    const d = new Database2(DB_PATH, { readonly: true });
    const { createReport } = require('../report');
    const r = createReport(d).build({ username: 'fabi' }, [{ id: a.id, domain: 'a.test' }], monday, { lang: 'de', publicUrl: 'https://x.test' });
    d.close();
    assert.match(r.text, /Österreich \(24\)/);
    assert.match(r.text, /Umsatz 50,00\s€/);
    assert.match(r.subject, /^a\.test: 30 Besucher letzte Woche \(\+50 %\)$/);
    assert.match(r.html, /🇦🇹 Österreich/);
  });
  await t.test('visitor-controlled source names cannot reach Object.prototype; lang is validated', () => {
    const Database2 = require('better-sqlite3');
    const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
    const tmp = path2.join(fs2.mkdtempSync(path2.join(os2.tmpdir(), 'taci-rp-')), 'r.db');
    { const src = new Database2(DB_PATH, { readonly: true }); src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); src.close(); } // the live test DB is WAL — copy via SQLite
    const d = new Database2(tmp);
    const ins = d.prepare('INSERT INTO events (site_id, ts, day, path, source, name, vh, country, device, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [i, src] of ['constructor', '__proto__', 'toString', 'hasOwnProperty'].entries())
      for (let k = 0; k < 9 - i; k++) ins.run(b.id, monday - 2 * day, new Date(monday - 2 * day).toISOString().slice(0, 10), '/', src, null, 'p' + i + '-' + k, null, null, null);
    const { createReport } = require('../report');
    const r = createReport(d).build({ username: 'fabi' }, [{ id: b.id, domain: 'b.test' }], monday, { lang: '"><script>x</script>', publicUrl: 'https://x.test' });
    d.close(); fs2.rmSync(path2.dirname(tmp), { recursive: true, force: true });
    for (const src of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.match(r.text, new RegExp(src + ' \\(\\d+\\)'), src);
    assert.ok(!/function|\[object Object\]|native code/.test(r.text + r.html), 'prototype leaked into the report');
    assert.match(r.html, /<html lang="en">/);
    assert.ok(!/<script>/.test(r.html));
  });
  await t.test('a viewer only gets the sites they can see', () => {
    assert.match(toVera, /a\.test/);
    assert.ok(!/b\.test/.test(toVera), 'b.test leaked into the viewer report');
  });
  await t.test('same Monday again → no second mail', async () => {
    assert.deepStrictEqual((await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday + 10 * 60000 } })).j, []);
  });
  await t.test('opt-out is respected next week', async () => {
    await call('POST', '/api/me/report', { token: viewer, body: { email: 'vera@example.com', weekly: false } });
    const r = (await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday + 7 * day } })).j;
    assert.deepStrictEqual(r.map((x) => x.user), ['fabi']);
  });
  await t.test('German report when chosen; unknown language rejected', async () => {
    assert.strictEqual((await call('POST', '/api/me/report', { token: owner, body: { email: 'fabi@example.com', weekly: true, lang: 'xx' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/me/report', { token: owner, body: { email: 'fabi@example.com', weekly: true, lang: 'de' } })).status, 200);
    assert.strictEqual((await call('GET', '/api/me/report', { token: owner })).j.lang, 'de');
    mails.length = 0;
    assert.strictEqual((await call('POST', '/api/me/report/send', { token: owner })).status, 200);
    await sleep(200);
    const de = qp(mails[0].data);
    assert.match(de, /Besucher/);
    assert.match(de, /Länder: /); // "send now" uses the real date → other test week
    assert.match(de, /Wochenbericht/);
    assert.match(de, /Hallo fabi/);
    // saving without lang keeps the chosen language
    await call('POST', '/api/me/report', { token: owner, body: { email: 'fabi@example.com', weekly: true } });
    assert.strictEqual((await call('GET', '/api/me/report', { token: owner })).j.lang, 'de');
  });
  await t.test('a paused site is left out of the report (Tyto 2.3.0)', async () => {
    // same Monday as the first run, but built fresh: report_last is reset so the tick sends again
    { const d = new Database(DB_PATH); d.prepare("UPDATE users SET report_last = NULL, report_lang = 'en' WHERE username = 'fabi'").run(); d.close(); }
    assert.strictEqual((await call('PATCH', '/api/sites/' + b.id, { key: KEY, body: { paused: true } })).status, 200);
    mails.length = 0;
    const r = (await call('POST', '/api/_test/report-tick', { key: KEY, body: { now: monday + 20 * 60000 } })).j;
    assert.ok(r.some((x) => x.user === 'fabi' && x.sent), JSON.stringify(r));
    await sleep(300);
    const m = qp(mails.find((x) => x.rcpt.join().includes('fabi@')).data);
    assert.match(m, /a\.test/);
    assert.ok(!/b\.test/.test(m), 'paused b.test is in the report');
    assert.strictEqual((await call('PATCH', '/api/sites/' + b.id, { key: KEY, body: { paused: false } })).status, 200);
  });
  await t.test('"send now" works and is rate-limited', async () => {
    mails.length = 0;
    assert.strictEqual((await call('POST', '/api/me/report/send', { token: owner })).status, 200);
    await sleep(200);
    assert.strictEqual(mails.length, 1);
    await call('POST', '/api/me/report/send', { token: owner });
    assert.strictEqual((await call('POST', '/api/me/report/send', { token: owner })).status, 429);
  });
});
