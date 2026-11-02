// Shared API helpers.
export const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
export const APP_VERSION = '2.21.0';

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}
export function fail(message, status = 400, code = 'error') {
  return json({ error: message, code }, status);
}

export async function readBody(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return {};
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function now() { return Math.floor(Date.now() / 1000); }

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const map = {};
  for (const row of results || []) map[row.key] = row.value;
  return map;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, String(value)).run();
}

export function publicSettings(s) {
  return {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    phone: s.phone || '',
    bank_card: s.bank_card || '',
    bank_owner: s.bank_owner || '',
    default_monthly_amount: Number(s.default_monthly_amount || 0)
  };
}

// ---------------------------------------------------------------------------
// money splitting
// ---------------------------------------------------------------------------
export function splitEqual(total, n) {
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

export function splitByArea(total, units) {
  const totalArea = units.reduce((s, u) => s + (Number(u.area_m2) || 0), 0);
  if (totalArea <= 0) return null;
  const shares = units.map(u => Math.round(total * (Number(u.area_m2) || 0) / totalArea));
  const diff = total - shares.reduce((a, b) => a + b, 0);
  if (diff !== 0) {
    let idx = 0;
    for (let i = 1; i < units.length; i++) {
      if ((Number(units[i].area_m2) || 0) > (Number(units[idx].area_m2) || 0)) idx = i;
    }
    shares[idx] += diff;
  }
  return shares;
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
function csvCell(v) {
  let s = String(v ?? '');
  // v2.15.0 — ضد تزریق فرمول اکسل (CSV injection): سلولی که با = ، + ، @ یا tab/CR
  // شروع شود در اکسل به‌عنوان فرمول/دستور اجرا می‌شود → با اپاستروف خنثی می‌شود.
  // اعداد منفی (مثل ‎-500) دست‌نخورده می‌مانند تا ستون‌های عددی سالم بمانند.
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// v2.14.0 — Excel-friendly export: an HTML <table> saved as .xls opens in
// Excel/LibreOffice with correct columns and UTF-8 on every locale
// (comma-CSV mis-splits when the OS list-separator is not «,»).
export function xlsResponse(filename, rows) {
  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tr = r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>';
  const body = '<html><head><meta charset="utf-8"></head><body>' +
    '<table dir="rtl" border="1" cellspacing="0" cellpadding="4">' +
    rows.map(tr).join('') + '</table></body></html>';
  return new Response(body, {
    headers: {
      'content-type': 'application/vnd.ms-excel; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // v2.15.0 — امنیت: مرورگر مجاز به حدس زدن MIME نیست (فایل دانلودی است)
      'x-content-type-options': 'nosniff'
    }
  });
}

export function csvResponse(filename, rows) {
  const body = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff'
    }
  });
}

// ---------------------------------------------------------------------------
// db helpers
// ---------------------------------------------------------------------------
export async function getAllUnits(env) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM units ORDER BY LENGTH(number), number'
  ).all();
  return results || [];
}

export async function countAdmins(env) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1"
  ).first();
  return row ? row.c : 0;
}

// username validation: 3..32 chars, latin letters/digits/underscore/dot
export function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_.]{3,32}$/.test(u);
}
export function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 72;
}

// ---------------------------------------------------------------------------
// Telegram username (یوزرنیم تلگرام) — stored WITHOUT the leading «@» so it
// stays comparable with the username Telegram reports in initData/webhooks.
// Accepts «@user», "user" and full links like https://t.me/user.
// ---------------------------------------------------------------------------
export function normalizeTelegramUsername(v) {
  let s = String(v ?? '').trim();
  s = s.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '');
  s = s.replace(/^@+/, '').trim();
  return s.slice(0, 32);
}
// Telegram usernames: 5..32 latin letters/digits/underscore, start with a letter
// (we accept 4+ to be tolerant with legacy short names); empty = not set.
export function validTelegramUsername(s) {
  return s === '' || (typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s));
}
