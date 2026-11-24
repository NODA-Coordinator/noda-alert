/* NODA Alert app. One file for both versions of the screen:
 *   - the phone app (web/index.html, any HTTPS static host), which talks to Apps Script with fetch()
 *   - the Apps Script web app (Index.html), which talks to Apps Script with google.script.run
 * Edit this file, then run `node tools/build.js` to refresh Index.html and web/index.html.
 * Never show or send patient names, rooms, ages or diagnoses. The server never sends any.
 */
(function () {
'use strict';
var H = 3600e3, MIN = 60e3, DAY = 24 * H;
var APP_VERSION = '2.9.1';
var FIREBASE_DIR = './vendor/firebase/12.19.0/';
var GAS = !!(window.google && google.script && google.script.run);
var MODE = GAS ? 'gas' : (document.documentElement.getAttribute('data-app') === 'pwa' ? 'pwa' : 'none');
var CFG = MODE === 'pwa' ? readConfig() : {};
var KEY = MODE === 'gas' && typeof window.NODA_KEY === 'string' ? window.NODA_KEY : '';
var ST = null, VIEW = { name: 'home' }, TAB = 'vigils', DRAFT = null, BUSY = false, UI = {};
var PASTE = {}, DEEP = null, LOADING = null;
var SIGN = { step: 'email' };   // phone app sign-in: 'email' -> 'code' (-> 'role'), or 'paste' for a link
var PUSH = { busy: false, err: '', fb: null, waiters: [], refreshing: false, sending: false, lastRefresh: 0, endpoint: '' };
var TEST = {};                   // a test notification waiting for this phone's receipt: {id, waiting, started, tries, timer} or {failed}
var DETAIL = {};                 // coordinator: one volunteer's hours and history {id, data, loading, err}
var LETTER = {};                 // coordinator: service letter {id, opts, data, loading, err}
// UI.fix: the hours entry the coordinator is fixing (its id); UI.fixDraft / UI.fixErr: what was typed, what to fix.
var INSTALL = { evt: null };
var ROLES = { key: '', list: [], who: '', at: 0 };   // version 2.4: roles this person can switch between on this phone
var ROLE_FETCH = false;
// Version 2.9.1: a role switch on its way: {to, raced}. The new role shows the moment it's tapped (its color, tabs and
// buttons, with placeholder cards) and its screen fills in when the server answers. SWITCHES counts switches started,
// so an answer that was on its way when one began is known to be for the role this phone left.
var SWITCH = null, SWITCHES = 0;
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
// Version 2.6: the Text size setting (1 to 5; 2 is the default) and the theme ('light', 'dark' or 'auto' to match
// the phone), kept on this phone. The logo's address comes from the header, so both versions use the same one.
var LOOK = { size: 2, theme: 'auto' };
var SIZE_WORD = { 1: 'smaller than default', 2: 'default', 3: 'a little larger than default', 4: 'larger than default', 5: 'largest' };
var DARK_BAR = '#0F1124';
var aaBtn = document.getElementById('aa');
var LOGO = (function () { var m = document.querySelector('.top .mark'); return m && m.getAttribute('src') ? m.getAttribute('src') : ''; })();
var ICON = {
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10v10h11V10"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3.5 20c0-3.2 2.5-5.6 5.5-5.6s5.5 2.4 5.5 5.6"/><circle cx="17" cy="9" r="2.4"/><path d="M16.2 14.4c2.6.3 4.3 2.5 4.3 5.6"/>',
  chart: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="M9 5l7 7-7 7"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  shield: '<path d="M12 3.5 5.5 6v5.2c0 4.4 2.8 7.7 6.5 9.3 3.7-1.6 6.5-4.9 6.5-9.3V6z"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  lock: '<rect x="5.5" y="11" width="13" height="9" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  letter: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="m4.5 7 7.5 6 7.5-6"/>'
};
function svg(name, cls) { return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICON[name] || '') + '</svg>'; }
// Version 2.7: motion follows the phone's Reduce Motion setting; LAST_BTN is the button just tapped (it shows a
// spinner while the server works); UPDATED means a newer version of the app is ready.
var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
var LAST_BTN = null, UPDATED = false, SCREEN = '', UPDATE_CHECK = Date.now();
// Version 2.8: the history entries this app added, so the phone's Back gesture steps back instead of closing the app:
// a tab other than the first, a screen you stepped into, the Text size screen (in that order, newest last).
// NEWPHONE: just signed in on this phone while the same sign-in is on another phone.
var NAV = { tab: false, screen: false, look: false, skip: 0, reload: false }, NEWPHONE = false;

/* ---------- version 2.7: smooth screens ---------- */
// A new screen replaces the old one; the same screen updates in place (a "morph"): only what changed is touched,
// so a refresh doesn't flash, jump or move the focus.
function screenKey() { return [ST ? ST.role : '', KEY ? 1 : 0, TAB, VIEW.name, VIEW.id || '', SIGN.step].join('|'); }
function paint(html) {
  var k = screenKey();
  if (k !== SCREEN || !app.firstChild || app.hasAttribute('aria-busy')) { app.innerHTML = html; SCREEN = k; }
  else { var t = document.createElement('template'); t.innerHTML = html; morphKids(app, t.content); }
  app.removeAttribute('aria-busy');
  placeNowMarks();
}
function sameNode(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || (a.id || '') === (b.id || '')); }
function morphKids(a, b) {
  var x = a.firstChild, y = b.firstChild;
  while (y) {
    var next = y.nextSibling;
    if (!x) a.appendChild(y);
    else if (sameNode(x, y)) { morphNode(x, y); x = x.nextSibling; }
    else { var after = x.nextSibling; a.replaceChild(y, x); x = after; }
    y = next;
  }
  while (x) { var gone = x; x = x.nextSibling; a.removeChild(gone); }
}
function morphNode(x, y) {
  if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; return; }
  var tag = x.nodeName, i, at;
  var typed = tag === 'INPUT' && x.type !== 'checkbox' && x.type !== 'radio', before = typed ? x.getAttribute('value') : null;
  for (i = x.attributes.length - 1; i >= 0; i--) { at = x.attributes[i].name; if (!y.hasAttribute(at)) x.removeAttribute(at); }
  for (i = 0; i < y.attributes.length; i++) { at = y.attributes[i]; if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value); }
  if (tag === 'INPUT') {
    if (!typed) x.checked = y.hasAttribute('checked');
    // What someone typed stays, unless the app itself put a different value there.
    else if (y.getAttribute('value') !== before && x !== document.activeElement) x.value = y.getAttribute('value') || '';
    return;
  }
  if (tag === 'TEXTAREA') { if (x.defaultValue !== y.textContent && x !== document.activeElement) { x.defaultValue = y.textContent; x.value = y.textContent; } return; }
  morphKids(x, y);
  if (tag === 'SELECT' && x !== document.activeElement) { var o = y.querySelector('option[selected]'); if (o) x.value = o.value; }
}
// Moving between screens: a short slide (forward, back) or fade (tabs) where the browser can, nothing at all
// with Reduce Motion on. The state changes before this is called; fn only draws it.
function navigate(dir, fn) {
  var html = document.documentElement;
  if (!document.startViewTransition || REDUCED || document.visibilityState !== 'visible' || html.hasAttribute('data-nav')) { fn(); return; }
  html.setAttribute('data-nav', dir);
  var done = function () { html.removeAttribute('data-nav'); };
  // A turn of the phone mid-slide skips the slide (the screen still changes); catching ready keeps that out of the console.
  try { var t = document.startViewTransition(fn); t.ready.catch(function () {}); t.finished.then(done, done); } catch (e) { done(); fn(); }
}

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
// Version 2.9: every time is shown in the hospital's time zone (ST.tz from the server), whatever the phone is set to.
// zp(ts) = that time's parts there: {y, mo, d, h, mi, wd}.
var TZF = {}, WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function zp(ts) {
  var tz = ST && ST.tz, f = tz ? TZF[tz] : null;
  if (tz && f === undefined) {
    try { f = TZF[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' }); }
    catch (e) { f = TZF[tz] = null; }
  }
  if (!f) { var d = new Date(ts); return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), wd: d.getDay() }; }
  var o = {};
  f.formatToParts(new Date(ts)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, wd: WD.indexOf(o.weekday) };
}
// "Times are Central time (CST)." when the phone is set to another time zone, so nobody is an hour off.
function tzNote() {
  try {
    if (!ST || !ST.tz || Intl.DateTimeFormat().resolvedOptions().timeZone === ST.tz) return '';
    var z = new Intl.DateTimeFormat('en-US', { timeZone: ST.tz, timeZoneName: 'short' }).formatToParts(new Date()).filter(function (p) { return p.type === 'timeZoneName'; })[0];
    return '<p class="hint tznote">Times are the hospital’s time' + (z ? ' (' + esc(z.value) + ')' : '') + ', not your phone’s.</p>';
  } catch (e) { return ''; }
}
// On the two nights a year the clocks change, a time near the change carries its zone ("1:30 AM CDT", "1:30 AM CST"),
// so the two 1:30 AMs can be told apart. '' the rest of the year. Worked out once per hour of time.
var TZN = {}, TZC = {};
function zoneTag(ts) {
  var tz = ST && ST.tz;
  if (!tz) return '';
  var k = tz + Math.floor(ts / H);
  if (TZC[k] !== undefined) return TZC[k];
  var f = TZN[tz];
  if (f === undefined) { try { f = TZN[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }); } catch (e) { f = TZN[tz] = null; } }
  var z = function (t) { var p = f.formatToParts(new Date(t)).filter(function (x) { return x.type === 'timeZoneName'; })[0]; return p ? p.value : ''; };
  var tag = '';
  if (f) { var a = z(ts - 3 * H), b = z(ts + 3 * H); if (a && b && a !== b) tag = ' ' + z(ts); }
  return (TZC[k] = tag);
}
function t24(ts) { var d = zp(ts); return pad(d.h) + pad(d.mi) + zoneTag(ts); }
// "2 PM", "2:30 PM"; t12p gives the parts, so a range can say AM or PM once.
function t12p(ts) { var d = zp(ts), h = d.h; return { n: (h % 12 || 12) + (d.mi ? ':' + pad(d.mi) : ''), ap: h < 12 ? 'AM' : 'PM', z: zoneTag(ts) }; }
function t12(ts) { var p = t12p(ts); return p.n + ' ' + p.ap + p.z; }
function rangeJoin(a, b, mid) { var A = t12p(a), B = t12p(b); return A.ap === B.ap && !A.z && !B.z ? A.n + mid + B.n + ' ' + B.ap : A.n + ' ' + A.ap + A.z + mid + B.n + ' ' + B.ap + B.z; }
function r12(a, b) { return rangeJoin(a, b, '–'); }
function r24(a, b) { return t24(a) + '–' + t24(b); }
// The day a time falls on, as a number that only compares and subtracts (whole days apart): the UTC midnight of that
// date in the hospital's time zone.
function midnight(ts) { var d = zp(ts); return Date.UTC(d.y, d.mo - 1, d.d); }
function dayLabel(ts) {
  var diff = Math.round((midnight(ts) - midnight(Date.now())) / DAY);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Tomorrow'; if (diff === -1) return 'Yesterday';
  var d = zp(ts);
  return WD[d.wd] + ', ' + d.mo + '/' + d.d;
}
// "today", "tomorrow", or "Sun, 11/1" (a weekday keeps its capital).
function dayWord(ts) { var d = dayLabel(ts); return /^(Today|Tomorrow|Yesterday)$/.test(d) ? d.toLowerCase() : d; }
function shortDate(ts) { var d = zp(ts); return d.mo + '/' + d.d; }
function longDate(ts) { var d = zp(ts); return MONTHS[d.mo - 1] + ' ' + d.d + ', ' + d.y; }
function medDate(ts) { var d = zp(ts); return MONTHS[d.mo - 1].slice(0, 3) + ' ' + d.d + ', ' + d.y; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
// 4.5, 38, -0.5 (one decimal at most), and "4.5 hours" / "1 hour"
function hrsNum(n) { var r = Math.round((+n || 0) * 10) / 10; return (r < 0 ? '−' : '') + (Math.abs(r) % 1 ? Math.abs(r).toFixed(1) : String(Math.abs(r))); }
function hrsTxt(n) { var r = Math.round((+n || 0) * 10) / 10; return hrsNum(n) + (Math.abs(r) === 1 ? ' hour' : ' hours'); }
function isoOf(ts) { var d = zp(ts); return d.y + '-' + pad(d.mo) + '-' + pad(d.d); }
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
// "Good morning", "Good afternoon", "Good evening"
function greeting() { var h = zp(Date.now()).h; return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
// "Sam O." -> "SO", "Maria Keller" -> "MK"
function initials(n) {
  var p = String(n || '').replace(/[^A-Za-zÀ-ɏ\s'-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase() || '?';
}
// The way the server writes a time in a page: "3:30 PM", "12:00 PM".
function hmm(ts) { var d = zp(ts), h = d.h, ap = h < 12 ? 'AM' : 'PM'; return (h % 12 || 12) + ':' + pad(d.mi) + ' ' + ap + zoneTag(ts); }
// "2 to 4 PM", "11 PM to 1 AM"
function fromTo(a, b) { return rangeJoin(a, b, ' to '); }
// Version 2.9: a stretch that ends on another day names that day: "2–6 PM", "10:30 PM to 8:30 PM tomorrow".
// An end at exactly midnight counts as the same day ("11 PM–12 AM").
function endsOtherDay(a, b) { return midnight(b - 1) !== midnight(a); }
function span12(a, b) { return endsOtherDay(a, b) ? t12(a) + ' to ' + t12(b) + ' ' + dayWord(b) : r12(a, b); }
// "until 6 PM", or "until 2 AM tomorrow" when it ends on another day than today.
function until12(b, now) { return 'until ' + t12(b) + (endsOtherDay(now, b) ? ' ' + dayWord(b) : ''); }
// A stretch of open hours, by when it starts: "This afternoon", "Tonight", "Overnight", "Tomorrow morning", "Sun, 11/29 evening".
function partLabel(t, now) {
  if (t <= now) return 'Open now';
  var h = zp(t).h, diff = Math.round((midnight(t) - midnight(now)) / DAY);
  var part = h < 5 ? 'overnight' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  if (diff === 0) return { overnight: 'Overnight', morning: 'This morning', afternoon: 'This afternoon', evening: 'This evening', night: 'Tonight' }[part];
  if (diff === 1 && part === 'overnight') return 'Overnight';
  var day = diff === 1 ? 'Tomorrow' : dayLabel(t);
  return day + ' ' + (part === 'overnight' ? 'early morning' : part);
}

/* ---------- version 2.6: Text size and theme ---------- */
function lookLoad() {
  var s = Math.round(+(LS.get('textSize') || 2));
  LOOK.size = s >= 1 && s <= 5 ? s : 2;
  var t = LS.get('theme');
  LOOK.theme = t === 'light' || t === 'dark' ? t : 'auto';
  applyLook();
}
function applyLook() {
  var h = document.documentElement;
  h.setAttribute('data-ts', String(LOOK.size));
  if (typeof fitHeader === 'function') fitHeader();
  if (LOOK.theme === 'auto') h.removeAttribute('data-theme'); else h.setAttribute('data-theme', LOOK.theme);
  barColors(h.getAttribute('data-role') || '');
}
// The phone's status bar: the role's color in light, navy in dark.
function barColors(role) {
  var col = ROLE_THEME[role] || ROLE_THEME.vol;
  var light = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: light)"]');
  var dark = document.querySelector('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]');
  var a = LOOK.theme === 'dark' ? DARK_BAR : col, b = LOOK.theme === 'light' ? col : DARK_BAR;
  if (light && light.getAttribute('content') !== a) light.setAttribute('content', a);
  if (dark && dark.getAttribute('content') !== b) dark.setAttribute('content', b);
}
function sizeText(s) { return 'Size ' + s + ' of 5: ' + SIZE_WORD[s]; }
function setSize(n) {
  n = Math.max(1, Math.min(5, Math.round(+n || 2)));
  LOOK.size = n; LS.set('textSize', String(n)); applyLook(); lookRefresh();
}
function setTheme(t) {
  LOOK.theme = t === 'light' || t === 'dark' ? t : 'auto';
  if (LOOK.theme === 'auto') LS.del('theme'); else LS.set('theme', LOOK.theme);
  applyLook();
}
// Update the Text size screen in place, so the slider and buttons keep focus.
function lookRefresh() {
  var r = document.getElementById('ts-range'), s = LOOK.size;
  if (r) { if (+r.value !== s) r.value = String(s); r.setAttribute('aria-valuetext', sizeText(s)); r.style.setProperty('--p', ((s - 1) * 25) + '%'); }
  var now = document.getElementById('ts-now'); if (now) now.textContent = sizeText(s);
  var dn = app.querySelector('[data-act="ts-down"]'), up = app.querySelector('[data-act="ts-up"]');
  if (dn) dn.disabled = s <= 1;
  if (up) up.disabled = s >= 5;
}
function openLook() {
  if (VIEW.name === 'textsize') return;
  if (VIEW.name === 'request' && DRAFT) { var f = document.getElementById('req'); if (f) readForm(f); }
  VIEW = { name: 'textsize', back: VIEW, backUI: UI, y: window.scrollY || 0 };
  UI = {};
  navPush('look');
  navigate('forward', function () {
    render(); window.scrollTo(0, 0);
    var h = app.querySelector('h2'); if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) { /* no focus */ } }
  });
}
function closeLook() {
  var v = VIEW.name === 'textsize' ? VIEW : null;
  // Version 2.8: leave through history when the Text size screen added an entry (popstate comes back here).
  if (v && navPop('look')) return;
  VIEW = v && v.back ? v.back : { name: 'home' }; UI = v && v.backUI ? v.backUI : {};
  navigate('back', function () {
    render(); window.scrollTo(0, v ? v.y : 0);
    if (aaBtn) { try { aaBtn.focus({ preventScroll: true }); } catch (e) { /* no focus */ } }
  });
}
function lookView() {
  var s = LOOK.size;
  var themes = [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match my phone']].map(function (t) {
    var id = 'th-' + t[0];
    return '<label class="th th-' + t[0] + '" for="' + id + '"><input type="radio" name="theme" id="' + id + '" value="' + t[0] + '"' + (LOOK.theme === t[0] ? ' checked' : '') + '>' +
      '<span class="thbox"><span class="tsw" aria-hidden="true"><i></i><i></i></span>' + t[1] + '</span></label>';
  }).join('');
  return '<div class="sheet-hd"><h2>Text size and theme</h2><button type="button" class="pillbtn close" data-act="look-close">' + svg('close') + 'Close</button></div>' +
    '<p class="lede">Choose what is easiest for you to read. This phone remembers it.</p>' +
    '<section class="card">' +
      '<label class="lab2" for="ts-range">Text size</label>' +
      '<div class="sl"><span class="sa" aria-hidden="true">A</span><div class="slw">' +
        '<input type="range" id="ts-range" class="range" min="1" max="5" step="1" value="' + s + '" aria-valuetext="' + esc(sizeText(s)) + '" data-fill="' + ((s - 1) * 25) + '">' +
        '<div class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><span class="defl" aria-hidden="true">Default</span></div>' +
      '<span class="sA" aria-hidden="true">A</span></div>' +
      '<p class="tsnow" id="ts-now">' + esc(sizeText(s)) + '</p>' +
      '<div class="btns2"><button type="button" class="btn outline" data-act="ts-down"' + (s <= 1 ? ' disabled' : '') + '>Smaller</button>' +
      '<button type="button" class="btn outline" data-act="ts-up"' + (s >= 5 ? ' disabled' : '') + '>Larger</button></div>' +
    '</section>' +
    '<p class="lab">Preview</p>' +
    '<div class="prev" aria-hidden="true"><p class="h2">A patient needs company.</p><p class="sub">12 hours are still open.</p><span class="pri">Sit 2–4 PM today</span></div>' +
    '<section class="card"><fieldset><legend class="lab2">Theme</legend><div class="themes">' + themes + '</div></fieldset></section>' +
    '<div class="more"><button type="button" class="btn primary big block" data-act="look-close">Done</button></div>';
}

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
// Version 2.9: a request that hasn't answered in 45 seconds stops, so the screen never waits forever on a weak
// connection. (A page sent again after that is safe: its request ID makes the server send it only once.)
function apiCall(fn, args, key) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, 45000) : null;
  var done = function () { if (timer) clearTimeout(timer); };
  return fetch(CFG.apiUrl, {
    method: 'POST', redirect: 'follow', credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fn, key: key, args: args || [] }),
    signal: ctl ? ctl.signal : undefined
  }).then(function (res) {
    return res.text().then(function (t) {
      done();
      var j = null;
      try { j = JSON.parse(t); } catch (e) { j = null; }
      if (!j || typeof j !== 'object') {
        throw new Error(res.ok ? 'NODA Alert’s server answered in an unexpected way. The coordinator may need to deploy the newest Code.gs.'
          : 'NODA Alert’s server isn’t answering (' + res.status + '). Try again in a minute.');
      }
      if (j.ok !== true) throw new Error(j.error || 'Something went wrong. Try again.');
      return j.data;
    }, function () { done(); throw new Error('Couldn’t reach NODA Alert. Check your connection and try again.'); });
  }, function () { done(); throw new Error('Couldn’t reach NODA Alert. Check your connection and try again.'); });
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
  var k = KEY, n = SWITCHES;
  // Version 2.9.1: an answer that comes back after a role switch began is for the role this phone left, so it isn't drawn.
  var old = function () { return k !== KEY || n !== SWITCHES || !!SWITCH; };
  LOADING = call('getState', []).then(function (st) { if (old()) return; ST = st; render(); afterLoad(); }, function (err) {
    if (old()) return;
    if (ST) { toast(err && err.message ? err.message : 'Couldn’t refresh. Try again.'); return; }
    app.innerHTML = '<p class="empty">Couldn’t reach NODA Alert. Check your connection and reload. ' + esc(err && err.message ? '(' + err.message + ')' : '') + '</p>' +
      (MODE === 'pwa' ? '<p><button type="button" class="btn" data-act="retry">Try again</button></p>' : '');
  }).then(function () { LOADING = null; });
  return LOADING;
}
function act(fn, args, after, onErr) {
  if (BUSY) return;
  BUSY = true; document.body.classList.add('busy');
  var btn = LAST_BTN; LAST_BTN = null;
  if (btn && btn.isConnected && btn.tagName === 'BUTTON') { btn.classList.add('pending'); btn.setAttribute('aria-busy', 'true'); }
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
  return VIEW.name === 'request' || VIEW.name === 'letter' || VIEW.name === 'bulk' || VIEW.name === 'textsize' || UI.addHours || UI.fix || UI.addVol || UI.addRn ||
    UI.endAsk || UI.confirmRelease || UI.confirmReset || UI.confirmRn || UI.confirmSignOut || UI.confirmPause || UI.confirmOthers ||
    UI.confirmOut || UI.confirmRemove || UI.confirmClear ||
    (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'radio');
}
// Version 2.8: a page notification opens the sign-up at Check and confirm with the suggested time chosen, the
// same as the home screen's big button, so Sign up is on the first screen.
function openSignup(id) {
  var v = vigilById(id), best = v ? bestOption(signupOptions(v, Date.now())) : null;
  VIEW = { name: 'vigil', id: id };
  UI = best ? { pickStart: best.t, pickHours: best.h } : {};
  navPush('screen');
  navigate('forward', function () { render(); showConfirm(); });
}
function showConfirm() {
  var c = document.getElementById('confirm');
  if (!c) { window.scrollTo(0, 0); return; }
  placeConfirm(c);
  try { c.focus({ preventScroll: true }); } catch (e) { /* no focus */ }
  keepConfirm(c);
}
// The whole box in the middle of the screen when it fits; when it doesn't (large text on a small phone),
// its Sign up button just above the bottom edge.
function placeConfirm(c) {
  var b = c.querySelector('[data-act="take"]') || c, room = window.innerHeight - (parseFloat(document.documentElement.style.scrollPaddingBottom) || 0);
  var r = c.getBoundingClientRect(), y = r.height + 32 <= room ? r.top - (room - r.height) / 2 : b.getBoundingClientRect().bottom + 16 - room;
  if (Math.abs(y) >= 1) window.scrollTo(0, Math.max(0, (window.scrollY || 0) + y));
}
// The app's fonts can arrive a moment later and move things: keep the box in place for a few seconds,
// until the person touches the screen, scrolls or types.
var KEEP_CONFIRM = null;
function keepConfirm(c) {
  if (KEEP_CONFIRM) KEEP_CONFIRM();
  if (typeof ResizeObserver !== 'function') return;
  var evs = ['touchstart', 'pointerdown', 'wheel', 'keydown'], timer;
  var ro = new ResizeObserver(function () { if (document.getElementById('confirm') === c) placeConfirm(c); else stop(); });
  function stop() {
    ro.disconnect(); clearTimeout(timer); KEEP_CONFIRM = null;
    evs.forEach(function (e) { window.removeEventListener(e, stop, true); });
  }
  KEEP_CONFIRM = stop;
  timer = setTimeout(stop, 4000);
  evs.forEach(function (e) { window.addEventListener(e, stop, true); });
  ro.observe(app);
  if (aaBtn && aaBtn.parentNode) ro.observe(aaBtn.parentNode);
}
// Version 2.9: what a tapped notification opens. A page or open-hour alert opens the sign-up; a reminder, a late
// check-in or a canceled shift opens the volunteer's home screen, where that shift is first. Since server 2.7 a phone
// gets every notice its person is due in any mode, so a notice for another mode switches to it first: a volunteer's
// alert to Volunteer, a nurse's or coordinator's notice from Volunteer to Charge nurse or Coordinator.
var KIND_ROLE = { 'new': 'vol', repage: 'vol', gap: 'vol', remind: 'vol', late: 'vol', cancel: 'vol', thanks: 'vol',
  'rn-signup': 'rn', 'rn-late': 'rn', endsoon: 'rn', escalate: 'rn', coord: 'coord' };
var SIGNUP_KINDS = { 'new': 1, repage: 1, gap: 1 };
function deepRole(kind) {
  var want = KIND_ROLE[kind];
  if (!want || !ST) return '';
  if (want === 'vol') return ST.role !== 'vol' && hasRole('vol') ? 'vol' : '';
  if (ST.role !== 'vol') return '';
  var other = want === 'rn' ? 'coord' : 'rn';
  return hasRole(want) ? want : hasRole(other) ? other : '';
}
function afterLoad() {
  if (DEEP && ST && ST.role !== 'none') {
    var d = DEEP, to = MODE === 'pwa' && !d.tried ? deepRole(d.kind) : '';
    if (to) { d.tried = true; switchRoleTo(to); return; }
    DEEP = null;
    if (d.vigil && vigilById(d.vigil)) {
      if (ST.role === 'coord') TAB = 'vigils';
      if (ST.role !== 'vol') go({ name: 'vigil', id: d.vigil });
      else if (!d.kind || SIGNUP_KINDS[d.kind]) openSignup(d.vigil);
      else { TAB = 'vigils'; if (VIEW.name !== 'home') go({ name: 'home' }, 'back'); else window.scrollTo(0, 0); }
    }
  }
  if (MODE === 'pwa' && Date.now() - PUSH.lastRefresh > 6 * H) pushRefresh();
  if (MODE === 'pwa' && KEY && ST && ST.role !== 'none' && (ROLES.key !== KEY || Date.now() - ROLES.at > 15 * MIN)) fetchRoles();
}

/* ---------- data ---------- */
// A vigil covers windowH whole hours from its start. Sign-ups (ST.slots) cover some of them; the rest are open.
function vigilById(id) { for (var i = 0; i < ST.vigils.length; i++) if (ST.vigils[i].id === id) return ST.vigils[i]; return null; }
function vEnd(v) { return v.end || v.start + (v.windowH || 0) * H; }
function signupsOf(v) { return ST.slots.filter(function (s) { return s.vigilId === v.id; }).sort(function (a, b) { return a.start - b.start; }); }
// Version 2.9, as the server counts it: a volunteer is due at the start of their hours (or 30 minutes after signing up
// for hours under way). LATE_SHOW after that with no check-in they show as not checked in, and the nurse is asked;
// LATE_OPEN after it their hours count as open again.
var LATE_SHOW = 5 * MIN, LATE_OPEN = 20 * MIN;
function dueOf(s) { return s.due || s.start; }
function isLate(s, now) { return !s.inAt && !s.outAt && s.start <= now && now < s.end && now >= dueOf(s) + LATE_SHOW; }
// Whether sign-up s holds the hour that starts at t: hours that have passed, whoever signed up; the hour under way,
// while they're checked in or not yet LATE_OPEN past due; later hours, unless they checked out (left early).
function holds(s, t, now) {
  if (!(s.start <= t && t < s.end)) return false;
  if (t + H <= now) return true;
  if (s.outAt) return false;
  return t > now || !!s.inAt || now < dueOf(s) + LATE_OPEN;
}
// The sign-up holding the hour at t (with now), or any sign-up for it (without: an ended vigil's record).
function whoAt(list, t, now) {
  for (var i = 0; i < list.length; i++) if (now === undefined ? list[i].start <= t && t < list[i].end : holds(list[i], t, now)) return list[i];
  return null;
}
function signupState(v, s, now) {
  if (v.status !== 'active') return s.start >= v.ended ? 'cancelled' : 'done';
  if (s.outAt || s.end <= now) return 'done';
  if (s.start <= now) return s.inAt ? 'bedside' : now >= dueOf(s) + LATE_SHOW ? 'late' : 'due';
  return 'taken';
}
// Sign-ups whose volunteer hasn't checked in, LATE_SHOW or more past due (the nurse is asked about them).
function lateOf(v, now) { return v.status === 'active' ? signupsOf(v).filter(function (s) { return isLate(s, now); }) : []; }
// One cell per hour of the vigil: {start, end, s (the sign-up covering it, if any), st (its state)}.
function cells(v, now) {
  var list = signupsOf(v), out = [], end = vEnd(v);
  for (var t = v.start; t < end; t += H) {
    var s = v.status === 'active' ? whoAt(list, t, now) : whoAt(list, t), st;
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
// Styles that come from data (the "now" line, a block's width, the slider's fill) are set here, after each
// render: the phone app's Content Security Policy doesn't allow style attributes in the HTML.
function placeNowMarks() {
  Array.prototype.forEach.call(app.querySelectorAll('[data-p]'), function (m) { m.style.left = m.getAttribute('data-p') + '%'; });
  Array.prototype.forEach.call(app.querySelectorAll('[data-w]'), function (m) { m.style.flexGrow = m.getAttribute('data-w'); });
  Array.prototype.forEach.call(app.querySelectorAll('[data-fill]'), function (m) { m.style.setProperty('--p', m.getAttribute('data-fill') + '%'); });
}
// Version 2.6: the vigil as a row of hours. Covered in green, open outlined in amber, the volunteer's own hours in
// their color, not covered in red; hours that have passed are faded. The sentence above it says the same in words.
function ribbon(v, s, now) {
  var me = ST.me ? ST.me.id : null, vol = ST.role === 'vol', mine = false, missed = false;
  var segs = s.cells.map(function (x) {
    var c;
    if (x.st === 'cancelled') c = 'c';
    else if (x.s) { c = me && x.s.vol === me ? 'y' : 'f'; if (c === 'y') mine = true; }
    else if (x.st === 'missed') { c = 'm'; missed = true; }
    else c = 'o';
    if (x.end <= now && c !== 'm') c += ' d';
    return '<i class="' + c + '"></i>';
  }).join('');
  var mark = '', n = s.cells.length;
  if (v.status === 'active' && n) {
    var p = (now - v.start) / (vEnd(v) - v.start);
    if (p >= 0 && p <= 1) mark = '<b class="nowmark" data-p="' + (p * 100).toFixed(2) + '"></b>';
  }
  var tick = function (k) { var t = v.start + Math.round(n * k / 4) * H; return vol ? t12(t) : t24(t); };
  return '<div class="ribbon' + (n > 36 ? ' dense' : '') + '" aria-hidden="true">' + segs + mark + '</div>' +
    '<div class="ticks" aria-hidden="true"><span>' + tick(0) + '</span><span class="t2">' + tick(1) + '</span><span>' + tick(2) + '</span><span class="t4">' + tick(3) + '</span><span>' + tick(4) + '</span></div>' +
    '<div class="legend" aria-hidden="true"><span><i class="f"></i>Covered</span><span><i class="o"></i>Open</span>' +
      (mine ? '<span><i class="y"></i>You</span>' : '') + (missed ? '<span><i class="m"></i>Not covered</span>' : '') + '</div>';
}
// The next 12 hours of a vigil as labeled blocks: who's there, and what's open.
function lane(v, now) {
  var from = now <= v.start ? v.start : v.start + Math.floor((now - v.start) / H) * H, to = Math.min(vEnd(v), from + 12 * H);
  if (to <= from) return '';
  var blocks = segments(v, now).map(function (g) {
    var a = Math.max(g.start, from), b = Math.min(g.end, to), h = Math.round((b - a) / H);
    if (h <= 0) return '';
    var cls = g.s ? 'lb' : g.st === 'missed' ? 'lb mi' : g.st === 'cancelled' ? 'lb mi' : 'lb op';
    var label = g.s ? (h >= 3 ? g.s.volName : initials(g.s.volName)) : g.st === 'missed' ? '—' : (h >= 3 ? 'Open ' + h + ' h' : h + ' h');
    var short = g.s ? initials(g.s.volName) : g.st === 'missed' ? '—' : h + ' h';
    // The long label, and a short one for the largest text sizes (app.css shows one of them).
    return '<span class="' + cls + '" data-w="' + h + '"><span class="ll">' + esc(label) + '</span><span class="ls">' + esc(short) + '</span></span>';
  }).join('');
  var span = to - from, p = (now - from) / span;
  var mark = p >= 0 && p <= 1 ? '<b class="nowmark" data-p="' + (p * 100).toFixed(2) + '"></b>' : '';
  var tick = function (k) { return t24(from + Math.round(span / H * k / 4) * H); };
  return '<span class="lane" aria-hidden="true">' + blocks + mark + '</span>' +
    '<span class="axis" aria-hidden="true"><span>' + tick(0) + '</span><span class="t2">' + tick(1) + '</span><span>' + tick(2) + '</span><span class="t4">' + tick(3) + '</span><span>' + tick(4) + '</span></span>';
}
function vigilCard(v, mode, now) {
  var s = stats(v, now), meta, late = lateOf(v, now);
  // Version 2.9: the end reason only when the server sends it (coordinators); warnings first.
  if (v.status !== 'active') meta = '<span>Ended ' + t24(v.ended) + (v.reason ? ' · ' + esc(v.reason) : '') + '</span>';
  else meta = (noPhones(v) ? '<span class="warn">The page reached no phone</span>' : '') +
    (late.length ? '<span class="warn">Not checked in: ' + esc(late.map(function (x) { return x.volName; }).join(', ')) + '</span>' : '') +
    '<span>Next 12 h: ' + plural(s.open12, 'open hour') + '</span>' + (s.gap ? '<span class="warn">' + (s.gap.start <= now ? 'Open now' : 'Gap at ' + t24(s.gap.start)) + '</span>' : '<span>Fully covered</span>');
  return '<button type="button" class="card card-btn vcard" data-act="open" data-id="' + esc(v.id) + '">' +
    '<span class="rw"><span class="unit">' + esc(v.unitName) + (v.practice ? ' <span class="chip practice">Practice</span>' : '') + '</span><span class="vid">' + esc(v.id) + '</span></span>' +
    (v.status === 'active' ? '<span class="lanehd"><span>Next 12 hours</span><span>Now ' + t24(now) + '</span></span>' + lane(v, now) : '') +
    '<span class="meta">' + meta + '</span></button>';
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
  // Version 2.8: on iPhone, a sign-in in Safari doesn't carry over to the Home Screen app, so say "Home Screen first".
  var iosFirst = MODE === 'pwa' && isIOS() && !standalone()
    ? '<div class="note"><p class="m0"><b>On iPhone, add NODA to your Home Screen first.</b> Tap Share ' + SHARE_ICON + ', then Add to Home Screen. Open NODA from your Home Screen and sign in there. A sign-in here in Safari doesn’t carry over.</p></div>' : '';
  return (reason === 'revoked' ? '<p class="note">You’ve been signed out on this phone. Sign in again to keep using NODA Alert.</p>' : '') +
    '<div class="head"><p class="eyebrow">Sign in</p><h2>Sign in to NODA Alert</h2></div>' + iosFirst +
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
  apiCall('requestCode', [email], '').then(function (r) {
    // Version 2.8: NODA has used up today's sign-in emails. Say so instead of waiting for a code that won't come.
    if (r && r.paused) { SIGN.err = 'NODA has sent all the sign-in emails it can for today. Try again tomorrow.'; return; }
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
    NEWPHONE = true; keepStorage();
    rolesSave(r.roles, r.who);
    LS.del('signin');
    toast(signedInText(ST));
    afterLoad();
  }, function (err) {
    SIGN.err = (err && err.message) || 'Couldn’t check that code. Try again.';
    SIGN.step = 'code';
  }).then(function () {
    SIGN.busy = false; render();
    if (SIGN.step === 'code' && SIGN.err) focusField('s-code');
    else if (KEY && ST && SIGN.step === 'email') window.scrollTo(0, 0); // signed in: Home from the top
  });
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
// Version 2.8: ask the browser to keep NODA's storage (the sign-in) when the phone runs low on space. Chrome and
// Safari decide without asking; Firefox would show a question, so it is skipped there.
function keepStorage() {
  try {
    if (MODE !== 'pwa' || !navigator.storage || !navigator.storage.persist || /Firefox/i.test(navigator.userAgent)) return;
    navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); }).catch(function () { /* fine either way */ });
  } catch (e) { /* not available */ }
}
// moved: the server already moved this phone's notifications to the new sign-in (a role switch, server 2.7.1).
function switchKey(k, moved) {
  var old = KEY || cleanKey(LS.get('key'));
  if (old && old !== k && !moved) {
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
    LS.del('key'); LS.del('push'); LS.del('lastRole'); rolesClear();
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
// Version 2.5: alerts go to phones only (Alert emails Off on the Settings tab). Older servers leave alertEmails out.
function appOnly() { return !!(ST && ST.alertEmails === false); }
// How many on-call volunteers a page reaches: with alerts by app only, those with a phone getting NODA notifications.
function reachN() { return ST.reach !== undefined ? ST.reach : ST.onCall; }
function hasRole(role) { return ROLES.key === KEY && ROLES.list.some(function (r) { return r.role === role; }); }
function roleSwitchHTML() {
  if (MODE !== 'pwa' || !KEY || !ST || ST.role === 'none' || ROLES.key !== KEY || ROLES.list.length < 2) return '';
  return '<span class="roles-label" id="roles-label">Use NODA as</span>' +
    '<div class="roles-seg" role="group" aria-labelledby="roles-label">' + ROLES.list.map(function (r) {
      // (Not disabled while the server works: the screen drew then stayed that way after the answer, in 2.6.
      // switchRoleTo already waits its turn, and taps are held off while busy.)
      return '<button type="button" class="rolebtn" data-act="role-switch" data-role="' + esc(r.role) + '" aria-pressed="' + (r.role === (SWITCH ? SWITCH.to : ST.role)) + '">' +
        esc(ROLE_SHORT[r.role]) + '</button>';
    }).join('') + '</div>';
}
// Version 2.9.1: one request. The tapped role shows at once; the server switches and, when notifications are on, moves
// this phone's notifications to the new role in the same request (an older server leaves that to the phone, as before).
function switchRoleTo(role) {
  if (BUSY || SWITCH || !ST || !KEY || role === ST.role) return;
  if (PUSH.busy) { toast('One moment: notifications are still being set up on this phone.'); return; }
  var k = KEY, s = pushSaved();
  var dev = s.on && s.id ? { pushId: s.id, platform: platformLabel() } : null;
  SWITCHES++;
  SWITCH = { to: role, raced: !!PUSH.sending };
  clearTimeout(TEST.timer);
  BUSY = true; document.body.classList.add('busy');
  navigate('tab', function () { render(); window.scrollTo(0, 0); });
  apiCall('switchRole', [ROLES.who, role, dev], k).then(function (r) {
    if (!r || !r.key || !r.state || r.state.role === 'none') throw new Error('Couldn’t switch. Try again.');
    var moved = !!(dev && r.device && r.device.moved);
    switchKey(r.key, moved);
    // A registration for the role it left was on its way when the switch began: register this phone again.
    if (moved && (SWITCH.raced || PUSH.sending)) { s = pushSaved(); if (s.on && s.id) { s.at = 0; pushSave(s); } PUSH.lastRefresh = 0; }
    SWITCH = null;
    ST = r.state; rolesSave(r.roles, r.who || ROLES.who);
    if (VIEW.name === 'textsize') { VIEW.back = { name: 'home' }; VIEW.backUI = {}; VIEW.y = 0; } else VIEW = { name: 'home' };
    TAB = 'vigils'; UI = {}; DETAIL = {}; LETTER = {}; DRAFT = null; TEST = {};
    BUSY = false; document.body.classList.remove('busy');
    render(); window.scrollTo(0, 0);
    toast('You’re using NODA as ' + ROLE_WORD[ST.role] + '.');
    afterLoad();
  }, function (err) {
    SWITCH = null;
    BUSY = false; document.body.classList.remove('busy');
    if (TEST.waiting) testCheckIn(1000);
    navigate('tab', function () { render(); window.scrollTo(0, 0); });
    toast((err && err.message) || 'Couldn’t switch. Try again.');
    ROLES.at = 0; fetchRoles();
  });
}
// While a switch is on its way: the new role's title, tabs and placeholder cards.
function switchingView(rolesShown) {
  var to = SWITCH.to, withTabs = to === 'vol' || to === 'coord';
  whoEl.textContent = roleTitle(to); whoEl.hidden = rolesShown;
  if (withTabs) { tabs.innerHTML = tabsHTML(to, 'vigils'); tabs.hidden = false; } else { tabs.hidden = true; tabs.innerHTML = ''; }
  document.body.classList.toggle('has-tabs', withTabs);
  if (SCREEN === 'switch|' + to && app.hasAttribute('aria-busy')) return;
  app.innerHTML = '<div class="skel" aria-hidden="true"><i class="sk-title"></i><i class="sk-card"></i><i class="sk-card sk-tall"></i></div>' +
    '<p class="vh">Switching to ' + esc(ROLE_SHORT[to]) + '…</p>';
  app.setAttribute('aria-busy', 'true'); SCREEN = 'switch|' + to;
}
function roleTitle(role) { return role === 'rn' ? 'Charge nurse' : role === 'coord' ? 'NODA coordinator' : 'Volunteer'; }

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
  return '<div class="getapp"><span><b>NODA Alert has a phone app</b>' + (appOnly() && ST.role === 'vol' ? 'NODA pages come only through the phone app.' : ST.push && ST.role !== 'rn' ? 'It can show pages as notifications.' : 'It opens like an app from your home screen.') + '</span>' +
    '<a class="btn small primary" href="' + esc(ST.appUrl + '#k=' + KEY) + '" target="_top" rel="noopener">Open the phone app</a></div>';
}
function deviceCard(before) {
  if (MODE !== 'pwa' || !ST || ST.role === 'none') return before || '';
  var who = ST.role === 'rn' ? (ST.name ? ST.name + ' (charge RN)' : 'Charge RN') : ST.role === 'coord' ? 'NODA coordinator' : ST.me.name;
  var again = emailSignIn() ? ' You can sign in again with your email.' : ' You’ll need your link to sign in again.';
  var body = UI.confirmSignOut
    ? '<div class="confirm"><p>Sign out of NODA Alert on this phone?' + (pushState() === 'on' ? ' Notifications on this phone stop.' : '') + again + '</p><div class="row"><button type="button" class="btn danger" data-act="signout">Sign out</button><button type="button" class="btn" data-act="signout-cancel">Cancel</button></div></div>'
    : '<div class="row"><button type="button" class="btn small" data-act="signout-ask">Sign out of this phone</button></div>';
  var others = ST.role === 'vol' ? otherPhones() : [];
  var otherHTML = !others.length ? '' : UI.confirmOthers
    ? '<div class="confirm"><p>Sign out your other ' + (others.length === 1 ? 'phone' : others.length + ' phones') + '? ' + (others.length === 1 ? 'It stops' : 'They stop') + ' getting NODA pages, and anyone using ' + (others.length === 1 ? 'it' : 'them') + ' has to sign in again.</p><div class="row"><button type="button" class="btn danger" data-act="others-yes">Sign out other phones</button><button type="button" class="btn" data-act="others-no">Cancel</button></div></div>'
    : '<p class="m0">Also signed in on ' + esc(phoneNames(others)) + '.</p><div class="row"><button type="button" class="btn small" data-act="others-ask">Sign out other phones</button></div>';
  return '<h3 class="sec">This phone</h3>' + (before ? '<div class="card-gap">' + before + '</div>' : '') + '<div class="card device"><p class="m0">Signed in as <b>' + esc(who) + '</b>.</p>' + otherHTML + body +
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
  if (MODE !== 'pwa' || !ST || (ST.role !== 'vol' && ST.role !== 'coord' && !(ST.role === 'rn' && ST.rnPush && ST.rnPush.can))) return 'na';
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
  var coord = ST.role === 'coord', rn = ST.role === 'rn';
  var what = coord ? 'vigil updates' : rn ? 'sign-up notices' : 'pages';
  // Said only when it's true: a volunteer who turned alert emails off gets pages on their other phone, not by email.
  var until = rn ? '' : appOnly() ? ' Until then, NODA can’t send ' + what + ' to this phone.' : coord || ST.me.pageEmail ? ' Until then, ' + what + ' come by email.' : '';
  // With alerts by app only, a volunteer with no phone getting notifications gets no pages: the card says so in color.
  var need = appOnly() && !coord && !rn && s !== 'on' && !ST.me.devices;
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
    sub = coord ? 'Vigil updates come to this phone' + (appOnly() ? '.' : ' and by email.') : rn ? 'You hear when a volunteer signs up for a vigil you paged, or an hour still has no one.' : '';
    acts = '<button type="button" class="btn small" data-act="push-test"' + dis + (TEST.waiting ? ' disabled' : '') + '>Send a test</button><button type="button" class="btn small quiet" data-act="push-off"' + dis + '>Turn off</button>';
    extra = testLine() + (coord || rn ? '' : pageEmailBlock() + dndBlock());
  } else {
    head = coord ? 'Get vigil updates on this phone' : rn ? 'Know when volunteers sign up' : !appOnly() ? 'Get pages on this phone' : ST.me.devices ? 'Get pages on this phone too' : 'Turn on notifications to get pages';
    chip = '<span class="chip off">Off</span>';
    sub = rn ? 'NODA tells you when a volunteer signs up for a vigil you paged, or when an hour still has no one.'
      : appOnly() ? 'NODA sends ' + what + ' to the app, not by email.'
      : 'Get ' + what + ' right away, even when the app is closed.' +
      (!coord && ST.me.appFirst && ST.me.pageEmail && ST.me.receiptsOk ? ' After a test, they come here instead of by email.' : '');
    acts = '<button type="button" class="btn primary" data-act="push-on"' + dis + '>' + (PUSH.busy ? 'Turning on…' : 'Turn on notifications') + '</button>';
  }
  if (PUSH.busy && s === 'on') acts = '<span class="hint m0">Working…</span>';
  return '<section class="card notif' + (s === 'on' ? ' on' : need ? ' need' : '') + '" id="notif" aria-live="polite">' +
    '<div class="row"><span><b>' + head + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + chip + '</div>' +
    (PUSH.err ? '<p class="err" role="alert">' + esc(PUSH.err) + '</p>' : '') +
    (acts ? '<div class="acts">' + acts + '</div>' : '') + extra + '</section>';
}
// Version 2.9: a page can't ring through Do Not Disturb or silent mode on its own; the volunteer has to let it.
function dndBlock() {
  return '<details class="dnd"><summary>Let pages through Do Not Disturb</summary><p class="hint m0">' +
    (isIOS() ? 'Open Settings, then Focus, then Do Not Disturb (and Sleep, if you use it). Tap Apps, then Allow Notifications From, then add NODA. Keep your ringer on while you’re on call: silent mode mutes notification sounds.'
      : isAndroid() ? 'Open Settings, then Modes (or Notifications), then Do Not Disturb. Under the apps that can interrupt, add NODA Alert. Keep your ringer on while you’re on call. Menu names vary by phone.'
      : 'On your phone, let NODA Alert through Do Not Disturb, and keep the ringer on while you’re on call.') + '</p></details>';
}
// This phone's row from the server (volunteers), if it is registered.
function thisPhone() {
  var id = pushSaved().id;
  var list = (ST && ST.me && ST.me.phones) || (ST && ST.rnPush && ST.rnPush.phones) || [];
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
  // Version 2.5: no alert emails to choose; a test shows pages will reach this phone.
  if (appOnly()) return any ? '' : '<p class="hint m0">Send a test to make sure pages reach this phone.</p>';
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
  var n = SWITCHES;
  call('confirmTestPush', [TEST.id]).then(function (st) {
    if (n !== SWITCHES) return;   // a role switch began meanwhile (version 2.9.1)
    ST = st;
    if (st.test && st.test.confirmed) { clearTimeout(TEST.timer); TEST = {}; if (st.notice) toast(st.notice); }
    else if (giveUp()) { clearTimeout(TEST.timer); TEST = { failed: true }; }
    else testCheckIn(TEST.tries < 3 ? 4000 : 8000);
  }, function () {
    if (n !== SWITCHES) return;
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
  if (SWITCH) { setTimeout(function () { fidChanged(fid); }, 2000); return; }   // after the role switch (version 2.9.1)
  var n = SWITCHES;
  PUSH.sending = true;
  call('registerDevice', [fid, platformLabel()]).then(function (st) {
    PUSH.sending = false;
    if (s.id) call('unregisterDevice', [s.id]).catch(function () {});
    // A role switch began meanwhile: this registration was for the role the phone left, so the next refresh redoes it.
    pushSave({ on: true, id: fid, at: n === SWITCHES ? Date.now() : 0, ep: PUSH.endpoint });
    if (n === SWITCHES) { ST = st; if (!editing()) render(); }
  }, function () { PUSH.sending = false; });
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
  if (MODE !== 'pwa' || SWITCH || PUSH.refreshing || PUSH.busy || !s.on || !KEY || !ST || (ST.role === 'rn' && !(ST.rnPush && ST.rnPush.can))) return;
  var st = pushState();
  if (st === 'unconfigured' || st === 'na' || st === 'ios-install' || st === 'ios-old' || st === 'unsupported') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    call('unregisterDevice', [s.id || '']).catch(function () {});
    pushSave({ on: false }); if (!editing()) render();
    return;
  }
  PUSH.refreshing = true;
  // Version 2.9.1: once a role switch begins (n !== SWITCHES), this refresh registers nothing more for the role the
  // phone is leaving and uses none of its answers. PUSH.sending marks a registration on its way, which the switch
  // can't overtake for sure: then the phone is registered again for its new role afterwards.
  var n = SWITCHES, stale = function () { return n !== SWITCHES || !!SWITCH; };
  var register = function (fid) {
    PUSH.sending = true;
    return call('registerDevice', [fid, platformLabel()]).then(function (st) { PUSH.sending = false; if (!stale()) ST = st; return st; },
      function (err) { PUSH.sending = false; throw err; });
  };
  swReady().then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
    var force = !sub || (s.ep && sub.endpoint !== s.ep);
    return fcmRegister(force).then(function (fid) {
      if (!force && fid === s.id && Date.now() - (s.at || 0) < DAY) return;
      if (stale()) return;
      return register(fid).then(function (st1) {
        if (s.id && s.id !== fid && !stale()) call('unregisterDevice', [s.id]).catch(function () {});
        if (st1.device && st1.device.revived && !force && !stale()) {
          // The server had turned this phone off because FCM said it was gone: register it again from scratch.
          return fcmRegister(true).then(function (fid2) { return register(fid2).then(function () { return fid2; }); });
        }
        return fid;
      }).then(function (finalId) { pushSave({ on: true, id: finalId, at: stale() ? 0 : Date.now(), ep: PUSH.endpoint }); if (!editing()) render(); });
    });
  }).catch(function () { /* try again next time the app opens */ })
    .then(function () {
      PUSH.refreshing = false; PUSH.lastRefresh = Date.now();
      // A role switch began meanwhile: check again for the role the phone is in now (it registers only if needed).
      if (n !== SWITCHES) { PUSH.lastRefresh = 0; if (!SWITCH) pushRefresh(); }
    });
}

/* ---------- charge RN ---------- */
function viewRN() {
  if (VIEW.name === 'request' && DRAFT) return rnRequest();
  if (VIEW.name === 'vigil' && vigilById(VIEW.id)) return rnVigil(vigilById(VIEW.id));
  return rnHome();
}
// How many volunteers a page reaches, in words.
function reachText() {
  var n = reachN();
  return appOnly() ? plural(n, 'volunteer') + ' can get pages' : plural(n, 'volunteer is', 'volunteers are') + ' on call';
}
// Version 2.6: the charge nurse's home (and the coordinator's Today tab): a greeting, the Request button, and each
// active vigil's next 12 hours. The coordinator also gets a one-sentence summary, three numbers and "Needs you".
function rnHome() {
  var now = Date.now(), coord = ST.role === 'coord';
  var active = ST.vigils.filter(function (v) { return v.status === 'active'; }).reverse();
  var ended = ST.vigils.filter(function (v) { return v.status !== 'active'; }).reverse();
  var open12 = active.reduce(function (n, v) { return n + stats(v, now).open12; }, 0);
  var req = ST.units.length
    ? '<button type="button" class="btn primary big block" data-act="new">Request a NODA volunteer</button>'
    : '<p class="note">Add at least one unit on the Units tab of the Sheet before paging.</p>';
  var reachNote = appOnly() && !reachN() ? '<p class="note">No volunteers have NODA notifications on yet, so a page won’t reach anyone.</p>' : '';
  // Before server 2.7 a phone got pages only while NODA was in Volunteer mode on it. From 2.7 it gets them in every mode.
  var modeNote = appOnly() && MODE === 'pwa' && hasRole('vol') && !serverAtLeast('2.7.0') ? '<p class="hint">You get NODA pages on this phone only in Volunteer mode.</p>' : '';
  var warn = staleBanner(now);
  var list = active.length ? '<div class="stack">' + active.map(function (v) { return vigilCard(v, 'rn', now); }).join('') + '</div>' : '<p class="empty">No active vigils.</p>';
  var idle = '';
  if (active.length) {
    var busy = {}; active.forEach(function (v) { busy[v.unitId] = 1; });
    var free = ST.units.filter(function (u) { return u.active !== false && !busy[u.id]; }).map(function (u) { return u.name; });
    if (free.length && free.length < 6) idle = '<p class="hint">' + esc(free.length === 1 ? free[0] + ' has' : free.slice(0, -1).join(', ') + ' and ' + free[free.length - 1] + ' have') + ' no active vigil.</p>';
  }
  var endedHTML = ended.length ? '<h3 class="sec">Ended in the last day</h3><div class="stack">' + ended.map(function (v) { return vigilCard(v, 'rn', now); }).join('') + '</div>' : '';
  if (!coord) {
    return installBanner() + getAppCard() + warn +
      '<h2 class="greet">' + greeting() + (ST.name ? ', ' + esc(firstName(ST.name)) : '') + '.</h2>' +
      req + '<p class="hint">' + esc(reachText()) + '.</p>' + reachNote + modeNote +
      '<h3 class="sec">Active now</h3>' + list + idle + endedHTML + tzNote() + deviceCard(notifCard());
  }
  var sum = active.length
    ? (active.length === 1 ? 'One vigil is active. ' : active.length + ' vigils are active. ') +
      (open12 ? plural(open12, 'hour') + ' in the next 12 ' + (open12 === 1 ? 'still needs' : 'still need') + ' a companion.' : 'Every hour in the next 12 is covered.')
    : 'No vigils are active.';
  var num = function (b, label) { return '<div class="num"><b>' + b + '</b><span>' + label + '</span></div>'; };
  return installBanner() + getAppCard() + warn +
    '<h2 class="greet">' + greeting() + '.</h2><p class="sum">' + esc(sum) + '</p>' +
    '<div class="nums">' + num(active.length, active.length === 1 ? 'active vigil' : 'active vigils') + num(open12, 'open hours, next 12 h') +
      num(reachN() + (appOnly() ? '<small> of ' + ST.onCall + '</small>' : ''), appOnly() ? 'can get pages' : 'on call') + '</div>' +
    reachNote + modeNote + list + idle + needsYou() +
    '<div class="more">' + req + '</div>' + endedHTML + tzNote();
}
// The coordinator's to-do list: letters asked for, and on-call volunteers whose pages can't reach them.
function needsYou() {
  var chev = svg('chev', 'ico chev'), items = [];
  (ST.volunteers || []).forEach(function (v) {
    if (letterOpen(v) && !v.removed) items.push('<button type="button" class="li" data-act="vol-open" data-id="' + esc(v.id) + '"><span class="av">' + esc(initials(v.name)) + '</span><span class="tx">' + esc(v.name) + ' asked for a service letter</span>' + chev + '</button>');
  });
  if (appOnly()) {
    var n = (ST.volunteers || []).filter(function (v) { return v.onCall && !v.removed && !v.devices; }).length;
    if (n) items.push('<button type="button" class="li" data-act="tab" data-tab="volunteers"><span class="av g">' + svg('bell') + '</span><span class="tx">' + plural(n, 'volunteer') + ' on call can’t get pages yet</span>' + chev + '</button>');
  }
  // Version 2.9: the weekly phone check, the number nurses call, and the timer.
  var wk = ST.weekly, miss = wk && wk.done ? (wk.miss || []).length : 0;
  if (miss) items.push('<button type="button" class="li" data-act="tab" data-tab="volunteers"><span class="av g">' + svg('bell') + '</span><span class="tx">' + plural(miss, 'phone') + ' didn’t answer this week’s phone check: ' + esc(wk.miss.join(', ')) + '</span>' + chev + '</button>');
  if (ST.health && !String(ST.backupPhone || '').trim()) items.push('<button type="button" class="li" data-act="tab" data-tab="links"><span class="av g">' + svg('bell') + '</span><span class="tx">Add a Backup phone on the Settings tab, so nurses have a number to call when a page reaches no one</span>' + chev + '</button>');
  if (ST.health && !ST.tickAt) items.push('<button type="button" class="li" data-act="tab" data-tab="links"><span class="av g">' + svg('clock') + '</span><span class="tx">NODA’s 15-minute check hasn’t run yet. Check its timer in Apps Script</span>' + chev + '</button>');
  if (!items.length) return '';
  return '<h3 class="sec">Needs you</h3><div class="card list">' + items.join('') + '</div>';
}
function opt(name, i, label, on) {
  var id = 'f-' + name + '-' + i;
  return '<label class="opt" for="' + id + '"><input type="checkbox" id="' + id + '" name="' + name + '" value="' + i + '"' + (on ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
}
function seg(name, val, label, cur) {
  var id = 'f-' + name + '-' + String(val).replace(/\W/g, '');
  return '<label for="' + id + '"><input type="radio" id="' + id + '" name="' + name + '" value="' + esc(val) + '"' + (String(cur) === String(val) ? ' checked' : '') + '><span>' + esc(label) + '</span></label>';
}
function reqOK(d) { return d.crit1.length > 0 && d.crit2.length > 0 && d.consent && !!d.unitId; }
// What still stops the page from going out, in one sentence (version 2.8).
function reqWhy(d) {
  var need = [];
  if (!d.crit1.length || !d.crit2.length) need.push('check one item in each list');
  if (!d.consent) need.push('confirm permission');
  if (!d.unitId) need.push('pick the unit');
  if (!need.length) return '';
  var s = need.length === 1 ? need[0] : need.slice(0, -1).join(', ') + ' and ' + need[need.length - 1];
  return s.charAt(0).toUpperCase() + s.slice(1) + ' to send.';
}
function reqStart(d) { return Math.floor(Date.now() / (30 * MIN)) * 30 * MIN + d.startIn * H; }
function covLine(d) {
  var start = reqStart(d), end = start + d.windowH * H;
  return 'Covers ' + dayWord(start) + ' ' + t24(start) + ' to ' + dayWord(end) + ' ' + t24(end) + ', ' + d.windowH + ' hours.';
}
// Version 2.9: start, length and check-in place in one line, with Change to open them.
function reqSummary(d) {
  var start = reqStart(d), end = start + d.windowH * H;
  return (d.startIn ? 'Starts in ' + plural(d.startIn, 'hour') : 'Starts now') + ' and covers ' + d.windowH + ' hours, until ' + dayWord(end) + ' at ' + t12(end) +
    '. Volunteers check in: ' + d.checkIn + '.';
}
function sendLabel(d) {
  var u = unitName(d.unitId);
  if (d.practice) return 'Send a practice page' + (u ? ' for ' + u : '');
  return 'Page ' + plural(reachN(), 'volunteer') + (u ? ' for ' + u : '');
}
// A new ID for each request form, so a page sent twice after a lost answer makes one vigil (version 2.9).
function newReqId() {
  var c = 'abcdefghijklmnopqrstuvwxyz0123456789', out = '';
  try { var b = new Uint8Array(20); window.crypto.getRandomValues(b); for (var i = 0; i < b.length; i++) out += c.charAt(b[i] % 36); }
  catch (e) { for (var j = 0; j < 20; j++) out += c.charAt(Math.floor(Math.random() * 36)); }
  return out;
}
function unitName(id) { for (var i = 0; i < ST.units.length; i++) if (ST.units[i].id === id) return ST.units[i].name; return ''; }
// What volunteers' phones show, worded as the server words it (pageMsg_ in Code.gs). Version 2.9: no PPE on the lock
// screen (the app and the email say it), and a practice page says so first.
function pagePreview(d) {
  var r = rules(), start = reqStart(d), soon = start <= Date.now() + 5 * MIN;
  var body = (d.practice ? 'Practice only: no one needs to come in. ' : '') + 'A patient on ' + (unitName(d.unitId) || 'your unit') + ' needs a companion, ' + (soon ? 'starting now' : 'from ' + hmm(start)) + ', for the next ' + d.windowH +
    ' hours. Sign up for ' + r.min + ' to ' + r.max + ' hours.';
  return '<div class="nh">' + (LOGO ? '<img src="' + esc(LOGO) + '" alt="">' : '') + 'NODA Alert<span>now</span></div>' +
    '<p class="nt">' + (d.practice ? 'NODA practice page' : 'NODA page') + '</p><p class="nb">' + esc(body) + '</p>';
}
// Where volunteers checked in last time this phone paged, kept on this phone (version 2.9: only that; the unit and PPE
// are chosen each time).
function rnLast() { try { var o = JSON.parse(LS.get('rnLast') || 'null'); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } }
function rnRequest() {
  var d = DRAFT, L = ST.lists, ok = reqOK(d), coord = ST.role === 'coord';
  var unitSeg = ST.units.map(function (u) { return seg('unit', u.id, u.name, d.unitId); }).join('');
  var inSeg = L.checkIn.map(function (c) { return seg('checkIn', c, c, d.checkIn); }).join('');
  // Version 2.9: start, length and check-in place rarely change, so they wait behind Change.
  var when = UI.reqMore
    ? '<div class="field"><span class="fl2" id="l-start">Start</span><div class="seg" role="radiogroup" aria-labelledby="l-start">' + seg('startIn', 0, 'Now', d.startIn) + seg('startIn', 1, 'In 1 hour', d.startIn) + seg('startIn', 2, 'In 2 hours', d.startIn) + '</div></div>' +
      '<div class="field"><span class="fl2" id="l-win">Cover the next</span><div class="seg" role="radiogroup" aria-labelledby="l-win">' + [12, 24, 48, 72].map(function (h) { return seg('windowH', h, h + ' hours', d.windowH); }).join('') + '</div></div>' +
      '<p class="hint" id="cov-sum">' + esc(covLine(d)) + '</p>' +
      '<div class="field"><span class="fl2" id="l-checkin">Volunteers check in' + (d.remembered ? ' <span class="rem">· as last time</span>' : '') + '</span><div class="seg" role="radiogroup" aria-labelledby="l-checkin">' + inSeg + '</div></div>'
    : '<div class="sumrow"><p class="hint m0" id="cov-sum">' + esc(reqSummary(d)) + '</p><button type="button" class="btn small" data-act="req-more" aria-label="Change the start, length or check-in place">Change</button></div>';
  var dup = UI.dup
    ? '<div class="confirm" id="dup-ask" role="alertdialog" aria-labelledby="dup-h" tabindex="-1"><p id="dup-h"><b>' + esc(UI.dup.msg) + '</b></p><p>Is this page for another patient?</p>' +
      '<button type="button" class="btn primary block" data-act="dup-open" data-id="' + esc(UI.dup.id) + '">No: open ' + esc(UI.dup.id) + '</button>' +
      '<button type="button" class="btn block" data-act="dup-second">Yes: page for a second patient</button></div>' : '';
  return '<div class="back-row"><button type="button" class="pillbtn back" data-act="home">' + svg('back') + 'Back</button></div>' +
    '<p class="reach"><span class="rchip">' + (coord ? 'Coordinator' : 'Charge nurse') + '</span><span>' + esc(reachText()) + '</span></p>' +
    '<h2 class="h1">Request a NODA volunteer</h2>' +
    '<form id="req" class="form" novalidate>' +
      '<fieldset><legend class="fl">Patient meets at least one</legend>' + L.crit1.map(function (t, i) { return opt('crit1', i, t, d.crit1.indexOf(i) > -1); }).join('') + '</fieldset>' +
      '<fieldset><legend class="fl">And at least one</legend>' + L.crit2.map(function (t, i) { return opt('crit2', i, t, d.crit2.indexOf(i) > -1); }).join('') + '</fieldset>' +
      '<fieldset><legend class="fl">Permission</legend><label class="opt consent" for="f-consent"><input type="checkbox" id="f-consent" name="consent"' + (d.consent ? ' checked' : '') + '><span>The patient or surrogate agreed, or the attending provider approved (no surrogate).</span></label></fieldset>' +
      '<fieldset><legend class="fl">Where</legend>' +
        '<div class="field"><span class="fl2" id="l-unit">Unit</span><div class="seg" role="radiogroup" aria-labelledby="l-unit">' + unitSeg + '</div></div>' +
        '<div class="field"><span class="fl2" id="l-ppe">PPE at the bedside</span><div class="seg" role="radiogroup" aria-labelledby="l-ppe">' + seg('ppe', 'no', 'None', d.ppe ? 'yes' : 'no') + seg('ppe', 'yes', 'Needed', d.ppe ? 'yes' : 'no') + '</div></div>' +
      '</fieldset>' +
      '<fieldset><legend class="fl">When</legend>' + when + '</fieldset>' +
      (coord && serverAtLeast('2.7.0') ? '<fieldset><legend class="fl">Practice</legend><label class="opt" for="f-practice"><input type="checkbox" id="f-practice" name="practice"' + (d.practice ? ' checked' : '') + '><span>Practice page. Volunteers are told no one needs to come in.</span></label></fieldset>' : '') +
      '<fieldset><legend class="fl">Volunteers will see</legend><div class="nprev" id="req-prev">' + pagePreview(d) + '</div>' +
        '<p class="hint">The page has no patient details. Share those in person at check-in.</p></fieldset>' +
      '<div class="foot">' + (dup || '<button type="submit" class="btn primary big block" id="send"' + (ok ? '' : ' disabled') + '>' + esc(sendLabel(d)) + '</button>' +
        '<p class="hint" id="why"' + (ok ? ' hidden' : '') + '>' + esc(reqWhy(d)) + '</p>' +
        '<p class="fine" id="fine"' + (ok ? '' : ' hidden') + '>' + svg('lock') + 'No patient details are sent.</p>') + '</div>' +
    '</form>';
}
function readForm(f) {
  function picks(name) { return Array.prototype.map.call(f.querySelectorAll('input[name="' + name + '"]:checked'), function (x) { return +x.value; }); }
  function radio(name, def) { var x = f.querySelector('input[name="' + name + '"]:checked'); return x ? x.value : def; }
  DRAFT.crit1 = picks('crit1'); DRAFT.crit2 = picks('crit2');
  DRAFT.consent = f.querySelector('#f-consent').checked;
  DRAFT.unitId = radio('unit', DRAFT.unitId);
  DRAFT.checkIn = radio('checkIn', DRAFT.checkIn);
  DRAFT.ppe = radio('ppe', DRAFT.ppe ? 'yes' : 'no') === 'yes';
  // Fields behind Change keep their values while it's closed.
  DRAFT.startIn = +radio('startIn', DRAFT.startIn); DRAFT.windowH = +radio('windowH', DRAFT.windowH);
  var pr = f.querySelector('#f-practice'); if (pr) DRAFT.practice = pr.checked;
}
function updateReq() {
  var f = document.getElementById('req'); if (!f) return;
  readForm(f);
  var ok = reqOK(DRAFT), send = document.getElementById('send');
  document.getElementById('cov-sum').textContent = UI.reqMore ? covLine(DRAFT) : reqSummary(DRAFT);
  document.getElementById('req-prev').innerHTML = pagePreview(DRAFT);
  if (send) {
    send.disabled = !ok; send.textContent = sendLabel(DRAFT);
    document.getElementById('why').hidden = ok;
    document.getElementById('why').textContent = reqWhy(DRAFT);
    document.getElementById('fine').hidden = !ok;
  }
  fitScrollPad();
}
// Sends the page. The button says "Sending page…" until the server answers (a page can take several seconds). A unit
// that already has an active vigil gets a question instead: open that vigil, or page for a second patient.
function sendRequest() {
  if (BUSY || !DRAFT) return;
  var b = document.getElementById('send');
  if (b) { b.disabled = true; b.textContent = DRAFT.practice ? 'Sending practice page…' : 'Sending page…'; b.classList.add('pending'); b.setAttribute('aria-busy', 'true'); }
  var sent = DRAFT;
  act('requestVigil', [DRAFT], function (st) {
    LS.set('rnLast', JSON.stringify({ checkIn: sent.checkIn }));
    DRAFT = null; VIEW = { name: 'vigil', id: st.lastCreated }; UI = {}; window.scrollTo(0, 0);
    // Version 2.8: phones confirm within seconds; show the count without a reload.
    [20000, 60000].forEach(function (ms) { setTimeout(function () { if (VIEW.name === 'vigil' && VIEW.id === st.lastCreated && autoRefreshOK()) load(); }, ms); });
  }, function (m) {
    var dup = /already has an active NODA vigil \((V-\d+)/.exec(m);
    if (dup && DRAFT && !DRAFT.second) {
      UI.dup = { id: dup[1], msg: m.split(' If this is another patient')[0] };
      setTimeout(function () { var c = document.getElementById('dup-ask'); if (c) { try { c.focus(); c.scrollIntoView({ block: 'nearest' }); } catch (e) { /* no focus */ } } }, 0);
    } else toast(m);
  });
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
      case 'late': return '<span class="chip late">Not checked in · ' + n + '</span>';
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
// Version 2.8: how many volunteers' phones showed the latest page, and how to hear about sign-ups. Version 2.9:
// "delivered" (a phone showed it; that doesn't mean someone saw it) and how many people opened it.
function reachLine(v) {
  if (v.status !== 'active') return '';
  var out = '';
  if (v.reach && v.reach.sent) {
    var r = v.reach, fresh = Date.now() - r.at < 10 * MIN;
    out += '<p class="reachline">' + svg('bell') + '<span>' + (r.kind === 'repage' ? 'Re-page' : r.kind === 'gap' ? 'Latest alert' : 'Page') + ' delivered to <b>' + r.confirmed + ' of ' + r.sent + '</b> volunteers’ phones' + (fresh ? ' so far' : '') +
      (r.opened !== undefined ? '. ' + (r.opened ? plural(r.opened, 'volunteer') + ' opened it' : 'No one has opened it yet') : '') + '.</span></p>';
  } else if (ST.push && v.phones !== null && v.phones !== undefined && v.phones > 0) {
    out += '<p class="reachline">' + svg('bell') + '<span>The page reached <b>' + plural(v.phones, 'volunteer’s phone', 'volunteers’ phones') + '</b>.</span></p>';
  }
  if (ST.role === 'rn' && pushState() === 'off') out += '<p class="hint">To hear when a volunteer signs up, turn on notifications under This phone on the home screen.</p>';
  return out;
}
// Version 2.9: the number to call when a page doesn't reach anyone (Backup phone, on the Settings tab of the Sheet).
function callLine() {
  var p = String((ST && ST.backupPhone) || '').trim(), tel = p.replace(/[^\d+]/g, '');
  var link = tel.length >= 3 ? '<a class="tel" href="tel:' + esc(tel) + '">' + esc(p) + '</a>' : '';
  if (ST.role === 'coord') return link ? 'Nurses are told to call ' + link + '.' : 'Nurses are told to call the NODA coordinator. Add a Backup phone on the Settings tab to give them a number.';
  return link ? 'Call ' + link + ' to find a volunteer.' : 'Call the NODA coordinator to find a volunteer.';
}
// True when app notifications are on and the first page reached no volunteer's phone, and no later page did either.
function noPhones(v) { return v.status === 'active' && !!ST.push && v.phones === 0 && !(v.reach && v.reach.sent) && !signupsOf(v).length; }
// Version 2.9: the nurse's warning when a page reached no phone, few phones after 5 minutes, or no one has signed up
// after 15 minutes, with the number to call.
function pageWarn(v, now) {
  if (v.status !== 'active' || signupsOf(v).length) return '';
  if (noPhones(v)) return '<div class="alert" role="alert"><p><b>The page reached no volunteer’s phone.</b> ' + callLine() + '</p></div>';
  var r = v.reach, low = r && r.sent && now - r.at >= 5 * MIN && r.confirmed * 2 < r.sent, waited = now - v.created >= 15 * MIN;
  if (!low && !waited) return '';
  return '<div class="alert amber" role="status"><p><b>' + (waited ? 'No volunteer has signed up yet.' : 'Only ' + r.confirmed + ' of ' + r.sent + ' volunteers’ phones have the page.') + '</b> ' + callLine() + '</p></div>';
}
// Version 2.9: the 15-minute check (reminders, repeat alerts, "no volunteer yet") hasn't run for more than 35 minutes.
function staleBanner(now) {
  if (!ST || !ST.tickAt || now - ST.tickAt <= 35 * MIN) return '';
  return '<div class="alert" role="alert"><p><b>NODA’s 15-minute check last ran ' + esc(dayWord(ST.tickAt) + ' at ' + t12(ST.tickAt)) + '.</b> Reminders and repeat alerts are stopped until it runs again.</p>' +
    '<p>' + (ST.role === 'coord' ? 'Open the Apps Script project and check its timer under Triggers.' : callLine()) + '</p></div>';
}
// Version 2.9: a volunteer who hasn't checked in: the nurse says whether they're at the bedside.
function latePanel(v, now) {
  if (!serverAtLeast('2.7.0')) return '';
  return lateOf(v, now).map(function (x) {
    var due = dueOf(x), open = now >= due + LATE_OPEN, first = firstName(x.volName);
    return '<div class="card latecard" role="group" aria-labelledby="late-' + esc(x.id) + '"><p class="h" id="late-' + esc(x.id) + '">' + esc(x.volName) + ' hasn’t checked in.</p>' +
      '<p class="sub m0">Due at ' + esc(t12(due)) + '. ' + (open ? 'Their hours are open to other volunteers again.' : 'At ' + esc(t12(due + LATE_OPEN)) + ' their hours open to other volunteers.') + ' Is ' + esc(first) + ' at the bedside?</p>' +
      '<div class="btns2"><button type="button" class="btn primary" data-act="here" data-id="' + esc(x.id) + '">Yes, check ' + esc(first) + ' in</button>' +
      '<button type="button" class="btn" data-act="nothere" data-id="' + esc(x.id) + '">No, open the hours</button></div></div>';
  }).join('');
}
// Version 2.9: who gets this vigil's notices (sign-ups, "no volunteer yet", late volunteers), and a way to take them
// over at shift change.
function handoff(v) {
  if (v.status !== 'active' || v.nurseName === undefined) return '';
  if (v.mine) return '<p class="hint">This vigil’s notices come to you.</p>';
  var who = v.nurseName ? 'This vigil’s notices go to ' + esc(v.nurseName) + '.' : 'No charge nurse gets this vigil’s notices.';
  var btn = ST.role === 'rn' && ST.name ? '<button type="button" class="btn small" data-act="take-updates" data-id="' + esc(v.id) + '">Send them to me</button>' : '';
  return '<div class="note row"><span>' + who + '</span>' + btn + '</div>';
}
// An end can be undone for 15 minutes (server 2.7).
function canUndo(v, now) {
  return v.status !== 'active' && !!v.ended && now - v.ended < 15 * MIN && serverAtLeast('2.7.0') && v.reason !== 'Schedule ran out' && !(v.practice && ST.role !== 'coord');
}
function rnVigil(v) {
  var now = Date.now(), s = stats(v, now), rows = '', last = '';
  segments(v, now).forEach(function (g) {
    var dl = dayLabel(g.start);
    if (dl !== last) { rows += '<li class="dayhead">' + esc(dl) + '</li>'; last = dl; }
    rows += '<li class="slot rn"><span class="t24">' + r24(g.start, g.end) + '</span>' + segChip(g) + '</li>';
  });
  // Who the server tells when the vigil ends: everyone booked who hasn't arrived (version 2.7).
  var booked = {}; signupsOf(v).forEach(function (x) { if (!x.inAt && x.end > now) booked[x.vol] = 1; });
  var np = Object.keys(booked).length;
  var status = (v.status === 'active'
    ? '<span class="chip taken">Active since ' + t24(v.created) + '</span>'
    : '<span class="chip done">Ended ' + t24(v.ended) + (v.reason ? ' · ' + esc(v.reason) : '') + '</span>') +
    (v.practice ? ' <span class="chip practice">Practice</span>' : '');
  var actions = '';
  if (v.status === 'active') {
    if (UI.endAsk === v.id) {
      actions = '<div class="card endpanel"><p class="h">End this vigil?</p>' +
        '<p class="hint m0">' + esc(v.unitName + ' · ' + v.id + ', paged ' + dayWord(v.created) + ' at ' + t12(v.created)) + '.</p><fieldset><legend class="fl">Reason</legend>' +
        ST.lists.reasons.map(function (r, i) { var id = 'f-reason-' + i; return '<label class="opt" for="' + id + '"><input type="radio" id="' + id + '" name="reason" value="' + esc(r) + '"' + (UI.reason === r ? ' checked' : '') + '><span>' + esc(r) + '</span></label>'; }).join('') +
        '</fieldset><p class="hint m0">' + (np ? plural(np, 'booked volunteer') + ' will be told their hours are canceled.' : 'No booked volunteer needs to be told.') + '</p>' +
        '<div class="row"><button type="button" class="btn danger" data-act="end" data-id="' + esc(v.id) + '"' + (UI.reason ? '' : ' disabled') + '>End vigil' + (np ? ' and notify' : '') + '</button><button type="button" class="btn" data-act="end-cancel">Keep it open</button></div></div>';
    } else {
      actions = '<div class="stack"><button type="button" class="btn outline block" data-act="repage" data-id="' + esc(v.id) + '"' + (s.open ? '' : ' disabled') + '>Re-page for ' + plural(s.open, 'open hour') + '</button>' +
        '<div class="btns2"><button type="button" class="btn" data-act="extend" data-id="' + esc(v.id) + '">Add 12 hours</button>' +
        '<button type="button" class="btn danger" data-act="end-ask" data-id="' + esc(v.id) + '">End vigil</button></div></div>';
    }
  } else if (canUndo(v, now)) {
    actions = '<div class="stack"><button type="button" class="btn outline block" data-act="reopen" data-id="' + esc(v.id) + '">Undo: reopen this vigil</button>' +
      '<p class="hint m0">Ended by mistake? You can reopen it until ' + esc(t12(v.ended + 15 * MIN)) + '. Booked volunteers are told their shift is back on.</p></div>';
  }
  var ext = v.status === 'active' && v.autoExt ? '<p class="note">No one ended this vigil when its hours ran out, so NODA added 12 hours' + (v.autoExt > 1 ? ' (' + v.autoExt + ' times in a row)' : '') + '. End it when it’s no longer needed.</p>' : '';
  return '<div class="back-row"><button type="button" class="pillbtn back" data-act="home">' + svg('back') + 'Back</button></div>' +
    '<p class="crumb">' + esc(v.unitName) + ' · ' + esc(v.id) + '</p><h2 class="h1">Coverage</h2>' +
    staleBanner(now) + pageWarn(v, now) + latePanel(v, now) +
    '<div class="stack"><div>' + status + '</div>' +
    '<div class="stats"><div><b>' + s.filled + '/' + s.total + '</b><span>hours filled</span></div><div><b>' + (s.gap ? (s.gap.start <= now ? 'Now' : t24(s.gap.start)) : 'None') + '</b><span>next gap</span></div><div><b>' + v.paged + '</b><span>paged</span></div></div>' +
    reachLine(v) + handoff(v) + ext +
    '<div class="card">' + ribbon(v, s, now) + '</div>' +
    actions + '</div>' +
    '<h3 class="sec">Hours</h3><ul class="slots">' + rows + '</ul>' +
    '<p class="hint">Volunteers arrive 5–10 minutes early and check in ' + esc(where(v)) + '.</p>' + tzNote();
}

/* ---------- volunteer ---------- */
// Version 2.6: three tabs (Vigils, My shifts, My hours) and the sign-up screen.
function viewVol() {
  if (VIEW.name === 'vigil' && vigilById(VIEW.id)) return volVigil(vigilById(VIEW.id));
  if (TAB === 'shifts') return volShifts();
  if (TAB === 'hours') return volHours();
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
// Version 2.9: a shift on a vigil that ended before this volunteer arrived, until its hours have passed, so nobody
// travels in for a vigil that's over.
function canceledShifts(now) {
  var out = [];
  ST.vigils.forEach(function (v) {
    if (v.status === 'active' || !v.ended) return;
    signupsOf(v).forEach(function (s) { if (s.vol === ST.me.id && !s.inAt && s.end > v.ended && s.end > now) out.push({ v: v, s: s }); });
  });
  return out.sort(function (a, b) { return a.s.start - b.s.start; });
}
function canceledCard(x) {
  return '<section class="card gone" role="status"><p class="lab2">Shift canceled</p><h3 class="ct">The ' + (x.v.practice ? 'practice ' : '') + 'vigil on ' + esc(x.v.unitName) + ' has ended.</h3>' +
    '<p class="sub">Your shift ' + esc(dayWord(x.s.start) + ', ' + span12(x.s.start, x.s.end)) + ', is canceled. Please don’t come in. Thank you for being ready.</p></section>';
}
function volHome() {
  var now = Date.now();
  var needs = ST.vigils.filter(function (v) { return v.status === 'active' && stats(v, now).open > 0; }).reverse();
  var mine = myShifts(now), gone = canceledShifts(now);
  var on = pushState() === 'on';
  var by = appOnly()
    ? (on ? 'Pages come to this phone.' : ST.me.devices ? 'Pages go to the phone where you turned on notifications.'
      : 'Pages can’t reach you yet.' + (MODE === 'pwa' ? '' : ' Turn on notifications in the phone app.'))
    : !ST.me.pageEmail ? 'Alerts come to your phone only.' : on ? 'Alerts come to your phone and by email.' : 'Alerts come by email.';
  // Alert emails are off but this phone isn't the one getting notifications: say so, with a way back.
  var peNote = !appOnly() && !ST.me.pageEmail && !on
    ? '<div class="note row"><span>Alert emails are off, so pages and reminders go only to the phone where you turned notifications on.</span><button type="button" class="btn small" data-act="pe-on">Email me alerts too</button></div>' : '';
  var first = firstName(ST.me.name);
  // Notifications that need attention go at the top; once they're on, their card waits under This phone.
  var ps = pushState(), notif = ps === 'on' ? '' : notifCard(), notifLater = ps === 'on' ? notifCard() : '';
  // Version 2.8: a shift that's starting (check-in open) or under way goes first, so Check in is in sight.
  var urgent = mine.length && shiftNow(mine[0].s, now);
  // Just signed in on this phone: turning on notifications is the next step, so its card comes first.
  var first1 = NEWPHONE && !!notif;
  var pause = UI.confirmPause
    ? '<div class="confirm" id="pause-ask"><p>Pause NODA pages? You won’t get pages or “no one yet” alerts until you turn this back on.</p>' +
      '<div class="row"><button type="button" class="btn danger" data-act="pause-yes">Pause pages</button><button type="button" class="btn" data-act="pause-no">Keep getting pages</button></div></div>' : '';
  // Version 2.9: repeat alerts between 10 PM and 7 AM go only to volunteers who choose them.
  var night = ST.me.onCall && ST.me.nightPages !== undefined && serverAtLeast('2.7.0')
    ? '<label class="card toggle" for="f-night"><span class="tx"><b>Night pages</b><small>' +
        (ST.me.nightPages ? 'On. Repeat alerts for open hours can come between 10 PM and 7 AM.' : 'Off. A new page or a nurse’s re-page can still come at night; automatic repeat alerts wait until 7 AM.') +
      '</small></span><input type="checkbox" id="f-night" role="switch"' + (ST.me.nightPages ? ' checked' : '') + '></label>' : '';
  // Version 2.9: what needs this volunteer comes first (a canceled shift, a shift to check in for, patients who need
  // company), so the main button is on the first screen even with large text. A calm screen starts with a greeting.
  var lead = gone.length || urgent || needs.length;
  return installBanner() + getAppCard() +
    (lead ? '<h2 class="vh">NODA Alert</h2>' : '<h2 class="greet">' + greeting() + (first ? ', ' + esc(first) : '') + '.</h2>') +
    gone.map(canceledCard).join('') +
    (urgent ? nextShift(mine[0], mine.length, now) : '') +
    needs.map(function (v) { return needCard(v, now); }).join('') +
    (first1 ? '<div class="card-gap">' + notif + '</div>' : '') +
    '<label class="card toggle" for="f-avail"><span class="tx"><b>Available for NODA pages</b><small>' +
      (ST.me.onCall ? by : 'Paused. You won’t get alerts.') +
    '</small></span><input type="checkbox" id="f-avail" role="switch"' + (ST.me.onCall ? ' checked' : '') + '></label>' + pause + night +
    peNote + (notif && !first1 ? '<div class="card-gap">' + notif + '</div>' : '') +
    newPhoneCard() +
    (needs.length ? '' : '<div class="card calm"><h3 class="ct">Every hour is covered right now.</h3><p class="sub">Thank you. When a patient needs company, it shows here.</p></div>') +
    (mine.length && !urgent ? nextShift(mine[0], mine.length, now) : '') + tzNote() +
    (MODE === 'pwa' ? deviceCard(notifLater) : '<p class="hint">Add this page to your home screen so it’s one tap away.</p>');
}
// True while a shift can be checked in (from 10 minutes before) or is under way.
function shiftNow(s, now) {
  var early = rules().early * MIN;
  return (s.inAt && !s.outAt) || (!s.inAt && now >= s.start - early && now < s.end);
}
// Version 2.8: right after signing in on a new phone, if the same sign-in is on another phone, offer to sign it out.
function otherPhones() {
  if (!ST || ST.role !== 'vol' || !ST.me || !ST.me.phones || !serverAtLeast('2.6.0')) return [];
  var mine = pushSaved().id;
  return ST.me.phones.filter(function (p) { return p.id !== mine; });
}
// True when the server is at least version v ('2.6.0'), so a newer phone app offers only what the server can do.
function serverAtLeast(v) {
  var a = String((ST && ST.version) || '0').split('.'), b = v.split('.');
  for (var i = 0; i < 3; i++) { var x = +a[i] || 0, y = +b[i] || 0; if (x !== y) return x > y; }
  return true;
}
function phoneNames(list) {
  return list.map(function (p) { return String(p.platform || 'Phone').replace(/ \(.*\)$/, '') + (p.seen ? ', last used ' + shortDate(p.seen) : ''); }).join('; ');
}
function newPhoneCard() {
  var o = otherPhones();
  if (!NEWPHONE || !o.length) return '';
  return '<section class="card" id="newphone"><h3 class="ct">You’re signed in on this phone.</h3>' +
    '<p class="sub">Your NODA sign-in is also on ' + (o.length === 1 ? 'another phone' : o.length + ' other phones') + ' (' + esc(phoneNames(o)) + '). Not using ' + (o.length === 1 ? 'it' : 'them') + ' anymore? Sign ' + (o.length === 1 ? 'it' : 'them') + ' out so pages stop going there.</p>' +
    '<button type="button" class="btn primary block" data-act="others-yes">Sign out my other phones</button>' +
    '<button type="button" class="btn block" data-act="others-keep">' + (o.length === 1 ? 'Keep both' : 'Keep them all') + '</button></section>';
}
// The suggested sign-up on the home screen: the first open time, for 2 hours when 2 fit.
function bestOption(opts) {
  if (!opts.length) return null;
  var o = opts[0], L = o.lens, h = L.indexOf(2) >= 0 ? 2 : L[L.length - 1] < 2 ? L[L.length - 1] : L[0];
  return { t: o.t, h: h };
}
function sitLabel(t, h, now) {
  var end = t + h * H;
  if (t <= now) return 'Sit now, ' + until12(end, now);
  return endsOtherDay(t, end) ? 'Sit ' + dayWord(t) + ' ' + t12(t) + ' to ' + t12(end) + ' ' + dayWord(end) : 'Sit ' + r12(t, end) + ' ' + dayWord(t);
}
function needCard(v, now) {
  var s = stats(v, now), best = bestOption(signupOptions(v, now));
  var next = !s.gap ? '' : s.gap.start <= now ? ' Someone is needed now.' : ' The next open time is ' + dayWord(s.gap.start) + ' at ' + t12(s.gap.start) + '.';
  return '<section class="card need">' +
    (v.practice ? '<p class="lab2"><span class="chip practice">Practice</span> No one needs to come in.</p>' : '') +
    '<h3 class="ct">A patient on ' + esc(v.unitName) + ' needs company.</h3>' +
    '<p class="sub">' + (s.open === 1 ? '1 hour is still open.' : s.open + ' hours are still open.') + next + '</p>' +
    ribbon(v, s, now) +
    (best ? '<button type="button" class="btn primary big block" data-act="pick" data-id="' + esc(v.id) + '" data-t="' + best.t + '" data-h="' + best.h + '">' + esc(sitLabel(best.t, best.h, now)) + '</button>' +
      '<button type="button" class="btn outline block" data-act="open" data-id="' + esc(v.id) + '">Other times</button>'
      : '<button type="button" class="btn outline block" data-act="open" data-id="' + esc(v.id) + '">See the hours</button>') +
  '</section>';
}
// One shift: when, where, and Check in / Check out / I can't make it. Version 2.9: Check out asks first (it sits where
// Check in was, so a second tap can't end a shift), and a late volunteer is told where things stand.
function shiftBody(v, s, now) {
  var early = rules().early * MIN, inNow = s.inAt && !s.outAt, canIn = !s.inAt && now >= s.start - early && now < s.end, acts;
  var late = isLate(s, now), due = dueOf(s), reopened = late && now >= due + LATE_OPEN;
  if (UI.confirmRelease === s.id) {
    acts = '<div class="confirm"><p>Can’t make it? NODA lets the other volunteers know, so someone can sign up.</p><button type="button" class="btn danger block" data-act="release" data-id="' + esc(s.id) + '">Give up this shift</button><button type="button" class="btn block" data-act="keep">Keep my shift</button></div>';
  } else if (UI.confirmOut === s.id) {
    acts = '<div class="confirm" id="out-ask" tabindex="-1"><p>Check out now? NODA logs your hours.' + (s.end - now > 5 * MIN ? ' Your hours until ' + esc(t12(s.end)) + ' open to other volunteers, and the charge nurse is told.' : '') + '</p>' +
      '<button type="button" class="btn danger block" data-act="checkout" data-id="' + esc(s.id) + '">Yes, check out</button><button type="button" class="btn block" data-act="keep">Not yet</button></div>';
  } else {
    acts = (canIn ? '<button type="button" class="btn primary big block" data-act="checkin" data-id="' + esc(s.id) + '">Check in</button>' : '') +
      (inNow ? '' : '<button type="button" class="btn outline block" data-act="release-ask" data-id="' + esc(s.id) + '">I can’t make it</button>');
  }
  var info = inNow ? esc(v.unitName) + '. You’re checked in. Check out when you leave.'
    : reopened ? esc(v.unitName) + '. You were due at ' + esc(t12(due)) + ', so your hours are open to other volunteers again. If you’re here, check in ' + esc(where(v)) + ' now.'
    : late ? esc(v.unitName) + '. You were due at ' + esc(t12(due)) + '. Check in ' + esc(where(v)) + ' when you arrive. Can’t make it? Tap I can’t make it, so another volunteer can come.'
    : esc(v.unitName) + '. Check in ' + esc(where(v)) + (canIn ? ' now.' : ' from ' + t12(s.start - early) + '.');
  var when = '<p class="big">' + esc(dayLabel(s.start) + ', ' + span12(s.start, s.end)) + '</p>' +
    (v.practice ? '<p><span class="chip practice">Practice</span></p>' : '') +
    (inNow ? '<p><span class="chip bedside">At bedside</span></p>' : late ? '<p><span class="chip late">Not checked in</span></p>' : '');
  // Version 2.8: while Check in or Check out is open, that button comes right under the time, before the details.
  if (UI.confirmRelease === s.id || UI.confirmOut === s.id || !(inNow || canIn)) return when + '<p>' + info + '</p>' + acts;
  return when + '<button type="button" class="btn primary big block" data-act="' + (inNow ? 'checkout-ask' : 'checkin') + '" data-id="' + esc(s.id) + '">' + (inNow ? 'Check out' : 'Check in') + '</button>' +
    '<p class="after-main">' + info + '</p>' + (inNow ? '' : '<button type="button" class="btn outline block" data-act="release-ask" data-id="' + esc(s.id) + '">I can’t make it</button>');
}
function nextShift(x, count, now) {
  return '<section class="card shift"><p class="lab2">Your next shift</p>' + shiftBody(x.v, x.s, now) +
    (count > 1 ? '<button type="button" class="btn quiet block" data-act="tab" data-tab="shifts">See all ' + count + ' of your shifts</button>' : '') + '</section>';
}
function volShifts() {
  var now = Date.now(), mine = myShifts(now);
  return '<div class="head"><h2>My shifts</h2></div>' + canceledShifts(now).map(canceledCard).join('') +
    (mine.length ? mine.map(function (x) { return '<section class="card shift">' + shiftBody(x.v, x.s, now) + '</section>'; }).join('')
      : '<p class="empty">No upcoming shifts. When a patient needs company, you can sign up on Vigils.</p>') +
    '<p class="hint">Check in when you arrive and check out when you leave, so your hours count.</p>';
}
// The volunteer's hours, and a way to ask the coordinator for a service letter.
function letterAsked() { return !!(ST.me.letterAsked && (!ST.me.letterSent || ST.me.letterSent < ST.me.letterAsked)); }
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
  var h = ST.me.hours || { total: 0, vigil: 0, training: 0, other: 0, shifts: 0 }, has = h.total > 0;
  var letter = letterAsked()
    ? '<p class="hint m0">You asked for a service letter on ' + esc(medDate(ST.me.letterAsked)) + '. Your coordinator will email it to you.</p>'
    : has ? '<button type="button" class="btn outline block" data-act="ask-letter">Ask for a service letter</button><p class="hint m0">A letter confirming your NODA hours, for school or job applications.</p>' : '';
  return '<div class="head"><h2>My hours</h2></div>' +
    '<section class="card service">' +
      (has ? '<p class="big">' + esc(hrsTxt(h.total)) + '</p><p class="sub">' + esc([h.shifts ? plural(h.shifts, 'vigil shift') : '', h.first ? 'since ' + longDate(h.first) : ''].filter(Boolean).join(' · ')) + '</p>' +
          '<p class="sub">' + esc([h.vigil ? hrsTxt(h.vigil) + ' at the bedside' : '', h.training ? hrsTxt(h.training) + ' of training' : '', h.other ? hrsTxt(h.other) + ' other' : ''].filter(Boolean).join(' · ')) + '</p>'
        : '<p class="sub">Your hours show here after your first vigil shift or the NODA training day.</p>') +
      letter + '</section>' +
    '<h3 class="sec">History</h3>' + histList(ST.me.history || []) +
    '<p class="hint">Shifts are added when you check out. If something looks wrong, tell your coordinator.</p>';
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
function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
// Version 2.9: start times under a heading for each day, the first 12 hours first ("More times" shows the rest), so a
// long vigil doesn't show "9:30 PM" three times with no day.
function startTimes(list, cur, now) {
  var limit = list[0].t + 12 * H, shown = UI.allTimes ? list : list.filter(function (o) { return o.t < limit || o.t === cur.t; });
  var html = '', day = '';
  shown.forEach(function (o) {
    var dl = dayLabel(o.t);
    if (dl !== day) { html += (day ? '</div>' : '') + '<p class="startday" aria-hidden="true">' + esc(dl) + '</p><div class="starts" role="group" aria-label="Start time, ' + esc(dayWord(o.t)) + '">'; day = dl; }
    html += '<button type="button" class="pill" data-act="pick-start" data-t="' + o.t + '" aria-pressed="' + (o.t === cur.t) + '">' + esc(o.t <= now ? 'Now' : t12(o.t)) + '</button>';
  });
  html += '</div>';
  var more = list.length - shown.length;
  return '<div class="startlist">' + html + (more > 0 ? '<button type="button" class="btn quiet block" data-act="more-times">More start times (' + more + ')</button>' : '') + '</div>';
}
// Two questions (when can you come, how long can you stay), then a box to check and confirm.
function signupQuestions(v, opts, now) {
  var r = rules(), cur = null;
  opts.forEach(function (o) { if (o.t === UI.pickStart) cur = o; });
  if (!cur) cur = opts[0];
  UI.pickStart = cur.t;
  var h = cur.lens.indexOf(UI.pickHours) >= 0 ? UI.pickHours : cur.lens.indexOf(2) >= 0 ? 2 : cur.lens[0];
  UI.pickHours = h;
  var groups = [];
  opts.forEach(function (o) { var g = groups[groups.length - 1]; if (!g || g.run !== o.run) groups.push(g = { run: o.run, opts: [] }); g.opts.push(o); });
  var q1 = groups.map(function (g) {
    var on = g.run === cur.run;
    var range = g.run.start <= now ? cap(until12(g.run.end, now)) : span12(g.run.start, g.run.end);
    return '<div class="part' + (on ? ' on' : '') + '"><button type="button" class="part-btn" data-act="pick-start" data-t="' + g.opts[0].t + '" aria-pressed="' + on + '">' +
      '<b>' + esc(partLabel(g.run.start, now)) + '</b><span>' + esc(range + ' · ' + plural(g.run.hours, 'hour') + ' open') + '</span></button>' + (on && g.opts.length > 1 ? startTimes(g.opts, cur, now) : '') + '</div>';
  }).join('');
  var q2 = cur.lens.map(function (k) {
    var e = cur.t + k * H;
    return '<button type="button" class="len" data-act="pick-hours" data-h="' + k + '" aria-pressed="' + (k === h) + '"><b>' + plural(k, 'hour') + '</b><span>until ' + esc(t12(e) + (endsOtherDay(cur.t, e) ? ' ' + dayWord(e) : '')) + '</span></button>';
  }).join('');
  var end = cur.t + h * H, before = Math.round((cur.t - cur.run.start) / H), after = Math.round((cur.run.end - end) / H), left = [];
  if (before > 0 && before < r.min) left.push(plural(before, 'open hour') + ' before you');
  if (after > 0 && after < r.min) left.push(plural(after, 'open hour') + ' after you');
  var opens = cur.t - r.early * MIN, cross = endsOtherDay(cur.t, end);
  var when = cur.t <= now ? 'now ' + until12(end, now) : cross ? dayWord(cur.t) + ' from ' + t12(cur.t) + ' to ' + t12(end) + ' ' + dayWord(end) : dayWord(cur.t) + ' from ' + fromTo(cur.t, end);
  var label = cur.t <= now ? 'now ' + until12(end, now) : cross ? dayWord(cur.t) + ' ' + t12(cur.t) + ' to ' + t12(end) + ' ' + dayWord(end) : dayWord(cur.t) + ' ' + r12(cur.t, end);
  return '<h3 class="q"><span aria-hidden="true">1</span>When can you come?</h3>' + q1 +
    '<h3 class="q"><span aria-hidden="true">2</span>How long can you stay?</h3><div class="lens" role="group" aria-label="How long">' + q2 + '</div>' +
    '<section class="conf" id="confirm" tabindex="-1" aria-labelledby="conf-h"><p class="lab2">Check and confirm</p>' +
      (v.practice ? '<p class="note">Practice page: no one needs to come in.</p>' : '') +
      '<h3 class="ct" id="conf-h">You’ll sit ' + esc(when) + '.</h3>' +
      '<ul class="facts2">' +
        '<li>' + svg('pin') + '<span>Check in ' + esc(where(v)) + '.</span></li>' +
        '<li>' + svg('shield') + '<span>' + (v.ppe ? 'PPE is needed. The nurse shows you what to wear.' : 'No PPE is needed.') + '</span></li>' +
        '<li>' + svg('clock') + '<span>' + (opens <= now ? 'You can check in as soon as you arrive.' : 'Arrive 5–10 minutes early. Check-in opens at ' + t12(opens) + '.') + '</span></li>' +
      '</ul>' +
      (left.length ? '<p class="hint">That leaves ' + left.join(' and ') + '.</p>' : '') +
      (cur.lens.length === 1 && cur.lens[0] < r.min ? '<p class="hint">Only ' + hrs(cur.lens[0]) + ' ' + (cur.lens[0] === 1 ? 'is' : 'are') + ' open here, so you can take ' + (cur.lens[0] === 1 ? 'it' : 'them') + ' on ' + (cur.lens[0] === 1 ? 'its' : 'their') + ' own.</p>' : '') +
      '<button type="button" class="btn primary big block" data-act="take" data-id="' + esc(v.id) + '">Sign up for ' + esc(label) + '</button>' +
      '<p class="fine">If plans change, tap “I can’t make it” on your home screen.</p>' +
    '</section>';
}
// Who's with the patient, who's coming, and what's open, from now on.
function watchList(v, now) {
  var rows = '', last = 'Today';
  segments(v, now).forEach(function (g) {
    if (g.st === 'done' || g.st === 'missed' || g.st === 'cancelled') return;
    var dl = dayLabel(g.start);
    if (dl !== last) { rows += '<li class="day">' + esc(dl) + '</li>'; last = dl; }
    var range = span12(g.start, g.end), cls, av, txt;
    if (g.s && g.s.vol === ST.me.id) { cls = 'you'; av = '<span class="av y">' + esc(initials(ST.me.name)) + '</span>'; txt = 'You'; }
    else if (g.s) { cls = 'cv'; av = '<span class="av' + (g.st === 'bedside' ? ' now' : '') + '">' + esc(initials(g.s.volName)) + '</span>'; txt = esc(g.s.volName) + (g.st === 'bedside' ? ', with the patient now' : g.st === 'late' ? ', not checked in yet' : ''); }
    else { cls = 'op'; av = '<span class="av o" aria-hidden="true"></span>'; txt = (g.st === 'opennow' ? 'Open now' : 'Open') + ' · ' + plural(g.hours, 'hour'); }
    rows += '<li class="blk ' + cls + '">' + av + '<span class="tx"><b>' + esc(range) + '</b><span>' + txt + '</span></span></li>';
  });
  return '<h3 class="h3">Who’s keeping watch</h3><ul class="tl">' + (rows || '<li class="day">No upcoming hours</li>') + '</ul>';
}
function volVigil(v) {
  var now = Date.now();
  var back = '<div class="back-row"><button type="button" class="pillbtn back" data-act="home">' + svg('back') + 'Back</button></div>';
  if (v.status !== 'active') {
    // Version 2.9: a volunteer booked for hours that hadn't started is told plainly not to come in.
    var mineGone = signupsOf(v).some(function (x) { return x.vol === ST.me.id && !x.inAt && x.end > v.ended; });
    return back + '<p class="crumb">' + esc(v.unitName) + ' · ' + esc(v.id) + '</p><h2 class="h1">This ' + (v.practice ? 'practice ' : '') + 'vigil has ended</h2>' +
      '<p class="empty">' + (mineGone ? 'Your shift on it is canceled, so please don’t come in. ' : '') + 'Thank you for being part of it.' + (v.practice ? '' : ' Your coordinator will be in touch.') + '</p>';
  }
  var just = null;
  if (UI.justTook) signupsOf(v).forEach(function (x) { if (x.id === UI.justTook && x.vol === ST.me.id) just = x; });
  var onit = just ? '<section class="card onit" id="onit" tabindex="-1"><p class="lab2">You’re on</p><p class="big">' + esc(dayLabel(just.start) + ', ' + span12(just.start, just.end)) + '</p><ol>' +
      '<li>Arrive 5–10 minutes early. Check-in opens at ' + t12(just.start - rules().early * MIN) + '.</li>' +
      '<li>Wear your NODA volunteer badge.</li>' +
      '<li>Check in ' + esc(where(v)) + '. The charge nurse walks you to the room.</li></ol></section>' : '';
  var opts = signupOptions(v, now);
  return back + '<p class="crumb">' + esc(v.unitName) + ' · ' + esc(v.id) + (v.practice ? ' · <span class="chip practice">Practice</span>' : '') + '</p>' +
    '<h2 class="h1">Sit with a patient</h2>' + (opts.length ? '<p class="sub">Two questions, then you confirm.</p>' : '') + onit +
    (opts.length ? signupQuestions(v, opts, now) : '<p class="empty">Every hour is covered right now. You’ll get an alert if hours open up.</p>') +
    watchList(v, now) +
    '<p class="hint">When you arrive, the charge nurse shares the patient’s name, room and anything you should know. If the vigil ends, you’ll get an alert.</p>' + tzNote();
}

/* ---------- coordinator ---------- */
// Version 2.6: tabs across the bottom, a word under every icon. Volunteers: Vigils, My shifts, My hours.
// Coordinator: Today, Volunteers, Report, Setup (charge nurses, links and status).
function tabList(role) {
  if ((role || ST.role) === 'vol') return [['vigils', 'Vigils', 'heart'], ['shifts', 'My shifts', 'cal'], ['hours', 'My hours', 'clock']];
  return [['vigils', 'Today', 'home'], ['volunteers', 'Volunteers', 'people'], ['report', 'Report', 'chart'], ['links', 'Setup', 'sliders']];
}
function tabsHTML(role, cur) {
  var list = tabList(role), at = cur || TAB;
  tabs.className = 'tabs n' + list.length;
  return list.map(function (t) {
    return '<button type="button" class="tab" data-act="tab" data-tab="' + t[0] + '"' + (at === t[0] ? ' aria-current="page"' : '') + '>' + svg(t[2], 'tico') + '<span>' + t[1] + '</span></button>';
  }).join('');
}
function backBtn(act, id) { return '<div class="back-row"><button type="button" class="pillbtn back" data-act="' + act + '"' + (id ? ' data-id="' + esc(id) + '"' : '') + '>' + svg('back') + 'Back</button></div>'; }
function viewSetup() {
  return '<div class="head"><h2>Setup</h2></div>' + healthView() + (ST.chargeNurses ? viewRns() : '') + practiceView() + viewLinks();
}
function volById(id) { for (var i = 0; i < ST.volunteers.length; i++) if (ST.volunteers[i].id === id) return ST.volunteers[i]; return null; }
function viewVols() {
  if (VIEW.name === 'vol' && volById(VIEW.id)) return volDetail(volById(VIEW.id));
  if (VIEW.name === 'letter' && volById(VIEW.id)) return letterView(volById(VIEW.id));
  if (VIEW.name === 'bulk') return bulkView();
  // Version 2.9: removed volunteers are listed apart, with Restore.
  var all = ST.volunteers.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var vols = all.filter(function (v) { return !v.removed; }), gone = all.filter(function (v) { return v.removed; });
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
    var remove = UI.confirmRemove === v.id
      ? '<div class="confirm"><p>Remove ' + esc(v.name) + '? They’re signed out on every phone and stop getting pages, and any hours they booked open to other volunteers. Their hours record stays, and you can restore them later.</p>' +
        '<div class="row"><button type="button" class="btn danger" data-act="remove" data-id="' + esc(v.id) + '">Remove</button><button type="button" class="btn" data-act="remove-cancel">Cancel</button></div></div>' : '';
    return '<li><div class="row"><button type="button" class="who" data-act="vol-open" data-id="' + esc(v.id) + '"><b>' + esc(v.name) + '</b><small>' + esc([v.org, v.email].filter(Boolean).join(' · ')) + appText(v) + '</small></button>' +
      (v.onCall ? '<span class="chip taken">On call</span>' : '<span class="chip done">Paused</span>') + '</div>' +
      '<div class="row"><span class="hrs">' + esc(hrsTxt(v.hours.total)) + (letterOpen(v) ? ' · <b class="flag">letter requested</b>' : '') + '</span><span class="acts">' +
      '<button type="button" class="btn small" data-act="vol-open" data-id="' + esc(v.id) + '">Hours and letter</button>' +
      '<button type="button" class="btn small" data-act="oncall" data-id="' + esc(v.id) + '" data-on="' + (v.onCall ? '0' : '1') + '">' + (v.onCall ? 'Pause' : 'Put on call') + '</button>' +
      '<button type="button" class="btn small" data-act="sendlink" data-id="' + esc(v.id) + '">' + (links ? 'Email link' : 'Email invite') + '</button>' +
      (links ? '<button type="button" class="btn small" data-act="showlink" data-id="' + esc(v.id) + '">' + (UI.showLink === v.id ? 'Hide link' : 'Show link') + '</button>' : '') +
      '<button type="button" class="btn small quiet" data-act="reset-ask" data-id="' + esc(v.id) + '">' + (links ? 'New link' : 'Sign out phones') + '</button>' +
      (serverAtLeast('2.7.0') ? '<button type="button" class="btn small quiet" data-act="remove-ask" data-id="' + esc(v.id) + '">Remove</button>' : '') + '</span></div>' +
      linkBox + reset + remove + '</li>';
  }).join('') + '</ul>' : '<p class="empty">No volunteers yet. Add the first one above.</p>';
  var removed = gone.length ? '<h3 class="sec">Removed</h3><ul class="roster">' + gone.map(function (v) {
    return '<li><div class="row"><span><b>' + esc(v.name) + '</b><small>Removed ' + esc(medDate(v.removed)) + ' · ' + esc(hrsTxt(v.hours.total)) + '</small></span>' +
      '<button type="button" class="btn small" data-act="restore" data-id="' + esc(v.id) + '">Restore</button></div></li>';
  }).join('') + '</ul>' : '';
  return '<div class="head"><p class="eyebrow">' + plural(ST.onCall, 'volunteer') + ' on call of ' + vols.length + '</p><h2>Volunteers</h2></div>' +
    '<div class="stack">' + add +
    (vols.length ? '<div class="row"><button type="button" class="btn" data-act="bulk-open">Add hours for several volunteers</button></div>' : '') +
    list + removed + '</div>' +
    '<p class="hint">' + (links
      ? 'Treat each volunteer’s link like a password. If one gets shared, make a new link.'
      : 'Email invite sends the app’s address and how to sign in with an email code.') + '</p>';
}
function appText(v) {
  return appState(v) + extraText(v);
}
function appState(v) {
  if (appOnly()) return v.devices ? ' · app notifications on' + (v.tested ? ' (tested)' : '') : v.onCall ? ' · <b class="flag">no app yet: gets no pages</b>' : '';
  if (!v.devices) return '';
  return ' · app notifications on' + (v.tested ? ' (tested)' : '') + (v.pageEmail ? '' : ' · alert emails off');
}
// Version 2.9: night pages, this week's phone check, and a phone that hasn't opened NODA in two weeks.
function extraText(v) {
  var out = '';
  if (v.nightPages) out += ' · night pages';
  if (v.onCall && v.check === 'miss') out += ' · <b class="flag">missed this week’s phone check</b>';
  if (v.onCall && v.devices && v.seen && Date.now() - v.seen > 14 * DAY) out += ' · <b class="flag">phone last opened NODA ' + esc(shortDate(v.seen)) + '</b>';
  return out;
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
  var pe = !appOnly() && !v.pageEmail
    ? '<div class="row"><span>Their phone confirms each alert it gets.</span><button type="button" class="btn small" data-act="pe-on-vol" data-id="' + esc(v.id) + '">Turn alert emails back on</button></div>'
    : '';
  var facts = [h.vigil ? hrsTxt(h.vigil) + ' at the bedside' : '', h.other ? hrsTxt(h.other) + ' other' : '', h.first ? 'since ' + longDate(h.first) : 'no hours yet', h.last ? 'last active ' + medDate(h.last) : ''].filter(Boolean).join(' · ');
  return backBtn('home') +
    '<div class="head"><p class="crumb">Volunteer · ' + esc(v.id) + '</p><h2>' + esc(v.name) + '</h2></div>' +
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
      '<div class="row"><span>App notifications</span><b>' + (v.devices ? plural(v.devices, 'phone') + (v.tested ? ', tested' : '') : appOnly() && v.onCall ? '<span class="flag">Off: gets no pages</span>' : 'Off') + '</b></div>' +
      '<div class="row"><span>Alert emails</span><b>' + (appOnly() ? 'Off for everyone (Settings tab)' : v.pageEmail ? 'On' : 'Off (phone only)') + '</b></div>' +
      (v.nightPages !== undefined ? '<div class="row"><span>Night pages</span><b>' + (v.nightPages ? 'On' : 'Off') + '</b></div>' : '') +
      (v.seen ? '<div class="row"><span>Phone last opened NODA</span><b>' + esc(medDate(v.seen)) + '</b></div>' : '') +
      (v.check ? '<div class="row"><span>This week’s phone check</span><b>' + (v.check === 'ok' ? 'Answered' : v.check === 'miss' ? '<span class="flag">No answer</span>' : 'No phone set up') + '</b></div>' : '') +
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
  var vols = ST.volunteers.filter(function (v) { return !v.removed; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  var picks = '<fieldset><legend>Volunteers</legend><div class="row"><button type="button" class="btn small" data-act="bulk-all">Select all</button><button type="button" class="btn small quiet" data-act="bulk-none">Clear</button></div>' +
    vols.map(function (v, i) {
      var on = UI.hDraft && UI.hDraft.volIds && UI.hDraft.volIds.indexOf(v.id) >= 0;
      return '<label class="opt" for="f-bulk-' + i + '"><input type="checkbox" id="f-bulk-' + i + '" name="bulkvol" value="' + esc(v.id) + '"' + (on ? ' checked' : '') + '><span>' + esc(v.name) + '</span></label>';
    }).join('') + '</fieldset>';
  return backBtn('home') +
    '<div class="head"><p class="crumb">Hours</p><h2>Add hours for several volunteers</h2></div>' +
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
  return '<div class="noprint">' + backBtn('vol-open', v.id) +
    '<div class="head"><p class="crumb">Service letter</p><h2>Letter for ' + esc(v.name) + '</h2></div>' +
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
function loadLetter(id, opts, quiet) {
  LETTER = { id: id, opts: opts, data: LETTER.id === id ? LETTER.data : null, loading: true };
  if (!quiet) render();
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
  return '<h3 class="h3' + (ST.health ? '' : ' first') + '">Charge nurses</h3><p class="eyebrow">' + plural(on, 'charge nurse') + ' can sign in</p>' + setupNote +
    '<div class="stack">' + add + rows + '</div>' +
    '<p class="hint">Each charge nurse signs in with their own work email, so the Log shows who paged. Turning someone off signs them out everywhere.</p>' +
    (si.shared
      ? '<p class="note">The shared charge RN link (below) still works too. Once your charge nurses are on this list, set Shared charge RN link to Off on the Settings tab.</p>'
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
    (rows ? '<div class="tbl-wrap" tabindex="0" role="region" aria-label="Vigil report"><table><thead><tr><th>Vigil</th><th>Unit</th><th>Started</th><th>Ended</th><th>Outcome</th><th class="num">Hours covered</th><th class="num">Companions</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="empty">No vigils yet.</p>') +
    '<p class="hint">The measures the NODA Program Guide suggests tracking. The full record is in the Sheet.</p>' +
    '<h3 class="sec">Volunteer hours</h3>' +
    (hrows ? '<div class="tbl-wrap" tabindex="0" role="region" aria-label="Volunteer hours"><table class="hours"><thead><tr><th>Volunteer</th><th class="num">Shifts</th><th class="num">Bedside</th><th class="num">Training</th><th class="num">Total</th></tr></thead><tbody>' + hrows +
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
// Version 2.9: is paging working? When the 15-minute check last ran, the outside monitor, the number nurses call,
// backup emails, the weekly phone check, and notifications Google never delivered.
function healthView() {
  var h = ST.health;
  if (!h) return '';
  var now = Date.now(), wk = ST.weekly, bp = String(ST.backupPhone || '').trim();
  var tick = !ST.tickAt ? '<span class="flag">Hasn’t run yet</span>'
    : now - ST.tickAt > 35 * MIN ? '<span class="flag">Stopped: last ran ' + esc(dayWord(ST.tickAt) + ' at ' + t12(ST.tickAt)) + '</span>' : 'Ran at ' + esc(t12(ST.tickAt));
  var week = !h.weeklyOn ? 'Off (Settings tab)'
    : !wk ? 'First one Monday after 10 AM'
    : !wk.done ? 'Sent ' + esc(dayWord(wk.at) + ' at ' + t12(wk.at)) + ', waiting for answers'
    : (wk.ok || []).length + ' of ' + ((wk.ok || []).length + (wk.miss || []).length) + ' phones answered (' + esc(shortDate(wk.at)) + ')' +
      ((wk.miss || []).length ? ' · <span class="flag">No answer: ' + esc(wk.miss.join(', ')) + '</span>' : '') +
      ((wk.none || []).length ? ' · No phone: ' + esc(wk.none.join(', ')) : '');
  return '<h3 class="h3 first">Is paging working?</h3><div class="status">' +
    '<div class="row"><span>15-minute check</span><b>' + tick + '</b></div>' +
    '<div class="row"><span>Outside monitor</span><b>' + (h.monitor === true ? 'On' : h.monitor === 'bad' ? '<span class="flag">Address not accepted: use the https://hc-ping.com/… check URL</span>' : '<span class="flag">Not set up</span>') + '</b></div>' +
    '<div class="row"><span>Number nurses call</span><b>' + (bp ? esc(bp) : '<span class="flag">Not set (Backup phone)</span>') + '</b></div>' +
    '<div class="row"><span>Backup emails</span><b>' + (h.backupEmails ? 'On: first page, sign-ups, cancellations' : 'Off') + '</b></div>' +
    '<div class="row"><span>Weekly phone check</span><b>' + week + '</b></div>' +
    '<div class="row"><span>Night pages</span><b>' + plural(ST.nightVols || 0, 'volunteer') + ' on call</b></div>' +
    '<div class="row"><span>Most hours in a row</span><b>' + (h.maxInRow ? plural(h.maxInRow, 'hour') : 'No limit') + '</b></div>' +
    (h.gaveUp ? '<div class="row"><span>Notifications never delivered</span><b class="flag">' + h.gaveUp + (h.gaveUpAt ? ', latest ' + esc(shortDate(h.gaveUpAt) + ' ' + t12(h.gaveUpAt)) : '') + '</b></div>' : '') +
    '</div><p class="hint">The outside monitor emails you if the 15-minute check stops. The weekly check sends every on-call phone a test each Monday; phones that don’t answer are listed here and under Needs you.</p>';
}
// Version 2.9: practice vigils (and their sign-ups) are cleared from the app, never by deleting rows in the Sheet.
function practiceView() {
  if (!ST.practice) return '';
  var active = ST.vigils.some(function (v) { return v.practice && v.status === 'active'; });
  return '<h3 class="sec">Practice vigils</h3>' +
    (UI.confirmClear
      ? '<div class="confirm"><p>Delete every practice vigil and its sign-ups? Real vigils aren’t touched, and practice hours never counted.</p>' +
        '<div class="row"><button type="button" class="btn danger" data-act="clear-practice">Clear practice vigils</button><button type="button" class="btn" data-act="clear-cancel">Cancel</button></div></div>'
      : '<button type="button" class="btn block" data-act="clear-ask"' + (active ? ' disabled' : '') + '>Clear practice vigils</button>' +
        (active ? '<p class="hint m0">End the active practice vigil first.</p>' : ''));
}
function viewLinks() {
  var si = ST.signIn || { email: false, links: true, shared: true };
  var codes = ST.codes || { today: 0, cap: 0 };
  var rn = !si.shared
    ? '<p class="note">The shared charge RN link is off (Settings tab). Charge nurses sign in with their own email; see Charge nurses above.</p>'
    : ST.rnLink
    ? '<div class="linkbox"><input type="text" id="rn-link" readonly value="' + esc(ST.rnLink) + '"><div class="row"><button type="button" class="btn small" data-act="copy" data-src="rn-link">Copy link</button>' +
      (UI.confirmRn ? '' : '<button type="button" class="btn small quiet" data-act="rn-ask">Make a new charge RN link</button>') + '</div></div>' +
      (UI.confirmRn ? '<div class="confirm"><p>Make a new charge RN link? The old one stops working for every unit.</p><div class="row"><button type="button" class="btn danger" data-act="rn-new">Make new link</button><button type="button" class="btn" data-act="rn-cancel">Cancel</button></div></div>' : '')
    : '<p class="note">Paste the web app URL into cell B2 on the Settings tab of the Sheet. Links appear here after that.</p>';
  var where = !ST.appUrl
    ? 'Links open the Apps Script web app. To move everyone to the phone app, paste its address next to Phone app URL on the Settings tab.'
    : si.links ? '' : 'Emails open the phone app with no personal link in them. People sign in there with their email.';
  var appOnlyN = ST.volunteers.filter(function (v) { return !v.pageEmail && !v.removed; }).length;
  var rc = ST.receipts || { sent: 0, confirmed: 0, missed: 0 };
  var checked = rc.confirmed + rc.missed;
  return '<h3 class="h3' + (ST.chargeNurses || ST.health ? '' : ' first') + '">Links and status</h3>' +
    '<h3 class="sec first">Charge RN link</h3>' + rn +
    (si.shared ? '<p class="hint">Anyone with this link can page volunteers.' +
      (ST.chargeNurses ? ' To know who paged, add charge nurses above instead.' : '') + '</p>' : '') +
    (where ? '<p class="hint">' + where + '</p>' : '') +
    '<h3 class="sec">Status</h3><div class="status">' +
      '<div class="row"><span>Emails left today</span><b>' + ST.emailLeft + '</b></div>' +
      '<div class="row"><span>App notifications</span><b>' + esc(pushStatusText()) + '</b></div>' +
      (appOnly() ? '<div class="row"><span>Alert emails</span><b>Off · sign-in only</b></div>' +
        '<div class="row"><span>Can get pages</span><b>' + reachN() + ' of ' + ST.onCall + ' on call</b></div>'
        : '<div class="row"><span>Alerts by app only</span><b>' + (appOnlyN ? plural(appOnlyN, 'volunteer') : 'None yet') + '</b></div>') +
      (checked ? '<div class="row"><span>Phone receipts</span><b>' + rc.confirmed + ' of ' + checked + ' confirmed (' + Math.round(100 * rc.confirmed / checked) + '%)</b></div>' : '') +
      '<div class="row"><span>Coordinator email</span><b>' + esc(ST.coordEmail || 'Not set') + '</b></div>' +
      (ST.signIn ? '<div class="row"><span>Email sign-in</span><b>' + (si.email ? 'On · ' + codes.today + ' of ' + codes.cap + ' codes today' : 'Off') + '</b></div>' +
        '<div class="row"><span>Links in emails</span><b>' + (si.links ? 'Personal sign-in links' : 'App address only') + '</b></div>' +
        '<div class="row"><span>Shared charge RN link</span><b>' + (si.shared ? 'On' : 'Off') + '</b></div>' : '') +
    '</div>' +
    (appOnly() ? '<p class="hint">Alert emails are off (Settings tab), so email is used only for sign-in. This Google account can email 100 people a day.</p>'
      : '<p class="hint">This Google account can email 100 people a day. App notifications don’t count.' +
      (ST.signIn ? ' Sign-in codes pause when 30 or fewer emails are left, so pages still go out.' : '') + '</p>') +
    '<button type="button" class="btn" data-act="test">Send me a test email</button>' +
    (MODE === 'pwa' ? '<h3 class="sec">Notifications on this phone</h3>' + notifCard() + deviceCard() : '');
}

/* ---------- render ---------- */
// The role's color on the whole app, and on Android's status bar (version 2.4.1). '' = signed out: the usual colors.
function roleTheme(role) {
  var r = ROLE_THEME[role] ? role : '', html = document.documentElement;
  if ((html.getAttribute('data-role') || '') !== r) { if (r) html.setAttribute('data-role', r); else html.removeAttribute('data-role'); }
  barColors(r);
}
function setTabs(show) {
  if (show) { tabs.innerHTML = tabsHTML(); tabs.hidden = false; } else { tabs.hidden = true; tabs.innerHTML = ''; }
  document.body.classList.toggle('has-tabs', !!show);
}
function render() {
  navSync();
  renderNow();
  fitHeader();
  fitScrollPad();
}
function renderNow() {
  var look = VIEW.name === 'textsize';
  var rs = look ? '' : roleSwitchHTML();
  rolesEl.innerHTML = rs; rolesEl.hidden = !rs;
  roleTheme(SWITCH ? SWITCH.to : ST && KEY ? ST.role : '');
  if (aaBtn) aaBtn.setAttribute('aria-pressed', String(look));
  if (look) { setTabs(false); paint(lookView()); return; }
  whoEl.hidden = false;
  if (SWITCH && KEY) { switchingView(!!rs); return; }
  if (MODE === 'pwa' && !KEY) { whoEl.textContent = 'Sign in'; setTabs(false); paint(signInView()); return; }
  if (!ST) return;
  if (ST.role === 'none') { whoEl.textContent = MODE === 'pwa' ? 'Sign in' : 'Link not active'; setTabs(false); paint(noneView()); return; }
  if (LS.get('lastRole') !== ST.role) LS.set('lastRole', ST.role);
  // The role under the name; the role switch says it instead for people on more than one list.
  whoEl.textContent = roleTitle(ST.role);
  whoEl.hidden = !!rs;
  // Tabs show on each tab's main screen; a screen you step into (signing up, a request, a volunteer) has Back instead.
  if (ST.role === 'vol' && ['vigils', 'shifts', 'hours'].indexOf(TAB) < 0) TAB = 'vigils';
  if (ST.role === 'coord' && ['vigils', 'volunteers', 'report', 'links'].indexOf(TAB) < 0) TAB = 'vigils';
  setTabs((ST.role === 'vol' || ST.role === 'coord') && VIEW.name === 'home');
  var html;
  if (ST.role === 'vol') html = viewVol();
  else if (ST.role === 'rn' || TAB === 'vigils') html = viewRN();
  else if (TAB === 'volunteers') html = viewVols();
  else if (TAB === 'report') html = viewReport();
  else html = viewSetup();
  paint(html);
}
function go(view, dir) {
  VIEW = view; UI = {};
  if (view.name !== 'home' && dir !== 'back') navPush('screen');
  navigate(dir || 'forward', function () { render(); window.scrollTo(0, 0); });
}
// Version 2.8: history for the phone's Back gesture (phone app only; the Apps Script page runs in a frame).
function navPush(kind) {
  if (MODE !== 'pwa' || NAV[kind]) return;
  try { history.pushState({ noda: kind }, ''); NAV[kind] = true; } catch (e) { /* no history: Back closes the app as before */ }
}
// In-app Back: step back through history when this app added that entry, so the two stay in step (popstate below
// then draws the screen). True if it did.
function navPop(kind) {
  if (MODE !== 'pwa' || !NAV[kind]) return false;
  try { history.back(); return true; } catch (e) { NAV[kind] = false; return false; }
}
// Back on a main screen by some other way (a role switch, a finished form): drop the entries left behind, quietly.
function navSync() {
  if (MODE !== 'pwa' || NAV.look || VIEW.name !== 'home') return;
  var drop = 0;
  if (NAV.screen) { NAV.screen = false; drop++; }
  if (NAV.tab && TAB === 'vigils') { NAV.tab = false; drop++; }
  if (drop) { NAV.skip++; try { history.go(-drop); } catch (e) { NAV.skip = 0; } }
}
function navDepth() { return (NAV.tab ? 1 : 0) + (NAV.screen ? 1 : 0) + (NAV.look ? 1 : 0); }
// A new version reloads from the first screen, so no Back entries are left behind for a page that no longer has them.
function reloadApp() {
  if (NAV.reload) return;
  var d = MODE === 'pwa' ? navDepth() : 0;
  if (d) { NAV.reload = true; try { history.go(-d); return; } catch (e) { NAV.reload = false; } }
  location.reload();
}
window.addEventListener('popstate', function () {
  if (MODE !== 'pwa') return;
  if (NAV.reload) { location.reload(); return; }
  // The app's own clean-up step (navSync): the screen is already right.
  if (NAV.skip) { NAV.skip--; return; }
  if (NAV.look) { NAV.look = false; closeLook(); return; }
  if (NAV.screen) {
    NAV.screen = false;
    if (VIEW.name !== 'home') { DRAFT = null; VIEW = { name: 'home' }; UI = {}; navigate('back', function () { render(); window.scrollTo(0, 0); }); }
    return;
  }
  if (NAV.tab) { NAV.tab = false; if (TAB !== 'vigils') { TAB = 'vigils'; VIEW = { name: 'home' }; UI = {}; navigate('tab', function () { render(); window.scrollTo(0, 0); }); } }
});
// Version 2.8: large text on a small phone keeps the header to one row, so more of each screen is in sight.
// Step by step, only as far as needed: a smaller logo and name; then the Text size button shows just "Aa"
// (its name is still "Text size"); then the logo steps aside.
function fitHeader() {
  var top = aaBtn && aaBtn.parentNode, ttl = top && top.querySelector('.ttl');
  if (!ttl) return;
  var wraps = function () { return aaBtn.offsetTop >= ttl.offsetTop + ttl.offsetHeight / 2; };
  void top.offsetHeight;
  var y = window.scrollY || 0;
  top.classList.remove('fit1', 'fit2', 'fit3');
  ['fit1', 'fit2', 'fit3'].some(function (c) { if (!wraps()) return true; top.classList.add(c); return false; });
  // Trying the roomier header for a moment mustn't move the page (Chrome's scroll anchoring would follow it).
  if ((window.scrollY || 0) !== y) window.scrollTo(0, y);
}
window.addEventListener('resize', function () { fitHeader(); fitScrollPad(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitHeader(); });
// Version 2.8: focus moved by keyboard or switch control never lands under the tab bar or the sticky Send bar.
function fitScrollPad() {
  var foot = app.querySelector('.foot'), pad = 0, was = false, loose = false;
  if (foot) {
    // A Page bar that would cover too much of the screen (very large text on a small or zoomed phone) stops floating
    // and waits at the end of the form: past 40% of the screen while the form is incomplete, past 50% once Page works.
    var send = foot.querySelector('#send'), ready = !!send && !send.disabled;
    was = foot.classList.contains('loose');
    loose = foot.offsetHeight > window.innerHeight * (ready ? 0.5 : 0.4);
    foot.classList.toggle('loose', loose);
    if (!loose) pad = foot.offsetHeight + 12;
  } else if (!tabs.hidden) pad = tabs.offsetHeight + 24;
  document.documentElement.style.scrollPaddingBottom = pad ? pad + 'px' : '';
  // The bar has just started floating: keep the control in use in sight above it.
  if (foot && was && !loose) {
    var a = document.activeElement;
    if (a && a !== document.body && app.contains(a) && !foot.contains(a) && a.getBoundingClientRect().bottom > foot.getBoundingClientRect().top) {
      try { a.scrollIntoView({ block: 'nearest' }); } catch (e) { /* older browser */ }
    }
  }
}
// Re-render after a tap without the screen jumping: the tapped control stays where it was, and keeps focus.
function keepPlace(el, fn) {
  var act = el.getAttribute('data-act'), key = el.getAttribute('data-t') || el.getAttribute('data-h') || '';
  var top = el.getBoundingClientRect().top;
  fn();
  var sel = '.' + el.className.split(' ')[0] + '[data-act="' + act + '"][data-' + (el.hasAttribute('data-t') ? 't' : 'h') + '="' + key + '"]';
  var again = app.querySelector(sel);
  if (again) { window.scrollBy(0, again.getBoundingClientRect().top - top); try { again.focus({ preventScroll: true }); } catch (e) { /* no focus */ } }
}

/* ---------- events ---------- */
function copyText(text, input) {
  function fallback() { if (input) { input.focus(); input.select(); } toast(input ? 'Selected. Use your phone’s Copy to copy it.' : 'Couldn’t copy. Your link is in your email from the coordinator.'); }
  try { navigator.clipboard.writeText(text).then(function () { toast('Link copied'); }, fallback); } catch (e) { fallback(); }
}
var ACT = {
  tab: function (el) {
    if (SWITCH) return;
    var t = el.getAttribute('data-tab');
    if (t === TAB && VIEW.name === 'home') { window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' }); return; }
    // Version 2.8: Back from another tab returns to the first one.
    if (t === 'vigils' && VIEW.name === 'home' && navPop('tab')) return;
    if (t !== 'vigils') navPush('tab');
    TAB = t; VIEW = { name: 'home' }; UI = {};
    navigate('tab', function () { render(); window.scrollTo(0, 0); });
  },
  home: function () { DRAFT = null; if (VIEW.name !== 'home' && navPop('screen')) return; go({ name: 'home' }, 'back'); },
  open: function (el) { go({ name: 'vigil', id: el.getAttribute('data-id') }); },
  'new': function () {
    // Version 2.9: the unit is picked every time (unless there is only one), so a float nurse can't page the last unit
    // by mistake; PPE starts at None, since it's about this patient; 48 hours, the criteria's own window. Only the
    // check-in place is remembered on this phone. Each form gets its own request ID.
    var last = rnLast() || {}, L = ST.lists, inOk = L.checkIn.indexOf(last.checkIn) >= 0;
    DRAFT = { crit1: [], crit2: [], consent: false, unitId: ST.units.length === 1 ? ST.units[0].id : '', checkIn: inOk ? last.checkIn : L.checkIn[0],
      ppe: false, startIn: 0, windowH: 48, remembered: inOk && last.checkIn !== L.checkIn[0], reqId: newReqId(), practice: false };
    go({ name: 'request' });
  },
  'req-more': function () { var f = document.getElementById('req'); if (f) readForm(f); UI.reqMore = true; render(); focusField('f-startIn-0'); },
  'dup-open': function (el) { var id = el.getAttribute('data-id'); DRAFT = null; UI = {}; VIEW = { name: 'vigil', id: id }; render(); window.scrollTo(0, 0); },
  'dup-second': function () { if (!DRAFT) return; DRAFT.second = true; UI.dup = null; render(); sendRequest(); },
  // Version 2.9: the nurse answers for a volunteer who hasn't checked in; hands a vigil's notices over; undoes an end.
  here: function (el) { act('confirmPresence', [el.getAttribute('data-id'), true]); },
  nothere: function (el) { act('confirmPresence', [el.getAttribute('data-id'), false]); },
  'take-updates': function (el) { act('takeUpdates', [el.getAttribute('data-id')]); },
  reopen: function (el) { act('reopenVigil', [el.getAttribute('data-id')]); },
  repage: function (el) { act('repage', [el.getAttribute('data-id')]); },
  extend: function (el) { act('extendVigil', [el.getAttribute('data-id'), 12]); },
  'end-ask': function (el) { UI.endAsk = el.getAttribute('data-id'); UI.reason = null; render(); },
  'end-cancel': function () { UI = {}; render(); },
  end: function (el) { var r = UI.reason; act('endVigil', [el.getAttribute('data-id'), r], function () { UI = {}; }); },
  take: function (el) {
    var vid = el.getAttribute('data-id');
    if (!UI.pickStart || !UI.pickHours) return;
    act('signUp', [vid, UI.pickStart, UI.pickHours], function (st) {
      VIEW = { name: 'vigil', id: vid }; UI = { justTook: st.signedUp }; window.scrollTo(0, 0);
      setTimeout(function () { var c = document.getElementById('onit'); if (c) { try { c.focus({ preventScroll: true }); } catch (e) { /* no focus */ } } }, 0);
    });
  },
  // Version 2.6: the home screen's one big answer opens the sign-up with that time chosen, at the confirm box.
  pick: function (el) {
    VIEW = { name: 'vigil', id: el.getAttribute('data-id') };
    UI = { pickStart: +el.getAttribute('data-t'), pickHours: +el.getAttribute('data-h') };
    navPush('screen');
    navigate('forward', function () { render(); showConfirm(); });
  },
  'pick-start': function (el) { UI.pickStart = +el.getAttribute('data-t'); keepPlace(el, function () { render(); }); },
  'pick-hours': function (el) { UI.pickHours = +el.getAttribute('data-h'); keepPlace(el, function () { render(); }); },
  'look-close': function () { closeLook(); },
  'ts-down': function () { setSize(LOOK.size - 1); },
  'ts-up': function () { setSize(LOOK.size + 1); },
  checkin: function (el) { act('checkIn', [el.getAttribute('data-id')]); },
  // Version 2.9: Check out asks first.
  'checkout-ask': function (el) {
    UI.confirmOut = el.getAttribute('data-id'); render();
    var c = document.getElementById('out-ask'); if (c) { try { c.focus({ preventScroll: true }); c.scrollIntoView({ block: 'nearest' }); } catch (e) { /* no focus */ } }
  },
  checkout: function (el) { act('checkOut', [el.getAttribute('data-id')], function () { UI = {}; }); },
  'more-times': function () { UI.allTimes = true; render(); },
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
  retry: function () { app.setAttribute('aria-busy', 'true'); app.innerHTML = '<div class="skel" aria-hidden="true"><i class="sk-title"></i><i class="sk-card"></i></div>'; load(); },
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
  myhours: function () { navPush('tab'); TAB = 'hours'; go({ name: 'home' }); },
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
    var o = { from: h.first ? isoOf(h.first) : '', to: todayISO(), salutation: 'To whom it may concern', note: '', signer: d.signer || '', title: d.title || 'NODA Lead Coordinator' };
    go({ name: 'letter', id: id });
    loadLetter(id, o, true);
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
  // Version 2.8
  'pause-yes': function () { act('setAvailability', [false], function () { UI = {}; }); },
  'pause-no': function () { UI = {}; render(); },
  'others-ask': function () { UI.confirmOthers = true; render(); },
  'others-no': function () { UI = {}; render(); },
  'others-keep': function () { NEWPHONE = false; render(); },
  'others-yes': function () {
    act('signOutOtherPhones', [pushSaved().id || ''], function (st) {
      if (st && st.key) { KEY = cleanKey(st.key); LS.set('key', KEY); }
      NEWPHONE = false; UI = {};
    });
  },
  'role-switch': function (el) { switchRoleTo(el.getAttribute('data-role')); },
  // Version 2.9: Remove and Restore (instead of deleting a row), and clearing practice vigils.
  'remove-ask': function (el) { UI.confirmRemove = el.getAttribute('data-id'); render(); },
  'remove-cancel': function () { UI.confirmRemove = null; render(); },
  remove: function (el) { act('removeVolunteer', [el.getAttribute('data-id')], function () { UI = {}; }); },
  restore: function (el) { act('restoreVolunteer', [el.getAttribute('data-id')]); },
  'clear-ask': function () { UI.confirmClear = true; render(); },
  'clear-cancel': function () { UI.confirmClear = false; render(); },
  'clear-practice': function () { act('clearPractice', [], function () { UI = {}; }); }
};
app.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]'); if (!el || el.disabled) return;
  var fn = ACT[el.getAttribute('data-act')]; if (fn) { LAST_BTN = el; fn(el); LAST_BTN = null; }
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
  if (t.name === 'theme') { setTheme(t.value); return; }
  if (t.id === 'ts-range') { setSize(t.value); return; }
  if (t.id === 'f-avail') {
    // Version 2.8: pausing takes a second tap, so a slip while scrolling doesn't stop someone's pages.
    if (!t.checked && ST && ST.me && ST.me.onCall) {
      t.checked = true; UI.confirmPause = true; render();
      var y = document.querySelector('#pause-ask [data-act="pause-yes"]'); if (y) { try { y.focus(); } catch (e2) { /* no focus */ } }
      return;
    }
    UI.confirmPause = false;
    act('setAvailability', [t.checked]);
    return;
  }
  if (t.id === 'f-pagemail') { act('setPageEmail', [t.checked]); return; }
  if (t.id === 'f-night') { act('setNightPages', [t.checked]); return; }
  if (t.name === 'reason') { UI.reason = t.value; var b = app.querySelector('[data-act="end"]'); if (b) b.disabled = false; }
});
app.addEventListener('input', function (e) { if (e.target.id === 'ts-range') setSize(e.target.value); });
if (aaBtn) aaBtn.addEventListener('click', function () { if (VIEW.name === 'textsize') closeLook(); else openLook(); });
app.addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target;
  if (f.id === 'req') {
    readForm(f);
    if (!reqOK(DRAFT)) { updateReq(); return; }
    sendRequest();
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
document.addEventListener('visibilitychange', function () {
  // Version 2.7: a newer version installed while the app was open. Switch to it while the app is out of sight,
  // or on return if that didn't happen, unless something is being typed.
  if (UPDATED && (document.visibilityState === 'hidden' || !editing())) { reloadApp(); return; }
  if (document.visibilityState !== 'visible') return;
  // A phone can keep the app open for days without reloading it: look for a new version at most once an hour.
  if (PUSH.reg && Date.now() - UPDATE_CHECK > 3600e3) { UPDATE_CHECK = Date.now(); PUSH.reg.update().catch(function () {}); }
  if (autoRefreshOK()) load();
});

/* ---------- start ---------- */
// The phone app reads the key from "#k=" (or "?k=") once, keeps it on this device, and cleans the address bar.
function takeFromUrl() {
  var out = { key: '', vigil: '', kind: '' }, found = false;
  [location.hash.replace(/^#/, ''), location.search.replace(/^\?/, '')].forEach(function (part) {
    part.split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i < 1) return;
      var name = kv.slice(0, i), val = kv.slice(i + 1);
      try { val = decodeURIComponent(val.replace(/\+/g, ' ')); } catch (e) { return; }
      if (name === 'k') { found = true; if (!out.key) out.key = cleanKey(val); }
      if (name === 'v') { found = true; if (!out.vigil && /^V-\d{1,9}$/.test(val)) out.vigil = val; }
      if (name === 'n') { found = true; if (!out.kind && /^[a-z-]{1,20}$/.test(val)) out.kind = val; }
    });
  });
  if (found) { try { history.replaceState(null, '', location.pathname); } catch (e) { /* keep the address */ } }
  if (out.key.length < 16) out.key = '';
  return out;
}
function onSwMessage(e) {
  var d = (e && e.data) || {};
  if (d.type === 'noda-updated') { if (d.version === APP_VERSION) return; UPDATED = true; if (document.visibilityState === 'hidden' || !ST) reloadApp(); return; }
  if (d.type === 'noda-push' && d.kind === 'test') { if (TEST.waiting) testCheckIn(1500); return; }
  if (d.type === 'noda-push') { if (KEY && !BUSY && !editing()) load(); }
  else if (d.type === 'noda-open') { DEEP = { vigil: /^V-\d{1,9}$/.test(d.vigil || '') ? d.vigil : '', kind: /^[a-z-]{1,20}$/.test(d.kind || '') ? d.kind : '' }; if (KEY) load(); }
  else if (d.type === 'noda-resubscribe') { var s = pushSaved(); if (s.on) { s.ep = 'changed'; pushSave(s); PUSH.lastRefresh = 0; pushRefresh(); } }
}
function startPWA() {
  if ('serviceWorker' in navigator) {
    // Version 2.7: register once the page has loaded, so a first visit's saved copy doesn't slow the first screen.
    var reg = function () { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* the app still works without it */ }); };
    if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
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
  DEEP = u.vigil || u.kind ? { vigil: u.vigil, kind: u.kind } : null;
  keepStorage();
  if (u.key) switchKey(u.key); else KEY = cleanKey(LS.get('key'));
  if (KEY.length < 16) KEY = '';
  rolesLoad();
  // Sign-in starts with email, unless this server said email sign-in is off (then: paste a link).
  SIGN = { step: LS.get('signin') === 'link' ? 'paste' : 'email' };
  if (!KEY) { render(); return; }
  bootShell();
  load();
}

// Version 2.7: while the first data loads, show the tabs and colors of the role last used on this phone.
function bootShell() {
  var r = LS.get('lastRole');
  if (r !== 'vol' && r !== 'rn' && r !== 'coord') return;
  roleTheme(r);
  if (r !== 'rn') { tabs.innerHTML = tabsHTML(r); tabs.hidden = false; document.body.classList.add('has-tabs'); }
}
lookLoad();
if (MODE === 'gas') {
  if (!KEY) { ST = { role: 'none' }; render(); } else { bootShell(); load(); }
} else if (MODE === 'pwa') {
  startPWA();
} else {
  whoEl.textContent = 'Not set up yet';
  app.innerHTML = '<div class="head"><h2>This is the app’s code, not the live app</h2></div>' +
    '<p class="empty">NODA Alert runs inside Google Apps Script. It starts working once it’s pasted into a Google Sheet’s Apps Script editor and deployed as a web app, as the setup guide describes. Until then, use the clickable demo to see how it works.</p>';
}
})();
