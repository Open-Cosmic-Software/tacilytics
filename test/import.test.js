'use strict';
// Import of historical data: Plausible export ZIP, GA4 CSVs; merging into /stats without double counting.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { _test: I, parseImport } = require('../importers');

const ROOT = path.join(__dirname, '..');

// tiny ZIP writer (deflate) for the test
function zip(files) {
  const locals = []; const central = []; let off = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [name, text] of files) {
    const raw = Buffer.from(text); const data = zlib.deflateRawSync(raw); const nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const PLAUSIBLE = [
  ['imported_visitors_20260901_20260903.csv', '"date","visitors","pageviews","bounces","visits","visit_duration"\n"2026-09-01",100,300,40,120,6000\n"2026-09-02",110,320,41,130,6100\n"2026-09-03",90,250,35,100,5000\n'],
  ['imported_pages_20260901_20260903.csv', '"date","hostname","path","visits","visitors","pageviews","exits","time_on_page"\n"2026-09-01","shop.test","/pasta",50,60,150,20,100\n"2026-09-02","shop.test","/pasta",55,65,160,20,100\n"2026-09-01","shop.test","/",40,50,80,10,10\n'],
  ['imported_sources_20260901_20260903.csv', '"date","source","referrer","utm_source","utm_medium","utm_campaign","utm_content","utm_term","pageviews","visitors","visits","visit_duration","bounces"\n"2026-09-01","Google","","","","","","",100,40,45,0,10\n"2026-09-01","","","","","","","",50,30,30,0,10\n'],
  ['imported_locations_20260901_20260903.csv', '"date","country","region","city","visitors","visits","visit_duration","bounces","pageviews"\n"2026-09-01","DE","","0",80,90,0,20,200\n'],
  ['imported_custom_events_20260901_20260903.csv', '"date","name","link_url","path","visitors","events"\n"2026-09-02","Purchase","","",7,9\n'],
];

test('importers: parsing', async (t) => {
  await t.test('Plausible ZIP → totals + dimensions', async () => {
    const r = await parseImport('plausible', { zip: zip(PLAUSIBLE) });
    const tot = r.rows.filter((x) => x.dim === '');
    assert.strictEqual(tot.length, 3);
    assert.strictEqual(tot.reduce((a, x) => a + x.pageviews, 0), 870);
    assert.ok(r.rows.some((x) => x.dim === 'source' && x.name === 'google' && x.visitors === 40));
    assert.ok(r.rows.some((x) => x.dim === 'source' && x.name === 'Direct' && x.visitors === 30), 'empty source = Direct');
    assert.ok(r.rows.some((x) => x.dim === 'event' && x.name === 'Purchase' && x.pageviews === 9));
  });
  await t.test('GA4 CSV with comment header, German columns, grand total line skipped', async () => {
    const csv = '# ----------------------------------------\n# Seiten\n# 20260901-20260902\n# ----------------------------------------\nSeitenpfad und Bildschirmklasse,Datum,Aufrufe,Nutzer insgesamt\n/a,20260901,1.234,500\n/b,20260901,10,4\n/a,20260902,20,9\n,,1.264,513\n';
    const r = await parseImport('ga', { files: [{ name: 'Seiten.csv', text: csv }] });
    const a = r.rows.filter((x) => x.dim === 'page' && x.name === '/a');
    assert.deepStrictEqual(a.map((x) => x.pageviews), [1234, 20]);
    const tot = r.rows.filter((x) => x.dim === '');
    assert.deepStrictEqual(tot.map((x) => [x.day, x.pageviews]), [['2026-09-01', 1244], ['2026-09-02', 20]], 'totals derived from the only dimension');
  });
  await t.test('GA4 "source / medium" rows are merged per source', async () => {
    const csv = 'Date,Session source / medium,Total users,Views\n20260901,google / organic,10,20\n20260901,google / cpc,5,6\n20260901,(direct) / (none),3,3\n';
    const r = await parseImport('ga', { files: [{ name: 's.csv', text: csv }] });
    assert.deepStrictEqual(r.rows.filter((x) => x.dim === 'source').map((x) => [x.name, x.visitors]).sort(), [['Direct', 3], ['google', 15]]);
  });
  await t.test('a CSV without a date column is refused with a hint', async () => {
    await assert.rejects(() => parseImport('ga', { files: [{ name: 'x.csv', text: 'Page,Views\n/a,3\n' }] }), /Date column/);
  });
  await t.test('ZIP bomb guard', async () => {
    const big = zip([['imported_visitors_x.csv', 'a'.repeat(1000)]]);
    await assert.rejects(() => I.unzip(big, { maxBytes: 100 }), /too large/);
  });
});

test('import: API + stats', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taci-import-'));
  const DB_PATH = path.join(dir, 'analytics.db');
  const PORT = 44000 + Math.floor(Math.random() * 1000);
  const KEY = 'imp-' + crypto.randomBytes(4).toString('hex');
  const ENV = { ...process.env, TACILYTICS_DATACENTER: 'off', DB_PATH, PORT: String(PORT), DIGEST_WEBHOOK_URL: 'off', DATA_RETENTION_DAYS: '0', INGEST_SALT: 's', API_KEY: KEY, SESSION_SECRET: 'x', WEB_PASSWORD: 'imp-pass-12345', TRUST_PROXY: '0', TACILYTICS_ALERT_TICK: 'off' };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { proc.kill('SIGTERM'); await new Promise((r) => proc.on('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${PORT}/nyx.js`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const H = { Authorization: 'Bearer ' + KEY };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { ...H, ...(typeof body === 'string' || Buffer.isBuffer(body) ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body == null ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)) });
    return { status: r.status, j: await r.json().catch(() => ({})) };
  };
  const site = (await call('POST', '/api/sites', { domain: 'shop.test' })).j;
  // own data starts 2026-09-03 (one visitor, one pageview)
  { const d = new Database(DB_PATH); d.prepare("INSERT INTO events (site_id, ts, day, path, vh) VALUES (?, ?, '2026-09-03', '/', 'own1')").run(site.id, Date.UTC(2026, 8, 3, 10)); d.close(); }

  const up = await call('POST', '/api/imports?site=shop.test&source=plausible', zip(PLAUSIBLE), { 'Content-Type': 'application/zip' });
  await t.test('upload accepted, overlap explained', () => {
    assert.strictEqual(up.status, 200, JSON.stringify(up.j));
    assert.deepStrictEqual([up.j.first_day, up.j.last_day, up.j.pageviews], ['2026-09-01', '2026-09-03', 870]);
    assert.match(up.j.note, /2026-09-03/);
    assert.strictEqual(up.j.created_by, 'API key');
  });
  const st = (await call('GET', '/api/stats?site=shop.test&from=2026-09-01&to=2026-09-03')).j;
  await t.test('stats: imported days before own data + own data, no double counting', () => {
    // 09-01 + 09-02 imported (300 + 320), 09-03 = own data only (1), imported 250 must NOT count
    assert.strictEqual(st.totals.pageviews, 621);
    assert.strictEqual(st.totals.visitors, 211);
    assert.deepStrictEqual(st.series.map((x) => x.pageviews), [300, 320, 1]);
    assert.deepStrictEqual(st.imported, { included: true, excludedByFilter: false, until: '2026-09-03' });
  });
  await t.test('stats: breakdowns include imported pages, sources, countries, goals', () => {
    assert.deepStrictEqual(st.pages.find((p) => p.name === '/pasta'), { name: '/pasta', pageviews: 310, visitors: 125 });
    assert.ok(st.sources.some((s) => s.name === 'google' && s.visitors === 40));
    assert.ok(st.countries.some((c) => c.name === 'DE' && c.visitors === 80));
    assert.ok(st.goals.some((g) => g.name === 'Purchase' && g.pageviews === 9));
  });
  await t.test('stats with a filter exclude imported data and say so', async () => {
    const f = (await call('GET', '/api/stats?site=shop.test&from=2026-09-01&to=2026-09-03&country=DE')).j;
    assert.deepStrictEqual(f.imported, { included: false, excludedByFilter: true, until: null });
    assert.ok(f.totals.pageviews < 10);
  });
  await t.test('GA CSV upload works as raw text/plain too', async () => {
    const r = await call('POST', '/api/imports?site=shop.test&source=ga&name=ga.csv', 'Date,Total users,Views\n20260801,5,9\n', { 'Content-Type': 'text/plain' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.j));
    const s2 = (await call('GET', '/api/stats?site=shop.test&from=2026-08-01&to=2026-08-01')).j;
    assert.strictEqual(s2.totals.pageviews, 9);
  });
  await t.test('list + delete', async () => {
    const l = (await call('GET', '/api/imports?site=shop.test')).j;
    assert.strictEqual(l.imports.length, 2);
    await call('DELETE', '/api/imports/' + up.j.id);
    const s3 = (await call('GET', '/api/stats?site=shop.test&from=2026-09-01&to=2026-09-03')).j;
    assert.strictEqual(s3.totals.pageviews, 1);
  });
  await t.test('beacons still work (JSON body parser untouched elsewhere)', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/collect`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/129.0' }, body: JSON.stringify({ d: 'shop.test', p: '/x' }) });
    assert.ok(r.status < 300);
  });
});
