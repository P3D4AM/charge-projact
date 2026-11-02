// Visit & login tracking (گزارش ورود کاربران به مینی‌اپ) — v2.9.1
//
// Every time the mini app is opened (/auth/me, /auth/telegram) or someone logs
// in with username/password (/auth/login), one row is written to the `visits`
// table. The report belongs ONLY to the app-admin (مدیر اپ): it is shown in
// the admin panel «ورود کاربران» tab and is never sent to or shown to the
// building managers (مدیر ساختمان) — neither in their mini app nor via Telegram.
//
// Real-time Telegram notification: when a RESIDENT opens/enters the app, ONLY
// the app-admin accounts linked to Telegram get a short message. Building
// managers never receive visit notifications. Residents themselves are never
// notified, and the visitor never notifies themself. Cooldowns keep the noise
// and the subrequest count sane:
//   • «open» events of the same user within 5 minutes are not logged again
//     (refresh/poll spam protection)
//   • at most one notification per user per 10 minutes
//   • rows older than 90 days are pruned opportunistically (10% of writes)
import { route } from './router.js';
import { json, fail, now, getSettings, setSetting } from './helpers.js';
import { faNum, formatJalaliDateTime, tehranDayStartSec } from './jalali.js';
import { getBotToken, sendTelegramMessage } from './telegram.js';
import { logOutgoingBotMessage, isoDateToTehranDayStart } from './botmessages.js';

// pure helpers are unit-tested (scripts/test-visits.mjs)
export const OPEN_DEDUP_SECONDS = 300;      // don't log another «open» within 5 min
export const NOTIFY_COOLDOWN_SECONDS = 600; // one notification per user per 10 min
export const VISITS_KEEP_DAYS = 90;
export const VISITS_LIST_LIMIT = 60;

/** True when `lastAt` is set and `nowSec - lastAt` is still inside the cooldown. */
export function withinCooldown(lastAt, nowSec, cooldownSeconds) {
  if (!lastAt) return false;
  return (Number(nowSec) - Number(lastAt)) < cooldownSeconds;
}

export function visitKindLabel(kind) {
  return kind === 'login' ? 'وارد اپ شد (نام کاربری/رمز)' : 'اپ را باز کرد';
}
export function visitViaLabel(via) {
  if (via === 'telegram') return 'داخل تلگرام';
  if (via === 'web') return 'از مرورگر';
  return '';
}

/** Strips the «واحد» prefix users sometimes type into the unit number. */
function unitNo(n) {
  return String(n ?? '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim();
}

/** Telegram text for one visit — sent only to the app-admin. */
export function buildVisitText(v = {}) {
  const who = String(v.name || '').trim() || 'ساکن';
  const unit = v.unit ? ' — واحد ' + faNum(unitNo(v.unit)) : '';
  const via = visitViaLabel(v.via);
  const ts = Number(v.ts) > 0 ? Number(v.ts) : Math.floor(Date.now() / 1000);
  return '👁 گزارش ورود به اپ\n\n' +
    who + unit + '\n' +
    '• ' + visitKindLabel(v.kind) + (via ? ' (' + via + ')' : '') + '\n' +
    '• ' + formatJalaliDateTime(ts * 1000);
}

// ---------------------------------------------------------------------------
// db side
// ---------------------------------------------------------------------------
/** Quick counts for the admin panel overview (single query). */
export async function visitQuickStats(env) {
  const ts = now();
  const dayStart = tehranDayStartSec(ts);
  const weekStart = ts - 7 * 86400;
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS week,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today,
             COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS uniq_today
      FROM visits WHERE created_at >= ?
    `).bind(dayStart, dayStart, weekStart).first();
    return {
      today: Number((row && row.today) || 0),
      week: Number((row && row.week) || 0),
      uniq_today: Number((row && row.uniq_today) || 0)
    };
  } catch {
    return { today: 0, week: 0, uniq_today: 0 }; // visits table not created yet
  }
}

/**
 * Full report for the app-admin panel: stats + rows joined with users/units.
 * opts.kind: 'open' | 'login' | '' (all)
 * opts.from/opts.to: ISO dates (inclusive, Tehran midnight bounds)
 * opts.limit/opts.offset: pagination (defaults VISITS_LIST_LIMIT / 0)
 * Returns { stats, visits, has_more }.
 */
export async function visitsReport(env, opts = {}) {
  const stats = await visitQuickStats(env);
  let rows = [];
  let hasMore = false;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || VISITS_LIST_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const kind = opts.kind === 'open' || opts.kind === 'login' ? String(opts.kind) : '';
  const from = isoDateToTehranDayStart(opts.from);
  const toDay = isoDateToTehranDayStart(opts.to);
  const to = toDay ? toDay + 86399 : 0;
  try {
    const where = [];
    const binds = [];
    if (kind) { where.push('v.kind = ?'); binds.push(kind); }
    if (from) { where.push('v.created_at >= ?'); binds.push(from); }
    if (to) { where.push('v.created_at <= ?'); binds.push(to); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { results } = await env.DB.prepare(`
      SELECT v.id, v.user_id, v.kind, v.via, v.created_at,
             u.full_name, u.username, u.role,
             un.number AS unit_number
      FROM visits v
      LEFT JOIN users u ON u.id = v.user_id
      LEFT JOIN units un ON un.id = u.unit_id
      ${whereSql}
      ORDER BY v.id DESC LIMIT ${limit + 1} OFFSET ${offset}
    `).bind(...binds).all();
    rows = results || [];
    hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
  } catch { /* visits table not created yet */ }
  return { stats, visits: rows, has_more: hasMore };
}

/**
 * Logs one visit and (best-effort) notifies the app-admin via Telegram.
 * Never throws — auth flows must not break if the visits table is missing.
 * ctx: the Workers execution context; when present the Telegram send is
 * deferred through ctx.waitUntil so login stays fast.
 */
export async function logVisit(env, user, kind, via, ctx) {
  try {
    if (!env || !env.DB || !user || !user.id) return { logged: false, reason: 'invalid' };
    const ts = now();
    const last = await env.DB.prepare(
      'SELECT created_at FROM visits WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).bind(user.id).first();
    const lastAt = last ? Number(last.created_at) || 0 : 0;
    if (kind === 'open' && withinCooldown(lastAt, ts, OPEN_DEDUP_SECONDS)) {
      return { logged: false, reason: 'dedup' };
    }
    await env.DB.prepare(
      'INSERT INTO visits (user_id, kind, via, created_at) VALUES (?, ?, ?, ?)'
    ).bind(user.id, String(kind || 'open'), String(via || ''), ts).run();

    const p = notifyVisit(env, user, kind, via, ts, lastAt).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    else await p;

    // opportunistic pruning of old rows
    if (Math.random() < 0.1) {
      try {
        await env.DB.prepare('DELETE FROM visits WHERE created_at < ?')
          .bind(ts - VISITS_KEEP_DAYS * 86400).run();
      } catch { /* ignore */ }
    }
    return { logged: true };
  } catch (e) {
    try { console.error('[visits] log failed:', (e && e.message) || e); } catch { /* ignore */ }
    return { logged: false, reason: 'error' };
  }
}

/** Sends the visit message ONLY to app-admin accounts linked to Telegram. */
async function notifyVisit(env, visitor, kind, via, ts, lastAt) {
  try {
    // only residents trigger notifications — the admin opening their own
    // panel would otherwise ping themself on every login
    if (visitor.role !== 'resident') return;
    const s = await getSettings(env);
    if (s.visit_notify_enabled === '0') return;
    if (withinCooldown(lastAt, ts, NOTIFY_COOLDOWN_SECONDS)) return;
    const token = await getBotToken(env);
    if (!token) return;

    let unitNumber = '';
    if (visitor.unit_id) {
      const u = await env.DB.prepare('SELECT number FROM units WHERE id = ?')
        .bind(visitor.unit_id).first();
      unitNumber = u ? u.number : '';
    }
    // v2.9.1: member logins go ONLY to the app management (مدیریت اپ).
    // Building managers must never receive them.
    const { results } = await env.DB.prepare(`
      SELECT DISTINCT telegram_user_id FROM users
      WHERE is_active = 1 AND telegram_user_id IS NOT NULL AND role = 'admin'
    `).all();
    if (!(results || []).length) return;

    const text = buildVisitText({
      name: visitor.full_name || visitor.username || 'ساکن',
      unit: unitNumber, kind, via, ts
    });
    const appUrl = s.app_url || '';
    const keyboard = appUrl
      ? { inline_keyboard: [[{ text: '🏢 باز کردن اپ ساختمان', web_app: { url: appUrl } }]] }
      : undefined;
    for (const r of results) {
      try {
        const rr = await sendTelegramMessage(token, r.telegram_user_id, text, keyboard);
        // v2.19.0 — ثبت گزارش بازدید برای مدیران در «گزارش پیام‌های ربات»
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: r.telegram_user_id, text, title: 'گزارش بازدید' });
      } catch { /* never throw */ }
    }
  } catch { /* never break auth */ }
}

// ---------------------------------------------------------------------------
// routes — app-admin ONLY (v2.9.1: removed from the building manager mini app)
// ---------------------------------------------------------------------------
// User-login report for the admin panel «ورود کاربران» tab.
// Query params: kind=open|login, from, to (ISO dates), offset, limit
route('GET', '/a/visits', async (c) => {
  const s = await getSettings(c.env);
  const rep = await visitsReport(c.env, {
    kind: c.query.get('kind'),
    from: c.query.get('from'),
    to: c.query.get('to'),
    offset: c.query.get('offset'),
    limit: c.query.get('limit')
  });
  return json({
    ...rep,
    notify_enabled: s.visit_notify_enabled !== '0',
    bot_configured: Boolean(await getBotToken(c.env)),
    me_linked: Boolean(c.user.telegram_user_id)
  });
}, 'admin');

// Toggle the real-time Telegram notification (app-admin only)
route('PUT', '/a/visits/notify', async (c) => {
  const b = c.body || {};
  if (b.enabled === undefined) return fail('وضعیت ارسال پیام مشخص نشده است');
  await setSetting(c.env, 'visit_notify_enabled', b.enabled ? '1' : '0');
  return json({ ok: true, notify_enabled: Boolean(b.enabled) });
}, 'admin');
