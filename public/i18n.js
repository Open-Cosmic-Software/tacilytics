/* Tacilytics — dashboard translations.
   The UI is written in English. When German is active, every text node and every
   placeholder / title / aria-label that appears in the DOM is looked up in a dictionary
   (exact match, then a few patterns for strings with numbers or names in them).
   A MutationObserver covers everything rendered later, so new code needs no t() calls.
   Unknown strings stay English; with ?i18n=debug window.__taciMissing collects them (for translators).
   Language: Settings → Security → Language (auto = browser language), per browser. */
(function () {
  var DE = {
    // header / toolbar
    'Settings': 'Einstellungen', 'Sign out': 'Abmelden', 'Add site': 'Seite hinzufügen', 'online now': 'gerade online', 'online': 'online',
    'View live visitors': 'Live-Besucher ansehen', 'Account, security and team': 'Konto, Sicherheit und Team',
    "Cookieless analytics · we count, we don't tell": 'Analyse ohne Cookies · wir zählen, wir verraten nichts',
    'Today': 'Heute', '7 days': '7 Tage', '30 days': '30 Tage', '90 days': '90 Tage', '12 mo': '12 Mon.',
    'From': 'Von', 'To': 'Bis', 'Apply': 'Anwenden', 'CSV': 'CSV', 'Share': 'Teilen', 'Embed code': 'Einbettungscode',
    'Alerts': 'Alarme', 'Import': 'Import', 'Create a public read-only link': 'Öffentlichen Nur-Lesen-Link erstellen',
    'Get a message on traffic spikes, drops or reached goals': 'Nachricht bei Traffic-Spitzen, Einbrüchen oder erreichten Zielen',
    'Bring your history from Google Analytics or Plausible': 'Alte Daten aus Google Analytics oder Plausible übernehmen',
    'Filtered by': 'Gefiltert nach', 'Clear all': 'Alle entfernen',
    // stat cards / chart
    'Unique visitors': 'Besucher', 'Visitors': 'Besucher', 'Pageviews': 'Seitenaufrufe', 'Bounce rate': 'Absprungrate',
    'Views / visitor': 'Aufrufe / Besucher', 'Avg. visit time': 'Ø Besuchsdauer', 'Conversion rate': 'Conversion-Rate',
    'Revenue': 'Umsatz', 'Orders': 'Bestellungen', 'Avg. order value': 'Ø Bestellwert', 'Notes': 'Notizen',
    'Mark a day in the chart, e.g. a newsletter or a release': 'Einen Tag im Diagramm markieren, z. B. Newsletter oder Release',
    'Includes imported history.': 'Enthält importierte Daten.', 'Imported history is hidden while a filter is active.': 'Importierte Daten sind ausgeblendet, solange ein Filter aktiv ist.',
    'vs. previous period': 'ggü. Vorzeitraum', 'vs. last year': 'ggü. Vorjahr',
    // panels
    'Pages': 'Seiten', 'Top': 'Top', 'Entry': 'Einstieg', 'Exit': 'Ausstieg', 'Sources': 'Quellen', 'Source': 'Quelle', 'Medium': 'Medium', 'Campaign': 'Kampagne',
    'Locations': 'Länder', 'Browsers': 'Browser', 'OS': 'Betriebssysteme', 'Devices': 'Geräte', 'Languages': 'Sprachen',
    'Platforms': 'Plattformen', 'Platform': 'Plattform', 'App version': 'App-Version', 'web vs. apps': 'Web vs. Apps',
    'Goals & conversions': 'Ziele & Conversions', 'Goal': 'Ziel', 'Funnels': 'Funnels', '+ New funnel': '+ Neuer Funnel',
    'Visitor journeys': 'Besucherwege', 'Scroll depth': 'Scrolltiefe', 'avg · share reaching 75 %': 'Ø · Anteil, der 75 % erreicht',
    'Site search': 'Seitensuche', 'No results': 'Ohne Treffer', 'Broken pages (404)': 'Kaputte Seiten (404)',
    'Revenue by source': 'Umsatz nach Quelle', 'Revenue by platform': 'Umsatz nach Plattform', 'first source of the buying visit': 'erste Quelle des Kaufbesuchs',
    'No data yet': 'Noch keine Daten', 'Not enough data yet': 'Noch nicht genug Daten', 'Add a site to begin': 'Füge eine Seite hinzu, um zu starten',
    'No funnels yet — define one to see where visitors drop off.': 'Noch keine Funnels. Lege einen an, um zu sehen, wo Besucher abspringen.',
    'Direct': 'Direkt', 'Other': 'Andere', 'Left the site': 'Seite verlassen', 'Desktop': 'Desktop', 'Mobile': 'Mobil', 'Tablet': 'Tablet',
    'visitors': 'Besucher', 'views': 'Aufrufe', 'Page': 'Seite',
    // live
    'Live': 'Live', 'Recent activity': 'Letzte Aktivität', 'Visitors over the last 30 minutes · updates every few seconds': 'Besucher der letzten 30 Minuten · aktualisiert sich alle paar Sekunden',
    'No visitors in the last 30 minutes': 'Keine Besucher in den letzten 30 Minuten',
    // common buttons
    'Close': 'Schließen', 'Signing in with your password also asks for a 6-digit code from your authenticator app.': 'Bei der Anmeldung mit Passwort wird zusätzlich ein 6-stelliger Code aus deiner Authenticator-App abgefragt.', 'Cancel': 'Abbrechen', 'Create': 'Erstellen', 'Add': 'Hinzufügen', 'Save': 'Speichern', 'Remove': 'Entfernen',
    'Revoke': 'Widerrufen', 'Copy': 'Kopieren', 'Copy link': 'Link kopieren', 'Copied ✓': 'Kopiert ✓', 'Copied': 'Kopiert', 'Saved ✓': 'Gespeichert ✓',
    'Sending…': 'Wird gesendet …', 'Sent ✓': 'Gesendet ✓', 'Failed': 'Fehlgeschlagen', 'Test': 'Test', 'Loading…': 'Lädt …', 'Older': 'Ältere',
    'Uploading…': 'Wird hochgeladen …', 'Download': 'Herunterladen', 'Downloaded': 'Heruntergeladen', 'Changed ✓': 'Geändert ✓', 'on': 'an',
    // add site / snippet / share / funnel
    'Add a site': 'Seite hinzufügen', 'Enter the domain you want to track.': 'Gib die Domain ein, die du messen willst.', 'example.com': 'beispiel.de',
    'Add tracking': 'Tracking einbauen', 'for': 'für', '. Same dashboard for website and apps.': '. Ein Dashboard für Website und Apps.',
    'Website': 'Website', 'Flutter app': 'Flutter-App', 'Other apps': 'Andere Apps', 'Copy step 2': 'Schritt 2 kopieren',
    'Share dashboard': 'Dashboard teilen', 'Anyone with this link can view stats for': 'Jeder mit diesem Link sieht die Zahlen von',
    '— read-only, no login.': '. Nur lesen, ohne Anmeldung.', 'Revoke this link': 'Diesen Link widerrufen',
    'New funnel': 'Neuer Funnel', '2–8 ordered steps. A visitor advances only after completing the previous step.': '2–8 Schritte in fester Reihenfolge. Ein Besucher kommt erst weiter, wenn er den vorigen Schritt erledigt hat.',
    'Funnel name, e.g. Signup flow': 'Name, z. B. Registrierung', '+ Add step': '+ Schritt hinzufügen',
    'Link expired': 'Link abgelaufen', 'This share link was revoked or never existed.': 'Dieser Link wurde widerrufen oder hat nie existiert.',
    // notes / alerts / import
    'Notes in the chart': 'Notizen im Diagramm', 'e.g. Newsletter sent': 'z. B. Newsletter verschickt', 'No notes yet.': 'Noch keine Notizen.',
    'Mark a day — a newsletter, a release, a sale — so a spike explains itself later. Everyone with access to this site sees them.': 'Markiere einen Tag, z. B. Newsletter, Release oder Sale, damit eine Spitze später erklärt ist. Alle mit Zugriff auf die Seite sehen die Notizen.',
    'Alerts for': 'Alarme für', 'New alert': 'Neuer Alarm', 'Add alert': 'Alarm hinzufügen', 'No alerts for this site yet.': 'Für diese Seite gibt es noch keine Alarme.',
    'Tacilytics sends a message to a webhook (Discord, Slack, or anything that takes JSON). Checked every 10 minutes.': 'Tacilytics schickt eine Nachricht an einen Webhook (Discord, Slack oder alles, was JSON annimmt). Geprüft wird alle 10 Minuten.',
    'Traffic spike — about 3× the usual for this hour': 'Traffic-Spitze: etwa 3× so viel wie sonst zu dieser Uhrzeit',
    'Traffic drop — under 20 % of usual (tracker broken?)': 'Traffic-Einbruch: unter 20 % von sonst (Tracker kaputt?)',
    'Goal reached — e.g. 10× Purchase': 'Ziel erreicht, z. B. 10× Purchase', 'Event name, e.g. Purchase': 'Event-Name, z. B. Purchase', 'How many': 'Wie oft',
    'in 1 hour': 'in 1 Stunde', 'in 24 hours': 'in 24 Stunden', 'in 7 days': 'in 7 Tagen', 'Traffic spike': 'Traffic-Spitze', 'Traffic drop': 'Traffic-Einbruch',
    'Webhook URL (https://…)': 'Webhook-URL (https://…)', 'Webhook URL (optional — server default)': 'Webhook-URL (optional, sonst Server-Standard)',
    'Leave the webhook empty to use the server default (DIGEST_WEBHOOK_URL).': 'Webhook leer lassen, um den Server-Standard zu nutzen (DIGEST_WEBHOOK_URL).',
    'Discord: channel settings → Integrations → Webhooks → Copy URL.': 'Discord: Kanaleinstellungen → Integrationen → Webhooks → URL kopieren.',
    'Import history into': 'Daten importieren in', 'Imported': 'Importiert', 'Plausible': 'Plausible', 'Google Analytics 4': 'Google Analytics 4',
    'Bring your old numbers along. They show up in the chart and in the panels for the days': 'Nimm deine alten Zahlen mit. Sie erscheinen im Diagramm und in den Listen für die Tage,',
    'before': 'bevor', 'Tacilytics started counting — never twice.': 'Tacilytics selbst gezählt hat, nie doppelt.',
    'Choose a file first': 'Bitte zuerst eine Datei wählen',
    // sign in / invite / reset
    'Cookieless analytics. Sign in with your passphrase.': 'Analyse ohne Cookies. Melde dich mit deiner Passphrase an.',
    'Cookieless analytics. Sign in to your account.': 'Analyse ohne Cookies. Melde dich mit deinem Konto an.',
    'Passphrase': 'Passphrase', 'Password': 'Passwort', 'Username': 'Benutzername', 'Sign in': 'Anmelden', 'Sign in with a passkey': 'Mit Passkey anmelden',
    '6-digit code': '6-stelliger Code', 'Verify': 'Bestätigen', 'Lost your phone? Enter one of your recovery codes instead.': 'Handy verloren? Gib stattdessen einen deiner Wiederherstellungscodes ein.',
    'Wrong password': 'Falsches Passwort', 'Wrong username or password': 'Falscher Benutzername oder falsches Passwort', 'Wrong code': 'Falscher Code',
    'Connection error': 'Verbindungsfehler', 'Too many attempts — wait 15 minutes': 'Zu viele Versuche, bitte 15 Minuten warten',
    'Sign-in expired — enter your password again': 'Anmeldung abgelaufen, bitte Passwort erneut eingeben', 'Passkey not accepted': 'Passkey nicht akzeptiert',
    'Join Tacilytics': 'Tacilytics beitreten', 'Choose a username and a password.': 'Wähle Benutzername und Passwort.', 'Create account': 'Konto erstellen',
    'Password (at least 10 characters)': 'Passwort (mindestens 10 Zeichen)', 'New password': 'Neues Passwort',
    'New password (at least 10 characters)': 'Neues Passwort (mindestens 10 Zeichen)', 'Choose a new password.': 'Wähle ein neues Passwort.', 'Save password': 'Passwort speichern',
    'Password saved. Sign in with your new password.': 'Passwort gespeichert. Melde dich mit dem neuen Passwort an.',
    'This invite link is invalid, used or expired': 'Dieser Einladungslink ist ungültig, schon benutzt oder abgelaufen',
    'This reset link is invalid, used or expired': 'Dieser Link ist ungültig, schon benutzt oder abgelaufen',
    // settings
    'Security': 'Sicherheit', 'Team': 'Team', 'Activity': 'Aktivität',
    'Passkeys': 'Passkeys', 'optional': 'optional', 'No passkey yet.': 'Noch kein Passkey.', 'Add passkey': 'Passkey hinzufügen', 'Name, e.g. MacBook': 'Name, z. B. MacBook',
    'Sign in with Face ID, Touch ID, Windows Hello or a security key. No password, no code — and it cannot be phished.': 'Anmelden mit Face ID, Touch ID, Windows Hello oder Sicherheitsschlüssel. Kein Passwort, kein Code, und Phishing geht nicht.',
    'This browser does not support passkeys.': 'Dieser Browser unterstützt keine Passkeys.',
    'Two-factor code (OTP)': 'Zwei-Faktor-Code (OTP)', 'Set up': 'Einrichten', 'Turn on': 'Einschalten', 'Turn off': 'Ausschalten', 'New recovery codes': 'Neue Wiederherstellungscodes',
    'Use any authenticator app (1Password, Google Authenticator, Authy, Bitwarden …).': 'Geht mit jeder Authenticator-App (1Password, Google Authenticator, Authy, Bitwarden …).',
    'Scan the code, or enter this key by hand:': 'Scanne den Code oder gib den Schlüssel von Hand ein:', 'Your password': 'Dein Passwort',
    'Save your recovery codes': 'Wiederherstellungscodes sichern', 'I saved them': 'Gesichert',
    'Each code works once, instead of a 6-digit code. Keep them somewhere safe — they are shown only now.': 'Jeder Code funktioniert einmal, anstelle eines 6-stelligen Codes. Bewahre sie sicher auf, sie werden nur jetzt angezeigt.',
    "Don’t count my own visits": 'Eigene Besuche nicht zählen', 'Ignore this browser': 'Diesen Browser ignorieren', 'Count again': 'Wieder zählen',
    'Open your site once with one of these links, in every browser and on every phone you use. That browser is then ignored on that site (stored in the browser, nothing on the server). The second link undoes it.': 'Öffne deine Seite einmal mit einem dieser Links, in jedem Browser und auf jedem Handy, das du nutzt. Dieser Browser wird dann auf der Seite nicht mehr gezählt (gespeichert im Browser, nichts auf dem Server). Der zweite Link macht es rückgängig.',
    'Weekly report': 'Wochenbericht', 'e-mail': 'E-Mail', 'every Monday': 'jeden Montag', 'Send one now': 'Jetzt einen senden',
    'Every Monday morning, for each of your sites: key figures, a day-by-day chart, highlights, top pages, sources, countries, devices, goals, shop numbers and your notes — compared with the week before.': 'Jeden Montagmorgen für jede deiner Seiten: Kennzahlen, Tagesdiagramm, Auffälliges, Top-Seiten, Quellen, Länder, Geräte, Ziele, Shop-Zahlen und deine Notizen, verglichen mit der Vorwoche.',
    'Language of the e-mail': 'Sprache der Mail',
    'E-mail is not set up on this server yet (SMTP_URL and REPORT_FROM in .env).': 'Auf diesem Server ist noch kein Mailversand eingerichtet (SMTP_URL und REPORT_FROM in der .env).',
    'API keys': 'API-Keys', 'No keys yet.': 'Noch keine Keys.', 'Create key': 'Key erstellen', 'read-only': 'nur lesen', 'read + write': 'lesen + schreiben', 'never used': 'nie benutzt',
    'Name, e.g. reporting script': 'Name, z. B. Reporting-Skript', 'Copy key': 'Key kopieren', 'Copy it now — it is shown only once.': 'Jetzt kopieren, er wird nur einmal angezeigt.',
    'Current password': 'Aktuelles Passwort', 'New password (10+)': 'Neues Passwort (10+)', 'Change': 'Ändern',
    'Changing it signs you out on all other devices.': 'Danach bist du auf allen anderen Geräten abgemeldet.',
    'Language': 'Sprache', 'Theme': 'Darstellung', 'System': 'System', 'Light': 'Hell', 'Dark': 'Dunkel', 'Automatic': 'Automatisch',
    'Appearance': 'Darstellung', 'Language and appearance are saved in this browser.': 'Sprache und Darstellung werden in diesem Browser gespeichert.',
    'Create your account': 'Konto erstellen', 'Create owner account': 'Owner-Konto erstellen',
    'Members': 'Mitglieder', 'Invite someone': 'Jemanden einladen', 'Create link': 'Link erstellen', 'Open invites': 'Offene Einladungen',
    'Creates a link that works once, for 7 days. Send it yourself — Tacilytics sends no e-mail.': 'Erstellt einen Link, der einmal und 7 Tage lang funktioniert. Verschick ihn selbst, Tacilytics verschickt keine Mails.',
    'Owner': 'Owner', 'Admin': 'Admin', 'Viewer': 'Viewer', 'Sites': 'Seiten', 'Password link': 'Passwort-Link', 'Reset 2FA': '2FA zurücksetzen',
    'One-time link to set a new password (24 h)': 'Einmaliger Link für ein neues Passwort (24 h)', '(you)': '(du)', 'all sites': 'alle Seiten', '2FA on': '2FA an', 'no 2FA': 'ohne 2FA',
    'Nothing yet.': 'Noch nichts.', 'someone': 'jemand',
    'Remove this passkey?': 'Diesen Passkey entfernen?', 'Remove this member? They are signed out immediately.': 'Mitglied entfernen? Die Person wird sofort abgemeldet.',
    'Turn off two-factor codes?': 'Zwei-Faktor-Codes ausschalten?', 'Turn off 2FA for this member? Use this when they lost their phone.': '2FA für dieses Mitglied ausschalten? Das ist für den Fall, dass das Handy weg ist.',
    'Revoke this key? Scripts using it stop working immediately.': 'Key widerrufen? Skripte, die ihn nutzen, funktionieren sofort nicht mehr.',
    'Remove this import? The imported numbers disappear from all charts.': 'Import entfernen? Die importierten Zahlen verschwinden aus allen Diagrammen.',
    // activity labels
    'added site': 'hat Seite hinzugefügt', 'removed site': 'hat Seite entfernt', 'created share link': 'hat Share-Link erstellt', 'revoked share link': 'hat Share-Link widerrufen',
    'added note': 'hat Notiz hinzugefügt', 'removed note': 'hat Notiz entfernt', 'added funnel': 'hat Funnel angelegt', 'removed funnel': 'hat Funnel entfernt',
    'created the first account': 'hat das erste Konto erstellt', 'created invite': 'hat eingeladen', 'revoked invite': 'hat Einladung widerrufen',
    'joined via invite': 'ist über Einladung beigetreten', 'changed role': 'hat Rolle geändert', 'removed member': 'hat Mitglied entfernt',
    'reset 2FA of': 'hat 2FA zurückgesetzt von', 'created password link for': 'hat Passwort-Link erstellt für', 'changed own password': 'hat eigenes Passwort geändert',
    'set a new password via link': 'hat per Link ein neues Passwort gesetzt', 'turned 2FA on': 'hat 2FA eingeschaltet', 'turned 2FA off': 'hat 2FA ausgeschaltet',
    'made new recovery codes': 'hat neue Wiederherstellungscodes erzeugt', 'added passkey': 'hat Passkey hinzugefügt', 'removed passkey': 'hat Passkey entfernt',
    'created API key': 'hat API-Key erstellt', 'revoked API key': 'hat API-Key widerrufen', 'turned the weekly report on': 'hat den Wochenbericht eingeschaltet',
    'turned the weekly report off': 'hat den Wochenbericht ausgeschaltet', 'added alert': 'hat Alarm hinzugefügt', 'removed alert': 'hat Alarm entfernt',
    'turned alert on': 'hat Alarm eingeschaltet', 'turned alert off': 'hat Alarm ausgeschaltet', 'imported history': 'hat Daten importiert', 'removed import': 'hat Import entfernt',
    'reset the login (password, 2FA, sessions) of': 'hat die Anmeldung zurückgesetzt (Passwort, 2FA, Sitzungen) von',
    'Visitors on imported days are summed per day, not unique across days.': 'Besucher an importierten Tagen werden pro Tag summiert, nicht über Tage hinweg eindeutig gezählt.',
    'Tacilytics · open source ·': 'Tacilytics · Open Source ·',
    '· open source ·': '· Open Source ·',
    'Discard your changes?': 'Änderungen verwerfen?',
    'Time zone': 'Zeitzone',
    'Time zone (days start at midnight here)': 'Zeitzone (hier beginnt der Tag um Mitternacht)',
    'Time zone of this site — days start at midnight here': 'Zeitzone dieser Website, hier beginnt der Tag um Mitternacht',
    'Days, hours, the weekly report and alerts follow this time zone for': 'Tage, Stunden, Wochenbericht und Alarme richten sich nach dieser Zeitzone für',
    'Ignore visits from cloud and hosting networks (scrapers). The IP is checked on arrival and never stored. Visitors behind some VPNs are not counted either.': 'Besuche aus Cloud- und Hosting-Netzen ignorieren (Scraper). Die IP wird beim Eintreffen geprüft und nie gespeichert. Besucher hinter manchen VPNs werden dann ebenfalls nicht gezählt.',
    'Stored data does not change — switching back and forth is safe.': 'Gespeicherte Daten ändern sich nicht, Hin- und Herwechseln ist gefahrlos.',
    'Unique visitors per day are an approximation outside UTC: the anonymous visitor ID changes at midnight UTC.': 'Eindeutige Besucher pro Tag sind außerhalb von UTC eine Näherung: Die anonyme Besucher-ID wechselt um Mitternacht UTC.',
    'Unknown time zone': 'Unbekannte Zeitzone',
    'Direct / none': 'Direkt / keine', 'Android app': 'Android-App', 'iOS app': 'iOS-App', 'Web': 'Web',
    'For scripts, agents and the CLI (': 'Für Skripte, Agents und die CLI (',
    '). A key acts as you, sees only your sites, and cannot touch the team or your security settings. Read-only unless you untick it.': '). Ein Key handelt als du, sieht nur deine Seiten und kann weder das Team noch deine Sicherheitseinstellungen ändern. Nur lesen, außer du nimmst den Haken raus.',
    '). A key acts as you, sees only your sites, and cannot touch the team or your security settings.': '). Ein Key handelt als du, sieht nur deine Seiten und kann weder das Team noch deine Sicherheitseinstellungen ändern.',
    'For server mode, create a “server mode (count only)” key: it can only report page views for the sites you tick, nothing else. Never put a read + write key on a web server.': 'Für den Server-Modus legst du einen Key „Server-Modus (nur zählen)“ an: Er kann nur Seitenaufrufe für die angehakten Seiten melden, sonst nichts. Leg nie einen Key mit Schreibrechten auf einen Webserver.',
    'server mode (count only)': 'Server-Modus (nur zählen)', 'server mode': 'Server-Modus', 'Reports for:': 'Meldet für:',
    'Signed in as': 'Angemeldet als',
    'Viewer — read only': 'Viewer: nur lesen', 'Admin — sites, share links and funnels (all or picked sites)': 'Admin: Seiten, Share-Links und Funnels (alle oder ausgewählte Seiten)', 'Owner — everything, including the team': 'Owner: alles, auch das Team',
    'In Plausible:': 'In Plausible:', 'Site settings → Imports & Exports → Export data': 'Website-Einstellungen → Imports & Exports → Export data',
    '. Upload the ZIP you get (or the CSV files in it).': '. Lade das ZIP hoch (oder die CSV-Dateien darin).',
    'In Google Analytics 4: open a report (e.g.': 'In Google Analytics 4: Öffne einen Bericht (z. B.', 'Pages and screens': 'Seiten und Bildschirme', 'Traffic acquisition': 'Akquisition von Zugriffen',
    'Demographic details': 'Demografische Details', '), add': ') und füge', 'Date': 'Datum', 'as a secondary dimension, then': 'als sekundäre Dimension hinzu, dann',
    'Share → Download file → CSV': 'Teilen → Datei herunterladen → CSV', '. One file per report; pick several at once.': '. Eine Datei pro Bericht, du kannst mehrere auf einmal wählen.',
    'Privacy flags on the tag:': 'Datenschutz-Optionen am Tag:', 'Track goals & properties from your code:': 'Ziele und Eigenschaften aus deinem Code messen:',
    'Recovery codes left:': 'Übrige Wiederherstellungscodes:', 'server default': 'Server-Standard', 'last sent': 'zuletzt gesendet',
  };
  // strings with numbers / names in them
  var DE_RX = [
    [/^Every change by anyone on the team, newest first\. Kept for a year \(AUDIT_RETENTION_DAYS\)\.$/, 'Jede Änderung im Team, neueste zuerst. Wird ein Jahr aufbewahrt (AUDIT_RETENTION_DAYS).'],
    [/^Signed in as (.+) · (Owner|Admin|Viewer)$/, 'Angemeldet als $1 · $2'],
    [/^You were invited as (owner|admin|viewer)\. Choose a username and a password\.$/, function (m, r) { return 'Du wurdest als ' + { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' }[r] + ' eingeladen. Wähle Benutzername und Passwort.'; }],
    [/^Choose a new password for (.+)\.( Your two-factor code stays on\.)?$/, function (m, u, z) { return 'Wähle ein neues Passwort für ' + u + '.' + (z ? ' Dein Zwei-Faktor-Code bleibt an.' : ''); }],
    [/^(\d+) files? imported \(([\d.,]+) views\)\.\s*(.*)$/, function (m, n, v, rest) { return n + (n === '1' ? ' Datei' : ' Dateien') + ' importiert (' + v + ' Aufrufe). ' + rest; }],
    [/^Includes imported history \(until (.+)\)\.$/, 'Enthält importierte Daten (bis $1).'],
    [/^Own data starts (.+); imported days from then on are ignored\.$/, 'Eigene Daten ab $1. Importierte Tage ab dann werden ignoriert.'],
    [/^Days from (.+) on already have own data — imported numbers count only before that day\.$/, 'Ab $1 gibt es schon eigene Daten. Importierte Zahlen zählen nur vor diesem Tag.'],
    [/^Left the site \(([\d.,]+k?)\)$/, 'Seite verlassen ($1)'],
    [/^(\d+)% deep$/, '$1 % tief'],
    [/^(.+) — ([\d.,]+k?) measured views$/, '$1 · $2 gemessene Aufrufe'],
    [/^· ([\d.,]+k?) sessions, top paths, 30-min session window$/, '· $1 Sitzungen, häufigste Wege, Sitzungsfenster 30 Min.'],
    [/^([\d.,]+) searches · ([\d.,]+)% without results$/, '$1 Suchen · $2 % ohne Treffer'],
    [/^(“[^”]+”)\s+· (\d+)× no results$/, '$1 · $2× ohne Treffer'],
    [/^· (Owner|Admin|Viewer)$/, '· $1'],
    [/^(2FA on|no 2FA)((?: · \d+ passkeys?)?) · last sign-in (.+)$/, function (m, a, pk, d) { return (a === '2FA on' ? '2FA an' : 'ohne 2FA') + pk.replace('passkeys', 'Passkeys').replace('passkey', 'Passkey') + ' · letzte Anmeldung ' + d; }],
    [/^(.+) · (2FA on|no 2FA)((?: · \d+ passkeys?)?) · last sign-in (.+)$/, function (m, s, a, pk, d) { return s.replace('all sites', 'alle Seiten') + ' · ' + (a === '2FA on' ? '2FA an' : 'ohne 2FA') + pk + ' · letzte Anmeldung ' + d; }],
    [/^(\d+) visitors$/, '$1 Besucher'], [/^(\d+) views$/, '$1 Aufrufe'], [/^added (.+)$/, 'hinzugefügt $1'],
    [/^used (.+)$/, 'benutzt $1'], [/^last sign-in (.+)$/, 'letzte Anmeldung $1'], [/^expires (.+)$/, 'läuft ab $1'], [/^Last sent (.+)$/, 'Zuletzt gesendet $1'],
    [/^Server did not answer with JSON \(HTTP (\d+)\)$/, 'Der Server hat nicht mit JSON geantwortet (HTTP $1). Bitte neu laden.'],
    [/^Send this to (.+)\. It works once, for 24 hours\. Their 2FA stays on\.$/, 'Schick das an $1. Funktioniert einmal, 24 Stunden lang. Die 2FA bleibt an.'],
  ];

  function lang() {
    var p; try { p = localStorage.getItem('tacilytics_lang') || 'auto'; } catch (e) { p = 'auto'; }
    if (p === 'auto') p = /^de\b/i.test(navigator.language || '') ? 'de' : 'en';
    return p === 'de' ? 'de' : 'en';
  }
  var L = lang();
  var DE_VALUES = {}; // already-German strings: never "missing", never re-translated
  document.documentElement.setAttribute('lang', L);
  // collecting untranslated strings only on demand (?i18n=debug) — otherwise the set would grow with
  // every page path / source shown during a long session
  var DEBUG = /[?&]i18n=debug\b/.test(location.search);
  if (DEBUG) window.__taciMissing = window.__taciMissing || {};
  function tr(s) {
    if (L !== 'de' || !s) return null;
    var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0], core = s.trim();
    if (!core || !/[A-Za-z]/.test(core)) return null;
    if (Object.prototype.hasOwnProperty.call(DE, core)) return lead + DE[core] + tail;
    if (DE_VALUES[core]) return null;
    for (var i = 0; i < DE_RX.length; i++) if (DE_RX[i][0].test(core)) return lead + noteResult(core.replace(DE_RX[i][0], DE_RX[i][1])) + tail;
    if (DEBUG) window.__taciMissing[core] = 1;
    return null;
  }
  function addValue(v) { if (typeof v === 'string') DE_VALUES[v.trim()] = 1; }
  for (var k in DE) if (Object.prototype.hasOwnProperty.call(DE, k)) addValue(DE[k]);
  function noteResult(t) { if (t) addValue(t); return t;
  }
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1 };
  function walk(node) {
    if (L !== 'de') return;
    if (node.nodeType === 3) {
      var p = node.parentNode;
      if (!p || SKIP[p.nodeName] || (p.closest && p.closest('.snippet, .bar .name, .feed, #actRows .act-target, [data-no-i18n]'))) return;
      var t = tr(node.nodeValue); if (t != null && t !== node.nodeValue) node.nodeValue = t;
      return;
    }
    if (node.nodeType !== 1 || SKIP[node.nodeName]) return;
    if (node.closest && node.closest('[data-no-i18n]')) return;
    for (var a = 0; a < ATTRS.length; a++) {
      var v = node.getAttribute && node.getAttribute(ATTRS[a]);
      if (v) { var tv = tr(v); if (tv != null && tv !== v) node.setAttribute(ATTRS[a], tv); } // equal → no write, or the observer loops
    }
    if (node.nodeName === 'OPTION' && node.parentNode && node.parentNode.id === 'siteSelect') return; // domains
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function start() {
    walk(document.body);
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'characterData') walk(m.target);
        else if (m.type === 'attributes') walk(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (L === 'de') { if (document.body) start(); else document.addEventListener('DOMContentLoaded', start); }
  window.TaciLang = {
    get: function () { try { return localStorage.getItem('tacilytics_lang') || 'auto'; } catch (e) { return 'auto'; } },
    set: function (v) { try { localStorage.setItem('tacilytics_lang', v); } catch (e) {} location.reload(); },
    current: L,
    t: function (s) { var r = tr(s); return r == null ? s : r; }, // for texts that never reach the DOM (confirm())
  };
})();
