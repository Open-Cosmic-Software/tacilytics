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
function parseList(text) {
  const v4 = []; const v6 = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const [addr, bitsS] = line.split('/');
    const kind = net.isIP(addr);
    if (kind === 4) {
      const bits = bitsS === undefined ? 32 : +bitsS;
      if (!(bits >= 0 && bits <= 32)) continue;
      const size = 2 ** (32 - bits);
      const start = Math.floor(v4ToInt(addr) / size) * size;
      v4.push([start, start + size - 1]);
    } else if (kind === 6) {
      const bits = bitsS === undefined ? 128 : +bitsS;
      if (!(bits >= 0 && bits <= 128)) continue;
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

function createDatacenterCheck({ dir, mode = process.env.TACILYTICS_DATACENTER, files = process.env.TACILYTICS_DATACENTER_FILE, log = console } = {}) {
  let list = { v4: [], v6: [] };
  let loaded = false;
  const off = String(mode || '').toLowerCase() === 'off';
  const cache = dir ? require('path').join(dir, '.datacenter-ranges.txt') : null;

  function use(text, from) {
    const l = parseList(text);
    if (!l.v4.length && !l.v6.length) return false;
    list = l; loaded = true;
    log.info && log.info(`datacenter check: ${l.v4.length} IPv4 + ${l.v6.length} IPv6 ranges (${from})`);
    return true;
  }
  async function refresh() {
    if (off) return;
    try {
      const texts = await Promise.all(DEFAULT_URLS.map(async (u) => {
        const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(u + ' → HTTP ' + r.status);
        return r.text();
      }));
      const text = texts.join('\n');
      // sanity: a real list has thousands of ranges; a tiny or empty answer keeps the old one
      if (text.split('\n').length < 1000) throw new Error('list too short');
      if (use(text, 'download') && cache) { const tmp = cache + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, cache); }
    } catch (e) {
      log.warn && log.warn('datacenter check: refresh failed (' + e.message + ')' + (loaded ? ', keeping the last list' : ', check stays off until a list loads'));
    }
  }
  function start() {
    if (off) { log.info && log.info('datacenter check: off (TACILYTICS_DATACENTER=off)'); return; }
    if (files) {
      // fixed local list (offline installs, tests): no download
      const text = String(files).split(',').map((f) => fs.readFileSync(f.trim(), 'utf8')).join('\n');
      use(text, 'file');
      return;
    }
    if (cache && fs.existsSync(cache)) { try { use(fs.readFileSync(cache, 'utf8'), 'cache'); } catch {} }
    refresh();
    setInterval(refresh, 24 * 3600 * 1000).unref();
  }
  function isDatacenter(ip) {
    if (!loaded) return false;
    let s = String(ip || '');
    if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
    const kind = net.isIP(s);
    if (kind === 4) return inRanges(list.v4, v4ToInt(s));
    if (kind === 6) return inRanges(list.v6, v6ToBig(s));
    return false;
  }
  return { start, refresh, isDatacenter, get loaded() { return loaded; } };
}

module.exports = { createDatacenterCheck, _test: { parseList, inRanges, v4ToInt, v6ToBig } };
