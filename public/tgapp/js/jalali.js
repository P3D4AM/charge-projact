// Jalali (Solar Hijri) calendar utilities — shared by Cloudflare Worker and browser (ESM).
// Algorithm based on the well-known jalaali-js implementation (MIT license).

function div(a, b) { return ~~(a / b); }
function mod(a, b) { return a - ~~(a / b) * b; }

const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

export function jalCal(jy) {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jm, jump = 0, leap, n, i;

  if (jy < jp || jy >= BREAKS[bl - 1]) throw new Error('Invalid Jalaali year ' + jy);

  for (i = 1; i < bl; i += 1) {
    jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

function g2d(gy, gm, gd) {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4)
        + div(153 * mod(gm + 9, 12) + 2, 5)
        + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn) {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

export function j2d(jy, jm, jd) {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

export function d2j(jdn) {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

export function toJalaali(date) {
  return d2j(g2d(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

export function toGregorian(jy, jm, jd) {
  return d2g(j2d(jy, jm, jd));
}

export function isLeapJalaali(jy) {
  return jalCal(jy).leap === 0;
}

export function jalaaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalaali(jy) ? 30 : 29;
}

export const J_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];

export const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function faNum(v) {
  return String(v).replace(/[0-9]/g, d => FA_DIGITS[+d]);
}

// Today in Tehran timezone as Gregorian {gy, gm, gd}
export function tehranToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => Number((parts.find(x => x.type === t) || {}).value || 0);
  return { gy: get('year'), gm: get('month'), gd: get('day') };
}

// Jalali {jy, jm, jd} for given Gregorian Y/M/D parts
export function toJalaaliFromParts(gy, gm, gd) {
  return d2j(g2d(gy, gm, gd));
}

// Current Jalali period "YYYY-MM" (Tehran timezone) — for the Worker
export function currentPeriod() {
  const t = tehranToday();
  const j = toJalaaliFromParts(t.gy, t.gm, t.gd);
  return `${j.jy}-${String(j.jm).padStart(2, '0')}`;
}

// Current Jalali period based on device-local date — for the browser
export function localPeriod() {
  const now = new Date();
  const j = toJalaaliFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return `${j.jy}-${String(j.jm).padStart(2, '0')}`;
}

export function todayLocalJalaali() {
  const now = new Date();
  return toJalaaliFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function isPeriod(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

export function isJalaliYear(s) {
  return typeof s === 'string' && /^\d{4}$/.test(s);
}

export function periodLabel(period) {
  if (!isPeriod(period)) return period || '';
  const [y, m] = period.split('-').map(Number);
  return `${J_MONTHS[m - 1]} ${faNum(y)}`;
}

export function addPeriods(period, delta) {
  let [y, m] = period.split('-').map(Number);
  m += delta;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Tehran date/time helpers (v2.8) — shared by Worker messages (گزارش ورود)
// and the frontend visit list so both render exactly the same string.
// ---------------------------------------------------------------------------
export const FA_WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

/** Gregorian date parts + HH + MM in Asia/Tehran for the given epoch ms. */
export function tehranParts(epochMs = Date.now()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(Number(epochMs)));
  const g = t => Number((p.find(x => x.type === t) || {}).value || 0);
  return { gy: g('year'), gm: g('month'), gd: g('day'), hh: g('hour'), mm: g('minute') };
}

/** «شنبه ۷ مهر ۱۴۰۵ • ساعت ۱۴:۳۲» — opts.time === false → تاریخ بدون ساعت */
export function formatJalaliDateTime(epochMs, opts = {}) {
  const { gy, gm, gd, hh, mm } = tehranParts(epochMs);
  const j = toJalaaliFromParts(gy, gm, gd);
  const wd = FA_WEEKDAYS[new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay()];
  const date = `${wd} ${faNum(j.jd)} ${J_MONTHS[j.jm - 1]} ${faNum(j.jy)}`;
  if (opts.time === false) return date;
  return `${date} • ساعت ${faNum(String(hh).padStart(2, '0'))}:${faNum(String(mm).padStart(2, '0'))}`;
}

/** Epoch seconds of 00:00 today in Tehran (Iran = UTC+3:30 fixed, no DST). */
export function tehranDayStartSec(nowSec = Math.floor(Date.now() / 1000)) {
  const { gy, gm, gd } = tehranParts(Number(nowSec) * 1000);
  return Math.floor(Date.UTC(gy, gm - 1, gd) / 1000) - 12600;
}
