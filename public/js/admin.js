// App-Admin Panel (پنل مدیریت کل اپ) — standalone page, admin role only.
// Install-first-run → login → overview/managers/users/settings/tools/reports.
// Deliberately separate from the building manager's mini app (index.html).
import {
  $, $$, icon, esc, faNum, fmtMoney, fmtNum, parseNum, enNum,
  toast, haptic, openModal, confirmDialog, moneyField, bindMoneyInputs,
  periodLabel, isPeriod, localPeriod, addPeriods, statusChip,
  unitNo, unitWord,
  toJalaali, toGregorian, jalaaliMonthLength, todayLocalJalaali, formatJalaliDateTime,
  J_MONTHS,
  getTheme, cycleTheme, themeIcon, THEME_LABEL
} from './util.js';
import { mockFetch, MOCK_STATE } from './mock.js';

const qs = new URLSearchParams(location.search);
const MOCK = qs.has('mock') || /(^|\.)space-z\.ai$/.test(location.hostname) || location.hostname === 'localhost';
const TOKEN_KEY = 'bc_admin_token';

const state = { user: null, building: 'پنل مدیریت', period: localPeriod(), jy: localPeriod().slice(0, 4) };

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function api(path, opts = {}) {
  const { method = 'GET', body } = opts;
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
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: 'Bearer ' + getToken() } : {})
    },
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

function perr(e) {
  const box = $('#gate-err');
  if (box) { box.textContent = e.message || 'خطا'; }
  else toast(e.message || 'خطا', 'err');
}

// ---------------------------------------------------------------------------
// Gate: install (first run) or login
// ---------------------------------------------------------------------------
// v2.19.0 — نسخهٔ نرم‌افزار در فوتر پنل مدیریت (از /health عمومی — هم دمو هم واقعی)
function setFooterVersion(v) {
  const el = $('#df-version');
  if (el && v) el.textContent = 'نسخهٔ ' + faNum(String(v));
}
try {
  api('/health').then(h => setFooterVersion(h && h.version)).catch(() => { /* بی‌صدا */ });
} catch { /* ignore */ }

async function boot() {
  // demo mode also requires username & password — no automatic entry,
  // and the credentials are deliberately NOT displayed on the page.
  if (MOCK) {
    showLogin();
    return;
  }
  try {
    const st = await api('/install-status');
    if (!st.installed) { showInstall(); return; }
  } catch (e) { /* fall through to login */ }
  if (getToken()) {
    try {
      const me = await api('/auth/me');
      if (me.user.role !== 'admin') {
        showLogin();
        $('#gate-err').textContent = 'این حساب «مدیر اپ» نیست؛ ورود از این صفحه فقط برای مدیر اپ است.';
        return;
      }
      state.user = me.user;
      state.building = me.settings.building_name || state.building;
      enterPanel();
      return;
    } catch { clearToken(); }
  }
  showLogin();
}

function showInstall() {
  $('#gate-title').textContent = 'نصب اولیه اپ';
  $('#gate-sub').textContent = 'نام ساختمان و حساب «مدیر اپ» را تعریف کنید. این مرحله فقط بار اول نمایش داده می‌شود.';
  $('#install-form').hidden = false;
  $('#login-form').hidden = true;
  $('#install-form').addEventListener('submit', async e => {
    e.preventDefault();
    const building_name = $('#in-name').value.trim();
    const address = $('#in-addr').value.trim();
    const username = $('#in-user').value.trim();
    const password = $('#in-pass').value;
    const password2 = $('#in-pass2').value;
    if (password !== password2) { $('#gate-err').textContent = 'تکرار رمز عبور مطابقت ندارد'; return; }
    const btn = $('#in-go');
    btn.disabled = true;
    try {
      const r = await api('/install', { method: 'POST', body: { building_name, address, username, password } });
      setToken(r.token);
      state.user = r.user;
      state.building = building_name;
      haptic('success');
      toast('نصب اولیه انجام شد؛ خوش آمدید!', 'ok');
      enterPanel();
    } catch (err2) {
      $('#gate-err').textContent = err2.message;
      btn.disabled = false;
    }
  });
}

function showLogin() {
  $('#gate-title').textContent = 'پنل مدیریت اپ';
  $('#install-form').hidden = true;
  $('#login-form').hidden = false;
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#lg-go');
    btn.disabled = true;
    $('#gate-err').textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: $('#lg-user').value.trim(), password: $('#lg-pass').value } });
      if (r.user.role !== 'admin') {
        $('#gate-err').textContent = 'این حساب «مدیر اپ» نیست؛ مدیران ساختمان از اپ (index.html) وارد می‌شوند.';
        btn.disabled = false;
        return;
      }
      setToken(r.token);
      state.user = r.user;
      haptic('success');
      enterPanel();
    } catch (err2) {
      $('#gate-err').textContent = err2.message;
      btn.disabled = false;
    }
  });
}

function doLogout() {
  clearToken();
  if (MOCK) MOCK_STATE.user = null;
  location.reload();
}

function enterPanel() {
  $('#gate').hidden = true;
  $('#panel').hidden = false;
  $('#side-bname').textContent = state.building;
  $$('#side-nav .snav').forEach(b => b.addEventListener('click', () => {
    $$('#side-nav .snav').forEach(x => x.classList.toggle('on', x === b));
    navigate(b.dataset.view);
  }));
  $('#side-logout').addEventListener('click', doLogout);
  navigate('overview');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
let navSeq = 0;
async function navigate(view) {
  state._view = view;
  const seq = ++navSeq;
  const main = $('#pview');
  main.innerHTML = `<div class="p-loading"><span class="spinner"></span> در حال بارگذاری...</div>`;
  try {
    const html = await VIEWS[view]();
    if (seq !== navSeq) return;
    main.innerHTML = html;
    if (MOUNT[view]) MOUNT[view]();
    // v2.11.1: switching tabs while scrolled down kept the old offset — the
    // new view opened mid-page ("صفحه میاد پایین و بهم می‌ریزد"). Every tab
    // now opens cleanly from the top.
    window.scrollTo(0, 0);
  } catch (e) {
    if (seq !== navSeq) return;
    main.innerHTML = `<div class="p-empty">${icon('alert', 40)}<p>${esc(e.message)}</p></div>`;
  }
}

async function viewOverview() {
  const o = await api('/a/overview');
  state.building = o.building_name || state.building;
  $('#side-bname').textContent = state.building;
  return `
    <div class="p-head"><h2>داشبورد اپ</h2><span class="p-chip">نسخه ${esc(faNum(o.version))}</span></div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">نام ساختمان</div><div class="pc-v">${esc(o.building_name)}</div></div>
      <div class="pcard"><div class="pc-k">مدیران ساختمان (فعال)</div><div class="pc-v">${faNum(o.counts.manager)}</div></div>
      <div class="pcard"><div class="pc-k">ساکنین (فعال)</div><div class="pc-v">${faNum(o.counts.resident)}</div></div>
      <div class="pcard"><div class="pc-k">تعداد واحدها</div><div class="pc-v">${faNum(o.counts.units)}</div></div>
    </div>
    <div class="p-head"><h3>وضعیت سیستم</h3></div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">ربات تلگرام</div>
        <div class="pc-v">${o.bot && o.bot.connected ? 'متصل @' + esc(o.bot.username) : (o.bot && o.bot.configured ? 'توکن تنظیم شده (تأیید نشد)' : 'تنظیم نشده')}</div></div>
      <div class="pcard"><div class="pc-k">آدرس اپ</div><div class="pc-v small" dir="ltr">${esc(o.app_url)}</div></div>
    </div>
    <div class="p-head"><h3>بازدید و ورود به اپ</h3></div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">بازدید امروز</div><div class="pc-v">${faNum((o.visits && o.visits.today) || 0)}</div></div>
      <div class="pcard"><div class="pc-k">بازدید ۷ روز اخیر</div><div class="pc-v">${faNum((o.visits && o.visits.week) || 0)}</div></div>
      <div class="pcard"><div class="pc-k">کاربرانِ امروز</div><div class="pc-v">${faNum((o.visits && o.visits.uniq_today) || 0)}</div></div>
    </div>
    <div class="p-note">توضیح کامل همه تب‌ها در <b>🎓 آموزش پنل</b> آمده است.</div>
  `;
}

// --- managers ---------------------------------------------------------------
// The list is derived from user roles: whoever has role=manager shows up here.
// Promote/demote happens in the Users tab («مدیر کن» / «عزل از مدیریت»). Only
// creating a brand-new standalone manager account lives here, kept for
// convenience; the primary flow is promoting an existing user.
// Telegram-connection cell for user/manager tables (v2.9.2) — explicit
// three-state indicator with a colored dot, same wording as the manager panel:
//   ● متصل — account is linked (telegram_user_id set) and can receive messages
//   ● در انتظار اتصال — username stored, but the user has not opened the app
//     inside Telegram yet (auto-links on the first in-Telegram open / bot start)
//   ● متصل نیست — no username stored and no link
function tgCell(u) {
  const dot = on => `<span class="dot ${on ? 'on' : 'off'}"></span>`;
  const handle = u.telegram_username
    ? ` <span class="p-muted" dir="ltr">@${esc(u.telegram_username)}</span>` : '';
  if (u.telegram_linked) return `<span class="chip paid">${dot(true)}متصل</span>${handle}`;
  if (u.telegram_username) {
    return `<span class="chip neutral" title="پس از اولین ورود کاربر به اپ داخل تلگرام، اتصال خودکار می‌شود">${dot(false)}در انتظار اتصال</span>${handle}`;
  }
  return `<span class="chip neutral">${dot(false)}متصل نیست</span>`;
}

// One-line summary of telegram-link state for a list of users (v2.9.2)
function tgSummary(list) {
  const n = (list || []).length;
  if (!n) return '';
  const on = list.filter(u => u.telegram_linked).length;
  const wait = list.filter(u => !u.telegram_linked && u.telegram_username).length;
  return `<div class="tg-summary"><span class="dot on"></span>متصل: <b>${faNum(on)}</b> از ${faNum(n)}`
    + (wait ? ` &nbsp;•&nbsp; <span class="dot off"></span>در انتظار اتصال: <b>${faNum(wait)}</b>` : '')
    + `</div>`;
}

// Personal message modal (پیام شخصی) — shared by Users/Managers tabs.
function openPersonalMessageModal(u, opts = {}) {
  const linked = Boolean(u.telegram_linked);
  const handle = u.telegram_username ? '@' + u.telegram_username : '';
  openModal({
    title: 'پیام شخصی تلگرام — ' + (u.full_name || u.username),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">گیرنده</span><span class="v" dir="ltr">${esc(handle || u.username)}</span></div>
          <div class="kv"><span class="k">وضعیت اتصال</span><span class="v">${linked
            ? '<span class="chip accent">متصل — پیام از طریق ربات ارسال می‌شود</span>'
            : '<span class="chip neutral">متصل نیست</span>'}</span></div>
        </div>
        ${linked ? '' : `<div class="hint">ربات تلگرام نمی‌تواند به یک یوزرنیم پیام بدهد؛ به‌محض اولین ورود این کاربر به اپ داخل تلگرام (یا استارت ربات)، حسابش خودکار متصل می‌شود و ارسال پیام فعال خواهد شد. اگر یوزرنیم را در پروفایل ثبت نکرده‌اید، از «ویرایش» ثبتش کنید.</div>`}
        <div class="field"><label>متن پیام *</label>
          <textarea id="pm-text" rows="4" placeholder="مثلاً: سلام، لطفاً شارژ این ماه را تا پایان هفته تسویه کنید 🙏"></textarea>
          <div class="hint">نام ساختمان به‌طور خودکار بالای پیام درج می‌شود.</div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button>
      <button class="btn accent" data-maction="go" ${linked ? '' : 'disabled'}>${icon('send', 15)} ارسال پیام</button>`,
    onMount(m) {
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const text = $('#pm-text', m.el).value.trim();
        if (!text) { toast('متن پیام را وارد کنید', 'err'); return; }
        b.disabled = true;
        try {
          await api(opts.endpoint, { method: 'POST', body: { text } });
          haptic('success');
          toast('پیام شخصی برای ' + (u.full_name || u.username) + ' ارسال شد', 'ok');
          m.close();
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

async function viewManagers() {
  const { managers } = await api('/a/managers');
  state._managers = managers || [];
  const rows = (managers || []).map(m => `
    <tr>
      <td><b dir="ltr">${esc(m.username)}</b></td>
      <td>${esc(m.full_name || '—')}</td>
      <td>${esc(faNum(m.phone || '—'))}</td>
      <td>${m.unit_number ? unitWord(m.unit_number) : '<span class="p-muted">—</span>'}</td>
      <td>${m.role === 'manager' && m.is_resident === false ? '<span class="chip neutral">ساکن نیست</span>' : '<span class="chip paid">ساکن</span>'}</td>
      <td>${m.is_active ? '<span class="chip paid">فعال</span>' : '<span class="chip unpaid">غیرفعال</span>'}</td>
      <td>${tgCell(m)}</td>
      <td class="actions">
        <button class="btn ghost sm" data-act="msg" data-id="${m.id}">💬 پیام</button>
        <button class="btn ghost sm" data-act="edit" data-id="${m.id}">ویرایش</button>
        <button class="btn ghost sm" data-act="toggle" data-id="${m.id}">${m.is_active ? 'غیرفعال' : 'فعال'}</button>
        <button class="btn ghost sm" data-act="reset" data-id="${m.id}">ریست رمز</button>
        <button class="btn ghost sm" data-act="demote" data-id="${m.id}">عزل از مدیریت</button>
        <button class="btn danger sm" data-act="del" data-id="${m.id}">حذف</button>
      </td>
    </tr>`).join('');
  return `
    <div class="p-head">
      <h2>مدیران ساختمان</h2>
      <button class="btn accent" id="mgr-add">${icon('plus', 16)} ساخت حساب مدیر جدید</button>
    </div>
    <div class="p-note">این فهرست از روی نقش کاربران ساخته می‌شود: هر کسی که در تب <b>کاربران</b> با دکمه «مدیر کن» ارتقا بگیرد اینجا نمایش داده می‌شود و با «عزل از مدیریت» از همین فهرست حذف می‌شود (به ساکن برمی‌گردد). اگر می‌خواهید <b>یک کاربر موجود</b> را مدیر کنید، به تب «کاربران» بروید. مدیر ساختمان با این حساب وارد اپ می‌شود و فقط ابزارهای مدیریتی ساختمان را می‌بیند؛ اگر مدیر در ساختمان ساکن است، از «ویرایش» واحد او را انتخاب کنید تا تب «واحد من» را هم ببیند. <b>ستون «سکونت»:</b> مدیرِ ساکن مثل بقیهٔ واحدها جزو بدهکاران شارژ است و یادآوریِ خودکار/دستی برایش می‌رود؛ اگر مدیر ساکن ساختمان نیست، در «ویرایش» تیک «مدیر، ساکن ساختمان نیست» را بزنید تا از بدهکاران و یادآوری‌ها مستثنی شود.</div>
    ${tgSummary(managers || [])}
    <div class="p-table-wrap"><table class="p-table">
      <thead><tr><th>نام کاربری</th><th>نام</th><th>تلفن</th><th>واحد مدیر</th><th>سکونت</th><th>وضعیت</th><th>تلگرام</th><th>عملیات</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="p-empty-cell">هنوز مدری تعیین نشده است — از تب «کاربران» یک کاربر را «مدیر کن»</td></tr>'}</tbody>
    </table></div>
  `;
}

async function unitOptionsHtml(selectedId) {
  let units = [];
  try { units = (await api('/a/units')).units || []; } catch { /* ignore */ }
  return `<option value="">— بدون واحد —</option>` + units.map(u =>
    `<option value="${u.id}" ${Number(selectedId) === u.id ? 'selected' : ''}>${unitWord(u.number)}${u.resident_name ? ' — ' + esc(u.resident_name) : ''}</option>`
  ).join('');
}

function openManagerForm() {
  openModal({
    title: 'ساخت حساب مدیر ساختمان جدید',
    body: `
      <div class="form-grid">
        <div class="field"><label>نام کاربری *</label><input id="mg-user" dir="ltr" placeholder="manager" autocapitalize="none"></div>
        <div class="field"><label>رمز عبور *</label><input id="mg-pass" dir="ltr" placeholder="حداقل ۶ کاراکتر"></div>
        <div class="field"><label>نام و نام خانوادگی *</label><input id="mg-name"></div>
        <div class="field"><label>تلفن</label><input id="mg-phone" inputmode="tel"></div>
        <div class="field"><label>یوزرنیم تلگرام (اختیاری)</label><input id="mg-tg" dir="ltr" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">با ثبت یوزرنیم، به‌محض اولین ورود مدیر به اپ داخل تلگرام، حسابش خودکار متصل می‌شود و می‌توانید برایش پیام شخصی بفرستید.</div>
        </div>
        <div class="field"><label>واحد مدیر (اختیاری — برای تب «واحد من»)</label><select id="mg-unit"><option value="">— بدون واحد —</option></select></div>
        <div class="field"><label class="chk"><input type="checkbox" id="mg-nres"> مدیر، ساکن ساختمان نیست (از بدهکاران شارژ و یادآوری‌ها مستثنی شود)</label>
          <div class="hint">اگر مدیر در همین ساختمان واحد دارد و شارژ می‌دهد، این تیک را نزنید تا مثل بقیهٔ واحدها در فهرست بدهکاران بیاید و یادآوری خودکار/دستی برایش ارسال شود.</div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ایجاد حساب مدیر</button>`,
    onMount(m) {
      unitOptionsHtml('').then(html => { $('#mg-unit', m.el).innerHTML = html; });
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        b.disabled = true;
        try {
          await api('/a/managers', {
            method: 'POST',
            body: {
              username: enNum($('#mg-user', m.el).value).trim(),
              password: $('#mg-pass', m.el).value,
              full_name: $('#mg-name', m.el).value.trim(),
              phone: enNum($('#mg-phone', m.el).value).trim(),
              telegram_username: $('#mg-tg', m.el).value.trim(),
              unit_id: $('#mg-unit', m.el).value ? Number($('#mg-unit', m.el).value) : null,
              is_resident: !$('#mg-nres', m.el).checked
            }
          });
          toast('حساب مدیر ساخته شد', 'ok');
          m.close(); navigate('managers');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

function openManagerEditForm(m) {
  openModal({
    title: 'ویرایش مدیر — ' + m.username,
    body: `
      <div class="form-grid">
        <div class="field"><label>نام و نام خانوادگی</label><input id="me-name" value="${esc(m.full_name || '')}"></div>
        <div class="field"><label>تلفن</label><input id="me-phone" inputmode="tel" value="${esc(faNum(m.phone || ''))}"></div>
        <div class="field"><label>یوزرنیم تلگرام</label><input id="me-tg" dir="ltr" value="${esc(m.telegram_username ? '@' + m.telegram_username : '')}" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">${m.telegram_linked ? 'حساب به تلگرام متصل است — با دکمه «💬 پیام» می‌توانید برایش پیام بفرستید.' : 'به‌محض اولین ورود این کاربر به اپ داخل تلگرام، اتصال خودکار انجام می‌شود.'}</div>
        </div>
        <div class="field"><label>واحد مدیر (برای تب «واحد من»)</label><select id="me-unit"></select></div>
        <div class="field"><label class="chk"><input type="checkbox" id="me-nres" ${m.is_resident === false ? 'checked' : ''}> مدیر، ساکن ساختمان نیست (از بدهکاران شارژ و یادآوری‌ها مستثنی شود)</label>
          <div class="hint">مدیرِ ساکن مثل بقیهٔ واحدها در فهرست بدهکاران می‌آید و یادآوری خودکار/دستی برایش ارسال می‌شود؛ با این تیک مستثنی می‌شود.</div>
        </div>
        <div class="field"><label>رمز عبور جدید</label><input id="me-pass" dir="ltr" placeholder="خالی = بدون تغییر"></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ذخیره تغییرات</button>`,
    onMount(mm) {
      unitOptionsHtml(m.unit_id).then(html => { $('#me-unit', mm.el).innerHTML = html; });
      $$('[data-maction]', mm.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { mm.close(); return; }
        b.disabled = true;
        try {
          const body = {
            full_name: $('#me-name', mm.el).value.trim(),
            phone: enNum($('#me-phone', mm.el).value).trim(),
            telegram_username: $('#me-tg', mm.el).value.trim(),
            unit_id: $('#me-unit', mm.el).value ? Number($('#me-unit', mm.el).value) : null,
            is_resident: !$('#me-nres', mm.el).checked
          };
          const pw = $('#me-pass', mm.el).value;
          if (pw) body.password = pw;
          await api('/a/users/' + m.id, { method: 'PUT', body });
          toast('تغییرات ذخیره شد', 'ok');
          mm.close(); navigate('managers');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

async function managerAction(act, id) {
  const m = (state._managers || []).find(x => x.id === id);
  if (!m) return;
  try {
    if (act === 'edit') {
      openManagerEditForm(m);
    } else if (act === 'msg') {
      openPersonalMessageModal(m, { endpoint: '/a/users/' + m.id + '/message' });
    } else if (act === 'demote') {
      const okd = await confirmDialog(`مدیریت «${m.full_name || m.username}» عزل شود؟\nبه نقش ساکن برمی‌گردد و از این فهرست حذف می‌شود.`);
      if (!okd) return;
      await api('/a/users/' + id, { method: 'PUT', body: { role: 'resident' } });
      toast('کاربر از مدیریت عزل شد (به ساکن برگشت)', 'ok');
      navigate('managers');
    } else if (act === 'toggle') {
      await api('/a/users/' + id, { method: 'PUT', body: { is_active: !m.is_active } });
      toast(m.is_active ? 'حساب غیرفعال شد' : 'حساب فعال شد', 'ok');
      navigate('managers');
    } else if (act === 'reset') {
      openModal({
        title: 'ریست رمز عبور — ' + m.username,
        body: `<div class="field"><label>رمز عبور جدید *</label><input id="rp-pass" dir="ltr" placeholder="حداقل ۶ کاراکتر"></div>`,
        footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ثبت رمز</button>`,
        onMount(mm) {
          $$('[data-maction]', mm.el).forEach(b => b.addEventListener('click', async () => {
            if (b.dataset.maction === 'cancel') { mm.close(); return; }
            const pass = $('#rp-pass', mm.el).value;
            if (pass.length < 6) { toast('رمز باید حداقل ۶ کاراکتر باشد', 'err'); return; }
            try {
              await api('/a/users/' + id, { method: 'PUT', body: { password: pass } });
              toast('رمز عبور ریست شد', 'ok');
              mm.close();
            } catch (e) { toast(e.message, 'err'); }
          }));
        }
      });
    } else if (act === 'del') {
      const okd = await confirmDialog(`حساب «${m.username}» حذف شود؟`);
      if (!okd) return;
      await api('/a/users/' + id, { method: 'DELETE', body: {} });
      toast('حساب حذف شد', 'ok');
      navigate('managers');
    }
  } catch (e) { toast(e.message, 'err'); }
}

// --- users ------------------------------------------------------------------
// Full user management: every account (created by the app-admin OR by a
// building manager) is visible here with edit / active-toggle / password-reset /
// delete + role control («مدیر کن» promotes to building manager, «عزل از مدیریت»
// returns them to resident). New unit-user accounts can also be created here.
async function viewUsers() {
  const { users } = await api('/a/users');
  state._users = users || [];
  const filter = state._userFilter || 'all';
  const list = (users || []).filter(u => filter === 'all' || u.role === filter);
  const roleLabel = { admin: 'مدیر اپ', manager: 'مدیر ساختمان', resident: 'ساکن' };
  const rows = list.map(u => {
    const actions = u.role === 'admin'
      ? '<span class="p-muted">محافظت‌شده</span>'
      : `
        <button class="btn ghost sm" data-act="edit" data-id="${u.id}">ویرایش</button>
        ${u.role === 'resident' ? `<button class="btn ghost sm" data-act="promote" data-id="${u.id}">👑 مدیر کن</button>` : ''}
        ${u.role === 'manager' ? `<button class="btn ghost sm" data-act="demote" data-id="${u.id}">عزل از مدیریت</button>` : ''}
        <button class="btn ghost sm" data-act="toggle" data-id="${u.id}">${u.is_active ? 'غیرفعال' : 'فعال'}</button>
        <button class="btn ghost sm" data-act="reset" data-id="${u.id}">ریست رمز</button>
        <button class="btn ghost sm" data-act="invite" data-id="${u.id}">${icon('link', 14)} لینک تلگرام</button>
        <button class="btn danger sm" data-act="del" data-id="${u.id}">حذف</button>`;
    return `
    <tr>
      <td><b dir="ltr">${esc(u.username)}</b></td>
      <td><span class="chip neutral">${roleLabel[u.role] || u.role}</span></td>
      <td>${esc(u.full_name || '—')}</td>
      <td>${u.unit_number ? unitWord(u.unit_number) : '—'}</td>
      <td>${u.is_active ? '<span class="chip paid">فعال</span>' : '<span class="chip unpaid">غیرفعال</span>'}</td>
      <td>${tgCell(u)}</td>
      <td class="actions">
        ${u.role === 'admin' ? '' : `<button class="btn ghost sm" data-act="msg" data-id="${u.id}">💬 پیام</button>`}
        ${actions}
      </td>
    </tr>`;
  }).join('');
  return `
    <div class="p-head">
      <h2>کاربران اپ</h2>
      <button class="btn accent" id="user-add">${icon('plus', 16)} افزودن کاربر</button>
    </div>
    <div class="filter-row">
      ${[['all', 'همه'], ['manager', 'مدیران ساختمان'], ['resident', 'ساکنین'], ['admin', 'مدیر اپ']].map(([v, l]) =>
        `<button class="fchip ${filter === v ? 'on' : ''}" data-ufilter="${v}">${l}</button>`).join('')}
    </div>
    ${tgSummary(list)}
    <div class="p-note">همه حساب‌ها اینجا دیده می‌شوند — چه توسط شما و چه توسط مدیر ساختمان ساخته شده باشند. از اینجا می‌توانید هر حساب را ویرایش کنید، فعال/غیرفعال کنید، رمزش را ریست کنید یا حذف کنید. با دکمه <b>👑 مدیر کن</b> یک کاربر مدیر ساختمان می‌شود (در تب «مدیران ساختمان» ظاهر می‌شود) و با <b>عزل از مدیریت</b> به ساکن برمی‌گردد و از آن تب حذف می‌شود. ستون <b>تلگرام</b> وضعیت اتصال را زنده نشان می‌دهد: <span class="chip paid">متصل</span> یعنی کاربر اپ را داخل تلگرام باز کرده و به ربات متصل است (پیام شخصی برایش فعال است)، <span class="chip neutral">در انتظار اتصال</span> یعنی یوزرنیم ثبت شده ولی هنوز اپ را داخل تلگرام باز نکرده، و <span class="chip neutral">متصل نیست</span> یعنی یوزرنیمی ثبت نشده. به‌محض اولین باز کردن اپ از داخل تلگرام (حتی از لینک گروه)، وضعیت خودکار به «متصل» تغییر می‌کند. دکمه <b>🔗 لینک تلگرام</b> (v2.18.0) همان <b>لینک دعوت یک‌بارمصرف</b> پنل مدیر ساختمان است: برای هر حساب ساکن یا مدیر ساختمان لینک «t.me/<ربات>?startapp=…» با اعتبار انتخابی می‌سازید؛ کاربر آن را از داخل تلگرام و با پروفایل خودش باز می‌کند و برای امنیت <b>یوزرنیم و رمز عبور همان حساب</b> را وارد می‌کند — حسابش برای همیشه به همان پروفایل قفل می‌شود (نشست‌های قبلی و ورود با یوزر/پسورد از پروفایل دیگر باطل می‌شود). از v2.20.0 اگر پروفایل کلیک‌کننده قبلاً به حساب دیگری وصل بوده باشد، <b>از آن حساب آزاد و به این حساب منتقل می‌شود</b> — دیگر خطای «قبلاً به حساب دیگری متصل شده» نمی‌گیرد؛ یعنی لینک دعوت یعنی انتقال واقعی مالکیت تلگرامِ حساب. برای حساب «مدیر اپ» لینک ساخته نمی‌شود.</div>
    <div class="p-table-wrap"><table class="p-table">
      <thead><tr><th>نام کاربری</th><th>نقش</th><th>نام</th><th>واحد</th><th>وضعیت</th><th>تلگرام</th><th>عملیات</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="p-empty-cell">کاربری یافت نشد</td></tr>'}</tbody>
    </table></div>
  `;
}

// ---------------------------------------------------------------------------
// v2.18.0 — لینک اتصال تلگرام (یک‌بارمصرف با زمان انقضای انتخابی)
// همان مکانیزم پنل مدیر ساختمان (v2.17.0) — عیناً برای تب «کاربران» این پنل:
// لینک «https://t.me/<bot>?startapp=<token>» ساخته می‌شود؛ با باز کردنش داخل
// تلگرام، حساب به همان پروفایل قفل می‌شود و نشست‌های قبلی باطل می‌شوند.
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
      toast('لینک کپی شد — برای کاربر بفرستید', 'ok');
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

async function openInviteModal(u, onDone, unitLabel = '') {
  const done = () => { if (onDone) onDone(); };
  // لینک فعالِ همین حساب (اگر باشد) اول نمایش داده می‌شود
  let active = null;
  try {
    const { invites } = await api('/invites');
    active = (invites || []).find(i => i.user_id === u.id) || null;
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

  openModal({
    title: 'لینک اتصال تلگرام — ' + (u.full_name || u.username),
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">حساب</span><span class="v" dir="ltr">${esc(u.username)}</span></div>
          ${unitLabel ? `<div class="kv"><span class="k">واحد</span><span class="v">${esc(unitLabel)}</span></div>` : ''}
          <div class="kv"><span class="k">اتصال فعلی</span><span class="v">${u.telegram_linked ? '<span class="chip accent">متصل</span>' : '<span class="chip neutral">متصل نیست</span>'}</span></div>
        </div>
        <div id="inv-active">${linkBox(active)}</div>
        <div class="hint">این لینک <b>فقط یک بار</b> کار می‌کند: کاربر باید آن را <b>از داخل تلگرام و با پروفایل خودش</b> باز کند. با باز کردن لینک، حسابش فقط به همان پروفایل قفل می‌شود — پروفایل‌های قبلی و ورود با یوزر/پسورد از پروفایل دیگر دیگر اپ را باز نمی‌کنند.</div>
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
          const act2 = (r2.invites || []).find(i => i.user_id === u.id) || null;
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
          const r = await api('/invites', { method: 'POST', body: { user_id: u.id, hours } });
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
}

function openUserForm() {
  openModal({
    title: 'افزودن کاربر جدید',
    body: `
      <div class="form-grid">
        <div class="field"><label>نقش کاربر *</label>
          <select id="nu-role">
            <option value="resident">ساکن یک واحد</option>
            <option value="manager">مدیر ساختمان</option>
          </select>
        </div>
        <div class="field"><label>نام کاربری *</label><input id="nu-user" dir="ltr" placeholder="unit4" autocapitalize="none"></div>
        <div class="field"><label>رمز عبور *</label><input id="nu-pass" dir="ltr" placeholder="حداقل ۶ کاراکتر"></div>
        <div class="field"><label>نام و نام خانوادگی *</label><input id="nu-name"></div>
        <div class="field"><label>تلفن</label><input id="nu-phone" inputmode="tel"></div>
        <div class="field"><label>یوزرنیم تلگرام (اختیاری)</label><input id="nu-tg" dir="ltr" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. با ثبت یوزرنیم، به‌محض اولین ورود کاربر به اپ داخل تلگرام (یا استارت ربات)، حسابش خودکار متصل می‌شود و دکمه «💬 پیام» برایش فعال می‌شود.</div>
        </div>
        <div class="field" id="nu-unit-wrap"><label>واحد *</label><select id="nu-unit"></select>
          <div class="hint" id="nu-unit-hint">هر واحد فقط یک حساب ساکن دارد؛ اگر حساب قبلی وجود دارد، ابتدا آن را حذف یا ویرایش کنید.</div>
        </div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ایجاد کاربر</button>`,
    onMount(m) {
      unitOptionsHtml('').then(html => { $('#nu-unit', m.el).innerHTML = html; });
      const roleSel = $('#nu-role', m.el);
      const syncRole = () => {
        const isRes = roleSel.value === 'resident';
        $('#nu-unit-wrap', m.el).style.display = isRes ? '' : 'none';
      };
      roleSel.addEventListener('change', syncRole);
      syncRole();
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { m.close(); return; }
        const role = roleSel.value;
        const unitVal = $('#nu-unit', m.el).value;
        if (role === 'resident' && !unitVal) { toast('برای ساکن، انتخاب واحد الزامی است', 'err'); return; }
        b.disabled = true;
        try {
          await api('/a/users', {
            method: 'POST',
            body: {
              role,
              username: enNum($('#nu-user', m.el).value).trim(),
              password: $('#nu-pass', m.el).value,
              full_name: $('#nu-name', m.el).value.trim(),
              phone: enNum($('#nu-phone', m.el).value).trim(),
              telegram_username: $('#nu-tg', m.el).value.trim(),
              unit_id: unitVal ? Number(unitVal) : null
            }
          });
          haptic('success');
          toast(role === 'manager' ? 'حساب مدیر ساخته شد' : 'حساب ساکن ساخته شد', 'ok');
          m.close(); navigate('users');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

function openUserEditForm(u) {
  openModal({
    title: 'ویرایش کاربر — ' + u.username,
    body: `
      <div class="form-grid">
        <div class="card" style="padding:10px 12px">
          <div class="kv"><span class="k">نقش</span><span class="v">${u.role === 'manager' ? 'مدیر ساختمان' : u.role === 'resident' ? 'ساکن' : 'مدیر اپ'}</span></div>
          <div class="kv"><span class="k">تلگرام</span><span class="v">${u.telegram_linked ? '<span class="chip accent">متصل</span>' : '<span class="chip neutral">متصل نیست</span>'}${u.telegram_username ? ` <span dir="ltr" class="p-muted">@${esc(u.telegram_username)}</span>` : ''}</span></div>
          <button class="btn subtle block sm" id="ue-invite" style="margin-top:8px">${icon('link', 14)} لینک اتصال تلگرام (یک‌بارمصرف)</button>
        </div>
        <div class="field"><label>نام کاربری (ورود به اپ)</label><input id="ue-user" dir="ltr" value="${esc(u.username || '')}" autocapitalize="none">
          <div class="hint">با تغییر نام کاربری، دفعه بعد ورود فقط با نام جدید انجام می‌شود — حتماً به کاربر بگویید. فقط حروف لاتین/رقم/نقطه/زیرخط (۳ تا ۳۲ کاراکتر) و نباید تکراری باشد.</div>
        </div>
        <div class="field"><label>نام و نام خانوادگی</label><input id="ue-name" value="${esc(u.full_name || '')}"></div>
        <div class="field"><label>تلفن</label><input id="ue-phone" inputmode="tel" value="${esc(faNum(u.phone || ''))}"></div>
        <div class="field"><label>یوزرنیم تلگرام</label><input id="ue-tg" dir="ltr" value="${esc(u.telegram_username ? '@' + u.telegram_username : '')}" placeholder="@ali_rezaei" autocapitalize="none">
          <div class="hint">فقط حروف لاتین/رقم/زیرخط — @ لازم نیست. با ثبت یوزرنیم، اتصال پس از اولین ورود کاربر به اپ داخل تلگرام خودکار انجام می‌شود؛ سپس با «💬 پیام» می‌توانید برایش پیام بفرستید.</div>
        </div>
        <div class="field"><label>واحد (${u.role === 'resident' ? 'واحد ساکن' : 'برای تب «واحد من» مدیر'})</label><select id="ue-unit"></select></div>
        <div class="field"><label>رمز عبور جدید</label><input id="ue-pass" dir="ltr" placeholder="خالی = بدون تغییر"></div>
      </div>`,
    footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ذخیره تغییرات</button>`,
    onMount(mm) {
      unitOptionsHtml(u.unit_id).then(html => { $('#ue-unit', mm.el).innerHTML = html; });
      const invBtn = $('#ue-invite', mm.el);
      if (invBtn) invBtn.addEventListener('click', () => {
        openInviteModal(u, null, u.unit_number ? unitWord(u.unit_number) : '');
      });
      $$('[data-maction]', mm.el).forEach(b => b.addEventListener('click', async () => {
        if (b.dataset.maction === 'cancel') { mm.close(); return; }
        b.disabled = true;
        try {
          const body = {
            username: enNum($('#ue-user', mm.el).value).trim(),
            full_name: $('#ue-name', mm.el).value.trim(),
            phone: enNum($('#ue-phone', mm.el).value).trim(),
            telegram_username: $('#ue-tg', mm.el).value.trim(),
            unit_id: $('#ue-unit', mm.el).value ? Number($('#ue-unit', mm.el).value) : null
          };
          const pw = $('#ue-pass', mm.el).value;
          if (pw) body.password = pw;
          await api('/a/users/' + u.id, { method: 'PUT', body });
          toast('تغییرات ذخیره شد', 'ok');
          mm.close(); navigate('users');
        } catch (e) { toast(e.message, 'err'); b.disabled = false; }
      }));
    }
  });
}

async function userAction(act, id) {
  const u = (state._users || []).find(x => x.id === id);
  if (!u) return;
  try {
    if (act === 'edit') {
      openUserEditForm(u);
    } else if (act === 'msg') {
      openPersonalMessageModal(u, { endpoint: '/a/users/' + u.id + '/message' });
    } else if (act === 'invite') {
      // v2.18.0 — لینک دعوت یک‌بارمصرف اتصال تلگرام (همان مکانیزم پنل مدیر ساختمان)
      openInviteModal(u, () => navigate('users'), u.unit_number ? unitWord(u.unit_number) : '');
    } else if (act === 'promote') {
      const okd = await confirmDialog(`«${u.full_name || u.username}» مدیر ساختمان شود؟\nدر تب «مدیران ساختمان» نمایش داده می‌شود و به ابزارهای مدیریتی اپ دسترسی می‌گیرد.`);
      if (!okd) return;
      await api('/a/users/' + id, { method: 'PUT', body: { role: 'manager' } });
      haptic('success');
      toast('کاربر به مدیر ساختمان ارتقا یافت', 'ok');
      navigate('users');
    } else if (act === 'demote') {
      const okd = await confirmDialog(`مدیریت «${u.full_name || u.username}» عزل شود؟\nبه نقش ساکن برمی‌گردد و از تب «مدیران ساختمان» حذف می‌شود.`);
      if (!okd) return;
      await api('/a/users/' + id, { method: 'PUT', body: { role: 'resident' } });
      toast('کاربر از مدیریت عزل شد (به ساکن برگشت)', 'ok');
      navigate('users');
    } else if (act === 'toggle') {
      await api('/a/users/' + id, { method: 'PUT', body: { is_active: !u.is_active } });
      toast(u.is_active ? 'حساب غیرفعال شد' : 'حساب فعال شد', 'ok');
      navigate('users');
    } else if (act === 'reset') {
      openModal({
        title: 'ریست رمز — ' + u.username,
        body: `<div class="field"><label>رمز عبور جدید *</label><input id="rp-pass" dir="ltr"></div>`,
        footer: `<button class="btn subtle" data-maction="cancel">انصراف</button><button class="btn accent" data-maction="go">ثبت رمز</button>`,
        onMount(mm) {
          $$('[data-maction]', mm.el).forEach(b => b.addEventListener('click', async () => {
            if (b.dataset.maction === 'cancel') { mm.close(); return; }
            const pass = $('#rp-pass', mm.el).value;
            if (pass.length < 6) { toast('رمز باید حداقل ۶ کاراکتر باشد', 'err'); return; }
            try {
              await api('/a/users/' + id, { method: 'PUT', body: { password: pass } });
              toast('رمز ریست شد', 'ok'); mm.close();
            } catch (e) { toast(e.message, 'err'); }
          }));
        }
      });
    } else if (act === 'del') {
      const okd = await confirmDialog(`حساب «${u.username}» حذف شود؟`);
      if (!okd) return;
      await api('/a/users/' + id, { method: 'DELETE', body: {} });
      toast('حساب حذف شد', 'ok');
      navigate('users');
    }
  } catch (e) { toast(e.message, 'err'); }
}

// --- bot messages report (گزارش پیام‌های بات) ---------------------------------
// Shows every message people send to the bot (private messages + group
// commands) with a Jalali date-range calendar, title filter chips and a text
// search. Data is logged by the webhook (src/botmessages.js).
state._bm = { range: 'all', from: '', to: '', title: '', dir: '', q: '', limit: 50 };

const BM_RANGES = [
  ['all', 'همه'],
  ['today', 'امروز'],
  ['yesterday', 'دیروز'],
  ['week', '۷ روز اخیر'],
  ['month', '۳۰ روز اخیر']
];

// Per-page sizes for the report tables (v2.10.0) — deliberately small so the
// browser never chokes on huge tables.
const PAGE_SIZES = [20, 50, 100];
function pageSizeChips(attr, current) {
  return PAGE_SIZES.map(n =>
    `<button class="fchip ${Number(current) === n ? 'on' : ''}" data-${attr}="${n}">${faNum(n)}</button>`).join('');
}

function jToIso(j) {
  const g = toGregorian(j.jy, j.jm, j.jd);
  return `${g.gy}-${String(g.gm).padStart(2, '0')}-${String(g.gd).padStart(2, '0')}`;
}
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return jToIso(toJalaali(d));
}
function isoToJ(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  return toJalaali(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function isoFa(iso) {
  const j = isoToJ(iso);
  return j ? faNum(`${j.jd} ${J_MONTHS_FA[j.jm - 1]} ${j.jy}`) : '—';
}
// J_MONTHS is re-exported through util.js — alias for calendar labels
const J_MONTHS_FA = J_MONTHS;

function bmQuery(extra = {}) {
  const f = { ...state._bm, ...extra };
  const p = new URLSearchParams();
  if (f.range === 'all') { /* no dates */ }
  else if (f.range === 'today') { p.set('from', isoDaysAgo(0)); p.set('to', isoDaysAgo(0)); }
  else if (f.range === 'yesterday') { p.set('from', isoDaysAgo(1)); p.set('to', isoDaysAgo(1)); }
  else if (f.range === 'week') { p.set('from', isoDaysAgo(7)); p.set('to', isoDaysAgo(0)); }
  else if (f.range === 'month') { p.set('from', isoDaysAgo(30)); p.set('to', isoDaysAgo(0)); }
  else { // custom
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
  }
  if (f.title) p.set('title', f.title);
  if (f.dir) p.set('dir', f.dir); // v2.19.0 — فیلتر جهت: دریافتی/ارسالی
  if (f.q) p.set('q', f.q);
  p.set('limit', String(Math.max(1, Math.min(500, Number(f.limit) || 50))));
  return p; // URLSearchParams — stringifies on concatenation
}

const BM_KIND_ICON = { command: 'send', text: 'msg', other: 'file', out: 'send' };
const BM_DIR_IN = 'دریافتی';
const BM_DIR_OUT = 'ارسالی';

function bmSenderCell(m) {
  const name = m.full_name || m.app_name || '';
  const handle = m.username
    ? `<div class="p-muted" dir="ltr" style="font-size:11.5px">@${esc(m.username)}</div>` : '';
  const link = m.app_role
    ? `<div style="margin-top:4px"><span class="chip neutral">${m.app_role === 'manager' ? 'مدیر ساختمان' : m.app_role === 'admin' ? 'مدیر اپ' : 'ساکن'}${m.unit_number ? ' — ' + unitWord(m.unit_number) : ''}</span></div>`
    : '';
  // v2.19.0 — پیام‌های ارسالی ربات: این ستون «گیرندهٔ» پیام را نشان می‌دهد
  const dirTag = m.direction === 'out'
    ? `<div class="p-muted" style="font-size:10.5px;margin-bottom:2px">گیرنده:</div>` : '';
  return `${dirTag}<b>${esc(name || 'ناشناس')}</b>${handle}${link}`;
}

function bmRowHtml(m) {
  const dt = formatJalaliDateTime(Number(m.created_at) * 1000);
  const [dPart, tPart] = dt.split(' • ');
  const text = String(m.text || '');
  const short = text.length > 140 ? text.slice(0, 140) + '…' : text;
  const kindIc = BM_KIND_ICON[m.kind] || 'msg';
  const isOut = m.direction === 'out';
  // v2.19.0 — ستون «جهت»: چیپ سبز ارسالی / خاکستری دریافتی + نوع چت
  const dirChip = isOut
    ? '<span class="chip paid">' + icon('send', 11) + ' ' + BM_DIR_OUT + '</span>'
    : '<span class="chip neutral">' + icon('msg', 11) + ' ' + BM_DIR_IN + '</span>';
  const chatChip = '<span class="chip neutral">' + (m.chat_type === 'private' ? 'چت خصوصی' : 'گروه') + '</span>';
  return `
    <tr>
      <td style="white-space:nowrap">${esc(dPart)}<div class="p-muted" style="font-size:11px">${esc((tPart || '').replace('ساعت ', ''))}</div></td>
      <td>${bmSenderCell(m)}</td>
      <td style="white-space:nowrap">${dirChip}<div style="margin-top:4px">${chatChip}</div></td>
      <td><span class="chip accent">${icon(kindIc, 11)} ${esc(m.title || '—')}</span></td>
      <td class="bm-text" title="${esc(text)}">${text ? esc(short) : '<span class="p-muted">(بدون متن)</span>'}</td>
    </tr>`;
}

async function viewBotMsgs() {
  const data = await api('/a/bot/messages?' + bmQuery());
  state._bmData = data;
  const st = data.stats || {};
  const f = state._bm;
  const titleChips = [
    `<button class="fchip ${!f.title ? 'on' : ''}" data-bmtitle="">همه عناوین</button>`,
    ...(data.titles || []).map(t =>
      `<button class="fchip ${f.title === t.title ? 'on' : ''}" data-bmtitle="${esc(t.title)}">${esc(t.title)} <b>(${faNum(t.n)})</b></button>`)
  ].join('');
  return `
    <div class="p-head">
      <h2>💬 پیام‌های ربات تلگرام</h2>
      <button class="btn ghost" id="bm-refresh">${icon('refresh', 16)} بازخوانی</button>
    </div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">کل پیام‌های ثبت‌شده</div><div class="pc-v">${faNum(st.total || 0)}</div></div>
      <div class="pcard"><div class="pc-k">امروز</div><div class="pc-v">${faNum(st.today || 0)}</div></div>
      <div class="pcard"><div class="pc-k">۷ روز اخیر</div><div class="pc-v">${faNum(st.week || 0)}</div></div>
      <div class="pcard"><div class="pc-k">پیام‌های ارسالی ربات</div><div class="pc-v">${faNum(st.out_total || 0)}</div></div>
      <div class="pcard"><div class="pc-k">فرستندگان امروز</div><div class="pc-v">${faNum(st.senders_today || 0)}</div></div>
    </div>
    <div class="pcard wide">
      <div class="pc-k">فیلترها</div>
      <div class="filter-row">
        ${BM_RANGES.map(([v, l]) => `<button class="fchip ${f.range === v ? 'on' : ''}" data-bmrange="${v}">${l}</button>`).join('')}
      </div>
      <div class="filter-row cal-wrap" id="bm-cal-wrap">
        <button class="fchip ${f.range === 'custom' && f.from ? 'on' : ''}" id="bm-from-btn">${icon('cal', 13)} از: <b>${isoFa(f.range === 'custom' ? f.from : '')}</b></button>
        <button class="fchip ${f.range === 'custom' && f.to ? 'on' : ''}" id="bm-to-btn">${icon('cal', 13)} تا: <b>${isoFa(f.range === 'custom' ? f.to : '')}</b></button>
      </div>
      <div class="filter-row" id="bm-dir-row">
        <button class="fchip ${!f.dir ? 'on' : ''}" data-bmdir="">همه پیام‌ها</button>
        <button class="fchip ${f.dir === 'in' ? 'on' : ''}" data-bmdir="in">${icon('msg', 12)} دریافتی از کاربران</button>
        <button class="fchip ${f.dir === 'out' ? 'on' : ''}" data-bmdir="out">${icon('send', 12)} ارسالی ربات</button>
      </div>
      <div class="filter-row" id="bm-title-row">${titleChips}</div>
      <div class="filter-row"><span class="p-muted" style="font-size:12px;align-self:center">تعداد نمایش در هر صفحه:</span>${pageSizeChips('bmlimit', f.limit)}</div>
      <div class="bm-search">
        <input id="bm-q" placeholder="جستجو در متن پیام یا نام فرستنده…" value="${esc(f.q)}">
        <button class="btn subtle sm" id="bm-q-go">${icon('search', 15)} جستجو</button>
        <button class="btn ghost sm" id="bm-clear">حذف فیلترها</button>
      </div>
    </div>
    <div class="p-note">دو جهت ثبت می‌شود: ۱) «دریافتی» — هر پیامی که در چت خصوصی به ربات فرستاده شود (متن، فرمان یا رسانه) و هر دستوری که ربات در گروه پاسخ می‌دهد؛ گفتگوی عادی گروه ثبت نمی‌شود. ۲) «ارسالی» — هر پیامی که ربات خودش می‌فرستد: یادآوری خودکار ماهانه و دستی، اعلان همگانی، پیام شخصی، اعلام رسید پرداخت/کار جدید/بازدید، پیام آزمایشی و پاسخ‌های خودکار ربات (مثل خوش‌آمد /start). اگر طرف حساب حساب اپ متصل‌شده‌ای داشته باشد، نقش و واحدش کنار نامش نمایش داده می‌شود. نگهداری پیام‌ها ۱۸۰ روز است.</div>
    <div class="p-table-wrap"><table class="p-table" id="bm-table">
      <thead><tr><th>تاریخ</th><th>فرستنده / گیرنده</th><th>جهت</th><th>عنوان</th><th>متن پیام</th></tr></thead>
      <tbody id="bm-tbody">
        ${(data.messages || []).map(bmRowHtml).join('') || '<tr><td colspan="5" class="p-empty-cell">پیامی با این فیلترها یافت نشد</td></tr>'}
      </tbody>
    </table></div>
    ${data.has_more ? '<div style="text-align:center;margin:14px 0"><button class="btn subtle" id="bm-more">نمایش بیشتر…</button></div>' : ''}
  `;
}

// --- Jalali calendar popover (تقویم شمسی) ------------------------------------
let calState = null; // { mode: 'from'|'to', jy, jm }

function calGridHtml() {
  const { jy, jm } = calState;
  const monthLen = jalaaliMonthLength(jy, jm);
  const g1 = toGregorian(jy, jm, 1);
  const offset = (new Date(Date.UTC(g1.gy, g1.gm - 1, g1.gd)).getUTCDay() + 1) % 7; // Saturday-first
  const sel = isoToJ(calState.store[calState.mode]);
  const today = todayLocalJalaali();
  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<span class="cal-d empty"></span>';
  for (let d = 1; d <= monthLen; d++) {
    const cls = ['cal-d'];
    if (today.jy === jy && today.jm === jm && today.jd === d) cls.push('today');
    if (sel && sel.jy === jy && sel.jm === jm && sel.jd === d) cls.push('sel');
    cells += `<button type="button" class="${cls.join(' ')}" data-cal-d="${d}">${faNum(d)}</button>`;
  }
  return `
    <div class="cal-pop" id="cal-pop">
      <div class="cal-head">
        <button type="button" class="st-btn" data-cal-nav="-1">${icon('chevr', 15)}</button>
        <b>${J_MONTHS_FA[jm - 1]} ${faNum(jy)}</b>
        <button type="button" class="st-btn" data-cal-nav="1">${icon('chevl', 15)}</button>
      </div>
      <div class="cal-grid">
        ${['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'].map(w => `<span class="cal-w">${w}</span>`).join('')}
        ${cells}
      </div>
      <div class="cal-foot">
        <button type="button" class="btn subtle sm" data-cal-today>رفتن به امروز</button>
        <button type="button" class="btn ghost sm" data-cal-clear>پاک کردن این تاریخ</button>
      </div>
    </div>`;
}

// openCalendar(mode, opts) — shared by the bot-messages and user-login reports.
// opts.store: filter state object (default state._bm) — opts.view: view to
// re-render after picking (default 'botmsgs') — opts.wrap: popover anchor.
function openCalendar(mode, opts = {}) {
  const wrap = opts.wrap || $('#bm-cal-wrap');
  if (!wrap) return;
  const store = opts.store || state._bm;
  const view = opts.view || 'botmsgs';
  const existing = $('#cal-pop');
  if (existing && calState && calState.mode === mode) { existing.remove(); calState = null; return; }
  const j = isoToJ(store[mode]) || todayLocalJalaali();
  calState = { mode, jy: j.jy, jm: j.jm, store, view };
  const old = $('#cal-pop');
  if (old) old.remove();
  wrap.insertAdjacentHTML('beforeend', calGridHtml());
  mountCalPop(); // bind the freshly inserted popover buttons
}

function closeCalendar() {
  const pop = $('#cal-pop');
  if (pop) pop.remove();
  calState = null;
}

function pickCalendarDay(d) {
  if (!calState) return;
  const iso = jToIso({ jy: calState.jy, jm: calState.jm, jd: d });
  const st = calState.store;
  const view = calState.view; // read BEFORE closeCalendar() nulls calState
  st[calState.mode] = iso;
  // keep the range valid — swap if the bounds are inverted
  if (st.from && st.to && st.from > st.to) {
    const t = st.from;
    st.from = st.to;
    st.to = t;
  }
  st.range = 'custom';
  closeCalendar();
  navigate(view);
}

function mountBotMsgs() {
  const refresh = $('#bm-refresh');
  if (refresh) refresh.addEventListener('click', () => navigate('botmsgs'));

  $$('[data-bmrange]').forEach(b => b.addEventListener('click', () => {
    state._bm.range = b.dataset.bmrange;
    navigate('botmsgs');
  }));

  $$('[data-bmtitle]').forEach(b => b.addEventListener('click', () => {
    state._bm.title = b.dataset.bmtitle || '';
    navigate('botmsgs');
  }));

  $$('[data-bmdir]').forEach(b => b.addEventListener('click', () => {
    state._bm.dir = b.dataset.bmdir || '';
    navigate('botmsgs');
  }));

  $$('[data-bmlimit]').forEach(b => b.addEventListener('click', () => {
    state._bm.limit = Number(b.dataset.bmlimit) || 50;
    navigate('botmsgs');
  }));

  const fromBtn = $('#bm-from-btn');
  if (fromBtn) fromBtn.addEventListener('click', e => { e.stopPropagation(); openCalendar('from'); });
  const toBtn = $('#bm-to-btn');
  if (toBtn) toBtn.addEventListener('click', e => { e.stopPropagation(); openCalendar('to'); });

  mountCalPop(); // bind calendar popover (when open) after re-render

  const qGo = $('#bm-q-go');
  if (qGo) qGo.addEventListener('click', () => {
    state._bm.q = $('#bm-q').value.trim();
    navigate('botmsgs');
  });
  const qInp = $('#bm-q');
  if (qInp) qInp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { state._bm.q = qInp.value.trim(); navigate('botmsgs'); }
  });

  const clearBtn = $('#bm-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    state._bm = { range: 'all', from: '', to: '', title: '', dir: '', q: '', limit: state._bm.limit || 50 };
    navigate('botmsgs');
  });

  const more = $('#bm-more');
  if (more) more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const p = bmQuery();
      p.set('offset', String(state._bmData.messages.length));
      const data = await api('/a/bot/messages?' + p.toString());
      state._bmData.messages.push(...(data.messages || []));
      state._bmData.has_more = data.has_more;
      const tb = $('#bm-tbody');
      if (tb && (data.messages || []).length) {
        tb.insertAdjacentHTML('beforeend', data.messages.map(bmRowHtml).join(''));
      }
      if (!data.has_more) more.closest('div').remove();
      else more.disabled = false;
    } catch (e) { toast(e.message, 'err'); more.disabled = false; }
  });
}

function mountCalPop() { // re-bind calendar popover buttons after re-render
  const pop = $('#cal-pop');
  if (!pop) return;
  $$('[data-cal-nav]', pop).forEach(b => b.addEventListener('click', () => {
    let { jy, jm } = calState;
    jm += Number(b.dataset.calNav);
    if (jm > 12) { jm = 1; jy++; }
    if (jm < 1) { jm = 12; jy--; }
    calState.jy = jy; calState.jm = jm;
    pop.outerHTML = calGridHtml();
    mountCalPop();
  }));
  $$('[data-cal-d]', pop).forEach(b => b.addEventListener('click', () => pickCalendarDay(Number(b.dataset.calD))));
  const todayBtn = $('[data-cal-today]', pop);
  if (todayBtn) todayBtn.addEventListener('click', () => {
    const t = todayLocalJalaali();
    calState.jy = t.jy; calState.jm = t.jm;
    pop.outerHTML = calGridHtml();
    mountCalPop();
  });
  const clearBtn = $('[data-cal-clear]', pop);
  if (clearBtn) clearBtn.addEventListener('click', () => {
    const st = calState.store;
    const view = calState.view; // read BEFORE closeCalendar() nulls calState
    st[calState.mode] = '';
    if (!st.from && !st.to) st.range = 'all';
    closeCalendar();
    navigate(view);
  });
}

// click outside the calendar closes it (module-level — never stacks)
document.addEventListener('click', e => {
  if ($('#cal-pop') && !e.target.closest('.cal-wrap')) closeCalendar();
});

// --- user-login report (گزارش ورود کاربران) ----------------------------------
// v2.9.1: belongs ONLY to the app-admin. Shows every open / password-login of
// the mini app with quick ranges, a Jalali calendar range and kind chips, plus
// the Telegram-notification toggle (notifications go only to the app-admin).
state._vs = { range: 'all', from: '', to: '', kind: '', limit: 50 };

const VS_KINDS = [
  ['', 'همه رویدادها'],
  ['open', 'باز کردن اپ'],
  ['login', 'ورود با نام کاربری']
];
const VS_KIND_LABEL = { open: 'باز کردن اپ', login: 'ورود با نام کاربری' };

function vsQuery(extra = {}) {
  const f = { ...state._vs, ...extra };
  const p = new URLSearchParams();
  if (f.range === 'all') { /* no dates */ }
  else if (f.range === 'today') { p.set('from', isoDaysAgo(0)); p.set('to', isoDaysAgo(0)); }
  else if (f.range === 'yesterday') { p.set('from', isoDaysAgo(1)); p.set('to', isoDaysAgo(1)); }
  else if (f.range === 'week') { p.set('from', isoDaysAgo(7)); p.set('to', isoDaysAgo(0)); }
  else if (f.range === 'month') { p.set('from', isoDaysAgo(30)); p.set('to', isoDaysAgo(0)); }
  else { // custom
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
  }
  if (f.kind) p.set('kind', f.kind);
  p.set('limit', String(Math.max(1, Math.min(200, Number(f.limit) || 50))));
  return p;
}

function vsRowHtml(x) {
  const dt = formatJalaliDateTime(Number(x.created_at) * 1000);
  const [dPart, tPart] = dt.split(' • ');
  const via = x.via === 'telegram' ? 'داخل تلگرام'
    : x.via === 'web' ? 'از مرورگر'
    : x.via === 'session' ? 'نشست ذخیره‌شده' : '—';
  const role = x.role === 'manager' ? 'مدیر ساختمان' : x.role === 'admin' ? 'مدیر اپ' : 'ساکن';
  const who = esc(x.full_name || x.username || 'کاربر حذف‌شده');
  const handle = x.username ? `<div class="p-muted" dir="ltr" style="font-size:11.5px">@${esc(x.username)}</div>` : '';
  return `
    <tr>
      <td style="white-space:nowrap">${esc(dPart)}<div class="p-muted" style="font-size:11px">${esc((tPart || '').replace('ساعت ', ''))}</div></td>
      <td><b>${who}</b>${handle}</td>
      <td><span class="chip neutral">${role}${x.unit_number ? ' — ' + esc(unitWord(x.unit_number)) : ''}</span></td>
      <td><span class="chip ${x.kind === 'login' ? 'accent' : 'neutral'}">${VS_KIND_LABEL[x.kind] || 'باز کردن اپ'}</span></td>
      <td><span class="p-muted">${via}</span></td>
    </tr>`;
}

async function viewVisits() {
  const data = await api('/a/visits?' + vsQuery());
  state._vsData = data;
  const st = data.stats || {};
  const f = state._vs;
  const on = Boolean(data.notify_enabled);
  const warns = [
    data.bot_configured === false
      ? '<div class="hint" style="color:var(--danger)">⚠️ توکن ربات ثبت نشده است؛ از تب «تنظیمات اپ» ← کارت «ربات تلگرام» توکن را ثبت کنید تا پیام ورود ارسال شود.</div>'
      : '',
    data.me_linked === false
      ? '<div class="hint" style="color:var(--danger)">⚠️ حساب شما به تلگرام متصل نیست؛ یک بار داخل تلگرام وارد اپ شوید تا پیام‌های ورود برای شما ارسال شوند.</div>'
      : ''
  ].filter(Boolean).join('');
  return `
    <div class="p-head">
      <h2>🚪 گزارش ورود کاربران</h2>
      <button class="btn ghost" id="vs-refresh">${icon('refresh', 16)} بازخوانی</button>
    </div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">بازدید امروز</div><div class="pc-v">${faNum(st.today || 0)}</div></div>
      <div class="pcard"><div class="pc-k">بازدید ۷ روز اخیر</div><div class="pc-v">${faNum(st.week || 0)}</div></div>
      <div class="pcard"><div class="pc-k">کاربرانِ امروز</div><div class="pc-v">${faNum(st.uniq_today || 0)}</div></div>
    </div>
    <div class="pcard wide">
      <div class="pc-k">اعلان تلگرام هنگام ورود اعضا</div>
      <div class="filter-row" style="margin-bottom:6px">
        <button class="btn ${on ? 'ok' : 'ghost'} sm" id="vs-tgl">
          ${on ? '✓ فعال — پیام تلگرام ارسال می‌شود' : 'غیرفعال — پیام تلگرام ارسال نمی‌شود'}
        </button>
      </div>
      <div class="hint">با فعال بودن، وقتی ساکنی (عضوی) اپ را باز یا وارد شود، پیام کوتاهی <b>فقط برای مدیر اپِ متصل به تلگرام</b> فرستاده می‌شود (هر ساکن حداکثر هر ۱۰ دقیقه یک‌بار). پیام ورود اعضا <b>هرگز</b> برای مدیران ساختمان ارسال نمی‌شود و گزارش آن فقط در همین تب است.</div>
      ${warns ? `<div style="margin-top:8px">${warns}</div>` : ''}
    </div>
    <div class="pcard wide">
      <div class="pc-k">فیلترها</div>
      <div class="filter-row">
        ${BM_RANGES.map(([v, l]) => `<button class="fchip ${f.range === v ? 'on' : ''}" data-vsrange="${v}">${l}</button>`).join('')}
      </div>
      <div class="filter-row cal-wrap" id="vs-cal-wrap">
        <button class="fchip ${f.range === 'custom' && f.from ? 'on' : ''}" id="vs-from-btn">${icon('cal', 13)} از: <b>${isoFa(f.range === 'custom' ? f.from : '')}</b></button>
        <button class="fchip ${f.range === 'custom' && f.to ? 'on' : ''}" id="vs-to-btn">${icon('cal', 13)} تا: <b>${isoFa(f.range === 'custom' ? f.to : '')}</b></button>
        <button class="btn ghost sm" id="vs-clear">حذف فیلترها</button>
      </div>
      <div class="filter-row">
        ${VS_KINDS.map(([v, l]) => `<button class="fchip ${f.kind === v ? 'on' : ''}" data-vskind="${v}">${l}</button>`).join('')}
      </div>
      <div class="filter-row"><span class="p-muted" style="font-size:12px;align-self:center">تعداد نمایش در هر صفحه:</span>${pageSizeChips('vslimit', f.limit)}</div>
    </div>
    <div class="p-note">هر باز کردن یا ورود به مینی‌اپ ثبت می‌شود («باز کردن اپ» = باز کردن با نشست ذخیره‌شده، «ورود با نام کاربری» = ورود با رمز). گزارش ورود کاربران فقط برای مدیر اپ است و در پنل/اپ مدیر ساختمان نمایش داده نمی‌شود. نگهداری رکوردها ۹۰ روز است.</div>
    <div class="p-table-wrap"><table class="p-table" id="vs-table">
      <thead><tr><th>تاریخ</th><th>کاربر</th><th>نقش و واحد</th><th>نوع رویداد</th><th>کانال</th></tr></thead>
      <tbody id="vs-tbody">
        ${(data.visits || []).map(vsRowHtml).join('') || '<tr><td colspan="5" class="p-empty-cell">رویدادی با این فیلترها یافت نشد</td></tr>'}
      </tbody>
    </table></div>
    ${data.has_more ? '<div style="text-align:center;margin:14px 0"><button class="btn subtle" id="vs-more">نمایش بیشتر…</button></div>' : ''}
  `;
}

function mountVisits() {
  const refresh = $('#vs-refresh');
  if (refresh) refresh.addEventListener('click', () => navigate('visits'));

  $$('[data-vsrange]').forEach(b => b.addEventListener('click', () => {
    state._vs.range = b.dataset.vsrange;
    navigate('visits');
  }));
  $$('[data-vskind]').forEach(b => b.addEventListener('click', () => {
    state._vs.kind = b.dataset.vskind || '';
    navigate('visits');
  }));

  $$('[data-vslimit]').forEach(b => b.addEventListener('click', () => {
    state._vs.limit = Number(b.dataset.vslimit) || 50;
    navigate('visits');
  }));

  const fromBtn = $('#vs-from-btn');
  if (fromBtn) fromBtn.addEventListener('click', e => {
    e.stopPropagation();
    openCalendar('from', { store: state._vs, view: 'visits', wrap: $('#vs-cal-wrap') });
  });
  const toBtn = $('#vs-to-btn');
  if (toBtn) toBtn.addEventListener('click', e => {
    e.stopPropagation();
    openCalendar('to', { store: state._vs, view: 'visits', wrap: $('#vs-cal-wrap') });
  });

  mountCalPop(); // bind calendar popover (when open) after re-render

  const clearBtn = $('#vs-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    state._vs = { range: 'all', from: '', to: '', kind: '', limit: state._vs.limit || 50 };
    navigate('visits');
  });

  const tgl = $('#vs-tgl');
  if (tgl) tgl.addEventListener('click', async () => {
    tgl.disabled = true;
    try {
      const on = Boolean(state._vsData && state._vsData.notify_enabled);
      const r = await api('/a/visits/notify', { method: 'PUT', body: { enabled: !on } });
      haptic('success');
      toast(r.notify_enabled ? 'پیام تلگرام هنگام ورود اعضا فعال شد' : 'پیام تلگرام هنگام ورود اعضا خاموش شد', 'ok');
      navigate('visits');
    } catch (e) { toast(e.message, 'err'); tgl.disabled = false; }
  });

  const more = $('#vs-more');
  if (more) more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const p = vsQuery();
      p.set('offset', String((state._vsData.visits || []).length));
      const data = await api('/a/visits?' + p.toString());
      state._vsData.visits.push(...(data.visits || []));
      state._vsData.has_more = data.has_more;
      const tb = $('#vs-tbody');
      if (tb && (data.visits || []).length) {
        tb.insertAdjacentHTML('beforeend', data.visits.map(vsRowHtml).join(''));
      }
      if (!data.has_more) more.closest('div').remove();
      else more.disabled = false;
    } catch (e) { toast(e.message, 'err'); more.disabled = false; }
  });
}

// --- settings ---------------------------------------------------------------
function botCardHtml(bot) {
  const st = bot || {};
  const connected = st.configured && st.connected;
  const statusHtml = !st.configured
    ? `<p class="p-muted">ربات هنوز متصل نشده است. توکن را از <b dir="ltr">@BotFather</b> بگیرید و همین‌جا ثبت کنید — وب‌هوک، دکمه منو و دستورات خودکار تنظیم می‌شوند (بدون نیاز به ترمینال).</p>`
    : `<div class="filter-row" style="margin-bottom:8px">
        <span class="fchip ${connected ? 'on' : ''}" style="cursor:default">${connected ? '✅ متصل' : '⚠️ قطع'}${st.username ? ' — @' + esc(st.username) : ''}</span>
        <span class="fchip" style="cursor:default">منبع توکن: ${st.source === 'settings' ? 'پنل مدیریت' : 'متغیر محیطی'}</span>
        ${st.masked ? `<span class="fchip" style="cursor:default" dir="ltr">${esc(st.masked)}</span>` : ''}
      </div>
      ${connected ? '' : `<p class="p-muted">اتصال ربات تأیید نشد: ${esc(st.error || 'نامشخص')}</p>`}
      ${st.webhook && st.webhook.url ? (
        st.webhook.matches_app
          ? `<p class="p-muted">وب‌هوک: ✅ روی آدرس فعلی اپ ثبت است${st.webhook.last_error ? ' — آخرین خطا: ' + esc(st.webhook.last_error) : ''}</p>`
          : `<p class="p-muted">وب‌هوک روی آدرس دیگری ثبت است (<span dir="ltr">${esc(st.webhook.url)}</span>) — دکمه «ثبت وب‌هوک» را بزنید.</p>`
      ) : (st.webhook && st.webhook.error
        ? `<p class="p-muted">وضعیت وب‌هوک نامشخص: ${esc(st.webhook.error)}</p>`
        : (connected ? '<p class="p-muted">وب‌هوک ثبت نشده است — دکمه «ثبت وب‌هوک» را بزنید.</p>' : ''))}`;

  const links = connected && st.links ? `
    <div class="filter-row" style="margin-top:10px">
      ${st.links.add_to_group ? `<a class="btn accent sm" href="${esc(st.links.add_to_group)}" target="_blank" rel="noopener">➕ افزودن ربات به گروه</a>` : ''}
      ${st.links.bot ? `<a class="btn ghost sm" href="${esc(st.links.bot)}" target="_blank" rel="noopener">💬 چت با ربات</a>` : ''}
      <button class="btn ghost sm" data-botact="copylink">📋 کپی لینک اپ</button>
    </div>
    <div class="p-note" style="margin-top:8px">در چت خصوصی، دکمه منو کنار کادر نوشتن اپ را باز می‌کند. در گروه‌ها تلگرام دکمه منو ندارد و دکمه وب‌اپ هم فقط در چت خصوصی مجاز است؛ به همین دلیل ربات در گروه پیام با <b>دکمه لینک</b> («باز کردن اپ ساختمان») می‌فرستد — آن پیام را <b>پین کنید</b> (دستور <code>/app</code> هم همان پیام را دوباره می‌فرستد). ضمناً انتخاب دستور از فهرست منو فقط متنش را در کادر می‌نویسد — اجرای آن با دکمه ارسال (✈️) است.</div>`
    : '';

  return `
    <div class="pcard wide" id="bot-card">
      <div class="pc-k">🤖 ربات تلگرام — اتصال اپ و مینی‌اپ به ربات</div>
      ${statusHtml}
      <div id="bot-form" class="form-grid" style="margin-top:8px;${st.configured && connected ? 'display:none' : ''}">
        <div class="field"><label>توکن ربات (از @BotFather)</label>
          <input id="bot-token" dir="ltr" type="password" placeholder="123456789:AAExample_Token_From_BotFather" autocomplete="off">
        </div>
        <button class="btn accent" id="bot-save">${icon('link', 16)} ${st.configured && !connected ? 'تلاش مجدد / ذخیره توکن' : 'اتصال ربات'}</button>
      </div>
      ${st.configured ? `
        <div class="filter-row" style="margin-top:10px">
          <button class="btn ghost sm" data-botact="showform">🔁 جایگزینی توکن</button>
          <button class="btn ghost sm" data-botact="webhook">${icon('refresh', 16)} ثبت وب‌هوک</button>
          <button class="btn ghost sm" data-botact="menu">⚙️ دکمه منو و دستورات</button>
          ${st.source === 'settings' ? '<button class="btn danger sm" data-botact="disconnect">قطع اتصال ربات</button>' : ''}
        </div>` : ''}
      ${links}
    </div>`;
}

async function viewSettings() {
  const [s, bot] = await Promise.all([
    api('/a/settings'),
    api('/a/bot').catch(() => ({ configured: false }))
  ]);
  state._settings = s.settings || {};
  state._bot = bot || {};
  const st = s.settings || {};
  return `
    <div class="p-head"><h2>تنظیمات اپ</h2></div>
    <div class="p-grid2">
      ${botCardHtml(state._bot)}
      <div class="pcard wide">
        <div class="pc-k">اطلاعات ساختمان و پرداخت</div>
        <div class="form-grid">
          <div class="field"><label>نام ساختمان *</label><input id="se-name" value="${esc(st.building_name || '')}"></div>
          <div class="field"><label>آدرس</label><input id="se-addr" value="${esc(st.address || '')}"></div>
          <div class="field"><label>تلفن مدیریت</label><input id="se-phone" value="${esc(faNum(st.phone || ''))}"></div>
          <div class="field"><label>شماره کارت (برای نمایش در صورت‌حساب)</label><input id="se-card" dir="ltr" value="${esc(st.bank_card || '')}"></div>
          <div class="field"><label>به نام (صاحب کارت)</label><input id="se-owner" value="${esc(st.bank_owner || '')}"></div>
          ${moneyField({ id: 'se-amount', label: 'مبلغ پیش‌فرض شارژ ماهانه', value: st.default_monthly_amount ? Number(st.default_monthly_amount).toLocaleString('en-US') : '', required: false })}
        </div>
        <button class="btn accent" id="se-save" style="margin-top:10px">${icon('check', 16)} ذخیره تنظیمات</button>
      </div>
      <div class="pcard wide">
        <div class="pc-k">حساب مدیر اپ</div>
        <div class="form-grid">
          <div class="field"><label>رمز عبور جدید</label><input id="ap-pass" dir="ltr" placeholder="خالی = بدون تغییر"></div>
        </div>
        <button class="btn accent" id="ap-save" style="margin-top:10px">${icon('check', 16)} تغییر رمز من</button>
        <div class="p-note">این پنل روی مرورگر باز می‌شود؛ توصیه می‌شود رمز قوی انتخاب کنید و آدرس پنل را فقط در اختیار افراد مورد اعتماد بگذارید.</div>
      </div>
    </div>
  `;
}

function mountSettings() {
  bindMoneyInputs($('#pview'));
  // ---- bot card actions ----
  const botSave = $('#bot-save');
  if (botSave) botSave.addEventListener('click', async () => {
    const token = $('#bot-token').value.trim();
    if (!token) { toast('توکن ربات را وارد کنید', 'err'); return; }
    botSave.disabled = true;
    try {
      const r = await api('/a/bot/token', { method: 'POST', body: { token } });
      haptic('success');
      toast(`ربات @${r.username} متصل شد ✅`, 'ok');
      if (r.webhook_ok) toast('وب‌هوک روی آدرس فعلی اپ ثبت شد', 'ok', 3000);
      else if (r.webhook_error) toast('وب‌هوک ثبت نشد: ' + r.webhook_error, 'err', 5000);
      navigate('settings');
    } catch (e) { toast(e.message, 'err', 5200); botSave.disabled = false; }
  });
  $$('[data-botact]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.botact;
    try {
      if (act === 'showform') {
        const f = $('#bot-form');
        if (f) { f.style.display = ''; $('#bot-token').focus(); }
      } else if (act === 'webhook') {
        b.disabled = true;
        await api('/a/bot/webhook', { method: 'POST', body: {} });
        toast('وب‌هوک ربات روی آدرس فعلی ثبت شد', 'ok');
        navigate('settings');
      } else if (act === 'menu') {
        b.disabled = true;
        await api('/a/bot/menu', { method: 'POST', body: {} });
        toast('دکمه منو و دستورات ربات اعمال شد (در چت خصوصی ربات)', 'ok');
        b.disabled = false;
      } else if (act === 'disconnect') {
        const okd = await confirmDialog('اتصال ربات قطع شود؟ یادآوری‌ها و اعلان‌های تلگرامی از کار می‌افتند.');
        if (!okd) return;
        b.disabled = true;
        await api('/a/bot/token', { method: 'DELETE', body: {} });
        toast('اتصال ربات قطع شد', 'ok');
        navigate('settings');
      } else if (act === 'copylink') {
        const url = (state._bot && state._bot.links && state._bot.links.app) || location.origin;
        try { await navigator.clipboard.writeText(url); toast('لینک اپ کپی شد', 'ok'); }
        catch { toast(url, 'info', 5000); }
      }
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  }));
  // ---- building settings ----
  const save = $('#se-save');
  if (save) save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await api('/a/settings', {
        method: 'POST',
        body: {
          building_name: $('#se-name').value.trim(),
          address: $('#se-addr').value.trim(),
          phone: enNum($('#se-phone').value).trim(),
          bank_card: enNum($('#se-card').value).trim(),
          bank_owner: $('#se-owner').value.trim(),
          default_monthly_amount: parseNum($('#se-amount').value)
        }
      });
      toast('تنظیمات ذخیره شد', 'ok');
      navigate('settings');
    } catch (e) { toast(e.message, 'err'); save.disabled = false; }
  });
  const ap = $('#ap-save');
  if (ap) ap.addEventListener('click', async () => {
    const pass = $('#ap-pass').value;
    if (!pass) { toast('رمز جدید را وارد کنید', 'err'); return; }
    if (pass.length < 6) { toast('رمز باید حداقل ۶ کاراکتر باشد', 'err'); return; }
    try {
      await api('/a/users/' + state.user.id, { method: 'PUT', body: { password: pass } });
      toast('رمز عبور تغییر کرد', 'ok');
      $('#ap-pass').value = '';
    } catch (e) { toast(e.message, 'err'); }
  });
}

// --- tools (sample data) ------------------------------------------------------
async function viewTools() {
  return `
    <div class="p-head"><h2>داده نمونه و ابزارهای نصب</h2></div>
    <div class="p-grid2">
      <div class="pcard wide">
        <div class="pc-k">داده نمونه</div>
        <p class="p-muted">۸ واحد نمونه با حساب کاربری ساکنین (unit1 تا unit8 با رمز 1234)، شارژ دو ماه، دو هزینه مشترک و تقسیم خودکار سهم‌ها ساخته می‌شود. برای آزمایش سریع اپ مناسب است.</p>
        <div class="field"><label class="chk"><input type="checkbox" id="sd-force"> بازنویسی داده‌های فعلی (حذف واحدها و اقلام مالی موجود)</label></div>
        <button class="btn accent" id="sd-go">${icon('db', 16)} بارگذاری داده نمونه</button>
      </div>
      <div class="pcard wide danger-zone">
        <div class="pc-k">پاک‌سازی داده‌های ساختمان</div>
        <p class="p-muted">همه واحدها، اقلام مالی و حساب‌های ساکنین حذف می‌شوند. حساب مدیر اپ و مدیران ساختمان باقی می‌مانند.</p>
        <button class="btn danger" id="rs-go">${icon('trash', 16)} پاک‌سازی کامل داده‌ها</button>
      </div>
      <div class="pcard wide">
        <div class="pc-k">خروجی و پشتیبان (v2.15.0)</div>
        <p class="p-muted">دانلود گزارش‌ها و پشتیبان کامل مستقیماً از همین پنل — «اکسل» در هر نسخه‌ای از Excel ستون‌بندی درست دارد؛ بکاپ ZIP مدارک پیوست را هم داخل همان فایل نگه می‌دارد (با یا بدون مدارک) و بازیابی از همان ZIP یا JSON انجام می‌شود.</p>
        <div class="p-grid2" style="gap:8px">
          <button class="btn subtle block" id="exp-debtors-x">${icon('download', 16)} اکسل بدهکاران</button>
          <button class="btn subtle block" id="exp-year-x">${icon('download', 16)} اکسل خلاصه سال جاری</button>
          <button class="btn subtle block" id="exp-debtors-c">${icon('download', 16)} CSV بدهکاران</button>
          <button class="btn subtle block" id="exp-year-c">${icon('download', 16)} CSV خلاصه سال</button>
          <button class="btn subtle block" id="exp-backup-zip">${icon('db', 16)} پشتیبان کامل با مدارک (ZIP)</button>
          <button class="btn subtle block" id="exp-backup-zip-light">${icon('db', 16)} پشتیبان بدون مدارک (ZIP)</button>
          <button class="btn subtle block" id="exp-backup">${icon('db', 16)} پشتیبان کامل (JSON)</button>
          <button class="btn subtle block" id="exp-restore">${icon('upload', 16)} بازیابی پشتیبان (ZIP یا JSON)</button>
        </div>
        <input id="admin-restore-file" type="file" accept=".zip,.json,application/zip,application/json" hidden>
      </div>
      <div class="pcard wide">
        <div class="pc-k">ربات تلگرام</div>
        <p class="p-muted">مدیریت ربات (ثبت توکن، وب‌هوک، دکمه منو و لینک افزودن به گروه) به تب <b>تنظیمات اپ</b> منتقل شده است.</p>
        <button class="btn subtle" id="go-settings">${icon('gear', 16)} رفتن به تنظیمات اپ</button>
      </div>
    </div>
  `;
}

// v2.14.0 — downloads from the app-admin panel (server routes, shared access)
// v2.14.1 — Telegram WebView (android/ios): <a download> با blob کار نمی‌کند →
// فایل با توکن در query به مرورگر بیرونی سپرده می‌شود (سرور ?t= را می‌پذیرد)
const TG = window.Telegram?.WebApp;
const TG_MOBILE = ['android', 'ios'].includes(String(TG?.platform || '').toLowerCase());
function openServerDownloadPanel(pathWithQuery) {
  const abs = location.origin + pathWithQuery
    + (pathWithQuery.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(getToken());
  try {
    if (TG?.openLink) TG.openLink(abs);
    else window.open(abs, '_blank');
  } catch { window.open(abs, '_blank'); }
  toast('فایل در مرورگر باز شد؛ دانلود آنجا انجام می‌شود', 'info', 2600);
}

async function adminDownload(type, fmt, files) {
  try {
    // v2.15.0 — ZIP بکاپ با/بدون مدارک
    let q = (fmt ? '&fmt=' + fmt : '');
    if (type === 'backup' && fmt === 'zip') q += '&files=' + (files === '0' ? '0' : '1');
    let blob, filename;
    if (MOCK) {
      const res = await mockFetch('/export?type=' + type + q, 'GET', {});
      const dl = res.__download;
      if (!dl) throw new Error(res.error || 'خروجی در دسترس نیست');
      blob = new Blob([dl.content], { type: /zip/.test(dl.mime) ? dl.mime : dl.mime + ';charset=utf-8' });
      filename = dl.filename;
    } else if (TG_MOBILE) {
      openServerDownloadPanel('/api/export?type=' + type + q);
      return;
    } else {
      const res = await fetch('/api/export?type=' + type + q, { headers: { authorization: 'Bearer ' + getToken() } });
      if (!res.ok) {
        let msg = 'خطا در دریافت فایل (' + res.status + ')';
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* not json */ }
        throw new Error(msg);
      }
      blob = await res.blob();
      const m2 = /filename="(.+)"/.exec(res.headers.get('content-disposition') || '');
      filename = m2 ? m2[1] : (type + (fmt === 'xls' ? '.xls' : fmt === 'zip' ? '.zip' : '.csv'));
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('فایل خروجی آماده شد', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function adminRestore(file) {
  if (file.size > 80 * 1024 * 1024) { toast('حجم فایل بیش از حد مجاز است', 'err'); return; }
  let payload;
  // v2.15.0 — بازیابی از ZIP: backup.json داخل بسته استخراج می‌شود
  let head = new Uint8Array(0);
  try { head = new Uint8Array(await file.slice(0, 4).arrayBuffer()); } catch { /* empty */ }
  const isZip = head.length > 3 && head[0] === 0x50 && head[1] === 0x4B && head[2] === 0x03 && head[3] === 0x04;
  if (isZip) {
    try {
      const { readZip } = await import('./lib/zip.js');
      const entries = await readZip(new Uint8Array(await file.arrayBuffer()));
      const bj = entries.find(e => e.name === 'backup.json' || e.name.endsWith('/backup.json'));
      if (!bj) { toast('داخل این ZIP فایل backup.json پیدا نشد', 'err'); return; }
      payload = JSON.parse(new TextDecoder().decode(bj.data));
    } catch (e) { toast((e && e.message) || 'خواندن ZIP ناموفق بود', 'err'); return; }
  } else {
    try { payload = JSON.parse(await file.text()); }
    catch { toast('فایل معتبر نیست (ZIP یا JSON پشتیبان همین اپ)', 'err'); return; }
  }
  if (!payload || payload.app !== 'building-charges' || !Array.isArray(payload.units)) {
    toast('این فایل پشتیبانِ همین اپ نیست', 'err'); return;
  }
  const n = x => faNum(Number((x || []).length));
  const okd = await confirmDialog(
    `بازیابی پشتیبان؟\n\n` +
    `• واحدها: ${n(payload.units)}\n• اقلام مالی: ${n(payload.debts)}\n• حساب‌ها: ${n(payload.users)}\n` +
    `• کارها: ${n(payload.tasks)}\n• مدارک پیوست: ${n(payload.task_files)}\n\n` +
    `داده‌های فعلی با محتوای این فایل جایگزین می‌شود. این عمل قابل بازگشت نیست!`
  );
  if (!okd) return;
  try {
    await api('/import', { method: 'POST', body: payload });
    haptic('success');
    toast('پشتیبان با موفقیت بازیابی شد', 'ok');
    navigate('overview');
  } catch (e) { toast(e.message, 'err'); }
}

function mountTools() {
  // v2.14.0 — export/backup wiring
  const ex = (id, type, fmt) => { const b = $(id); if (b) b.addEventListener('click', () => adminDownload(type, fmt)); };
  ex('#exp-debtors-x', 'debtors', 'xls');
  ex('#exp-year-x', 'year', 'xls');
  ex('#exp-debtors-c', 'debtors', '');
  ex('#exp-year-c', 'year', '');
  const bb = $('#exp-backup'); if (bb) bb.addEventListener('click', () => adminDownload('backup', ''));
  const bz = $('#exp-backup-zip'); if (bz) bz.addEventListener('click', () => adminDownload('backup', 'zip', '1'));
  const bzl = $('#exp-backup-zip-light'); if (bzl) bzl.addEventListener('click', () => adminDownload('backup', 'zip', '0'));
  const rb = $('#exp-restore');
  const rf = $('#admin-restore-file');
  if (rb && rf) {
    rb.addEventListener('click', () => { rf.value = ''; rf.click(); });
    rf.addEventListener('change', () => { const f = rf.files && rf.files[0]; if (f) adminRestore(f); });
  }
  const sd = $('#sd-go');
  if (sd) sd.addEventListener('click', async () => {
    const force = $('#sd-force').checked;
    const okd = await confirmDialog(force
      ? 'داده‌های فعلی حذف و داده نمونه ساخته شود؟'
      : 'داده نمونه اضافه شود؟');
    if (!okd) return;
    sd.disabled = true;
    try {
      const r = await api('/a/dev/seed', { method: 'POST', body: { force } });
      haptic('success');
      toast(`داده نمونه ساخته شد: ${faNum(r.units)} واحد، ${faNum(r.accounts)} حساب ساکن`, 'ok');
      if (r.login_hint) toast(r.login_hint, 'info', 5000);
      navigate('tools');
    } catch (e) { toast(e.message, 'err'); sd.disabled = false; }
  });
  const rs = $('#rs-go');
  if (rs) rs.addEventListener('click', async () => {
    const okd1 = await confirmDialog('تمام واحدها، اقلام مالی و حساب‌های ساکنین حذف شوند؟');
    if (!okd1) return;
    const okd2 = await confirmDialog('مطمئنید؟ این عملیات قابل بازگشت نیست!');
    if (!okd2) return;
    try {
      await api('/a/dev/reset', { method: 'POST', body: {} });
      if (MOCK) { toast('در حالت نمایشی داده‌ها به حالت اولیه بازگشتند؛ صفحه دوباره بارگذاری می‌شود', 'ok'); setTimeout(() => location.reload(), 900); return; }
      toast('همه داده‌های ساختمان پاک شد', 'ok');
      navigate('overview');
    } catch (e) { toast(e.message, 'err'); }
  });
  const gs = $('#go-settings');
  if (gs) gs.addEventListener('click', () => {
    $$('#side-nav .snav').forEach(x => x.classList.toggle('on', x.dataset.view === 'settings'));
    navigate('settings');
  });
}

// --- install guide (راهنمای نصب) ----------------------------------------------
async function viewGuide() {
  const steps = [
    {
      t: '۱) استقرار روی Cloudflare — دو راه: خودکار یا دستی',
      b: `<p><b>راه خودکار (توصیه‌شده — یک دستور):</b> در پوشه پروژه دستور زیر را اجرا کنید. اسکریپت همه‌چیز را انجام می‌دهد: نصب وابستگی‌ها، بررسی ورود، ساخت دیتابیس D1 و ثبت خودکار <code>database_id</code> در <code>wrangler.jsonc</code>، اعمال اسکیما، دیپلوی و حتی فعال‌سازی وب‌هوک ربات اگر <code>BOT_TOKEN</code> بدهید.</p>
      <pre>npm run deploy:auto
# یا با ربات:
BOT_TOKEN=123:ABC npm run deploy:auto</pre>
      <p><b>راه دستی (قدم‌به‌قدم):</b></p>
      <ol class="guide-ol">
        <li>در پوشه پروژه <code>npm install</code> و سپس <code>npx wrangler login</code> را اجرا کنید (یک بار).</li>
        <li>دیتابیس بسازید: <code>npx wrangler d1 create building-charges</code> — مقدار <b>database_id</b> خروجی را در فایل <code>wrangler.jsonc</code> جایگزین <code>REPLACE_ME_AFTER_d1_create</code> کنید.</li>
        <li>جداول را بسازید: <code>npm run db:init</code> (اسکما idempotent است — اجرای تکراری بی‌خطر است؛ برای به‌روزرسانی‌های بعدی، فایل‌های پوشه <code>migrations/</code> را هم با همین دستور اجرا کنید).</li>
        <li>انتشار: <code>npm run deploy</code> — آدرس اپ شما <code>https://building-charges.&lt;subdomain&gt;.workers.dev</code> خواهد بود.</li>
      </ol>
      <p><b>استقرار تمام‌خودکار با CI/CD:</b> اگر پروژه روی GitHub باشد، پوشه <code>.github/workflows/deploy.yml</code> همراه پروژه است؛ کافی است در GitHub سه Secret تعریف کنید: <code>CLOUDFLARE_API_TOKEN</code> (با دسترسی D1 Edit + Workers Scripts Edit)، <code>CLOUDFLARE_ACCOUNT_ID</code> و اختیاراً <code>TELEGRAM_BOT_TOKEN</code> — از آن پس هر push به main، تست و استقرار را کامل خودکار انجام می‌دهد.</p>`
    },
    {
      t: '۲) نصب اولیه اپ',
      b: `<p>همین صفحه (<code>admin.html</code>) را باز کنید. بار اول، فرم «نصب اولیه» نمایش داده می‌شود: <b>نام ساختمان</b> و <b>حساب «مدیر اپ»</b> (نام کاربری و رمز) را تعریف کنید. این حساب مالک اپ است و فقط از طریق همین پنل وارد می‌شود.</p>`
    },
    {
      t: '۳) تعیین مدیر ساختمان — ارتقا و عزل کاربران',
      b: `<p><b>راه اصلی:</b> در تب <b>کاربران</b> روی دکمه <b>👑 مدیر کن</b> کنار هر کاربر بزنید تا مدیر ساختمان شود — بلافاصله در تب «مدیران ساختمان» ظاهر می‌شود. با دکمه <b>عزل از مدیریت</b> (در تب کاربران یا مدیران) به نقش ساکن برمی‌گردد و از فهرست مدیران حذف می‌شود. نیازی به ساخت حساب جداگانه برای هر مدیر نیست.</p>
      <p>اگر می‌خواهید <b>حساب جدید</b> بسازید، در تب «کاربران» دکمه <b>افزودن کاربر</b> است (ساکن یک واحد یا مدیر ساختمان). دکمه «ساخت حساب مدیر جدید» در تب مدیران هم برای ساختن حساب مدیر مستقل باقی است. با «ویرایش» هر کاربر می‌توانید نام کاربری ورود، نام، تلفن، واحد و رمز را عوض کنید. مدیر ساختمان هیچ دسترسی‌ای به این پنل ندارد.</p>
      <p><b>مدیر ساکن است یا نه؟</b> مدیرِ ساکن (با واحد) مثل بقیهٔ واحدها جزو <b>بدهکاران شارژ</b> است و یادآوری خودکار/دستی برایش ارسال می‌شود. اگر مدیر در ساختمان ساکن نیست، در «ویرایش» تیک <b>«مدیر، ساکن ساختمان نیست»</b> را بزنید تا از فهرست بدهکاران و یادآوری‌ها مستثنی شود (ستون «سکونت» در تب مدیران وضعیت را نشان می‌دهد).</p>
      <p><b>لینک اتصال تلگرام (یک‌بارمصرف):</b> دکمه <b>🔗 لینک تلگرام</b> کنار هر کاربر (یا دکمه داخل «ویرایش» کاربر) همان لینک دعوت پنل مدیر ساختمان را می‌سازد: اعتبار لینک را انتخاب کنید (۱ ساعت تا ۷ روز)، لینک را برای کاربر بفرستید و او آن را <b>از داخل تلگرام با پروفایل خودش</b> باز کند و <b>یوزرنیم و رمز عبور همان حساب</b> را وارد کند — حسابش فقط به همان پروفایل قفل می‌شود و نشست‌های قبلی/ورود با یوزر و رمز از پروفایل دیگر باطل می‌شود. از v2.20.0 اگر پروفایل کاربر قبلاً به حساب دیگری وصل بود، همین لینک او را <b>از آن حساب خارج و به این حساب منتقل می‌کند</b> (خطای «پروفایل قبلاً به حساب دیگری متصل شده» دیگر وجود ندارد)؛ پروفایل قبلیِ این حساب هم خودکار از حساب خارج می‌شود و این وضعیت تا ساخته‌شدن لینک جدید بعدی پابرجا می‌ماند. هر حساب در هر لحظه فقط یک لینک فعال دارد و می‌توانید لینک فعال را «باطل» کنید. برای حساب «مدیر اپ» لینک دعوت ساخته نمی‌شود.</p>`
    },
    {
      t: '۴) راه‌اندازی ساختمان توسط مدیر',
      b: `<p>مدیر ساختمان با حسابش وارد اپ می‌شود (همان آدرس workers.dev یا از طریق ربات)، واحدها را ثبت می‌کند و برای هر ساکن یک <b>حساب کاربری (نام کاربری و رمز)</b> می‌سازد. ساکنین فقط وضعیت واحد خودشان را می‌بینند و به داده‌های دیگران دسترسی ندارند.</p>`
    },
    {
      t: '۵) ربات تلگرام — اتصال بدون ترمینال از تب تنظیمات',
      b: `<ol class="guide-ol">
        <li>در تلگرام از <b>@BotFather</b> با دستور <code>/newbot</code> یک ربات بسازید و توکن را کپی کنید (قالب: <code>123456789:AAEx…</code>).</li>
        <li>در همین پنل به تب <b>تنظیمات اپ</b> بروید، در کارت «🤖 ربات تلگرام» توکن را وارد کنید و دکمه <b>اتصال ربات</b> را بزنید. ربات تأیید می‌شود و <b>وب‌هوک، دکمه منو و دستورات (/start و /app) خودکار ثبت می‌شوند</b> — هیچ دستور ترمینالی لازم نیست.</li>
        <li>وضعیت اتصال، وب‌هوک و توکن (به‌صورت ماسک‌شده) در همان کارت نمایش داده می‌شود؛ دکمه‌های «ثبت وب‌هوک»، «دکمه منو و دستورات» و «جایگزینی توکن» هم همان‌جاست.</li>
        <li>روش جایگزین (سروری): <code>BOT_TOKEN=... npm run deploy:auto</code> یا <code>npx wrangler secret put BOT_TOKEN</code> — در این حالت توکن از متغیر محیطی خوانده می‌شود؛ اگر بعداً توکن دیگری در پنل ذخیره کنید، <b>توکن پنل اولویت دارد</b>.</li>
      </ol>
      <p>نکته مهم: یادآوری بدهی و اعلان همگانی از طریق همین ربات ارسال می‌شود. ساکنین باید یک بار <b>داخل تلگرام</b> با نام کاربری/رمز وارد اپ شوند تا حسابشان به تلگرام متصل شود؛ پس از آن پیام‌ها برایشان قابل ارسال است.</p>`
    },
    {
      t: '۶) اتصال اپ به گروه تلگرام — تا ساکنین دنبال آدرس نگردند',
      b: `<p>بهترین راه اینکه واحدها همیشه به اپ دسترسی داشته باشند، اضافه‌کردن ربات به گروه ساختمان است:</p>
      <ol class="guide-ol">
        <li>در تب «تنظیمات اپ» روی دکمه <b>➕ افزودن ربات به گروه</b> بزنید (لینک <code>t.me/ربات?startgroup</code> باز می‌شود) و گروه ساختمان را انتخاب کنید. افزودن دستی ربات به گروه هم کافی است.</li>
        <li>ربات به‌محض ورود، پیام خوش‌آمد با دکمه <b>«باز کردن اپ ساختمان»</b> را در گروه می‌فرستد (در گروه‌ها این دکمه به‌صورت لینک است چون تلگرام دکمه وب‌اپ را فقط در چت خصوصی قبول می‌کند). این پیام را <b>پین کنید</b> — از این به بعد همه از همین دکمه اپ را باز می‌کنند.</li>
        <li>اگر پیام پین‌شده حذف شد، هر ساکنی دستور <code>/app</code> را در گروه بفرستد، همان پیام دوباره ارسال می‌شود. یادآوری: انتخاب دستور از فهرست منو فقط آن را در کادر می‌نویسد — باید <b>دکمه ارسال</b> زده شود.</li>
        <li>توصیه می‌شود ربات را <b>مدیر گروه</b> کنید تا دستور <code>/app</code> را حتماً ببیند؛ در غیر این صورت در BotFather بخش <code>/mybots ← Bot Settings ← Group Privacy</code> را خاموش کنید (اگر ربات عضو ساده بماند، خودش در پیام خوش‌آمد این نکته را یادآوری می‌کند).</li>
        <li>در چت خصوصیِ ربات هم دکمه منو (⚙️ کنار کادر تایپ) اپ را مستقیم باز می‌کند — برای هر ساکن به‌صورت جداگانه کار می‌کند.</li>
      </ol>
      <p>نکته فنی: تلگرام دکمه منو و دکمه وب‌اپ را فقط در چت خصوصی نشان می‌دهد/قبول می‌کند؛ به همین دلیل «پیام پین‌شده با دکمه لینک» راه استاندارد اتصال اپ به گروه است.</p>`
    },    {
      t: '۷) تنظیمات و صورت‌حساب PDF',
      b: `<p>در تب «تنظیمات اپ» نام ساختمان، آدرس، تلفن و <b>شماره کارت</b> را ثبت کنید تا در صورت‌حساب‌های PDF (صورت‌حساب هر واحد و گزارش سالانه) نمایش داده شود. صورت‌حساب‌ها به‌صورت فارسی و راست‌به‌چپ تولید می‌شوند.</p>`
    },
    {
      t: '۸) عیب‌یابی',
      b: `<ul class="guide-ul">
        <li><b>خطای database_id هنگام deploy:</b> هنوز <code>REPLACE_ME_AFTER_d1_create</code> است — یک بار <code>npm run deploy:auto</code> اجرا کنید تا خودکار ثبت شود.</li>
        <li><b>خطای no such table در اپ:</b> اسکیما اعمال نشده — <code>npm run db:init</code>.</li>
        <li><b>دکمه یادآوری پیام می‌دهد که توکن ربات تنظیم نشده:</b> مرحله ۵ — توکن را در تب «تنظیمات اپ» ذخیره کنید (وب‌هوک خودکار ثبت می‌شود).</li>
        <li><b>یادآوری «۰ نفر» را گزارش می‌کند:</b> هیچ ساکن متصلی وجود ندارد؛ ساکنین باید یک بار داخل تلگرام وارد اپ شوند.</li>
        <li><b>«نشست منقضی شده»:</b> طبیعی است؛ کاربر دوباره وارد می‌شود.</li>
        <li><b>حذف داده‌های آزمایشی:</b> در تب «داده نمونه و نصب» گزینه پاک‌سازی کامل، همه واحدها و اقلام مالی را حذف می‌کند و ساختمان برای استفاده واقعی آماده می‌شود.</li>
      
        <li><b>ربات به گروه اضافه شد ولی پیام نمی‌دهد:</b> ربات را مدیر گروه کنید یا Group Privacy را در BotFather خاموش کنید؛ سپس دستور <code>/app</code> را بفرستید.</li>
        <li><b>توکن ربات را عوض کردم (ربات جدید):</b> توکن جدید را در تب «تنظیمات اپ» ذخیره کنید؛ وب‌هوک و دکمه منو خودکار روی توکن جدید اعمال می‌شود.</li>
        <li><b>آدرس اپ (دامنه) تغییر کرد:</b> در تب «تنظیمات اپ» دکمه‌های «ثبت وب‌هوک» و «دکمه منو و دستورات» را دوباره بزنید.</li>
      </ul>`
    }
  ];
  return `
    <div class="p-head"><h2>راهنمای نصب و راه‌اندازی</h2><span class="p-chip">نسخه ${esc(faNum(PANEL_DOCS_VERSION))}</span></div>
    <div class="p-note">این راهنما فقط در همین پنل مدیریت قرار دارد و در اپ مدیر ساختمان/ساکنین نمایش داده نمی‌شود. مراحل را به ترتیب انجام دهید.</div>
    ${steps.map((s, i) => `
      <div class="pcard wide">
        <div class="pc-k">${esc(s.t)}</div>
        ${s.b}
      </div>`).join('')}
    <div class="p-note">مسیرهای مدیریتی API (<code>/a/*</code>) فقط با نقش «مدیر اپ» قابل دسترسی‌اند و در اپ مدیر ساختمان هیچ نشانه‌ای از این پنل وجود ندارد.</div>
  `;
}

// --- panel tutorial (آموزش پنل — v2.10.0) ------------------------------------
// Full usage tutorial for every tab of this panel. The explanatory note that
// used to sit at the bottom of the dashboard was moved into section 2 here.
const PANEL_DOCS_VERSION = '2.23.1';

function viewTutorial() {
  const parts = [
    {
      t: '۱) پنل مدیریت اپ چیست و چه کسانی به آن وارد می‌شوند؟',
      b: `<p>این پنل (<code>admin.html</code>) مرکز فرماندهی کل اپلیکیشن است و <b>فقط مالک اپ</b> — یعنی کاربری که با نقش «مدیر اپ» ساخته می‌شود — به آن وارد می‌شود. آدرس آن جدا از اپ ساختمان است و هیچ دکمه یا لینکی از داخل اپ مدیر ساختمان یا نمای ساکنین به آن وجود ندارد؛ پس آدرسش را فقط در اختیار افراد مورد اعتماد بگذارید.</p>
      <p>اپ سه نقش دارد: <b>مدیر اپ</b> (شما — مالک و مدیر همین پنل)، <b>مدیر ساختمان</b> (کاربر روزمره‌ای که واحدها، شارژها، هزینه‌ها و یادآوری‌ها را در اپ اصلی مدیریت می‌کند) و <b>ساکن</b> (که فقط وضعیت واحد خودش را می‌بیند). طبق همین سیاست دسترسی، <b>اطلاعات ریز مالی (شارژ و بدهی تک‌تک واحدها) فقط در اپ مدیر ساختمان دیده می‌شود</b>؛ در این پنل فقط گزارش تجمیعی «📈 عملکرد مدیر» (کارها، هزینه‌ها و مانده صندوق) بدون جزئیات واحدها دیده می‌شود. بقیه اینجا مدیریت کاربران، اتصال ربات، تنظیمات و گزارش‌های ورود و پیام است.</p>`
    },
    {
      t: '۲) تب «داشبورد اپ» — تصویر کلی',
      b: `<p>اولین چیزی که پس از ورود می‌بینید. چهار کارت بالای صفحه <b>نام ساختمان، تعداد مدیران ساختمانِ فعال، تعداد ساکنین فعال و تعداد واحدها</b> را نشان می‌دهد. در بخش «وضعیت سیستم»، اتصال <b>ربات تلگرام</b> (متصل / تنظیم‌شده ولی تأییدنشده / تنظیم‌نشده) و <b>آدرس فعلی اپ</b> را می‌بینید؛ اگر آدرس اپ را عوض کردید یا ربات قطع شد، همین‌جا اولین جای چک‌کردن است.</p>
      <p>بخش «بازدید و ورود به اپ» سه عدد خلاصه دارد: <b>بازدید امروز، بازدید ۷ روز اخیر و تعداد کاربرانِ امروز</b>. هر بار که ساکنی مینی‌اپ را باز یا وارد شود یک رویداد ثبت می‌شود؛ فهرست کامل ورود کاربران و سوییچ پیام تلگرام در تب «ورود کاربران» همین پنل است. گزارش ورود کاربران فقط برای مدیر اپ است و به مدیران ساختمان نشان داده یا ارسال نمی‌شود. توضیح هر عدد در تب مربوط به خودش آمده است.</p>`
    },
    {
      t: '۳) تب «مدیران ساختمان» — ساخت و مدیریت مدیران',
      b: `<p>این فهرست، همه کاربران با نقش «مدیر ساختمان» است. دو راه برای مدیرشدن وجود دارد: <b>راه اصلی</b> در تب «کاربران» است (دکمه «👑 مدیر کن» کنار هر کاربر) و <b>راه دوم</b> دکمه «ساخت حساب مدیر جدید» در همین تب است که یک حساب مستقل می‌سازد.</p>
      <ul class="guide-ul">
        <li><b>ویرایش:</b> نام کاربری ورود، نام، تلفن، واحدِ خود مدیر و رمز عبورش را می‌توانید عوض کنید.</li>
        <li><b>سکونت مدیر:</b> با تیک «مدیر، ساکن ساختمان نیست» در ویرایش، مدیر از فهرست بدهکاران شارژ و یادآوری‌های بات مستثنی می‌شود؛ بدون تیک، واحدش مثل بقیهٔ واحدها بدهکار و یادآوری‌گیرنده است.</li>
        <li><b>فعال/غیرفعال:</b> با غیرفعال‌کردن، ورود مدیر بلافاصله قطع می‌شود ولی داده‌هایش حفظ می‌شود؛ برای فعال‌کردن دوباره کافی است سوییچ را برگردانید.</li>
        <li><b>ریست رمز:</b> رمز جدید بدهید و آن را فقط به خودِ مدیر بگویید.</li>
        <li><b>پیام شخصی:</b> اگر حساب مدیر به تلگرام متصل باشد، با یک کلیک پیام خصوصی از طریق ربات برایش می‌فرستید.</li>
        <li><b>حذف:</b> حساب مدیر ساختمان قابل حذف است (حساب خودِ مدیر اپ حذف نمی‌شود).</li>
      </ul>`
    },
    {
      t: '۴) تب «کاربران» — ساکنین، مدیران و نشانگر اتصال تلگرام',
      b: `<p>فهرست کامل همه حساب‌های اپ. با دکمه «افزودن کاربر» برای هر واحد یک حساب ساکن می‌سازید (هر واحد فقط یک حساب ساکن می‌تواند داشته باشد) یا حساب مدیر می‌سازید. <b>نام کاربری ساکن و رمزش را بنویسید و فقط به خودش بدهید</b> — ساکن با همان نام‌کاربری/رمز وارد اپ می‌شود و فقط وضعیت واحد خودش را می‌بیند.</p>
      <p>چیپ‌های بالای فهرست، کاربران را بر اساس نقش فیلتر می‌کنند (همه / مدیر اپ / مدیر ساختمان / ساکن). کنار هر حساب <b>نشانگر اتصال تلگرام</b> با نقطه رنگی دیده می‌شود که سه حالت دارد:</p>
      <ul class="guide-ul">
        <li><b>● متصل (سبز):</b> کاربر حداقل یک بار اپ را داخل تلگرام باز کرده؛ پیام‌های ربات برایش قابل ارسال است.</li>
        <li><b>● در انتظار اتصال:</b> یوزرنیم تلگرامش ثبت شده ولی هنوز اپ را داخل تلگرام باز نکرده — به‌محض اولین بازکردن (حتی از لینک گروه) خودکار متصل می‌شود.</li>
        <li><b>● متصل نیست:</b> نه یوزرنیمی ثبت شده و نه اتصالی وجود دارد؛ اگر می‌خواهید برایش پیام بفرستید، اول یوزرنیمش را از «ویرایش» ثبت کنید.</li>
      </ul>
      <p>سایر اقدامات: «👑 مدیر کن» و «عزل از مدیریت» (تغییر نقش)، ویرایش (از جمله تغییر نام کاربری ورود)، فعال/غیرفعال، ریست رمز، پیام شخصی، <b>لینک تلگرام</b> (v2.18.0 — همان لینک دعوت یک‌بارمصرف پنل مدیر ساختمان؛ کاربر لینک را با پروفایلش باز می‌کند و با یوزر/رمز همان حساب، حساب به پروفایلش منتقل و قفل می‌شود — از v2.20.0 پروفایلِ متصل به حساب دیگر هم با همین لینک منتقل می‌شود) و حذف حساب. پس از عزل یک مدیر، او به ساکن برمی‌گردد و از تب «مدیران ساختمان» حذف می‌شود.</p>`
    },
    {
      t: '۵) تب «عملکرد مدیر ساختمان» — گزارش شفاف کارها و صندوق',
      b: `<p>از نسخه ۲.۱۳.۰ مدیر ساختمان می‌تواند کارهایی را که در طول سال انجام می‌دهد (تعمیرات، نظافت، بازدید آسانسور و…) همراه هزینهٔ هر کار در مینی‌اپ ثبت کند و مدارک (فیش، قرارداد، برگه بازدید آسانسور و…) را پیوست کند. همان گزارش تجمیعی در تب «📈 عملکرد مدیر» همین پنل هم دیده می‌شود: <b>مانده صندوق ساختمان</b> (وصول‌شده منهای هزینه‌ها)، روند ماهانه هزینه‌ها، تفکیک دسته‌بندی، فهرست کارها و هزینه‌های مشترک سال.</p>
      <p>چیپ‌های سال بالای صفحه گزارش را به هر سالی می‌برند (پیش‌فرض سال جاری) و دکمه <b>«دانلود گزارش عملکرد مدیر (PDF)»</b> خروجی کامل با نمودار را می‌دهد. این همان گزارشی است که ساکنین در تب «عملکرد مدیر» مینی‌اپ می‌بینند — یعنی شفافیت یکسان برای همه. جزئیات واحدها (چه کسی چقدر داده یا بدهکار است) طبق سیاست دسترسی در این پنل نیست.</p>`
    },
    {
      t: '۶) تب «پیام‌های ربات» — گزارش کامل پیام‌های دریافتی و ارسالی',
      b: `<p>گزارش پیام‌های ربات دو جهت دارد: ۱) <b>دریافتی</b> — هر پیامی که در <b>چت خصوصی</b> به ربات فرستاده شود (متن، فرمان مثل /start، عکس یا هر رسانه) و هر دستوری که ربات در <b>گروه</b> پاسخ می‌دهد؛ گفتگوی عادی گروه ثبت نمی‌شود. ۲) <b>ارسالی</b> (جدید) — هر پیامی که ربات خودش برای اعضا می‌فرستد: <b>یادآوری خودکار ماهانه</b> و <b>یادآوری دستی</b> مدیر ساختمان، <b>اعلان همگانی</b>، <b>پیام شخصی</b> (از پنل مدیریت یا پنل مدیر ساختمان)، <b>اعلام رسید پرداخت</b> و <b>نتیجهٔ بررسی آن</b>، <b>اعلام کار جدید</b>، <b>گزارش بازدید</b>، <b>پیام آزمایشی</b> و پاسخ‌های خودکار ربات (مثل پیام خوش‌آمدِ /start). برای پیام‌های ارسالی، ستون «فرستنده / گیرنده» نشان می‌دهد پیام به چه کسی رسیده است. نگهداری پیام‌ها <b>۱۸۰ روز</b> است. اگر طرف حساب حساب اپِ متصل‌شده‌ای داشته باشد، نقش و واحدش کنار نامش نمایش داده می‌شود.</p>
      <p><b>فیلترها (از بالا به پایین):</b></p>
      <ul class="guide-ul">
        <li><b>بازه سریع:</b> همه / امروز / دیروز / ۷ روز اخیر / ۳۰ روز اخیر.</li>
        <li><b>تقویم شمسی «از» و «تا»:</b> روی دکمه «از: —» بزنید تا تقویم باز شود؛ ماه را با فلش‌ها عوض کنید، روز را انتخاب کنید و برای بستن بازه، «تا» را هم به همین شکل بزنید. با «پاک کردن این تاریخ» فقط همان تاریخ حذف می‌شود و بیرون تقویم کلیک کنید تا بسته شود.</li>
        <li><b>جهت:</b> «همه پیام‌ها» / «دریافتی از کاربران» / «ارسالی ربات».</li>
        <li><b>عناوین:</b> چیپ «همه عناوین» یا هر عنوان مشخص (مثل «یادآوری خودکار» یا «پیام شخصی» یا «فرمان /start») با تعداد هر کدام.</li>
        <li><b>جستجو:</b> در متن پیام‌ها و نام فرستنده‌ها جستجو کنید (دکمه جستجو یا کلید Enter).</li>
        <li><b>تعداد نمایش در هر صفحه:</b> ۲۰ / ۵۰ / ۱۰۰ ردیف — برای مرور راحت، فهرست‌های طولانی را صفحه‌بندی کنید. با «نمایش بیشتر…» انتهای جدول، صفحه بعدی به همان فهرست اضافه می‌شود.</li>
      </ul>
      <p>دکمه «حذف فیلترها» همه فیلترها را یک‌جا برمی‌گرداند به حالت اول. کارت‌های آماری بالای صفحه (کل، امروز، ۷ روز، پیام‌های ارسالی ربات، فرستندگان امروز) تحت‌تأثیر فیلترها نیستند و همیشه کل را نشان می‌دهند.</p>`
    },
    {
      t: '۷) تب «ورود کاربران» — گزارش ورود و سوییچ اعلان',
      b: `<p>هر <b>باز کردن اپ</b> (ورود خودکار با نشست ذخیره‌شده) و هر <b>ورود با نام کاربری</b> (ورود با رمز) اینجا با تاریخ و ساعت شمسی ثبت می‌شود. نگهداری رکوردها <b>۹۰ روز</b> است. فیلترها مثل تب قبل کار می‌کنند: بازه سریع، تقویم شمسی «از/تا»، نوع رویداد (باز کردن اپ / ورود با نام کاربری) و تعداد نمایش در هر صفحه.</p>
      <p><b>اعلان تلگرام هنگام ورود اعضا:</b> با روشن‌بودن این سوییچ، وقتی ساکنی اپ را باز یا وارد شود، پیام کوتاهی <b>فقط برای مدیر اپِ متصل به تلگرام</b> (شما) فرستاده می‌شود — هر ساکن حداکثر هر ۱۰ دقیقه یک‌بار تا اسپم نشوید. <b>پیام ورود اعضا هرگز برای مدیران ساختمان یا خود اعضا ارسال نمی‌شود</b> و گزارشش فقط در همین تب دیده می‌شود. اگر بالای کارت هشدار «توکن ربات ثبت نشده» یا «حساب شما به تلگرام متصل نیست» دیدید، اعلان کار نمی‌کند تا آن مشکل را برطرف کنید.</p>`
    },
    {
      t: '۷‌بیس) تب «اعلان فعالیت‌ها» — چه کاری چه وقت اعلان بفرستد (v2.22.0)',
      b: `<p>این تب کنترل کامل اعلان‌های فعالیت به دست شماست: از وقتی مدیر ساختمان یا ساکن <b>وارد مینی‌اپ می‌شوند تا کارهایی که داخل اپ انجام می‌دهند</b>. چهار کارت بالای تب، آمار اعلان‌های ۲۴ ساعت اخیر، رسیده‌ها، ارسال‌نشده‌ها و کل گزارش را نشان می‌دهد.</p>
      <ul class="guide-ul">
        <li><b>اتصال تلگرام مدیرکل:</b> اگر حساب شما متصل نیست، دکمهٔ «لینک اتصال تلگرام» یک لینک یک‌بارمصرف می‌سازد؛ آن را داخل تلگرام باز کنید و نام کاربری/رمز حساب مدیرکل را وارد کنید. با دکمهٔ «ارسال اعلان آزمایشی» درستی اتصال را همان لحظه امتحان کنید.</li>
        <li><b>تیک رویدادها:</b> هر فعالیت (ورود ساکن/مدیر، ثبت پرداخت و اعتبار اضافه‌پرداخت، صدور شارژ، هزینه مشاع، واحد و حساب ساکن، رسید پرداخت، نظرسنجی، کار، یادآوری، خروجی/بکاپ/بازیابی و پیام شخصی) یک تیک دارد؛ تیک‌ها را بزنید و «ذخیرهٔ تیک‌ها» را بزنید — از همان لحظه فقط همان‌ها به تلگرام شما می‌آیند. تیک «ساکن اپ را باز کرد» همان سوییچ تب «ورود کاربران» است.</li>
        <li><b>گزارش کامل اعلان‌ها:</b> پایین تب، متن کامل هر پیام با زمان، انجام‌دهنده و وضعیت ارسال (رسید / دلیل عدم ارسال) ذخیره و قابل فیلتر است — ۱۸۰ روز نگه داشته می‌شود. ارسال نشدن به معنی گم‌شدن رویداد نیست؛ رویداد همیشه در گزارش می‌ماند.</li>
        <li><b>یادآوری دوره‌ای برای مدیر ساختمان (v2.23.0):</b> با دکمهٔ «یادآوری دوره‌ای جدید»، یادآوری‌های تکرارشونده (هر روز / هفتگی / ماهانه با روز مشخص) برای همهٔ مدیران ساختمانِ فعالِ متصل به تلگرام بسازید — مثل «تسویه صندوق ماه» یا «ارسال یادآوری بدهی‌ها». cron روزانهٔ اپ سررسیدها را می‌سنجد و پیام می‌فرستد؛ با «ارسال آزمایشی» هر مورد را فوراً امتحان کنید و هر یادآوری را خاموش/روشن، ویرایش یا حذف کنید. گزارش پیام‌های ارسالی در تب «پیام‌های ربات» ثبت می‌شود.</li>
      </ul>`
    },
    {
      t: '۸) تب «تنظیمات اپ» — ربات، ساختمان و حساب شما',
      b: `<p><b>کارت ربات تلگرام:</b> توکن را از @BotFather بگیرید و دکمه «اتصال ربات» را بزنید — وب‌هوک، دکمه منو و دستورات خودکار ثبت می‌شوند و نیازی به ترمینال نیست. بعد از اتصال، لینک «افزودن ربات به گروه»، «چت با ربات»، «کپی لینک اپ»، «ثبت وب‌هوک» (بعد از تغییر آدرس اپ) و «جایگزینی توکن» در همان کارت است. راهنمای کامل گروه در تب «راهنمای نصب» آمده است.</p>
      <p><b>اطلاعات ساختمان و پرداخت:</b> نام ساختمان، آدرس، تلفن، شماره کارت و نام صاحب کارت را ثبت کنید — این اطلاعات در <b>صورت‌حساب‌های PDF</b> (صورت‌حساب واحد و گزارش سالانه) نمایش داده می‌شود. «مبلغ پیش‌فرض شارژ ماهانه» هم پیش‌فرض صدور شارژِ مدیر ساختمان را تعیین می‌کند.</p>
      <p><b>نکته تغییر نام کاربری:</b> در ویرایش هر کاربر (و در پنل مدیر ساختمان) می‌توانید <b>نام کاربری ورود</b> را عوض کنید؛ از دفعه بعد ورود فقط با نام جدید انجام می‌شود و نام قبلی آزاد می‌گردد.</p>
      <p><b>حساب مدیر اپ:</b> رمز عبور خودتان را از همین‌جا عوض کنید. اگر رمز را فراموش کردید، راه بازیابی وجود ندارد و باید از ابزارهای نصب (تب بعد) کمک بگیرید — پس رمز قوی ولی به‌یادماندنی انتخاب کنید.</p>`
    },
    {
      t: '۹) تب «داده نمونه و نصب» — ابزارهای تست و پاک‌سازی',
      b: `<p>برای آشنایی با اپ بدون داده واقعی، «داده نمونه» یک ساختمان آزمایشی کامل (واحدها، ساکنین، شارژ، هزینه) می‌سازد تا هم اپ مدیر و هم نمای ساکن را امتحان کنید. قبل از شروع استفاده واقعی، از همان تب <b>«پاک‌سازی کامل»</b> را بزنید تا همه داده‌های نمونه حذف شوند و ساختمان خالی و آماده تحویل شود. وضعیت نصب (اتصال دیتابیس و نسخه اپ) هم در همین تب نمایش داده می‌شود.</p>`
    },
    {
      t: '۱۰) تم، خروج و استفاده با موبایل',
      b: `<p>دکمه <b>تم</b> در پایین منوی کنار (و دکمه گرد بالای صفحه ورود) بین سه حالت می‌چرخد: خودکار (متناسب با گوشی/کامپیوتر شما)، روشن و تاریک — انتخاب شما ذخیره می‌شود. دکمه <b>خروج از حساب</b> هم همان‌جاست و نشست شما را کامل می‌بندد.</p>
      <p>این پنل <b>موبایل‌فرندلی</b> است: منوی تب‌ها در موبایل به نوار افقی بالای صفحه تبدیل می‌شود و جدول‌ها قابل اسکرول افقی‌اند. اگر هنگام تایپ در فرم‌ها صفحه زوم کرد یا دکمه‌ها جابه‌جا شدند، با یک اسکرول برمی‌گردد — رفتار طبیعی مرورگر گوشی است، نه خرابی.</p>`
    },
    {
      t: '۱۱) پرسش‌های پرتکرار',
      b: `<ul class="guide-ul">
        <li><b>چرا نشانگر تلگرام کاربر «در انتظار اتصال» است؟</b> یوزرنیمش ثبت شده ولی هنوز اپ را داخل تلگرام باز نکرده. از او بخواهید یک بار از داخل تلگرام (چت ربات یا دکمه گروه) وارد اپ شود.</li>
        <li><b>چرا دکمه «ارسال پیام» برای بعضی کاربران خاموش است؟</b> ربات نمی‌تواند به کسی که اپ را داخل تلگرام باز نکرده پیام بدهد؛ بعد از اتصال، دکمه خودش فعال می‌شود.</li>
        <li><b>آیا مدیر ساختمان این پنل را می‌بیند؟</b> خیر — به هیچ شکلی. حتی گزارش ورود کاربران و پیام‌های ربات هم فقط همین‌جاست.</li>
        <li><b>اطلاعات مالی (شارژ و بدهی واحدها) کجاست؟</b> طبق سیاست دسترسی فقط در اپ مدیر ساختمان؛ در این پنل فقط گزارش تجمیعی «عملکرد مدیر» (کارها، هزینه‌ها و صندوق) بدون جزئیات واحدها دیده می‌شود.</li>
        <li><b>«نشست منقضی شده» یعنی چه؟</b> نشست شما (حداکثر ۳۰ روز) تمام شده؛ فقط دوباره وارد شوید.</li>
        <li><b>فیلترها را به‌هم ریختم!</b> در هر گزارش دکمه «حذف فیلترها» همه را برمی‌گرداند.</li>
      </ul>`
    }
  ];
  return `
    <div class="p-head"><h2>🎓 آموزش پنل مدیریت</h2><span class="p-chip">نسخه ${esc(faNum(PANEL_DOCS_VERSION))}</span></div>
    <div class="p-note">آموزش کامل استفاده از همه تب‌های همین پنل — از ساخت کاربر تا فیلتر گزارش‌ها. راهنمای گام‌به‌گام <b>نصب و استقرار</b> در تب «📘 راهنمای نصب» است.</div>
    ${parts.map(s => `
      <div class="pcard wide">
        <div class="pc-k">${esc(s.t)}</div>
        ${s.b}
      </div>`).join('')}
  `;
}

// ---------------------------------------------------------------------------
// v2.13.0 — عملکرد مدیر ساختمان (کارها، هزینه‌ها، صندوق) — view + PDF download
// ---------------------------------------------------------------------------
async function viewPerformance() {
  const curJy = localPeriod().slice(0, 4);
  if (!state.perfJy) state.perfJy = curJy;
  const perf = await api('/reports/performance?jy=' + state.perfJy);
  state._perf = perf;
  const fund = perf.fund_all || {};
  const fundY = perf.fund || {};

  const years = [];
  for (let y = Number(curJy) + 1; y >= Number(curJy) - 4; y--) years.push(String(y));

  const monthRows = (perf.months || []).map(m => `
    <tr>
      <td>${esc(periodLabel(m.period))}</td>
      <td class="num">${faNum(m.tasks || 0)}</td>
      <td class="num">${fmtNum(m.cost || 0)}</td>
      <td class="num">${fmtNum(m.expenses || 0)}</td>
      <td class="num" style="color:var(--ok)">${fmtNum(m.collected || 0)}</td>
    </tr>`).join('');
  const mTot = (perf.months || []).reduce((a, m) => ({
    tasks: a.tasks + (m.tasks || 0), cost: a.cost + (m.cost || 0),
    expenses: a.expenses + (m.expenses || 0), collected: a.collected + (m.collected || 0)
  }), { tasks: 0, cost: 0, expenses: 0, collected: 0 });

  const catRows = (perf.categories || []).map(c => `
    <tr>
      <td>${esc(c.category)}</td>
      <td class="num">${faNum(c.count)}</td>
      <td class="num">${fmtNum(c.cost)}</td>
    </tr>`).join('');

  const taskRows = (perf.tasks || []).slice(0, 60).map(t => `
    <tr>
      <td>${t.done_at ? esc(new Date(t.done_at * 1000).toLocaleDateString('fa-IR')) : '—'}</td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.category || 'سایر')}</td>
      <td class="num">${t.cost ? fmtNum(t.cost) : '—'}</td>
      <td class="num">${faNum((t.files || []).length)}</td>
    </tr>`).join('');

  const expRows = (perf.expenses || []).slice(0, 60).map(e => `
    <tr>
      <td>${esc(e.period ? periodLabel(e.period) : '—')}</td>
      <td>${esc(e.title)}</td>
      <td>${esc(e.category || '—')}</td>
      <td class="num">${fmtNum(e.amount)}</td>
    </tr>`).join('');

  return `
    <div class="p-head"><h2>📈 عملکرد مدیر ساختمان</h2></div>
    <div class="p-note">گزارش شفاف کارها و هزینه‌های مدیر ساختمان — همان چیزی که ساکنین در مینی‌اپ (تب «عملکرد مدیر») می‌بینند.</div>

    <div class="ufilter-row" style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0">
      ${years.map(y => `<button class="fchip ${y === state.perfJy ? 'on' : ''}" data-perf-year="${y}">${faNum(y)}</button>`).join('')}
    </div>

    <div class="p-cards">
      <div class="pcard"><div class="pc-k">مانده صندوق ساختمان (کل)</div><div class="pc-v ${(fund.balance || 0) >= 0 ? 'ok' : 'bad'}">${fmtMoney(fund.balance || 0)}</div></div>
      <div class="pcard"><div class="pc-k">وصول‌شده از ساکنین (کل)</div><div class="pc-v">${fmtMoney(fund.collected || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه‌های مشترک (کل)</div><div class="pc-v">${fmtMoney(fund.expenses || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه کارها (کل)</div><div class="pc-v">${fmtMoney(fund.tasks_cost || 0)}</div></div>
    </div>
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">کارهای سال ${faNum(perf.jy)}</div><div class="pc-v">${faNum((perf.totals || {}).tasks || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه کارها (سال)</div><div class="pc-v">${fmtMoney(fundY.tasks_cost || 0)}</div></div>
      <div class="pcard"><div class="pc-k">هزینه‌های مشترک (سال)</div><div class="pc-v">${fmtMoney(fundY.expenses || 0)}</div></div>
      <div class="pcard"><div class="pc-k">وصول سال ${faNum(perf.jy)}</div><div class="pc-v">${fmtMoney(fundY.collected || 0)}</div></div>
    </div>

    <div class="pcard wide" style="margin-bottom:14px">
      <div class="pc-k">روند ماهانه سال ${faNum(perf.jy)}</div>
      <div class="p-table-wrap"><table class="p-table">
        <thead><tr><th>ماه</th><th>تعداد کار</th><th>هزینه کارها (تومان)</th><th>هزینه‌های مشترک (تومان)</th><th>وصولی (تومان)</th></tr></thead>
        <tbody>${monthRows}
          <tr class="total"><td><b>جمع</b></td><td class="num"><b>${faNum(mTot.tasks)}</b></td><td class="num"><b>${fmtNum(mTot.cost)}</b></td><td class="num"><b>${fmtNum(mTot.expenses)}</b></td><td class="num"><b>${fmtNum(mTot.collected)}</b></td></tr>
        </tbody></table></div>
    </div>

    ${(perf.categories || []).length ? `
    <div class="pcard wide" style="margin-bottom:14px">
      <div class="pc-k">هزینه کارها به تفکیک دسته</div>
      <div class="p-table-wrap"><table class="p-table">
        <thead><tr><th>دسته</th><th>تعداد کار</th><th>هزینه (تومان)</th></tr></thead>
        <tbody>${catRows}</tbody></table></div>
    </div>` : ''}

    <div class="pcard wide" style="margin-bottom:14px">
      <div class="pc-k">کارهای ثبت‌شده${(perf.tasks || []).length > 60 ? ' (۶۰ مورد اخیر)' : ''}</div>
      <div class="p-table-wrap"><table class="p-table">
        <thead><tr><th>تاریخ</th><th>عنوان کار</th><th>دسته</th><th>هزینه (تومان)</th><th>مدارک</th></tr></thead>
        <tbody>${taskRows || '<tr><td colspan="5" style="color:var(--muted)">کاری ثبت نشده است</td></tr>'}</tbody></table></div>
    </div>

    ${(perf.expenses || []).length ? `
    <div class="pcard wide" style="margin-bottom:14px">
      <div class="pc-k">هزینه‌های مشترک سال ${faNum(perf.jy)} (از بخش ثبت هزینه‌ها)</div>
      <div class="p-table-wrap"><table class="p-table">
        <thead><tr><th>ماه</th><th>عنوان</th><th>دسته</th><th>مبلغ (تومان)</th></tr></thead>
        <tbody>${expRows}</tbody></table></div>
    </div>` : ''}

    <button class="btn" id="perf-pdf" style="margin-bottom:20px">${icon('download', 16)} دانلود گزارش عملکرد مدیر (PDF)</button>
  `;
}

function mountPerformance() {
  $$('[data-perf-year]').forEach(b => b.addEventListener('click', () => {
    state.perfJy = b.dataset.perfYear;
    navigate('performance');
  }));
  const btn = $('#perf-pdf');
  if (btn) btn.addEventListener('click', async () => {
    const jy = state.perfJy || localPeriod().slice(0, 4);
    try {
      btn.disabled = true;
      if (MOCK) {
        const { downloadMockPdf } = await import('./pdf-client.js');
        await downloadMockPdf('performance', { jy });
      } else if (TG_MOBILE) {
        // v2.14.1 — Telegram WebView: دانلود به مرورگر بیرونی سپرده می‌شود
        openServerDownloadPanel('/api/pdf/performance?jy=' + jy);
      } else {
        const res = await fetch('/api/pdf/performance?jy=' + jy, {
          headers: { authorization: 'Bearer ' + getToken() }
        });
        if (!res.ok) throw new Error('خطا در تولید PDF');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `performance-${jy}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }
      toast('فایل PDF آماده شد', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// 🔔 اعلان فعالیت‌ها (v2.22.0) — تیک رویدادها + اتصال تلگرام مدیرکل + گزارش کامل
// ---------------------------------------------------------------------------
async function viewNotifs() {
  const cfg = await api('/a/notifications/config');
  state._notifCfg = cfg;
  // v2.23.0 — یادآوری‌های دوره‌ای برای مدیر ساختمان (ساخت از پنل ادمین)
  const mr = await api('/a/mreminders').catch(() => ({ items: [], manager_count: 0, reachable: 0 }));
  state._mrem = mr;
  state._nq = state._nq || { event: '', sent: '' };
  const q = new URLSearchParams();
  if (state._nq.event) q.set('event', state._nq.event);
  if (state._nq.sent !== '') q.set('sent', state._nq.sent);
  q.set('limit', '50');
  const rep = await api('/a/notifications?' + q.toString());
  const st = rep.stats || {};
  const meLinked = (cfg.admins || []).some(a => a.telegram_linked);
  const warns = [
    cfg.bot_configured === false ? '<div class="p-note" style="color:var(--danger)">⚠️ توکن ربات ثبت نشده است؛ ابتدا از تب «تنظیمات اپ» ← کارت ربات، توکن را ثبت کنید.</div>' : '',
    meLinked ? '' : '<div class="p-note" style="color:var(--danger)">⚠️ حساب مدیرکل به تلگرام متصل نیست — با دکمهٔ «لینک اتصال تلگرام» وصل شوید تا اعلان‌ها برسند.</div>'
  ].filter(Boolean).join('');

  const groupLabel = g => { const x = (cfg.groups || []).find(y => y.key === g); return x ? x.label : g; };
  const byGroup = {};
  (cfg.events || []).forEach(e => { (byGroup[e.group] = byGroup[e.group] || []).push(e); });
  const checklist = Object.keys(byGroup).map(g => `
    <div class="pcard" style="padding:10px 12px;margin-bottom:8px">
      <div class="pc-k" style="font-size:12px">${esc(groupLabel(g))}</div>
      ${byGroup[g].map(e => `
      <label style="display:flex;align-items:center;gap:10px;padding:7px 2px;cursor:pointer;border-bottom:1px dashed var(--line)">
        <input type="checkbox" class="nf-ev" data-ev="${esc(e.key)}" ${e.enabled ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)">
        <span style="flex:1;font-size:13.5px">${esc(e.label)}${e.note ? ` <span class="p-muted" style="font-size:11px">— ${esc(e.note)}</span>` : ''}</span>
        <span class="p-muted" dir="ltr" style="font-size:10.5px">${esc(e.key)}</span>
      </label>`).join('')}
    </div>`).join('');

  const admins = (cfg.admins || []).map(a => `
    <div class="pcard" style="padding:10px 12px">
      <div class="pc-k">${esc(a.full_name || a.username)}</div>
      <div class="p-note" style="color:${a.telegram_linked ? 'var(--ok)' : 'var(--danger)'}">${a.telegram_linked ? '✓ به تلگرام متصل است' : 'به تلگرام متصل نیست'}</div>
    </div>`).join('');

  const eventOptions = ['<option value="">همهٔ رویدادها</option>']
    .concat((cfg.events || []).map(e => `<option value="${esc(e.key)}" ${state._nq.event === e.key ? 'selected' : ''}>${esc(e.label)}</option>`)).join('');
  const sentLabel = e => {
    if (!e.send_error) return e.sent ? '<span style="color:var(--ok)">✓ رسید</span>' : '<span style="color:var(--danger)">نرسید</span>';
    const map = { bot_not_configured: 'ربات تنظیم نیست', no_admin_telegram: 'گیرنده‌ای متصل نیست', telegram_rejected: 'تلگرام نپذیرفت' };
    return `<span style="color:var(--danger)">${esc(map[e.send_error] || e.send_error)}</span>`;
  };
  const rows = (rep.items || []).map(n => `
    <tr>
      <td style="white-space:nowrap;font-size:12px">${esc(formatJalaliDateTime(n.created_at))}</td>
      <td style="font-size:12.5px">${esc(n.title)}</td>
      <td style="font-size:12.5px;white-space:nowrap">${esc(n.actor_username || '')}${n.actor_role ? `<span class="p-muted" style="font-size:10.5px"> ${n.actor_role === 'resident' ? '(ساکن)' : n.actor_role === 'manager' ? '(مدیر)' : ''}</span>` : ''}${!n.actor_username && !n.actor_role ? '<span class="p-muted">سیستم</span>' : ''}</td>
      <td style="max-width:360px;white-space:normal;font-size:11.5px;color:var(--muted)">${esc(n.text)}</td>
      <td style="white-space:nowrap">${sentLabel(n)}</td>
    </tr>`).join('');

  return `
    <div class="p-head"><h2>🔔 اعلان فعالیت‌ها</h2>
      <button class="btn ghost" id="nf-refresh">${icon('refresh', 16)} بازخوانی</button>
    </div>
    ${warns}
    <div class="p-cards">
      <div class="pcard"><div class="pc-k">اعلان ۲۴ ساعت اخیر</div><div class="pc-v">${faNum(st.today_count || 0)}</div></div>
      <div class="pcard"><div class="pc-k">رسیده به تلگرام</div><div class="pc-v" style="color:var(--ok)">${faNum(st.sent_count || 0)}</div></div>
      <div class="pcard"><div class="pc-k">ارسال‌نشده</div><div class="pc-v" style="color:${Number(st.failed_count) > 0 ? 'var(--danger)' : 'inherit'}">${faNum(st.failed_count || 0)}</div></div>
      <div class="pcard"><div class="pc-k">کل گزارش</div><div class="pc-v">${faNum(rep.total || 0)}</div></div>
    </div>
    <div class="p-grid2">
      <div class="pcard wide">
        <div class="pc-k">اتصال تلگرام مدیرکل</div>
        <div class="p-grid2" style="margin-top:8px">${admins}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn accent" id="nf-link">${icon('link', 15)} لینک اتصال تلگرام (یک‌بارمصرف)</button>
          <button class="btn subtle" id="nf-test">${icon('bell', 15)} ارسال اعلان آزمایشی</button>
        </div>
        <div class="p-note">لینک را داخل تلگرام باز کنید و نام کاربری/رمز حساب مدیرکل را وارد کنید؛ از آن پس اعلان‌های فعال‌شده به تلگرام شما می‌آیند.</div>
      </div>
      <div class="pcard wide">
        <div class="pc-k">کدام فعالیت‌ها اعلان بفرستند؟ (تیک بزنید و ذخیره کنید)</div>
        <div style="margin-top:8px">${checklist}</div>
        <button class="btn accent" id="nf-save" style="margin-top:10px">${icon('check', 16)} ذخیرهٔ تیک‌ها</button>
      </div>
    </div>
    <div class="pcard wide" style="margin-top:12px">
      <div class="pc-k">یادآوری دوره‌ای برای مدیر ساختمان — از طریق نوتیف تلگرام برایش ارسال می‌شود</div>
      <div class="p-note">${mr.reachable > 0
        ? `${faNum(mr.reachable)} از ${faNum(mr.manager_count)} مدیر ساختمانِ فعال به تلگرام متصل است — یادآوری‌ها برای همین‌ها فرستاده می‌شود.`
        : 'هیچ مدیر ساختمانی به تلگرام متصل نیست؛ مدیر باید یک بار داخل تلگرام وارد اپ شود.'}</div>
      <div style="margin-top:10px">${(mr.items || []).map(r => `
        <div class="pcard" style="padding:10px 12px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <div style="flex:1;min-width:180px">
              <b style="font-size:13.5px">${esc(r.title)}</b>
              <div class="p-muted" style="font-size:11.5px">${esc(r.freq_label)}${r.text ? ' — ' + esc(r.text.slice(0, 60)) + (r.text.length > 60 ? '…' : '') : ''}</div>
              ${r.last_sent_at ? `<div class="p-muted" style="font-size:11px">آخرین ارسال: ${esc(formatJalaliDateTime(r.last_sent_at))}</div>` : '<div class="p-muted" style="font-size:11px">هنوز ارسال نشده</div>'}
            </div>
            <button class="btn ${r.is_active ? 'ok' : 'ghost'} sm" data-mr-tgl data-id="${r.id}" data-on="${r.is_active}">${r.is_active ? '✓ فعال' : 'خاموش'}</button>
            <button class="btn subtle sm" data-mr-send data-id="${r.id}">${icon('send', 14)} ارسال آزمایشی</button>
            <button class="btn ghost sm" data-mr-edit data-id="${r.id}">${icon('edit', 14)}</button>
            <button class="btn danger sm" data-mr-del data-id="${r.id}">${icon('trash', 14)}</button>
          </div>
        </div>`).join('') || '<div class="p-note">هنوز یادآوری دوره‌ای نساخته‌اید.</div>'}</div>
      <button class="btn accent" id="mr-add" style="margin-top:6px">${icon('plus', 16)} یادآوری دوره‌ای جدید</button>
      <div class="p-note">دوره‌ها: هر روز • هفتگی (روز هفته) • ماهانه (روز ماه شمسی). cron روزانهٔ اپ سررسیدها را می‌سنجد؛ اگر یک روز از دست برود، در اولین اجرای بعدی جبران می‌شود و هیچ یادآوری در یک دوره دوبار فرستاده نمی‌شود.</div>
    </div>
    <div class="pcard wide" style="margin-top:12px">
      <div class="pc-k">گزارش کامل اعلان‌های ارسالی — متن، انجام‌دهنده و وضعیت ارسال هر پیام ۱۸۰ روز نگهداری می‌شود</div>
      <div class="filter-row" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">
        <select id="nf-event" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)">${eventOptions}</select>
        <button class="fchip ${state._nq.sent === '0' ? 'on' : ''}" data-nfsent="0">ارسال‌نشده</button>
        <button class="fchip ${state._nq.sent === '' ? 'on' : ''}" data-nfsent="">همه</button>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>زمان</th><th>رویداد</th><th>انجام‌دهنده</th><th>متن پیام</th><th>وضعیت</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="p-muted">هنوز اعلانی ثبت نشده است</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

function mountNotifs() {
  const refresh = $('#nf-refresh');
  if (refresh) refresh.addEventListener('click', () => navigate('notifs'));
  const save = $('#nf-save');
  if (save) save.addEventListener('click', async () => {
    const events = {};
    $$('.nf-ev').forEach(cb => { events[cb.dataset.ev] = cb.checked; });
    save.disabled = true;
    try {
      await api('/a/notifications/config', { method: 'POST', body: { events } });
      toast('تیک اعلان‌ها ذخیره شد', 'ok');
      navigate('notifs');
    } catch (e) { toast(e.message, 'err'); save.disabled = false; }
  });
  const link = $('#nf-link');
  if (link) link.addEventListener('click', async () => {
    link.disabled = true;
    try {
      const r = await api('/a/notifications/link', { method: 'POST', body: {} });
      openModal({
        title: 'لینک اتصال تلگرام — یک‌بارمصرف',
        body: `<div class="p-note">این لینک را داخل تلگرام باز کنید (تا ۲۴ ساعت معتبر است) و در صفحهٔ بازشده نام کاربری/رمز حساب مدیرکل را وارد کنید:</div>
               <div class="pcard" dir="ltr" style="margin-top:8px;word-break:break-all;font-size:12px">${esc(r.url)}</div>`,
        footer: '<button class="btn accent" data-maction="ok">فهمیدم</button>',
        onMount(m) { const b = $('[data-maction="ok"]', m.el); if (b) b.addEventListener('click', () => m.close()); }
      });
    } catch (e) { toast(e.message, 'err'); }
    link.disabled = false;
  });
  const test = $('#nf-test');
  if (test) test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const r = await api('/a/notifications/test', { method: 'POST', body: {} });
      const why = { bot_not_configured: 'توکن ربات ثبت نشده است', no_admin_telegram: 'حساب شما به تلگرام متصل نیست' };
      if (r.sent) toast('اعلان آزمایشی به تلگرام شما رسید ✓', 'ok');
      else toast('ارسال نشد: ' + (why[r.send_error] || r.send_error || 'خطای نامشخص'), 'err', 5200);
      navigate('notifs');
    } catch (e) { toast(e.message, 'err'); }
    test.disabled = false;
  });
  const evSel = $('#nf-event');
  if (evSel) evSel.addEventListener('change', () => { state._nq.event = evSel.value; navigate('notifs'); });
  $$('[data-nfsent]').forEach(b => b.addEventListener('click', () => { state._nq.sent = b.dataset.nfsent; navigate('notifs'); }));

  // v2.23.0 — یادآوری دوره‌ای مدیر ساختمان
  const addBtn = $('#mr-add');
  if (addBtn) addBtn.addEventListener('click', () => openManagerReminderForm(null));
  $$('[data-mr-tgl]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api('/a/mreminders/' + b.dataset.id, { method: 'PUT', body: { is_active: b.dataset.on !== '1' } });
      toast('وضعیت یادآوری تغییر کرد', 'ok');
      navigate('notifs');
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  }));
  $$('[data-mr-send]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await api('/a/mreminders/' + b.dataset.id + '/send', { method: 'POST', body: {} });
      const why = { bot_token_missing: 'توکن ربات ثبت نشده است', no_manager_telegram: 'مدیری به تلگرام متصل نیست' };
      if (r.sent) toast(`برای ${faNum(r.sent)} مدیر ساختمان ارسال شد ✓`, 'ok');
      else toast('ارسال نشد: ' + (why[r.reason] || r.reason || 'خطای نامشخص'), 'err', 5200);
      navigate('notifs');
    } catch (e) { toast(e.message, 'err'); b.disabled = false; }
  }));
  $$('[data-mr-del]').forEach(b => b.addEventListener('click', async () => {
    const okd = await confirmDialog('این یادآوری دوره‌ای حذف شود؟');
    if (!okd) return;
    try {
      await api('/a/mreminders/' + b.dataset.id, { method: 'DELETE', body: {} });
      toast('یادآوری حذف شد', 'ok');
      navigate('notifs');
    } catch (e) { toast(e.message, 'err'); }
  }));
  $$('[data-mr-edit]').forEach(b => b.addEventListener('click', () => {
    const item = ((state._mrem || {}).items || []).find(x => Number(x.id) === Number(b.dataset.id));
    if (item) openManagerReminderForm(item);
  }));
}

// فرم ساخت/ویرایش یادآوری دوره‌ای مدیر ساختمان (v2.23.0)
function openManagerReminderForm(item) {
  const it = item || { title: '', text: '', freq: 'monthly', weekday: 6, month_day: 1, is_active: 1 };
  const weekOpts = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];
  const dayOpts = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${Number(it.month_day || 1) === i + 1 ? 'selected' : ''}>روز ${faNum(i + 1)}</option>`).join('');
  openModal({
    title: item ? 'ویرایش یادآوری دوره‌ای' : 'یادآوری دوره‌ای جدید برای مدیر ساختمان',
    body: `
      <div class="form-grid">
        <div class="field"><label>عنوان *</label><input id="mre-title" value="${esc(it.title)}" placeholder="مثلاً: تسویه صندوق ماه"></div>
        <div class="field"><label>متن (اختیاری)</label><textarea id="mre-text" rows="3">${esc(it.text || '')}</textarea></div>
        <div class="field"><label>دوره</label>
          <select id="mre-freq">
            <option value="monthly" ${it.freq === 'monthly' ? 'selected' : ''}>ماهانه</option>
            <option value="weekly" ${it.freq === 'weekly' ? 'selected' : ''}>هفتگی</option>
            <option value="daily" ${it.freq === 'daily' ? 'selected' : ''}>هر روز</option>
          </select></div>
        <div class="field" id="mre-week-wrap" style="display:none"><label>روز هفته</label>
          <select id="mre-week">${weekOpts.map((w, i) => `<option value="${i}" ${Number(it.weekday) === i ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
        <div class="field" id="mre-day-wrap" style="display:none"><label>روز ماه (شمسی — ۱ تا ۲۸)</label>
          <select id="mre-day">${dayOpts}</select>
          <div class="hint">از این روز به بعدِ هر ماه، در اولین اجرای cron یادآوری می‌رود.</div></div>
      </div>`,
    footer: `
      <button class="btn subtle" data-maction="cancel">انصراف</button>
      <button class="btn accent" data-maction="save">${icon('check', 16)} ${item ? 'ذخیرهٔ تغییرات' : 'ساخت یادآوری'}</button>`,
    onMount(m) {
      const freqSel = $('#mre-freq', m.el);
      const sync = () => {
        $('#mre-week-wrap', m.el).style.display = freqSel.value === 'weekly' ? '' : 'none';
        $('#mre-day-wrap', m.el).style.display = freqSel.value === 'monthly' ? '' : 'none';
      };
      freqSel.addEventListener('change', sync);
      sync();
      $$('[data-maction]', m.el).forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.maction;
        if (act === 'cancel') { m.close(); return; }
        if (act === 'save') {
          b.disabled = true;
          const body = {
            title: $('#mre-title', m.el).value.trim(),
            text: $('#mre-text', m.el).value.trim(),
            freq: freqSel.value,
            weekday: Number($('#mre-week', m.el).value),
            month_day: Number($('#mre-day', m.el).value)
          };
          if (!body.title) { toast('عنوان را وارد کنید', 'err'); b.disabled = false; return; }
          try {
            if (item) await api('/a/mreminders/' + item.id, { method: 'PUT', body });
            else await api('/a/mreminders', { method: 'POST', body });
            toast('یادآوری دوره‌ای ذخیره شد', 'ok');
            m.close();
            navigate('notifs');
          } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        }
      }));
    }
  });
}

// ---------------------------------------------------------------------------
const VIEWS = { overview: viewOverview, managers: viewManagers, users: viewUsers, botmsgs: viewBotMsgs, visits: viewVisits, notifs: viewNotifs, settings: viewSettings, tools: viewTools, guide: viewGuide, tutorial: viewTutorial, performance: viewPerformance };
const MOUNT2 = { notifs: mountNotifs };
const MOUNT = { settings: mountSettings, tools: mountTools, botmsgs: mountBotMsgs, visits: mountVisits, performance: mountPerformance, notifs: mountNotifs };

$('#pview').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  const fn = state._view === 'managers' ? managerAction : userAction;
  fn(act, Number(id));
});
document.addEventListener('click', e => {
  const uf = e.target.closest('[data-ufilter]');
  if (uf) { state._userFilter = uf.dataset.ufilter; navigate('users'); }
});
document.addEventListener('click', e => {
  if (e.target.closest('#mgr-add')) openManagerForm();
  if (e.target.closest('#user-add')) openUserForm();
});

// ---------------------------------------------------------------------------
// Theme toggle (auto → light → dark) — available on the gate screen (fab)
// and inside the panel (sidebar). Persisted across both pages.
// ---------------------------------------------------------------------------
function themeBtnLabel(t) {
  return `${icon(themeIcon(t), 16)} تم: ${THEME_LABEL[t]}`;
}
const gateThemeBtn = $('#gate-theme');
if (gateThemeBtn) {
  gateThemeBtn.innerHTML = icon(themeIcon(getTheme()));
  gateThemeBtn.addEventListener('click', () => {
    const t = cycleTheme();
    gateThemeBtn.innerHTML = icon(themeIcon(t));
    if (sideThemeBtn) sideThemeBtn.innerHTML = themeBtnLabel(t);
    toast('تم: ' + THEME_LABEL[t], 'info', 1600);
  });
}
const sideThemeBtn = $('#side-theme');
if (sideThemeBtn) {
  sideThemeBtn.innerHTML = themeBtnLabel(getTheme());
  sideThemeBtn.addEventListener('click', () => {
    const t = cycleTheme();
    sideThemeBtn.innerHTML = themeBtnLabel(t);
    if (gateThemeBtn) gateThemeBtn.innerHTML = icon(themeIcon(t));
    toast('تم: ' + THEME_LABEL[t], 'info', 1600);
  });
}

boot();
