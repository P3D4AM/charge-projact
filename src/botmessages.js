// Bot messages report (گزارش پیام‌های بات) — v2.9, extended v2.19.0
//
// TWO directions are logged in one table (column `direction`):
//   • 'in'  — every message people send TO the bot:
//       private chat: every message (commands, plain text, media/other)
//       groups: only the commands the bot reacts to (/start, /app, /help)
//   • 'out' — every message the BOT ITSELF sends (v2.19.0):
//       automatic monthly reminders (cron), manual reminders, broadcast
//       announcements, personal messages, payment-claim notifications,
//       new-task/visit notifications, bot test messages and the webhook
//       replies (/start welcome, /help guide, app cards).
//
// Each row gets a human «title» (عنوان) so the admin panel can filter:
//   «فرمان /start» / «پیام متنی» / «یادآوری خودکار» / «یادآوری دستی» /
//   «پیام شخصی» / «اعلان همگانی» / «اعلام رسید پرداخت» …
// The admin panel (admin.html → تب «پیام‌های ربات») shows a Jalali calendar
// date-range filter, direction/title chips and a text search on this data.
//
// Robustness: logging NEVER throws — a missing table or a bad update must not
// break the Telegram webhook. Rows older than 180 days are pruned
// opportunistically (10% of writes) to keep the free D1 healthy.
import { route } from './router.js';
import { json, now } from './helpers.js';
import { tehranDayStartSec } from './jalali.js';

export const MSG_KEEP_DAYS = 180;        // retention window (days)
export const MSG_LIST_LIMIT = 200;       // default page size
export const MSG_TEXT_MAX = 500;         // stored text length cap
export const TEHRAN_OFFSET_SEC = 12600;  // Iran = UTC+3:30 (fixed, no DST)
export const DAY_SECONDS = 86400;

// ---------------------------------------------------------------------------
// pure helpers (unit-tested in scripts/test-botmessages.mjs)
// ---------------------------------------------------------------------------

/** Public label for a chat type. */
export function chatTypeLabel(t) {
  if (t === 'group' || t === 'supergroup') return 'گروه';
  if (t === 'private') return 'چت خصوصی';
  return t || '';
}

/**
 * Derives {kind, title} from a Telegram message.
 * kind: 'command' | 'text' | 'other'
 * title: «فرمان /start» | «پیام متنی» | «رسانه یا سایر»
 */
export function deriveBotTitle(chatType, msg = {}) {
  const text = String(msg.text || '').trim();
  const first = text.split(/\s+/)[0] || '';
  const m = /^\/([a-zA-Z_\u0600-\u06FF]+)(@\w+)?/.exec(first);
  if (m) {
    const cmd = '/' + m[1].toLowerCase();
    return { kind: 'command', title: 'فرمان ' + cmd };
  }
  if (text) return { kind: 'text', title: 'پیام متنی' };
  return { kind: 'other', title: 'رسانه یا سایر' };
}

/** True when the update should be logged (new messages only — edits are noise). */
export function shouldLogUpdate(update = {}) {
  if (!update.message || !update.message.chat) return false;
  const t = update.message.chat.type;
  if (t === 'private') return true;                        // every private message
  if (t === 'group' || t === 'supergroup') {               // groups: commands only
    const first = String(update.message.text || '').trim().split(/\s+/)[0] || '';
    const cmd = first.toLowerCase().split('@')[0];
    return ['/start', '/app', '/help', '/اپ'].includes(cmd);
  }
  return false;
}

/** 'YYYY-MM-DD' (Gregorian ISO) → epoch seconds of that date's 00:00 Tehran. */
export function isoDateToTehranDayStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return 0;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0;
  return Math.floor(Date.UTC(y, mo - 1, d) / 1000) - TEHRAN_OFFSET_SEC;
}

/** Epoch seconds of 00:00 «n days ago» in Tehran (n=0 → today). */
export function tehranDaysAgoStart(n, ts = now()) {
  return tehranDayStartSec(ts) - Number(n || 0) * DAY_SECONDS;
}

/**
 * Public title for an outgoing bot message (v2.19.0).
 * The caller passes a specific title; unknown/empty falls back to «ارسال ربات».
 */
export function outgoingTitle(title) {
  const t = String(title || '').trim().slice(0, 80);
  return t || 'ارسال ربات';
}

/** Normalizes and validates the report filters coming from the query string. */
export function parseFilters(query = new URLSearchParams()) {
  const from = isoDateToTehranDayStart(query.get('from'));
  const toDay = isoDateToTehranDayStart(query.get('to'));
  const to = toDay ? toDay + 86399 : 0;
  const title = String(query.get('title') || '').trim().slice(0, 80);
  const dirRaw = String(query.get('dir') || '').trim().toLowerCase();
  const dir = dirRaw === 'in' || dirRaw === 'out' ? dirRaw : '';
  const q = String(query.get('q') || '').trim().slice(0, 100);
  let limit = Number(query.get('limit')) || MSG_LIST_LIMIT;
  limit = Math.max(1, Math.min(500, Math.floor(limit)));
  const offset = Math.max(0, Math.min(10000, Math.floor(Number(query.get('offset')) || 0)));
  return { from, to, title, dir, q, limit, offset };
}

/** Builds the SQL WHERE fragment + bound args for the given filters.
 *  All columns are qualified with the `b.` alias (bot_messages) because the
 *  report SELECT joins users/units which have same-named columns. */
export function filterSql(f = {}) {
  const where = [];
  const args = [];
  if (f.from) { where.push('b.created_at >= ?'); args.push(f.from); }
  if (f.to) { where.push('b.created_at <= ?'); args.push(f.to); }
  if (f.title) { where.push('b.title = ?'); args.push(f.title); }
  if (f.dir === 'in' || f.dir === 'out') { where.push('b.direction = ?'); args.push(f.dir); }
  if (f.q) {
    where.push('(b.text LIKE ? OR b.full_name LIKE ? OR b.username LIKE ?)');
    const like = '%' + f.q.replace(/[%_]/g, ch => '\\' + ch) + '%';
    args.push(like, like, like);
  }
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

// ---------------------------------------------------------------------------
// db side
// ---------------------------------------------------------------------------

/** Quick counts for the report header (single query, Tehran day borders). */
export async function botMessageStats(env) {
  const ts = now();
  const dayStart = tehranDayStartSec(ts);
  const weekStart = tehranDaysAgoStart(7, ts);
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today,
             COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS week,
             COUNT(DISTINCT CASE WHEN created_at >= ? THEN COALESCE(tg_user_id, chat_id) END) AS senders_today,
             COALESCE(SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END), 0) AS out_total
      FROM bot_messages
    `).bind(dayStart, weekStart, dayStart).first();
    return {
      total: Number((row && row.total) || 0),
      today: Number((row && row.today) || 0),
      week: Number((row && row.week) || 0),
      senders_today: Number((row && row.senders_today) || 0),
      out_total: Number((row && row.out_total) || 0)
    };
  } catch {
    return { total: 0, today: 0, week: 0, senders_today: 0, out_total: 0 }; // table not created yet
  }
}

/** Distinct titles with counts (for the filter chips). */
export async function botMessageTitles(env) {
  try {
    const { results } = await env.DB.prepare(`
      SELECT title, COUNT(*) AS n FROM bot_messages
      GROUP BY title ORDER BY n DESC, title ASC LIMIT 24
    `).all();
    return (results || []).map(r => ({ title: r.title, n: Number(r.n) }));
  } catch { return []; }
}

/** Full report: stats + titles + filtered rows (joined with app users when linked). */
export async function botMessagesReport(env, filters) {
  const f = filters || parseFilters();
  const stats = await botMessageStats(env);
  const titles = await botMessageTitles(env);
  let rows = [];
  let matched = 0;
  let has_more = false;
  try {
    const { where, args } = filterSql(f);
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bot_messages b ${where}`)
      .bind(...args).first();
    matched = Number((cnt && cnt.n) || 0);
    const { results } = await env.DB.prepare(`
      SELECT b.id, b.chat_id, b.chat_type, b.tg_user_id, b.username, b.full_name,
             b.kind, b.title, b.text, b.created_at, COALESCE(b.direction, 'in') AS direction,
             u.role AS app_role, u.full_name AS app_name, un.number AS unit_number
      FROM bot_messages b
      LEFT JOIN users u ON u.telegram_user_id = b.tg_user_id
      LEFT JOIN units un ON un.id = u.unit_id
      ${where}
      ORDER BY b.id DESC LIMIT ${f.limit + 1} OFFSET ${f.offset}
    `).bind(...args).all();
    const list = results || [];
    has_more = list.length > f.limit;
    rows = list.slice(0, f.limit);
  } catch { /* bot_messages table not created yet */ }
  return { stats, titles, messages: rows, matched, has_more, filters: f };
}

/** Opportunistic pruning of rows older than the retention window (10% of writes). */
async function pruneOldMessages(env) {
  if (Math.random() >= 0.1) return;
  try {
    await env.DB.prepare('DELETE FROM bot_messages WHERE created_at < ?')
      .bind(now() - MSG_KEEP_DAYS * 86400).run();
  } catch { /* ignore */ }
}

/**
 * Logs one incoming bot message. Never throws — the webhook must not break.
 * ctx: Workers execution context; when present the INSERT is deferred via
 * ctx.waitUntil so the reply to the user stays fast.
 */
export async function logBotMessage(env, msg, ctx) {
  const job = (async () => {
    try {
      if (!env || !env.DB || !msg || !msg.chat) return { logged: false, reason: 'invalid' };
      const chatType = String(msg.chat.type || 'private');
      const { kind, title } = deriveBotTitle(chatType, msg);
      const text = String(msg.text || '').trim().slice(0, MSG_TEXT_MAX);
      const from = msg.from || {};
      const ts = Number(msg.date) > 0 ? Number(msg.date) : now();
      await env.DB.prepare(
        'INSERT INTO bot_messages (chat_id, chat_type, tg_user_id, username, full_name, kind, title, text, direction, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        Number(msg.chat.id) || 0, chatType,
        from.id != null ? Number(from.id) : null,
        String(from.username || '').slice(0, 64),
        [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 120),
        kind, title, text, 'in', ts
      ).run();
      await pruneOldMessages(env);
      return { logged: true };
    } catch (e) {
      try { console.error('[bot-messages] log failed:', (e && e.message) || e); } catch { /* ignore */ }
      return { logged: false, reason: 'error' };
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(job); return { logged: true, deferred: true }; }
  return job;
}

/**
 * v2.19.0 — Logs one OUTGOING bot message (یادآوری خودکار/دستی، پیام شخصی،
 * اعلان، اعلام رسید/کار/بازدید، پیام آزمایشی، پاسخ‌های وب‌هوک …).
 * Never throws — a logging failure must never break the actual send flow.
 * ctx: when present the work is deferred via ctx.waitUntil.
 * info: { chatId (recipient tg id), text, title, chatType ('private'|'group'…) }
 */
export async function logOutgoingBotMessage(env, info, ctx) {
  const job = (async () => {
    try {
      if (!env || !env.DB || !info || !Number(info.chatId)) return { logged: false, reason: 'invalid' };
      const chatId = Number(info.chatId);
      const chatType = String(info.chatType || 'private');
      const text = String(info.text || '').trim().slice(0, MSG_TEXT_MAX);
      const title = outgoingTitle(info.title);
      // best-effort recipient lookup — fills name/username + feeds the users join
      let username = '', fullName = '';
      try {
        const u = await env.DB.prepare(
          'SELECT username, full_name FROM users WHERE telegram_user_id = ? ORDER BY id LIMIT 1'
        ).bind(chatId).first();
        if (u) { username = String(u.username || ''); fullName = String(u.full_name || ''); }
      } catch { /* users table missing on a fresh db — log without the name */ }
      await env.DB.prepare(
        'INSERT INTO bot_messages (chat_id, chat_type, tg_user_id, username, full_name, kind, title, text, direction, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(chatId, chatType, chatId, username.slice(0, 64), fullName.slice(0, 120), 'out', title, text, 'out', now()).run();
      await pruneOldMessages(env);
      return { logged: true };
    } catch (e) {
      try { console.error('[bot-messages] outgoing log failed:', (e && e.message) || e); } catch { /* ignore */ }
      return { logged: false, reason: 'error' };
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(job); return { logged: true, deferred: true }; }
  return job;
}

// ---------------------------------------------------------------------------
// route — admin panel only (مدیر اپ)
// ---------------------------------------------------------------------------
route('GET', '/a/bot/messages', async (c) => {
  const rep = await botMessagesReport(c.env, parseFilters(c.query));
  return json(rep);
}, 'admin');
