/* NODA Alert app. One file for both versions of the screen:
 *   - the phone app (web/index.html, any HTTPS static host), which talks to Apps Script with fetch()
 *   - the Apps Script web app (Index.html), which talks to Apps Script with google.script.run
 * Edit this file, then run `node tools/build.js` to refresh Index.html and web/index.html.
 * Never show or send patient names, rooms, ages or diagnoses. The server never sends any.
 */
(function () {
'use strict';
var H = 3600e3, MIN = 60e3, DAY = 24 * H;
var APP_VERSION = '2.4.1';
var FIREBASE_DIR = './vendor/firebase/12.19.0/';
var GAS = !!(window.google && google.script && google.script.run);
var MODE = GAS ? 'gas' : (document.documentElement.getAttribute('data-app') === 'pwa' ? 'pwa' : 'none');
var CFG = MODE === 'pwa' ? readConfig() : {};
var KEY = MODE === 'gas' && typeof window.NODA_KEY === 'string' ? window.NODA_KEY : '';
var ST = null, VIEW = { name: 'home' }, TAB = 'vigils', DRAFT = null, BUSY = false, UI = {};
var PASTE = {}, DEEP = null, LOADING = null;
var SIGN = { step: 'email' };   // phone app sign-in: 'email' -> 'code' (-> 'role'), or 'paste' for a link
var PUSH = { busy: false, err: '', fb: null, waiters: [], refreshing: false, lastRefresh: 0, endpoint: '' };
var TEST = {};                   // a test notification waiting for this phone's receipt: {id, waiting, started, tries, timer} or {failed}
var DETAIL = {};                 // coordinator: one volunteer's hours and history {id, data, loading, err}
var LETTER = {};                 // coordinator: service letter {id, opts, data, loading, err}
// UI.fix: the hours entry the coordinator is fixing (its id); UI.fixDraft / UI.fixErr: what was typed, what to fix.
var INSTALL = { evt: null };
var ROLES = { key: '', list: [], who: '', at: 0 };   // version 2.4: roles this person can switch between on this phone
var ROLE_FETCH = false;
var ROLE_SHORT = { vol: 'Volunteer', rn: 'Charge nurse', coord: 'Coordinator' };
var ROLE_WORD = { vol: 'a volunteer', rn: 'a charge nurse', coord: 'the NODA coordinator' };
// Role colors (version 2.4.1): the app takes the color of the role it's in (app.css, html[data-role]). These are the
// light-mode colors, also used for the phone's status bar; dark mode keeps a dark status bar.
var ROLE_THEME = { vol: '#3D3B93', rn: '#1766A0', coord: '#6B1F62' };
var app = document.getElementById('app'), tabs = document.getElementById('tabs'), whoEl = document.getElementById('who');
var rolesEl = document.createElement('div');
rolesEl.id = 'roles'; rolesEl.className = 'roles'; rolesEl.hidden = true;
tabs.parentNode.insertBefore(rolesEl, tabs);
var toastTimer = null;

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function t24(ts) { var d = new Date(ts); return pad(d.getHours()) + pad(d.getMinutes()); }
function t12(ts) { var d = new Date(ts), h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; return (m ? h + ':' + pad(m) : String(h)) + ' ' + ap; }
function r12(a, b) { var A = t12(a), B = t12(b); return A.slice(-2) === B.slice(-2) ? A.slice(0, -3) + '–' + B : A + '–' + B; }
function r24(a, b) { return t24(a) + '–' + t24(b); }
function midnight(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayLabel(ts) {
  var diff = Math.round((midnight(ts) - midnight(Date.now())) / DAY);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow'; if (diff === -1) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}
// "today", "tomorrow", or "Sun, 11/1" (a weekday keeps its capital).
function dayWord(ts) { var d = dayLabel(ts); return /^(Today|Tomorrow|Yesterday)$/.test(d) ? d.toLowerCase() : d; }
function shortDate(ts) { return new Date(ts).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }); }
function longDate(ts) { return new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
function medDate(ts) { return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
// 4.5, 38, -0.5 (one decimal at most), and "4.5 hours" / "1 hour"
function hrsNum(n) { var r = Math.round((+n || 0) * 10) / 10; return (r < 0 ? '−' : '') + (Math.abs(r) % 1 ? Math.abs(r).toFixed(1) : String(Math.abs(r))); }
function hrsTxt(n) { var r = Math.round((+n || 0) * 10) / 10; return hrsNum(n) + (Math.abs(r) === 1 ? ' hour' : ' hours'); }
function isoOf(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayISO() { return isoOf(Date.now()); }
// Where volunteers check in, as the server words it: "at the charge RN desk", "with the HUC".
function where(v) { return v.where || 'at the charge RN desk'; }
function hrs(n) { return plural(n, 'hour'); }
// Sign-up rules from the server: hours per sign-up, and how early check-in opens.
function rules() { var r = (ST && ST.signUp) || {}; return { min: r.minHours || 1, max: r.maxHours || 4, early: r.checkInEarlyMin || 10 }; }
function cleanKey(k) { return String(k || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64); }
// Browser storage can be missing or blocked (private windows, cleared data); the app still works without it.
var LS = {
  get: function (k) { try { return window.localStorage.getItem('noda.' + k); } catch (e) { return null; } },
  set: function (k, v) { try { window.localStorage.setItem('noda.' + k, v); } catch (e) { /* not saved */ } },
  del: function (k) { try { window.localStorage.removeItem('noda.' + k); } catch (e) { /* nothing to remove */ } }
};

/* ---------- phone app settings (config.js) ---------- */
function readConfig() {
  var c = window.NODA_CONFIG || {};
  var url = String(c.appsScriptUrl || '').trim();
  var f = c.firebase || {};
  var fbOk = ['apiKey', 'projectId', 'messagingSenderId', 'appId'].every(function (k) { return typeof f[k] === 'string' && f[k] && !/PASTE/i.test(f[k]); });
  var vapid = String(c.vapidKey || '').trim();
  var vapidOk = /^[A-Za-z0-9_-]{80,100}=?$/.test(vapid);
  return {
    apiUrl: /^https:\/\/script\.google\.com\/(a\/macros\/[^\/\s]+|macros)\/s\/[A-Za-z0-9_-]{10,}\/exec$/.test(url) ? url : '',
    urlGiven: !!url && !/PASTE/i.test(url),
    firebase: fbOk ? f : null,
    vapidKey: vapidOk ? vapid : '',
    pushReady: fbOk && vapidOk
  };
}

/* ---------- server ---------- */
// Apps Script version: google.script.run. Phone app: POST {fn, key, args} as text/plain to the /exec URL.
// text/plain keeps it a CORS "simple request" (no preflight, which Apps Script can't answer).
function apiCall(fn, args, key) {
  return fetch(CFG.apiUrl, {
    method: 'POST', redirect: 'follow', credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fn, key: key, args: args || [] })
  }).then(function (res) {
    return res.text().then(function (t) {
      var j = null;
      try { j = JSON.parse(t); } catch (e) { j = null; }
      if (!j || typeof j !== 'object') {
        throw new Error(res.ok ? 'NODA Alert’s server answered in an unexpected way. The coordinator may need to deploy the newest Code.gs.'
          : 'NODA Alert’s server isn’t answering (' + res.status + '). Try again in a minute.');
      }
      if (j.ok !== true) throw new Error(j.error || 'Something went wrong. Try again.');
      return j.data;
    });
  }, function () { throw new Error('Couldn’t reach NODA Alert. Check your connection and try again.'); });
}
function call(fn, args) {
  if (MODE === 'pwa') return apiCall(fn, args, KEY);
  return new Promise(function (resolve, reject) {
    var r = google.script.run.withSuccessHandler(resolve).withFailureHandler(reject);
    r[fn].apply(r, [KEY].concat(args || []));
  });
}
function load() {
  if (LOADING) return LOADING;
  LOADING = call('getState', []).then(function (st) { ST = st; render(); afterLoad(); }, function (err) {
    if (ST) { toast(err && err.message ? err.message : 'Couldn’t refresh. Try again.'); return; }
    app.innerHTML = '<p class="empty">Couldn’t reach NODA Alert. Check your connection and reload. ' + esc(err && err.message ? '(' + err.message + ')' : '') + '</p>' +
      (MODE === 'pwa' ? '<p><button type="button" class="btn" data-act="retry">Try again</button></p>' : '');
  }).then(function () { LOADING = null; });
  return LOADING;
}
function act(fn, args, after, onErr) {
  if (BUSY) return;
  BUSY = true; document.body.classList.add('busy');
  call(fn, args).then(function (st) {
    ST = st; if (after) after(st); render(); if (st.notice) toast(st.notice);
  }, function (err) {
    var m = err && err.message ? err.message : 'Something went wrong. Try again.';
    if (onErr) { onErr(m); render(); } else toast(m);
    return load();
  }).then(function () { BUSY = false; document.body.classList.remove('busy'); });
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  // Longer messages stay up longer, so there's time to read them.
  clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, Math.max(3800, String(msg).length * 55));
}
function editing() {
  var a = document.activeElement;
  return VIEW.name === 'request' || VIEW.name === 'letter' || VIEW.name === 'bulk' || UI.addHours || UI.fix || UI.addVol || UI.addRn ||
    UI.endAsk || UI.confirmRelease || UI.confirmReset || UI.confirmRn || UI.confirmSignOut ||
    (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'radio');
}
function afterLoad() {
  if (DEEP && ST && ST.role !== 'none') {
    var id = DEEP; DEEP = null;
    if (vigilById(id)) { if (ST.role === 'coord') TAB = 'vigils'; go({ name: 'vigil', id: id }); }
  }
  if (MODE === 'pwa' && Date.now() - PUSH.lastRefresh > 6 * H) pushRefresh();
  if (MODE === 'pwa' && KEY && ST && ST.role !== 'none' && (ROLES.key !== KEY || Date.now() - ROLES.at > 15 * MIN)) fetchRoles();
}

/* ---------- data ---------- */
// A vigil covers windowH whole hours from its start. Sign-ups (ST.slots) cover some of them; the rest are open.
function vigilById(id) { for (var i = 0; i < ST.vigils.length; i++) if (ST.vigils[i].id === id) return ST.vigils[i]; return null; }
function vEnd(v) { return v.end || v.start + (v.windowH || 0) * H; }
function signupsOf(v) { return ST.slots.filter(function (s) { return s.vigilId === v.id; }).sort(function (a, b) { return a.start - b.start; }); }
function whoAt(list, t) { for (var i = 0; i < list.length; i++) if (list[i].start <= t && t < list[i].end) return list[i]; return null; }
function signupState(v, s, now) {
  if (v.status !== 'active') return s.start >= v.ended ? 'cancelled' : 'done';
  if (s.outAt || s.end <= now) return 'done';
  if (s.start <= now) return s.inAt ? 'bedside' : 'due';
  return 'taken';
}
// One cell per hour of the vigil: {start, end, s (the sign-up covering it, if any), st (its state)}.
function cells(v, now) {
  var list = signupsOf(v), out = [], end = vEnd(v);
  for (var t = v.start; t < end; t += H) {
    var s = whoAt(list, t), st;
    if (v.status !== 'active') st = t >= v.ended ? 'cancelled' : (s ? 'done' : 'missed');
    else if (t + H <= now) st = s ? 'done' : 'missed';
    else if (t <= now) st = s ? signupState(v, s, now) : 'opennow';
    else st = s ? 'taken' : 'open';
    out.push({ start: t, end: t + H, s: s, st: st });
  }
  return out;
}
// filled: hours with someone signed up. open: hours still to cover; open12: those in the next 12 hours.
function stats(v, now) {
  var c = cells(v, now), r = { cells: c, total: c.length, filled: 0, open: 0, open12: 0, gap: null };
  c.forEach(function (x) {
    if (x.s && x.st !== 'cancelled') r.filled++;
    if (v.status === 'active' && !x.s && x.end > now) {
      r.open++; if (!r.gap) r.gap = x;
      if (x.start < now + 12 * H) r.open12++;
    }
  });
  return r;
}
// Neighboring hours with the same sign-up (or the same open state) on the same day as one row: {start, end, s, st, hours}.
function segments(v, now) {
  var out = [];
  cells(v, now).forEach(function (x) {
    var key = x.st === 'cancelled' ? 'c' : x.s ? 's' + x.s.id : 'o' + x.st;
    var st = x.s && x.st !== 'cancelled' ? signupState(v, x.s, now) : x.st;
    var last = out[out.length - 1];
    if (last && last.key === key && midnight(last.start) === midnight(x.start)) { last.end = x.end; last.hours++; }
    else out.push({ key: key, start: x.start, end: x.end, s: x.st === 'cancelled' ? null : x.s, st: st, hours: 1 });
  });
  return out;
}
// Stretches of open hours that haven't ended: {start, end, hours}.
function runs(v, now) {
  var out = [], cur = null;
  if (v.status !== 'active') return out;
  cells(v, now).forEach(function (x) {
    if (!x.s && x.end > now) {
      if (cur && cur.end === x.start) cur.end = x.end; else { cur = { start: x.start, end: x.end }; out.push(cur); }
    } else cur = null;
  });
  out.forEach(function (r) { r.hours = Math.round((r.end - r.start) / H); });
  return out;
}

/* ---------- shared pieces ---------- */
function strip(v, s, now) {
  var cls = { done: 'd', missed: 'm', bedside: 'f', due: 'f', taken: 'f', open: 'o', opennow: 'o', cancelled: 'c' };
  var segs = s.cells.map(function (x) { return '<i class="' + cls[x.st] + '" title="' + r24(x.start, x.end) + '"></i>'; }).join('');
  var mark = '';
  if (v.status === 'active' && s.cells.length) {
    var p = (now - v.start) / (vEnd(v) - v.start);
    if (p >= 0 && p <= 1) mark = '<b class="nowmark" data-p="' + (p * 100).toFixed(2) + '"></b>';
  }
  return '<div class="strip' + (s.cells.length > 36 ? ' dense' : '') + '" aria-hidden="true">' + segs + mark + '</div>';
}
function placeNowMarks() { Array.prototype.forEach.call(app.querySelectorAll('.nowmark'), function (m) { m.style.left = m.getAttribute('data-p') + '%'; }); }
function vigilCard(v, mode, now) {
  var s = stats(v, now), meta;
  if (v.status !== 'active') meta = '<span>Ended ' + t24(v.ended) + ' · ' + esc(v.reason) + '</span>';
  else if (mode === 'vol') meta = '<span>' + plural(s.open, 'open hour') + '</span>' + (s.gap ? '<span class="warn">Next open: ' + esc(dayLabel(s.gap.start)) + ' ' + t12(s.gap.start) + '</span>' : '');
  else meta = '<span>Next 12 h: ' + plural(s.open12, 'available hour') + '</span>' + (s.gap ? '<span class="warn">Gap at ' + t24(s.gap.start) + '</span>' : '<span>Fully covered</span>');
  return '<button type="button" class="card card-btn" data-act="open" data-id="' + esc(v.id) + '">' +
    '<div class="row"><span class="unit">' + esc(v.unitName) + '</span><span class="vid">' + esc(v.id) + '</span></div>' +
    strip(v, s, now) + '<div class="meta">' + meta + '</div></button>';
}
function noneView() {
  if (MODE === 'pwa') return signInView('revoked');
  return '<div class="head"><h2>This link isn’t active</h2></div><p class="empty">Ask your NODA coordinator for your personal link. If you were sent a new link, the old one stops working.</p>';
}
function signedInText(st) {
  if (st.role === 'vol') return 'Signed in as ' + st.me.name;
  if (st.role === 'coord') return 'Signed in as the NODA coordinator';
  return st.name ? 'Signed in as ' + st.name + ' (charge RN)' : 'Signed in as charge RN';
}
// Can this person sign in again by email? (Everyone on a list can; the shared charge RN link has no email.)
function emailSignIn() { return !!(ST && ST.signIn && ST.signIn.email && !(ST.role === 'rn' && !ST.name)); }

/* ---------- phone app: sign in with an emailed code ---------- */
var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
function signInView(reason) {
  if (SIGN.step === 'paste') return pasteView(reason);
  var dis = SIGN.busy ? ' disabled' : '';
  var err = SIGN.err ? '<p class="err" role="alert">' + esc(SIGN.err) + '</p>' : '';
  if (SIGN.step === 'role') {
    return '<div class="head"><p class="eyebrow">Sign in</p><h2>Sign in as</h2></div>' +
      '<div class="card paste"><p class="m0"><b>' + esc(SIGN.email) + '</b> is on more than one NODA list. Choose how to use NODA Alert on this phone. You can switch any time at the top of the app.</p>' + err +
      '<div class="stack">' + (SIGN.choices || []).map(function (c) {
        return '<button type="button" class="btn primary big block" data-act="signin-role" data-role="' + esc(c.role) + '"' + dis + '>' + esc(c.label) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="more"><button type="button" class="btn small quiet" data-act="signin-restart"' + dis + '>Use a different email</button></div>';
  }
  if (SIGN.step === 'code') {
    return '<div class="head"><p class="eyebrow">Sign in</p><h2>Check your email</h2></div>' +
      '<form id="signin-code" class="card paste" novalidate>' +
        '<p class="m0">If <b>' + esc(SIGN.email) + '</b> is on the NODA list, a 6-digit code from NODA Alert is on its way. It works for 10 minutes.</p>' +
        '<label class="field" for="s-code"><span>6-digit code</span><input type="text" id="s-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" autocapitalize="off" spellcheck="false" value="' + esc(SIGN.code || '') + '"></label>' +
        err +
        '<div class="acts"><button type="submit" class="btn primary"' + dis + '>' + (SIGN.busy ? 'Checking…' : 'Sign in') + '</button></div>' +
      '</form>' +
      '<div class="more"><button type="button" class="btn small quiet" data-act="signin-resend"' + dis + '>Send a new code</button>' +
        '<button type="button" class="btn small quiet" data-act="signin-restart"' + dis + '>Use a different email</button></div>' +
      '<p class="hint">No code after a few minutes? Check your spam or junk folder.</p>';
  }
  return (reason === 'revoked' ? '<p class="note">You’ve been signed out on this phone. Sign in again to keep using NODA Alert.</p>' : '') +
    '<div class="head"><p class="eyebrow">Sign in</p><h2>Sign in to NODA Alert</h2></div>' +
    '<form id="signin-email" class="card paste" novalidate>' +
      '<p class="m0">Enter the email address your NODA coordinator has for you. NODA Alert emails you a 6-digit code. There’s no password.</p>' +
      '<label class="field" for="s-email"><span>Email</span><input type="email" id="s-email" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="' + esc(SIGN.email || '') + '"></label>' +
      err +
      '<div class="acts"><button type="submit" class="btn primary"' + dis + '>' + (SIGN.busy ? 'Sending…' : 'Email me a code') + '</button></div>' +
    '</form>' +
    '<h3 class="sec">Have a NODA Alert link?</h3>' +
    '<div class="more"><button type="button" class="btn small" data-act="signin-paste"' + dis + '>Paste your link</button></div>';
}
function focusField(id) { var i = document.getElementById(id); if (i) { try { i.focus(); } catch (e) { /* not focusable */ } } }
function sendCode(email, again) {
  email = String(email || '').trim();
  SIGN.email = email; SIGN.err = '';
  if (!EMAIL_RE.test(email)) { SIGN.err = 'Enter your email address, like name@example.org.'; render(); focusField('s-email'); return; }
  var wait = again && SIGN.sentAt ? 60e3 - (Date.now() - SIGN.sentAt) : 0;
  if (wait > 0) { toast('You can ask for a new code in ' + Math.ceil(wait / 1000) + ' seconds.'); return; }
  SIGN.busy = true; render();
  apiCall('requestCode', [email], '').then(function () {
    SIGN = { step: 'code', email: email, sentAt: Date.now() };
    if (again) toast('A new code is on its way. Use the newest one.');
  }, function (err) {
    var m = (err && err.message) || '';
    if (/Unknown action|turned off/.test(m)) {
      // This server has no email sign-in (older Code.gs) or it is switched off: sign in with a link.
      LS.set('signin', 'link');
      SIGN = { step: 'paste' };
      PASTE = { err: /Unknown action/.test(m) ? 'This NODA Alert can’t send sign-in codes yet. Sign in with the link your coordinator sent you.' : m };
      return;
    }
    SIGN.err = m || 'Couldn’t send a code. Try again.';
  }).then(function () { SIGN.busy = false; render(); focusField(SIGN.step === 'code' ? 's-code' : SIGN.step === 'paste' ? 'p-link' : 's-email'); });
}
function checkCode(role) {
  var code = String(SIGN.code || '').replace(/\D/g, '');
  SIGN.err = '';
  if (code.length !== 6) { SIGN.err = 'Enter the 6-digit code from the email.'; render(); focusField('s-code'); return; }
  SIGN.busy = true; render();
  apiCall('verifyCode', [SIGN.email, code, role || ''], '').then(function (r) {
    if (r && r.choose) { SIGN.step = 'role'; SIGN.choices = r.choose; return; }
    if (!r || !r.key || !r.state || r.state.role === 'none') throw new Error('Couldn’t sign in. Ask for a new code and try again.');
    switchKey(r.key); ST = r.state; SIGN = { step: 'email' }; PASTE = {}; VIEW = { name: 'home' }; TAB = 'vigils'; UI = {};
    rolesSave(r.roles, r.who);
    LS.del('signin');
    toast(signedInText(ST));
    afterLoad();
  }, function (err) {
    SIGN.err = (err && err.message) || 'Couldn’t check that code. Try again.';
    SIGN.step = 'code';
  }).then(function () { SIGN.busy = false; render(); if (SIGN.step === 'code' && SIGN.err) focusField('s-code'); });
}

/* ---------- phone app: sign in by pasting your link ---------- */
function extractKey(text) {
  text = String(text || '').trim();
  var m = text.match(/[#?&]k=([A-Za-z0-9]{16,64})(?![A-Za-z0-9])/);
  if (m) return m[1];
  return /^[A-Za-z0-9]{16,64}$/.test(text) ? text : '';
}
function pasteView(reason) {
  var head = reason === 'revoked'
    ? '<div class="head"><p class="eyebrow">Sign in</p><h2>This link isn’t active</h2></div><p class="empty">The link saved on this phone no longer works. If your coordinator sent you a new link, paste it below.</p>'
    : '<div class="head"><p class="eyebrow">One-time sign-in</p><h2>Paste your NODA Alert link</h2></div>';
  var canPaste = !!(navigator.clipboard && navigator.clipboard.readText);
  return head +
    '<form id="paste" class="card paste" novalidate>' +
      '<p class="m0">Your coordinator emailed you a personal link. Copy the whole link from that email and paste it here.</p>' +
      '<label class="field" for="p-link"><span>Your link</span><input type="url" id="p-link" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…#k=…" value="' + esc(PASTE.text || '') + '"></label>' +
      (PASTE.err ? '<p class="err" role="alert">' + esc(PASTE.err) + '</p>' : '') +
      '<div class="acts"><button type="submit" class="btn primary"' + (PASTE.busy ? ' disabled' : '') + '>' + (PASTE.busy ? 'Checking…' : 'Sign in') + '</button>' +
      (canPaste ? '<button type="button" class="btn" data-act="paste-clip"' + (PASTE.busy ? ' disabled' : '') + '>Paste</button>' : '') + '</div>' +
    '</form>' +
    '<p class="hint">To copy your link, press and hold the <b>Open NODA Alert</b> or <b>Take a shift</b> button in any NODA email, then copy the link.</p>' +
    '<div class="more"><button type="button" class="btn small" data-act="signin-email"' + (PASTE.busy ? ' disabled' : '') + '>Sign in with email instead</button></div>';
}
function trySignIn(text) {
  PASTE.text = String(text || '').trim();
  var k = extractKey(PASTE.text);
  if (!k) { PASTE.err = 'That doesn’t look like a NODA Alert link. Copy the whole link from your email and try again.'; render(); return; }
  PASTE.busy = true; PASTE.err = ''; render();
  apiCall('getState', [], k).then(function (st) {
    if (!st || st.role === 'none') { PASTE.err = 'That link isn’t active. Ask your NODA coordinator for your current link.'; return; }
    switchKey(k); ST = st; PASTE = {}; SIGN = { step: 'email' }; VIEW = { name: 'home' }; TAB = 'vigils'; UI = {};
    rolesClear();
    toast(signedInText(st));
    afterLoad();
  }, function (err) { PASTE.err = err && err.message ? err.message : 'Couldn’t check that link. Try again.'; })
    .then(function () { PASTE.busy = false; render(); });
}
// Signing in with a different link on a phone that has notifications on: stop the previous person's
// notifications on this phone now, and register it for the new person on the next refresh.
function switchKey(k) {
  var old = KEY || cleanKey(LS.get('key'));
  if (old && old !== k) {
    var s = pushSaved();
    if (s.on && s.id) { apiCall('unregisterDevice', [s.id], old).catch(function () {}); s.at = 0; pushSave(s); PUSH.lastRefresh = 0; }
  }
  KEY = k; LS.set('key', k);
}
function signOut() {
  var s = pushSaved();
  var stop = s.on && s.id ? call('unregisterDevice', [s.id]).catch(function () {}).then(fcmUnregister) : Promise.resolve();
  BUSY = true; document.body.classList.add('busy');
  stop.then(function () {
    LS.del('key'); LS.del('push'); rolesClear();
    clearTimeout(TEST.timer); TEST = {}; DETAIL = {}; LETTER = {};
    KEY = ''; ST = null; UI = {}; VIEW = { name: 'home' }; TAB = 'vigils'; PASTE = {};
    SIGN = { step: LS.get('signin') === 'link' ? 'paste' : 'email' };
    BUSY = false; document.body.classList.remove('busy');
    render(); toast('Signed out of this phone.');
  });
}

/* ---------- phone app: switch roles (version 2.4) ---------- */
// Someone on more than one list (Volunteers, Charge nurses, Coordinator email) switches roles with one tap.
// The server offers only the roles their email has right now. `who` is the server's signed note of that
// email: a coordinator's key is shared, so the note is how a coordinator can switch too.
function rolesLoad() {
  try {
    var r = JSON.parse(LS.get('roles') || 'null');
    if (r && Array.isArray(r.list)) ROLES = { key: String(r.key || ''), list: r.list, who: String(r.who || ''), at: +r.at || 0 };
  } catch (e) { /* start without */ }
}
function rolesSave(list, who) {
  list = (Array.isArray(list) ? list : []).filter(function (r) { return r && /^(vol|rn|coord)$/.test(r.role); })
    .map(function (r) { return { role: r.role }; });
  ROLES = { key: KEY, list: list, who: String(who || ''), at: Date.now() };
  LS.set('roles', JSON.stringify(ROLES));
}
function rolesClear() { ROLES = { key: '', list: [], who: '', at: 0 }; LS.del('roles'); }
function fetchRoles() {
  if (MODE !== 'pwa' || !KEY || ROLE_FETCH) return;
  var k = KEY;
  ROLE_FETCH = true;
  apiCall('myRoles', [ROLES.who], k).then(function (r) {
    if (k !== KEY) return;   // switched or signed out meanwhile
    var before = JSON.stringify(ROLES.list);
    // Keep the note when the server can't make a new one (a coordinator who signed in with a link).
    rolesSave(r && r.roles, (r && r.who) || ROLES.who);
    if (JSON.stringify(ROLES.list) !== before && !editing()) render();
  }, function (err) {
    // An older Code.gs has no role switch: show none, and don't ask again until the app restarts.
    if (k === KEY && /Unknown action/.test((err && err.message) || '')) { ROLES.key = KEY; ROLES.list = []; ROLES.at = Date.now() + 365 * DAY; }
  }).then(function () { ROLE_FETCH = false; });
}
function roleSwitchHTML() {
  if (MODE !== 'pwa' || !KEY || !ST || ST.role === 'none' || ROLES.key !== KEY || ROLES.list.length < 2) return '';
  return '<span class="roles-label" id="roles-label">Use NODA as</span>' +
    '<div class="roles-seg" role="group" aria-labelledby="roles-label">' + ROLES.list.map(function (r) {
      return '<button type="button" class="rolebtn" data-act="role-switch" data-role="' + esc(r.role) + '" aria-pressed="' + (r.role === ST.role) + '"' +
        (BUSY ? ' disabled' : '') + '>' + esc(ROLE_SHORT[r.role]) + '</button>';
    }).join('') + '</div>';
}
function switchRoleTo(role) {
  if (BUSY || !ST || !KEY || role === ST.role) return;
  var k = KEY;
  BUSY = true; document.body.classList.add('busy'); render();
  apiCall('switchRole', [ROLES.who, role], k).then(function (r) {
    if (!r || !r.key || !r.state || r.state.role === 'none') throw new Error('Couldn’t switch. Try again.');
    switchKey(r.key);   // moves this phone's notifications to the new role
    ST = r.state; rolesSave(r.roles, r.who || ROLES.who);
    VIEW = { name: 'home' }; TAB = 'vigils'; UI = {}; DETAIL = {}; LETTER = {}; DRAFT = null;
    clearTimeout(TEST.timer); TEST = {};
    toast('You’re using NODA as ' + ROLE_WORD[ST.role] + '.');
    afterLoad();
  }, function (err) {
    toast((err && err.message) || 'Couldn’t switch. Try again.');
    ROLES.at = 0; fetchRoles();
  }).then(function () { BUSY = false; document.body.classList.remove('busy'); render(); window.scrollTo(0, 0); });
}

/* ---------- phone app: install on the home screen ---------- */
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isAndroid() { return /Android/i.test(navigator.userAgent); }
function standalone() { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
function iosVersion() { var m = navigator.userAgent.match(/OS (\d+)_(\d+)/); return m ? +m[1] + (+m[2]) / 100 : 0; }
function myLink() { return location.origin + location.pathname + '#k=' + KEY; }
var SHARE_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M7 10H6v10h12V10h-1"/></svg>';
function installBanner() {
  if (MODE !== 'pwa' || standalone() || !ST || ST.role === 'none') return '';
  var hid = +(LS.get('installHide') || 0);
  if (hid && Date.now() - hid < 14 * DAY && !UI.showInstall) return '';
  var push = (ST.role === 'vol' || ST.role === 'coord') && ST.push && CFG.pushReady;
  var later = '<button type="button" class="btn small quiet" data-act="install-hide">Not now</button>';
  if (isIOS()) {
    // The Home Screen app keeps its own storage, so it signs in once more: by email when possible, else by pasting the link.
    var byEmail = emailSignIn();
    var steps = byEmail
      ? '<li>Tap Share ' + SHARE_ICON + ' in Safari, then <b>Add to Home Screen</b>.</li>' +
        '<li>Open <b>NODA</b> from your Home Screen and sign in with your email' + (push ? '. Then tap <b>Turn on notifications</b>' : '') + '.</li>'
      : '<li>Tap <b>Copy my link</b>. You’ll paste it once in the Home Screen app.</li>' +
        '<li>Tap Share ' + SHARE_ICON + ' in Safari, then <b>Add to Home Screen</b>.</li>' +
        '<li>Open <b>NODA</b> from your Home Screen and paste your link' + (push ? '. Then tap <b>Turn on notifications</b>' : '') + '.</li>';
    return '<section class="banner" aria-label="Add NODA Alert to your Home Screen"><p class="h">Add NODA Alert to your Home Screen</p>' +
      '<ol>' + steps + '</ol>' +
      '<p>Don’t see Add to Home Screen? Open this page in Safari first.</p>' +
      '<div class="acts">' + (byEmail ? '' : '<button type="button" class="btn small primary" data-act="copy-mylink">Copy my link</button>') + later + '</div></section>';
  }
  if (INSTALL.evt) {
    return '<section class="banner" aria-label="Install NODA Alert"><p class="h">Install NODA Alert</p><p>Put NODA on your home screen so it opens like an app' + (push ? ' and can show notifications' : '') + '.</p>' +
      '<div class="acts"><button type="button" class="btn small primary" data-act="install">Install</button>' + later + '</div></section>';
  }
  if (isAndroid()) {
    return '<section class="banner" aria-label="Install NODA Alert"><p class="h">Install NODA Alert</p><p>In Chrome, tap ⋮ (top right), then <b>Install app</b> or <b>Add to Home screen</b>.</p><div class="acts">' + later + '</div></section>';
  }
  return '';
}
// Apps Script version: point people to the phone app once its address is on the Settings tab.
function getAppCard() {
  if (MODE !== 'gas' || !ST || !ST.appUrl || ST.role === 'none' || !KEY) return '';
  return '<div class="getapp"><span><b>NODA Alert has a phone app</b>' + (ST.push && ST.role !== 'rn' ? 'It can show pages as notifications.' : 'It opens like an app from your home screen.') + '</span>' +
    '<a class="btn small primary" href="' + esc(ST.appUrl + '#k=' + KEY) + '" target="_top" rel="noopener">Open the phone app</a></div>';
}
function deviceCard() {
  if (MODE !== 'pwa' || !ST || ST.role === 'none') return '';
  var who = ST.role === 'rn' ? (ST.name ? ST.name + ' (charge RN)' : 'Charge RN') : ST.role === 'coord' ? 'NODA coordinator' : ST.me.name;
  var again = emailSignIn() ? ' You can sign in again with your email.' : ' You’ll need your link to sign in again.';
  var body = UI.confirmSignOut
    ? '<div class="confirm"><p>Sign out of NODA Alert on this phone?' + (pushState() === 'on' ? ' Notifications on this phone stop.' : '') + again + '</p><div class="row"><button type="button" class="btn danger" data-act="signout">Sign out</button><button type="button" class="btn" data-act="signout-cancel">Cancel</button></div></div>'
    : '<div class="row"><button type="button" class="btn small" data-act="signout-ask">Sign out of this phone</button></div>';
  return '<h3 class="sec">This phone</h3><div class="card device"><p class="m0">Signed in as <b>' + esc(who) + '</b>.</p>' + body +
    '<p class="ver">NODA Alert ' + APP_VERSION + (ST.version ? ' · server ' + esc(ST.version) : '') + '</p></div>';
}

/* ---------- phone app: notifications ---------- */
function pushSaved() { try { return JSON.parse(LS.get('push') || 'null') || {}; } catch (e) { return {}; } }
function pushSave(o) { LS.set('push', JSON.stringify(o)); }
function platformLabel() {
  var ua = navigator.userAgent;
  var dev = isIOS() ? (/iPhone|iPod/.test(ua) ? 'iPhone' : 'iPad') : isAndroid() ? 'Android' : 'Computer';
  return dev + (standalone() ? (isIOS() ? ' (Home Screen)' : ' (installed)') : ' (browser)');
}
// 'na' | 'unconfigured' | 'ios-old' | 'ios-install' | 'unsupported' | 'denied' | 'on' | 'off'
function pushState() {
  if (MODE !== 'pwa' || !ST || (ST.role !== 'vol' && ST.role !== 'coord')) return 'na';
  if (!CFG.pushReady || !ST.push) return 'unconfigured';
  if (isIOS()) { var v = iosVersion(); if (v && v < 16.04) return 'ios-old'; if (!standalone()) return 'ios-install'; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  var s = pushSaved();
  return s.on && s.id && Notification.permission === 'granted' ? 'on' : 'off';
}
function notifCard() {
  var s = pushState();
  if (s === 'na' || (s === 'unconfigured' && ST.role !== 'coord')) return '';
  var coord = ST.role === 'coord';
  var what = coord ? 'vigil updates' : 'pages';
  // Said only when it's true: a volunteer who turned alert emails off gets pages on their other phone, not by email.
  var until = coord || ST.me.pageEmail ? ' Until then, ' + what + ' come by email.' : '';
  var head, sub, chip = '', acts = '', extra = '';
  var dis = PUSH.busy ? ' disabled' : '';
  if (s === 'unconfigured') {
    head = 'Notifications aren’t set up yet';
    sub = !ST.push ? 'Add the Firebase service account key to Script Properties, or check that App notifications is On in the Settings tab (phone app guide, part 2).' : 'This copy of the phone app is missing its Firebase settings in config.js (phone app guide, part 3).';
    chip = '<span class="chip off">Off</span>';
  } else if (s === 'ios-old') {
    head = 'Notifications need a newer iPhone update';
    sub = 'Update to iOS 16.4 or later in Settings, General, Software Update.' + until;
  } else if (s === 'ios-install') {
    head = 'Notifications need the Home Screen app';
    sub = 'Add NODA Alert to your Home Screen, open it from there, then turn on notifications.';
    if (!installBanner()) acts = '<button type="button" class="btn small" data-act="install-show">Show the steps</button>';
  } else if (s === 'unsupported') {
    head = 'This browser can’t show notifications';
    sub = 'Use Chrome on Android, or Safari on iPhone with NODA Alert added to the Home Screen.' + until;
  } else if (s === 'denied') {
    head = 'Notifications are blocked';
    chip = '<span class="chip blocked">Blocked</span>';
    sub = 'Your phone is blocking notifications from NODA Alert. ' +
      (isIOS() ? 'Open the Settings app, tap Notifications, tap NODA, and turn on Allow Notifications.'
        : isAndroid() ? 'Press and hold the NODA icon, tap App info, then Notifications, and allow them. In Chrome, use ⋮, Settings, Site settings, Notifications.'
        : 'Allow notifications for this site in your browser’s settings.') + ' Then tap Turn on notifications.';
    acts = '<button type="button" class="btn small primary" data-act="push-on"' + dis + '>Turn on notifications</button>';
  } else if (s === 'on') {
    head = 'Notifications are on';
    chip = '<span class="chip on">On</span>';
    // Volunteers: the Available switch above and Email me alerts too below already say where alerts go.
    sub = coord ? 'Vigil updates come to this phone and by email.' : '';
    acts = '<button type="button" class="btn small" data-act="push-test"' + dis + (TEST.waiting ? ' disabled' : '') + '>Send a test</button><button type="button" class="btn small quiet" data-act="push-off"' + dis + '>Turn off</button>';
    extra = testLine() + (coord ? '' : pageEmailBlock());
  } else {
    head = coord ? 'Get vigil updates on this phone' : 'Get pages on this phone';
    chip = '<span class="chip off">Off</span>';
    sub = 'Get ' + what + ' right away, even when the app is closed.' +
      (!coord && ST.me.appFirst && ST.me.pageEmail && ST.me.receiptsOk ? ' After a test, they come here instead of by email.' : '');
    acts = '<button type="button" class="btn primary" data-act="push-on"' + dis + '>' + (PUSH.busy ? 'Turning on…' : 'Turn on notifications') + '</button>';
  }
  if (PUSH.busy && s === 'on') acts = '<span class="hint m0">Working…</span>';
  return '<section class="card notif' + (s === 'on' ? ' on' : '') + '" id="notif" aria-live="polite">' +
    '<div class="row"><span><b>' + head + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + chip + '</div>' +
    (PUSH.err ? '<p class="err" role="alert">' + esc(PUSH.err) + '</p>' : '') +
    (acts ? '<div class="acts">' + acts + '</div>' : '') + extra + '</section>';
}
// This phone's row from the server (volunteers), if it is registered.
function thisPhone() {
  var id = pushSaved().id;
  var list = (ST && ST.me && ST.me.phones) || [];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
// Where the last test notification stands.
function testLine() {
  if (TEST.waiting) return '<p class="hint m0 testline">Waiting for the test to reach this phone…</p>';
  if (TEST.failed) return '<p class="err m0" role="alert">This phone hasn’t confirmed the test yet. If the notification showed up, send another test. If it didn’t, check that notifications for NODA are allowed in your phone’s settings.</p>';
  var me = thisPhone();
  return me && me.tested ? '<p class="hint m0 testline ok">This phone passed a test notification.</p>' : '';
}
// Volunteers: choose whether alerts (pages, reminders, thank-you notes) also come by email. Only after a phone
// has passed a test. With the coordinator's Phone-only alerts after a test row On, the first passed test turns
// alert emails off by itself (version 2.3).
function pageEmailBlock() {
  var me = ST.me;
  var any = (me.phones || []).some(function (p) { return p.tested; });
  if (!any) {
    return '<p class="hint m0">' + (!me.receiptsOk
      ? 'Alert emails stay on until your coordinator finishes setup.'
      : me.appFirst && me.pageEmail
      ? 'Send a test. After it arrives, alerts come here instead of by email.'
      : 'Send a test. After it arrives, you can turn off alert emails.') + '</p>';
  }
  return '<label class="toggle inset" for="f-pagemail"><span><b>Email me alerts too</b><small>' +
    (me.pageEmail
      ? 'Turn off to get alerts on this phone only.'
      : 'Off. If your phone misses an alert, NODA emails it.') +
    '</small></span><input type="checkbox" id="f-pagemail" role="switch"' + (me.pageEmail ? ' checked' : '') + '></label>';
}
// After "Send a test": ask the server every few seconds whether this phone sent back the test's receipt.
function startTestWatch() {
  clearTimeout(TEST.timer);
  TEST = { id: pushSaved().id, waiting: true, started: Date.now(), tries: 0 };
  testCheckIn(4000);
}
function testCheckIn(ms) { clearTimeout(TEST.timer); TEST.timer = setTimeout(testCheck, ms); }
function testCheck() {
  if (!TEST.waiting || !KEY || !TEST.id) return;
  TEST.tries++;
  var giveUp = function () { return Date.now() - TEST.started > 60000; };
  call('confirmTestPush', [TEST.id]).then(function (st) {
    ST = st;
    if (st.test && st.test.confirmed) { clearTimeout(TEST.timer); TEST = {}; if (st.notice) toast(st.notice); }
    else if (giveUp()) { clearTimeout(TEST.timer); TEST = { failed: true }; }
    else testCheckIn(TEST.tries < 3 ? 4000 : 8000);
  }, function () {
    if (giveUp()) { clearTimeout(TEST.timer); TEST = { failed: true }; } else testCheckIn(8000);
  }).then(function () { if (!editing()) render(); });
}
function swReady() {
  return new Promise(function (resolve, reject) {
    if (!('serviceWorker' in navigator)) { reject(new Error('unsupported')); return; }
    var t = setTimeout(function () { reject(new Error('timeout')); }, 15000);
    navigator.serviceWorker.ready.then(function (r) { clearTimeout(t); resolve(r); }, function (e) { clearTimeout(t); reject(e); });
  });
}
// Loads Firebase only when notifications are used (the files are on this site, nothing from a CDN).
function fcm() {
  if (PUSH.fb) return PUSH.fb;
  PUSH.fb = Promise.all([import(FIREBASE_DIR + 'firebase-app.js'), import(FIREBASE_DIR + 'firebase-messaging.js')]).then(function (m) {
    return m[1].isSupported().then(function (ok) {
      if (!ok) throw new Error('unsupported');
      var messaging = m[1].getMessaging(m[0].initializeApp(CFG.firebase));
      m[1].onRegistered(messaging, function (fid) {
        var w = PUSH.waiters; PUSH.waiters = [];
        if (w.length) w.forEach(function (f) { f(fid); }); else fidChanged(fid);
      });
      return { messaging: messaging, register: m[1].register, unregister: m[1].unregister };
    });
  });
  PUSH.fb.catch(function () { PUSH.fb = null; });
  return PUSH.fb;
}
// Registers this phone with FCM and resolves with its Firebase Installation ID (FID).
// force: drop the old FCM registration first (used when the phone's push subscription changed).
function fcmRegister(force) {
  return Promise.all([swReady(), fcm()]).then(function (r) {
    var reg = r[0], F = r[1];
    return (force ? F.unregister(F.messaging).catch(function () {}) : Promise.resolve()).then(function () {
      return new Promise(function (resolve, reject) {
        var done = function (fid) { clearTimeout(timer); resolve(fid); };
        var timer = setTimeout(function () { PUSH.waiters = PUSH.waiters.filter(function (f) { return f !== done; }); reject(new Error('timeout')); }, 30000);
        PUSH.waiters.push(done);
        F.register(F.messaging, { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg }).catch(function (e) {
          clearTimeout(timer); PUSH.waiters = PUSH.waiters.filter(function (f) { return f !== done; }); reject(e);
        });
      });
    }).then(function (fid) {
      return reg.pushManager.getSubscription().then(function (sub) { PUSH.endpoint = sub ? sub.endpoint : ''; return fid; }, function () { return fid; });
    });
  });
}
function fcmUnregister() {
  return fcm().then(function (F) { return F.unregister(F.messaging); }).catch(function () {})
    .then(function () { return swReady(); }).then(function (reg) { return reg.pushManager.getSubscription(); })
    .then(function (sub) { return sub ? sub.unsubscribe() : false; }).catch(function () {});
}
function fidChanged(fid) {
  var s = pushSaved();
  if (!s.on || !KEY || fid === s.id) return;
  call('registerDevice', [fid, platformLabel()]).then(function (st) {
    if (s.id) call('unregisterDevice', [s.id]).catch(function () {});
    pushSave({ on: true, id: fid, at: Date.now(), ep: PUSH.endpoint }); ST = st; if (!editing()) render();
  }, function () {});
}
function pushErrText(err) {
  var m = String((err && (err.code || err.message)) || '');
  if (/unsupported/.test(m)) return 'This browser can’t receive notifications.';
  if (/timeout/.test(m)) return 'Turning on notifications took too long. Check your connection and try again.';
  if (/permission/.test(m)) return 'Notifications weren’t allowed. Tap Turn on notifications and choose Allow.';
  if (err && err.message && !err.code && !/^\w+\/[\w-]+$/.test(err.message) && err.message.length < 200 && /[ .]/.test(err.message)) return err.message;
  return 'Couldn’t turn on notifications' + (m ? ' (' + m.slice(0, 80) + ')' : '') + '. Try again in a minute. If it keeps happening, tell your coordinator.';
}
function b64ToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  var raw = atob(s), out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function pushTurnOn() {
  if (PUSH.busy) return;
  var first;
  // Start straight from the tap, as Apple asks: subscribing shows the permission question on iPhone and
  // Android, and Firebase then reuses this subscription. Without a ready service worker, just ask.
  try {
    first = PUSH.reg && PUSH.reg.pushManager
      ? PUSH.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.vapidKey) })
      : Notification.requestPermission();
  } catch (e) { first = Promise.reject(e); }
  PUSH.busy = true; PUSH.err = ''; render();
  Promise.resolve(first).catch(function (err) {
    // A subscription made with an older key pair blocks a new one: remove it so Firebase can subscribe again.
    if (err && err.name === 'InvalidStateError' && PUSH.reg) return PUSH.reg.pushManager.getSubscription().then(function (sub) { return sub && sub.unsubscribe(); });
    return null;   // otherwise the permission check below decides
  }).then(function () {
    var perm = Notification.permission;
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'blocked' : 'not-allowed');
    return fcmRegister(false);
  }).then(function (fid) {
    return call('registerDevice', [fid, platformLabel()]).then(function (st) {
      pushSave({ on: true, id: fid, at: Date.now(), ep: PUSH.endpoint });
      ST = st; toast('Notifications are on for this phone.');
    });
  }).catch(function (err) {
    var m = err && err.message;
    PUSH.err = m === 'blocked' ? '' : m === 'not-allowed' ? 'Notifications weren’t allowed. Tap Turn on notifications and choose Allow.' : pushErrText(err);
  }).then(function () { PUSH.busy = false; render(); });
}
function pushTurnOff() {
  if (PUSH.busy) return;
  var s = pushSaved();
  PUSH.busy = true; PUSH.err = ''; render();
  // Tell the server first, so pages stop even if the phone can't reach Firebase right now.
  call('unregisterDevice', [s.id || '']).then(function (st) { ST = st; }, function () {})
    .then(fcmUnregister)
    .then(function () { pushSave({ on: false }); toast('Notifications are off for this phone.'); PUSH.busy = false; render(); });
}
// Each time the app opens (at most every 6 hours): keep this phone's registration fresh,
// and notice if notifications were turned off in the phone's settings.
function pushRefresh() {
  var s = pushSaved();
  if (MODE !== 'pwa' || PUSH.refreshing || PUSH.busy || !s.on || !KEY || !ST || ST.role === 'rn') return;
  var st = pushState();
  if (st === 'unconfigured' || st === 'na' || st === 'ios-install' || st === 'ios-old' || st === 'unsupported') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    call('unregisterDevice', [s.id || '']).catch(function () {});
    pushSave({ on: false }); if (!editing()) render();
    return;
  }
  PUSH.refreshing = true;
  swReady().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
    var force = !sub || (s.ep && sub.endpoint !== s.ep);
    return fcmRegister(force).then(function (fid) {
      if (!force && fid === s.id && Date.now() - (s.at || 0) < DAY) return;
      return call('registerDevice', [fid, platformLabel()]).then(function (st1) {
        ST = st1;
        if (s.id && s.id !== fid) call('unregisterDevice', [s.id]).catch(function () {});
        if (st1.device && st1.device.revived && !force) {
          // The server had turned this phone off because FCM said it was gone: register it again from scratch.
          return fcmRegister(true).then(function (fid2) { return call('registerDevice', [fid2, platformLabel()]).then(function (st2) { ST = st2; return fid2; }); });
        }
        return fid;
      }).then(function (finalId) { pushSave({ on: true, id: finalId, at: Date.now(), ep: PUSH.endpoint }); if (!editing()) render(); });
    });
  }).catch(function () { /* try again next time the app opens */ })
    .then(function () { PUSH.refreshing = false; PUSH.lastRefresh = Date.now(); });
}

/* ---------- charge RN ---------- */
function viewRN() {
  if (VIEW.name === 'request' && DRAFT) return rnRequest();
  if (VIEW.name === 'vigil' && vigilById(VIEW.id)) return rnVigil(vigilById(VIEW.id));
  return rnHome();
}
function rnHome() {
  var now = Date.now();
  var active = ST.vigils.filter(function (v) { return v.status === 'active'; }).reverse();
  var ended = ST.vigils.filter(function (v) { return v.status !== 'active'; }).reverse();
  // The coordinator's overview: hours that still need a companion in the next 12 hours, across active vigils.
  var avail = active.reduce(function (n, v) { return n + stats(v, now).open12; }, 0);
  var overview = ST.role === 'coord'
    ? '<div class="stats overview"><div><b>' + active.length + '</b><span>' + (active.length === 1 ? 'active vigil' : 'active vigils') + '</span></div>' +
      '<div><b>' + avail + '</b><span>available hours, next 12 h</span></div><div><b>' + ST.onCall + '</b><span>on call</span></div></div>' : '';
  return installBanner() + getAppCard() +
    '<div class="head"><h2>NODA vigils</h2></div>' + overview +
    (ST.units.length ? '<button type="button" class="btn primary big block" data-act="new">Request a NODA volunteer</button>' : '<p class="note">Add at least one unit on the Units tab of the Sheet before paging.</p>') +
    (ST.role === 'rn' ? '<p class="hint">' + plural(ST.onCall, 'volunteer is', 'volunteers are') + ' on call.</p>' : '') +
    '<h3 class="sec">Active now</h3>' +
    (active.length ? '<div class="stack">' + active.map(function (v) { return vigilCard(v, 'rn', now); }).join('') + '</div>' : '<p class="empty">No active vigils.</p>') +
    (ended.length ? '<h3 class="sec">Ended in the last day</h3><div class="stack">' + ended.map(function (v) { return vigilCard(v, 'rn', now); }).join('') + '</div>' : '') +
    (ST.role === 'rn' ? deviceCard() : '');
}
function opt(name, i, label, on) {
  var id = 'f-' + name + '-' + i;
  return '<label class="opt" for="' + id + '"><input type="checkbox" id="' + id + '" name="' + name + '" value="' + i + '"' + (on ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
}
function seg(name, val, label, cur) {
  var id = 'f-' + name + '-' + String(val).replace(/\W/g, '');
  return '<label for="' + id + '"><input type="radio" id="' + id + '" name="' + name + '" value="' + esc(val) + '"' + (String(cur) === String(val) ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
}
function reqOK(d) { return d.crit1.length > 0 && d.crit2.length > 0 && d.consent; }
function covLine(d) {
  var start = Math.floor(Date.now() / (30 * MIN)) * 30 * MIN + d.startIn * H, end = start + d.windowH * H;
  return 'Covers ' + dayWord(start) + ' ' + t24(start) + ' to ' + dayWord(end) + ' ' + t24(end) + ', ' + d.windowH + ' hours.';
}
function rnRequest() {
  var d = DRAFT, L = ST.lists, ok = reqOK(d);
  return '<button type="button" class="btn quiet back" data-act="home">‹ Vigils</button>' +
    '<div class="head"><p class="eyebrow">New request</p><h2>Request a NODA volunteer</h2></div>' +
    '<form id="req" class="form" novalidate>' +
      '<fieldset><legend>Patient meets at least one</legend>' + L.crit1.map(function (t, i) { return opt('crit1', i, t, d.crit1.indexOf(i) > -1); }).join('') + '</fieldset>' +
      '<fieldset><legend>And at least one</legend>' + L.crit2.map(function (t, i) { return opt('crit2', i, t, d.crit2.indexOf(i) > -1); }).join('') + '</fieldset>' +
      '<label class="opt consent" for="f-consent"><input type="checkbox" id="f-consent" name="consent"' + (d.consent ? ' checked' : '') + '><span><b>Permission given:</b> the patient or surrogate agreed, or the attending provider approved (no surrogate)</span></label>' +
      '<fieldset><legend>Where</legend>' +
        '<label class="field" for="f-unit"><span>Unit</span><select id="f-unit">' + ST.units.map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.id === d.unitId ? ' selected' : '') + '>' + esc(u.name) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field" for="f-checkin"><span>Volunteers check in</span><select id="f-checkin">' + L.checkIn.map(function (c) { return '<option value="' + esc(c) + '"' + (c === d.checkIn ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
        '<div class="field"><span>PPE at the bedside</span><div class="seg">' + seg('ppe', 'no', 'None', d.ppe ? 'yes' : 'no') + seg('ppe', 'yes', 'Needed', d.ppe ? 'yes' : 'no') + '</div></div>' +
      '</fieldset>' +
      '<fieldset><legend>Coverage</legend>' +
        '<div class="field"><span>Start</span><div class="seg">' + seg('startIn', 0, 'Now', d.startIn) + seg('startIn', 1, 'In 1 hour', d.startIn) + seg('startIn', 2, 'In 2 hours', d.startIn) + '</div></div>' +
        '<div class="field"><span>Cover the next</span><div class="seg">' + [12, 24, 48, 72].map(function (h) { return seg('windowH', h, h + ' hours', d.windowH); }).join('') + '</div></div>' +
        '<p class="hint" id="cov-sum">' + esc(covLine(d)) + '</p>' +
      '</fieldset>' +
      '<p class="note">The page has no patient details. Share those in person at check-in.</p>' +
      '<button type="submit" class="btn primary big block" id="send"' + (ok ? '' : ' disabled') + '>Page ' + plural(ST.onCall, 'on-call volunteer') + '</button>' +
      '<p class="hint" id="why"' + (ok ? ' hidden' : '') + '>Check one item in each list and confirm permission to send.</p>' +
    '</form>';
}
function readForm(f) {
  function picks(name) { return Array.prototype.map.call(f.querySelectorAll('input[name="' + name + '"]:checked'), function (x) { return +x.value; }); }
  function radio(name, def) { var x = f.querySelector('input[name="' + name + '"]:checked'); return x ? x.value : def; }
  DRAFT.crit1 = picks('crit1'); DRAFT.crit2 = picks('crit2');
  DRAFT.consent = f.querySelector('#f-consent').checked;
  DRAFT.unitId = f.querySelector('#f-unit').value;
  DRAFT.checkIn = f.querySelector('#f-checkin').value;
  DRAFT.ppe = radio('ppe', 'no') === 'yes';
  DRAFT.startIn = +radio('startIn', 0); DRAFT.windowH = +radio('windowH', 24);
}
function updateReq() {
  var f = document.getElementById('req'); if (!f) return;
  readForm(f);
  var ok = reqOK(DRAFT);
  document.getElementById('cov-sum').textContent = covLine(DRAFT);
  document.getElementById('send').disabled = !ok;
  document.getElementById('why').hidden = ok;
}
// One row of the coverage list: a volunteer's sign-up, or a stretch of open hours.
function segChip(g) {
  var h = ' · ' + g.hours + ' h';
  if (g.s) {
    var n = esc(g.s.volName);
    switch (g.st) {
      case 'done': return '<span class="chip done">Covered · ' + n + '</span>';
      case 'bedside': return '<span class="chip bedside">At bedside · ' + n + '</span>';
      case 'due': return '<span class="chip taken">Due now · ' + n + '</span>';
      case 'taken': return '<span class="chip taken">' + n + h + '</span>';
    }
  }
  switch (g.st) {
    case 'missed': return '<span class="chip missed">Not covered' + h + '</span>';
    case 'opennow': return '<span class="chip now">Open now' + h + '</span>';
    case 'open': return '<span class="chip open">Open' + h + '</span>';
    case 'cancelled': return '<span class="chip done">Canceled</span>';
  }
  return '';
}
function rnVigil(v) {
  var now = Date.now(), s = stats(v, now), rows = '', last = '';
  segments(v, now).forEach(function (g) {
    var dl = dayLabel(g.start);
    if (dl !== last) { rows += '<li class="dayhead">' + esc(dl) + '</li>'; last = dl; }
    rows += '<li class="slot rn"><span class="t24">' + r24(g.start, g.end) + '</span>' + segChip(g) + '</li>';
  });
  var booked = {}; signupsOf(v).forEach(function (x) { if (x.start >= now) booked[x.vol] = 1; });
  var np = Object.keys(booked).length;
  var status = v.status === 'active'
    ? '<span class="chip taken">Active since ' + t24(v.created) + '</span>'
    : '<span class="chip done">Ended ' + t24(v.ended) + ' · ' + esc(v.reason) + '</span>';
  var actions = '';
  if (v.status === 'active') {
    if (UI.endAsk === v.id) {
      actions = '<div class="card endpanel"><p class="h">End this vigil?</p><fieldset><legend class="eyebrow">Reason</legend>' +
        ST.lists.reasons.map(function (r, i) { var id = 'f-reason-' + i; return '<label class="opt" for="' + id + '"><input type="radio" id="' + id + '" name="reason" value="' + esc(r) + '"' + (UI.reason === r ? ' checked' : '') + '><span>' + esc(r) + '</span></label>'; }).join('') +
        '</fieldset><p class="hint m0">' + (np ? plural(np, 'booked volunteer') + ' will be told their hours are canceled.' : 'No one is signed up for later hours.') + '</p>' +
        '<div class="row"><button type="button" class="btn danger" data-act="end" data-id="' + esc(v.id) + '"' + (UI.reason ? '' : ' disabled') + '>End vigil' + (np ? ' and notify' : '') + '</button><button type="button" class="btn" data-act="end-cancel">Keep it open</button></div></div>';
    } else {
      actions = '<div class="row"><button type="button" class="btn" data-act="repage" data-id="' + esc(v.id) + '"' + (s.open ? '' : ' disabled') + '>Re-page for ' + plural(s.open, 'open hour') + '</button>' +
        '<button type="button" class="btn" data-act="extend" data-id="' + esc(v.id) + '">Add 12 hours</button>' +
        '<button type="button" class="btn danger" data-act="end-ask" data-id="' + esc(v.id) + '">End vigil</button></div>';
    }
  }
  return '<button type="button" class="btn quiet back" data-act="home">‹ Vigils</button>' +
    '<div class="head"><p class="eyebrow">' + esc(v.unitName) + ' · ' + esc(v.id) + '</p><h2>Coverage</h2></div>' +
    '<div class="stack"><div>' + status + '</div>' +
    '<div class="stats"><div><b>' + s.filled + '/' + s.total + '</b><span>hours filled</span></div><div><b>' + (s.gap ? t24(s.gap.start) : 'None') + '</b><span>next gap</span></div><div><b>' + v.paged + '</b><span>paged</span></div></div>' +
    strip(v, s, now) +
    '<div class="legend"><span><i class="f"></i>Filled</span><span><i class="o"></i>Open</span><span><i class="m"></i>Not covered</span></div>' +
    actions + '</div>' +
    '<h3 class="sec">Hours</h3><ul class="slots">' + rows + '</ul>' +
    '<p class="hint">Volunteers arrive 5–10 minutes early and check in ' + esc(where(v)) + '.</p>';
}

/* ---------- volunteer ---------- */
function viewVol() {
  if (VIEW.name === 'vigil' && vigilById(VIEW.id)) return volVigil(vigilById(VIEW.id));
  if (VIEW.name === 'myhours') return volHours();
  return volHome();
}
function myShifts(now) {
  var out = [];
  ST.vigils.forEach(function (v) {
    if (v.status !== 'active') return;
    signupsOf(v).forEach(function (s) { if (s.vol === ST.me.id && s.end > now && !s.outAt) out.push({ v: v, s: s }); });
  });
  return out.sort(function (a, b) { return a.s.start - b.s.start; });
}
function volHome() {
  var now = Date.now();
  var needs = ST.vigils.filter(function (v) { return v.status === 'active' && stats(v, now).open > 0; }).reverse();
  var mine = myShifts(now);
  var on = pushState() === 'on';
  var by = !ST.me.pageEmail ? 'Alerts come to your phone only.' : on ? 'Alerts come to your phone and by email.' : 'Alerts come by email.';
  // Alert emails are off but this phone isn't the one getting notifications: say so, with a way back.
  var peNote = !ST.me.pageEmail && !on
    ? '<div class="note row"><span>Alert emails are off, so pages and reminders go only to the phone where you turned notifications on.</span><button type="button" class="btn small" data-act="pe-on">Email me alerts too</button></div>' : '';
  return installBanner() + getAppCard() +
    '<div class="head"><h2>NODA vigils</h2></div>' +
    '<label class="toggle" for="f-avail"><span><b>Available for NODA pages</b><small>' +
      (ST.me.onCall ? by : 'Paused. You won’t get alerts.') +
    '</small></span><input type="checkbox" id="f-avail" role="switch"' + (ST.me.onCall ? ' checked' : '') + '></label>' +
    peNote + notifCard() +
    '<h3 class="sec">Your shifts</h3>' +
    (mine.length ? '<div class="stack">' + mine.map(function (x) { return shiftCard(x.v, x.s, now); }).join('') + '</div>' : '<p class="empty">No upcoming shifts. Sign up below when you can.</p>') +
    '<h3 class="sec">Needs company</h3>' +
    (needs.length ? '<div class="stack">' + needs.map(function (v) { return vigilCard(v, 'vol', now); }).join('') + '</div>' : '<p class="empty">Every hour is covered right now. Thank you.</p>') +
    serviceCard() +
    (MODE === 'pwa' ? deviceCard() : '<p class="hint">Add this page to your home screen so it’s one tap away.</p>');
}
// The volunteer's hours, and a way to ask the coordinator for a service letter.
function letterAsked() { return !!(ST.me.letterAsked && (!ST.me.letterSent || ST.me.letterSent < ST.me.letterAsked)); }
function serviceCard() {
  var h = ST.me.hours || { total: 0 };
  var has = h.total > 0;
  var body = has
    ? '<p class="big">' + esc(hrsTxt(h.total)) + '</p><p class="sub">' + esc([h.shifts ? plural(h.shifts, 'vigil shift') : '', h.first ? 'since ' + longDate(h.first) : ''].filter(Boolean).join(' · ')) + '</p>'
    : '<p class="sub">Your hours show here after your first vigil shift or the NODA training day.</p>';
  var acts = '<button type="button" class="btn small" data-act="myhours">See your hours</button>' +
    (has && !letterAsked() ? '<button type="button" class="btn small" data-act="ask-letter">Ask for a service letter</button>' : '');
  var note = letterAsked()
    ? '<p class="hint m0">You asked for a service letter on ' + esc(medDate(ST.me.letterAsked)) + '. Your coordinator will email it to you.</p>'
    : has ? '<p class="hint m0">A letter confirming your NODA hours, for school or job applications.</p>' : '';
  return '<h3 class="sec">Your NODA service</h3><div class="card service">' + body + '<div class="acts">' + acts + '</div>' + note + '</div>';
}
// Hours rows, newest first. fixable (coordinator): tapping an entry opens a form to fix it, which adds a
// Correction row; the original entry stays on the record.
function histList(list, fixable) {
  if (!list.length) return '<p class="empty">No hours yet.</p>';
  return '<ul class="hist">' + list.map(function (e) {
    var cells = '<span class="d">' + esc(e.at ? medDate(e.at) : '—') + '</span><span class="w">' + esc(e.what) + '</span><span class="h' + (e.hours < 0 ? ' neg' : '') + '">' + esc(hrsNum(e.hours)) + ' h</span>';
    if (!fixable || e.type === 'Correction') return '<li>' + cells + '</li>';
    var open = UI.fix === e.id;
    return '<li class="fixable' + (open ? ' open' : '') + '"><button type="button" class="hrow" data-act="' + (open ? 'fix-cancel' : 'fix-open') + '" data-id="' + esc(e.id) + '" aria-expanded="' + open + '">' + cells + '</button>' +
      (open ? fixForm(e) : '') + '</li>';
  }).join('') + '</ul>';
}
// Fix one entry: what it should be, and why.
function fixForm(e) {
  var d = UI.fixDraft || {};
  var now = e.net !== undefined ? e.net : e.hours;
  return '<form id="fixform" class="fixform" novalidate data-id="' + esc(e.id) + '">' +
    '<p class="hint m0">' + (Math.abs(now - e.hours) > 0.004 ? 'With its corrections, this entry is now ' + esc(hrsTxt(now)) + '. ' : '') +
      'Your fix is added as a correction, and this entry stays on the record.</p>' +
    '<div class="two"><label class="field" for="x-hours"><span>Hours it should be</span><input type="number" id="x-hours" inputmode="decimal" step="0.25" min="0" max="24" value="' + esc(d.hours !== undefined ? d.hours : hrsNum(now)) + '"></label>' +
    '<label class="field" for="x-note"><span>Why (needed)</span><input type="text" id="x-note" maxlength="120" value="' + esc(d.note || '') + '"></label></div>' +
    '<p class="hint m0">Enter 0 to take the entry off the total. Never put patient details in a note.</p>' +
    (UI.fixErr ? '<p class="err" role="alert">' + esc(UI.fixErr) + '</p>' : '') +
    '<div class="acts"><button type="submit" class="btn primary">Save the fix</button><button type="button" class="btn" data-act="fix-cancel">Cancel</button></div></form>';
}
function fixProblem(d) {
  var h = parseFloat(d.hours);
  if (String(d.hours).trim() === '' || !isFinite(h) || h < 0 || h > 24) return 'Enter the hours this entry should be: 0 to 24. 0 takes it off the record.';
  if (!String(d.note).trim()) return 'Add a short note saying why.';
  return '';
}
function hoursStats(h) {
  return '<div class="stats"><div><b>' + esc(hrsNum(h.total)) + '</b><span>total hours</span></div><div><b>' + h.shifts + '</b><span>vigil shifts</span></div><div><b>' + esc(hrsNum(h.training)) + '</b><span>training hours</span></div></div>';
}
function volHours() {
  var h = ST.me.hours || { total: 0, vigil: 0, training: 0, other: 0, shifts: 0 };
  return '<button type="button" class="btn quiet back" data-act="home">‹ Vigils</button>' +
    '<div class="head"><p class="eyebrow">Your NODA service</p><h2>Your hours</h2></div>' +
    '<div class="stack">' + hoursStats(h) +
    (h.first ? '<p class="hint m0">Since ' + esc(longDate(h.first)) + (h.vigil ? '. ' + esc(hrsTxt(h.vigil)) + ' at the bedside.' : '.') + '</p>' : '') +
    '</div>' +
    '<h3 class="sec">History</h3>' + histList(ST.me.history || []) +
    '<p class="hint">Shifts are added when you check out. If something looks wrong, tell your coordinator.</p>' +
    (h.total > 0 && !letterAsked() ? '<div class="more"><button type="button" class="btn" data-act="ask-letter">Ask for a service letter</button></div>' : '') +
    (letterAsked() ? '<p class="hint">You asked for a service letter on ' + esc(medDate(ST.me.letterAsked)) + '. Your coordinator will email it to you.</p>' : '');
}
function shiftCard(v, s, now) {
  var early = rules().early * MIN, inNow = s.inAt && !s.outAt, canIn = !s.inAt && now >= s.start - early && now < s.end, body;
  if (UI.confirmRelease === s.id) {
    body = '<div class="confirm"><p>Release these hours? Other volunteers will be alerted so someone can sign up.</p><div class="row"><button type="button" class="btn danger" data-act="release" data-id="' + esc(s.id) + '">Release hours</button><button type="button" class="btn" data-act="keep">Keep them</button></div></div>';
  } else {
    body = '<div class="row">' +
      (inNow ? '<button type="button" class="btn primary" data-act="checkout" data-id="' + esc(s.id) + '">Check out</button>'
        : canIn ? '<button type="button" class="btn primary" data-act="checkin" data-id="' + esc(s.id) + '">Check in</button>'
        : '<span class="hint m0">Check-in opens at ' + t12(s.start - early) + '.</span>') +
      (inNow ? '' : '<button type="button" class="btn quiet" data-act="release-ask" data-id="' + esc(s.id) + '">Can’t make it</button>') + '</div>';
  }
  return '<div class="card shift"><div class="row"><span class="t12">' + esc(dayLabel(s.start)) + ' · ' + r12(s.start, s.end) + '</span>' + (inNow ? '<span class="chip bedside">At bedside</span>' : '') + '</div>' +
    '<p class="sub">' + esc(v.unitName) + ' · ' + hrs(Math.round((s.end - s.start) / H)) + ' · check in ' + esc(where(v)) + '</p>' + body + '</div>';
}
// Where a sign-up can start, and for how long: every hour of an open stretch that leaves room for the shortest
// sign-up, for the shortest to the longest sign-up. A stretch shorter than the shortest sign-up is taken whole.
function signupOptions(v, now) {
  var r = rules(), opts = [];
  // Times this volunteer already has on another active vigil are left out (the server refuses them too).
  var mine = [];
  ST.vigils.forEach(function (o) { if (o.status === 'active' && o.id !== v.id) signupsOf(o).forEach(function (s) { if (s.vol === ST.me.id && !s.outAt) mine.push(s); }); });
  var busy = function (a, b) { return mine.some(function (s) { return s.start < b && a < s.end; }); };
  runs(v, now).forEach(function (run) {
    if (run.hours < r.min) { if (!busy(run.start, run.end)) opts.push({ t: run.start, run: run, lens: [run.hours] }); return; }
    for (var t = run.start; t + r.min * H <= run.end; t += H) {
      var most = Math.min(r.max, Math.round((run.end - t) / H)), lens = [];
      for (var k = r.min; k <= most && !busy(t, t + k * H); k++) lens.push(k);
      if (lens.length) opts.push({ t: t, run: run, lens: lens });
    }
  });
  return opts;
}
function signupCard(v, now) {
  var r = rules(), opts = signupOptions(v, now);
  if (!opts.length) return '<p class="empty">Every hour is covered right now. You’ll get an alert if hours open up.</p>';
  var cur = null;
  opts.forEach(function (o) { if (o.t === UI.pickStart) cur = o; });
  if (!cur) cur = opts[0];
  UI.pickStart = cur.t;
  var h = cur.lens.indexOf(UI.pickHours) >= 0 ? UI.pickHours : cur.lens[0];
  UI.pickHours = h;
  var end = cur.t + h * H, before = Math.round((cur.t - cur.run.start) / H), after = Math.round((cur.run.end - end) / H), left = [];
  if (before > 0 && before < r.min) left.push(plural(before, 'open hour') + ' before you');
  if (after > 0 && after < r.min) left.push(plural(after, 'open hour') + ' after you');
  var startOpts = opts.map(function (o) {
    var most = o.lens[o.lens.length - 1];
    return '<option value="' + o.t + '"' + (o.t === cur.t ? ' selected' : '') + '>' + esc(dayLabel(o.t) + ' ' + t12(o.t) + (o.t <= now ? ' (now)' : '') + ' · ' + (o.lens.length > 1 ? 'up to ' : '') + most + ' h') + '</option>';
  }).join('');
  var hourOpts = cur.lens.map(function (k) { return '<option value="' + k + '"' + (k === h ? ' selected' : '') + '>' + hrs(k) + '</option>'; }).join('');
  return '<div class="card signup"><p class="h">Sign up</p>' +
    '<label class="field" for="f-start"><span>Start</span><select id="f-start">' + startOpts + '</select></label>' +
    '<label class="field" for="f-hours"><span>How long</span><select id="f-hours">' + hourOpts + '</select></label>' +
    '<p class="hint m0">You’d sit ' + esc(dayWord(cur.t)) + ' ' + r12(cur.t, end) + ', ' + hrs(h) + '.' +
      (left.length ? ' That leaves ' + left.join(' and ') + '.' : '') + '</p>' +
    '<button type="button" class="btn primary block" data-act="take" data-id="' + esc(v.id) + '">Sign up for ' + hrs(h) + '</button>' +
    (cur.lens.length === 1 && cur.lens[0] < r.min
      ? '<p class="hint m0">Only ' + hrs(cur.lens[0]) + ' ' + (cur.lens[0] === 1 ? 'is' : 'are') + ' open here, so you can take ' + (cur.lens[0] === 1 ? 'it' : 'them') + ' on ' + (cur.lens[0] === 1 ? 'its' : 'their') + ' own.</p>' : '') + '</div>';
}
function volVigil(v) {
  var now = Date.now(), rows = '', last = '';
  if (v.status !== 'active') {
    return '<button type="button" class="btn quiet back" data-act="home">‹ Vigils</button><div class="head"><p class="eyebrow">' + esc(v.unitName) + ' · ' + esc(v.id) + '</p><h2>This vigil has ended</h2></div><p class="empty">Thank you for being part of it. Your coordinator will be in touch.</p>';
  }
  segments(v, now).forEach(function (g) {
    if (g.st === 'done' || g.st === 'missed' || g.st === 'cancelled') return;
    var dl = dayLabel(g.start);
    if (dl !== last) { rows += '<li class="dayhead">' + esc(dl) + '</li>'; last = dl; }
    var chip;
    if (g.s && g.s.vol === ST.me.id) chip = '<span class="chip you">You · ' + g.hours + ' h</span>';
    else if (g.s) chip = '<span class="chip taken">' + esc(g.s.volName) + '</span>';
    else chip = g.st === 'opennow' ? '<span class="chip now">Open now · ' + g.hours + ' h</span>' : '<span class="chip open">Open · ' + g.hours + ' h</span>';
    rows += '<li class="slot vol"><span class="t12">' + r12(g.start, g.end) + '</span>' + chip + '</li>';
  });
  var just = null;
  if (UI.justTook) signupsOf(v).forEach(function (x) { if (x.id === UI.justTook && x.vol === ST.me.id) just = x; });
  var onit = just ? '<div class="card onit"><p class="eyebrow">You’re on</p><p class="big">' + esc(dayLabel(just.start)) + ' · ' + r12(just.start, just.end) + '</p><ol>' +
      '<li>Arrive 5–10 minutes early. Check-in opens at ' + t12(just.start - rules().early * MIN) + '.</li>' +
      '<li>Wear your NODA volunteer badge.</li>' +
      '<li>Check in ' + esc(where(v)) + '. The charge nurse walks you to the room.</li></ol></div>' : '';
  return '<button type="button" class="btn quiet back" data-act="home">‹ Vigils</button>' +
    '<div class="head"><p class="eyebrow">' + esc(v.unitName) + ' · ' + esc(v.id) + '</p><h2>A patient needs company</h2></div>' +
    '<div class="stack">' + onit +
    '<ul class="facts"><li><b>Check in</b><span>' + esc(where(v).replace(/^(at|with) the /, '').replace(/^./, function (c) { return c.toUpperCase(); })) + '</span></li>' +
    '<li><b>PPE</b><span>' + (v.ppe ? 'Needed. The nurse shows you what to wear.' : 'None needed') + '</span></li>' +
    '<li><b>Arrive</b><span>5–10 minutes early, to learn the patient’s preferences</span></li></ul>' +
    signupCard(v, now) + '</div>' +
    '<p class="hint">When you arrive, the charge nurse shares the patient’s name, room and anything you should know. If the vigil ends, you’ll get an alert.</p>' +
    '<h3 class="sec">Coverage</h3><ul class="slots">' + (rows || '<li class="dayhead">No upcoming hours</li>') + '</ul>';
}

/* ---------- coordinator ---------- */
function tabsHTML() {
  var list = [['vigils', 'Vigils'], ['volunteers', 'Volunteers']];
  if (ST.chargeNurses) list.push(['rns', 'Charge RNs']);
  return list.concat([['report', 'Report'], ['links', 'Links']]).map(function (t) {
    return '<button type="button" role="tab" data-act="tab" data-tab="' + t[0] + '" aria-selected="' + (TAB === t[0]) + '">' + t[1] + '</button>';
  }).join('');
}
function volById(id) { for (var i = 0; i < ST.volunteers.length; i++) if (ST.volunteers[i].id === id) return ST.volunteers[i]; return null; }
function viewVols() {
  if (VIEW.name === 'vol' && volById(VIEW.id)) return volDetail(volById(VIEW.id));
  if (VIEW.name === 'letter' && volById(VIEW.id)) return letterView(volById(VIEW.id));
  if (VIEW.name === 'bulk') return bulkView();
  var vols = ST.volunteers.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var links = !ST.signIn || ST.signIn.links;
  var add = !UI.addVol ? '<button type="button" class="btn block" data-act="addvol-open">Add a volunteer</button>' :
    '<form id="addvol" class="card form" novalidate><p class="eyebrow">Add a volunteer</p>' +
    '<label class="field" for="v-name"><span>Full name</span><input type="text" id="v-name" autocomplete="off" required></label>' +
    '<label class="field" for="v-email"><span>Email</span><input type="email" id="v-email" autocomplete="off" required></label>' +
    '<label class="field" for="v-org"><span>Staff department or Volunteer Services</span><input type="text" id="v-org" autocomplete="off"></label>' +
    '<div class="row acts-row"><button type="submit" class="btn primary">Add volunteer</button><button type="button" class="btn" data-act="addvol-close">Done</button></div></form>';
  var list = vols.length ? '<ul class="roster">' + vols.map(function (v) {
    var linkBox = UI.showLink === v.id ? (v.link
      ? '<div class="linkbox"><input type="text" id="l-' + esc(v.id) + '" readonly value="' + esc(v.link) + '"><button type="button" class="btn small" data-act="copy" data-src="l-' + esc(v.id) + '">Copy link</button></div>'
      : '<p class="hint m0">Paste the web app URL on the Settings tab of the Sheet to make links.</p>') : '';
    var reset = UI.confirmReset === v.id
      ? '<div class="confirm"><p>' + (links
          ? 'Make a new link for ' + esc(v.name) + '? Their old link stops working' + (v.devices ? ', and so do notifications on their phone until they sign in with the new link' : '') + '.'
          : 'Sign ' + esc(v.name) + ' out of NODA Alert on every phone? They can sign in again with their email' + (v.devices ? '. Notifications on their phone stop until they do' : '') + '.') +
        '</p><div class="row"><button type="button" class="btn danger" data-act="reset" data-id="' + esc(v.id) + '">' + (links ? 'Make new link' : 'Sign out') + '</button><button type="button" class="btn" data-act="reset-cancel">Cancel</button></div></div>' : '';
    return '<li><div class="row"><button type="button" class="who" data-act="vol-open" data-id="' + esc(v.id) + '"><b>' + esc(v.name) + '</b><small>' + esc([v.org, v.email].filter(Boolean).join(' · ')) + appText(v) + '</small></button>' +
      (v.onCall ? '<span class="chip taken">On call</span>' : '<span class="chip done">Paused</span>') + '</div>' +
      '<div class="row"><span class="hrs">' + esc(hrsTxt(v.hours.total)) + (letterOpen(v) ? ' · <b class="flag">letter requested</b>' : '') + '</span><span class="acts">' +
      '<button type="button" class="btn small" data-act="vol-open" data-id="' + esc(v.id) + '">Hours and letter</button>' +
      '<button type="button" class="btn small" data-act="oncall" data-id="' + esc(v.id) + '" data-on="' + (v.onCall ? '0' : '1') + '">' + (v.onCall ? 'Pause' : 'Put on call') + '</button>' +
      '<button type="button" class="btn small" data-act="sendlink" data-id="' + esc(v.id) + '">' + (links ? 'Email link' : 'Email invite') + '</button>' +
      (links ? '<button type="button" class="btn small" data-act="showlink" data-id="' + esc(v.id) + '">' + (UI.showLink === v.id ? 'Hide link' : 'Show link') + '</button>' : '') +
      '<button type="button" class="btn small quiet" data-act="reset-ask" data-id="' + esc(v.id) + '">' + (links ? 'New link' : 'Sign out phones') + '</button></span></div>' +
      linkBox + reset + '</li>';
  }).join('') + '</ul>' : '<p class="empty">No volunteers yet. Add the first one above.</p>';
  return '<div class="head"><p class="eyebrow">' + plural(ST.onCall, 'volunteer') + ' on call of ' + ST.volunteers.length + '</p><h2>Volunteers</h2></div>' +
    '<div class="stack">' + add +
    (vols.length ? '<div class="row"><button type="button" class="btn" data-act="bulk-open">Add hours for several volunteers</button></div>' : '') +
    list + '</div>' +
    '<p class="hint">' + (links
      ? 'Treat each volunteer’s link like a password. If one gets shared, make a new link.'
      : 'Email invite sends the app’s address and how to sign in with an email code.') + '</p>';
}
function appText(v) {
  if (!v.devices) return '';
  return ' · app notifications on' + (v.tested ? ' (tested)' : '') + (v.pageEmail ? '' : ' · alert emails off');
}
function letterOpen(v) { return !!(v.letterAsked && (!v.letterSent || v.letterSent < v.letterAsked)); }

/* ---------- coordinator: one volunteer's hours, history and letter ---------- */
function loadDetail(id) {
  DETAIL = { id: id, loading: true, data: DETAIL.id === id ? DETAIL.data : null };
  call('getHours', [id]).then(function (d) { if (DETAIL.id === id) { DETAIL.data = d; DETAIL.err = ''; } }, function (err) {
    if (DETAIL.id === id) DETAIL.err = (err && err.message) || 'Couldn’t load the hours. Try again.';
  }).then(function () { if (DETAIL.id === id) { DETAIL.loading = false; if (VIEW.name === 'vol' && VIEW.id === id) render(); } });
}
function volDetail(v) {
  var h = v.hours, d = DETAIL.id === v.id ? DETAIL : {};
  var first = v.name.split(' ')[0];
  var hist = d.data ? histList(d.data.history, true) : d.err ? '<p class="err">' + esc(d.err) + '</p>' : '<p class="empty">Loading…</p>';
  var form = UI.addHours ? hoursForm('addhours', 'Add hours for ' + first, '') : '';
  var pe = !v.pageEmail
    ? '<div class="row"><span>Their phone confirms each alert it gets.</span><button type="button" class="btn small" data-act="pe-on-vol" data-id="' + esc(v.id) + '">Turn alert emails back on</button></div>'
    : '';
  var facts = [h.vigil ? hrsTxt(h.vigil) + ' at the bedside' : '', h.other ? hrsTxt(h.other) + ' other' : '', h.first ? 'since ' + longDate(h.first) : 'no hours yet', h.last ? 'last active ' + medDate(h.last) : ''].filter(Boolean).join(' · ');
  return '<button type="button" class="btn quiet back" data-act="home">‹ Volunteers</button>' +
    '<div class="head"><p class="eyebrow">Volunteer · ' + esc(v.id) + '</p><h2>' + esc(v.name) + '</h2></div>' +
    '<div class="stack">' + hoursStats(h) +
    '<p class="hint m0">' + esc(facts.charAt(0).toUpperCase() + facts.slice(1)) + '</p>' +
    (letterOpen(v) ? '<p class="note">' + esc(first) + ' asked for a service letter on ' + esc(medDate(v.letterAsked)) + '.</p>' : '') +
    (v.letterSent && !letterOpen(v) ? '<p class="hint m0">Last service letter emailed ' + esc(medDate(v.letterSent)) + '.</p>' : '') +
    '<div class="row acts-row"><button type="button" class="btn primary" data-act="letter-open" data-id="' + esc(v.id) + '"' + (h.total > 0 ? '' : ' disabled') + '>Service letter</button>' +
      (UI.addHours ? '' : '<button type="button" class="btn" data-act="addhours-open">Add hours</button>') + '</div>' +
    form + '</div>' +
    '<h3 class="sec">Hours record</h3>' + hist +
    '<p class="hint">Tap an entry to fix it.</p>' +
    '<h3 class="sec">Contact and pages</h3><div class="status">' +
      '<div class="row"><span>Email</span><b>' + esc(v.email) + '</b></div>' +
      '<div class="row"><span>Department</span><b>' + esc(v.org || '—') + '</b></div>' +
      '<div class="row"><span>Pages</span><b>' + (v.onCall ? 'On call' : 'Paused') + '</b></div>' +
      '<div class="row"><span>App notifications</span><b>' + (v.devices ? plural(v.devices, 'phone') + (v.tested ? ', tested' : '') : 'Off') + '</b></div>' +
      '<div class="row"><span>Alert emails</span><b>' + (v.pageEmail ? 'On' : 'Off (phone only)') + '</b></div>' +
      pe + '</div>';
}
// The add-hours form, for one volunteer (their page) or several (the bulk page).
// UI.hDraft keeps what was typed when something needs fixing; UI.hErr says what.
function hoursForm(id, title, extra) {
  var types = ST.lists.hourTypes || [];
  var bulk = id === 'bulkhours';
  var d = UI.hDraft || {};
  var type = d.type || 'Training';
  var hrs = d.hours !== undefined ? d.hours : bulk ? '4.5' : '';
  var note = d.note !== undefined ? d.note : bulk ? 'NODA training day' : '';
  return '<form id="' + id + '" class="card form" novalidate><p class="eyebrow">' + esc(title) + '</p>' +
    '<label class="field" for="h-type"><span>What for</span><select id="h-type">' + types.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === type ? ' selected' : '') + '>' + esc(t.label) + '</option>';
    }).join('') + '</select></label>' +
    '<label class="field" for="h-date"><span>Date</span><input type="date" id="h-date" value="' + esc(d.date || todayISO()) + '" max="' + todayISO() + '"></label>' +
    '<label class="field" for="h-hours"><span>Hours</span><input type="number" id="h-hours" inputmode="decimal" step="0.25" min="0.25" max="24" value="' + esc(hrs) + '"></label>' +
    '<label class="field" for="h-note"><span>Note (optional; never patient details)</span><input type="text" id="h-note" maxlength="120" value="' + esc(note) + '"></label>' +
    extra +
    (UI.hErr ? '<p class="err" role="alert">' + esc(UI.hErr) + '</p>' : '') +
    '<div class="acts"><button type="submit" class="btn primary">Save hours</button>' +
    (bulk ? '' : '<button type="button" class="btn" data-act="addhours-cancel">Cancel</button>') + '</div></form>';
}
function readHoursForm(f) {
  var d = {
    type: f.querySelector('#h-type').value, date: f.querySelector('#h-date').value,
    hours: String(f.querySelector('#h-hours').value || '').trim(), note: f.querySelector('#h-note').value
  };
  var picks = f.querySelectorAll('input[name="bulkvol"]');
  if (picks.length) d.volIds = Array.prototype.filter.call(picks, function (x) { return x.checked; }).map(function (x) { return x.value; });
  return d;
}
function hoursNum(d) { return parseFloat(d.hours); }
// The checks the server makes, so a slip is caught before anything is sent.
function hoursProblem(d) {
  var h = hoursNum(d);
  if (d.volIds && !d.volIds.length) return 'Check at least one volunteer.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date > todayISO()) return 'Enter a date no later than today.';
  if (!isFinite(h) || !(h > 0) || h > 24) return 'Enter the hours: more than 0 and no more than 24. To take hours off an entry, fix that entry.';
  return '';
}
function bulkView() {
  var vols = ST.volunteers.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var picks = '<fieldset><legend>Volunteers</legend><div class="row"><button type="button" class="btn small" data-act="bulk-all">Select all</button><button type="button" class="btn small quiet" data-act="bulk-none">Clear</button></div>' +
    vols.map(function (v, i) {
      var on = UI.hDraft && UI.hDraft.volIds && UI.hDraft.volIds.indexOf(v.id) >= 0;
      return '<label class="opt" for="f-bulk-' + i + '"><input type="checkbox" id="f-bulk-' + i + '" name="bulkvol" value="' + esc(v.id) + '"' + (on ? ' checked' : '') + '><span>' + esc(v.name) + '</span></label>';
    }).join('') + '</fieldset>';
  return '<button type="button" class="btn quiet back" data-act="home">‹ Volunteers</button>' +
    '<div class="head"><p class="eyebrow">Hours</p><h2>Add hours for several volunteers</h2></div>' +
    hoursForm('bulkhours', 'The same hours for everyone you check', picks) +
    '<p class="hint">Each person gets their own entry. To fix one later, open that volunteer and tap it.</p>';
}
function letterView(v) {
  var L = LETTER.id === v.id ? LETTER : {};
  var o = L.opts || {};
  var first = v.name.split(' ')[0];
  var c = L.data && L.data.letter;
  var preview = c ? letterHTML(c) : L.err ? '<p class="err">' + esc(L.err) + '</p>' : '<p class="empty">Loading…</p>';
  var ok = !!(c && c.ready);
  return '<div class="noprint"><button type="button" class="btn quiet back" data-act="vol-open" data-id="' + esc(v.id) + '">‹ ' + esc(v.name) + '</button>' +
    '<div class="head"><p class="eyebrow">Service letter</p><h2>Letter for ' + esc(v.name) + '</h2></div>' +
    '<form id="letterform" class="card form" novalidate>' +
      '<div class="two"><label class="field" for="l-from"><span>Hours from</span><input type="date" id="l-from" max="' + todayISO() + '" value="' + esc(o.from || '') + '"></label>' +
      '<label class="field" for="l-to"><span>Through</span><input type="date" id="l-to" max="' + todayISO() + '" value="' + esc(o.to || '') + '"></label></div>' +
      '<label class="field" for="l-sal"><span>Addressed to</span><input type="text" id="l-sal" maxlength="120" value="' + esc(o.salutation || 'To whom it may concern') + '"></label>' +
      '<label class="field" for="l-note"><span>A few words about ' + esc(first) + ' (optional)</span><textarea id="l-note" rows="4" maxlength="800" placeholder="What their time has meant to patients and staff. No patient details.">' + esc(o.note || '') + '</textarea></label>' +
      '<div class="two"><label class="field" for="l-signer"><span>Signed by</span><input type="text" id="l-signer" maxlength="80" value="' + esc(o.signer || '') + '"></label>' +
      '<label class="field" for="l-title"><span>Title</span><input type="text" id="l-title" maxlength="80" value="' + esc(o.title || '') + '"></label></div>' +
      '<div class="acts"><button type="submit" class="btn">Update the letter</button></div>' +
    '</form></div>' +
    '<h3 class="sec noprint">Preview' + (c && c.ready ? ' · ' + esc(hrsTxt(c.total)) + (c.shifts ? ' · ' + plural(c.shifts, 'vigil shift') : '') : '') + '</h3>' + preview +
    '<div class="noprint"><div class="row acts-row"><button type="button" class="btn primary" data-act="letter-print"' + (ok ? '' : ' disabled') + '>Print or save as PDF</button>' +
      '<button type="button" class="btn" data-act="letter-copy"' + (ok ? '' : ' disabled') + '>Copy the text</button>' +
      '<button type="button" class="btn" data-act="letter-email" data-id="' + esc(v.id) + '"' + (ok ? '' : ' disabled') + '>Email PDF to ' + esc(first) + '</button></div>' +
    '<p class="hint">Email sends a PDF to ' + esc(v.email) + ', with a copy to you. To use hospital letterhead, copy the text.</p></div>';
}
function letterHTML(c) {
  var p = function (t, cls) { return '<p' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(t) + '</p>'; };
  if (!c.ready) return '<p class="empty">There are no NODA hours between those dates.</p>';
  return '<article class="letter" aria-label="Letter preview">' +
    '<header class="lh"><p class="lh-name">No One Dies Alone</p>' + p(c.org, 'lh-org') + '</header>' +
    p(c.date, 'date') + p(c.to) + c.paras.map(function (t) { return p(t); }).join('') +
    p(c.close, 'close') + p(c.signer || '______________________________', 'sig') + p(c.title, 'sig') + p(c.orgShort, 'sig') +
    '</article>';
}
function readLetterForm() {
  var f = document.getElementById('letterform');
  if (!f) return LETTER.opts || {};
  var val = function (id) { var el = f.querySelector('#' + id); return el ? el.value : ''; };
  return { from: val('l-from'), to: val('l-to'), salutation: val('l-sal'), note: val('l-note'), signer: val('l-signer'), title: val('l-title') };
}
function loadLetter(id, opts) {
  LETTER = { id: id, opts: opts, data: LETTER.id === id ? LETTER.data : null, loading: true };
  render();
  call('getLetter', [id, opts]).then(function (d) { if (LETTER.id === id) { LETTER.data = d; LETTER.err = ''; } }, function (err) {
    if (LETTER.id === id) LETTER.err = (err && err.message) || 'Couldn’t make the letter. Try again.';
  }).then(function () { if (LETTER.id === id) { LETTER.loading = false; if (VIEW.name === 'letter') render(); } });
}
// Charge nurses who sign in with their own email (so the Log shows who paged).
function viewRns() {
  var si = ST.signIn || {};
  var list = ST.chargeNurses.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var on = list.filter(function (n) { return n.on; }).length;
  var canInvite = !!(ST.appUrl && si.email);
  var setupNote = !ST.appUrl
    ? '<p class="note">Charge nurses sign in through the phone app. Paste its address next to Phone app URL on the Settings tab of the Sheet first.</p>'
    : !si.email ? '<p class="note">Email sign-in is Off on the Settings tab, so the charge nurses below can’t sign in yet.</p>' : '';
  var add = !UI.addRn ? '<button type="button" class="btn block" data-act="addrn-open">Add a charge nurse</button>' :
    '<form id="addrn" class="card form" novalidate><p class="eyebrow">Add a charge nurse</p>' +
    '<label class="field" for="n-name"><span>Full name</span><input type="text" id="n-name" autocomplete="off" required></label>' +
    '<label class="field" for="n-email"><span>Work email</span><input type="email" id="n-email" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>' +
    '<div class="row acts-row"><button type="submit" class="btn primary">Add charge nurse</button><button type="button" class="btn" data-act="addrn-close">Done</button></div></form>';
  var rows = list.length ? '<ul class="roster">' + list.map(function (n) {
    var chip = !n.on ? '<span class="chip done">Off</span>' : n.signedIn ? '<span class="chip taken">Signed in</span>' : '<span class="chip open">Not signed in yet</span>';
    return '<li><div class="row"><span><b>' + esc(n.name) + '</b><small>' + esc(n.email) + '</small></span>' + chip + '</div>' +
      '<div class="row"><span class="acts">' +
      (n.on && canInvite ? '<button type="button" class="btn small" data-act="rn-invite" data-id="' + esc(n.email) + '">Email invite</button>' : '') +
      '<button type="button" class="btn small' + (n.on ? ' quiet' : '') + '" data-act="rn-onoff" data-id="' + esc(n.email) + '" data-on="' + (n.on ? '0' : '1') + '">' + (n.on ? 'Turn off' : 'Turn on') + '</button>' +
      '</span></div></li>';
  }).join('') + '</ul>' : '<p class="empty">No charge nurses yet. Add the charge nurses on your pilot units above.</p>';
  return '<div class="head"><p class="eyebrow">' + plural(on, 'charge nurse') + ' can sign in</p><h2>Charge nurses</h2></div>' + setupNote +
    '<div class="stack">' + add + rows + '</div>' +
    '<p class="hint">Each charge nurse signs in with their own work email, so the Log shows who paged. Turning someone off signs them out everywhere.</p>' +
    (si.shared
      ? '<p class="note">The shared charge RN link (Links tab) still works too. Once your charge nurses are on this list, set Shared charge RN link to Off on the Settings tab.</p>'
      : '<p class="hint">Only the charge nurses on this list can page volunteers.</p>');
}
function viewReport() {
  var rows = ST.report.map(function (r) {
    return '<tr><td class="mono">' + esc(r.id) + '</td><td>' + esc(r.unit) + '</td><td>' + shortDate(r.start) + ' ' + t24(r.start) + '</td><td>' + (r.ended ? shortDate(r.ended) + ' ' + t24(r.ended) : '—') + '</td><td>' + esc(r.status === 'active' ? 'Active' : r.reason) + '</td><td class="num">' + r.hours.toFixed(1) + ' of ' + r.scheduled + '</td><td class="num">' + r.companions + '</td></tr>';
  }).join('');
  var feed = ST.log.map(function (e) {
    var today = dayLabel(e.at) === 'Today';
    return '<li><span class="t24">' + (today ? '' : shortDate(e.at) + ' ') + t24(e.at) + '</span><span>' + esc(e.text) + '</span></li>';
  }).join('');
  var total = ST.report.reduce(function (a, r) { return a + r.hours; }, 0);
  var vols = ST.volunteers.filter(function (v) { return v.hours.total; }).sort(function (a, b) { return b.hours.total - a.hours.total || a.name.localeCompare(b.name); });
  var sum = { vigil: 0, shifts: 0, training: 0, total: 0 };
  var hrows = vols.map(function (v) {
    var h = v.hours;
    sum.vigil += h.vigil; sum.shifts += h.shifts; sum.training += h.training; sum.total += h.total;
    return '<tr><td><button type="button" class="linkish" data-act="vol-open" data-id="' + esc(v.id) + '">' + esc(v.name) + '</button>' + (letterOpen(v) ? ' <b class="flag">letter</b>' : '') + '</td>' +
      '<td class="num">' + h.shifts + '</td><td class="num">' + esc(hrsNum(h.vigil)) + '</td><td class="num">' + esc(hrsNum(h.training)) + '</td><td class="num"><b>' + esc(hrsNum(h.total)) + '</b></td></tr>';
  }).join('');
  return '<div class="head"><p class="eyebrow">' + plural(ST.report.length, 'vigil') + ' · ' + total.toFixed(1) + ' companion hours</p><h2>Report</h2></div>' +
    (rows ? '<div class="tbl-wrap"><table><thead><tr><th>Vigil</th><th>Unit</th><th>Started</th><th>Ended</th><th>Outcome</th><th class="num">Hours covered</th><th class="num">Companions</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="empty">No vigils yet.</p>') +
    '<p class="hint">The measures the NODA Program Guide suggests tracking. The full record is in the Sheet.</p>' +
    '<h3 class="sec">Volunteer hours</h3>' +
    (hrows ? '<div class="tbl-wrap"><table class="hours"><thead><tr><th>Volunteer</th><th class="num">Shifts</th><th class="num">Bedside</th><th class="num">Training</th><th class="num">Total</th></tr></thead><tbody>' + hrows +
      '</tbody><tfoot><tr><th>All volunteers</th><th class="num">' + sum.shifts + '</th><th class="num">' + esc(hrsNum(sum.vigil)) + '</th><th class="num">' + esc(hrsNum(sum.training)) + '</th><th class="num">' + esc(hrsNum(sum.total)) + '</th></tr></tfoot></table></div>'
      : '<p class="empty">No hours yet. They start with the training day and the first vigil.</p>') +
    '<p class="hint">Total includes other NODA service. Tap a name for that volunteer’s hours or a service letter.</p>' +
    '<h3 class="sec">Activity</h3>' + (feed ? '<ul class="feed">' + feed + '</ul>' : '<p class="empty">Nothing yet.</p>');
}
function pushStatusText() {
  var d = ST.devices || { volunteers: 0, coord: 0 };
  switch (ST.pushStatus) {
    case 'on': return 'On · ' + plural(d.volunteers, 'volunteer phone');
    case 'off': return 'Off (Settings tab)';
    case 'bad': return 'Key can’t be read';
    default: return 'Not set up';
  }
}
function viewLinks() {
  var si = ST.signIn || { email: false, links: true, shared: true };
  var codes = ST.codes || { today: 0, cap: 0 };
  var rn = !si.shared
    ? '<p class="note">The shared charge RN link is off (Settings tab). Charge nurses sign in with their own email; see the Charge RNs tab.</p>'
    : ST.rnLink
    ? '<div class="linkbox"><input type="text" id="rn-link" readonly value="' + esc(ST.rnLink) + '"><div class="row"><button type="button" class="btn small" data-act="copy" data-src="rn-link">Copy link</button>' +
      (UI.confirmRn ? '' : '<button type="button" class="btn small quiet" data-act="rn-ask">Make a new charge RN link</button>') + '</div></div>' +
      (UI.confirmRn ? '<div class="confirm"><p>Make a new charge RN link? The old one stops working for every unit.</p><div class="row"><button type="button" class="btn danger" data-act="rn-new">Make new link</button><button type="button" class="btn" data-act="rn-cancel">Cancel</button></div></div>' : '')
    : '<p class="note">Paste the web app URL into cell B2 on the Settings tab of the Sheet. Links appear here after that.</p>';
  var where = !ST.appUrl
    ? 'Links open the Apps Script web app. To move everyone to the phone app, paste its address next to Phone app URL on the Settings tab.'
    : si.links ? '' : 'Emails open the phone app with no personal link in them. People sign in there with their email.';
  var appOnly = ST.volunteers.filter(function (v) { return !v.pageEmail; }).length;
  var rc = ST.receipts || { sent: 0, confirmed: 0, missed: 0 };
  var checked = rc.confirmed + rc.missed;
  return '<div class="head"><p class="eyebrow">Setup</p><h2>Links and status</h2></div>' +
    '<h3 class="sec first">Charge RN link</h3>' + rn +
    (si.shared ? '<p class="hint">Anyone with this link can page volunteers.' +
      (ST.chargeNurses ? ' To know who paged, use the Charge RNs tab instead.' : '') + '</p>' : '') +
    (where ? '<p class="hint">' + where + '</p>' : '') +
    '<h3 class="sec">Status</h3><div class="status">' +
      '<div class="row"><span>Emails left today</span><b>' + ST.emailLeft + '</b></div>' +
      '<div class="row"><span>App notifications</span><b>' + esc(pushStatusText()) + '</b></div>' +
      '<div class="row"><span>Alerts by app only</span><b>' + (appOnly ? plural(appOnly, 'volunteer') : 'None yet') + '</b></div>' +
      (checked ? '<div class="row"><span>Phone receipts</span><b>' + rc.confirmed + ' of ' + checked + ' confirmed (' + Math.round(100 * rc.confirmed / checked) + '%)</b></div>' : '') +
      '<div class="row"><span>Coordinator email</span><b>' + esc(ST.coordEmail || 'Not set') + '</b></div>' +
      (ST.signIn ? '<div class="row"><span>Email sign-in</span><b>' + (si.email ? 'On · ' + codes.today + ' of ' + codes.cap + ' codes today' : 'Off') + '</b></div>' +
        '<div class="row"><span>Links in emails</span><b>' + (si.links ? 'Personal sign-in links' : 'App address only') + '</b></div>' +
        '<div class="row"><span>Shared charge RN link</span><b>' + (si.shared ? 'On' : 'Off') + '</b></div>' : '') +
    '</div>' +
    '<p class="hint">This Google account can email 100 people a day. App notifications don’t count.' +
      (ST.signIn ? ' Sign-in codes pause when 30 or fewer emails are left, so pages still go out.' : '') + '</p>' +
    '<button type="button" class="btn" data-act="test">Send me a test email</button>' +
    (MODE === 'pwa' ? '<h3 class="sec">Notifications on this phone</h3>' + notifCard() + deviceCard() : '');
}

/* ---------- render ---------- */
// The role's color on the whole app, and on Android's status bar (version 2.4.1). '' = signed out: the usual colors.
function roleTheme(role) {
  var r = ROLE_THEME[role] ? role : '', html = document.documentElement;
  if ((html.getAttribute('data-role') || '') !== r) { if (r) html.setAttribute('data-role', r); else html.removeAttribute('data-role'); }
  var meta = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: light)"]');
  if (meta && meta.getAttribute('content') !== ROLE_THEME[r || 'vol']) meta.setAttribute('content', ROLE_THEME[r || 'vol']);
}
function render() {
  var rs = roleSwitchHTML();
  rolesEl.innerHTML = rs; rolesEl.hidden = !rs;
  roleTheme(ST && KEY ? ST.role : '');
  if (MODE === 'pwa' && !KEY) { whoEl.textContent = 'Sign in'; tabs.hidden = true; app.innerHTML = signInView(); return; }
  if (!ST) return;
  if (ST.role === 'none') { whoEl.textContent = MODE === 'pwa' ? 'Sign in' : 'Link not active'; tabs.hidden = true; app.innerHTML = noneView(); return; }
  whoEl.textContent = ST.role === 'rn' ? 'Charge RN' + (ST.name ? ' · ' + ST.name : '') : ST.role === 'coord' ? 'NODA coordinator' : 'Volunteer · ' + ST.me.name;
  if (ST.role === 'coord') { tabs.hidden = false; tabs.innerHTML = tabsHTML(); } else tabs.hidden = true;
  var html;
  if (ST.role === 'vol') html = viewVol();
  else if (ST.role === 'rn' || TAB === 'vigils') html = viewRN();
  else if (TAB === 'volunteers') html = viewVols();
  else if (TAB === 'rns' && ST.chargeNurses) html = viewRns();
  else if (TAB === 'report') html = viewReport();
  else html = viewLinks();
  app.innerHTML = html;
  placeNowMarks();
}
function go(view) { VIEW = view; UI = {}; render(); window.scrollTo(0, 0); }

/* ---------- events ---------- */
function copyText(text, input) {
  function fallback() { if (input) { input.focus(); input.select(); } toast(input ? 'Selected. Use your phone’s Copy to copy it.' : 'Couldn’t copy. Your link is in your email from the coordinator.'); }
  try { navigator.clipboard.writeText(text).then(function () { toast('Link copied'); }, fallback); } catch (e) { fallback(); }
}
var ACT = {
  tab: function (el) { TAB = el.getAttribute('data-tab'); VIEW = { name: 'home' }; UI = {}; render(); },
  home: function () { DRAFT = null; go({ name: 'home' }); },
  open: function (el) { go({ name: 'vigil', id: el.getAttribute('data-id') }); },
  'new': function () {
    DRAFT = { crit1: [], crit2: [], consent: false, unitId: ST.units[0].id, checkIn: ST.lists.checkIn[0], ppe: false, startIn: 0, windowH: 24 };
    go({ name: 'request' });
  },
  repage: function (el) { act('repage', [el.getAttribute('data-id')]); },
  extend: function (el) { act('extendVigil', [el.getAttribute('data-id'), 12]); },
  'end-ask': function (el) { UI.endAsk = el.getAttribute('data-id'); UI.reason = null; render(); },
  'end-cancel': function () { UI = {}; render(); },
  end: function (el) { var r = UI.reason; act('endVigil', [el.getAttribute('data-id'), r], function () { UI = {}; }); },
  take: function (el) {
    var vid = el.getAttribute('data-id');
    if (!UI.pickStart || !UI.pickHours) return;
    act('signUp', [vid, UI.pickStart, UI.pickHours], function (st) { VIEW = { name: 'vigil', id: vid }; UI = { justTook: st.signedUp }; window.scrollTo(0, 0); });
  },
  checkin: function (el) { act('checkIn', [el.getAttribute('data-id')]); },
  checkout: function (el) { act('checkOut', [el.getAttribute('data-id')]); },
  'release-ask': function (el) { UI.confirmRelease = el.getAttribute('data-id'); render(); },
  keep: function () { UI = {}; render(); },
  release: function (el) { act('releaseSlot', [el.getAttribute('data-id')], function () { UI = {}; }); },
  oncall: function (el) { act('setOnCall', [el.getAttribute('data-id'), el.getAttribute('data-on') === '1']); },
  sendlink: function (el) { act('sendLink', [el.getAttribute('data-id')]); },
  showlink: function (el) { var id = el.getAttribute('data-id'); UI.showLink = UI.showLink === id ? null : id; render(); },
  'reset-ask': function (el) { UI.confirmReset = el.getAttribute('data-id'); render(); },
  'reset-cancel': function () { UI.confirmReset = null; render(); },
  reset: function (el) { act('resetLink', [el.getAttribute('data-id')], function () { UI = {}; }); },
  'rn-ask': function () { UI.confirmRn = true; render(); },
  'rn-cancel': function () { UI.confirmRn = false; render(); },
  'rn-new': function () { act('newRnLink', [], function () { UI = {}; }); },
  'rn-invite': function (el) { act('inviteChargeNurse', [el.getAttribute('data-id')]); },
  'rn-onoff': function (el) { act('setChargeNurse', [el.getAttribute('data-id'), el.getAttribute('data-on') === '1']); },
  test: function () { act('sendTest', []); },
  copy: function (el) {
    var input = document.getElementById(el.getAttribute('data-src')); if (!input) return;
    copyText(input.value, input);
  },
  // phone app
  retry: function () { app.innerHTML = '<p class="empty">Loading…</p>'; load(); },
  'signin-paste': function () { SIGN = { step: 'paste', email: SIGN.email }; PASTE = {}; render(); focusField('p-link'); },
  'signin-email': function () { SIGN = { step: 'email', email: SIGN.email }; render(); focusField('s-email'); },
  'signin-restart': function () { SIGN = { step: 'email', email: SIGN.email }; render(); focusField('s-email'); },
  'signin-resend': function () { var c = document.getElementById('s-code'); if (c) SIGN.code = c.value; sendCode(SIGN.email, true); },
  'signin-role': function (el) { checkCode(el.getAttribute('data-role')); },
  'paste-clip': function () {
    try {
      navigator.clipboard.readText().then(function (t) { var i = document.getElementById('p-link'); if (i) i.value = t; trySignIn(t); },
        function () { toast('Press and hold in the box, then tap Paste.'); });
    } catch (e) { toast('Press and hold in the box, then tap Paste.'); }
  },
  'copy-mylink': function () { copyText(myLink(), null); },
  install: function () {
    var e = INSTALL.evt; if (!e) return;
    INSTALL.evt = null;
    e.prompt();
    if (e.userChoice) e.userChoice.then(function () { render(); }, function () { render(); });
  },
  'install-hide': function () { LS.set('installHide', String(Date.now())); UI.showInstall = false; render(); },
  'install-show': function () { UI.showInstall = true; render(); window.scrollTo(0, 0); },
  'push-on': function () { pushTurnOn(); },
  'push-off': function () { clearTimeout(TEST.timer); TEST = {}; pushTurnOff(); },
  'push-test': function () {
    clearTimeout(TEST.timer); TEST = {};
    act('sendTestPush', [pushSaved().id || ''], function (st) { if (st.test && st.test.canConfirm) startTestWatch(); });
  },
  // page emails, hours and letters (version 2.2)
  'pe-on': function () { act('setPageEmail', [true]); },
  'pe-on-vol': function (el) { act('pageEmailOn', [el.getAttribute('data-id')]); },
  myhours: function () { go({ name: 'myhours' }); },
  'ask-letter': function () { act('requestLetter', []); },
  'vol-open': function (el) { var id = el.getAttribute('data-id'); TAB = 'volunteers'; go({ name: 'vol', id: id }); loadDetail(id); },
  'addhours-open': function () { UI.addHours = true; UI.hDraft = null; UI.hErr = ''; UI.fix = null; render(); focusField('h-hours'); },
  'fix-open': function (el) { UI.fix = el.getAttribute('data-id'); UI.fixDraft = null; UI.fixErr = ''; UI.addHours = false; render(); focusField('x-hours'); },
  'fix-cancel': function () { UI.fix = null; UI.fixDraft = null; UI.fixErr = ''; render(); },
  'addhours-cancel': function () { UI.addHours = false; UI.hDraft = null; UI.hErr = ''; render(); },
  'bulk-open': function () { go({ name: 'bulk' }); },
  'bulk-all': function () { Array.prototype.forEach.call(app.querySelectorAll('input[name="bulkvol"]'), function (x) { x.checked = true; }); },
  'bulk-none': function () { Array.prototype.forEach.call(app.querySelectorAll('input[name="bulkvol"]'), function (x) { x.checked = false; }); },
  'letter-open': function (el) {
    var id = el.getAttribute('data-id'), d = ST.letter || {}, v = volById(id), h = v ? v.hours : {};
    go({ name: 'letter', id: id });
    loadLetter(id, { from: h.first ? isoOf(h.first) : '', to: todayISO(), salutation: 'To whom it may concern', note: '', signer: d.signer || '', title: d.title || 'NODA Lead Coordinator' });
  },
  'letter-copy': function () {
    var c = LETTER.data && LETTER.data.letter; if (!c) return;
    try { navigator.clipboard.writeText(c.text).then(function () { toast('Letter copied. Paste it into your letterhead.'); }, function () { toast('Couldn’t copy. Use Print or Email instead.'); }); }
    catch (e) { toast('Couldn’t copy. Use Print or Email instead.'); }
  },
  'letter-print': function () { try { window.print(); } catch (e) { toast('Use your browser’s Print command to print the letter.'); } },
  'letter-email': function (el) { var o = readLetterForm(); LETTER.opts = o; act('emailLetter', [el.getAttribute('data-id'), o]); },
  'addvol-open': function () { UI.addVol = true; render(); focusField('v-name'); },
  'addvol-close': function () { UI.addVol = false; render(); },
  'addrn-open': function () { UI.addRn = true; render(); focusField('n-name'); },
  'addrn-close': function () { UI.addRn = false; render(); },
  'signout-ask': function () { UI.confirmSignOut = true; render(); },
  'signout-cancel': function () { UI.confirmSignOut = false; render(); },
  signout: function () { signOut(); },
  'role-switch': function (el) { switchRoleTo(el.getAttribute('data-role')); }
};
app.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  var fn = ACT[el.getAttribute('data-act')]; if (fn) fn(el);
});
tabs.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]'); if (el) ACT.tab(el);
});
rolesEl.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  var fn = ACT[el.getAttribute('data-act')]; if (fn) fn(el);
});
app.addEventListener('change', function (e) {
  var t = e.target;
  if (t.closest('#req')) { updateReq(); return; }
  if (t.id === 'f-start') { UI.pickStart = +t.value; render(); return; }
  if (t.id === 'f-hours') { UI.pickHours = +t.value; render(); return; }
  if (t.id === 'f-avail') { act('setAvailability', [t.checked]); return; }
  if (t.id === 'f-pagemail') { act('setPageEmail', [t.checked]); return; }
  if (t.name === 'reason') { UI.reason = t.value; var b = app.querySelector('[data-act="end"]'); if (b) b.disabled = false; }
});
app.addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target;
  if (f.id === 'req') {
    readForm(f);
    if (!reqOK(DRAFT)) { updateReq(); return; }
    act('requestVigil', [DRAFT], function (st) { DRAFT = null; VIEW = { name: 'vigil', id: st.lastCreated }; UI = {}; window.scrollTo(0, 0); });
  } else if (f.id === 'addvol') {
    var p = {
      name: f.querySelector('#v-name').value, email: f.querySelector('#v-email').value,
      org: f.querySelector('#v-org').value
    };
    act('addVolunteer', [p]);
  } else if (f.id === 'addhours' || f.id === 'bulkhours') {
    var d = readHoursForm(f), bulk = f.id === 'bulkhours', vid = VIEW.id;
    UI.hDraft = d;
    UI.hErr = hoursProblem(d);
    if (UI.hErr) {
      render();
      focusField(/note/.test(UI.hErr) ? 'h-note' : /date/.test(UI.hErr) ? 'h-date' : /volunteer/.test(UI.hErr) ? 'f-bulk-0' : 'h-hours');
      return;
    }
    var o = { volIds: bulk ? d.volIds : [vid], type: d.type, date: d.date, hours: hoursNum(d), note: d.note };
    act('addHours', [o], bulk
      ? function () { VIEW = { name: 'home' }; UI = {}; window.scrollTo(0, 0); }
      : function () { UI = {}; loadDetail(vid); },
      function (m) { UI.hErr = m; });
  } else if (f.id === 'fixform') {
    var x = { id: f.getAttribute('data-id'), hours: String(f.querySelector('#x-hours').value || '').trim(), note: f.querySelector('#x-note').value };
    var forVol = VIEW.id;
    UI.fixDraft = x;
    UI.fixErr = fixProblem(x);
    if (UI.fixErr) { render(); focusField(/note/.test(UI.fixErr) ? 'x-note' : 'x-hours'); return; }
    act('fixHours', [{ id: x.id, hours: parseFloat(x.hours), note: x.note }], function () { UI = {}; loadDetail(forVol); }, function (m) { UI.fixErr = m; });
  } else if (f.id === 'letterform') {
    loadLetter(VIEW.id, readLetterForm());
  } else if (f.id === 'addrn') {
    act('addChargeNurse', [{ name: f.querySelector('#n-name').value, email: f.querySelector('#n-email').value }]);
  } else if (f.id === 'paste') {
    trySignIn(f.querySelector('#p-link').value);
  } else if (f.id === 'signin-email') {
    if (!SIGN.busy) sendCode(f.querySelector('#s-email').value, false);
  } else if (f.id === 'signin-code') {
    SIGN.code = f.querySelector('#s-code').value;
    if (!SIGN.busy) checkCode('');
  }
});

// Keep the screen fresh: every minute while visible, and whenever the app comes back to the front.
// (Not on the phone app's sign-in screen, where it would wipe a half-pasted link.)
function autoRefreshOK() { return KEY && !BUSY && !editing() && !(MODE === 'pwa' && ST && ST.role === 'none'); }
setInterval(function () { if (document.visibilityState === 'visible' && autoRefreshOK()) load(); }, 60000);
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && autoRefreshOK()) load(); });

/* ---------- start ---------- */
// The phone app reads the key from "#k=" (or "?k=") once, keeps it on this device, and cleans the address bar.
function takeFromUrl() {
  var out = { key: '', vigil: '' }, found = false;
  [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')].forEach(function (part) {
    part.split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 1) return;
      var name = kv.slice(0, i), val = kv.slice(i + 1);
      try { val = decodeURIComponent(val.replace(/\+/g, ' ')); } catch (e) { return; }
      if (name === 'k') { found = true; if (!out.key) out.key = cleanKey(val); }
      if (name === 'v') { found = true; if (!out.vigil && /^V-\d{1,9}$/.test(val)) out.vigil = val; }
    });
  });
  if (found) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* keep the address */ } }
  if (out.key.length < 16) out.key = '';
  return out;
}
function onSwMessage(e) {
  var d = (e && e.data) || {};
  if (d.type === 'noda-push' && d.kind === 'test') { if (TEST.waiting) testCheckIn(1500); return; }
  if (d.type === 'noda-push') { if (KEY && !BUSY && !editing()) load(); }
  else if (d.type === 'noda-open') { DEEP = /^V-\d{1,9}$/.test(d.vigil || '') ? d.vigil : null; if (KEY) load(); }
  else if (d.type === 'noda-resubscribe') { var s = pushSaved(); if (s.on) { s.ep = 'changed'; pushSave(s); PUSH.lastRefresh = 0; pushRefresh(); } }
}
function startPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* the app still works without it */ });
    navigator.serviceWorker.ready.then(function (r) { PUSH.reg = r; });
    navigator.serviceWorker.addEventListener('message', onSwMessage);
  }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); INSTALL.evt = e; if (ST && !editing()) render(); });
  window.addEventListener('appinstalled', function () { INSTALL.evt = null; if (ST) render(); });
  if (!CFG.apiUrl) {
    whoEl.textContent = 'Not set up yet';
    app.innerHTML = '<div class="head"><h2>Almost ready</h2></div><p class="empty">' + (CFG.urlGiven
      ? 'The Apps Script address in config.js doesn’t look right. It should start with https://script.google.com/macros/s/ and end in /exec.'
      : 'This copy of NODA Alert doesn’t know where its server is yet. Whoever set it up needs to finish config.js (phone app setup guide, part 3).') + '</p>';
    return;
  }
  var u = takeFromUrl();
  DEEP = u.vigil || null;
  if (u.key) switchKey(u.key); else KEY = cleanKey(LS.get('key'));
  if (KEY.length < 16) KEY = '';
  rolesLoad();
  // Sign-in starts with email, unless this server said email sign-in is off (then: paste a link).
  SIGN = { step: LS.get('signin') === 'link' ? 'paste' : 'email' };
  if (!KEY) { render(); return; }
  load();
}

if (MODE === 'gas') {
  if (!KEY) { ST = { role: 'none' }; render(); } else load();
} else if (MODE === 'pwa') {
  startPWA();
} else {
  whoEl.textContent = 'Not set up yet';
  app.innerHTML = '<div class="head"><h2>This is the app’s code, not the live app</h2></div>' +
    '<p class="empty">NODA Alert runs inside Google Apps Script. It starts working once it’s pasted into a Google Sheet’s Apps Script editor and deployed as a web app, as the setup guide describes. Until then, use the clickable demo to see how it works.</p>';
}
})();
