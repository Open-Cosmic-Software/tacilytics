/* Tacilytics dashboard */
(function () {
  var TOKEN = localStorage.getItem('nyx_token') || '';
  // share mode: /share/<token> renders a read-only dashboard without login
  var SHARE = (location.pathname.match(/^\/share\/([a-f0-9]{32,64})$/) || [])[1] || '';
  var state = { site: localStorage.getItem('nyx_site') || '', period: '7d', from: '', to: '', sites: [], filters: {}, srcTab: 'sources', pageTab: 'pages' };
  // which chart series are visible (toggled via the legend)
  state.show = { visitors: true, pageviews: true };
  try {
    var savedShow = JSON.parse(localStorage.getItem('nyx_show') || 'null');
    // Never allow both off — an empty chart looks like broken data, not like a choice.
    if (savedShow && (savedShow.visitors || savedShow.pageviews)) {
      state.show = { visitors: !!savedShow.visitors, pageviews: !!savedShow.pageviews };
    }
  } catch (e) { /* corrupt value → keep both visible */ }
  var lastStats = null;
  function closeModal(ov, opt) { return window.TaciModal.close(ov, opt); } // one close path for all modals (account.js)
  // dashboard segmentation filters (whitelist mirrors the server's FILTER_COLS + goal)
  var FILTER_LABELS = { country: 'Country', source: 'Source', page: 'Page', browser: 'Browser', os: 'OS', device: 'Device', lang: 'Language', medium: 'Medium', campaign: 'Campaign', platform: 'Platform', version: 'App version', goal: 'Goal' };

  // build the stats/realtime query string from the current site, period/range and active filters
  function statsQuery() {
    var q = 'site=' + encodeURIComponent(state.site);
    if (SHARE) q += '&share=' + SHARE;
    if (state.from && state.to) q += '&from=' + state.from + '&to=' + state.to;
    else q += '&period=' + state.period;
    Object.keys(state.filters).forEach(function (k) { q += '&' + k + '=' + encodeURIComponent(state.filters[k]); });
    return q;
  }
  function setFilter(key, value) { if (!value || value === 'Direct') return; state.filters[key] = value; load(); }
  function removeFilter(key) { delete state.filters[key]; load(); }
  function clearFilters() { state.filters = {}; load(); }
  var $ = function (id) { return document.getElementById(id); };
  var ORIGIN = location.origin;
  // chart palette comes from CSS custom properties (single source of truth for the theme)
  var CSSV = getComputedStyle(document.documentElement);
  function cv(name, fb) { return (CSSV.getPropertyValue(name) || '').trim() || fb; }
  var COL = {};
  // chart colours follow the theme: re-read the CSS variables whenever it changes
  function readColors() {
    CSSV = getComputedStyle(document.documentElement);
    COL.v = cv('--chart-visitors', '#5b8def'); COL.p = cv('--chart-pageviews', '#8b93a3'); COL.red = cv('--red', '#f87171');
    COL.dim = cv('--text-dim', '#8b93a3'); COL.line = cv('--line-strong', '#323946'); COL.bg = cv('--bg', '#071114');
    COL.grid = document.documentElement.getAttribute('data-theme') === 'light' ? 'rgba(10,40,38,.08)' : 'rgba(255,255,255,.05)';
  }
  readColors();
  new MutationObserver(function () { readColors(); if (lastStats && lastStats.series) drawChart(lastStats.series); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Escape any value that originates from visitor beacons before it touches innerHTML.
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json', 'x-session-token': TOKEN }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { if (!SHARE) showLogin(); throw new Error('auth'); }
      // same rule as account.js: JSON errors come back as {error}, anything that is not JSON throws (Tyto)
      return window.TaciReadJson(r);
    });
  }

  // ── flags / names ──
  // ── icons: UI = Lucide, brands = Simple Icons (sprite /assets/icons.svg), flags = flag-icons ──
  var SPRITE = '/assets/icons.svg?v=1';
  var BRAND_COLORS = {"apple": "#000000", "android": "#3DDC84", "linux": "#FCC624", "chrome": "#4285F4", "safari": "#006CFF", "firefox": "#FF7139", "samsung": "#1428A0", "opera": "#FF1B2D", "google": "#4285F4", "facebook": "#0866FF", "instagram": "#FF0069", "youtube": "#FF0000", "tiktok": "#000000", "x": "#000000", "duckduckgo": "#DE5833", "gmail": "#EA4335", "whatsapp": "#25D366", "pinterest": "#BD081C", "reddit": "#FF4500", "klarna": "#FFB3C7", "paypal": "#002991", "flutter": "#02569B", "swift": "#F05138", "kotlin": "#7F52FF", "react": "#61DAFB", "ecosia": "#008009", "brave": "#FB542B", "vivaldi": "#EF3939", "yandex": "#5282FF", "telegram": "#26A5E4", "ios": "#000000", "macos": "#000000", "ubuntu": "#E95420", "chromeos": "#4285F4", "twitch": "#9146FF", "github": "#181717", "discord": "#5865F2", "snapchat": "#FFFC00", "threads": "#000000", "bluesky": "#1185FE", "mastodon": "#6364FF", "signal": "#3B45FD"};
  function isDark(hex) {
    var h = hex.replace('#', ''); if (h.length !== 6) return false;
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return Math.max(r, g, b) < 90; // only near-black / deep navy marks; saturated reds stay
  }
  // lookup tables keyed by visitor data (source, country, platform …): own keys only, so a source
  // called 'constructor' or '__proto__' stays plain text instead of hitting Object.prototype
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }
  function ico(id, cls) { return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"><use href="' + SPRITE + '#' + id + '"></use></svg>'; }
  function brand(name, fallbackUi) {
    if (!name) return ico(fallbackUi || 'i-other', 'ui');
    var c = own(BRAND_COLORS, name);
    if (name === 'samsung') c = '#6f8dff'; // Samsung navy is unreadable on dark — same hue, lighter
    if (c && isDark(c)) c = '#e7f3f1'; // black logos (Apple, X, GitHub …) would vanish on the dark UI
    return '<svg class="ico brand" aria-hidden="true"' + (c ? ' style="color:' + c + '"' : '') + '><use href="' + SPRITE + '#b-' + name + '"></use></svg>';
  }
  function flagIcon(cc) {
    if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return ico('i-globe', 'ui');
    return '<img class="flag" src="/assets/flags/' + cc.toLowerCase() + '.svg" alt="" loading="lazy" width="18" height="14">';
  }
  var BROWSER_ICON = { Chrome: 'chrome', Safari: 'safari', Firefox: 'firefox', Samsung: 'samsung', Opera: 'opera', Vivaldi: 'vivaldi', Brave: 'brave', Yandex: 'yandex' };
  var OS_ICON = { Android: 'android', iOS: 'apple', macOS: 'apple', Linux: 'linux', ChromeOS: 'chrome' };
  var PLATFORM_ICON = { android: 'android', ios: 'apple', macos: 'apple', linux: 'linux' };
  function sourceBrand(n) {
    var h = String(n || '').toLowerCase();
    var map = [['google', 'google'], ['gmail', 'gmail'], ['.gm', 'gmail'], ['facebook', 'facebook'], ['fb', 'facebook'], ['instagram', 'instagram'], ['ig', 'instagram'],
      ['youtube', 'youtube'], ['tiktok', 'tiktok'], ['t.co', 'x'], ['twitter', 'x'], ['x.com', 'x'], ['duckduckgo', 'duckduckgo'], ['ecosia', 'ecosia'], ['reddit', 'reddit'],
      ['pinterest', 'pinterest'], ['whatsapp', 'whatsapp'], ['telegram', 'telegram'], ['github', 'github'], ['paypal', 'paypal'], ['klarna', 'klarna'], ['discord', 'discord'],
      ['twitch', 'twitch'], ['snapchat', 'snapchat'], ['threads', 'threads'], ['bsky', 'bluesky'], ['mastodon', 'mastodon']];
    for (var i = 0; i < map.length; i++) {
      var k = map[i][0];
      if (h === k || h.indexOf(k + '.') === 0 || h.indexOf('.' + k + '.') >= 0 || h.indexOf(k) >= 0 && k.length > 3) return map[i][1];
    }
    return null;
  }

  function flag(cc) { return flagIcon(cc); } // returns HTML now (img), never a text emoji
  var NAMES = { DE: 'Germany', AT: 'Austria', CH: 'Switzerland', GB: 'United Kingdom', US: 'United States', FR: 'France', NL: 'Netherlands', ES: 'Spain', IT: 'Italy', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland', CZ: 'Czechia', BE: 'Belgium', IE: 'Ireland', PT: 'Portugal', CA: 'Canada', AU: 'Australia', BR: 'Brazil', IN: 'India', JP: 'Japan', CN: 'China', RU: 'Russia', TR: 'Turkey', MX: 'Mexico', HU: 'Hungary', RO: 'Romania', GR: 'Greece', UA: 'Ukraine', HR: 'Croatia', NZ: 'New Zealand', SG: 'Singapore', KR: 'South Korea', IL: 'Israel', AE: 'UAE', ZA: 'South Africa' };

  // ── login (the form itself lives in account.js: passphrase, accounts, TOTP, passkeys) ──
  function showLogin() { clearInterval(window.__rt); [].forEach.call(document.querySelectorAll('.modal-overlay:not(#login):not(.hide)'), function (o) { closeModal(o, { force: true }); }); $('login').classList.remove('hide'); $('app').classList.add('hide'); var v = $('appVersion'); if (v) v.textContent = ''; if (window.TaciAccount) window.TaciAccount.prepareLogin(); }
  function hideLogin() { $('login').classList.add('hide'); $('app').classList.remove('hide'); }
  function signedIn(token) { TOKEN = token; localStorage.setItem('nyx_token', TOKEN); $('loginErr').textContent = ''; boot(); }
  $('logoutBtn').onclick = function () {
    fetch('/auth/logout', { method: 'POST', headers: { 'x-session-token': TOKEN } }).catch(function () {});
    localStorage.removeItem('nyx_token'); TOKEN = ''; showLogin();
  };
  // hooks for account.js
  window.Taci = { api: api, esc: esc, ico: ico, signedIn: signedIn, sites: function () { return state.sites; }, reloadSites: function () { return loadSites().then(load); } };

  // ── sites ──
  function loadSites() {
    return api('/api/sites').then(function (sites) {
      state.sites = sites;
      var sel = $('siteSelect');
      sel.innerHTML = sites.map(function (s) { return '<option value="' + esc(s.domain) + '">' + esc(s.domain) + '</option>'; }).join('');
      if (!sites.length) { sel.innerHTML = '<option>no sites yet</option>'; return; }
      if (!state.site || !sites.some(function (s) { return s.domain === state.site; })) state.site = sites[0].domain;
      sel.value = state.site;
      showTz();
    });
  }
  $('siteSelect').onchange = function () { state.site = this.value; showTz(); localStorage.setItem('nyx_site', state.site); load(); if (typeof loadFunnels === 'function') loadFunnels(); };

  // ── time zones: the browser's zone is the default for a new site; the list comes from Intl ──
  var BROWSER_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  var TZ_LIST = (function () {
    var l = []; try { l = Intl.supportedValuesOf('timeZone'); } catch (e) { /* old browser: the two below */ }
    if (l.indexOf('UTC') < 0) l = ['UTC'].concat(l);
    if (l.indexOf(BROWSER_TZ) < 0) l.push(BROWSER_TZ);
    return l;
  })();
  function fillTz(sel, value) {
    var list = TZ_LIST.indexOf(value) < 0 ? TZ_LIST.concat([value]) : TZ_LIST;
    sel.innerHTML = list.map(function (z) { return '<option value="' + esc(z) + '">' + esc(z.replace(/_/g, ' ')) + '</option>'; }).join('');
    sel.value = value;
  }
  // today in the site's time zone (en-CA formats as YYYY-MM-DD)
  function localToday() { var s = currentSite(); try { return new Intl.DateTimeFormat('en-CA', { timeZone: (s && s.timezone) || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function currentSite() { return (state.sites || []).filter(function (s) { return s.domain === state.site; })[0]; }
  function showTz() { var s = currentSite(); $('tzName').textContent = s ? String(s.timezone || 'UTC').replace(/_/g, ' ') : 'UTC'; $('tzBtn').classList.toggle('hide', !s); }
  $('tzBtn').onclick = function () {
    var s = currentSite(); if (!s) return;
    $('tzSite').textContent = s.domain; $('tzErr').textContent = ''; fillTz($('tzSelect'), s.timezone || 'UTC'); $('dcFilter').checked = s.dc_filter !== 0; $('dcFilter').disabled = s.dc_active === false;
    $('dcFilter').parentNode.style.opacity = s.dc_active === false ? '0.55' : '';
    $('dcInfo').textContent = s.dc_active === false ? 'The filter is not running on this server right now (switched off, or the network lists have not loaded yet). Every visit is counted.'
      : s.dc_dropped_today ? s.dc_dropped_today + ' of ' + s.dc_seen_today + ' hits from cloud networks ignored today (UTC).' : '';
    $('tzModal').classList.remove('hide'); $('tzSelect').focus();
  };
  $('cancelTz').onclick = function () { closeModal($('tzModal'), { force: true }); };
  $('saveTz').onclick = function () {
    var s = currentSite(); if (!s) return;
    api('/api/sites/' + s.id, { method: 'PATCH', body: JSON.stringify($('dcFilter').disabled ? { timezone: $('tzSelect').value } : { timezone: $('tzSelect').value, dcFilter: $('dcFilter').checked }) }).then(function (r) {
      if (r.error) { $('tzErr').textContent = r.error; return; }
      closeModal($('tzModal'), { force: true });
      loadSites().then(load);
    });
  };

  $('addSiteBtn').onclick = function () { $('addModal').classList.remove('hide'); $('newDomain').value = ''; fillTz($('newTz'), BROWSER_TZ); $('addErr').textContent = ''; $('newDomain').focus(); };
  $('cancelAdd').onclick = function () { closeModal($('addModal'), { force: true }); };
  $('createSiteBtn').onclick = function () {
    var d = $('newDomain').value.trim();
    api('/api/sites', { method: 'POST', body: JSON.stringify({ domain: d, timezone: $('newTz').value }) }).then(function (s) {
      if (s.error) { $('addErr').textContent = s.error; return; }
      $('addModal').classList.add('hide');
      state.site = s.domain; localStorage.setItem('nyx_site', state.site);
      loadSites().then(function () { $('siteSelect').value = state.site; load(); showSnippet(s.domain); });
    });
  };
  $('newDomain').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('createSiteBtn').click(); });

  // ── snippet: website, Flutter app, any other app (same site, platform tells them apart) ──
  var SNIP_REPO = 'https://github.com/Open-Cosmic-Software/tacilytics';
  state.snipTab = 'web';
  function snippetFor(domain) {
    return '<script defer data-domain="' + domain + '" src="' + ORIGIN + '/tacilytics.js"><\/script>';
  }
  function snipParts(domain, tab) {
    if (tab === 'flutter') return {
      s1: '1 · Add the package to <code>pubspec.yaml</code>, then run <code>flutter pub get</code>:',
      c1: 'dependencies:\n  tacilytics:\n    git:\n      url: ' + SNIP_REPO + '\n      path: sdk/flutter',
      s2: '2 · Start it in <code>main()</code> — screens are tracked automatically:',
      c2: "import 'package:tacilytics/tacilytics.dart';\n\nvoid main() {\n  Tacilytics.init(\n    endpoint: '" + ORIGIN + "',\n    domain: '" + domain + "',\n    appVersion: '1.0.0',\n    enabled: true,\n  );\n  runApp(MaterialApp(\n    navigatorObservers: [TacilyticsRouteObserver()],\n    home: const MyHome(),\n  ));\n}",
      hint: 'Goals &amp; revenue anywhere in your code:<br><code>Tacilytics.instance.event(\'Signup\')</code> · <code>.search(\'term\', 6)</code> · <code>.purchase(value: 49.90)</code><br><span style="opacity:.7">No cookies, no device id. Want it only after consent? Leave out <code>enabled: true</code> and call <code>setEnabled(true)</code> later.</span>'
    };
    if (tab === 'other') return {
      s1: 'Swift, Kotlin, React Native, Unity … — send one JSON <code>POST</code> per screen or event:',
      c1: 'POST ' + ORIGIN + '/api/collect\nContent-Type: application/json\nUser-Agent: MyApp/1.0 (android)\n\n{\n  "d": "' + domain + '",\n  "p": "/product/42",\n  "pf": "android",\n  "sid": "<random id, new per app launch>",\n  "av": "1.0.0"\n}',
      s2: 'Event with properties (e.g. a purchase) — add a name and props:',
      c2: '{\n  "d": "' + domain + '", "p": "/checkout", "pf": "ios", "sid": "…",\n  "n": "Purchase",\n  "pr": { "value": "49.90", "currency": "EUR" }\n}',
      hint: '<code>pf</code>: android · ios · macos · windows · linux. <code>sid</code>: 16–64 random chars, kept in memory only — never a device id. All fields: <a href="' + SNIP_REPO + '#mobile--desktop-apps" target="_blank" rel="noopener">README</a>.'
    };
    return {
      s1: 'Paste this once into the <code>&lt;head&gt;</code> of your site:',
      c1: snippetFor(domain), s2: '', c2: '',
      hint: 'Track goals &amp; properties from your code:<br><code>tacilytics(\'Signup\')</code> · <code>tacilytics(\'Signup\', { plan: \'pro\' })</code><br><span style="opacity:.7">Privacy flags on the tag: <code>data-honor-dnt</code> · <code>data-track-outbound</code> · <code>data-track-downloads</code></span>'
    };
  }
  function renderSnippet() {
    var d = $('snipDomain').textContent, p = snipParts(d, state.snipTab);
    $('snipStep1').innerHTML = p.s1;
    $('snippetCode').textContent = p.c1;
    $('snipStep2').innerHTML = p.s2;
    $('snippetCode2').textContent = p.c2;
    $('snippetCode2').classList.toggle('hide', !p.c2);
    $('copySnippet2').classList.toggle('hide', !p.c2);
    $('copySnippet').textContent = p.c2 ? 'Copy step 1' : 'Copy';
    $('snipHint').innerHTML = p.hint;
  }
  function showSnippet(domain) {
    $('snipDomain').textContent = domain;
    renderSnippet();
    $('snippetModal').classList.remove('hide');
  }
  function copyFrom(btnId, codeId, label) {
    navigator.clipboard.writeText($(codeId).textContent).then(function () {
      $(btnId).textContent = 'Copied'; setTimeout(function () { renderSnippet(); if (label) $(btnId).textContent = label; }, 1500);
    });
  }
  // ── CSV export of the current view ──
  $('exportBtn').onclick = function () {
    if (!lastStats) return;
    var s = lastStats, rows = [['metric', 'name', 'visitors', 'pageviews']];
    rows.push(['summary', 'visitors', s.totals.visitors, '']);
    rows.push(['summary', 'pageviews', '', s.totals.pageviews]);
    rows.push(['summary', 'bounce_rate', s.totals.bounce + '%', '']);
    rows.push(['summary', 'avg_visit_seconds', s.totals.duration == null ? '' : s.totals.duration, '']);
    [['page', s.pages], ['entry_page', s.entryPages], ['exit_page', s.exitPages], ['source', s.sources], ['medium', s.mediums], ['campaign', s.campaigns], ['country', s.countries], ['browser', s.browsers], ['os', s.os], ['device', s.devices], ['language', s.languages], ['goal', s.goals]].forEach(function (pair) {
      (pair[1] || []).forEach(function (r) { rows.push([pair[0], r.name, r.visitors, r.pageviews]); });
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tacilytics-' + state.site + '-' + state.period + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('snippetBtn').onclick = function () { if (state.site) showSnippet(state.site); };
  $('closeSnippet').onclick = function () { closeModal($('snippetModal')); };
  $('copySnippet').onclick = function () { copyFrom('copySnippet', 'snippetCode'); };
  $('copySnippet2').onclick = function () { copyFrom('copySnippet2', 'snippetCode2', 'Copy step 2'); };

  // ── live visitors (last 30 min) ──
  var liveTimer = null;
  function openLive() { if (!state.site || state.site === 'no sites yet') return; $('liveModal').classList.remove('hide'); fetchLive(); clearInterval(liveTimer); liveTimer = setInterval(fetchLive, 8000); }
  function closeLive() { closeModal($('liveModal')); }
  $('liveModal').addEventListener('taci:close', function () { clearInterval(liveTimer); liveTimer = null; }); // every exit stops polling
  function fetchLive() {
    if (document.hidden) return;
    api('/api/realtime?' + liveQuery()).then(function (r) {
      if (r.error) return;
      $('live-online').textContent = r.online;
      renderLivePlatforms(r.platforms || [], r.appOnline || 0);
      renderSpark(r.minutes);
      renderFeed(r.recent, r.now);
    }).catch(function () {});
  }
  // live = same segment filters as the dashboard (the period does not matter for the last minutes)
  function liveQuery() {
    var q = 'site=' + encodeURIComponent(state.site);
    if (SHARE) q += '&share=' + SHARE;
    Object.keys(state.filters).forEach(function (k) { if (k !== 'goal') q += '&' + k + '=' + encodeURIComponent(state.filters[k]); });
    return q;
  }
  // who is online per platform; only shown once an app reports, each entry is a switch for the filter
  function renderLivePlatforms(rows, appOnline) {
    var el = $('live-pf');
    var apps = rows.filter(function (r) { return r.name !== 'web'; });
    var cur = state.filters.platform || '';
    if (!apps.length && !cur) { el.classList.add('hide'); el.innerHTML = ''; return; }
    el.classList.remove('hide');
    var total = rows.reduce(function (a, r) { return a + r.visitors; }, 0);
    var items = [{ v: '', icon: ico('i-users', 'ui'), label: 'All', n: total }];
    if (apps.length > 1 || (apps.length && rows.some(function (r) { return r.name === 'web'; }))) items.push({ v: 'app', icon: platformIcon('app'), label: platformLabel('app'), n: appOnline });
    rows.forEach(function (r) { items.push({ v: r.name, icon: platformIcon(r.name), label: platformLabel(r.name), n: r.visitors }); });
    if (cur && !items.some(function (i) { return i.v === cur; })) items.push({ v: cur, icon: platformIcon(cur), label: platformLabel(cur), n: 0 });
    el.innerHTML = items.map(function (i) {
      return '<button type="button" class="lpf' + (i.v === cur ? ' active' : '') + '" data-pf="' + esc(i.v) + '" aria-pressed="' + (i.v === cur) + '">' + i.icon +
        '<span>' + esc(i.label) + '</span><b>' + i.n + '</b></button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('[data-pf]'), function (b) {
      b.onclick = function () {
        var v = b.getAttribute('data-pf');
        if (v) state.filters.platform = v; else delete state.filters.platform;
        delete state.filters.version; // an app version only makes sense inside its platform
        load(); fetchLive();
      };
    });
  }
  function renderSpark(minutes) {
    var svg = $('live-spark'), W = 600, H = 70, n = minutes.length;
    var max = Math.max.apply(null, minutes.map(function (m) { return m.pageviews; }).concat([1]));
    var bw = W / n;
    svg.innerHTML = minutes.map(function (m, i) {
      var h = m.pageviews ? Math.max(3, Math.round((m.pageviews / max) * (H - 6))) : 0;
      return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - h) + '" width="' + (bw - 2).toFixed(1) + '" height="' + h + '" rx="2" fill="' + (i >= n - 5 ? COL.v : COL.line) + '"></rect>';
    }).join('');
  }
  function timeAgo(ts, now) {
    var s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 8) return 'just now';
    if (s < 60) return s + 's ago';
    return Math.round(s / 60) + 'm ago';
  }
  function renderFeed(recent, now) {
    var el = $('live-feed');
    if (!recent || !recent.length) { el.innerHTML = '<div class="empty">No visitors in the last 30 minutes</div>'; return; }
    el.innerHTML = recent.map(function (e) {
      var loc = e.country ? flagIcon(e.country) : ico('i-globe', 'ui');
      var what = e.name ? '<span class="goal">' + ico('i-goal', 'ui') + ' ' + esc(e.name) + '</span>' : '<span class="path">' + esc(e.path) + '</span>';
      var src = (e.source && e.source !== 'Direct') ? 'via ' + e.source : '';
      var meta = [e.platform ? platformLabel(e.platform) : e.browser, e.device, src].filter(Boolean).map(esc).join(' · ');
      return '<div class="feed-row"><span class="fl" title="' + esc(e.country || e.tz || '') + '">' + loc + '</span>' +
        '<div class="fw">' + what + '<span class="fm">' + meta + '</span></div>' +
        '<span class="ft">' + timeAgo(e.ts, now) + '</span></div>';
    }).join('');
  }
  $('realtimeBtn').onclick = openLive;
  $('closeLive').onclick = closeLive;

  // ── periods ──
  Array.prototype.forEach.call(document.querySelectorAll('#periods button'), function (b) {
    b.onclick = function () {
      document.querySelectorAll('#periods button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active'); state.period = b.dataset.p;
      state.from = ''; state.to = ''; $('fromDate').value = ''; $('toDate').value = ''; // clear custom range
      load();
    };
  });

  // ── custom date range ──
  $('applyRange').onclick = function () {
    var f = $('fromDate').value, t = $('toDate').value;
    if (!f || !t) return;
    if (f > t) { var tmp = f; f = t; t = tmp; $('fromDate').value = f; $('toDate').value = t; }
    state.from = f; state.to = t;
    document.querySelectorAll('#periods button').forEach(function (x) { x.classList.remove('active'); });
    load();
  };

  // ── panel tabs (Pages + Sources) ──
  function wireTabs(id, key, rerender) {
    Array.prototype.forEach.call(document.querySelectorAll('#' + id + ' button'), function (b) {
      b.onclick = function () {
        document.querySelectorAll('#' + id + ' button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active'); state[key] = b.dataset.t; rerender();
      };
    });
  }
  wireTabs('pageTabs', 'pageTab', renderPagesPanel);
  wireTabs('srcTabs', 'srcTab', renderSourcesPanel);
  wireTabs('searchTabs', 'searchTab', function () { renderSearch(); });
  wireTabs('pfTabs', 'pfTab', function () { renderPlatformsPanel(); });
  wireTabs('snipTabs', 'snipTab', renderSnippet);

  // ── rendering ──
  function fmt(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n); }
  function trend(id, p) {
    var el = $(id);
    if (p == null) { el.textContent = ''; el.className = 'trend'; return; }
    var up = p >= 0;
    el.textContent = (up ? '↑ ' : '↓ ') + Math.abs(p) + '%';
    el.className = 'trend ' + (up ? 'up' : 'down');
  }

  function bars(elId, rows, opts) {
    opts = opts || {};
    var el = $(elId);
    if (!rows || !rows.length) { el.innerHTML = '<div class="empty">No data yet</div>'; return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.visitors || 0; })) || 1;
    var fk = opts.filterKey; // when set, clicking a row drills into that segment
    el.innerHTML = rows.map(function (r) {
      var label = opts.label ? opts.label(r) : (r.name || '—');
      var w = Math.max(3, Math.round(((r.visitors || 0) / max) * 100));
      var val = opts.value ? opts.value(r) : r.name;
      var clickable = fk && val && val !== 'Direct';
      var cr = opts.cr && r.cr != null ? '<span class="cr">' + r.cr + '%</span>' : '';
      return '<div class="bar' + (clickable ? ' clickable' : '') + '"' + (clickable ? ' data-fk="' + esc(fk) + '" data-fv="' + esc(val) + '"' : '') + ' title="' + esc(label) + '">' +
        '<div class="fill" style="width:' + w + '%"></div>' +
        '<span class="name">' + (opts.icon ? opts.icon(r) : '') + '<span class="txt">' + esc(label) + '</span></span><span class="val">' + fmt(r.visitors) + cr + '</span></div>';
    }).join('');
    if (fk) Array.prototype.forEach.call(el.querySelectorAll('.bar.clickable'), function (b) {
      b.onclick = function () { setFilter(b.getAttribute('data-fk'), b.getAttribute('data-fv')); };
    });
  }

  // seconds → "1m 23s" / "45s"
  function fmtDur(s) {
    if (s == null) return '—';
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    return m + 'm' + (r ? ' ' + r + 's' : '');
  }

  // ── segmentation filter chips ──
  function renderFilters() {
    var el = $('filters');
    var keys = Object.keys(state.filters);
    if (!keys.length) { el.classList.add('hide'); el.innerHTML = ''; return; }
    el.classList.remove('hide');
    var chips = keys.map(function (k) {
      var v = state.filters[k];
      var disp = k === 'country' ? (flagIcon(v) + ' ' + esc(own(NAMES, v) || v)) : k === 'platform' ? (platformIcon(v) + ' ' + esc(platformLabel(v))) : esc(v);
      return '<span class="chip"><span class="k">' + esc(own(FILTER_LABELS, k) || k) + '</span>' + disp +
        '<button data-rm="' + esc(k) + '" title="Remove" aria-label="Remove filter">' + ico('i-x', 'ui') + '</button></span>';
    }).join('');
    el.innerHTML = '<span class="flabel">Filtered by</span>' + chips + '<span class="chip clear" id="clearFilters">Clear all</span>';
    Array.prototype.forEach.call(el.querySelectorAll('[data-rm]'), function (b) { b.onclick = function () { removeFilter(b.getAttribute('data-rm')); }; });
    var ce = $('clearFilters'); if (ce) ce.onclick = clearFilters;
  }

  // Smooth line through points (Catmull-Rom → cubic Bézier), clamped so it never dips below the baseline.
  function smoothPath(pts, floorY) {
    if (!pts.length) return '';
    if (pts.length < 3) return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = Math.min(floorY, p1[1] + (p2[1] - p0[1]) / 6);
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = Math.min(floorY, p2[1] - (p3[1] - p1[1]) / 6);
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d;
  }
  // Mini sparkline at the bottom of a KPI card.
  function sparkline(cardValueId, values, color) {
    var card = $(cardValueId) && $(cardValueId).parentNode; if (!card) return;
    var old = card.querySelector('svg.spark'); if (old) old.remove();
    if (!values || values.length < 2) return;
    var W = 200, H = 38, mx = Math.max.apply(null, values) || 1;
    var pts = values.map(function (v, i) { return [(i * W) / (values.length - 1), H - 3 - (v / mx) * (H - 8)]; });
    var line = smoothPath(pts, H - 1);
    var gid = 'sg-' + cardValueId;
    var svg = '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity=".28"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="url(#' + gid + ')"/>' +
      '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity=".9"/></svg>';
    card.insertAdjacentHTML('beforeend', svg);
  }
  // ── chart annotations: a thin coral line + diamond per annotated day (daily views only) ──
  function annotationsFor(d) {
    var list = (lastStats && lastStats.annotations) || [];
    return d && d.day ? list.filter(function (a) { return a.day === d.day; }) : [];
  }
  function annotationMarks(series, x, H) {
    var list = (lastStats && lastStats.annotations) || [];
    if (!list.length) return '';
    var out = '';
    series.forEach(function (d, i) {
      if (!annotationsFor(d).length) return;
      var cx = x(i).toFixed(1);
      out += '<line x1="' + cx + '" x2="' + cx + '" y1="14" y2="' + H + '" stroke="var(--accent-2, #ff7a5c)" stroke-width="1.2" stroke-dasharray="3 4" opacity=".75" vector-effect="non-scaling-stroke"/>' +
        '<path d="M' + cx + ' 3 l5 6 l-5 6 l-5 -6 z" fill="var(--accent-2, #ff7a5c)"/>';
    });
    return out;
  }
  function drawChart(series) {
    var svg = $('chart'); var W = 800, H = 220, pad = 8;
    var showV = state.show.visitors, showP = state.show.pageviews;
    // Only visible series define the scale — otherwise hiding a line would not zoom in.
    var max = Math.max(1, Math.max.apply(null, series.map(function (d) {
      return Math.max(showV ? d.visitors : 0, showP ? d.pageviews : 0);
    })));
    var n = series.length;
    var x = function (i) { return pad + (i * (W - 2 * pad)) / Math.max(1, n - 1); };
    var y = function (v) { return H - pad - (v / max) * (H - 2 * pad); };
    function path(key) { return smoothPath(series.map(function (d, i) { return [x(i), y(d[key])]; }), H - pad); }
    var areaP = path('visitors') + ' L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' L' + x(0).toFixed(1) + ' ' + (H - pad) + ' Z';
    var hovers = series.map(function (d, i) {
      var w = (W - 2 * pad) / Math.max(1, n);
      return '<rect x="' + (x(i) - w / 2).toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + H + '" fill="transparent" ' +
        'data-i="' + i + '"></rect>';
    }).join('');
    svg.innerHTML =
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + COL.v + '" stop-opacity="0.32"/><stop offset="100%" stop-color="' + COL.v + '" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      [0.25, 0.5, 0.75].map(function (f) { var gy = (pad + f * (H - 2 * pad)).toFixed(1); return '<line x1="0" x2="' + W + '" y1="' + gy + '" y2="' + gy + '" stroke="' + COL.grid + '" stroke-dasharray="2 6" vector-effect="non-scaling-stroke"/>'; }).join('') +
      (showV ? '<path d="' + areaP + '" fill="url(#ag)"/>' : '') +
      (showP ? '<path d="' + path('pageviews') + '" fill="none" stroke="' + COL.p + '" stroke-width="1.6" stroke-dasharray="4 4" opacity="0.85"/>' : '') +
      (showV ? '<path d="' + path('visitors') + '" fill="none" stroke="' + COL.v + '" stroke-width="2.4" stroke-linecap="round"/>' : '') +
      (showV && n <= 40 ? series.map(function (d, i) { return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d.visitors).toFixed(1) + '" r="2.4" fill="' + COL.v + '" stroke="' + COL.bg + '" stroke-width="1.5"/>'; }).join('') : '') +
      annotationMarks(series, x, H) +
      hovers;
    var tip = $('tip');
    Array.prototype.forEach.call(svg.querySelectorAll('rect'), function (rect) {
      rect.addEventListener('mousemove', function (e) {
        var d = series[+rect.dataset.i];
        var notes = annotationsFor(d);
        tip.innerHTML = '<strong>' + esc(d.label) + '</strong>' +
          (showV ? '<br>' + d.visitors + ' visitors' : '') +
          (showP ? '<br>' + d.pageviews + ' views' : '') +
          notes.map(function (a) { return '<br><span class="tip-note" data-no-i18n>◆ ' + esc(a.text) + '</span>'; }).join('');
        tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 10) + 'px'; tip.style.opacity = 1;
      });
      rect.addEventListener('mouseleave', function () { tip.style.opacity = 0; });
    });
  }

  // ── import history (Plausible / GA4) ──
  var impSrc = 'plausible';
  var IMP_HOWTO = {
    plausible: 'In Plausible: <strong>Site settings → Imports &amp; Exports → Export data</strong>. Upload the ZIP you get (or the CSV files in it).',
    ga: 'In Google Analytics 4: open a report (e.g. <strong>Pages and screens</strong>, <strong>Traffic acquisition</strong>, <strong>Demographic details</strong>), add <strong>Date</strong> as a secondary dimension, then <strong>Share → Download file → CSV</strong>. One file per report; pick several at once.',
  };
  function openImport() {
    $('importModal').classList.remove('hide'); $('impErr').textContent = ''; $('impStatus').textContent = ''; $('impSite').textContent = state.site;
    setImpSrc(impSrc); loadImports();
  }
  function setImpSrc(src) {
    impSrc = src;
    Array.prototype.forEach.call($('impTabs').children, function (b) { b.classList.toggle('active', b.dataset.src === src); });
    $('impHowto').innerHTML = IMP_HOWTO[src];
  }
  function loadImports() {
    api('/api/imports?site=' + encodeURIComponent(state.site)).then(function (r) {
      if (r.error) return;
      $('impList').innerHTML = r.imports.length ? '<div class="set-card"><h3>Imported</h3>' + r.imports.map(function (i) {
        return '<div class="set-row"><span><strong>' + (i.source === 'ga' ? 'Google Analytics' : 'Plausible') + '</strong> ' + esc(i.first_day || '?') + ' – ' + esc(i.last_day || '?') +
          ' <span class="muted small">· ' + Number(i.pageviews).toLocaleString() + ' views' + (i.created_by ? ' · by ' + esc(i.created_by) : '') + '</span></span>' +
          '<button class="btn ghost danger mini" data-delimp="' + i.id + '">Remove</button></div>';
      }).join('') + (r.countsUntil ? '<p class="muted small" style="margin:8px 0 0">Own data starts ' + esc(r.countsUntil) + '; imported days from then on are ignored.</p>' : '') + '</div>' : '';
      $('impList').querySelectorAll('[data-delimp]').forEach(function (b) {
        b.onclick = function () { if (confirm('Remove this import? The imported numbers disappear from all charts.')) api('/api/imports/' + b.dataset.delimp, { method: 'DELETE' }).then(function () { loadImports(); load(); }); };
      });
    });
  }
  $('importBtn').onclick = openImport;
  $('closeImport').onclick = function () { closeModal($('importModal')); };
  $('impTabs').onclick = function (e) { var b = e.target.closest('button'); if (b) setImpSrc(b.dataset.src); };
  $('impGo').onclick = function () {
    var files = Array.prototype.slice.call($('impFile').files || []);
    $('impErr').textContent = '';
    if (!files.length) { $('impErr').textContent = 'Choose a file first'; return; }
    var done = 0, views = 0;
    $('impStatus').textContent = 'Uploading…';
    // one request per file: each file becomes its own import (and can be removed on its own)
    files.reduce(function (p, f) {
      return p.then(function () {
        return fetch('/api/imports?site=' + encodeURIComponent(state.site) + '&source=' + impSrc + '&name=' + encodeURIComponent(f.name), {
          method: 'POST', headers: { 'x-session-token': localStorage.getItem('nyx_token') || '', 'Content-Type': /\.zip$/i.test(f.name) ? 'application/zip' : 'text/csv' }, body: f,
        }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(f.name + ': ' + (j.error || r.status)); done++; views += j.pageviews || 0; if (j.note) $('impStatus').textContent = j.note; }); });
      });
    }, Promise.resolve()).then(function () {
      $('impStatus').textContent = done + ' file' + (done > 1 ? 's' : '') + ' imported (' + views.toLocaleString() + ' views). ' + ($('impStatus').textContent.indexOf('Days from') === 0 ? $('impStatus').textContent : '');
      $('impFile').value = ''; loadImports(); load();
    }).catch(function (e) { $('impErr').textContent = e.message; $('impStatus').textContent = ''; loadImports(); load(); });
  };

  // ── alerts ──
  var KIND_LABEL = { spike: 'Traffic spike', drop: 'Traffic drop', goal: 'Goal' };
  function openAlerts() {
    // a fresh form only when the modal opens — openAlerts also re-renders the list while it is open
    if ($('alertsModal').classList.contains('hide')) { $('alKind').value = 'spike'; $('alGoalRow').classList.add('hide'); $('alGoal').value = ''; $('alThreshold').value = '10'; $('alWindow').value = '24'; $('alWebhook').value = ''; }
    $('alertsModal').classList.remove('hide'); $('alertsErr').textContent = ''; $('alertsSite').textContent = state.site;
    var goals = ((lastStats && lastStats.goals) || []).map(function (g) { return g.name; });
    $('alGoalList').innerHTML = goals.map(function (g) { return '<option value="' + esc(g) + '">'; }).join('');
    api('/api/alerts?site=' + encodeURIComponent(state.site)).then(function (r) {
      if (r.error) { $('alertsErr').textContent = r.error; return; }
      $('alHint').textContent = r.fallbackWebhook ? 'Leave the webhook empty to use the server default (DIGEST_WEBHOOK_URL).' : 'Discord: channel settings → Integrations → Webhooks → Copy URL.';
      $('alWebhook').placeholder = r.fallbackWebhook ? 'Webhook URL (optional — server default)' : 'Webhook URL (https://…)';
      $('alertsList').innerHTML = r.alerts.length ? '<div class="set-card">' + r.alerts.map(function (a) {
        var what = a.kind === 'goal' ? a.threshold + '× <span data-no-i18n>' + esc(a.goal) + '</span> in ' + (a.window_hours === 1 ? '1 h' : a.window_hours === 24 ? '24 h' : '7 days') : KIND_LABEL[a.kind];
        return '<div class="set-row"><span>' + ico(a.kind === 'goal' ? 'i-goal' : a.kind === 'drop' ? 'i-down' : 'i-up', 'ui') + '<strong>' + what + '</strong>' +
          ' <span class="muted small">→ ' + (a.webhook ? '<span data-no-i18n>' + esc(a.webhook) + '</span>' : 'server default') + (a.last_fired ? ' · last sent ' + new Date(a.last_fired).toLocaleString() : '') + '</span></span>' +
          '<label class="small muted" style="display:inline-flex;gap:5px;align-items:center"><input type="checkbox" data-al-on="' + a.id + '"' + (a.enabled ? ' checked' : '') + ' style="width:auto;margin:0"> on</label>' +
          '<button class="btn ghost mini" data-al-test="' + a.id + '">Test</button>' +
          '<button class="btn ghost danger mini" data-al-del="' + a.id + '">Remove</button></div>';
      }).join('') + '</div>' : '<p class="muted small">No alerts for this site yet.</p>';
      var L = $('alertsList');
      L.querySelectorAll('[data-al-on]').forEach(function (c) { c.onchange = function () { api('/api/alerts/' + c.dataset.alOn, { method: 'PATCH', body: JSON.stringify({ enabled: c.checked }) }); }; });
      L.querySelectorAll('[data-al-del]').forEach(function (b) { b.onclick = function () { api('/api/alerts/' + b.dataset.alDel, { method: 'DELETE' }).then(openAlerts); }; });
      L.querySelectorAll('[data-al-test]').forEach(function (b) {
        b.onclick = function () {
          b.textContent = 'Sending…';
          api('/api/alerts/' + b.dataset.alTest + '/test', { method: 'POST' }).then(function (r) { b.textContent = r.error ? 'Failed' : 'Sent ✓'; if (r.error) $('alertsErr').textContent = r.error; });
        };
      });
    });
  }
  $('alertsBtn').onclick = openAlerts;
  $('closeAlerts').onclick = function () { closeModal($('alertsModal'), { force: true }); };
  $('alKind').onchange = function () { $('alGoalRow').classList.toggle('hide', this.value !== 'goal'); };
  $('alAdd').onclick = function () {
    $('alertsErr').textContent = '';
    var body = { site: state.site, kind: $('alKind').value, webhook: $('alWebhook').value.trim() || undefined };
    if (body.kind === 'goal') { body.goal = $('alGoal').value.trim(); body.threshold = Number($('alThreshold').value); body.window_hours = Number($('alWindow').value); }
    api('/api/alerts', { method: 'POST', body: JSON.stringify(body) }).then(function (r) {
      if (r.error) { $('alertsErr').textContent = r.error; return; }
      $('alWebhook').value = ''; window.TaciModal.snapshot($('alertsModal')); openAlerts();
    });
  };

  // ── add / list annotations ──
  function openAnnotations() {
    $('annModal').classList.remove('hide'); $('annErr').textContent = '';
    $('annDay').value = localToday(); $('annText').value = ''; $('annText').focus(); window.TaciModal.snapshot($('annModal')); // also when re-opened after a save
    api('/api/annotations?site=' + encodeURIComponent(state.site)).then(function (list) {
      $('annList').innerHTML = (list || []).length ? list.map(function (a) {
        return '<div class="set-row"><span><strong>' + esc(a.day) + '</strong> <span data-no-i18n>' + esc(a.text) + '</span>' + (a.created_by ? ' <span class="muted small">· ' + esc(a.created_by) + '</span>' : '') + '</span>' +
          '<button class="btn ghost danger mini" data-delann="' + a.id + '">Remove</button></div>';
      }).join('') : '<p class="muted small">No notes yet.</p>';
      $('annList').querySelectorAll('[data-delann]').forEach(function (b) {
        b.onclick = function () { api('/api/annotations/' + b.dataset.delann, { method: 'DELETE' }).then(function () { openAnnotations(); load(); }); };
      });
    });
  }
  $('annBtn').onclick = openAnnotations;
  $('closeAnn').onclick = function () { closeModal($('annModal'), { force: true }); };
  $('saveAnn').onclick = function () {
    api('/api/annotations', { method: 'POST', body: JSON.stringify({ site: state.site, day: $('annDay').value, text: $('annText').value }) }).then(function (r) {
      if (r.error) { $('annErr').textContent = r.error; return; }
      openAnnotations(); load();
    });
  };
  $('annText').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('saveAnn').click(); });

  // ── tab-aware panels (Pages: Top/Entry/Exit · Sources: Source/Medium/Campaign) ──
  function renderPagesPanel() {
    var s = lastStats; if (!s) return;
    bars('p-pages', s[state.pageTab] || s.pages, { filterKey: 'page', label: function (r) { return r.name; } });
  }
  // readable names for app/short referrers — the raw host stays in the data and the tooltip
  var SOURCE_NAMES = {
    'com.google.android.googlequicksearchbox': 'Google App (Android)', 'com.google.android.gm': 'Gmail App',
    'fb': 'Facebook', 'm.facebook.com': 'Facebook (mobile)', 'l.facebook.com': 'Facebook', 'lm.facebook.com': 'Facebook',
    'ig': 'Instagram', 'l.instagram.com': 'Instagram', 'homescreen': 'Homescreen (app shortcut)',
    'android-app://com.google.android.googlequicksearchbox': 'Google App (Android)', 't.co': 'X / Twitter',
  };
  var PLATFORM_NAMES = { web: 'Web', app: 'All apps', android: 'Android app', ios: 'iOS app', macos: 'macOS app', windows: 'Windows app', linux: 'Linux app' };
  function platformIcon(n) { return n === 'web' ? ico('i-web', 'ui') : n === 'app' ? ico('i-smartphone', 'ui') : n === 'windows' ? ico('i-desktop', 'ui') : brand(own(PLATFORM_ICON, n), 'i-mobile'); }
  function platformLabel(n) { return own(PLATFORM_NAMES, n) || n; }
  state.pfTab = 'platforms';
  function renderPlatformsPanel() {
    var s = lastStats; if (!s) return;
    var w = $('w-platforms');
    // only interesting once an app reports — a site that is web-only keeps its old layout
    var hasApp = (s.platforms || []).some(function (r) { return r.name !== 'web'; }) || state.filters.platform;
    if (!hasApp) { w.classList.add('hide'); return; }
    w.classList.remove('hide');
    if (state.pfTab === 'appVersions') bars('p-platforms', s.appVersions || [], { filterKey: 'version', icon: function () { return ico('i-layers', 'ui'); }, label: function (r) { return 'v' + r.name; } });
    else {
      // "All apps" row on top once more than one kind of visitor reports (web + app, or several apps)
      var pfRows = s.platforms || [];
      var appRows = pfRows.filter(function (r) { return r.name !== 'web'; });
      if (!state.filters.platform && s.appVisitors && pfRows.length > 1 && appRows.length) pfRows = [{ name: 'app', visitors: s.appVisitors }].concat(pfRows);
      bars('p-platforms', pfRows, { filterKey: 'platform', icon: function (r) { return platformIcon(r.name); }, label: function (r) { return platformLabel(r.name); } });
    }
  }
  function sourceLabel(n) { if (n === 'Direct') return 'Direct / none'; var nice = own(SOURCE_NAMES, n); return nice ? nice + ' · ' + n : n; }
  function renderSourcesPanel() {
    var s = lastStats; if (!s) return;
    var tab = state.srcTab, fk = tab === 'mediums' ? 'medium' : tab === 'campaigns' ? 'campaign' : 'source';
    bars('p-sources', s[tab] || [], { filterKey: fk, icon: function (r) { if (tab !== 'sources') return ico(tab === 'campaigns' ? 'i-sparkles' : 'i-sources', 'ui'); if (r.name === 'Direct') return ico('i-direct', 'ui'); if (r.name === 'homescreen') return ico('i-mobile', 'ui'); return brand(sourceBrand(r.name), 'i-sources'); }, label: function (r) { return tab === 'sources' ? sourceLabel(r.name) : r.name; } });
    var el = $('p-sources');
    if (tab === 'sources' && s.paymentReturns && s.paymentReturns.length) {
      var n = s.paymentReturns.reduce(function (a, r) { return a + (r.visitors || 0); }, 0);
      var who = s.paymentReturns.map(function (r) { return r.name; }).join(', ');
      el.insertAdjacentHTML('beforeend', '<p class="pay-note" title="' + esc(who) + '">' + ico('i-pay', 'ui') + ' ' + fmt(n) + ' returning from payment (' + esc(who) + ') — not counted as a source</p>');
    }
  }

  function money(v, cur) {
    try { return new Intl.NumberFormat(navigator.language || 'de-DE', { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v); }
    catch (e) { return (Math.round(v * 100) / 100) + ' ' + (cur || ''); }
  }
  function pctTxt(p) { return p == null ? '—' : (p >= 0 ? '↑ ' : '↓ ') + Math.abs(p) + '%'; }
  function pctCls(p) { return p == null ? '' : (p >= 0 ? 'up' : 'down'); }

  // previous-period trend already sits in the stat cards; last year only appears once data reaches back that far
  function renderCompare(s) {
    ['visitors', 'pageviews'].forEach(function (k) {
      var el = $('y-' + k); if (!el) return;
      if (!s.yoy || s.yoy[k] == null) { el.classList.add('hide'); el.textContent = ''; return; }
      el.classList.remove('hide');
      el.className = 'yoy ' + pctCls(s.yoy[k]);
      el.textContent = pctTxt(s.yoy[k]) + ' vs last year';
    });
  }

  function renderInsights(s) {
    renderCompare(s);
    // commerce cards + revenue by source
    var c = s.commerce, cw = $('commerce');
    if (c) {
      cw.classList.remove('hide');
      $('c-revenue').textContent = money(c.revenue);
      $('c-orders').textContent = fmt(c.orders);
      $('c-aov').textContent = money(c.aov);
      $('c-cr').textContent = c.cr + '%';
      trend('tc-revenue', c.trend && c.trend.revenue);
      trend('tc-orders', c.trend && c.trend.orders);
      $('w-revsrc').classList.remove('hide');
      var pfs = c.byPlatform || [];
      if (pfs.some(function (r) { return r.name !== 'web'; })) {
        $('w-revpf').classList.remove('hide');
        var maxP = Math.max.apply(null, pfs.map(function (r) { return r.revenue; }).concat([1]));
        $('p-revpf').innerHTML = pfs.map(function (r) {
          var w = Math.max(3, Math.round((r.revenue / maxP) * 100));
          return '<div class="bar clickable" data-fk="platform" data-fv="' + esc(r.name) + '"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(platformLabel(r.name)) + '</span><span class="val">' + money(r.revenue) + '<span class="cr">' + r.orders + '×</span></span></div>';
        }).join('');
        Array.prototype.forEach.call($('p-revpf').querySelectorAll('.bar.clickable'), function (b) { b.onclick = function () { setFilter('platform', b.getAttribute('data-fv')); }; });
      } else $('w-revpf').classList.add('hide');
      var maxR = Math.max.apply(null, c.bySource.map(function (r) { return r.revenue; }).concat([1]));
      $('p-revsrc').innerHTML = c.bySource.map(function (r) {
        var w = Math.max(3, Math.round((r.revenue / maxR) * 100));
        return '<div class="bar" title="' + esc(r.name) + '"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(sourceLabel(r.name)) + '</span><span class="val">' + money(r.revenue) + '<span class="cr">' + r.orders + '×</span></span></div>';
      }).join('') || '<div class="empty">No data yet</div>';
    } else { cw.classList.add('hide'); $('w-revsrc').classList.add('hide'); $('w-revpf').classList.add('hide'); }
    // site search
    if (s.search) {
      $('w-search').classList.remove('hide');
      $('searchMeta').textContent = fmt(s.search.total) + ' searches · ' + s.search.zeroShare + '% without results';
      renderSearch();
    } else $('w-search').classList.add('hide');
    // 404
    if (s.notFound && s.notFound.length) {
      $('w-404').classList.remove('hide');
      bars('p-404', s.notFound, { label: function (r) { return r.name + (r.fromPage ? '  ← ' + r.fromPage : ''); } });
    } else $('w-404').classList.add('hide');
    // scroll depth
    if (s.scrollPages && s.scrollPages.length) {
      $('w-scroll').classList.remove('hide');
      $('p-scroll').innerHTML = s.scrollPages.map(function (r) {
        return '<div class="bar" title="' + esc(r.name) + ' — ' + r.pageviews + ' measured views"><div class="fill" style="width:' + Math.max(3, r.avg) + '%"></div><span class="name">' + esc(r.name) + '</span><span class="val">' + r.avg + '%<span class="cr">' + r.deep + '% deep</span></span></div>';
      }).join('');
    } else $('w-scroll').classList.add('hide');
  }
  state.searchTab = 'top';
  function renderSearch() {
    var s = lastStats; if (!s || !s.search) return;
    var rows = s.search[state.searchTab] || [];
    bars('p-search', rows, { label: function (r) { return '“' + r.name + '”' + (state.searchTab === 'top' && r.zero ? '  · ' + r.zero + '× no results' : ''); } });
  }
  function renderProps(s) {
    var wrap = $('propsWrap');
    if (!s.properties || !s.properties.length) { wrap.classList.add('hide'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hide');
    wrap.innerHTML = s.properties.map(function (p) {
      var rows = p.values.map(function (v) {
        var max = Math.max.apply(null, p.values.map(function (x) { return x.visitors || 0; })) || 1;
        var w = Math.max(3, Math.round(((v.visitors || 0) / max) * 100));
        return '<div class="bar"><div class="fill" style="width:' + w + '%"></div><span class="name">' + esc(v.name) + '</span><span class="val">' + fmt(v.visitors) + '</span></div>';
      }).join('');
      return '<div class="card panel"><h3>' + ico('i-goal', 'h') + ' ' + esc(p.key) + '</h3><div class="bars">' + rows + '</div></div>';
    }).join('');
  }

  function load() {
    var emptyMetrics = ['s-visitors', 's-pageviews', 's-bounce', 's-vpv', 's-dur'];
    var emptyPanels = ['p-pages', 'p-sources', 'p-countries', 'p-browsers', 'p-os', 'p-devices', 'p-goals', 'p-languages'];
    if (!state.site || state.site === 'no sites yet') {
      emptyMetrics.forEach(function (id) { $(id).textContent = '—'; });
      emptyPanels.forEach(function (id) { $(id).innerHTML = '<div class="empty">Add a site to begin</div>'; });
      $('chart').innerHTML = '';
      return;
    }
    renderFilters();
    api('/api/stats?' + statsQuery()).then(function (s) {
      if (s.error) return;
      lastStats = s;
      var imn = $('importedNote');
      if (s.imported && s.imported.included) { imn.textContent = 'Includes imported history' + (s.imported.until ? ' (until ' + s.imported.until + ')' : '') + '.'; imn.title = 'Visitors on imported days are summed per day, not unique across days.'; imn.classList.remove('hide'); }
      else if (s.imported && s.imported.excludedByFilter) { imn.textContent = 'Imported history is hidden while a filter is active.'; imn.classList.remove('hide'); }
      else imn.classList.add('hide');
      $('s-visitors').textContent = fmt(s.totals.visitors);
      $('s-pageviews').textContent = fmt(s.totals.pageviews);
      $('s-bounce').textContent = s.totals.bounce + '%';
      $('s-vpv').textContent = s.totals.viewsPerVisitor;
      $('s-dur').textContent = fmtDur(s.totals.duration);
      $('realtime').textContent = s.realtime;
      trend('t-visitors', s.trend && s.trend.visitors);
      trend('t-pageviews', s.trend && s.trend.pageviews);
      drawChart(s.series);
      sparkline('s-visitors', (s.series || []).map(function (d) { return d.visitors; }), COL.v);
      sparkline('s-pageviews', (s.series || []).map(function (d) { return d.pageviews; }), COL.p);
      renderPagesPanel();
      renderSourcesPanel();
      bars('p-countries', s.countries, { filterKey: 'country', icon: function (r) { return flagIcon(r.name); }, label: function (r) { return own(NAMES, r.name) || r.name; } });
      bars('p-browsers', s.browsers, { filterKey: 'browser', icon: function (r) { return r.name === 'App' ? ico('i-mobile', 'ui') : r.name === 'Edge' ? ico('i-browser', 'ui') : brand(own(BROWSER_ICON, r.name), 'i-browser'); } });
      bars('p-os', s.os, { filterKey: 'os', icon: function (r) { return r.name === 'Windows' ? ico('i-desktop', 'ui') : brand(own(OS_ICON, r.name), 'i-os'); } });
      bars('p-devices', s.devices, { filterKey: 'device', icon: function (r) { return ico(r.name === 'Desktop' ? 'i-desktop' : r.name === 'Tablet' ? 'i-tablet' : 'i-mobile', 'ui'); } });
      renderPlatformsPanel();
      bars('p-languages', s.languages, { filterKey: 'lang' });
      bars('p-goals', s.goals, { filterKey: 'goal', cr: true, icon: function (r) { return ico(r.name === 'Purchase' ? 'i-cart' : r.name === 'Search' ? 'i-search' : r.name === '404' ? 'i-404' : 'i-goal', 'ui'); }, label: function (r) { return r.name; } });
      renderProps(s);
      renderInsights(s);
      loadJourneys();
      loadFunnels();
    });
  }

  // ── series toggle (click legend) ──
  function syncLegend() {
    ['visitors', 'pageviews'].forEach(function (k) {
      var b = $('leg-' + k);
      if (b) b.setAttribute('aria-pressed', state.show[k] ? 'true' : 'false');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.leg'), function (btn) {
    btn.addEventListener('click', function () {
      var k = btn.dataset.key, other = k === 'visitors' ? 'pageviews' : 'visitors';
      // Turning off the last visible line would empty the chart → flip instead of blanking.
      if (state.show[k] && !state.show[other]) { state.show[k] = false; state.show[other] = true; }
      else { state.show[k] = !state.show[k]; }
      localStorage.setItem('nyx_show', JSON.stringify(state.show));
      syncLegend();
      if (lastStats && lastStats.series) drawChart(lastStats.series);
    });
  });

  // ── visitor journeys: hand-rolled sankey (no lib) ──
  function loadJourneys() {
    if (!state.site) return;
    var q = statsQuery();
    api('/api/journeys?' + q).then(function (j) {
      if (j.error || !j.links) return;
      drawSankey(j);
      $('journeyMeta').textContent = '· ' + fmt(j.sessions) + ' sessions, top paths, 30-min session window';
    }).catch(function (e) { if (window.console) console.error('journeys:', e); });
  }
  function drawSankey(j) {
    var svg = $('journey');
    svg.innerHTML = '';
    if (!j.links.length) { svg.innerHTML = '<text x="20" y="40" fill="#888" font-size="13">Not enough data yet</text>'; return; }
    var W = Math.max(svg.clientWidth || 760, 640), H = 340, PAD = 24, colW = 150;
    var depths = j.maxDepth;
    var colX = function (d) { return PAD + d * ((W - 2 * PAD - colW) / Math.max(1, depths - 1)); };
    // node totals per column: sum of outgoing (or incoming for last col)
    var nodes = {}; // "d|path" → {in,out}
    j.links.forEach(function (l) {
      var a = nodes[l.depth + '|' + l.from] = nodes[l.depth + '|' + l.from] || { v: 0 };
      a.v += l.count;
      var b = nodes[(l.depth + 1) + '|' + l.to] = nodes[(l.depth + 1) + '|' + l.to] || { v: 0 };
      b.v = Math.max(b.v, 0) + l.count;
    });
    // layout: stack nodes per column by size
    var cols = {};
    Object.keys(nodes).forEach(function (k) {
      var d = +k.split('|')[0];
      (cols[d] = cols[d] || []).push({ key: k, path: k.slice(k.indexOf('|') + 1), v: nodes[k].v });
    });
    var maxTotal = 0;
    Object.keys(cols).forEach(function (d) {
      cols[d].sort(function (a, b) { return b.v - a.v; });
      var t = cols[d].reduce(function (s, n) { return s + n.v; }, 0);
      if (t > maxTotal) maxTotal = t;
    });
    var scale = (H - 2 * PAD - 40) / Math.max(1, maxTotal);
    var pos = {}; // key → {x,y,h}
    Object.keys(cols).forEach(function (d) {
      var y = PAD;
      cols[d].forEach(function (n) {
        var h = Math.max(4, n.v * scale);
        pos[n.key] = { x: colX(+d), y: y, h: h, v: n.v, path: n.path };
        y += h + 10;
      });
    });
    var ns = 'http://www.w3.org/2000/svg';
    var used = {}; // per-node offsets so ribbons stack instead of overlap
    j.links.forEach(function (l) {
      var a = pos[l.depth + '|' + l.from], b = pos[(l.depth + 1) + '|' + l.to];
      if (!a || !b) return;
      var h = Math.max(2, l.count * scale);
      var ao = used[l.depth + '|' + l.from] = used[l.depth + '|' + l.from] || { o: 0 };
      var bo = used['in' + (l.depth + 1) + '|' + l.to] = used['in' + (l.depth + 1) + '|' + l.to] || { o: 0 };
      var y1 = a.y + ao.o + h / 2, y2 = b.y + bo.o + h / 2;
      ao.o += h; bo.o += h;
      var x1 = a.x + 8, x2 = b.x;
      var mx = (x1 + x2) / 2;
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
      p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(138,165,162,.13)' : 'rgba(45,212,191,.26)');
      p.setAttribute('stroke-width', h);
      p.setAttribute('fill', 'none');
      p.style.transition = 'stroke .2s';
      var tip = l.from + ' → ' + (l.to === '✖ exit' ? 'left the site' : l.to) + ' · ' + l.count;
      p.addEventListener('mouseenter', function (e) { p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(138,165,162,.32)' : 'rgba(45,212,191,.6)'); showTip(e, tip); });
      p.addEventListener('mousemove', function (e) { showTip(e, tip); });
      p.addEventListener('mouseleave', function () { p.setAttribute('stroke', l.to === '✖ exit' ? 'rgba(138,165,162,.13)' : 'rgba(45,212,191,.26)'); hideTip(); });
      svg.appendChild(p);
    });
    Object.keys(pos).forEach(function (k) {
      var n = pos[k];
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', n.x); r.setAttribute('y', n.y);
      r.setAttribute('width', 8); r.setAttribute('height', n.h);
      r.setAttribute('rx', 2);
      r.setAttribute('fill', n.path === '✖ exit' ? COL.line : n.path === '…' ? COL.dim : COL.v);
      svg.appendChild(r);
      var t = document.createElementNS(ns, 'text');
      t.setAttribute('x', n.x + 12); t.setAttribute('y', n.y + Math.min(n.h / 2 + 4, 14));
      t.setAttribute('fill', COL.dim); t.setAttribute('font-size', '11');
      var shown = n.path === '✖ exit' ? 'Left the site' : n.path;
      var label = shown.length > 22 ? shown.slice(0, 21) + '…' : shown;
      t.textContent = label + ' (' + fmt(n.v) + ')';
      svg.appendChild(t);
    });
  }
  function showTip(e, text) { var tip = $('tip'); tip.textContent = text; tip.style.opacity = 1; tip.style.left = (e.pageX + 12) + 'px'; tip.style.top = (e.pageY - 10) + 'px'; }
  function hideTip() { $('tip').style.opacity = 0; }

  // ── share links ──
  var shareToken = null;
  $('shareBtn').onclick = function () {
    if (!state.site) return;
    api('/api/shares', { method: 'POST', body: JSON.stringify({ site: state.site }) }).then(function (s) {
      if (s.error) return;
      shareToken = s.token;
      $('shareDomain').textContent = s.domain;
      $('shareUrl').textContent = ORIGIN + '/share/' + s.token;
      $('shareModal').classList.remove('hide');
    });
  };
  $('copyShare').onclick = function () { navigator.clipboard.writeText($('shareUrl').textContent); $('copyShare').textContent = 'Copied'; setTimeout(function () { $('copyShare').textContent = 'Copy link'; }, 1500); };
  $('revokeShare').onclick = function () { if (shareToken) api('/api/shares/' + shareToken, { method: 'DELETE' }).then(function () { $('shareModal').classList.add('hide'); }); };
  $('closeShare').onclick = function () { closeModal($('shareModal')); };

  // ── funnels ──
  function fmtPct(p) { return (p == null ? '—' : p + '%'); }
  function loadFunnels() {
    if (SHARE) { $('funnels').innerHTML = ''; $('addFunnelBtn').classList.add('hide'); return; }
    if (!state.site) return;
    api('/api/funnels?site=' + encodeURIComponent(state.site)).then(function (fs) {
      if (!Array.isArray(fs)) return;
      if (!fs.length) { $('funnels').innerHTML = '<div class="empty">No funnels yet — define one to see where visitors drop off.</div>'; return; }
      $('funnels').innerHTML = '';
      fs.forEach(function (f) {
        var q = state.from && state.to ? 'from=' + state.from + '&to=' + state.to : 'period=' + state.period;
        api('/api/funnels/' + f.id + '/stats?' + q).then(function (st) {
          if (st.error) return;
          var max = st.steps.length ? st.steps[0].visitors : 0;
          var html = '<div class="funnel"><div class="funnel-head"><strong>' + esc(st.name) + '</strong>' +
            '<button class="funnel-del" data-id="' + f.id + '" title="Delete funnel">×</button></div>';
          st.steps.forEach(function (s, i) {
            var w = max ? Math.max(2, (s.visitors / max) * 100) : 2;
            html += '<div class="funnel-step"><div class="funnel-label">' + (i + 1) + '. ' + (s.type === 'goal' ? ico('i-goal', 'ui') : ico('i-pages', 'ui')) + ' ' + esc(s.label) + '</div>' +
              '<div class="funnel-bar-wrap"><div class="funnel-bar" style="width:' + w + '%"></div>' +
              '<span class="funnel-nums">' + fmt(s.visitors) + ' · ' + s.pctOfFirst + '%' + (i > 0 ? ' <span class="drop">−' + s.dropFromPrev + '%</span>' : '') + '</span></div></div>';
          });
          html += '</div>';
          $('funnels').insertAdjacentHTML('beforeend', html);
          $('funnels').querySelectorAll('.funnel-del').forEach(function (btn) {
            btn.onclick = function () { api('/api/funnels/' + btn.dataset.id, { method: 'DELETE' }).then(loadFunnels); };
          });
        });
      });
    });
  }

  function stepRow() {
    var div = document.createElement('div');
    div.className = 'step-row';
    div.innerHTML = '<select class="step-type"><option value="page">Page</option><option value="goal">Goal</option></select>' +
      '<input class="step-value" type="text" placeholder="/pricing or Signup" autocomplete="off">';
    return div;
  }
  $('addFunnelBtn').onclick = function () {
    $('funnelErr').textContent = ''; $('funnelName').value = '';
    var wrap = $('funnelSteps'); wrap.innerHTML = '';
    wrap.appendChild(stepRow()); wrap.appendChild(stepRow());
    $('funnelModal').classList.remove('hide'); $('funnelName').focus();
  };
  $('addStepBtn').onclick = function () { if ($('funnelSteps').children.length < 8) $('funnelSteps').appendChild(stepRow()); };
  $('cancelFunnel').onclick = function () { closeModal($('funnelModal'), { force: true }); };
  $('createFunnelBtn').onclick = function () {
    var steps = Array.prototype.map.call($('funnelSteps').children, function (row) {
      return { type: row.querySelector('.step-type').value, value: row.querySelector('.step-value').value.trim() };
    }).filter(function (s) { return s.value; });
    api('/api/funnels', { method: 'POST', body: JSON.stringify({ site: state.site, name: $('funnelName').value, steps: steps }) }).then(function (r) {
      if (r.error) { $('funnelErr').textContent = r.error; return; }
      $('funnelModal').classList.add('hide');
      loadFunnels();
    });
  };

  function boot() {
    hideLogin();
    if (window.TaciAccount) window.TaciAccount.afterBoot();
    syncLegend();
    loadSites().then(function () { load(); loadFunnels(); });
    // live dashboard: refresh every 15s while the tab is visible
    clearInterval(window.__rt);
    window.__rt = setInterval(function () {
      if (!state.site || document.hidden) return;
      load();
    }, 15000);
  }

  // share mode: resolve the token, lock the UI down to one site, skip login entirely
  function bootShare() {
    fetch('/api/share-info/' + SHARE).then(function (r) { return r.json(); }).then(function (info) {
      if (info.error) { document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#e6e8ec;background:#0f1115;font-family:sans-serif"><div><h2>Link expired</h2><p>This share link was revoked or never existed.</p></div></div>'; return; }
      hideLogin();
      state.site = info.domain;
      var sel = $('siteSelect');
      sel.innerHTML = '<option>' + esc(info.domain) + '</option>'; sel.disabled = true;
      ['addSiteBtn', 'tzBtn', 'logoutBtn', 'settingsBtn', 'shareBtn', 'snippetBtn', 'addFunnelBtn', 'annBtn', 'alertsBtn', 'importBtn'].forEach(function (id) { var el = $(id); if (el) el.classList.add('hide'); });
      syncLegend();
      load();
      clearInterval(window.__rt);
      window.__rt = setInterval(function () { if (!document.hidden) load(); }, 15000);
    });
  }

  var INVITE = (location.pathname.match(/^\/invite\/([a-f0-9]{32,64})$/) || [])[1] || '';
  if (SHARE) bootShare();
  else if (INVITE) { $('login').classList.add('hide'); window.TaciAccount.showInvite(INVITE); }
  else if (/^\/reset\/[a-f0-9]{32,64}$/.test(location.pathname)) { $('login').classList.add('hide'); window.TaciAccount.showReset(location.pathname.split('/').pop()); }
  else if (TOKEN) boot(); else showLogin();
})();
