// Claims (رسیدهای پرداخت شارژ) — v2.16.0
//
// چرخهٔ کامل «رسید واریزی ساکن»:
//   ۱) ساکن در «واحد من» فیش واریزی خود را (الزامی) با مبلغ و توضیح بارگذاری می‌کند.
//   ۲) بات تلگرام به همهٔ مدیران ساختمان پیام می‌دهد که رسیدی ثبت شده و در پنل
//      مدیریت (تب شارژ) بررسی شود.
//   ۳) مدیر فایل را می‌بیند، توضیح ساکن را می‌خواند و پرداخت را «کامل» یا
//      «جزیی» ثبت می‌کند؛ مبلغ به قدیمی‌ترین اقلام بدهی واحد (FIFO) اعمال
//      می‌شود و اگر بدهی بماند، برای بعد می‌ماند. ساکن هم با پیام بات خبردار می‌شود.
//   ۴) اگر رسید اشتباه باشد، مدیر می‌تواند آن را رد کند (ساکن پیام می‌گیرد).
//
// دسترسی‌ها:
//   • ثبت رسید → همهٔ اعضای دارای واحد ('user' + گارد داخل هندلر)
//   • فهرست/مشاهدهٔ فایل → مدیر/ادمین همه را، ساکن فقط رسیدهای واحد خودش
//   • تأیید/رد → فقط مدیر ساختمان ('manager') — حریم مالی مثل بقیهٔ مسیرها
//
// ذخیرهٔ فایل مثل مدارک کارها: قطعات ~۶۰ کیلوبایتی (claim_file_chunks) چون
// گزارهٔ D1 محدودیت طول دارد؛ بدون سرویس خارجی.
import { route } from './router.js';
import { json, fail, now, getSettings } from './helpers.js';
import { faNum, tehranParts, toJalaaliFromParts, J_MONTHS, currentPeriod } from './jalali.js';
import { registerCredit, unitCredit } from './credits.js';
import { getBotToken, sendTelegramMessage } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { rememberAppUrl } from './scheduler.js';
import { b64ToBytes } from './tasks.js';

const MAX_FILE_BYTES = 6 * 1024 * 1024;   // ۶ مگابایت برای فیش
const MAX_CLAIMS = 5000;                  // سقف کل ردیف‌های رسید
const CHUNK = 60 * 1024;                  // ۶۰KB در هر قطعه
const MAX_NOTE = 500;

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf'
]);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function jalaliDate(ts) {
  try {
    const p = tehranParts(Number(ts) * 1000);
    const j = toJalaaliFromParts(p.gy, p.gm, p.gd);
    return `${faNum(j.jd)} ${J_MONTHS[(j.jm || 1) - 1]} ${faNum(j.jy)}`;
  } catch { return ''; }
}

async function claimsWithFiles(env, rows) {
  const map = new Map();
  const ids = rows.map(r => r.id);
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, claim_id, name, mime, size, created_at
       FROM claim_files WHERE claim_id IN (${marks}) ORDER BY id`
    ).bind(...ids).all();
    for (const f of results || []) {
      if (!map.has(f.claim_id)) map.set(f.claim_id, []);
      map.get(f.claim_id).push(f);
    }
  }
  return rows.map(r => ({ ...r, files: map.get(r.id) || [] }));
}

/** ماندهٔ بدهی باز یک واحد (روی همهٔ اقلام) */
async function unitRemaining(env, unitId) {
  const r = await env.DB.prepare(
    'SELECT COALESCE(SUM(amount - paid_amount), 0) AS v FROM debts WHERE unit_id = ?'
  ).bind(unitId).first();
  return Math.max(0, Number(r && r.v) || 0);
}

/**
 * اعمال مبلغ پرداخت روی اقلام بدهی واحد به‌صورت FIFO (قدیمی‌ترین دوره اول).
 * بازگشت: {applied, remaining} — applied همان مبلغ مصرف‌شده است.
 */
async function applyFifoPayment(env, unitId, total, method, note) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM debts WHERE unit_id = ? AND paid_amount < amount
     ORDER BY period ASC, id ASC`
  ).bind(unitId).all();
  let left = Math.round(Number(total) || 0);
  const stmts = [];
  for (const d of results || []) {
    if (left <= 0) break;
    const rem = d.amount - d.paid_amount;
    const take = Math.min(rem, left);
    if (take <= 0) continue;
    const paid = d.paid_amount + take;
    const status = paid >= d.amount ? 'paid' : 'partial';
    const noteFull = note
      ? (d.note ? String(d.note).slice(0, 180) + ' | ' + note : note)
      : d.note;
    stmts.push(env.DB.prepare(
      'UPDATE debts SET paid_amount = ?, status = ?, paid_at = ?, method = ?, note = ? WHERE id = ?'
    ).bind(paid, status, now(), method, noteFull || '', d.id));
    left -= take;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { applied: Math.round(Number(total) || 0) - left, remaining_left: left };
}

// ---------------------------------------------------------------------------
// POST /claims — ثبت رسید جدید توسط ساکن (الزام: واحد + فایل)
// ---------------------------------------------------------------------------
route('POST', '/claims', async (c) => {
  const unit = c.unit || c.auth.unit;
  if (!unit) return fail('به هیچ واحدی متصل نیستید؛ با مدیر ساختمان تماس بگیرید', 403, 'no_unit');

  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM payment_claims').first();
  if (cnt && cnt.c >= MAX_CLAIMS) return fail('تعداد رسیدهای ثبت‌شده به سقف مجاز رسیده است', 409);

  // هر واحد در هر لحظه فقط یک رسید در انتظار بررسی دارد (ضد اسپم و تکرار)
  const pending = await c.env.DB.prepare(
    "SELECT id FROM payment_claims WHERE unit_id = ? AND status = 'pending' LIMIT 1"
  ).bind(unit.id).first();
  if (pending) return fail('شما یک رسید در انتظار بررسی دارید؛ لطفاً منتظر تأیید مدیر ساختمان بمانید', 409, 'claim_pending');

  const b = c.body || {};
  const amount = Math.round(Number(b.amount) || 0);
  if (!(amount > 0)) return fail('مبلغ پرداخت‌شده را وارد کنید');
  if (amount > 1e12) return fail('مبلغ بیش از حد مجاز است');
  const note = String(b.note || '').trim().slice(0, MAX_NOTE);

  // فیش واریزی الزامی است
  const f = b.file || {};
  const mime = String(f.mime || '').trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return fail('فیش واریزی الزامی است — فقط تصویر (JPG/PNG/WebP/GIF) یا PDF پذیرفته می‌شود', 400, 'bad_mime');
  }
  const bin = b64ToBytes(String(f.data_b64 || ''));
  if (!bin || !bin.length) return fail('فایل فیش واریزی خالی است — دوباره انتخاب کنید');
  if (bin.length > MAX_FILE_BYTES) return fail('حجم فیش بیش از حد مجاز است (حداکثر ۶ مگابایت)', 413, 'file_too_large');

  const nowSec = now();
  const res = await c.env.DB.prepare(`
    INSERT INTO payment_claims (unit_id, user_id, amount, note, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).bind(unit.id, c.user.id, amount, note, nowSec).run();
  const claimId = res.meta.last_row_id;

  const fName = String(f.name || 'fish-varizi').trim().slice(0, 120) || 'fish-varizi';
  const fRes = await c.env.DB.prepare(`
    INSERT INTO claim_files (claim_id, name, mime, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(claimId, fName, mime, bin.length, nowSec).run();
  const fileId = fRes.meta.last_row_id;

  const stmts = [];
  for (let off = 0, idx = 0; off < bin.length; off += CHUNK, idx++) {
    stmts.push(c.env.DB.prepare(
      'INSERT INTO claim_file_chunks (file_id, idx, data) VALUES (?, ?, ?)'
    ).bind(fileId, idx, bin.slice(off, off + CHUNK)));
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  // پیام بات به همهٔ مدیران ساختمان (waitUntil — ثبت رسید هرگز منتظر ارسال نمی‌ماند)
  let notifyQueued = false;
  const origin = new URL(c.request.url).origin;
  const job = notifyManagersNewClaim(c.env, {
    id: claimId, unit, amount, note,
    created_at: nowSec,
    resident_user: c.user
  }, origin);
  if (c.ctx && typeof c.ctx.waitUntil === 'function') c.ctx.waitUntil(job);
  else { try { await job; } catch { /* non-fatal */ } }
  notifyQueued = true;

  const claim = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(claimId).first();
  return json({
    claim: { ...claim, files: [{ id: fileId, claim_id: claimId, name: fName, mime, size: bin.length, created_at: nowSec }] },
    notify_queued: notifyQueued
  }, 201);
}, 'user');

/** پیام «رسید ثبت شد» به همهٔ مدیران ساختمان */
async function notifyManagersNewClaim(env, claim, origin) {
  try {
    const botToken = await getBotToken(env);
    if (!botToken) return;
    const { results } = await env.DB.prepare(`
      SELECT telegram_user_id FROM users
      WHERE role = 'manager' AND is_active = 1
        AND telegram_user_id IS NOT NULL AND telegram_user_id != ''
    `).all();
    if (!(results || []).length) return;
    const s = await getSettings(env);
    const buildingName = s.building_name || 'ساختمان';
    if (origin) { try { await rememberAppUrl(env, origin); } catch { /* optional */ } }
    const text = `${buildingName} — رسید پرداخت شارژ ثبت شد\n\n` +
      `واحد ${claim.unit.number}${claim.unit.resident_name ? ' — ' + claim.unit.resident_name : ''}\n` +
      `مبلغ اعلام‌شده: ${faNum(Number(claim.amount).toLocaleString('en-US'))} تومان\n` +
      (claim.note ? `توضیح ساکن: ${claim.note}\n` : '') +
      `تاریخ: ${jalaliDate(claim.created_at)}\n\n` +
      `برای بررسی فیش و ثبت پرداخت، به پنل مدیریت ساختمان (تب شارژ) بروید.`;
    const keyboard = origin ? { inline_keyboard: [[{ text: 'بررسی در پنل مدیریت', web_app: { url: origin } }]] } : undefined;
    for (const r of results) {
      try {
        const rr = await sendTelegramMessage(botToken, r.telegram_user_id, text, keyboard);
        // v2.19.0 — ثبت اعلام رسید پرداخت به مدیران در «گزارش پیام‌های ربات»
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: r.telegram_user_id, text, title: 'اعلام رسید پرداخت' });
      } catch { /* keep going */ }
    }
  } catch { /* notification must never break claim creation */ }
}

/** پیام نتیجهٔ بررسی به ساکن */
async function notifyResidentClaimResult(env, claim, unit, kind, { credited = 0 } = {}) {
  try {
    const botToken = await getBotToken(env);
    if (!botToken) return;
    const { results } = await env.DB.prepare(`
      SELECT telegram_user_id FROM users
      WHERE is_active = 1 AND telegram_user_id IS NOT NULL AND telegram_user_id != ''
        AND unit_id = ?
    `).bind(unit.unit_id).all();
    if (!(results || []).length) return;
    const s = await getSettings(env);
    const buildingName = s.building_name || 'ساختمان';
    let text;
    if (kind === 'confirmed') {
      const remaining = await unitRemaining(env, unit.unit_id);
      const credit = await unitCredit(env, unit.unit_id);
      text = `${buildingName} — رسید شما تأیید شد\n\n` +
        `واحد ${unit.number} — مبلغ ثبت‌شده: ${faNum(Number(claim.confirmed_amount || 0).toLocaleString('en-US'))} تومان\n` +
        (credited > 0 ? `اعتبار اضافه‌پرداخت شما: ${faNum(credit.toLocaleString('en-US'))} تومان (در شارژ ماه‌های بعد اعمال می‌شود)\n` : '') +
        (remaining > 0
          ? `مانده بدهی واحد شما: ${faNum(remaining.toLocaleString('en-US'))} تومان`
          : 'بدهی واحد شما تسویه شد. دستتان درد نکند!');
    } else {
      text = `${buildingName} — رسید شما بررسی نشد\n\n` +
        `واحد ${unit.number}\n` +
        (claim.reject_note ? `دلیل: ${claim.reject_note}\n` : '') +
        `لطفاً برای پیگیری با مدیر ساختمان هماهنگ کنید.`;
    }
    for (const r of results) {
      try {
        const rr = await sendTelegramMessage(botToken, r.telegram_user_id, text);
        // v2.19.0 — ثبت نتیجهٔ بررسی رسید برای ساکن در «گزارش پیام‌های ربات»
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: r.telegram_user_id, text, title: 'نتیجهٔ رسید پرداخت' });
      } catch { /* keep going */ }
    }
  } catch { /* never break confirm/reject */ }
}

// ---------------------------------------------------------------------------
// GET /claims — فهرست رسیدها
//   ساکن: فقط رسیدهای واحد خودش؛ مدیر/ادمین: همه (فیلتر status اختیاری)
// ---------------------------------------------------------------------------
route('GET', '/claims', async (c) => {
  const role = c.user.role;
  const status = String(c.query.get('status') || '').trim();
  const okStatus = ['pending', 'confirmed', 'rejected'].includes(status) ? status : null;

  let rows;
  if (role === 'manager' || role === 'admin') {
    rows = okStatus
      ? (await c.env.DB.prepare(
          `SELECT pc.*, u.number AS unit_number, u.resident_name AS unit_resident
           FROM payment_claims pc JOIN units u ON u.id = pc.unit_id
           WHERE pc.status = ?
           ORDER BY pc.created_at DESC, pc.id DESC LIMIT 200`
        ).bind(okStatus).all()).results || []
      : (await c.env.DB.prepare(
          `SELECT pc.*, u.number AS unit_number, u.resident_name AS unit_resident
           FROM payment_claims pc JOIN units u ON u.id = pc.unit_id
           ORDER BY pc.created_at DESC, pc.id DESC LIMIT 200`
        ).all()).results || [];
  } else {
    const unit = c.unit || c.auth.unit;
    if (!unit) return json({ claims: [], unit_remaining: 0 });
    rows = (await c.env.DB.prepare(
      `SELECT pc.*, u.number AS unit_number, u.resident_name AS unit_resident
       FROM payment_claims pc JOIN units u ON u.id = pc.unit_id
       WHERE pc.unit_id = ?
       ORDER BY pc.created_at DESC, pc.id DESC LIMIT 50`
    ).bind(unit.id).all()).results || [];
  }
  const claims = await claimsWithFiles(c.env, rows);
  return json({ claims });
}, 'user');

// ---------------------------------------------------------------------------
// GET /claims/files/:id — مشاهده/دانلود فیش واریزی
//   مدیر/ادمین: همه؛ ساکن: فقط فیش رسیدهای واحد خودش
// ---------------------------------------------------------------------------
route('GET', '/claims/files/:id', async (c) => {
  const id = Number(c.params.id);
  const file = await c.env.DB.prepare('SELECT * FROM claim_files WHERE id = ?').bind(id).first();
  if (!file) return fail('فیش پیدا نشد', 404);
  const claim = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(file.claim_id).first();
  if (!claim) return fail('رسید پیدا نشد', 404);
  const role = c.user.role;
  if (role !== 'manager' && role !== 'admin') {
    const unit = c.unit || c.auth.unit;
    if (!unit || unit.id !== claim.unit_id) {
      return fail('شما به این فیش دسترسی ندارید', 403, 'forbidden');
    }
  }
  const { results } = await c.env.DB.prepare(
    'SELECT data FROM claim_file_chunks WHERE file_id = ? ORDER BY idx'
  ).bind(id).all();
  if (!(results || []).length) return fail('محتوای فیش یافت نشد', 404);
  const parts = (results || []).map(r => r.data);
  const total = parts.reduce((s, p) => s + (p.byteLength || p.length || 0), 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(new Uint8Array(p), off); off += p.byteLength || p.length; }
  const safeName = encodeURIComponent(file.name || 'file');
  return new Response(out, {
    headers: {
      'content-type': file.mime || 'application/octet-stream',
      'content-length': String(out.length),
      'content-disposition': `inline; filename*=UTF-8''${safeName}`,
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff'
    }
  });
}, 'user');

// ---------------------------------------------------------------------------
// POST /claims/:id/confirm — تأیید و ثبت پرداخت (کامل یا جزیی) — فقط مدیر
//   body: { amount? }  → نبودِ amount یا amount >= مانده یعنی ثبت کامل
// ---------------------------------------------------------------------------
route('POST', '/claims/:id/confirm', async (c) => {
  const id = Number(c.params.id);
  const claim = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(id).first();
  if (!claim) return fail('رسید پیدا نشد', 404);
  if (claim.status !== 'pending') return fail('این رسید قبلاً بررسی شده است', 409, 'already_reviewed');

  const unit = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(claim.unit_id).first();
  if (!unit) return fail('واحد این رسید پیدا نشد', 404);

  const remaining = await unitRemaining(c.env, unit.id);
  if (remaining <= 0) return fail('بدهی این واحد تسویه شده است؛ رسید را رد کنید یا ابتدا بدهی را اصلاح کنید', 409, 'no_debt');

  const b = c.body || {};
  let amt = (b.amount == null || b.amount === '') ? remaining : Math.round(Number(b.amount) || 0);
  if (!(amt > 0)) return fail('مبلغ نامعتبر است');
  // v2.21.0 — اضافه‌پرداخت: اگر مبلغ رسید از ماندهٔ بدهی بیشتر باشد (ساکن واقعاً
  // بیشتر پرداخت کرده)، مدیر باید صریحاً تأیید کند تا مابه‌التفاوت به‌عنوان اعتبار
  // اضافه‌پرداخت واحد ثبت شود (کد 'overpay_possible' برای مودال تأیید).
  if (amt > remaining && !b.overpay) {
    return fail(`مبلغ بیشتر از مانده بدهی واحد است (${faNum(remaining.toLocaleString('en-US'))} تومان) — مابه‌التفاوت به‌عنوان اعتبار اضافه‌پرداخت ثبت شود؟`, 400, 'overpay_possible');
  }
  const appliedTotal = Math.min(amt, remaining);
  const excess = amt - appliedTotal;

  const note = `رسید پرداخت ساکن #${id}${claim.note ? ' — ' + claim.note.slice(0, 120) : ''}`;
  const { applied } = await applyFifoPayment(c.env, unit.id, appliedTotal, 'رسید تأییدشده', note);

  // v2.21.0 — مابه‌التفاوت به دفتر اعتبار واحد می‌رود (ساکن در «واحد من» می‌بیند)
  let credited = 0;
  let creditBalance = null;
  if (excess > 0) {
    credited = await registerCredit(c.env, unit.id, excess, {
      period: currentPeriod(),
      note: 'اضافه‌پرداخت رسید #' + id,
      createdBy: c.user.id
    });
    creditBalance = await unitCredit(c.env, unit.id);
  }

  await c.env.DB.prepare(`
    UPDATE payment_claims
    SET status = 'confirmed', confirmed_amount = ?, confirmed_by = ?, confirmed_at = ?
    WHERE id = ?
  `).bind(applied + credited, c.user.id, now(), id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(id).first();

  // خبر ساکن (waitUntil — پاسخ سریع می‌ماند؛ خطا هرگز تأیید را نمی‌شکند)
  const job = notifyResidentClaimResult(c.env, updated, unit, 'confirmed', { credited });
  if (c.ctx && typeof c.ctx.waitUntil === 'function') c.ctx.waitUntil(job);
  else { try { await job; } catch { /* non-fatal */ } }

  const afterRemaining = await unitRemaining(c.env, unit.id);
  return json({
    claim: updated,
    applied,
    credited,
    credit_balance: creditBalance,
    unit_remaining: afterRemaining
  });
}, 'manager');

// ---------------------------------------------------------------------------
// POST /claims/:id/reject — رد رسید (فیش اشتباه/نامعتبر) — فقط مدیر
// ---------------------------------------------------------------------------
route('POST', '/claims/:id/reject', async (c) => {
  const id = Number(c.params.id);
  const claim = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(id).first();
  if (!claim) return fail('رسید پیدا نشد', 404);
  if (claim.status !== 'pending') return fail('این رسید قبلاً بررسی شده است', 409, 'already_reviewed');

  const unit = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(claim.unit_id).first();
  const b = c.body || {};
  const reason = String(b.reason || '').trim().slice(0, MAX_NOTE);

  await c.env.DB.prepare(`
    UPDATE payment_claims
    SET status = 'rejected', reject_note = ?, confirmed_by = ?, confirmed_at = ?
    WHERE id = ?
  `).bind(reason, c.user.id, now(), id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM payment_claims WHERE id = ?').bind(id).first();

  if (unit) {
    const job = notifyResidentClaimResult(c.env, updated, unit, 'rejected');
    if (c.ctx && typeof c.ctx.waitUntil === 'function') c.ctx.waitUntil(job);
    else { try { await job; } catch { /* non-fatal */ } }
  }
  return json({ claim: updated });
}, 'manager');
