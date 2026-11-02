// Admin activity notifications (اعلان فعالیت‌ها برای مدیرکل) — v2.22.0
//
// «از وقتی وارد مینی‌اپ می‌شوند تا کارهایی که در اپ می‌کنند» — هر رویدادی که در
// پنل مدیریت اپ تیک بخورد، به‌صورت پیام تلگرام خصوصی برای حساب‌های مدیر اپ
// (role='admin') که تلگرامشان متصل است فرستاده می‌شود.
//
// چرخهٔ هر رویداد:
//   ۱) تیک در پنل ادمین (تب «🔔 اعلان فعالیت‌ها») → settings کلید admin_notif_cfg
//      (JSON {eventKey:'1'|'0'}). تیک «ساکن اپ را باز کرد» همان کلید قدیمی
//      visit_notify_enabled را می‌نویسد تا با تب «ورود کاربران» یکی بماند.
//   ۲) هندلر مربوطه notifyActivity(...) را صدا می‌زند (هرگز نمی‌شکند؛ ارسال در
//      waitUntil می‌ماند تا پاسخ سریع بماند — الگوی claims.js).
//   ۳) متن کامل پیام + انجام‌دهنده + وضعیت ارسال در جدول admin_notifications
//      ذخیره می‌شود — گزارش کامل اعلان‌های ارسالی، مستقل از موفقیت تلگرام.
//      ردیف‌های قدیمی‌تر از ۱۸۰ روز در ۱۰٪ نوشته‌ها حذف می‌شوند.
//   ۴) پیام موفق به «گزارش پیام‌های بات» (bot_messages direction=out) هم می‌رود.
//
// اتصال تلگرام مدیرکل: از پنل، لینک یک‌بارمصرف t.me/<bot>?startapp=… ساخته می‌شود
// (POST /a/notifications/link)؛ بازکردن آن داخل تلگرام + یوزرنیم/رمز همان حساب،
// telegram_user_id مدیرکل را متصل می‌کند (همان مسیر /auth/invite موجود).
import { route } from './router.js';
import { json, fail, now, getSettings, setSetting } from './helpers.js';
import { getBotToken, sendTelegramMessage, getBotUsernameCached } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';

const NOTIF_KEEP_DAYS = 180;   // نگهداری گزارش اعلان‌ها
const NOTIF_REPORT_LIMIT = 200;
const MAX_NOTE_TEXT = 3800;    // سقف متن پیام (تلگرام ~4096)

// ---------------------------------------------------------------------------
// کاتالوگ رویدادها — فقط از این فهرست قابل فعال‌سازی است
// ---------------------------------------------------------------------------
export const NOTIF_GROUPS = [
  { key: 'presence', label: 'ورود و حضور' },
  { key: 'finance',  label: 'مدیر ساختمان — مالی' },
  { key: 'mgmt',     label: 'مدیر ساختمان — مدیریت' },
  { key: 'security', label: 'داده و امنیت' }
];

export const NOTIF_EVENTS = [
  { key: 'resident_open',   group: 'presence', label: 'ساکن اپ را باز کرد',                          legacy: 'visit_notify_enabled', def: '1' },
  { key: 'resident_login',  group: 'presence', label: 'ساکن وارد اپ شد (نام کاربری/تلگرام)',          def: '0' },
  { key: 'manager_login',   group: 'presence', label: 'مدیر ساختمان وارد اپ شد',                      def: '0' },
  { key: 'claim_created',   group: 'finance',  label: 'ساکن رسید پرداخت ثبت کرد',                     def: '0' },
  { key: 'payment',         group: 'finance',  label: 'ثبت/ویرایش/لغو پرداخت و اعتبار اضافه‌پرداخت',   def: '0' },
  { key: 'charge_generate', group: 'finance',  label: 'صدور شارژ ماه',                                def: '0' },
  { key: 'expense_change',  group: 'finance',  label: 'ثبت/حذف هزینه مشاع',                           def: '0' },
  { key: 'unit_change',     group: 'mgmt',     label: 'افزودن/ویرایش/حذف واحد',                       def: '0' },
  { key: 'resident_change', group: 'mgmt',     label: 'ساخت/ویرایش/حذف حساب ساکن',                    def: '0' },
  { key: 'poll_change',     group: 'mgmt',     label: 'نظرسنجی جدید/رأی/بستن نظرسنجی',                def: '0' },
  { key: 'task_change',     group: 'mgmt',     label: 'کار جدید/انجام/حذف کار',                       def: '0' },
  { key: 'reminder',        group: 'mgmt',     label: 'ارسال یادآوری بدهی (دستی/خودکار)',             def: '0' },
  { key: 'export_import',   group: 'security', label: 'خروجی/بکاپ/بازیابی داده',                      def: '0' },
  { key: 'message_sent',    group: 'security', label: 'پیام شخصی ربات به کاربر',                      def: '0' }
];

const EVENT_KEYS = new Set(NOTIF_EVENTS.map(e => e.key));
const EVENT_MAP = new Map(NOTIF_EVENTS.map(e => [e.key, e]));
const ROLE_LABEL = { admin: 'مدیر اپ', manager: 'مدیر ساختمان', resident: 'ساکن' };

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
function cfgFromSettings(s) {
  let cfg = {};
  try { cfg = JSON.parse(s.admin_notif_cfg || '{}') || {}; } catch { /* corrupt → defaults */ }
  const out = {};
  for (const e of NOTIF_EVENTS) {
    if (e.legacy) out[e.key] = s[e.legacy] !== '0';
    else out[e.key] = cfg[e.key] === undefined ? e.def === '1' : cfg[e.key] === '1';
  }
  return out;
}

async function saveCfgKey(env, key, enabled) {
  const e = EVENT_MAP.get(key);
  if (!e) return;
  if (e.legacy) {
    await setSetting(env, e.legacy, enabled ? '1' : '0');
    return;
  }
  const s = await getSettings(env);
  let cfg = {};
  try { cfg = JSON.parse(s.admin_notif_cfg || '{}') || {}; } catch { /* fresh */ }
  cfg[key] = enabled ? '1' : '0';
  await setSetting(env, 'admin_notif_cfg', JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// core — notifyActivity(env, ctx, eventKey, detail)
//   detail: { actor, unitId, unitNumber, refId, lines: [], meta }
//   هرگز throw نمی‌کند؛ اگر ctx.waitUntil باشد کار در پس‌زمینه انجام می‌شود.
// ---------------------------------------------------------------------------
export async function notifyActivity(env, ctx, eventKey, detail = {}) {
  const job = (async () => {
    try {
      const e = EVENT_MAP.get(eventKey) || (eventKey === 'test' ? { key: 'test', label: 'اعلان آزمایشی' } : null);
      if (!e) return;
      const actor = detail.actor || null;
      // اعلانِ خودِ مدیرکل برای خودش بی‌معناست — فقط کاربران (ساکن/مدیر ساختمان/سیستم)
      if (actor && actor.role === 'admin') return;
      const s = await getSettings(env);
      const cfg = cfgFromSettings(s);
      if (eventKey !== 'test' && !cfg[eventKey]) return;

      const token = await getBotToken(env);
      const building = s.building_name || 'ساختمان';
      const lines = (detail.lines || []).filter(Boolean).map(String);
      let text = `🔔 ${building}\n${e.label}\n`;
      if (lines.length) text += '\n' + lines.map(l => '• ' + l).join('\n') + '\n';
      if (actor) {
        const nm = actor.full_name || actor.username || 'کاربر';
        const tg = actor.telegram_username ? ' (@' + actor.telegram_username + ')' : '';
        text += `\nانجام‌دهنده: ${nm}${tg} — ${ROLE_LABEL[actor.role] || actor.role || ''}`;
      } else {
        text += '\nانجام‌دهنده: سیستم (خودکار)';
      }
      text = text.slice(0, MAX_NOTE_TEXT);

      // ۱) گزارش کامل — حتی اگر ارسال شکست بخورد
      const res = await env.DB.prepare(`
        INSERT INTO admin_notifications (event, title, text, actor_user_id, actor_username, actor_role, unit_id, unit_number, ref_id, meta, sent, send_error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?)
      `).bind(
        eventKey, e.label, text,
        actor ? actor.id || null : null,
        actor ? actor.username || '' : '',
        actor ? actor.role || '' : '',
        detail.unitId || null,
        detail.unitNumber || '',
        detail.refId || null,
        detail.meta ? JSON.stringify(detail.meta).slice(0, 900) : '',
        now()
      ).run();
      const rowId = res.meta && res.meta.last_row_id;

      // ۲) گیرنده‌ها: همهٔ مدیرکل‌های فعالِ متصل به تلگرام
      const { results: admins } = await env.DB.prepare(`
        SELECT DISTINCT telegram_user_id FROM users
        WHERE is_active = 1 AND telegram_user_id IS NOT NULL AND role = 'admin'
      `).all();
      const targets = (admins || []).map(r => r.telegram_user_id).filter(Boolean);

      let sent = 0;
      let err = '';
      if (!token) err = 'bot_not_configured';
      else if (!targets.length) err = 'no_admin_telegram';
      else {
        for (const chatId of targets) {
          try {
            const rr = await sendTelegramMessage(token, chatId, text);
            if (rr && rr.ok) {
              sent++;
              try { await logOutgoingBotMessage(env, { chatId, text, title: 'اعلان فعالیت — ' + e.label }); } catch { /* report only */ }
            } else {
              err = err || 'telegram_rejected';
            }
          } catch (ex) {
            err = err || String((ex && ex.message) || ex).slice(0, 200);
          }
        }
      }
      if (rowId) {
        await env.DB.prepare('UPDATE admin_notifications SET sent = ?, send_error = ? WHERE id = ?')
          .bind(sent > 0 ? 1 : 0, err, rowId).run();
      }
      // ۳) پاک‌سازی فرصتی ردیف‌های قدیمی (۱۰٪ نوشته‌ها)
      if (Math.random() < 0.1) {
        try {
          await env.DB.prepare('DELETE FROM admin_notifications WHERE created_at < ?')
            .bind(now() - NOTIF_KEEP_DAYS * 86400).run();
        } catch { /* non-fatal */ }
      }
    } catch { /* هرگز مسیر اصلی را نمی‌شکند */ }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(job); return null; }
  await job;
  return null;
}

/** برچسب فارسی رویداد — برای mock و تست */
export function eventLabel(key) {
  const e = EVENT_MAP.get(key);
  return e ? e.label : key;
}

// ---------------------------------------------------------------------------
// routes — فقط مدیرکل ('admin')
// ---------------------------------------------------------------------------

// GET /a/notifications/config — کاتالوگ + وضعیت تیک‌ها + اتصال تلگرام مدیرکل
route('GET', '/a/notifications/config', async (c) => {
  const s = await getSettings(c.env);
  const cfg = cfgFromSettings(s);
  const { results: admins } = await c.env.DB.prepare(
    "SELECT id, username, full_name, telegram_user_id, telegram_username FROM users WHERE role = 'admin' ORDER BY id"
  ).all();
  return json({
    events: NOTIF_EVENTS.map(e => ({
      key: e.key, label: e.label, group: e.group,
      enabled: Boolean(cfg[e.key]),
      note: e.key === 'resident_open' ? 'همان اعلان تب «ورود کاربران»' : ''
    })),
    groups: NOTIF_GROUPS,
    admins: (admins || []).map(a => ({
      id: a.id, username: a.username, full_name: a.full_name || '',
      telegram_linked: Boolean(a.telegram_user_id),
      telegram_username: a.telegram_username || ''
    })),
    bot_configured: Boolean(await getBotToken(c.env))
  });
}, 'admin');

// POST /a/notifications/config — ذخیرهٔ تیک‌ها  body: { events: { key: bool } }
route('POST', '/a/notifications/config', async (c) => {
  const b = c.body || {};
  if (!b.events || typeof b.events !== 'object') return fail('فهرست رویدادها مشخص نشده است');
  let changed = 0;
  for (const [key, val] of Object.entries(b.events)) {
    if (!EVENT_KEYS.has(key)) return fail('رویداد ناشناس: ' + key);
    await saveCfgKey(c.env, key, Boolean(val));
    changed++;
  }
  if (!changed) return fail('تغییری ارسال نشده است');
  const s = await getSettings(c.env);
  return json({ ok: true, events: cfgFromSettings(s) });
}, 'admin');

// GET /a/notifications — گزارش کامل اعلان‌های ارسالی (فیلتر event/sent + صفحه‌بندی)
route('GET', '/a/notifications', async (c) => {
  const q = c.query;
  const where = [];
  const binds = [];
  const ev = String(q.get('event') || '').trim();
  if (ev && (EVENT_KEYS.has(ev) || ev === 'test')) { where.push('event = ?'); binds.push(ev); }
  const sent = q.get('sent');
  if (sent === '1' || sent === '0') { where.push('sent = ?'); binds.push(Number(sent)); }
  const offset = Math.max(0, Number(q.get('offset') || 0) || 0);
  const limit = Math.min(NOTIF_REPORT_LIMIT, Math.max(1, Number(q.get('limit') || 60) || 60));
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { results: items } = await c.env.DB.prepare(
    `SELECT * FROM admin_notifications ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM admin_notifications').first();
  const stats = await c.env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN sent = 1 THEN 1 ELSE 0 END), 0) AS sent_count,
      COALESCE(SUM(CASE WHEN sent = 0 THEN 1 ELSE 0 END), 0) AS failed_count,
      COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today_count
    FROM admin_notifications
  `).bind(now() - 86400).first();

  return json({
    items: (items || []).map(r => ({ ...r, sent: Number(r.sent) ? 1 : 0 })),
    total: Number(total && total.c) || 0,
    offset,
    limit,
    stats: {
      sent_count: Number(stats && stats.sent_count) || 0,
      failed_count: Number(stats && stats.failed_count) || 0,
      today_count: Number(stats && stats.today_count) || 0
    }
  });
}, 'admin');

// POST /a/notifications/test — ارسال پیام آزمایشی (مستقل از تیک‌ها) + ثبت در گزارش
route('POST', '/a/notifications/test', async (c) => {
  await notifyActivity(c.env, c.ctx, 'test', {
    lines: ['این یک اعلان آزمایشی است — اگر این پیام را می‌بینید، اتصال تلگرام مدیرکل درست است.']
  });
  const row = await c.env.DB.prepare(
    "SELECT sent, send_error FROM admin_notifications WHERE event = 'test' ORDER BY id DESC LIMIT 1"
  ).first();
  return json({ ok: true, sent: row ? Number(row.sent) : 0, send_error: row ? row.send_error : '' });
}, 'admin');

// POST /a/notifications/link — لینک اتصال تلگرام یک‌بارمصرف برای حساب مدیرکل
// (همان مسیر مصرف /auth/invite؛ بازکردن لینک داخل تلگرام + یوزرنیم/رمز همان حساب)
route('POST', '/a/notifications/link', async (c) => {
  const b = c.body || {};
  const userId = Number(b.user_id) || c.user.id;
  const user = await c.env.DB.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').bind(userId).first();
  if (!user || user.role !== 'admin') return fail('فقط حساب مدیر اپ از این مسیر لینک می‌گیرد', 404);
  if (!user.is_active) return fail('این حساب غیرفعال است', 409);

  const token = await getBotToken(c.env);
  const botUsername = await getBotUsernameCached(c.env);
  if (!token || !botUsername) {
    return fail('ابتدا توکن ربات را در تب «تنظیمات اپ» ثبت کنید', 400, 'bot_token_missing');
  }

  const hours = Math.min(72, Math.max(1, Math.round(Number(b.hours) || 24)));
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const t = tokenHex(bytes);
  const t0 = now();
  // مثل /invites: هر حساب فقط یک لینک فعال
  await c.env.DB.prepare('DELETE FROM invite_tokens WHERE user_id = ? AND used_at IS NULL').bind(user.id).run();
  await c.env.DB.prepare(`
    INSERT INTO invite_tokens (token, user_id, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(t, user.id, c.user.id, t0, t0 + hours * 3600).run();

  return json({ ok: true, url: `https://t.me/${botUsername}?startapp=${t}`, expires_at: t0 + hours * 3600 }, 201);
}, 'admin');

function tokenHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
