// Tasks (کارهای مدیر ساختمان) — v2.13.0
// دفتر کارهای انجام‌شده در طول سال + هزینهٔ هر کار (که از صندوق ساختمان کسر
// می‌شود) + مدارک پیوست (فیش/قرارداد/برگه بازدید آسانسور و…).
//
// دسترسی‌ها:
//   • خواندن کارها و عملکرد مدیر و دانلود مدارک → همهٔ اعضای واردشده ('user')
//     چون شفافیت عملکرد مدیر برای ساکنین هدفِ این بخش است.
//   • ثبت/ویرایش/حذف کار و آپلود/حذف مدرک → فقط مدیر ساختمان ('manager').
//
// ذخیرهٔ فایل: D1 ستون BLOB ندارد محدودیت اندازهٔ گزاره → محتوا در قطعات
// ~۶۰ کیلوبایتی (task_file_chunks) ذخیره و هنگام دانلود سرهم می‌شود؛ بدون
// نیاز به سرویس خارجی (R2 و…).
import { route } from './router.js';
import {
  json, fail, now, getSettings, setSetting
} from './helpers.js';
import { isJalaliYear, toGregorian, tehranParts, toJalaaliFromParts, faNum, J_MONTHS } from './jalali.js';
import { buildPerformanceReportPdf, buildTasksReportPdf } from './pdf.js';
import { getBotToken, sendTelegramMessage } from './telegram.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { rememberAppUrl } from './scheduler.js';

const TASK_CATEGORIES = [
  'نظافت', 'تعمیرات', 'آسانسور', 'برق', 'آب', 'گاز', 'نگهبانی',
  'باغبانی', 'اداری و مالی', 'خرید و تدارکات', 'سایر'
];

const MAX_FILE_BYTES = 6 * 1024 * 1024;   // ۶ مگابایت برای هر مدرک
const MAX_FILES_PER_TASK = 8;             // حداکثر مدرک برای هر کار
const MAX_TASKS = 5000;                   // سقف کل ردیف‌های کار
const CHUNK = 60 * 1024;                  // ۶۰KB در هر قطعه

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf'
]);

export function normalizeTaskCategory(v) {
  const c = String(v || '').trim().slice(0, 40);
  return TASK_CATEGORIES.includes(c) ? c : 'سایر';
}

// بازهٔ unix (شامل/ناهمسان) یک سال شمسی بر پایهٔ نیمه‌شب تهران (UTC+3:30 ثابت)
export function jalaliYearRange(jy) {
  const midnightTehran = (jyy, jm, jd) => {
    const g = toGregorian(jyy, jm, jd);
    return Math.floor(Date.UTC(g.gy, g.gm - 1, g.gd) / 1000) - 12600;
  };
  return { start: midnightTehran(jy, 1, 1), end: midnightTehran(jy + 1, 1, 1) };
}

// سال/ماه شمسیِ یک timestamp بر پایهٔ تقویم تهران
export function tsJalaliPeriod(ts) {
  const p = tehranParts(Number(ts) * 1000);
  const j = toJalaaliFromParts(p.gy, p.gm, p.gd);
  return { jy: String(j.jy), jm: j.jm, period: `${j.jy}-${String(j.jm).padStart(2, '0')}` };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function filesForTasks(env, taskIds) {
  const map = new Map();
  if (!taskIds.length) return map;
  const marks = taskIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, task_id, name, mime, size, created_at
     FROM task_files WHERE task_id IN (${marks}) ORDER BY id`
  ).bind(...taskIds).all();
  for (const f of results || []) {
    if (!map.has(f.task_id)) map.set(f.task_id, []);
    map.get(f.task_id).push(f);
  }
  return map;
}

async function listTasks(env, { start, end, limit = 1000 } = {}) {
  const sql = `
    SELECT * FROM tasks
    ${start ? 'WHERE done_at >= ? AND done_at < ?' : ''}
    ORDER BY done_at DESC, id DESC
    LIMIT ${Number(limit) || 1000}
  `;
  const { results } = start
    ? await env.DB.prepare(sql).bind(start, end).all()
    : await env.DB.prepare(sql).all();
  return results || [];
}

// ---------------------------------------------------------------------------
//_tasks — فهرست کارها (سال شمسی اختیاری) با متادیتای مدارک
// ---------------------------------------------------------------------------
route('GET', '/tasks', async (c) => {
  const jy = c.query.get('jy');
  let rows;
  if (isJalaliYear(jy || '')) {
    const r = jalaliYearRange(Number(jy));
    rows = await listTasks(c.env, { start: r.start, end: r.end });
  } else {
    rows = await listTasks(c.env, {});
  }
  const files = await filesForTasks(c.env, rows.map(t => t.id));
  return json({
    tasks: rows.map(t => ({ ...t, files: files.get(t.id) || [] })),
    categories: TASK_CATEGORIES
  });
}, 'user');

// ---------------------------------------------------------------------------
// ثبت / ویرایش / حذف کار — فقط مدیر ساختمان
// ---------------------------------------------------------------------------
function readTaskBody(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return { error: 'عنوان کار الزامی است' };
  const category = normalizeTaskCategory(b.category);
  const description = String(b.description || '').trim().slice(0, 2000);
  const cost = Math.max(0, Math.round(Number(b.cost) || 0));
  const doneAt = b.date ? (Number(b.date) || now()) : now();
  return { title, category, description, cost, doneAt };
}

route('POST', '/tasks', async (c) => {
  const b = c.body || {};
  const t = readTaskBody(b);
  if (t.error) return fail(t.error);
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM tasks').first();
  if (cnt && cnt.c >= MAX_TASKS) return fail('تعداد کارهای ثبت‌شده به سقف مجاز رسیده است', 409);
  const res = await c.env.DB.prepare(`
    INSERT INTO tasks (title, category, description, cost, done_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(t.title, t.category, t.description, t.cost, t.doneAt, c.user.id, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(res.meta.last_row_id).first();
  // v2.14.2 — «خبردار شدن» ساکنین: اگر مدیر گزینهٔ اعلام را روشن گذاشته باشد،
  // پیام تلگرام به همهٔ اعضای متصل می‌رود. waitUntil تا پاسخ سریع بماند؛
  // هر خطایی در ارسال هرگز ثبت کار را نمی‌شکند.
  let notifyQueued = false;
  if (b.notify !== false) {
    notifyQueued = true;
    const origin = new URL(c.request.url).origin;
    const job = notifyNewTask(c.env, { ...t, id: res.meta.last_row_id }, c.user.id, origin);
    if (c.ctx && typeof c.ctx.waitUntil === 'function') c.ctx.waitUntil(job);
    else { try { await job; } catch { /* non-fatal */ } }
  }
  return json({ task: { ...row, files: [] }, notify_queued: notifyQueued }, 201);
}, 'manager');

// v2.14.2 — اعلام کار جدید به همهٔ اعضای متصل تلگرام (به‌جز خود ثبت‌کننده)
async function notifyNewTask(env, task, creatorId, origin) {
  try {
    const botToken = await getBotToken(env);
    if (!botToken) return;
    const { results } = await env.DB.prepare(`
      SELECT telegram_user_id FROM users
      WHERE is_active = 1 AND telegram_user_id IS NOT NULL AND telegram_user_id != ''
        AND id != ?
    `).bind(creatorId).all();
    if (!(results || []).length) return;
    const s = await getSettings(env);
    const buildingName = s.building_name || 'ساختمان';
    if (origin) { try { await rememberAppUrl(env, origin); } catch { /* optional */ } }
    const p = tehranParts(task.done_at * 1000);
    const j = toJalaaliFromParts(p.gy, p.gm, p.gd);
    const dateStr = `${faNum(j.jd)} ${J_MONTHS[(j.jm || 1) - 1]} ${faNum(j.jy)}`;
    const text = `${buildingName} — کار جدید ثبت شد\n\n` +
      `«${task.title}» (${task.category})\n` +
      `تاریخ انجام: ${dateStr}\n` +
      (task.cost > 0 ? `هزینه: ${faNum(Number(task.cost).toLocaleString('en-US'))} تومان (از صندوق ساختمان)` : 'بدون هزینه برای صندوق');
    const keyboard = origin ? { inline_keyboard: [[{ text: 'مشاهده در اپ ساختمان', web_app: { url: origin } }]] } : undefined;
    for (const r of results) {
      try {
        const rr = await sendTelegramMessage(botToken, r.telegram_user_id, text, keyboard);
        // v2.19.0 — ثبت اعلام کار جدید در «گزارش پیام‌های ربات»
        if (rr && rr.ok) await logOutgoingBotMessage(env, { chatId: r.telegram_user_id, text, title: 'اعلام کار جدید' });
      } catch { /* keep going */ }
    }
  } catch { /* notification must never break task creation */ }
}

// ---------------------------------------------------------------------------
// v2.14.1 — تنظیم موجودی اولیهٔ صندوق (فقط مدیر ساختمان)
// پولی که از قبل دست مدیر ساختمان قبلی بوده و باید در ماندهٔ کلی صندوق دیده شود.
// ذخیره در settings به‌صورت JSON {amount, note, updated_at} — مقدار ۰ یعنی صفر
// کردن موجودی اولیه (هر عدد متناهی پذیرفته می‌شود تا اصلاح منفی هم ممکن باشد).
//
// ⚠️ این مسیر باید «قبل از» PUT /tasks/:id ثبت شود وگرنه رجیستری مسیرها
// /tasks/fund را با :id مچ می‌کند (همان تلهٔ DELETE /tasks/files/:id).
// ---------------------------------------------------------------------------
route('PUT', '/tasks/fund', async (c) => {
  const b = c.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount)) return fail('مبلغ موجودی اولیه را درست وارد کنید');
  if (Math.abs(amount) > 1e12) return fail('مبلغ موجودی اولیه بیش از حد مجاز است');
  const note = String(b.note || '').trim().slice(0, 200);
  const payload = { amount: Math.round(amount), note, updated_at: now(), updated_by: c.user.id };
  await setSetting(c.env, 'fund_opening', JSON.stringify(payload));
  return json({ ok: true, fund_opening: { amount: payload.amount, note: payload.note, updated_at: payload.updated_at } });
}, 'manager');

route('PUT', '/tasks/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!row) return fail('کار پیدا نشد', 404);
  const b = c.body || {};
  const t = readTaskBody({
    title: b.title !== undefined ? b.title : row.title,
    category: b.category !== undefined ? b.category : row.category,
    description: b.description !== undefined ? b.description : row.description,
    cost: b.cost !== undefined ? b.cost : row.cost,
    date: b.date !== undefined ? b.date : row.done_at
  });
  if (t.error) return fail(t.error);
  await c.env.DB.prepare(`
    UPDATE tasks SET title = ?, category = ?, description = ?, cost = ?, done_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(t.title, t.category, t.description, t.cost, t.doneAt, now(), id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  const files = await filesForTasks(c.env, [id]);
  return json({ task: { ...updated, files: files.get(id) || [] } });
}, 'manager');

route('DELETE', '/tasks/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(id).first();
  if (!row) return fail('کار پیدا نشد', 404);
  // حذف صریح فرزندان (اتکا به CASCADE نداریم — سازگار با هر تنظیم SQLite)
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM task_file_chunks WHERE file_id IN (SELECT id FROM task_files WHERE task_id = ?)').bind(id),
    c.env.DB.prepare('DELETE FROM task_files WHERE task_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id)
  ]);
  return json({ ok: true });
}, 'manager');

// ---------------------------------------------------------------------------
// مدارک پیوست — آپلود (JSON + base64) و حذف؛ فقط مدیر ساختمان
// ---------------------------------------------------------------------------
route('POST', '/tasks/:id/files', async (c) => {
  const id = Number(c.params.id);
  const task = await c.env.DB.prepare('SELECT id FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return fail('کار پیدا نشد', 404);
  const b = c.body || {};
  const name = String(b.name || 'مدرک').trim().slice(0, 120) || 'مدرک';
  const mime = String(b.mime || '').trim().toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return fail('فقط تصویر (JPG/PNG/WebP/GIF) یا PDF پذیرفته می‌شود', 400, 'bad_mime');
  }
  const cnt = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM task_files WHERE task_id = ?'
  ).bind(id).first();
  if (cnt && cnt.c >= MAX_FILES_PER_TASK) {
    return fail(`حداکثر ${MAX_FILES_PER_TASK} مدرک برای هر کار مجاز است`, 409, 'too_many_files');
  }

  const bin = b64ToBytes(String(b.data_b64 || ''));
  if (!bin || !bin.length) return fail('محتوای فایل خالی است');
  if (bin.length > MAX_FILE_BYTES) return fail('حجم مدرک بیش از حد مجاز است (حداکثر ۶ مگابایت)', 413, 'file_too_large');

  const nowSec = now();
  const fRes = await c.env.DB.prepare(`
    INSERT INTO task_files (task_id, name, mime, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name, mime, bin.length, nowSec).run();
  const fileId = fRes.meta.last_row_id;

  const stmts = [];
  for (let off = 0, idx = 0; off < bin.length; off += CHUNK, idx++) {
    stmts.push(c.env.DB.prepare(
      'INSERT INTO task_file_chunks (file_id, idx, data) VALUES (?, ?, ?)'
    ).bind(fileId, idx, bin.slice(off, off + CHUNK)));
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  const file = await c.env.DB.prepare('SELECT id, task_id, name, mime, size, created_at FROM task_files WHERE id = ?')
    .bind(fileId).first();
  return json({ file }, 201);
}, 'manager');

route('DELETE', '/tasks/files/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM task_files WHERE id = ?').bind(id).first();
  if (!row) return fail('مدرک پیدا نشد', 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM task_file_chunks WHERE file_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM task_files WHERE id = ?').bind(id)
  ]);
  return json({ ok: true });
}, 'manager');

// دانلود/مشاهده مدرک — همهٔ اعضای واردشده
route('GET', '/tasks/files/:id', async (c) => {
  const id = Number(c.params.id);
  const file = await c.env.DB.prepare('SELECT * FROM task_files WHERE id = ?').bind(id).first();
  if (!file) return fail('مدرک پیدا نشد', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT data FROM task_file_chunks WHERE file_id = ? ORDER BY idx'
  ).bind(id).all();
  if (!(results || []).length) return fail('محتوای مدرک یافت نشد', 404);
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
      // v2.15.0 — امنیت: MIME با whitelist کنترل شده و حدس مرورگر ممنوع
      'x-content-type-options': 'nosniff'
    }
  });
}, 'user');

// ---------------------------------------------------------------------------
// گزارش عملکرد مدیر + صندوق ساختمان — همهٔ اعضای واردشده
//
// صندوق = موجودی اولیه (پولی که از قبل دست مدیر قبلی بوده — v2.14.1)
//       + پولی که از ساکنین وصول شده (شارژ + سهم هزینه‌ها)
//       − هزینه‌های مشترک ثبت‌شده در «ثبت هزینه‌ها» − هزینهٔ کارهای ثبت‌شده.
// موجودی اولیه فقط در ماندهٔ کلی (همهٔ سال‌ها) حساب می‌شود، نه در تفکیک یک سال.
// ---------------------------------------------------------------------------

/** موجودی اولیه صندوق از settings — JSON {amount, note, updated_at} */
export async function getFundOpening(env) {
  const s = await getSettings(env);
  if (!s.fund_opening) return { amount: 0, note: '', updated_at: null };
  try {
    const o = JSON.parse(s.fund_opening);
    return { amount: Number(o && o.amount) || 0, note: String((o && o.note) || ''), updated_at: Number(o && o.updated_at) || null };
  } catch { return { amount: 0, note: '', updated_at: null }; }
}

async function fundTotals(env, { start, end, jy } = {}) {
  const debtQ = jy
    ? `SELECT COALESCE(SUM(paid_amount), 0) AS v FROM debts WHERE period LIKE ?`
    : `SELECT COALESCE(SUM(paid_amount), 0) AS v FROM debts`;
  const expQ = jy
    ? `SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE period LIKE ?`
    : `SELECT COALESCE(SUM(amount), 0) AS v FROM expenses`;
  const taskQ = start
    ? `SELECT COALESCE(SUM(cost), 0) AS v FROM tasks WHERE done_at >= ? AND done_at < ?`
    : `SELECT COALESCE(SUM(cost), 0) AS v FROM tasks`;

  const [d, e, t, opening] = await Promise.all([
    (jy ? env.DB.prepare(debtQ).bind(jy + '-%') : env.DB.prepare(debtQ)).first(),
    (jy ? env.DB.prepare(expQ).bind(jy + '-%') : env.DB.prepare(expQ)).first(),
    (start ? env.DB.prepare(taskQ).bind(start, end) : env.DB.prepare(taskQ)).first(),
    getFundOpening(env)
  ]);
  const collected = Number(d && d.v) || 0;
  const expenses = Number(e && e.v) || 0;
  const tasksCost = Number(t && t.v) || 0;
  // موجودی اولیه فقط در ماندهٔ کلی (بدون فیلتر سال) اعمال می‌شود
  const isAll = !jy && !start;
  const open = isAll ? (opening.amount || 0) : 0;
  return {
    collected, expenses, tasks_cost: tasksCost,
    opening: open,
    balance: open + collected - expenses - tasksCost
  };
}

route('GET', '/reports/performance', async (c) => {
  const jyParam = c.query.get('jy');
  const jy = isJalaliYear(jyParam || '') ? jyParam : tsJalaliPeriod(now()).jy;
  const range = jalaliYearRange(Number(jy));
  const jyLike = jy + '-%';

  const [fund, fundAll, tasks, expenses, debtMonths] = await Promise.all([
    fundTotals(c.env, { start: range.start, end: range.end, jy }),
    fundTotals(c.env, {}),
    listTasks(c.env, { start: range.start, end: range.end }),
    c.env.DB.prepare(
      `SELECT id, title, category, amount, period, spent_at FROM expenses WHERE period LIKE ? ORDER BY period DESC, id DESC LIMIT 1000`
    ).bind(jyLike).all(),
    c.env.DB.prepare(
      `SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected FROM debts WHERE period LIKE ? GROUP BY period`
    ).bind(jyLike).all()
  ]);

  const files = await filesForTasks(c.env, tasks.map(t => t.id));

  // ۱۲ ماه سال: تعداد و هزینهٔ کارها + هزینه‌های مشترک + وصولی
  const months = Array.from({ length: 12 }, (_, i) => ({
    period: `${jy}-${String(i + 1).padStart(2, '0')}`,
    tasks: 0, cost: 0, expenses: 0, collected: 0
  }));
  for (const t of tasks) {
    if (!t.done_at) continue;
    const { jm } = tsJalaliPeriod(t.done_at);
    if (months[jm - 1]) { months[jm - 1].tasks++; months[jm - 1].cost += t.cost || 0; }
  }
  for (const e of expenses.results || []) {
    const m = Number(String(e.period || '').slice(5, 7));
    if (m >= 1 && m <= 12) months[m - 1].expenses += e.amount || 0;
  }
  for (const d of debtMonths.results || []) {
    const m = Number(String(d.period || '').slice(5, 7));
    if (m >= 1 && m <= 12) months[m - 1].collected = Number(d.collected) || 0;
  }

  // تفکیک هزینهٔ کارها بر پایهٔ دسته
  const catMap = new Map();
  for (const t of tasks) {
    const cat = t.category || 'سایر';
    const cur = catMap.get(cat) || { category: cat, count: 0, cost: 0 };
    cur.count++; cur.cost += t.cost || 0;
    catMap.set(cat, cur);
  }
  const categories = [...catMap.values()].sort((a, b) => b.cost - a.cost || b.count - a.count);

  const taskFiles = tasks.map(t => ({ ...t, files: files.get(t.id) || [] }));

  return json({
    jy,
    fund,
    fund_all: fundAll,
    fund_opening: await getFundOpening(c.env),
    totals: {
      tasks: tasks.length,
      cost: tasks.reduce((s, t) => s + (t.cost || 0), 0),
      expenses_count: (expenses.results || []).length,
      expenses_amount: (expenses.results || []).reduce((s, e) => s + (e.amount || 0), 0)
    },
    months,
    categories,
    tasks: taskFiles,
    expenses: expenses.results || []
  });
}, 'user');

// ---------------------------------------------------------------------------
// v2.15.0 — PDF «کارهای مدیر ساختمان» برای همهٔ اعضا (واحدها در صفحهٔ خودشان)
// نسخهٔ متمرکز روی کارها + مدارک + ماندهٔ صندوق؛ بدون جزئیات مالی واحدها.
// ---------------------------------------------------------------------------
route('GET', '/pdf/tasks', async (c) => {
  const jyParam = c.query.get('jy');
  const jy = isJalaliYear(jyParam || '') ? jyParam : tsJalaliPeriod(now()).jy;
  const range = jalaliYearRange(Number(jy));

  const [fundAll, tasks, opening] = await Promise.all([
    fundTotals(c.env, {}),
    listTasks(c.env, { start: range.start, end: range.end }),
    getFundOpening(c.env)
  ]);
  const files = await filesForTasks(c.env, tasks.map(t => t.id));
  const s = await getSettings(c.env);

  const pdfBytes = await buildTasksReportPdf(c.env, {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    jy,
    totals: { tasks: tasks.length, cost: tasks.reduce((su, t) => su + (t.cost || 0), 0) },
    fund_all: fundAll,
    fund_opening: opening,
    tasks: tasks.map(t => ({ ...t, files: (files.get(t.id) || []).map(f => ({ name: f.name })) })),
    generated_at: now()
  });
  return new Response(pdfBytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="tasks-${jy}.pdf"`,
      'x-content-type-options': 'nosniff'
    }
  });
}, 'user');

// ---------------------------------------------------------------------------
// PDF گزارش عملکرد مدیر — همهٔ اعضای واردشده (شفافیت برای ساکنین)
// ---------------------------------------------------------------------------
route('GET', '/pdf/performance', async (c) => {
  const jyParam = c.query.get('jy');
  const jy = isJalaliYear(jyParam || '') ? jyParam : tsJalaliPeriod(now()).jy;
  const range = jalaliYearRange(Number(jy));
  const jyLike = jy + '-%';

  const [fund, tasks, expenses, debtMonths] = await Promise.all([
    fundTotals(c.env, { start: range.start, end: range.end, jy }),
    listTasks(c.env, { start: range.start, end: range.end }),
    c.env.DB.prepare(
      `SELECT id, title, category, amount, period, spent_at FROM expenses WHERE period LIKE ? ORDER BY period, id`
    ).bind(jyLike).all(),
    c.env.DB.prepare(
      `SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected FROM debts WHERE period LIKE ? GROUP BY period`
    ).bind(jyLike).all()
  ]);

  const fileCount = await c.env.DB.prepare(
    `SELECT task_id, COUNT(*) AS c FROM task_files WHERE task_id IN (SELECT id FROM tasks WHERE done_at >= ? AND done_at < ?) GROUP BY task_id`
  ).bind(range.start, range.end).all();
  const fcMap = new Map((fileCount.results || []).map(r => [r.task_id, r.c]));

  const months = Array.from({ length: 12 }, (_, i) => ({
    period: `${jy}-${String(i + 1).padStart(2, '0')}`,
    tasks: 0, cost: 0, expenses: 0, collected: 0
  }));
  for (const t of tasks) {
    if (!t.done_at) continue;
    const { jm } = tsJalaliPeriod(t.done_at);
    if (months[jm - 1]) { months[jm - 1].tasks++; months[jm - 1].cost += t.cost || 0; }
  }
  for (const e of expenses.results || []) {
    const m = Number(String(e.period || '').slice(5, 7));
    if (m >= 1 && m <= 12) months[m - 1].expenses += e.amount || 0;
  }
  for (const d of debtMonths.results || []) {
    const m = Number(String(d.period || '').slice(5, 7));
    if (m >= 1 && m <= 12) months[m - 1].collected = Number(d.collected) || 0;
  }

  const catMap = new Map();
  for (const t of tasks) {
    const cat = t.category || 'سایر';
    const cur = catMap.get(cat) || { category: cat, count: 0, cost: 0 };
    cur.count++; cur.cost += t.cost || 0;
    catMap.set(cat, cur);
  }

  const s = await getSettings(c.env);
  const [fundAll, opening] = await Promise.all([
    fundTotals(c.env, {}),
    getFundOpening(c.env)
  ]);
  const pdfBytes = await buildPerformanceReportPdf(c.env, {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    jy,
    fund,
    fund_all: fundAll,
    fund_opening: opening,
    totals: {
      tasks: tasks.length,
      cost: tasks.reduce((su, t) => su + (t.cost || 0), 0),
      expenses_count: (expenses.results || []).length,
      expenses_amount: (expenses.results || []).reduce((su, e) => su + (e.amount || 0), 0)
    },
    months,
    categories: [...catMap.values()].sort((a, b) => b.cost - a.cost || b.count - a.count),
    tasks: tasks.map(t => ({ ...t, files_count: fcMap.get(t.id) || 0 })),
    expenses: expenses.results || [],
    generated_at: now()
  });
  return new Response(pdfBytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="performance-${jy}.pdf"`,
      'x-content-type-options': 'nosniff'
    }
  });
}, 'user');

// ---------------------------------------------------------------------------
// helpers — base64 ↔ bytes (آپلود JSON و پشتیبان‌گیری)
// ---------------------------------------------------------------------------
export function b64ToBytes(s) {
  try {
    const norm = String(s || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!norm) return null;
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

export function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes || 0));
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < u8.length; i += STEP) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  }
  return btoa(bin);
}
