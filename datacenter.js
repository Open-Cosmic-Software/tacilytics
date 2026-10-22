'use strict';
// Datacenter IP check (2.5). Scrapers that pretend to be a normal Chrome on a Mac pass every
// user-agent filter, but people do not browse from cloud servers. Like Plausible, the visitor IP is
// checked once on arrival against public lists of hosting / cloud networks and never stored.
//
// List: X4BNet/lists_vpn "datacenter" output (MIT, https://github.com/X4BNet/lists_vpn), refreshed once
// a day into the data directory. Nothing about visitors leaves the server: we only download the list.
// If no list is available (offline install, first start without network) the check is off and every
// visit counts — losing real visitors is worse than counting a few bots.
const fs = require('fs');
const net = require('net');

const DEFAULT_URLS = [
  'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt',
  'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv6.txt',
];
// iCloud Private Relay runs on Akamai / Fastly / Cloudflare networks that the datacenter list contains.
// Those are real Safari visitors, so Apple's published egress ranges are an allowlist checked first.
const RELAY_URL = 'https://mask-api.icloud.com/egress-ip-ranges.csv';

// sanity limits: a broken or hostile list must never be able to drop everyone
const MIN_BITS_V4 = 8;
const MIN_BITS_V6 = 24; // the real list's largest IPv6 prefix is /24
const MAX_V4_SHARE = 0.25; // today ~9 % of the IPv4 space
const MAX_V6_SHARE = 0.001; // of global unicast 2000::/3, today ~12 ppm
// residential / ISP addresses that must never be inside a datacenter list (Telekom, Vodafone, Comcast, Telekom v6)
// IPv6: Telekom, Vodafone, T-Mobile, 1&1, O2
const CANARIES = ['79.192.0.1', '84.150.3.3', '91.64.1.1', '73.0.0.1',
  '2003::1', '2a02:8108::1', '2a01:598::1', '2001:16b8::1', '2a02:3030::1'];

function v4ToInt(ip) {
  const p = ip.split('.');
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + +p[3];
}
function v6ToBig(ip) {
  // expand "::" and an embedded IPv4 tail, then read 8 groups of 16 bits
  let s = ip.toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const n = v4ToInt(v4[1]); s = s.slice(0, -v4[1].length) + ((n >>> 16).toString(16)) + ':' + ((n & 0xffff).toString(16)); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  let x = 0n;
  for (const g of groups) x = (x << 16n) + BigInt(parseInt(g || '0', 16));
  return x;
}

// parse "a.b.c.d/nn" and "x::/nn" lines into sorted, merged [start, end] ranges
function parseList(text, { minV4 = MIN_BITS_V4, minV6 = MIN_BITS_V6 } = {}) {
  const v4 = []; const v6 = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [addrRaw, bitsS, extra] = line.split(',')[0].trim().split('/');
    const addr = addrRaw.trim();
    if (extra !== undefined) continue;
    if (bitsS !== undefined && !/^\d{1,3}$/.test(bitsS)) continue; // "1.2.3.4/" must not become /0
    const kind = net.isIP(addr);
    if (kind === 4) {
      const bits = bitsS === undefined ? 32 : +bitsS;
      if (!(bits >= minV4 && bits <= 32)) continue;
      const size = 2 ** (32 - bits);
      const start = Math.floor(v4ToInt(addr) / size) * size;
      v4.push([start, start + size - 1]);
    } else if (kind === 6) {
      const bits = bitsS === undefined ? 128 : +bitsS;
      if (!(bits >= minV6 && bits <= 128)) continue;
      const host = 128n - BigInt(bits);
      const start = (v6ToBig(addr) >> host) << host;
      v6.push([start, start + (1n << host) - 1n]);
    }
  }
  const merge = (arr) => {
    arr.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const out = [];
    for (const r of arr) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + (typeof r[0] === 'bigint' ? 1n : 1)) { if (r[1] > last[1]) last[1] = r[1]; } else out.push([r[0], r[1]]);
    }
    return out;
  };
  return { v4: merge(v4), v6: merge(v6) };
}

function inRanges(ranges, x) {
  let lo = 0; let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (x < ranges[mid][0]) hi = mid - 1;
    else if (x > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

function v4Share(l) { let n = 0; for (const [a, b] of l.v4) n += b - a + 1; return n / 2 ** 32; }
// share of global unicast 2000::/3 (2^125 addresses), counted only for the part inside it
function v6Share(l) {
  const lo = 0x2n << 124n; const hi = lo + (1n << 125n) - 1n;
  let n = 0n;
  for (const [a, b] of l.v6) { const s = a > lo ? a : lo; const e = b < hi ? b : hi; if (e >= s) n += e - s + 1n; }
  return Number((n * 1000000n) >> 125n) / 1e6;
}

// Reject a whole list that looks wrong instead of trusting it. Returns an error text or null.
function validate(l) {
  if (!l.v4.length && !l.v6.length) return 'no ranges';
  const share = v4Share(l);
  if (share > MAX_V4_SHARE) return `covers ${(share * 100).toFixed(1)} % of IPv4 (limit ${MAX_V4_SHARE * 100} %)`;
  const share6 = v6Share(l);
  if (share6 > MAX_V6_SHARE) return `covers ${(share6 * 100).toFixed(3)} % of global IPv6 (limit ${MAX_V6_SHARE * 100} %)`;
  for (const c of CANARIES) if (lookup(l, c)) return 'contains residential address ' + c;
  return null;
}
function lookup(l, ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return inRanges(l.v4, v4ToInt(ip));
  if (kind === 6) return inRanges(l.v6, v6ToBig(ip));
  return false;
}
// Apple relay CSV: "prefix,country,region,city,". Relay prefixes are small, no minimum length.
// One pass over the ~12 MB file: keep only the prefix column and count the well-formed lines.
function parseRelay(text) {
  const t = String(text);
  const out = [];
  let lines = 0;
  let i = 0;
  while (i < t.length) {
    let nl = t.indexOf('\n', i); if (nl < 0) nl = t.length;
    const comma = t.indexOf(',', i);
    if (comma > i && comma < nl) {
      const prefix = t.slice(i, comma);
      if (/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(prefix)) { out.push(prefix); lines++; }
    }
    i = nl + 1;
  }
  const r = parseList(out.join('\n'), { minV4: 0, minV6: 0 });
  r.lines = lines;
  return r;
}

function createDatacenterCheck({ dir, mode = process.env.TACILYTICS_DATACENTER, files = process.env.TACILYTICS_DATACENTER_FILE,
  relayFile = process.env.TACILYTICS_RELAY_FILE, log = console } = {}) {
  let list = { v4: [], v6: [] };
  let relay = { v4: [], v6: [] };
  let loaded = false;
  let loadedAt = 0;
  let retryMs = 5 * 60000;
  const off = String(mode || '').toLowerCase() === 'off';
  const P = require('path');
  const cache = dir ? P.join(dir, '.datacenter-ranges.txt') : null;
  const relayCache = dir ? P.join(dir, '.relay-ranges.csv') : null;
  const say = (k, m) => { if (log[k]) log[k]('datacenter check: ' + m); };

  function use(text, from) {
    const l = parseList(text);
    const bad = validate(l);
    if (bad) { say('warn', `list from ${from} rejected (${bad})` + (loaded ? ', keeping the last list' : ', filter stays off')); return false; }
    list = l; loaded = true; loadedAt = Date.now();
    say('info', `${l.v4.length} IPv4 + ${l.v6.length} IPv6 ranges (${from}, ${(v4Share(l) * 100).toFixed(1)} % of IPv4)`);
    return true;
  }
  function useRelay(text, from) {
    const r = parseRelay(text);
    if (r.lines < 100) { say('warn', `relay list from ${from} too short, ignored`); return false; }
    relay = { v4: r.v4, v6: r.v6 };
    say('info', `${r.v4.length} IPv4 + ${r.v6.length} IPv6 iCloud Private Relay ranges allowed (${from})`);
    return true;
  }
  const writeCache = (f, text) => { if (!f) return; const tmp = f + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, f); };
  async function get(u) {
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
    return r.text();
  }
  let timer = null;
  function schedule(ms) { if (timer) clearTimeout(timer); timer = setTimeout(refresh, ms); if (timer.unref) timer.unref(); }
  async function refresh() {
    if (off) return;
    let ok = true;
    try {
      const text = (await Promise.all(DEFAULT_URLS.map(get))).join('\n');
      if (use(text, 'download')) writeCache(cache, text); else ok = false;
    } catch (e) { ok = false; say('warn', 'refresh failed (' + e.message + ')' + (loaded ? ', keeping the last list' : ', filter stays off until a list loads')); }
    try { const t = await get(RELAY_URL); if (useRelay(t, 'download')) writeCache(relayCache, t); else ok = false; } catch (e) { ok = false; say('warn', 'relay list refresh failed (' + e.message + ')'); }
    // without the relay allowlist the filter is off, so a missing relay list is a failure too
    if (!relay.v4.length && !relay.v6.length) ok = false;
    // retry with backoff while something failed, otherwise once a day
    if (ok) { retryMs = 5 * 60000; schedule(24 * 3600 * 1000); } else { schedule(retryMs); retryMs = Math.min(retryMs * 4, 6 * 3600 * 1000); }
  }
  function start() {
    if (off) { say('info', 'off (TACILYTICS_DATACENTER=off)'); return; }
    if (relayFile) { try { useRelay(fs.readFileSync(relayFile, 'utf8'), 'file'); } catch (e) { say('warn', 'relay file: ' + e.message); } }
    if (files) {
      // fixed local list (offline installs, tests): no download
      if (!relayFile) say('warn', 'TACILYTICS_DATACENTER_FILE without TACILYTICS_RELAY_FILE: iCloud Private Relay visitors inside the list will be dropped');
      try { use(String(files).split(',').map((f) => fs.readFileSync(f.trim(), 'utf8')).join('\n'), 'file'); } catch (e) { say('warn', 'list file: ' + e.message); }
      return;
    }
    let fresh = false;
    let relayOk = false;
    if (relayCache && fs.existsSync(relayCache)) { try { relayOk = useRelay(fs.readFileSync(relayCache, 'utf8'), 'cache'); } catch {} }
    if (cache && fs.existsSync(cache)) {
      try {
        // clamp: a cache file with a future mtime must not give a negative age (timer overflow)
        const age = Math.max(0, Date.now() - fs.statSync(cache).mtimeMs);
        if (use(fs.readFileSync(cache, 'utf8'), 'cache')) { loadedAt = Date.now() - age; fresh = relayOk && age < 24 * 3600 * 1000; }
        if (age > 7 * 24 * 3600 * 1000) say('warn', `cached list is ${Math.round(age / 86400000)} days old`);
      } catch {}
    }
    if (fresh) schedule(Math.max(1000, 24 * 3600 * 1000 - (Date.now() - loadedAt))); else refresh();
  }
  function isDatacenter(ip) {
    if (!loaded) return false;
    let s = String(ip || '').split('%')[0].toLowerCase();
    if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
    if (!net.isIP(s)) return false;
    // without Apple's relay allowlist the datacenter list would drop iCloud Private Relay users
    // (Akamai / Fastly egress): then the filter stays off. Only a fixed local list may run without it.
    if (!relay.v4.length && !relay.v6.length && !files) return false;
    if (lookup(relay, s)) return false; // iCloud Private Relay = a real person
    return lookup(list, s);
  }
  // active = the filter really drops something right now (list loaded and, unless a fixed file is used, the relay allowlist too)
  const active = () => !off && loaded && (!!files || relay.v4.length > 0 || relay.v6.length > 0);
  return { start, refresh, isDatacenter, get loaded() { return loaded; }, get loadedAt() { return loadedAt; }, get active() { return active(); }, get off() { return off; } };
}

module.exports = { createDatacenterCheck, _test: { parseList, parseRelay, validate, inRanges, v4ToInt, v6ToBig, v6Share, MIN_BITS_V6 } };
