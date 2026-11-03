// Authentication: PBKDF2 password hashing + HMAC-signed session tokens +
// Telegram initData validation and account linking. Cloudflare Workers compatible.
import { validateInitData, getBotToken } from './telegram.js';

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const ROLES = ['admin', 'manager', 'resident'];

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function unb64(s) {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'PBKDF2', hash: 'SHA-256' }, false, ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key, 256
  );
}

/** Returns "pbkdf2$<iter>$<salt-b64>$<hash-b64>" */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(String(password), salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = Number(iterStr) || PBKDF2_ITERATIONS;
    const hash = await pbkdf2(String(password), unb64(saltB64), iterations);
    // constant-time-ish comparison
    const a = b64(hash), b = hashB64;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// sessions (stateless HMAC-signed tokens)
// ---------------------------------------------------------------------------
function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return unb64(s);
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(msg));
}

async function sessionSecret(env) {
  if (env.SESSION_SECRET) return String(env.SESSION_SECRET);
  // fall back to a per-installation secret stored in settings (created at install)
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
  if (row && row.value) return row.value;
  const secret = b64(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('session_secret', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(secret).run();
  return secret;
}

/** Creates a signed session token for a user id (ep = token epoch).
 *  v2.15.0 — tgId: وقتی توکن درون تلگرام صادر شده، شناسهٔ پروفایل تلگرام داخل
 *  امضا می‌شود تا نشستِ یک پروفایل روی پروفایل دیگرِ همان دستگاه usable نباشد. */
export async function createSessionToken(env, userId, role, epoch = 0, tgId = 0) {
  const secret = await sessionSecret(env);
  const payload = {
    uid: userId, role, ep: Number(epoch) || 0,
    tg: Number(tgId) || 0,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// v2.14.0 — token epoch (خروج اجباری از همه دستگاه‌ها)
// Bumped on password change/reset; every older session token dies instantly.
// ---------------------------------------------------------------------------
export async function bumpTokenEpoch(env, userId) {
  if (!userId) return;
  await env.DB.prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?')
    .bind(userId).run();
}

export async function verifySessionToken(env, token) {
  try {
    const [body, sigB64] = String(token || '').split('.');
    if (!body || !sigB64) return null;
    const secret = await sessionSecret(env);
    const expected = await hmac(secret, body);
    // v2.14.0 — constant-time signature comparison (length + byte diff)
    const a = b64url(new Uint8Array(expected));
    if (a.length !== sigB64.length) return null;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ sigB64.charCodeAt(i);
    if (diff !== 0) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.uid || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// request context
// ---------------------------------------------------------------------------
async function findActiveUser(env, id) {
  if (!id) return null;
  return env.DB.prepare(
    'SELECT * FROM users WHERE id = ? AND is_active = 1 LIMIT 1'
  ).bind(id).first() || null;
}

/**
 * Resolves the authenticated user for a request.
 * Priority: Bearer session token > Telegram initData (linked account).
 * Returns { user, unit, via } or null.
 */
export async function buildAuthContext(request, env) {
  // 1) session token
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearer || request.headers.get('x-session-token') || '';
  if (token) {
    const payload = await verifySessionToken(env, token);
    if (payload) {
      // v2.15.0 — قفل نشست به پروفایل تلگرام: اگر توکن برای پروفایل دیگری صادر
      // شده باشد و درخواست از داخل تلگرامِ پروفایل دیگری بیاید (initData معتبرِ
      // شناسهٔ متفاوت)، توکن رد می‌شود → کلاینت کاربر را به صفحهٔ ورود می‌برد.
      // این همان «باز کردن پنل دیگران با یک تلگرام روی پروفایل‌های مختلف» است.
      if (payload.tg) {
        const initData = request.headers.get('x-telegram-init-data') || '';
        const botToken0 = await getBotToken(env);
        if (initData && botToken0) {
          const maxAge0 = Number(env.INITDATA_MAX_AGE || 86400);
          const tgNow = await validateInitData(initData, botToken0, maxAge0);
          if (tgNow && tgNow.id && Number(tgNow.id) !== Number(payload.tg)) return null;
        }
      }
      const user = await findActiveUser(env, payload.uid);
      // v2.14.0 — epoch check: a token issued before the latest password
      // change/reset is rejected (payload without ep = very old token → reject
      // only when an epoch was ever bumped, so pre-v2.14 tokens keep working
      // until the next password change)
      if (user && Number(user.token_epoch || 0) > 0 && Number(payload.ep || 0) !== Number(user.token_epoch)) {
        return null;
      }
      // v2.17.0 — حسابِ قفل‌شده به پروفایل لینک دعوت: توکنِ بی‌مته یا initDataِ
      // پروفایل دیگر از داخل تلگرام پذیرفته نمی‌شود؛ فقط پروفایلِ قفل‌شده وارد می‌شود.
      if (user) {
        const bound = Number(user.bound_tg_id || 0);
        if (bound) {
          if (payload.tg && Number(payload.tg) !== bound) return null;
          const initData2 = request.headers.get('x-telegram-init-data') || '';
          if (initData2) {
            const botToken2 = await getBotToken(env);
            if (botToken2) {
              const maxAge2 = Number(env.INITDATA_MAX_AGE || 86400);
              const tgNow2 = await validateInitData(initData2, botToken2, maxAge2);
              if (tgNow2 && tgNow2.id && Number(tgNow2.id) !== bound) return null;
            }
          }
        }
      }
      if (user) return { user, unit: user.unit_id ? await loadUnit(env, user.unit_id) : null, via: 'session' };
    }
  }

  // 2) Telegram initData (Mini App opened inside Telegram)
  const initData = request.headers.get('x-telegram-init-data') || '';
  const botToken = await getBotToken(env);
  if (initData && botToken) {
    const maxAge = Number(env.INITDATA_MAX_AGE || 86400);
    const tgUser = await validateInitData(initData, botToken, maxAge);
    if (tgUser && tgUser.id) {
      // v2.24.0 — یک پروفایل تلگرام می‌تواند به چند حساب متصل باشد (اتصال موازی)؛
      // ورود مینی‌اپ باید قطعی باشد: اول مدیر ساختمان، بعد ساکن، در آخر مدیر اپ
      // (اپِ مدیر اپ پنل وب است). قبلاً LIMIT 1 بدون ترتیب، بستگی به ترتیب اتصال داشت.
      const row = await env.DB.prepare(`
        SELECT * FROM users WHERE telegram_user_id = ? AND is_active = 1
        ORDER BY CASE role WHEN 'manager' THEN 0 WHEN 'resident' THEN 1 ELSE 2 END, id
        LIMIT 1
      `).bind(tgUser.id).first();
      if (row) {
        // v2.17.0 — حساب قفل‌شده فقط با پروفایل خودش از initData وارد می‌شود
        if (Number(row.bound_tg_id || 0) && Number(row.bound_tg_id) !== Number(tgUser.id)) return null;
        return {
          user: row,
          unit: row.unit_id ? await loadUnit(env, row.unit_id) : null,
          via: 'telegram',
          tgUser
        };
      }
      // Auto-link by username: the manager pre-filled «یوزرنیم تلگرام» in the
      // profile; the first time that person opens the app inside Telegram the
      // account binds to their chat id automatically (personal messages and
      // monthly reminders then reach them without any manual step).
      if (tgUser.username) {
        const cand = await env.DB.prepare(
          'SELECT * FROM users WHERE telegram_user_id IS NULL AND bound_tg_id IS NULL AND is_active = 1 AND lower(telegram_username) = ? LIMIT 1'
        ).bind(String(tgUser.username).toLowerCase()).first();
        // v2.20.0 — این پروفایل قبلاً در حساب دیگری ثبت شده؟ اتصال خودکار انجام
        // نمی‌شود تا یک پروفایل هرگز روی دو حساب ثبت نماند (انتقال فقط با لینک دعوت).
        if (cand) {
          const heldElsewhere = await env.DB.prepare(
            'SELECT id FROM users WHERE telegram_user_id = ? AND id != ? LIMIT 1'
          ).bind(tgUser.id, cand.id).first();
          if (!heldElsewhere) {
            await env.DB.prepare(
              'UPDATE users SET telegram_user_id = ?, telegram_username = ? WHERE id = ?'
            ).bind(tgUser.id, String(tgUser.username), cand.id).run();
            cand.telegram_user_id = tgUser.id;
            cand.telegram_username = String(tgUser.username);
            return {
              user: cand,
              unit: cand.unit_id ? await loadUnit(env, cand.unit_id) : null,
              via: 'telegram',
              tgUser
            };
          }
        }
      }
    }
  }
  return null;
}

async function loadUnit(env, unitId) {
  return env.DB.prepare('SELECT * FROM units WHERE id = ? LIMIT 1').bind(unitId).first() || null;
}

/**
 * v2.14.0 — login throttle (ضد حملهٔ حدس رمز): per-username counter stored in
 * settings. After 5 failed attempts the account locks for 10 minutes; a
 * successful login clears the counter.
 */
const THROTTLE_MAX = 5;
const THROTTLE_WINDOW = 10 * 60; // seconds

// v2.20.0 — export: برای مصرف لینک دعوت هم همان شمارندهٔ ضد حملهٔ حدس رمز
// به‌کار می‌رود (همان کلید login_fail:<username> ورود عادی)
export async function loginThrottleCheck(env, uname) {
  const key = 'login_fail:' + uname;
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row || !row.value) return null;
  try {
    const st = JSON.parse(row.value);
    if (st && st.until > Math.floor(Date.now() / 1000)) return st;
    // v2.15.0 — فقط «قفلِ منقضی‌شده» (until>0 و گذشته) همان‌جا پاک می‌شود؛
    // رکوردِ شمارندهٔ میانی (until=0، ۱ تا ۴ خطا) باید بماند تا پشت‌سرهم شدن
    // خطاها به قفل ۵تایی برسد (تست api 15b همین را می‌گیرد)
    if (st && Number(st.until) > 0) {
      await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
    }
  } catch {
    // v2.15.0 — مقدار خراب هم همان‌جا پاک می‌شود
    try { await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run(); } catch { /* ignore */ }
  }
  return null;
}

async function loginThrottleFail(env, uname) {
  const key = 'login_fail:' + uname;
  const t = Math.floor(Date.now() / 1000);
  let n = 1;
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    const st = row && row.value ? JSON.parse(row.value) : null;
    // count every consecutive failure; `until` only marks the LOCK window
    if (st && Number.isFinite(Number(st.n))) n = (Number(st.n) || 0) + 1;
  } catch { /* ignore */ }
  const until = n >= THROTTLE_MAX ? t + THROTTLE_WINDOW : 0;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, JSON.stringify({ n, until })).run();
  return { n, locked: n >= THROTTLE_MAX, until };
}
export { loginThrottleFail };

async function loginThrottleClear(env, uname) {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind('login_fail:' + uname).run();
}
export { loginThrottleClear };

/**
 * Password login. When the request carries valid Telegram initData, the account
 * gets linked to that Telegram id so future opens auto-login.
 */
export async function loginWithPassword(request, env, username, password) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || !password) return { error: 'نام کاربری و رمز عبور را وارد کنید' };

  // v2.14.0 — brute-force protection: too many wrong tries → temporary lock
  const locked = await loginThrottleCheck(env, uname);
  if (locked) {
    const mins = Math.max(1, Math.ceil((locked.until - Math.floor(Date.now() / 1000)) / 60));
    return { error: `به‌خاطر تلاش‌های ناموفق زیاد، این حساب تا ${mins} دقیقه قفل است؛ بعداً دوباره تلاش کنید`, status: 429 };
  }

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE lower(username) = ? LIMIT 1'
  ).bind(uname).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await loginThrottleFail(env, uname);
    return { error: 'نام کاربری یا رمز عبور اشتباه است', status: 401 };
  }
  await loginThrottleClear(env, uname);
  if (!user.is_active) {
    return { error: 'این حساب کاربری غیرفعال شده است؛ با مدیر اپ تماس بگیرید', status: 403 };
  }

  // optional Telegram linking
  let linked = false;
  let tgId = 0;
  const bound = Number(user.bound_tg_id || 0); // v2.17.0 — قفل حساب به پروفایل لینک دعوت
  const initData = request.headers.get('x-telegram-init-data') || '';
  const botToken = await getBotToken(env);
  if (initData && botToken) {
    const maxAge = Number(env.INITDATA_MAX_AGE || 86400);
    const tgUser = await validateInitData(initData, botToken, maxAge);
    if (tgUser && tgUser.id) {
      tgId = Number(tgUser.id) || 0;
      // v2.17.0 — حسابِ قفل‌شده از داخل تلگرام فقط با همان پروفایل باز می‌شود؛
      // یوزر/پسوردش از پروفایل دیگر (یا دستگاه دیگر داخل تلگرام) بی‌اثر است.
      if (bound && tgId !== bound) {
        return {
          error: 'این حساب با لینک دعوت به یک پروفایل تلگرام قفل شده است؛ فقط با همان پروفایلی که لینک را باز کرد وارد می‌شود',
          status: 403,
          code: 'profile_locked'
        };
      }
      // v2.15.0 — هر کس فقط با اعتبارنامهٔ خودش وارد می‌شود؛ v2.24.0 — ورود
      // موفق با یوزر/پسورد، اثبات مالکیت است: همین پروفایل به این حساب هم وصل
      // می‌شود (اتصال موازی) حتی اگر به حساب دیگری هم وصل باشد. انتقال کامل
      // پروفایل فقط با لینک دعوتِ بدون پرچم parallel انجام می‌شود.
      // keep a manually-entered username when initData carries none
      const tgUname = tgUser.username || user.telegram_username || '';
      await env.DB.prepare(
        'UPDATE users SET telegram_user_id = ?, telegram_username = ? WHERE id = ?'
      ).bind(tgUser.id, tgUname, user.id).run();
      user.telegram_user_id = tgUser.id;
      user.telegram_username = tgUname;
      linked = true;
    }
  }

  // نشستِ مرورگر (بدون initData) برای حساب قفل‌شده هم توکنش به پروفایل مقید است
  // تا اگر داخل تلگرام پروفایل دیگری استفاده شود، به‌خودی‌خواه بی‌اعتبار شود.
  return { user, linked, tgId, boundTg: bound };
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    full_name: u.full_name || '',
    phone: u.phone || '',
    unit_id: u.unit_id || null,
    telegram_linked: Boolean(u.telegram_user_id),
    telegram_username: u.telegram_username || '',
    is_active: Boolean(u.is_active),
    // v2.17.0 — فقط برای مدیر معنا دارد: مدیرِ ساکن جزو بدهکاران و یادآوری‌هاست
    is_resident: u.role === 'resident' ? true : Number(u.is_resident === undefined ? 1 : u.is_resident) !== 0,
    profile_locked: Boolean(u.bound_tg_id) // v2.17.0 — حسابِ قفل‌شده به لینک دعوت
  };
}
