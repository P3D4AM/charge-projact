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
  tehranParts, toJalaaliFromParts,
  getTheme, setTheme, cycleTheme, themeIcon, THEME_LABEL
} from './util.js';
import { mockFetch, MOCK_STATE } from './mock.js';

const TG = window.Telegram?.WebApp;
const qs = new URLSearchParams(location.search);
const FORCE_REAL = qs.has('real');
const previewHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hostname.endsWith('.space-z.ai');
const MOCK = !FORCE_REAL && (qs.has('mock') || (!TG?.initData && previewHost));

const TOKEN_KEY = 'bc_token';
// v2.15.0 — نشست به پروفایل تلگرام قفل می‌شود: کلید توکن برای هر شناسهٔ تلگرام
// جداگانه است. تلگرام اندروید/iOS فضای WebView را بین پروفایل‌های یک دستگاه به
// اشتراک می‌گذارد و علتِ «باز شدن پنل دیگران بدون رمز» همین بود؛ حالا هر
// پروفایل فقط توکن خودش را می‌بیند و توکن دیگران (کلید قدیمی مشترک) نادیده
// گرفته می‌شود مگر اینکه واقعاً مال همان پروفایل باشد (مهاجرت یک‌باره).
const tgUid = String((TG?.initDataUnsafe?.user?.id) || '');
const tokenKey = () => (tgUid ? 'bc_token_u' + tgUid : TOKEN_KEY);
const state = {
  user: null, role: 'guest', unit: null,
  settings: {}, period: localPeriod(), jy: localPeriod().slice(0, 4),
  view: 'dashboard', unitsCache: [], debtCache: {},
  filter: { units: '', charges: 'all' }
};

const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';

function getToken() {
  const own = localStorage.getItem(tokenKey()) || '';
  if (own) return own;
  // داخل تلگرام هرگز به کلید مشترک قدیمی برنمی‌گردیم (همان نشستِ دیگران)
  return tgUid ? '' : (localStorage.getItem(TOKEN_KEY) || '');
}
function setToken(t) {
  localStorage.setItem(tokenKey(), t);
  if (tgUid) localStorage.removeItem(TOKEN_KEY); // کلید مشترک دیگر منبع نشست نیست
}
function clearToken() {
  localStorage.removeItem(tokenKey());
  if (tgUid) localStorage.removeItem(TOKEN_KEY);
}
// مهاجرت یک‌باره: توکن قدیمی مشترک فقط وقتی به کلید per-profile منتقل می‌شود که
// واقعاً مال همین پروفایل تلگرام باشد؛ در غیر این صورت پاک می‌شود (خروج امن).
async function migrateLegacyToken() {
  if (!tgUid) return;
  if (localStorage.getItem(tokenKey())) return;
  const legacy = localStorage.getItem(TOKEN_KEY) || '';
  if (!legacy) return;
  try {
    const me = await api('/auth/me', { token: legacy });
    if (me && me.user && Number(me.user.telegram_user_id || 0) === Number(tgUid)) {
      localStorage.setItem(tokenKey(), legacy);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch (e) {
    if (e && e.status === 401) localStorage.removeItem(TOKEN_KEY);
    // خطای شبکه → کلید قدیمی می‌ماند تا دفعهٔ بعد
  }
}

// ---------------------------------------------------------------------------
// API layer
// ---------------------------------------------------------------------------
function authHeaders(tokenOverride) {
  const h = {};
  const t = tokenOverride !== undefined ? tokenOverride : getToken();
  if (t) h['authorization'] = 'Bearer ' + t;
  if (TG?.initData) h['x-telegram-init-data'] = TG.initData;
  return h;
}

async function api(path, opts = {}) {
  const { method = 'GET', body, token } = opts;
  if (MOCK) {
    const res = await mockFetch(path, method, body || {});
    // mock layer signals failures with {__ok:false,...} — mirror the real
    // fetch path by converting them to thrown errors so UI shows the message
    if (res && res.__ok === false) {
      const e = new Error(res.error || 'خطا');
      e.status = res.status; e.code = res.code;
      throw e;
    }
    return res;
  }
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const e = new Error((data && data.error) || ('خطای سرور (' + res.status + ')'));
    e.status = res.status; e.code = data && data.code;
    throw e;
  }
  return data;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// v2.14.1 — دانلود در وب‌ویو تلگرام (اندروید/iOS): کلیک <a download> با blob
// هیچ اتفاقی نمی‌افتد — این همان «دانلودها انجام نمیشه» است. راه‌حل: URL مستقیم
// با توکن در query به مرورگر بیرونی سپرده می‌شود (openLink) که آنجا دانلود عادی است.
const TG_PLATFORM = String((window.Telegram?.WebApp?.platform) || '').toLowerCase();
const TG_MOBILE = TG_PLATFORM === 'android' || TG_PLATFORM === 'ios';
function openExternal(url) {
  try {
    if (TG?.openLink) TG.openLink(url);
    else window.open(url, '_blank');
  } catch { window.open(url, '_blank'); }
}
function openServerDownload(pathWithQuery) {
  const t = getToken();
  const abs = location.origin + pathWithQuery + (pathWithQuery.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t);
  openExternal(abs);
  toast('فایل در مرورگر باز شد؛ دانلود آنجا انجام می‌شود', 'info', 2600);
}

async function downloadExport(type, fmt, files) {
  try {
    // v2.15.0 — fmt=zip برای بکاپ: files=1 مدارک پیوست را هم داخل زیپ می‌گذارد
    let q = (fmt ? '&fmt=' + fmt : '');
    if (type === 'backup' && fmt === 'zip') q += '&files=' + (files === '0' ? '0' : '1');
    q += (type === 'year' ? '&jy=' + state.jy : '');
    if (MOCK) {
      const res = await mockFetch('/export?type=' + type + q, 'GET', {});
      const dl = res.__download;
      const bin = /zip/.test(dl.mime) ? 'application/zip' : dl.mime + ';charset=utf-8';
      triggerDownload(URL.createObjectURL(new Blob([dl.content], { type: bin })), dl.filename);
    } else if (TG_MOBILE) {
      // v2.14.1 — Telegram WebView: دانلود به مرورگر بیرونی سپرده می‌شود
      openServerDownload('/api/export?type=' + type + q);
      return;
    } else {
      const res = await fetch('/api/export?type=' + type + q, { headers: authHeaders() });
      if (!res.ok) {
        // v2.14.0 — surface the real reason (status + server message) so a
        // failed download is diagnosable instead of a generic error
        let msg = 'خطا در دریافت فایل (' + res.status + ')';
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not json */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const m = /filename="(.+)"/.exec(res.headers.get('content-disposition') || '');
      triggerDownload(URL.createObjectURL(blob), m ? m[1] : type + (fmt === 'xls' ? '.xls' : fmt === 'zip' ? '.zip' : '.csv'));
    }
    toast('فایل خروجی آماده شد', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

// Download a server-generated PDF (statement for a unit / yearly report /
// monthly all-units report)
async function downloadPdf(kind, { unitId, jy, period } = {}) {
  try {
    if (MOCK) {
      const { downloadMockPdf } = await import('./pdf-client.js');
      await downloadMockPdf(kind, { unitId, jy, period });
      return;
    }
    const url = kind === 'report'
      ? '/api/pdf/report?jy=' + (jy || state.jy)
      : kind === 'monthly'
        ? '/api/pdf/monthly?period=' + (period || state.period)
        : kind === 'performance'
          ? '/api/pdf/performance?jy=' + (jy || state.jy)
          : kind === 'tasks'
            ? '/api/pdf/tasks?jy=' + (jy || state.jy)
            : '/api/pdf/statement?unit_id=' + (unitId || (state.unit && state.unit.id))
              + (jy ? '&jy=' + jy : '');
    if (TG_MOBILE) {
      // v2.14.1 — Telegram WebView: دانلود به مرورگر بیرونی سپرده می‌شود
      openServerDownload(url);
      return;
    }
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      let msg = 'خطا در تولید PDF';
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const m = /filename="(.+)"/.exec(res.headers.get('content-disposition') || '');
    triggerDownload(URL.createObjectURL(blob), m ? m[1] : kind + '.pdf');
    toast('فایل PDF آماده شد', 'ok');
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
// Boot: session → telegram auto-login → login screen
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

// v2.17.0 — مصرف لینک دعوت یک‌بارمصرف در بوت: start_param تلگرام (لینک
// «t.me/<bot>?startapp=») یا ?invite= در دمو. بعد از موفقیت، نشستِ پروفایل
// ساخته و حساب به همان پروفایل قفل می‌شود؛ خطاها با صفحهٔ شفاف + راه برگشت.
let inviteHandled = false;
const inviteTokenFromEnv = () => {
  if (inviteHandled) return '';
  const sp = String(TG?.initDataUnsafe?.start_param || '').trim();
  const qp = String(qs.get('invite') || '').trim();
  return sp || qp;
};

// v2.19.0 — نسخهٔ نرم‌افزار در فوتر پنل واحدها (از /health عمومی — هم دمو هم واقعی)
function setFooterVersion(v) {
  const el = $('#df-version');
  if (el && v) el.textContent = 'نسخهٔ ' + faNum(String(v));
}
try {
  api('/health').then(h => setFooterVersion(h && h.version)).catch(() => { /* بی‌صدا */ });
} catch { /* ignore */ }

async function boot() {
  renderSplash();
  // v2.15.0 — مهاجرت امن کلید قدیمی به کلید مخصوص همین پروفایل تلگرام
  await migrateLegacyToken();
  // 0) v2.17.0 — لینک دعوت یک‌بارمصرف: اتصال حساب به این پروفایل + ورود
  //    v2.20.0 — اثبات مالکیت با یوزر/پسورد همان حساب (پروتکل دومرحله‌ای:
  //    اول بدون اعتبارنامه می‌پرسیم؛ اگر لینک سالم و جدید بود فرم اعتبارنامه)
  const inviteToken = inviteTokenFromEnv();
  if (inviteToken) {
    inviteHandled = true;
    try {
      const r = await api('/auth/invite', { method: 'POST', body: { token: inviteToken } });
      await inviteEnter(r);
      return;
    } catch (e) {
      if (e && e.code === 'invite_credentials_required') {
        renderInviteCredentials(inviteToken);
        return;
      }
      renderInviteError(e);
      return;
    }
  }
  // 1) existing session token → straight in
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

// v2.20.0 — ورود بعد از مصرف موفق لینک (مشترک بین مسیر مستقیم و فرم اعتبارنامه)
async function inviteEnter(r) {
  setToken(r.token);
  haptic('success');
  toast('حساب شما به این پروفایل تلگرام متصل شد', 'ok');
  const me = await api('/auth/me');
  enterApp(me);
}

// v2.20.0 — فرم «اتصال حساب با لینک دعوت»: اثبات مالکیت با یوزرنیم/رمز عبور
// همان حساب. این همان چرخه‌ای است که انتقال حساب به پروفایل جدید را کامل می‌کند:
// لینک + پروفایل جدید + یوزر/رمز درست → حساب منتقل و پروفایل قبلی بیرون می‌افتد.
function renderInviteCredentials(token) {
  $('#tabbar').hidden = true;
  $('#btn-settings').hidden = true;
  $('#hsub').textContent = '';
  $('#main').innerHTML = `
    <div class="view"><div class="screen">
      <div class="logo">${icon('link', 30)}</div>
      <h2>اتصال حساب با لینک دعوت</h2>
      <p style="max-width:300px">این لینک حساب را به همین پروفایل تلگرام منتقل می‌کند و پروفایل قبلی از حساب خارج می‌شود. برای امنیت، <b>نام کاربری و رمز عبور همان حساب</b> را وارد کنید.</p>
      <form id="inv-form" class="login-box" style="width:100%;max-width:300px">
        <div class="field">
          <label for="inv-user">نام کاربری</label>
          <input id="inv-user" autocomplete="username" autocapitalize="none" dir="ltr" style="text-align:center" required>
        </div>
        <div class="field">
          <label for="inv-pass">رمز عبور</label>
          <input id="inv-pass" type="password" autocomplete="current-password" dir="ltr" style="text-align:center" required>
        </div>
        <button class="btn block" id="inv-go" type="submit">${icon('link', 16)} اتصال حساب</button>
        <div class="hint" id="inv-err" style="color:var(--danger);min-height:18px"></div>
      </form>
      <button class="btn subtle block" id="inv-cancel" style="max-width:300px">${icon('user', 15)} انصراف — ورود با نام کاربری</button>
    </div></div>`;
  $('#inv-cancel').addEventListener('click', renderLogin);
  $('#inv-form').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('#inv-user').value.trim();
    const password = $('#inv-pass').value;
    if (!username || !password) return;
    const btn = $('#inv-go');
    btn.disabled = true;
    $('#inv-err').textContent = '';
    try {
      const r = await api('/auth/invite', { method: 'POST', body: { token, username, password } });
      await inviteEnter(r);
    } catch (e2) {
      if (e2 && (e2.code === 'invite_bad_credentials' || e2.code === 'invite_credentials_required')) {
        btn.disabled = false;
        $('#inv-err').textContent = 'نام کاربری یا رمز عبور این حساب درست نیست';
      } else {
        renderInviteError(e2);
      }
    }
  });
}

function renderInviteError(e) {
  $('#tabbar').hidden = true;
  $('#btn-settings').hidden = true;
  $('#hsub').textContent = '';
  $('#main').innerHTML = `
    <div class="view"><div class="screen">
      <div class="logo">${icon('link', 30)}</div>
      <h2>لینک دعوت قابل استفاده نیست</h2>
      <p style="max-width:300px">${esc(e && e.message || 'لینک دعوت معتبر نیست.')}</p>
      <button class="btn block" id="inv-login" style="max-width:280px">${icon('user', 16)} ورود با نام کاربری</button>
    </div></div>`;
  $('#inv-login').addEventListener('click', renderLogin);
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
      if (r.linked_telegram) toast('حساب شما به این پروفایل تلگرام متصل شد', 'ok');
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
      ['tasks', 'کارها', 'clipboard'],
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
      ['perf', 'عملکرد مدیر', 'clipboard'],
      ['guide', 'راهنما', 'book']
    ] : [];
  } else {
    tabs = [
      ['my', 'وضعیت من', 'home'],
      ['myreports', 'گزارش سالانه', 'chart'],
      ['myhistory', 'تاریخچه', 'file'],
      ['perf', 'عملکرد مدیر', 'clipboard'],
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
    // v2.16.0 — هدر جمع‌شده با تعویض تب همیشه برگردد
    $('#hdr')?.classList.remove('hide');
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
    const uCredit = Math.max(0, Number(u.credit) || 0);
    return `
    <div class="row clickable" data-action="unit-open" data-id="${u.id}">
      <div class="badge">${esc(faNum(u.number))}</div>
      <div class="mid">
        <div class="t1">${esc(u.resident_name || 'بدون ساکن')}</div>
        <div class="t2">${faNum(u.area_m2)} متر • ${faNum(u.residents_count)} نفر ${hasAcc ? ' • حساب ساکن فعال' : ''}</div>
      </div>
      <div class="end" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        ${u.debt > 0
          ? `<span class="chip unpaid">${fmtMoney(u.debt)}</span>`
          : '<span class="chip paid">تسویه</span>'}
        ${uCredit > 0 ? `<span class="chip accent" title="اعتبار اضافه‌پرداخت — در شارژ ماه‌های بعد کسر می‌شود">${icon('wallet', 11)} اعتبار ${fmtMoney(uCredit)}</span>` : ''}
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

// v2.12.0 (بند ۱): هر زمان فقط یک مودال واحد باز است — بازکردن دوباره، مودال
// قبلی را «جایگزین» می‌کند نه اینکه روی آن باز شود (رفع باگ پنجره روی پنجره
// پس از ثبت/لغو پرداخت و ایجاد حساب ساکن).
let unitSheet = null;

// تاریخ شمسی {jy,jm,jd} از timestamp (تقویم تهران) — برای پیش‌پرکردن تاریخ
// پرداخت هنگام ویرایش پرداخت ثبت‌شده.
function tsToJalali(ts) {
  const p = tehranParts(Number(ts) * 1000);
  return toJalaaliFromParts(p.gy, p.gm, p.gd);
}

async function openUnitModal(unitId) {
  const unit = state.unitsCache.find(u => u.id === unitId);
  if (!unit) return;
  const [{ debts }, accRes, creditsRes] = await Promise.all([
    api('/debts?unit_id=' + unitId),
    api('/residents?unit_id=' + unitId).catch(() => ({ residents: [] })),
    // v2.21.0 — دفتر اعتبار اضافه‌پرداخت واحد (برای نمایش و مدیریت)
    api('/credits?unit_id=' + unitId).catch(() => ({ entries: [] }))
  ]);
  debts.forEach(x => { state.debtCache[x.id] = x; });
  const acc = (accRes.residents || [])[0] || null;
  const unitCredit = Math.max(0, Number(unit.credit) || 0);
  const creditRows = (creditsRes.entries || []).slice(0, 8).map(e => `
    <div class="row" style="padding:6px 0">
      <div class="badge ${e.amount > 0 ? '' : 'gray'}">${icon(e.amount > 0 ? 'plus' : 'wallet', 14)}</div>
      <div class="mid">
        <div class="t1" style="color:${e.amount > 0 ? 'var(--ok)' : 'var(--muted)'}">${e.amount > 0 ? '+' : '−'}${fmtMoney(Math.abs(e.amount))}</div>
        <div class="t2">${esc(e.note || '')} • ${claimDate(e.created_at)}</div>
      </div>
      ${e.kind === 'add' ? `<button class="btn danger sm" data-action="credit-del" data-id="${e.id}" title="حذف ثبت اشتباه">${icon('trash', 13)}</button>` : ''}
    </div>`).join('');

  const lines = (debts || []).map(x => `
    <div class="debt-line">
      <div class="dl-top">
        <div>
          <div class="dl-desc">${esc(x.description)}</div>
          <div class="dl-sub">${esc(periodLabel(x.period))} • ${fmtMoney(x.paid_amount)} از ${fmtMoney(x.amount)} پرداخت شده${x.method ? ' • ' + esc(x.method) : ''}</div>
          ${x.note ? `<div class="dl-note">${esc(x.note)}</div>` : ''}
        </div>
        ${statusChip(x.status)}
      </div>
      <div class="dl-actions">
        ${x.status !== 'paid' ? `<button class="btn ok sm" data-action="debt-pay" data-id="${x.id}">${icon('wallet', 14)} ثبت پرداخت</button>` : ''}
        ${x.status !== 'paid' && unitCredit > 0 ? `<button class="btn subtle sm" data-action="credit-apply" data-id="${x.id}">${icon('plus', 14)} اعمال اعتبار</button>` : ''}
        ${x.paid_amount > 0 ? `<button class="btn subtle sm" data-action="debt-edit" data-id="${x.id}">${icon('edit', 14)} ویرایش</button>
        <button class="btn subtle sm" data-action="debt-unpay" data-id="${x.id}">${icon('undo', 14)} لغو پرداخت</button>` : ''}
        <button class="btn danger sm" data-action="debt-del" data-id="${x.id}">${icon('trash', 14)}</button>
      </div>
    </div>`).join('');

  // v2.17.0 — کارت حساب واحد: اگر واحد حساب مدیر دارد (یوزر/پسورد پنل اصلی)،
  // دیگر «ساخت حساب ساکن» پیشنهاد نمی‌شود؛ برای حساب ساکن، لینک دعوت یک‌بارمصرف هم هست.
  const mgrAcc = unit.manager_account || null;
  const tgChip = linked => linked ? '<span class="chip accent">متصل</span>' : '<span class="chip neutral">متصل نیست</span>';
  const accountCard = acc ? `
    <div class="card" style="margin-top:12px">
      <div class="kv"><span class="k">حساب کاربری ساکن</span><span class="v" dir="ltr">${esc(acc.username)}</span></div>
      <div class="kv"><span class="k">نام</span><span class="v">${esc(acc.full_name || '—')}</span></div>
      <div class="kv"><span class="k">وضعیت</span><span class="v">${acc.is_active ? '<span class="chip paid">فعال</span>' : '<span class="chip unpaid">غیرفعال</span>'}</span></div>
      <div class="kv"><span class="k">اتصال تلگرام</span><span class="v">${acc.telegram_linked ? `<span class="chip accent">متصل</span>${acc.telegram_username ? ` <span dir="ltr" class="p-muted">@${esc(acc.telegram_username)}</span>` : ''}` : (acc.telegram_username ? `<span class="chip neutral">در انتظار اتصال</span> <span dir="ltr" class="p-muted">@${esc(acc.telegram_username)}</span>` : '<span class="chip neutral">متصل نیست</span>')}</span></div>
      <button class="btn subtle block sm" data-action="invite-link" data-id="${acc.id}" style="margin-top:8px">${icon('link', 14)} لینک اتصال تلگرام (یک‌بارمصرف)</button>
      <button class="btn subtle block sm" data-action="resident-manage" data-id="${acc.id}" style="margin-top:8px">${icon('user', 14)} مدیریت حساب ساکن</button>
    </div>` : (mgrAcc ? `
    <div class="card" style="margin-top:12px">
      <div class="kv"><span class="k">حساب این واحد</span><span class="v">مدیر ساختمان — <b dir="ltr">${esc(mgrAcc.username)}</b></span></div>
      <div class="kv"><span class="k">نام</span><span class="v">${esc(mgrAcc.full_name || '—')}</span></div>
      <div class="kv"><span class="k">اتصال تلگرام</span><span class="v">${tgChip(mgrAcc.telegram_linked)}</span></div>
      <div class="hint" style="margin-top:8px">این واحد با همان یوزرنیم و رمزِ پنل اصلی فعال است؛ مدیر با ورود به اپ، علاوه بر پنل مدیریت، تب «واحد من» همین واحد را هم با همان حساب می‌بیند — نیازی به ساخت حساب کاربری جداگانه نیست.</div>
    </div>` : `
    <button class="btn subtle block" data-action="resident-create" data-unit="${unit.id}" style="margin-top:12px">${icon('user', 16)} ایجاد حساب کاربری برای ساکن</button>`);

  // بند ۶ (v2.12.0): فیلتر سالیانه صورت‌حساب PDF — پیش‌فرض سال جاری، به‌همراه
  // سال‌های دارای قلم و گزینه «همه سال‌ها» برای صورت‌حساب کامل.
  const curJy = localPeriod().slice(0, 4);
  const debtYears = [...new Set((debts || []).map(x => String(x.period || '').slice(0, 4)).filter(Boolean))];
  const pdfYears = [...new Set([curJy, ...debtYears])].sort((a, b) => Number(b) - Number(a)).slice(0, 6);
  let pdfSel = curJy;
  const pdfLabel = () => 'دانلود صورت‌حساب ' + (pdfSel === 'all' ? 'همه سال‌ها' : 'سال ' + faNum(pdfSel));

  // بند ۱ (v2.12.0): اگر مودال واحدی از قبل باز است، اول بسته شود تا مودال جدید
  // «جایگزین» آن شود؛ نه اینکه پنجره روی پنجره باز شود.
  if (unitSheet) { const stale = unitSheet; unitSheet = null; stale.close(); }

  const modalRef = openModal({
    title: unitWord(unit.number),
    body: `
      <div class="card" style="margin-bottom:12px">
        <div class="kv"><span class="k">ساکن</span><span class="v">${esc(unit.resident_name || '—')}</span></div>
        <div class="kv"><span class="k">تلفن</span><span class="v">${esc(faNum(unit.phone || '—'))}</span></div>
        <div class="kv"><span class="k">متراژ</span><span class="v">${faNum(unit.area_m2)} متر</span></div>
        <div class="kv"><span class="k">تعداد ساکنین</span><span class="v">${faNum(unit.residents_count)} نفر</span></div>
        ${unitCredit > 0 ? `<div class="kv"><span class="k">اعتبار اضافه‌پرداخت</span><span class="v" style="color:var(--ok)">${fmtMoney(unitCredit)} — در شارژ ماه‌های بعد کسر می‌شود</span></div>` : ''}
        ${unit.note ? `<div class="kv"><span class="k">یادداشت</span><span class="v">${esc(unit.note)}</span></div>` : ''}
      </div>
      <button class="btn block" data-maction="credit-add" style="margin-bottom:12px">${icon('plus', 16)} ثبت اضافه‌پرداخت (اعتبار واحد)</button>
      ${accountCard}
      <div class="section-title" style="margin-top:14px">اقلام شارژ و هزینه</div>
      ${lines || emptyState({ ic: 'file', text: 'قلمی برای این واحد ثبت نشده است' })}
      ${creditRows ? `<div class="section-title" style="margin-top:14px">دفتر اعتبار (اضافه‌پرداخت / مصرف)</div><div class="rows">${creditRows}</div>` : ''}
      <div class="section-title" style="margin-top:14px">صورت‌حساب PDF</div>
      <div class="filter-row" data-pdf-years>
        ${pdfYears.map(y => `<button class="fchip ${y === pdfSel ? 'on' : ''}" data-py="${y}">${faNum(y)}</button>`).join('')}
        <button class="fchip ${pdfSel === 'all' ? 'on' : ''}" data-py="all">همه سال‌ها</button>
      </div>
      <button class="btn block" data-maction="unit-pdf">${icon('download', 16)} ${pdfLabel()}</button>`,
    footer: `
      <button class="btn subtle" data-maction="unit-edit" data-id="${unit.id}">${icon('edit', 16)} ویرایش</button>
      <button class="btn danger" data-maction="unit-del" data-id="${unit.id}">${icon('trash', 16)} حذف</button>`,
    onMount(m) {
      $$('[data-py]', m.el).forEach(c => c.addEventListener('click', () => {
        pdfSel = c.dataset.py;
        $$('[data-py]', m.el).forEach(x => x.classList.toggle('on', x === c));
        const btn = $('[data-maction="unit-pdf"]', m.el);
        if (btn) btn.innerHTML = icon('download', 16) + ' ' + pdfLabel();
      }));
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'unit-edit') openUnitForm(unit.id);
        if (act === 'unit-pdf') downloadPdf('statement', { unitId: unit.id, jy: pdfSel === 'all' ? '' : pdfSel });
        // v2.21.0 — ثبت دستی اضافه‌پرداخت (اعتبار واحد)
        if (act === 'credit-add') openCreditRegisterModal(unit);
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
  unitSheet = modalRef;
}

// ---------------------------------------------------------------------------
// v2.21.0 — اعتبار اضافه‌پرداخت: ثبت دستی + اعمال روی قلم + حذف ثبتِ اشتباه
// ---------------------------------------------------------------------------
function openCreditRegisterModal(unit, onDone) {
  openModal({
    title: 'ثبت اضافه‌پرداخت — ' + unitWord(unit.number),
    body: `
      <div class="form-grid">
        <div class="field"><div class="hint">اگر ساکن بیشتر از بدهی‌اش پرداخت کرده، مابه‌التفاوت را اینجا ثبت کنید تا «اعتبار» واحد شود؛ در صدور شارژ ماه‌های بعدی خودکار از آن کسر می‌شود و ساکن همان‌جا می‌بیند.</div></div>
        ${moneyField({ id: 'cr-amount', label: 'مبلغ اضافه‌پرداخت (تومان)' })}
        <div class="field"><label>یادداشت</label><input id="cr-note" placeholder="اختیاری — مثلاً واریزی اردیبهشت"></div>
        ${Math.max(0, Number(unit.credit) || 0) > 0 ? `<div class="field"><div class="hint">اعتبار فعلی واحد: <b style="color:var(--ok)">${fmtMoney(unit.credit)}</b> تومان</div></div>` : ''}
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn ok" data-maction="go">${icon('wallet', 16)} ثبت اعتبار</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#cr-amount', m.el).value);
        if (!(amount > 0)) { toast('مبلغ را وارد کنید', 'err'); return; }
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const res = await api('/credits', {
            method: 'POST',
            body: { unit_id: unit.id, amount, note: $('#cr-note', m.el).value.trim() }
          });
          haptic('success');
          toast(`اعتبار ${fmtMoney(res.registered || amount)} ثبت شد — مانده اعتبار: ${fmtMoney(res.credit_balance || 0)}`, 'ok', 4500);
          m.close();
          refresh();
          if (onDone) onDone();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; b.innerHTML = `${icon('wallet', 16)} ثبت اعتبار`; }
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
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. به‌محض اولین ورود ساکن به اپ داخل تلگرام (یا استارت ربات)، حسابش خودکار متصل می‌شود و می‌توانید برایش پیام شخصی بفرستید.</div>
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

function openResidentManageModal(acc, onDone) {
  const linked = Boolean(acc.telegram_linked);
  const done = () => { if (onDone) onDone(); else refresh(); };
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
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. به‌محض اولین ورود ساکن به اپ داخل تلگرام (یا استارت ربات)، اتصال خودکار انجام می‌شود.</div>
        </div>
        ${linked ? `<button class="btn block" data-maction="msg">${icon('send', 15)} ارسال پیام شخصی تلگرام</button>` : ''}
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
            m.close(); done();
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        } else if (act === 'msg') {
          openResidentMessageModal(acc);
        } else if (act === 'toggle') {
          try {
            await api('/residents/' + acc.id, { method: 'PUT', body: { is_active: !acc.is_active } });
            toast(acc.is_active ? 'حساب غیرفعال شد' : 'حساب فعال شد', 'ok');
            m.close(); done();
          } catch (e) { toast(e.message, 'err'); }
        } else if (act === 'del') {
          const okd = await confirmDialog('این حساب ساکن حذف شود؟ ساکن دیگر نمی‌تواند وارد شود.');
          if (!okd) return;
          try {
            await api('/residents/' + acc.id, { method: 'DELETE', body: {} });
            toast('حساب حذف شد', 'ok');
            m.close(); done();
          } catch (e) { toast(e.message, 'err'); }
        }
      }));
    }
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

// ---------------------------------------------------------------------------
// v2.17.0 — لینک اتصال تلگرام (یک‌بارمصرف با زمان انقضای انتخابی)
// لینک به شکل «https://t.me/<bot>?startapp=<token>» ساخته می‌شود؛ با باز کردنش
// داخل تلگرام، حساب ساکن به همان پروفایل قفل می‌شود و نشست‌های قبلی باطل می‌شوند.
// ---------------------------------------------------------------------------
const INVITE_HOURS = [
  [1, '۱ ساعت'], [6, '۶ ساعت'], [12, '۱۲ ساعت'],
  [24, '۲۴ ساعت'], [72, '۳ روز'], [168, '۷ روز']
];

function inviteExpiryLabel(ts) {
  const left = Math.max(0, (Number(ts) || 0) - Math.floor(Date.now() / 1000));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60);
  if (h >= 24) return `${faNum(Math.floor(h / 24))} روز و ${faNum(h % 24)} ساعت مانده`;
  if (h > 0) return `${faNum(h)} ساعت و ${faNum(m)} دقیقه مانده`;
  return `${faNum(m)} دقیقه مانده`;
}

async function copyInviteLink(url) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
      toast('لینک کپی شد — برای ساکن بفرستید', 'ok');
      return;
    }
    throw new Error('no clipboard');
  } catch {
    // تلگرام WebView ممکن است Clipboard را ندهد — لینک برای کپی دستی انتخاب می‌شود
    try {
      const inp = $('#inv-url');
      if (inp) { inp.focus(); inp.select(); document.execCommand('copy'); toast('لینک کپی شد', 'ok'); return; }
    } catch { /* fall through */ }
    toast('کپی خودکار ممکن نشد — لینک را دستی انتخاب و کپی کنید', 'err');
  }
}

async function openInviteModal(acc, onDone, unitLabel = '') {
  const done = () => { if (onDone) onDone(); else refresh(); };
  // لینک فعالِ همین حساب (اگر باشد) اول نمایش داده می‌شود
  let active = null;
  try {
    const { invites } = await api('/invites');
    active = (invites || []).find(i => i.user_id === acc.id) || null;
  } catch { /* اولین بار ممکن است هنوز ربات تنظیم نشده باشد */ }

  const linkBox = inv => inv ? `
    <div class="card" style="padding:10px 12px">
      <div class="kv"><span class="k">لینک فعال</span><span class="v"><span class="chip accent">فعال</span> <span class="p-muted">${inviteExpiryLabel(inv.expires_at)}</span></span></div>
      <div class="field" style="margin-top:8px">
        <input id="inv-url" dir="ltr" readonly value="${esc(inv.url || '')}" style="font-size:12px" onclick="this.select()">
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn sm" style="flex:1" data-iact="copy">${icon('copy', 14)} کپی لینک</button>
        ${inv.url ? `<a class="btn subtle sm" style="flex:1;text-align:center;text-decoration:none" href="${esc(inv.url)}" target="_blank" rel="noopener">${icon('link', 14)} بازکردن لینک</a>` : ''}
        <button class="btn danger sm" data-iact="revoke" data-id="${inv.id}">${icon('trash', 14)} باطل کردن</button>
      </div>
    </div>` : '';

  const m = openModal({
    title: 'لینک اتصال تلگرام — ' + (acc.full_name || acc.username),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">حساب</span><span class="v" dir="ltr">${esc(acc.username)}</span></div>
          ${unitLabel ? `<div class="kv"><span class="k">واحد</span><span class="v">${esc(unitLabel)}</span></div>` : ''}
          <div class="kv"><span class="k">اتصال فعلی</span><span class="v">${acc.telegram_linked ? '<span class="chip accent">متصل</span>' : '<span class="chip neutral">متصل نیست</span>'}</span></div>
        </div>
        <div id="inv-active">${linkBox(active)}</div>
        <div class="hint">این لینک <b>فقط یک بار</b> کار می‌کند: ساکن باید آن را <b>از داخل تلگرام و با پروفایل خودش</b> باز کند. با باز کردن لینک، حسابش فقط به همان پروفایل قفل می‌شود — پروفایل‌های قبلی و ورود با یوزر/پسورد از پروفایل دیگر دیگر اپ را باز نمی‌کنند.</div>
        <div class="field"><label>اعتبار لینک جدید</label>
          <div class="filter-row" data-inv-hours>
            ${INVITE_HOURS.map(([h, l], i) => `<button class="fchip ${i === 3 ? 'on' : ''}" data-h="${h}">${l}</button>`).join('')}
          </div>
        </div>
        <button class="btn block" data-iact="gen">${icon('plus', 16)} ساخت لینک یک‌بارمصرف</button>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">بستن</button>`,
    onMount(mm) {
      let hours = 24;
      $$('[data-inv-hours] .fchip', mm.el).forEach(c => c.addEventListener('click', () => {
        hours = Number(c.dataset.h) || 24;
        $$('[data-inv-hours] .fchip', mm.el).forEach(x => x.classList.toggle('on', x === c));
      }));
      const done2 = async () => {
        // بعد از ساخت/ابطال، کارت لینک فعال داخل همین مودال تازه می‌شود
        try {
          const r2 = await api('/invites');
          const act2 = (r2.invites || []).find(i => i.user_id === acc.id) || null;
          const box = $('#inv-active', mm.el);
          if (box) {
            box.innerHTML = linkBox(act2);
            bindLinkBox(box);
          }
        } catch { /* ignore */ }
      };
      const bindLinkBox = scope => {
        $$('[data-iact]', scope).forEach(b => b.addEventListener('click', async () => {
          const act = b.dataset.iact;
          if (act === 'copy') {
            const inp = $('#inv-url', mm.el);
            if (inp && inp.value) copyInviteLink(inp.value);
          } else if (act === 'revoke') {
            b.disabled = true;
            try {
              await api('/invites/' + Number(b.dataset.id), { method: 'DELETE', body: {} });
              toast('لینک باطل شد', 'ok');
              await done2();
            } catch (e) { toast(e.message, 'err'); b.disabled = false; }
          }
        }));
      };
      bindLinkBox(mm.el);
      const genBtn = $('[data-iact="gen"]', mm.el);
      if (genBtn) genBtn.addEventListener('click', async () => {
        genBtn.disabled = true;
        try {
          const r = await api('/invites', { method: 'POST', body: { user_id: acc.id, hours } });
          haptic('success');
          toast('لینک یک‌بارمصرف ساخته شد', 'ok');
          await done2();
          const inp = $('#inv-url', mm.el);
          if (inp && inp.value) copyInviteLink(inp.value);
          void r;
        } catch (e) { toast(e.message, 'err'); genBtn.disabled = false; }
      });
      $$('[data-maction]', mm.el).forEach(b => b.addEventListener('click', () => {
        if (b.dataset.maction === 'cancel') { mm.close(); done(); }
      }));
    }
  });
  return m;
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
// v2.16.0 — رسیدهای پرداخت شارژ (فیش واریزی ساکن + بررسی مدیر)
// ---------------------------------------------------------------------------
function claimStatusChip(status) {
  const map = {
    pending: ['partial', 'در انتظار بررسی', 'eye'],
    confirmed: ['paid', 'تأیید شد', 'check'],
    rejected: ['unpaid', 'بررسی نشد', 'alert']
  };
  const [cls, label, ic] = map[status] || map.pending;
  return `<span class="chip ${cls}">${icon(ic, 11)}${label}</span>`;
}

function claimDate(ts) {
  try { return fmtDate(ts); } catch { return ''; }
}

// کارت رسیدِ در انتظار بررسی — تب شارژ مدیر
function pendingClaimCard(c) {
  const file = (c.files || [])[0];
  return `
    <div class="card" style="margin-bottom:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <div class="badge">${esc(faNum(unitNo(c.unit_number)))}</div>
          <b style="font-size:14px">${esc(c.unit_resident || unitWord(c.unit_number))}</b>
        </div>
        ${claimStatusChip(c.status)}
      </div>
      ${(() => { const rem = Number(c.unit_remaining) || 0; return rem > 0 ? `<div class="t2" style="color:var(--danger);margin-top:4px">مانده بدهی واحد: ${fmtMoney(rem)}</div>` : ''; })()}
      <div class="kv" style="margin-top:8px"><span class="k">مبلغ اعلام‌شده</span><span class="v">${fmtMoney(c.amount)}</span></div>
      ${c.note ? `<div class="kv"><span class="k">توضیح ساکن</span><span class="v" style="white-space:normal;text-align:left">${esc(c.note)}</span></div>` : ''}
      <div class="kv"><span class="k">تاریخ ثبت</span><span class="v">${claimDate(c.created_at)}</span></div>
      ${file ? `<button class="btn subtle sm" data-action="claim-file" data-id="${file.id}" style="margin-top:6px">${icon('clip', 14)} مشاهدهٔ فیش واریزی (${esc(file.name)})</button>` : ''}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn ok sm" data-action="claim-confirm" data-id="${c.id}">${icon('wallet', 14)} ثبت کامل</button>
        <button class="btn subtle sm" data-action="claim-partial" data-id="${c.id}">${icon('edit', 14)} ثبت جزیی</button>
        <button class="btn danger sm" data-action="claim-reject" data-id="${c.id}">${icon('trash', 14)} رد رسید</button>
      </div>
    </div>`;
}

// ردیف رسیدِ بررسی‌شده — تب شارژ مدیر
function doneClaimRow(c) {
  const file = (c.files || [])[0];
  return `
    <div class="row">
      <div class="badge gray">${esc(faNum(unitNo(c.unit_number)))}</div>
      <div class="mid">
        <div class="t1">${esc(c.unit_resident || unitWord(c.unit_number))} — ${fmtMoney(c.status === 'confirmed' ? (c.confirmed_amount || 0) : c.amount)}</div>
        <div class="t2">${c.status === 'rejected' && c.reject_note ? 'دلیل: ' + esc(c.reject_note) : (c.note ? esc(c.note) : '')} • ${claimDate(c.confirmed_at || c.created_at)}</div>
        ${(() => { const rem = Number(c.unit_remaining) || 0; return rem > 0 ? `<div class="t2" style="color:var(--danger)">مانده بدهی واحد: ${fmtMoney(rem)}</div>` : ''; })()}
      </div>
      <div class="end" style="display:flex;align-items:center;gap:8px">
        ${file ? `<button class="btn subtle sm" data-action="claim-file" data-id="${file.id}">${icon('clip', 13)}</button>` : ''}
        ${claimStatusChip(c.status)}
      </div>
    </div>`;
}

// ردیف رسیدهای خود ساکن — «واحد من»
function myClaimRow(c) {
  const file = (c.files || [])[0];
  const sub = c.status === 'confirmed'
    ? `${fmtMoney(c.confirmed_amount || 0)} تومان برای واحد شما ثبت شد • ${claimDate(c.confirmed_at || c.created_at)}`
    : (c.status === 'rejected'
      ? `${c.reject_note ? 'دلیل: ' + esc(c.reject_note) : 'با مدیر ساختمان هماهنگ کنید'} • ${claimDate(c.confirmed_at || c.created_at)}`
      : `${esc(c.note || 'بدون توضیح')} • ${claimDate(c.created_at)}`);
  return `
    <div class="row">
      <div class="badge gray">${icon('clip')}</div>
      <div class="mid">
        <div class="t1">${fmtMoney(c.amount)} ${c.status === 'confirmed' ? '— تأیید شد' : ''}</div>
        <div class="t2">${sub}</div>
      </div>
      <div class="end" style="display:flex;align-items:center;gap:8px">
        ${file ? `<button class="btn subtle sm" data-action="claim-file" data-id="${file.id}">${icon('clip', 13)}</button>` : ''}
        ${claimStatusChip(c.status)}
      </div>
    </div>`;
}

// دریافت محتوای فیش (دمو: mock — واقعی: سرور) — مثل مدارک کارها
async function fetchClaimFileBlob(fileId) {
  if (MOCK) {
    const res = await mockFetch('/claims/files/' + fileId, 'GET', {});
    if (res && res.__ok === false) throw new Error(res.error || 'خطا');
    const f = res.__file || {};
    const bin = atob(String(f.data_b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: f.mime || 'application/octet-stream' });
  }
  const res = await fetch('/api/claims/files/' + fileId, { headers: authHeaders() });
  if (!res.ok) {
    let msg = 'خطا در دریافت فیش';
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.blob();
}

// نمایش فیش: تصویر در مودال، PDF دانلود می‌شود (مثل openTaskFile)
async function openClaimFile(fileId) {
  const meta = state._claimFiles && state._claimFiles.get(fileId);
  const name = (meta && meta.name) || 'فیش واریزی';
  try {
    toast('در حال دریافت فیش…', 'info', 1500);
    const blob = await fetchClaimFileBlob(fileId);
    const url = URL.createObjectURL(blob);
    if (/^image\//.test(blob.type)) {
      openModal({
        title: name,
        body: `<div class="img-viewer"><img src="${url}" alt="${esc(name)}"></div>`,
        footer: `<button class="btn subtle" data-maction="cancel">بستن</button>`,
        onMount(m) {
          $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', () => m.close()));
        }
      });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } else {
      triggerDownload(url, name);
      toast('فایل فیش آماده شد', 'ok');
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  } catch (e) { toast(e.message, 'err'); }
}

// مودال ثبت رسید توسط ساکن — «واحد من»
async function openClaimModal() {
  let remaining = 0;
  try { const d = await api('/my/summary'); remaining = d.totals.remaining; } catch { /* ignore */ }
  state._claimFile = null;
  openModal({
    title: 'ثبت رسید پرداخت شارژ',
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">مانده بدهی واحد شما</span><span class="v" style="color:${remaining > 0 ? 'var(--danger)' : 'var(--ok)'}">${fmtMoney(remaining)}</span></div>
        </div>
        ${moneyField({ id: 'claim-amount', label: 'مبلغ پرداخت‌شده (تومان)', value: remaining > 0 ? remaining.toLocaleString('en-US') : '' })}
        <div class="field"><label for="claim-note">توضیح</label>
          <textarea id="claim-note" rows="2" maxlength="500" placeholder="مثلاً: شارژ این ماه کامل پرداخت شد یا فعلاً فلان مبلغ پرداخت کردم"></textarea>
        </div>
        <div class="field"><label>فیش واریزی (تصویر یا PDF) *</label>
          <button type="button" class="btn subtle block" id="claim-pick">${icon('clip', 16)} انتخاب فایل فیش</button>
          <input id="claim-file-input" type="file" accept="image/*,application/pdf" hidden>
          <div class="hint" id="claim-file-name" style="margin-top:6px;color:var(--warn)">فایلی انتخاب نشده — بارگذاری فیش واریزی الزامی است</div>
        </div>
        <div class="field"><div class="hint">با ثبت رسید، مدیر ساختمان با پیام تلگرام باخبر می‌شود؛ فیش شما را بررسی می‌کند و پرداخت را کامل یا جزیی ثبت می‌کند. نتیجه از طریق بات به شما هم اعلام می‌شود.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="save">${icon('check', 16)} ثبت رسید</button>`,
    onMount(m) {
      const inp = $('#claim-file-input', m.el);
      const nameBox = $('#claim-file-name', m.el);
      $('#claim-pick', m.el).addEventListener('click', () => { inp.value = ''; inp.click(); });
      inp.addEventListener('change', () => {
        const f = (inp.files || [])[0];
        if (!f) { state._claimFile = null; nameBox.textContent = 'فایلی انتخاب نشده — بارگذاری فیش واریزی الزامی است'; nameBox.style.color = 'var(--warn)'; return; }
        if (f.size > MAX_FILE_MB * 1024 * 1024) {
          toast(`فایل بزرگ‌تر از ${faNum(MAX_FILE_MB)} مگابایت است`, 'err', 5000);
          state._claimFile = null; inp.value = '';
          nameBox.textContent = 'فایلی انتخاب نشده — بارگذاری فیش واریزی الزامی است';
          nameBox.style.color = 'var(--warn)';
          return;
        }
        state._claimFile = f;
        nameBox.textContent = `فایل انتخاب‌شده: ${f.name} (${fmtSize(f.size)})`;
        nameBox.style.color = 'var(--ok)';
      });
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#claim-amount', m.el).value);
        if (!(amount > 0)) { toast('مبلغ پرداخت‌شده را وارد کنید', 'err'); return; }
        const note = $('#claim-note', m.el).value.trim();
        if (!state._claimFile) { toast('بارگذاری فیش واریزی الزامی است', 'err'); return; }
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          let payload = state._claimFile;
          if (/^image\//.test(payload.type) && payload.size > 300 * 1024) payload = await compressImage(payload);
          const data_b64 = await fileToB64(payload);
          await api('/claims', {
            method: 'POST',
            body: { amount, note, file: { name: state._claimFile.name.slice(0, 120), mime: payload.type || 'application/octet-stream', size: payload.size, data_b64 } }
          });
          haptic('success');
          toast('رسید شما ثبت شد و مدیر ساختمان باخبر می‌شود', 'ok', 4200);
          m.close();
          refresh();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; b.innerHTML = `${icon('check', 16)} ثبت رسید`; }
      }));
    }
  });
}

// ثبت کامل — کل ماندهٔ بدهی واحد از قدیمی‌ترین دوره (FIFO) تسویه می‌شود
async function confirmClaimFull(id) {
  const c = state._claims && state._claims.get(id);
  if (!c) return;
  const okd = await confirmDialog(`کل ماندهٔ بدهی ${unitWord(c.unit_number)} ثبت شود؟\n(مبلغ از قدیمی‌ترین قلم بدهی تسویه می‌شود و اگر چیزی نماند، بدهی واحد صفر می‌شود)`);
  if (!okd) return;
  try {
    const res = await sendClaimConfirm(id, {});
    haptic('success');
    let msg = `پرداخت کامل ثبت شد (${fmtMoney(res.applied || 0)})`;
    if (res.credited > 0) msg += ` + اعتبار ${fmtMoney(res.credited)}`;
    if (res.unit_remaining > 0) msg += ` — ماندهٔ بدهی واحد: ${fmtMoney(res.unit_remaining)}`;
    toast(msg, 'ok', 5000);
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// v2.21.0 — ارسال تأیید رسید؛ اگر مبلغ از ماندهٔ بدهی بیشتر باشد (کد
// 'overpay_possible') مدیر تأیید می‌کند و مابه‌التفاوت به اعتبار واحد می‌رود
async function sendClaimConfirm(id, body) {
  try {
    return await api(`/claims/${id}/confirm`, { method: 'POST', body });
  } catch (e) {
    if (e.code !== 'overpay_possible') throw e;
    const okd = await confirmDialog('مبلغ رسید بیشتر از ماندهٔ بدهی واحد است.\nمابه‌التفاوت به‌عنوان «اعتبار اضافه‌پرداخت» ثبت شود و در شارژ ماه‌های بعدی کسر گردد؟');
    if (!okd) throw e;
    return await api(`/claims/${id}/confirm`, { method: 'POST', body: { ...body, overpay: true } });
  }
}

// ثبت جزیی — مبلغ دلخواه (هر چقدر بود) و بقیهٔ بدهی می‌ماند
function openClaimPartialModal(id) {
  const c = state._claims && state._claims.get(id);
  if (!c) return;
  openModal({
    title: 'ثبت جزیی پرداخت — ' + unitWord(c.unit_number),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">مبلغ اعلام‌شدهٔ ساکن</span><span class="v">${fmtMoney(c.amount)}</span></div>
          ${c.note ? `<div class="kv"><span class="k">توضیح ساکن</span><span class="v" style="white-space:normal;text-align:left">${esc(c.note)}</span></div>` : ''}
        </div>
        ${moneyField({ id: 'claim-partial-amount', label: 'مبلغ ثبت‌شده (تومان)', value: Math.round(Number(c.amount) || 0).toLocaleString('en-US') })}
        <div class="field"><div class="hint">مبلغ از قدیمی‌ترین اقلام بدهی واحد تسویه می‌شود؛ اگر بدهی بماند، برای بعد می‌ماند. اگر مبلغ بیش از ماندهٔ بدهی باشد، مابه‌التفاوت «اعتبار اضافه‌پرداخت» واحد می‌شود. فیش را قبل از ثبت با دکمهٔ «مشاهدهٔ فیش واریزی» ببینید.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="save">${icon('wallet', 16)} ثبت پرداخت</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#claim-partial-amount', m.el).value);
        if (!(amount > 0)) { toast('مبلغ را وارد کنید', 'err'); return; }
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const res = await sendClaimConfirm(id, { amount });
          haptic('success');
          let msg = `${fmtMoney(res.applied || 0)} برای واحد ثبت شد`;
          if (res.credited > 0) msg += ` + اعتبار ${fmtMoney(res.credited)}`;
          if (res.unit_remaining > 0) msg += ` — مانده: ${fmtMoney(res.unit_remaining)}`;
          else msg += ' — بدهی واحد تسویه شد';
          toast(msg, 'ok', 5000);
          m.close();
          refresh();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; b.innerHTML = `${icon('wallet', 16)} ثبت پرداخت`; }
      }));
    }
  });
}

// رد رسید — ساکن با پیام تلگرام باخبر می‌شود
async function rejectClaim(id) {
  const c = state._claims && state._claims.get(id);
  if (!c) return;
  const okd = await confirmDialog(`رسید ${unitWord(c.unit_number)} رد شود؟\n(ساکن با پیام تلگرام باخبر می‌شود تا با شما هماهنگ کند)`);
  if (!okd) return;
  try {
    await api(`/claims/${id}/reject`, { method: 'POST', body: { reason: '' } });
    haptic('success');
    toast('رسید رد شد و ساکن باخبر شد', 'ok');
    refresh();
  } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------------------
// Views — Charges (period ledger)
// ---------------------------------------------------------------------------
async function viewCharges() {
  const [debtsRes, dash, claimsRes, unitsRes] = await Promise.all([
    api('/debts?period=' + state.period),
    api('/dashboard?period=' + state.period),
    // v2.16.0 — رسیده‌های پرداخت ساکنین (بررسی فیش واریزی)
    api('/claims').catch(() => ({ claims: [] })),
    // v2.23.0 — ماندهٔ کل بدهی هر واحد (نمایش زیر وضعیت مثل تب واحدها)
    api('/units').catch(() => ({ units: [] }))
  ]);
  const debts = debtsRes.debts || [];
  state._unitDebt = new Map((unitsRes.units || []).map(u => [u.id, Number(u.debt) || 0]));
  debts.forEach(x => { state.debtCache[x.id] = x; });
  const f = state.filter.charges;
  const list = debts.filter(x => f === 'all' || (f === 'unpaid' ? x.status !== 'paid' : x.status === 'paid'));

  // v2.16.0 — رسیدهای در انتظار بررسی + آخرین موارد بررسی‌شده (فقط برای مدیر)
  const allClaims = claimsRes.claims || [];
  state._claims = new Map(allClaims.map(c => [c.id, c]));
  state._claimFiles = new Map();
  for (const cl of allClaims) for (const fl of (cl.files || [])) state._claimFiles.set(fl.id, { ...fl, claim_id: cl.id });
  const pendingClaims = allClaims.filter(c => c.status === 'pending');
  const doneClaims = allClaims.filter(c => c.status !== 'pending').slice(0, 3);
  const claimsSection = state.role === 'manager' ? `
    <div class="section-title">رسیدهای پرداخت ساکنین${pendingClaims.length ? ` <span class="chip warn">${faNum(pendingClaims.length)} در انتظار بررسی</span>` : ''}</div>
    <div class="field" style="margin-bottom:8px"><div class="hint">ساکنین پس از پرداخت، فیش واریزی خود را در «واحد من» بارگذاری می‌کنند و مدیر ساختمان با پیام تلگرام باخبر می‌شود. فیش را ببینید، توضیح ساکن را بخوانید و پرداخت را کامل یا جزیی ثبت کنید.</div></div>
    ${pendingClaims.length ? pendingClaims.map(pendingClaimCard).join('') : emptyState({ ic: 'check', text: 'رسید در انتظار بررسی نیست' })}
    ${doneClaims.length ? `<div class="section-title">آخرین بررسی‌شده‌ها</div>${doneClaims.map(doneClaimRow).join('')}` : ''}
  ` : '';

  const rows = list.map(x => `
    <div class="row">
      <div class="badge">${esc(faNum(unitNo(x.unit_number)))}</div>
      <div class="mid">
        <div class="t1">${esc(x.resident_name || unitWord(x.unit_number))}</div>
        <div class="t2">${esc(x.description)}</div>
        ${x.note ? `<div class="note-line">${esc(x.note)}</div>` : ''}
      </div>
      <div class="end" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span class="amount">${fmtMoney(x.amount)}</span>
        ${statusChip(x.status)}
        ${(() => { const rem = (state._unitDebt || new Map()).get(x.unit_id) || 0; return rem > 0 ? `<div class="t2" style="color:var(--danger);font-size:11px">مانده بدهی واحد: ${fmtMoney(rem)}</div>` : ''; })()}
      </div>
    </div>
    ${x.status !== 'paid' ? `<div style="display:flex;gap:8px;margin:-4px 0 8px;padding:0 4px">
      <button class="btn ok sm" data-action="debt-pay" data-id="${x.id}">${icon('wallet', 14)} ثبت پرداخت</button>
      ${x.paid_amount > 0 ? `<button class="btn subtle sm" data-action="debt-edit" data-id="${x.id}">${icon('edit', 14)} ویرایش</button>
      <button class="btn subtle sm" data-action="debt-unpay" data-id="${x.id}">${icon('undo', 14)} لغو پرداخت</button>` : ''}
      <button class="btn danger sm" data-action="debt-del" data-id="${x.id}">${icon('trash', 14)}</button>
    </div>` : (x.paid_amount > 0 || x.note ? `<div style="display:flex;gap:8px;margin:-4px 0 8px;padding:0 4px">
      <button class="btn subtle sm" data-action="debt-edit" data-id="${x.id}">${icon('edit', 14)} ویرایش</button>
    </div>` : '')}`).join('');

  const rate = dash.month.issued ? Math.round(dash.month.collected / dash.month.issued * 100) : 0;

  return `
    ${stepperHTML({ id: 'charges-stepper', period: state.period })}
    ${claimsSection}
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--muted)">
        <span>صادرشده: <b style="color:var(--text)">${fmtNum(dash.month.issued)}</b></span>
        <span>وصول‌شده: <b style="color:var(--ok)">${fmtNum(dash.month.collected)}</b></span>
        <span>مانده: <b style="color:var(--danger)">${fmtNum(dash.month.issued - dash.month.collected)}</b></span>
      </div>
      <div class="progress" style="margin-top:9px"><i style="width:${rate}%"></i></div>
    </div>
    <button class="btn block" data-action="gen-open" style="margin-bottom:12px">${icon('plus', 17)} صدور شارژ (همه یا چند واحد انتخابی)</button>
    <div class="filter-row">
      ${[['all', 'همه'], ['unpaid', 'پرداخت‌نشده'], ['paid', 'تسویه‌شده']].map(([v, l]) =>
        `<button class="fchip ${f === v ? 'on' : ''}" data-cfilter="${v}">${l}</button>`).join('')}
    </div>
    ${rows || emptyState({
      ic: 'card',
      text: f === 'all' ? 'برای این ماه شارژی صادر نشده است' : 'موردی در این دسته نیست',
      btnLabel: f === 'all' ? 'صدور شارژ ماه' : '', btnId: '',
      // v2.14.1 — دکمهٔ وسط صفحه که «کار نمی‌کرد» حالا همان مودال صدور را باز
      // می‌کند (روش ثابت/متراژ/نفرات) — از طریق delegation جهانی
      btnAction: f === 'all' ? 'gen-open' : ''
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
  // v2.15.0 — صدور برای همه یا چند واحد انتخابی؛ پیش‌فرض: همهٔ واحدها
  const units = state.unitsCache.slice();
  const sel = new Set(units.map(u => u.id));
  const selWord = () => (sel.size === units.length ? 'همهٔ واحدها' : faNum(sel.size) + ' واحد انتخاب‌شده');
  openModal({
    title: 'صدور شارژ ' + periodLabel(state.period),
    body: `
      <div class="form-grid">
        <div class="field"><label>روش محاسبه</label>
          <div class="radio-cards" id="gen-modes">
            ${modes.map(([v, t, s], i) => `<button class="rcard ${i === 0 ? 'on' : ''}" data-mode="${v}">${t}<small>${s}</small></button>`).join('')}
          </div>
        </div>
        ${moneyField({ id: 'gen-amount', label: 'مبلغ', value: state.settings.default_monthly_amount ? Number(state.settings.default_monthly_amount).toLocaleString('en-US') : '' })}
        <div class="field"><label>واحدها — ${units.length ? 'برای همه صادر می‌شود مگر اینکه انتخاب کنید' : 'واحدی ثبت نشده'}</label>
          ${units.length ? `
          <div class="filter-row" id="gen-units" style="flex-wrap:wrap">
            ${units.map(u => `<button type="button" class="fchip on" data-gen-unit="${u.id}">${esc(faNum(unitNo(u.number)))}</button>`).join('')}
          </div>
          <div class="hint" id="gen-sel-hint" style="margin-top:6px">انتخاب‌شده: ${selWord()} — با لمس نام واحد، از صدور خارج/وارد می‌شود.</div>` : ''}
        </div>
        <div class="field"><div class="hint" id="gen-preview"></div></div>
        <div class="field"><div class="hint">اقلامی که قبلاً برای این ماه صادر شده‌اند دوباره صادر نمی‌شوند.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('plus', 16)} صدور</button>`,
    onMount(m) {
      const defaultAmt = Number(state.settings.default_monthly_amount) || 0;
      const preview = () => {
        const amt = parseNum($('#gen-amount', m.el).value);
        if (!units.length) { $('#gen-preview', m.el).textContent = 'ابتدا از تب «واحدها» واحد ثبت کنید.'; return; }
        const picked = units.filter(u => sel.has(u.id));
        if (!picked.length) { $('#gen-preview', m.el).textContent = 'هیچ واحدی انتخاب نشده است.'; return; }
        const n = picked.length;
        if (mode === 'fixed') $('#gen-preview', m.el).textContent = `${faNum(n)} واحد × ${fmtNum(amt)} = ${fmtNum(amt * n)} تومان`;
        else if (mode === 'person') {
          const rc = picked.reduce((s, u) => s + (u.residents_count || 1), 0);
          $('#gen-preview', m.el).textContent = `${faNum(rc)} نفر × ${fmtNum(amt)} = ${fmtNum(amt * rc)} تومان`;
        } else {
          const area = picked.reduce((s, u) => s + (u.area_m2 || 0), 0);
          $('#gen-preview', m.el).textContent = `${faNum(area)} متر × ${fmtNum(amt)} = ${fmtNum(Math.round(amt * area))} تومان`;
        }
      };
      const applyMode = () => {
        const lbl = $('label[for="gen-amount"]', m.el);
        const picked = units.filter(u => sel.has(u.id));
        if (mode === 'fixed') {
          if (lbl) lbl.textContent = 'مبلغ هر واحد *';
          $('#gen-amount', m.el).value = defaultAmt ? defaultAmt.toLocaleString('en-US') : '';
        } else if (mode === 'area') {
          if (lbl) lbl.textContent = 'مبلغ هر متر مربع *';
          const avg = picked.length ? picked.reduce((s, u) => s + (u.area_m2 || 0), 0) / picked.length : 0;
          const per = avg && defaultAmt ? Math.round(defaultAmt / avg / 1000) * 1000 : 0;
          $('#gen-amount', m.el).value = per ? per.toLocaleString('en-US') : '';
        } else {
          if (lbl) lbl.textContent = 'مبلغ هر نفر *';
          const avg = picked.length ? picked.reduce((s, u) => s + (u.residents_count || 1), 0) / picked.length : 0;
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
      // v2.15.0 — انتخاب/لغو انتخاب هر واحد
      $$('[data-gen-unit]', m.el).forEach(ch => ch.addEventListener('click', () => {
        const id = Number(ch.dataset.genUnit);
        if (sel.has(id)) { sel.delete(id); ch.classList.remove('on'); }
        else { sel.add(id); ch.classList.add('on'); }
        const hint = $('#gen-sel-hint', m.el);
        if (hint) hint.textContent = 'انتخاب‌شده: ' + selWord() + ' — با لمس نام واحد، از صدور خارج/وارد می‌شود.';
        preview();
      }));
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#gen-amount', m.el).value);
        if (amount <= 0) { toast('مبلغ را وارد کنید', 'err'); return; }
        if (units.length && !sel.size) { toast('حداقل یک واحد را انتخاب کنید', 'err'); return; }
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          // فقط وقتی زیرمجموعهٔ واقعی است unit_ids فرستاده می‌شود؛ وگرنه همهٔ واحدها
          const subset = units.length && sel.size < units.length;
          const res = await api('/charges/generate', {
            method: 'POST',
            body: { period: state.period, mode, amount, ...(subset ? { unit_ids: [...sel] } : {}) }
          });
          haptic('success');
          let msg = `${faNum(res.created)} قلم شارژ صادر شد`;
          if (subset) msg += ' برای واحدهای انتخابی';
          if (res.skipped) msg += ` (${faNum(res.skipped)} واحد قبلاً صادر شده)`;
          // v2.21.0 — اعمال خودکار اعتبار اضافه‌پرداخت روی شارژ تازه‌صادره
          if (res.credit_used_total > 0) msg += ` • اعتبار ${fmtMoney(res.credit_used_total)} برای ${faNum(res.credit_units)} واحد اعمال شد`;
          toast(msg, 'ok', 5000);
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
  // v2.21.0 — اعتبار واحد (اگر در کش واحدها باشد) برای نمایش در مودال پرداخت
  const unitRow = (state.unitsCache || []).find(u => u.id === debt.unit_id);
  const unitCreditBal = Math.max(0, Number(unitRow && unitRow.credit) || 0);
  openModal({
    title: 'ثبت پرداخت — ' + unitWord(debt.unit_number),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">شرح</span><span class="v">${esc(debt.description)}</span></div>
          <div class="kv"><span class="k">مبلغ کل</span><span class="v">${fmtMoney(debt.amount)}</span></div>
          <div class="kv"><span class="k">مانده</span><span class="v" style="color:var(--danger)">${fmtMoney(remaining)}</span></div>
          ${unitCreditBal > 0 ? `<div class="kv"><span class="k">اعتبار واحد</span><span class="v" style="color:var(--ok)">${fmtMoney(unitCreditBal)}</span></div>` : ''}
        </div>
        ${moneyField({ id: 'pay-amount', label: 'مبلغ پرداخت', value: remaining.toLocaleString('en-US') })}
        <div class="field"><div class="hint">اگر مبلغ بیش از مانده وارد شود، مابه‌التفاوت به‌عنوان «اعتبار اضافه‌پرداخت» واحد ثبت می‌شود و در شارژ ماه‌های بعدی خودکار کسر می‌گردد.</div></div>
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
        // v2.21.0 — مبلغ بیشتر از مانده = اضافه‌پرداخت؛ نیاز به تأیید مدیر
        let overpay = false;
        if (amount > remaining) {
          const excess = amount - remaining;
          const okd = await confirmDialog(`ماندهٔ این قلم ${fmtMoney(remaining)} است.\nمبلغ اضافه (${fmtMoney(excess)}) به‌عنوان «اعتبار اضافه‌پرداخت» واحد ثبت شود و در شارژ ماه‌های بعدی کسر گردد؟`);
          if (!okd) return;
          overpay = true;
        }
        b.disabled = true;
        try {
          const res = await api(`/debts/${debtId}/pay`, {
            method: 'POST',
            body: {
              amount,
              method: $('#pay-method', m.el).value,
              date: readJalaaliDate('pay-date'),
              note: $('#pay-note', m.el).value.trim(),
              ...(overpay ? { overpay: true } : {})
            }
          });
          haptic('success');
          let msg = 'پرداخت ثبت شد';
          if (res.credited > 0) msg = `پرداخت ${fmtMoney(res.applied || 0)} ثبت شد + اعتبار ${fmtMoney(res.credited)} (مانده اعتبار: ${fmtMoney(res.credit_balance || 0)})`;
          toast(msg, 'ok', 5000);
          m.close();
          if (onDone) onDone(); else navigate(state.view);
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
// v2.12.0 (بند ۲) — ویرایش پرداخت ثبت‌شده: بدون لغو پرداخت، فقط مبلغ پرداخت،
// روش، تاریخ یا یادداشت به‌روز می‌شود. فقط برای اقلامی که پرداختی دارند
// نمایش داده می‌شود (اقلام بدون ثبت پرداخت، ویرایش ندارند).
// ---------------------------------------------------------------------------
async function openPayEditModal(debtId, onDone) {
  const debt = state.debtCache[debtId];
  if (!debt) return;
  const paid = Number(debt.paid_amount) || 0;
  if (paid <= 0) { toast('برای این قلم پرداختی ثبت نشده است', 'info'); return; }
  const j = debt.paid_at ? tsToJalali(debt.paid_at) : null;
  const methodOpts = ['کارت به کارت', 'نقدی', 'پایا', 'سایر'];
  const method = debt.method && methodOpts.includes(debt.method) ? debt.method
    : debt.method ? '__other__' : methodOpts[0];
  const methodHtml = method === '__other__'
    ? methodOpts.map(o => `<option>${o}</option>`).join('') + `<option selected>${esc(debt.method)}</option>`
    : methodOpts.map(o => `<option${o === method ? ' selected' : ''}>${o}</option>`).join('');
  openModal({
    title: 'ویرایش پرداخت — ' + unitWord(debt.unit_number),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">شرح</span><span class="v">${esc(debt.description)}</span></div>
          <div class="kv"><span class="k">مبلغ کل</span><span class="v">${fmtMoney(debt.amount)}</span></div>
          <div class="kv"><span class="k">پرداخت‌شده فعلی</span><span class="v" style="color:var(--ok)">${fmtMoney(paid)}</span></div>
        </div>
        ${moneyField({ id: 'pay-amount', label: 'مبلغ پرداخت', value: paid.toLocaleString('en-US') })}
        <div class="field"><label>روش پرداخت</label>
          <select id="pay-method">${methodHtml}</select></div>
        <div class="field"><label>تاریخ پرداخت</label>${jalaaliDateFields({ prefix: 'pay-date', value: j })}</div>
        <div class="field"><label>یادداشت</label><input id="pay-note" value="${esc(debt.note || '')}" placeholder="اختیاری">
          <div class="hint">یادداشت قبلی با مقدار جدید جایگزین می‌شود؛ خالی‌گذاشتن یعنی حذف یادداشت.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('check', 16)} ذخیره تغییرات</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#pay-amount', m.el).value);
        if (amount <= 0) { toast('مبلغ پرداخت باید بزرگ‌تر از صفر باشد', 'err'); return; }
        if (amount > debt.amount) { toast('مبلغ پرداخت نمی‌تواند از مبلغ کل بیشتر باشد', 'err'); return; }
        b.disabled = true;
        try {
          await api(`/debts/${debtId}/pay-edit`, {
            method: 'POST',
            body: {
              amount,
              method: $('#pay-method', m.el).value,
              date: readJalaaliDate('pay-date'),
              note: $('#pay-note', m.el).value.trim()
            }
          });
          haptic('success');
          toast('پرداخت ویرایش شد', 'ok');
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
// Views — Tasks (کارهای مدیر ساختمان) — v2.13.0
// مدیر: ثبت/ویرایش/حذف کار + مدارک پیوست + گزارش عملکرد (نمودار و PDF)
// ساکن: تب «عملکرد مدیر» همان گزارش را بدون دکمه‌های مدیریتی می‌بیند.
// ---------------------------------------------------------------------------
const TASK_CATEGORIES = [
  'نظافت', 'تعمیرات', 'آسانسور', 'برق', 'آب', 'گاز', 'نگهبانی',
  'باغبانی', 'اداری و مالی', 'خرید و تدارکات', 'سایر'
];
const MAX_FILE_MB = 6;

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return faNum((n / 1048576).toFixed(1)) + ' مگابایت';
  if (n >= 1024) return faNum(Math.round(n / 1024)) + ' کیلوبایت';
  return faNum(n) + ' بایت';
}

function taskMonthLabel(ts) {
  const j = tsToJalali(ts);
  return J_MONTHS[(j.jm || 1) - 1] + ' ' + faNum(j.jy);
}

// --- کارت‌های کارها (مشترک مدیر/ساکن) — دسته‌بندی ماه‌به‌ماه
function taskCardsHtml(tasks, canManage) {
  if (!tasks.length) {
    return emptyState({
      ic: 'clipboard',
      text: canManage ? 'هنوز کاری ثبت نشده است' : 'برای این سال کاری ثبت نشده است',
      btnLabel: canManage ? 'ثبت اولین کار' : '',
      btnId: canManage ? 'task-add-empty' : ''
    });
  }
  const groups = [];
  let curKey = null;
  for (const t of tasks) {
    const key = t.done_at ? taskMonthLabel(t.done_at) : 'بدون تاریخ';
    if (key !== curKey) { groups.push({ key, items: [] }); curKey = key; }
    groups[groups.length - 1].items.push(t);
  }
  return groups.map(g => `
    <div class="section-title">${esc(g.key)}</div>
    ${g.items.map(t => {
      const files = t.files || [];
      const atts = files.map(f => `
        <span class="att-wrap">
          <button class="att-chip" data-action="task-file" data-id="${f.id}" title="${esc(f.name)} — ${esc(fmtSize(f.size))}">
            ${icon(String(f.mime || '').startsWith('image/') ? 'img' : 'file', 13)}
            <span class="att-name">${esc(f.name)}</span>
            <span class="att-size">${esc(fmtSize(f.size))}</span>
          </button>${canManage ? `
          <button class="att-del" data-action="task-file-del" data-id="${f.id}" title="حذف ${esc(f.name)}" aria-label="حذف مدرک">${icon('trash', 12)}</button>` : ''}
        </span>`).join('');
      return `
      <div class="card task-card">
        <div class="tk-head">
          <div class="tk-title">${esc(t.title)}</div>
          <span class="chip neutral">${esc(t.category || 'سایر')}</span>
        </div>
        <div class="tk-meta">
          <span>${icon('cal', 13)} ${esc(fmtDate(t.done_at))}</span>
          <span class="${t.cost ? 'tk-cost' : 'tk-free'}">${t.cost ? fmtMoney(t.cost) : 'بدون هزینه'}</span>
        </div>
        ${t.description ? `<div class="tk-desc">${esc(t.description)}</div>` : ''}
        ${files.length ? `<div class="att-row">${atts}</div>` : ''}
        ${canManage ? `
        <div class="tk-actions">
          <button class="btn subtle sm" data-action="task-file-add" data-id="${t.id}">${icon('clip', 14)} افزودن مدرک</button>
          <button class="btn subtle sm" data-action="task-edit" data-id="${t.id}">${icon('edit', 14)} ویرایش</button>
          <button class="btn danger sm" data-action="task-del" data-id="${t.id}">${icon('trash', 14)} حذف</button>
        </div>` : ''}
      </div>`;
    }).join('')}`).join('');
}

// --- بخش گزارش عملکرد (نمودارها) — مشترک تب کارها و تب عملکرد مدیر
// canEditFund=true فقط در تب «کارها» (مدیر) → دکمهٔ تنظیم موجودی اولیهٔ صندوق
function perfReportHtml(perf, canEditFund = false, showYearSections = true) {
  const fund = perf.fund_all || {};
  const fundY = perf.fund || {};
  const opening = perf.fund_opening || {};
  const hasOpening = Math.abs(Number(opening.amount) || 0) > 0;
  const months = perf.months || [];
  const max = Math.max(1, ...months.map(m => Math.max(m.cost || 0, m.expenses || 0)));
  const bars = months.map((m, i) => {
    const hT = Math.round((m.cost || 0) / max * 100);
    const hE = Math.round((m.expenses || 0) / max * 100);
    return `<div class="bar-col" title="${esc(periodLabel(m.period))} — هزینه کارها: ${fmtNum(m.cost || 0)} | هزینه‌های مشترک: ${fmtNum(m.expenses || 0)} | ${faNum(m.tasks || 0)} کار">
      <div class="bar-pair"><span class="bar tasks" style="height:${hT}%"></span><span class="bar exp" style="height:${hE}%"></span></div>
      <span class="m">${shortMonth(i + 1)}</span></div>`;
  }).join('');

  const cats = perf.categories || [];
  const catMax = Math.max(1, ...cats.map(c => c.cost || 0));
  const catRows = cats.map(c => `
    <div class="cb-row">
      <span class="cb-name">${esc(c.category)}</span>
      <span class="cb-track"><i style="width:${Math.max(2, Math.round((c.cost || 0) / catMax * 100))}%"></i></span>
      <span class="cb-val">${faNum(c.count)} کار • ${fmtMoney(c.cost)}</span>
    </div>`).join('');

  return `
    <div class="hero fund-hero">
      <div class="label">مانده صندوق ساختمان</div>
      <div class="value ${(fund.balance || 0) >= 0 ? 'ok' : 'bad'}">${fmtMoney(fund.balance || 0)}</div>
      <div class="sub">وصول‌شده از ساکنین: <b>${fmtMoney(fund.collected || 0)}</b> • هزینه‌های مشترک: <b>${fmtMoney(fund.expenses || 0)}</b> • کارها: <b>${fmtMoney(fund.tasks_cost || 0)}</b>${hasOpening ? ` • موجودی اولیه: <b>${fmtMoney(opening.amount)}</b>${opening.note ? ` (${esc(opening.note)})` : ''}` : ''}</div>
      ${canEditFund ? `<button class="btn subtle sm" data-action="fund-edit" style="margin-top:10px">${icon('edit', 14)} تنظیم موجودی اولیه صندوق</button>` : ''}
    </div>
    <div class="field"><div class="hint">${hasOpening
      ? 'مانده صندوق = موجودی اولیه (پولی که از قبل دست مدیر قبلی بوده) + پول وصول‌شده از ساکنین منهای هزینه‌های مشترک و هزینهٔ کارهای مدیر.'
      : 'مانده صندوق = پول وصول‌شده از ساکنین (شارژ و سهم هزینه‌ها) منهای هزینه‌های مشترک ثبت‌شده و هزینهٔ کارهای ثبت‌شدهٔ مدیر.'}</div></div>
    ${!showYearSections ? '' : `
    <div class="section-title">عملکرد سال ${faNum(perf.jy)}</div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">کارهای انجام‌شده</div><div class="pc-v">${faNum((perf.totals || {}).tasks || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه کارها</div><div class="pc-v">${fmtNum((perf.totals || {}).cost || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه‌های مشترک</div><div class="pc-v">${fmtNum((perf.totals || {}).expenses_amount || 0)}</div></div>
      <div class="pcard"><div class="pc-k">وصول سال ${faNum(perf.jy)}</div><div class="pc-v">${fmtNum(fundY.collected || 0)}</div></div>
    </div>

    <div class="section-title">روند ماهانه هزینه‌ها</div>
    <div class="card chart-card">
      <div class="legend"><span><i class="lg-dot a"></i> هزینه کارها</span><span><i class="lg-dot b"></i> هزینه‌های مشترک</span></div>
      <div class="bars">${bars}</div>
    </div>
    ${cats.length ? `
    <div class="section-title">هزینه کارها به تفکیک دسته</div>
    <div class="card cat-card">${catRows}</div>` : ''}
    `}
  `;
}

// --- v2.14.1: تنظیم موجودی اولیهٔ صندوق (فقط مدیر — پول نزد مدیر قبلی)
function openFundModal() {
  openModal({
    title: 'تنظیم موجودی اولیه صندوق',
    body: `
      <div class="form-grid">
        ${moneyField({ id: 'fund-open-amount', label: 'موجودی اولیه (تومان) *', value: state._fundOpening && state._fundOpening.amount ? Number(state._fundOpening.amount).toLocaleString('en-US') : '' })}
        <div class="field"><label>توضیح (اختیاری)</label>
          <input id="fund-open-note" maxlength="200" placeholder="مثلاً: پول نقدی که از مدیر قبلی تحویل گرفته شد" value="${esc((state._fundOpening && state._fundOpening.note) || '')}"></div>
        <div class="field"><div class="hint">این مبلغ مستقیماً به «مانده صندوق ساختمان» اضافه می‌شود و برای همهٔ ساکنین در گزارش عملکرد قابل مشاهده است. برای صفر کردن، ۰ وارد کنید. مبلغ منفی هم برای اصلاح پذیرفته می‌شود.</div></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('check', 16)} ذخیره</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const amount = parseNum($('#fund-open-amount', m.el).value);
        if (!Number.isFinite(amount)) { toast('مبلغ را درست وارد کنید', 'err'); return; }
        const note = $('#fund-open-note', m.el).value.trim();
        b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const res = await api('/tasks/fund', { method: 'PUT', body: { amount, note } });
          state._fundOpening = res.fund_opening || { amount, note };
          haptic('success');
          toast(amount === 0 ? 'موجودی اولیه صفر شد' : 'موجودی اولیه ذخیره شد', 'ok');
          m.close(); navigate('tasks');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; b.innerHTML = icon('check', 16) + ' ذخیره'; }
      }));
    }
  });
}

// --- تب «کارها» (مدیر ساختمان)
async function viewTasks() {
  // v2.14.2 — حالت «همه سال‌ها»: کارِ ثبت‌شده در سالی دیگر از سالِ نمای فعلی دیده
  // نمی‌شد (هزینه‌اش از صندوق کل کسر می‌شد ولی در فهرست نبود) — با این حالت همهٔ
  // کارها (با سال در سرگروه ماه‌ها) پیدا و قابل حذف می‌شوند
  const all = !!state.tasksAll;
  const [perf, tasksRes] = await Promise.all([
    api('/reports/performance' + (all ? '' : '?jy=' + state.jy)),
    all ? api('/tasks') : api('/tasks?jy=' + state.jy)
  ]);
  state._tasks = tasksRes.tasks || [];
  state._taskFiles = new Map();
  for (const t of state._tasks) for (const f of (t.files || [])) state._taskFiles.set(f.id, { ...f, task_id: t.id });
  state._fundOpening = perf.fund_opening || { amount: 0, note: '' };

  return `
    <div class="stepper" id="task-stepper">
      <button class="st-btn" data-yd="1" aria-label="سال بعد">${icon('chevr')}</button>
      <div class="p-label"><span>سال ${faNum(state.jy)}</span><small>دفتر کارها و عملکرد مدیر</small></div>
      <button class="st-btn" data-yd="-1" aria-label="سال قبل">${icon('chevl')}</button>
    </div>

    <div class="filter-row" id="tjy-row">
      <button class="fchip ${all ? 'on' : ''}" data-tjy="all">همه سال‌ها</button>
      <button class="fchip ${!all ? 'on' : ''}" data-tjy="year">سال ${faNum(state.jy)}</button>
    </div>

    ${perfReportHtml(perf, true, !all)}

    <button class="btn block" data-action="task-add" style="margin-top:14px">${icon('plus', 17)} ثبت کار جدید</button>

    <div class="section-title" style="margin-top:6px">${all ? 'کارهای همهٔ سال‌ها' : 'کارهای ثبت‌شده'}</div>
    ${taskCardsHtml(state._tasks, true)}
    <input id="task-file-input" type="file" accept="image/*,application/pdf" multiple hidden>

    ${all ? '' : `<button class="btn block" data-action="pdf-performance" style="margin-top:14px">${icon('download', 17)} دانلود گزارش عملکرد مدیر (PDF)</button>`}
    <div class="field" style="margin-top:8px"><div class="hint">${all
      ? 'همهٔ کارهای همهٔ سال‌ها با هم — سرگروه هر ماه، نام ماه و سال را نشان می‌دهد. برای گزارش PDF، حالت «سال» را انتخاب کنید.'
      : 'هزینهٔ هر کار هنگام ثبت از صندوق کسر می‌شود و در همین گزارش برای ساکنین قابل مشاهده است. مدارک (فیش، قرارداد، برگه بازدید آسانسور و…) را با دکمه «افزودن مدرک» پیوست کنید تا ساکنین هم ببینند. اگر کاری را با تاریخ سال دیگری ثبت کرده‌اید، در همان سال یا با «همه سال‌ها» پیدا می‌شود.'}</div></div>
  `;
}

// --- تب «عملکرد مدیر» (ساکنین — فقط خواندنی)
async function viewPerf() {
  const [perf, tasksRes] = await Promise.all([
    api('/reports/performance?jy=' + state.jy),
    api('/tasks?jy=' + state.jy)
  ]);
  state._tasks = tasksRes.tasks || [];
  state._taskFiles = new Map();
  for (const t of state._tasks) for (const f of (t.files || [])) state._taskFiles.set(f.id, { ...f, task_id: t.id });

  return `
    <div class="stepper" id="perf-stepper">
      <button class="st-btn" data-yd="1" aria-label="سال بعد">${icon('chevr')}</button>
      <div class="p-label"><span>سال ${faNum(state.jy)}</span><small>عملکرد مدیر ساختمان</small></div>
      <button class="st-btn" data-yd="-1" aria-label="سال قبل">${icon('chevl')}</button>
    </div>

    ${perfReportHtml(perf, false)}

    <div class="section-title" style="margin-top:6px">کارهای انجام‌شده</div>
    ${taskCardsHtml(state._tasks, false)}

    <button class="btn block" data-action="pdf-performance" style="margin-top:14px">${icon('download', 17)} دانلود گزارش عملکرد مدیر (PDF)</button>
    <div class="field" style="margin-top:8px"><div class="hint">این گزارش نشان می‌دهد مدیر ساختمان در طول سال چه کارهایی انجام داده، هر کار چه هزینه‌ای داشته و پول ساختمان کجا خرج شده است. مدارک هر کار را می‌توانید با لمس آن باز کنید.</div></div>
  `;
}

function mountPerfView() {
  const t = $('#task-stepper');
  const p = $('#perf-stepper');
  const el = t || p;
  if (el) $$('[data-yd]', el).forEach(b => b.addEventListener('click', () => {
    state.jy = String(Number(state.jy) + Number(b.dataset.yd));
    navigate(t ? 'tasks' : 'perf');
  }));
  // v2.14.2 — چیپ‌های «همه سال‌ها / سال جاری» (فقط تب کارها)
  $$('#tjy-row [data-tjy]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.tjy === 'all';
    if (!!state.tasksAll === v) return;
    state.tasksAll = v;
    navigate('tasks');
  }));
  const addEmpty = $('#task-add-empty');
  if (addEmpty) addEmpty.addEventListener('click', () => openTaskForm());
  // هندلر بارگذاری مدارک — یک‌بار روی input دائمی وصل می‌شود
  const fin = $('#task-file-input');
  if (fin && !fin.dataset.bound) {
    fin.dataset.bound = '1';
    fin.addEventListener('change', () => handleTaskFilesSelected(fin));
  }
}

// --- فرم ثبت/ویرایش کار
function openTaskForm(existing) {
  const isEdit = Boolean(existing && existing.id);
  const j = existing && existing.done_at ? tsToJalali(existing.done_at) : null;
  openModal({
    title: isEdit ? 'ویرایش کار' : 'ثبت کار جدید',
    body: `
      <div class="form-grid">
        <div class="field"><label>عنوان کار *</label>
          <input id="tk-title" placeholder="مثلاً: سرویس و شارژ کولرهای ساختمان" value="${esc((existing && existing.title) || '')}"></div>
        <div class="field"><label>دسته</label>
          <select id="tk-cat">${TASK_CATEGORIES.map(c =>
            `<option ${((existing && existing.category) || 'سایر') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>تاریخ انجام</label>${jalaaliDateFields({ prefix: 'tk-date', value: j })}</div>
        ${moneyField({ id: 'tk-cost', label: 'هزینه کار (اختیاری — از صندوق کسر می‌شود)', required: false, value: existing && existing.cost ? Number(existing.cost).toLocaleString('en-US') : '' })}
        <div class="field"><label>توضیحات</label>
          <textarea id="tk-desc" placeholder="جزئیات کار، پیمانکار، شماره فیش و…">${esc((existing && existing.description) || '')}</textarea></div>
        ${isEdit ? '' : `
        <div class="field"><label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;color:var(--text)">
          <input type="checkbox" id="tk-notify" checked style="width:18px;height:18px;margin:0">
          <span>اعلام این کار به ساکنین با پیام تلگرام</span></label>
          <div class="hint">برای همهٔ اعضای متصل به تلگرام می‌رود: عنوان، دسته، تاریخ و هزینهٔ کار + دکمهٔ ورود به اپ. مدارک را ساکنین داخل اپ می‌بینند.</div></div>`}
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn" data-maction="go">${icon('check', 16)} ${isEdit ? 'ذخیره تغییرات' : 'ثبت کار'}</button>`,
    onMount(m) {
      bindMoneyInputs(m.el);
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const title = $('#tk-title', m.el).value.trim();
        if (!title) { toast('عنوان کار را وارد کنید', 'err'); return; }
        const cost = parseNum($('#tk-cost', m.el).value);
        if (cost < 0) { toast('مبلغ نامعتبر است', 'err'); return; }
        b.disabled = true;
        try {
          const body = {
            title,
            category: $('#tk-cat', m.el).value,
            description: $('#tk-desc', m.el).value.trim(),
            cost,
            date: readJalaaliDate('tk-date'),
            notify: $('#tk-notify', m.el) ? $('#tk-notify', m.el).checked : true
          };
          const res = isEdit ? await api('/tasks/' + existing.id, { method: 'PUT', body }) : await api('/tasks', { method: 'POST', body });
          haptic('success');
          toast(isEdit ? 'کار به‌روز شد' : 'کار ثبت شد', 'ok');
          // v2.14.2 — بازخورد اعلام به ساکنین
          if (res && res.notified !== undefined) {
            if (res.notified > 0) setTimeout(() => toast('اعلان برای ' + faNum(res.notified) + ' عضو ارسال شد', 'info', 2800), 700);
          } else if (res && res.notify_queued) {
            setTimeout(() => toast('اعلان به ساکنین متصل ارسال می‌شود', 'info', 2800), 700);
          }
          // v2.14.2 — اگر سالِ تاریخِ کار با سالِ نمای فعلی فرق داشت، خودکار به
          // همان سال برو تا کار «گم‌شده» به نظر نرسد (ریشهٔ گزارش کاربر)
          const saved = res && res.task;
          if (saved && saved.done_at) {
            const jySaved = Number(tsToJalali(saved.done_at).jy);
            if (state.tasksAll || jySaved !== Number(state.jy)) {
              state.jy = String(jySaved);
              state.tasksAll = false;
              setTimeout(() => toast('نمایش کارها به سال ' + faNum(jySaved) + ' منتقل شد', 'info', 3200), 350);
            }
          }
          m.close(); refresh();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

// --- فشرده‌سازی تصویر پیش از آپلود (تا ۱۶۰۰ پیکسل، JPEG) 
function compressImage(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(bl => resolve(bl || file), 'image/jpeg', 0.85);
      } catch { resolve(file); }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// --- آپلود مدارک برای یک کار (تصویر/PDF) — input مخفی دائمی در DOM (سازگار با
// WebView تلگرام و اتوماسیون)؛ هندلر change یک‌بار در mountPerfView وصل می‌شود
function pickAndUploadTaskFiles(taskId) {
  const inp = $('#task-file-input');
  if (!inp) { toast('فرم بارگذاری یافت نشد؛ دوباره تلاش کنید', 'err'); return; }
  inp.dataset.taskId = String(taskId);
  inp.value = '';
  inp.click();
}

async function handleTaskFilesSelected(inp) {
  const taskId = Number(inp.dataset.taskId || 0);
  const files = [...(inp.files || [])].slice(0, 8);
  if (!taskId || !files.length) return;
  let done = 0, failed = 0;
  toast('در حال بارگذاری مدارک…', 'info');
  for (const f of files) {
    try {
      let payload = f;
      if (/^image\//.test(f.type) && f.size > 300 * 1024) payload = await compressImage(f);
      const mime = payload.type || f.type || 'application/octet-stream';
      if (payload.size > MAX_FILE_MB * 1024 * 1024) {
        toast(`«${f.name}» بزرگ‌تر از ${faNum(MAX_FILE_MB)} مگابایت است`, 'err', 5000);
        failed++; continue;
      }
      const data_b64 = await fileToB64(payload);
      await api(`/tasks/${taskId}/files`, {
        method: 'POST',
        body: { name: f.name.slice(0, 120), mime, size: payload.size, data_b64 }
      });
      done++;
    } catch (e) {
      failed++;
      toast((e && e.message) || 'بارگذاری ناموفق بود', 'err', 5000);
    }
  }
  if (done) { haptic('success'); toast(`${faNum(done)} مدرک پیوست شد${failed ? ' • ' + faNum(failed) + ' ناموفق' : ''}`, failed ? 'info' : 'ok'); }
  if (done) refresh();
}

// --- دریافت محتوای مدرک (دمو: از mock — واقعی: از سرور)
async function fetchTaskFileBlob(fileId) {
  if (MOCK) {
    const res = await mockFetch('/tasks/files/' + fileId, 'GET', {});
    if (res && res.__ok === false) throw new Error(res.error || 'خطا');
    const f = res.__file || {};
    const bin = atob(String(f.data_b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: f.mime || 'application/octet-stream' });
  }
  const res = await fetch('/api/tasks/files/' + fileId, { headers: authHeaders() });
  if (!res.ok) {
    let msg = 'خطا در دریافت مدرک';
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.blob();
}

// --- نمایش مدرک: تصویر در مودال، PDF دانلود می‌شود
async function openTaskFile(fileId) {
  const meta = state._taskFiles && state._taskFiles.get(fileId);
  const name = (meta && meta.name) || 'مدرک';
  try {
    toast('در حال دریافت مدرک…', 'info', 1500);
    const blob = await fetchTaskFileBlob(fileId);
    const url = URL.createObjectURL(blob);
    if (/^image\//.test(blob.type)) {
      openModal({
        title: name,
        body: `<div class="img-viewer"><img src="${url}" alt="${esc(name)}"></div>`,
        footer: `<button class="btn subtle" data-maction="cancel">بستن</button>`,
        onMount(m) {
          $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', () => m.close()));
        }
      });
      // آزادسازی حافظه با تأخیر (مودال ممکن است مدتی باز بماند)
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } else {
      triggerDownload(url, name);
      toast('فایل مدرک آماده شد', 'ok');
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    }
  } catch (e) { toast(e.message, 'err'); }
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
  const [rep, arRes, acRes] = await Promise.all([
    api('/reports/year?jy=' + state.jy),
    isManager ? api('/autoremind').catch(() => null) : Promise.resolve(null),
    // v2.23.0 — صدور خودکار شارژ (فقط مدیر ساختمان)
    isManager ? api('/autocharge').catch(() => null) : Promise.resolve(null)
  ]);
  state.autoRemind = arRes;
  state.autoCharge = acRes;
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
    const rc = Number(u.remind_count || 0);
    const uc = Math.max(0, Number(u.credit) || 0);
    return `<tr>
      <td>${esc(faNum(u.number))}</td>
      <td>${esc(u.resident_name || '—')}</td>
      <td class="num">${fmtNum(u.issued)}</td>
      <td class="num" style="color:var(--ok)">${fmtNum(u.paid)}</td>
      <td class="num" style="color:${rem > 0 ? 'var(--danger)' : 'var(--muted)'}">${fmtNum(rem)}</td>
      <td class="num" style="color:${uc > 0 ? 'var(--ok)' : 'var(--muted)'}">${uc > 0 ? fmtNum(uc) : '—'}</td>
      <td class="num" title="${rc && u.last_remind_at ? 'آخرین یادآوری: ' + new Date(u.last_remind_at * 1000).toLocaleDateString('fa-IR') : ''}">${rem > 0 ? (rc ? faNum(rc) + ' بار' : '—') : '—'}</td>
    </tr>`;
  }).join('');
  const repCredit = Math.max(0, Number(rep.credit_total) || 0);

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

    ${repCredit > 0 ? `<div class="card" style="margin:12px 0;padding:10px 12px">
      <div class="kv"><span class="k">اعتبار اضافه‌پرداخت واحدها</span><span class="v" style="color:var(--ok)">${fmtMoney(repCredit)}</span></div>
      <div class="hint" style="margin-top:4px">پیش‌پرداخت ساکنینی که بیشتر از بدهی‌شان پرداخت کرده‌اند؛ در صدور شارژ ماه‌های بعدی خودکار کسر می‌شود.</div>
    </div>` : ''}

    <div class="section-title">وضعیت واحدها</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>واحد</th><th>ساکن</th><th>صادرشده</th><th>وصول</th><th>مانده</th><th>اعتبار</th><th>یادآوری</th></tr></thead>
      <tbody>${unitRows}</tbody></table></div>

    <button class="btn block" data-action="pdf-report" style="margin-top:14px">${icon('download', 17)} دانلود گزارش سالانه (PDF)</button>

    ${isManager ? `
    <div class="section-title" style="margin-top:16px">گزارش ماهانه همه واحدها</div>
    ${stepperHTML({ id: 'month-stepper', period: state.period })}
    <button class="btn block" data-action="pdf-monthly" style="margin-top:10px">${icon('download', 17)} دانلود گزارش ماهانه ${esc(periodLabel(state.period))} (PDF)</button>

    <div class="section-title" style="margin-top:16px">یادآوری و اعلان</div>
    <div class="rows">
      <div class="row">
        <div class="badge gray">${icon('bell')}</div>
        <div class="mid"><div class="t1">یادآوری بدهی</div><div class="t2">ارسال پیام خودکار به واحدهای بدهکار</div></div>
        <button class="btn ghost sm" data-action="remind">ارسال</button>
      </div>
      <div class="row">
        <div class="badge gray">${icon('card')}</div>
        <div class="mid"><div class="t1">صدور خودکار شارژ ماهانه</div><div class="t2">${acLineText(state.autoCharge)}</div></div>
        <button class="btn ghost sm" data-action="autocharge">تنظیم</button>
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
    <div class="rows">
      <button class="btn subtle block" data-action="export" data-type="debtors" data-fmt="xls">${icon('download', 16)} فایل اکسل بدهکاران</button>
      <button class="btn subtle block" data-action="export" data-type="year" data-fmt="xls">${icon('download', 16)} فایل اکسل خلاصه سال ${faNum(state.jy)}</button>
      <button class="btn subtle block" data-action="export" data-type="debtors">${icon('download', 16)} CSV بدهکاران</button>
      <button class="btn subtle block" data-action="export" data-type="year">${icon('download', 16)} CSV خلاصه سال ${faNum(state.jy)}</button>
      <button class="btn subtle block" data-action="export" data-type="backup" data-fmt="zip" data-files="1">${icon('db', 16)} پشتیبان کامل با مدارک (ZIP)</button>
      <button class="btn subtle block" data-action="export" data-type="backup" data-fmt="zip" data-files="0">${icon('db', 16)} پشتیبان سبک بدون مدارک (ZIP)</button>
      <button class="btn subtle block" data-action="export" data-type="backup">${icon('db', 16)} پشتیبان کامل (JSON — قدیمی)</button>
      <button class="btn subtle block" data-action="import-backup">${icon('upload', 16)} بازیابی پشتیبان (ZIP یا JSON)</button>
      <input id="import-file" type="file" accept=".zip,.json,application/zip,application/json" hidden>
    </div>` : ''}
  `;
}

function mountReports() {
  const el = $('#year-stepper');
  if (el) $$('[data-yd]', el).forEach(b => b.addEventListener('click', () => {
    state.jy = String(Number(state.jy) + Number(b.dataset.yd));
    navigate('reports');
  }));
  // v2.12.0 (بند ۴): انتخاب ماه برای گزارش ماهیانه همه واحدها
  bindStepper('month-stepper', dir => {
    state.period = dir === 0 ? localPeriod() : addPeriods(state.period, dir);
    navigate('reports');
  });
  const inp = $('#import-file');
  if (inp) inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (f) importBackupFile(f);
  });
}

// ---------------------------------------------------------------------------
// Import backup (بازیابی پشتیبان) — v2.11.0 JSON + v2.15.0 ZIP
// ZIP: همان بسته‌ای که خود اپ می‌سازد (backup.json + files/*) — سمت مرورگر
// باز می‌شود، backup.json استخراج و مسیر بازیابی JSON ادامه می‌یابد.
// ---------------------------------------------------------------------------
async function importBackupFile(file) {
  let head = new Uint8Array(0);
  try { head = new Uint8Array((await file.slice(0, 4).arrayBuffer())); } catch { /* empty */ }
  const isZip = head.length > 3 && head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04;
  const maxMB = isZip ? 80 : 12;
  if (file.size > maxMB * 1024 * 1024) { toast(`حجم فایل بیش از حد مجاز است (حداکثر ${faNum(maxMB)} مگابایت)`, 'err'); return; }
  let payload;
  if (isZip) {
    try {
      const { readZip } = await import('./lib/zip.js');
      const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
      const bj = entries.find(e => e.name === 'backup.json' || e.name.endsWith('/backup.json'));
      if (!bj) { toast('داخل این ZIP فایل backup.json پیدا نشد', 'err'); return; }
      payload = JSON.parse(new TextDecoder().decode(bj.data));
    } catch (e) {
      toast((e && e.message) || 'خواندن فایل ZIP ناموفق بود', 'err');
      return;
    }
  } else {
    try { payload = JSON.parse(await file.text()); }
    catch { toast('فایل معتبر نیست (ZIP یا JSON پشتیبان همین اپ)', 'err'); return; }
  }
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
        <div class="kv"><span class="k">کارهای مدیر</span><span class="v">${n(payload.tasks)}</span></div>
        <div class="kv"><span class="k">مدارک پیوست</span><span class="v">${n(payload.task_files)}</span></div>
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
  const linked = pv ? pv.linked_residents : 0;
  if (linked === 0) {
    toast('هیچ ساکنی به تلگرام متصل نیست. ساکنین باید یک بار داخل تلگرام با نام کاربری/رمز وارد اپ شوند تا بتوان پیام دریافت کرد.', 'info', 6500);
    return;
  }
  const okd = await confirmDialog(
    `پیام یادآوری به واحدهای بدهکار ارسال شود؟\nساکنین متصل تلگرام: ${faNum(linked)} نفر` +
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
      toast('هیچ ساکن متصلِ بدهکاری پیدا نشد؛ یادآوری ارسال نشد', 'info', 5200);
      return;
    }
    haptic('success');
    toast(`یادآوری برای ${faNum(res.sent)} ساکن ارسال شد${res.failed ? ' — ' + faNum(res.failed) + ' ناموفق' : ''}`, res.failed ? 'info' : 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function openAnnounceModal() {
  openModal({
    title: 'اعلان همگانی',
    body: `
      <div class="form-grid">
        <div class="field"><label>متن پیام برای ساکنین</label>
          <textarea id="an-text" placeholder="مثلاً: قطعی آب ساختمان فردا از ساعت ۹ تا ۱۲ خواهد بود."></textarea></div>
        <div class="field"><div class="hint">پیام برای همه ساکنینی که حساب فعال و اتصال تلگرام دارند ارسال می‌شود.</div></div>
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
// ---------------------------------------------------------------------------
function arLineText(ar) {
  if (!ar || !ar.cfg) return 'برای تنظیم، دکمه «تنظیم» را بزنید';
  const c = ar.cfg;
  if (!c.enabled) return 'غیرفعال — یادآوری به‌صورت خودکار ارسال نمی‌شود';
  // v2.14.0 — «تعداد یادآوری»: روزهای ارسال همهٔ مراحل ماه را نشان بده
  const rounds = Array.isArray(c.rounds) && c.rounds.length ? c.rounds : [c.day];
  const done = Array.isArray(c.done) ? c.done.length : (c.last ? rounds.length : 0);
  let t = `فعال • ${faNum(rounds.length)} یادآوری در ماه (روزهای ${rounds.map(d => faNum(d)).join('، ')})`;
  if (done > 0 && done < rounds.length) t += ` • ${faNum(done)} مرحله ارسال شده`;
  if (c.last && done >= rounds.length) t += ' • آخرین ارسال: ' + periodLabel(c.last);
  if (ar.bot_configured === false) t += ' • ⚠️ توکن ربات ثبت نشده';
  return t;
}

function openAutoRemindModal() {
  const ar = state.autoRemind;
  if (!ar) { toast('تنظیمات یادآوری خودکار بارگذاری نشده است؛ دوباره تلاش کنید', 'err'); return; }
  const cfg = ar.cfg;
  const st = ar.stats || {};
  const dayOpts = Array.from({ length: 29 }, (_, i) =>
    `<option value="${i + 1}" ${cfg.day === i + 1 ? 'selected' : ''}>روز ${faNum(i + 1)} ماه</option>`
  ).join('');
  const statsText = [
    `ساکنان بدهکار: ${faNum(st.debtor_residents || 0)} نفر`,
    `متصل تلگرام: ${faNum(st.reachable_residents || 0)}`,
    `بدون اتصال: ${faNum(st.unreachable_residents || 0)}`,
    `جمع مانده: ${fmtMoney(st.total_debt || 0)}`
  ].join(' • ');
  const botWarn = ar.bot_configured === false
    ? `<div class="field"><div class="hint" style="color:var(--danger)">⚠️ توکن ربات ثبت نشده است؛ در پنل مدیریت اپ (تب «تنظیمات اپ» ← ربات تلگرام) توکن را ثبت کنید تا یادآوری خودکار بتواند پیام بفرستد.</div></div>`
    : '';

  openModal({
    title: 'یادآوری خودکار ماهانه',
    body: `
      <div class="form-grid">
        <div class="field"><label>وضعیت</label>
          <button type="button" id="ar-on" class="${cfg.enabled ? 'btn ok' : 'btn ghost'}" data-on="${cfg.enabled ? 1 : 0}">
            ${cfg.enabled ? '✓ فعال — ارسال خودکار ماهانه' : 'غیرفعال — ارسال خودکار خاموش است'}
          </button></div>
        <div class="field"><label>تعداد یادآوری در ماه</label>
          <div class="fchip-row" id="ar-count-row" style="display:flex;gap:6px;flex-wrap:wrap">
            ${[1, 2, 3, 4].map(n => `<button type="button" class="fchip ${n === (cfg.count || 1) ? 'on' : ''}" data-ar-count="${n}">${faNum(n)} یادآوری</button>`).join('')}
          </div>
          <div class="hint">مرحله‌های بعدی تا پایان ماه پخش می‌شوند؛ اگر مرحله‌ای در روز خودش ارسال نشود، در اولین اجرای بعدی جبران می‌شود.</div></div>
        <div class="field"><label>روز شروع یادآوری (شمسی)</label>
          <select id="ar-day">${dayOpts}</select>
          <div class="hint">اولین یادآوریِ ماه در این روز انجام می‌شود و مراحل بعدی فاصله‌دار تا روز ۲۹ ادامه دارند.</div></div>
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
    onMount(m) {
      const tgl = $('#ar-on', m.el);
      const setTgl = on => {
        tgl.dataset.on = on ? '1' : '0';
        tgl.className = on ? 'btn ok' : 'btn ghost';
        tgl.textContent = on ? '✓ فعال — ارسال خودکار ماهانه' : 'غیرفعال — ارسال خودکار خاموش است';
      };
      tgl.addEventListener('click', () => setTgl(tgl.dataset.on !== '1'));
      // v2.14.0 — «تعداد یادآوری» chips (default = current selection)
      let arCount = cfg.count || 1;
      $$('#ar-count-row [data-ar-count]', m.el).forEach(b => b.addEventListener('click', () => {
        arCount = Number(b.dataset.arCount) || 1;
        $$('#ar-count-row [data-ar-count]', m.el).forEach(x => x.classList.toggle('on', x === b));
      }));
      $('#ar-reset', m.el).addEventListener('click', e => {
        e.preventDefault();
        $('#ar-text', m.el).value = ar.default_text || '';
      });

      // save current form, then run the requested action
      const saveCfg = async () => api('/autoremind', {
        method: 'PUT',
        body: { enabled: tgl.dataset.on === '1', day: Number($('#ar-day', m.el).value), count: arCount, text: $('#ar-text', m.el).value.trim() }
      });

      const runResultToast = r => {
        if (r.reason === 'bot_token_missing') { toast('توکن ربات تنظیم نشده است؛ در پنل مدیریت اپ توکن را ثبت کنید', 'err'); return; }
        if (r.reason === 'no_targets') { toast('ساکن بدهکارِ متصل‌به‌تلگرامی پیدا نشد؛ ارسال انجام نشد', 'info', 5200); return; }
        let t = `یادآوری برای ${faNum(r.sent)} ساکن ارسال شد`;
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
          const okd = await confirmDialog(
            'یادآوری همین حالا برای همه ساکنان بدهکارِ متصل ارسال شود؟\n(تنظیمات فعلی فرم ذخیره می‌شود و این ماه دیگر خودکار ارسال نمی‌شود)'
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
// v2.23.0 — صدور خودکار شارژ ماهانه (کارت گزارش‌ها + مودال تنظیم)
// ---------------------------------------------------------------------------
function acLineText(ac) {
  if (!ac) return 'در دسترس نیست';
  const c = ac.cfg || {};
  const on = Boolean(c.enabled);
  const modeTxt = { fixed: 'مبلغ ثابت', area: 'بر اساس متراژ', person: 'بر اساس نفرات' }[c.mode] || 'مبلغ ثابت';
  const base = on ? '✓ فعال' : 'غیرفعال';
  return `${base} • روز ${faNum(c.day || 1)} هر ماه • ${modeTxt} • ${faNum(ac.ticked || 0)} واحد تیک‌خورده`;
}

async function openAutoChargeModal() {
  let ac = state.autoCharge;
  try { ac = await api('/autocharge'); } catch (e) { toast(e.message, 'err'); return; }
  state.autoCharge = ac;
  const cfg = ac.cfg || {};
  const units = ac.units || [];
  const dayOpts = Array.from({ length: 28 }, (_, i) =>
    `<option value="${i + 1}" ${Number(cfg.day || 1) === i + 1 ? 'selected' : ''}>روز ${faNum(i + 1)}</option>`).join('');
  const modes = [
    ['fixed', 'مبلغ ثابت', 'برای هر واحد'],
    ['area', 'بر اساس متراژ', 'هر متر مربع'],
    ['person', 'بر اساس نفرات', 'هر نفر']
  ];
  const botWarn = ac.bot_configured === false
    ? '<div class="hint" style="color:var(--danger)">⚠️ توکن ربات در پنل مدیریت اپ ثبت نشده است؛ صدور انجام می‌شود ولی پیام تلگرام به ساکنین نمی‌رسد.</div>'
    : '';
  openModal({
    title: 'صدور خودکار شارژ ماهانه',
    body: `
      <div class="form-grid">
        <div class="field"><button type="button" id="ac-on" class="${cfg.enabled ? 'btn ok' : 'btn ghost'}">${cfg.enabled ? '✓ فعال — صدور خودکار ماهانه' : 'غیرفعال — صدور خودکار خاموش است'}</button>
          <div class="hint">از روز انتخابی هر ماه شمسی، برای واحدهای تیک‌خورده قلم «شارژ ماهانه» صادر می‌شود، اعتبار اضافه‌پرداخت مثل صدور دستی اعمال می‌شود و ساکن متصل هر واحد پیام تلگرام می‌گیرد. در هر ماه فقط یک‌بار.</div></div>
        <div class="field"><label>روز صدور در ماه (شمسی)</label>
          <select id="ac-day">${dayOpts}</select>
          <div class="hint">اگر اپ در آن روز روشن نشده باشد، اولین اجرای بعدی جبران می‌کند.</div></div>
        <div class="field"><label>روش محاسبه</label>
          <div class="radio-cards" id="ac-modes">
            ${modes.map(([v, t, s2]) => `<button type="button" class="rcard ${(cfg.mode || 'fixed') === v ? 'on' : ''}" data-mode="${v}">${t}<small>${s2}</small></button>`).join('')}
          </div></div>
        ${moneyField({ id: 'ac-amount', label: 'مبلغ پایه (تومان)', value: cfg.amount ? Number(cfg.amount).toLocaleString('en-US') : '', required: true })}
        <div class="field"><label>واحدهای صدور خودکار — با لمس تیک می‌خورد (${faNum(ac.ticked || 0)} فعال از ${faNum(units.length)})</label>
          ${units.length ? `<div class="filter-row" id="ac-units" style="flex-wrap:wrap">
            ${units.map(u => `<button type="button" class="fchip ${u.auto_charge ? 'on' : ''}" data-ac-unit="${u.id}" title="${esc(u.resident_name || '')}">${esc(faNum(unitNo(u.number)))}</button>`).join('')}
          </div>
          <div class="hint">واحدهایی که «شارژ ماهانه»ِ این ماه را قبلاً دستی گرفته‌اند، در اجرای خودکار رد می‌شوند (تکراری صادر نمی‌شود).</div>` : '<div class="hint">هنوز واحدی ثبت نکرده‌اید.</div>'}
        </div>
        ${botWarn}
      </div>
      <div class="rows" style="margin-top:12px">
        <button class="btn subtle block" data-maction="run">${icon('bell', 16)} صدور همین حالا (دستی)</button>
      </div>`,
    footer: `
      <button class="btn subtle" data-maction="cancel">انصراف</button>
      <button class="btn" data-maction="save">${icon('check', 16)} ذخیره</button>`,
    onMount(m) {
      let mode = cfg.mode || 'fixed';
      const tgl = $('#ac-on', m.el);
      const setTgl = on => {
        tgl.dataset.on = on ? '1' : '0';
        tgl.className = on ? 'btn ok' : 'btn ghost';
        tgl.textContent = on ? '✓ فعال — صدور خودکار ماهانه' : 'غیرفعال — صدور خودکار خاموش است';
      };
      tgl.dataset.on = cfg.enabled ? '1' : '0';
      tgl.addEventListener('click', () => setTgl(tgl.dataset.on !== '1'));
      $$('#ac-modes [data-mode]', m.el).forEach(b => b.addEventListener('click', () => {
        mode = b.dataset.mode;
        $$('#ac-modes [data-mode]', m.el).forEach(x => x.classList.toggle('on', x === b));
      }));
      // تیک واحدها — ذخیرهٔ فوری
      $$('#ac-units [data-ac-unit]', m.el).forEach(b => b.addEventListener('click', async () => {
        const on = !b.classList.contains('on');
        b.disabled = true;
        try {
          await api('/autocharge/unit', { method: 'PUT', body: { unit_id: Number(b.dataset.acUnit), on } });
          b.classList.toggle('on', on);
          haptic('success');
        } catch (e) { toast(e.message, 'err'); }
        b.disabled = false;
      }));

      const saveCfg = async () => api('/autocharge', {
        method: 'PUT',
        body: {
          enabled: tgl.dataset.on === '1',
          day: Number($('#ac-day', m.el).value),
          mode,
          amount: parseNum($('#ac-amount', m.el).value)
        }
      });

      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'cancel') { m.close(); return; }
        if (act === 'run') {
          const okd = await confirmDialog(
            'صدور خودکار همین حالا اجرا شود؟\n(ماه جاری مُهر می‌شود و دیگر در cron اجرا نمی‌شود؛ اقلام تکراری رد می‌شوند)'
          );
          if (!okd) return;
          b.disabled = true;
          try {
            await saveCfg();
            const res = await api('/autocharge/run', { method: 'POST', body: {} });
            const r = res.result || {};
            if (r.reason === 'no_units') toast('هیچ واحدی تیک نخورده است؛ اول واحدها را انتخاب کنید', 'info', 6000);
            else if (r.reason === 'no_amount') toast('مبلغ پایه را وارد کنید', 'err');
            else {
              haptic('success');
              let t = `صدور انجام شد: ${faNum(r.created || 0)} قلم تازه`;
              if (r.skipped) t += ` • ${faNum(r.skipped)} ردشده (قبلاً صادرشده)`;
              if (r.notified) t += ` • ${faNum(r.notified)} پیام اطلاع‌رسانی`;
              toast(t, 'ok', 6500);
            }
            m.close();
            navigate('reports');
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
          return;
        }
        if (act === 'save') {
          b.disabled = true;
          try {
            await saveCfg();
            state.autoCharge = await api('/autocharge');
            haptic('success');
            toast('تنظیمات صدور خودکار ذخیره شد', 'ok');
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
  const [d, pollsRes, tasksRes, claimsRes] = await Promise.all([
    api('/my/summary'),
    api('/polls').catch(() => ({ polls: [] })),
    // v2.14.2 — کارهای مدیر در «واحد من» هم (فقط‌خواندنی، جدیدترین‌ها)
    api('/tasks').catch(() => ({ tasks: [] })),
    // v2.16.0 — رسیدهای پرداخت من + وضعیت بررسی
    api('/claims').catch(() => ({ claims: [] }))
  ]);
  state._claims = new Map((claimsRes.claims || []).map(c => [c.id, c]));
  state._claimFiles = new Map();
  for (const cl of (claimsRes.claims || [])) for (const fl of (cl.files || [])) state._claimFiles.set(fl.id, { ...fl, claim_id: cl.id });
  const myClaims = (claimsRes.claims || []).slice(0, 4);
  const pendingClaim = (claimsRes.claims || []).find(c => c.status === 'pending');
  state._tasks = tasksRes.tasks || [];
  state._taskFiles = new Map();
  for (const t of state._tasks) for (const f of (t.files || [])) state._taskFiles.set(f.id, { ...f, task_id: t.id });
  const recentTasks = state._tasks.slice(0, 3);
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

  // v2.21.0 — اعتبار اضافه‌پرداخت: مانده، ماندهٔ مؤثر پس از اعتبار و تاریخچهٔ دفتر
  const myCredit = d.credit || { balance: 0, effective_remaining: d.totals.remaining, entries: [] };
  const creditEntriesHtml = (myCredit.entries || []).slice(0, 6).map(e => `
    <div class="row" style="padding:7px 0">
      <div class="badge ${e.amount > 0 ? '' : 'gray'}">${icon(e.amount > 0 ? 'plus' : 'wallet', 15)}</div>
      <div class="mid">
        <div class="t1" style="color:${e.amount > 0 ? 'var(--ok)' : 'var(--muted)'}">${e.amount > 0 ? '+' : '−'}${fmtMoney(Math.abs(e.amount))}</div>
        <div class="t2">${esc(e.note || (e.amount > 0 ? 'ثبت اضافه‌پرداخت' : 'مصرف اعتبار'))} • ${claimDate(e.created_at)}</div>
      </div>
    </div>`).join('');

  const s = state.settings || {};
  const activePolls = (pollsRes.polls || []).map(normalizePoll).filter(p => p.status === 'open');
  const closedPolls = (pollsRes.polls || []).map(normalizePoll).filter(p => p.status !== 'open').slice(0, 3);
  const pollsHtml = (activePolls.length || closedPolls.length) ? `
    <div class="section-title">نظرسنجی‌ها</div>
    ${activePolls.length ? activePolls.map(p => pollCard(p, { canVote: true })).join('') : ''}
    ${closedPolls.length ? closedPolls.map(p => pollCard(p, { canVote: false })).join('') : ''}` : '';

  // بند ۶ (v2.12.0): فیلتر سالیانه صورت‌حساب PDF برای کاربران — پیش‌فرض سال جاری
  const curJy = localPeriod().slice(0, 4);
  const debtYears = [...new Set((d.debts || []).map(x => String(x.period || '').slice(0, 4)).filter(Boolean))];
  const pdfYears = [...new Set([curJy, ...debtYears])].sort((a, b) => Number(b) - Number(a)).slice(0, 6);
  state.myPdfSel = curJy;
  const pdfLabel = () => 'دانلود صورت‌حساب ' + (state.myPdfSel === 'all' ? 'همه سال‌ها' : 'سال ' + faNum(state.myPdfSel));

  return `
    <div class="hero">
      <div class="label">مانده بدهی ${unitWord(d.unit.number)}</div>
      <div class="value ${myCredit.balance > 0 && myCredit.effective_remaining <= 0 ? 'ok' : (d.totals.remaining > 0 ? 'bad' : 'ok')}">${fmtMoney(myCredit.balance > 0 ? myCredit.effective_remaining : d.totals.remaining)}</div>
      <div class="sub">پرداخت‌شده تا امروز: <b>${fmtMoney(d.totals.paid)}</b> از ${fmtMoney(d.totals.issued)}</div>
      ${myCredit.balance > 0 ? `<div class="sub" style="color:var(--ok)">اعتبار اضافه‌پرداخت شما: <b>${fmtMoney(myCredit.balance)}</b> تومان — از شارژ ماه‌های بعدی کسر می‌شود</div>` : ''}
    </div>
    ${myCredit.balance > 0 || (myCredit.entries || []).length ? `
    <div class="section-title">اعتبار اضافه‌پرداخت</div>
    <div class="card" style="margin-bottom:14px">
      <div class="kv"><span class="k">اعتبار فعلی</span><span class="v" style="color:var(--ok)">${fmtMoney(myCredit.balance)}</span></div>
      ${myCredit.balance > 0 ? `<div class="kv"><span class="k">مانده پس از کسر اعتبار</span><span class="v">${fmtMoney(myCredit.effective_remaining)}</span></div>` : ''}
      <div class="hint" style="margin-top:6px">اگر بیشتر از بدهی‌تان پرداخت کرده باشید، مابه‌التفاوت «اعتبار» می‌شود و مدیر ساختمان در صدور شارژ ماه‌های بعدی به‌صورت خودکار از آن کسر می‌کند؛ یعنی ماه بعد به همان اندازه شارژ کمتری می‌پردازید.</div>
      ${creditEntriesHtml ? `<div style="margin-top:6px;border-top:1px solid var(--line);padding-top:4px">${creditEntriesHtml}</div>` : ''}
    </div>` : ''}
    <div class="section-title">رسید پرداخت شارژ</div>
    <div class="card" style="margin-bottom:14px">
      <div class="hint">پس از پرداخت شارژ، <b>فیش واریزی</b> خود را اینجا بارگذاری کنید و در توضیح بنویسید که شارژ را کامل پرداخت کرده‌اید یا چه مبلغی پرداخت کرده‌اید. مدیر ساختمان با پیام تلگرام باخبر می‌شود، فیش را بررسی می‌کند و پرداخت شما را کامل یا جزیی ثبت می‌کند؛ اگر بدهی بماند، برای بعد می‌ماند.</div>
      ${pendingClaim ? `
      <div class="kv" style="margin-top:8px"><span class="k">وضعیت</span><span class="v">${claimStatusChip('pending')}</span></div>
      <div class="hint" style="margin-top:6px;color:var(--warn)">رسید شما در انتظار بررسی مدیر ساختمان است؛ پس از بررسی، نتیجه با پیام تلگرام هم به شما اعلام می‌شود.</div>` : `
      <button class="btn block" data-action="claim-new" style="margin-top:10px">${icon('upload', 17)} بارگذاری فیش و ثبت پرداخت</button>`}
    </div>
    ${myClaims.length ? `<div class="rows" style="margin-bottom:14px">${myClaims.map(myClaimRow).join('')}</div>` : ''}
    <div class="card" style="margin-bottom:14px">
      <div class="kv"><span class="k">ساکن</span><span class="v">${esc(d.unit.resident_name || '—')}</span></div>
      <div class="kv"><span class="k">شماره واحد</span><span class="v">${esc(faNum(unitNo(d.unit.number)))}</span></div>
      <div class="kv"><span class="k">متراژ</span><span class="v">${faNum(d.unit.area_m2)} متر</span></div>
      ${s.bank_card ? `<div class="kv"><span class="k">کارت به نام</span><span class="v">${esc(s.bank_owner || 'مدیر ساختمان')}</span></div>` : ''}
      ${s.bank_card ? `<div class="kv"><span class="k">شماره کارت</span><span class="v" dir="ltr">${esc(faNum(s.bank_card))}</span></div>` : ''}
    </div>
    <div class="filter-row" data-my-pdf-years>
      ${pdfYears.map(y => `<button class="fchip ${y === state.myPdfSel ? 'on' : ''}" data-action="my-pdf-year" data-py="${y}">${faNum(y)}</button>`).join('')}
      <button class="fchip ${state.myPdfSel === 'all' ? 'on' : ''}" data-action="my-pdf-year" data-py="all">همه سال‌ها</button>
    </div>
    <button class="btn block" data-action="pdf-statement" style="margin-bottom:14px">${icon('download', 17)} ${pdfLabel()}</button>
    ${recentTasks.length ? `
    <div class="section-title">کارهای مدیر ساختمان</div>
    <div class="field" style="margin-bottom:8px"><div class="hint">آخرین کارهای انجام‌شدهٔ مدیر ساختمان؛ مدرک هر کار را با لمسش ببینید. کارهای جدید از طریق پیام تلگرام هم به شما اعلام می‌شود.</div></div>
    ${taskCardsHtml(recentTasks, false)}
    <button class="btn block" data-action="pdf-tasks" style="margin-top:10px">${icon('download', 16)} دانلود گزارش PDF کارهای مدیر ساختمان (سال ${faNum(state.jy)})</button>
    <button class="btn subtle block" data-action="my-goto-perf" style="margin-top:8px">${icon('clipboard', 16)} مشاهدهٔ همهٔ کارها، هزینه‌ها و ماندهٔ صندوق</button>` : ''}
    ${pollsHtml}
    <div class="section-title">اقلام باز</div>
    ${rows || emptyState({ ic: 'check', text: 'بدهی باز ندارید؛ دستتان درد نکند' })}
    <div class="field" style="margin-top:14px"><div class="hint">پس از پرداخت، فیش واریزی را در بخش «رسید پرداخت شارژ» همین صفحه بارگذاری کنید تا مدیر ساختمان آن را بررسی و ثبت کند و وضعیت شما به‌روز شود.</div></div>
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
  const myRepCredit = d.credit || { balance: 0, effective_remaining: remaining };

  return `
    <div class="stepper" id="myrep-stepper">
      <button class="st-btn" data-yd="1" aria-label="سال بعد">${icon('chevr')}</button>
      <div class="p-label"><span>سال ${faNum(jy)}</span><small>گزارش سالانه واحد شما</small></div>
      <button class="st-btn" data-yd="-1" aria-label="سال قبل">${icon('chevl')}</button>
    </div>

    <div class="hero">
      <div class="label">مانده سال ${faNum(jy)} — ${unitWord(d.unit.number)}</div>
      <div class="value ${myRepCredit.balance > 0 && myRepCredit.effective_remaining <= 0 ? 'ok' : (remaining > 0 ? 'bad' : 'ok')}">${fmtMoney(myRepCredit.balance > 0 ? myRepCredit.effective_remaining : remaining)}</div>
      <div class="sub">شارژ سال: <b>${fmtMoney(tI)}</b> • پرداخت‌شده: <b>${fmtMoney(tP)}</b>${myRepCredit.balance > 0 ? ` • اعتبار شما: <b style="color:var(--ok)">${fmtMoney(myRepCredit.balance)}</b>` : ''}</div>
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
        <li>روی هر واحد بزنید تا جزئیات باز شود: اقلام بدهی، ثبت/ویرایش/لغو پرداخت و <b>صورت‌حساب PDF</b> واحد با انتخاب سال.</li>
        <li>در همان صفحه <b>حساب کاربری ساکن</b> بسازید (نام کاربری و رمز). ساکن با همین حساب وارد اپ می‌شود و فقط وضعیت واحد خودش را می‌بیند.</li>
        <li>از همان‌جا می‌توانید حساب ساکن را فعال/غیرفعال کنید، رمزش را ریست کنید یا حذفش کنید. هر واحد فقط یک حساب ساکن دارد.</li>
      </ol>
      <p><b>لینک اتصال تلگرام (یک‌بارمصرف)</b> — در کارت حساب ساکن، دکمهٔ «لینک اتصال تلگرام» را بزنید و اعتبار لینک را انتخاب کنید (۱ ساعت تا ۷ روز). لینک ساخته‌شده را برای ساکن بفرستید؛ او باید آن را <b>از داخل تلگرام و با پروفایل خودش</b> باز کند و <b>یوزرنیم و رمز عبور همان حساب</b> را وارد کند. با این کار حساب فقط به همان پروفایل قفل می‌شود: پروفایل‌های دیگر و ورود با یوزر/پسورد از پروفایل دیگر دیگر اپ را باز نمی‌کنند و همهٔ نشست‌های قبلی باطل می‌شوند. اگر پروفایل ساکن قبلاً به حساب دیگری وصل بوده باشد، همین لینک او را از آن حساب خارج و به این حساب منتقل می‌کند (خطای «پروفایل قبلاً به حساب دیگری متصل شده» وجود ندارد) و این وضعیت تا ساخته‌شدن لینک جدید بعدی پابرجا می‌ماند. هر حساب فقط یک لینک فعال دارد و می‌توانید آن را باطل کنید.</p>
      <p><b>واحدِ خودِ مدیر</b> — اگر واحدی به حساب مدیرِ ساخته‌شده در پنل اصلی وصل باشد، مودال واحد به‌جای پیشنهاد «ساخت حساب ساکن» نشان می‌دهد که همین یوزرنیم و رمزِ پنل، حساب آن واحد است و با ورود مدیر، تب «واحد من» هم باز می‌شود.</p>
      <div class="hint">رمز ساکن را فقط به خودش بدهید؛ با غیرفعال‌کردن حساب، دسترسی او بلافاصله قطع می‌شود.</div>`),
    guideCard('card', 'شارژ — صدور و ثبت پرداخت', `
      <ol>
        <li>با فلش‌های بالای صفحه ماه موردنظر را انتخاب کنید (دکمه «این ماه» هم هست).</li>
        <li><b>صدور شارژ برای همه یا چند واحد انتخابی</b> با سه روش: <b>مبلغ ثابت</b> برای هر واحد، <b>به نسبت متراژ</b> (مبلغ هر مترمربع) یا <b>بر اساس نفرات</b> (مبلغ هر نفر). پیش‌نمایش جمع کل را قبل از صدور نشان می‌دهد.</li>
        <li><b>مثلاً اگر فقط دو واحد شارژ ماه عقب افتاده</b>، در همان مودال چیپ واحدهای نخواسته را لمس کنید تا از صدور خارج شوند — فقط واحدهای انتخاب‌شده شارژ می‌گیرند.</li>
        <li>اقلامی که قبلاً برای آن ماه صادر شده‌اند دوباره صادر نمی‌شوند — پس تکرار اشتباهی ندارد.</li>
        <li>زیر هر قلم پرداخت‌نشده، دکمه <b>ثبت پرداخت</b> است: مبلغ (کامل یا جزئی)، روش پرداخت (کارت‌به‌کارت، نقدی، پایا)، <b>تاریخ شمسی</b> و یادداشت.</li>
        <li><b>ویرایش</b> (برای اقلامی که پرداختی دارند): بدون لغو پرداخت، فقط مبلغ، روش، تاریخ یا یادداشت را اصلاح کنید.</li>
        <li><b>لغو پرداخت</b> برای اصلاح ثبت اشتباه و سطل زباله برای حذف قلم.</li>
      </ol>
      <p>فیلترهای «همه / پرداخت‌نشده / تسویه‌شده» پیدا کردن بدهکاران را سریع می‌کند.</p>
      <p><b>رسیدهای پرداخت ساکنین</b> — بالای همین تب: ساکنین پس از پرداخت، فیش واریزی خود را در «واحد من» بارگذاری می‌کنند و <b>بات تلگرام به شما پیام می‌دهد</b> که رسیدی ثبت شده است. در بخش «رسیدهای پرداخت ساکنین» فیش هر واحد را <b>ببینید</b>، <b>توضیح ساکن را بخوانید</b> و سپس یکی از سه دکمه را بزنید:</p>
      <ul>
        <li><b>ثبت کامل</b>: کل ماندهٔ بدهی واحد تسویه می‌شود (از قدیمی‌ترین قلم بدهی).</li>
        <li><b>ثبت جزیی</b>: هر مبلغی که واقعاً واریز شده را وارد کنید؛ بقیهٔ بدهی می‌ماند.</li>
        <li><b>رد رسید</b>: اگر فیش اشتباه یا نامعتبر است — ساکن با پیام تلگرام باخبر می‌شود.</li>
      </ul>
      <p>بعد از تأیید، ساکن هم با پیام تلگرام نتیجه را می‌گیرد و اگر بدهی مانده باشد، در وضعیت او می‌ماند.</p>`),
    guideCard('pie', 'هزینه‌های مشترک — این تب چیست و چه کاری می‌کند؟', `
      <p><b>هزینهٔ مشاع</b> هزینه‌ای است که به یک واحد خاص تعلق ندارد و برای کل ساختمان است — مثل قبض برق مشترک، حقوق نظافتچی، سرویس آسانسور، خرابی لولهٔ مشترک و…</p>
      <ol>
        <li>عنوان، دسته (نظافت، برق، آسانسور و...)، مبلغ و ماه را وارد کنید.</li>
        <li>روش تقسیم را انتخاب کنید: <b>مساوی بین همه واحدها</b> یا <b>به نسبت متراژ</b>.</li>
        <li>با ثبت، سهم هر واحد به‌صورت خودکار محاسبه و به بدهی همان ماه واحدها اضافه می‌شود — دیگر لازم نیست دستی حساب کنید؛ هر ساکن فقط سهم خودش را می‌پردازد.</li>
        <li>حذف هزینه، سهم همه واحدها را هم حذف می‌کند.</li>
        <li>در گزارش عملکرد (تب کارها) جمع هزینه‌های مشترک سال، کنار هزینهٔ کارها و وصولی نمایش داده می‌شود.</li>
      </ol>
      <div class="hint">فرقش با تب «کارها»: هزینهٔ مشترک به ساکنین <b>صورت‌حساب می‌شود</b> (در بدهی‌شان می‌آید)؛ ولی هزینهٔ «کار» فقط <b>از صندوق کسر می‌شود</b> و به بدهی هیچ واحدی اضافه نمی‌شود.</div>`),
    guideCard('poll', 'نظرسنجی — تصمیم‌گیری با ساکنین', `
      <ol>
        <li>سؤال و حداقل <b>دو گزینه</b> بنویسید (هر گزینه در یک خط) و نظرسنجی را بسازید.</li>
        <li>ساکنین در تب «وضعیت من» نظرسنجی فعال را می‌بینند و رأی می‌دهند؛ <b>هر واحد یک رأی</b> دارد و می‌تواند رأی خود را عوض کند.</li>
        <li>نتایج لحظه‌ای (تعداد و درصد هر گزینه) برای همه نمایش داده می‌شود.</li>
        <li>می‌توانید نظرسنجی را <b>ببندید</b>، دوباره <b>باز کنید</b> یا حذف کنید.</li>
      </ol>`),
    guideCard('clipboard', 'کارها — این تب چیست و برای چه کاری است؟', `
      <p>این تب <b>دفتر ثبت کارهای شما به‌عنوان مدیر ساختمان</b> است: هر کاری که در طول سال برای ساختمان انجام می‌دهید (تعمیرات، نظافت، سرویس آسانسور، پیگیری اداری و…) اینجا با تاریخ، دسته، توضیح و مدرک ثبت می‌شود تا <b>شفافیت کامل</b> باشد — همهٔ ساکنین ببینند چه کارهایی انجام شده، چه هزینه‌ای داشته و پول ساختمان کجا رفته.</p>
      <ol>
        <li>با <b>ثبت کار جدید</b> وارد کنید: عنوان، دسته، تاریخ انجام و هزینه (اختیاری).</li>
        <li><b>هزینهٔ هر کار هنگام ثبت از صندوق ساختمان کسر می‌شود</b>؛ «مانده صندوق» بالای همین تب برای شما و همهٔ ساکنین به‌روز می‌شود.</li>
        <li>با <b>افزودن مدرک</b> فیش، قرارداد یا برگه بازدید را پیوست کنید (تا ۸ مدرک، هرکدام تا ۶ مگابایت) — ساکنین هم می‌بینند.</li>
        <li>گزینهٔ <b>«اعلام به ساکنین»</b> فعال باشد، با ثبت کار برای همهٔ اعضای متصل به تلگرام پیام می‌رود (عنوان، تاریخ، هزینه + دکمهٔ ورود به اپ).</li>
        <li>گزارش عملکرد (نمودار ماهانه + تفکیک دسته) ساخته می‌شود و <b>PDF</b> آن قابل دانلود است؛ همان گزارش در تب «عملکرد مدیر» ساکنین هم هست.</li>
        <li>با چیپ <b>«همه سال‌ها»</b> همهٔ کارهای همهٔ سال‌ها را یک‌جا ببینید — اگر کاری با تاریخ سال دیگری ثبت شده باشد، همین‌جا یا در سال خودش پیدا و قابل حذف است.</li>
        <li>با <b>«تنظیم موجودی اولیه صندوق»</b> پولی که از مدیر قبلی دست‌تان مانده را وارد کنید تا در ماندهٔ صندوق لحاظ شود (صفر کردن و مبلغ اصلاحی منفی هم مجاز است).</li>
      </ol>
      <p><b>هزینهٔ اختیاری — کِی وارد کنم، کِی نه؟</b><br>
      • اگر پولِ آن کار <b>از صندوق/حساب ساختمان</b> پرداخت شده یا قصد دارید از پول ساختمان جبرانش کنید → هزینه را وارد کنید تا از صندوق کسر شود و حساب شفاف بماند.<br>
      • اگر از <b>جیب شخصی</b> پرداخت کرده‌اید و نمی‌خواهید از صندوق برگردد، یا کار هزینه‌ای نداشته (بازدید رایگان، پیگیری تلفنی و…) → هزینه را خالی/صفر بگذارید؛ کار فقط به‌عنوان انجام‌شده ثبت می‌شود.<br>
      • هزینهٔ اشتباه را با «ویرایش» اصلاح یا با «حذف» برگردانید — با حذف کار، مبلغش دوباره به صندوق برمی‌گردد.</p>`),
    guideCard('chart', 'گزارش‌ها، یادآوری و خروجی‌ها', `
      <ul>
        <li><b>گزارش سالانه</b>: جدول روند ماهانه و وضعیت تک‌تک واحدها؛ با فلش‌ها سال را عوض کنید و <b>PDF گزارش سالانه</b> را دانلود کنید.</li>
        <li><b>گزارش ماهانه همه واحدها</b>: ماه را با فلش‌ها انتخاب کنید و PDF وضعیت همه واحدها در آن ماه را بگیرید؛ یادداشت‌های پرداخت هر واحد هم در گزارش می‌آید.</li>
        <li><b>یادآوری بدهی</b>: پیام خودکار به واحدهای بدهکار — از طریق ربات تلگرام ارسال می‌شود، پس توکن ربات باید تنظیم شده باشد.</li>
        <li><b>اعلان همگانی</b>: پیام به همه ساکنین متصل (مثل اطلاع‌رسانی قطعی آب).</li>
        <li><b>خروجی‌ها</b>: فایل CSV بدهکاران، خلاصه سال و <b>پشتیبان کامل</b> — مرتباً پشتیبان بگیرید.
          <br>پشتیبان از نسخهٔ ۲.۱۵ به‌صورت <b>فایل ZIP</b> است: <b>«پشتیبان کامل با مدارک»</b> همهٔ عکس‌ها و PDFهای پیوست‌شده به کارها را هم داخل همان فایل نگه می‌دارد؛ <b>«پشتیبان سبک بدون مدارک»</b> فقط اطلاعات است و حجم کمی دارد — اگر نمی‌خواهید بکاپ سنگین شود، همین گزینه را بگیرید. فرمت JSON قدیمی هم برای سازگاری هست.</li>
        <li><b>بازیابی پشتیبان</b>: با دکمه «بازیابی پشتیبان (ZIP یا JSON)» فایل پشتیبان قبلی را انتخاب کنید؛ اگر ZIP بدهید، خود اپ <b>backup.json</b> را از داخل بسته بیرون می‌کشد. پس از تأیید، همه داده‌ها (واحدها، شارژها، هزینه‌ها، حساب‌های ساکن/مدیر و نظرسنجی‌ها) با محتوای فایل جایگزین می‌شود. حساب «مدیر اپ» و اتصال ربات دست‌نخورده می‌مانند — پس پشتیبان را جایی امن نگه دارید و آن را با کسی به اشتراک نگذارید.</li>
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
      <p>ساکن فقط این‌ها را می‌بیند: <b>وضعیت من</b> (مانده بدهی، شماره کارت شما، اقلام باز)، <b>گزارش سالانه واحد خودش</b>، <b>تاریخچه</b>، <b>عملکرد مدیر</b> (کارها، هزینه‌ها، مانده صندوق و مدارک)، <b>نظرسنجی‌ها</b> و صورت‌حساب PDF واحد خودش. هیچ دسترسی‌ای به واحدهای دیگر یا ثبت و ویرایش اطلاعات ندارد و راهنمای همین تب‌ها را هم نمی‌بیند.</p>`),
    guideCard('card', 'صدور خودکار شارژ و گزارش سریع‌تر (جدید)', `
      <ul>
        <li><b>صدور خودکار شارژ ماهانه</b> — در تب «گزارش‌ها» ← بخش «یادآوری و اعلان» ← ردیف «صدور خودکار شارژ ماهانه» ← تنظیم. خاموش/روشن کنید، روز ماه (شمسی)، روش محاسبه (ثابت/متراژ/نفرات) و مبلغ پایه را بدهید و <b>واحدها را تیک بزنید</b>. از آن روز به بعد، اول ماه برای واحدهای تیک‌خورده قلم شارژ صادر می‌شود، اعتبار اضافه‌پرداخت مثل صدور دستی اعمال می‌شود و ساکن متصل هر واحد پیام تلگرام می‌گیرد. در هر ماه فقط یک‌بار صادر می‌شود و اقلام تکراری رد می‌شوند؛ دکمهٔ «صدور همین حالا» هم برای اجرای فوری هست.</li>
        <li><b>مانده بدهی زیر وضعیت در تب شارژ</b> — مثل تب واحدها، زیر وضعیت هر قلم و هر رسید پرداخت، اگر واحد هنوز بدهی کلی داشته باشد «مانده بدهی واحد» با رنگ قرمز نوشته می‌شود؛ واحدِ تسویه هیچ نوشتهٔ اضافه‌ای ندارد.</li>
      </ul>
      <div class="hint">یادآوری‌های دوره‌ای که «مدیریت اپ» برای شما می‌سازد هم به‌صورت پیام تلگرام می‌رسد (مثلاً یادآوری تسویه ماهانه) — این تنظیم دست شما نیست و از پنل مدیریت اپ کنترل می‌شود.</div>`)
  ].join('');
}

function residentGuideCards() {
  return [
    guideCard('home', 'وضعیت من — مانده بدهی شما', `
      <ul>
        <li>کارت بالای صفحه <b>مانده بدهی واحد شما</b> و مجموع پرداخت‌شده تا امروز را نشان می‌دهد.</li>
        <li>مشخصات واحد، نام ساکن و متراژ + <b>شماره کارت مدیر ساختمان</b> برای کارت‌به‌کارت.</li>
        <li>لیست <b>اقلام باز</b>: هر قلم شارژ یا هزینه مشترک که تسویه نشده است.</li>
        <li>بخش <b>کارهای مدیر ساختمان</b>: آخرین کارهای انجام‌شدهٔ مدیر و مدارکشان (فقط‌خواندنی) همین‌جا دیده می‌شود؛ با ثبت کار جدید اگر مدیر اعلام کند، <b>پیام تلگرام</b> هم دریافت می‌کنید.</li>
        <li>با دکمهٔ <b>«دانلود گزارش PDF کارهای مدیر ساختمان»</b> فهرست کارها، هزینه‌ها، مدارک و ماندهٔ صندوق را به‌صورت یک فایل PDF مرتب برای بایگانی یا اشتراک با دیگران بگیرید.</li>
      </ul>
      <div class="hint">پرداخت را به حساب مدیر واریز کنید؛ ثبت آن در سیستم با مدیر ساختمان است و بلافاصله در وضعیت شما به‌روز می‌شود.</div>`),
    guideCard('upload', 'رسید پرداخت شارژ — فیش واریزی خود را بارگذاری کنید', `
      <p>بعد از اینکه شارژ را واریز کردید، در «وضعیت من» بخش <b>«رسید پرداخت شارژ»</b> فیش واریزی خود را ثبت کنید تا مدیر ساختمان سریع‌تر و مطمئن‌تر آن را ثبت کند:</p>
      <ol>
        <li>دکمهٔ <b>«بارگذاری فیش و ثبت پرداخت»</b> را بزنید.</li>
        <li><b>مبلغ پرداخت‌شده</b> را وارد کنید (پیش‌فرض، مانده بدهی شماست — اگر کامل پرداخت کرده‌اید همان را بگذارید، اگر جزیی پرداخت کرده‌اید مبلغش را بنویسید).</li>
        <li>در <b>توضیح</b> بنویسید، مثلاً: «شارژ این ماه کامل پرداخت شد» یا «فعلاً فلان مبلغ پرداخت کردم».</li>
        <li><b>فیش واریزی</b> (تصویر رسید کارت‌به‌کارت یا PDF) را انتخاب کنید — <b>الزامی</b> است.</li>
      </ol>
      <p>بعد از ثبت، <b>مدیر ساختمان با پیام تلگرام باخبر می‌شود</b> تا در پنل مدیریت فیش شما را ببیند، توضیحتان را بخواند و پرداخت را کامل یا جزیی ثبت کند. نتیجهٔ بررسی هم با پیام تلگرام به شما اعلام می‌شود؛ اگر بخشی از بدهی بماند، در وضعیت شما می‌ماند تا بعداً پرداخت کنید. تا بررسیِ رسید قبلی، فقط یک رسید در انتظار بررسی می‌توانید داشته باشید.</p>`),
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
    guideCard('clipboard', 'عملکرد مدیر — شفافیت کامل', `
      <ul>
        <li>در تب <b>عملکرد مدیر</b> می‌بینید مدیر ساختمان در طول ماه و سال چه کارهایی انجام داده است.</li>
        <li><b>مانده صندوق ساختمان</b> (پول وصول‌شده منهای هزینه‌ها) به‌همراه تفکیک هزینه‌های مشترک و هزینهٔ کارها نمایش داده می‌شود.</li>
        <li><b>نمودار ماهانه</b> و <b>تفکیک دسته‌بندی</b> نشان می‌دهد پول ساختمان کجا خرج شده است.</li>
        <li>مدارک هر کار (فیش، قرارداد، برگه بازدید آسانسور و…) را با لمسش می‌توانید ببینید یا دانلود کنید.</li>
        <li>همین کارها در «وضعیت من» (بخش کارهای مدیر ساختمان) هم نمایش داده می‌شود و کار جدید با پیام تلگرام به شما اعلام می‌شود؛ از همان‌جا <b>PDF مخصوص کارهای مدیر</b> هم قابل دانلود است.</li>
        <li>با دکمه <b>دانلود گزارش عملکرد مدیر (PDF)</b> خروجی کامل همین گزارش را بگیرید.</li>
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
            await api('/auth/change-password', { method: 'POST', body: { old_password: oldPass, new_password: newPass } });
            haptic('success'); toast('رمز عبور تغییر کرد', 'ok');
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
      if (!acc) return;
      // v2.12.0: پس از ذخیره/تغییر وضعیت/حذف، مودال واحد زیرین هم به‌روز شود
      const unitId = Number(el.closest('.sheet')?.querySelector('[data-maction="unit-edit"]')?.dataset.id) || acc.unit_id || 0;
      openResidentManageModal(acc, () => {
        refresh();
        if (unitId) setTimeout(() => openUnitModal(unitId), 180);
      });
    } catch (e) { toast(e.message, 'err'); }
  },
  // v2.17.0 — لینک دعوت یک‌بارمصرف اتصال تلگرام (از مودال واحد / مدیریت حساب ساکن)
  'invite-link': async el => {
    const id = Number(el.dataset.id);
    const unitId = Number(el.closest('.sheet')?.querySelector('[data-maction="unit-edit"]')?.dataset.id) || 0;
    try {
      const list = await api(unitId ? ('/residents?unit_id=' + unitId) : '/residents');
      const acc = (list.residents || []).find(r => r.id === id);
      if (!acc) { toast('حساب ساکن پیدا نشد', 'err'); return; }
      const unit = state.unitsCache.find(u => u.id === unitId);
      openInviteModal(acc, () => { if (unitId) setTimeout(() => openUnitModal(unitId), 180); }, unit ? unitWord(unit.number) : '');
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
  // v2.12.0 (بند ۲): ویرایش پرداخت ثبت‌شده — همان منطق جایگزینی مودال واحد
  'debt-edit': el => {
    const id = Number(el.dataset.id);
    if (state.view === 'units' && el.closest('.sheet')) {
      const unitId = Number(el.closest('.sheet').querySelector('[data-maction="unit-edit"]')?.dataset.id);
      openPayEditModal(id, () => {
        refresh();
        if (unitId) setTimeout(() => openUnitModal(unitId), 150);
      });
    } else openPayEditModal(id);
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
  // v2.21.0 — اعمال اعتبار واحد روی یک قلم باز (پیش‌پرداخت)
  'credit-apply': async el => {
    const id = Number(el.dataset.id);
    const debt = state.debtCache[id];
    if (!debt) return;
    const okd = await confirmDialog('اعتبار واحد روی این قلم اعمال شود؟\n(تا سقف اعتبار یا ماندهٔ همین قلم — هر کدام کمتر باشد)');
    if (!okd) return;
    try {
      const res = await api('/credits/apply', { method: 'POST', body: { debt_id: id } });
      haptic('success');
      let msg = `${fmtMoney(res.used || 0)} از اعتبار روی این قلم اعمال شد`;
      if (res.credit_balance != null) msg += ` — اعتبار باقی‌مانده: ${fmtMoney(res.credit_balance)}`;
      toast(msg, 'ok', 4500);
      if (el.closest('.sheet')) { const unitId = Number(el.closest('.sheet').querySelector('[data-maction="unit-edit"]')?.dataset.id); refresh(); if (unitId) setTimeout(() => openUnitModal(unitId), 150); }
      else navigate(state.view);
    } catch (e) { toast(e.message, 'err'); }
  },
  // v2.21.0 — حذف ردیف ثبتِ اشتباه از دفتر اعتبار (فقط ردیف‌های «ثبت»)
  'credit-del': async el => {
    const id = Number(el.dataset.id);
    const okd = await confirmDialog('این ردیف اضافه‌پرداخت حذف شود؟\n(فقط ثبتِ اشتباه حذف می‌شود؛ مصرف‌های اعتبار دست‌نخورده می‌مانند)');
    if (!okd) return;
    try {
      const res = await api('/credits/' + id, { method: 'DELETE', body: {} });
      toast('حذف شد — اعتبار فعلی: ' + fmtMoney(res.credit_balance || 0), 'ok');
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
  'autocharge': () => openAutoChargeModal(),
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
  'export': el => downloadExport(el.dataset.type, el.dataset.fmt, el.dataset.files),
  'import-backup': () => { const f = $('#import-file'); if (f) { f.value = ''; f.click(); } },
  // v2.13.0 — کارهای مدیر ساختمان + مدارک + گزارش عملکرد
  'task-add': () => openTaskForm(),
  'task-edit': el => {
    const t = (state._tasks || []).find(x => x.id === Number(el.dataset.id));
    if (t) openTaskForm(t);
  },
  'task-del': async el => {
    const id = Number(el.dataset.id);
    const okd = await confirmDialog('این کار و مدارک پیوست آن حذف شود؟');
    if (!okd) return;
    try {
      await api('/tasks/' + id, { method: 'DELETE', body: {} });
      haptic('success'); toast('کار حذف شد', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  },
  'task-file-add': el => pickAndUploadTaskFiles(Number(el.dataset.id)),
  'task-file': el => openTaskFile(Number(el.dataset.id)),
  // v2.14.1: تنظیم موجودی اولیهٔ صندوق (پول نزد مدیر قبلی) — فقط تب کارها
  'fund-edit': () => openFundModal(),
  // v2.14.2 — از «واحد من» به گزارش کامل عملکرد (ساکن: تب عملکرد مدیر / مدیر: تب کارها)
  'my-goto-perf': () => navigate(state.role === 'manager' ? 'tasks' : 'perf'),
  // v2.13.0: حذف مدرک پیوست — فقط مدیر ساختمان (دکمه کنار چیپ مدرک)
  'task-file-del': async el => {
    const id = Number(el.dataset.id);
    const meta = state._taskFiles && state._taskFiles.get(id);
    const okd = await confirmDialog(`مدرک «${(meta && meta.name) || 'انتخاب‌شده'}» حذف شود؟`);
    if (!okd) return;
    try {
      await api('/tasks/files/' + id, { method: 'DELETE', body: {} });
      haptic('success'); toast('مدرک حذف شد', 'ok');
      refresh();
    } catch (e) { toast(e.message, 'err'); }
  },
  'pdf-performance': () => downloadPdf('performance', { jy: state.jy }),
  // v2.16.0 — رسیدهای پرداخت شارژ (ساکن ثبت می‌کند، مدیر بررسی می‌کند)
  'claim-new': () => openClaimModal(),
  'claim-file': el => openClaimFile(Number(el.dataset.id)),
  'claim-confirm': el => confirmClaimFull(Number(el.dataset.id)),
  'claim-partial': el => openClaimPartialModal(Number(el.dataset.id)),
  'claim-reject': el => rejectClaim(Number(el.dataset.id)),
  // v2.15.0 — گزارش کارهای مدیر برای ساکنین (دکمه در «واحد من»)
  'pdf-tasks': () => downloadPdf('tasks', { jy: state.jy }),
  // v2.12.0 (بند ۶): صورت‌حساب PDF با فیلتر سال انتخابی کاربر (پیش‌فرض سال جاری)
  'pdf-statement': () => downloadPdf('statement', { jy: state.myPdfSel === 'all' ? '' : (state.myPdfSel || localPeriod().slice(0, 4)) }),
  'my-pdf-year': el => {
    state.myPdfSel = el.dataset.py;
    $$('[data-my-pdf-years] [data-action="my-pdf-year"]').forEach(c => c.classList.toggle('on', c === el));
    const btn = $('[data-action="pdf-statement"]');
    if (btn) {
      const lbl = 'دانلود صورت‌حساب ' + (state.myPdfSel === 'all' ? 'همه سال‌ها' : 'سال ' + faNum(state.myPdfSel));
      btn.innerHTML = icon('download', 17) + ' ' + lbl;
    }
  },
  // v2.12.0 (بند ۴): گزارش ماهیانه همه واحدها
  'pdf-monthly': () => downloadPdf('monthly', { period: state.period }),
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
  else if (view === 'tasks' || view === 'perf') mountPerfView();
}

async function renderView(view) {
  switch (view) {
    case 'dashboard': return viewDashboard();
    case 'units': return viewUnits();
    case 'charges': return viewCharges();
    case 'expenses': return viewExpenses();
    case 'polls': return viewPolls();
    case 'reports': return viewReports();
    case 'tasks': return viewTasks();
    case 'perf': return viewPerf();
    case 'my': return viewMy();
    case 'myhistory': return viewMyHistory();
    case 'myreports': return viewMyReports();
    case 'guide': return viewGuide();
    default: return emptyState({ text: 'صفحه یافت نشد' });
  }
}

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
  // v2.16.0 — جمع‌شدن هدر با اسکرول به پایین و برگشت با اسکرول به بالا:
  // کل نوار (عنوان، دکمه تنظیمات، تم و بارگذاری مجدد) به سمت بالا می‌رود و
  // با اولین اسکرول رو به بالا برمی‌گردد. rAF برای کارایی؛ passive برای اسکرول روان.
  const hdr = $('#hdr');
  if (hdr) {
    let lastY = window.scrollY, ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const dy = y - lastY;
        if (y > 90 && dy > 6) hdr.classList.add('hide');
        else if (dy < -6 || y < 60) hdr.classList.remove('hide');
        lastY = y;
        ticking = false;
      });
    }, { passive: true });
  }
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


