<div align="center">

<img src="public/assets/tacilytics-mark.svg" width="96" alt="Tacilytics" />

# Tacilytics

**Privacy-first, cookieless analytics for websites and apps — self-hosted in minutes.**
*Tacit* (adj.): understood without being said. Tacilytics counts what matters and keeps quiet about who did it — one tiny script, one Node process, one SQLite file. No cookies, no IDs, no creepy tracking. (And in Italian, *taci* simply means "be quiet".)

> Formerly **Nyx Analytics**. Existing installs keep working: `/nyx.js`, `window.nyx()` and the old Flutter class names are still supported as aliases.

[![License: MIT](https://img.shields.io/badge/License-MIT-a855f7.svg)](LICENSE)
![Cookieless](https://img.shields.io/badge/cookies-zero-e879a8)
![No tracking](https://img.shields.io/badge/IPs%20stored-never-67e8f9)
![Node](https://img.shields.io/badge/node-%3E%3D18-4ade80)

**[▶ Live demo](https://demo.tacilytics.com)** · **[Website](https://tacilytics.com)** · **[Hosted cloud](https://cloud.tacilytics.com)** · **[Quick start](#quick-start)**

<a href="https://demo.tacilytics.com"><img src="docs/dashboard.png" width="820" alt="Tacilytics dashboard — open the live demo" /></a>

<sub>The demo shows a fictional shop with generated data. No real visitors.</sub>

</div>

---

## Why Tacilytics

- 🍪 **Cookieless.** No cookies, no IDs, nothing written to the visitor's device, no fingerprinting. **Strict mode** (`data-strict`) also reduces what the tracker reads on the device to what every page request carries anyway — see [Strict mode](#strict-mode).
- 🛡️ **IPs are never stored.** Unique visitors are counted with a *daily, salted, one-way hash* that’s irreversible and rotated every day.
- 🌍 **Region from the browser timezone**, never from IP geolocation.
- 🔍 **Segment everything.** Click any country, page, source, browser or campaign to filter the whole dashboard — stacked, with one-click chips.
- 🚦 **Campaigns & funnels.** Full UTM (`source` / `medium` / `campaign`), entry & exit pages, **goal conversion rates** and **custom event properties**.
- ⏱️ **Engagement time** — average time-on-page, measured privately (visible seconds only, no extra identifier).
- 🤖 **Bots & crawlers dropped** automatically, so your numbers stay honest.
- ⚡ **~2 KB tracker**, SPA-aware (tracks `pushState` / `popstate` route changes), optional **DNT / Global Privacy Control** honoring.
- 🗓️ **Data minimisation built in** — optional auto-purge of raw events after a retention window you choose.
- 🎯 **Custom events & goals**, **live visitors**, **trends**, **custom date ranges**, **CSV export**.
- 🛰️ **Agent-ready:** a clean `/api/v1` REST API (with segmentation params) + a `tacilytics` CLI (with `--json`).
- 🗄️ **Zero infra:** Express + SQLite. No Redis, no ClickHouse, no cloud.

## Quick start

**With npm** (fastest):

```bash
mkdir my-analytics && cd my-analytics
npx tacilytics serve      # http://127.0.0.1:3920 — data/ and .env live in this folder
```

Or install it globally: `npm i -g tacilytics`, then `tacilytics serve`.
Set your own `WEB_PASSWORD`, `SESSION_SECRET`, `INGEST_SALT` and `API_KEY` in a `.env` file in that folder (see [`.env.example`](.env.example)).

**With Docker:**

```bash
git clone https://github.com/Open-Cosmic-Software/tacilytics.git && cd tacilytics
cp .env.example .env     # set WEB_PASSWORD, SESSION_SECRET, INGEST_SALT, API_KEY
docker compose up -d     # http://127.0.0.1:3920 — data lives in the tacilytics-data volume
```

The container listens on `0.0.0.0` inside, compose publishes it on `127.0.0.1` only. Outside Docker, set `HOST` to change the bind address.

**From source:**

```bash
git clone https://github.com/Open-Cosmic-Software/tacilytics.git
cd tacilytics
npm install
cp .env.example .env     # set WEB_PASSWORD, SESSION_SECRET, INGEST_SALT, API_KEY
npm start                # http://127.0.0.1:3920
```

The server binds to `127.0.0.1` — put TLS in front. Example **Caddy**:

```
analytics.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3920
}
```

Open the dashboard, log in, click **+ Add site**, and drop the snippet into your `<head>`:

```html
<script defer data-domain="example.com" src="https://analytics.example.com/tacilytics.js"></script>
```

That’s it. Pageviews start flowing in, without cookies. (Want the tracker to read less on the device as well? Add `data-strict`, see [Strict mode](#strict-mode).)

## Custom events, goals & properties

Track conversions from anywhere in your code — optionally with **properties** to break them down:

```js
tacilytics('Signup');
tacilytics('Upgrade', { plan: 'pro' });
tacilytics('Purchase', { plan: 'pro', amount: '49' });
```

Goals show up in the **Goals & conversions** panel with a **conversion rate** (% of visitors). Click a goal to drill into it — the whole dashboard re-segments to converters, and each property’s top values appear as their own breakdown. Pageviews stay separate, so your view counts stay clean.

## Segment everything

Click any row — a country, page, source, browser, OS, device, language or campaign — to **filter the entire dashboard** to that segment. Filters stack and show as removable chips. The same segmentation is available over the API and CLI:

```bash
tacilytics stats example.com 30d --country=DE --source=twitter.com
curl -H "Authorization: Bearer $TACILYTICS_API_KEY" \
  "https://analytics.example.com/api/v1/stats?site=example.com&period=30d&country=DE&medium=email"
```

## Campaigns, entry/exit & engagement

- **UTM campaigns** — `utm_source` / `utm_medium` / `utm_campaign` are captured automatically; switch the Sources panel between **Source / Medium / Campaign**.
- **Entry & exit pages** — switch the Pages panel between **Top / Entry / Exit** to see where visits start and end.
- **Engagement time** — the tracker reports how long each page was actually *visible* (a follow-up beacon, no new identifier), surfaced as **Avg. visit time**.
- **Custom date range** — pick any `from`/`to` window in the toolbar, or pass `--from`/`--to` to the API/CLI.

## Privacy controls on the tag

Opt-in flags on the `<script>` tag:

```html
<script defer data-domain="example.com"
        data-honor-dnt          <!-- skip tracking if DNT / Global Privacy Control is on -->
        data-strict             <!-- reduce device reads (see Strict mode) -->
        data-track-outbound     <!-- auto-record clicks to other domains as events -->
        data-track-downloads    <!-- auto-record file downloads (pdf, zip, docx …) as "File Download"; or ="pdf,epub" -->
        src="https://analytics.example.com/tacilytics.js"></script>
```

### Strict mode

The default tracker writes nothing to the visitor's device, but it does **read** a few things there: one `localStorage` flag (your own visits, below), the time zone (→ country), the browser language, the window size (→ scroll depth) and, with `data-honor-dnt`, the DNT/GPC setting. EU device-access rules (ePrivacy Art. 5(3), in Germany § 25 TDDDG) cover reading as well as storing, and the EDPB reads "access" broadly (Guidelines 2/2023 also count information a script makes the browser send). Strict mode reduces device access to what every page request carries anyway:

```html
<script defer data-domain="example.com" data-strict data-honor-dnt src="https://analytics.example.com/tacilytics.js"></script>
```

In strict mode the tracker does not read local storage, the time zone, the language, the window or screen size, or the DNT/GPC setting. It sends what the page knows: domain, path, referrer, UTM parameters and time on page; the browser adds its usual request headers. To get there it still uses page state, not device properties: `location` and the query string (UTM), `document.referrer`, the DOM for the optional 404 and site-search detection, and a check that `navigator.sendBeacon` exists. Some authorities (EDPB Guidelines 2/2023) read the rules more broadly than "device properties", so do not take "strict" as "nothing at all". The server takes the language from `Accept-Language`, and with `data-honor-dnt` it checks the `DNT` / `Sec-GPC` request headers. Two things are still used for timing and never sent: the page's visibility state (`document.visibilityState`) and the device clock (`Date.now()`, only differences, for time on page). A test runs the tracker with every other device API booby-trapped and fails if strict mode touches one.

**WordPress plugin:** its role exclusion (don't count logged-in admins, editors …) uses a `localStorage` marker in a small inline script before the tracker. Turn the role exclusion off when you use strict mode; a later plugin release will handle it on the server.

What you give up: **no country** (it came from the time zone), **no scroll depth** (time on page stays), and `?tacilytics=off` does not work (the console says so) — exclude your own visits another way (e.g. a test browser you don't count, or filter yourself out in the dashboard). Strict mode does not decide whether you need consent; that depends on your jurisdiction and the rest of your website. This is not legal advice.

### Server mode (no script at all)

Server mode runs no script and reads or stores nothing on the visitor's device. Your web server reports each page view itself, from the request the visitor sent to your page anyway: path, `Referer`, `Accept-Language`, `User-Agent` and the visitor IP. Don't add the `<script>` tag on pages that use server mode; mixing both on one page would bring the script back.

```http
POST /api/v1/hit
Authorization: Bearer tk_…            # a "server mode (count only)" key (Settings → API keys)
Content-Type: application/json

{ "domain": "example.com", "path": "/shop?utm_source=news", "ip": "203.0.113.7",
  "ua": "<User-Agent header>", "referrer": "<Referer header>", "lang": "<Accept-Language header>",
  "purpose": "<Sec-Purpose or Purpose header>" }
```

Node / Express, after your static files and before your pages. It reports only page loads that ended with `200` (no 404s, no redirects) and only for clients that asked for HTML:

```js
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.accepts(['html', 'json']) !== 'html') return next();
  res.on('finish', () => {
    if (res.statusCode !== 200) return;
    fetch('https://analytics.example.com/api/v1/hit', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.TACILYTICS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'example.com', path: req.originalUrl, ip: req.ip, ua: req.get('user-agent'),
        referrer: req.get('referer'), lang: req.get('accept-language'), purpose: req.get('sec-purpose') || req.get('purpose') }),
    }).then((r) => { if (r.status === 429) console.warn('tacilytics: rate limited'); }).catch(() => {});
  });
  next();
});
```

**Which key goes on the web server.** Web servers are where sites get broken into, so the key there should be able to do as little as possible:

- Create a **server mode (count only)** key under Settings → API keys (admin or owner) and tick the site(s) it reports for. It can call `POST /api/v1/hit` for those sites and nothing else (`403` everywhere else, reads included), and it never reaches more than the account that created it.
- **Never** put the `API_KEY` from `.env` on a web server. It is the owner key for every site on the instance.
- Don't use a read + write key either. It still works on `/api/v1/hit` (as in 2.4.0), but a stolen one can also create public share links, point alert webhooks at any URL, upload or delete imports, and change notes, funnels and the time zone of its sites.
- If several sites run on different servers, give each server its own key, so one break-in can be revoked without touching the others.
- Server-mode keys arrived in 2.4.1. Before downgrading to 2.4.0, delete them: 2.4.0 does not know the scope and would treat them as ordinary read-only keys.

- **The visitor IP** is only accepted here, with a server-mode or write key, never on the public `/api/collect`. It is hashed like a tracker hit (daily salt) and never stored. Behind a proxy or load balancer, send the real visitor IP (e.g. `req.ip` with Express `trust proxy` set right), not your proxy's. Without an IP the hit is refused (`400`), because all visitors would fall onto one hash.
- **Filtered on our side:** bots and monitors (same list as the tracker), requests without a user agent, prefetch / prerender (`purpose`), and `dnt: true` / `gpc: true` if you choose to forward those headers. A key can only report for its own sites. The rate limit (6,000 page views a minute) applies per key, so sites on one shared-hosting IP don't block each other; above it the API answers `429` and the hit is not counted.
- **Page caches and CDNs:** if a cache plugin or a CDN (e.g. Cloudflare) answers the request, your server code never runs and the visit is not reported. Report from somewhere every request passes, or exclude HTML from the cache.
- **What you give up compared with the script:** no time on page, no scroll depth, no click / outbound / download events, no country, and no `?tacilytics=off`. Server-side goals work: add `"name": "Purchase", "props": { "value": 49.9 }`.
- **Data protection:** the IP and user agent are personal data while they are hashed. That needs a legal basis (typically legitimate interest, GDPR Art. 6(1)(f)) and a sentence in your privacy policy. If someone else runs Tacilytics for you (for example Tacilytics Cloud), your server passes visitor IPs to them, so you need a data processing agreement (DPA). Server mode does not decide whether you need consent for the rest of your website. This is not legal advice.

**Your own visits:** open your site once with `?tacilytics=off` (e.g. `https://example.com/?tacilytics=off`) and that browser is no longer counted on that site. `?tacilytics=on` undoes it. It is stored in the browser's localStorage, nothing is sent; repeat it on every browser and phone you use. Settings → Security has the links for all your sites.

## Mobile & desktop apps

Track your **native app in the same dashboard as your website**. Every row gets a platform
(`web`, `android`, `ios`, `macos`, `windows`, `linux`), so you can see everything together or
click a platform to filter. Once an app reports in, you get a **Platforms** panel (plus app
versions) and **Revenue by platform**.

**Flutter** — a ready-made package lives in [`sdk/flutter`](sdk/flutter):

```dart
Tacilytics.init(endpoint: 'https://analytics.example.com', domain: 'example.com', appVersion: '1.4.0');
Tacilytics.instance.setEnabled(userConsented);       // off until you say so — wire it to your consent
MaterialApp(navigatorObservers: [TacilyticsRouteObserver()]); // automatic screen views
Tacilytics.instance.search('vinegar', 6);
Tacilytics.instance.purchase(value: 49.90, currency: 'EUR', items: 2);
```

**Any other stack** (Swift, Kotlin, React Native, …) — it is one JSON `POST /api/collect`:

| field | meaning |
|---|---|
| `d` | site domain (as registered) |
| `p` | screen, written like a path (`/product/42`) |
| `pf` | platform: `android` · `ios` · `macos` · `windows` · `linux` |
| `sid` | random id drawn **per app launch**, kept in memory only (16–64 chars `A-Za-z0-9_-`) |
| `av` | app version (optional) |
| `dv` | `mobile` · `tablet` · `desktop` (optional) |
| `l` / `cc` | language tag / 2-letter region of the device locale (optional) |
| `n` / `pr` | event name + flat properties, same as the web `tacilytics()` call (optional) |
| `s` / `um` / `uc` | utm source / medium / campaign, e.g. from a deep link (optional) |

Send any non-empty, non-bot `User-Agent` (e.g. `MyApp/1.4 (android)`).

Privacy stays the same as on the web: **no device or advertising id, no cookies, no IP stored.**
The server hashes the launch id with a random daily salt that is deleted when the day ends, so a visitor is never followed across days.
Without `sid`, the usual IP + user-agent daily hash is used. Region comes from the timezone or
device locale, never from IP geolocation.

## Import from Google Analytics or Plausible

**Import** (toolbar) brings your history along, so switching doesn't mean starting at zero.

- **Plausible:** Site settings → Imports & Exports → *Export data*. Upload the ZIP (or the CSVs in it).
- **Google Analytics 4:** open a report (*Pages and screens*, *Traffic acquisition*, *Demographic details*, *Tech*), add **Date** as a secondary dimension, *Share → Download file → CSV*. One file per report; English or German column names.

Imported numbers are daily totals per dimension (pages, sources, countries, browsers, OS, devices, events) and count **only for days before your own data starts** — never twice. They appear in the chart, the totals and the panels; while a filter is active they are left out (they can't be combined), and the dashboard says so. Every import can be removed again. No visitor-level data is imported or stored.

## Notes in the chart

Click **Notes** in the chart legend to mark a day — a newsletter, a release, a sale. A coral line and a diamond appear on that day, the note shows in the tooltip, and everyone with access to the site (including share links) sees it. Admins and owners add and remove notes. `GET /api/annotations?site=…` lists them; `/stats` returns the ones in its range as `annotations`.

## Time zone per site

Every site has its own time zone (any IANA name, e.g. `Europe/Berlin`; the browser's zone is preselected when you add a site, existing sites stay on `UTC`). Click the clock next to the site picker to change it. Days, the hourly view, date ranges, notes, the weekly report, the daily digest and the alert baseline all follow it, with daylight-saving days as 23 or 25 hours and offsets like +5:45 kept exact. Stored data is not touched, so switching back and forth is safe.

One limit: the anonymous visitor ID rotates at midnight **UTC** (that is what keeps it unlinkable across days). Outside UTC a local day therefore spans two IDs, and *unique visitors per day* are an approximation — pageviews, goals and revenue are exact.

`PATCH /api/sites/:id {"timezone":"Europe/Berlin"}` (admin) changes it via the API; unknown names are rejected with 400.

## Weekly report by e-mail

Settings → Security → **Weekly report**: enter an address and tick *every Monday*. Each person gets one mail per week for **the sites they can see** — visitors and pageviews vs. the week before, top pages, sources, goals and a link to the dashboard. *Send one now* sends a sample.

Needs mail settings in `.env`:

```env
SMTP_URL=smtps://user:password@mail.example.com:465     # or smtp://…:587 (STARTTLS)
REPORT_FROM=Tacilytics <reports@example.com>
REPORT_HOUR_UTC=6                                         # Monday, this hour (UTC)
TACILYTICS_ORIGIN=https://analytics.example.com           # for the dashboard link in the mail
```

## Alerts

**Alerts** (toolbar) sends a message to a webhook — Discord, Slack, or anything that takes JSON — when:

- **Traffic spike:** about 3× the usual for this hour of the day,
- **Traffic drop:** under 20 % of usual (often: the tracker fell off the site),
- **Goal reached:** e.g. 10× `Purchase` within 1 hour, 24 hours or 7 days.

"Usual" is the median of the same hour over the last 14 days, so quiet nights don't look like incidents. Checked every 10 minutes, with a cooldown so one long spike is one message. **Test** sends a sample message. Admins and owners manage alerts.

Webhooks entered in the dashboard must be public `https://` addresses — no localhost, private ranges or redirects, so nobody on the team can use alerts to reach internal services. `DIGEST_WEBHOOK_URL` from `.env` is the default target (and may be internal); sites without own alerts keep the default spike/drop alerts there.

## Live visitors

Click **“● online now”** for a realtime view: a 30-minute pulse and a live feed of
who’s on the site right now — page, goal, country, browser/device and source —
auto-refreshing every few seconds.

<div align="center"><img src="docs/live.png" width="560" alt="Live visitors" /></div>

## Agent API

Everything the dashboard shows is available over a stable REST API, authenticated with a Bearer key:

```bash
curl -H "Authorization: Bearer $TACILYTICS_API_KEY" \
  "https://analytics.example.com/api/v1/stats?site=example.com&period=30d"
```

| Method & path | Description |
|---|---|
| `GET /api/v1` | API discovery |
| `GET /api/v1/sites` | list tracked sites |
| `POST /api/v1/sites` | add a site `{ domain }` |
| `GET /api/v1/stats?site=&period=` | aggregated stats — `today \| 7d \| 30d \| 90d \| 12mo`, or `from=YYYY-MM-DD&to=YYYY-MM-DD` |
| `GET /api/v1/realtime?site=` | online count, 30-min pulse + recent events |
| `POST /api/v1/hit` | server mode: report a page view from your web server (server-mode key), see [Server mode](#server-mode-no-script-at-all) |

Add any of `country, source, page, browser, os, device, lang, medium, campaign, goal` to `/stats` to segment, e.g. `…/stats?site=example.com&period=30d&country=DE&medium=email`.

## CLI

```bash
export TACILYTICS_URL=https://analytics.example.com
export TACILYTICS_API_KEY=xxx

tacilytics sites
tacilytics stats example.com 30d
tacilytics live example.com --watch
tacilytics add example.com

# on the server itself (reads the database, no API key)
tacilytics users
tacilytics reset-login <username>
```

Add `--json` to any command for machine-readable output — perfect for agents and scripts.

## How it works

`tacilytics.js` sends a tiny beacon (`navigator.sendBeacon`, `text/plain` so the cross-origin
request stays preflight-free) with the path, referrer, timezone and language — no
personal data, no cookies. The server parses the User-Agent (browser/OS/device),
drops bots, maps timezone → country, derives the **daily visitor hash**, and stores one
row per pageview. The dashboard aggregates it with plain SQL.

**The cookieless trade-off, honestly:** because there’s no persistent identifier, Tacilytics
counts unique visitors *per day* and can’t follow the same person across days or
devices. You get the 95 % that matters (how many, which pages, from where) without cookies,
the same approach as Plausible/Fathom. Whether you still need consent depends on your
jurisdiction and setup; strict mode (`data-strict`) reduces the device reads further.

**Sources per visit.** Like GA, Plausible and Matomo, the source belongs to the visit: an internal
click or a reload inherits the source of the same visitor's previous page view within 30 minutes,
instead of showing up as *Direct*. This happens on the server (daily visitor hash), so strict mode
works the same and nothing extra is read on the device.

**Bots and scrapers.** Known crawler, AI-scraper and HTTP-library user agents are dropped. Scrapers
that pretend to be a normal browser usually run in a cloud: by default, visits from cloud and hosting
networks are ignored too (list: [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn) *datacenter*,
MIT, downloaded once a day — no visitor data leaves your server). The IP is checked on arrival and
never stored. iCloud Private Relay runs on the same cloud networks, so Apple's published egress list is
downloaded too and always let through; without it the filter stays off. A list that looks wrong (a
range shorter than /8, more than 25 % of IPv4, a known residential address inside) is refused, and a
failed download is retried with backoff. Honest trade-off: commercial VPNs, Opera's built-in VPN and
cloud desktops (Windows 365, AVD) are not counted either — for B2B sites consider switching it off.
If more than half of a site's hits in an hour are dropped, the server log warns (usually a proxy
setup: check `TRUST_PROXY`). Switch it off per site in the time-zone dialog, or for the whole server
with `TACILYTICS_DATACENTER=off`.

## Light mode & German

Settings → Security → **Appearance**: *Theme* (System / Light / Dark) and *Language* (Automatic / English / Deutsch), saved per browser. *System* follows the device's light/dark setting live; *Automatic* picks German when the browser is German. Your data (paths, sources, event names) is never translated.

## Team, 2FA & passkeys

Out of the box the dashboard opens with one shared passphrase (`WEB_PASSWORD`). When you want more:

1. Sign in, open **Settings → Security** and create your **owner account**. From then on `WEB_PASSWORD` no longer opens anything, so nobody can walk around your 2FA with it.
2. **Settings → Team → Invite someone** creates a link that works **once, for 7 days**. Send it yourself; Tacilytics sends no e-mail.

| Role | Can |
|---|---|
| **Owner** | everything, including the team |
| **Admin** | add/remove sites, share links, funnels — optionally limited to **specific sites** |
| **Viewer** | read only — optionally limited to **specific sites** |

**Hosting several customers on one instance** (2.3): give each customer an **admin limited to their sites**. The operator adds their sites; a domain that already belongs to someone else is refused (409) instead of being shared. Pause a site with `PATCH /api/sites/:id {"paused": true}` (server key or an unlimited owner/admin): it collects nothing until resumed, the data stays. `GET /api/v1/usage?month=YYYY-MM` lists page views per site for volume checks (operator only). The operator's `DIGEST_WEBHOOK_URL` is never used for alerts of limited accounts; set `DIGEST_WEBHOOK_URL=off` on a shared instance so the daily digest does not list customer domains. `DASHBOARD_EXTRA_SCRIPT=/path.js` adds one same-origin script to the dashboard (e.g. a billing banner served by your own proxy). Paused sites are left out of alerts and the weekly report. Site-limited accounts cannot add or delete sites (the operator does both, sites are what is billed and paused). **Domains are first come, first served:** if a customer gets 409 for a domain they own, the operator resolves it with an owner account (move the site to the right account in Settings → Team); domain verification is planned.

Everyone can turn on, **optionally**:

- **Passkeys** (Face ID, Touch ID, Windows Hello, security keys). A passkey replaces password *and* code and cannot be phished.
- **One-time codes (TOTP)** from any authenticator app, with 10 single-use **recovery codes**. Codes cannot be reused.

**Forgot the password?** An owner clicks **Password link** next to the person in Settings → Team: a one-time link (24 h) to set a new one. Their 2FA stays on and all their sessions end.

**Activity log:** owners see every change in Settings → Activity — who added a site, invited someone, changed a role, created an API key, turned 2FA off … with time and address. Failed attempts and sign-ins are not logged, secrets never. Kept for a year (`AUDIT_RETENTION_DAYS`, minimum 30).

**Locked out?** On the server: `tacilytics users` lists accounts, `tacilytics reset-login <username>` prints a new password, turns 2FA off and ends that person's sessions. An owner can also reset a teammate's 2FA in Settings → Team.

**API keys per person:** Settings → Security → API keys creates a personal key (`tk_…`) for scripts, agents and the CLI. It acts as you and never more: it sees only your sites, is **read-only unless you untick it** (a viewer's key always is), and cannot manage the team or change security settings. Keys are stored as SHA-256, shown once, and can be revoked; removing a member revokes theirs.

The server-wide `API_KEY` from `.env` keeps owner rights for agents and the CLI on your own box.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3920` | Port (bound to 127.0.0.1) |
| `WEB_PASSWORD` | `tacilytics` | Dashboard passphrase — **only until the first account exists** |
| `TACILYTICS_ORIGIN` | request host | Public URL of the dashboard, e.g. `https://analytics.example.com`. Pins the passkey domain; recommended behind a proxy |
| `TRUST_PROXY` | `1` | Number of HTTP reverse proxies in front of Tacilytics that append `X-Forwarded-For` (e.g. Cloudflare + Caddy = `2`; a plain TCP forwarder like socat or `ssh -L` does not count). Rate limits **and visitor hashes** use the address the outermost trusted proxy saw, never the client-written first `X-Forwarded-For` entry. Too low: with two proxies and `1`, every visitor looks like the Cloudflare address and unique visitors collapse. Too high: clients can pick their own address and bypass the limits. Tacilytics binds to 127.0.0.1, so a proxy is always in front and `0` is almost always wrong (everyone becomes 127.0.0.1). A request without `X-Forwarded-For` logs a one-time warning |
| `INGEST_SALT` | fixed | Extra server-side secret mixed into the visitor hash (on top of the random daily salt) |
| `API_KEY` | — | Bearer key for the API / CLI |
| `DB_PATH` | `./data/analytics.db` | SQLite path |
| `DIGEST_WEBHOOK_URL` | — | Daily digest + default alert target (Discord/Slack-compatible). `off` disables it |
| `DASHBOARD_EXTRA_SCRIPT` | — | One same-origin script added to the dashboard page (hosting banner). Only a plain path like `/cloud/ui.js`; URLs, `//` and `..` are ignored |
| `WATCH_MIN_VISITORS` | `10` | Spike/drop alerts stay silent below this many visitors per hour |
| `SMTP_URL` / `REPORT_FROM` | — | Mail server + sender for the weekly report |
| `REPORT_HOUR_UTC` | `6` | Monday hour (UTC) the weekly report goes out; it covers the last 7 full days in each site's time zone |
| `AUDIT_RETENTION_DAYS` | `365` | How long the team activity log is kept (min. 30) |
| `TACILYTICS_DATACENTER` | on | `off` disables the cloud / hosting network filter server-wide (no list download) |
| `TACILYTICS_DATACENTER_FILE` | — | Use local range lists instead of the daily download (comma-separated paths, CIDR per line), e.g. for offline installs |
| `TACILYTICS_RELAY_FILE` | — | Local copy of Apple's iCloud Private Relay egress CSV (with a local datacenter list) |
| `DATA_RETENTION_DAYS` | `0` | `0` = keep forever; `>0` purges raw events older than N days, daily (data minimisation) |

## Privacy & security

- No cookies, no cross-site tracking, **IPs never persisted**.
- Daily one-way visitor hash with a **random salt per day**. It lives in its own small file (`data/.day-salt`, mode 600), never in the database, and is overwritten in place when the next day starts. Past days can't be re-linked afterwards, not even with the database, a known IP or user agent, or the server's own secrets. Only the server clock picks the day; late or out-of-day events get an unlinkable one-off hash.
  - **Honest limits of "overwritten":** on ext4 an in-place overwrite really replaces the bytes. On copy-on-write filesystems (btrfs, ZFS), in filesystem or VM snapshots, and on SSDs (wear levelling) the old block can physically survive. **Backups of `data/` contain the salt of the day they were taken**, so treat them like the live server or exclude `data/.day-salt` from them.
  - **One process only.** The salt is drawn by the single Node process. Running several processes against the same `data/` would let each draw its own salt at midnight.
- **Data minimisation:** set `DATA_RETENTION_DAYS` to auto-purge raw events after your chosen window.
- **Respects DNT / Global Privacy Control** when you add `data-honor-dnt` to the tag.
- **Strict mode** (`data-strict`) skips the device reads (no localStorage, time zone, language or window size). See [Strict mode](#strict-mode).
- **Server mode** (`POST /api/v1/hit`) runs no script on the visitor's device at all; your server reports the page view. See [Server mode](#server-mode-no-script-at-all).
- Engagement time adds **no new identifier** — it’s matched to the visitor’s own daily hash server-side.
- Custom event properties are capped (scalars only, size-limited) so they can’t become a PII dumping ground.
- Passwords hashed with scrypt; session tokens, invite links and recovery codes are stored only as SHA-256. Sessions live in the database (survive restarts, expire after 30 days).
- Timing-safe auth; login (per IP and per account), the 2FA step and the collect endpoint are rate-limited. Unknown usernames take as long as wrong passwords.
- Every per-site endpoint checks access: share links see exactly their site, viewers only the sites they were given.
- All visitor-supplied values are HTML-escaped before they reach the DOM.
- Run behind TLS; keep `.env` at `chmod 600`.

## How it compares

An honest overview. Plausible and Umami are good projects; pick what fits you.

| | Tacilytics | Plausible CE | Umami | Google Analytics 4 |
|---|---|---|---|---|
| Cookies | ❌ none | ❌ none | ❌ none | ✅ yes |
| IPs leave your server | ❌ never | ❌ | ❌ | ✅ sent to Google |
| No script on the device at all | ✅ server mode | ❌ | ❌ | ❌ |
| Strict mode (no device reads) | ✅ | ❌ | ❌ | ❌ |
| Mobile app SDK | ✅ Flutter | ❌ | ❌ | ✅ |
| Runs on | Node + SQLite file | Elixir + Postgres + ClickHouse | Node + Postgres/MySQL | Google |
| Tracker size | ~2 KB | ~1 KB | ~2 KB | ~45 KB+ |
| Built for big traffic (millions/day) | ⚠️ not yet, SQLite | ✅ | ✅ | ✅ |
| Self-hosted, you own the data | ✅ | ✅ | ✅ | ❌ |
| Licence | MIT | AGPL | MIT | proprietary |

*As of October 2026, to the best of our knowledge. Spot a mistake? Please [open an issue](https://github.com/Open-Cosmic-Software/tacilytics/issues).*

## Contributing

Issues, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go [privately](SECURITY.md).

## Credits

- UI icons: [Lucide](https://lucide.dev) (ISC)
- Brand marks: [Simple Icons](https://simpleicons.org) (CC0). Brand names and logos are trademarks of their owners; see `public/assets/DISCLAIMER-simple-icons.md`. Windows and Edge have no free official mark, so a neutral icon is shown.
- Flags: [flag-icons](https://flagicons.lipis.dev) (MIT)
- Font: [Inter](https://rsms.me/inter/) (SIL OFL 1.1), self-hosted
- Datacenter ranges: [X4BNet/lists_vpn](https://github.com/X4BNet/lists_vpn) (MIT), downloaded at runtime, not bundled
- iCloud Private Relay egress ranges: published by Apple (`mask-api.icloud.com`), downloaded at runtime as an allowlist

## License

[MIT](LICENSE) — built by **Nyx & Fabian** 🦞
