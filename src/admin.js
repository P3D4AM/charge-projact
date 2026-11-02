// App-admin routes (/a/*, role=admin only) + shared finance views (admin+manager).
// This is the «پنل مدیریت کل اپ» — installation, appointing building managers,
// user accounts, app settings, sample data. Completely separate from the
// building manager's mini-app surface.
import { route } from './router.js';
import {
  json, fail, now, getSettings, setSetting, splitEqual, splitByArea,
  getAllUnits, validUsername, validPassword, publicSettings, APP_VERSION,
  normalizeTelegramUsername, validTelegramUsername
} from './helpers.js';
import { hashPassword, publicUser, bumpTokenEpoch } from './auth.js';
import { currentPeriod, isJalaliYear, isPeriod, periodLabel } from './jalali.js';
import {
  sendTelegramMessage, setWebhook, getBotInfo, getBotToken, botTokenSource,
  getWebhookInfo, deleteWebhook, setMyCommands, setChatMenuButton,
  sendPersonalToUser
} from './telegram.js';
import { rememberAppUrl } from './scheduler.js';
import { visitQuickStats } from './visits.js';
import { logOutgoingBotMessage } from './botmessages.js';
import { buildYearReportPdf, buildMonthlyReportPdf } from './pdf.js';

// ---------------------------------------------------------------------------
// MANAGER-ONLY finance views — total residents' debt is visible ONLY to the
// building manager (per access policy). The app-admin panel intentionally has
// no financial data.
// ---------------------------------------------------------------------------
route('GET', '/dashboard', async (c) => {
  const q = c.query;
  const period = isPeriod(q.get('period') || '') ? q.get('period') : currentPeriod();
  const jy = period.slice(0, 4);

  const totals = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS issued, COALESCE(SUM(paid_amount), 0) AS collected FROM debts'
  ).first();
  const month = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(amount), 0) AS issued, COALESCE(SUM(paid_amount), 0) AS collected FROM debts WHERE period = ?'
  ).bind(period).first();
  const debtors = await c.env.DB.prepare(
    'SELECT COUNT(DISTINCT unit_id) AS c FROM debts WHERE amount > paid_amount'
  ).first();
  const unitsCount = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM units').first();
  const series = await c.env.DB.prepare(`
    SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected
    FROM debts WHERE period LIKE ?
    GROUP BY period ORDER BY period
  `).bind(jy + '-%').all();

  const recent = await c.env.DB.prepare(`
    SELECT d.id, d.period, d.kind, d.description, d.paid_amount, d.paid_at, d.method,
           u.number AS unit_number, u.resident_name
    FROM debts d JOIN units u ON u.id = d.unit_id
    WHERE d.paid_amount > 0
    ORDER BY COALESCE(NULLIF(d.paid_at, 0), d.created_at) DESC
    LIMIT 8
  `).all();

  const top = await c.env.DB.prepare(`
    SELECT u.id, u.number, u.resident_name,
           COALESCE(SUM(d.amount - d.paid_amount), 0) AS debt
    FROM units u LEFT JOIN debts d ON d.unit_id = u.id
    GROUP BY u.id
    HAVING debt > 0
    ORDER BY debt DESC
    LIMIT 5
  `).all();

  return json({
    period,
    totals: { issued: totals.issued, collected: totals.collected, outstanding: Math.max(0, totals.issued - totals.collected) },
    month: { issued: month.issued, collected: month.collected },
    units_count: unitsCount.c,
    debtors_count: debtors.c,
    series: series.results || [],
    recent: recent.results || [],
    top: top.results || []
  });
}, 'manager');

route('GET', '/reports/year', async (c) => {
  const q = c.query;
  const jy = isJalaliYear(q.get('jy') || '') ? q.get('jy') : currentPeriod().slice(0, 4);
  const series = await c.env.DB.prepare(`
    SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected, COUNT(*) AS items
    FROM debts WHERE period LIKE ?
    GROUP BY period ORDER BY period
  `).bind(jy + '-%').all();

  // v2.14.0 — «تعداد یادآوری»: how many reminders each unit's unpaid items got
  const byUnit = await c.env.DB.prepare(`
    SELECT u.id, u.number, u.resident_name, u.area_m2,
           COALESCE(SUM(d.amount), 0) AS issued, COALESCE(SUM(d.paid_amount), 0) AS paid,
           COALESCE(MAX(CASE WHEN d.paid_amount < d.amount THEN d.remind_count END), 0) AS remind_count,
           MAX(CASE WHEN d.paid_amount < d.amount THEN d.last_remind_at END) AS last_remind_at
    FROM units u LEFT JOIN debts d ON d.unit_id = u.id AND d.period LIKE ?
    GROUP BY u.id
    ORDER BY (COALESCE(SUM(d.amount), 0) - COALESCE(SUM(d.paid_amount), 0)) DESC
  `).bind(jy + '-%').all();

  return json({ jy, series: series.results || [], by_unit: byUnit.results || [] });
}, 'manager');

// Yearly building report PDF (shared)
route('GET', '/pdf/report', async (c) => {
  const jy = isJalaliYear(c.query.get('jy') || '') ? c.query.get('jy') : currentPeriod().slice(0, 4);
  const seriesRes = await c.env.DB.prepare(`
    SELECT period, SUM(amount) AS issued, SUM(paid_amount) AS collected
    FROM debts WHERE period LIKE ?
    GROUP BY period ORDER BY period
  `).bind(jy + '-%').all();
  const byUnitRes = await c.env.DB.prepare(`
    SELECT u.id, u.number, u.resident_name,
           COALESCE(SUM(d.amount), 0) AS issued, COALESCE(SUM(d.paid_amount), 0) AS paid
    FROM units u LEFT JOIN debts d ON d.unit_id = u.id AND d.period LIKE ?
    GROUP BY u.id
    ORDER BY LENGTH(u.number), u.number
  `).bind(jy + '-%').all();
  const s = await getSettings(c.env);

  const pdfBytes = await buildYearReportPdf(c.env, {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    jy,
    series: seriesRes.results || [],
    by_unit: byUnitRes.results || [],
    generated_at: now()
  });
  return new Response(pdfBytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="report-${jy}.pdf"`,
      'x-content-type-options': 'nosniff'
    }
  });
}, 'manager');

// ---------------------------------------------------------------------------
// v2.12.0 — گزارش ماهیانه همه واحدها (JSON برای تب گزارش‌ها + PDF)
// Per-unit aggregation of a single month, including each unit's payment notes.
// ---------------------------------------------------------------------------
async function monthlyReportData(env, period) {
  const { results: debts } = await env.DB.prepare(`
    SELECT d.*, u.number AS unit_number, u.resident_name
    FROM debts d JOIN units u ON u.id = d.unit_id
    WHERE d.period = ?
    ORDER BY LENGTH(u.number), u.number, d.id
  `).bind(period).all();
  const units = await getAllUnits(env);
  const map = new Map();
  for (const u of units || []) {
    map.set(u.id, {
      id: u.id, number: u.number, resident_name: u.resident_name,
      items: 0, issued: 0, paid: 0, notes: []
    });
  }
  let issued = 0, collected = 0;
  for (const d of debts || []) {
    issued += d.amount;
    collected += d.paid_amount;
    const r = map.get(d.unit_id);
    if (!r) continue;
    r.items++;
    r.issued += d.amount;
    r.paid += d.paid_amount;
    const n = String(d.note || '').trim();
    if (n) r.notes.push({ description: d.description || '', note: n });
  }
  return {
    period,
    totals: { issued, collected, remaining: Math.max(0, issued - collected) },
    by_unit: [...map.values()]
  };
}

route('GET', '/reports/month', async (c) => {
  const period = isPeriod(c.query.get('period') || '') ? c.query.get('period') : currentPeriod();
  return json(await monthlyReportData(c.env, period));
}, 'manager');

// Monthly all-units report PDF (shared)
route('GET', '/pdf/monthly', async (c) => {
  const period = isPeriod(c.query.get('period') || '') ? c.query.get('period') : currentPeriod();
  const data = await monthlyReportData(c.env, period);
  const s = await getSettings(c.env);
  const pdfBytes = await buildMonthlyReportPdf(c.env, {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    period: data.period,
    totals: data.totals,
    by_unit: data.by_unit,
    generated_at: now()
  });
  return new Response(pdfBytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="monthly-report-${period}.pdf"`,
      'x-content-type-options': 'nosniff'
    }
  });
}, 'manager');

// ---------------------------------------------------------------------------
// ADMIN ONLY
// ---------------------------------------------------------------------------
route('GET', '/a/overview', async (c) => {
  const s = await getSettings(c.env);
  const counts = {};
  for (const role of ['admin', 'manager', 'resident']) {
    const row = await c.env.DB.prepare(
      'SELECT COUNT(*) AS c FROM users WHERE role = ? AND is_active = 1'
    ).bind(role).first();
    counts[role] = row ? row.c : 0;
  }
  const unitsCount = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM units').first();

  const botToken = await getBotToken(c.env);
  let bot = { configured: Boolean(botToken) };
  if (bot.configured && !c.query.has('fast')) {
    const info = await getBotInfo(botToken);
    if (info.ok) bot = { ...bot, username: info.username, connected: true };
    else bot = { ...bot, connected: false, error: info.error };
  }

  // visit counters (گزارش بازدید و ورود) — non-financial, safe for this panel
  const visits = await visitQuickStats(c.env);

  return json({
    installed: true,
    building_name: s.building_name || 'ساختمان من',
    app_url: new URL(c.request.url).origin,
    version: APP_VERSION,
    counts: { ...counts, units: unitsCount.c },
    bot,
    visits,
    installed_at: s.installed_at || null
  });
}, 'admin');

// --- building managers -----------------------------------------------------
route('GET', '/a/managers', async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT m.*, u.number AS unit_number FROM users m
    LEFT JOIN units u ON u.id = m.unit_id
    WHERE m.role = 'manager'
    ORDER BY m.created_at DESC
  `).all();
  return json({ managers: (results || []).map(m => ({ ...publicUser(m), unit_number: m.unit_number || null })) });
}, 'admin');

// units list for admin forms (e.g. linking a manager to their own unit)
route('GET', '/a/units', async (c) => {
  const units = await getAllUnits(c.env);
  return json({ units: units.map(u => ({ id: u.id, number: u.number, resident_name: u.resident_name })) });
}, 'admin');

route('POST', '/a/managers', async (c) => {
  const b = c.body || {};
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const fullName = String(b.full_name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 20);
  const tgUsername = normalizeTelegramUsername(b.telegram_username);
  const unitId = b.unit_id ? Number(b.unit_id) || null : null;
  // v2.17.0 — «مدیر، ساکن ساختمان نیست»: از بدهکاران شارژ و یادآوری‌ها مستثنی می‌شود
  const isResident = b.is_resident === undefined ? 1 : (b.is_resident ? 1 : 0);
  if (!validUsername(username)) return fail('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
  if (!validPassword(password)) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');
  if (!fullName) return fail('نام و نام خانوادگی مدیر را وارد کنید');
  if (!validTelegramUsername(tgUsername)) {
    return fail('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
  }
  if (unitId) {
    const unit = await c.env.DB.prepare('SELECT id FROM units WHERE id = ?').bind(unitId).first();
    if (!unit) return fail('واحد انتخاب‌شده پیدا نشد', 404);
  }
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE lower(username) = ? LIMIT 1')
    .bind(username).first();
  if (dup) return fail('این نام کاربری قبلاً استفاده شده است', 409);
  const hash = await hashPassword(password);
  const res = await c.env.DB.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, phone, unit_id, telegram_username, is_active, is_resident, created_by, created_at)
    VALUES (?, ?, 'manager', ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(username, hash, fullName, phone, unitId, tgUsername, isResident, c.user.id, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ manager: publicUser(row) }, 201);
}, 'admin');

// --- user management (managers + residents) --------------------------------
// Create any user from the admin panel: a resident of a unit, or a building
// manager. Residents are limited to one account per unit (same rule as the
// manager surface).
route('POST', '/a/users', async (c) => {
  const b = c.body || {};
  const role = ['manager', 'resident'].includes(b.role) ? b.role : 'resident';
  const username = String(b.username || '').trim().toLowerCase();
  const password = String(b.password || '');
  const fullName = String(b.full_name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').trim().slice(0, 20);
  const tgUsername = normalizeTelegramUsername(b.telegram_username);
  const unitId = b.unit_id ? Number(b.unit_id) || null : null;
  if (!validUsername(username)) return fail('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
  if (!validPassword(password)) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');
  if (!fullName) return fail('نام و نام خانوادگی را وارد کنید');
  if (!validTelegramUsername(tgUsername)) {
    return fail('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
  }
  if (role === 'resident' && !unitId) return fail('برای حساب ساکن، انتخاب واحد الزامی است');
  if (unitId) {
    const unit = await c.env.DB.prepare('SELECT id FROM units WHERE id = ?').bind(unitId).first();
    if (!unit) return fail('واحد انتخاب‌شده پیدا نشد', 404);
    if (role === 'resident') {
      const taken = await c.env.DB.prepare(
        "SELECT id FROM users WHERE role = 'resident' AND unit_id = ? LIMIT 1"
      ).bind(unitId).first();
      if (taken) return fail('این واحد قبلاً حساب ساکن دارد؛ حساب قبلی را ویرایش یا حذف کنید', 409);
    }
  }
  const dup = await c.env.DB.prepare('SELECT id FROM users WHERE lower(username) = ? LIMIT 1')
    .bind(username).first();
  if (dup) return fail('این نام کاربری قبلاً استفاده شده است', 409);
  const hash = await hashPassword(password);
  // v2.17.0 — پرچم «مدیر ساکن است» فقط برای نقش manager معنا دارد
  const isResident = role === 'manager'
    ? (b.is_resident === undefined ? 1 : (b.is_resident ? 1 : 0))
    : 1;
  const res = await c.env.DB.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, phone, unit_id, telegram_username, is_active, is_resident, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(username, hash, role, fullName, phone, unitId, tgUsername, isResident, c.user.id, now()).run();
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(res.meta.last_row_id).first();
  return json({ user: publicUser(row) }, 201);
}, 'admin');

route('GET', '/a/users', async (c) => {
  const role = c.query.get('role');
  const roles = ['manager', 'resident'].includes(role) ? [role] : ['admin', 'manager', 'resident'];
  const { results } = await c.env.DB.prepare(`
    SELECT u.*, un.number AS unit_number FROM users u
    LEFT JOIN units un ON un.id = u.unit_id
    ORDER BY u.role, u.created_at DESC
  `).all();
  const users = (results || [])
    .filter(u => roles.includes(u.role))
    .map(u => ({ ...publicUser(u), unit_number: u.unit_number || null }));
  return json({ users });
}, 'admin');

route('PUT', '/a/users/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) return fail('کاربر پیدا نشد', 404);
  if (row.role === 'admin' && row.id === c.user.id && (c.body || {}).is_active === false) {
    return fail('نمی‌توانید حساب خودتان را غیرفعال کنید', 409);
  }
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

  // Role control: promote resident → manager, demote manager → resident.
  // The app-admin role itself can never be granted or taken away here.
  let newRole = row.role;
  if (b.role !== undefined && b.role !== row.role) {
    if (!['manager', 'resident'].includes(b.role)) {
      return fail('تغییر نقش فقط بین «مدیر ساختمان» و «ساکن» امکان‌پذیر است', 400);
    }
    if (row.role === 'admin') {
      return fail('نقش مدیر اپ قابل تغییر نیست', 409);
    }
    newRole = b.role;
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
  let unitId = row.unit_id;
  if (b.unit_id !== undefined) {
    unitId = b.unit_id ? Number(b.unit_id) || null : null;
    if (unitId) {
      const unit = await c.env.DB.prepare('SELECT id FROM units WHERE id = ?').bind(unitId).first();
      if (!unit) return fail('واحد انتخاب‌شده پیدا نشد', 404);
      // after a role change to resident, the unit must not already have an account
      if (newRole === 'resident' && row.role !== 'resident') {
        const taken = await c.env.DB.prepare(
          "SELECT id FROM users WHERE role = 'resident' AND unit_id = ? AND id != ? LIMIT 1"
        ).bind(unitId, id).first();
        if (taken) return fail('این واحد قبلاً حساب ساکن دارد؛ حساب قبلی را ویرایش یا حذف کنید', 409);
      }
    }
  }
  await c.env.DB.prepare('UPDATE users SET username = ?, full_name = ?, phone = ?, is_active = ?, unit_id = ?, role = ?, telegram_username = ?, is_resident = ? WHERE id = ?')
    .bind(newUsername, fullName, phone, isActive, unitId, newRole, tgUsername,
      // v2.17.0 — پرچم سکونت مدیر؛ برای ساکن همیشه ۱
      newRole === 'manager'
        ? (b.is_resident === undefined ? (Number(row.is_resident === undefined ? 1 : row.is_resident) || 0 ? 1 : 0) : (b.is_resident ? 1 : 0))
        : 1,
      id).run();
  if (b.password) {
    if (!validPassword(String(b.password))) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');
    const hash = await hashPassword(String(b.password));
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, id).run();
    // v2.14.0 — password reset revokes all that user's existing sessions
    await bumpTokenEpoch(c.env, id);
  }
  const updated = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  return json({ user: publicUser(updated) });
}, 'admin');

route('DELETE', '/a/users/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!row) return fail('کاربر پیدا نشد', 404);
  if (row.role === 'admin') return fail('حساب مدیر اپ قابل حذف نیست', 409);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
}, 'admin');

// Personal Telegram message to one user from the app-admin panel.
// Works once the user's account is linked (first app open / bot start).
route('POST', '/a/users/:id/message', async (c) => {
  const r = await sendPersonalToUser(c.env, Number(c.params.id), String((c.body || {}).text || ''), c.ctx);
  if (!r.ok) return fail(r.error, r.status || 500, r.code);
  return json({ ok: true, user: r.user });
}, 'admin');

// --- app settings (building name & install-level config) --------------------
route('GET', '/a/settings', async (c) => {
  const s = await getSettings(c.env);
  return json({
    settings: publicSettings(s),
    installed_at: s.installed_at || null,
    bot_configured: Boolean(await getBotToken(c.env)),
    app_url: new URL(c.request.url).origin
  });
}, 'admin');

route('POST', '/a/settings', async (c) => {
  const b = c.body || {};
  const fields = {
    building_name: v => {
      const name = String(v).trim().slice(0, 80);
      if (!name) throw new Error('نام ساختمان نمی‌تواند خالی باشد');
      return name;
    },
    address: v => String(v).trim().slice(0, 200),
    phone: v => String(v).trim().slice(0, 20),
    bank_card: v => String(v).trim().slice(0, 30),
    bank_owner: v => String(v).trim().slice(0, 80),
    default_monthly_amount: v => String(Math.max(0, Math.round(Number(v) || 0)))
  };
  for (const [key, fn] of Object.entries(fields)) {
    if (b[key] !== undefined) {
      try {
        await setSetting(c.env, key, fn(b[key]));
      } catch (e) {
        return fail(String(e && e.message) || 'مقدار نامعتبر است');
      }
    }
  }
  return json({ ok: true, settings: publicSettings(await getSettings(c.env)) });
}, 'admin');

// --- bot setup (token is managed from the admin panel, stored in settings) --
function maskToken(t) {
  const s = String(t || '');
  if (s.length < 10) return '••••';
  const [id] = s.split(':');
  return `${id}:••••••${s.slice(-4)}`;
}

function botLinks(username, origin) {
  return {
    app: origin,
    bot: username ? `https://t.me/${username}` : null,
    add_to_group: username ? `https://t.me/${username}?startgroup=true` : null
  };
}

route('GET', '/a/bot', async (c) => {
  const origin = new URL(c.request.url).origin;
  const token = await getBotToken(c.env);
  if (!token) {
    return json({
      configured: false,
      source: null,
      hint: 'توکن ربات را از @BotFather بگیرید و همین‌جا ثبت کنید (بدون نیاز به ترمینال).'
    });
  }
  const source = await botTokenSource(c.env);
  const info = await getBotInfo(token);
  const wh = await getWebhookInfo(token);
  const expectedWebhook = origin + '/webhook/telegram';
  const whInfo = wh.ok ? (wh.info || {}) : null;
  return json({
    configured: true,
    source, // 'settings' (panel) | 'env' (wrangler secret/vars)
    masked: maskToken(token),
    connected: info.ok,
    username: info.ok ? info.username : null,
    bot_id: info.ok ? info.id : null,
    error: info.ok ? null : info.error,
    webhook: whInfo ? {
      url: whInfo.url || '',
      matches_app: (whInfo.url || '') === expectedWebhook,
      pending_updates: whInfo.pending_update_count || 0,
      last_error: whInfo.last_error_message || null
    } : { error: wh.error },
    expected_webhook_url: expectedWebhook,
    links: botLinks(info.ok ? info.username : null, origin)
  });
}, 'admin');

// Save + verify a bot token from the panel; then auto-wire webhook, commands
// and the private-chat menu button so the bot is instantly usable.
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

route('POST', '/a/bot/token', async (c) => {
  let token = String((c.body || {}).token || '').trim();
  token = token.replace(/[\s'"`]+/g, ''); // tolerate copy/paste artifacts
  if (!token) return fail('توکن ربات را وارد کنید', 400, 'bad_token');
  if (!TOKEN_RE.test(token)) {
    return fail('قالب توکن معتبر نیست؛ توکن از @BotFather به شکل «123456789:AAEx…» است', 400, 'bad_token');
  }
  const info = await getBotInfo(token);
  if (!info.ok) {
    return fail('توکن ربات تأیید نشد: ' + (info.error || 'نامشخص'), 502, 'token_invalid');
  }
  await setSetting(c.env, 'bot_token', token);
  // v2.17.0 — کشِ یوزرنیم ربات (برای ساخت لینک دعوت) باطل شود
  try { await c.env.DB.prepare("DELETE FROM settings WHERE key = 'bot_username'").run(); } catch { /* ignore */ }

  const origin = new URL(c.request.url).origin;
  await rememberAppUrl(c.env, origin); // cron reminders need the origin for the app button
  const wh = await setWebhook(token, origin + '/webhook/telegram', c.env.WEBHOOK_SECRET || '');
  const menu = await setChatMenuButton(token, origin);
  const cmds = await setMyCommands(token);
  return json({
    ok: true,
    username: info.username,
    bot_id: info.id,
    webhook_ok: wh.ok,
    webhook_error: wh.ok ? null : wh.error,
    menu_ok: menu.ok,
    commands_ok: cmds.ok,
    links: botLinks(info.username, origin)
  });
}, 'admin');

route('DELETE', '/a/bot/token', async (c) => {
  const source = await botTokenSource(c.env);
  if (source !== 'settings') {
    return fail('توکن فعلی از متغیر محیطی (wrangler secret) تنظیم شده و از اینجا قابل حذف نیست', 409, 'env_token');
  }
  const token = await getBotToken(c.env);
  const row = await c.env.DB.prepare("DELETE FROM settings WHERE key = 'bot_token'").run();
  void row;
  try { await c.env.DB.prepare("DELETE FROM settings WHERE key = 'bot_username'").run(); } catch { /* v2.17.0 cache */ }
  if (token) { try { await deleteWebhook(token); } catch { /* best effort */ } }
  return json({ ok: true });
}, 'admin');

// Re-apply menu button + commands (e.g. after changing the app URL/domain)
route('POST', '/a/bot/menu', async (c) => {
  const token = await getBotToken(c.env);
  if (!token) return fail('توکن ربات تنظیم نشده است', 409);
  const origin = new URL(c.request.url).origin;
  const menu = await setChatMenuButton(token, origin);
  const cmds = await setMyCommands(token);
  if (!menu.ok || !cmds.ok) {
    return fail('اعمال دکمه منو/دستورات ناموفق بود: ' + (menu.error || cmds.error || ''), 502);
  }
  return json({ ok: true });
}, 'admin');

route('POST', '/a/bot/webhook', async (c) => {
  const token = await getBotToken(c.env);
  if (!token) return fail('توکن ربات تنظیم نشده است', 409);
  const origin = new URL(c.request.url).origin;
  await rememberAppUrl(c.env, origin); // keep the cron-side app URL fresh
  const res = await setWebhook(token, origin + '/webhook/telegram', c.env.WEBHOOK_SECRET || '');
  return res.ok ? json({ ok: true, url: origin + '/webhook/telegram' })
    : fail('ثبت وب‌هوک ناموفق بود: ' + res.error, 502);
}, 'admin');

// Send a test message to the app-admin's own Telegram account (if linked)
route('POST', '/a/bot/test', async (c) => {
  const token = await getBotToken(c.env);
  if (!token) return fail('توکن ربات تنظیم نشده است', 409);
  const text = String((c.body || {}).text || '').trim() || ('تست ارسال از ' + (await getSettings(c.env)).building_name);
  const row = await c.env.DB.prepare(
    "SELECT telegram_user_id FROM users WHERE telegram_user_id IS NOT NULL AND role = 'admin' LIMIT 1"
  ).first();
  if (!row) return fail('هیچ حسابی به تلگرام متصل نیست؛ ابتدا از طریق مینی‌اپ وارد شوید', 409);
  const res = await sendTelegramMessage(token, row.telegram_user_id, text);
  if (res.ok) {
    // v2.19.0 — ثبت پیام آزمایشی ربات در «گزارش پیام‌های ربات»
    try { await logOutgoingBotMessage(c.env, { chatId: row.telegram_user_id, text, title: 'پیام آزمایشی' }, c.ctx); } catch { /* never break */ }
  }
  return res.ok ? json({ ok: true }) : fail('ارسال ناموفق: ' + res.error, 502);
}, 'admin');

// --- sample data & reset (installation tools) --------------------------------
route('POST', '/a/dev/seed', async (c) => {
  const force = Boolean((c.body || {}).force);
  const existing = await getAllUnits(c.env);
  if (existing.length > 0 && !force) return fail('واحدهایی وجود دارد؛ گزینه «بازنویسی» را فعال کنید', 409);

  if (existing.length > 0 && force) {
    // wipe existing building data before re-seeding
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM debts'),
      c.env.DB.prepare('DELETE FROM expenses'),
      c.env.DB.prepare("DELETE FROM users WHERE role = 'resident'"),
      c.env.DB.prepare('DELETE FROM units')
    ]);
  }

  const sample = [
    { number: '1', name: 'علی رضایی', phone: '09121110001', area: 85, residents: 2 },
    { number: '2', name: 'مریم احمدی', phone: '09121110002', area: 110, residents: 3 },
    { number: '3', name: 'حسین کریمی', phone: '09121110003', area: 95, residents: 2 },
    { number: '4', name: 'زهرا موسوی', phone: '09121110004', area: 120, residents: 4 },
    { number: '5', name: 'رضا محمدی', phone: '09121110005', area: 75, residents: 1 },
    { number: '6', name: 'سارا حسینی', phone: '09121110006', area: 130, residents: 3 },
    { number: '7', name: 'امیر نادری', phone: '09121110007', area: 100, residents: 2 },
    { number: '8', name: 'نرگس صادقی', phone: '09121110008', area: 105, residents: 3 }
  ];
  const ts = now();
  await c.env.DB.batch(sample.map(u => c.env.DB.prepare(`
    INSERT INTO units (number, resident_name, phone, area_m2, residents_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(u.number, u.name, u.phone, u.area, u.residents, ts)));

  // resident login accounts: username unit1..unit8, password 1234
  const units = await getAllUnits(c.env);
  const defaultPass = await hashPassword('1234');
  const accStmts = units.map((u, i) => c.env.DB.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, phone, unit_id, is_active, created_by, created_at)
    VALUES (?, ?, 'resident', ?, ?, ?, 1, ?, ?)
  `).bind('unit' + u.number, defaultPass, sample[i].name, sample[i].phone, u.id, c.user.id, ts));
  await c.env.DB.batch(accStmts);

  const period = currentPeriod();
  const paidUnits = new Set(['1', '2', '3', '4', '5']);
  const partialUnits = new Set(['6']);
  const debtStmts = units.map(u => c.env.DB.prepare(`
    INSERT INTO debts (unit_id, kind, period, description, amount, paid_amount, status, paid_at, method, created_at)
    VALUES (?, 'monthly', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    u.id, period, 'شارژ ماه ' + periodLabel(period), 650000,
    paidUnits.has(u.number) ? 650000 : (partialUnits.has(u.number) ? 300000 : 0),
    paidUnits.has(u.number) ? 'paid' : (partialUnits.has(u.number) ? 'partial' : 'unpaid'),
    paidUnits.has(u.number) || partialUnits.has(u.number) ? ts - 86400 * 3 : null,
    paidUnits.has(u.number) ? 'کارت به کارت' : (partialUnits.has(u.number) ? 'نقدی' : ''),
    ts
  ));
  await c.env.DB.batch(debtStmts);

  const [py, pm] = period.split('-').map(Number);
  const prevPeriod = `${pm === 1 ? py - 1 : py}-${pm === 1 ? 12 : String(pm - 1).padStart(2, '0')}`;
  const prevStmts = units.map(u => {
    const paid = !['7', '8'].includes(u.number);
    return c.env.DB.prepare(`
      INSERT INTO debts (unit_id, kind, period, description, amount, paid_amount, status, paid_at, method, created_at)
      VALUES (?, 'monthly', ?, ?, 650000, ?, ?, ?, ?, ?)
    `).bind(
      u.id, prevPeriod, 'شارژ ماه ' + periodLabel(prevPeriod),
      paid ? 650000 : 0, paid ? 'paid' : 'unpaid',
      paid ? ts - 86400 * 35 : null, paid ? 'پایا' : '', ts - 86400 * 40
    );
  });
  await c.env.DB.batch(prevStmts);

  const exp1 = await c.env.DB.prepare(`
    INSERT INTO expenses (title, category, amount, period, split_mode, spent_at, created_at)
    VALUES (?, ?, ?, ?, 'equal', ?, ?)
  `).bind('هزینه نظافت', 'نظافت', 1200000, period, ts - 86400 * 5, ts).run();
  const exp2 = await c.env.DB.prepare(`
    INSERT INTO expenses (title, category, amount, period, split_mode, spent_at, created_at)
    VALUES (?, ?, ?, ?, 'area', ?, ?)
  `).bind('قبض برق مشترک', 'برق', 800000, period, ts - 86400 * 2, ts).run();

  const expDebtStmts = [];
  const equalShares = splitEqual(1200000, units.length);
  units.forEach((u, i) => {
    if (equalShares[i] > 0) expDebtStmts.push(c.env.DB.prepare(`
      INSERT INTO debts (unit_id, kind, expense_id, period, description, amount, created_at)
      VALUES (?, 'expense', ?, ?, ?, ?, ?)
    `).bind(u.id, exp1.meta.last_row_id, period, 'سهم هزینه: هزینه نظافت', equalShares[i], ts));
  });
  const areaShares = splitByArea(800000, units) || splitEqual(800000, units.length);
  units.forEach((u, i) => {
    if (areaShares[i] > 0) expDebtStmts.push(c.env.DB.prepare(`
      INSERT INTO debts (unit_id, kind, expense_id, period, description, amount, created_at)
      VALUES (?, 'expense', ?, ?, ?, ?, ?)
    `).bind(u.id, exp2.meta.last_row_id, period, 'سهم هزینه: قبض برق مشترک', areaShares[i], ts));
  });
  await c.env.DB.batch(expDebtStmts);

  await setSetting(c.env, 'installed_at', String(ts));

  return json({
    ok: true,
    units: units.length,
    accounts: accStmts.length,
    debts: debtStmts.length + prevStmts.length + expDebtStmts.length,
    login_hint: 'نام کاربری ساکنین: unit1 تا unit8 — رمز: 1234'
  });
}, 'admin');

route('POST', '/a/dev/reset', async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM debts'),
    c.env.DB.prepare('DELETE FROM expenses'),
    c.env.DB.prepare('DELETE FROM users WHERE role = ?').bind('resident'),
    c.env.DB.prepare('DELETE FROM units')
  ]);
  return json({ ok: true });
}, 'admin');

// stats helper used by admin panel footer
route('GET', '/a/version', async () => json({ version: APP_VERSION }), 'admin');
