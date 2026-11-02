// Periodic reminders TO the building manager, authored by the app-admin
// (یادآوری دوره‌ای برای مدیر ساختمان) — v2.23.0
//
// مدیرکل از پنل مدیریت اپ یادآوری‌های دوره‌ای می‌سازد (روزانه / هفتگی / ماهانه)
// و cron روزانه (wrangler.jsonc crons) سررسیدها را می‌سنجد و با ربات برای
// حساب‌های فعالِ «مدیر ساختمان» که تلگرامشان متصل است می‌فرستد. هر یادآوری
// بلافاصله پس از ارسال مُهر می‌شود تا در همان روز/هفته/ماه تکرار نشود؛ اگر cron
// یک روز از دست برود، سررسید بعدی خودبه‌خود جبران می‌شود (مثل runAutoReminder).
//
// مسیرها فقط برای مدیرکل ('admin') است — مدیر ساختمان این‌ها را نمی‌سازد/نمی‌بیند
// و فقط پیام تلگرامش را دریافت می‌کند. گزارش پیام‌های ارسالی هم مثل بقیهٔ ربات
// در «گزارش پیام‌های بات» ثبت می‌شود.
import { route } from './router.js';
import { json, fail, now } from './helpers.js';
import { getBotToken, sendTelegramMessage } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { tehranToday, toJalaaliFromParts } from './jalali.js';

const FREQS = ['daily', 'weekly', 'monthly'];
const WEEK_LABEL = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];

function todayKeys() {
  const t = tehranToday();
  const j = toJalaaliFromParts(t.gy, t.gm, t.gd);
  const period = `${j.jy}-${String(j.jm).padStart(2, '0')}`;
  const day = `${period}-${String(j.jd).padStart(2, '0')}`;
  // شنبه = ۰ … جمعه = ۶  (JS: یک‌شنبه=۰ → شنبه=۶)
  const gWeek = new Date(Date.UTC(t.gy, t.gm - 1, t.gd)).getUTCDay();
  const weekday = (gWeek + 1) % 7;
  return { period, day, jd: j.jd, weekday };
}

export function freqLabel(r) {
  if (r.freq === 'daily') return 'هر روز';
  if (r.freq === 'weekly') return `هر ${WEEK_LABEL[Number(r.weekday) || 0] || 'هفته'}`;
  return `ماهانه — روز ${r.month_day || 1} شمسی`;
}

function validate(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw new Error('عنوان یادآوری را وارد کنید');
  const text = String(b.text || '').trim().slice(0, 800);
  const freq = FREQS.includes(b.freq) ? b.freq : 'monthly';
  const weekday = freq === 'weekly'
    ? Math.min(6, Math.max(0, Math.round(Number(b.weekday) || 0)))
    : null;
  const month_day = freq === 'monthly'
    ? Math.min(28, Math.max(1, Math.round(Number(b.month_day) || 1)))
    : null;
  return { title, text, freq, weekday, month_day };
}

// ---------------------------------------------------------------------------
// runManagerReminders — از cron روزانه و دکمهٔ «ارسال آزمایشی» (opts.force برای
// یک یادآوری مشخص) صدا زده می‌شود. opts.sender برای تست‌ها قابل تزریق است.
// ---------------------------------------------------------------------------
export async function runManagerReminders(env, opts = {}) {
  const out = { ran: false, reason: '', sent: 0, failed: 0, due: 0, unreachable: 0 };
  const t = todayKeys();

  let rows = [];
  try {
    if (opts.id) {
      const r = await env.DB.prepare('SELECT * FROM manager_reminders WHERE id = ?').bind(Number(opts.id)).first();
      rows = r ? [r] : [];
    } else {
      const { results } = await env.DB.prepare('SELECT * FROM manager_reminders WHERE is_active = 1 ORDER BY id').all();
      rows = results || [];
    }
  } catch { out.reason = 'table_missing'; return out; }

  // سررسیدها
  const due = opts.id
    ? rows // ارسال آزمایشی — مستقل از تقویم
    : rows.filter(r => {
        if (r.freq === 'daily') return r.last_sent_day !== t.day;
        if (r.freq === 'weekly') return Number(r.weekday) === t.weekday && r.last_sent_day !== t.day;
        return Number(r.month_day) <= t.jd && r.last_sent_period !== t.period;
      });
  out.due = due.length;
  if (!due.length) { out.reason = 'not_due'; return out; }

  const botToken = opts.sender ? 'test' : await getBotToken(env);
  if (!botToken) { out.reason = 'bot_token_missing'; return out; }

  const { results: mgrs } = await env.DB.prepare(`
    SELECT telegram_user_id FROM users
    WHERE role = 'manager' AND is_active = 1 AND telegram_user_id IS NOT NULL
  `).all();
  const targets = (mgrs || []).map(m => m.telegram_user_id).filter(Boolean);
  out.unreachable = Math.max(0, await countManagers(env) - targets.length);
  if (!targets.length) { out.reason = 'no_manager_telegram'; return out; }

  const s = { app_url: null };
  try { s.app_url = (await env.DB.prepare("SELECT value FROM settings WHERE key = 'app_url'").first() || {}).value || null; } catch { /* fresh db */ }
  const keyboard = s.app_url && !opts.sender
    ? { inline_keyboard: [[{ text: '🏢 باز کردن اپ ساختمان', web_app: { url: s.app_url } }]] }
    : undefined;

  for (const r of due) {
    const text = `📌 یادآوری از مدیریت اپ${opts.id ? ' (آزمایشی)' : ''}\n${r.title}` + (r.text ? `\n\n${r.text}` : '');
    for (const chatId of targets) {
      try {
        const rr = opts.sender
          ? await opts.sender(chatId, text, keyboard)
          : await sendTelegramMessage(botToken, chatId, text, keyboard);
        if (rr && rr.ok) {
          out.sent++;
          try { await logOutgoingBotMessage(env, { chatId, text, title: 'یادآوری دوره‌ای' }); } catch { /* report only */ }
        } else out.failed++;
      } catch { out.failed++; }
    }
    if (!opts.id) {
      await env.DB.prepare(
        'UPDATE manager_reminders SET last_sent_at = ?, last_sent_day = ?, last_sent_period = ? WHERE id = ?'
      ).bind(now(), t.day, t.period, r.id).run();
    }
  }
  out.ran = true;
  return out;
}

async function countManagers(env) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM users WHERE role = 'manager' AND is_active = 1"
  ).first();
  return Number(r && r.c) || 0;
}

function publicRow(r) {
  return { ...r, id: Number(r.id), freq: r.freq, weekday: r.weekday, month_day: r.month_day,
    is_active: Number(r.is_active) ? 1 : 0, freq_label: freqLabel(r) };
}

// ---------------------------------------------------------------------------
// routes — فقط مدیرکل ('admin')
// ---------------------------------------------------------------------------
route('GET', '/a/mreminders', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM manager_reminders ORDER BY id DESC LIMIT 100'
  ).all();
  return json({
    items: (results || []).map(publicRow),
    manager_count: await countManagers(c.env),
    reachable: (await c.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = 'manager' AND is_active = 1 AND telegram_user_id IS NOT NULL"
    ).first()).c,
    today: todayKeys()
  });
}, 'admin');

route('POST', '/a/mreminders', async (c) => {
  let v;
  try { v = validate(c.body || {}); } catch (e) { return fail(e.message); }
  const res = await c.env.DB.prepare(`
    INSERT INTO manager_reminders (title, text, freq, weekday, month_day, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).bind(v.title, v.text, v.freq, v.weekday, v.month_day, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM manager_reminders WHERE id = ?')
    .bind(res.meta.last_row_id).first();
  return json({ ok: true, item: publicRow(row) }, 201);
}, 'admin');

route('PUT', '/a/mreminders/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM manager_reminders WHERE id = ?').bind(id).first();
  if (!row) return fail('یادآوری پیدا نشد', 404);
  const b = c.body || {};
  let v = { title: row.title, text: row.text, freq: row.freq, weekday: row.weekday, month_day: row.month_day };
  if (b.title !== undefined || b.text !== undefined || b.freq !== undefined || b.weekday !== undefined || b.month_day !== undefined) {
    try {
      v = validate({
        title: b.title !== undefined ? b.title : row.title,
        text: b.text !== undefined ? b.text : row.text,
        freq: b.freq !== undefined ? b.freq : row.freq,
        weekday: b.weekday !== undefined ? b.weekday : row.weekday,
        month_day: b.month_day !== undefined ? b.month_day : row.month_day
      });
    } catch (e) { return fail(e.message); }
  }
  const isActive = b.is_active === undefined ? (Number(row.is_active) ? 1 : 0) : (b.is_active ? 1 : 0);
  // تغییر دوره، مُهر قبلی را پاک می‌کند تا بلافاصله طبق دورهٔ جدید سنجیده شود
  const resetStamp = v.freq !== row.freq || v.weekday !== row.weekday || v.month_day !== row.month_day;
  await c.env.DB.prepare(`
    UPDATE manager_reminders SET title = ?, text = ?, freq = ?, weekday = ?, month_day = ?, is_active = ?
    ${resetStamp ? ', last_sent_day = \'\', last_sent_period = \'\'' : ''}
    WHERE id = ?
  `).bind(v.title, v.text, v.freq, v.weekday, v.month_day, isActive, id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM manager_reminders WHERE id = ?').bind(id).first();
  return json({ ok: true, item: publicRow(updated) });
}, 'admin');

route('DELETE', '/a/mreminders/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM manager_reminders WHERE id = ?').bind(id).first();
  if (!row) return fail('یادآوری پیدا نشد', 404);
  await c.env.DB.prepare('DELETE FROM manager_reminders WHERE id = ?').bind(id).run();
  return json({ ok: true });
}, 'admin');

// ارسال آزمایشی/فوری — مستقل از تقویم؛ مُهر نمی‌زند
route('POST', '/a/mreminders/:id/send', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM manager_reminders WHERE id = ?').bind(id).first();
  if (!row) return fail('یادآوری پیدا نشد', 404);
  const out = await runManagerReminders(c.env, { id, sender: c.env.__testSender || null });
  return json({ ok: true, ...out });
}, 'admin');
