'use strict';
// Datacenter filter (2.5): visits from cloud / hosting networks are dropped on arrival, the IP is never
// stored. Per site switch (dc_filter, default on). No list loaded = filter off (count rather than lose).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDatacenterCheck, _test: T } = require('../datacenter.js');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-dc-'));
const LIST = path.join(dir, 'ranges.txt');
// 127.0.0.0/8 stands in for a cloud network, so the local test connection counts as "datacenter"
fs.writeFileSync(LIST, '# test list\n127.0.0.0/8\n198.51.100.0/24\n2001:db8::/32\n');

test('datacenter list: parsing and lookup', () => {
  const c = createDatacenterCheck({ files: LIST, log: {} });
  assert.strictEqual(c.isDatacenter('8.8.8.8'), false, 'no list loaded yet = off');
  c.start();
  assert.ok(c.loaded);
  for (const ip of ['127.0.0.1', '198.51.100.7', '198.51.100.255', '::ffff:198.51.100.1', '2001:db8::1', '2001:db8:ffff::9']) assert.strictEqual(c.isDatacenter(ip), true, ip);
  for (const ip of ['198.51.101.1', '203.0.113.5', '2001:db9::1', '::1', 'nonsense', '']) assert.strictEqual(c.isDatacenter(ip), false, ip);
  const l = T.parseList('10.0.0.0/9\n10.128.0.0/9\n10.0.0.0/8\n');
  assert.deepStrictEqual(l.v4.length, 1, 'adjacent and overlapping ranges merge');
  assert.strictEqual(createDatacenterCheck({ mode: 'off', files: LIST, log: {} }).isDatacenter('127.0.0.1'), false);
});

const DB_PATH = path.join(dir, 'a.db');
const PORT = 48000 + Math.floor(Math.random() * 1000);
const KEY = 'k-dc-filter-test';
const ENV = { ...process.env, DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off',
  DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'pass-dc-filter',
  TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off', TACILYTICS_DATACENTER_FILE: LIST };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const auth = { Authorization: 'Bear' + 'er ' + KEY };
async function j(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const count = (p) => { const db = new Database(DB_PATH, { readonly: true }); const n = db.prepare('SELECT COUNT(*) n FROM events WHERE path = ?').get(p).n; db.close(); return n; };
const collect = (p, ua = UA) => fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': ua }, body: JSON.stringify({ d: 'dc.test', p, st: 1 }) });
const hit = (p, ip) => j('POST', '/api/v1/hit', { domain: 'dc.test', ua: UA, ip, path: p }, auth);

test('datacenter filter in the server', async (t) => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', (d) => { err += d; });
  t.after(async () => { if (proc.exitCode === null) { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); } fs.rmSync(dir, { recursive: true, force: true }); });
  let up = false; for (let i = 0; i < 100 && !up; i++) { try { await fetch(base + '/nyx.js'); up = true; } catch { await sleep(100); } }
  assert.ok(up, 'server started ' + err);
  const site = (await j('POST', '/api/sites', { domain: 'dc.test' }, auth)).data;
  assert.strictEqual(site.dc_filter, 1, 'on by default');

  await t.test('collect from a datacenter IP is dropped (also in strict mode)', async () => {
    await collect('/from-cloud');
    assert.strictEqual(count('/from-cloud'), 0);
  });
  await t.test('server mode: datacenter IP dropped, normal IP counted', async () => {
    assert.strictEqual((await hit('/h-cloud', '198.51.100.20')).status, 204);
    await hit('/h-home', '203.0.113.20');
    assert.strictEqual(count('/h-cloud'), 0);
    assert.strictEqual(count('/h-home'), 1);
  });
  await t.test('SF1: server-mode crawlers and DNT do not enter the drop statistics', async () => {
    const before = (await j('GET', '/api/sites', undefined, auth)).data.find((x) => x.id === site.id);
    await j('POST', '/api/v1/hit', { domain: 'dc.test', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', ip: '198.51.100.30', path: '/gbot' }, auth);
    await j('POST', '/api/v1/hit', { domain: 'dc.test', ua: UA, ip: '198.51.100.31', path: '/dnt', dnt: true }, auth);
    await j('POST', '/api/v1/hit', { domain: 'dc.test', ua: UA, ip: '198.51.100.32', path: '/pf', purpose: 'prefetch' }, auth);
    const after = (await j('GET', '/api/sites', undefined, auth)).data.find((x) => x.id === site.id);
    assert.strictEqual(after.dc_seen_today, before.dc_seen_today, 'bot / DNT / prefetch never checked');
    assert.strictEqual(after.dc_dropped_today, before.dc_dropped_today);
  });
  await t.test('SF2: dashboard numbers + warning on a small site where every hit is dropped', async () => {
    const s0 = (await j('GET', '/api/sites', undefined, auth)).data.find((x) => x.id === site.id);
    assert.strictEqual(s0.dc_active, true, 'fixed list file = filter active');
    assert.ok(s0.dc_dropped_today >= 2, 'drops counted today: ' + s0.dc_dropped_today);
    assert.ok(s0.dc_seen_today >= s0.dc_dropped_today);
    await j('POST', '/api/sites', { domain: 'small.test' }, auth);
    for (let i = 0; i < 4; i++) await j('POST', '/api/v1/hit', { domain: 'small.test', ua: UA, ip: '198.51.100.' + (40 + i), path: '/s' + i }, auth);
    await sleep(50);
    assert.ok(!/hits for small\.test/.test(err), 'not yet at 4 hits');
    await j('POST', '/api/v1/hit', { domain: 'small.test', ua: UA, ip: '198.51.100.45', path: '/s5' }, auth);
    await sleep(100);
    assert.match(err, /datacenter filter: 5 of 5 hits for small\.test/, 'warned although under 20 hits');
    assert.ok(!/198\.51\.100/.test(err), 'no IP in the warning');
  });
  await t.test('N3: upper-case IPv4-mapped IPv6 is unwrapped too', async () => {
    assert.strictEqual((await hit('/h-mapped', '::FFFF:198.51.100.50')).status, 204);
    assert.strictEqual(count('/h-mapped'), 0);
  });
  await t.test('switched off per site → counted again; timezone untouched', async () => {
    const r = await j('PATCH', '/api/sites/' + site.id, { dcFilter: false }, auth);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.dc_filter, 0);
    assert.strictEqual(r.data.timezone, site.timezone);
    await collect('/cloud-allowed');
    await hit('/h-cloud-allowed', '198.51.100.21');
    assert.strictEqual(count('/cloud-allowed'), 1);
    assert.strictEqual(count('/h-cloud-allowed'), 1);
    await j('PATCH', '/api/sites/' + site.id, { dcFilter: true }, auth);
  });
  await t.test('the IP is never stored', () => {
    const db = new Database(DB_PATH, { readonly: true });
    const dump = JSON.stringify(db.prepare('SELECT * FROM events').all());
    db.close();
    assert.ok(!dump.includes('198.51.100') && !dump.includes('203.0.113'), 'no IP in events');
  });
  await t.test('PATCH validates first: a bad time zone changes nothing, dcFilter must be boolean', async () => {
    assert.strictEqual((await j('PATCH', '/api/sites/' + site.id, { dcFilter: false, timezone: 'Bogus/Zone' }, auth)).status, 400);
    assert.strictEqual((await j('PATCH', '/api/sites/' + site.id, { dcFilter: 'false' }, auth)).status, 400);
    assert.strictEqual((await j('PATCH', '/api/sites/' + site.id, { dcFilter: null }, auth)).status, 400);
    const db = new Database(DB_PATH, { readonly: true });
    assert.strictEqual(db.prepare('SELECT dc_filter FROM sites WHERE id = ?').get(site.id).dc_filter, 1, 'still on');
    db.close();
  });
  await t.test('native apps may use OkHttp; websites with a bare HTTP library are dropped', async () => {
    await j('PATCH', '/api/sites/' + site.id, { dcFilter: false }, auth);
    await fetch(base + '/api/collect', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'okhttp/4.12.0' }, body: JSON.stringify({ d: 'dc.test', p: '/app-okhttp', pf: 'android' }) });
    await collect('/web-okhttp', 'okhttp/4.12.0');
    assert.strictEqual(count('/app-okhttp'), 1);
    assert.strictEqual(count('/web-okhttp'), 0);
  });
  await t.test('scraper user agents without "bot" are dropped', async () => {
    await j('PATCH', '/api/sites/' + site.id, { dcFilter: false }, auth);
    await collect('/ua-adobe', 'adobeone-datasets/0.1 (Adobe Research; image-text research dataset)');
    await collect('/ua-meta', 'meta-third-partyagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)');
    await collect('/ua-bare', 'Mozilla/5.0');
    await collect('/ua-real');
    assert.strictEqual(count('/ua-adobe') + count('/ua-meta') + count('/ua-bare'), 0);
    assert.strictEqual(count('/ua-real'), 1);
  });
});

test('datacenter list: a broken or hostile list cannot drop everyone', () => {
  const { parseList, validate } = T;
  assert.deepStrictEqual(parseList('1.2.3.4/\n1.2.3.4/ \n1.2.3.4/0x10\n1.2.3.4/1e1\n2001:db8::/\n0.0.0.0/0\n::/0\n5.0.0.0/7').v4, [], 'no /0, no loose prefixes, nothing below /8');
  assert.deepStrictEqual(parseList('::/0\n2001::/15\n2a00::/16\n2a02::/23').v6, [], 'nothing below /24 for IPv6');
  // SF4: a list of /24s covering a big part of the German ISP space is refused (share + canaries)
  const v6big = Array.from({ length: 256 }, (_, i) => `2a02:${i.toString(16).padStart(2, '0')}00::/24`).join('\n');
  assert.match(validate(parseList(v6big)), /covers|residential/, 'large IPv6 share refused');
  for (const c of ['2a02:8100::/24', '2a01:500::/24', '2001:1600::/24', '2a02:3000::/24']) assert.match(validate(parseList(c)), /residential/, 'v6 canary ' + c);
  assert.strictEqual(validate(parseList('2a05:d000::/24\n2600:1f00::/24')), null, 'normal cloud /24s pass');
  const big = Array.from({ length: 70 }, (_, i) => `${i + 1}.0.0.0/8`).join('\n');
  assert.match(validate(parseList(big)), /covers/, 'more than 25 % of IPv4 is refused');
  assert.match(validate(parseList('79.192.0.0/10')), /residential/, 'a residential canary inside is refused');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taci-dcbad-')), 'bad.txt');
  fs.writeFileSync(f, big);
  const c = createDatacenterCheck({ files: f, log: {} });
  c.start();
  assert.strictEqual(c.loaded, false);
  assert.strictEqual(c.isDatacenter('8.8.8.8'), false, 'refused list = filter off');
});

test('iCloud Private Relay is allowed through, and without the relay list the downloaded filter stays off', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-relay-'));
  const dcList = path.join(tmp, 'dc.txt');
  const relay = path.join(tmp, 'relay.csv');
  fs.writeFileSync(dcList, '172.224.0.0/12\n146.75.0.0/16\n34.64.0.0/10\n');
  fs.writeFileSync(relay, Array.from({ length: 120 }, (_, i) => `172.224.${i}.0/24,DE,DE-NW,Bestwig,`).join('\n') + '\n2a02:26f7:b3c0::/48,DE,DE-NW,,\n');
  const c = createDatacenterCheck({ files: dcList, relayFile: relay, log: {} });
  c.start();
  assert.strictEqual(c.isDatacenter('172.224.5.9'), false, 'relay egress = real Safari visitor');
  assert.strictEqual(c.isDatacenter('172.230.1.1'), true, 'rest of the network still filtered');
  assert.strictEqual(c.isDatacenter('34.80.0.1'), true);
  assert.strictEqual(c.isDatacenter('fe80::1%eth0'), false, 'zone id does not crash');
});

test('SF3: a failed relay download retries soon instead of waiting a day; N2 future mtime', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-sf3-'));
  const realFetch = global.fetch;
  const realSet = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} }; };
  global.fetch = async (u) => {
    if (String(u).includes('icloud')) throw new Error('offline');
    return { ok: true, text: async () => '5.9.0.0/16\n2a05:d000::/24\n' };
  };
  try {
    const c = createDatacenterCheck({ dir: tmp, log: {} });
    await c.refresh();
    assert.ok(c.loaded, 'datacenter list loaded');
    assert.strictEqual(c.active, false, 'without relay allowlist the filter is not active');
    assert.strictEqual(c.isDatacenter('5.9.1.1'), false);
    assert.ok(delays.at(-1) <= 5 * 60000, 'retry in minutes, got ' + delays.at(-1));
    // N2: cache with an mtime in the future → no negative age, no timer overflow
    const cache = path.join(tmp, '.datacenter-ranges.txt');
    const relayCsv = path.join(tmp, '.relay-ranges.csv');
    fs.writeFileSync(relayCsv, Array.from({ length: 120 }, (_, i) => `172.224.${i}.0/24,DE,,,`).join('\n'));
    const fut = new Date(Date.now() + 10 * 86400000);
    fs.utimesSync(cache, fut, fut);
    delays.length = 0;
    const c2 = createDatacenterCheck({ dir: tmp, log: {} });
    c2.start();
    assert.ok(c2.active);
    assert.ok(delays.length && delays.every((d) => d >= 0 && d <= 24 * 3600 * 1000), 'sane delay: ' + delays);
  } finally { global.fetch = realFetch; global.setTimeout = realSet; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('N1: relay CSV is parsed in one pass and counts only well-formed lines', () => {
  const r = T.parseRelay('172.224.0.0/24,DE,,,\n# comment\nbogus,,\n2a02:26f7::/48,DE,,\n172.225.0.0/24\n');
  assert.strictEqual(r.lines, 2);
  assert.strictEqual(r.v4.length, 1);
  assert.strictEqual(r.v6.length, 1);
});
