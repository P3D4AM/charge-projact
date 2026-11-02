// Credits (اعتبار اضافه‌پرداخت) — v2.21.0
//
// اگر ساکنی بیشتر از بدهی‌اش پرداخت کند، مابه‌التفاوت به‌عنوان «اعتبار» واحد
// ثبت می‌شود و در صدور شارژ ماه‌های بعدی به‌صورت خودکار از آن کسر می‌شود.
//
// چرخهٔ کامل:
//   ۱) ثبت: مدیر هنگام ثبت پرداختِ بیشتر از مانده (کد 'overpay_possible' ← تأیید)،
//      هنگام تأیید رسید ساکن با مبلغ بیشتر، یا دستی از کارت واحد «ثبت اضافه‌پرداخت».
//   ۲) مصرف: در صدور شارژ ماه جدید به‌صورت خودکار (پیش‌پرداخت همان قلم جدید)،
//      با «اعمال اعتبار» دستی روی هر قلم باز، یا از مسیر مصرفِ دمو.
//   ۳) نمایش: کارت اعتبار در «واحد من» ساکن، چیپ اعتبار در کارت‌های واحد مدیر،
//      ستون «اعتبار» در گزارش سالانه/ماهانه و خروجی بدهکاران و PDFها.
//
// دفتر تراکنش است: amount مثبت = ثبت (kind=add)؛ amount منفی = مصرف
// (kind=consume، همراه debt_id). ماندهٔ واحد = SUM(amount) — همیشه ≥ ۰ نگه داشته می‌شود.
//
// دسترسی‌ها:
//   • ثبت/حذف/اعمال/فهرست → فقط مدیر ساختمان ('manager') — حریم مالی
//   • تاریخچهٔ اعتبار واحد خود → کاربر دارای واحد ('user' + گارد داخل هندلر)
import { route } from './router.js';
import { json, fail, now } from './helpers.js';
import { notifyActivity } from './actnotifs.js';

const MAX_NOTE = 300;
const MAX_CREDITS = 20000; // سقف کل ردیف‌های دفتر

// ---------------------------------------------------------------------------
// helpers (بین manager.js / claims.js / api.js مشترک)
// ---------------------------------------------------------------------------

/** ماندهٔ اعتبار واحد (SUM مثبت‌ها و منفی‌ها) */
export async function unitCredit(env, unitId) {
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS v FROM unit_credits WHERE unit_id = ?'
  ).bind(unitId).first();
  return Math.max(0, Number(r && r.v) || 0);
}

/** ماندهٔ باز بدهی واحد (روی همهٔ اقلام) */
export async function unitDebtRemaining(env, unitId) {
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount - paid_amount), 0) AS v FROM debts WHERE unit_id = ?'
  ).bind(unitId).first();
  return Math.max(0, Number(r && r.v) || 0);
}

/** جمع اعتبار همهٔ واحدها — برای داشبورد/گزارش‌ها */
export async function creditTotal(env) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS v FROM unit_credits').first();
  return Math.max(0, Number(r && r.v) || 0);
}

/** ثبت اضافه‌پرداخت (ردیف مثبت) — amount باید > 0 باشد */
export async function registerCredit(env, unitId, amount, { period = '', note = '', createdBy = null } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!(amt > 0)) throw new Error('credit_amount_invalid');
  await env.DB.prepare(
    "INSERT INTO unit_credits (unit_id, amount, kind, period, note, created_by, created_at) VALUES (?, ?, 'add', ?, ?, ?, ?)"
  ).bind(unitId, amt, period, note.slice(0, MAX_NOTE), createdBy, now()).run();
  return amt;
}

/** مصرف اعتبار (ردیف منفی) — فقط ثبت دفتر؛ به‌روزرسانی debts با caller است */
export async function consumeCredit(env, unitId, amount, { debtId = null, period = '', note = '' } = {}) {
  const amt = Math.round(Number(amount) || 0);
  if (!(amt > 0)) throw new Error('credit_amount_invalid');
  await env.DB.prepare(
    "INSERT INTO unit_credits (unit_id, amount, kind, debt_id, period, note, created_at) VALUES (?, ?, 'consume', ?, ?, ?, ?)"
  ).bind(unitId, -amt, debtId, period, note.slice(0, MAX_NOTE), now()).run();
  return amt;
}

/**
 * اعمال اعتبار موجود واحد روی یک قلم بدهی باز: تا سقف min(اعتبار، ماندهٔ قلم).
 * بازگشت: {used, debt} — debt به‌روزشده یا null اگر چیزی مصرف نشد.
 */
export async function applyCreditToDebt(env, unitId, debt, { note = '', period } = {}) {
  const remaining = Number(debt.amount) - Number(debt.paid_amount);
  if (remaining <= 0) return { used: 0, debt };
  const credit = await unitCredit(env, unitId);
  const used = Math.min(credit, remaining);
  if (used <= 0) return { used: 0, debt };
  const paid = Number(debt.paid_amount) + used;
  const status = paid >= Number(debt.amount) ? 'paid' : 'partial';
  const method = 'اعتبار اضافه‌پرداخت';
  const noteFull = note
    ? (debt.note ? String(debt.note).slice(0, 180) + ' | ' + note : note)
    : debt.note;
  await env.DB.prepare(
    'UPDATE debts SET paid_amount = ?, status = ?, paid_at = COALESCE(paid_at, ?), method = ?, note = ? WHERE id = ?'
  ).bind(paid, status, now(), method, noteFull || '', debt.id).run();
  await consumeCredit(env, unitId, used, {
    debtId: debt.id,
    period: period || debt.period || '',
    note: note || 'اعمال اعتبار روی ' + (debt.description || 'قلم بدهی')
  });
  const updated = await env.DB.prepare(
    'SELECT d.*, u.number AS unit_number, u.resident_name FROM debts d JOIN units u ON u.id = d.unit_id WHERE d.id = ?'
  ).bind(debt.id).first();
  return { used, debt: updated };
}

/**
 * مصرف خودکار اعتبار روی اقلام باز واحد به‌صورت FIFO (قدیمی‌ترین دوره اول) —
 * بعد از صدور شارژ ماه جدید صدا زده می‌شود. بازگشت: {used, units_touched}
 */
export async function autoConsumeCredit(env, unitId, { period = '' } = {}) {
  const credit = await unitCredit(env, unitId);
  if (credit <= 0) return { used: 0 };
  let left = credit;
  const { results } = await env.DB.prepare(
    'SELECT * FROM debts WHERE unit_id = ? AND paid_amount < amount ORDER BY period ASC, id ASC'
  ).bind(unitId).all();
  let used = 0;
  for (const d of results || []) {
    if (left <= 0) break;
    const rem = Number(d.amount) - Number(d.paid_amount);
    const take = Math.min(rem, left);
    if (take <= 0) continue;
    const paid = Number(d.paid_amount) + take;
    const status = paid >= Number(d.amount) ? 'paid' : 'partial';
    const method = 'اعتبار اضافه‌پرداخت';
    const noteFull = debtCreditNote(period);
    await env.DB.prepare(
      'UPDATE debts SET paid_amount = ?, status = ?, paid_at = COALESCE(paid_at, ?), method = ?, note = ? WHERE id = ?'
    ).bind(paid, status, now(), method, noteFull, d.id).run();
    await consumeCredit(env, unitId, take, {
      debtId: d.id,
      period: period || d.period || '',
      note: 'مصرف خودکار در صدور شارژ' + (period ? ' ' + period : '')
    });
    left -= take;
    used += take;
  }
  return { used };
}

/** یادداشت استاندارد قلم تسویه‌شده با اعتبار */
function debtCreditNote(period) {
  return 'پیش‌پرداخت با اعتبار اضافه‌پرداخت' + (period ? ' — ' + period : '');
}

/** تاریخچهٔ دفتر اعتبار یک واحد (جدیدترین اول) */
export async function creditEntries(env, unitId, limit = 50) {
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.number AS unit_number, u.resident_name
     FROM unit_credits c JOIN units u ON u.id = c.unit_id
     WHERE c.unit_id = ? ORDER BY c.id DESC LIMIT ?`
  ).bind(unitId, Math.min(200, Math.max(1, Number(limit) || 50))).all();
  return results || [];
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

// GET /credits — دفتر اعتبار همهٔ واحدها + ماندهٔ هر واحد (مدیر)
route('GET', '/credits', async (c) => {
  const unitId = Number(c.query.get('unit_id') || 0);
  const { results: balances } = await c.env.DB.prepare(`
    SELECT u.id AS unit_id, u.number AS unit_number, u.resident_name,
           COALESCE(SUM(cr.amount), 0) AS credit
    FROM units u LEFT JOIN unit_credits cr ON cr.unit_id = u.id
    GROUP BY u.id HAVING credit != 0 ORDER BY LENGTH(u.number), u.number
  `).all();
  let entries;
  if (unitId) {
    entries = await creditEntries(c.env, unitId, 200);
  } else {
    const { results } = await c.env.DB.prepare(`
      SELECT c.*, u.number AS unit_number, u.resident_name
      FROM unit_credits c JOIN units u ON u.id = c.unit_id
      ORDER BY c.id DESC LIMIT 200
    `).all();
    entries = results || [];
  }
  return json({
    balances: balances || [],
    entries,
    total: (balances || []).reduce((s, b) => s + (Number(b.credit) || 0), 0)
  });
}, 'manager');

// POST /credits — ثبت دستی اضافه‌پرداخت (مدیر)
route('POST', '/credits', async (c) => {
  const b = c.body || {};
  const unitId = Number(b.unit_id);
  const amount = Math.round(Number(b.amount) || 0);
  const period = String(b.period || '').trim();
  const note = String(b.note || '').trim();
  if (!unitId) return fail('واحد مشخص نشده است');
  if (!(amount > 0)) return fail('مبلغ اضافه‌پرداخت باید بزرگ‌تر از صفر باشد');
  if (amount > 2_000_000_000) return fail('مبلغ بیش از حد بزرگ است');
  const unit = await c.env.DB.prepare('SELECT id, number FROM units WHERE id = ?').bind(unitId).first();
  if (!unit) return fail('واحد پیدا نشد', 404);

  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM unit_credits').first();
  if ((Number(cnt && cnt.c) || 0) >= MAX_CREDITS) return fail('سقف ردیف‌های اعتبار پر شده است', 409, 'credits_full');

  await registerCredit(c.env, unitId, amount, {
    period: period && period !== 'none' ? period : '',
    note: note || 'ثبت دستی اضافه‌پرداخت',
    createdBy: c.user.id
  });
  const balance = await unitCredit(c.env, unitId);
  notifyActivity(c.env, c.ctx, 'payment', {
    actor: c.user, unitId, unitNumber: unit.number, refId: null,
    lines: [`اعتبار (اضافه‌پرداخت) ${amount.toLocaleString('en-US')} تومانی برای واحد ${unit.number} ثبت شد — مانده اعتبار: ${balance.toLocaleString('en-US')}`]
  });
  return json({ ok: true, unit_id: unitId, registered: amount, credit_balance: balance }, 201);
}, 'manager');

// DELETE /credits/:id — حذف ردیف ثبتِ اشتباه (فقط kind=add؛ ردیف‌های مصرف دست نمی‌خورند).
// اگر این ثبت قبلاً مصرف شده باشد (حذفش مانده را منفی می‌کند) رد می‌شود — صحت دفتر.
route('DELETE', '/credits/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM unit_credits WHERE id = ?').bind(id).first();
  if (!row) return fail('ردیف اعتبار پیدا نشد', 404);
  if (row.kind !== 'add') return fail('ردیف‌های «مصرف اعتبار» قابل حذف نیستند — بدهی قلم مربوطه را لغو/اصلاح کنید', 409, 'consume_locked');
  const balance = await unitCredit(c.env, row.unit_id);
  if (balance - Number(row.amount) < 0) {
    return fail('این اضافه‌پرداخت قبلاً مصرف شده است و قابل حذف نیست؛ ابتدا مصرف آن را از قلم مربوطه لغو کنید', 409, 'already_consumed');
  }
  await c.env.DB.prepare('DELETE FROM unit_credits WHERE id = ?').bind(id).run();
  return json({ ok: true, credit_balance: balance - Number(row.amount) });
}, 'manager');

// POST /credits/apply — اعمال اعتبار واحد روی یک قلم باز (مدیر)
route('POST', '/credits/apply', async (c) => {
  const b = c.body || {};
  const debtId = Number(b.debt_id);
  if (!debtId) return fail('قلم بدهی مشخص نشده است');
  const debt = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(debtId).first();
  if (!debt) return fail('قلم بدهی پیدا نشد', 404);
  if (debt.paid_amount >= debt.amount) return fail('این قلم قبلاً تسویه شده است', 409, 'already_paid');
  const credit = await unitCredit(c.env, debt.unit_id);
  if (credit <= 0) return fail('این واحد اعتبار قابل مصرف ندارد', 409, 'no_credit');
  const { used, debt: updated } = await applyCreditToDebt(c.env, debt.unit_id, debt, {
    note: 'اعمال دستی اعتبار توسط مدیر'
  });
  const balance = await unitCredit(c.env, debt.unit_id);
  const remainingAfter = await unitDebtRemaining(c.env, debt.unit_id);
  notifyActivity(c.env, c.ctx, 'payment', {
    actor: c.user, unitId: debt.unit_id, refId: debt.id,
    lines: [`${used.toLocaleString('en-US')} تومان از اعتبار واحد روی قلم «${debt.description || 'بدهی'}» اعمال شد — مانده اعتبار: ${balance.toLocaleString('en-US')}`]
  });
  return json({ ok: true, used, debt: updated, credit_balance: balance, unit_remaining: remainingAfter });
}, 'manager');

// GET /my/credit — تاریخچه و ماندهٔ اعتبار واحد خود (ساکن/مدیر دارای واحد)
route('GET', '/my/credit', async (c) => {
  const unit = c.unit || c.auth.unit;
  if (!unit) return fail('به هیچ واحدی متصل نیستید؛ با مدیر ساختمان تماس بگیرید', 403, 'no_unit');
  const [balance, entries] = await Promise.all([
    unitCredit(c.env, unit.id),
    creditEntries(c.env, unit.id, 50)
  ]);
  return json({ unit_id: unit.id, balance, entries });
}, 'user');
