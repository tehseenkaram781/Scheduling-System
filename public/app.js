'use strict';
// ---------------------------------------------------------------------------
// Styled role-aware SPA (plain JS + design-system CSS). Talks to /api.
// Every role sees the same shell; nav items + pages differ per RBAC.
// ---------------------------------------------------------------------------

const user = JSON.parse(sessionStorage.getItem('user') || 'null');
if (!user) location.replace('login.html');

// Hard bound on a single cell (one row × one day), every entry type. Mirrors the
// server's MAX_HOURS_PER_ENTRY. Unrelated to the daily-overtime flag, which only
// warns on the summed total across a day and never blocks. A single cell may hold
// a whole day; DAY_CAP then stops anything else being added to that date.
const MAX_HOURS = 24;
// ---- HH:MM duration formatting ---------------------------------------------
// TimeEntry.hours is stored (and sent to/from the API) as decimal hours, e.g.
// 8.5 — unchanged on the backend. Every place that shows a SINGLE entry's or a
// single table cell's logged duration displays it clock-style as HH:MM instead
// of that raw decimal; sums across many entries/days/subtasks keep the existing
// plain "Nh" format, since those aren't one entry's timestamp.
function hoursToHHMM(h) {
  const n = Number(h);
  if (!isFinite(n)) return '—';
  const mins = Math.round(n * 60);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
// Forgiving duration parser — people type shorthand, not zero-padded HH:MM.
// Returns { hours, canonical } for anything recognisable, or { error } with a
// message to show. Deliberately refuses to guess at unrecognisable input rather
// than silently coercing it to some number of hours.
//   8      → 08:00   (bare 1-2 digits = whole hours)
//   :34    → 00:34   (leading colon = minutes only)
//   9:3    → 09:03   (both sides parsed independently, then padded)
//   9:     → 09:00   (mid-type trailing colon)
//   930    → 09:30   (bare 3-4 digits = HHMM)
// `hours` is rounded to the 2-decimal precision the database column stores, so
// the minute the user typed round-trips exactly.
function parseDuration(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '');
  if (s === '') return { error: 'Enter a duration — e.g. 8:30, 830 or 8' };
  let m, hh, mm;
  if ((m = s.match(/^(\d{1,2})$/))) { hh = +m[1]; mm = 0; }
  else if ((m = s.match(/^:(\d{1,2})$/))) { hh = 0; mm = +m[1]; }
  else if ((m = s.match(/^(\d{1,2}):(\d{0,2})$/))) { hh = +m[1]; mm = m[2] === '' ? 0 : +m[2]; }
  else if ((m = s.match(/^(\d{1,2})(\d{2})$/))) { hh = +m[1]; mm = +m[2]; }
  else return { error: "Couldn't understand that — try something like 8:30 or 830" };
  if (mm > 59) return { error: 'Minutes must be between 00 and 59' };
  return {
    hours: Math.round((hh + mm / 60) * 100) / 100,
    canonical: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'),
  };
}
// ---- display unit (Hours | Days) -------------------------------------------
// A per-user RENDERING preference and nothing more. Hours remain the unit of
// storage (TimeEntry.hours), of entry (the HH:MM field), and of every rule that
// operates on time — the 0:00–9:00 per-cell bound, the 24h daily cap and the
// 40h weekly row cap all keep reading raw hours and are entirely unaware of
// this setting. Switching it can therefore never change a stored figure, nor
// whether a limit is breached.
const DAY_HOURS = 8;
const unitPref = () => ((user && user.displayUnit) === 'DAYS' ? 'DAYS' : 'HOURS');
/**
 * The single place a duration becomes text. Every display site calls this, so
 * the 8-hour day and the 2-decimal rule exist once rather than being re-derived
 * (and drifting) per screen.
 *
 * `opts.clock` picks the HOURS-mode style: true renders one entry's own
 * duration clock-style (08:30), false the plain aggregate style (8.5h). That
 * distinction is meaningless in DAYS mode — "0.5 of a day" has no clock
 * reading — so both collapse to the same decimal-day text there.
 *
 * Trailing zeros are trimmed (40h → "5d", not "5.00d"): a fixed 2dp makes every
 * round figure look falsely precise, and the cap is what the spec pins down,
 * not the padding.
 */
function formatDuration(hours, opts) {
  const n = Number(hours);
  if (!isFinite(n)) return '—';
  if (unitPref() === 'DAYS') {
    return (Math.round((n / DAY_HOURS) * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + 'd';
  }
  return (opts && opts.clock) ? hoursToHHMM(n) : num(n) + 'h';
}
// Shorthand for the two call styles, so display sites read cleanly.
const dur = (h) => formatDuration(h);                  // aggregates: "8.5h" / "1.06d"
const durClock = (h) => formatDuration(h, { clock: true }); // one entry: "08:30" / "1.06d"
// Column headings and prose that name the unit. A table headed "Hours" above a
// column of "1.06d" values contradicts itself, so the word tracks the setting.
const unitLabel = () => (unitPref() === 'DAYS' ? 'Days' : 'Hours');
const unitLabelLower = () => (unitPref() === 'DAYS' ? 'days' : 'hours');

// Snaps a duration field to canonical HH:MM. Wired to blur/Enter only — the user
// is mid-thought on every other keystroke, and rewriting the value under the
// caret as they type moves the cursor and fights them.
window.normalizeHoursField = (el) => {
  if (!el) return;
  const raw = String(el.value).trim();
  const err = $('mHoursErr');
  if (raw === '') return; // an empty field isn't a format error — that's the save's job
  const r = parseDuration(raw);
  if (r.error) { if (err) { err.textContent = r.error; err.hidden = false; } return; }
  el.value = r.canonical;
  if (err) err.hidden = true;
};
// Enter in the Duration field submits the dialog exactly as clicking its Save/
// Request-edit button would — `onSubmit` is that same action, passed in by each
// call site. Validation is unchanged: `onSubmit` runs readHoursInput() itself
// (parse, then range check), so an invalid value surfaces the normal inline
// error instead of silently saving or silently doing nothing.
window.hoursFieldKey = (e, el, onSubmit) => {
  if (e.key === 'Enter') { e.preventDefault(); normalizeHoursField(el); if (onSubmit) onSubmit(); }
};
// Single-line fields (Reason) submit on Enter the same way Duration does.
window.submitFieldKey = (e, onSubmit) => {
  if (e.key === 'Enter') { e.preventDefault(); if (onSubmit) onSubmit(); }
};
// Notes is a multi-line textarea — plain Enter must stay a newline, so only
// Ctrl/Cmd+Enter submits from there.
window.notesFieldKey = (e, onSubmit) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (onSubmit) onSubmit(); }
};
// Escape closes whichever modal is open — the Cancel/Close button's action,
// wherever the focus happens to be inside it (Duration, Notes, Reason, or
// elsewhere). One listener covers every modal in the app, not just this dialog.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('overlay')) closeModal();
});
// An 8-hour day is the reference point on the main timesheet grid: exactly 8h
// reads as plain ink ("black"), under reads as the danger red, over as the
// success green — both already theme-aware, so contrast holds in light and dark.
function hoursColorClass(h) {
  const n = Number(h);
  if (n < 8) return 'hh-under';
  if (n > 8) return 'hh-over';
  return 'hh-eq';
}
// `cls` overrides the value-derived colour. The weekly grid passes its day
// column's class so every cell in a day agrees; pass '' for no colour at all
// (the Total column, where an 8-hour rule would be meaningless).
function hhmmSpan(h, cls) {
  // hoursColorClass still reads raw HOURS: the 8-hour reference is a fact about
  // the day, not about how the reader has chosen to see it, so the colouring is
  // identical in both units even though the text is not.
  const c = cls === undefined ? hoursColorClass(h) : cls;
  return `<span class="hh-val ${c}">${durClock(h)}</span>`;
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let currentWeek = mondayOf(new Date());
let reviewingUserId = '';
let reviewingUserName = ''; // label for a deep-linked reviewee not in the shortlist
let subtaskMap = {};
let collapsed = new Set();
let activeNav = 'inbox'; // default landing tab — see boot()
let analyticsRange = 'month';
// Shared vocabulary for every "activity range" picker in the app (Summary, the
// Dashboard's team-scoped cards, deep search). Keeping one definition means
// adding a range here — e.g. the '1y' option — updates every picker at once.
const ACTIVITY_RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['6m', 'Last 6 months'], ['1y', 'Last 1 year'], ['custom', 'Custom range'], ['lifetime', 'Lifetime']];
let historyRange = '30d';
let historyCustom = { start: '', end: '' }; // Summary: custom-range bounds
let teamRange = '30d';                      // Dashboard team aggregate: same vocabulary as Summary
let teamCustom = { start: '', end: '' };
let leadRange = '30d';                      // Dashboard: Team Lead's own hour-distribution cards
let leadCustom = { start: '', end: '' };
let dsRange = 'lifetime';                   // Deep search: defaults wide open, unlike the other cards
let dsCustom = { start: '', end: '' };
let peopleFilter = 'members';   // People page: 'members' | 'leads' (sidebar-driven)
let approvalsTab = 'pending';   // Approvals page: 'pending' | 'edits' (sidebar-driven)
let approvalsRole = '';         // Approvals page: '' = all, else a Role to filter the queue by
let subtasksSection = 'create'; // Subtasks page: 'all' | 'create' | 'leads' (sidebar-driven)
let dashSection = '';           // Dashboard: selected component key (per role, sidebar-driven)
let clientsSection = 'list';    // Clients page: 'list' | 'add' (sidebar-driven; CEO only gets 'add')
let calCursor = new Date();     // Calendar page: any date within the displayed month
let calPickYear = calCursor.getFullYear(); // year shown in the month-jump picker

// ---- date helpers ---------------------------------------------------------
function mondayOf(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay();
  x.setUTCDate(x.getUTCDate() + ((day === 0 ? -6 : 1) - day));
  return x;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function fmtDay(d) { return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; }
function weekRangeLabel(m) { const s = addDays(m, 6); return `${fmtDay(m)} – ${fmtDay(s)}, ${s.getUTCFullYear()}`; }
function relTime(s) {
  const t = (Date.now() - new Date(s).getTime()) / 1000;
  if (t < 60) return 'just now'; if (t < 3600) return Math.floor(t / 60) + 'm ago';
  if (t < 86400) return Math.floor(t / 3600) + 'h ago'; return Math.floor(t / 86400) + 'd ago';
}
// Compact number formatter — used for hour totals (e.g. "7.5h", "1,204h").
function num(n) { return (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Project identity is text-only now (palette retired the per-project hues); the
// marker stays a small neutral dot so row alignment is unchanged.
const projSwatch = () => `<span class="proj-swatch" style="background:var(--text3)"></span>`;
// A person chip: mini initials avatar + name (uses the global `initials`).
// `leaderless`/empty renders a muted placeholder.
const personChip = (name) => name
  ? `<span class="lead-chip"><span class="mini-avatar">${esc(initials(name))}</span>${esc(name)}</span>`
  : `<span class="lead-chip leaderless"><span class="mini-avatar">–</span>leaderless</span>`;

// ---- icons ----------------------------------------------------------------
const ICONS = {
  calendar: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M16 3v4M8 3v4M4 11h16"/>',
  table: '<path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M4 10h16M10 4v16"/>',
  inbox: '<path d="M4 13v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/><path d="M4 13l2.5-7A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1L20 13M4 13h4l1 2h6l1-2h4"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h12l-3-3m0 6l3-3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>', next: '<path d="M9 6l6 6-6 6"/>',
  chevronR: '<path d="M9 6l6 6-6 6"/>', chevronD: '<path d="M6 9l6 6 6-6"/>',
  folder: '<path d="M4 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  check: '<path d="M5 12l5 5L20 7"/>', users: '<path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M17 20a6 6 0 0 0-3-5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
  pencil: '<path d="M4 20h4l10-10a2 2 0 0 0-4-4L4 16v4zM13 6l4 4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>', building: '<path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 21V9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4.3-4.3"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  minus: '<path d="M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  kebab: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
};
function icon(n, cls) { return `<svg class="icon ${cls || ''}" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`; }

// ---- api ------------------------------------------------------------------
async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers, { Authorization: 'Bearer ' + sessionStorage.getItem('jwt') });
  let res = await fetch('/api' + path, opts);
  if (res.status === 401) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: sessionStorage.getItem('refresh') }) });
    if (r.ok) { const d = await r.json(); sessionStorage.setItem('jwt', d.accessToken); sessionStorage.setItem('refresh', d.refreshToken); opts.headers.Authorization = 'Bearer ' + d.accessToken; res = await fetch('/api' + path, opts); }
    else { sessionStorage.clear(); location.replace('login.html'); throw new Error('Session expired'); }
  }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || ('HTTP ' + res.status)); }
  return res.status === 204 ? null : res.json();
}
const $ = (id) => document.getElementById(id);
const view = () => $('view');
function toast(msg) { /* lightweight non-blocking notice */ const d = document.createElement('div'); d.textContent = msg; d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg2);color:var(--text1);border:1px solid var(--border);padding:10px 16px;border-radius:10px;z-index:99'; document.body.appendChild(d); setTimeout(() => d.remove(), 2200); }

// ---- theme ----------------------------------------------------------------
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
function toggleTheme() {
  const t = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.cookie = `theme=${t}; path=/; max-age=31536000`;
  // Keep the Profile Settings panel's switch in sync when it's the open UI.
  const sw = $('pmThemeSwitch'); if (sw) sw.checked = t === 'dark';
  const lbl = $('pmThemeLabel'); if (lbl) lbl.textContent = t === 'dark' ? 'Dark' : 'Light';
}

// ---- modal ----------------------------------------------------------------
// Open animates in (fade + slight scale via CSS); close plays the reverse before
// the node is removed. A pending close is cancelled if a new modal opens first
// (e.g. close-then-open handoffs like pickRequestEdit) so the new one survives.
let _modalCloseTimer = null;
function openModal(inner) {
  if (_modalCloseTimer) { clearTimeout(_modalCloseTimer); _modalCloseTimer = null; }
  $('modalMount').innerHTML = `<div class="modal-overlay" id="overlay"><div class="modal">${inner}</div></div>`;
  $('overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
}
function closeModal() {
  cropState = null; // drop any in-flight avatar crop (and its working canvas)
  const ov = $('overlay'); const mount = $('modalMount');
  if (!ov) { if (mount) mount.innerHTML = ''; return; }
  ov.classList.add('closing'); // triggers the reverse fade/scale
  if (_modalCloseTimer) clearTimeout(_modalCloseTimer);
  _modalCloseTimer = setTimeout(() => { const m = $('modalMount'); if (m) m.innerHTML = ''; _modalCloseTimer = null; }, 160);
}

// ---- sidebar / nav --------------------------------------------------------
function initials(n) { return n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }
function navItemsForRole() {
  // Admin is a system role: just the Users & teams panel, no business views.
  if (user.role === 'ADMIN') return [{ key: 'admin', label: 'Users & teams', icon: 'users' }];
  // Order: Notifications first (also the login landing tab), then Timesheet
  // and Calendar, then the role-specific sections.
  const base = [
    { key: 'inbox', label: 'Notifications', icon: 'inbox' },
    { key: 'table', label: 'Timesheet', icon: 'table' },
    { key: 'calendar', label: 'Calendar', icon: 'calendar' },
  ];
  const byRole = {
    CEO: [{ key: 'projects', label: 'Projects', icon: 'folder' }, { key: 'clients', label: 'Clients', icon: 'building' }, { key: 'teams', label: 'Teams', icon: 'users' }, { key: 'dashboard', label: 'Dashboard', icon: 'chart' }, { key: 'audit', label: 'Audit log', icon: 'shield' }],
    PM: [{ key: 'subtasks', label: 'Tasks', icon: 'list' }, { key: 'approvals', label: 'Approvals', icon: 'check' }, { key: 'teams', label: 'Teams', icon: 'users' }, { key: 'people', label: 'People', icon: 'users' }, { key: 'dashboard', label: 'Dashboard', icon: 'chart' }, { key: 'audit', label: 'Audit log', icon: 'shield' }],
    TEAM_LEAD: [{ key: 'team', label: 'My tasks', icon: 'list' }, { key: 'teams', label: 'My teams', icon: 'users' }, { key: 'history', label: 'Summary', icon: 'clock' }, { key: 'dashboard', label: 'Dashboard', icon: 'chart' }],
    TEAM_MEMBER: [{ key: 'history', label: 'Summary', icon: 'clock' }, { key: 'dashboard', label: 'Dashboard', icon: 'chart' }],
  };
  return base.concat(byRole[user.role] || []);
}
function renderSidebar() {
  paintAvatar($('avatar'), user);
  $('userName').textContent = user.name;
  $('userRole').textContent = user.role.replace('_', ' ').toLowerCase();
  $('nav').innerHTML = navItemsForRole().map((it) => `<a href="#" class="rail-item ${activeNav === it.key ? 'active' : ''}" data-nav="${it.key}" title="${esc(it.label)}" aria-label="${esc(it.label)}">${icon(it.icon)}<span class="rail-label">${esc(it.label)}</span></a>`).join('');
  $('nav').querySelectorAll('[data-nav]').forEach((el) => { el.onclick = (e) => { e.preventDefault(); go(el.dataset.nav); }; });
  // Brand lockup doubles as "home" — the first tab this role sees.
  const brand = $('railBrand');
  if (brand) brand.onclick = (e) => { e.preventDefault(); const first = navItemsForRole()[0]; if (first) go(first.key); };
  // Profile card is now the sidebar's last element and opens the settings panel
  // upward. Log out moved inside that panel — there is no standalone link.
  const card = $('profileCard');
  if (card) card.onclick = (e) => { e.stopPropagation(); toggleProfileMenu(); };
  renderBottomNav();
  updateSidebarContext(activeNav);
}
/**
 * Renders an avatar element: the uploaded picture when one is set, otherwise the
 * initials treatment that every account has used until now. One helper so the
 * sidebar card and the panel's preview can never disagree about the fallback.
 */
function paintAvatar(el, u) {
  if (!el) return;
  if (u.avatarUrl) {
    el.textContent = '';
    el.style.backgroundImage = `url("${u.avatarUrl}")`;
    el.classList.add('has-img');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
    el.textContent = initials(u.name);
  }
}
// ---- Profile Settings panel ------------------------------------------------
// Anchored to the profile card at the BOTTOM of the sidebar and opening upward
// (CSS `bottom: 100%`), so it expands into the empty space above the card and
// never covers the nav items. Reuses the app's existing surface tokens — same
// radius/shadow/border language as the kebab menu and modals.
function profileMenuHtml() {
  const dark = currentTheme() === 'dark';
  // Identity block, one editable field, one preference, then two quiet rows.
  // The password fields stay collapsed — they are a rare, deliberate action and
  // shouldn't occupy half a preferences popover by default.
  return `<div class="pm-head">
      <div class="avatar pm-avatar" id="pmAvatar">–</div>
      <div class="pm-id">
        <div class="pm-email" title="${esc(user.email)}">${esc(user.email)}</div>
        <div class="pm-photo-actions">
          <button type="button" class="pm-link" onclick="$('pmAvatarFile').click()">Change photo</button>
          <span id="pmAvatarClear" hidden><span class="pm-dot" aria-hidden="true">·</span><button type="button" class="pm-link" onclick="clearAvatar()">Remove</button></span>
        </div>
      </div>
      <input type="file" id="pmAvatarFile" accept="image/png,image/jpeg,image/webp" hidden onchange="pickAvatar(this)">
    </div>
    <div class="field pm-field"><label for="pmName">Display name</label>
      <input id="pmName" maxlength="120" value="${esc(user.name)}" onkeydown="submitFieldKey(event,()=>saveProfile())">
      <div class="field-error" id="pmNameErr" hidden></div>
      <div class="pm-save"><button class="btn btn-primary btn-sm" onclick="saveProfile()">Save</button></div>
    </div>
    <div class="pm-row">
      <span class="pm-row-label">Appearance</span>
      <label class="pm-switch" title="Toggle light / dark">
        <input type="checkbox" id="pmThemeSwitch" ${dark ? 'checked' : ''} onchange="toggleTheme()">
        <span class="pm-switch-track"><span class="pm-switch-knob"></span></span>
        <span class="pm-switch-text" id="pmThemeLabel">${dark ? 'Dark' : 'Light'}</span>
      </label>
    </div>
    <div class="pm-row">
      <span class="pm-row-label">Unit</span>
      <div class="segmented pm-seg" id="pmUnit" title="How durations are shown — ${DAY_HOURS}h = 1 day. Entry stays HH:MM.">
        ${[['HOURS', 'Hours'], ['DAYS', 'Days']].map(([v, l]) =>
          `<button type="button" class="seg${unitPref() === v ? ' active' : ''}" data-unit="${v}" onclick="setDisplayUnit('${v}')">${l}</button>`).join('')}
      </div>
    </div>
    <div class="pm-sep"></div>
    <button type="button" class="pm-rowbtn" id="pmPwToggle" aria-expanded="false" aria-controls="pmPwFields" onclick="togglePasswordFields()">
      <span>Change password</span>
      <svg class="icon pm-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
    </button>
    <div id="pmPwFields" class="pm-fold" hidden>
      <input id="pmPwCurrent" type="password" placeholder="Current password" autocomplete="off">
      <input id="pmPwNew" type="password" placeholder="New password" autocomplete="off">
      <input id="pmPwConfirm" type="password" placeholder="Confirm new password" autocomplete="off">
      <button class="btn btn-sm pm-full" onclick="changePasswordPlaceholder()">Update password</button>
    </div>
    <button type="button" class="pm-rowbtn pm-logout" onclick="logOut()"><span>Log out</span>${icon('logout')}</button>`;
}
function openProfileMenu() {
  const m = $('profileMenu'), card = $('profileCard');
  if (!m) return;
  m.innerHTML = profileMenuHtml();
  m.hidden = false;
  if (card) card.setAttribute('aria-expanded', 'true');
  paintAvatar($('pmAvatar'), user);
  const clear = $('pmAvatarClear'); if (clear) clear.hidden = !user.avatarUrl;
  const n = $('pmName'); if (n) n.focus();
}
function closeProfileMenu() {
  const m = $('profileMenu'), card = $('profileCard');
  if (m) { m.hidden = true; m.innerHTML = ''; }
  if (card) card.setAttribute('aria-expanded', 'false');
}
function toggleProfileMenu() {
  const m = $('profileMenu');
  if (m && m.hidden) openProfileMenu(); else closeProfileMenu();
}
// Dismiss on outside click / Escape, matching the kebab menu's behaviour.
// The crop dialog is mounted outside the menu but is logically part of it, so
// interacting with it must not dismiss the menu underneath.
document.addEventListener('click', (e) => {
  const m = $('profileMenu');
  if (!m || m.hidden) return;
  const inside = e.target.closest && (e.target.closest('#profileCard') || e.target.closest('#modalMount'));
  if (m.contains(e.target) || inside) return;
  closeProfileMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('overlay')) return; // a modal is on top — Escape belongs to it, not us
  closeProfileMenu();
});

// ---- Avatar: pick → crop → store ------------------------------------------
// Picking a file no longer commits an automatic centre-crop; it opens a
// crop/reposition step so the user decides what ends up inside the circle.
// Everything is client-side canvas work — no cropping library, matching the
// app's hand-rolled approach everywhere else. What finally gets stored is a
// single AVATAR_PX JPEG (tens of KB), never the original plus coordinates, so
// the server still never has to process image bytes.
const AVATAR_PX = 256;          // stored square, in px
const CROP_FRAME = 260;         // on-screen preview square, in CSS px
const MAX_AVATAR_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_PX = 8000;     // reject absurd dimensions outright
const CROP_WORK_PX = 2000;      // pre-downscale huge sources so dragging stays smooth
const CROP_MAX_ZOOM = 4;        // relative to "just covers the frame"
let cropState = null;

window.pickAvatar = (input) => {
  const file = input.files && input.files[0];
  input.value = ''; // let the same file be re-picked after a Remove/Cancel
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { toast('Pick a PNG, JPEG or WebP image'); return; }
  if (file.size > MAX_AVATAR_BYTES) { toast('That image is over 12 MB — pick a smaller one'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // naturalWidth/Height (not width/height) because a detached <img> never
      // enters the document and so has no CSS layout box to derive them from.
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih) { toast("That image couldn't be read"); return; }
      if (iw > MAX_SOURCE_PX || ih > MAX_SOURCE_PX) { toast(`That image is too large — max ${MAX_SOURCE_PX}px per side`); return; }
      openAvatarCropper(cropWorkSource(img, iw, ih));
    };
    img.onerror = () => toast("That image couldn't be read");
    img.src = reader.result;
  };
  reader.onerror = () => toast("That file couldn't be read");
  reader.readAsDataURL(file);
};

/** A 12MP photo repainted on every pointermove is sluggish; shrink it once up
 *  front. Well above what a 256px avatar can resolve, so nothing is lost. */
function cropWorkSource(img, iw, ih) {
  const longest = Math.max(iw, ih);
  if (longest <= CROP_WORK_PX) return img;
  const k = CROP_WORK_PX / longest;
  const c = document.createElement('canvas');
  c.width = Math.round(iw * k); c.height = Math.round(ih * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c; // drawImage accepts a canvas as a source just like an image
}

function openAvatarCropper(src) {
  const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
  // Minimum zoom is "just covers the frame", so the image can never be shrunk
  // small enough to leave empty corners inside the crop.
  const minScale = CROP_FRAME / Math.min(iw, ih);
  cropState = { src, iw, ih, minScale, maxScale: minScale * CROP_MAX_ZOOM, scale: minScale, ox: 0, oy: 0 };
  cropState.ox = (CROP_FRAME - iw * minScale) / 2;
  cropState.oy = (CROP_FRAME - ih * minScale) / 2;
  openModal(`<h3>Adjust your picture</h3>
    <p class="crop-hint">Drag to reposition · scroll or use the slider to zoom</p>
    <div class="crop-stage" id="cropStage">
      <canvas class="crop-canvas" id="cropCanvas"></canvas>
      <div class="crop-mask"></div><div class="crop-ring"></div>
    </div>
    <div class="crop-zoom">
      <span class="crop-zoom-mark" aria-hidden="true">&minus;</span>
      <input type="range" id="cropZoom" min="0" max="100" step="1" value="0" aria-label="Zoom">
      <span class="crop-zoom-mark" aria-hidden="true">+</span>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="applyAvatarCrop()">Save picture</button>
    </div>`);
  wireCropper();
}

/** Keeps the image covering the frame on every axis — no empty gutters. */
function clampCrop() {
  const w = cropState.iw * cropState.scale, h = cropState.ih * cropState.scale;
  cropState.ox = Math.min(0, Math.max(CROP_FRAME - w, cropState.ox));
  cropState.oy = Math.min(0, Math.max(CROP_FRAME - h, cropState.oy));
}
function drawCrop() {
  const cv = $('cropCanvas');
  if (!cv || !cropState) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // crisp on retina, capped
  const backing = Math.round(CROP_FRAME * dpr);
  if (cv.width !== backing) { cv.width = cv.height = backing; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CROP_FRAME, CROP_FRAME);
  ctx.drawImage(cropState.src, cropState.ox, cropState.oy, cropState.iw * cropState.scale, cropState.ih * cropState.scale);
}
function syncCropZoom() {
  const z = $('cropZoom');
  if (!z || !cropState) return;
  const span = cropState.maxScale - cropState.minScale;
  z.value = String(span ? Math.round(((cropState.scale - cropState.minScale) / span) * 100) : 0);
}
/** Zooms about a fixed point (frame centre by default, cursor for the wheel),
 *  so the pixel under that point stays put instead of drifting. */
function setCropScale(next, ax, ay) {
  const s = cropState.scale;
  const n = Math.min(cropState.maxScale, Math.max(cropState.minScale, next));
  if (n === s) return;
  if (ax == null) { ax = CROP_FRAME / 2; ay = CROP_FRAME / 2; }
  cropState.ox = ax - ((ax - cropState.ox) / s) * n;
  cropState.oy = ay - ((ay - cropState.oy) / s) * n;
  cropState.scale = n;
  clampCrop(); drawCrop(); syncCropZoom();
}
function wireCropper() {
  const stage = $('cropStage'), zoom = $('cropZoom');
  if (!stage) return;
  drawCrop(); syncCropZoom();
  zoom.oninput = () => setCropScale(cropState.minScale + (+zoom.value / 100) * (cropState.maxScale - cropState.minScale));
  // Pointer events cover mouse, touch and pen in one path; capture keeps the
  // drag alive when the cursor leaves the frame mid-gesture.
  let pid = null, lastX = 0, lastY = 0;
  stage.addEventListener('pointerdown', (e) => {
    pid = e.pointerId; lastX = e.clientX; lastY = e.clientY;
    stage.setPointerCapture(pid); stage.classList.add('dragging');
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (pid === null || e.pointerId !== pid || !cropState) return;
    cropState.ox += e.clientX - lastX; cropState.oy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clampCrop(); drawCrop();
  });
  const endDrag = () => {
    if (pid === null) return;
    try { stage.releasePointerCapture(pid); } catch (_) { /* already released */ }
    pid = null; stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', (e) => {
    if (!cropState) return;
    e.preventDefault(); // the panel behind must not scroll while zooming
    const r = stage.getBoundingClientRect();
    setCropScale(cropState.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // Listeners live on nodes inside #modalMount, which is emptied on close —
  // nothing to unbind by hand.
}
/** Renders the visible frame at AVATAR_PX and stores just that square. */
window.applyAvatarCrop = async () => {
  if (!cropState) { closeModal(); return; }
  const k = AVATAR_PX / CROP_FRAME; // frame px → stored px
  const c = document.createElement('canvas');
  c.width = c.height = AVATAR_PX;
  const ctx = c.getContext('2d');
  ctx.drawImage(cropState.src, cropState.ox * k, cropState.oy * k,
    cropState.iw * cropState.scale * k, cropState.ih * cropState.scale * k);
  const dataUrl = c.toDataURL('image/jpeg', 0.85);
  cropState = null;
  closeModal();
  if (await persistAvatar(dataUrl)) toast('Picture updated');
};
window.clearAvatar = async () => {
  if (await persistAvatar(null)) toast('Picture removed');
};
/** Repaints every place the avatar appears, so none of them can go stale. */
function refreshAvatars() {
  paintAvatar($('avatar'), user);   // sidebar profile card
  paintAvatar($('pmAvatar'), user); // preview inside the settings panel
  const clear = $('pmAvatarClear'); if (clear) clear.hidden = !user.avatarUrl;
  renderBottomNav();                // mobile More sheet shows the same avatar
}
/** The picture is its own commit — Change and Remove persist straight away,
 *  independent of the panel's "Save changes" (which owns the display name).
 *  Painted optimistically and rolled back if the request fails. */
async function persistAvatar(nextUrl) {
  const prev = user.avatarUrl ?? null;
  user.avatarUrl = nextUrl;
  refreshAvatars();
  try {
    const saved = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ avatarUrl: nextUrl }) });
    user.avatarUrl = saved.avatarUrl ?? null;
    sessionStorage.setItem('user', JSON.stringify(user));
    refreshAvatars();
    return true;
  } catch (e) {
    user.avatarUrl = prev;
    refreshAvatars();
    toast(e.message);
    return false;
  }
}
/** Persists name + picture together, then repaints the sidebar card. */
window.saveProfile = async () => {
  const el = $('pmName'), err = $('pmNameErr');
  const name = (el ? el.value : '').trim();
  if (!name) {
    if (err) { err.textContent = 'Display name cannot be empty'; err.hidden = false; }
    if (el) el.focus();
    return;
  }
  if (err) err.hidden = true;
  try {
    const saved = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ name, avatarUrl: user.avatarUrl ?? null }) });
    user.name = saved.name;
    user.avatarUrl = saved.avatarUrl;
    sessionStorage.setItem('user', JSON.stringify(user));
    paintAvatar($('avatar'), user);
    $('userName').textContent = user.name;
    renderBottomNav(); // the mobile More sheet shows the same name/avatar
    closeProfileMenu();
    toast('Profile updated');
  } catch (e) { toast(e.message); }
};
/**
 * Switch the duration display unit. Saved against the account (so it follows
 * the person between devices) and applied immediately without a reload.
 *
 * The active pill is painted before the request rather than after: this is a
 * display preference with no failure mode worth making the user wait on, and a
 * toggle that visibly lags its own click feels broken. If the save does fail,
 * the pill and the local copy are put back so what's on screen never claims a
 * preference the server didn't accept.
 */
window.setDisplayUnit = async (unit) => {
  if (unit !== 'HOURS' && unit !== 'DAYS') return;
  const previous = unitPref();
  if (unit === previous) return;
  const paint = (u) => {
    const box = $('pmUnit');
    if (box) box.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.unit === u));
  };
  user.displayUnit = unit;
  sessionStorage.setItem('user', JSON.stringify(user));
  paint(unit);
  repaintForUnitChange();
  try {
    const saved = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ displayUnit: unit }) });
    // Trust the server's echo over the optimistic value.
    user.displayUnit = saved.displayUnit || unit;
    sessionStorage.setItem('user', JSON.stringify(user));
    toast(unit === 'DAYS' ? `Showing days (${DAY_HOURS}h = 1 day)` : 'Showing hours');
  } catch (e) {
    user.displayUnit = previous;
    sessionStorage.setItem('user', JSON.stringify(user));
    paint(previous);
    repaintForUnitChange();
    toast(e.message);
  }
};
/**
 * Re-render whatever screen is open so every duration on it picks up the new
 * unit. Durations are formatted during render, so there is nothing to patch in
 * place — re-running the active view is both simpler and guaranteed complete,
 * where hunting for individual spans would miss the SVG charts entirely.
 *
 * Routes through go() rather than keeping a second copy of the view table, so
 * a screen added later can't be silently left out of this. The profile menu
 * lives in the rail, outside #view, so it survives the re-render and stays
 * open under the user's cursor.
 */
function repaintForUnitChange() {
  if (activeNav) go(activeNav);
}
// Deliberately NOT wired to /auth/change-password yet — front-end placeholder
// only, per spec. The real endpoint exists and works (the forced first-login
// screen uses it), so finishing this is a small follow-up, not new plumbing.
window.togglePasswordFields = () => {
  const f = $('pmPwFields'), t = $('pmPwToggle');
  if (!f || !t) return;
  const opening = f.hidden;
  f.hidden = !opening;
  t.setAttribute('aria-expanded', String(opening));
  if (opening) { const first = $('pmPwCurrent'); if (first) first.focus(); }
};
window.changePasswordPlaceholder = () => {
  toast('Changing your password from here is coming soon');
};
window.logOut = () => { sessionStorage.clear(); location.replace('login.html'); };

// The context panel's section heading mirrors the active rail icon.
function navLabelFor(k) { const it = navItemsForRole().find((i) => i.key === k); return it ? it.label : ''; }

// ---- mobile bottom nav (4 primary + More) ---------------------------------
// Mirrors the rail: the first 4 sections become bottom-bar buttons, the rest
// go into a "More" bottom sheet (with profile + logout). data-nav wires clicks
// through go(); setActiveNav toggles .active on every [data-nav] for free, and
// syncMoreActive() lights the More button when the active section is overflow.
let overflowNavKeys = new Set();
function renderBottomNav() {
  const items = navItemsForRole();
  const primary = items.slice(0, 4);
  const overflow = items.slice(4);
  overflowNavKeys = new Set(overflow.map((it) => it.key));

  const moreDots = '<svg class="icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
  const logoutSvg = '<svg class="icon" viewBox="0 0 24 24"><path d="M16 17l5-5-5-5M21 12H9M9 3H4v18h5"/></svg>';

  $('bottomNav').innerHTML =
    primary.map((it) => `<button class="bn-item${activeNav === it.key ? ' active' : ''}" data-nav="${it.key}" aria-label="${esc(it.label)}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('')
    + (overflow.length ? `<button class="bn-item${overflowNavKeys.has(activeNav) ? ' active' : ''}" id="moreBtn" aria-label="More">${moreDots}<span>More</span></button>` : '');
  $('bottomNav').querySelectorAll('.bn-item[data-nav]').forEach((el) => { el.onclick = () => go(el.dataset.nav); });

  $('moreSheet').innerHTML =
    '<div class="more-grabber"></div>'
    + `<div class="more-user"><div class="avatar${user.avatarUrl ? ' has-img' : ''}"${user.avatarUrl ? ` style="background-image:url('${esc(user.avatarUrl)}')"` : ''}>${user.avatarUrl ? '' : esc(initials(user.name))}</div><div><div class="name">${esc(user.name)}</div><div class="role">${esc(user.role.replace('_', ' ').toLowerCase())}</div></div></div>`
    + (overflow.length ? '<div class="more-sep"></div>' : '')
    + overflow.map((it) => `<button class="more-item${activeNav === it.key ? ' active' : ''}" data-nav="${it.key}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('')
    + '<div class="more-sep"></div>'
    + `<button class="more-item" id="moreLogout">${logoutSvg}<span>Log out</span></button>`;
  $('moreSheet').querySelectorAll('.more-item[data-nav]').forEach((el) => { el.onclick = () => { closeMore(); go(el.dataset.nav); }; });
  // The sidebar (and with it the profile panel) is hidden on mobile, so the More
  // sheet stays the logout path there. Same action, one shared function.
  $('moreLogout').onclick = () => logOut();

  const moreBtn = $('moreBtn');
  if (moreBtn) moreBtn.onclick = toggleMore;
  $('moreScrim').onclick = closeMore;
}
function openMore() { document.body.classList.add('more-open'); $('moreScrim').hidden = false; }
function closeMore() { document.body.classList.remove('more-open'); $('moreScrim').hidden = true; }
function toggleMore() { document.body.classList.contains('more-open') ? closeMore() : openMore(); }
function syncMoreActive() { const b = $('moreBtn'); if (b) b.classList.toggle('active', overflowNavKeys.has(activeNav)); }

// ---- per-tab sidebar context ----------------------------------------------
// Register a tab id → a render function for its contextual panel content (built
// below the persistent profile card). Tabs with no entry render nothing. Adding
// a new tab's panel later is purely additive — register a key here, nothing else.
// The Timesheet ('table') is intentionally absent: its Reviewing/Project controls
// live in an in-content toolbar (renderTable), not the kebab menu.
const sidebarContextByTab = {
  subtasks: renderSubtasksContext,
  people: renderPeopleContext,
  approvals: renderApprovalsContext,
  dashboard: renderDashboardContext,
  clients: renderClientsContext,
};
let currentSidebarTab; // avoids needless re-render (which would reset live inputs)
// Renders the active tab's controls into the persistent kebab-menu container
// (#sidebarContext). The kebab button in the header opens/closes the menu.
function updateSidebarContext(k) {
  const el = $('sidebarContext'); if (!el) return;
  if (currentSidebarTab === k) return;
  currentSidebarTab = k;
  closeCtxMenu(); // switching pages dismisses any open menu
  const render = sidebarContextByTab[k];
  el.style.display = '';
  el.innerHTML = '';
  if (render) render(el);
}

// People context: switch the main table between Team members and Team leads.
// Only the selected group renders on the page (they used to stack).
function renderPeopleContext(el) {
  const opts = [['members', 'Team members', 'users'], ['leads', 'Team leads', 'shield']];
  el.innerHTML = `<div class="panel-title">People</div><div class="side-section"><ul class="project-list">`
    + opts.map(([k, label, ic]) => `<li class="side-opt${peopleFilter === k ? ' is-active' : ''}" onclick="setPeopleFilter('${k}')">${icon(ic)}<span>${label}</span></li>`).join('')
    + `</ul></div>`;
}
window.setPeopleFilter = (v) => {
  peopleFilter = v;
  // Re-render the panel in place so the active pill updates (updateSidebarContext
  // deliberately skips a re-render when the tab itself hasn't changed).
  const el = $('sidebarContext'); if (el) renderPeopleContext(el);
  renderPeople();
};

// Dashboard components per role. Static (depends only on role, not fetched
// data), so the sidebar can render immediately. Chart and table views of the
// same data are separate entries, disambiguated by name — no two share a label.
// Persistent sticky summary strip per role. This key is pulled out of the
// picker and rendered as an always-on header above the switchable components.
// Only roles with an existing "at a glance" stat strip are listed.
const DASH_HERO = { CEO: 'overview', PM: 'status-overview' };
function dashComponentsFor(role) {
  const M = {
    PM: [
      ['status-breakdown', 'Task status — Breakdown', 'chart'],
      ['plan-actual', 'Planned vs actual hours', 'chart'],
      ['burndown', 'Burn-down', 'list'],
    ],
    CEO: [
      ['alloc-chart', 'Resource allocation — Chart', 'chart'],
      ['alloc-table', 'Resource allocation — Table', 'list'],
      ['headcount', 'Headcount by role', 'users'],
    ],
    // Team aggregate views are offered to both team-facing roles. For the Lead
    // they sit alongside (never replace) the existing per-member breakdown.
    TEAM_LEAD: [
      ['split-chart', 'Team time by task — Chart', 'chart'],
      ['split-table', 'Team hours by task — Table', 'list'],
      ['members', 'Hours per team member', 'users'],
      ['team-hours', 'Team hours', 'chart'],
    ],
    // A Team Member's Dashboard is the team view only — their own hours live on
    // the Summary page, so per-person cards here would just duplicate it.
    TEAM_MEMBER: [
      ['team-hours', 'Team hours', 'chart'],
    ],
  };
  const comps = M[role] || M.TEAM_MEMBER; // the render fallback branch is the member view
  // Deep search is offered on every Dashboard; it filters data the role can
  // already see (scoping is enforced server-side).
  return comps.concat([['deep-search', 'Deep search', 'search']]);
}
function renderDashboardContext(el) {
  const comps = dashComponentsFor(user.role);
  if (!comps.some((c) => c[0] === dashSection)) dashSection = comps[0][0];
  el.innerHTML = `<div class="panel-title">Dashboard</div><div class="side-section"><ul class="project-list">`
    + comps.map(([k, label, ic]) => `<li class="side-opt${dashSection === k ? ' is-active' : ''}" data-opt="${k}" onclick="setDashSection('${k}')">${icon(ic)}<span>${label}</span></li>`).join('')
    + `</ul></div>`;
}
/**
 * Both date inputs are ALWAYS in the markup — never conditionally added —
 * and just toggle a hidden state. `.page-title-row` right-aligns this whole
 * control with justify-content:space-between, so its right edge is pinned to
 * the card edge; if the two inputs were only inserted once "Custom range" is
 * picked, the control's own width would grow and, with its right edge fixed,
 * that growth comes entirely out of its LEFT edge — which is exactly what
 * shifts the select itself sideways. Reserving the width up front instead
 * means switching to Custom range never changes this control's total size,
 * so nothing before or inside it can move; visibility:hidden (not display:
 * none) is what keeps the reserved space while also dropping the inputs out
 * of tab order without extra ARIA bookkeeping.
 */
function rangeControlHtml(value, onSelect, custom, onCustom) {
  const hidden = value === 'custom' ? '' : ' tr-date-hidden';
  return `<div class="row-flex"><select class="tr-sel" onchange="${onSelect}(this.value)">${ACTIVITY_RANGES.map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` +
    `<input type="date" class="tr-date${hidden}" value="${esc(custom.start)}" onchange="${onCustom}('start',this.value)">` +
    `<input type="date" class="tr-date${hidden}" value="${esc(custom.end)}" onchange="${onCustom}('end',this.value)"></div>`;
}
// Range picker for the team aggregate cards — same vocabulary as Summary's, so
// the two read identically for a given selection.
function teamRangeControl() {
  return rangeControlHtml(teamRange, 'setTeamRange', teamCustom, 'setTeamCustom');
}
window.setTeamRange = (r) => { teamRange = r; renderDashboard(); };
window.setTeamCustom = (k, v) => { teamCustom = { ...teamCustom, [k]: v }; renderDashboard(); };
// Range picker for the Team Lead's own hour-distribution cards (chart / table /
// members) — same widget, separate state, since these show different data than
// the team-aggregate cards above.
function leadRangeControl() {
  return rangeControlHtml(leadRange, 'setLeadRange', leadCustom, 'setLeadCustom');
}
window.setLeadRange = (r) => { leadRange = r; renderDashboard(); };
window.setLeadCustom = (k, v) => { leadCustom = { ...leadCustom, [k]: v }; renderDashboard(); };
window.setDashSection = (k) => {
  dashSection = k;
  document.querySelectorAll('#sidebarContext .side-opt').forEach((li) => li.classList.toggle('is-active', li.dataset.opt === k));
  renderDashboard();
};

// Clients context: list vs. the add-client form. Only CEO gets the form, so for
// a role with a single section, no picker is rendered at all.
function clientsSectionsFor() {
  const opts = [['list', 'Clients', 'building']];
  if (user.role === 'CEO') opts.push(['add', 'Add client', 'plus']);
  return opts;
}
function renderClientsContext(el) {
  const opts = clientsSectionsFor();
  if (opts.length < 2) { el.style.display = 'none'; el.innerHTML = ''; return; } // nothing to switch between
  if (!opts.some((o) => o[0] === clientsSection)) clientsSection = opts[0][0];
  el.style.display = '';
  el.innerHTML = `<div class="panel-title">Clients</div><div class="side-section"><ul class="project-list">`
    + opts.map(([k, label, ic]) => `<li class="side-opt${clientsSection === k ? ' is-active' : ''}" data-opt="${k}" onclick="setClientsSection('${k}')">${icon(ic)}<span>${label}</span></li>`).join('')
    + `</ul></div>`;
}
window.setClientsSection = (k) => {
  clientsSection = k;
  document.querySelectorAll('#sidebarContext .side-opt').forEach((li) => li.classList.toggle('is-active', li.dataset.opt === k));
  renderClients();
};

// Approvals context: switch between the pending-timesheets and edit-requests
// queues, with live counts. Only the selected queue renders on the page.
const APPROVAL_ROLES = [['', 'All'], ['CEO', 'CEO'], ['PM', 'PM'], ['TEAM_LEAD', 'Team Lead'], ['TEAM_MEMBER', 'Team Member']];
function renderApprovalsContext(el) {
  const c = window._apCounts || {};
  const opts = [['pending', 'Timesheets', 'check', c.pending], ['edits', 'Edit requests', 'pencil', c.edits]];
  // Employee-type moved onto the page itself as a horizontal segmented bar
  // (see renderApprovals) — it filters what's on screen, so it sits with
  // that content instead of in the sidebar alongside the queue switcher.
  el.innerHTML = `<div class="panel-title">Approvals</div><div class="side-section"><ul class="project-list">`
    + opts.map(([k, label, ic, n]) => `<li class="side-opt${approvalsTab === k ? ' is-active' : ''}" onclick="setApprovalsTab('${k}')">${icon(ic)}<span>${label}</span>${n == null ? '' : `<span class="side-count">${n}</span>`}</li>`).join('')
    + `</ul></div>`;
}
window.setApprovalsTab = (t) => {
  approvalsTab = t;
  const el = $('sidebarContext'); if (el) renderApprovalsContext(el);
  renderApprovals();
};
window.setApprovalsRole = (r) => {
  // The role bar lives on the page now (renderApprovals), not the sidebar —
  // renderApprovals() alone regenerates it, no sidebar re-render needed.
  approvalsRole = r;
  renderApprovals();
};

// Subtasks context: a quick Team Leads lookup (PM view — same audience as the
// Subtasks screen). Clicking a lead pops up the projects they currently lead.
function renderSubtasksContext(el) {
  const opts = [['create', 'Create task', 'plus'], ['leads', 'Assign project', 'users'], ['all', 'All tasks', 'list']];
  el.innerHTML = `<div class="panel-title">Tasks</div><div class="side-section"><ul class="project-list">`
    + opts.map(([k, label, ic]) => `<li class="side-opt${subtasksSection === k ? ' is-active' : ''}" data-opt="${k}" onclick="setSubtasksSection('${k}')">${icon(ic)}<span>${label}</span></li>`).join('')
    + `</ul></div>`
    + `<div class="side-section"><div class="side-label">Team leads</div><ul class="project-list" id="sidebarLeadList"><li class="muted"><i>Loading…</i></li></ul></div>`;
  loadSidebarLeads();
}
window.setSubtasksSection = (k) => {
  subtasksSection = k;
  // Toggle the active pill in place rather than re-rendering the whole panel —
  // that would needlessly re-fetch the Team Leads lookup below it.
  document.querySelectorAll('#sidebarContext .side-opt').forEach((li) => li.classList.toggle('is-active', li.dataset.opt === k));
  renderSubtasks();
};
async function loadSidebarLeads() {
  const ul = $('sidebarLeadList'); if (!ul) return;
  try {
    const leads = await api('/users?role=TEAM_LEAD'); // excludes deactivated/deleted per backend
    window._sidebarLeads = leads;
    ul.innerHTML = leads.map((l) => `<li class="lead-item" onclick="openLeadProjects('${l.id}')"><span class="mini-avatar">${esc(initials(l.name))}</span><span>${esc(l.name)}</span></li>`).join('') || '<li class="muted"><i>No team leads.</i></li>';
  } catch (e) { ul.innerHTML = `<li class="muted"><i>${esc(e.message)}</i></li>`; }
}
// Read-only lookup: the projects a given lead currently leads. Doesn't touch the
// main Project Leads table; closing the popup leaves the screen exactly as it was.
window.openLeadProjects = async (id) => {
  const lead = (window._sidebarLeads || []).find((l) => l.id === id); if (!lead) return;
  let projects = [];
  try { projects = await api('/projects'); } catch (e) { toast(e.message); return; }
  const led = projects.filter((p) => p.teamLead && p.teamLead.id === id);
  const body = led.length
    ? `<ul class="lead-proj-list">${led.map((p) => `<li>${icon('folder')}<span>${esc(p.name)}</span></li>`).join('')}</ul>`
    : `<p class="muted">Not currently leading any projects.</p>`;
  openModal(`<h3>${esc(lead.name)}</h3><p class="meta">Projects currently led</p>${body}<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`);
};

function setActiveNav(k) { activeNav = k; document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === k)); updateSidebarContext(k); syncMoreActive(); }
function go(k) {
  setActiveNav(k);
  showSkeleton(); // shimmer while the (often async) view fetches; replaced on render
  ({ table: renderTable, calendar: renderCalendar, inbox: renderInbox, projects: renderProjects, clients: renderClients,
     subtasks: renderSubtasks, approvals: renderApprovals, team: renderTeam,
     dashboard: renderDashboard, audit: renderAudit,
     teams: renderTeams, people: renderPeople, admin: renderAdmin, history: renderHistory }[k] || renderTable)();
}

// Kept as the app-wide "projects changed" hook so its several callers stay
// valid. There's no standalone projects list or filter to refresh anymore, so
// it's a no-op.
async function loadProjectsList() {}
async function loadReviewing() {
  const sel = $('reviewing'); if (!sel) return; // only present in the Timesheet view context
  try {
    const people = await api('/users/reviewable');
    sel.innerHTML = '<option value="">Myself</option>' + people.map((p) => `<option value="${p.id}">${esc(p.name)} · ${p.role.replace('_', ' ').toLowerCase()}</option>`).join('');
    // Preserve an active reviewee (e.g. deep-linked from the Inbox) across tab
    // switches even if they aren't in the reviewable shortlist.
    if (reviewingUserId) {
      if (![...sel.options].some((o) => o.value === reviewingUserId)) {
        const opt = document.createElement('option'); opt.value = reviewingUserId; opt.textContent = reviewingUserName || 'Selected user'; sel.appendChild(opt);
      }
      sel.value = reviewingUserId;
    }
    sel.onchange = () => { reviewingUserId = sel.value; reviewingUserName = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ''; renderTable(); };
  } catch (e) {}
}
async function loadSubtaskMap() { subtaskMap = {}; try { (await api('/subtasks')).forEach((s) => { subtaskMap[s.id] = { name: s.name, project: s.project ? s.project.name : '', projectId: s.projectId }; }); } catch (e) {} }
async function loadInboxBadge() { try { const n = await api('/notifications?unread=true'); const el = document.querySelector('[data-nav="inbox"] span'); if (el) el.textContent = n.length ? `Notifications (${n.length})` : 'Notifications'; } catch (e) {} }

// ---- header ---------------------------------------------------------------
function headerHtml(title, right) {
  // Pages that used to have a secondary-panel context now expose those controls
  // via a 3-dots (kebab) menu beside the theme toggle. The Timesheet is the
  // exception — its Reviewing/Project controls live in an in-content toolbar.
  const kebab = hasCtxMenu(activeNav)
    ? `<button class="btn btn-icon" id="ctxMenuBtn" title="Options" aria-label="Options">${icon('kebab')}</button>`
    : '';
  return `<div class="header"><div>
    <div class="breadcrumb">Projects › ${MONTHS[currentWeek.getUTCMonth()]} ${currentWeek.getUTCFullYear()}</div>
    <h1>${esc(title)}</h1></div>
    <div class="header-right">${right || ''}${kebab}</div></div>`;
}
function wireHeader() {
  // No theme toggle here any more — theme switching lives solely in the Profile
  // Settings panel, so there is exactly one place to change it.
  const k = $('ctxMenuBtn');
  if (k) {
    k.onclick = (e) => { e.stopPropagation(); toggleCtxMenu(); };
    // A page re-render (e.g. a kebab filter change) rebuilds this button while
    // the menu stays open — keep the pressed state in sync.
    const m = $('ctxMenu'); if (m && !m.hidden) k.classList.add('active');
  }
}
// ---- kebab context menu ----------------------------------------------------
// Whether the active tab has controls to show in the kebab. Requires both a
// registered renderer AND that it produced content (some render nothing for a
// given role, e.g. Clients with a single section).
function hasCtxMenu(k) {
  if (!sidebarContextByTab[k]) return false;
  const el = document.getElementById('sidebarContext');
  return !!(el && el.children.length);
}
function closeCtxMenu() {
  const m = $('ctxMenu'); if (m) m.hidden = true;
  const b = $('ctxMenuBtn'); if (b) b.classList.remove('active');
}
function toggleCtxMenu() {
  const m = $('ctxMenu'), b = $('ctxMenuBtn'); if (!m || !b) return;
  if (!m.hidden) { closeCtxMenu(); return; }
  m.hidden = false; // show first so offsetWidth is measurable
  const r = b.getBoundingClientRect();
  m.style.top = (r.bottom + 8) + 'px';
  m.style.left = Math.max(12, r.right - m.offsetWidth) + 'px';
  b.classList.add('active');
}
// Dismiss the kebab menu / project popover on any outside click or Escape.
document.addEventListener('click', (e) => {
  const m = $('ctxMenu');
  if (m && !m.hidden && !m.contains(e.target) && !(e.target.closest && e.target.closest('#ctxMenuBtn'))) closeCtxMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
function renderPage(title, bodyHtml, right) {
  const v = view();
  v.classList.remove('is-dash'); // only the Dashboard opts into the fill layout
  v.innerHTML = headerHtml(title, right) + bodyHtml;
  wireHeader();
  // Re-trigger the view entrance animation on every route change.
  v.classList.remove('view-enter'); void v.offsetWidth; v.classList.add('view-enter');
  positionNavPill();
  countUpStats();
}

// ---- motion helpers -------------------------------------------------------
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Retained as a no-op: the icon rail marks the active item with a pressed-in
// "clay" .active style, so there's no sliding pill to position anymore.
function positionNavPill() {}

// Count numeric stat values up from 0 (ease-out cubic). Skips tiles whose value
// contains child markup (e.g. a "(10%)" span) so nothing gets flattened.
function countUpStats() {
  if (reducedMotion()) return;
  view().querySelectorAll('.stat .value').forEach((el) => {
    if (el.children.length) return;
    const m = el.textContent.match(/^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
    if (!m) return;
    const prefix = m[1], numStr = m[2], suffix = m[3];
    const decimals = (numStr.split('.')[1] || '').length;
    const hadCommas = numStr.indexOf(',') >= 0;
    const target = parseFloat(numStr.replace(/,/g, ''));
    if (!isFinite(target) || target === 0) return;
    const fmt = (n) => {
      let s = decimals ? n.toFixed(decimals) : String(Math.round(n));
      if (hadCommas) { const p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
      return prefix + s + suffix;
    };
    const steps = 26; let i = 0;
    const iv = setInterval(() => {
      i++; const t = Math.min(1, i / steps); const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(target * eased);
      if (t >= 1) clearInterval(iv);
    }, 24);
  });
}

// Shimmer placeholders shown while an async view fetches its data.
function showSkeleton() {
  view().innerHTML = `<div class="skeleton-wrap">${[120, 240, 170].map((h) => `<div class="skeleton" style="height:${h}px"></div>`).join('')}</div>`;
}
window.addEventListener('resize', positionNavPill);

// ===========================================================================
// Timesheet view  — unchanged core behaviour
// ===========================================================================
async function renderTable() {
  const viewingSelf = !reviewingUserId;
  let week;
  try { week = await api(`/time-entries/week?weekStart=${iso(currentWeek)}${reviewingUserId ? '&userId=' + reviewingUserId : ''}`); }
  catch (e) {
    // If we lack visibility into the selected person, fall back to our own
    // timesheet rather than erroring (e.g. a deep-link to an out-of-scope user).
    if (reviewingUserId) { reviewingUserId = ''; const sel = $('reviewing'); if (sel) sel.value = ''; toast('You do not have access to that timesheet'); return renderTable(); }
    renderPage('Weekly timesheet', `<p class="danger-text">${esc(e.message)}</p>`); return;
  }

  // Leave has been removed from the timesheet — drop any leave-only entries
  // (no subtask and no project) so they don't render or affect totals.
  const entries = (week.entries || []).filter((e) => e.subtaskId || e.projectId);
  const locked = week.locked; // Submitted or Approved
  const appStatus = week.approval ? week.approval.status : null; // SUBMITTED | APPROVED | REVERTED | null
  const state = appStatus || 'DRAFT';
  const badge = {
    APPROVED: '<span class="badge badge-approved">Approved</span>',
    SUBMITTED: '<span class="badge badge-submitted">Submitted</span>',
    REVERTED: '<span class="badge badge-rejected">Reopened — resubmit</span>',
    DRAFT: '<span class="badge badge-draft">Draft</span>',
  }[state];
  const editable = viewingSelf && !locked; // every role edits their own unlocked week

  // Row key: subtaskId | 'p:'+projectId | 'leave'. rowMeta drives the dialog titles.
  const weekDates = DAY_NAMES.map((_, i) => iso(addDays(currentWeek, i)));
  const byCell = {}, rowMeta = {};
  const keyOf = (e) => e.subtaskId ? e.subtaskId : (e.projectId ? 'p:' + e.projectId : 'leave');
  entries.forEach((e) => { const k = keyOf(e) + '|' + e.date.slice(0, 10); (byCell[k] = byCell[k] || []).push(e); });

  const groups = {}; // projectName -> [{key,name}]
  const pickRowId = {}; // rowKey -> TimesheetRow id (only for user-picked rows)
  const seenRow = new Set(); // rowKey -> already placed (first source wins its group)
  const addRow = (proj, key, name) => {
    // A row appears exactly once. Markers are added first (authoritative project),
    // so a later entry for the same target can't split it into a second group even
    // if the client-side subtaskMap is missing/differs.
    if (seenRow.has(key)) return;
    seenRow.add(key);
    rowMeta[key] = { name, project: proj === 'Leave' ? '' : proj };
    groups[proj] = groups[proj] || [];
    groups[proj].push({ key, name });
  };
  // Own view: rows are added to THIS week only (via the + picker or "Copy from
  // previous week"). A fresh week with no markers and no entries starts empty —
  // rows never carry over automatically.
  if (viewingSelf) {
    let picks = [];
    try { picks = await api(`/timesheet-rows?weekStart=${iso(currentWeek)}`); } catch (e) {}
    picks.forEach((p) => {
      const key = p.subtaskId ? p.subtaskId : 'p:' + p.projectId;
      pickRowId[key] = p.id;
      addRow(p.project, key, p.name);
    });
  }
  // Rows from actual entries (covers reviewer view + any historical/submitted week
  // whose row was since un-picked — data always shows even if the pick is gone).
  entries.forEach((e) => {
    if (e.subtaskId) { const m = subtaskMap[e.subtaskId] || {}; addRow(m.project || (e.subtask && 'Project') || 'Other', e.subtaskId, m.name || (e.subtask && e.subtask.name) || 'Task'); }
    else if (e.projectId) { addRow(e.project ? e.project.name : 'Project', 'p:' + e.projectId, 'General / project time'); }
  });

  // Toolbar row (relocated here from the old secondary panel): the role-gated
  // Reviewing selector. Sits directly below the title/status badge (in the
  // header) and above the week navigator.
  const canReview = ['CEO', 'PM', 'TEAM_LEAD'].includes(user.role);
  let html = '';
  let tb = '';
  if (canReview) tb += `<div class="tb-field"><span class="tb-label">Reviewing:</span><select id="reviewing"><option value="">Myself</option></select></div>`;
  if (tb) html += `<div class="view-toolbar">${tb}</div>`;
  if (viewingSelf && state === 'REVERTED') html += `<div style="margin-bottom:14px"><span class="reopen-banner">Reopened — resubmit</span></div>`;
  html += `<div class="weeknav"><button class="btn btn-icon" onclick="shiftWeek(-1)">${icon('prev')}</button>
    <span class="range">${weekRangeLabel(currentWeek)}</span>
    <button class="btn btn-icon" onclick="shiftWeek(1)">${icon('next')}</button>
    <button class="btn btn-ghost btn-sm" onclick="goToday()">Today</button></div>`;

  // Action bar: submit (own, unlocked) / request edit (own, locked) / inline review (PM).
  let actions = '';
  if (viewingSelf && !locked && Object.keys(rowMeta).length) actions += `<button class="btn btn-primary" onclick="submitWeek()">Submit for review</button>`;
  if (viewingSelf && !locked) actions += `<button class="btn btn-ghost" onclick="saveDraft()">Save draft</button>`;
  if (viewingSelf && !locked) actions += `<button class="btn btn-ghost" onclick="openCopyPrevWeek()">${icon('copy')} Copy from previous week</button>`;
  if (viewingSelf && locked) actions += `<button class="btn btn-primary" onclick="openRequestEditPicker()">Request edit</button>`;
  if (viewingSelf && state === 'REVERTED') actions += ` <span class="muted">This week was reopened — edit and re-submit.</span>`;
  if (reviewingUserId && user.role === 'PM' && appStatus === 'SUBMITTED') actions += `<button class="btn btn-primary" onclick="approveWeek()">Approve</button> <button class="btn btn-ghost" onclick="revertWeek()">Request changes</button>`;
  if (actions) html += `<div class="actions" style="margin-bottom:12px">${actions}</div>`;

  html += '<table class="ts-table"><thead><tr><th class="left">Project / task</th>';
  // Day headers as circular date badges; today's date reads as a filled circle.
  const todayIso = iso(new Date());
  DAY_NAMES.forEach((d, i) => {
    const isToday = weekDates[i] === todayIso;
    html += `<th><span class="day-name">${d}</span><span class="day-badge${isToday ? ' is-today' : ''}">${Number(weekDates[i].slice(8, 10))}</span></th>`;
  });
  html += '<th>Total</th></tr></thead><tbody>';
  const cellHours = (key, date) => (byCell[key + '|' + date] || []).reduce((s, e) => s + Number(e.hours), 0);
  // A day column is coloured as ONE unit, from that day's grand total: over 8h
  // green, exactly 8h default ink, under 8h (including empty) red. Computed
  // before any row renders so project rows, task rows and the grand total row
  // all reference the same figure rather than each cell's own value.
  const dayTotal = {};
  weekDates.forEach((d) => { dayTotal[d] = entries.filter((e) => e.date.slice(0, 10) === d).reduce((s, e) => s + Number(e.hours), 0); });
  const dayCls = (date) => hoursColorClass(dayTotal[date] || 0);
  const cellHasEntry = (key, date) => (byCell[key + '|' + date] || []).length > 0;
  // An explicit 0 ("no work done") reads as a muted 0; a truly empty cell keeps
  // the add affordance so a forgotten day stands out from a deliberate zero.
  const cellDisplay = (key, date, emptyMark) => {
    const v = cellHours(key, date);
    if (!cellHasEntry(key, date)) return emptyMark;
    return v === 0 ? '<span class="cell-zero" title="0 hours logged — no work done">0</span>' : hhmmSpan(v, dayCls(date));
  };
  const renderGroup = (proj, rows) => {
    const c = collapsed.has(proj); let pt = 0, pc = '';
    const pjArg = esc(proj).replace(/'/g, "\\'");
    weekDates.forEach((date) => {
      const sum = rows.reduce((s, r) => s + cellHours(r.key, date), 0); pt += sum;
      // Hover a project-row day cell → per-subtask breakdown for that day. Only
      // days with hours get a tooltip; a zero day shows nothing.
      const hov = sum > 0 ? ` onmousemove="projTip(event,'${pjArg}','${date}')" onmouseleave="cellTipHide()"` : '';
      pc += `<td class="col-total"${hov}>${sum ? hhmmSpan(sum, dayCls(date)) : ''}</td>`;
    });
    html += `<tr class="row-project" onclick="toggleGroup('${esc(proj).replace(/'/g, "\\'")}')"><td class="left">${icon(c ? 'chevronR' : 'chevronD', 'chev')}${projSwatch(proj)}${esc(proj)}</td>${pc}<td class="col-total">${hhmmSpan(pt, '')}</td></tr>`;
    if (c) return;
    rows.forEach((r) => { let rt = 0, cells = '';
      weekDates.forEach((date) => { rt += cellHours(r.key, date);
        // Cells with an entry get a hover tooltip (hours/notes/date/status); the
        // click-to-edit dialog is unchanged. Empty cells have nothing to preview.
        const hov = cellHasEntry(r.key, date) ? ` onmousemove="cellTip(event,'${r.key}','${date}')" onmouseleave="cellTipHide()"` : '';
        if (editable) cells += `<td class="cell-edit" onclick="openCell('${r.key}','${date}')"${hov}>${cellDisplay(r.key, date, '<span class="cell-add">+</span>')}</td>`;
        else cells += `<td><span class="cell-ro" onclick="openCell('${r.key}','${date}')"${hov}>${cellDisplay(r.key, date, '·')}</span></td>`; });
      const isGeneral = r.key.startsWith('p:');
      // A user-picked row (not Leave, not a data-only historical row) is removable.
      const rmv = (editable && pickRowId[r.key]) ? `<span class="row-x" title="Remove from my timesheet" onclick="event.stopPropagation();removeRow('${pickRowId[r.key]}','${esc(r.name).replace(/'/g, "\\'")}',${rt})">${icon('minus')}</span>` : '';
      html += `<tr class="row-subtask"><td class="left task-name${isGeneral ? ' muted' : ''}">${esc(r.name)}${rmv}</td>${cells}<td class="col-total">${hhmmSpan(rt, '')}</td></tr>`; });
  };
  Object.keys(groups).forEach((p) => renderGroup(p, groups[p]));
  // An empty/fresh week has no rows to sum — a "Grand total" row reading 00:00
  // is just noise until there's at least one project/task on the sheet.
  if (Object.keys(groups).length) {
    let grand = 0, gc = '';
    weekDates.forEach((date) => { const dt = dayTotal[date]; grand += dt; gc += `<td>${dt ? hhmmSpan(dt, dayCls(date)) : ''}</td>`; });
    html += `<tr class="row-grand"><td class="left">Grand total</td>${gc}<td class="col-total">${hhmmSpan(grand, '')}</td></tr>`;
  }
  html += '</tbody></table>';
  // + picker: add a subtask / project row to your persistent timesheet.
  // "Request task" is the Team Member path to a task that doesn't exist yet:
  // it proposes one to the project's lead rather than creating it. Leads and PMs
  // create tasks directly, so it would only be noise for them.
  if (editable) {
    const requestBtn = user.role === 'TEAM_MEMBER'
      ? ` <button class="btn btn-ghost" onclick="openTaskRequest()">${icon('inbox')} Request task</button>`
      : '';
    html += `<div class="actions" style="margin-top:12px"><button class="btn btn-ghost" onclick="openRowPicker()">${icon('plus')} Add project / task</button>${requestBtn}</div>`;
  }
  renderPage('Weekly timesheet', html, badge);
  if (canReview) loadReviewing();
  window._week = { byCell, locked, viewingSelf, rowMeta, state, pickRowId, groups, dates: weekDates, datesWithEntries: new Set(entries.map((e) => e.date.slice(0, 10))) };
}
window.shiftWeek = (n) => { currentWeek = addDays(currentWeek, n * 7); renderTable(); };
window.goToday = () => { currentWeek = mondayOf(new Date()); renderTable(); };
window.toggleGroup = (p) => { collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p); renderTable(); };

// ---- picked-row management (persistent across weeks) ----------------------
// The + picker: every visible Project → (General + assigned subtasks), minus
// what's already on the table. Built from the already-loaded /projects + subtaskMap
// (same RBAC scoping); the backend re-validates each pick on add.
window.openRowPicker = async () => {
  let projects = [];
  try { projects = await api('/projects'); } catch (e) { toast(e.message); return; }
  const picked = window._week ? window._week.pickRowId : {};
  const isMemberish = ['TEAM_MEMBER', 'TEAM_LEAD'].includes(user.role);
  let body = '';
  projects.forEach((p) => {
    const subs = Object.entries(subtaskMap).filter(([, m]) => m.projectId === p.id);
    // Options: each visible subtask, minus what's already picked. Project-level
    // "General / project time" rows were removed — every row now names a task.
    const opts = [];
    subs.forEach(([sid, m]) => { if (!picked[sid]) opts.push(`<label class="pick-opt"><input type="checkbox" data-pick="subtask" data-id="${sid}"> ${esc(m.name)}</label>`); });
    // Team members/leads only pick subtasks they're assigned to; if a project has
    // no visible subtasks left to pick, skip it entirely.
    if (!opts.length) return;
    body += `<div class="pick-group"><div class="pick-proj">${esc(p.name)}</div>${opts.join('')}</div>`;
  });
  if (!body) body = `<p class="meta">Nothing left to add — every visible project and task is already on your timesheet.${isMemberish ? ' Assigned tasks appear here once your Team Lead assigns them.' : ''}</p>`;
  openModal(`<h3>Add to my timesheet</h3><p class="meta">Pick the projects and tasks to show as rows. They stay on your timesheet across weeks until you remove them.</p><div class="pick-list">${body}</div><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="addPickedRows()">Add selected</button></div>`);
};
window.addPickedRows = async () => {
  const picks = [];
  document.querySelectorAll('#modalMount [data-pick]:checked').forEach((el) => {
    picks.push(el.dataset.pick === 'subtask' ? { subtaskId: el.dataset.id } : { projectId: el.dataset.id });
  });
  if (!picks.length) { closeModal(); return; }
  try { await api('/timesheet-rows', { method: 'POST', body: JSON.stringify({ picks, weekStart: iso(currentWeek) }) }); closeModal(); toast(`Added ${picks.length} row${picks.length > 1 ? 's' : ''} to this week`); await renderTable(); }
  catch (e) { toast(e.message); }
};
// ---- Request a new task (Team Member → project's Team Lead) ----------------
// Proposes a task; nothing is created until the project's current lead approves.
// The project list is whatever /projects returns for this member, so the form
// can only ever offer projects they already have visibility into.
window.openTaskRequest = async () => {
  let projects = [];
  try { projects = await api('/projects'); } catch (e) { toast(e.message); return; }
  if (!projects.length) {
    openModal(`<h3>Request a task</h3><p class="meta">You have no projects yet — you'll be able to request tasks once you're assigned to one.</p><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`);
    return;
  }
  openModal(`<h3>Request a task</h3>
    <p class="meta">Sent to the project's Team Lead for approval. Nothing is created until they approve it.</p>
    <div class="field"><label>Project</label><select id="trProject">${projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Task name</label><input id="trName" placeholder="e.g. Payment retry handling" maxlength="200"></div>
    <div class="field"><label>Estimated hours <span class="muted">(optional)</span></label><input id="trHours" type="number" min="0" step="0.25" placeholder="e.g. 12"></div>
    <div class="field"><label>Reason</label><textarea id="trReason" rows="3" placeholder="Why is this task needed?" maxlength="2000"></textarea></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="submitTaskRequest()">Send request</button></div>`);
};
window.submitTaskRequest = async () => {
  const name = ($('trName').value || '').trim();
  const reason = ($('trReason').value || '').trim();
  if (!name) { toast('Task name is required'); return; }
  if (!reason) { toast('Please say why this task is needed'); return; }
  const rawHours = ($('trHours').value || '').trim();
  const body = { projectId: $('trProject').value, proposedName: name, reason };
  if (rawHours !== '') body.proposedEstimatedHours = Number(rawHours);
  try {
    await api('/task-requests', { method: 'POST', body: JSON.stringify(body) });
    closeModal();
    toast('Request sent to the Team Lead');
    loadInboxBadge();
  } catch (e) { toast(e.message); }
};
// Edit + resubmit after a lead asked for changes — reuses the same request row,
// so the member never has to retype it from scratch.
window.openTaskRequestEdit = async (id) => {
  let r;
  try { r = await api('/task-requests/' + id); } catch (e) { toast(e.message); return; }
  openModal(`<h3>Edit &amp; resubmit</h3>
    <p class="meta">${esc(r.project.name)}</p>
    ${r.reviewNote ? `<p class="meta"><b>Lead asked for:</b> ${esc(r.reviewNote)}</p>` : ''}
    <div class="field"><label>Task name</label><input id="trName" value="${esc(r.proposedName)}" maxlength="200"></div>
    <div class="field"><label>Estimated hours <span class="muted">(optional)</span></label><input id="trHours" type="number" min="0" step="0.25" value="${r.proposedEstimatedHours ?? ''}"></div>
    <div class="field"><label>Reason</label><textarea id="trReason" rows="3" maxlength="2000">${esc(r.reason)}</textarea></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="resubmitTaskRequest('${id}')">Resubmit</button></div>`);
};
window.resubmitTaskRequest = async (id) => {
  const name = ($('trName').value || '').trim();
  const reason = ($('trReason').value || '').trim();
  if (!name) { toast('Task name is required'); return; }
  if (!reason) { toast('Please say why this task is needed'); return; }
  const rawHours = ($('trHours').value || '').trim();
  const body = { proposedName: name, reason };
  if (rawHours !== '') body.proposedEstimatedHours = Number(rawHours);
  try {
    await api('/task-requests/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    closeModal();
    toast('Resubmitted for review');
    renderInbox(); loadInboxBadge();
  } catch (e) { toast(e.message); }
};
// ---- Copy from previous week ----------------------------------------------
// Bulk-add last week's rows to the current week. Two modes: the row structure
// only (empty cells), or the structure plus a pre-fill of last week's hours
// (fully editable — nothing is submitted or approved by copying).
window.openCopyPrevWeek = () => {
  const prev = weekRangeLabel(addDays(currentWeek, -7));
  openModal(`<h3>Copy from previous week</h3><p class="meta">Bring the rows you used in the week of <b>${esc(prev)}</b> into this week. Rows don't carry over automatically — this is how you reuse them.</p>
    <div class="pick-list">
      <label class="pick-opt"><input type="radio" name="copyMode" value="tasks" checked> <span><b>Tasks only</b> — add the same rows, all hours start empty.</span></label>
      <label class="pick-opt"><input type="radio" name="copyMode" value="hours"> <span><b>Tasks and hours</b> — also copy last week's hours as an editable starting point.</span></label>
    </div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="copyPrevWeek()">Copy</button></div>`);
};
window.copyPrevWeek = async () => {
  const el = document.querySelector('#modalMount [name="copyMode"]:checked');
  const mode = el ? el.value : 'tasks';
  try {
    const r = await api('/timesheet-rows/copy-previous', { method: 'POST', body: JSON.stringify({ weekStart: iso(currentWeek), mode }) });
    closeModal();
    if (!r.copiedRows) toast('Nothing to copy — last week had no rows');
    else toast(`Copied ${r.copiedRows} row${r.copiedRows === 1 ? '' : 's'}${mode === 'hours' && r.copiedEntries ? ` · ${r.copiedEntries} entr${r.copiedEntries === 1 ? 'y' : 'ies'}` : ''}`);
    await renderTable();
  } catch (e) { toast(e.message); }
};
// Manual removal (unlocked week only — the button is only rendered then). Removes
// the row from THIS week: the marker plus any hours logged against it this week.
// An empty row goes immediately; one with real hours asks first, since this drops
// that week's logged time for the row in one click. Other weeks are untouched.
window.removeRow = async (id, name, hours) => {
  if (Number(hours) > 0 && !confirm(`"${name}" has ${durClock(hours)} logged this week — remove anyway?\n\nThe row and this week's logged time for it are removed. Other weeks aren't affected, and you can re-add it any time.`)) return;
  try { await api('/timesheet-rows/' + id, { method: 'DELETE' }); toast('Row removed'); await renderTable(); }
  catch (e) { toast(e.message); }
};
// Save Draft: entries already persist as you edit, so the save itself is implicit.
// The one real effect is cleanup — any row with no hours logged Mon–Sun is dropped
// from the week (its marker + all-zero entries removed), keeping the draft tidy.
window.saveDraft = async () => {
  try {
    const r = await api('/timesheet-rows/prune-empty', { method: 'POST', body: JSON.stringify({ weekStart: iso(currentWeek) }) });
    await renderTable();
    const w = window._week;
    let total = 0; if (w) Object.values(w.byCell).forEach((list) => list.forEach((e) => { total += Number(e.hours); }));
    const rows = w ? Object.keys(w.rowMeta).filter((k) => k !== 'leave').length : 0;
    const dropped = r.dropped ? ` · ${r.dropped} empty row${r.dropped === 1 ? '' : 's'} dropped` : '';
    toast(`Draft saved ✓ · ${rows} row${rows === 1 ? '' : 's'} · ${durClock(total)} logged${dropped}`);
  } catch (e) { toast(e.message); }
};

// ---- cell hover tooltip ---------------------------------------------------
window.cellTip = (evt, key, date) => {
  const w = window._week; if (!w) return;
  const list = (w.byCell[key + '|' + date]) || []; if (!list.length) return;
  const meta = w.rowMeta[key] || {};
  const hours = list.reduce((s, e) => s + Number(e.hours), 0);
  const notes = list.map((e) => e.notes).filter(Boolean).join('; ');
  const statusLabel = { APPROVED: 'Approved', SUBMITTED: 'Submitted', REVERTED: 'Reopened', DRAFT: 'Draft' }[w.state] || 'Draft';
  // Match the table hierarchy: Project is the bold title, subtask the sub-line.
  const title = meta.project || meta.name || 'Entry';
  let h = `<div class="ct-name">${esc(title)}</div>`;
  if (meta.project && meta.name) h += `<div class="ct-sub">${esc(meta.name)}</div>`;
  h += `<div class="ct-line"><b>${durClock(hours)}</b> · ${esc(date)}</div>`;
  h += `<div class="ct-line">Status: ${esc(statusLabel)}</div>`;
  if (notes) h += `<div class="ct-notes">${esc(notes)}</div>`;
  let t = document.getElementById('cellTip');
  if (!t) { t = document.createElement('div'); t.id = 'cellTip'; t.className = 'chart-tip hover-tip'; document.body.appendChild(t); }
  t.innerHTML = h; t.style.display = 'block';
  t.style.left = (evt.clientX + 14) + 'px'; t.style.top = (evt.clientY + 16) + 'px';
};
window.cellTipHide = () => { const t = document.getElementById('cellTip'); if (t) t.style.display = 'none'; };
// Project-row tooltip: a per-subtask breakdown of the hours logged on that day.
// Only subtasks with non-zero hours are listed; each shows name, hours and notes
// (notes omitted if none). A day with no hours renders a minimal empty state.
window.projTip = (evt, proj, date) => {
  const w = window._week; if (!w) return;
  const rows = (w.groups && w.groups[proj]) || [];
  let h = `<div class="ct-name">${esc(proj)}</div>`;
  let any = false;
  rows.forEach((r) => {
    const list = w.byCell[r.key + '|' + date] || [];
    const hrs = list.reduce((s, e) => s + Number(e.hours), 0);
    if (!hrs) return;
    any = true;
    const notes = list.map((e) => e.notes).filter(Boolean).join('; ');
    h += `<div class="ct-block"><div class="ct-sub"><b>${durClock(hrs)}</b> · ${esc(r.name)}</div>`;
    if (notes) h += `<div class="ct-notes">${esc(notes)}</div>`;
    h += `</div>`;
  });
  if (!any) h += `<div class="ct-line muted">No hours logged</div>`;
  let t = document.getElementById('cellTip');
  if (!t) { t = document.createElement('div'); t.id = 'cellTip'; t.className = 'chart-tip hover-tip'; document.body.appendChild(t); }
  t.innerHTML = h; t.style.display = 'block';
  t.style.left = (evt.clientX + 14) + 'px'; t.style.top = (evt.clientY + 16) + 'px';
};

window.openCell = (rowKey, date) => {
  const w = window._week; const list = (w.byCell[rowKey + '|' + date]) || []; const entry = list[0];
  // The save handlers only receive an entry id, so stash the cell's coordinates
  // for the cap check.
  window._cellCtx = { rowKey, date };
  const meta = w.rowMeta[rowKey] || {};
  const canEdit = w.viewingSelf; // own timesheet
  let b = `<h3>${esc(meta.name || 'Entry')}</h3><p class="meta">${esc(meta.project ? meta.project + ' · ' : '')}${date}</p>`;
  // Lock state is decided when the dialog OPENS — a locked week never renders the
  // editable form (so there's no path that errors out on save).
  if (w.locked) {
    if (entry) {
      // Read-only; owner may request an edit (proposed hours + reason).
      b += `<div class="field"><label>Duration</label><div>${durClock(entry.hours)} <span class="badge badge-approved">${entry.status.toLowerCase()}</span></div></div><div class="field"><label>Notes</label><div>${esc(entry.notes) || '—'}</div></div>`;
      if (canEdit) b += `<div class="field"><label>Proposed duration <span class="muted">(00:00–${hoursToHHMM(MAX_HOURS)})</span></label><input id="mHours" type="text" inputmode="numeric" placeholder="8:30 or 830" maxlength="5" value="${hoursToHHMM(entry.hours)}" onblur="normalizeHoursField(this)" onkeydown="hoursFieldKey(event,this,()=>requestEdit('${entry.id}'))"><div class="field-error" id="mHoursErr" hidden></div></div><div class="field"><label>Reason</label><input id="mReason" placeholder="Why change this?" onkeydown="submitFieldKey(event,()=>requestEdit('${entry.id}'))"></div><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="requestEdit('${entry.id}')">Request edit</button></div>`;
      else b += `<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`;
    } else {
      // Locked week, empty cell — nothing to add or amend here.
      b += `<p class="meta">This week is locked. There's no entry on this day to amend.</p><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`;
    }
  } else if (canEdit) {
    // Stays hoursToHHMM, NOT durClock: this feeds the input's `value`, and the
    // field only ever accepts HH:MM. Rendering "1.06d" into a box that parses
    // "8:30" would make the user's own saved entry unreadable back to them and
    // un-resubmittable without retyping. The Days preference governs how a
    // duration is shown, never how one is typed.
    const hrs = entry ? hoursToHHMM(entry.hours) : '', notes = entry ? (entry.notes || '') : '';
    // Same action Save triggers, referenced by both fields below (Enter in
    // Duration, Ctrl/Cmd+Enter in Notes) so all three paths stay in lockstep.
    const submitCall = entry ? `saveEntry('${entry.id}')` : `createEntry('${rowKey}','${date}')`;
    b += `<div class="field"><label>Duration <span class="muted">(00:00–${hoursToHHMM(MAX_HOURS)})</span></label><input id="mHours" type="text" inputmode="numeric" placeholder="8:30 or 830" maxlength="5" value="${hrs}" autofocus onblur="normalizeHoursField(this)" onkeydown="hoursFieldKey(event,this,()=>${submitCall})"><div class="field-error" id="mHoursErr" hidden></div></div>`;
    b += `<div class="field"><label>Notes</label><textarea id="mNotes" rows="3" placeholder="Optional details" onkeydown="notesFieldKey(event,()=>${submitCall})">${esc(notes)}</textarea></div><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button>`;
    b += entry ? `<button class="btn btn-ghost" onclick="deleteEntry('${entry.id}')">Delete</button><button class="btn btn-primary" onclick="saveEntry('${entry.id}')">Save</button>` : `<button class="btn btn-primary" onclick="createEntry('${rowKey}','${date}')">Save</button>`;
    b += `</div>`;
  } else {
    b += entry ? `<div class="field"><label>Duration</label><div>${durClock(entry.hours)} · ${entry.status.toLowerCase()}</div></div><div class="field"><label>Notes</label><div>${esc(entry.notes) || '—'}</div></div>` : `<p class="meta">No entry.</p>`;
    b += `<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`;
  }
  openModal(b);
};
// Top-level "Request edit" (locked week): pick a date + row, then reuse the
// per-cell request-edit dialog — no duplicated EditRequest logic.
window.openRequestEditPicker = () => {
  const w = window._week; if (!w) return;
  const rows = [];
  Object.entries(w.byCell).forEach(([k, list]) => {
    const i = k.lastIndexOf('|'); const rowKey = k.slice(0, i), date = k.slice(i + 1);
    const meta = w.rowMeta[rowKey] || {};
    const hrs = list.reduce((s, e) => s + Number(e.hours), 0);
    rows.push({ rowKey, date, name: meta.name || rowKey, project: meta.project || '', hrs });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  if (!rows.length) { toast('No entries to amend this week'); return; }
  const body = rows.map((r) => `<tr style="cursor:pointer" onclick="pickRequestEdit('${r.rowKey}','${r.date}')"><td>${r.date}</td><td>${esc(r.name)}${r.project ? ' <span class="muted">· ' + esc(r.project) + '</span>' : ''}</td><td class="num">${durClock(r.hrs)}</td></tr>`).join('');
  openModal(`<h3>Request edit</h3><p class="meta">Pick the entry you want to amend.</p><table class="data-table"><thead><tr><th>Date</th><th>Row</th><th class="num">Duration</th></tr></thead><tbody>${body}</tbody></table><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
};
window.pickRequestEdit = (rowKey, date) => { closeModal(); openCell(rowKey, date); };
async function refresh() { await Promise.all([renderTable(), loadInboxBadge()]); }
// Reads + validates the Duration field (HH:MM), surfacing an inline message
// under the input. Returns decimal hours (what the API expects — unchanged on
// the backend) or null when invalid, so the caller aborts the save. The server
// enforces the same 0–MAX_HOURS bound independently.
function readHoursInput() {
  const el = $('mHours'), err = $('mHoursErr');
  const raw = el ? String(el.value).trim() : '';
  const fail = (msg) => {
    if (err) { err.textContent = msg; err.hidden = false; } else { toast(msg); }
    if (el) el.focus();
    return null;
  };
  // Two separate steps, in this order: understand what was typed, THEN check it
  // against the allowed range. A typo and an out-of-range duration are different
  // mistakes and get different messages.
  const r = parseDuration(raw);
  if (r.error) return fail(r.error);
  if (r.hours < 0 || r.hours > MAX_HOURS) {
    return fail(`Duration must be between 00:00 and ${hoursToHHMM(MAX_HOURS)}`);
  }
  if (el) el.value = r.canonical; // leave the field showing what was actually saved
  if (err) err.hidden = true;
  return r.hours;
}
// Hard caps, checked before the request goes out so the user gets a specific,
// immediate message instead of a round-trip 400. The server enforces the same
// rules independently — this is convenience, never the guarantee.
//   day total <= 24h · each project's weekly subtotal <= 40h
//   (no per-task/row cap, no cap on the week's grand total)
// `replacingId` is the entry being edited, excluded from the "before" figures.
// Mirrors the server: only rejects when the save would INCREASE an over-cap
// total, so an existing breach can still be edited downwards.
const DAY_CAP = 24, WEEK_CAP = 40;
function capViolation(rowKey, date, hours, replacingId) {
  const w = window._week;
  if (!w || !w.byCell) return null;
  const sumCells = (pred) => Object.entries(w.byCell).reduce((s, [k, list]) => {
    if (!pred(k)) return s;
    return s + list.reduce((a, e) => a + (replacingId && e.id === replacingId ? 0 : Number(e.hours)), 0);
  }, 0);
  const dayName = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
  // The entry being replaced is excluded from every "before" figure, so its old
  // value has to be added back to know the scope's CURRENT total — otherwise
  // lowering an already-over-cap row would read as an increase and be blocked.
  let prev = 0;
  if (replacingId) {
    Object.values(w.byCell).forEach((list) => list.forEach((e) => { if (e.id === replacingId) prev = Number(e.hours); }));
  }
  const over = (before, label, cap) => {
    const after = before + hours;
    return after > cap && after > before + prev
      ? `This would put ${label} at ${durClock(after)} — the limit is ${durClock(cap)}`
      : null;
  };

  const day = over(sumCells((k) => k.endsWith('|' + date)), dayName, DAY_CAP);
  if (day) return day;
  // No per-task/row cap — a single task may run the whole week's 40h on its own.

  const projName = Object.keys(w.groups || {}).find((p) => (w.groups[p] || []).some((r) => r.key === rowKey));
  if (projName) {
    const keys = new Set((w.groups[projName] || []).map((r) => r.key));
    const proj = over(sumCells((k) => keys.has(k.slice(0, k.lastIndexOf('|')))), `${projName} for the week`, WEEK_CAP);
    if (proj) return proj;
  }
  // No cap on the week's grand total — only the day and each project's weekly
  // subtotal are bounded.
  return null;
}
/** Shows a cap breach under the Duration field, same place as format errors. */
function capBlocked(rowKey, date, hours, replacingId) {
  const msg = capViolation(rowKey, date, hours, replacingId);
  if (!msg) return false;
  const err = $('mHoursErr');
  if (err) { err.textContent = msg; err.hidden = false; } else { toast(msg); }
  return true;
}
window.createEntry = async (rowKey, date) => {
  const hours = readHoursInput(); if (hours === null) return;
  if (capBlocked(rowKey, date, hours)) return;
  try {
    const isProject = rowKey.startsWith('p:');
    const p = { date, hours, entryType: 'WORK', billable: true, notes: $('mNotes').value };
    if (isProject) p.projectId = rowKey.slice(2);
    else p.subtaskId = rowKey;
    await api('/time-entries', { method: 'POST', body: JSON.stringify(p) }); closeModal(); await refresh();
  } catch (e) { toast(e.message); }
};
window.saveEntry = async (id) => { const hours = readHoursInput(); if (hours === null) return; const c = window._cellCtx || {}; if (c.rowKey && capBlocked(c.rowKey, c.date, hours, id)) return; try { await api('/time-entries/' + id, { method: 'PATCH', body: JSON.stringify({ hours, notes: $('mNotes').value }) }); closeModal(); await refresh(); } catch (e) { toast(e.message); } };
window.deleteEntry = async (id) => { try { await api('/time-entries/' + id, { method: 'DELETE' }); closeModal(); await refresh(); } catch (e) { toast(e.message); } };
window.requestEdit = async (id) => { const hours = readHoursInput(); if (hours === null) return; const c = window._cellCtx || {}; if (c.rowKey && capBlocked(c.rowKey, c.date, hours, id)) return; try { await api('/edit-requests', { method: 'POST', body: JSON.stringify({ timeEntryId: id, proposedHours: hours, reason: $('mReason').value }) }); closeModal(); toast('Edit request submitted'); } catch (e) { toast(e.message); } };
window.submitWeek = async () => {
  // Catch likely accidental omissions: weekdays on/before today with no entry
  // at all. A deliberate "no work" day should carry a 0-hour entry instead.
  const w = window._week;
  if (w && w.dates) {
    const today = iso(new Date());
    const missing = w.dates.filter((d) => { const dow = new Date(d + 'T00:00:00').getDay(); return dow >= 1 && dow <= 5 && d <= today && !w.datesWithEntries.has(d); });
    if (missing.length && !confirm(`No time logged on: ${missing.join(', ')}.\n\nIf that's intentional, log 0 hours to record "no work done". Submit anyway?`)) return;
  }
  try {
    // Tidy first: empty rows (0h all week) are dropped so the submitted week is clean.
    await api('/timesheet-rows/prune-empty', { method: 'POST', body: JSON.stringify({ weekStart: iso(currentWeek) }) });
    await api('/approvals/submit', { method: 'POST', body: JSON.stringify({ weekStart: iso(currentWeek) }) });
    toast('Submitted for review'); await refresh();
  } catch (e) { toast(e.message); }
};
window.approveWeek = async () => { try { await api('/approvals/approve', { method: 'POST', body: JSON.stringify({ userId: reviewingUserId, weekStart: iso(currentWeek) }) }); toast('Approved'); await refresh(); } catch (e) { toast(e.message); } };
window.revertWeek = async () => { try { await api('/approvals/revert', { method: 'POST', body: JSON.stringify({ userId: reviewingUserId, weekStart: iso(currentWeek) }) }); toast('Sent back for changes'); await refresh(); } catch (e) { toast(e.message); } };

// ===========================================================================
// Inbox
// ===========================================================================
const NOTE_ICON = { ASSIGNMENT: 'list', SUBMISSION: 'inbox', APPROVAL: 'check', EDIT_REQUEST: 'inbox', EDIT_RESOLVED: 'check', TEAM: 'users', ROLE_CHANGE: 'users', MEMBERSHIP: 'users', TIMESHEET: 'table', TASK_REQUEST: 'list', TASK_REQUEST_RESOLVED: 'check', HOURS_ALERT: 'alert' };
// Status-color language for the leading dot (matches badges/bars across the app).
const NOTE_STATUS = { SUBMISSION: 'submitted', EDIT_REQUEST: 'submitted', APPROVAL: 'approved', EDIT_RESOLVED: 'approved', TASK_REQUEST: 'submitted', TASK_REQUEST_RESOLVED: 'approved', HOURS_ALERT: 'rejected' };
// Types that get the high-urgency row treatment (red border/tint/icon) so they
// stand out at a glance from routine submission/approval traffic.
const NOTE_URGENT = new Set(['HOURS_ALERT']);
window.setDashRange = (r) => { analyticsRange = r; renderDashboard(); };
async function renderInbox() {
  renderPage('Notifications', `<div id="inboxBody"><p class="muted">Loading…</p></div>`, '');
  try {
    const notes = await api('/notifications');
    window._inboxNotes = notes;
    let h = `<div class="actions" style="margin:0 0 12px"><button class="btn btn-ghost btn-sm" onclick="markAllRead()">Mark all read</button></div><ul class="inbox-list">`;
    h += notes.map((n) => {
      const canAct = n.actionable && !n.resolved;
      let controls = '';
      if (n.actionable && n.resolved) {
        controls = `<span class="badge badge-approved" style="margin-left:8px">actioned</span>`;
      } else if (canAct && n.type === 'SUBMISSION') {
        controls = `<span class="inbox-actions"><button class="btn btn-primary btn-sm" onclick="notifAction(event,'${n.id}','approve')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="notifAction(event,'${n.id}','reject')">Request changes</button></span>`;
      } else if (canAct && n.type === 'EDIT_REQUEST') {
        controls = `<span class="inbox-actions"><button class="btn btn-primary btn-sm" onclick="notifAction(event,'${n.id}','approve')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="notifAction(event,'${n.id}','deny')">Deny</button></span>`;
      } else if (canAct && n.type === 'TASK_REQUEST') {
        // Same row serves both sides: the lead reviews it, while the requester's
        // copy (sent when changes were requested) is their way back in to edit.
        controls = user.role === 'TEAM_LEAD'
          ? `<span class="inbox-actions"><button class="btn btn-primary btn-sm" onclick="notifAction(event,'${n.id}','approve')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="taskReviewNote(event,'${n.id}','reject')">Request changes</button> <button class="btn btn-ghost btn-sm" onclick="taskReviewNote(event,'${n.id}','deny')">Deny</button></span>`
          : `<span class="inbox-actions"><button class="btn btn-primary btn-sm" onclick="taskRequestEdit(event,'${n.id}')">Edit &amp; resubmit</button></span>`;
      }
      const hasTarget = !!(n.targetUserId && n.targetWeekStart);
      const cls = 'inbox-row' + (hasTarget ? ' inbox-row-link' : '') + (NOTE_URGENT.has(n.type) ? ' inbox-row-urgent' : '');
      return `<li class="${cls}" onclick="notifOpen('${n.id}')"><span class="status-dot ${NOTE_STATUS[n.type] || 'draft'}"></span>${icon(NOTE_ICON[n.type] || 'inbox')}<div class="msg"><div class="type">${n.type.replace('_', ' ').toLowerCase()}</div>${esc(n.message)}</div>${controls}<span class="ts">${relTime(n.createdAt)}</span><span class="dot ${n.read ? 'read' : 'unread'}"></span></li>`;
    }).join('') || '<p class="muted">No notifications.</p>';
    $('inboxBody').innerHTML = h + '</ul>';
  } catch (e) { $('inboxBody').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
// Deny and "request changes" both require a note — the requester has to know
// why, or what to fix. Approve needs none, so it stays a one-click action.
window.taskReviewNote = (ev, id, decision) => {
  ev.stopPropagation();
  const isDeny = decision === 'deny';
  openModal(`<h3>${isDeny ? 'Deny request' : 'Request changes'}</h3>
    <p class="meta">${isDeny ? 'Explain why — the requester will see this.' : 'Describe what needs to change before you can approve it.'}</p>
    <div class="field"><label>Note</label><textarea id="trNote" rows="3" maxlength="2000" placeholder="${isDeny ? 'e.g. This is already covered by an existing task.' : 'e.g. Narrow the scope and add an estimate.'}"></textarea></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="sendTaskReview('${id}','${decision}')">${isDeny ? 'Deny' : 'Send back'}</button></div>`);
};
window.sendTaskReview = async (id, decision) => {
  const note = ($('trNote').value || '').trim();
  if (!note) { toast('A note is required'); return; }
  try {
    await api('/notifications/' + id + '/action', { method: 'POST', body: JSON.stringify({ decision, note }) });
    closeModal();
    toast(decision === 'deny' ? 'Denied' : 'Sent back for changes');
  } catch (e) { toast(e.message); return; }
  renderInbox(); loadInboxBadge();
};
// The notification carries the request id, so go straight to the edit form.
window.taskRequestEdit = async (ev, id) => {
  ev.stopPropagation();
  const n = (window._inboxNotes || []).find((x) => x.id === id);
  if (n && n.relatedEntityId) openTaskRequestEdit(n.relatedEntityId);
};
window.notifAction = async (ev, id, decision) => {
  ev.stopPropagation();
  try { await api('/notifications/' + id + '/action', { method: 'POST', body: JSON.stringify({ decision }) }); toast(decision === 'approve' ? 'Approved' : (decision === 'deny' ? 'Denied' : 'Sent back')); }
  catch (e) { toast(e.message); }
  renderInbox(); loadInboxBadge();
};
// Row click: mark read, then (for notifications that reference a person + week)
// deep-link into the Timesheet view for that subject's timesheet on that week.
// Action buttons stopPropagation, so they never trigger this.
window.notifOpen = async (id) => {
  const n = (window._inboxNotes || []).find((x) => x.id === id);
  if (!n) return;
  if (!n.read) { try { await api('/notifications/' + id + '/read', { method: 'PATCH' }); } catch (e) {} }
  if (n.targetUserId && n.targetWeekStart) {
    currentWeek = mondayOf(new Date(n.targetWeekStart + 'T00:00:00'));
    if (n.targetUserId === user.id) {
      // Own timesheet (e.g. "your timesheet was paid") — view it normally, not
      // in read-only "reviewing" mode.
      reviewingUserId = '';
      reviewingUserName = '';
    } else {
      // Point "Reviewing" at the subject. Switching to the Timesheet view (below) builds
      // its sidebar context, and loadReviewing() rebuilds the dropdown and selects
      // this user via reviewingUserId/Name. Actual visibility is enforced by the
      // backend week fetch — renderTable falls back to self if it denies access.
      reviewingUserId = n.targetUserId;
      reviewingUserName = n.targetUserName || 'Selected user';
    }
    setActiveNav('table');
    renderTable();
    loadInboxBadge();
  } else {
    // No timesheet target — just reflect the read state.
    renderInbox();
    loadInboxBadge();
  }
};
window.markRead = async (id) => { try { await api('/notifications/' + id + '/read', { method: 'PATCH' }); } catch (e) {} renderInbox(); loadInboxBadge(); };
window.markAllRead = async () => { try { await api('/notifications/read-all', { method: 'PATCH' }); } catch (e) {} renderInbox(); loadInboxBadge(); };

// ===========================================================================
// Calendar (placeholder)
// ===========================================================================
// Full-screen month calendar — one grid filling the viewport, per-day logged
// hours from /time-entries/calendar. Days with hours show a total pill + entry
// count and open the day detail; leading/trailing cells are neighbouring-month
// filler so the grid reads as a complete rectangle. Month nav lives in the page
// header. (A day pill is a multi-entry total, so it stays plain "Nh" — the HH:MM
// treatment is reserved for single-entry durations, e.g. inside the day detail.)
async function renderCalendar() {
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0)); // last day of month
  const startStr = first.toISOString().slice(0, 10);
  const endStr = last.toISOString().slice(0, 10);
  const label = `${MONTHS[month]} ${year}`;
  const nav = `<div class="cal-nav"><button class="btn btn-icon" onclick="calShift(-1)" title="Previous month">‹</button><button class="cal-month-btn" onclick="openMonthPicker()" title="Jump to any month">${esc(MONTHS[month])} ${year} ${icon('chevronD', 'cal-caret')}</button><button class="btn btn-icon" onclick="calShift(1)" title="Next month">›</button><button class="btn btn-ghost btn-sm" onclick="calToday()">Today</button></div>`;
  renderPage('Calendar', `<div id="calg" class="cal-full"><p class="muted">Loading ${esc(label)}…</p></div>`, nav);
  try {
    const data = await api(`/time-entries/calendar?range=custom&start_date=${startStr}&end_date=${endStr}`);
    const byDay = {};
    (data.days || []).forEach((d) => { byDay[d.date] = d; });
    window._cal = byDay;
    const firstDow = first.getUTCDay(); // Sunday-first
    const daysInMonth = last.getUTCDate();
    const prevLast = new Date(Date.UTC(year, month, 0)).getUTCDate(); // last day of prev month
    const todayStr = new Date().toISOString().slice(0, 10);
    const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7; // whole weeks only
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => `<div class="cal-wd">${w}</div>`).join('');
    let cells = '';
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - firstDow + 1;
      if (dayNum < 1) { cells += `<div class="cal-cell pad"><span class="cal-num">${prevLast + dayNum}</span></div>`; continue; }
      if (dayNum > daysInMonth) { cells += `<div class="cal-cell pad"><span class="cal-num">${dayNum - daysInMonth}</span></div>`; continue; }
      const ds = new Date(Date.UTC(year, month, dayNum)).toISOString().slice(0, 10);
      const dd = byDay[ds];
      const hrs = dd ? dd.hours : 0;
      const isT = ds === todayStr;
      const has = hrs > 0;
      // Hours pill only (no entry count on the face) — colored against the 8h
      // reference like the timesheet grid. Hover adds a project/subtask/hours
      // breakdown; click opens the full per-entry detail (calDay).
      const meta = has ? `<span class="cal-meta"><span class="cal-hrs ${hoursColorClass(hrs)}">${dur(hrs)}</span></span>` : '';
      const interactive = has ? ` onclick="calDay('${ds}')" onmousemove="calTip(event,'${ds}')" onmouseleave="cellTipHide()"` : '';
      cells += `<div class="cal-cell${has ? ' has' : ''}${isT ? ' today' : ''}"${interactive}><span class="cal-num">${dayNum}</span>${meta}</div>`;
    }
    $('calg').innerHTML = `<div class="cal-wds">${wd}</div><div class="cal-grid">${cells}</div>`;
  } catch (e) { $('calg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.calShift = (delta) => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1); renderCalendar(); };
window.calToday = () => { calCursor = new Date(); renderCalendar(); };
// Month-jump picker: a year stepper + a 12-month grid, so any month is one click
// away (no stepping through). The currently shown month is highlighted; the real
// current month gets a ring.
function monthPickerHtml() {
  const now = new Date();
  const grid = MONTHS.map((mn, i) => {
    const sel = i === calCursor.getMonth() && calPickYear === calCursor.getFullYear();
    const isNow = i === now.getMonth() && calPickYear === now.getFullYear();
    return `<button class="mp-cell${sel ? ' sel' : ''}${isNow ? ' now' : ''}" onclick="calPickMonth(${i})">${esc(mn.slice(0, 3))}</button>`;
  }).join('');
  return `<h3>Jump to month</h3>
    <div class="mp-yearbar">
      <button class="btn btn-icon" onclick="calPickYearShift(-1)" title="Previous year">‹</button>
      <span class="mp-year">${calPickYear}</span>
      <button class="btn btn-icon" onclick="calPickYearShift(1)" title="Next year">›</button>
    </div>
    <div class="mp-grid">${grid}</div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`;
}
window.openMonthPicker = () => { calPickYear = calCursor.getFullYear(); openModal(monthPickerHtml()); };
window.calPickYearShift = (d) => { calPickYear += d; openModal(monthPickerHtml()); };
window.calPickMonth = (mi) => { calCursor = new Date(calPickYear, mi, 1); closeModal(); renderCalendar(); };
window.calDay = (dateStr) => {
  const dd = (window._cal || {})[dateStr]; if (!dd) return;
  const p = dateStr.split('-');
  const dateLabel = `${MONTHS[+p[1] - 1]} ${+p[2]}, ${p[0]}`;
  const rows = dd.entries.map((e) => `<tr><td>${esc(e.subtask ? e.subtask.name : (e.entryType || '—'))}${e.notes ? `<div class="cal-daynotes">${esc(e.notes)}</div>` : ''}</td><td class="num">${durClock(e.hours)}</td></tr>`).join('');
  // Own larger-type treatment (cal-daymodal) rather than the shared modal/data-table
  // defaults, which run small (16px header, 12–13px table) — this view needs to
  // read clearly at a glance, same as the calendar grid it's opened from.
  openModal(`<div class="cal-daymodal"><h3>${esc(dateLabel)}</h3><p class="meta">${dur(dd.hours)} across ${dd.entries.length} ${dd.entries.length === 1 ? 'entry' : 'entries'}</p><table class="data-table"><thead><tr><th>Task</th><th class="num">Duration</th></tr></thead><tbody>${rows}</tbody></table><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div></div>`);
};
// Day hover tooltip: date + project/subtask + hours per task worked that day —
// a summary, not the full per-entry detail (notes/status), which stays reserved
// for the click-through day view (calDay). Reuses the same #cellTip element/CSS
// as the timesheet's cellTip/projTip.
window.calTip = (evt, dateStr) => {
  const dd = (window._cal || {})[dateStr]; if (!dd || !dd.entries.length) return;
  const byTarget = {}; // subtaskId or 'p:'+projectId -> { name, project, hours }
  dd.entries.forEach((e) => {
    const key = e.subtaskId || ('p:' + e.projectId);
    if (!byTarget[key]) {
      const meta = e.subtaskId ? (subtaskMap[e.subtaskId] || {}) : {};
      byTarget[key] = {
        name: e.subtaskId ? (meta.name || 'Task') : 'General / project time',
        project: e.subtaskId ? (meta.project || '') : (e.project ? e.project.name : ''),
        hours: 0,
      };
    }
    byTarget[key].hours += Number(e.hours);
  });
  const p = dateStr.split('-');
  const dateLabel = `${MONTHS[+p[1] - 1]} ${+p[2]}, ${p[0]}`;
  let h = `<div class="ct-name">${esc(dateLabel)}</div>`;
  // Matches the timesheet's projTip block convention: "<b>hours</b> · name",
  // with the project as a muted sub-line when there is one.
  Object.values(byTarget).forEach((r) => {
    h += `<div class="ct-block">${r.project ? `<div class="ct-sub">${esc(r.project)}</div>` : ''}<div class="ct-line"><b>${durClock(r.hours)}</b> · ${esc(r.name)}</div></div>`;
  });
  let t = document.getElementById('cellTip');
  if (!t) { t = document.createElement('div'); t.id = 'cellTip'; t.className = 'chart-tip hover-tip'; document.body.appendChild(t); }
  t.innerHTML = h; t.style.display = 'block';
  t.style.left = (evt.clientX + 14) + 'px'; t.style.top = (evt.clientY + 16) + 'px';
};

// ===========================================================================
// CEO — Projects management
// ===========================================================================
let showArchived = false;
async function renderProjects() {
  renderPage('Projects', `<div id="pg"><p class="muted">Loading…</p></div>`, `<button class="btn btn-primary" onclick="openAddProject()">+ Add project</button>`);
  try {
    const projects = await api('/projects?include_archived=' + showArchived);
    const clientCount = new Set(projects.map((p) => p.client && p.client.name).filter(Boolean)).size;

    let h = `<div class="dash-hero"><div class="stat-row">
      <div class="stat"><div class="stat-ico tone-violet">${icon('folder')}</div><div class="label">Projects</div><div class="value">${projects.length}</div></div>
      <div class="stat"><div class="stat-ico tone-green">${icon('building')}</div><div class="label">Clients</div><div class="value">${clientCount}</div></div>
    </div></div>`;

    h += `<div class="card"><div class="page-title-row"><h3>All projects</h3>
      <label class="row-flex"><input type="checkbox" ${showArchived ? 'checked' : ''} onchange="toggleArchived(this.checked)" style="width:auto"> Show archived</label></div>
      <div class="item-grid">`;
    h += projects.map((p) => {
      const archived = !!p.archivedAt;
      const due = p.deadline ? 'Due ' + fmtDay(new Date(p.deadline)) : 'No deadline';
      // Stable per-project color (hash of the name), not position-based.
      const color = 'var(--bg2)'; // neutral card surface (per-project hues retired)
      return `<div class="item-card${archived ? ' is-archived' : ''}" style="background:${color}">
        <span class="item-chip">${icon('calendar')}${esc(due)}</span>
        <div class="item-title">${esc(p.name)}${archived ? ' <span class="badge badge-muted">archived</span>' : ''}</div>
        <div class="item-desc">${esc(p.client ? p.client.name : '—')}</div>
        <div class="item-spacer"></div>
        <div class="item-actions">
          <button class="btn btn-sm" onclick="setArchive('${p.id}',${archived ? 'false' : 'true'})">${archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn btn-sm" onclick="deleteProject('${p.id}','${esc(p.name).replace(/'/g, "")}')">Delete</button>
        </div></div>`;
    }).join('') || '<p class="muted">No projects yet.</p>';
    $('pg').innerHTML = h + '</div></div>';
    watchDashHero();
  } catch (e) { $('pg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.toggleArchived = (v) => { showArchived = v; renderProjects(); };
window.setArchive = async (id, archived) => { try { await api('/projects/' + id + '/' + (archived ? 'archive' : 'unarchive'), { method: 'POST' }); toast(archived ? 'Archived' : 'Unarchived'); renderProjects(); loadProjectsList(); } catch (e) { toast(e.message); } };
window.deleteProject = async (id, name) => { if (!confirm('Delete project "' + name + '"? Only works if it has no tasks and no logged time — otherwise archive it instead.')) return; try { await api('/projects/' + id, { method: 'DELETE' }); toast('Deleted'); renderProjects(); loadProjectsList(); } catch (e) { toast(e.message); } };

// ===========================================================================
// Teams (PM manage · CEO view · Team Lead own-membership)
// ===========================================================================
async function renderTeams() {
  renderPage('Teams', `<div id="tmg"><p class="muted">Loading…</p></div>`);
  const isPM = user.role === 'PM', isLead = user.role === 'TEAM_LEAD';
  // Membership editing: a lead on their own team (all `/teams` returns for them),
  // a PM on any. Mirrors assertCanManageMembers() server-side.
  const canManage = isPM || isLead;
  try {
    const [teams, leads, members] = await Promise.all([
      api('/teams'),
      isPM ? api('/users?role=TEAM_LEAD') : Promise.resolve([]),
      // Only members not already on a team — a member belongs to exactly one team,
      // and the backend rejects the add anyway, so don't offer the dead choice.
      (isPM || isLead) ? api('/users?role=TEAM_MEMBER&unassigned=true') : Promise.resolve([]),
    ]);
    window._leads = leads; window._members = members; window._teams = teams;
    let h = '';
    if (isPM) {
      h += `<div class="card sticky-create"><h3>Create team</h3><div class="form-grid">
        <label>Name</label><input id="tmName" placeholder="Team name">
        <label>Team lead</label><select id="tmLead"><option value="">— leaderless —</option>${leads.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
        <div style="margin-top:12px"><button class="btn btn-primary" onclick="createTeam()">Create team</button></div></div>`;
    }
    if (!teams.length) { h += '<p class="muted">No teams' + (isLead ? ' led by you.' : '.') + '</p>'; $('tmg').innerHTML = h; return; }
    const TEAM_TONES = ['tone-blue', 'tone-green', 'tone-amber', 'tone-violet', 'tone-red', 'tone-gray'];
    const initials = (n) => (n || '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    teams.forEach((t, idx) => {
      const tone = TEAM_TONES[idx % TEAM_TONES.length];
      const count = (t.memberships || []).length;
      const leadChip = t.teamLead
        ? `<span class="lead-chip"><span class="mini-avatar">${initials(t.teamLead.name)}</span>${esc(t.teamLead.name)}</span>`
        : `<span class="lead-chip leaderless"><span class="mini-avatar">–</span>leaderless</span>`;
      const memberPills = count
        ? (t.memberships).map((m) => `<span class="member-pill"><span class="mini-avatar">${initials(m.user.name)}</span>${esc(m.user.name)}${canManage ? `<span class="x" title="Remove from team" onclick="removeTeamMember('${t.id}','${m.user.id}')">✕</span>` : ''}</span>`).join('')
        : '<span class="muted">No members yet</span>';
      h += `<div class="card team-card">
        <div class="team-head">
          <div class="team-ico ${tone}">${esc(initials(t.name)) || icon('users')}</div>
          <div><div class="team-name">${esc(t.name)}</div><div class="muted" style="font-size:12px">${count} member${count === 1 ? '' : 's'}</div></div>
          <div class="spacer-h"></div>
          <span class="count-chip">${count}</span>
          ${isPM ? `<button class="btn btn-ghost btn-sm" title="Rename team" onclick="openRenameTeam('${t.id}')">${icon('pencil')}</button>` : ''}
          ${isPM ? `<button class="btn btn-ghost btn-sm" onclick="deleteTeam('${t.id}','${esc(t.name).replace(/'/g, '')}')">Delete team</button>` : ''}
        </div>
        <div class="team-sec-label">Lead</div>
        <div class="row-flex" style="margin-bottom:14px">${leadChip}
        ${isPM ? `<select id="tl_${t.id}" style="max-width:220px"><option value="">— change lead —</option>${leads.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select><button class="btn btn-ghost btn-sm" onclick="changeTeamLead('${t.id}')">Set lead</button>` : ''}</div>
        <div class="team-sec-label">Members</div>
        <div class="member-list">${memberPills}</div>
        ${canManage ? (members.length
          ? `<div class="row-flex" style="margin-top:12px"><select id="am_${t.id}" style="max-width:220px">${members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><button class="btn btn-primary btn-sm" onclick="addTeamMember('${t.id}')">Add member</button></div>`
          : `<p class="muted" style="margin-top:12px">Every Team Member already belongs to a team. Remove someone from their current team to free them up to join this one.</p>`) : ''}
      </div>`;
    });
    $('tmg').innerHTML = h;
    watchStickyCreate();
  } catch (e) { $('tmg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
// Flags the sticky "Create team" card once it actually sticks, so it can lift
// above the scrolling list. Uses an IntersectionObserver keyed to the sticky
// offset (no per-scroll work); the rootMargin must stay just past `top` in CSS.
function watchStickyCreate() {
  const el = document.querySelector('.sticky-create');
  if (!el || typeof IntersectionObserver === 'undefined') return;
  new IntersectionObserver(
    ([entry]) => el.classList.toggle('is-stuck', entry.intersectionRatio < 1),
    { threshold: [1], rootMargin: '-17px 0px 0px 0px' },
  ).observe(el);
}
window.createTeam = async () => { try { const body = { name: $('tmName').value }; if ($('tmLead').value) body.teamLeadId = $('tmLead').value; await api('/teams', { method: 'POST', body: JSON.stringify(body) }); toast('Team created'); renderTeams(); } catch (e) { toast(e.message); } };
window.openRenameTeam = (id) => {
  const t = (window._teams || []).find((x) => x.id === id); if (!t) return;
  openModal(`<h3>Rename team</h3>
    <div class="field"><label>Team name</label><input id="rtName" value="${esc(t.name)}" autofocus></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveTeamName('${id}')">Save</button></div>`);
};
window.saveTeamName = async (id) => {
  const name = $('rtName').value.trim();
  if (!name) { toast('Team name cannot be empty'); return; }
  try { await api('/teams/' + id, { method: 'PATCH', body: JSON.stringify({ name }) }); closeModal(); toast('Team renamed'); renderTeams(); } catch (e) { toast(e.message); }
};
window.deleteTeam = async (id, name) => { if (!confirm('Delete team "' + name + '"? (soft delete — history preserved)')) return; try { await api('/teams/' + id, { method: 'DELETE' }); toast('Team deleted'); renderTeams(); } catch (e) { toast(e.message); } };
window.changeTeamLead = async (id) => { const v = $('tl_' + id).value; try { await api('/teams/' + id + '/lead', { method: 'PUT', body: JSON.stringify({ teamLeadId: v || undefined }) }); toast('Lead updated'); renderTeams(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.addTeamMember = async (id) => { const v = $('am_' + id).value; if (!v) return; try { await api('/teams/' + id + '/members', { method: 'POST', body: JSON.stringify({ userId: v }) }); toast('Member added'); renderTeams(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.removeTeamMember = async (id, userId) => { try { await api('/teams/' + id + '/members/' + userId, { method: 'DELETE' }); toast('Member removed'); renderTeams(); loadInboxBadge(); } catch (e) { toast(e.message); } };

// ===========================================================================
// People — promote / demote (PM)
// ===========================================================================
async function renderPeople() {
  renderPage('People', `<div id="ppl"><p class="muted">Loading…</p></div>`);
  try {
    const [leads, members] = await Promise.all([api('/users?role=TEAM_LEAD'), api('/users?role=TEAM_MEMBER')]);
    const row = (u, action, label) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role.replace('_', ' ').toLowerCase()}</td><td class="num"><button class="btn btn-ghost btn-sm" onclick="roleHistory('${u.id}','${esc(u.name).replace(/'/g, "")}')">History</button> <button class="btn btn-primary btn-sm" onclick="${action}('${u.id}')">${label}</button></td></tr>`;
    // Only the group selected in the sidebar renders.
    const showMembers = peopleFilter !== 'leads';
    const list = showMembers ? members : leads;
    const heading = showMembers
      ? 'Team members <span class="muted">— promote to lead</span>'
      : 'Team leads <span class="muted">— demote to member</span>';
    let h = `<div class="card"><div class="page-title-row"><h3>${heading}</h3><span class="muted">${list.length} ${list.length === 1 ? 'person' : 'people'}</span></div>`;
    h += `<table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead><tbody>`;
    h += list.map((u) => row(u, showMembers ? 'promote' : 'demote', showMembers ? 'Promote' : 'Demote')).join('')
      || `<tr><td colspan="4" class="muted">No ${showMembers ? 'team members' : 'team leads'}.</td></tr>`;
    $('ppl').innerHTML = h + '</tbody></table></div>';
  } catch (e) { $('ppl').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.promote = async (userId) => { try { await api('/role-changes/promote', { method: 'POST', body: JSON.stringify({ userId }) }); toast('Promoted to Team Lead'); renderPeople(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.demote = async (userId) => { try { await api('/role-changes/demote', { method: 'POST', body: JSON.stringify({ userId }) }); toast('Demoted to Team Member'); renderPeople(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.roleHistory = async (userId, name) => {
  try {
    const rows = await api('/role-changes/' + userId + '/history');
    const body = rows.map((r) => `<tr><td>${relTime(r.createdAt)}</td><td>${r.oldRole.replace('_', ' ').toLowerCase()} → ${r.newRole.replace('_', ' ').toLowerCase()}</td><td>${esc(r.changedBy ? r.changedBy.name : '')}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No role changes.</td></tr>';
    openModal(`<h3>Role history</h3><p class="meta">${esc(name)}</p><table class="data-table"><thead><tr><th>When</th><th>Change</th><th>By</th></tr></thead><tbody>${body}</tbody></table><div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Close</button></div>`);
  } catch (e) { toast(e.message); }
};

// ===========================================================================
// Clients (CEO)
// ===========================================================================
async function renderClients() {
  const canEdit = user.role === 'CEO';
  renderPage('Clients', `<div id="cg"><p class="muted">Loading…</p></div>`);
  try {
    const clients = await api('/clients');
    window._clients = clients;

    // Only the section selected in the sidebar renders; a client is just a name
    // that projects hang off of, so the list is name + Edit.
    if (canEdit && clientsSection === 'add') {
      $('cg').innerHTML = `<div class="card"><h3>Add client</h3><div class="form-grid"><label>Name</label><input id="clName" placeholder="Client name"></div><div style="margin-top:12px"><button class="btn btn-primary" onclick="addClient()">Add client</button></div></div>`;
      return;
    }

    const cols = canEdit ? 2 : 1;
    let h = `<div class="card" style="padding-top:6px"><table class="data-table"><thead><tr><th>Client</th>${canEdit ? '<th></th>' : ''}</tr></thead><tbody>`;
    h += clients.map((c) => {
      const editBtn = canEdit ? `<td class="num"><button class="btn btn-ghost btn-sm" title="Edit client" onclick="openEditClient('${c.id}')">${icon('pencil')}</button></td>` : '';
      return `<tr><td>${esc(c.name)}</td>${editBtn}</tr>`;
    }).join('') || `<tr><td colspan="${cols}" class="muted">No clients.</td></tr>`;
    h += '</tbody></table></div>';

    $('cg').innerHTML = h;
  } catch (e) { $('cg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.openEditClient = (id) => {
  const c = (window._clients || []).find((x) => x.id === id); if (!c) return;
  openModal(`<h3>Edit client</h3>
    <div class="field"><label>Name</label><input id="ecName" value="${esc(c.name)}"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveClient('${id}')">Save</button></div>`);
};
window.saveClient = async (id) => {
  try { await api('/clients/' + id, { method: 'PATCH', body: JSON.stringify({ name: $('ecName').value }) }); closeModal(); toast('Client updated'); renderClients(); loadProjectsList(); } catch (e) { toast(e.message); }
};
window.addClient = async () => { try { await api('/clients', { method: 'POST', body: JSON.stringify({ name: $('clName').value }) }); toast('Client added'); renderClients(); } catch (e) { toast(e.message); } };

// ===========================================================================
// PM — Subtasks: create + project-level team lead (v6)
// ===========================================================================
async function renderSubtasks() {
  renderPage('Tasks', `<div id="sg"><p class="muted">Loading…</p></div>`);
  try {
    const [projects, subtasks, leads] = await Promise.all([api('/projects'), api('/subtasks'), api('/users?role=TEAM_LEAD')]);
    window._leads = leads;
    const activeProjects = projects.filter((p) => !p.archivedAt);
    const leadCell = (p) => personChip(p.teamLead ? p.teamLead.name : null);
    window._subtasks = subtasks;

    // Only the section selected in the sidebar renders.
    let h;
    if (subtasksSection === 'leads') {
      // One Team Lead owns the whole project — every subtask inherits it.
      h = `<div class="card"><h3>Assign project <span class="muted">— one lead owns every task under the project</span></h3>
        <table class="data-table"><thead><tr><th>Project</th><th>Current lead</th><th></th></tr></thead><tbody>`;
      h += activeProjects.map((p) => `<tr><td>${esc(p.name)}</td><td>${leadCell(p)}</td><td class="num">
        <select id="pl_${p.id}" style="max-width:200px"><option value="">— leaderless —</option>${leads.map((l) => `<option value="${l.id}" ${p.teamLead && p.teamLead.id === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        <button class="btn btn-ghost btn-sm" onclick="setProjectLead('${p.id}')">Set lead</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No projects.</td></tr>';
      h += '</tbody></table></div>';
    } else if (subtasksSection === 'create') {
      h = `<div class="card"><h3>Create task</h3><div class="form-grid">
        <label>Project</label><select id="stProj">${activeProjects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <label>Name</label><input id="stName" placeholder="Task name">
        <label>Estimated hours</label><input id="stEst" type="number" placeholder="0">
        <label>Deadline</label><input id="stDeadline" type="date"></div>
        <div style="margin-top:12px"><button class="btn btn-primary" onclick="createSubtask()">Create task</button></div></div>`;
    } else {
      // Subtasks inherit their parent project's lead (read-only). Project filter +
      // per-row Delete (PM soft-delete). List is populated by filterSubtasks().
      const filterOpts = `<option value="">All projects</option>` + activeProjects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      h = `<div class="card"><div class="page-title-row"><h3>All tasks</h3><span id="stCount" class="muted"></span></div>
        <label class="row-flex muted" style="gap:8px;margin-bottom:12px">Project
          <select id="stFilter" onchange="filterSubtasks(this.value)" style="max-width:220px">${filterOpts}</select></label>
        <div class="item-grid" id="stBody"></div></div>`;
    }
    $('sg').innerHTML = h;
    if (subtasksSection === 'all') filterSubtasks(''); // default: all projects
  } catch (e) { $('sg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
// Block card on a neutral surface — project identity reads from the name text
// (the per-project color palette was retired for the lime + neutrals scheme).
function subtaskCard(s) {
  const leadName = s.project && s.project.teamLead ? s.project.teamLead.name : '';
  const due = s.deadline ? 'Due ' + fmtDay(new Date(s.deadline)) : 'No deadline';
  const color = 'var(--bg2)'; // neutral card surface (per-project hues retired)
  return `<div class="item-card" style="background:${color}">
    <span class="item-chip">${icon('calendar')}${esc(due)}</span>
    <div class="item-title">${esc(s.name)}</div>
    <div class="item-desc">${esc(s.project ? s.project.name : '')}${leadName ? ' · ' + esc(leadName) : ' · leaderless'}</div>
    <div class="item-spacer"></div>
    <div class="item-actions">
      <span class="item-pct">${dur(s.estimatedHours)} est.</span>
      <span class="item-spacer"></span>
      <button class="btn btn-sm" title="Delete task" onclick="deleteSubtask('${s.id}','${esc(s.name).replace(/'/g, '')}')">${icon('trash')}</button>
    </div></div>`;
}
// Client-side project filter over the already-fetched subtask list. Keeps the
// Create-form project selector and the filter in sync (selecting a project in
// either narrows the table to it); "All projects" shows everything.
window.filterSubtasks = (pid) => {
  const all = window._subtasks || [];
  const shown = pid ? all.filter((s) => s.projectId === pid) : all;
  const body = $('stBody');
  if (body) body.innerHTML = shown.map(subtaskCard).join('') || '<p class="muted">No tasks for this project.</p>';
  const cnt = $('stCount'); if (cnt) cnt.textContent = `${shown.length} of ${all.length} tasks`;
  const f = $('stFilter'); if (f && f.value !== (pid || '')) f.value = pid || '';
  if (pid) { const cp = $('stProj'); if (cp && cp.value !== pid) cp.value = pid; }
};
window.deleteSubtask = async (id, name) => {
  let info = { hours: 0, people: 0, entries: 0 };
  try { info = await api('/subtasks/' + id + '/usage'); } catch (e) {}
  const msg = info.entries > 0
    ? `"${name}" has ${dur(info.hours)} logged across ${info.people} ${info.people === 1 ? 'person' : 'people'}.\n\nDeleting hides it from all pickers, but existing time entries stay intact and remain visible in reports and the audit log.\n\nDelete this task?`
    : `Delete task "${name}"?`;
  if (!confirm(msg)) return;
  try { await api('/subtasks/' + id, { method: 'DELETE' }); toast('Task deleted'); renderSubtasks(); loadSubtaskMap(); loadProjectsList(); } catch (e) { toast(e.message); }
};
window.createSubtask = async () => { try { const p = { projectId: $('stProj').value, name: $('stName').value, estimatedHours: Number($('stEst').value) }; if ($('stDeadline').value) p.deadline = new Date($('stDeadline').value).toISOString(); await api('/subtasks', { method: 'POST', body: JSON.stringify(p) }); toast('Task created'); renderSubtasks(); } catch (e) { toast(e.message); } };
window.setProjectLead = async (pid) => { const v = $('pl_' + pid).value; try { await api('/projects/' + pid + '/lead', { method: 'PUT', body: JSON.stringify({ teamLeadId: v || undefined }) }); toast('Project lead updated'); renderSubtasks(); loadInboxBadge(); } catch (e) { toast(e.message); } };

// ===========================================================================
// PM — Approvals (timesheet queue + edit requests)
// ===========================================================================
async function renderApprovals() {
  renderPage('Approvals', `<div id="ag"><p class="muted">Loading…</p></div>`);
  try {
    const [pending, edits] = await Promise.all([api('/approvals/pending'), api('/edit-requests/pending')]);
    // Counts feed the sidebar switcher (totals + per-employee-type); refresh it
    // now that we know them.
    const roleCounts = {};
    pending.forEach((a) => { const r = a.user && a.user.role; if (r) roleCounts[r] = (roleCounts[r] || 0) + 1; });
    window._apCounts = { pending: pending.length, edits: edits.length };
    window._apRoleCounts = roleCounts;
    // Name lookup so a clicked row can label the "Reviewing" selector without
    // threading the (possibly apostrophe-bearing) name through an inline handler.
    window._pendingNames = {};
    pending.forEach((a) => { if (a.user) window._pendingNames[a.userId] = a.user.name; });
    const sc = $('sidebarContext'); if (sc && activeNav === 'approvals') renderApprovalsContext(sc);

    // Only the section selected in the sidebar renders.
    let h;
    if (approvalsTab === 'edits') {
      h = `<div class="card card-sticky-head"><div class="page-title-row"><h3>Edit requests</h3><span class="muted">${edits.length} pending</span></div><table class="data-table"><thead><tr><th>Requester</th><th>Change</th><th>Reason</th><th></th></tr></thead><tbody>`;
      h += edits.map((r) => { const o = r.oldValue || {}, p = r.proposedValue || {}; return `<tr><td><span class="status-dot submitted"></span> ${esc(r.requestedBy.name)}</td><td class="num">${durClock(o.hours)} → <b>${durClock(p.hours)}</b></td><td>${esc(r.reason)}</td><td class="num"><button class="btn btn-primary btn-sm" onclick="editApprove('${r.id}')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="editDeny('${r.id}')">Deny</button></td></tr>`; }).join('') || '<tr><td colspan="4" class="muted">No edit requests.</td></tr>';
    } else {
      const shown = approvalsRole ? pending.filter((a) => a.user && a.user.role === approvalsRole) : pending;
      const roleLabel = (APPROVAL_ROLES.find((r) => r[0] === approvalsRole) || ['', 'All'])[1];
      const countLabel = approvalsRole ? `${shown.length} of ${pending.length} pending · ${roleLabel}` : `${pending.length} pending`;
      // Horizontal segmented bar, same pattern as the admin Users role filter —
      // was a sidebar list; moved here because it filters this table, not the
      // Timesheets/Edit requests queue switcher it used to sit beside.
      const roleBar = `<div class="segmented" style="margin-bottom:12px;flex-wrap:wrap">${APPROVAL_ROLES.map(([r, label]) => {
        const n = r === '' ? pending.length : (roleCounts[r] || 0);
        return `<button class="seg${approvalsRole === r ? ' active' : ''}" onclick="setApprovalsRole('${r}')">${label}${n ? ` <span class="muted">${n}</span>` : ''}</button>`;
      }).join('')}</div>`;
      h = `<div class="card card-sticky-head"><div class="page-title-row"><h3>Timesheets awaiting approval</h3><span class="muted">${countLabel}</span></div>${roleBar}<table class="data-table"><thead><tr><th>Employee</th><th>Week</th><th></th></tr></thead><tbody>`;
      h += shown.map((a) => `<tr style="cursor:pointer" title="Open ${esc(a.user.name)}'s timesheet for this week" onclick="reviewOpen('${a.userId}','${a.weekStartDate.slice(0, 10)}')"><td><span class="status-dot submitted"></span> ${esc(a.user.name)}${a.user.role ? ` <span class="muted" style="font-size:12px">· ${esc(a.user.role.replace('_', ' ').toLowerCase())}</span>` : ''}</td><td class="num">${a.weekStartDate.slice(0, 10)}</td><td class="num"><button class="btn btn-primary btn-sm" onclick="event.stopPropagation();reviewApprove('${a.userId}','${a.weekStartDate.slice(0, 10)}')">Approve</button> <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();reviewRevert('${a.userId}','${a.weekStartDate.slice(0, 10)}')">Reject</button></td></tr>`).join('')
        || `<tr><td colspan="3" class="muted">${approvalsRole ? 'No pending timesheets for ' + esc(roleLabel) + '.' : 'Nothing pending.'}</td></tr>`;
    }
    $('ag').innerHTML = h + '</tbody></table></div>';
  } catch (e) { $('ag').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
// Clicking an approval row opens that person's timesheet in the Timesheet view for
// that week — same deep-link the Inbox uses (see notifOpen). Action buttons
// stopPropagation so they never trigger this.
window.reviewOpen = (userId, weekStart) => {
  if (userId === user.id) { reviewingUserId = ''; reviewingUserName = ''; }
  else { reviewingUserId = userId; reviewingUserName = (window._pendingNames && window._pendingNames[userId]) || 'Selected user'; }
  currentWeek = mondayOf(new Date(weekStart + 'T00:00:00'));
  setActiveNav('table');
  renderTable();
  loadInboxBadge();
};
window.reviewApprove = async (userId, weekStart) => { try { await api('/approvals/approve', { method: 'POST', body: JSON.stringify({ userId, weekStart }) }); toast('Approved'); renderApprovals(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.reviewRevert = async (userId, weekStart) => { try { await api('/approvals/revert', { method: 'POST', body: JSON.stringify({ userId, weekStart }) }); toast('Reverted'); renderApprovals(); } catch (e) { toast(e.message); } };
window.editApprove = async (id) => { try { await api('/edit-requests/' + id + '/approve', { method: 'POST' }); toast('Edit approved'); renderApprovals(); loadInboxBadge(); } catch (e) { toast(e.message); } };
window.editDeny = async (id) => { try { await api('/edit-requests/' + id + '/deny', { method: 'POST' }); toast('Edit denied'); renderApprovals(); } catch (e) { toast(e.message); } };

// ===========================================================================
// Team Lead — My team (assign members to own subtasks)
// ===========================================================================
async function renderTeam() {
  renderPage('My tasks', `<div id="tg"><p class="muted">Loading…</p></div>`);
  try {
    // Assignable members are scoped to the Lead's OWN team(s) — not every Team
    // Member in the system. A lead may own more than one Team, so this unions
    // active memberships across all of them (deduped). The backend enforces the
    // same rule independently; this just keeps the picker from offering choices
    // it would reject.
    const [subtasks, myTeams] = await Promise.all([api('/subtasks'), api('/teams')]);
    const byId = {};
    myTeams.forEach((t) => (t.memberships || []).forEach((m) => { byId[m.user.id] = m.user; }));
    const members = Object.values(byId);
    window._members = members;
    let h = '';
    if (!subtasks.length) h = '<p class="muted">You have no assigned tasks yet. A PM assigns you as team lead first.</p>';
    for (const s of subtasks) {
      let assigns = [];
      try { assigns = await api('/assignments?subtaskId=' + s.id); } catch (e) {}
      const active = assigns.filter((a) => !a.unassignedAt);
      const pills = active.map((a) => `<span class="pill">${esc(a.teamMember.name)}<span class="x" onclick="unassignMember('${s.id}','${a.teamMemberId}')">✕</span></span>`).join('') || '<span class="muted">no members</span>';
      h += `<div class="card"><div class="page-title-row"><h3>${esc(s.name)} <span class="muted">· ${esc(s.project ? s.project.name : '')}</span></h3>
        <button class="btn btn-primary btn-sm" onclick="openAssignMember('${s.id}','${esc(s.name).replace(/'/g, "")}')">Assign member</button></div>
        <div class="pill-list">${pills}</div></div>`;
    }
    $('tg').innerHTML = h;
  } catch (e) { $('tg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.openAssignMember = (subtaskId, name) => {
  const members = window._members || [];
  const body = members.length
    ? `<div class="field"><label>Team member</label><select id="amMember">${members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div>`
    : `<p class="meta">You have no team members yet. Add members to your team first.</p>`;
  const actions = members.length
    ? `<button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="assignMember('${subtaskId}')">Assign</button>`
    : `<button class="btn btn-ghost" onclick="closeModal()">Close</button>`;
  openModal(`<h3>Assign member</h3><p class="meta">${esc(name)}</p>${body}<div class="modal-actions">${actions}</div>`);
};
window.assignMember = async (subtaskId) => { try { await api('/assignments/team-members', { method: 'POST', body: JSON.stringify({ subtaskId, teamMemberId: $('amMember').value }) }); closeModal(); toast('Member assigned'); renderTeam(); } catch (e) { toast(e.message); } };
window.unassignMember = async (subtaskId, memberId) => { try { await api('/assignments/team-members?subtaskId=' + subtaskId + '&teamMemberId=' + memberId, { method: 'DELETE' }); toast('Removed'); renderTeam(); } catch (e) { toast(e.message); } };

// ===========================================================================
// Summary — personal lifetime activity log (Team Member + Team Lead).
// Read-only; own work only. Separate from a Lead's "Reviewing" team access.
// ===========================================================================
window.setHistoryRange = (r) => { historyRange = r; renderHistory(); };
// Custom range: both dates are optional server-side, but re-render only once the
// user has picked something so the view never flickers mid-edit.
window.applyHistoryCustom = () => {
  historyCustom = { start: ($('hcStart') || {}).value || '', end: ($('hcEnd') || {}).value || '' };
  renderHistory();
};
// Steps a project-panel strip one panel at a time. Measures the live panel
// rather than assuming a width, so it stays correct when the panel falls back
// to full-width on a narrow card. Native wheel/swipe scrolling and scroll-snap
// still work independently of these buttons.
window.hptScroll = (stripId, dir) => {
  const strip = $(stripId);
  if (!strip) return;
  const panel = strip.querySelector('.hpt-panel');
  const step = panel ? panel.getBoundingClientRect().width + 18 : strip.clientWidth;
  strip.scrollBy({ left: dir * step, behavior: 'smooth' });
};
// One mini bar chart per project in a horizontal scroll strip, shared by My
// Progress ("Hours per task") and the Dashboard's team view. `projects` is
// normalised to [{ name, tasks: [{ name, hours }] }] by each caller, so this
// stays agnostic about which endpoint the numbers came from. Every distinct
// task gets its own color (see assignDistinctColors) so tasks stay tellable
// apart at a glance, not just by bar height. Every project passed in gets a
// panel — filtering to "has hours in range" happens server-side.
function projectPanelsCard(stripId, projects, title, sub, controls, pending) {
  const panels = projects.map((p) => {
    const c = barChart(
      p.tasks.map((s) => ({ label: s.name, segments: [{ value: s.hours, name: 'Hours' }] })),
      // width/height are the nominal canvas the SVG scales to fill. Kept close
      // to the panel's own proportions so the plot uses the card's height
      // instead of letterboxing inside it.
      { fmt: (v) => dur(v), empty: 'No hours logged', width: 520, height: 340 },
    );
    return `<div class="hpt-panel"><div class="hpt-name" title="${esc(p.name)}">${esc(p.name)}</div>${c}</div>`;
  }).join('');
  // Arrows mirror the week navigator's prev/next treatment; they only earn their
  // place once there's more than one panel to move between.
  const nav = projects.length > 1
    ? `<button class="btn btn-icon" title="Previous project" onclick="hptScroll('${stripId}',-1)">${icon('prev')}</button><button class="btn btn-icon" title="Next project" onclick="hptScroll('${stripId}',1)">${icon('next')}</button>`
    : '';
  // The range control (when passed) sits next to the title on the LEFT, not
  // grouped with the nav arrows on the right — those are pagination, this is
  // a filter, and the two shouldn't move together.
  const head = `<div class="hpt-head"><div class="title-range-group"><h3>${title}${sub ? ` <span class="muted" style="font-weight:400;font-size:12px">— ${sub}</span>` : ''}</h3>${controls || ''}</div><div class="row-flex">${nav}</div></div>`;
  const bodyHtml = projects.length
    ? `<div class="hpt-strip" id="${stripId}">${panels}</div>`
    : `<div class="chart-empty">${esc(noHoursMsg(pending || 0))}</div>`;
  return `<div class="card">${head}${bodyHtml}</div>`;
}
// Every hours visualisation shows APPROVED time only, so an empty chart is
// ambiguous: nothing logged, or nothing signed off yet? Say which.
function noHoursMsg(pending) {
  return pending > 0 ? `No approved hours yet — ${dur(pending)} awaiting approval` : 'No hours logged';
}
async function renderHistory() {
  const picker = historyRange === 'custom'
    ? `<label class="row-flex muted">From <input type="date" id="hcStart" value="${esc(historyCustom.start)}" onchange="applyHistoryCustom()" style="max-width:150px"></label>
       <label class="row-flex muted">To <input type="date" id="hcEnd" value="${esc(historyCustom.end)}" onchange="applyHistoryCustom()" style="max-width:150px"></label>`
    : '';
  const rangeCtl = `<label class="row-flex muted">Range: <select onchange="setHistoryRange(this.value)" style="max-width:160px">${ACTIVITY_RANGES.map(([v, l]) => `<option value="${v}" ${historyRange === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${picker}`;
  // Sits left, directly under the "Summary" title, rather than in the page
  // header's top-right corner (same reasoning as the chart-card headers: a
  // filter belongs next to what it filters, not pushed to the far edge).
  renderPage('Summary', `<div class="row-flex" style="margin-bottom:16px">${rangeCtl}</div><div id="hg"><p class="muted">Loading…</p></div>`);
  try {
    let q = '/time-entries/history?range=' + historyRange;
    if (historyRange === 'custom') {
      if (historyCustom.start) q += '&start_date=' + historyCustom.start;
      if (historyCustom.end) q += '&end_date=' + historyCustom.end;
    }
    const data = await api(q);
    const projects = data.projects || [];
    // Every figure below is APPROVED hours; `pendingHours` is what this user has
    // logged in the range that a reviewer hasn't signed off yet.
    const pending = data.pendingHours || 0;
    if (!projects.length) { $('hg').innerHTML = `<div class="card"><p class="muted">${esc(noHoursMsg(pending))}.</p></div>`; return; }

    const grandTotal = projects.reduce((s, p) => s + p.totalHours, 0);
    // Hours per task, split one mini chart per project rather than one chart
    // mixing every project's tasks together — the project name no longer has to
    // ride along in each bar label. Panels sit in a horizontal scroll strip so
    // the card keeps its existing footprint however many projects there are.
    // `projects` is already range-filtered server-side (only projects with hours
    // logged in the selected range come back), so no project yields an empty panel.
    // Bars stay per-task at the same granularity as the grouped table below, and
    // keep the highlight-the-largest treatment — subtasks arrive sorted desc.
    // "Awaiting approval" replaces the old per-row "Xh approved · Yh pending"
    // split: one place to see unapproved time, and every other number on the
    // page means approved.
    let h = `<div class="stat-row"><div class="stat"><div class="stat-ico tone-blue">${icon('clock')}</div><div class="label">Approved hours</div><div class="value">${dur(grandTotal)}</div></div>
      <div class="stat"><div class="stat-ico tone-violet">${icon('folder')}</div><div class="label">Projects</div><div class="value">${projects.length}</div></div>
      <div class="stat"><div class="stat-ico tone-amber">${icon('inbox')}</div><div class="label">Awaiting approval</div><div class="value">${dur(pending)}</div></div></div>`;
    h += projectPanelsCard('hptStrip', projects.map((p) => ({
      name: p.projectName,
      tasks: p.subtasks.map((s) => ({ name: s.name, hours: s.totalHours })),
    })), 'Hours per task', 'approved hours', '', pending);

    // Grouped Project → Subtask breakdown (the priority view).
    h += `<div class="card"><h3>Activity by project <span class="muted" style="font-weight:400;font-size:12px">— approved hours</span></h3><table class="data-table"><thead><tr><th>Project / task</th><th class="num">${unitLabel()}</th></tr></thead><tbody>`;
    projects.forEach((p) => {
      h += `<tr class="row-project"><td class="left"><b>${esc(p.projectName)}</b></td><td class="num"><b>${dur(p.totalHours)}</b></td></tr>`;
      p.subtasks.forEach((s) => {
        h += `<tr><td class="left" style="padding-left:26px">${esc(s.name)}</td><td class="num">${dur(s.totalHours)}</td></tr>`;
      });
    });
    h += `</tbody></table></div>`;
    $('hg').innerHTML = h;
  } catch (e) { $('hg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}

// ===========================================================================
// Dashboards (role-specific)
// ===========================================================================
function bar(v, max, cls) { const pct = max > 0 ? Math.min(100, (v / max) * 100) : 0; return `<div class="bar-track"><div class="bar-fill ${cls || ''}" style="width:${pct}%"></div></div>`; }
// ===========================================================================
// Charts — hand-rolled inline SVG (no library). Fills reference CSS custom
// properties, so charts re-theme automatically on light/dark toggle. Each
// renderer returns an HTML string; empty data yields an inline empty state.
// ===========================================================================
// Every chart colour in the app comes from one identity ramp (lime → forest →
// charcoal → black), defined as --chart-* in the stylesheet. Two consumers:
//   catColor(i)            — a fixed, small set of SERIES (e.g. "Est." vs
//                            "Logged"), where each series must hold one colour
//                            across every group or the legend stops meaning
//                            anything. Entries are ordered from opposite ends
//                            of the ramp so two series read apart.
//   assignDistinctColors() — data-driven categories (task/member/role names),
//                            sampled along the ramp for however many there are.
const CAT_COLORS = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-6)', 'var(--chart-2)', 'var(--chart-4)'];
const catColor = (i) => CAT_COLORS[i % CAT_COLORS.length];
/* Project-differentiation palette: lime, black, forest green, charcoal —
   alternating green/neutral so adjacent slots always differ in family. Each
   entry pairs the project's own colour with the far end of its subtask ramp;
   the CSS side documents why the ramp direction differs per slot. Kept as
   var() references (not baked hex) so the chart re-themes on light/dark
   toggle without needing a re-render. */
const PROJECT_COLORS = ['var(--proj-1)', 'var(--proj-2)', 'var(--proj-3)', 'var(--proj-4)'];
const PROJECT_TINTS = ['var(--proj-1-hi)', 'var(--proj-2-hi)', 'var(--proj-3-hi)', 'var(--proj-4-hi)'];
/** Most tasks a project can have before its shades would be too close to tell
 *  apart. Past this the range is re-walked rather than sliced finer: two
 *  distant tasks sharing a tone is a smaller problem than six tones nobody can
 *  distinguish, and position + label still separate them. */
const SHADE_STEPS = 6;
/**
 * A task's colour is its PROJECT's colour, lightened — same hue, same family,
 * only the tint moves. That is what makes a project's tasks read as one group
 * at a glance; drawing them from a general palette (as an earlier pass did)
 * scattered a project's own work across unrelated colours.
 *
 * The walk starts at 0.28, never 0, so the lightest-toned task is still clearly
 * lighter than the project arc sitting directly inside it — at 0 a task would
 * be indistinguishable from its own parent ring. A lone task gets a tint for
 * the same reason rather than the bare base colour.
 */
function taskShade(fam, k, n) {
  const steps = Math.min(n, SHADE_STEPS);
  const j = steps <= 1 ? 0.6 : (k % steps) / (steps - 1);
  const t = 0.28 + j * 0.72;
  return `color-mix(in srgb, ${fam.tint} ${Math.round(t * 100)}%, ${fam.base})`;
}
/** 32-bit avalanche mix — plain string hashes leave the low bits (what
 *  `% palette length` reads) badly clustered for short, similar ids. */
function hashKey(key) {
  let h = 5381;
  const s = String(key || '');
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
/**
 * Stable colour per project: the id hashes to a preferred palette slot, so a
 * project keeps the same colour across renders, range switches and reorderings
 * rather than being assigned by list position. If two projects in the SAME
 * chart hash to one slot, the later one probes forward to the next free slot —
 * telling them apart is the entire point of the chart, so a collision there
 * can't be allowed to stand. Collisions are resolved in a canonical (sorted)
 * order, NOT arrival order: sorting the same projects differently must not
 * repaint them, and probing in arrival order did exactly that.
 *
 * Trade-off worth knowing: a project that LOST a collision can reclaim its
 * preferred colour if the rival later drops out of the set (a range filter,
 * say). Guaranteed-distinct and stable-across-every-possible-subset can't
 * both hold with a fixed palette, and for this chart distinctness wins —
 * two identically-coloured project rings would defeat its whole purpose.
 * Uncontested projects (the common case) never move. With more projects than
 * palette slots reuse is unavoidable; the nesting and grouped legend still
 * carry the meaning.
 */
function assignProjectColors(keys) {
  const uniq = [...new Set((keys || []).map((k) => String(k)))];
  const colorOf = {}, taken = new Set();
  [...uniq].sort().forEach((k) => {
    let idx = hashKey(k) % PROJECT_COLORS.length, tries = 0;
    while (taken.has(idx) && tries < PROJECT_COLORS.length) { idx = (idx + 1) % PROJECT_COLORS.length; tries++; }
    taken.add(idx);
    colorOf[k] = { base: PROJECT_COLORS[idx], tint: PROJECT_TINTS[idx] };
  });
  return colorOf;
}
const CHART_RAMP = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
/** Colour at position t (0…1) along the ordinal ramp, as a CSS expression that
 *  still resolves through the theme's own custom properties — so the chart
 *  re-themes on light/dark toggle without being re-rendered. */
function rampColor(t) {
  const last = CHART_RAMP.length - 1;
  const pos = Math.max(0, Math.min(1, t)) * last;
  const k = Math.min(Math.floor(pos), last - 1);
  const f = pos - k;
  if (f <= 0.001) return CHART_RAMP[k];
  if (f >= 0.999) return CHART_RAMP[k + 1];
  return `color-mix(in srgb, ${CHART_RAMP[k + 1]} ${Math.round(f * 100)}%, ${CHART_RAMP[k]})`;
}
/**
 * One colour per distinct label, all drawn from the app's own lime → forest →
 * charcoal → black ramp so every chart matches the product's identity instead
 * of a generic rainbow.
 *
 * The samples are INTERLEAVED (take from the bright end, then the middle, then
 * back) rather than walked in ramp order. Walking in order puts neighbouring
 * items on neighbouring shades, which for a monochromatic ramp means they look
 * nearly identical — measured 1.11:1 between neighbours at 10 items, versus
 * 2.25:1 interleaved. Same colours, just dealt out so adjacent ones separate.
 *
 * Identical labels still share a colour (they're one label seen twice, not two
 * labels). With many categories a single-family ramp can't keep every possible
 * PAIR far apart — that's inherent to the palette — but neighbours stay
 * separated, and every bar and legend row is labelled regardless.
 */
function assignDistinctColors(labels) {
  const uniq = [];
  const seen = new Set();
  for (const label of labels) {
    const key = String(label);
    if (!seen.has(key)) { seen.add(key); uniq.push(key); }
  }
  const n = uniq.length;
  const colorOf = {};
  if (!n) return colorOf;
  if (n === 1) { colorOf[uniq[0]] = CHART_RAMP[0]; return colorOf; }
  const ordered = Array.from({ length: n }, (_, i) => rampColor(i / (n - 1)));
  let lo = 0, hi = Math.ceil(n / 2);
  uniq.forEach((label, i) => { colorOf[label] = ordered[i % 2 === 0 ? lo++ : hi++]; });
  return colorOf;
}
const chartEmpty = (msg) => `<div class="chart-empty">${esc(msg || 'No data for this period')}</div>`;

// ===========================================================================
// Shared list/table module
// ---------------------------------------------------------------------------
// One renderer for every tabular list in the app. Screens supply column defs +
// row data + optional per-row actions; this builds the DOM and owns the styling
// and hover interaction. Restyling all lists (e.g. to the "Dock" aesthetic) is
// a change to THIS function + the `.list-mod` CSS only — no screen touches its
// own markup. Returns an HTML string (embed like any other markup).
//
//   opts.columns : [{ label, align?, width?, mono?, cell? , hoverOnly? }]
//       label     header text ('' for an actions/blank column)
//       align     'left' | 'right' | 'center'   (default 'left')
//       width     CSS grid track (e.g. '110px', 'max-content'); default 1fr
//       mono      render this cell in the monospace/number style
//       cell      (row, i) => HTML  (defaults to '')
//       hoverOnly reveal this cell only on row hover (dock-style tooltip/actions)
//   opts.rows     : any[]
//   opts.rowAttrs : (row, i) => string  extra attributes on the row wrapper
//                   (e.g. `onclick="..."` or `data-id="..."` — this is how each
//                   screen keeps its existing click/action wiring)
//   opts.empty    : message when there are no rows
//   opts.className: extra class on the container
//
// INTEGRATION SEAM: when the real Dock component arrives, its row markup /
// interaction replaces the body of this function (and `.list-mod` CSS); every
// screen updates automatically because they all route through here.
function listModule(opts) {
  opts = opts || {};
  const cols = opts.columns || [];
  const rows = opts.rows || [];
  const alignCls = (a) => (a === 'right' ? ' ta-r' : a === 'center' ? ' ta-c' : '');
  const cellCls = (c) => alignCls(c.align) + (c.mono ? ' mono' : '') + (c.hoverOnly ? ' list-hover-only' : '');
  const template = cols.map((c) => c.width || 'minmax(0,1fr)').join(' ');
  const head = `<div class="list-head">${cols.map((c) => `<div class="list-h${alignCls(c.align)}">${esc(c.label || '')}</div>`).join('')}</div>`;
  if (!rows.length) {
    return `<div class="list-mod ${opts.className || ''}" style="--list-cols:${template}">${head}<div class="list-empty">${esc(opts.empty || 'Nothing to show.')}</div></div>`;
  }
  const body = rows
    .map((row, i) => {
      const cells = cols.map((c) => `<div class="list-c${cellCls(c)}">${c.cell ? c.cell(row, i) : ''}</div>`).join('');
      const attrs = opts.rowAttrs ? opts.rowAttrs(row, i) || '' : '';
      return `<div class="list-row" ${attrs}>${cells}</div>`;
    })
    .join('');
  return `<div class="list-mod ${opts.className || ''}" style="--list-cols:${template}">${head}<div class="list-body">${body}</div></div>`;
}
window.chartTip = (evt, text) => {
  let t = document.getElementById('chartTip');
  if (!t) { t = document.createElement('div'); t.id = 'chartTip'; t.className = 'chart-tip'; document.body.appendChild(t); }
  t.textContent = text; t.style.display = 'block';
  t.style.left = (evt.clientX + 12) + 'px'; t.style.top = (evt.clientY + 14) + 'px';
};
window.chartTipHide = () => { const t = document.getElementById('chartTip'); if (t) t.style.display = 'none'; };

// Grouped/single-series bar chart.
// data: [{ label, segments: [{ value, color?, name? }] }]  (single series → one segment)
// opts: { height, fmt, legend, empty }
/**
 * Greedy word-wrap for an SVG axis label. Returns at most `maxLines` lines of
 * roughly `width` characters; only the final line is ever ellipsised, so a
 * two-word name reads in full instead of being cut to "QA & harden…".
 */
function wrapLabel(text, width, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const next = cur ? cur + ' ' + words[i] : words[i];
    if (next.length <= width) { cur = next; continue; }
    if (cur) {
      lines.push(cur);
      cur = '';
      if (lines.length === maxLines) break; // words[i] onward don't fit
    }
    cur = words[i];
  }
  if (cur && lines.length < maxLines) { lines.push(cur); cur = ''; }
  // Anything left over — unplaced words, or a tail that had no line to go on —
  // must be signalled, never dropped in silence.
  const truncated = i < words.length || cur !== '';
  return lines.map((l, li) => {
    if (l.length > width + 2) return l.slice(0, width + 1) + '…'; // one huge word
    return truncated && li === lines.length - 1 ? l + '…' : l;
  });
}
function barChart(data, opts) {
  opts = opts || {};
  const fmt = opts.fmt || ((v) => String(v));
  if (!data || !data.length || data.every((g) => g.segments.every((s) => !Number(s.value)))) return chartEmpty(opts.empty);
  const H = opts.height || 300, padB = 52, padT = 22, padL = 60, padR = 14;
  const plotH = H - padB - padT;
  const maxSeg = Math.max(...data.map((g) => g.segments.length));
  const groups = data.length;

  // Bar width is derived FROM the available width, not the other way round.
  // Previously groupW was fixed, so W grew with the bar count and a one-bar
  // chart was capped at ~140px — a sliver in the corner of a 540px panel.
  // Now the drawing area is a nominal canvas the SVG scales to fill, and the
  // bars divide it up: fewer bars → wider bars, clamped at both ends so a lone
  // bar isn't absurd and a crowded chart stays legible.
  const SEG_GAP = 6, MIN_SEG = 22, MAX_SEG = 96;
  const NOMINAL_W = opts.width || 640;
  const avail = NOMINAL_W - padL - padR;
  const slotW = avail / groups;                       // one group's share, gap included
  const rawGroupW = slotW * 0.72;                     // ~28% of each slot is breathing room
  let segW = (rawGroupW - SEG_GAP * (maxSeg - 1)) / maxSeg;
  segW = Math.max(MIN_SEG, Math.min(MAX_SEG, segW));
  const groupW = segW * maxSeg + SEG_GAP * (maxSeg - 1);
  // Floor of 24, not 16: the floor only binds when bars are already pinned at
  // MIN_SEG (the crowded, scrolling case), and there the gap is all the room
  // the axis labels get. At 16 adjacent labels cleared each other by 0.7px —
  // technically not overlapping, but one wider glyph or a different font and
  // they collide. Costs nothing when the chart fits, since slotW - groupW is
  // larger than the floor anyway.
  const gap = Math.max(24, Math.min(72, slotW - groupW));
  const used = groups * groupW + (groups - 1) * gap;
  // Fits: centre the cluster in the plot area. Doesn't fit (many bars pinned at
  // MIN_SEG): widen the canvas instead and let .chart-wrap scroll horizontally.
  const overflows = used > avail;
  const W = overflows ? padL + padR + used : NOMINAL_W;
  const originX = padL + Math.max(0, (avail - used) / 2);

  const maxVal = Math.max(1, ...data.flatMap((g) => g.segments.map((s) => Number(s.value) || 0)));
  // One segment per group means color identifies the TASK (each bar is its
  // own thing) — those get a distinct color per group, same as the pie chart,
  // so "Platform Modernization"'s 6 task bars don't all render as the one
  // identical accent-colored block. Multiple segments per group means color
  // identifies the SERIES instead (e.g. "Est." vs "Logged") — there, every
  // bar in a series must stay the SAME color across all groups, or the
  // legend stops meaning anything, so that case keeps catColor(si) untouched.
  const groupColors = maxSeg === 1 && opts.highlight == null ? assignDistinctColors(data.map((g) => g.label)) : null;
  // Gridlines and y-tick LABELS are built separately. When the chart scrolls,
  // the labels are lifted into their own non-scrolling SVG pinned to the left
  // (see the return below) so the scale stays readable at any scroll offset;
  // the gridlines have to stay with the plot, since they must line up with the
  // bars they measure.
  const ticks = 4, y = (v) => padT + plotH - (v / maxVal) * plotH;
  let g = '', axisY = '';
  for (let i = 0; i <= ticks; i++) {
    const v = (maxVal / ticks) * i, yy = y(v);
    g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`;
    axisY += `<text x="${padL - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end" class="chart-axis">${esc(fmt(Math.round(v)))}</text>`;
  }
  data.forEach((grp, gi) => {
    const gx = originX + gi * (groupW + gap);
    const totalW = grp.segments.length * segW + (grp.segments.length - 1) * SEG_GAP;
    const startX = gx + (groupW - totalW) / 2;
    grp.segments.forEach((s, si) => {
      const val = Number(s.value) || 0, bx = startX + si * (segW + SEG_GAP), by = y(val), bh = padT + plotH - by;
      // opts.highlight: render every bar muted except that group index, which
      // takes a solid accent fill (the reference's "Weekly Progress" treatment).
      const color = opts.highlight != null
        ? (gi === opts.highlight ? (opts.highlightColor || 'var(--accent)') : 'var(--bg3)')
        : (s.color || (groupColors ? groupColors[String(grp.label)] : catColor(si)));
      const tip = (s.name ? s.name + ' · ' : '') + grp.label + ': ' + fmt(val);
      g += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${segW}" height="${Math.max(bh, 0).toFixed(1)}" rx="4" fill="${color}" onmousemove="chartTip(event,'${esc(tip)}')" onmouseleave="chartTipHide()"><title>${esc(tip)}</title></rect>`;
      if (bh > 14) g += `<text x="${(bx + segW / 2).toFixed(1)}" y="${(by - 5).toFixed(1)}" text-anchor="middle" class="chart-val">${esc(fmt(val))}</text>`;
    });
    // Labels wrap onto a second line rather than truncating, so names like
    // "QA & hardening" and "General / project" stay readable in full.
    const lblCls = 'chart-axis' + (opts.highlight === gi ? ' is-current' : '');
    // Wider bars can carry more characters per line — ~7px per glyph at 12.5px.
    const lines = wrapLabel(grp.label, Math.max(9, Math.round((groupW + gap * 0.6) / 7)), 2);
    const cxL = (gx + groupW / 2).toFixed(1);
    lines.forEach((ln, li) => {
      g += `<text x="${cxL}" y="${H - padB + 18 + li * 13}" text-anchor="middle" class="${lblCls}">${esc(ln)}</text>`;
    });
    g += `<title>${esc(grp.label)}</title>`;
  });
  let legend = '';
  if (opts.legend && data[0] && data[0].segments.length > 1) {
    legend = `<div class="chart-legend">${data[0].segments.map((s, si) => `<span class="leg"><span class="sw" style="background:${s.color || catColor(si)}"></span>${esc(s.name || '')}</span>`).join('')}</div>`;
  }
  /* Two layouts, and the distinction matters:
   *
   *   FITS — one SVG, no explicit size, scaling to fill its card. The old cap
   *          at the computed px width is what stranded a small chart in a
   *          large panel.
   *
   *   OVERFLOWS — a pinned y-axis beside a horizontally scrolling plot.
   *
   * In the overflow case the plot is pinned to its natural pixel size so the
   * pane actually scrolls; left to scale, an SVG whose viewBox is wider than
   * its box shrinks to fit the width instead, which is what crushed 40 bars
   * into slivers with their labels overlapping. Sizing it at exactly its
   * viewBox dimensions also makes box aspect equal viewBox aspect, so `meet`
   * has nothing to letterbox.
   *
   * The plot's viewBox starts at x=padL rather than 0, which crops off the
   * left gutter WITHOUT touching a single coordinate in the drawing code —
   * the y-tick labels that lived there are drawn by the separate axis SVG
   * instead, which never scrolls. The x-axis labels deliberately stay inside
   * the scroller: each one names the bar above it, so pinning them would peel
   * every label away from the thing it labels.
   *
   * The legend sits outside the scroll pane in both cases, so it stays on
   * screen instead of being parked off the right-hand end of a 3000px plot.
   * In the scrolling case it goes ABOVE the plot rather than below: this chart
   * is sized to fill the viewport, so its bottom edge is at or past the fold,
   * and a legend under it lands behind the horizontal scrollbar or off-screen
   * entirely. Above the plot it sits directly under the card title, where it
   * is read before the bars rather than hunted for afterwards.
   */
  if (!overflows) {
    return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart-svg" style="min-width:${Math.min(W, 320)}px" preserveAspectRatio="xMidYMid meet" role="img">${axisY}${g}</svg>${legend}</div>`;
  }
  const topLegend = legend ? legend.replace('class="chart-legend"', 'class="chart-legend is-top"') : '';
  return `<div class="chart-wrap is-scroll">${topLegend}
    <div class="chart-scroll-frame">
      <svg class="chart-axis-y" width="${padL}" height="${H}" viewBox="0 0 ${padL} ${H}" aria-hidden="true">${axisY}</svg>
      <div class="chart-scroll-pane">
        <svg viewBox="${padL} 0 ${W - padL} ${H}" class="chart-svg" style="width:${W - padL}px;height:${H}px" preserveAspectRatio="xMidYMid meet" role="img">${g}</svg>
      </div>
    </div></div>`;
}

// Donut/pie chart. data: [{ label, value, color? }]. opts: { fmt, empty }
// Interactive donut: a shared `hoveredIndex` links slices ↔ legend ↔ center
// label (the React Bits "Navigation/PieChart" pattern, done in vanilla JS).
let _pieSeq = 0;
const PIE_REG = {};
function pieChart(data, opts) {
  opts = opts || {};
  const fmt = opts.fmt || ((v) => String(v));
  const items = (data || []).filter((d) => Number(d.value) > 0);
  // Re-summing already-rounded slice values reintroduces float drift, which is
  // what put "422.78000000000003h" in the donut centre. Round the total here so
  // it is correct regardless of what `fmt` a caller passes in.
  const total = Math.round(items.reduce((s, d) => s + Number(d.value), 0) * 100) / 100;
  if (!total) return chartEmpty(opts.empty);
  const size = 180, r = 82, inner = 55, cx = size / 2, cy = size / 2;
  const id = 'pie' + _pieSeq++;
  const pcts = items.map((d) => Math.round(Number(d.value) / total * 100));
  // Computed once, over the whole item list, so: (a) the slice and its legend
  // row can never disagree, (b) two items sharing a label (e.g. "UI build" on
  // two different projects) resolve to the exact same color, and (c) two
  // DIFFERENT labels don't quietly collide onto the same color either — see
  // assignDistinctColors.
  const distinctColors = assignDistinctColors(items.map((d) => d.label));
  const colors = items.map((d) => d.color || distinctColors[String(d.label)]);
  const hov = (i) => `onmouseenter="pieHover('${id}',${i})" onmouseleave="pieHover('${id}',-1)"`;
  let svg = '';
  if (items.length === 1) {
    const d = items[0], color = colors[0], tip = d.label + ': ' + fmt(d.value) + ' (100%)';
    svg = `<circle class="pie-slice" data-i="0" cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${color}" stroke-width="${r - inner}" ${hov(0)}><title>${esc(tip)}</title></circle>`;
  } else {
    let a0 = -Math.PI / 2;
    items.forEach((d, i) => {
      const frac = Number(d.value) / total, a1 = a0 + frac * Math.PI * 2, color = colors[i], large = frac > 0.5 ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const xi1 = cx + inner * Math.cos(a1), yi1 = cy + inner * Math.sin(a1), xi0 = cx + inner * Math.cos(a0), yi0 = cy + inner * Math.sin(a0);
      const tip = d.label + ': ' + fmt(d.value) + ' (' + pcts[i] + '%)';
      svg += `<path class="pie-slice" data-i="${i}" d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} L${xi1.toFixed(1)} ${yi1.toFixed(1)} A${inner} ${inner} 0 ${large} 0 ${xi0.toFixed(1)} ${yi0.toFixed(1)} Z" fill="${color}" stroke="var(--bg1)" stroke-width="2" ${hov(i)}><title>${esc(tip)}</title></path>`;
      a0 = a1;
    });
  }
  const centerLabel = opts.center || 'Total';
  const totalText = fmt(total);
  PIE_REG[id] = { items, fmt, pcts, centerLabel, totalText };
  const center = `<div class="pie-center"><div class="pie-center-val">${esc(totalText)}</div><div class="pie-center-lab">${esc(centerLabel)}</div></div>`;
  const legend = `<div class="chart-legend col">${items.map((d, i) => `<span class="leg" data-i="${i}" ${hov(i)}><span class="sw" style="background:${colors[i]}"></span>${esc(d.label)} <span class="muted">${esc(fmt(d.value))} · ${pcts[i]}%</span></span>`).join('')}</div>`;
  return `<div class="chart-wrap pie" id="${id}"><div class="pie-donut"><svg viewBox="0 0 ${size} ${size}" class="chart-svg pie-svg" role="img">${svg}</svg>${center}</div>${legend}</div>`;
}

// Shared hover state: i = slice index, or -1 to reset. Updates slices, legend
// and the center label together.
window.pieHover = function (id, i) {
  const reg = PIE_REG[id], root = document.getElementById(id);
  if (!reg || !root) return;
  root.querySelectorAll('.pie-slice, .leg').forEach((el) => {
    const idx = Number(el.dataset.i);
    el.classList.toggle('is-active', idx === i);
    el.classList.toggle('is-dim', i !== -1 && idx !== i);
  });
  const valEl = root.querySelector('.pie-center-val'), labEl = root.querySelector('.pie-center-lab');
  if (i === -1) { valEl.textContent = reg.totalText; labEl.textContent = reg.centerLabel; }
  else { valEl.textContent = reg.fmt(reg.items[i].value); labEl.textContent = reg.items[i].label + ' · ' + reg.pcts[i] + '%'; }
};

// ---- Sunburst: outer ring = projects, inner ring = their subtasks ---------
/**
 * One ring segment. A sweep covering the whole circle can't be drawn as an arc
 * (start and end points coincide, so the path collapses to nothing) — that
 * case becomes a stroked circle of the same band width instead.
 */
function ringSegment(cx, cy, rO, rI, a0, a1) {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    return { tag: 'circle', attrs: `cx="${cx}" cy="${cy}" r="${((rO + rI) / 2).toFixed(2)}" fill="none" stroke-width="${(rO - rI).toFixed(2)}"` };
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  return {
    tag: 'path',
    attrs: `d="M${p(rO, a0)} A${rO} ${rO} 0 ${large} 1 ${p(rO, a1)} L${p(rI, a1)} A${rI} ${rI} 0 ${large} 0 ${p(rI, a0)} Z"`,
  };
}
let _sunSeq = 0;
const SUN_REG = {};
/**
 * Colour for every arc in the chart, keyed the same way it is drawn.
 *
 * One base colour per project (hashed from its id, so it survives re-renders,
 * range switches and resorts), and each of that project's tasks as a tint of
 * that same base — see taskShade. Read radially, a wedge is one hue getting
 * lighter as it moves outward, which is what makes "these tasks belong to this
 * project" visible before a single label is read.
 *
 * Task keys are project-scoped (`t:<projectKey>|<task>`) so two projects that
 * both contain a "UI build" get two entries in two different families rather
 * than colliding on one colour.
 */
function sunArcColors(projects) {
  const fams = assignProjectColors(projects.map((p) => p.key));
  const colorOf = {};
  projects.forEach((p) => {
    const fam = fams[String(p.key)];
    colorOf['p:' + p.key] = fam.base;
    p.tasks.forEach((t, i) => { colorOf['t:' + p.key + '|' + t.name] = taskShade(fam, i, p.tasks.length); });
  });
  return colorOf;
}
/**
 * Two concentric rings on one angular scale, root at the centre:
 *   inner = projects
 *   outer = their tasks
 *
 * Every child arc is laid out strictly inside its parent's angular span, so a
 * repeated name — two projects each having a "UI build" — is unambiguous from
 * position alone, before any colour or label is read. Colour is assigned per
 * ARC (see sunArcColors): every project and every task gets its own shade, so
 * no two segments anywhere in the chart share a colour.
 *
 * Children are laid out against their PARENT's total, not the grand total.
 * That guarantees a child band exactly fills its parent even when the numbers
 * disagree slightly (rounded member hours not summing to the task total) —
 * the nesting stays true rather than drifting out of alignment.
 *
 * data: [{ project, projectId?, tasks: [{ name, hours, members?: [{name, hours}] }] }]
 */
function sunburstChart(data, opts) {
  opts = opts || {};
  const fmt = opts.fmt || ((v) => String(v));
  const projects = (data || [])
    .map((p) => ({
      project: p.project,
      key: p.projectId || p.project,
      tasks: (p.tasks || [])
        .filter((t) => Number(t.hours) > 0)
        .map((t) => ({ ...t, members: (t.members || []).filter((m) => Number(m.hours) > 0) })),
    }))
    .filter((p) => p.tasks.length)
    .map((p) => ({ ...p, total: Math.round(p.tasks.reduce((s, t) => s + Number(t.hours), 0) * 100) / 100 }));
  const grand = Math.round(projects.reduce((s, p) => s + p.total, 0) * 100) / 100;
  if (!grand) return chartEmpty(opts.empty);

  const hasMembers = projects.some((p) => p.tasks.some((t) => t.members.length));
  const size = 320, cx = size / 2, cy = size / 2;
  // Two rings, root at the centre: projects inside, their tasks outside.
  // Members are NOT drawn — a third band of many thin slivers added visual
  // noise out of proportion to how often it's read. The per-member figures are
  // kept in the legend, so nothing is lost, just moved to where it's legible.
  const RINGS = [[108, 66], [150, 114]];   // projects (inner), tasks (outer)
  const id = 'sun' + _sunSeq++;
  const pct = (v) => Math.round((v / grand) * 100);

  let svg = '';
  const segs = [];
  // Each segment records its parent and children, which is what lets a
  // selection light up across BOTH rings: a task knows its project, a project
  // knows all its tasks. Without these links a highlight can only ever affect
  // the one arc that was clicked.
  const draw = (level, a0, a1, color, label, sub, value, parentIdx) => {
    const [rO, rI] = RINGS[level];
    const s = ringSegment(cx, cy, rO, rI, a0, a1);
    const i = segs.length;
    segs.push({ label, sub, value, pct: pct(value), color, level, parentIdx: parentIdx == null ? null : parentIdx, children: [] });
    if (parentIdx != null) segs[parentIdx].children.push(i);
    const hov = `onmouseenter="sunHover('${id}',${i})" onmouseleave="sunHover('${id}',-1)" onclick="sunSelect(event,'${id}',${i})"`;
    const tip = `${label}${sub ? ' · ' + sub : ''}: ${fmt(value)} (${pct(value)}%)`;
    const paint = s.tag === 'circle'
      ? `stroke="${color}"`
      : `fill="${color}" stroke="var(--bg1)" stroke-width="2" stroke-linejoin="round"`;
    svg += `<${s.tag} class="sun-seg sun-l${level}" data-i="${i}" ${s.attrs} ${paint} ${hov}><title>${esc(tip)}</title></${s.tag}>`;
    return i;
  };

  const arcColor = sunArcColors(projects);
  let a = -Math.PI / 2;
  projects.forEach((p) => {
    const pSpan = (p.total / grand) * Math.PI * 2;
    p.legendIdx = draw(0, a, a + pSpan, arcColor['p:' + p.key], p.project, '', p.total);

    let b = a;
    p.tasks.forEach((t) => {
      const tHours = Number(t.hours);
      const tSpan = (tHours / p.total) * pSpan;     // fills the parent exactly
      t.legendIdx = draw(1, b, b + tSpan, arcColor['t:' + p.key + '|' + t.name], t.name, p.project, tHours, p.legendIdx);
      // Members have no arc of their own now, so a legend row for one points at
      // its parent task's segment — hovering "Sam Member" still lights up the
      // slice his hours are part of, rather than highlighting nothing.
      t.members.forEach((m) => { m.legendIdx = t.legendIdx; });
      b += tSpan;
    });
    a += pSpan;
  });

  const centerLabel = opts.center || 'Total';
  const totalText = fmt(grand);
  SUN_REG[id] = { segs, fmt, centerLabel, totalText, hovered: null, selected: null };
  const center = `<div class="pie-center"><div class="pie-center-val">${esc(totalText)}</div><div class="pie-center-lab">${esc(centerLabel)}</div></div>`;

  // Legend carries the full hierarchy even though only two tiers are drawn:
  // project → its tasks → who logged them, each indented under its parent. A
  // duplicated task name stays unambiguous because it sits under its own
  // project's heading. Members get no swatch — there is no arc of that colour
  // to match, and a swatch would imply one.
  const row = (cls, idx, swatch, text, value) =>
    `<span class="leg ${cls}" data-i="${idx}" onmouseenter="sunHover('${id}',${idx})" onmouseleave="sunHover('${id}',-1)" onclick="sunSelect(event,'${id}',${idx})">${swatch ? `<span class="sw" style="background:${swatch}"></span>` : ''}${text} <span class="muted">${esc(fmt(value))} · ${pct(value)}%</span></span>`;
  const legend = `<div class="chart-legend col sun-legend">${projects.map((p) => `<div class="sun-group">
      ${row('leg-proj', p.legendIdx, segs[p.legendIdx].color, `<b>${esc(p.project)}</b>`, p.total)}
      ${p.tasks.map((t) => `${row('leg-task', t.legendIdx, segs[t.legendIdx].color, esc(t.name), Number(t.hours))}
        ${(hasMembers ? t.members : []).map((m) => row('leg-member', m.legendIdx, null, esc(m.name), Number(m.hours))).join('')}`).join('')}
    </div>`).join('')}</div>`;

  // Background click clears; segment clicks stopPropagation so they don't
  // immediately undo themselves on the way up.
  return `<div class="chart-wrap pie sunburst" id="${id}"><div class="pie-donut sun-donut"><svg viewBox="0 0 ${size} ${size}" class="chart-svg pie-svg" role="img" onclick="sunClear('${id}')">${svg}</svg>${center}</div>${legend}</div>`;
}
/**
 * The set of segments a focus lights up — the whole point of the two rings
 * being related rather than two independent charts:
 *   a task    → itself + the ONE project arc it sits inside (many-to-one)
 *   a project → itself + EVERY task arc belonging to it   (one-to-many)
 * Everything outside the set is dimmed, so exactly one relationship is on
 * screen at a time.
 */
function sunLinkedSet(reg, i) {
  if (i == null || i < 0 || !reg.segs[i]) return null;
  const s = reg.segs[i];
  const set = new Set([i]);
  if (s.parentIdx != null) set.add(s.parentIdx);
  (s.children || []).forEach((c) => set.add(c));
  return set;
}
/**
 * Single painter for both interactions, so hover and selection can never
 * disagree about what is highlighted. Hover wins while the pointer is over a
 * segment; on leave the view falls back to the persistent selection rather
 * than resetting to neutral, which is what makes a click feel "sticky".
 */
function sunPaint(id) {
  const reg = SUN_REG[id], root = document.getElementById(id);
  if (!reg || !root) return;
  const focus = reg.hovered != null ? reg.hovered : reg.selected;
  const set = sunLinkedSet(reg, focus);
  root.querySelectorAll('.sun-seg, .leg').forEach((el) => {
    const idx = Number(el.dataset.i);
    const on = set ? set.has(idx) : false;
    el.classList.toggle('is-active', on);
    el.classList.toggle('is-dim', !!set && !on);
    el.classList.toggle('is-selected', reg.selected != null && idx === reg.selected);
  });
  root.classList.toggle('has-selection', reg.selected != null);
  const valEl = root.querySelector('.pie-center-val'), labEl = root.querySelector('.pie-center-lab');
  if (!valEl || !labEl) return;
  if (focus == null) { valEl.textContent = reg.totalText; labEl.textContent = reg.centerLabel; }
  else {
    // A task names its project too ("Discovery · Platform Modernization"); a
    // project has no parent to name, so it reads as just its own total.
    const s = reg.segs[focus];
    valEl.textContent = reg.fmt(s.value);
    labEl.textContent = (s.sub ? s.label + ' · ' + s.sub : s.label) + ' · ' + s.pct + '%';
  }
}
window.sunHover = function (id, i) {
  const reg = SUN_REG[id];
  if (!reg) return;
  reg.hovered = (i == null || i < 0) ? null : i;
  sunPaint(id);
};
/** Click toggles: re-clicking the active segment clears it. */
window.sunSelect = function (evt, id, i) {
  if (evt && evt.stopPropagation) evt.stopPropagation();
  const reg = SUN_REG[id];
  if (!reg) return;
  reg.selected = reg.selected === i ? null : i;
  sunPaint(id);
};
/** Clicking the chart background (outside any arc) clears the selection. */
window.sunClear = function (id) {
  const reg = SUN_REG[id];
  if (!reg) return;
  reg.selected = null;
  sunPaint(id);
};

async function renderDashboard() {
  // is-dash lets the view become a flex column so #dg can absorb the leftover
  // height below the header + hero strip, rather than guessing their size.
  renderPage('Dashboard', `<div id="dashHero" class="dash-hero" hidden></div><div id="dg"><p class="muted">Loading…</p></div>`);
  view().classList.add('is-dash');
  try {
    // Each dashboard widget is built into `parts` under its component key; only
    // the one selected in the sidebar is written to the page. Data fetching is
    // unchanged (still one Promise.all per role), so switching is display-only.
    const parts = {};
    // Every card below shows APPROVED hours. This total lets an empty chart say
    // "nothing signed off yet" instead of implying nothing was worked on. Every
    // Dashboard card is now team- or company-scoped, so only `scope` is needed;
    // personal pending is surfaced on the Summary page instead.
    const pend = await api('/dashboards/pending-hours').catch(() => ({ mine: 0, scope: 0 }));
    const emptyScope = noHoursMsg(pend.scope);
    if (user.role === 'PM') {
      const [burn, status] = await Promise.all([api('/dashboards/pm/burndown'), api('/dashboards/pm/task-status')]);
      parts['status-overview'] = `<div class="card"><h3>Task status <span class="muted" style="font-weight:400;font-size:12px">— overview</span></h3><div class="stat-row">
        <div class="stat"><div class="stat-ico tone-gray">${icon('list')}</div><div class="label">Unassigned</div><div class="value">${status.counts.unassigned} <span class="muted" style="font-size:13px">(${status.percentages.unassigned}%)</span></div></div>
        <div class="stat"><div class="stat-ico tone-amber">${icon('inbox')}</div><div class="label">Pending</div><div class="value">${status.counts.pending}</div></div>
        <div class="stat"><div class="stat-ico tone-green">${icon('check')}</div><div class="label">Approved</div><div class="value accent">${status.counts.approved}</div></div></div></div>`;
      const statusPie = pieChart([
        { label: 'Unassigned', value: status.counts.unassigned, color: 'var(--status-draft)' },
        { label: 'Pending', value: status.counts.pending, color: 'var(--status-submitted)' },
        { label: 'Approved', value: status.counts.approved, color: 'var(--status-approved)' },
      ], { center: 'Tasks', empty: 'No tasks' });
      // Two series, so colour means SERIES here, not task: planned reads as the
      // muted charcoal end of the ramp, actual as the lime end.
      //
      // Height comes from the live viewport rather than the 300px default: with
      // one task per bar this is the densest chart in the app, and it is the
      // only thing on its own dashboard page, so it should use the screen. The
      // subtracted 300px covers the page header, the sticky status strip, card
      // padding and the legend. Measured here rather than in CSS because the
      // SVG's viewBox has to agree with the rendered box or `meet` letterboxes.
      const paH = Math.max(340, Math.round(window.innerHeight - 300));
      const planActual = barChart(burn.map((b) => ({ label: b.subtask, segments: [{ value: b.estimatedHours, name: 'Est.', color: 'var(--chart-5)' }, { value: b.hoursLogged, name: 'Logged', color: 'var(--chart-1)' }] })), { fmt: (v) => dur(v), legend: true, height: paH, empty: burn.length ? emptyScope : 'No tasks' });
      parts['status-breakdown'] = `<div class="card"><h3>Task status <span class="muted" style="font-weight:400;font-size:12px">— breakdown</span></h3>${statusPie}</div>`;
      parts['plan-actual'] = `<div class="card"><h3>Planned vs actual hours <span class="muted" style="font-weight:400;font-size:12px">— per task · approved hours</span></h3>${planActual}</div>`;
      let bd = `<div class="card"><h3>Burn-down <span class="muted" style="font-weight:400;font-size:12px">— approved hours</span></h3><table class="data-table"><thead><tr><th>Task</th><th>Project</th><th class="num">Est.</th><th class="num">Logged</th><th class="num">Remaining</th><th class="num">Days left</th></tr></thead><tbody>`;
      bd += burn.map((b) => `<tr><td>${esc(b.subtask)}</td><td>${esc(b.project)}</td><td class="num">${dur(b.estimatedHours)}</td><td class="num">${dur(b.hoursLogged)}</td><td class="num">${dur(b.remainingHours)}</td><td class="num">${b.daysToDeadline == null ? '—' : b.daysToDeadline}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No tasks.</td></tr>';
      parts['burndown'] = bd + '</tbody></table></div>';
    } else if (user.role === 'CEO') {
      const [overview, alloc] = await Promise.all([
        api('/analytics/ceo/overview?range=' + analyticsRange),
        api('/dashboards/ceo/resource-allocation'),
      ]);
      parts['overview'] = `<div class="card card-hero"><div class="page-title-row"><h3>Company overview</h3>
        <label class="row-flex muted">Period: <select onchange="setDashRange(this.value)" style="max-width:150px">
          ${['week', 'month', 'quarter'].map((r) => `<option value="${r}" ${analyticsRange === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></label></div>
        <div class="stat-row">
          <div class="stat"><div class="stat-ico tone-violet">${icon('folder')}</div><div class="label">Active projects</div><div class="value">${overview.total_active_projects}</div></div>
          <div class="stat"><div class="stat-ico tone-blue">${icon('clock')}</div><div class="label">Approved hours</div><div class="value accent">${num(overview.total_hours_this_period)}</div></div>
          <div class="stat"><div class="stat-ico tone-green">${icon('users')}</div><div class="label">Headcount</div><div class="value">${Object.values(overview.headcount_by_role).reduce((a, b) => a + b, 0)}</div></div>
        </div>
        <div class="row-flex muted" style="margin-top:4px">Headcount: ${Object.entries(overview.headcount_by_role).map(([r, n]) => `${r.replace('_', ' ').toLowerCase()} ${n}`).join(' · ') || '—'}</div></div>`;
      // Charts (built from the data already fetched above).
      const allocPie = pieChart(alloc.flatMap((c) => c.projects.map((p) => ({ label: p.project, value: p.hours }))), { fmt: (v) => dur(v), center: 'Total hours', empty: emptyScope });
      const headcountBars = barChart(Object.entries(overview.headcount_by_role).map(([r, n]) => ({ label: r.replace('_', ' ').toLowerCase(), segments: [{ value: n }] })), { empty: 'No headcount' });
      parts['alloc-chart'] = `<div class="card"><h3>Resource allocation <span class="muted" style="font-weight:400;font-size:12px">— chart · approved hours</span></h3>${allocPie}</div>`;
      parts['headcount'] = `<div class="card"><h3>Headcount by role</h3>${headcountBars}</div>`;
      const allocRows = alloc.flatMap((c) => c.projects.map((p) => ({ client: c.client, project: p.project, hours: p.hours })));
      parts['alloc-table'] = `<div class="card"><h3>Resource allocation <span class="muted" style="font-weight:400;font-size:12px">— table · approved hours</span></h3>` + listModule({
        columns: [
          { label: 'Client', cell: (r) => esc(r.client) },
          { label: 'Project', cell: (r) => esc(r.project) },
          { label: unitLabel(), align: 'right', width: '110px', mono: true, cell: (r) => dur(r.hours) },
        ], rows: allocRows, empty: emptyScope + '.',
      }) + `</div>`;
    } else if (user.role === 'TEAM_LEAD') {
      let lq = '/dashboards/team-lead/hour-distribution?range=' + leadRange;
      if (leadRange === 'custom') {
        if (leadCustom.start) lq += '&start_date=' + leadCustom.start;
        if (leadCustom.end) lq += '&end_date=' + leadCustom.end;
      }
      const dist = await api(lq);
      const max = Math.max(1, ...dist.map((d) => d.totalHours));
      // Group the flat subtask list under its project for the two-ring chart.
      // Falls back to a single "—" bucket if an older server build hasn't got
      // the project field yet, so the card degrades rather than breaking.
      const byProject = [];
      const projIdx = {};
      dist.forEach((d) => {
        const key = d.projectId || d.project || '—';
        if (projIdx[key] === undefined) { projIdx[key] = byProject.length; byProject.push({ project: d.project || '—', projectId: d.projectId || null, tasks: [] }); }
        // Members form the outer ring. Only the Team Lead's own view builds
        // this — the Team Member aggregate deliberately carries no per-member
        // figures at all (see teamProjectTaskHours), so there is nothing here
        // that could surface them on that endpoint.
        byProject[projIdx[key]].tasks.push({
          name: d.subtask,
          hours: d.totalHours,
          members: (d.byMember || []).map((m) => ({ name: m.member, hours: m.hours })),
        });
      });
      const splitPie = sunburstChart(byProject, { fmt: (v) => dur(v), center: 'Total hours', empty: emptyScope });
      const byMember = {};
      dist.forEach((d) => d.byMember.forEach((m) => { byMember[m.member] = (byMember[m.member] || 0) + m.hours; }));
      // Re-summing per-subtask figures reintroduces float drift, so round again
      // here — same 2dp the hours are stored at.
      const memberBars = barChart(Object.entries(byMember).sort((a, b) => b[1] - a[1]).map(([name, hrs]) => ({ label: name, segments: [{ value: Math.round(hrs * 100) / 100 }] })), { fmt: (v) => dur(v), empty: emptyScope });
      // Same range picker on all three cards — they're one dataset cut three
      // ways, and only one is ever visible at a time (sidebar-selected).
      parts['split-chart'] = `<div class="card"><div class="page-title-row"><div class="title-range-group"><h3>Team time by task <span class="muted" style="font-weight:400;font-size:12px">— chart · approved hours</span></h3>${leadRangeControl()}</div></div>${splitPie}</div>`;
      parts['members'] = `<div class="card"><div class="page-title-row"><div class="title-range-group"><h3>Hours per team member <span class="muted" style="font-weight:400;font-size:12px">— approved hours</span></h3>${leadRangeControl()}</div></div>${memberBars}</div>`;
      // Project column for the same reason the chart got a second ring: task
      // names repeat across projects, so the name alone doesn't identify a row.
      let st = `<div class="card"><div class="page-title-row"><div class="title-range-group"><h3>Team hours by task <span class="muted" style="font-weight:400;font-size:12px">— table · approved hours</span></h3>${leadRangeControl()}</div></div><table class="data-table"><thead><tr><th>Task</th><th>Project</th><th class="num">${unitLabel()}</th><th style="width:200px"></th><th>By member</th></tr></thead><tbody>`;
      st += dist.map((d) => `<tr><td>${esc(d.subtask)}</td><td class="muted">${esc(d.project || '—')}</td><td class="num">${dur(d.totalHours)}</td><td>${bar(d.totalHours, max)}</td><td class="muted">${d.byMember.map((m) => esc(m.member) + ' (' + dur(m.hours) + ')').join(', ') || '—'}</td></tr>`).join('') || `<tr><td colspan="5" class="muted">${esc(emptyScope)}.</td></tr>`;
      parts['split-table'] = st + '</tbody></table></div>';
    }
    // Team aggregate (Team Member + Team Lead). Aggregate-only by design: the
    // endpoint returns no member identities or per-member hours, so neither the
    // chart nor the network response can attribute hours to a person. For the
    // Lead this is a complementary summary; their per-member card is unchanged.
    //
    // By-task and by-project are one screen: the same numbers cut two ways, so
    // splitting them across sidebar entries only made you click between halves
    // of one answer. A single range picker (on the top card) drives both.
    if (user.role === 'TEAM_MEMBER' || user.role === 'TEAM_LEAD') {
      let tq = '/dashboards/team/hours?range=' + teamRange;
      if (teamRange === 'custom') {
        if (teamCustom.start) tq += '&start_date=' + teamCustom.start;
        if (teamCustom.end) tq += '&end_date=' + teamCustom.end;
      }
      const team = await api(tq);
      const scope = `${team.memberCount} member${team.memberCount === 1 ? '' : 's'} · ${dur(team.totalHours)} approved`;
      const byTask = projectPanelsCard('teamHptStrip', (team.projects || []).map((p) => ({
        name: p.projectName,
        tasks: p.tasks.map((t) => ({ name: t.name, hours: t.totalHours })),
      })), 'Team hours by task', scope, teamRangeControl(), pend.scope);
      const teamPie = pieChart((team.projects || []).map((p) => ({ label: p.projectName, value: p.totalHours })), { fmt: (v) => dur(v), center: 'Team hours', empty: emptyScope });
      const byProject = `<div class="card"><h3>Team hours by project <span class="muted" style="font-weight:400;font-size:12px">— share of ${dur(team.totalHours)} approved</span></h3>${teamPie}</div>`;
      parts['team-hours'] = byTask + byProject;
    }

    // Deep search is role-independent: the server scopes results to what this
    // user can already see, so the same card is built for everyone.
    parts['deep-search'] = deepSearchCard();

    // Persistent sticky summary strip (if this role has one), then the selected
    // switchable component below it, full width.
    const heroKey = DASH_HERO[user.role], heroEl = $('dashHero');
    if (heroEl) {
      if (heroKey && parts[heroKey]) { heroEl.innerHTML = parts[heroKey]; heroEl.hidden = false; }
      else { heroEl.innerHTML = ''; heroEl.hidden = true; }
    }
    const comps = dashComponentsFor(user.role);
    if (!comps.some((c) => c[0] === dashSection)) dashSection = comps[0][0];
    $('dg').innerHTML = parts[dashSection] || parts[comps[0][0]] || '<p class="muted">Nothing to show.</p>';
    watchDashHero();
  } catch (e) { $('dg').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}

// ---- Deep search (Dashboard component, every role) ------------------------
// A filter over already-visible hours — the backend applies the same visibility
// scoping used everywhere else (Team Lead = own team, Team Member = own hours).
let deepSearchScope = 'all';
function deepSearchRangeControl() {
  const picker = dsRange === 'custom'
    ? `<input type="date" class="tr-date" value="${esc(dsCustom.start)}" onchange="setDsCustom('start',this.value)">
       <input type="date" class="tr-date" value="${esc(dsCustom.end)}" onchange="setDsCustom('end',this.value)">`
    : '';
  return `<label class="row-flex muted">Range: <select class="tr-sel" onchange="setDsRange(this.value)">${ACTIVITY_RANGES.map(([v, l]) => `<option value="${v}" ${dsRange === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>${picker}`;
}
window.setDsRange = (r) => { dsRange = r; runDeepSearch(); };
window.setDsCustom = (k, v) => { dsCustom = { ...dsCustom, [k]: v }; runDeepSearch(); };
function deepSearchCard() {
  return `<div class="card"><div class="page-title-row"><div class="title-range-group"><h3>Deep search <span class="muted" style="font-weight:400;font-size:12px">— hours by date, per task or project</span></h3>${deepSearchRangeControl()}</div>
    <div class="segmented" id="dsScope">
      ${[['all', 'All'], ['subtask', 'Tasks'], ['project', 'Projects']].map(([v, l]) => `<button class="seg${deepSearchScope === v ? ' active' : ''}" data-mode="${v}" onclick="setDeepScope('${v}')">${l}</button>`).join('')}
    </div></div>
    <div class="row-flex" style="margin-bottom:12px">
      <input id="dsQuery" placeholder="Search a task or project name…" value="${esc(window._dsQuery || '')}" onkeydown="if(event.key==='Enter')runDeepSearch()">
      <button class="btn btn-primary" onclick="runDeepSearch()">${icon('search')}Search</button>
    </div>
    <div id="dsResults">${window._dsHtml || '<p class="muted">Type at least 2 characters and press Search.</p>'}</div></div>`;
}
window.setDeepScope = (v) => {
  deepSearchScope = v;
  const t = document.getElementById('dsScope');
  if (t) t.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.mode === v));
  if ((window._dsQuery || '').trim().length >= 2) runDeepSearch();
};
window.runDeepSearch = async () => {
  const el = $('dsQuery'); if (!el) return;
  const q = el.value.trim();
  window._dsQuery = q;
  const out = $('dsResults'); if (!out) return;
  if (q.length < 2) { window._dsHtml = '<p class="muted">Type at least 2 characters and press Search.</p>'; out.innerHTML = window._dsHtml; return; }
  out.innerHTML = '<p class="muted">Searching…</p>';
  try {
    let dq = `/time-entries/deep-search?q=${encodeURIComponent(q)}&scope=${deepSearchScope}&range=${dsRange}`;
    if (dsRange === 'custom') {
      if (dsCustom.start) dq += '&start_date=' + dsCustom.start;
      if (dsCustom.end) dq += '&end_date=' + dsCustom.end;
    }
    const d = await api(dq);
    window._dsHtml = deepSearchResults(d);
  } catch (e) {
    window._dsHtml = `<p class="danger-text">${esc(e.message)}</p>`;
  }
  out.innerHTML = window._dsHtml;
};
function deepSearchResults(d) {
  const rows = d.results || [];
  if (!rows.length) return `<p class="muted">Nothing found for "${esc(d.query)}" in the hours you can see.</p>`;
  // Whether to show a "Who" column: only useful when the viewer sees more than
  // their own hours (Team Members always see exactly themselves).
  const multi = rows.some((r) => r.days.some((x) => x.people.length > 1)) || user.role === 'CEO' || user.role === 'PM' || user.role === 'TEAM_LEAD';
  return rows.map((r) => `<div class="card" style="background:var(--bg0);margin-bottom:12px">
    <div class="page-title-row"><h3 style="font-size:14px">${esc(r.label)} <span class="badge badge-muted">${r.kind}</span>${r.project ? ` <span class="muted" style="font-weight:400;font-size:12px">in ${esc(r.project)}</span>` : ''}</h3>
      <span class="muted">${dur(r.totalHours)} total · ${r.days.length} ${r.days.length === 1 ? 'day' : 'days'}</span></div>
    <table class="data-table"><thead><tr><th>Date</th><th class="num">${unitLabel()}</th>${multi ? '<th>Who</th>' : ''}</tr></thead><tbody>
    ${r.days.map((x) => `<tr><td>${esc(x.date)}</td><td class="num">${dur(x.hours)}</td>${multi ? `<td class="muted">${esc(x.people.join(', '))}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>`).join('');
}

// Elevate the sticky Dashboard summary once it's pinned under scrolling content
// (mirrors watchStickyCreate). Re-attached on every dashboard render.
function watchDashHero() {
  const el = document.querySelector('.dash-hero');
  if (!el || el.hidden || typeof IntersectionObserver === 'undefined') return;
  new IntersectionObserver(
    ([entry]) => el.classList.toggle('is-stuck', entry.intersectionRatio < 1),
    { threshold: [1], rootMargin: '-17px 0px 0px 0px' },
  ).observe(el);
}

// ===========================================================================
// Audit log (CEO / PM)
// ===========================================================================
async function renderAudit() {
  let projects = []; try { projects = await api('/projects'); } catch (e) {}
  window._auProjects = projects;
  const opts = projects.map((p) => `<option value="${esc(p.name)}">`).join('');
  renderPage('Audit log', `<div class="card"><h3>Look up entity history</h3><div class="form-grid">
    <label>Entity type</label><select id="auType" onchange="onAuTypeChange()"><option>Project</option><option value="Subtask">Task</option><option>TimeEntry</option><option>Approval</option><option>TimeEntryEditRequest</option><option>ProjectTeamLeadAssignment</option><option>SubtaskTeamMemberAssignment</option>${user.role === 'CEO' ? '<option>Client</option><option>User</option>' : ''}</select>
    <label id="auIdLabel">Project name</label><input id="auId" list="auProjects" placeholder="Start typing a project name…"><datalist id="auProjects">${opts}</datalist></div>
    <div style="margin-top:12px"><button class="btn btn-primary" onclick="lookupAudit()">Look up</button></div></div><div id="auResult"></div>`);
}
window.onAuTypeChange = () => {
  const isProject = $('auType').value === 'Project';
  $('auIdLabel').textContent = isProject ? 'Project name' : 'Entity ID';
  $('auId').placeholder = isProject ? 'Start typing a project name…' : 'uuid';
  $('auId').setAttribute('list', isProject ? 'auProjects' : '');
  $('auId').value = '';
};
window.lookupAudit = async () => {
  try {
    const type = $('auType').value;
    let entityId = $('auId').value.trim();
    if (type === 'Project' && entityId && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(entityId)) {
      const match = (window._auProjects || []).find((p) => p.name.toLowerCase() === entityId.toLowerCase());
      if (!match) { $('auResult').innerHTML = `<p class="danger-text">No project named "${esc(entityId)}".</p>`; return; }
      entityId = match.id;
    }
    const rows = await api(`/audit-log?entityType=${encodeURIComponent(type)}&entityId=${encodeURIComponent(entityId)}`);
    $('auResult').innerHTML = `<div class="card">` + listModule({
      columns: [
        { label: 'When', width: 'max-content', cell: (r) => relTime(r.createdAt) },
        { label: 'Action', cell: (r) => esc(r.action) },
        { label: 'Actor', cell: (r) => `${esc(r.actor ? r.actor.name : '')} <span class="muted">(${r.actor ? r.actor.role.toLowerCase() : ''})</span>` },
      ], rows, empty: 'No audit rows.',
    }) + `</div>`;
  } catch (e) { $('auResult').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
};

// ===========================================================================
// Add project modal (CEO)
// ===========================================================================
async function openAddProject() {
  let clients = []; try { clients = await api('/clients'); } catch (e) {}
  let b = `<h3>Add project</h3><p class="meta">Projects belong to a client.</p>
    <div class="field"><label>Client</label><select id="pClient">${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Name</label><input id="pName" placeholder="Project name"></div>
    <div class="field"><label>Deadline</label><input id="pDeadline" type="date"></div>
    <details style="margin:8px 0"><summary style="color:var(--text2);cursor:pointer">Quick add client</summary>
      <div class="field" style="margin-top:8px"><label>Client name</label><input id="cName"></div>
      <div class="toggle-row"><button class="btn btn-ghost btn-sm" onclick="createClientInline()">Add client</button></div></details>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createProject()">Create project</button></div>`;
  openModal(b);
}
window.createClientInline = async () => { try { await api('/clients', { method: 'POST', body: JSON.stringify({ name: $('cName').value }) }); closeModal(); openAddProject(); } catch (e) { toast(e.message); } };
window.createProject = async () => { try { const p = { clientId: $('pClient').value, name: $('pName').value }; if ($('pDeadline').value) p.deadline = new Date($('pDeadline').value).toISOString(); await api('/projects', { method: 'POST', body: JSON.stringify(p) }); closeModal(); await loadProjectsList(); toast('Project created'); if (activeNav === 'projects') renderProjects(); } catch (e) { toast(e.message); } };

// ===========================================================================
// Admin panel — Users & teams (ADMIN role only)
// ===========================================================================
const ROLE_OPTIONS = ['CEO', 'PM', 'TEAM_LEAD', 'TEAM_MEMBER', 'ADMIN'];
const roleLabel = (r) => r.replace('_', ' ').toLowerCase();
function userStatus(u) {
  if (u.deletedAt) return { label: 'Deleted', cls: 'badge-deleted' };
  if (u.deactivatedAt) return { label: 'Deactivated', cls: 'badge-draft' };
  return { label: 'Active', cls: 'badge-approved' };
}
const ADMIN_ROLE_FILTERS = [['all', 'All'], ['ADMIN', 'Admin'], ['CEO', 'CEO'], ['PM', 'PM'], ['TEAM_LEAD', 'Team Lead'], ['TEAM_MEMBER', 'Team Member']];
function adminUserRow(u) {
  const st = userStatus(u);
  let actions = '';
  if (!u.deletedAt) {
    actions += `<button class="btn btn-ghost btn-sm" onclick="openResetPw('${u.id}','${esc(u.name).replace(/'/g, '')}')">Reset password</button> `;
    actions += u.deactivatedAt
      ? `<button class="btn btn-ghost btn-sm" onclick="setUserActive('${u.id}',true)">Reactivate</button> `
      : `<button class="btn btn-ghost btn-sm" onclick="setUserActive('${u.id}',false)">Deactivate</button> `;
    actions += `<button class="btn btn-ghost btn-sm danger-text" onclick="deleteUser('${u.id}','${esc(u.name).replace(/'/g, '')}')">Delete</button>`;
  } else {
    actions = '<span class="muted">—</span>';
  }
  return `<tr${u.deletedAt ? ' class="muted"' : ''}><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${roleLabel(u.role)}</td><td><span class="badge ${st.cls}">${st.label}</span></td><td class="num">${actions}</td></tr>`;
}
// Purely client-side role filter over the already-fetched user list.
window.filterAdminUsers = (role) => {
  const users = window._adminUsers || [];
  const shown = role === 'all' ? users : users.filter((u) => u.role === role);
  const body = $('admUsersBody');
  if (body) body.innerHTML = shown.map(adminUserRow).join('') || '<tr><td colspan="5" class="muted">No users match.</td></tr>';
  const cnt = $('admCount'); if (cnt) cnt.textContent = `${shown.length} of ${users.length} users`;
  const wrap = $('admRoleFilter'); if (wrap) wrap.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
};
async function renderAdmin() {
  renderPage('Users & teams', `<div id="adm"><p class="muted">Loading…</p></div>`,
    `<button class="btn btn-primary" onclick="openAddUser()">+ Add user</button>`);
  try {
    const [users, teams] = await Promise.all([api('/users/admin'), api('/teams')]);
    window._adminUsers = users;
    window._adminLeads = users.filter((u) => u.role === 'TEAM_LEAD' && !u.deletedAt);

    // Account/system metadata only — no business (project/timesheet) data.
    const roleCounts = {};
    users.forEach((u) => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
    const rolePie = pieChart(Object.entries(roleCounts).map(([r, n]) => ({ label: r.replace('_', ' ').toLowerCase(), value: n })), { center: 'Users', empty: 'No users' });
    const statusBars = barChart([
      { label: 'Active', segments: [{ value: users.filter((u) => !u.deletedAt && !u.deactivatedAt).length, color: 'var(--status-approved)' }] },
      { label: 'Deactivated', segments: [{ value: users.filter((u) => u.deactivatedAt && !u.deletedAt).length, color: 'var(--status-draft)' }] },
      { label: 'Deleted', segments: [{ value: users.filter((u) => u.deletedAt).length, color: 'var(--status-rejected)' }] },
    ], { empty: 'No users' });

    let h = `<div class="chart-grid2">
      <div class="card"><h3>Users by role</h3>${rolePie}</div>
      <div class="card"><h3>Account status</h3>${statusBars}</div></div>`;
    h += `<div class="card"><div class="page-title-row"><h3>Users</h3><span id="admCount" class="muted"></span></div>
      <div class="segmented" id="admRoleFilter" style="margin-bottom:12px;flex-wrap:wrap">${ADMIN_ROLE_FILTERS.map(([v, l]) => `<button class="seg${v === 'all' ? ' active' : ''}" data-role="${v}" onclick="filterAdminUsers('${v}')">${l}</button>`).join('')}</div>
      <table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody id="admUsersBody"></tbody></table></div>`;

    h += `<div class="card"><div class="page-title-row"><h3>Teams</h3><button class="btn btn-primary btn-sm" onclick="openAddTeam()">+ Add team</button></div>` + listModule({
      columns: [
        { label: 'Team', cell: (t) => esc(t.name) },
        { label: 'Team lead', cell: (t) => (t.teamLead ? esc(t.teamLead.name) : '<span class="muted">leaderless</span>') },
        { label: 'Members', align: 'right', width: '90px', mono: true, cell: (t) => (t.memberships || []).length },
        { label: 'Created', width: '110px', cell: (t) => (t.createdAt ? t.createdAt.slice(0, 10) : '') },
      ], rows: teams, empty: 'No teams.',
    }) + `</div>`;
    $('adm').innerHTML = h;
    filterAdminUsers('all'); // default view
  } catch (e) { $('adm').innerHTML = `<p class="danger-text">${esc(e.message)}</p>`; }
}
window.openAddUser = () => {
  openModal(`<h3>Add user</h3><p class="meta">The new user sets their own password on first login.</p>
    <div class="field"><label>Name</label><input id="auName" placeholder="Full name"></div>
    <div class="field"><label>Email</label><input id="auEmail" type="email" placeholder="you@company.com"></div>
    <div class="field"><label>Role</label><select id="auRole">${ROLE_OPTIONS.map((r) => `<option value="${r}">${roleLabel(r)}</option>`).join('')}</select></div>
    <div class="field"><label>Temporary password</label><input id="auPw" type="text" placeholder="min 8 characters"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createUser()">Create user</button></div>`);
};
window.createUser = async () => {
  try {
    const p = { name: $('auName').value, email: $('auEmail').value, role: $('auRole').value, password: $('auPw').value };
    await api('/users/admin', { method: 'POST', body: JSON.stringify(p) });
    closeModal(); toast('User created'); renderAdmin();
  } catch (e) { toast(e.message); }
};
window.openResetPw = (id, name) => {
  openModal(`<h3>Reset password</h3><p class="meta">${esc(name)}</p>
    <div class="field"><label>New temporary password</label><input id="rpPw" type="text" placeholder="min 8 characters"></div>
    <p class="muted">They'll be forced to set a new password on next login.</p>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="resetPw('${id}')">Reset</button></div>`);
};
window.resetPw = async (id) => {
  try { await api('/users/admin/' + id + '/reset-password', { method: 'POST', body: JSON.stringify({ password: $('rpPw').value }) }); closeModal(); toast('Password reset'); }
  catch (e) { toast(e.message); }
};
window.setUserActive = async (id, active) => {
  try { await api('/users/admin/' + id + '/' + (active ? 'reactivate' : 'deactivate'), { method: 'POST' }); toast(active ? 'Reactivated' : 'Deactivated'); renderAdmin(); }
  catch (e) { toast(e.message); }
};
window.deleteUser = async (id, name) => {
  if (!confirm('Delete user "' + name + '"? Soft delete — history is preserved, but they can no longer log in.')) return;
  try { await api('/users/admin/' + id, { method: 'DELETE' }); toast('User deleted'); renderAdmin(); }
  catch (e) {
    // Leaderless-team guard: server asks for confirmation before proceeding.
    if (/confirm=true/.test(e.message) && confirm(e.message + '\n\nProceed anyway?')) {
      try { await api('/users/admin/' + id + '?confirm=true', { method: 'DELETE' }); toast('User deleted'); renderAdmin(); }
      catch (e2) { toast(e2.message); }
    } else { toast(e.message); }
  }
};
window.openAddTeam = () => {
  const leads = window._adminLeads || [];
  openModal(`<h3>Add team</h3>
    <div class="field"><label>Name</label><input id="atName" placeholder="Team name"></div>
    <div class="field"><label>Team lead <span class="muted">(optional)</span></label><select id="atLead"><option value="">— leaderless —</option>${leads.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="createAdminTeam()">Create team</button></div>`);
};
window.createAdminTeam = async () => {
  try { const body = { name: $('atName').value }; if ($('atLead').value) body.teamLeadId = $('atLead').value; await api('/teams', { method: 'POST', body: JSON.stringify(body) }); closeModal(); toast('Team created'); renderAdmin(); }
  catch (e) { toast(e.message); }
};

// ===========================================================================
// Forced password change (must_change_password) — blocks the app until done
// ===========================================================================
function renderForcePassword() {
  $('nav').innerHTML = '';
  // No nav on this screen, but the profile card stays wired: its panel is now
  // the only route to Log out, and someone who can't set a password still needs
  // a way out.
  const card = $('profileCard');
  if (card) card.onclick = (e) => { e.stopPropagation(); toggleProfileMenu(); };
  paintAvatar($('avatar'), user); $('userName').textContent = user.name; $('userRole').textContent = roleLabel(user.role);
  view().innerHTML = headerHtml('Set a new password', '') + `<div class="card" style="max-width:420px">
    <p class="muted">Your account requires a new password before you can continue.</p>
    <div class="field"><label>New password</label><input id="fpNew" type="password" placeholder="min 8 characters"></div>
    <div class="field"><label>Confirm new password</label><input id="fpConfirm" type="password" placeholder="repeat it"></div>
    <p id="fpErr" class="danger-text"></p>
    <div class="modal-actions"><button class="btn btn-primary" onclick="submitNewPassword()">Set password &amp; continue</button></div></div>`;
  wireHeader();
}
window.submitNewPassword = async () => {
  const np = $('fpNew').value, cf = $('fpConfirm').value;
  if (np.length < 8) { $('fpErr').textContent = 'Password must be at least 8 characters.'; return; }
  if (np !== cf) { $('fpErr').textContent = 'Passwords do not match.'; return; }
  try {
    await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword: np }) });
    user.mustChangePassword = false;
    sessionStorage.setItem('user', JSON.stringify(user));
    toast('Password updated'); boot();
  } catch (e) { $('fpErr').textContent = e.message; }
};

// ---- boot -----------------------------------------------------------------
async function boot() {
  // Forced password change gates everything else.
  if (user.mustChangePassword) { renderForcePassword(); return; }
  renderSidebar();
  if (user.role === 'ADMIN') { activeNav = 'admin'; setActiveNav('admin'); await renderAdmin(); return; }
  await loadSubtaskMap();
  loadInboxBadge();
  // Land on Notifications, not the Timesheet — the Reviewing selector + Project
  // filter are populated by renderTable's toolbar whenever that tab is opened.
  go('inbox');
}
boot();
