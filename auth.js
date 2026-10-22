'use strict';
/* Tacilytics — accounts, team, optional 2FA (TOTP) and passkeys (WebAuthn).
 *
 * Two modes, decided by whether the users table is empty:
 *   - Legacy (no accounts yet): sign in with WEB_PASSWORD, exactly like before 2.1.
 *     The signed-in owner can create the first account from Settings → Team.
 *   - Accounts (≥ 1 user): WEB_PASSWORD no longer opens anything (otherwise it would be a
 *     way around 2FA). Sign in with username + password (+ TOTP if enabled) or a passkey.
 * API_KEY (Bearer) keeps owner rights in both modes — it is for agents / the CLI.
 *
 * Roles: owner (everything incl. team) > admin (sites, shares, funnels) > viewer (read only,
 * optionally limited to a list of sites).
 *
 * Secrets at rest: passwords = scrypt, session/invite tokens + recovery codes = sha256,
 * TOTP secrets are stored as-is (they must be readable to verify codes).
 */
const crypto = require('crypto');
const PKG_VERSION = require('./package.json').version;

const ROLES = { viewer: 1, admin: 2, owner: 3 };
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const MIN_PW = 10;

// ── small crypto helpers ───────────────────────────────────────────────────
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randToken = (n = 24) => crypto.randomBytes(n).toString('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scryptAsync = (pw, salt, len, o) => new Promise((ok, no) => crypto.scrypt(pw, salt, len, o, (e, k) => (e ? no(e) : ok(k))));
function fmtHash(salt, h) { return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`; }
// sync variants: only for module start and the offline CLI (no event loop to block there)
function hashPasswordSync(pw) {
  const salt = crypto.randomBytes(16);
  return fmtHash(salt, crypto.scryptSync(String(pw), salt, 32, SCRYPT));
}
// async variants: everything that runs inside a request, so a login never blocks /api/collect
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return fmtHash(salt, await scryptAsync(String(pw), salt, 32, SCRYPT));
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, want);
}
// a fixed dummy hash so unknown usernames cost the same time as wrong passwords
const DUMMY_HASH = hashPasswordSync(randToken());

// ── TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 digits) ────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secretB32, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
/** returns the matched time step (for replay protection) or -1 */
function totpCheck(secretB32, code, now = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return -1;
  const step = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) if (safeEq(totpAt(secretB32, step + d), c)) return step + d;
  return -1;
}
function newRecoveryCodes() {
  // 10 codes like "k3f9-x2qa-7mde", alphabet without look-alikes
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const b = crypto.randomBytes(12);
    let s = ''; for (let i = 0; i < 12; i++) s += A[b[i] % A.length];
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  });
}
const normRecovery = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── base64url helpers for WebAuthn ─────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

function setupAuth({ app, db, WEB_PASSWORD, API_KEY, rateLimited, clientIp, siteIdByDomain, allSiteIds }) {
  const webauthn = require('@simplewebauthn/server');
  const QRCode = require('qrcode');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pw_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      sites TEXT,                 -- JSON array of site ids; NULL = all sites
      totp_secret TEXT,           -- set once 2FA is enabled
      totp_pending TEXT,          -- secret shown during setup, not active yet
      totp_last_step INTEGER,     -- last accepted TOTP step (no code reuse)
      recovery TEXT,              -- JSON array of sha256(code)
      webauthn_id TEXT NOT NULL,  -- random user handle for passkeys (base64url)
      created INTEGER NOT NULL,
      last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,        -- credential id (base64url)
      user_id INTEGER NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      name TEXT,
      created INTEGER NOT NULL,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER,            -- NULL = legacy WEB_PASSWORD session
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT,                 -- username, 'API key', 'passphrase', or NULL (public: invite / reset link)
      action TEXT NOT NULL,       -- e.g. 'site.add', 'team.invite', 'me.totp.enable'
      target TEXT,                -- what it was about (domain, username, …) — never a secret
      ip TEXT                     -- address as seen through the proxy; for "was that me?"
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,       -- first characters, shown in the list so people can tell keys apart
      user_id INTEGER NOT NULL,
      name TEXT,
      read_only INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_by INTEGER,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      sites TEXT,
      created_by INTEGER,
      created INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      used_at INTEGER,
      used_by INTEGER
    );
  `);

  // 2.4.1: key scopes. '' = the old behaviour (read-only or the account's own rights); 'hit' = server mode only,
  // usable for POST /api/v1/hit on the listed sites and nothing else. Existing keys keep scope '' (unchanged).
  for (const [col, decl] of [['scope', "TEXT NOT NULL DEFAULT ''"], ['sites', 'TEXT']]) {
    if (!db.prepare('PRAGMA table_info(api_keys)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE api_keys ADD COLUMN ${col} ${decl}`);
  }
  const q = {
    userCount: db.prepare('SELECT COUNT(*) n FROM users'),
    ownerCount: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'owner'"),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userByHandle: db.prepare('SELECT * FROM users WHERE webauthn_id = ?'),
    insUser: db.prepare('INSERT INTO users (username, pw_hash, role, sites, webauthn_id, created) VALUES (?, ?, ?, ?, ?, ?)'),
    sessGet: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    sessIns: db.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)'),
    sessDel: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    sessDelUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sessDelUserExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    sessDelLegacy: db.prepare('DELETE FROM sessions WHERE user_id IS NULL'),
    sessPurge: db.prepare('DELETE FROM sessions WHERE expires < ?'),
    pkByUser: db.prepare('SELECT id, name, created, last_used, transports FROM passkeys WHERE user_id = ? ORDER BY created'),
    pkGet: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
  };
  const hasUsers = () => q.userCount.get().n > 0;

  // ── audit log ──────────────────────────────────────────────────────────────
  // Every successful state change (POST/PATCH/DELETE answered with 2xx) gets one row, written
  // after the response is sent. Handlers can name the action/target via res.locals.audit;
  // otherwise method + route are recorded. New endpoints are covered without remembering to.
  // Not logged: tracking beacons, sign-in steps, WebAuthn option requests (no state change).
  const AUDIT_SKIP = new Set(['/api/collect', '/auth/login', '/auth/login/totp', '/auth/passkey/options', '/auth/passkey/verify', '/auth/logout', '/api/me/passkeys/options', '/api/me/totp/setup', '/api/v1/hit']);
  const AUDIT_DAYS = Math.max(30, parseInt(process.env.AUDIT_RETENTION_DAYS, 10) || 365);
  const insAudit = db.prepare('INSERT INTO audit_log (ts, actor, action, target, ip) VALUES (?, ?, ?, ?, ?)');
  function actorOf(p) {
    if (!p) return null;
    if (p.kind === 'user') return p.user.username;
    if (p.kind === 'userkey') return p.user.username + ' (API key)';
    if (p.kind === 'hitkey') return p.user.username + ' (server-mode key)';
    if (p.kind === 'apikey') return 'API key';
    if (p.kind === 'legacy') return 'passphrase';
    return null;
  }
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || AUDIT_SKIP.has(req.path)) return next();
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      try {
        // one row per named action (a single save can change several things, e.g. time zone + filter)
        const list = res.locals.audits && res.locals.audits.length ? res.locals.audits : [{}];
        const route = req.route ? req.route.path : req.path;
        const ts = Date.now();
        for (const a of list) {
          const action = a.action || `${req.method} ${route}`;
          const actor = a.actor !== undefined ? a.actor : actorOf(req.principal);
          insAudit.run(ts, actor, action, a.target == null ? null : String(a.target).slice(0, 200), clientIp(req));
        }
      } catch (e) { console.error('audit log:', e.message); }
    });
    next();
  });
  setInterval(() => db.prepare('DELETE FROM audit_log WHERE ts < ?').run(Date.now() - AUDIT_DAYS * 864e5), 6 * 3600e3).unref();
  const audit = (res, action, target, actor) => {
    const a = { action, target, ...(actor !== undefined ? { actor } : {}) };
    res.locals.audit = a;
    (res.locals.audits || (res.locals.audits = [])).push(a);
  };
  if (hasUsers() && !process.env.TACILYTICS_ORIGIN) {
    console.warn('⚠️  TACILYTICS_ORIGIN is not set. Passkeys use the request host, so they break if the dashboard is reached under another host/port or behind a proxy without X-Forwarded-Proto. Set it to the public dashboard URL.');
  }
  setInterval(() => q.sessPurge.run(Date.now()), 3600e3).unref();

  // ── sessions ──
  function createSession(userId) {
    const token = randToken();
    q.sessIns.run(sha256(token), userId, Date.now(), Date.now() + SESSION_DAYS * 864e5);
    if (userId) db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), userId);
    return token;
  }
  function principal(req) {
    // agents / CLI: API key = owner over everything
    const hdr = String(req.headers['authorization'] || '');
    const key = hdr.startsWith('Bearer ') ? hdr.slice(7) : String(req.headers['x-api-key'] || '');
    if (key) {
      // the server-wide API_KEY from .env: owner over everything (agents / CLI on your own box)
      if (API_KEY && safeEq(key, API_KEY)) return { kind: 'apikey', role: 'owner', sites: null, user: null };
      // personal keys (tk_…): act as their owner, never more — and read-only unless created otherwise
      if (key.startsWith('tk_')) {
        const k = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(key));
        const u = k && q.userById.get(k.user_id);
        if (!u) return null;
        if (!k.last_used || Date.now() - k.last_used > 60000) db.prepare('UPDATE api_keys SET last_used = ? WHERE id = ?').run(Date.now(), k.id);
        const userSites = u.sites ? JSON.parse(u.sites) : null;
        if (k.scope === 'hit') {
          // never more than the account itself may see today (an account limited later narrows its old keys too)
          const ks = JSON.parse(k.sites || '[]').filter((id) => userSites == null || userSites.includes(id));
          return { kind: 'hitkey', role: 'viewer', sites: ks, user: u, keyId: k.id };
        }
        const role = k.read_only ? 'viewer' : u.role;
        return { kind: 'userkey', role, sites: userSites, user: u, keyId: k.id };
      }
      return null; // a wrong key is a failed sign-in, not an anonymous request
    }
    const t = String(req.headers['x-session-token'] || '');
    if (!t) return null;
    const s = q.sessGet.get(sha256(t));
    if (!s) return null;
    if (s.expires < Date.now()) { q.sessDel.run(s.token_hash); return null; }
    if (s.user_id == null) {
      // legacy session only valid while there are no accounts
      if (hasUsers()) { q.sessDel.run(s.token_hash); return null; }
      return { kind: 'legacy', role: 'owner', sites: null, user: null, tokenHash: s.token_hash };
    }
    const u = q.userById.get(s.user_id);
    if (!u) { q.sessDel.run(s.token_hash); return null; }
    return { kind: 'user', role: u.role, sites: u.sites ? JSON.parse(u.sites) : null, user: u, tokenHash: s.token_hash };
  }
  function auth(req, res, next) {
    const p = principal(req);
    if (!p) return res.status(401).json({ error: 'Not authenticated' });
    // a server-mode key reports page views and does nothing else — not even read stats
    if (p.kind === 'hitkey' && !(req.method === 'POST' && req.path === '/api/v1/hit')) return res.status(403).json({ error: 'This key can only report page views (POST /api/v1/hit)' });
    req.principal = p;
    next();
  }
  const requireRole = (role) => (req, res, next) => auth(req, res, () => {
    if (ROLES[req.principal.role] >= ROLES[role]) return next();
    res.status(403).json({ error: 'Your role does not allow this' });
  });
  /** may the current principal (or share link) see this site id? */
  function siteAllowed(req, siteId) {
    if (req.shareSiteId != null) return req.shareSiteId === siteId;
    const p = req.principal;
    if (!p) return false;
    return p.sites == null || p.sites.includes(siteId);
  }

  // ── helpers ──
  const cleanName = (s) => String(s || '').trim().slice(0, 40);
  const validName = (s) => /^[A-Za-z0-9._@-]{2,40}$/.test(s);
  function cleanSites(raw) {
    if (raw == null) return null;
    if (!Array.isArray(raw)) return undefined;
    const valid = new Set(allSiteIds());
    const ids = [...new Set(raw.map(Number).filter((n) => valid.has(n)))];
    return ids;
  }
  const cleanRole = (r) => (Object.prototype.hasOwnProperty.call(ROLES, r) ? r : null);
  function publicUser(u) {
    return {
      id: u.id, username: u.username, role: u.role, sites: u.sites ? JSON.parse(u.sites) : null,
      totp: !!u.totp_secret, passkeys: q.pkByUser.all(u.id).length,
      created: u.created, last_login: u.last_login,
    };
  }
  function rpFor(req) {
    // TACILYTICS_ORIGIN pins the passkey domain (recommended behind proxies). Otherwise the
    // request host is used: a passkey signs the hash of its own rpID, so a forged Host header
    // cannot produce a valid assertion for another domain.
    const fixed = process.env.TACILYTICS_ORIGIN;
    const origin = fixed ? fixed.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
    return { origin, rpID: new URL(origin).hostname };
  }
  // short-lived in-memory state: login tickets (password ok, waiting for TOTP) + WebAuthn challenges
  const pending = new Map();
  const PENDING_MAX = 10000; // hard cap: /auth/passkey/options is unauthenticated, the map must not grow without bound
  function putPending(kind, data, ms = 5 * 60000, expires = null) {
    if (pending.size >= PENDING_MAX) {
      const n = Date.now();
      for (const [k, v] of pending) if (v.expires < n) pending.delete(k);
      if (pending.size >= PENDING_MAX) return null;
    }
    const id = randToken(16);
    pending.set(id, { kind, data, expires: expires || Date.now() + ms });
    return id;
  }
  function takePending(id, kind) {
    const e = pending.get(String(id || ''));
    if (!e) return null;
    pending.delete(String(id));
    if (e.kind !== kind || e.expires < Date.now()) return null;
    return { ...e.data, expires: e.expires };
  }
  const BUSY = (res) => res.status(503).json({ error: 'Too many sign-ins in progress — try again in a minute' });
  const TOTP_TRIES = 5; // wrong codes per password entry; after that the password is needed again
  setInterval(() => { const n = Date.now(); for (const [k, v] of pending) if (v.expires < n) pending.delete(k); }, 60000).unref();

  function checkSecondFactor(u, code) {
    // TOTP first, then a one-time recovery code
    const step = totpCheck(u.totp_secret, code);
    if (step >= 0) {
      if (u.totp_last_step != null && step <= u.totp_last_step) return false; // replay
      db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
      return true;
    }
    const rc = normRecovery(code);
    if (rc.length !== 12) return false;
    const list = JSON.parse(u.recovery || '[]');
    const h = sha256(rc);
    const i = list.findIndex((x) => safeEq(x, h));
    if (i < 0) return false;
    list.splice(i, 1);
    db.prepare('UPDATE users SET recovery = ? WHERE id = ?').run(JSON.stringify(list), u.id);
    return true;
  }

  // ── public auth endpoints ──────────────────────────────────────────────────
  app.get('/auth/status', (_req, res) => res.json({ accounts: hasUsers() }));

  app.post('/auth/login', async (req, res) => {
    const ip = clientIp(req);
    if (rateLimited('login:' + ip, 10, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const b = req.body || {};
    const pw = String(b.password || '');
    if (!hasUsers()) {
      if (!safeEq(pw, WEB_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
      return res.json({ token: createSession(null) });
    }
    const name = cleanName(b.username);
    if (name && rateLimited('login-user:' + name.toLowerCase(), 20, 60 * 60000)) return res.status(429).json({ error: 'Too many attempts for this account — wait an hour' });
    const u = name ? q.userByName.get(name) : null;
    const ok = (await verifyPassword(pw, u ? u.pw_hash : DUMMY_HASH)) && !!u;
    if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
    if (u.totp_secret) {
      const ticket = putPending('mfa', { userId: u.id, tries: 0 });
      return ticket ? res.json({ mfa: 'totp', ticket }) : BUSY(res);
    }
    res.json({ token: createSession(u.id) });
  });

  app.post('/auth/login/totp', (req, res) => {
    if (rateLimited('totp:' + clientIp(req), 10, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const b = req.body || {};
    const t = takePending(b.ticket, 'mfa');
    if (!t) return res.status(401).json({ error: 'Sign-in expired — enter your password again' });
    const u = q.userById.get(t.userId);
    if (!u || !u.totp_secret) return res.status(401).json({ error: 'Sign-in expired — enter your password again' });
    // per account, independent of the IP: guessing codes from many addresses does not help
    if (rateLimited('totp-user:' + u.id, 10, 15 * 60000)) return res.status(429).json({ error: 'Too many wrong codes for this account — wait 15 minutes' });
    if (!checkSecondFactor(u, b.code)) {
      const tries = (t.tries || 0) + 1;
      if (tries >= TOTP_TRIES) return res.status(401).json({ error: 'Too many wrong codes — enter your password again' });
      // one more try without re-entering the password; the successor keeps the original expiry and the count
      const ticket = putPending('mfa', { userId: u.id, tries }, 0, t.expires);
      return res.status(401).json(ticket ? { error: 'Wrong code', ticket } : { error: 'Wrong code — enter your password again' });
    }
    res.json({ token: createSession(u.id) });
  });

  app.post('/auth/passkey/options', async (req, res) => {
    if (rateLimited('pk:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    if (!hasUsers()) return res.status(400).json({ error: 'No accounts yet' });
    const { rpID } = rpFor(req);
    const options = await webauthn.generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const ticket = putPending('pk-auth', { challenge: options.challenge });
    if (!ticket) return BUSY(res);
    res.json({ options, ticket });
  });
  app.post('/auth/passkey/verify', async (req, res) => {
    if (rateLimited('pk:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const b = req.body || {};
    const t = takePending(b.ticket, 'pk-auth');
    const fail = () => res.status(401).json({ error: 'Passkey not accepted' });
    if (!t || !b.response || typeof b.response.id !== 'string') return fail();
    const pk = q.pkGet.get(b.response.id);
    if (!pk) return fail();
    const u = q.userById.get(pk.user_id);
    if (!u) return fail();
    // the authenticator's user handle must belong to the same account as the credential
    const handle = b.response.response && b.response.response.userHandle;
    if (handle && handle !== u.webauthn_id) return fail();
    const { origin, rpID } = rpFor(req);
    try {
      const v = await webauthn.verifyAuthenticationResponse({
        response: b.response, expectedChallenge: t.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: pk.counter, transports: pk.transports ? JSON.parse(pk.transports) : undefined },
        requireUserVerification: false,
      });
      if (!v.verified) return fail();
      db.prepare('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?').run(v.authenticationInfo.newCounter, Date.now(), pk.id);
    } catch { return fail(); }
    // a passkey is possession + (usually) biometrics: it replaces password and TOTP
    res.json({ token: createSession(u.id) });
  });

  app.post('/auth/logout', (req, res) => {
    const t = String(req.headers['x-session-token'] || '');
    if (t) q.sessDel.run(sha256(t));
    res.json({ ok: true });
  });

  // ── invites (public part) ──
  function inviteByToken(token) {
    const inv = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(String(token || '')));
    if (!inv || inv.used_at || inv.expires < Date.now()) return null;
    return inv;
  }
  app.get('/api/invite/:token', (req, res) => {
    if (rateLimited('inv:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const inv = inviteByToken(req.params.token);
    if (!inv) return res.status(404).json({ error: 'This invite link is invalid, used or expired' });
    res.json({ role: inv.role, expires: inv.expires });
  });
  app.post('/api/invite/:token', async (req, res) => {
    if (rateLimited('inv:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const b = req.body || {};
    const name = cleanName(b.username), pw = String(b.password || '');
    if (!validName(name)) return res.status(400).json({ error: 'Username: 2–40 characters, letters, digits, . _ @ -' });
    if (pw.length < MIN_PW) return res.status(400).json({ error: `Password needs at least ${MIN_PW} characters` });
    if (q.userByName.get(name)) return res.status(409).json({ error: 'This username is taken' });
    const pwHash = await hashPassword(pw);
    const tx = db.transaction(() => {
      const inv = inviteByToken(req.params.token);
      if (!inv) return null;
      if (q.userByName.get(name)) return 'taken'; // re-checked inside the transaction (two sign-ups racing for one name)
      const info = q.insUser.run(name, pwHash, inv.role, inv.sites, b64u(crypto.randomBytes(16)), Date.now());
      db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(Date.now(), info.lastInsertRowid, inv.id);
      return info.lastInsertRowid;
    });
    const uid = tx();
    if (uid === 'taken') return res.status(409).json({ error: 'This username is taken' });
    if (!uid) return res.status(404).json({ error: 'This invite link is invalid, used or expired' });
    audit(res, 'team.join', name, name);
    res.json({ token: createSession(uid) });
  });

  // ── me ─────────────────────────────────────────────────────────────────────
  app.get('/api/me', auth, (req, res) => {
    const p = req.principal;
    // version only behind auth: a public number would tell scanners which instances still run a release
    // with a known hole (Tyto). Never in /auth/status, the login screen or share links.
    const out = { kind: p.kind, role: p.role, accounts: hasUsers(), version: PKG_VERSION };
    if (p.user) {
      const u = q.userById.get(p.user.id);
      Object.assign(out, publicUser(u), {
        recoveryLeft: JSON.parse(u.recovery || '[]').length,
        passkeyList: q.pkByUser.all(u.id).map((k) => ({ id: k.id, name: k.name, created: k.created, last_used: k.last_used })),
      });
    }
    res.json(out);
  });
  const userOnly = (req, res, next) => {
    if (req.principal.kind === 'userkey' || req.principal.kind === 'hitkey') return res.status(403).json({ error: 'API keys cannot change account settings — sign in' });
    return req.principal.user ? next() : res.status(400).json({ error: 'Create an account first' });
  };
  async function needPassword(req, res) {
    if (rateLimited('reauth:' + req.principal.user.id, 10, 15 * 60000)) { res.status(429).json({ error: 'Too many attempts — wait 15 minutes' }); return false; }
    const u = q.userById.get(req.principal.user.id);
    if (!(await verifyPassword(String((req.body || {}).password || ''), u.pw_hash))) { res.status(401).json({ error: 'Wrong password' }); return false; }
    return true;
  }

  app.post('/api/me/password', auth, userOnly, async (req, res) => {
    if (!(await needPassword(req, res))) return;
    const npw = String((req.body || {}).newPassword || '');
    if (npw.length < MIN_PW) return res.status(400).json({ error: `Password needs at least ${MIN_PW} characters` });
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(await hashPassword(npw), req.principal.user.id);
    q.sessDelUserExcept.run(req.principal.user.id, req.principal.tokenHash); // sign out other devices
    audit(res, 'me.password');
    res.json({ ok: true });
  });

  app.post('/api/me/totp/setup', auth, userOnly, async (req, res) => {
    const u = q.userById.get(req.principal.user.id);
    if (u.totp_secret) return res.status(400).json({ error: '2FA is already on' });
    const secret = base32Encode(crypto.randomBytes(20));
    db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, u.id);
    const { rpID } = rpFor(req);
    const label = encodeURIComponent(`Tacilytics (${rpID}):${u.username}`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Tacilytics')}&algorithm=SHA1&digits=6&period=30`;
    const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ secret, uri, qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') });
  });
  app.post('/api/me/totp/enable', auth, userOnly, (req, res) => {
    if (rateLimited('totp-en:' + req.principal.user.id, 10, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const u = q.userById.get(req.principal.user.id);
    if (u.totp_secret) return res.status(400).json({ error: '2FA is already on' });
    if (!u.totp_pending) return res.status(400).json({ error: 'Start the setup first' });
    const step = totpCheck(u.totp_pending, (req.body || {}).code);
    if (step < 0) return res.status(401).json({ error: 'Wrong code — check the time on your phone' });
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, recovery = ? WHERE id = ?')
      .run(step, JSON.stringify(codes.map((c) => sha256(normRecovery(c)))), u.id);
    q.sessDelUserExcept.run(u.id, req.principal.tokenHash);
    audit(res, 'me.2fa.on');
    res.json({ ok: true, recoveryCodes: codes });
  });
  app.post('/api/me/totp/disable', auth, userOnly, async (req, res) => {
    if (!(await needPassword(req, res))) return;
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, recovery = NULL WHERE id = ?').run(req.principal.user.id);
    audit(res, 'me.2fa.off');
    res.json({ ok: true });
  });
  app.post('/api/me/recovery', auth, userOnly, async (req, res) => {
    if (!(await needPassword(req, res))) return;
    const u = q.userById.get(req.principal.user.id);
    if (!u.totp_secret) return res.status(400).json({ error: '2FA is off' });
    const codes = newRecoveryCodes();
    db.prepare('UPDATE users SET recovery = ? WHERE id = ?').run(JSON.stringify(codes.map((c) => sha256(normRecovery(c)))), u.id);
    audit(res, 'me.recovery.new');
    res.json({ recoveryCodes: codes });
  });

  app.post('/api/me/passkeys/options', auth, userOnly, async (req, res) => {
    const u = q.userById.get(req.principal.user.id);
    const { rpID } = rpFor(req);
    const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(u.id);
    const options = await webauthn.generateRegistrationOptions({
      rpName: 'Tacilytics', rpID, userName: u.username, userID: fromB64u(u.webauthn_id),
      attestationType: 'none',
      excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports ? JSON.parse(k.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const ticket = putPending('pk-reg', { challenge: options.challenge, userId: u.id });
    if (!ticket) return BUSY(res);
    res.json({ options, ticket });
  });
  app.post('/api/me/passkeys', auth, userOnly, async (req, res) => {
    const b = req.body || {};
    const t = takePending(b.ticket, 'pk-reg');
    if (!t || t.userId !== req.principal.user.id) return res.status(400).json({ error: 'Setup expired — try again' });
    const { origin, rpID } = rpFor(req);
    let v;
    try {
      v = await webauthn.verifyRegistrationResponse({ response: b.response, expectedChallenge: t.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch (e) { return res.status(400).json({ error: 'Passkey not accepted: ' + String(e.message || e).slice(0, 120) }); }
    if (!v.verified) return res.status(400).json({ error: 'Passkey not accepted' });
    const c = v.registrationInfo.credential;
    if (q.pkGet.get(c.id)) return res.status(409).json({ error: 'This passkey is already registered' });
    const name = String(b.name || '').trim().slice(0, 60) || 'Passkey';
    db.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, t.userId, Buffer.from(c.publicKey), c.counter || 0, c.transports ? JSON.stringify(c.transports) : null, name, Date.now());
    audit(res, 'me.passkey.add', name);
    res.json({ ok: true });
  });
  app.delete('/api/me/passkeys/:id', auth, userOnly, (req, res) => {
    const pk = db.prepare('SELECT name FROM passkeys WHERE id = ? AND user_id = ?').get(String(req.params.id), req.principal.user.id);
    db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(String(req.params.id), req.principal.user.id);
    audit(res, 'me.passkey.remove', pk ? pk.name : null);
    res.json({ ok: true });
  });

  app.get('/api/audit', requireRole('owner'), (req, res) => {
    if (req.principal.kind === 'userkey' || req.principal.kind === 'hitkey') return res.status(403).json({ error: 'API keys cannot read the audit log — sign in' });
    const before = Number(req.query.before) || Date.now() + 1;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json(db.prepare('SELECT id, ts, actor, action, target, ip FROM audit_log WHERE ts < ? ORDER BY ts DESC, id DESC LIMIT ?').all(before, limit));
  });

  // ── personal API keys ──
  app.get('/api/me/keys', auth, userOnly, (req, res) => {
    res.json(db.prepare('SELECT id, prefix, name, read_only, scope, sites, created, last_used FROM api_keys WHERE user_id = ? ORDER BY created').all(req.principal.user.id)
      .map((k) => ({ ...k, read_only: !!k.read_only, scope: k.scope || '', sites: k.sites ? JSON.parse(k.sites) : null })));
  });
  app.post('/api/me/keys', auth, userOnly, (req, res) => {
    const b = req.body || {};
    const n = db.prepare('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?').get(req.principal.user.id).n;
    if (n >= 20) return res.status(400).json({ error: 'At most 20 keys per account' });
    const key = 'tk_' + crypto.randomBytes(24).toString('base64url');
    const name = String(b.name || '').trim().slice(0, 60) || 'API key';
    if (b.scope === 'hit') {
      // server mode: bound to explicit sites, never more than the account may see. Admin or owner only: reporting
      // page views is writing data (it can add visitors), and a viewer may not write — same rule as /api/v1/hit in 2.4.0.
      if (req.principal.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot create server-mode keys' });
      if (!Array.isArray(b.sites) || !b.sites.length) return res.status(400).json({ error: 'Pick the site(s) this server reports for' });
      const ids = [...new Set(b.sites.map(Number))];
      if (ids.some((id) => !allSiteIds().includes(id) || !siteAllowed(req, id))) return res.status(403).json({ error: 'You have no access to one of these sites' });
      const info = db.prepare("INSERT INTO api_keys (key_hash, prefix, user_id, name, read_only, scope, sites, created) VALUES (?, ?, ?, ?, 1, 'hit', ?, ?)")
        .run(sha256(key), key.slice(0, 10), req.principal.user.id, name, JSON.stringify(ids), Date.now());
      audit(res, 'me.apikey.add', `${name} (${key.slice(0, 10)}…, server mode: sites ${ids.join(',')})`);
      return res.json({ id: info.lastInsertRowid, key, name, read_only: true, scope: 'hit', sites: ids });
    }
    // a viewer can only ever get a read-only key
    const readOnly = req.principal.role === 'viewer' ? true : b.readOnly !== false;
    const info = db.prepare('INSERT INTO api_keys (key_hash, prefix, user_id, name, read_only, created) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(key), key.slice(0, 10), req.principal.user.id, name, readOnly ? 1 : 0, Date.now());
    audit(res, 'me.apikey.add', `${name} (${key.slice(0, 10)}…, ${readOnly ? 'read-only' : 'read + write'})`);
    res.json({ id: info.lastInsertRowid, key, name, read_only: readOnly, scope: '' }); // the key is shown exactly once
  });
  app.delete('/api/me/keys/:id', auth, userOnly, (req, res) => {
    const k = db.prepare('SELECT name, prefix FROM api_keys WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.principal.user.id);
    db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.principal.user.id);
    audit(res, 'me.apikey.revoke', k ? `${k.name} (${k.prefix}…)` : null);
    res.json({ ok: true });
  });

  // ── team (owner) ───────────────────────────────────────────────────────────
  // team management needs a real sign-in (or the server API_KEY): a personal key that leaks must not
  // be able to invite, promote or remove people
  const ownerOnly = (req, res, next) => requireRole('owner')(req, res, () => (req.principal.kind === 'userkey' || req.principal.kind === 'hitkey'
    ? res.status(403).json({ error: 'API keys cannot manage the team — sign in' }) : next()));

  // first account: only from a legacy (WEB_PASSWORD) or API-key session, only while there are none
  app.post('/api/team/bootstrap', ownerOnly, async (req, res) => {
    if (hasUsers()) return res.status(409).json({ error: 'Accounts already exist' });
    const b = req.body || {};
    const name = cleanName(b.username), pw = String(b.password || '');
    if (!validName(name)) return res.status(400).json({ error: 'Username: 2–40 characters, letters, digits, . _ @ -' });
    if (pw.length < MIN_PW) return res.status(400).json({ error: `Password needs at least ${MIN_PW} characters` });
    const info = q.insUser.run(name, await hashPassword(pw), 'owner', null, b64u(crypto.randomBytes(16)), Date.now());
    q.sessDelLegacy.run(); // WEB_PASSWORD sessions end here
    audit(res, 'team.first-owner', name);
    res.json({ token: createSession(info.lastInsertRowid) });
  });

  app.get('/api/team', ownerOnly, (_req, res) => {
    const users = db.prepare('SELECT * FROM users ORDER BY created').all().map(publicUser);
    const invites = db.prepare('SELECT id, role, sites, created, expires FROM invites WHERE used_at IS NULL AND expires > ? ORDER BY created DESC').all(Date.now())
      .map((i) => ({ ...i, sites: i.sites ? JSON.parse(i.sites) : null }));
    res.json({ users, invites });
  });
  app.post('/api/team/invites', ownerOnly, (req, res) => {
    if (!hasUsers()) return res.status(400).json({ error: 'Create your own account first' });
    const b = req.body || {};
    const role = cleanRole(b.role);
    if (!role) return res.status(400).json({ error: 'Role must be owner, admin or viewer' });
    const sites = role !== 'owner' ? cleanSites(b.sites) : null; // admins and viewers can be limited to sites
    if (sites === undefined) return res.status(400).json({ error: 'sites must be a list of site ids or null' });
    if (Array.isArray(sites) && !sites.length) return res.status(400).json({ error: 'Pick at least one site' });
    const token = randToken();
    const expires = Date.now() + INVITE_DAYS * 864e5;
    db.prepare('INSERT INTO invites (token_hash, role, sites, created_by, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), role, sites ? JSON.stringify(sites) : null, req.principal.user ? req.principal.user.id : null, Date.now(), expires);
    audit(res, 'team.invite', role + (sites ? ' · sites ' + sites.join(',') : ''));
    res.json({ url: '/invite/' + token, role, expires });
  });
  app.delete('/api/team/invites/:id', ownerOnly, (req, res) => {
    db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(Number(req.params.id));
    audit(res, 'team.invite.revoke', '#' + Number(req.params.id));
    res.json({ ok: true });
  });
  app.patch('/api/team/users/:id', ownerOnly, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Unknown user' });
    const b = req.body || {};
    const role = b.role === undefined ? u.role : cleanRole(b.role);
    if (!role) return res.status(400).json({ error: 'Role must be owner, admin or viewer' });
    if (u.role === 'owner' && role !== 'owner' && q.ownerCount.get().n <= 1) return res.status(400).json({ error: 'There must be at least one owner' });
    let sites = role !== 'owner' ? (b.sites === undefined ? (u.sites ? JSON.parse(u.sites) : null) : cleanSites(b.sites)) : null;
    if (sites === undefined) return res.status(400).json({ error: 'sites must be a list of site ids or null' });
    if (Array.isArray(sites) && !sites.length) return res.status(400).json({ error: 'Pick at least one site' });
    db.prepare('UPDATE users SET role = ?, sites = ? WHERE id = ?').run(role, sites ? JSON.stringify(sites) : null, u.id);
    audit(res, 'team.change', `${u.username}: ${u.role} → ${role}` + (sites ? ' · sites ' + sites.join(',') : ''));
    res.json(publicUser(q.userById.get(u.id)));
  });
  app.delete('/api/team/users/:id', ownerOnly, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Unknown user' });
    if (u.role === 'owner' && q.ownerCount.get().n <= 1) return res.status(400).json({ error: 'There must be at least one owner' });
    db.transaction(() => {
      db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(u.id);
      q.sessDelUser.run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    })();
    audit(res, 'team.remove', u.username);
    res.json({ ok: true });
  });
  // owner can reset 2FA of a teammate who lost their phone (the teammate then sets it up again)
  app.post('/api/team/users/:id/reset-2fa', ownerOnly, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Unknown user' });
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, recovery = NULL WHERE id = ?').run(u.id);
    q.sessDelUser.run(u.id);
    audit(res, 'team.2fa.reset', u.username);
    res.json({ ok: true });
  });

  // owner creates a one-time password-reset link for a teammate (24 h). Only the password changes:
  // 2FA stays on (a reset link must not be a way around it) and all their sessions end.
  app.post('/api/team/users/:id/reset-link', ownerOnly, (req, res) => {
    const u = q.userById.get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'Unknown user' });
    const token = randToken();
    const expires = Date.now() + RESET_HOURS * 3600e3;
    db.transaction(() => {
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id); // only the newest link works
      db.prepare('INSERT INTO password_resets (token_hash, user_id, created_by, created, expires) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(token), u.id, req.principal.user ? req.principal.user.id : null, Date.now(), expires);
    })();
    audit(res, 'team.reset-link', u.username);
    res.json({ url: '/reset/' + token, username: u.username, expires });
  });
  function resetByToken(token) {
    const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(sha256(String(token || '')));
    if (!r || r.used_at || r.expires < Date.now()) return null;
    return r;
  }
  app.get('/api/reset/:token', (req, res) => {
    if (rateLimited('inv:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const r = resetByToken(req.params.token);
    const u = r && q.userById.get(r.user_id);
    if (!u) return res.status(404).json({ error: 'This reset link is invalid, used or expired' });
    res.json({ username: u.username, totp: !!u.totp_secret, expires: r.expires });
  });
  app.post('/api/reset/:token', async (req, res) => {
    if (rateLimited('inv:' + clientIp(req), 30, 15 * 60000)) return res.status(429).json({ error: 'Too many attempts — wait 15 minutes' });
    const pw = String((req.body || {}).password || '');
    if (pw.length < MIN_PW) return res.status(400).json({ error: `Password needs at least ${MIN_PW} characters` });
    if (!resetByToken(req.params.token)) return res.status(404).json({ error: 'This reset link is invalid, used or expired' });
    const pwHash = await hashPassword(pw); // async scrypt, outside the (synchronous) transaction
    const uid = db.transaction(() => {
      const r = resetByToken(req.params.token); // checked again: used/expired while hashing?
      if (!r || !q.userById.get(r.user_id)) return null;
      db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ?').run(Date.now(), r.token_hash);
      db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, r.user_id);
      q.sessDelUser.run(r.user_id);
      return r.user_id;
    })();
    if (!uid) return res.status(404).json({ error: 'This reset link is invalid, used or expired' });
    // no session here: the person signs in normally (with 2FA, if they have it)
    const who = q.userById.get(uid).username;
    audit(res, 'me.password.reset-link', who, who);
    res.json({ ok: true, username: who });
  });

  /** a site created by a site-limited account becomes part of that account's list */
  function grantSite(req, siteId) {
    const p = req.principal;
    if (!p || p.sites == null || !p.user) return;
    const u = q.userById.get(p.user.id);
    if (!u || u.sites == null) return;
    const list = JSON.parse(u.sites);
    if (!list.includes(siteId)) list.push(siteId);
    db.prepare('UPDATE users SET sites = ? WHERE id = ?').run(JSON.stringify(list), u.id);
    p.sites = list;
  }
  /** limited = can only see some sites (cloud customers, viewers with a site list) */
  const isLimited = (req) => !!(req.principal && req.principal.sites != null);
  return { auth, requireRole, siteAllowed, principal, audit, grantSite, isLimited };
}

// ── offline admin (CLI on the server, for lock-outs) ─────────────────────────
function adminOps(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!has) return { list: () => [], reset: () => { throw new Error('No accounts yet'); } };
  return {
    list: () => db.prepare('SELECT id, username, role, totp_secret IS NOT NULL AS totp, last_login FROM users ORDER BY id').all(),
    /** new random password, 2FA off, all sessions of that user ended. Returns the password. */
    reset(username) {
      const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username));
      if (!u) throw new Error('Unknown user: ' + username);
      const pw = crypto.randomBytes(12).toString('base64url');
      db.prepare('UPDATE users SET pw_hash = ?, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, recovery = NULL WHERE id = ?').run(hashPasswordSync(pw), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      // the dashboard's activity log should show this too (the CLI bypasses the HTTP audit middleware)
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get())
        db.prepare('INSERT INTO audit_log (ts, actor, action, target, ip) VALUES (?, ?, ?, ?, ?)').run(Date.now(), 'CLI', 'cli.reset', u.username, null);
      return pw;
    },
  };
}

module.exports = { setupAuth, adminOps, _test: { hashPassword, hashPasswordSync, verifyPassword, totpAt, totpCheck, base32Encode, base32Decode, newRecoveryCodes, normRecovery } };
