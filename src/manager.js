// Manager (مدیر ساختمان) routes: units, resident accounts, charges, debts,
// expenses, notifications, CSV export. Access: role=manager only.
import { route } from './router.js';
import {
  json, fail, now, getSettings, setSetting, splitEqual, splitByArea,
  csvResponse, xlsResponse, getAllUnits, validUsername, validPassword,
  normalizeTelegramUsername, validTelegramUsername, APP_VERSION
} from './helpers.js';
import { hashPassword, publicUser, bumpTokenEpoch } from './auth.js';
import { isPeriod, isJalaliYear, periodLabel, faNum, currentPeriod, tehranParts, toJalaaliFromParts, J_MONTHS } from './jalali.js';
import { sendTelegramMessage, getBotToken, sendPersonalToUser } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { b64ToBytes, bytesToB64 } from './tasks.js';
import { buildZip, safeEntryName } from '../public/js/lib/zip.js';
import {
  runAutoReminder, readAutoCfg, autoRemindStats, rememberAppUrl,
  renderRemindText, DEFAULT_REMIND_TEXT
} from './scheduler.js';
import { registerCredit, unitCredit, unitDebtRemaining, autoConsumeCredit, creditTotal } from './credits.js';

// ---------------------------------------------------------------------------
// UNITS
// ---------------------------------------------------------------------------
// Users often type «واحد 2» into the unit-number field, which made labels
// render as «واحد واحد 2». Strip the word on write and on display.
export function normalizeUnitNumber(v) {
  return String(v ?? '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim().slice(0, 20);
}

route('GET', '/units', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT u.*,
           COALESCE(t.issued, 0) AS issued, COALESCE(t.paid, 0) AS paid,
           COALESCE(cr.credit, 0) AS credit,
           acc.id AS account_id, acc.username AS account_username,
           acc.is_active AS account_active, acc.telegram_user_id AS account_telegram
    FROM units u
    LEFT JOIN (
      SELECT unit_id, SUM(amount) AS issued, SUM(paid_amount) AS paid
      FROM debts GROUP BY unit_id
    ) t ON t.unit_id = u.id
    LEFT JOIN (
      SELECT unit_id, SUM(amount) AS credit
      FROM unit_credits GROUP BY unit_id
    ) cr ON cr.unit_id = u.id
    LEFT JOIN users acc ON acc.unit_id = u.id AND acc.role = 'resident'
    ORDER BY LENGTH(u.number), u.number
  `).all();
  // v2.17.0 — واحدِ متصل به حساب مدیر ساختمان: همان یوزر/پسورد پنل اصلی پوششش
  // می‌دهد؛ مودال واحد دیگر «ساخت حساب ساکن» پیشنهاد نمی‌دهد.
  const { results: mgrAccs } = await c.env.DB.prepare(`
    SELECT id, username, full_name, unit_id, telegram_user_id, is_active, is_resident
    FROM users WHERE role = 'manager' AND unit_id IS NOT NULL ORDER BY id
  `).all();
  const mgrByUnit = new Map();
  for (const m of mgrAccs || []) {
    if (!mgrByUnit.has(m.unit_id)) mgrByUnit.set(m.unit_id, {
      username: m.username, full_name: m.full_name || '',
      telegram_linked: Boolean(m.telegram_user_id), is_active: Boolean(m.is_active),
      is_resident: Number(m.is_resident === undefined ? 1 : m.is_resident) !== 0
    });
  }
  const units = (results || []).map(r => ({
    ...r,
    debt: Math.max(0, (r.issued || 0) - (r.paid || 0)),
    credit: Math.max(0, Number(r.credit) || 0),
    has_account: Boolean(r.account_id),
    manager_account: mgrByUnit.get(r.id) || null
  }));
  return json({ units });
}, 'manager');

route('POST', '/units', async (c) => {
  const b = c.body || {};
  const number = normalizeUnitNumber(b.number);
  if (!number) return fail('شماره واحد الزامی است');
  const residentName = String(b.resident_name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 20);
  const area = Math.max(0, Number(b.area_m2) || 0);
  const residents = Math.max(1, Math.round(Number(b.residents_count) || 1));
  const note = String(b.note || '').trim().slice(0, 300);
  try {
    const res = await c.env.DB.prepare(`
      INSERT INTO units (number, resident_name, phone, area_m2, residents_count, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(number, residentName, phone, area, residents, note, now()).run();
    const row = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?')
      .bind(res.meta.last_row_id).first();
    return json({ unit: row }, 201);
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) return fail('شماره واحد تکراری است', 409);
    throw e;
  }
}, 'manager');

route('PUT', '/units/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(id).first();
  if (!row) return fail('واحد پیدا نشد', 404);
  const b = c.body || {};
  const number = b.number !== undefined ? normalizeUnitNumber(b.number) : row.number;
  if (!number) return fail('شماره واحد الزامی است');
  const residentName = b.resident_name !== undefined ? String(b.resident_name).trim().slice(0, 80) : row.resident_name;
  const phone = b.phone !== undefined ? String(b.phone).trim().slice(0, 20) : row.phone;
  const area = b.area_m2 !== undefined ? Math.max(0, Number(b.area_m2) || 0) : row.area_m2;
  const residents = b.residents_count !== undefined ? Math.max(1, Math.round(Number(b.residents_count) || 1)) : row.residents_count;
  const note = b.note !== undefined ? String(b.note).trim().slice(0, 300) : row.note;
  try {
    await c.env.DB.prepare(`
      UPDATE units SET number=?, resident_name=?, phone=?, area_m2=?, residents_count=?, note=?
      WHERE id=?
    `).bind(number, residentName, phone, area, residents, note, id).run();
    const updated = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(id).first();
    return json({ unit: updated });
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) return fail('شماره واحد تکراری است', 409);
    throw e;
  }
}, 'manager');

route('DELETE', '/units/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM units WHERE id = ?').bind(id).first();
  if (!row) return fail('واحد پیدا نشد', 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM users WHERE unit_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM debts WHERE unit_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM units WHERE id = ?').bind(id)
  ]);
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// RESIDENT ACCOUNTS (نام کاربری و رمز برای هر ساکن)
// ---------------------------------------------------------------------------
route('GET', '/residents', async (c) => {
  const unitId = Number(c.query.get('unit_id') || 0);
  const { results } = unitId
    ? await c.env.DB.prepare(`
        SELECT r.*, u.number AS unit_number FROM users r
        LEFT JOIN units u ON u.id = r.unit_id
        WHERE r.role = 'resident' AND r.unit_id = ?
        ORDER BY r.id
      `).bind(unitId).all()
    : await c.env.DB.prepare(`
        SELECT r.*, u.number AS unit_number FROM users r
        LEFT JOIN units u ON u.id = r.unit_id
        WHERE r.role = 'resident'
        ORDER BY LENGTH(u.number), u.number, r.id
      `).all();
  return json({ residents: (results || []).map(publicUser) });
}, 'manager');

route('POST', '/residents', async (c) => {
  const b = c.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const unitId = Number(b.unit_id || 0);
  const tgUsername = normalizeTelegramUsername(b.telegram_username);
  if (!validUsername(username)) return fail('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
  if (!validPassword(password)) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');
  if (!validTelegramUsername(tgUsername)) {
    return fail('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
  }
  const unit = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(unitId).first();
  if (!unit) return fail('واحد پیدا نشد', 404);
  const existing = await c.env.DB.prepare(
    "SELECT id FROM users WHERE role = 'resident' AND unit_id = ? LIMIT 1"
  ).bind(unitId).first();
  if (existing) return fail('این واحد قبلاً حساب ساکن دارد؛ ابتدا حساب قبلی را حذف کنید', 409);
  const dup = await c.env.DB.prepare(
    'SELECT id FROM users WHERE lower(username) = ? LIMIT 1'
  ).bind(username).first();
  if (dup) return fail('این نام کاربری قبلاً استفاده شده است', 409);

  const hash = await hashPassword(password);
  const res = await c.env.DB.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, phone, unit_id, telegram_username, is_active, created_by, created_at)
    VALUES (?, ?, 'resident', ?, ?, ?, ?, 1, ?, ?)
  `).bind(username, hash, String(b.full_name || unit.resident_name || '').trim().slice(0, 80),
    String(b.phone || unit.phone || '').trim().slice(0, 20),
    unitId, tgUsername, c.user.id, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ resident: publicUser(row) }, 201);
}, 'manager');

route('PUT', '/residents/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ? AND role = 'resident'").bind(id).first();
  if (!row) return fail('حساب ساکن پیدا نشد', 404);
  const b = c.body || {};

  // username change (v2.11.0) — validated + unique (case-insensitive)
  let newUsername = row.username;
  if (b.username !== undefined) {
    newUsername = String(b.username).trim().toLowerCase();
    if (!validUsername(newUsername)) return fail('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
    if (newUsername !== row.username) {
      const dup = await c.env.DB.prepare('SELECT id FROM users WHERE lower(username) = ? AND id != ? LIMIT 1')
        .bind(newUsername, id).first();
      if (dup) return fail('این نام کاربری قبلاً استفاده شده است', 409);
    }
  }

  const fullName = b.full_name !== undefined ? String(b.full_name).trim().slice(0, 80) : row.full_name;
  const phone = b.phone !== undefined ? String(b.phone).trim().slice(0, 20) : row.phone;
  let tgUsername = row.telegram_username || '';
  if (b.telegram_username !== undefined) {
    tgUsername = normalizeTelegramUsername(b.telegram_username);
    if (!validTelegramUsername(tgUsername)) {
      return fail('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
    }
  }
  let isActive = row.is_active;
  if (b.is_active !== undefined) isActive = b.is_active ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET username = ?, full_name = ?, phone = ?, is_active = ?, telegram_username = ? WHERE id = ?')
    .bind(newUsername, fullName, phone, isActive, tgUsername, id).run();
  if (b.password !== undefined && b.password !== '') {
    if (!validPassword(String(b.password))) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');
    const hash = await hashPassword(String(b.password));
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, id).run();
    // v2.14.0 — password change revokes the resident's existing sessions
    await bumpTokenEpoch(c.env, id);
  }
  const updated = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return json({ resident: publicUser(updated) });
}, 'manager');

// Personal Telegram message to one resident from the building-manager panel.
route('POST', '/residents/:id/message', async (c) => {
  const r = await sendPersonalToUser(c.env, Number(c.params.id), String((c.body || {}).text || ''), c.ctx);
  if (!r.ok) return fail(r.error, r.status || 500, r.code);
  return json({ ok: true, user: r.user });
}, 'manager');

route('DELETE', '/residents/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE id = ? AND role = 'resident'").bind(id).first();
  if (!row) return fail('حساب ساکن پیدا نشد', 404);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// DEBTS (ledger items)
// ---------------------------------------------------------------------------
route('GET', '/debts', async (c) => {
  const q = c.query;
  const where = [];
  const binds = [];
  if (q.get('period')) { where.push('d.period = ?'); binds.push(q.get('period')); }
  if (q.get('unit_id')) { where.push('d.unit_id = ?'); binds.push(Number(q.get('unit_id'))); }
  if (q.get('kind')) { where.push('d.kind = ?'); binds.push(q.get('kind')); }
  const status = q.get('status');
  if (status === 'unpaid') where.push("d.status IN ('unpaid','partial')");
  else if (status === 'paid') where.push("d.status = 'paid'");
  const sql = `
    SELECT d.*, u.number AS unit_number, u.resident_name
    FROM debts d JOIN units u ON u.id = d.unit_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.period DESC, LENGTH(u.number), u.number, d.id
    LIMIT 2000
  `;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return json({ debts: results || [] });
}, 'manager');

route('POST', '/debts', async (c) => {
  const b = c.body || {};
  const unitId = Number(b.unit_id);
  const amount = Math.round(Number(b.amount) || 0);
  const period = String(b.period || '').trim();
  const description = String(b.description || '').trim().slice(0, 120) || 'قلم دستی';
  if (!unitId) return fail('واحد مشخص نشده است');
  if (!isPeriod(period)) return fail('ماه نامعتبر است');
  if (amount <= 0) return fail('مبلغ باید بزرگ‌تر از صفر باشد');
  const unit = await c.env.DB.prepare('SELECT id FROM units WHERE id = ?').bind(unitId).first();
  if (!unit) return fail('واحد پیدا نشد', 404);
  const res = await c.env.DB.prepare(`
    INSERT INTO debts (unit_id, kind, period, description, amount, created_at)
    VALUES (?, 'custom', ?, ?, ?, ?)
  `).bind(unitId, period, description, amount, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ debt: row }, 201);
}, 'manager');

// Generate monthly charges — v2.15.0: for ALL units or a selected subset
// (b.unit_ids = array of unit ids; empty/missing = every unit)
route('POST', '/charges/generate', async (c) => {
  const b = c.body || {};
  const period = String(b.period || '').trim();
  const mode = ['fixed', 'area', 'person'].includes(b.mode) ? b.mode : 'fixed';
  const amount = Math.round(Number(b.amount) || 0);
  if (!isPeriod(period)) return fail('ماه نامعتبر است');
  if (amount <= 0) return fail('مبلغ باید بزرگ‌تر از صفر باشد');

  // v2.15.0 — انتخاب واحدها: فقط شناسه‌های عددیِ موجود پذیرفته می‌شوند
  let idFilter = null;
  if (Array.isArray(b.unit_ids) && b.unit_ids.length) {
    idFilter = new Set(b.unit_ids.map(x => Number(x) || 0).filter(Boolean));
    if (!idFilter.size) return fail('واحدی برای صدور انتخاب نشده است');
  }

  const units = await getAllUnits(c.env);
  if (units.length === 0) return fail('ابتدا واحدها را ثبت کنید');
  const targets = idFilter ? units.filter(u => idFilter.has(u.id)) : units;
  if (idFilter && targets.length === 0) return fail('هیچ‌کدام از واحدهای انتخابی پیدا نشد', 404);

  const { results: existing } = await c.env.DB.prepare(
    "SELECT unit_id FROM debts WHERE period = ? AND kind = 'monthly'"
  ).bind(period).all();
  const existingSet = new Set((existing || []).map(r => r.unit_id));

  const desc = 'شارژ ماه ' + periodLabel(period);
  const stmts = [];
  const noArea = [];
  for (const u of targets) {
    if (existingSet.has(u.id)) continue;
    let amt = 0;
    if (mode === 'fixed') amt = amount;
    else if (mode === 'person') amt = Math.round(amount * (u.residents_count || 1));
    else if (mode === 'area') {
      if (!u.area_m2) { noArea.push(u.number); continue; }
      amt = Math.round(amount * u.area_m2);
    }
    if (amt > 0) {
      stmts.push(c.env.DB.prepare(`
        INSERT INTO debts (unit_id, kind, period, description, amount, created_at)
        VALUES (?, 'monthly', ?, ?, ?, ?)
      `).bind(u.id, period, desc, amt, now()));
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  // v2.21.0 — مصرف خودکار اعتبار اضافه‌پرداخت: قلم شارژِ تازه‌صادرهٔ هر واحدی که
  // اعتبار دارد تا سقف اعتبارش «پیش‌پرداخت» می‌شود (ساکن همان اول می‌بیند که
  // برای این ماه چقدر باید بپردازد). ترتیبی — تلهٔ concurrency در D1.
  let creditUsedTotal = 0;
  let creditUnits = 0;
  const newUnits = targets.filter(u => !existingSet.has(u.id));
  if (newUnits.length) {
    const marks = newUnits.map(() => '?').join(',');
    const { results: newDebts } = await c.env.DB.prepare(
      `SELECT id, unit_id, amount, paid_amount FROM debts WHERE period = ? AND kind = 'monthly' AND unit_id IN (${marks})`
    ).bind(period, ...newUnits.map(u => u.id)).all();
    const byUnit = new Map();
    for (const d of newDebts || []) {
      if (!byUnit.has(d.unit_id)) byUnit.set(d.unit_id, []);
      byUnit.get(d.unit_id).push(d);
    }
    for (const u of newUnits) {
      const rows = byUnit.get(u.id) || [];
      if (!rows.length) continue;
      const { used } = await autoConsumeCredit(c.env, u.id, { period });
      if (used > 0) { creditUsedTotal += used; creditUnits++; }
    }
  }

  return json({
    created: stmts.length, skipped: existingSet.size, no_area: noArea,
    credit_used_total: creditUsedTotal, credit_units: creditUnits
  });
}, 'manager');

route('POST', '/debts/:id/pay', async (c) => {
  const id = Number(c.params.id);
  const debt = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first();
  if (!debt) return fail('قلم بدهی پیدا نشد', 404);
  const remaining = debt.amount - debt.paid_amount;
  if (remaining <= 0) return fail('این قلم قبلاً تسویه شده است', 409);

  const b = c.body || {};
  let amt = b.amount == null ? remaining : Math.round(Number(b.amount) || 0);
  if (!(amt > 0)) return fail('مبلغ نامعتبر است');
  // v2.21.0 — اضافه‌پرداخت: اگر مبلغ از مانده بیشتر باشد، مودی باید صریحاً تأیید کند
  // (overpay=true) تا مابه‌التفاوت به‌عنوان اعتبار اضافه‌پرداخت واحد ثبت شود.
  if (amt > remaining && !b.overpay) {
    return fail('مبلغ بیشتر از مانده بدهی است؛ مابه‌التفاوت به‌عنوان اعتبار اضافه‌پرداخت ثبت شود؟', 400, 'overpay_possible');
  }
  const applied = Math.min(amt, remaining);
  const excess = amt - applied;

  const paid = debt.paid_amount + applied;
  const status = paid >= debt.amount ? 'paid' : 'partial';
  const paidAt = b.date ? Number(b.date) || now() : now();
  const method = String(b.method || '').slice(0, 50);
  const note = b.note ? String(debt.note || '').slice(0, 200) + (debt.note ? ' | ' : '') + String(b.note).slice(0, 200) : debt.note;

  await c.env.DB.prepare(
    'UPDATE debts SET paid_amount = ?, status = ?, paid_at = ?, method = ?, note = ? WHERE id = ?'
  ).bind(paid, status, paidAt, method, note || '', id).run();

  // v2.21.0 — مابه‌التفاوت به دفتر اعتبار واحد می‌رود (پیش‌پرداخت ماه‌های بعد)
  let credited = 0;
  let creditBalance = null;
  if (excess > 0) {
    credited = await registerCredit(c.env, debt.unit_id, excess, {
      period: debt.period || '',
      note: 'اضافه‌پرداخت هنگام ثبت پرداخت' + (b.note ? ' — ' + String(b.note).slice(0, 120) : ''),
      createdBy: c.user.id
    });
    creditBalance = await unitCredit(c.env, debt.unit_id);
  }

  const updated = await c.env.DB.prepare(
    'SELECT d.*, u.number AS unit_number, u.resident_name FROM debts d JOIN units u ON u.id = d.unit_id WHERE d.id = ?'
  ).bind(id).first();
  return json({ debt: updated, applied, credited, credit_balance: creditBalance });
}, 'manager');

route('POST', '/debts/:id/unpay', async (c) => {
  const id = Number(c.params.id);
  const debt = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first();
  if (!debt) return fail('قلم بدهی پیدا نشد', 404);
  await c.env.DB.prepare(
    "UPDATE debts SET paid_amount = 0, status = 'unpaid', paid_at = NULL, method = '' WHERE id = ?"
  ).bind(id).run();
  const updated = await c.env.DB.prepare(
    'SELECT d.*, u.number AS unit_number, u.resident_name FROM debts d JOIN units u ON u.id = d.unit_id WHERE d.id = ?'
  ).bind(id).first();
  return json({ debt: updated });
}, 'manager');

// v2.12.0 — ویرایش پرداختِ ثبت‌شده بدون لغو آن: مبلغ پرداخت، روش، تاریخ و
// یادداشت مستقیماً به‌روز می‌شود (یادداشت «جایگزین» می‌شود نه الحاق).
route('POST', '/debts/:id/pay-edit', async (c) => {
  const id = Number(c.params.id);
  const debt = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first();
  if (!debt) return fail('قلم بدهی پیدا نشد', 404);

  const b = c.body || {};
  const amt = Math.round(Number(b.amount) || 0);
  if (!(amt > 0)) return fail('مبلغ پرداخت باید بزرگ‌تر از صفر باشد');
  if (amt > debt.amount) return fail('مبلغ پرداخت نمی‌تواند از مبلغ کل بیشتر باشد');

  const status = amt >= debt.amount ? 'paid' : 'partial';
  const paidAt = b.date ? (Number(b.date) || now()) : (debt.paid_at || now());
  const method = b.method !== undefined ? String(b.method).trim().slice(0, 50) : String(debt.method || '');
  const note = b.note !== undefined ? String(b.note).trim().slice(0, 200) : String(debt.note || '');

  await c.env.DB.prepare(
    'UPDATE debts SET paid_amount = ?, status = ?, paid_at = ?, method = ?, note = ? WHERE id = ?'
  ).bind(amt, status, paidAt, method, note, id).run();

  const updated = await c.env.DB.prepare(
    'SELECT d.*, u.number AS unit_number, u.resident_name FROM debts d JOIN units u ON u.id = d.unit_id WHERE d.id = ?'
  ).bind(id).first();
  return json({ debt: updated });
}, 'manager');

route('DELETE', '/debts/:id', async (c) => {
  const id = Number(c.params.id);
  const debt = await c.env.DB.prepare('SELECT * FROM debts WHERE id = ?').bind(id).first();
  if (!debt) return fail('قلم بدهی پیدا نشد', 404);
  await c.env.DB.prepare('DELETE FROM debts WHERE id = ?').bind(id).run();
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// EXPENSES (building-wide, auto-split into per-unit debts)
// ---------------------------------------------------------------------------
route('GET', '/expenses', async (c) => {
  const q = c.query;
  const period = q.get('period');
  const sql = `
    SELECT e.*,
      (SELECT COUNT(*) FROM debts d WHERE d.expense_id = e.id) AS share_count,
      (SELECT COALESCE(SUM(d.paid_amount), 0) FROM debts d WHERE d.expense_id = e.id) AS collected
    FROM expenses e
    ${period ? 'WHERE e.period = ?' : ''}
    ORDER BY e.created_at DESC
  `;
  const { results } = period
    ? await c.env.DB.prepare(sql).bind(period).all()
    : await c.env.DB.prepare(sql).all();
  return json({ expenses: results || [] });
}, 'manager');

route('POST', '/expenses', async (c) => {
  const b = c.body || {};
  const title = String(b.title || '').trim().slice(0, 100);
  const category = String(b.category || 'سایر').trim().slice(0, 40) || 'سایر';
  const amount = Math.round(Number(b.amount) || 0);
  const period = String(b.period || '').trim();
  const splitMode = b.split_mode === 'area' ? 'area' : 'equal';
  const spentAt = b.date ? Number(b.date) || now() : now();
  const note = String(b.note || '').trim().slice(0, 300);

  if (!title) return fail('عنوان هزینه الزامی است');
  if (!isPeriod(period)) return fail('ماه نامعتبر است');
  if (amount <= 0) return fail('مبلغ باید بزرگ‌تر از صفر باشد');

  const units = await getAllUnits(c.env);
  if (units.length === 0) return fail('ابتدا واحدها را ثبت کنید');

  let shares = splitMode === 'area' ? splitByArea(amount, units) : null;
  const usedMode = shares ? 'area' : 'equal';
  if (!shares) shares = splitEqual(amount, units.length);

  const res = await c.env.DB.prepare(`
    INSERT INTO expenses (title, category, amount, period, split_mode, spent_at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(title, category, amount, period, usedMode, spentAt, note, now()).run();
  const expenseId = res.meta.last_row_id;

  const desc = 'سهم هزینه: ' + title;
  const stmts = [];
  units.forEach((u, i) => {
    const share = shares[i];
    if (share > 0) {
      stmts.push(c.env.DB.prepare(`
        INSERT INTO debts (unit_id, kind, expense_id, period, description, amount, created_at)
        VALUES (?, 'expense', ?, ?, ?, ?, ?)
      `).bind(u.id, expenseId, period, desc, share, now()));
    }
  });
  if (stmts.length) await c.env.DB.batch(stmts);

  return json({
    expense_id: expenseId,
    split_mode: usedMode,
    share_count: stmts.length,
    distributed: shares.reduce((a, x) => a + x, 0)
  }, 201);
}, 'manager');

route('DELETE', '/expenses/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM expenses WHERE id = ?').bind(id).first();
  if (!row) return fail('هزینه پیدا نشد', 404);
  const paidRow = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM debts WHERE expense_id = ? AND paid_amount > 0'
  ).bind(id).first();
  if (paidRow && paidRow.c > 0) {
    return fail('برای حذف این هزینه، ابتدا پرداخت‌های مرتبط با آن را لغو کنید', 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM debts WHERE expense_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id)
  ]);
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// NOTIFY (reminders / announcements via bot)
// ---------------------------------------------------------------------------
const NOTIFY_CAP = 40;

// Pre-flight info so the reminder button can explain itself:
// bot token missing? any linked residents? any debtor units?
// v2.17.0 — مدیرِ ساکن (بدون تیک «ساکن نیست») هم در شمارِ گیرندگان است
route('GET', '/notify/preview', async (c) => {
  const debtorsRow = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT unit_id) AS c FROM debts WHERE amount > paid_amount'
  ).first();
  const token = await getBotToken(c.env);
  let linked = 0;
  if (token) {
    const row = await c.env.DB.prepare(`
      SELECT COUNT(*) AS c FROM users
      WHERE is_active = 1 AND telegram_user_id IS NOT NULL AND unit_id IS NOT NULL
        AND (role = 'resident' OR (role = 'manager' AND COALESCE(is_resident, 1) = 1))
    `).first();
    linked = row ? row.c : 0;
  }
  return json({
    bot_configured: Boolean(token),
    linked_residents: linked,
    debtor_units: debtorsRow ? debtorsRow.c : 0
  });
}, 'manager');

route('POST', '/notify/reminders', async (c) => {
  const botToken = await getBotToken(c.env);
  if (!botToken) return json({ sent: 0, failed: 0, skipped: 'bot_token_missing' });
  // v2.17.0 — مدیرِ ساکن هم جزو بدهکاران شارژ است و یادآوری می‌گیرد (مگر با
  // تیک «مدیر، ساکن ساختمان نیست» در پنل مدیریت اپ). اگر واحد هم حساب ساکن
  // و هم حساب مدیر داشته باشد فقط یک پیام برای آن واحد می‌رود (اولویت ساکن).
  const { results } = await c.env.DB.prepare(`
    SELECT acc.id AS acc_id, acc.role AS acc_role, acc.telegram_user_id, acc.full_name,
           u.id AS unit_id, u.number,
           COALESCE(SUM(d.amount - d.paid_amount), 0) AS debt
    FROM users acc
    JOIN units u ON u.id = acc.unit_id
    JOIN debts d ON d.unit_id = u.id
    WHERE acc.is_active = 1 AND acc.telegram_user_id IS NOT NULL
      AND (acc.role = 'resident' OR (acc.role = 'manager' AND COALESCE(acc.is_resident, 1) = 1))
    GROUP BY acc.id
    ORDER BY debt DESC
  `).all();
  const byUnit = new Map();
  for (const r of (results || []).sort((a, b) => (a.acc_role === 'resident' ? 0 : 1) - (b.acc_role === 'resident' ? 0 : 1))) {
    if (!byUnit.has(r.unit_id)) byUnit.set(r.unit_id, r);
  }
  const targets0 = [...byUnit.values()].filter(r => r.debt > 0).sort((a, b) => b.debt - a.debt);
  const results2 = targets0.slice(0, NOTIFY_CAP);
  if (!results2.length) {
    return json({ sent: 0, failed: 0, skipped: 'no_targets', linked: 0 });
  }
  const s = await getSettings(c.env);
  const buildingName = s.building_name || 'ساختمان';
  const origin = new URL(c.request.url).origin;
  // persist the origin so the cron-triggered reminders can attach the app button
  await rememberAppUrl(c.env, origin);
  let sent = 0, failed = 0;
  const errors = [];
  for (const r of results2) {
    const text = `${buildingName} — واحد ${faNum(String(r.number || '').replace(/^واحد[\s._\-–—]*/u, '').trim())}\n` +
      `${r.full_name ? r.full_name + ' عزیز، ' : ''}مانده بدهی شما بالغ بر ${faNum(Number(r.debt).toLocaleString('en-US'))} تومان است.` +
      `\nلطفاً نسبت به تسویه اقدام فرمایید. با تشکر`;
    const res = await sendTelegramMessage(botToken, r.telegram_user_id, text, {
      inline_keyboard: [[{ text: 'مشاهده شارژ ساختمان', web_app: { url: origin } }]]
    });
    if (res.ok) {
      sent++;
      // v2.19.0 — ثبت پیام ارسالی یادآوری دستی در «گزارش پیام‌های ربات»
      try { await logOutgoingBotMessage(c.env, { chatId: r.telegram_user_id, text, title: 'یادآوری دستی' }, c.ctx); } catch { /* never break */ }
    }
    else { failed++; errors.push({ unit: r.number, reason: res.error }); }
  }
  // v2.14.0 — «تعداد یادآوری»: count reminders per unit (unpaid items only)
  try {
    for (const r of results2) {
      await c.env.DB.prepare(
        'UPDATE debts SET remind_count = remind_count + 1, last_remind_at = ? WHERE unit_id = ? AND paid_amount < amount'
      ).bind(now(), r.unit_id).run();
    }
  } catch { /* schema older than v7 → skip counting */ }
  return json({ sent, failed, errors, targets: results2.length, capped: targets0.length >= NOTIFY_CAP });
}, 'manager');

route('POST', '/notify/announce', async (c) => {
  const text = String((c.body || {}).text || '').trim();
  if (!text) return fail('متن اعلان را وارد کنید');
  const botToken = await getBotToken(c.env);
  if (!botToken) return json({ sent: 0, failed: 0, skipped: 'bot_token_missing' });
  const { results } = await c.env.DB.prepare(`
    SELECT acc.telegram_user_id, u.number FROM users acc
    JOIN units u ON u.id = acc.unit_id
    WHERE acc.role = 'resident' AND acc.is_active = 1 AND acc.telegram_user_id IS NOT NULL
    LIMIT ${NOTIFY_CAP}
  `).all();
  const s = await getSettings(c.env);
  const buildingName = s.building_name || 'ساختمان';
  let sent = 0, failed = 0;
  const errors = [];
  for (const r of results || []) {
    const res = await sendTelegramMessage(botToken, r.telegram_user_id, `${buildingName}\n\n${text}`);
    if (res.ok) {
      sent++;
      // v2.19.0 — ثبت اعلان همگانی در «گزارش پیام‌های ربات»
      try { await logOutgoingBotMessage(c.env, { chatId: r.telegram_user_id, text: `${buildingName}\n\n${text}`, title: 'اعلان همگانی' }, c.ctx); } catch { /* never break */ }
    }
    else { failed++; errors.push({ unit: r.number, reason: res.error }); }
  }
  return json({ sent, failed, errors, capped: (results || []).length >= NOTIFY_CAP });
}, 'manager');

// ---------------------------------------------------------------------------
// AUTOMATIC MONTHLY REMINDER (یادآوری خودکار ماهانه)
// The schedule itself is a Cloudflare Cron Trigger (wrangler.jsonc) that calls
// runAutoReminder() daily at 09:00 Tehran; these routes let the manager
// configure, preview, test and fire it manually.
// ---------------------------------------------------------------------------
route('GET', '/autoremind', async (c) => {
  const s = await getSettings(c.env);
  const stats = await autoRemindStats(c.env);
  const token = await getBotToken(c.env);
  return json({
    cfg: readAutoCfg(s),
    stats,
    bot_configured: Boolean(token),
    default_text: DEFAULT_REMIND_TEXT
  });
}, 'manager');

route('PUT', '/autoremind', async (c) => {
  const b = c.body || {};
  if (b.enabled !== undefined) await setSetting(c.env, 'auto_reminder_enabled', b.enabled ? '1' : '0');
  if (b.day !== undefined) {
    const day = Math.round(Number(b.day) || 0);
    if (!(day >= 1 && day <= 29)) return fail('روز ارسال باید بین ۱ تا ۲۹ باشد');
    await setSetting(c.env, 'auto_reminder_day', String(day));
  }
  // v2.14.0 — «تعداد یادآوری در ماه» (۱ تا ۴ مرحله)
  if (b.count !== undefined) {
    const count = Math.round(Number(b.count) || 0);
    if (!(count >= 1 && count <= 4)) return fail('تعداد یادآوری باید بین ۱ تا ۴ باشد');
    await setSetting(c.env, 'auto_reminder_count', String(count));
  }
  if (b.text !== undefined) {
    const text = String(b.text).trim();
    if (!text) return fail('متن پیام الزامی است');
    if (text.length > 800) return fail('متن پیام حداکثر ۸۰۰ کاراکتر است');
    if (!/\{(name|unit|amount)\}/.test(text)) {
      return fail('متن باید حداقل یکی از متغیرهای {name}، {unit} یا {amount} را داشته باشد');
    }
    await setSetting(c.env, 'auto_reminder_text', text);
  }
  const s = await getSettings(c.env);
  return json({ cfg: readAutoCfg(s) });
}, 'manager');

// manual run («ارسال همین حالا») — also marks the month so the cron won't repeat it
route('POST', '/autoremind/run', async (c) => {
  const origin = new URL(c.request.url).origin;
  await rememberAppUrl(c.env, origin);
  const result = await runAutoReminder(c.env, { force: true, origin });
  return json({ result });
}, 'manager');

// sends a sample message with the current template to the manager's own Telegram
route('POST', '/autoremind/test', async (c) => {
  const botToken = await getBotToken(c.env);
  if (!botToken) return fail('ابتدا توکن ربات را در پنل مدیریت اپ ثبت کنید', 400, 'bot_token_missing');
  if (!c.user.telegram_user_id) {
    return fail('حساب شما به تلگرام متصل نیست؛ یک بار داخل تلگرام وارد اپ شوید', 400, 'not_linked');
  }
  const s = await getSettings(c.env);
  const cfg = readAutoCfg(s);
  const unit = c.user.unit_id
    ? await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(c.user.unit_id).first()
    : null;
  let amount = 2500000; // sample when the manager has no unit / no debt
  if (unit) {
    const row = await c.env.DB.prepare(
      'SELECT COALESCE(SUM(amount - paid_amount), 0) AS debt FROM debts WHERE unit_id = ?'
    ).bind(unit.id).first();
    if (row && row.debt > 0) amount = row.debt;
  }
  const text = renderRemindText(cfg.text, {
    building: s.building_name || 'ساختمان',
    name: c.user.full_name || 'مدیر ساختمان',
    unit: unit ? String(unit.number).replace(/^واحد[\s._\-–—]*/u, '').trim() : '۱۰۵',
    amount,
    month: periodLabel(currentPeriod())
  });
  const res = await sendTelegramMessage(botToken, c.user.telegram_user_id, text, {
    inline_keyboard: [[{ text: '🏢 باز کردن اپ ساختمان', web_app: { url: new URL(c.request.url).origin } }]]
  });
  if (!res.ok) return fail('ارسال پیام آزمایشی ناموفق بود: ' + (res.error || ''), 502, 'send_failed');
  // v2.19.0 — ثبت پیام آزمایشی در «گزارش پیام‌های ربات»
  try { await logOutgoingBotMessage(c.env, { chatId: c.user.telegram_user_id, text, title: 'پیام آزمایشی' }, c.ctx); } catch { /* never break */ }
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// EXPORT (CSV / JSON backup)
// ---------------------------------------------------------------------------
route('GET', '/export', async (c) => {
  const type = c.query.get('type') || 'debtors';
  const jy = isJalaliYear(c.query.get('jy') || '') ? c.query.get('jy') : null;
  // v2.14.0: fmt=xls -> Excel-friendly .xls (HTML table, UTF-8) that opens with
  // correct columns in every Excel locale; fmt=csv stays the RFC comma format.
  // v2.15.0: fmt=zip for type=backup → backup.json (+ attachments) in ONE zip.
  const fmtRaw = c.query.get('fmt') || '';
  const fmt = ['xls', 'zip'].includes(fmtRaw) ? fmtRaw : 'csv';

  const jalaliDate = ts => {
    if (!ts) return '-';
    const p = tehranParts(ts);
    const j = toJalaaliFromParts(p.gy, p.gm, p.gd);
    return `${faNum(j.jd)} ${J_MONTHS[j.jm - 1]} ${faNum(j.jy)}`;
  };

  if (type === 'debtors') {
    // v2.21.0 — ستون «اعتبار واحد»: مانده پس از اعتبار هم جداگانه می‌آید
    const { results } = await c.env.DB.prepare(`
      SELECT u.number, u.resident_name, u.phone,
             COALESCE(SUM(d.amount - d.paid_amount), 0) AS debt,
             COALESCE(cr.credit, 0) AS credit,
             COALESCE(MAX(CASE WHEN d.paid_amount < d.amount THEN d.remind_count END), 0) AS remind_count,
             MAX(CASE WHEN d.paid_amount < d.amount THEN d.last_remind_at END) AS last_remind_at
      FROM units u
      LEFT JOIN debts d ON d.unit_id = u.id
      LEFT JOIN (SELECT unit_id, SUM(amount) AS credit FROM unit_credits GROUP BY unit_id) cr ON cr.unit_id = u.id
      GROUP BY u.id
      HAVING debt > 0
      ORDER BY debt DESC
    `).all();
    const rows = [['شماره واحد', 'ساکن', 'تلفن', 'مانده بدهی (تومان)', 'اعتبار واحد (تومان)', 'مانده پس از اعتبار (تومان)', 'تعداد یادآوری', 'آخرین یادآوری']];
    for (const r of results || []) {
      const credit = Math.max(0, Number(r.credit) || 0);
      rows.push([
        r.number, r.resident_name || '', r.phone || '', r.debt, credit,
        Math.max(0, Number(r.debt) - credit),
        r.remind_count || 0, jalaliDate(r.last_remind_at)
      ]);
    }
    return fmt === 'xls' ? xlsResponse('debtors.xls', rows) : csvResponse('debtors.csv', rows);
  }

  if (type === 'year') {
    const year = jy || currentPeriod().slice(0, 4);
    const { results } = await c.env.DB.prepare(`
      SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected
      FROM debts WHERE period LIKE ?
      GROUP BY period ORDER BY period
    `).bind(year + '-%').all();
    const rows = [['ماه', 'صادرشده (تومان)', 'وصول‌شده (تومان)', 'مانده (تومان)']];
    for (const r of results || []) {
      rows.push([periodLabel(r.period), r.issued, r.collected, r.issued - r.collected]);
    }
    return fmt === 'xls' ? xlsResponse(`year-${year}.xls`, rows) : csvResponse(`year-${year}.csv`, rows);
  }

  if (type === 'backup') {
    // v2.14.0: sequential reads — one Promise.all with 10 parallel D1 queries
    // can trip the production concurrency limit and kill the whole download.
    const units = await c.env.DB.prepare('SELECT * FROM units ORDER BY id').all();
    const debts = await c.env.DB.prepare('SELECT * FROM debts ORDER BY id').all();
    const expenses = await c.env.DB.prepare('SELECT * FROM expenses ORDER BY id').all();
    const settings = await c.env.DB.prepare("SELECT key, value FROM settings WHERE key != 'session_secret'").all();
    // full-fidelity users (v2.11.0): password_hash + telegram fields included so a
    // restore brings the logins back too — the file must be kept private anyway
    // v2.17.0: bound_tg_id (قفل پروفایل) و is_resident (مدیر ساکن) هم می‌آیند
    const users = await c.env.DB.prepare('SELECT id, username, password_hash, role, full_name, phone, unit_id, telegram_user_id, telegram_username, is_active, token_epoch, bound_tg_id, is_resident, created_by, created_at FROM users ORDER BY id').all();
    const polls = await c.env.DB.prepare('SELECT * FROM polls ORDER BY id').all();
    const pollVotes = await c.env.DB.prepare('SELECT * FROM poll_votes ORDER BY id').all();
    // v2.13.0: tasks + attached files — BLOB content is base64-encoded
    const tasks = await c.env.DB.prepare('SELECT * FROM tasks ORDER BY id').all();
    const taskFiles = await c.env.DB.prepare('SELECT * FROM task_files ORDER BY id').all();
    const taskChunks = await c.env.DB.prepare('SELECT id, file_id, idx, data FROM task_file_chunks ORDER BY file_id, idx').all();
    // v2.16.0: رسیده‌های پرداخت شارژ (ساکن) + فیش و قطعات — در پشتیبان می‌آیند
    const claims = await c.env.DB.prepare('SELECT * FROM payment_claims ORDER BY id').all();
    const claimFiles = await c.env.DB.prepare('SELECT * FROM claim_files ORDER BY id').all();
    const claimChunks = await c.env.DB.prepare('SELECT id, file_id, idx, data FROM claim_file_chunks ORDER BY file_id, idx').all();
    // v2.21.0: دفتر اعتبار اضافه‌پرداخت — در پشتیبان می‌آید
    const credits = await c.env.DB.prepare('SELECT * FROM unit_credits ORDER BY id').all();
    const payload = {
      app: 'building-charges', version: String(APP_VERSION),
      exported_at: new Date().toISOString(),
      units: units.results, debts: debts.results, expenses: expenses.results,
      users: users.results, polls: polls.results, poll_votes: pollVotes.results,
      tasks: tasks.results, task_files: taskFiles.results,
      task_file_chunks: (taskChunks.results || []).map(r => ({ ...r, data: bytesToB64(r.data) })),
      payment_claims: claims.results, claim_files: claimFiles.results,
      claim_file_chunks: (claimChunks.results || []).map(r => ({ ...r, data: bytesToB64(r.data) })),
      unit_credits: credits.results,
      settings: settings.results
    };
    const jsonStr = JSON.stringify(payload, null, 2);

    // v2.15.0 — «بکاپ مدارک + فایل json در یک زیپ»: fmt=zip → backup.json و
    // (اختیاری با files=1) همهٔ مدارک پیوست کارها به‌صورت files/<id>-<name>.
    // گزینهٔ files به مدیر اجازه می‌دهد بکاپ سبکِ بدون مدارک بگیرد.
    if (fmt === 'zip') {
      const wantFiles = c.query.get('files') === '1';
      const entries = [{ name: 'backup.json', data: new TextEncoder().encode(jsonStr) }];
      let skippedFiles = 0;
      if (wantFiles) {
        // بودجهٔ حجم: هر مدرک تا ۶MB است ولی مجموع نباید isolate را زیر فشار بگذارد
        const BUDGET = 64 * 1024 * 1024;
        let used = 0;
        // کوئری‌های قطعات عمداً ترتیبی‌اند (تلهٔ concurrency در D1)
        // v2.16.0: فیش‌های واریزی ساکنین هم با پیشوند claims/ داخل زیپ می‌آیند
        for (const f of claimFiles.results || []) {
          try {
            const { results: chunks } = await c.env.DB.prepare(
              'SELECT data FROM claim_file_chunks WHERE file_id = ? ORDER BY idx'
            ).bind(f.id).all();
            const parts = (chunks || []).map(r => new Uint8Array(r.data));
            const total = parts.reduce((s, p) => s + p.length, 0);
            if (used + total > BUDGET) { skippedFiles++; continue; }
            const bin = new Uint8Array(total);
            let off = 0;
            for (const p of parts) { bin.set(p, off); off += p.length; }
            const base = safeEntryName(f.name);
            entries.push({ name: 'claims/' + f.id + '-' + base, data: bin });
            used += total;
          } catch { skippedFiles++; }
        }
        for (const f of taskFiles.results || []) {
          try {
            const { results: chunks } = await c.env.DB.prepare(
              'SELECT data FROM task_file_chunks WHERE file_id = ? ORDER BY idx'
            ).bind(f.id).all();
            const parts = (chunks || []).map(r => new Uint8Array(r.data));
            const total = parts.reduce((s, p) => s + p.length, 0);
            if (used + total > BUDGET) { skippedFiles++; continue; }
            const bin = new Uint8Array(total);
            let off = 0;
            for (const p of parts) { bin.set(p, off); off += p.length; }
            const base = safeEntryName(f.name);
            entries.push({ name: 'files/' + f.id + '-' + base, data: bin });
            used += total;
          } catch { skippedFiles++; }
        }
      }
      if (skippedFiles) {
        entries.push({
          name: 'FILES-SKIPPED.txt',
          data: new TextEncoder().encode(
            skippedFiles + ' file(s) were skipped: total size budget (64MB) reached.\n'
          )
        });
      }
      const zipBytes = buildZip(entries);
      return new Response(zipBytes, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="building-backup-${Date.now()}.zip"`,
          'x-content-type-options': 'nosniff'
        }
      });
    }

    return new Response(jsonStr, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="building-backup-${Date.now()}.json"`,
        'x-content-type-options': 'nosniff'
      }
    });
  }

  return fail('نوع خروجی نامعتبر است');
}, 'shared');

// ---------------------------------------------------------------------------
// IMPORT (بازیابی پشتیبان) — v2.11.0
// Restores a JSON backup produced by «پشتیبان کامل (JSON)». The whole restore
// runs in ONE D1 batch (atomic): either everything is applied or nothing.
// Safety rules:
//   • users with role='admin' are NEVER imported — the app-owner account of
//     the current deployment stays intact (no takeover / no lockout)
//   • settings keys session_secret and bot_token are NEVER imported
//   • users whose hash is missing (old backups) inherit the password of the
//     current account with the same username, otherwise an unusable random one
// ---------------------------------------------------------------------------
route('POST', '/import', async (c) => {
  const b = c.body || {};
  if (b.app !== 'building-charges') return fail('این فایل پشتیبانِ همین اپ نیست (برچسب app نامعتبر است)');
  for (const key of ['units', 'debts', 'expenses', 'users', 'settings']) {
    if (!Array.isArray(b[key])) return fail('ساختار فایل پشتیبان کامل نیست (بخش ' + key + ' پیدا نشد)');
  }
  const units = b.units, debts = b.debts, expenses = b.expenses, users = b.users;
  const settings = b.settings, polls = Array.isArray(b.polls) ? b.polls : [], pollVotes = Array.isArray(b.poll_votes) ? b.poll_votes : [];
  // v2.13.0: کارها و مدارک — پشتیبان‌های قدیمی این بخش‌ها را ندارند (اختیاری)
  const tasks = Array.isArray(b.tasks) ? b.tasks : [];
  const taskFiles = Array.isArray(b.task_files) ? b.task_files : [];
  const taskChunks = Array.isArray(b.task_file_chunks) ? b.task_file_chunks : [];
  // v2.16.0: رسیده‌ها — پشتیبان‌های قدیمی این بخش‌ها را ندارند (اختیاری)
  const claims = Array.isArray(b.payment_claims) ? b.payment_claims : [];
  const claimFiles = Array.isArray(b.claim_files) ? b.claim_files : [];
  const claimChunks = Array.isArray(b.claim_file_chunks) ? b.claim_file_chunks : [];
  // v2.21.0: دفتر اعتبار اضافه‌پرداخت — پشتیبان‌های قدیمی ندارند (اختیاری)
  const credits = Array.isArray(b.unit_credits) ? b.unit_credits : [];
  const LIMIT = 20000;
  if (units.length > LIMIT || debts.length > LIMIT || expenses.length > LIMIT || users.length > LIMIT
    || tasks.length > LIMIT || taskFiles.length > LIMIT || taskChunks.length > LIMIT
    || claims.length > LIMIT || claimFiles.length > LIMIT || claimChunks.length > LIMIT
    || credits.length > LIMIT) {
    return fail('حجم فایل پشتیبان بیش از حد مجاز است');
  }

  // snapshot current passwords by username (fallback for old backups without hash)
  const { results: curUsers } = await c.env.DB.prepare('SELECT username, password_hash FROM users').all();
  const curHash = new Map((curUsers || []).map(u => [u.username, u.password_hash]));

  const nowSec = now();
  const stmts = [];
  // 1) wipe (children first) — admin accounts and bot/session secrets stay
  stmts.push(c.env.DB.prepare('DELETE FROM poll_votes'));
  stmts.push(c.env.DB.prepare('DELETE FROM polls'));
  stmts.push(c.env.DB.prepare('DELETE FROM debts'));
  stmts.push(c.env.DB.prepare('DELETE FROM expenses'));
  // v2.13.0: کارها و مدارک هم پاک و از پشتیبان بازگردانی می‌شوند
  stmts.push(c.env.DB.prepare('DELETE FROM task_file_chunks'));
  stmts.push(c.env.DB.prepare('DELETE FROM task_files'));
  stmts.push(c.env.DB.prepare('DELETE FROM tasks'));
  // v2.16.0: رسیده‌های پرداخت هم پاک و بازگردانی می‌شوند
  stmts.push(c.env.DB.prepare('DELETE FROM claim_file_chunks'));
  stmts.push(c.env.DB.prepare('DELETE FROM claim_files'));
  stmts.push(c.env.DB.prepare('DELETE FROM payment_claims'));
  // v2.21.0: دفتر اعتبار اضافه‌پرداخت هم پاک و بازگردانی می‌شود
  stmts.push(c.env.DB.prepare('DELETE FROM unit_credits'));
  // v2.17.0: لینک‌های دعوتِ یک‌بارمصرفِ قبلی با بازیابی پشتیبان بی‌معنا می‌شوند
  stmts.push(c.env.DB.prepare('DELETE FROM invite_tokens'));
  stmts.push(c.env.DB.prepare("DELETE FROM users WHERE role != 'admin'"));
  stmts.push(c.env.DB.prepare('DELETE FROM units'));

  // 2) insert helper — multi-row INSERT, ≤ 90 bound params per statement
  const multiInsert = (table, cols, rows) => {
    const perStmt = Math.max(1, Math.floor(90 / cols.length));
    for (let i = 0; i < rows.length; i += perStmt) {
      const chunk = rows.slice(i, i + perStmt);
      const values = chunk.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',');
      const binds = chunk.flatMap(r => cols.map(col => r[col] === undefined ? null : r[col]));
      stmts.push(c.env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values}`).bind(...binds));
    }
  };

  // units
  multiInsert('units', ['id', 'number', 'resident_name', 'phone', 'area_m2', 'residents_count', 'note', 'created_at'],
    units.map(u => ({
      id: Number(u.id) || 0, number: String(u.number ?? '').slice(0, 40),
      resident_name: String(u.resident_name ?? ''), phone: String(u.phone ?? ''),
      area_m2: Number(u.area_m2) || 0, residents_count: Math.max(1, Number(u.residents_count) || 1),
      note: String(u.note ?? ''), created_at: Number(u.created_at) || nowSec
    })).filter(u => u.id && u.number));

  // users (never admin) — hash fallback keeps logins working where possible
  let importedUsers = 0;
  const userRows = [];
  const seenUsernames = new Set();
  for (const u of users) {
    if (!u || u.role === 'admin') continue;
    const uname = String(u.username ?? '').trim().toLowerCase();
    if (!uname || seenUsernames.has(uname)) continue;
    seenUsernames.add(uname);
    userRows.push({
      id: Number(u.id) || 0, username: uname,
      password_hash: String(u.password_hash || curHash.get(uname) || ('!' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))),
      role: u.role === 'manager' ? 'manager' : 'resident',
      full_name: String(u.full_name ?? ''), phone: String(u.phone ?? ''),
      unit_id: u.unit_id ? Number(u.unit_id) : null,
      telegram_user_id: u.telegram_user_id ? Number(u.telegram_user_id) : null,
      telegram_username: String(u.telegram_username ?? ''),
      is_active: (u.is_active === 0 || u.is_active === false) ? 0 : 1,
      token_epoch: Math.max(0, Math.round(Number(u.token_epoch) || 0)),
      bound_tg_id: u.bound_tg_id ? Number(u.bound_tg_id) : null,
      is_resident: (u.role === 'manager' && (u.is_resident === 0 || u.is_resident === false)) ? 0 : 1,
      created_by: u.created_by ? Number(u.created_by) : null,
      created_at: Number(u.created_at) || nowSec
    });
    importedUsers++;
  }
  if (userRows.length) {
    multiInsert('users', ['id', 'username', 'password_hash', 'role', 'full_name', 'phone', 'unit_id', 'telegram_user_id', 'telegram_username', 'is_active', 'token_epoch', 'bound_tg_id', 'is_resident', 'created_by', 'created_at'], userRows);
  }

  // expenses
  multiInsert('expenses', ['id', 'title', 'category', 'amount', 'period', 'split_mode', 'spent_at', 'note', 'created_at'],
    expenses.map(x => ({
      id: Number(x.id) || 0, title: String(x.title ?? '').slice(0, 120),
      category: String(x.category ?? 'سایر'), amount: Math.round(Number(x.amount) || 0),
      period: String(x.period ?? ''), split_mode: x.split_mode === 'area' ? 'area' : 'equal',
      spent_at: x.spent_at ? Number(x.spent_at) : null, note: String(x.note ?? ''),
      created_at: Number(x.created_at) || nowSec
    })).filter(x => x.id && x.title));

  // debts
  multiInsert('debts', ['id', 'unit_id', 'kind', 'expense_id', 'period', 'description', 'amount', 'paid_amount', 'status', 'paid_at', 'method', 'note', 'created_at'],
    debts.map(d => ({
      id: Number(d.id) || 0, unit_id: Number(d.unit_id) || 0,
      kind: ['monthly', 'expense', 'custom'].includes(d.kind) ? d.kind : 'custom',
      expense_id: d.expense_id ? Number(d.expense_id) : null,
      period: String(d.period ?? ''), description: String(d.description ?? ''),
      amount: Math.round(Number(d.amount) || 0), paid_amount: Math.max(0, Math.round(Number(d.paid_amount) || 0)),
      status: ['unpaid', 'partial', 'paid'].includes(d.status) ? d.status : 'unpaid',
      paid_at: d.paid_at ? Number(d.paid_at) : null, method: String(d.method ?? ''),
      note: String(d.note ?? ''), created_at: Number(d.created_at) || nowSec
    })).filter(d => d.id && d.unit_id));

  // polls + votes
  multiInsert('polls', ['id', 'question', 'options', 'status', 'created_by', 'created_at', 'closed_at'],
    polls.map(p => ({
      id: Number(p.id) || 0, question: String(p.question ?? '').slice(0, 200),
      options: String(p.options ?? '[]'), status: p.status === 'closed' ? 'closed' : 'open',
      created_by: p.created_by ? Number(p.created_by) : null,
      created_at: Number(p.created_at) || nowSec, closed_at: p.closed_at ? Number(p.closed_at) : null
    })).filter(p => p.id && p.question));
  multiInsert('poll_votes', ['id', 'poll_id', 'unit_id', 'user_id', 'option_index', 'created_at'],
    pollVotes.map(v => ({
      id: Number(v.id) || 0, poll_id: Number(v.poll_id) || 0, unit_id: Number(v.unit_id) || 0,
      user_id: v.user_id ? Number(v.user_id) : null,
      option_index: Math.max(0, Number(v.option_index) || 0),
      created_at: Number(v.created_at) || nowSec
    })).filter(v => v.id && v.poll_id && v.unit_id));

  // v2.13.0: کارها + مدارک + قطعات فایل (base64 ← BLOB)
  multiInsert('tasks', ['id', 'title', 'category', 'description', 'cost', 'done_at', 'created_by', 'created_at', 'updated_at'],
    tasks.map(t => ({
      id: Number(t.id) || 0, title: String(t.title ?? '').slice(0, 120),
      category: String(t.category ?? 'سایر').slice(0, 40),
      description: String(t.description ?? '').slice(0, 2000),
      cost: Math.max(0, Math.round(Number(t.cost) || 0)),
      done_at: t.done_at ? Number(t.done_at) : null,
      created_by: t.created_by ? Number(t.created_by) : null,
      created_at: Number(t.created_at) || nowSec,
      updated_at: t.updated_at ? Number(t.updated_at) : null
    })).filter(t => t.id && t.title));
  multiInsert('task_files', ['id', 'task_id', 'name', 'mime', 'size', 'created_at'],
    taskFiles.map(f => ({
      id: Number(f.id) || 0, task_id: Number(f.task_id) || 0,
      name: String(f.name ?? 'مدرک').slice(0, 120),
      mime: String(f.mime ?? ''), size: Math.max(0, Math.round(Number(f.size) || 0)),
      created_at: Number(f.created_at) || nowSec
    })).filter(f => f.id && f.task_id));
  const chunkRows = [];
  for (const ch of taskChunks) {
    const fid = Number(ch && ch.file_id) || 0;
    if (!fid) continue;
    const bin = b64ToBytes(ch.data);
    if (!bin || !bin.length) continue;
    chunkRows.push({ id: Number(ch.id) || 0, file_id: fid, idx: Math.max(0, Math.round(Number(ch.idx) || 0)), data: bin });
  }
  // قطعات تک‌ردیفی درج می‌شوند (هر قطعه تا ~۶۰KB دادهٔ باینری دارد)
  for (const ch of chunkRows) {
    stmts.push(c.env.DB.prepare('INSERT INTO task_file_chunks (id, file_id, idx, data) VALUES (?, ?, ?, ?)')
      .bind(ch.id, ch.file_id, ch.idx, ch.data));
  }

  // v2.16.0: رسیده‌های پرداخت + فیش‌ها + قطعات (base64 ← BLOB)
  multiInsert('payment_claims', ['id', 'unit_id', 'user_id', 'amount', 'note', 'status', 'confirmed_amount', 'reject_note', 'confirmed_by', 'created_at', 'confirmed_at'],
    claims.map(x => ({
      id: Number(x.id) || 0, unit_id: Number(x.unit_id) || 0, user_id: x.user_id ? Number(x.user_id) : null,
      amount: Math.max(0, Math.round(Number(x.amount) || 0)),
      note: String(x.note ?? '').slice(0, 500),
      status: ['pending', 'confirmed', 'rejected'].includes(x.status) ? x.status : 'pending',
      confirmed_amount: x.confirmed_amount ? Math.round(Number(x.confirmed_amount) || 0) : null,
      reject_note: String(x.reject_note ?? '').slice(0, 500),
      confirmed_by: x.confirmed_by ? Number(x.confirmed_by) : null,
      created_at: Number(x.created_at) || nowSec,
      confirmed_at: x.confirmed_at ? Number(x.confirmed_at) : null
    })).filter(x => x.id && x.unit_id));
  multiInsert('claim_files', ['id', 'claim_id', 'name', 'mime', 'size', 'created_at'],
    claimFiles.map(f => ({
      id: Number(f.id) || 0, claim_id: Number(f.claim_id) || 0,
      name: String(f.name ?? 'fish').slice(0, 120),
      mime: String(f.mime ?? ''), size: Math.max(0, Math.round(Number(f.size) || 0)),
      created_at: Number(f.created_at) || nowSec
    })).filter(f => f.id && f.claim_id));
  const claimChunkRows = [];
  for (const ch of claimChunks) {
    const fid = Number(ch && ch.file_id) || 0;
    if (!fid) continue;
    const bin = b64ToBytes(ch.data);
    if (!bin || !bin.length) continue;
    claimChunkRows.push({ id: Number(ch.id) || 0, file_id: fid, idx: Math.max(0, Math.round(Number(ch.idx) || 0)), data: bin });
  }
  for (const ch of claimChunkRows) {
    stmts.push(c.env.DB.prepare('INSERT INTO claim_file_chunks (id, file_id, idx, data) VALUES (?, ?, ?, ?)')
      .bind(ch.id, ch.file_id, ch.idx, ch.data));
  }

  // v2.21.0: دفتر اعتبار اضافه‌پرداخت — فقط ردیف‌های سالم (واحد باید موجود باشد)
  multiInsert('unit_credits', ['id', 'unit_id', 'amount', 'kind', 'debt_id', 'period', 'note', 'created_by', 'created_at'],
    credits.map(x => ({
      id: Number(x.id) || 0,
      unit_id: Number(x.unit_id) || 0,
      amount: Math.round(Number(x.amount) || 0),
      kind: x.kind === 'consume' ? 'consume' : 'add',
      debt_id: x.debt_id ? Number(x.debt_id) : null,
      period: String(x.period ?? '').slice(0, 10),
      note: String(x.note ?? '').slice(0, 300),
      created_by: x.created_by ? Number(x.created_by) : null,
      created_at: Number(x.created_at) || nowSec
    })).filter(x => x.id && x.unit_id && x.amount !== 0));

  // 3) settings — everything except secrets (session_secret, bot_token)
  const skipKeys = new Set(['session_secret', 'bot_token']);
  for (const s of settings) {
    if (!s || !s.key || skipKeys.has(String(s.key))) continue;
    stmts.push(c.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind(String(s.key), String(s.value ?? '')));
  }

  // 4) reset AUTOINCREMENT counters so future inserts never collide
  for (const [table, rows] of [['units', units], ['users', userRows], ['expenses', expenses], ['debts', debts], ['polls', polls], ['poll_votes', pollVotes], ['tasks', tasks], ['task_files', taskFiles], ['task_file_chunks', chunkRows], ['payment_claims', claims], ['claim_files', claimFiles], ['claim_file_chunks', claimChunkRows], ['unit_credits', credits]]) {
    const maxId = Math.max(0, ...rows.map(r => Number(r && r.id) || 0));
    stmts.push(c.env.DB.prepare("DELETE FROM sqlite_sequence WHERE name = ?").bind(table));
    if (maxId > 0) {
      stmts.push(c.env.DB.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').bind(table, maxId));
    }
  }

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    return fail('بازیابی ناموفق بود — فایل پشتیبان سالم است؟ (' + (e.message || 'خطای دیتابیس') + ')');
  }
  return json({
    ok: true,
    imported: {
      units: units.length, expenses: expenses.length, debts: debts.length,
      users: importedUsers, polls: polls.length, poll_votes: pollVotes.length,
      tasks: tasks.length, task_files: taskFiles.length,
      unit_credits: credits.length,
      exported_at: b.exported_at || null
    }
  });
}, 'shared');

// manager theme preference (kept for parity with mini app settings)
route('POST', '/settings/prefs', async (c) => {
  const b = c.body || {};
  if (b.default_monthly_amount !== undefined) {
    const amt = Math.round(Number(b.default_monthly_amount) || 0);
    if (amt < 0) return fail('مبلغ نامعتبر است');
    await setSetting(c.env, 'default_monthly_amount', String(amt));
  }
  return json({ ok: true });
}, 'manager');
