/* NODA Alert service worker.
 * 1) Shows every push as a notification, always, even when the app is open. iPhone requires a
 *    visible notification for each push and withdraws push permission from sites that skip them.
 * 2) Opens the app at the right vigil when a notification is tapped.
 * 3) Keeps the app's own files, so it opens at once and works offline (version 2.7: from the saved copy first;
 *    a new version installs in the background). It never touches Apps Script or Firebase requests,
 *    so vigil data is never cached.
 * 4) Sends back a receipt for a test notification, and for each alert (a page, and from version 2.3 a
 *    shift reminder or thank-you note) to a volunteer who gets alerts by app only. The receipt is a
 *    random ID from the notification, nothing else.
 * No patient information ever passes through here: pushes carry only unit, times, hours to cover and PPE.
 */
'use strict';
// The name changes with every version (tools/build.js adds a fingerprint of the app's files), so a new
// version installs side by side and replaces the old one in one step.
var CACHE = 'noda-shell-2.7.0-f2b2ce2790';
// Receipts go only to an Apps Script web app address.
var API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^\/\s]+|macros)\/s\/[A-Za-z0-9_-]{10,}\/exec$/;
// Version 2.7: the whole app is saved at install, so it opens at once from this copy, even on a slow connection.
var SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/badge-96.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/literata-latin-600-normal.woff2'
];
// Files that only change with a new version of the app: served from the cache first.
var STATIC = /\/(vendor|fonts|icons)\//;

// The four files the app can't open without. If one of them fails to download, this version doesn't install
// and the phone keeps the version it has; the browser tries again on the next visit.
var CORE = ['./', 'index.html', 'app.css', 'app.js'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) {
    var get = function (u) { return c.add(new Request(u, { cache: 'reload' })); };
    // Any other missing file (for example config.js before setup) must not stop the app from installing.
    return Promise.all(SHELL.map(function (u) { return CORE.indexOf(u) >= 0 ? get(u) : get(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    var old = keys.filter(function (k) { return k.indexOf('noda-') === 0 && k !== CACHE; });
    return Promise.all(old.map(function (k) { return caches.delete(k); })).then(function () { return old.length > 0; });
  }).then(function (updated) {
    return self.clients.claim().then(function () {
      // Tell an open app that a newer version is ready (not on the very first install).
      if (updated) return tellApp({ type: 'noda-updated', version: CACHE.replace(/^noda-shell-/, '').split('-')[0] });
    });
  }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Only this site's own files. Apps Script, Firebase and Google calls go straight to the network,
  // so vigil data is never cached.
  if (url.origin !== self.location.origin || url.pathname.indexOf(new URL(self.registration.scope).pathname) !== 0) return;
  if (STATIC.test(url.pathname)) {
    event.respondWith(caches.match(req).then(function (hit) { return hit || fetchAndKeep(req); }));
    return;
  }
  // config.js (the server's address): the saved copy at once, and a fresh copy saved for next time, so a change
  // to it reaches phones even without a new version of the app.
  if (/\/config\.js$/.test(url.pathname)) {
    var fresh = fetchAndKeep(req);
    event.waitUntil(fresh.catch(function () {}));
    event.respondWith(caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fresh; }));
    return;
  }
  // The app's pages and files: the saved copy of this version at once; the network only for anything missing.
  // A new version arrives as a new sw.js, which the browser checks on every visit.
  event.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetchAndKeep(req).catch(function () {
        return req.mode === 'navigate' ? c.match('./').then(function (home) { return home || Response.error(); }) : Response.error();
      });
    });
  }));
});

function fetchAndKeep(req) {
  return fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(function (res) {
    if (res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { return c.put(req.url.split('#')[0], copy); }).catch(function () {});
    }
    return res;
  });
}

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// FCM delivers our data-only messages as JSON with a "data" object: {title, body, kind, vigil, tag}.
self.addEventListener('push', function (event) {
  var d = {};
  try {
    var p = event.data ? event.data.json() : null;
    d = (p && (p.data || p.notification)) || {};
  } catch (e) { d = {}; }
  var title = clip(d.title, 80) || 'NODA Alert';
  var vigil = /^V-\d{1,9}$/.test(d.vigil || '') ? d.vigil : '';
  var tag = /^[A-Za-z0-9_-]{1,64}$/.test(d.tag || '') ? d.tag : '';
  var opts = {
    body: clip(d.body, 240) || 'Open NODA Alert for details.',
    icon: 'icons/icon-192.png',
    badge: 'icons/badge-96.png',
    lang: 'en',
    data: { vigil: vigil, kind: clip(d.kind, 20) }
  };
  if (tag) { opts.tag = tag; opts.renotify = true; }
  var shown = self.registration.showNotification(title, opts).catch(function () {
    return self.registration.showNotification(title, { body: opts.body });
  });
  var jobs = [shown.catch(function () {}), tellApp({ type: 'noda-push', kind: opts.data.kind, vigil: vigil })];
  // The receipt goes only once the notification is on the screen. A test answers at once; pages wait up to
  // 8 seconds, so phones don't all answer in the same second.
  if (d.rid && d.api) {
    jobs.push(shown.then(function () {
      return sendReceipt(String(d.api), String(d.rid), opts.data.kind === 'test' ? 0 : Math.floor(Math.random() * 8000));
    }, function () {}));
  }
  event.waitUntil(Promise.all(jobs));
});

// Tells NODA Alert this notification arrived. mode "no-cors": the answer isn't needed, only the request.
function sendReceipt(api, rid, delay) {
  if (!API_RE.test(api) || !/^[a-f0-9]{20}$/.test(rid)) return Promise.resolve();
  var body = JSON.stringify({ fn: 'pushReceipt', args: [rid] });
  var post = function () {
    return fetch(api, { method: 'POST', mode: 'no-cors', credentials: 'omit', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body });
  };
  return wait(delay).then(post).catch(function () { return wait(10000).then(post); }).catch(function () {});
}

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var vigil = (event.notification.data && event.notification.data.vigil) || '';
  var scope = self.registration.scope;
  var target = scope + (vigil ? '#v=' + vigil : '');
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    var open = list.filter(function (c) { return c.url.indexOf(scope) === 0; })[0];
    if (open) {
      // Tell the open app which vigil to show first, then bring it to the front.
      open.postMessage({ type: 'noda-open', vigil: vigil });
      return 'focus' in open ? open.focus().catch(function () {}) : undefined;
    }
    return self.clients.openWindow(target);
  }));
});

// The browser replaced this phone's push subscription: ask an open app to register it again.
// (When no app is open, the app notices the change the next time it opens.)
self.addEventListener('pushsubscriptionchange', function (event) {
  event.waitUntil(tellApp({ type: 'noda-resubscribe' }));
});

function tellApp(msg) {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) { c.postMessage(msg); });
  });
}
