// One-time Telegram link codes (کد اتصال تلگرام) — v2.11.9
//
// Problem: connecting a resident used to require either a Telegram @username
// (typed by the manager on the profile — useless for the many people who have
// no username) or a username+password login inside Telegram (sharing a
// password feels unsafe). This module gives every account a ONE-TIME link
// code instead:
//
//   • the manager/admin generates a code per user (8 chars, no 0/1/I/L/O/U
//     glyphs so it survives being read aloud or typed)
//   • the resident opens https://t.me/<bot>?start=<CODE> — or simply sends the
//     CODE as a message to the bot — and their telegram_user_id gets bound to
//     the account. No username needed, no password shared.
//   • afterwards the account receives debt reminders, auto reminders,
//     announcements and personal manager messages (v2.11.6 recipient chain).
//
// SECURITY (fits the six locks of v2.11.8):
//   1. the code binds MESSAGE DELIVERY only — it never issues a session
//      token, never touches password_hash and never grants panel access;
//      opening the mini app still requires username+password (lock 1)
//   2. single-use (used_at), expiry (default 7 days, LINK_CODE_TTL_HOURS),
//      rotating (issuing a new code revokes every previous unused one)
//   3. anti-brute-force: 5 invalid code attempts per Telegram account per
//      15 minutes → temporary lock (login_attempts table, username='linkcode')
//   4. a Telegram account can be bound to exactly ONE app account — a code
//      cannot hijack an id already bound elsewhere
import { now } from './helpers.js';
import { getBotToken, getBotInfo } from './telegram.js';
import { OUT_TITLE_LINK } from './botmessages.js';

// Crockford-style alphabet: digits without 0/1 and letters without I/L/O/U
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PATTERN = /^[2-9A-HJKMNP-TV-Z]{8}$/;

export const LINK_THROTTLE_MAX = 5;       // invalid codes per Telegram account
export const LINK_THROTTLE_WINDOW = 900;  // 15 minutes

// v2.11.10 — «اعتبار قابل تنظیم»: the manager picks how long the link/code
// stays alive. Whitelist (not free-form) so the API surface stays predictable
// and the UI select matches the backend 1:1. 168h (۷ روز) stays the default.
export const LINK_TTL_HOURS = [1, 6, 24, 72, 168, 360, 720]; // 1h..30d
export const DEFAULT_LINK_TTL_HOURS = 168;

/** Returns the whitelisted hour value for v, or null when v is invalid. */
export function resolveLinkTtlHours(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_LINK_TTL_HOURS;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || !LINK_TTL_HOURS.includes(n)) return null;
  return n;
}

export const LINK_TTL_ERROR = 'اعتبار انتخابی معتبر نیست؛ گزینه‌های مجاز: ۱ ساعت، ۶ ساعت، ۱ روز، ۳ روز، ۷ روز، ۱۵ روز و ۳۰ روز';

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function linkCodeTtlSeconds(env) {
  const hours = Number(env && env.LINK_CODE_TTL_HOURS) || 168; // 7 days
  return Math.max(1, Math.floor(hours * 3600));
}

/**
 * v2.11.9 — «کد اتصال»: /start <CODE> (deep link) or a bare CODE typed in the
 * private chat. Returns the normalized code or null; anything that is not
 * code-shaped falls through to the normal welcome/app-card flow, so ordinary
 * messages and plain /start are never hijacked.
 */
export function extractLinkCode(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  if (parts.length === 2 && /^\/start(@\w+)?$/i.test(parts[0])) {
    const up = parts[1].toUpperCase();
    if (CODE_PATTERN.test(up)) return up;
    return null;
  }
  if (parts.length === 1) {
    const up = t.toUpperCase();
    if (CODE_PATTERN.test(up)) return up;
  }
  return null;
}

/** Builds the "https://t.me/<bot>?start=" prefix (null when the bot is offline). */
export async function deepLinkPrefix(env) {
  try {
    const token = await getBotToken(env);
    if (!token) return null;
    const info = await getBotInfo(token);
    if (info.ok && info.username) return `https://t.me/${info.username}?start=`;
  } catch { /* best effort */ }
  return null;
}

/**
 * Creates (rotates) the one-time link code for a user.
 * ttlHours: whitelisted validity (v2.11.10 — see resolveLinkTtlHours); the
 *           env default (LINK_CODE_TTL_HOURS, ۷ روز) applies when omitted.
 * Returns { code, link, expires_at, ttl_hours, user } or { error, status }.
 * Every previous UNUSED code of the same user is revoked (rotation).
 */
export async function createLinkCode(env, userId, createdBy, ttlHours) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? LIMIT 1')
    .bind(Number(userId)).first();
  if (!user) return { error: 'کاربر پیدا نشد', status: 404 };
  if (!user.is_active) return { error: 'این حساب کاربری غیرفعال است؛ ابتدا آن را فعال کنید', status: 409 };
  const ttl = resolveLinkTtlHours(ttlHours);
  if (ttl == null) return { error: LINK_TTL_ERROR, status: 400 };

  await env.DB.prepare(
    'UPDATE link_codes SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL'
  ).bind(now(), user.id).run();

  const expiresAt = now() + (ttl
    ? Math.max(1, ttl) * 3600
    : linkCodeTtlSeconds(env)); // explicit ttl wins; env default otherwise
  let code = generateCode();
  for (let i = 0; i < 5; i++) {
    try {
      await env.DB.prepare(
        'INSERT INTO link_codes (code, user_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(code, user.id, Number(createdBy) || null, now(), expiresAt).run();
      break;
    } catch (e) {
      if (i === 4) return { error: 'ساخت کد ناموفق بود؛ دوباره تلاش کنید', status: 500 };
      code = generateCode(); // UNIQUE collision — astronomically unlikely, retry
    }
  }
  const prefix = await deepLinkPrefix(env);
  return {
    code,
    link: prefix ? prefix + code : null,
    expires_at: expiresAt,
    ttl_hours: ttl || Math.round(linkCodeTtlSeconds(env) / 3600),
    user
  };
}

// --- anti-brute-force (login_attempts table, username='linkcode') -----------

export async function checkLinkThrottle(env, chatId) {
  try {
    const key = 'tg:' + Number(chatId);
    const since = now() - LINK_THROTTLE_WINDOW;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE ok = 0 AND username = 'linkcode' AND ip = ? AND created_at > ?"
    ).bind(key, since).first();
    if (Number((row && row.c) || 0) >= LINK_THROTTLE_MAX) {
      const row2 = await env.DB.prepare(
        "SELECT MAX(created_at) AS last FROM login_attempts WHERE ok = 0 AND username = 'linkcode' AND ip = ?"
      ).bind(key).first();
      const lastAt = Number((row2 && row2.last) || 0);
      const waitMin = Math.max(1, Math.ceil((lastAt + LINK_THROTTLE_WINDOW - now()) / 60));
      return {
        blocked: true,
        message: `🔒 به دلیل ارسال کدهای نامعتبر زیاد، اتصال موقتاً قفل شده است؛ حدود ${waitMin} دقیقه دیگر دوباره امتحان کنید`
      };
    }
  } catch { /* table may not exist yet — never block */ }
  return { blocked: false };
}

export async function recordLinkAttempt(env, chatId, ok) {
  try {
    await env.DB.prepare(
      "INSERT INTO login_attempts (username, ip, ok, created_at) VALUES ('linkcode', ?, ?, ?)"
    ).bind('tg:' + Number(chatId), ok ? 1 : 0, now()).run();
  } catch { /* never break the webhook */ }
}

/**
 * Consumes a one-time link code inside a private Telegram chat.
 * Returns { ok:true, text, user, fresh, logRow } or { ok:false, text }.
 * The webhook handler sends `text` back to the chat; when ok, logRow is
 * recorded in the bot-messages report (عنوان «اتصال تلگرام»).
 * SECURITY: delivery-only — no session token is issued here, ever.
 */
export async function consumeLinkCode(env, rawCode, chatId, from) {
  const code = String(rawCode || '').trim().toUpperCase();
  const tgId = Number(from && from.id) || Number(chatId) || 0;

  const throttle = await checkLinkThrottle(env, chatId);
  if (throttle.blocked) return { ok: false, text: throttle.message };

  const invalid = () => {
    recordLinkAttempt(env, chatId, false);
    return {
      ok: false,
      text: '❌ کد اتصال معتبر نیست یا منقضی شده است.\nاز مدیر ساختمان بخواهید لینک یا کد تازه‌ای برایتان بسازد.'
    };
  };

  let row = null;
  try {
    row = await env.DB.prepare('SELECT * FROM link_codes WHERE code = ? LIMIT 1').bind(code).first();
  } catch { row = null; }
  if (!row || row.revoked_at || row.used_at || Number(row.expires_at) <= now()) return invalid();

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(row.user_id).first();
  if (!user || !Number(user.is_active)) return invalid();

  // a Telegram account may be bound to exactly one app account
  const taken = await env.DB.prepare(
    'SELECT username FROM users WHERE telegram_user_id = ? AND id != ? LIMIT 1'
  ).bind(tgId, user.id).first();
  if (taken) {
    return {
      ok: false,
      text: `⚠️ این حساب تلگرام از قبل به حساب «${taken.username}» متصل است.\nاگر قصد تغییر دارید، از مدیر ساختمان بخواهید اتصال را جابه‌جا کند.`
    };
  }

  const fresh = Number(user.telegram_user_id || 0) !== tgId;
  try {
    await env.DB.prepare(
      'UPDATE users SET telegram_user_id = ?, telegram_username = ? WHERE id = ?'
    ).bind(tgId, String((from && from.username) || user.telegram_username || ''), user.id).run();
    await env.DB.prepare(
      'UPDATE link_codes SET used_at = ?, used_by_tg_id = ? WHERE id = ?'
    ).bind(now(), tgId, row.id).run();
  } catch {
    return { ok: false, text: 'اتصال در این لحظه انجام نشد؛ کمی بعد دوباره امتحان کنید.' };
  }
  recordLinkAttempt(env, chatId, true);

  const name = user.full_name || user.username;
  const text = fresh
    ? `✅ اتصال انجام شد، ${name}!\n\nاز این پس «یادآوری شارژ» و پیام‌های مدیر ساختمان برایتان در همین چت ارسال می‌شود.\n🔒 این کد فقط پیام‌رسانی را وصل می‌کند؛ ورود به اپ همچنان با نام کاربری و رمز خودتان است.`
    : `ℹ️ ${name}، این حساب تلگرام از قبل به حساب شما متصل بود؛ همه‌چیز آماده است.`;
  return {
    ok: true,
    text,
    user,
    fresh,
    logRow: {
      tgUserId: tgId,
      fullName: name,
      title: OUT_TITLE_LINK,
      text: `اتصال تلگرام به حساب «${user.username}» انجام شد`
    }
  };
}
