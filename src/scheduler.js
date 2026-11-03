// Automatic monthly debt reminders — driven by a Cloudflare Cron Trigger
// (see wrangler.jsonc «triggers.crons», checked daily at 05:30 UTC = 09:00 Tehran).
//
// Flow: once per Jalali month, on/after the configured day, every active
// resident account linked to Telegram that has an outstanding unit balance
// gets one personalized message through the bot. A summary goes to the
// building manager(s). The month is marked in settings so it never repeats.
import { getSettings, setSetting } from './helpers.js';
import {
  tehranToday, toJalaaliFromParts, isPeriod, periodLabel, faNum
} from './jalali.js';
import { getBotToken, sendTelegramMessage } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { autoConsumeCredit } from './credits.js';

// Free Workers plan allows ~50 subrequests per invocation — each reminder is
// one Telegram call, so keep a safe cap (same idea as NOTIFY_CAP in manager.js).
export const REMIND_CAP = 40;

export const DEFAULT_REMIND_TEXT =
  '{building}\n' +
  '{name} عزیز، مانده بدهی واحد {unit} مبلغ {amount} تومان است.\n' +
  'لطفاً تا پایان {month} نسبت به تسویه اقدام فرمایید.\n' +
  'با تشکر 🙏';

// ---------------------------------------------------------------------------
// config (settings table keys: auto_reminder_*)
// ---------------------------------------------------------------------------
export function readAutoCfg(s = {}) {
  const day = Math.min(29, Math.max(1, Math.round(Number(s.auto_reminder_day) || 1)));
  // v2.14.0 — «تعداد یادآوری»: 1..4 reminder rounds per Jalali month
  const count = Math.min(4, Math.max(1, Math.round(Number(s.auto_reminder_count) || 1)));
  const text = String(s.auto_reminder_text || '').trim() || DEFAULT_REMIND_TEXT;
  let done = [], donePeriod = '';
  try {
    const st = JSON.parse(s.auto_reminder_rounds || '{}');
    if (st && Array.isArray(st.r)) {
      done = st.r.map(Number).filter(n => Number.isFinite(n));
      donePeriod = isPeriod(String(st.p || '')) ? String(st.p) : '';
    }
  } catch { /* no/invalid rounds marker */ }
  return {
    enabled: s.auto_reminder_enabled === '1',
    day,
    count,
    rounds: roundDays(day, count),
    text,
    last: isPeriod(s.auto_reminder_last || '') ? s.auto_reminder_last : '',
    done,
    donePeriod
  };
}

// v2.14.0 — the day-of-month of every reminder round: the first round fires on
// the configured day, the rest spread evenly until day 29.
//   roundDays(5, 1) -> [5]     roundDays(1, 3) -> [1, 15, 29]
//   roundDays(5, 2) -> [5, 29] roundDays(1, 4) -> [1, 10, 20, 29]
export function roundDays(day, count) {
  const d = Math.min(29, Math.max(1, Math.round(Number(day) || 1)));
  const c = Math.min(4, Math.max(1, Math.round(Number(count) || 1)));
  if (c === 1) return [d];
  const step = (29 - d) / (c - 1);
  return Array.from({ length: c }, (_, i) => Math.min(29, d + Math.round(i * step)));
}

// v2.14.0 — which round indexes are due right now (jd = current Jalali day).
// A round is due when its day has arrived and it has not been sent this month.
export function dueRounds(jd, period, cfg) {
  const doneP = cfg.donePeriod || '';
  const done = Array.isArray(cfg.done) ? cfg.done : [];
  return (cfg.rounds || roundDays(cfg.day, cfg.count))
    .map((d, i) => ({ d, i }))
    .filter(x => jd >= x.d && !(doneP === period && done.includes(x.i)))
    .map(x => x.i);
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------
/**
 * Gate for the automatic run. `jd` = current Jalali day of month,
 * `period` = "YYYY-MM" Jalali month. Returns one of:
 *   'disabled' | 'already_sent' | 'day_not_reached' | 'run'
 * The «jd >= day» (instead of ==) makes the job self-healing: if the Worker
 * or Telegram is unavailable on the exact day, it still fires on a later day
 * within the same month (once — thanks to the last-sent marker).
 */
export function gateAuto(jd, period, cfg) {
  if (!cfg.enabled) return 'disabled';
  const rounds = cfg.rounds || roundDays(cfg.day, cfg.count);
  const doneP = cfg.donePeriod || cfg.last || '';
  const done = Array.isArray(cfg.done) ? cfg.done : (doneP === period ? [0] : []);
  if (doneP === period && done.length >= rounds.length) return 'already_sent';
  return dueRounds(jd, period, { ...cfg, rounds, done, donePeriod: doneP }).length ? 'run' : 'day_not_reached';
}

/** Renders the message template. Supported vars: {building} {name} {unit} {amount} {month} */
export function renderRemindText(tpl, v = {}) {
  const map = {
    building: v.building || 'ساختمان',
    name: v.name || 'ساکن',
    unit: v.unit || '—',
    amount: faNum(Number(v.amount || 0).toLocaleString('en-US')),
    month: v.month || periodLabel(currentJalaliPeriod())
  };
  return String(tpl || '').replace(/\{(building|name|unit|amount|month)\}/g, (_, k) => map[k] ?? '');
}

export function currentJalaliPeriod() {
  const t = tehranToday();
  const j = toJalaaliFromParts(t.gy, t.gm, t.gd);
  return { period: `${j.jy}-${String(j.jm).padStart(2, '0')}`, jd: j.jd };
}

// ---------------------------------------------------------------------------
// db queries
// ---------------------------------------------------------------------------
/**
 * All active resident accounts (linked or not) with their unit's total
 * outstanding debt.
 * v2.17.0 — مدیرِ ساکن (بدون تیک «مدیر، ساکن ساختمان نیست» در پنل مدیریت اپ)
 * هم جزو بدهکاران شارژ است و یادآوری خودکار/دستی برایش می‌رود. اگر واحد هم
 * حساب ساکن و هم حساب مدیرِ ساکن داشته باشد فقط یکی (اولویت ساکن) هدف می‌شود.
 */
export async function debtorResidents(env) {
  const { results } = await env.DB.prepare(`
    SELECT acc.id AS user_id, acc.role AS acc_role, acc.telegram_user_id, acc.full_name,
           u.id AS unit_id, u.number AS unit_number,
           COALESCE(SUM(d.amount - d.paid_amount), 0) AS debt
    FROM users acc
    JOIN units u ON u.id = acc.unit_id
    JOIN debts d ON d.unit_id = u.id
    WHERE acc.is_active = 1
      AND (acc.role = 'resident' OR (acc.role = 'manager' AND COALESCE(acc.is_resident, 1) = 1))
    GROUP BY acc.id
  `).all();
  const byUnit = new Map();
  for (const r of (results || [])
    .map(r => ({ ...r, debt: Number(r.debt) || 0 }))
    .sort((a, b) => (a.acc_role === 'resident' ? 0 : 1) - (b.acc_role === 'resident' ? 0 : 1))) {
    if (!byUnit.has(r.unit_id)) byUnit.set(r.unit_id, r);
  }
  return [...byUnit.values()]
    .filter(r => r.debt > 0)
    .sort((a, b) => b.debt - a.debt);
}

/** Stats for the settings UI (single grouped query, computed in JS). */
export async function autoRemindStats(env) {
  const rows = await debtorResidents(env);
  const debtors = rows.length;
  const reachable = rows.filter(r => r.telegram_user_id != null).length;
  const total = rows.reduce((s, r) => s + r.debt, 0);
  return {
    debtor_residents: debtors,
    reachable_residents: reachable,
    unreachable_residents: debtors - reachable,
    total_debt: total,
    capped: debtors > REMIND_CAP
  };
}

// ---------------------------------------------------------------------------
// app url for the message button (cron context has no request URL)
// ---------------------------------------------------------------------------
/** Persists the app origin (from request-time handlers) so the cron job can attach the app button. */
export async function rememberAppUrl(env, origin) {
  if (!origin) return;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app_url'").first();
    if (row && row.value === origin) return;
    await setSetting(env, 'app_url', origin);
  } catch { /* settings table may not exist yet */ }
}

function unitNo(n) {
  return String(n ?? '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim();
}

// ---------------------------------------------------------------------------
// main runner — used by BOTH the cron trigger and the «send now» button
// opts.force: skip the day/last gates (manual run from the manager panel)
// opts.sender: injectable send fn (tests); default = Telegram Bot API
// ---------------------------------------------------------------------------
export async function runAutoReminder(env, opts = {}) {
  const out = {
    ran: false, reason: '', period: '',
    sent: 0, failed: 0, targets: 0, unreachable: 0, total_debt: 0,
    errors: [], capped: false, demo: Boolean(opts.demo),
    round: 0, rounds_total: 0
  };

  const { period, jd } = currentJalaliPeriod();
  out.period = period;

  const s = await getSettings(env);
  const cfg = readAutoCfg(s);

  // v2.14.0 — round-based gating: every configured reminder round fires once
  // per month (a missed day self-heals on the next cron run). A manual run
  // (opts.force) bypasses the gates and marks the whole month as handled.
  const due = dueRounds(jd, period, cfg);
  if (!opts.force) {
    if (!cfg.enabled) { out.reason = 'disabled'; return out; }
    if (!due.length) {
      out.reason = (cfg.donePeriod === period && cfg.done.length >= cfg.rounds.length)
        ? 'already_sent' : 'day_not_reached';
      return out;
    }
    out.round = due[0] + 1;
    out.rounds_total = cfg.rounds.length;
  }

  const rows = await debtorResidents(env);
  out.total_debt = rows.reduce((a, r) => a + r.debt, 0);
  out.unreachable = rows.filter(r => r.telegram_user_id == null).length;
  const targets = rows.filter(r => r.telegram_user_id != null).slice(0, REMIND_CAP);
  out.targets = targets.length;
  out.capped = rows.filter(r => r.telegram_user_id != null).length > REMIND_CAP;

  if (!targets.length) { out.reason = 'no_targets'; return out; }

  const botToken = opts.botToken ?? (opts.demo ? 'demo' : await getBotToken(env));
  if (!botToken) { out.reason = 'bot_token_missing'; return out; }

  const building = s.building_name || 'ساختمان';
  const monthLabel = periodLabel(period);
  const appUrl = s.app_url || opts.origin || '';
  const keyboard = appUrl && !opts.demo
    ? { inline_keyboard: [[{ text: '🏢 باز کردن اپ ساختمان', web_app: { url: appUrl } }]] }
    : undefined;

  const send = opts.sender || ((chatId, text, kb) => sendTelegramMessage(botToken, chatId, text, kb));
  for (const r of targets) {
    const text = renderRemindText(cfg.text, {
      building,
      name: r.full_name || '',
      unit: unitNo(r.unit_number),
      amount: r.debt,
      month: monthLabel
    });
    const res = await send(r.telegram_user_id, text, keyboard);
    if (res && res.ok) {
      out.sent++;
      if (!opts.demo) {
        // v2.19.0 — «گزارش پیام‌های ربات»: ثبت پیام‌های ارسالی یادآوری خودکار
        try { await logOutgoingBotMessage(env, { chatId: r.telegram_user_id, text, title: 'یادآوری خودکار' }); } catch { /* never break the run */ }
      }
      // v2.14.0 — «تعداد یادآوری»: unpaid items of the unit count this reminder
      if (!opts.demo && r.unit_id) {
        try {
          await env.DB.prepare(
            'UPDATE debts SET remind_count = remind_count + 1, last_remind_at = ? WHERE unit_id = ? AND paid_amount < amount'
          ).bind(Math.floor(Date.now() / 1000), r.unit_id).run();
        } catch { /* schema older than v7 → skip counting */ }
      }
    }
    else { out.failed++; out.errors.push({ unit: unitNo(r.unit_number), reason: (res && res.error) || 'unknown' }); }
  }

  // summary for building manager(s) — only after a real attempt
  const summary =
    '🤖 یادآوری خودکار ماهانه انجام شد\n' +
    `ماه: ${monthLabel}\n` +
    `• ارسال موفق: ${faNum(out.sent)} ساکن\n` +
    `• ناموفق: ${faNum(out.failed)}\n` +
    `• بدهکار بدون اتصال تلگرام: ${faNum(out.unreachable)} نفر\n` +
    `• جمع مانده بدهی واحدهای بدهکار: ${faNum(out.total_debt.toLocaleString('en-US'))} تومان`;
  if (!opts.demo) {
    const { results: mgrs } = await env.DB.prepare(`
      SELECT telegram_user_id FROM users
      WHERE role = 'manager' AND is_active = 1 AND telegram_user_id IS NOT NULL
    `).all();
    for (const m of mgrs || []) {
      try {
        const rr = await send(m.telegram_user_id, summary, undefined);
        // v2.19.0 — خلاصهٔ یادآوری خودکار برای مدیران هم ثبت می‌شود
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: m.telegram_user_id, text: summary, title: 'یادآوری خودکار' });
      } catch { /* never fail the run */ }
    }
  }

  // mark the handled rounds so the cron never re-sends them this month
  if (!opts.demo) {
    const doneRounds = opts.force
      ? cfg.rounds.map((_, i) => i)
      : Array.from(new Set([...(cfg.donePeriod === period ? cfg.done : []), ...due]));
    await setSetting(env, 'auto_reminder_rounds', JSON.stringify({ p: period, r: doneRounds }));
    if (doneRounds.length >= cfg.rounds.length) await setSetting(env, 'auto_reminder_last', period);
  }
  out.ran = true;
  return out;
}

// ---------------------------------------------------------------------------
// v2.23.0 — صدور خودکار شارژ ماهانه (ف۱)
//   تنظیمات (تب گزارش‌ها ← کارت «صدور خودکار شارژ» در پنل مدیر ساختمان):
//     settings کلید auto_charge_cfg = JSON {enabled, day, amount, mode}
//     + تیک per-unit: ستون units.auto_charge (migrations/v13)
//   cron روزانه: از روز تنظیم‌شدهٔ ماه شمسی، برای واحدهای تیک‌خورده که هنوز
//   قلم «شارژ ماهانه» این ماه را ندارند قلم صادر می‌شود (مثل صدور دستی:
//   fixed/area/person) → مصرف خودکار اعتبار → اطلاع‌رسانی به ساکن متصل هر واحد
//   («مرحله اطلاع‌رسانی») → خلاصه برای مدیران → مُهر ماه در settings تا تکرار نشود.
// ---------------------------------------------------------------------------
export function readAutoChargeCfg(s = {}) {
  let cfg = {};
  try { cfg = JSON.parse(s.auto_charge_cfg || '{}') || {}; } catch { /* corrupt → defaults */ }
  return {
    // v2.23.2 — backend، enabled را به‌صورت Boolean واقعی در JSON ذخیره می‌کرد و
    // اینجا فقط رشتهٔ '1' پذیرفته می‌شد → نتیجهٔ ذخیره همیشه «غیرفعال» خوانده می‌شد
    // (کارت در اپ سبز می‌شد ولی بعد از ذخیره دوباره خاموش نمایش داده می‌شد و cron
    // هم اجرا نمی‌کرد). حالا هر دو شکل (true / 1 / '1') پذیرفته می‌شود.
    enabled: (cfg.enabled === true || cfg.enabled === 1 || cfg.enabled === '1'),
    day: Math.min(28, Math.max(1, Math.round(Number(cfg.day) || 1))),
    amount: Math.max(0, Math.round(Number(cfg.amount) || 0)),
    mode: ['fixed', 'area', 'person'].includes(cfg.mode) ? cfg.mode : 'fixed',
    lastPeriod: s.auto_charge_last || ''
  };
}

/** حساب‌های متصلِ تلگرام یک واحد برای اطلاع‌رسانی (اولویت: ساکن، بعد مدیرِ ساکن) */
async function unitNotifyTargets(env, unitId) {
  const { results } = await env.DB.prepare(`
    SELECT acc.id, acc.role, acc.telegram_user_id, acc.full_name
    FROM users acc
    WHERE acc.unit_id = ? AND acc.is_active = 1 AND acc.telegram_user_id IS NOT NULL
      AND (acc.role = 'resident' OR (acc.role = 'manager' AND COALESCE(acc.is_resident, 1) = 1))
    ORDER BY CASE acc.role WHEN 'resident' THEN 0 ELSE 1 END
  `).bind(unitId).all();
  return results || [];
}

export async function runAutoCharge(env, opts = {}) {
  const out = {
    ran: false, reason: '', period: '',
    created: 0, skipped: 0, no_area: [], notified: 0, notify_failed: 0,
    credit_used_total: 0, credit_units: 0, demo: Boolean(opts.demo)
  };

  const { period, jd } = currentJalaliPeriod();
  out.period = period;

  const s = await getSettings(env);
  const cfg = readAutoChargeCfg(s);
  if (!opts.force) {
    if (!cfg.enabled) { out.reason = 'disabled'; return out; }
    if (cfg.amount <= 0) { out.reason = 'no_amount'; return out; }
    if (jd < cfg.day) { out.reason = 'day_not_reached'; return out; }
    if (cfg.lastPeriod === period) { out.reason = 'already_done'; return out; }
  }

  // فقط واحدهای تیک‌خورده (ستون ممکن است روی دیتابیس خیلی قدیمی نباشد)
  let units = [];
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM units WHERE auto_charge = 1 ORDER BY id'
    ).all();
    units = results || [];
  } catch { out.reason = 'column_missing'; return out; }
  if (!units.length) { out.reason = 'no_units'; return out; }

  const { results: existing } = await env.DB.prepare(
    "SELECT unit_id FROM debts WHERE period = ? AND kind = 'monthly'"
  ).bind(period).all();
  const existingSet = new Set((existing || []).map(r => r.unit_id));
  const targets = units.filter(u => !existingSet.has(u.id));
  out.skipped = units.length - targets.length;

  const desc = 'شارژ ماه ' + periodLabel(period);
  const stmts = [];
  for (const u of targets) {
    let amt = 0;
    if (cfg.mode === 'fixed') amt = cfg.amount;
    else if (cfg.mode === 'person') amt = Math.round(cfg.amount * (u.residents_count || 1));
    else if (cfg.mode === 'area') {
      if (!u.area_m2) { out.no_area.push(u.number); continue; }
      amt = Math.round(cfg.amount * u.area_m2);
    }
    if (amt > 0) {
      stmts.push(env.DB.prepare(`
        INSERT INTO debts (unit_id, kind, period, description, amount, created_at)
        VALUES (?, 'monthly', ?, ?, ?, ?)
      `).bind(u.id, period, desc, amt, Math.floor(Date.now() / 1000)));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  out.created = stmts.length;

  // مصرف خودکار اعتبار — دقیقاً مثل صدور دستی (تلهٔ concurrency: ترتیبی)
  const botToken = opts.botToken ?? (opts.demo ? 'demo' : await getBotToken(env));
  const appUrl = s.app_url || opts.origin || '';
  const keyboard = appUrl && !opts.demo
    ? { inline_keyboard: [[{ text: '🏢 باز کردن اپ ساختمان', web_app: { url: appUrl } }]] }
    : undefined;
  const send = opts.sender || ((chatId, text, kb) => sendTelegramMessage(botToken, chatId, text, kb));
  const building = s.building_name || 'ساختمان';

  for (const u of targets) {
    const { used } = await autoConsumeCredit(env, u.id, { period });
    if (used > 0) { out.credit_used_total += used; out.credit_units++; }
    const debtRow = await env.DB.prepare(
      "SELECT amount, paid_amount FROM debts WHERE unit_id = ? AND period = ? AND kind = 'monthly' LIMIT 1"
    ).bind(u.id, period).first();
    if (!debtRow) continue;
    const remaining = Math.max(0, Number(debtRow.amount) - Number(debtRow.paid_amount));
    // مرحلهٔ اطلاع‌رسانی: پیام خصوصی به ساکن متصل واحد (اولویت ساکن، بعد مدیرِ ساکن)
    const accs = await unitNotifyTargets(env, u.id);
    const text = `${building} — واحد ${faNum(unitNo(u.number))}\n` +
      `شارژ ${periodLabel(period)} صادر شد\n` +
      `• مبلغ: ${faNum(Number(debtRow.amount).toLocaleString('en-US'))} تومان\n` +
      (used > 0 ? `• از اعتبار اضافه‌پرداخت شما: ${faNum(used.toLocaleString('en-US'))} تومان اعمال شد\n` : '') +
      (remaining > 0
        ? `• مانده برای پرداخت: ${faNum(remaining.toLocaleString('en-US'))} تومان\nپس از پرداخت، فیش را در «واحد من» بارگذاری کنید.`
        : 'بدهی این ماه شما با اعتبار تسویه شد. دستتان درد نکند!');
    for (const acc of accs.slice(0, 1)) { // مثل یادآوری: هر واحد فقط یک پیام (اولویت ساکن، بعد مدیرِ ساکن)
      if (opts.demo) { out.notified++; continue; }
      try {
        const rr = await send(acc.telegram_user_id, text, keyboard);
        if (rr && rr.ok) {
          out.notified++;
          try { await logOutgoingBotMessage(env, { chatId: acc.telegram_user_id, text, title: 'صدور خودکار شارژ' }); } catch { /* report only */ }
        } else out.notify_failed++;
      } catch { out.notify_failed++; }
    }
  }

  // خلاصه برای مدیران ساختمان
  if (!opts.demo) {
    const summary =
      '🤖 صدور خودکار شارژ انجام شد\n' +
      `ماه: ${periodLabel(period)}\n` +
      `• قلم تازه: ${faNum(out.created)} واحد\n` +
      (out.skipped ? `• قبلاً صادرشده (ردشده): ${faNum(out.skipped)}\n` : '') +
      (out.credit_used_total > 0 ? `• اعتبار اعمال‌شده: ${faNum(out.credit_used_total.toLocaleString('en-US'))} تومان\n` : '') +
      `• اطلاع‌رسانی موفق: ${faNum(out.notified)} پیام` + (out.notify_failed ? ` — ناموفق: ${faNum(out.notify_failed)}` : '');
    const { results: mgrs } = await env.DB.prepare(`
      SELECT telegram_user_id FROM users
      WHERE role = 'manager' AND is_active = 1 AND telegram_user_id IS NOT NULL
    `).all();
    for (const m of mgrs || []) {
      try {
        const rr = await send(m.telegram_user_id, summary, undefined);
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: m.telegram_user_id, text: summary, title: 'صدور خودکار شارژ' });
      } catch { /* never fail the run */ }
    }
    // گزارش اعلان فعالیت برای مدیرکل (v2.22 hooks) — بازیگر: سیستم
    try {
      const { notifyActivity } = await import('./actnotifs.js');
      await notifyActivity(env, null, 'charge_generate', {
        lines: [
          `صدور خودکار — ماه ${periodLabel(period)}: ${out.created} قلم تازه` + (out.skipped ? `، ${out.skipped} ردشده` : ''),
          ...(out.credit_used_total > 0 ? [`اعتبار ${out.credit_used_total.toLocaleString('en-US')} تومان برای ${out.credit_units} واحد اعمال شد`] : []),
          `اطلاع‌رسانی: ${out.notified} پیام موفق` + (out.notify_failed ? `، ${out.notify_failed} ناموفق` : '')
        ]
      });
    } catch { /* never break the run */ }
  }

  // مُهر ماه — cron هرگز دو بار در یک ماه صادر نمی‌کند
  if (!opts.demo) await setSetting(env, 'auto_charge_last', period);
  out.ran = true;
  return out;
}
