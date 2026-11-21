/* NODA Alert service worker.
 * 1) Shows every push as a notification, always, even when the app is open. iPhone requires a
 *    visible notification for each push and withdraws push permission from sites that skip them.
 * 2) Opens the app at the right vigil when a notification is tapped.
 * 3) Keeps the app's own files for offline start. It never touches Apps Script or Firebase requests,
 *    so vigil data is never cached.
 * 4) Sends back a receipt for a test notification, and for each alert (a page, and from version 2.3 a
 *    shift reminder or thank-you note) to a volunteer who gets alerts by app only. The receipt is a
 *    random ID from the notification, nothing else.
 * No patient information ever passes through here: pushes carry only unit, times, hours to cover and PPE.
 */
'use strict';
var CACHE = 'noda-shell-2.6.0';
// Receipts go only to an Apps Script web app address.
var API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^\/\s]+|macros)\/s\/[A-Za-z0-9_-]{10,}\/exec$/;
var SHELL = [
  './', 'index.html', 'app.css', 'fonts.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/badge-96.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2', 'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'fonts/literata-latin-600-normal.woff2', 'fonts/ibm-plex-mono-latin-400-normal.woff2'
];
// Files that only change with a new version of the app: served from the cache first.
var STATIC = /\/(vendor|fonts|icons)\//;

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (c) {
    // One missing file (for example config.js before setup) must not stop the app from installing.
    return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: 'reload' })).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('noda-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Only this site's own files. Apps Script, Firebase and Google calls go straight to the network.
  if (url.origin !== self.location.origin || url.pathname.indexOf(new URL(self.registration.scope).pathname) !== 0) return;
  if (STATIC.test(url.pathname)) {
    event.respondWith(caches.match(req).then(function (hit) { return hit || fetchAndKeep(req); }));
    return;
  }
  // Everything else: network first (so updates arrive right away), the saved copy when offline.
  event.respondWith(fetchAndKeep(req).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (req.mode !== 'navigate') return Response.error();
      return caches.match('./').then(function (home) { return home || Response.error(); });
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
