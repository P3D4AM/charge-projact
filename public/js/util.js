// Shared frontend utilities: formatting, Jalali helpers re-export, icons, UI components.
import {
  faNum, J_MONTHS, periodLabel, addPeriods, isPeriod, localPeriod,
  todayLocalJalaali, jalaaliMonthLength, isLeapJalaali, toJalaali, toGregorian,
  formatJalaliDateTime, tehranDayStartSec, tehranParts, toJalaaliFromParts
} from './jalali.js';

export {
  faNum, J_MONTHS, periodLabel, addPeriods, isPeriod, localPeriod,
  todayLocalJalaali, jalaaliMonthLength, isLeapJalaali, toJalaali, toGregorian,
  formatJalaliDateTime, tehranDayStartSec, tehranParts, toJalaaliFromParts
} from './jalali.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function enNum(v) {
  return String(v ?? '')
    .replace(/[۰-۹]/g, d => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
export function parseNum(v) {
  const n = Number(enNum(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
export function fmtNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}
export function fmtMoney(n) {
  return fmtNum(Math.round(n || 0)) + ' تومان';
}
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Splits `total` equally among `n` units; the rounding remainder goes to the first units.
export function splitEqual(total, n) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}
export function shortMonth(m) {
  return J_MONTHS[m - 1].slice(0, 3);
}

// Unit numbers are sometimes stored with the word «واحد» typed into the field
// (e.g. «واحد 2») which made labels render as «مانده بدهی واحد واحد 2».
// unitNo() strips that prefix for display; unitWord() renders «واحد ۲».
export function unitNo(n) {
  // v2.15.0 — امنیت: شماره واحد در عنوان‌ها/برچسب‌ها رندر می‌شود؛ نویسه‌های
  // HTML از منبع حذف می‌شوند تا هیچ مسیری برای تزریق باز نماند.
  return String(n ?? '').replace(/[<>&"']/g, '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim() || String(n ?? '').replace(/[<>&"']/g, '').trim();
}
export function unitWord(n) {
  return 'واحد ' + faNum(unitNo(n));
}

// ---------------------------------------------------------------------------
// SVG icons (stroke-based, 24x24 viewBox)
// ---------------------------------------------------------------------------
const P = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a1.5 1.5 0 0 1-1.5 1.5H14v-6h-4v6H4.5A1.5 1.5 0 0 1 3 20Z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  card: '<rect x="1.5" y="4.5" width="21" height="15" rx="2.5"/><path d="M1.5 10h21"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  chart: '<path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  chevl: '<path d="m15 18-6-6 6-6"/>',
  chevr: '<path d="m9 18 6-6-6-6"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  send: '<path d="m22 2-11 11"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  msg: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  building: '<rect x="4" y="2" width="12" height="20" rx="1.5"/><path d="M16 8h3a1.5 1.5 0 0 1 1.5 1.5V22"/><path d="M8 6h4"/><path d="M8 10h4"/><path d="M8 14h4"/><path d="M9.5 22v-3.5h1V22"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  poll: '<rect x="3" y="3" width="18" height="18" rx="2.2"/><path d="M8 16.5v-5"/><path d="M12 16.5v-9"/><path d="M16 16.5v-3"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64L3 13"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  sun: '<circle cx="12" cy="12" r="4.4"/><path d="M12 2v2.3"/><path d="M12 19.7V22"/><path d="m4.9 4.9 1.6 1.6"/><path d="m17.5 17.5 1.6 1.6"/><path d="M2 12h2.3"/><path d="M19.7 12H22"/><path d="m4.9 19.1 1.6-1.6"/><path d="m17.5 6.5 1.6-1.6"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  clipboard: '<rect x="5" y="4" width="14" height="18" rx="2"/><path d="M9 2.5h6V6H9z"/><path d="M9 11h6"/><path d="M9 15h6"/><path d="M9 19h3"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'
};

export function icon(name, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.info}</svg>`;
}

// ---------------------------------------------------------------------------
// Theme (auto / light / dark) — shared by the mini app and the app-admin panel.
// The active mode is stored in localStorage and reflected on <html data-theme>.
// ---------------------------------------------------------------------------
const THEME_KEY = 'bc_theme';
export const THEME_ORDER = ['auto', 'light', 'dark'];
export const THEME_LABEL = { auto: 'خودکار (سیستم)', light: 'روشن', dark: 'تاریک' };

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

export function setTheme(t) {
  try {
    if (t === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch { /* ignore */ }
  document.documentElement.dataset.theme = t;
}

export function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(getTheme()) + 1) % THEME_ORDER.length];
  setTheme(next);
  return next;
}

export function themeIcon(t) {
  return t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'contrast';
}

// ---------------------------------------------------------------------------
// Haptics
// ---------------------------------------------------------------------------
export function haptic(kind = 'light') {
  try {
    const H = window.Telegram?.WebApp?.HapticFeedback;
    if (!H) return;
    if (['light', 'medium', 'heavy', 'rigid', 'soft'].includes(kind)) H.impactOccurred(kind);
    else H.notificationOccurred(kind);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
export function toast(msg, type = 'ok', ms = 2600) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info') + `<span>${esc(msg)}</span>`;
  el.querySelector('span').style.whiteSpace = 'pre-line';
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------------------
// Modal manager (bottom sheets)
// ---------------------------------------------------------------------------
const modalStack = [];
let backBound = false;

function updateBackButton() {
  const TG = window.Telegram?.WebApp;
  if (!TG?.BackButton) return;
  if (modalStack.length > 0) {
    if (!backBound) {
      TG.BackButton.onClick(() => {
        const top = modalStack[modalStack.length - 1];
        if (top) top.close();
      });
      backBound = true;
    }
    TG.BackButton.show();
  } else {
    TG.BackButton.hide();
  }
}

export function openModal({ title, body, footer = '', onMount, wide = false }) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="sheet${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head">
        <h3>${esc(title)}</h3>
        <button class="icon-btn sheet-x" aria-label="بستن">${icon('x')}</button>
      </div>
      <div class="sheet-body">${body}</div>
      ${footer ? `<div class="sheet-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const m = { el: wrap, closed: false };
  m.close = () => {
    if (m.closed) return;
    m.closed = true;
    wrap.classList.remove('open');
    const idx = modalStack.indexOf(m);
    if (idx >= 0) modalStack.splice(idx, 1);
    updateBackButton();
    setTimeout(() => wrap.remove(), 260);
  };
  wrap.querySelector('.modal-backdrop').addEventListener('click', m.close);
  wrap.querySelector('.sheet-x').addEventListener('click', m.close);
  modalStack.push(m);
  updateBackButton();
  if (onMount) onMount(m);
  return m;
}

export function confirmDialog(message) {
  const TG = window.Telegram?.WebApp;
  const inApp = () => new Promise(resolve => {
    const m = openModal({
      title: 'تأیید',
      body: `<p style="font-size:14px;white-space:pre-line">${esc(message)}</p>`,
      footer: `<button class="btn subtle" data-r="0">انصراف</button><button class="btn danger" data-r="1">تأیید</button>`,
      onMount(mm) {
        mm.el.querySelectorAll('[data-r]').forEach(b => {
          b.addEventListener('click', () => { resolve(b.dataset.r === '1'); mm.close(); });
        });
      }
    });
    m.el.querySelector('.modal-backdrop').addEventListener('click', () => resolve(false));
  });
  // Native confirm only when the client really supports it (Bot API 6.2+).
  // On older clients showConfirm throws / never calls back — the button then
  // appears dead. Version check + fallback keeps the flow working everywhere.
  if (TG?.showConfirm) {
    let supported = false;
    try {
      supported = TG.isVersionAtLeast ? TG.isVersionAtLeast('6.2') : false;
    } catch { supported = false; }
    if (supported) {
      return new Promise(resolve => {
        try {
          TG.showConfirm(message, ok => resolve(Boolean(ok)));
        } catch {
          return inApp();
        }
      });
    }
  }
  return inApp();
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------
export function moneyField({ id, value = '', label = 'مبلغ', required = true }) {
  return `
    <div class="field">
      <label for="${id}">${esc(label)}${required ? ' *' : ''}</label>
      <div class="amount-input">
        <input id="${id}" inputmode="numeric" autocomplete="off" data-money value="${esc(value)}" placeholder="0">
        <span class="unit">تومان</span>
      </div>
    </div>`;
}

export function bindMoneyInputs(root) {
  $$('input[data-money]', root).forEach(inp => {
    const fmt = () => {
      const n = parseNum(inp.value);
      inp.value = n ? n.toLocaleString('en-US') : '';
    };
    inp.addEventListener('input', () => {
      const pos = inp.value.length;
      fmt();
      // keep caret near end; simple approach for RTL numeric fields
      if (Math.abs(inp.value.length - pos) > 2) inp.setSelectionRange(inp.value.length, inp.value.length);
    });
    fmt();
  });
}

// Jalali date selects (day / month / year)
// v2.12.0: when a prefill `value` is given (e.g. editing an old payment), its
// year is merged into the options so the saved date can never silently fall
// back to a different year on save.
export function jalaaliDateFields({ prefix, value = null }) {
  const today = todayLocalJalaali();
  const y = value ? Number(value.jy) : today.jy;
  const m = value ? Number(value.jm) : today.jm;
  const d = value ? Number(value.jd) : today.jd;
  const base = [today.jy + 1, today.jy, today.jy - 1, today.jy - 2, today.jy - 3, today.jy - 4];
  const around = value ? [y + 1, y, y - 1, y - 2, y - 3, y - 4] : [];
  const years = [...new Set([...base, ...around])].sort((a, b) => b - a);
  const opts = (arr, sel, labels) => arr.map((v, i) =>
    `<option value="${v}"${Number(v) === sel ? ' selected' : ''}>${labels ? labels[i] : faNum(v)}</option>`).join('');
  bindJalaaliLabels();
  return `
    <div class="field-row-3">
      <select id="${prefix}-d">${opts(Array.from({ length: 31 }, (_, i) => i + 1), d)}</select>
      <select id="${prefix}-m">${opts(Array.from({ length: 12 }, (_, i) => i + 1), m, J_MONTHS)}</select>
      <select id="${prefix}-y">${opts(years, y)}</select>
    </div>
    <div class="hint" id="${prefix}-lbl" style="margin-top:6px">${faNum(y)} ${J_MONTHS[m - 1] || ''} ${faNum(d)}</div>`;
}

// v2.14.2 — برچسب زندهٔ تاریخ: بعد از بستن دراپ‌داون، تاریخ انتخابی به‌صورت
// خوانا زیر سه دropdown نمایش داده می‌شود (در موبایل نمایش حالت بستهٔ select
// قابل‌اعتماد نیست). یک‌بار در سطح document نصب می‌شود (delegation).
let jdBound = false;
function bindJalaaliLabels() {
  if (jdBound) return;
  jdBound = true;
  document.addEventListener('change', e => {
    const s = e.target;
    if (!s || !s.matches || !s.matches('select') || !/-[dmy]$/.test(String(s.id || ''))) return;
    const prefix = String(s.id).replace(/-[dmy]$/, '');
    const lbl = document.getElementById(prefix + '-lbl');
    if (!lbl) return;
    const d = document.getElementById(prefix + '-d');
    const m = document.getElementById(prefix + '-m');
    const y = document.getElementById(prefix + '-y');
    if (!d || !m || !y) return;
    lbl.textContent = faNum(Number(y.value)) + ' ' + (J_MONTHS[Number(m.value) - 1] || '') + ' ' + faNum(Number(d.value));
  });
}
export function readJalaaliDate(prefix) {
  // fix v2.13.0: «?.value» باید داخل Number() و روی خود عنصر بیاید؛ در نسخهٔ
  // قبلی به‌اشتباه روی خروجی Number() اعمال می‌شد و همیشه به ۱۴۰۴/۰۱/۰۱ سقوط می‌کرد.
  const d = Number($(('#' + prefix + '-d'))?.value) || 1;
  const m = Number($(('#' + prefix + '-m'))?.value) || 1;
  const y = Number($(('#' + prefix + '-y'))?.value) || 1404;
  const greg = toGregorian(y, m, Math.min(d, 31));
  return Math.floor(new Date(greg.gy, greg.gm - 1, greg.gd).getTime() / 1000);
}

// Period stepper component
export function stepperHTML({ id, period, todayBtn = true }) {
  return `
    <div class="stepper" id="${id}">
      <button class="st-btn" data-dir="1" aria-label="ماه بعد">${icon('chevr')}</button>
      <div class="p-label"><span>${periodLabel(period)}</span><small>${faNum(period)}</small></div>
      <button class="st-btn" data-dir="-1" aria-label="ماه قبل">${icon('chevl')}</button>
      ${todayBtn ? '<button class="st-btn today">ماه جاری</button>' : ''}
    </div>`;
}
export function bindStepper(id, onChange) {
  const el = document.getElementById(id);
  if (!el) return;
  $$('[data-dir]', el).forEach(b => b.addEventListener('click', () => onChange(Number(b.dataset.dir))));
  const t = $('.st-btn.today', el);
  if (t) t.addEventListener('click', () => onChange(0));
}

export function statusChip(status) {
  const map = {
    paid: ['paid', 'تسویه‌شده', 'check'],
    partial: ['partial', 'پرداخت جزئی', 'wallet'],
    unpaid: ['unpaid', 'پرداخت‌نشده', 'alert']
  };
  const [cls, label, ic] = map[status] || map.unpaid;
  return `<span class="chip ${cls}">${icon(ic, 11)}${label}</span>`;
}

export function kindChip(kind) {
  const map = { monthly: 'شارژ ماهانه', expense: 'سهم هزینه', custom: 'مورد دستی' };
  return `<span class="chip neutral">${esc(map[kind] || kind)}</span>`;
}

export function emptyState({ ic = 'info', text, btnLabel = '', btnId = '', btnAction = '' }) {
  return `
    <div class="empty">
      ${icon(ic, 44)}
      <p>${esc(text)}</p>
      ${btnLabel ? `<button class="btn ghost" id="${btnId}"${btnAction ? ` data-action="${btnAction}"` : ''}>${icon('plus', 16)}${esc(btnLabel)}</button>` : ''}
    </div>`;
}
