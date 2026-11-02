// Building Charges — Telegram Mini App frontend (vanilla ES modules).
// v2: username/password auth for every person, three roles (admin|manager|resident),
// server-side PDF statements. The app-admin panel is a separate page (admin.html)
// and is deliberately NOT linked or reachable from this manager surface.
import {
  $, $$, icon, esc, faNum, fmtMoney, fmtNum, parseNum, enNum,
  toast, haptic, openModal, confirmDialog, moneyField, bindMoneyInputs,
  jalaaliDateFields, readJalaaliDate, stepperHTML, bindStepper,
  statusChip, emptyState, periodLabel, addPeriods, isPeriod,
  localPeriod, todayLocalJalaali, J_MONTHS, shortMonth,
  unitNo, unitWord, formatJalaliDateTime,
  getTheme, setTheme, cycleTheme, themeIcon, THEME_LABEL
} from './util.js';
import { mockFetch, MOCK_STATE } from './mock.js';

const TG = window.Telegram?.WebApp;
const qs = new URLSearchParams(location.search);
const FORCE_REAL = qs.has('real');
// v2.11.8 (قفل ۵): حالت نمایشی (دمو) فقط روی localhost/127.0.0.1 فعال می‌شود —
// روی دامنه واقعی (حتی با ?mock) هیچ‌گاه دمو بالا نمی‌آید و همیشه احراز واقعی
// اجرا می‌شود؛ یعنی باز کردن لینک اپ هرگز پنل کسی را بدون رمز باز نمی‌کند.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const MOCK = !FORCE_REAL && LOCAL_HOST && (qs.has('mock') || !TG?.initData);

// v2.11.11: token slots are computed per Telegram identity — see slotKey() below
// ('bc_token_tg_<id>' inside Telegram, 'bc_token' in a plain browser).
const state = {
  user: null, role: 'guest', unit: null,
  settings: {}, period: localPeriod(), jy: localPeriod().slice(0, 4),
  view: 'dashboard', unitsCache: [], debtCache: {},
  filter: { units: '', charges: 'all' }
};

const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

// ---------------------------------------------------------------------------
// v2.11.11 — per-Telegram-account session memory (چندحسابی)
// The device keeps ONE REMEMBERED SESSION PER TELEGRAM ACCOUNT instead of a
// single shared token slot: switching Telegram accounts on the same phone no
// longer throws the previous account's session away, and switching back goes
// straight in without a password.
//   • slot selection reads the Telegram id from initData CLIENT-SIDE — purely
//     to pick WHICH remembered token to try; the server still verifies the
//     initData HMAC signature, the tid binding (lock 2) and the session
//     version (lock 4) on every request, so a forged id can only select an
//     empty/foreign slot that then fails with 401 → normal login screen.
//   • inside Telegram  → 'bc_token_tg_<id>'  (one slot per Telegram account)
//   • plain browser    → 'bc_token'           (unchanged web behavior)
// ---------------------------------------------------------------------------
function tgIdFromInitData() {
  try {
    const raw = TG?.initData;
    if (!raw) return null;
    const m = new URLSearchParams(raw).get('user');
    if (!m) return null;
    const u = JSON.parse(m);
    const id = Number(u && u.id);
    return id > 0 ? id : null;
  } catch { return null; }
}
function slotKey() {
  const tid = tgIdFromInitData();
  return tid ? `bc_token_tg_${tid}` : 'bc_token';
}
function getToken() { return localStorage.getItem(slotKey()) || ''; }
function setToken(t) { localStorage.setItem(slotKey(), t); }
function clearToken() { localStorage.removeItem(slotKey()); }

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------
function authHeaders() {
  const h = {};
  const t = getToken();
  if (t) h['authorization'] = 'Bearer ' + t;
  if (TG?.initData) h['x-telegram-init-data'] = TG.initData;
  return h;
}

async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
  if (MOCK) {
    // v2.11.11: the demo's session store validates the presented token too
    const res = await mockFetch(path, method, body || {}, getToken());
    // mock layer signals failures with {__ok:false,...} — mirror the real
    // fetch path by converting them to thrown errors so UI shows the message
    if (res && res.__ok === false) {
      const e = new Error(res.error || 'خطا');
      e.status = res.status; e.code = res.code;
      throw e;
    }
    storeRefreshed(res);
    return res;
  }
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || ('خطای سرور (' + res.status + ')'));
    e.status = res.status; e.code = data && data.code;
    throw e;
  }
  storeRefreshed(data);
  return data;
}

// v2.11.11 — sliding session renewal: /auth/me (and change-password) may hand
// back a fresh token; store it in the CURRENT Telegram account's slot so the
// remembered session never silently expires while the account is in use.
function storeRefreshed(data) {
  try { if (data && data.refreshed_token) setToken(data.refreshed_token); } catch { /* best effort */ }
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// v2.11.4 — Telegram's webview silently swallows blob: anchor downloads, so in
// real mode we fetch a short-lived signed URL (POST /dl/link) and open it
// OUTSIDE the mini app (Telegram.WebApp.openLink → external browser) where the
// native download manager handles Content-Disposition: attachment. In plain
// browsers (admin panel / desktop) the signed URL is opened directly.
async function openServerDownload(kind, params = {}) {
  const r = await api('/dl/link', { method: 'POST', body: { kind, ...params } });
  // inside real Telegram clients → open in the external browser (downloads work
  // there); in a plain browser (admin panel/desktop, platform 'unknown') →
  // direct window.open with the attachment URL downloads natively.
  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = tg && tg.platform && tg.platform !== 'unknown';
  if (inTelegram && typeof tg.openLink === 'function') {
    toast('در حال باز کردن فایل در مرورگر برای دانلود…', 'ok');
    tg.openLink(r.url);
  } else {
    window.open(r.url, '_blank', 'noopener');
    toast('فایل خروجی آماده شد', 'ok');
  }
}

async function downloadExport(type) {
  try {
    if (MOCK) {
      const q = type === 'year' ? '&jy=' + state.jy : '';
      const res = await mockFetch('/export?type=' + type + q, 'GET', {});
      const dl = res.__download;
      triggerDownload(URL.createObjectURL(new Blob([dl.content], { type: dl.mime + ';charset=utf-8' })), dl.filename);
    } else {
      await openServerDownload('export', { type });
    }
    if (MOCK) toast('فایل خروجی آماده شد', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Download a server-generated PDF (statement for a unit / yearly report)
async function downloadPdf(kind, { unitId, jy } = {}) {
  try {
    if (MOCK) {
      const { downloadMockPdf } = await import('./pdf-client.js');
      await downloadMockPdf(kind, { unitId, jy });
      return;
    }
    await openServerDownload(kind === 'report' ? 'report' : 'statement', {
      unit_id: unitId || (state.unit && state.unit.id),
      jy: jy || (kind === 'report' ? state.jy : '')
    });
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Theme — auto (Telegram params / system) or user-forced light / dark
// ---------------------------------------------------------------------------
const THEME_CSS_VARS = [
  '--bg', '--bg-2', '--sec', '--card', '--card-2', '--text', '--muted',
  '--accent', '--on-accent', '--accent-soft', '--line'
];

function hexToRgba(hex, a) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return null;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function applyTheme() {
  const mode = getTheme();
  document.documentElement.dataset.theme = mode;
  const st = document.documentElement.style;
  // clear any previous Telegram-driven inline overrides so CSS palettes apply
  THEME_CSS_VARS.forEach(v => st.removeProperty(v));

  // Telegram params only steer the palette in «auto» mode; forced light/dark
  // use this app's own palettes so every panel stays consistent.
  if (mode === 'auto' && TG?.themeParams) {
    const tp = TG.themeParams;
    const set = (k, v) => { if (v) st.setProperty(k, v); };
    set('--bg', tp.bg_color);
    set('--sec', tp.secondary_bg_color);
    set('--card', tp.section_bg_color || tp.secondary_bg_color);
    set('--card-2', hexToRgba(tp.text_color || '#ffffff', 0.06));
    set('--text', tp.text_color);
    set('--muted', tp.hint_color);
    set('--accent', tp.button_color);
    set('--on-accent', tp.button_text_color);
    set('--accent-soft', hexToRgba(tp.button_color || '#3390ec', 0.16));
    set('--line', hexToRgba(tp.text_color || '#ffffff', 0.09));
    try {
      TG.setHeaderColor(tp.secondary_bg_color || tp.bg_color);
      TG.setBackgroundColor(tp.bg_color);
    } catch { /* older clients */ }
  } else {
    try {
      const dark = mode === 'dark' || (mode === 'auto' && !window.matchMedia);
      const bg = dark ? '#17212b' : '#ffffff';
      const root = dark ? '#0e1621' : '#f1f4f8';
      TG?.setHeaderColor?.(bg);
      TG?.setBackgroundColor?.(mode === 'light' ? root : bg);
    } catch { /* older clients */ }
  }
}

function updateThemeBtn() {
  const b = $('#btn-theme');
  if (!b) return;
  const t = getTheme();
  b.innerHTML = icon(themeIcon(t));
  b.setAttribute('aria-label', 'تم: ' + THEME_LABEL[t]);
}

// ---------------------------------------------------------------------------
// Boot: remembered per-account session → login screen (no passwordless entry)
// ---------------------------------------------------------------------------
function renderSplash() {
  $('#main').innerHTML = `
    <div class="screen">
      <div class="logo">${icon('building', 32)}</div>
      <div class="spinner"></div>
      <p>در حال بارگذاری...</p>
    </div>`;
}

function enterApp(me) {
  state.user = me.user;
  state.role = me.role || me.user.role;
  state.unit = me.unit || null;
  state.settings = me.settings || {};
  if (isPeriod(me.current_period)) state.period = me.current_period;
  state.jy = state.period.slice(0, 4);
  $('#bname').textContent = state.settings.building_name || 'مدیریت شارژ ساختمان';
  $('#hsub').textContent =
    state.role === 'manager' ? 'پنل مدیر ساختمان' :
    state.role === 'admin' ? 'مدیر اپ' :
    (state.unit ? unitWord(state.unit.number) : '');
  renderShell();
  if (state.role === 'resident' && !state.unit) {
    renderNoUnit();
    return;
  }
  if (state.role === 'admin' && !state.unit) {
    renderAdminGate();
    return;
  }
  navigate(
    state.role === 'manager' ? 'dashboard' : 'my'
  );
}

async function boot() {
  renderSplash();
  // 1) this Telegram account's remembered session token → straight in
  //    (v2.11.11: each Telegram account has its own slot, so switching
  //    accounts on one device never forgets the other account's session)
  if (getToken()) {
    try {
      const me = await api('/auth/me');
      enterApp(me);
      return;
    } catch (e) {
      if (e.status === 401) clearToken();
    }
  }
  // 2) always ask for username & password first — no automatic entry.
  //    (Logging in inside Telegram also links the account for reminders.)
  renderLogin();
}

function renderLogin() {
  $('#tabbar').hidden = true;
  $('#btn-settings').hidden = true;
  $('#hsub').textContent = '';
  $('#main').innerHTML = `
    <div class="view">
      <div class="screen">
        <div class="logo">${icon('building', 30)}</div>
        <h2>ورود به اپ ساختمان</h2>
        <p style="max-width:280px">نام کاربری و رمز عبور خود را وارد کنید. اگر حساب ندارید، از مدیر ساختمان بگیرید.</p>
        <div class="hint" style="max-width:280px;margin:-4px auto 10px;display:flex;gap:6px;align-items:flex-start;text-align:right">
          ${icon('shield', 14)}
          <span>ورود فقط با نام کاربری و رمز عبور ممکن است؛ باز کردن لینک اپ بدون حساب، فقط همین صفحه را نشان می‌دهد. هر حساب تلگرام نشست خودش را جداگانه به یاد می‌گیرد.</span>
        </div>
        <form id="login-form" class="login-box" style="width:100%;max-width:300px">
          <div class="field">
            <label for="li-user">نام کاربری</label>
            <input id="li-user" autocomplete="username" autocapitalize="none" dir="ltr" style="text-align:center" required>
          </div>
          <div class="field">
            <label for="li-pass">رمز عبور</label>
            <input id="li-pass" type="password" autocomplete="current-password" dir="ltr" style="text-align:center" required>
          </div>
          <button class="btn block" id="li-go" type="submit">${icon('user', 17)} ورود</button>
          <div class="hint" id="li-err" style="color:var(--danger);min-height:18px"></div>
        </form>
      </div>
    </div>`;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('#li-user').value.trim();
    const password = $('#li-pass').value;
    if (!username || !password) return;
    const btn = $('#li-go');
    btn.disabled = true;
    $('#li-err').textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username, password } });
      setToken(r.token);
      haptic('success');
      if (r.linked_telegram) toast('حساب شما به تلگرام متصل شد', 'ok');
      boot();
    } catch (err) {
      haptic('error');
      $('#li-err').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function renderNoUnit() {
  $('#main').innerHTML = `
    <div class="view"><div class="screen">
      <div class="logo">${icon('home', 30)}</div>
      <h2>به واحدی متصل نیستید</h2>
      <p>حساب کاربری شما به هیچ واحدی اختصاص نیافته است.<br>از مدیر ساختمان بخواهید حساب شما را به واحدتان متصل کند.</p>
      <button class="btn ghost" id="logout-btn">${icon('x', 15)} خروج از حساب</button>
    </div></div>`;
  $('#logout-btn').addEventListener('click', doLogout);
}

// App-admin (مدیر اپ) without a linked unit: no finance here by design —
// total residents' debt is visible only to the building manager. Point to the panel.
function renderAdminGate() {
  $('#tabbar').hidden = true;
  $('#main').innerHTML = `
    <div class="view"><div class="screen">
      <div class="logo">${icon('gear', 30)}</div>
      <h2>مدیر اپ هستید</h2>
      <p>مدیریت کاربران، تنظیمات و نصب اپ از <b>پنل مدیریت اپ</b> انجام می‌شود.<br>
      مانده بدهی کل ساکنین فقط برای مدیر ساختمان نمایش داده می‌شود.</p>
      <button class="btn block" id="go-admin" style="max-width:280px">${icon('link', 17)} باز کردن پنل مدیریت اپ</button>
      <button class="btn ghost" id="logout-btn" style="margin-top:10px">${icon('x', 15)} خروج از حساب</button>
    </div></div>`;
  $('#go-admin').addEventListener('click', () => {
    const url = location.origin + '/admin.html';
    if (TG?.openLink) TG.openLink(url);
    else window.open(url, '_blank');
  });
  $('#logout-btn').addEventListener('click', doLogout);
}

async function doLogout() {
  // v2.11.8 (قفل ۴): خروج، همه نشست‌های این کاربر را سمت سرور هم باطل می‌کند
  // (توکن‌های مسروقه بی‌اثر می‌شوند) — بعد از آن ورود دوباره لازم است.
  // v2.11.11 (چندحسابی): فقط خانه‌ی نشست همین حساب تلگرام پاک می‌شود؛
  // حساب‌های دیگر تلگرام که روی همین دستگاه به یاد دارند دست‌نخورده می‌مانند.
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* best effort */ }
  clearToken();
  if (MOCK) MOCK_STATE.user = null;
  toast('از حساب خارج شدید', 'ok');
  boot();
}

function renderBootError(e) {
  const expired = e.status === 401;
  $('#main').innerHTML = `
    <div class="screen">
      <div class="logo">${icon(expired ? 'refresh' : 'alert', 32)}</div>
      <h2>${expired ? 'نشست منقضی شده' : 'خطا در اتصال'}</h2>
      <p>${esc(expired ? 'لطفاً دوباره وارد شوید.' : e.message)}</p>
      <button class="btn ghost" id="boot-retry">${icon('refresh', 16)} تلاش مجدد</button>
    </div>`;
  $('#boot-retry').addEventListener('click', boot);
}

// ---------------------------------------------------------------------------
// Shell & tabs (role-based — the app-admin panel is NOT part of this app)
// ---------------------------------------------------------------------------
function renderShell() {
  const tabbar = $('#tabbar');
  let tabs;
  if (state.role === 'manager') {
    tabs = [
      ['dashboard', 'داشبورد', 'home'],
      ['units', 'واحدها', 'users'],
      ['charges', 'شارژ', 'card'],
      ['expenses', 'هزینه‌ها', 'pie'],
      ['polls', 'نظرسنجی', 'poll'],
      ['reports', 'گزارش‌ها', 'chart'],
      ['guide', 'راهنما', 'book']
    ];
    // مدیر هم واحد خودش را دارد؛ نمای واحد خودش را هم می‌بیند
    if (state.unit) tabs.push(['my', 'واحد من', 'building']);
  } else if (state.role === 'admin') {
    // مانده بدهی کل ساکنین فقط برای مدیر ساختمان نمایش داده می‌شود؛
    // مدیر اپ یا مثل یک ساکن واحد خودش را می‌بیند یا به پنل مدیریت هدایت می‌شود.
    tabs = state.unit ? [
      ['my', 'وضعیت من', 'home'],
      ['myreports', 'گزارش سالانه', 'chart'],
      ['myhistory', 'تاریخچه', 'file'],
      ['guide', 'راهنما', 'book']
    ] : [];
  } else {
    tabs = [
      ['my', 'وضعیت من', 'home'],
      ['myreports', 'گزارش سالانه', 'chart'],
      ['myhistory', 'تاریخچه', 'file'],
      ['guide', 'راهنما', 'book']
    ];
  }
  tabbar.innerHTML = tabs.map(([v, l, ic]) =>
    `<button class="tab" data-view="${v}" aria-label="${l}">${icon(ic)}<span>${l}</span></button>`).join('');
  tabbar.classList.toggle('dense', tabs.length >= 7);
  tabbar.hidden = false;
  $('#btn-settings').hidden = false;
}

let navSeq = 0;
async function navigate(view) {
  const seq = ++navSeq;
  state.view = view;
  state.debtCache = {};
  $$('#tabbar .tab').forEach(t => t.classList.toggle('on', t.dataset.view === view));
  const main = $('#main');
  main.innerHTML = `<div class="view"><div class="screen"><div class="spinner"></div></div></div>`;
  try {
    const html = await renderView(view);
    if (seq !== navSeq) return;
    main.innerHTML = `<div class="view">${html}</div>`;
    mountView(view);
    // v2.11.1: reset scroll on tab switch — same fix as the admin panel, so a
    // new tab always opens from the top instead of a jumped-down page.
    window.scrollTo(0, 0);
    // v2.11.3: a fresh view always starts with the header visible
    document.body.classList.remove('hdr-hide');
    hdrLastY = 0;
  } catch (e) {
    if (seq !== navSeq) return;
    main.innerHTML = `<div class="view"><div class="screen">${icon('alert', 42)}
      <h2>خطا</h2><p>${esc(e.message)}</p>
      <button class="btn ghost" data-action="retry">${icon('refresh', 16)} تلاش مجدد</button></div></div>`;
  }
}
const refresh = () => navigate(state.view);

// ---------------------------------------------------------------------------
// Views — Dashboard (manager: full; admin: read-only)
// ---------------------------------------------------------------------------
async function viewDashboard() {
  const d = await api('/dashboard?period=' + state.period);
  const jy = state.period.slice(0, 4);
  const months = Array.from({ length: 12 }, (_, i) => `${jy}-${String(i + 1).padStart(2, '0')}`);
  const sMap = {};
  (d.series || []).forEach(s => { sMap[s.period] = s; });
  const max = Math.max(1, ...months.map(m => sMap[m] ? sMap[m].issued : 0));
  const bars = months.map((m, i) => {
    const s = sMap[m] || {};
    const hi = Math.round((s.issued || 0) / max * 100);
    const hc = Math.round((s.collected || 0) / max * 100);
    return `<div class="bar-col" title="${esc(periodLabel(m))} — صادر: ${fmtNum(s.issued || 0)} | وصول: ${fmtNum(s.collected || 0)}">
      <div class="bar-pair"><span class="bar issued" style="height:${hi}%"></span><span class="bar collected" style="height:${hc}%"></span></div>
      <span class="m">${shortMonth(i + 1)}</span></div>`;
  }).join('');

  const rate = d.month.issued ? Math.round(d.month.collected / d.month.issued * 100) : 0;
  const recent = (d.recent || []).map(r => `
    <div class="row">
      <div class="badge gray">${icon('wallet')}</div>
      <div class="mid">
        <div class="t1">${unitWord(r.unit_number)}${r.resident_name ? ' — ' + esc(r.resident_name) : ''}</div>
        <div class="t2">${esc(r.description)}${r.method ? ' • ' + esc(r.method) : ''}</div>
      </div>
      <div class="end">
        <span class="amount">${fmtMoney(r.paid_amount)}</span>
        <span class="t2">${fmtDate(r.paid_at)}</span>
      </div>
    </div>`).join('');

  const top = (d.top || []).map(t => `
    <div class="row">
      <div class="badge gray">${esc(faNum(unitNo(t.number)))}</div>
      <div class="mid">
        <div class="t1">${esc(t.resident_name || unitWord(t.number))}</div>
        <div class="t2">مانده بدهی</div>
      </div>
      <div class="end"><span class="amount" style="color:var(--danger)">${fmtMoney(t.debt)}</span></div>
    </div>`).join('');

  const quickActions = state.role === 'manager' ? `
    <div class="section-title">عملیات سریع</div>
    <div class="qa-row">
      <button class="qa" data-action="gen-open"><span class="ic">${icon('plus')}</span><span>صدور شارژ</span></button>
      <button class="qa" data-action="exp-add"><span class="ic">${icon('pie')}</span><span>هزینه جدید</span></button>
      <button class="qa" data-action="remind"><span class="ic">${icon('bell')}</span><span>یادآوری</span></button>
      <button class="qa" data-action="announce"><span class="ic">${icon('send')}</span><span>اعلان</span></button>
    </div>` : '';

  return `
    <div class="hero">
      <div class="label">مانده بدهی کل ساکنین</div>
      <div class="value ${d.totals.outstanding > 0 ? 'bad' : 'ok'}">${fmtMoney(d.totals.outstanding)}</div>
      <div class="sub">مجموع دریافتی تا امروز: <b>${fmtMoney(d.totals.collected)}</b> از ${fmtMoney(d.totals.issued)}</div>
      <div class="progress" style="margin-top:10px"><i style="width:${d.totals.issued ? Math.round(d.totals.collected / d.totals.issued * 100) : 0}%"></i></div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="k">${icon('card', 13)} صادرشده ${esc(periodLabel(state.period))}</div>
        <div class="v">${fmtNum(d.month.issued)} <small>تومان</small></div></div>
      <div class="stat"><div class="k">${icon('check', 13)} وصول این ماه</div>
        <div class="v">${fmtNum(d.month.collected)} <small>تومان</small></div>
        <div class="trend ${rate >= 60 ? 'up' : 'down'}">نرخ وصول ${faNum(rate)}٪</div></div>
      <div class="stat"><div class="k">${icon('users', 13)} تعداد واحدها</div>
        <div class="v">${faNum(d.units_count)}</div></div>
      <div class="stat"><div class="k">${icon('alert', 13)} واحدهای بدهکار</div>
        <div class="v" style="color:${d.debtors_count ? 'var(--danger)' : 'var(--ok)'}">${faNum(d.debtors_count)}</div></div>
    </div>

    ${quickActions}

    <div class="section-title">وصول مطالبات سال ${faNum(jy)}</div>
    <div class="card chart-card">
      <div class="bars">${bars}</div>
      <div class="legend"><span><i class="bar issued" style="width:9px;height:9px"></i>صادرشده</span><span><i style="background:var(--accent);width:9px;height:9px;border-radius:3px;display:inline-block"></i>وصول‌شده</span></div>
    </div>

    <div class="section-title">آخرین پرداخت‌ها</div>
    ${recent ? `<div class="rows">${recent}</div>` : emptyState({ ic: 'wallet', text: 'پرداختی ثبت نشده است' })}

    <div class="section-title">بیشترین بدهی</div>
    ${top ? `<div class="rows">${top}</div>` : emptyState({ ic: 'check', text: 'همه واحدها تسویه هستند' })}
  `;
}

// ---------------------------------------------------------------------------
// Views — Units
// ---------------------------------------------------------------------------
async function viewUnits() {
  const data = await api('/units');
  state.unitsCache = data.units || [];
  return `
    <div class="field" style="margin-bottom:12px">
      <div class="amount-input" style="position:relative">
        <input id="unit-search" placeholder="جستجوی شماره واحد یا نام ساکن..." autocomplete="off" style="padding-right:40px">
        <span style="position:absolute;right:12px;top:50%;transform:translateY(-50%);color:var(--muted)">${icon('search', 17)}</span>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <button class="btn block" id="unit-add">${icon('plus', 17)} افزودن واحد</button>
    </div>
    <div id="unit-rows">${renderUnitRows()}</div>`;
}

function renderUnitRows() {
  const q = enNum(state.filter.units).trim();
  const nq = q.toLowerCase();
  const list = state.unitsCache.filter(u =>
    !q || String(u.number).includes(nq) || String(u.resident_name || '').includes(state.filter.units.trim()));
  if (!list.length) {
    return emptyState({
      ic: 'users',
      text: state.filter.units ? 'نتیجه‌ای یافت نشد' : 'هنوز واحدی ثبت نشده است',
      btnLabel: state.filter.units ? '' : 'افزودن اولین واحد',
      btnId: 'unit-add-empty'
    });
  }
  return `<div class="rows">` + list.map(u => {
    const hasAcc = Boolean(u.has_account);
    return `
    <div class="row clickable" data-action="unit-open" data-id="${u.id}">
      <div class="badge">${esc(faNum(u.number))}</div>
      <div class="mid">
        <div class="t1">${esc(u.resident_name || 'بدون ساکن')}</div>
        <div class="t2">${faNum(u.area_m2)} متر • ${faNum(u.residents_count)} نفر ${hasAcc ? ' • حساب ساکن فعال' : ''}</div>
      </div>
      <div class="end">
        ${u.debt > 0
          ? `<span class="chip unpaid">${fmtMoney(u.debt)}</span>`
          : '<span class="chip paid">تسویه</span>'}
      </div>
    </div>`;
  }).join('') + `</div>`;
}

function mountUnits() {
  const s = $('#unit-search');
  if (s) {
    s.value = state.filter.units;
    s.addEventListener('input', () => {
      state.filter.units = s.value;
      const r = $('#unit-rows');
      if (r) r.innerHTML = renderUnitRows();
      const ae = $('#unit-add-empty');
      if (ae) ae.addEventListener('click', () => openUnitForm());
    });
  }
  const add = $('#unit-add');
  if (add) add.addEventListener('click', () => openUnitForm());
  const addE = $('#unit-add-empty');
  if (addE) addE.addEventListener('click', () => openUnitForm());
}

async function openUnitModal(unitId) {
  const unit = state.unitsCache.find(u => u.id === unitId);
  if (!unit) return;
  const [{ debts }, accRes] = await Promise.all([
    api('/debts?unit_id=' + unitId),
    api('/residents?unit_id=' + unitId).catch(() => ({ residents: [] }))
  ]);
  debts.forEach(x => { state.debtCache[x.id] = x; });
  const acc = (accRes.residents || [])[0] || null;

  const lines = (debts || []).map(x => `
    <div class="debt-line">
      <div class="dl-top">
        <div>
          <div class="dl-desc">${esc(x.description)}</div>
          <div class="dl-sub">${esc(periodLabel(x.period))} • ${fmtMoney(x.paid_amount)} از ${fmtMoney(x.amount)} پرداخت شده${x.method ? ' • ' + esc(x.method) : ''}</div>
        </div>
        ${statusChip(x.status)}
      </div>
      <div class="dl-actions">
        ${x.status !== 'paid' ? `<button class="btn ok sm" data-action="debt-pay" data-id="${x.id}">${icon('wallet', 14)} ثبت پرداخت</button>` : ''}
        ${x.paid_amount > 0 ? `<button class="btn subtle sm" data-action="debt-unpay" data-id="${x.id}">${icon('undo', 14)} لغو پرداخت</button>` : ''}
        <button class="btn danger sm" data-action="debt-del" data-id="${x.id}">${icon('trash', 14)}</button>
      </div>
    </div>`).join('');

  const accountCard = acc ? `
    <div class="card" style="margin-top:12px">
      <div class="kv"><span class="k">حساب کاربری ساکن</span><span class="v" dir="ltr">${esc(acc.username)}</span></div>
      <div class="kv"><span class="k">نام</span><span class="v">${esc(acc.full_name || '—')}</span></div>
      <div class="kv"><span class="k">وضعیت</span><span class="v">${acc.is_active ? '<span class="chip paid">فعال</span>' : '<span class="chip unpaid">غیرفعال</span>'}</span></div>
      <div class="kv"><span class="k">اتصال تلگرام</span><span class="v">${acc.telegram_linked ? `<span class="chip accent">متصل</span>${acc.telegram_username ? ` <span dir="ltr" class="p-muted">@${esc(acc.telegram_username)}</span>` : ''}` : (acc.telegram_username ? `<span class="chip neutral">در انتظار اتصال</span> <span dir="ltr" class="p-muted">@${esc(acc.telegram_username)}</span>` : '<span class="chip neutral">متصل نیست</span>')}</span></div>
      <button class="btn subtle block sm" data-action="resident-manage" data-id="${acc.id}" style="margin-top:8px">${icon('user', 14)} مدیریت حساب ساکن</button>
    </div>` : `
    <button class="btn subtle block" data-action="resident-create" data-unit="${unit.id}" style="margin-top:12px">${icon('user', 16)} ایجاد حساب کاربری برای ساکن</button>`;

  openModal({
    title: unitWord(unit.number),
    body: `
      <div class="card" style="margin-bottom:12px">
        <div class="kv"><span class="k">ساکن</span><span class="v">${esc(unit.resident_name || '—')}</span></div>
        <div class="kv"><span class="k">تلفن</span><span class="v">${esc(faNum(unit.phone || '—'))}</span></div>
        <div class="kv"><span class="k">متراژ</span><span class="v">${faNum(unit.area_m2)} متر</span></div>
        <div class="kv"><span class="k">تعداد ساکنین</span><span class="v">${faNum(unit.residents_count)} نفر</span></div>
        ${unit.note ? `<div class="kv"><span class="k">یادداشت</span><span class="v">${esc(unit.note)}</span></div>` : ''}
      </div>
      ${accountCard}
      <div class="section-title" style="margin-top:14px">اقلام شارژ و هزینه</div>
      ${lines || emptyState({ ic: 'file', text: 'قلمی برای این واحد ثبت نشده است' })}`,
    footer: `
      <button class="btn subtle" data-maction="unit-pdf" data-id="${unit.id}">${icon('download', 16)} صورت‌حساب PDF</button>
      <button class="btn subtle" data-maction="unit-edit" data-id="${unit.id}">${icon('edit', 16)} ویرایش</button>
      <button class="btn danger" data-maction="unit-del" data-id="${unit.id}">${icon('trash', 16)} حذف</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'unit-edit') openUnitForm(unit.id);
        if (act === 'unit-pdf') downloadPdf('statement', { unitId: unit.id });
        if (act === 'unit-del') {
          const okd = await confirmDialog(`${unitWord(unit.number)}، حساب کاربری و تمام اقلام مالی آن حذف شود؟`);
          if (!okd) return;
          try {
            await api('/units/' + unit.id, { method: 'DELETE' });
            haptic('success'); toast('واحد حذف شد', 'ok');
            m.close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }));
    }
  });
}

// --- resident account management -------------------------------------------
function openResidentCreateModal(unit) {
  openModal({
    title: 'حساب ساکن — ' + unitWord(unit.number),
    body: `
      <div class="form-grid">
        <div class="field"><div class="hint">با این نام کاربری و رمز، ساکن وارد اپ می‌شود و فقط وضعیت واحد خودش را می‌بیند.</div></div>
        <div class="field-row">
          <div class="field"><label>نام کاربری *</label>
            <input id="rf-user" dir="ltr" autocapitalize="none" value="unit${esc(enNum(unit.number))}" placeholder="unit5"></div>
          <div class="field"><label>رمز عبور *</label>
            <input id="rf-pass" dir="ltr" placeholder="حداقل ۶ کاراکتر"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>نام ساکن</label>
            <input id="rf-name" value="${esc(unit.resident_name || '')}"></div>
          <div class="field"><label>تلفن</label>
            <input id="rf-phone" inputmode="tel" value="${esc(faNum(unit.phone || ''))}"></div>
        </div>
        <div class="field"><label>یوزرنیم تلگرام (اختیاری)</label>
          <input id="rf-tg" dir="ltr" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. یوزرنیم اختیاری است: اگر ساکن یوزرنیم ندارد، پس از ساخت حساب از دکمه «لینک اتصال تلگرام» یک کد یک‌بارمصرف بگیرید تا با ارسال همان کد به ربات، برای دریافت پیام‌ها متصل شود.</div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('user', 16)} ایجاد حساب</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const username = $('#rf-user', m.el).value.trim();
        const password = $('#rf-pass', m.el).value;
        if (!username || !password) { toast('نام کاربری و رمز عبور الزامی است', 'err'); return; }
        b.disabled = true;
        try {
          await api('/residents', {
            method: 'POST',
            body: {
              username: enNum(username), password,
              unit_id: unit.id,
              full_name: $('#rf-name', m.el).value.trim(),
              phone: enNum($('#rf-phone', m.el).value).trim(),
              telegram_username: $('#rf-tg', m.el).value.trim()
            }
          });
          haptic('success'); toast('حساب ساکن ایجاد شد', 'ok');
          m.close(); refresh();
          setTimeout(() => openUnitModal(unit.id), 200);
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

function openResidentManageModal(acc) {
  const linked = Boolean(acc.telegram_linked);
  openModal({
    title: 'مدیریت حساب ساکن',
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">واحد</span><span class="v">${esc(faNum(unitNo(acc.unit_number)) || '—')}</span></div>
          <div class="kv"><span class="k">وضعیت</span><span class="v">${acc.is_active ? '<span class="chip paid">فعال</span>' : '<span class="chip unpaid">غیرفعال</span>'}</span></div>
          <div class="kv"><span class="k">اتصال تلگرام</span><span class="v">${linked ? '<span class="chip accent">متصل</span>' : (acc.telegram_username ? '<span class="chip neutral">در انتظار اتصال</span>' : '<span class="chip neutral">متصل نیست</span>')}</span></div>
        </div>
        <div class="field"><label>نام کاربری (ورود به اپ)</label><input id="ra-user" dir="ltr" value="${esc(acc.username || '')}" autocapitalize="none">
          <div class="hint">با تغییر نام کاربری، دفعه بعد ساکن با نام جدید وارد می‌شود — حتماً به او بگویید. فقط حروف لاتین/رقم/نقطه/زیرخط (۳ تا ۳۲ کاراکتر) و نباید تکراری باشد.</div>
        </div>
        <div class="field"><label>نام ساکن</label><input id="ra-name" value="${esc(acc.full_name || '')}"></div>
        <div class="field"><label>تلفن</label><input id="ra-phone" inputmode="tel" value="${esc(faNum(acc.phone || ''))}"></div>
        <div class="field"><label>رمز عبور جدید</label><input id="ra-pass" dir="ltr" placeholder="خالی = بدون تغییر"></div>
        <div class="field"><label>یوزرنیم تلگرام</label><input id="ra-tg" dir="ltr" value="${esc(acc.telegram_username ? '@' + acc.telegram_username : '')}" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. یوزرنیم اختیاری است؛ اگر ساکن یوزرنیم تلگرام ندارد، با دکمه «لینک اتصال تلگرام» پایین همین فرم، کد یک‌بارمصرف بگیرید و برایش بفرستید.</div>
        </div>
        ${linked ? `<button class="btn block" data-maction="msg">${icon('send', 15)} ارسال پیام شخصی تلگرام</button>` : ''}
        <button class="btn subtle block" data-maction="linkcode">${icon('link', 15)} لینک اتصال تلگرام (یک‌بارمصرف)</button>
        <div style="display:flex;gap:8px">
          <button class="btn subtle" style="flex:1" data-maction="toggle">${acc.is_active ? 'غیرفعال کردن' : 'فعال کردن'}</button>
          <button class="btn danger" style="flex:1" data-maction="del">${icon('trash', 14)} حذف حساب</button>
        </div>
      </div>`,
    footer: `<button class="btn block" data-maction="save">${icon('check', 16)} ذخیره تغییرات</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'save') {
          b.disabled = true;
          try {
            const body = {
              username: enNum($('#ra-user', m.el).value).trim(),
              full_name: $('#ra-name', m.el).value.trim(),
              phone: enNum($('#ra-phone', m.el).value).trim(),
              telegram_username: $('#ra-tg', m.el).value.trim()
            };
            const pw = $('#ra-pass', m.el).value;
            if (pw) body.password = pw;
            await api('/residents/' + acc.id, { method: 'PUT', body });
            haptic('success'); toast('تغییرات ذخیره شد', 'ok');
            m.close(); refresh();
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        } else if (act === 'msg') {
          openResidentMessageModal(acc);
        } else if (act === 'linkcode') {
          openLinkCodeModal(acc, '/residents/' + acc.id + '/linkcode');
        } else if (act === 'toggle') {
          try {
            await api('/residents/' + acc.id, { method: 'PUT', body: { is_active: !acc.is_active } });
            toast(acc.is_active ? 'حساب غیرفعال شد' : 'حساب فعال شد', 'ok');
            m.close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        } else if (act === 'del') {
          const okd = await confirmDialog('این حساب ساکن حذف شود؟ ساکن دیگر نمی‌تواند وارد شود.');
          if (!okd) return;
          try {
            await api('/residents/' + acc.id, { method: 'DELETE', body: {} });
            toast('حساب حذف شد', 'ok');
            m.close(); refresh();
          } catch (e) { toast(e.message, 'err'); }
        }
      }));
    }
  });
}

// v2.11.9 — کد اتصال تلگرام: one-time code / deep link for people WITHOUT a
// Telegram username. Opening the link (or sending the code to the bot) binds
// message delivery only — it never grants panel access (v2.11.8 locks intact).
// v2.11.10 — اعتبار لینک/کد قابل انتخاب است (۱ ساعت تا ۳۰ روز) و مودال علاوه
// بر لینک و کد، QR Code هم نشان می‌دهد تا ساکن بدون تایپ، ربات را باز کند.
const LINK_TTL_OPTIONS = [
  { h: 1, label: '۱ ساعت' }, { h: 6, label: '۶ ساعت' }, { h: 24, label: '۱ روز' },
  { h: 72, label: '۳ روز' }, { h: 168, label: '۷ روز' }, { h: 360, label: '۱۵ روز' },
  { h: 720, label: '۳۰ روز' }
];
const linkTtlLabel = h => (LINK_TTL_OPTIONS.find(o => o.h === Number(h)) || {}).label || faNum(h) + ' ساعت';

function linkQrSvg(text) {
  try {
    if (typeof window.qrcode !== 'function') return '';
    const qr = window.qrcode(0, 'M'); // 0 = اندازه ماژول‌ها خودکار انتخاب می‌شود
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2 });
  } catch { return ''; }
}

const LINK_SECURITY_HINT = '🔒 امن است: کد یک‌بارمصرف است، فقط «دریافت پیام‌ها و یادآوری‌ها» را وصل می‌کند و هیچ دسترسی ورود به اپ نمی‌دهد؛ با ساخت کد جدید، کد قبلی بی‌اثر می‌شود.';

async function openLinkCodeModal(user, endpoint) {
  const name = esc(user.full_name || user.username);
  const inviteText = 'برای دریافت یادآوری شارژ و پیام‌های مدیر ساختمان، این لینک را باز کنید و START بزنید:';
  let m;

  const statusCard = r => `
    <div class="card" style="padding:10px 12px">
      <div class="kv"><span class="k">کاربر</span><span class="v">${name}</span></div>
      <div class="kv"><span class="k">وضعیت فعلی</span><span class="v">${r.telegram_linked
        ? '<span class="chip accent">متصل</span> <span class="p-muted">— کد قبلی با ساخت این کد باطل می‌شود</span>'
        : '<span class="chip neutral">متصل نیست</span>'}</span></div>
    </div>`;

  const bindCopyShare = (root, link, code) => {
    $$('[data-maction]', root).forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.maction === 'copy') {
        const what = link || code;
        let done = false;
        try { await navigator.clipboard.writeText(what); done = true; } catch { /* fallback below */ }
        if (!done) {
          const ta = document.createElement('textarea');
          ta.value = what; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done = true; } catch { /* give up */ }
          ta.remove();
        }
        if (done) toast(link ? 'لینک اتصال کپی شد' : 'کد اتصال کپی شد', 'ok');
        else toast('کپی خودکار ممکن نشد — متن را دستی انتخاب کنید', 'err');
      } else if (b.dataset.maction === 'share') {
        const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(inviteText);
        const tg = window.Telegram && window.Telegram.WebApp;
        if (tg && typeof tg.openLink === 'function') tg.openLink(shareUrl);
        else window.open(shareUrl, '_blank', 'noopener');
      }
    }));
  };

  const renderConfig = (mo) => {
    const root = (mo || m).el;
    root.querySelector('.sheet-body').innerHTML = `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">کاربر</span><span class="v">${name}</span></div>
          <div class="kv"><span class="k">وضعیت فعلی</span><span class="v">${user.telegram_linked
            ? '<span class="chip accent">متصل</span> <span class="p-muted">— کدهای قبلی با کد جدید باطل می‌شوند</span>'
            : '<span class="chip neutral">متصل نیست</span>'}</span></div>
        </div>
        <div class="field"><label>اعتبار لینک / کد اتصال</label>
          <select id="lc-ttl">${LINK_TTL_OPTIONS.map(o =>
            `<option value="${o.h}"${o.h === 168 ? ' selected' : ''}>${o.label}${o.h === 168 ? ' — پیش‌فرض' : ''}</option>`).join('')}
          </select>
          <div class="hint">پس از انقضای این مدت، لینک و کد دیگر کار نمی‌کنند؛ هر زمان می‌توانید کد تازه‌ای بسازید.</div>
        </div>
        <div class="hint">در گام بعد، لینک + کد ۸ نویسی + QR Code ساخته می‌شود؛ QR را برای ساکن بفرستید تا با دوربین گوشی ربات را باز کند — بدون نیاز به یوزرنیم تلگرام.</div>
        <div class="hint">🔒 کد فقط «دریافت پیام‌ها و یادآوری‌ها» را وصل می‌کند و هیچ دسترسی ورود به اپ نمی‌دهد.</div>
      </div>`;
    root.querySelector('.sheet-foot').innerHTML = `
      <button class="btn subtle" data-maction="cancel">انصراف</button>
      <button class="btn accent" data-maction="go">${icon('link', 15)} ساخت لینک اتصال</button>`;
    $$('[data-maction]', root).forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.maction === 'cancel') { m.close(); return; }
      if (b.dataset.maction !== 'go') return;
      const ttl = enNum($('#lc-ttl', root).value);
      b.disabled = true;
      let r;
      try {
        r = await api(endpoint, { method: 'POST', body: { ttl_hours: Number(ttl) } });
      } catch (e) { toast(e.message, 'err'); b.disabled = false; return; }
      haptic('success');
      renderResult(r);
    }));
  };

  const renderResult = (r, mo) => {
    const root = (mo || m).el;
    const code = String(r.code || '');
    const link = String(r.link || '');
    const ttl = linkTtlLabel(r.ttl_hours || 168);
    const expMs = Number(r.expires_at) > 1e12 ? Number(r.expires_at) : Number(r.expires_at) * 1000;
    const qr = link ? linkQrSvg(link) : '';
    m.el.querySelector('.sheet-body').innerHTML = `
      <div class="form-grid">
        ${qr ? `
        <div class="field" style="text-align:center">
          <div style="display:inline-block;background:#fff;padding:10px;border-radius:12px;line-height:0;max-width:100%">${qr}</div>
          <div class="hint">QR Code — با دوربین گوشی اسکن کنید تا ربات باز شود؛ سپس START بزنید.</div>
        </div>` : ''}
        ${statusCard(r)}
        ${link ? `
        <div class="field"><label>لینک اتصال (یک‌بارمصرف — اعتبار ${ttl})</label>
          <div class="card" dir="ltr" style="padding:10px;word-break:break-all;user-select:all;font-size:12px">${esc(link)}</div>
        </div>` : ''}
        <div class="field"><label>کد اتصال (جایگزین لینک)</label>
          <div class="card" dir="ltr" style="padding:12px;text-align:center;font-size:22px;letter-spacing:5px;user-select:all"><b>${esc(code)}</b></div>
          <div class="hint">ساکن کافی است ربات را باز کند و همین کد را در چت بفرستد — بدون نیاز به یوزرنیم تلگرام. به‌محض ارسال کد، اتصال انجام می‌شود.</div>
        </div>
        <div class="hint">⏳ اعتبار این کد: <b>${ttl}</b> — تا ${formatJalaliDateTime(expMs)}</div>
        <div class="hint">${LINK_SECURITY_HINT}</div>
      </div>`;
    root.querySelector('.sheet-foot').innerHTML = `
      <button class="btn subtle" data-maction="regen">${icon('refresh', 15)} کد جدید</button>
      <button class="btn subtle" data-maction="copy">${icon('file', 16)} ${link ? 'کپی لینک' : 'کپی کد'}</button>
      ${link ? `<button class="btn accent" data-maction="share">${icon('send', 16)} ارسال در تلگرام</button>` : ''}`;
    $$('[data-maction="regen"]', root).forEach(b => b.addEventListener('click', () => renderConfig()));
    bindCopyShare(root, link, code);
  };

  m = openModal({
    title: 'لینک اتصال تلگرام',
    body: '<div style="min-height:120px"></div>',
    footer: '<span hidden></span>', // ظرف foot باید از ابتدا موجود باشد — محتوا در renderConfig/renderResult عوض می‌شود
    onMount: mo => { m = mo; renderConfig(mo); }
  });
}

// Personal Telegram message to one resident (building-manager panel).
function openResidentMessageModal(acc) {
  openModal({
    title: 'پیام شخصی تلگرام — ' + (acc.full_name || acc.username),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">گیرنده</span><span class="v" dir="ltr">${esc(acc.telegram_username ? '@' + acc.telegram_username : acc.username)}</span></div>
          <div class="kv"><span class="k">وضعیت اتصال</span><span class="v"><span class="chip accent">متصل — پیام از طریق ربات ارسال می‌شود</span></span></div>
        </div>
        <div class="field"><label>متن پیام *</label>
          <textarea id="pm-text" rows="4" placeholder="مثلاً: سلام، لطفاً شارژ این ماه را تا پایان هفته تسویه کنید 🙏"></textarea>
          <div class="hint">نام ساختمان به‌طور خودکار بالای پیام درج می‌شود.</div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">${icon('send', 15)} ارسال پیام</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const text = $('#pm-text', m.el).value.trim();
        if (!text) { toast('متن پیام را وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          await api('/residents/' + acc.id + '/message', { method: 'POST', body: { text } });
          haptic('success');
          toast('پیام شخصی برای ' + (acc.full_name || acc.username) + ' ارسال شد', 'ok');
          m.close();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

function openUnitForm(unitId) {
  const u = unitId ? state.unitsCache.find(x => x.id === unitId) : null;
  const isNew = !u;
  openModal({
    title: isNew ? 'افزودن واحد' : 'ویرایش ' + unitWord(u.number),
    body: `
      <div class="form-grid">
        <div class="field-row">
          <div class="field"><label>شماره واحد *</label>
            <input id="uf-number" inputmode="numeric" value="${u ? esc(unitNo(u.number)) : ''}" placeholder="مثلاً 5">
            <div class="hint">فقط شماره را بنویسید (مثلاً 5) — کلمه «واحد» لازم نیست.</div>
          </div>
          <div class="field"><label>نام ساکن</label>
            <input id="uf-name" value="${u ? esc(u.resident_name) : ''}" placeholder="نام و نام خانوادگی"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>تلفن همراه</label>
            <input id="uf-phone" inputmode="tel" value="${u ? esc(faNum(u.phone)) : ''}" placeholder="09xxxxxxxxx"></div>
          <div class="field"><label>متراژ (متر مربع)</label>
            <input id="uf-area" inputmode="decimal" value="${u ? faNum(u.area_m2) : ''}" placeholder="100"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>تعداد ساکنین</label>
            <input id="uf-res" inputmode="numeric" value="${u ? faNum(u.residents_count) : '1'}"></div>
          <div class="field"><label>یادداشت</label>
            <input id="uf-note" value="${u ? esc(u.note) : ''}" placeholder="اختیاری"></div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="save">${isNew ? 'افزودن' : 'ذخیره'}</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const number = enNum($('#uf-number', m.el).value).trim();
        if (!number) { toast('شماره واحد الزامی است', 'err'); return; }
        const payload = {
          number,
          resident_name: $('#uf-name', m.el).value.trim(),
          phone: enNum($('#uf-phone', m.el).value).trim(),
          area_m2: parseNum($('#uf-area', m.el).value),
          residents_count: Math.max(1, parseNum($('#uf-res', m.el).value) || 1),
          note: $('#uf-note', m.el).value.trim()
        };
        b.disabled = true;
        try {
          if (isNew) await api('/units', { method: 'POST', body: payload });
          else await api('/units/' + u.id, { method: 'PUT', body: payload });
          haptic('success'); toast(isNew ? 'واحد افزوده شد' : 'ذخیره شد', 'ok');
          m.close(); refresh();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Views — Charges (period ledger)
// ---------------------------------------------------------------------------
async function viewCharges() {
  const [debtsRes, dash] = await Promise.all([
    api('/debts?period=' + state.period),
    api('/dashboard?period=' + state.period)
  ]);
  const debts = debtsRes.debts || [];
  debts.forEach(x => { state.debtCache[x.id] = x; });
  const f = state.filter.charges;
  const list = debts.filter(x => f === 'all' || (f === 'unpaid' ? x.status !== 'paid' : x.status === 'paid'));

  const rows = list.map(x => `
    <div class="row">
      <div class="badge">${esc(faNum(unitNo(x.unit_number)))}</div>
      <div class="mid">
        <div class="t1">${esc(x.resident_name || unitWord(x.unit_number))}</div>
        <div class="t2">${esc(x.description)}</div>
      </div>
      <div class="end">
        <span class="amount">${fmtMoney(x.amount)}</span>
        ${statusChip(x.status)}
      </div>
    </div>
    ${x.status !== 'paid' ? `<div style="display:flex;gap:8px;margin:-4px 0 8px;padding:0 4px">
      <button class="btn ok sm" data-action="debt-pay" data-id="${x.id}">${icon('wallet', 14)} ثبت پرداخت</button>
      ${x.paid_amount > 0 ? `<button class="btn subtle sm" data-action="debt-unpay" data-id="${x.id}">${icon('undo', 14)} لغو پرداخت</button>` : ''}
      <button class="btn danger sm" data-action="debt-del" data-id="${x.id}">${icon('trash', 14)}</button>
    </div>` : ''}`).join('');

  const rate = dash.month.issued ? Math.round(dash.month.collected / dash.month.issued * 100) : 0;

  return `
    ${stepperHTML({ id: 'charges-stepper', period: state.period })}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted)">
        <span>صادرشده: <b style="color:var(--text)">${fmtNum(dash.month.issued)}</b></span>
        <span>وصول‌شده: <b style="color:var(--ok)">${fmtNum(dash.month.collected)}</b></span>
        <span>مانده: <b style="color:var(--danger)">${fmtNum(dash.month.issued - dash.month.collected)}</b></span>
      </div>
      <div class="progress" style="margin-top:9px"><i style="width:${rate}%"></i></div>
    </div>
    <button class="btn block" data-action="gen-open" style="margin-bottom:12px">${icon('plus', 17)} صدور شارژ برای همه واحدها</button>
    <div class="filter-row">
      ${[['all', 'همه'], ['unpaid', 'پرداخت‌نشده'], ['paid', 'تسویه‌شده']].map(([v, l]) =>
        `<button class="fchip ${f === v ? 'on' : ''}" data-cfilter="${v}">${l}</button>`).join('')}
    </div>
    ${rows || emptyState({
      ic: 'card',
      text: f === 'all' ? 'برای این ماه شارژی صادر نشده است' : 'موردی در این دسته نیست',
      // v2.11.3: the empty-state button was rendered with an empty id and no
      // handler — it looked clickable but did nothing. Give it an id and bind
      // openGenerateModal in mountCharges so «صدور شارژ ماه» works again.
      btnLabel: f === 'all' ? 'صدور شارژ ماه' : '', btnId: 'gen-empty'
    })}
  `;
}

function mountCharges() {
  bindStepper('charges-stepper', dir => {
    state.period = dir === 0 ? localPeriod() : addPeriods(state.period, dir);
    navigate('charges');
  });
  $$('[data-cfilter]').forEach(b => b.addEventListener('click', () => {
    state.filter.charges = b.dataset.cfilter;
    navigate('charges');
  }));
  const genEmpty = $('#gen-empty');
  if (genEmpty) genEmpty.addEventListener('click', openGenerateModal);
}

async function openGenerateModal() {
  if (!state.unitsCache.length) {
    try { state.unitsCache = (await api('/units')).units || []; } catch { /* ignore */ }
  }
  const modes = [
    ['fixed', 'مبلغ ثابت', 'برای هر واحد'],
    ['area', 'بر اساس متراژ', 'هر متر مربع'],
    ['person', 'بر اساس نفرات', 'هر نفر']
  ];
  let mode = 'fixed';
  // v2.11.3: scope — «همه واحدها» (old behaviour) or «انتخاب واحدها» so the
  // month's charge can be issued for just one or several selected units.
  let scope = 'all';
  const picked = new Set();
  const units = state.unitsCache.length ? state.unitsCache : null;
  const unitChips = (units || []).map(u =>
    `<button class="fchip" data-uid="${u.id}">${esc(faNum(unitNo(u.number)))}${u.resident_name ? ' • ' + esc(u.resident_name) : ''}</button>`
  ).join('');
  openModal({
    title: 'صدور شارژ ' + periodLabel(state.period),
    body: `
      <div class="form-grid">
        <div class="field"><label>دامنه صدور</label>
          <div class="radio-cards two" id="gen-scope">
            <button class="rcard on" data-scope="all">همه واحدها<small>صدور برای کل ساختمان</small></button>
            <button class="rcard" data-scope="pick">انتخاب واحدها<small>یک یا چند واحد</small></button>
          </div>
          <div id="gen-pick" hidden>
            <div class="unit-pick" id="gen-units">${unitChips}</div>
            <div class="pick-bar">
              <button class="btn ghost sm" id="gen-pick-all">${icon('check', 13)} انتخاب همه</button>
              <button class="btn ghost sm" id="gen-pick-none">${icon('x', 13)} هیچ‌کدام</button>
            </div>
          </div>
        </div>
        <div class="field"><label>روش محاسبه</label>
          <div class="radio-cards" id="gen-modes">
            ${modes.map(([v, t, s], i) => `<button class="rcard ${i === 0 ? 'on' : ''}" data-mode="${v}">${t}<small>${s}</small></button>`).join('')}
          </div>
        </div>
        ${moneyField({ id: 'gen-amount', label: 'مبلغ', value: state.settings.default_monthly_amount ? Number(state.settings.default_monthly_amount).toLocaleString('en-US') : '' })}
        <div class="field"><div class="hint" id="gen-preview"></div></div>
        <div class="field"><div class="hint">اقلامی که قبلاً برای این ماه صادر شده‌اند دوباره صادر نمی‌شوند.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('plus', 16)} صدور</button>`,
    onMount(m) {
      const defaultAmt = Number(state.settings.default_monthly_amount) || 0;
      const effUnits = () => (!units || !units.length) ? []
        : (scope === 'all' ? units : units.filter(u => picked.has(u.id)));
      const preview = () => {
        const amt = parseNum($('#gen-amount', m.el).value);
        if (!units || !units.length) { $('#gen-preview', m.el).textContent = 'ابتدا از تب «واحدها» واحد ثبت کنید.'; return; }
        const list = effUnits();
        if (scope === 'pick' && !list.length) { $('#gen-preview', m.el).textContent = 'حداقل یک واحد را انتخاب کنید.'; return; }
        const n = list.length;
        if (mode === 'fixed') $('#gen-preview', m.el).textContent = `${faNum(n)} واحد × ${fmtNum(amt)} = ${fmtNum(amt * n)} تومان`;
        else if (mode === 'person') {
          const rc = list.reduce((s, u) => s + (u.residents_count || 1), 0);
          $('#gen-preview', m.el).textContent = `${faNum(rc)} نفر × ${fmtNum(amt)} = ${fmtNum(amt * rc)} تومان`;
        } else {
          const area = list.reduce((s, u) => s + (u.area_m2 || 0), 0);
          $('#gen-preview', m.el).textContent = `${faNum(area)} متر × ${fmtNum(amt)} = ${fmtNum(Math.round(amt * area))} تومان`;
        }
      };
      const applyMode = () => {
        const lbl = $('label[for="gen-amount"]', m.el);
        if (mode === 'fixed') {
          if (lbl) lbl.textContent = 'مبلغ هر واحد *';
          $('#gen-amount', m.el).value = defaultAmt ? defaultAmt.toLocaleString('en-US') : '';
        } else if (mode === 'area') {
          if (lbl) lbl.textContent = 'مبلغ هر متر مربع *';
          const list = effUnits();
          const avg = list.length ? list.reduce((s, u) => s + (u.area_m2 || 0), 0) / list.length : 0;
          const per = avg && defaultAmt ? Math.round(defaultAmt / avg / 1000) * 1000 : 0;
          $('#gen-amount', m.el).value = per ? per.toLocaleString('en-US') : '';
        } else {
          if (lbl) lbl.textContent = 'مبلغ هر نفر *';
          const list = effUnits();
          const avg = list.length ? list.reduce((s, u) => s + (u.residents_count || 1), 0) / list.length : 0;
          const per = avg && defaultAmt ? Math.round(defaultAmt / avg / 1000) * 1000 : 0;
          $('#gen-amount', m.el).value = per ? per.toLocaleString('en-US') : '';
        }
        preview();
      };
      applyMode();
      bindMoneyInputs(m.el);
      $('#gen-amount', m.el).addEventListener('input', preview);
      $$('#gen-modes .rcard', m.el).forEach(b => b.addEventListener('click', () => {
        mode = b.dataset.mode;
        $$('#gen-modes .rcard', m.el).forEach(x => x.classList.toggle('on', x === b));
        applyMode();
      }));
      // v2.11.3: scope switch + multi-select unit chips
      $$('#gen-scope .rcard', m.el).forEach(b => b.addEventListener('click', () => {
        scope = b.dataset.scope;
        $$('#gen-scope .rcard', m.el).forEach(x => x.classList.toggle('on', x === b));
        $('#gen-pick', m.el).hidden = scope !== 'pick';
        preview();
      }));
      $$('#gen-units .fchip', m.el).forEach(b => b.addEventListener('click', () => {
        const id = Number(b.dataset.uid);
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        b.classList.toggle('on', picked.has(id));
        preview();
      }));
      $('#gen-pick-all', m.el).addEventListener('click', () => {
        (units || []).forEach(u => picked.add(u.id));
        $$('#gen-units .fchip', m.el).forEach(b => b.classList.add('on'));
        preview();
      });
      $('#gen-pick-none', m.el).addEventListener('click', () => {
        picked.clear();
        $$('#gen-units .fchip', m.el).forEach(b => b.classList.remove('on'));
        preview();
      });
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#gen-amount', m.el).value);
        if (amount <= 0) { toast('مبلغ را وارد کنید', 'err'); return; }
        if (scope === 'pick' && !picked.size) { toast('حداقل یک واحد را انتخاب کنید', 'err'); return; }
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const body = { period: state.period, mode, amount };
          if (scope === 'pick') body.unit_ids = [...picked];
          const res = await api('/charges/generate', { method: 'POST', body });
          haptic('success');
          let msg = `${faNum(res.created)} قلم شارژ صادر شد`;
          if (res.skipped) msg += ` (${faNum(res.skipped)} واحد قبلاً صادر شده)`;
          toast(msg, 'ok');
          if (res.no_area && res.no_area.length) toast('واحدهای بدون متراژ رد شدند: ' + res.no_area.join('، '), 'info');
          m.close(); navigate('charges');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'صدور'; }
      }));
    }
  });
}

async function openPayModal(debtId, onDone) {
  const debt = state.debtCache[debtId];
  if (!debt) return;
  const remaining = debt.amount - debt.paid_amount;
  openModal({
    title: 'ثبت پرداخت — ' + unitWord(debt.unit_number),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">شرح</span><span class="v">${esc(debt.description)}</span></div>
          <div class="kv"><span class="k">مبلغ کل</span><span class="v">${fmtMoney(debt.amount)}</span></div>
          <div class="kv"><span class="k">مانده</span><span class="v" style="color:var(--danger)">${fmtMoney(remaining)}</span></div>
        </div>
        ${moneyField({ id: 'pay-amount', label: 'مبلغ پرداخت', value: remaining.toLocaleString('en-US') })}
        <div class="field"><label>روش پرداخت</label>
          <select id="pay-method">
            <option>کارت به کارت</option><option>نقدی</option><option>پایا</option><option>سایر</option>
          </select></div>
        <div class="field"><label>تاریخ پرداخت</label>${jalaaliDateFields({ prefix: 'pay-date' })}</div>
        <div class="field"><label>یادداشت</label><input id="pay-note" placeholder="اختیاری"></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn ok" data-maction="go">${icon('check', 16)} ثبت پرداخت</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#pay-amount', m.el).value);
        if (amount <= 0) { toast('مبلغ را وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          await api(`/debts/${debtId}/pay`, {
            method: 'POST',
            body: {
              amount,
              method: $('#pay-method', m.el).value,
              date: readJalaaliDate('pay-date'),
              note: $('#pay-note', m.el).value.trim()
            }
          });
          haptic('success');
          toast('پرداخت ثبت شد', 'ok');
          m.close();
          if (onDone) onDone(); else navigate(state.view);
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Views — Expenses
// ---------------------------------------------------------------------------
async function viewExpenses() {
  const res = await api('/expenses?period=' + state.period);
  const list = res.expenses || [];
  const total = list.reduce((s, e) => s + e.amount, 0);
  const rows = list.map(e => `
    <div class="row">
      <div class="badge gray">${icon('pie')}</div>
      <div class="mid">
        <div class="t1">${esc(e.title)}</div>
        <div class="t2">${esc(e.category)} • سرانه ${faNum(e.share_count)} واحد • ${e.split_mode === 'area' ? 'به نسبت متراژ' : 'مساوی'}</div>
        <div class="t2">وصول‌شده: ${fmtMoney(e.collected)}</div>
      </div>
      <div class="end">
        <span class="amount">${fmtMoney(e.amount)}</span>
        <button class="btn danger sm" data-action="exp-del" data-id="${e.id}">${icon('trash', 13)} حذف</button>
      </div>
    </div>`).join('');

  return `
    ${stepperHTML({ id: 'exp-stepper', period: state.period })}
    <div class="card" style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:13px;color:var(--muted)">مجموع هزینه‌های ${esc(periodLabel(state.period))}</span>
      <b>${fmtMoney(total)}</b>
    </div>
    <button class="btn block" data-action="exp-add" style="margin-bottom:12px">${icon('plus', 17)} ثبت هزینه مشترک</button>
    ${rows || emptyState({ ic: 'pie', text: 'هزینه‌ای برای این ماه ثبت نشده است', btnLabel: 'ثبت اولین هزینه', btnId: 'exp-add-empty' })}
    <div class="field" style="margin-top:14px"><div class="hint">با ثبت هر هزینه، سهم هر واحد به‌صورت خودکار محاسبه و به لیست بدهی واحدها اضافه می‌شود.</div></div>
  `;
}

function mountExpenses() {
  bindStepper('exp-stepper', dir => {
    state.period = dir === 0 ? localPeriod() : addPeriods(state.period, dir);
    navigate('expenses');
  });
  const e = $('#exp-add-empty');
  if (e) e.addEventListener('click', openExpenseModal);
}

function openExpenseModal() {
  const cats = ['نظافت', 'برق', 'آب', 'گاز', 'آسانسور', 'نگهبانی', 'تعمیرات', 'بازیافت', 'سایر'];
  let split = 'equal';
  openModal({
    title: 'ثبت هزینه مشترک',
    body: `
      <div class="form-grid">
        <div class="field"><label>عنوان هزینه *</label><input id="ex-title" placeholder="مثلاً: قبض برق مشترک"></div>
        <div class="field-row">
          <div class="field"><label>دسته‌بندی</label>
            <select id="ex-cat">${cats.map(c => `<option>${c}</option>`).join('')}</select></div>
          <div class="field"><label>ماه</label>
            <input id="ex-period" value="${faNum(state.period)}" readonly style="opacity:.7"></div>
        </div>
        ${moneyField({ id: 'ex-amount', label: 'مبلغ کل' })}
        <div class="field"><label>روش تقسیم بین واحدها</label>
          <div class="seg" id="ex-split">
            <button class="on" data-s="equal">مساوی بین همه</button>
            <button data-s="area">به نسبت متراژ</button>
          </div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('check', 16)} ثبت و تقسیم</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('#ex-split button', m.el).forEach(b => b.addEventListener('click', () => {
        split = b.dataset.s;
        $$('#ex-split button', m.el).forEach(x => x.classList.toggle('on', x === b));
      }));
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const title = $('#ex-title', m.el).value.trim();
        const amount = parseNum($('#ex-amount', m.el).value);
        if (!title) { toast('عنوان هزینه را وارد کنید', 'err'); return; }
        if (amount <= 0) { toast('مبلغ را وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          const res = await api('/expenses', {
            method: 'POST',
            body: { title, category: $('#ex-cat', m.el).value, amount, period: state.period, split_mode: split }
          });
          haptic('success');
          toast(`هزینه بین ${faNum(res.share_count)} واحد تقسیم شد`, 'ok');
          m.close(); navigate('expenses');
        } catch (e2) { toast(e2.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Views — Polls (نظرسنجی) — manager manages; unit-linked users vote
// ---------------------------------------------------------------------------
// Defensive normalizer — backend/demo must send options/counts as arrays, but a
// malformed response must never crash the whole tab with a JS error.
function normalizePoll(p) {
  let options = p.options;
  if (!Array.isArray(options)) {
    try { options = JSON.parse(options) || []; } catch { options = []; }
  }
  if (!Array.isArray(options)) options = [];
  const counts = (Array.isArray(p.counts) && p.counts.length === options.length)
    ? p.counts : options.map(() => 0);
  return { ...p, options, counts };
}

function pollCard(p, { canVote = false, canManage = false } = {}) {
  const total = p.total_votes || 0;
  const open = p.status === 'open';
  const myVote = p.my_vote ?? null;
  const options = (p.options || []).map((opt, i) => {
    const n = (p.counts || [])[i] || 0;
    const pct = total ? Math.round(n / total * 100) : 0;
    const mine = myVote === i;
    const voteBtn = (canVote && open && !mine)
      ? `<button class="btn ok sm" data-action="poll-vote" data-poll="${p.id}" data-opt="${i}">${icon('check', 13)} رأی</button>` : '';
    return `
      <div class="poll-opt ${mine ? 'mine' : ''}" data-action="${canVote && open && !mine ? 'poll-vote' : 'noop'}" data-poll="${p.id}" data-opt="${i}" role="button">
        <div class="po-top">
          <span class="po-label">${esc(opt)}${mine ? ' <span class="chip accent">رأی شما</span>' : ''}</span>
          <span class="po-meta">${faNum(n)} رأی • ${faNum(pct)}٪</span>
        </div>
        <div class="po-bar"><i style="width:${pct}%"></i></div>
        ${voteBtn}
      </div>`;
  }).join('');

  const manage = canManage ? `
    <div style="display:flex;gap:8px;margin-top:10px">
      ${open
        ? `<button class="btn subtle sm" data-action="poll-close" data-poll="${p.id}">${icon('check', 14)} بستن نظرسنجی</button>`
        : `<button class="btn subtle sm" data-action="poll-reopen" data-poll="${p.id}">${icon('refresh', 14)} بازکردن مجدد</button>`}
      <button class="btn danger sm" data-action="poll-del" data-poll="${p.id}">${icon('trash', 14)} حذف</button>
    </div>` : '';

  return `
    <div class="card poll-card" style="margin-bottom:12px">
      <div class="po-head">
        <div class="poll-q">${esc(p.question)}</div>
        <span class="chip ${open ? 'accent' : 'neutral'}">${open ? 'فعال' : 'بسته'}</span>
      </div>
      ${options}
      <div class="hint" style="margin-top:8px">جمع آرا: ${faNum(total)} رأی — هر واحد یک رأی</div>
      ${manage}
    </div>`;
}

async function viewPolls() {
  const { polls } = await api('/polls');
  state._polls = (polls || []).map(normalizePoll);
  const open = state._polls.filter(p => p.status === 'open');
  const closed = state._polls.filter(p => p.status !== 'open');
  const canVote = Boolean(state.unit);
  return `
    <button class="btn block" data-action="poll-new" style="margin-bottom:14px">${icon('plus', 17)} نظرسنجی جدید</button>
    ${open.length ? `<div class="section-title">نظرسنجی‌های فعال</div>${open.map(p => pollCard(p, { canVote, canManage: true })).join('')}` : ''}
    ${closed.length ? `<div class="section-title">بسته‌شده</div>${closed.map(p => pollCard(p, { canVote: false, canManage: true })).join('')}` : ''}
    ${!(state._polls).length ? emptyState({ ic: 'poll', text: 'هنوز نظرسنجی‌ای نساخته‌اید', btnLabel: 'ساخت اولین نظرسنجی', btnId: 'poll-new-empty' }) : ''}
    <div class="field" style="margin-top:6px"><div class="hint">هر واحد یک رأی دارد. ساکنین در نمای «وضعیت من» نظرسنجی‌ها را می‌بینند و می‌توانند رأی بدهند.</div></div>
  `;
}

function mountPolls() {
  const b = $('#poll-new-empty');
  if (b) b.addEventListener('click', openPollForm);
}

function openPollForm() {
  openModal({
    title: 'نظرسنجی جدید',
    body: `
      <div class="form-grid">
        <div class="field"><label>سؤال *</label>
          <input id="pl-q" placeholder="مثلاً: رنگ نمای ساختمان چه باشد؟"></div>
        <div class="field"><label>گزینه‌ها (حداقل دو گزینه، هر گزینه در یک خط) *</label>
          <textarea id="pl-opts" placeholder="آبی&#10;کرم&#10;خاکستری"></textarea></div>
        <div class="field"><div class="hint">هر واحد یک رأی می‌دهد. نتیجه برای همه ساکنین نمایش داده می‌شود.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('poll', 16)} ایجاد نظرسنجی</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const question = $('#pl-q', m.el).value.trim();
        const options = $('#pl-opts', m.el).value.split('\n').map(x => x.trim()).filter(Boolean);
        if (!question) { toast('سؤال را وارد کنید', 'err'); return; }
        if (options.length < 2) { toast('حداقل دو گزینه وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          await api('/polls', { method: 'POST', body: { question, options } });
          haptic('success'); toast('نظرسنجی ساخته شد', 'ok');
          m.close(); navigate('polls');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

async function pollVote(pollId, optIdx) {
  const okd = await confirmDialog('این گزینه به‌عنوان رأی واحد شما ثبت شود؟ (رأی قبلی جایگزین می‌شود)');
  if (!okd) return;
  try {
    await api(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: optIdx } });
    haptic('success'); toast('رأی شما ثبت شد', 'ok');
    if (state.role === 'manager' && state.view === 'polls') navigate('polls');
    else if (state.view === 'my') navigate('my');
    else refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// Views — Reports (tables shared with admin view; manager tools manager-only)
// ---------------------------------------------------------------------------
async function viewReports() {
  const isManager = state.role === 'manager';
  // auto-reminder config loads together with the report (manager only; failure-tolerant)
  const [rep, arRes] = await Promise.all([
    api('/reports/year?jy=' + state.jy),
    isManager ? api('/autoremind').catch(() => null) : Promise.resolve(null)
  ]);
  state.autoRemind = arRes;
  const months = Array.from({ length: 12 }, (_, i) => `${state.jy}-${String(i + 1).padStart(2, '0')}`);
  const sMap = {};
  (rep.series || []).forEach(s => { sMap[s.period] = s; });
  let tI = 0, tC = 0;
  const trs = months.map(p => {
    const s = sMap[p] || { issued: 0, collected: 0 };
    tI += s.issued; tC += s.collected;
    const rem = s.issued - s.collected;
    return `<tr>
      <td>${periodLabel(p)}</td>
      <td class="num">${fmtNum(s.issued)}</td>
      <td class="num" style="color:var(--ok)">${fmtNum(s.collected)}</td>
      <td class="num" style="color:${rem > 0 ? 'var(--danger)' : 'var(--muted)'}">${fmtNum(rem)}</td>
    </tr>`;
  }).join('');

  const unitRows = (rep.by_unit || []).map(u => {
    const rem = u.issued - u.paid;
    return `<tr>
      <td>${esc(faNum(u.number))}</td>
      <td>${esc(u.resident_name || '—')}</td>
      <td class="num">${fmtNum(u.issued)}</td>
      <td class="num" style="color:var(--ok)">${fmtNum(u.paid)}</td>
      <td class="num" style="color:${rem > 0 ? 'var(--danger)' : 'var(--muted)'}">${fmtNum(rem)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="stepper" id="year-stepper">
      <button class="st-btn" data-yd="1" aria-label="سال بعد">${icon('chevr')}</button>
      <div class="p-label"><span>سال ${faNum(state.jy)}</span><small>خلاصه عملکرد سالانه</small></div>
      <button class="st-btn" data-yd="-1" aria-label="سال قبل">${icon('chevl')}</button>
    </div>

    <div class="section-title">روند ماهانه</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>ماه</th><th>صادرشده</th><th>وصول‌شده</th><th>مانده</th></tr></thead>
      <tbody>${trs}
        <tr class="total"><td>جمع سال</td><td>${fmtNum(tI)}</td><td>${fmtNum(tC)}</td><td>${fmtNum(tI - tC)}</td></tr>
      </tbody></table></div>

    <div class="section-title">وضعیت واحدها</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>واحد</th><th>ساکن</th><th>صادرشده</th><th>وصول</th><th>مانده</th></tr></thead>
      <tbody>${unitRows}</tbody></table></div>

    <button class="btn block" data-action="pdf-report" style="margin-top:14px">${icon('download', 17)} دانلود گزارش سالانه (PDF)</button>

    ${isManager ? `
    <div class="section-title">یادآوری و اعلان</div>
    <div class="rows">
      <div class="row">
        <div class="badge gray">${icon('bell')}</div>
        <div class="mid"><div class="t1">یادآوری بدهی</div><div class="t2">ارسال پیام خودکار به واحدهای بدهکار</div></div>
        <button class="btn ghost sm" data-action="remind">ارسال</button>
      </div>
      <div class="row">
        <div class="badge gray">${icon('refresh')}</div>
        <div class="mid"><div class="t1">یادآوری خودکار ماهانه</div><div class="t2">${arLineText(state.autoRemind)}</div></div>
        <button class="btn ghost sm" data-action="autoremind">تنظیم</button>
      </div>
      <div class="row">
        <div class="badge gray">${icon('send')}</div>
        <div class="mid"><div class="t1">اعلان همگانی</div><div class="t2">ارسال پیام به همه ساکنین متصل</div></div>
        <button class="btn ghost sm" data-action="announce">ارسال</button>
      </div>
    </div>

    <div class="section-title">خروجی و پشتیبان</div>
    <div class="hint" style="margin-bottom:10px">در تلگرام، فایل در مرورگر باز می‌شود و دانلود آنجا انجام می‌گیرد — پس از دریافت به تلگرام برگردید.</div>
    <div class="rows">
      <button class="btn subtle block" data-action="export" data-type="debtors">${icon('download', 16)} فایل CSV بدهکاران</button>
      <button class="btn subtle block" data-action="export" data-type="year">${icon('download', 16)} فایل CSV خلاصه سال ${faNum(state.jy)}</button>
      <button class="btn subtle block" data-action="export" data-type="backup">${icon('db', 16)} پشتیبان کامل (JSON)</button>
      <button class="btn subtle block" data-action="import-backup">${icon('upload', 16)} بازیابی پشتیبان (JSON)</button>
      <input id="import-file" type="file" accept=".json,application/json" hidden>
    </div>` : ''}
  `;
}

function mountReports() {
  const el = $('#year-stepper');
  if (el) $$('[data-yd]', el).forEach(b => b.addEventListener('click', () => {
    state.jy = String(Number(state.jy) + Number(b.dataset.yd));
    navigate('reports');
  }));
  const inp = $('#import-file');
  if (inp) inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) importBackupFile(f);
  });
}

// ---------------------------------------------------------------------------
// Import backup (بازیابی پشتیبان JSON) — v2.11.0
// Reads the file, validates the shape, shows a summary + strong warning and
// only after explicit confirmation POSTs it to /import (atomic restore).
// ---------------------------------------------------------------------------
async function importBackupFile(file) {
  if (file.size > 12 * 1024 * 1024) { toast('حجم فایل بیش از حد مجاز است (حداکثر ۱۲ مگابایت)', 'err'); return; }
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { toast('فایل JSON معتبر نیست', 'err'); return; }
  if (!payload || payload.app !== 'building-charges' || !Array.isArray(payload.units)) {
    toast('این فایل پشتیبانِ همین اپ نیست', 'err');
    return;
  }
  const n = x => faNum(Number((x || []).length));
  const expAt = payload.exported_at
    ? new Date(payload.exported_at).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' })
    : '—';
  openModal({
    title: 'بازیابی پشتیبان',
    body: `
      <div class="card" style="padding:10px 12px;margin-bottom:10px">
        <div class="kv"><span class="k">تاریخ پشتیبان</span><span class="v">${esc(expAt)}</span></div>
        <div class="kv"><span class="k">واحدها</span><span class="v">${n(payload.units)}</span></div>
        <div class="kv"><span class="k">شارژها</span><span class="v">${n(payload.debts)}</span></div>
        <div class="kv"><span class="k">هزینه‌ها</span><span class="v">${n(payload.expenses)}</span></div>
        <div class="kv"><span class="k">حساب‌های اپ</span><span class="v">${n(payload.users)}</span></div>
        <div class="kv"><span class="k">نظرسنجی‌ها</span><span class="v">${n(payload.polls)}</span></div>
      </div>
      <div class="hint" style="color:var(--danger)">⚠️ تمام داده‌های فعلی با محتوای این فایل جایگزین می‌شود و بازگشتی نیست. حساب «مدیر اپ» و اتصال ربات دست‌نخورده می‌مانند. قبل از ادامه، از همین‌جا یک پشتیبان جدید بگیرید.</div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn danger" data-maction="go">بازیابی و جایگزینی</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        b.disabled = true;
        try {
          const r = await api('/import', { method: 'POST', body: payload });
          haptic('success');
          const im = (r && r.imported) || {};
          toast(`بازیابی انجام شد — ${faNum(im.units || 0)} واحد، ${faNum(im.debts || 0)} شارژ، ${faNum(im.users || 0)} حساب`, 'ok', 5000);
          m.close();
          state.jy = state.period.slice(0, 4);
          navigate('dashboard');
        } catch (e) { toast(e.message, 'err', 6000); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Notifications (manager tools)
// ---------------------------------------------------------------------------
async function doReminders() {
  // pre-flight: explain exactly what is (not) possible before asking to send
  let pv = null;
  try { pv = await api('/notify/preview'); } catch (e) { toast(e.message, 'err'); return; }
  if (pv && pv.bot_configured === false) {
    toast('یادآوری از طریق ربات تلگرام است؛ ابتدا توکن ربات را در پنل مدیریت اپ (تب «تنظیمات اپ» ← ربات تلگرام) ثبت کنید', 'err', 5200);
    return;
  }
  if (pv && pv.debtor_units === 0) {
    toast('واحد بدهکاری وجود ندارد؛ یادآوری لازم نیست', 'ok');
    return;
  }
  const linked = pv ? (pv.linked_users ?? pv.linked_residents ?? 0) : 0;
  if (linked === 0) {
    toast('هیچ کاربری به تلگرام متصل نیست. کاربران باید یک بار داخل تلگرام با نام کاربری/رمز وارد اپ شوند تا بتوان پیام دریافت کرد.', 'info', 6500);
    return;
  }
  const okd = await confirmDialog(
    `پیام یادآوری به واحدهای بدهکار ارسال شود؟\nکاربران متصل تلگرام: ${faNum(linked)} نفر` +
    (pv && pv.debtor_units ? `\nواحدهای بدهکار: ${faNum(pv.debtor_units)}` : '')
  );
  if (!okd) return;
  try {
    const res = await api('/notify/reminders', { method: 'POST', body: {} });
    if (res.skipped === 'bot_token_missing') {
      toast('توکن ربات تنظیم نشده است؛ در پنل مدیریت اپ (تب «تنظیمات اپ» ← ربات تلگرام) توکن را ثبت کنید', 'err');
      return;
    }
    if (res.skipped === 'no_targets' || (res.targets === 0 && !res.sent && !res.failed)) {
      toast('هیچ کاربر متصلِ بدهکاری پیدا نشد؛ یادآوری ارسال نشد. توجه: فقط کسانی پیام می‌گیرند که حسابشان به تلگرام متصل و واحدشان بدهکار باشد.', 'info', 6000);
      return;
    }
    haptic('success');
    toast(`یادآوری برای ${faNum(res.sent)} کاربر ارسال شد${res.failed ? ' — ' + faNum(res.failed) + ' ناموفق' : ''}`, res.failed ? 'info' : 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function openAnnounceModal() {
  openModal({
    title: 'اعلان همگانی',
    body: `
      <div class="form-grid">
        <div class="field"><label>متن اعلان برای همه کاربران</label>
          <textarea id="an-text" placeholder="مثلاً: قطعی آب ساختمان فردا از ساعت ۹ تا ۱۲ خواهد بود."></textarea></div>
        <div class="field"><div class="hint">پیام برای همه کاربرانی که حساب فعال و اتصال تلگرام دارند ارسال می‌شود (ساکنین، مدیران ساختمان و مدیر اپ).</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('send', 16)} ارسال</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const text = $('#an-text', m.el).value.trim();
        if (!text) { toast('متن پیام را وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          const res = await api('/notify/announce', { method: 'POST', body: { text } });
          if (res.skipped === 'bot_token_missing') { toast('توکن ربات تنظیم نشده است', 'err'); }
          else { haptic('success'); toast(`اعلان برای ${faNum(res.sent)} واحد ارسال شد`, 'ok'); }
          m.close();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Automatic monthly reminder (یادآوری خودکار ماهانه)
// Cloudflare Cron checks daily; the manager configures it here.
// v2.11.7: «تعداد یادآوری» — up to 10 reminders per month, distributed
// evenly across the month (first = chosen day, rest evenly until month end).
// ---------------------------------------------------------------------------
function arComputeDays(count, day, monthLen) {
  const n = Math.min(10, Math.max(1, Math.round(Number(count) || 1)));
  const d0 = Math.min(29, Math.max(1, Math.round(Number(day) || 1)));
  const L = Math.min(31, Math.max(29, Math.round(Number(monthLen) || 30)));
  if (n === 1) return [d0];
  const set = new Set();
  for (let i = 0; i < n; i++) set.add(Math.min(L, Math.max(1, d0 + Math.round(i * (L - d0) / (n - 1)))));
  return [...set].sort((a, b) => a - b);
}

function arDaysLabel(days) {
  return (days || []).map(d => faNum(d)).join('، ');
}

function arLineText(ar) {
  if (!ar || !ar.cfg) return 'برای تنظیم، دکمه «تنظیم» را بزنید';
  const c = ar.cfg;
  if (!c.enabled) return 'غیرفعال — یادآوری به‌صورت خودکار ارسال نمی‌شود';
  const days = ar.days || arComputeDays(c.count, c.day, ar.month_len || 30);
  let t = days.length > 1
    ? `فعال • ${faNum(days.length)} نوبت در ماه • روزهای ${arDaysLabel(days)}`
    : `فعال • روز ${faNum(c.day)} هر ماه`;
  if (c.last) {
    const m = /^(\d{4}-\d{2})(?:#(\d{1,2}))?$/.exec(String(c.last));
    t += ' • آخرین ارسال: ' + periodLabel(m ? m[1] : c.last);
  }
  if (ar.bot_configured === false) t += ' • ⚠️ توکن ربات ثبت نشده';
  return t;
}

function openAutoRemindModal() {
  const ar = state.autoRemind;
  if (!ar) { toast('تنظیمات یادآوری خودکار بارگذاری نشده است؛ دوباره تلاش کنید', 'err'); return; }
  const cfg = ar.cfg;
  const st = ar.stats || {};
  const monthLen = ar.month_len || 30;
  const maxSlots = ar.max_slots || 10;
  const dayOpts = Array.from({ length: 29 }, (_, i) =>
    `<option value="${i + 1}" ${cfg.day === i + 1 ? 'selected' : ''}>روز ${faNum(i + 1)} ماه</option>`
  ).join('');
  const cntOpts = Array.from({ length: maxSlots }, (_, i) =>
    `<option value="${i + 1}" ${(cfg.count || 1) === i + 1 ? 'selected' : ''}>${faNum(i + 1)} نوبت</option>`
  ).join('');
  const daysPreview = () => arComputeDays(Number($('#ar-count', m.el).value), Number($('#ar-day', m.el).value), monthLen);
  const statsText = [
    `کاربران بدهکار: ${faNum((st.debtor_users ?? st.debtor_residents) || 0)} نفر`,
    `متصل تلگرام: ${faNum((st.reachable_users ?? st.reachable_residents) || 0)}`,
    `بدون اتصال: ${faNum((st.unreachable_users ?? st.unreachable_residents) || 0)}`,
    `جمع مانده: ${fmtMoney(st.total_debt || 0)}`
  ].join(' • ');
  const botWarn = ar.bot_configured === false
    ? `<div class="field"><div class="hint" style="color:var(--danger)">⚠️ توکن ربات ثبت نشده است؛ در پنل مدیریت اپ (تب «تنظیمات اپ» ← ربات تلگرام) توکن را ثبت کنید تا یادآوری خودکار بتواند پیام بفرستد.</div></div>`
    : '';

  let m;
  openModal({
    title: 'یادآوری خودکار ماهانه',
    body: `
      <div class="form-grid">
        <div class="field"><label>وضعیت</label>
          <button type="button" id="ar-on" class="${cfg.enabled ? 'btn ok' : 'btn ghost'}" data-on="${cfg.enabled ? 1 : 0}">
            ${cfg.enabled ? '✓ فعال — ارسال خودکار ماهانه' : 'غیرفعال — ارسال خودکار خاموش است'}
          </button></div>
        <div class="field"><label>تعداد یادآوری در ماه</label>
          <select id="ar-count">${cntOpts}</select>
          <div class="hint">تا ${faNum(maxSlots)} نوبت؛ اپ خودش این تعداد را به‌طور مساوی در طول ماه پخش می‌کند.</div></div>
        <div class="field"><label>اولین ارسال در ماه (شمسی)</label>
          <select id="ar-day">${dayOpts}</select>
          <div class="hint">اولین یادآوری در این روز ارسال می‌شود و نوبت‌های بعدی به‌طور مساوی تا پایان ماه پخش می‌شوند. اگر روزی فرصت ارسال از دست برود، روز بعد جبران می‌شود.</div></div>
        <div class="field"><label>روزهای ارسال (پیش‌نمایش)</label>
          <div id="ar-days" class="hint" style="font-weight:700;color:var(--txt)"></div></div>
        <div class="field"><label>متن پیام</label>
          <textarea id="ar-text" rows="5">${esc(cfg.text)}</textarea>
          <div class="hint">متغیرها: <b>{building}</b> نام ساختمان • <b>{name}</b> نام ساکن • <b>{unit}</b> شماره واحد • <b>{amount}</b> مبلغ بدهی • <b>{month}</b> ماه جاری
          <br><a href="#" id="ar-reset">بازگردانی متن پیش‌فرض</a></div></div>
        ${botWarn}
        <div class="field"><div class="hint">${statsText}</div></div>
      </div>
      <div class="rows" style="margin-top:12px">
        <button class="btn subtle block" data-maction="test">${icon('send', 16)} ارسال پیام آزمایشی به من</button>
        <button class="btn subtle block" data-maction="run">${icon('bell', 16)} ارسال یادآوری همین حالا</button>
      </div>`,
    footer: `
      <button class="btn subtle" data-maction="cancel">انصراف</button>
      <button class="btn" data-maction="save">${icon('check', 16)} ذخیره</button>`,
    onMount(mEl) {
      m = mEl;
      const tgl = $('#ar-on', m.el);
      const setTgl = on => {
        tgl.dataset.on = on ? '1' : '0';
        tgl.className = on ? 'btn ok' : 'btn ghost';
        tgl.textContent = on ? '✓ فعال — ارسال خودکار ماهانه' : 'غیرفعال — ارسال خودکار خاموش است';
      };
      tgl.addEventListener('click', () => setTgl(tgl.dataset.on !== '1'));
      $('#ar-reset', m.el).addEventListener('click', e => {
        e.preventDefault();
        $('#ar-text', m.el).value = ar.default_text || '';
      });
      const refreshDays = () => {
        const days = daysPreview();
        $('#ar-days', m.el).textContent = days.length > 1
          ? `${arDaysLabel(days)} — ${faNum(days.length)} نوبت در این ماه`
          : `${arDaysLabel(days)} — ${faNum(days.length)} نوبت در ماه`;
      };
      $('#ar-count', m.el).addEventListener('change', refreshDays);
      $('#ar-day', m.el).addEventListener('change', refreshDays);
      refreshDays();

      // save current form, then run the requested action
      const saveCfg = async () => api('/autoremind', {
        method: 'PUT',
        body: {
          enabled: tgl.dataset.on === '1',
          day: Number($('#ar-day', m.el).value),
          count: Number($('#ar-count', m.el).value),
          text: $('#ar-text', m.el).value.trim()
        }
      });

      const runResultToast = r => {
        if (r.reason === 'bot_token_missing') { toast('توکن ربات تنظیم نشده است؛ در پنل مدیریت اپ توکن را ثبت کنید', 'err'); return; }
        if (r.reason === 'no_targets') { toast('کاربر بدهکارِ متصل‌به‌تلگرامی پیدا نشد؛ ارسال انجام نشد', 'info', 5200); return; }
        let t = `یادآوری برای ${faNum(r.sent)} کاربر ارسال شد`;
        if (r.slots > 1) t += ` • نوبت ${faNum(Math.min((r.slot || 0) + 1, r.slots))} از ${faNum(r.slots)} ماه ثبت شد`;
        if (r.failed) t += ` • ${faNum(r.failed)} ناموفق`;
        if (r.unreachable) t += ` • ${faNum(r.unreachable)} بدون اتصال تلگرام`;
        toast(t, r.failed ? 'info' : 'ok', 6000);
      };

      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'cancel') { m.close(); return; }
        if (act === 'test') {
          b.disabled = true;
          try {
            await saveCfg();
            await api('/autoremind/test', { method: 'POST', body: {} });
            haptic('success');
            toast('پیام آزمایشی برای شما در تلگرام ارسال شد', 'ok');
          } catch (e) {
            if (e.code === 'not_linked') toast('حساب شما به تلگرام متصل نیست؛ یک بار داخل تلگرام وارد اپ شوید', 'info', 6000);
            else toast(e.message, 'err');
          }
          b.disabled = false;
          return;
        }
        if (act === 'run') {
          const days = daysPreview();
          const slotNote = days.length > 1
            ? `این ارسال به‌عنوان نوبت ${faNum(Math.min((ar.cfg.seq || 0) + 1, days.length))} از ${faNum(days.length)} این ماه ثبت می‌شود و بقیه نوبت‌ها طبق برنامه ارسال می‌شوند.`
            : '(تنظیمات فعلی فرم ذخیره می‌شود و این ماه دیگر خودکار ارسال نمی‌شود)';
          const okd = await confirmDialog(
            'یادآوری همین حالا برای همه کاربران بدهکارِ متصل ارسال شود؟\n' + slotNote
          );
          if (!okd) return;
          b.disabled = true;
          try {
            await saveCfg();
            const res = await api('/autoremind/run', { method: 'POST', body: {} });
            haptic('success');
            runResultToast(res.result || {});
            m.close();
            navigate('reports');
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
          return;
        }
        if (act === 'save') {
          b.disabled = true;
          try {
            await saveCfg();
            state.autoRemind = await api('/autoremind');
            haptic('success');
            toast('تنظیمات یادآوری خودکار ذخیره شد', 'ok');
            m.close();
            navigate('reports');
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Views — Resident (self-service)
// ---------------------------------------------------------------------------
async function viewMy() {
  const [d, pollsRes] = await Promise.all([
    api('/my/summary'),
    api('/polls').catch(() => ({ polls: [] }))
  ]);
  const open = (d.debts || []).filter(x => x.status !== 'paid');
  const rows = open.map(x => `
    <div class="row">
      <div class="badge gray">${icon(x.kind === 'monthly' ? 'card' : 'pie')}</div>
      <div class="mid">
        <div class="t1">${esc(x.description)}</div>
        <div class="t2">${esc(periodLabel(x.period))}${x.paid_amount ? ' • پرداخت‌شده: ' + fmtMoney(x.paid_amount) : ''}</div>
      </div>
      <div class="end">
        <span class="amount">${fmtMoney(x.amount - x.paid_amount)}</span>
        ${statusChip(x.status)}
      </div>
    </div>`).join('');

  const s = state.settings || {};
  const activePolls = (pollsRes.polls || []).map(normalizePoll).filter(p => p.status === 'open');
  const closedPolls = (pollsRes.polls || []).map(normalizePoll).filter(p => p.status !== 'open').slice(0, 3);
  const pollsHtml = (activePolls.length || closedPolls.length) ? `
    <div class="section-title">نظرسنجی‌ها</div>
    ${activePolls.length ? activePolls.map(p => pollCard(p, { canVote: true })).join('') : ''}
    ${closedPolls.length ? closedPolls.map(p => pollCard(p, { canVote: false })).join('') : ''}` : '';

  return `
    <div class="hero">
      <div class="label">مانده بدهی ${unitWord(d.unit.number)}</div>
      <div class="value ${d.totals.remaining > 0 ? 'bad' : 'ok'}">${fmtMoney(d.totals.remaining)}</div>
      <div class="sub">پرداخت‌شده تا امروز: <b>${fmtMoney(d.totals.paid)}</b> از ${fmtMoney(d.totals.issued)}</div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="kv"><span class="k">ساکن</span><span class="v">${esc(d.unit.resident_name || '—')}</span></div>
      <div class="kv"><span class="k">شماره واحد</span><span class="v">${esc(faNum(unitNo(d.unit.number)))}</span></div>
      <div class="kv"><span class="k">متراژ</span><span class="v">${faNum(d.unit.area_m2)} متر</span></div>
      ${s.bank_card ? `<div class="kv"><span class="k">کارت به نام</span><span class="v">${esc(s.bank_owner || 'مدیر ساختمان')}</span></div>` : ''}
      ${s.bank_card ? `<div class="kv"><span class="k">شماره کارت</span><span class="v" dir="ltr">${esc(faNum(s.bank_card))}</span></div>` : ''}
    </div>
    <button class="btn block" data-action="pdf-statement" style="margin-bottom:14px">${icon('download', 17)} دانلود صورت‌حساب (PDF)</button>
    ${pollsHtml}
    <div class="section-title">اقلام باز</div>
    ${rows || emptyState({ ic: 'check', text: 'بدهی باز ندارید؛ دستتان درد نکند' })}
    <div class="field" style="margin-top:14px"><div class="hint">پس از پرداخت، مبلغ توسط مدیر ساختمان در سیستم ثبت می‌شود و وضعیت شما به‌روز خواهد شد.</div></div>
  `;
}

async function viewMyHistory() {
  const d = await api('/my/summary');
  const groups = {};
  (d.debts || []).forEach(x => { (groups[x.period] = groups[x.period] || []).push(x); });
  const periods = Object.keys(groups).sort().reverse();
  const blocks = periods.map(p => `
    <div class="section-title">${esc(periodLabel(p))}</div>
    <div class="rows">${groups[p].map(x => `
      <div class="row">
        <div class="badge gray">${icon('file')}</div>
        <div class="mid">
          <div class="t1">${esc(x.description)}</div>
          <div class="t2">${x.paid_amount ? 'پرداخت‌شده: ' + fmtMoney(x.paid_amount) + (x.method ? ' • ' + esc(x.method) : '') : 'پرداخت نشده'}</div>
        </div>
        <div class="end">
          <span class="amount">${fmtMoney(x.amount)}</span>
          ${statusChip(x.status)}
        </div>
      </div>`).join('')}</div>`).join('');

  return blocks || emptyState({ ic: 'file', text: 'تاریخچه‌ای ثبت نشده است' });
}

// ---------------------------------------------------------------------------
// Views — Resident annual report (گزارش سالانه واحد خود)
// ---------------------------------------------------------------------------
async function viewMyReports() {
  const d = await api('/my/summary');
  const jy = state.jy;
  const debts = (d.debts || []).filter(x => String(x.period || '').startsWith(jy + '-'));
  const months = Array.from({ length: 12 }, (_, i) => `${jy}-${String(i + 1).padStart(2, '0')}`);
  const sMap = {};
  debts.forEach(x => {
    sMap[x.period] = sMap[x.period] || { issued: 0, paid: 0 };
    sMap[x.period].issued += x.amount;
    sMap[x.period].paid += x.paid_amount;
  });
  let tI = 0, tP = 0;
  const trs = months.map(p => {
    const s = sMap[p] || { issued: 0, paid: 0 };
    tI += s.issued; tP += s.paid;
    const rem = s.issued - s.paid;
    return `<tr>
      <td>${periodLabel(p)}</td>
      <td class="num">${fmtNum(s.issued)}</td>
      <td class="num" style="color:var(--ok)">${fmtNum(s.paid)}</td>
      <td class="num" style="color:${rem > 0 ? 'var(--danger)' : 'var(--muted)'}">${fmtNum(rem)}</td>
    </tr>`;
  }).join('');
  const remaining = Math.max(0, tI - tP);

  return `
    <div class="stepper" id="myrep-stepper">
      <button class="st-btn" data-yd="1" aria-label="سال بعد">${icon('chevr')}</button>
      <div class="p-label"><span>سال ${faNum(jy)}</span><small>گزارش سالانه واحد شما</small></div>
      <button class="st-btn" data-yd="-1" aria-label="سال قبل">${icon('chevl')}</button>
    </div>

    <div class="hero">
      <div class="label">مانده سال ${faNum(jy)} — ${unitWord(d.unit.number)}</div>
      <div class="value ${remaining > 0 ? 'bad' : 'ok'}">${fmtMoney(remaining)}</div>
      <div class="sub">شارژ سال: <b>${fmtMoney(tI)}</b> • پرداخت‌شده: <b>${fmtMoney(tP)}</b></div>
    </div>

    <div class="section-title">روند ماهانه واحد شما</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>ماه</th><th>شارژ</th><th>پرداخت</th><th>مانده</th></tr></thead>
      <tbody>${trs}
        <tr class="total"><td>جمع سال</td><td class="num">${fmtNum(tI)}</td><td class="num">${fmtNum(tP)}</td><td class="num">${fmtNum(tI - tP)}</td></tr>
      </tbody></table></div>

    <button class="btn block" data-action="pdf-statement-year" style="margin-top:14px">${icon('download', 17)} دانلود گزارش سالانه واحد من (PDF)</button>
    <div class="field" style="margin-top:10px"><div class="hint">این گزارش فقط وضعیت واحد خود شما را نشان می‌دهد و شامل اطلاعات سایر واحدها نیست.</div></div>
  `;
}

function mountMyReports() {
  const el = $('#myrep-stepper');
  if (el) $$('[data-yd]', el).forEach(b => b.addEventListener('click', () => {
    state.jy = String(Number(state.jy) + Number(b.dataset.yd));
    navigate('myreports');
  }));
}

// ---------------------------------------------------------------------------
// Views — In-app guide (راهنما): manager sees everything; residents see only
// the features of their own panel. The app-admin panel is never mentioned.
// ---------------------------------------------------------------------------
function guideCard(ic, title, body) {
  return `
    <div class="card guide-card">
      <div class="gc-head"><span class="gc-ic">${icon(ic, 18)}</span><b>${title}</b></div>
      <div class="gc-body">${body}</div>
    </div>`;
}

function managerGuideCards() {
  return [
    guideCard('home', 'داشبورد — مرکز کنترل شما', `
      <p>اولین تب بعد از ورود؛ وضعیت کلی ساختمان را یک‌جا نشان می‌دهد:</p>
      <ul>
        <li><b>مانده بدهی کل ساکنین</b> و نوار پیشرفت وصول مطالبات در بالای صفحه.</li>
        <li><b>نمودار ۱۲ماهه</b>: میزان صادرشده و وصول‌شده هر ماه سال جاری را مقایسه می‌کند.</li>
        <li><b>آخرین پرداخت‌ها</b> و <b>بیشترین بدهی‌ها</b> برای مرور سریع.</li>
      </ul>
      <p><b>عملیات سریع</b> (چهار دکمه زیر کارت‌های آماری): صدور شارژ، هزینه جدید، یادآوری و اعلان — بدون جابه‌جایی بین تب‌ها.</p>`),
    guideCard('users', 'واحدها — ثبت واحد و حساب ساکنین', `
      <ol>
        <li>با <b>افزودن واحد</b> شماره، نام ساکن، تلفن، <b>متراژ</b> و <b>تعداد نفرات</b> را ثبت کنید. متراژ و نفرات مبنای محاسبه شارژ هستند؛ حتماً پر کنید.</li>
        <li>در فیلد شماره فقط <b>خودِ عدد</b> را بنویسید (مثلاً 5) — اگر کلمه «واحد» تایپ شود، اپ خودکار آن را حذف می‌کند.</li>
        <li>روی هر واحد بزنید تا جزئیات باز شود: اقلام بدهی، ثبت/لغو پرداخت و <b>صورت‌حساب PDF</b> واحد.</li>
        <li>در همان صفحه <b>حساب کاربری ساکن</b> بسازید (نام کاربری و رمز). ساکن با همین حساب وارد اپ می‌شود و فقط وضعیت واحد خودش را می‌بیند.</li>
        <li>برای اینکه ساکن <b>یادآوری‌ها و پیام‌های شما</b> را در تلگرام دریافت کند، در «مدیریت حساب ساکن» دکمه <b>لینک اتصال تلگرام</b> را بزنید؛ در مودال بازشده <b>اعتبار</b> کد را انتخاب کنید (از ۱ ساعت تا ۳۰ روز) و لینک/کد/QR یک‌بارمصرف را برایش بفرستید — برای کسانی که یوزرنیم تلگرام ندارند هم کار می‌کند؛ ساکن کافی است QR را با دوربین اسکن کند یا کد را در چت ربات بفرستد.</li>
        <li>از همان‌جا می‌توانید حساب ساکن را فعال/غیرفعال کنید، رمزش را ریست کنید یا حذفش کنید. هر واحد فقط یک حساب ساکن دارد.</li>
      </ol>
      <div class="hint">رمز ساکن را فقط به خودش بدهید؛ با غیرفعال‌کردن حساب، دسترسی او بلافاصله قطع می‌شود.</div>`),
    guideCard('card', 'شارژ — صدور و ثبت پرداخت', `
      <ol>
        <li>با فلش‌های بالای صفحه ماه موردنظر را انتخاب کنید (دکمه «این ماه» هم هست).</li>
        <li><b>صدور شارژ برای همه واحدها</b> با سه روش: <b>مبلغ ثابت</b> برای هر واحد، <b>به نسبت متراژ</b> (مبلغ هر مترمربع) یا <b>بر اساس نفرات</b> (مبلغ هر نفر). پیش‌نمایش جمع کل را قبل از صدور نشان می‌دهد.</li>
        <li>می‌توانید شارژ را فقط برای <b>یک یا چند واحد انتخابی</b> صادر کنید: در کادر صدور گزینه <b>«انتخاب واحدها»</b> را بزنید و واحدهای دلخواه را برگزینید.</li>
        <li>اقلامی که قبلاً برای آن ماه صادر شده‌اند دوباره صادر نمی‌شوند — پس تکرار اشتباهی ندارد.</li>
        <li>زیر هر قلم پرداخت‌نشده، دکمه <b>ثبت پرداخت</b> است: مبلغ (کامل یا جزئی)، روش پرداخت (کارت‌به‌کارت، نقدی، پایا)، <b>تاریخ شمسی</b> و یادداشت.</li>
        <li><b>لغو پرداخت</b> برای اصلاح ثبت اشتباه و سطل زباله برای حذف قلم.</li>
      </ol>
      <p>فیلترهای «همه / پرداخت‌نشده / تسویه‌شده» پیدا کردن بدهکاران را سریع می‌کند.</p>`),
    guideCard('pie', 'هزینه‌های مشترک — تقسیم خودکار', `
      <ol>
        <li>عنوان، دسته (نظافت، برق، آسانسور و...)، مبلغ و ماه را وارد کنید.</li>
        <li>روش تقسیم را انتخاب کنید: <b>مساوی بین همه واحدها</b> یا <b>به نسبت متراژ</b>.</li>
        <li>با ثبت، سهم هر واحد به‌صورت خودکار محاسبه و به بدهی همان ماه واحدها اضافه می‌شود.</li>
        <li>حذف هزینه، سهم همه واحدها را هم حذف می‌کند.</li>
      </ol>`),
    guideCard('poll', 'نظرسنجی — تصمیم‌گیری با ساکنین', `
      <ol>
        <li>سؤال و حداقل <b>دو گزینه</b> بنویسید (هر گزینه در یک خط) و نظرسنجی را بسازید.</li>
        <li>ساکنین در تب «وضعیت من» نظرسنجی فعال را می‌بینند و رأی می‌دهند؛ <b>هر واحد یک رأی</b> دارد و می‌تواند رأی خود را عوض کند.</li>
        <li>نتایج لحظه‌ای (تعداد و درصد هر گزینه) برای همه نمایش داده می‌شود.</li>
        <li>می‌توانید نظرسنجی را <b>ببندید</b>، دوباره <b>باز کنید</b> یا حذف کنید.</li>
      </ol>`),
    guideCard('chart', 'گزارش‌ها، یادآوری و خروجی‌ها', `
      <ul>
        <li><b>گزارش سالانه</b>: جدول روند ماهانه و وضعیت تک‌تک واحدها؛ با فلش‌ها سال را عوض کنید و <b>PDF گزارش سالانه</b> را دانلود کنید.</li>
        <li><b>یادآوری بدهی</b>: پیام خودکار به واحدهای بدهکار — از طریق ربات تلگرام ارسال می‌شود، پس توکن ربات باید تنظیم شده باشد.</li>
        <li><b>اعلان همگانی</b>: پیام به همه ساکنین متصل (مثل اطلاع‌رسانی قطعی آب).</li>
        <li><b>خروجی‌ها</b>: فایل CSV بدهکاران، خلاصه سال و <b>پشتیبان کامل JSON</b> — مرتباً پشتیبان بگیرید.</li>
        <li><b>بازیابی پشتیبان</b>: با دکمه «بازیابی پشتیبان (JSON)» فایل پشتیبان قبلی را انتخاب کنید؛ پس از تأیید، همه داده‌ها (واحدها، شارژها، هزینه‌ها، حساب‌های ساکن/مدیر و نظرسنجی‌ها) با محتوای فایل جایگزین می‌شود. حساب «مدیر اپ» و اتصال ربات دست‌نخورده می‌مانند — پس پشتیبان را جایی امن نگه دارید و آن را با کسی به اشتراک نگذارید.</li>
      </ul>
      <div class="hint">برای ارسال پیام، ساکن باید یک بار داخل تلگرام با نام کاربری/رمز وارد اپ شود تا حسابش به تلگرام متصل شود.</div>`),
    guideCard('building', 'واحد من — نمای مدیر به‌عنوان ساکن', `
      <p>اگر خودتان در ساختمان ساکن هستید، از <b>تنظیمات ← اتصال به واحد من</b> واحد خود را انتخاب کنید. تب «واحد من» اضافه می‌شود و وضعیت واحد خودتان را دقیقاً مثل یک ساکن می‌بینید و در نظرسنجی‌ها رأی می‌دهید.</p>`),
    guideCard('gear', 'تنظیمات و امنیت', `
      <ul>
        <li>از دکمه ⚙️ بالای صفحه: مشاهده اطلاعات حساب، تغییر <b>رمز عبور</b> و خروج.</li>
        <li>وضعیت <b>اتصال تلگرام</b> را از همان‌جا ببینید؛ اتصال برای دریافت یادآوری ضروری است.</li>
        <li>رمز عبور حداقل ۶ کاراکتر و ترجیحاً شامل حرف و عدد باشد.</li>
      </ul>`),
    guideCard('info', 'ساکنین چه چیزی می‌بینند؟', `
      <p>ساکن فقط این‌ها را می‌بیند: <b>وضعیت من</b> (مانده بدهی، شماره کارت شما، اقلام باز)، <b>گزارش سالانه واحد خودش</b>، <b>تاریخچه</b>، <b>نظرسنجی‌ها</b> و صورت‌حساب PDF واحد خودش. هیچ دسترسی‌ای به واحدهای دیگر، هزینه‌ها یا گزارش‌های کلی ساختمان ندارد.</p>`)
  ].join('');
}

function residentGuideCards() {
  return [
    guideCard('home', 'وضعیت من — مانده بدهی شما', `
      <ul>
        <li>کارت بالای صفحه <b>مانده بدهی واحد شما</b> و مجموع پرداخت‌شده تا امروز را نشان می‌دهد.</li>
        <li>مشخصات واحد، نام ساکن و متراژ + <b>شماره کارت مدیر ساختمان</b> برای کارت‌به‌کارت.</li>
        <li>لیست <b>اقلام باز</b>: هر قلم شارژ یا هزینه مشترک که تسویه نشده است.</li>
      </ul>
      <div class="hint">پرداخت را به حساب مدیر واریز کنید؛ ثبت آن در سیستم با مدیر ساختمان است و بلافاصله در وضعیت شما به‌روز می‌شود.</div>`),
    guideCard('download', 'صورت‌حساب PDF', `
      <p>دکمه <b>دانلود صورت‌حساب (PDF)</b> در «وضعیت من»، صورتحساب کامل واحد شما را با جزئیات همه اقلام و پرداخت‌ها تولید می‌کند — برای بایگانی یا اعلام به مدیر ساختمان مناسب است.</p>`),
    guideCard('chart', 'گزارش سالانه واحد شما', `
      <ol>
        <li>در تب <b>گزارش سالانه</b>، جدول ۱۲ ماه سال را می‌بینید: شارژ هر ماه، پرداخت‌شده و مانده.</li>
        <li>با فلش‌های بالا سال را تغییر دهید.</li>
        <li>با دکمه <b>دانلود گزارش سالانه واحد من (PDF)</b> خروجی همین جدول را دریافت کنید. این گزارش فقط مال واحد خودتان است.</li>
      </ol>`),
    guideCard('poll', 'نظرسنجی‌ها — رأی بدهید', `
      <ul>
        <li>نظرسنجی‌های فعال در «وضعیت من» نمایش داده می‌شوند؛ روی گزینه موردنظر بزنید و رأی را تأیید کنید.</li>
        <li><b>هر واحد یک رأی</b> دارد؛ می‌توانید رأی خود را تا بسته‌شدن نظرسنجی تغییر دهید.</li>
        <li>نتایج (تعداد و درصد آرا) برای همه ساکنین قابل مشاهده است.</li>
      </ul>`),
    guideCard('file', 'تاریخچه', `
      <p>همه اقلام ماه‌های گذشته به‌تفکیک ماه، همراه مبلغ، وضعیت پرداخت و روش پرداخت ثبت‌شده. برای مرور حساب چند سال گذشته کاربردی است.</p>`),
    guideCard('gear', 'تنظیمات و رمز عبور', `
      <ul>
        <li>از دکمه ⚙️ بالای صفحه می‌توانید <b>رمز عبور</b> خود را عوض کنید (رمز فعلی + رمز جدید).</li>
        <li>وضعیت <b>اتصال تلگرام</b> را ببینید؛ وقتی داخل تلگرام وارد اپ شوید، حساب شما متصل می‌شود و یادآوری‌های مدیر به شما می‌رسد.</li>
        <li>از حساب خود خارج شوید اگر دستگاه شخصی نیست.</li>
      </ul>
      <div class="hint">رمز عبور خود را به کسی ندهید؛ مدیر ساختمان هرگز رمز شما را نمی‌داند و در صورت فراموشی آن را ریست می‌کند.</div>`)
  ].join('');
}

async function viewGuide() {
  const isManager = state.role === 'manager';
  const intro = isManager
    ? `به راهنمای کامل اپ خوش آمدید. همه تب‌ها و کارهایی که به‌عنوان مدیر ساختمان می‌توانید انجام دهید، مرحله‌به‌مرحله توضیح داده شده است. هر وقت فراموش کردید، همین تب را باز کنید.`
    : `به راهنمای اپ خوش آمدید. اینجا فقط امکاناتی توضیح داده شده که برای واحد شما فعال است: وضعیت بدهی، گزارش سالانه، تاریخچه، نظرسنجی و تنظیمات.`;
  const cards = isManager ? managerGuideCards() : residentGuideCards();
  return `
    <div class="guide-intro">
      <span class="gi-ic">${icon('book', 20)}</span>
      <div>${intro}</div>
    </div>
    <div class="guide-intro">
      <span class="gi-ic">${icon('shield', 20)}</span>
      <div><b>امنیت ورود:</b> ورود به اپ فقط با نام کاربری و رمز عبور ممکن است — باز کردن لینک اپ بدون حساب، فقط صفحه ورود را نشان می‌دهد. نشست شما فقط داخل تلگرامِ خودتان معتبر است و هر حساب تلگرامِ روی دستگاه، نشست خودش را جداگانه به یاد دارد — با تعویض حساب، حساب قبلی دوباره رمز نمی‌خواهد. با تغییر رمز یا خروج، همه نشست‌های فعال باطل می‌شوند. پنج ورود ناموفق پشت‌سرهم، ورود را ۱۵ دقیقه قفل می‌کند.</div>
    </div>
    ${cards}
  `;
}

// ---------------------------------------------------------------------------
// Settings (all roles): change own password + session info.
// App-level settings (building name, sample data, users) live ONLY in the
// separate admin panel (admin.html) — intentionally absent here.
// ---------------------------------------------------------------------------
// Manager: link their own account to their own unit → «واحد من» tab appears.
async function openMyUnitPicker() {
  let units = [];
  try { units = (await api('/units')).units || []; } catch (e) { toast(e.message, 'err'); return; }
  openModal({
    title: 'انتخاب واحد من',
    body: `
      <div class="hint" style="margin-bottom:10px">با انتخاب واحد، تب «واحد من» اضافه می‌شود و وضعیت واحد خودتان را مثل یک ساکن می‌بینید.</div>
      ${units.length ? `<div class="rows">${units.map(u => `
        <div class="row clickable" data-unit-pick="${u.id}">
          <div class="badge">${esc(faNum(unitNo(u.number)))}</div>
          <div class="mid">
            <div class="t1">${esc(u.resident_name || 'بدون ساکن')}</div>
            <div class="t2">${faNum(u.area_m2)} متر • ${faNum(u.residents_count)} نفر</div>
          </div>
          ${state.unit && state.unit.id === u.id ? '<span class="chip accent">واحد من</span>' : ''}
        </div>`).join('')}</div>`
      : emptyState({ ic: 'users', text: 'هنوز واحدی ثبت نشده است' })}`,
    footer: state.unit ? `<button class="btn danger block" data-maction="unlink">${icon('x', 15)} قطع اتصال از واحد</button>` : '',
    onMount(m) {
      $$('[data-unit-pick]', m.el).forEach(el => el.addEventListener('click', async () => {
        try {
          const r = await api('/my/unit', { method: 'POST', body: { unit_id: Number(el.dataset.unitPick) } });
          state.unit = r.unit;
          haptic('success'); toast('واحد شما ثبت شد', 'ok');
          m.close(); renderShell(); navigate('my');
        } catch (e) { toast(e.message, 'err'); }
      }));
      $$('[data-maction="unlink"]', m.el).forEach(b => b.addEventListener('click', async () => {
        try {
          await api('/my/unit', { method: 'POST', body: { unit_id: null } });
          state.unit = null;
          toast('اتصال واحد حذف شد', 'ok');
          m.close(); renderShell(); navigate('dashboard');
        } catch (e) { toast(e.message, 'err'); }
      }));
    }
  });
}

function openSettingsModal() {
  const u = state.user || {};
  openModal({
    title: 'تنظیمات و حساب کاربری',
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">کاربر</span><span class="v" dir="ltr">${esc(u.username || '—')}</span></div>
          <div class="kv"><span class="k">نقش</span><span class="v">${state.role === 'manager' ? 'مدیر ساختمان' : state.role === 'admin' ? 'مدیر اپ' : 'ساکن'}</span></div>
          <div class="kv"><span class="k">نام ساختمان</span><span class="v">${esc(state.settings.building_name || '—')}</span></div>
          <div class="kv"><span class="k">اتصال تلگرام</span><span class="v">${u.telegram_linked ? '<span class="chip accent">متصل</span>' : '<span class="chip neutral">متصل نیست</span>'}</span></div>
        </div>
        ${state.role === 'manager' ? `
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">واحد من</span>
            <span class="v">${state.unit ? unitWord(state.unit.number) : '<span class="chip neutral">متصل نیست</span>'}</span></div>
          <button class="btn subtle block sm" data-maction="my-unit" style="margin-top:8px">${icon('building', 14)} ${state.unit ? 'تغییر واحد من' : 'اتصال به واحد من'}</button>
        </div>` : ''}
        <div class="field"><label>رمز عبور فعلی</label><input id="pw-old" type="password" dir="ltr" autocomplete="current-password"></div>
        <div class="field"><label>رمز عبور جدید</label><input id="pw-new" type="password" dir="ltr" autocomplete="new-password" placeholder="حداقل ۶ کاراکتر"></div>
        <div class="field"><label>تکرار رمز جدید</label><input id="pw-new2" type="password" dir="ltr" autocomplete="new-password"></div>
        <button class="btn block" data-maction="pw">${icon('check', 16)} تغییر رمز عبور</button>
        <button class="btn danger block" data-maction="logout">${icon('x', 15)} خروج از حساب</button>
      </div>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'pw') {
          const oldPass = $('#pw-old', m.el).value;
          const newPass = $('#pw-new', m.el).value;
          const newPass2 = $('#pw-new2', m.el).value;
          if (!oldPass || !newPass) { toast('رمزها را وارد کنید', 'err'); return; }
          if (newPass !== newPass2) { toast('تکرار رمز جدید مطابقت ندارد', 'err'); return; }
          b.disabled = true;
          try {
            await api('/auth/change-password', { method: 'POST', body: { old_password: oldPass, new_password: newPass } })
              .then(r => { if (r && r.token) setToken(r.token); });
            haptic('success');
            toast('رمز عبور تغییر کرد؛ نشست‌های قبلی باطل شد', 'ok');
            m.close();
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        } else if (act === 'my-unit') {
          m.close();
          openMyUnitPicker();
        } else if (act === 'logout') {
          m.close();
          doLogout();
        }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// Action delegation
// ---------------------------------------------------------------------------
const actions = {
  'unit-open': el => openUnitModal(Number(el.dataset.id)),
  'unit-add': () => openUnitForm(),
  'unit-add-empty': () => openUnitForm(),
  'resident-create': el => {
    const unit = state.unitsCache.find(u => u.id === Number(el.dataset.unit));
    if (unit) openResidentCreateModal(unit);
  },
  'resident-manage': async el => {
    try {
      const list = await api('/residents?unit_id=' + (state.unitsCache.find(u => u.id === Number(el.closest('.sheet')?.querySelector('[data-unit]')?.dataset.unit))?.id || 0));
      const acc = (list.residents || []).find(r => r.id === Number(el.dataset.id));
      if (acc) openResidentManageModal(acc);
    } catch (e) { toast(e.message, 'err'); }
  },
  'debt-pay': el => {
    const id = Number(el.dataset.id);
    if (state.view === 'units' && el.closest('.sheet')) {
      const unitId = Number(el.closest('.sheet').querySelector('[data-maction="unit-edit"]')?.dataset.id);
      openPayModal(id, () => {
        refresh();
        if (unitId) setTimeout(() => openUnitModal(unitId), 150);
      });
    } else openPayModal(id);
  },
  'debt-unpay': async el => {
    const id = Number(el.dataset.id);
    const okd = await confirmDialog('پرداخت این قلم لغو شود؟');
    if (!okd) return;
    try {
      await api(`/debts/${id}/unpay`, { method: 'POST', body: {} });
      toast('پرداخت لغو شد', 'ok');
      if (el.closest('.sheet')) { const unitId = Number(el.closest('.sheet').querySelector('[data-maction="unit-edit"]')?.dataset.id); refresh(); if (unitId) setTimeout(() => openUnitModal(unitId), 150); }
      else navigate(state.view);
    } catch (e) { toast(e.message, 'err'); }
  },
  'debt-del': async el => {
    const id = Number(el.dataset.id);
    const okd = await confirmDialog('این قلم حذف شود؟');
    if (!okd) return;
    try {
      await api('/debts/' + id, { method: 'DELETE', body: {} });
      toast('حذف شد', 'ok');
      if (el.closest('.sheet')) { const unitId = Number(el.closest('.sheet').querySelector('[data-maction="unit-edit"]')?.dataset.id); refresh(); if (unitId) setTimeout(() => openUnitModal(unitId), 150); }
      else navigate(state.view);
    } catch (e) { toast(e.message, 'err'); }
  },
  'gen-open': () => openGenerateModal(),
  'exp-add': () => openExpenseModal(),
  'exp-add-empty': () => openExpenseModal(),
  'exp-del': async el => {
    const id = Number(el.dataset.id);
    const okd = await confirmDialog('این هزینه و سهم تمام واحدها حذف شود؟');
    if (!okd) return;
    try {
      await api('/expenses/' + id, { method: 'DELETE', body: {} });
      toast('هزینه حذف شد', 'ok');
      navigate('expenses');
    } catch (e) { toast(e.message, 'err'); }
  },
  'remind': () => doReminders(),
  'autoremind': () => openAutoRemindModal(),
  'announce': () => openAnnounceModal(),
  'poll-new': () => openPollForm(),
  'poll-vote': el => pollVote(Number(el.dataset.poll), Number(el.dataset.opt)),
  'poll-close': async el => {
    try {
      await api(`/polls/${Number(el.dataset.poll)}/close`, { method: 'POST', body: {} });
      toast('نظرسنجی بسته شد', 'ok');
      navigate('polls');
    } catch (e) { toast(e.message, 'err'); }
  },
  'poll-reopen': async el => {
    try {
      await api(`/polls/${Number(el.dataset.poll)}/reopen`, { method: 'POST', body: {} });
      toast('نظرسنجی دوباره باز شد', 'ok');
      navigate('polls');
    } catch (e) { toast(e.message, 'err'); }
  },
  'poll-del': async el => {
    const okd = await confirmDialog('این نظرسنجی و همه آراهای آن حذف شود؟');
    if (!okd) return;
    try {
      await api('/polls/' + Number(el.dataset.poll), { method: 'DELETE', body: {} });
      toast('نظرسنجی حذف شد', 'ok');
      navigate('polls');
    } catch (e) { toast(e.message, 'err'); }
  },
  'export': el => downloadExport(el.dataset.type),
  'import-backup': () => { const f = $('#import-file'); if (f) { f.value = ''; f.click(); } },
  'pdf-statement': () => downloadPdf('statement'),
  'pdf-statement-year': () => downloadPdf('statement', { jy: state.jy }),
  'pdf-report': () => downloadPdf('report', { jy: state.jy }),
  'logout': () => doLogout(),
  'retry': () => refresh()
};

function onMainClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { haptic('light'); fn(el); }
}

function mountView(view) {
  if (view === 'units') mountUnits();
  else if (view === 'charges') mountCharges();
  else if (view === 'expenses') mountExpenses();
  else if (view === 'polls') mountPolls();
  else if (view === 'reports') mountReports();
  else if (view === 'myreports') mountMyReports();
}

async function renderView(view) {
  switch (view) {
    case 'dashboard': return viewDashboard();
    case 'units': return viewUnits();
    case 'charges': return viewCharges();
    case 'expenses': return viewExpenses();
    case 'polls': return viewPolls();
    case 'reports': return viewReports();
    case 'my': return viewMy();
    case 'myhistory': return viewMyHistory();
    case 'myreports': return viewMyReports();
    case 'guide': return viewGuide();
    default: return emptyState({ text: 'صفحه یافت نشد' });
  }
}

// ---------------------------------------------------------------------------
// Scroll-aware header (v2.11.3) — while the user scrolls down the page the
// header slides up out of view; the first upward scroll (or getting near the
// top) brings it back. The CSS side is transform-only, so the sticky slot
// keeps its height and nothing reflows while the header hides.
// ---------------------------------------------------------------------------
let hdrLastY = 0;
window.addEventListener('scroll', () => {
  const y = window.scrollY;
  const dy = y - hdrLastY;
  if (y < 60 || dy < -2) document.body.classList.remove('hdr-hide');
  else if (dy > 4) document.body.classList.add('hdr-hide');
  hdrLastY = y;
}, { passive: true });

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function initUI() {
  $('#btn-settings').innerHTML = icon('gear');
  $('#btn-refresh').innerHTML = icon('refresh');
  $('#btn-refresh').addEventListener('click', () => { haptic('light'); navigate(state.view); });
  $('#btn-settings').addEventListener('click', openSettingsModal);
  updateThemeBtn();
  $('#btn-theme').addEventListener('click', () => {
    const t = cycleTheme();
    updateThemeBtn();
    haptic('light');
    toast('تم: ' + THEME_LABEL[t], 'info', 1600);
  });
  // Delegation at document level so data-action buttons inside modals work too
  document.addEventListener('click', onMainClick);
  $('#tabbar').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) { haptic('light'); navigate(t.dataset.view); }
  });

}

try { TG?.disableVerticalSwipes?.(); } catch { /* ignore */ }
TG?.ready();
TG?.expand();
applyTheme();
TG?.onEvent?.('themeChanged', applyTheme);
initUI();
boot();


