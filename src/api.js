// API dispatcher + auth/install/resident routes for the Building Charges app.
import { route, matchRoute } from './router.js';
import {
  json, fail, readBody, now, getSettings, setSetting, publicSettings,
  countAdmins, validUsername, validPassword, APP_VERSION
} from './helpers.js';
import {
  buildAuthContext, loginWithPassword, createSessionToken, bumpTokenEpoch,
  hashPassword, verifyPassword, publicUser
} from './auth.js';
import { currentPeriod } from './jalali.js';
import { buildStatementPdf } from './pdf.js';
import { getBotToken } from './telegram.js';
import { logVisit } from './visits.js';
import { ensureSchema } from './migrate.js';
import { unitCredit, creditEntries } from './credits.js';

// register route groups (side-effect route() registration)
import './manager.js';
import './admin.js';
import './polls.js';
import './visits.js';
import './tasks.js';
import './claims.js';
import './invites.js';
import './credits.js';
import './actnotifs.js';
import './mreminders.js';

// ---------------------------------------------------------------------------
// PUBLIC
// ---------------------------------------------------------------------------
route('GET', '/health', async () =>
  json({ ok: true, name: 'building-charges', version: APP_VERSION, time: now() }), 'public');

route('GET', '/install-status', async (c) => {
  const admins = await countAdmins(c.env);
  return json({ installed: admins > 0, version: APP_VERSION });
}, 'public');

// First-run installation — only allowed while no admin exists.
route('POST', '/install', async (c) => {
  if (await countAdmins(c.env) > 0) {
    return fail('اپ قبلاً نصب شده است؛ برای ورود از صفحه ورود استفاده کنید', 409, 'already_installed');
  }
  const b = c.body || {};
  const buildingName = String(b.building_name || '').trim().slice(0, 80);
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!buildingName) return fail('نام ساختمان الزامی است');
  if (!validUsername(username)) return fail('نام کاربری باید ۳ تا ۳۲ کاراکتر و شامل حروف لاتین، رقم، نقطه یا زیرخط باشد');
  if (!validPassword(password)) return fail('رمز عبور باید حداقل ۶ کاراکتر باشد');

  const hash = await hashPassword(password);
  await c.env.DB.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, is_active, created_at)
    VALUES (?, ?, 'admin', ?, 1, ?)
  `).bind(username.toLowerCase(), hash, 'مدیر اپ', now()).run();
  await setSetting(c.env, 'building_name', buildingName);
  if (b.address !== undefined) await setSetting(c.env, 'address', String(b.address).trim().slice(0, 200));

  const admin = await c.env.DB.prepare(
    "SELECT * FROM users WHERE username = ? LIMIT 1"
  ).bind(username.toLowerCase()).first();
  const token = await createSessionToken(c.env, admin.id, admin.role);
  return json({ ok: true, token, user: publicUser(admin) }, 201);
}, 'public');

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
route('POST', '/auth/login', async (c) => {
  const b = c.body || {};
  const res = await loginWithPassword(c.request, c.env, b.username, b.password);
  if (res.error) return fail(res.error, res.status || 401, res.code || 'login_failed');
  // visit log (گزارش ورود): every successful password login is recorded;
  // residents trigger the Telegram notification for managers/admin (best-effort)
  try {
    const via = (c.request.headers.get('x-telegram-init-data') || '') ? 'telegram' : 'web';
    await logVisit(c.env, res.user, 'login', via, c.ctx);
  } catch { /* never break login */ }
  const token = await createSessionToken(c.env, res.user.id, res.user.role, res.user.token_epoch, res.tgId || res.boundTg || 0);
  const unit = res.user.unit_id
    ? await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(res.user.unit_id).first()
    : null;
  return json({
    token,
    linked_telegram: Boolean(res.linked),
    user: publicUser(res.user),
    unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name } : null
  });
}, 'public');

// Exchange Telegram initData for a session (auto-login for linked accounts)
route('POST', '/auth/telegram', async (c) => {
  if (!c.auth) return fail('حساب تلگرام شما به هیچ حساب کاربری متصل نیست؛ با نام کاربری و رمز وارد شوید', 401, 'not_linked');
  try { await logVisit(c.env, c.auth.user, 'open', 'telegram', c.ctx); } catch { /* never break auth */ }
  const token = await createSessionToken(c.env, c.auth.user.id, c.auth.user.role, c.auth.user.token_epoch, c.auth.tgUser ? c.auth.tgUser.id : 0);
  return json({
    token,
    user: publicUser(c.auth.user),
    unit: c.auth.unit ? { id: c.auth.unit.id, number: c.auth.unit.number, resident_name: c.auth.unit.resident_name } : null
  });
}, 'public');

route('GET', '/auth/me', async (c) => {
  // visit log (گزارش بازدید): each app open with a remembered session lands here;
  // opens of the same user within 5 minutes are deduplicated inside logVisit
  try {
    const via = (c.request.headers.get('x-telegram-init-data') || '')
      ? 'telegram' : (c.auth.via || 'session');
    await logVisit(c.env, c.auth.user, 'open', via, c.ctx);
  } catch { /* never break auth */ }
  const s = await getSettings(c.env);
  const u = c.auth.user;
  const botToken = await getBotToken(c.env);
  return json({
    user: publicUser(u),
    role: u.role,
    unit: c.auth.unit ? {
      id: c.auth.unit.id, number: c.auth.unit.number,
      resident_name: c.auth.unit.resident_name,
      area_m2: c.auth.unit.area_m2, residents_count: c.auth.unit.residents_count
    } : null,
    settings: publicSettings(s),
    current_period: currentPeriod(),
    bot_configured: Boolean(botToken),
    app_url: new URL(c.request.url).origin
  });
}, 'user');

route('POST', '/auth/change-password', async (c) => {
  const b = c.body || {};
  const oldPass = String(b.old_password || '');
  const newPass = String(b.new_password || '');
  if (!validPassword(newPass)) return fail('رمز عبور جدید باید حداقل ۶ کاراکتر باشد');
  if (!(await verifyPassword(oldPass, c.auth.user.password_hash))) {
    return fail('رمز عبور فعلی اشتباه است', 403);
  }
  const hash = await hashPassword(newPass);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(hash, c.auth.user.id).run();
  // v2.14.0 — security review: changing the password revokes every existing
  // session (all devices); a fresh token is returned so THIS device stays in
  await bumpTokenEpoch(c.env, c.auth.user.id);
  const fresh = await c.env.DB.prepare('SELECT token_epoch FROM users WHERE id = ?')
    .bind(c.auth.user.id).first();
  const token = await createSessionToken(c.env, c.auth.user.id, c.auth.user.role, fresh ? fresh.token_epoch : 1);
  return json({ ok: true, token });
}, 'user');

route('POST', '/auth/logout', async () => json({ ok: true }), 'user');

// ---------------------------------------------------------------------------
// PUBLIC SETTINGS (visible to any logged-in user)
// ---------------------------------------------------------------------------
route('GET', '/settings/public', async (c) => {
  const s = await getSettings(c.env);
  return json({ settings: publicSettings(s) });
}, 'user');

// ---------------------------------------------------------------------------
// RESIDENT self-service (also used by a manager linked to their own unit)
// ---------------------------------------------------------------------------
route('GET', '/my/summary', async (c) => {
  const unit = c.auth.unit;
  if (!unit) {
    return fail('به هیچ واحدی متصل نیستید؛ با مدیر ساختمان تماس بگیرید', 403, 'no_unit');
  }
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM debts WHERE unit_id = ? ORDER BY period DESC, kind, id'
  ).bind(unit.id).all();
  const debts = results || [];
  const issued = debts.reduce((s, d) => s + d.amount, 0);
  const paid = debts.reduce((s, d) => s + d.paid_amount, 0);
  // v2.21.0 — اعتبار اضافه‌پرداخت: مانده و تاریخچهٔ دفتر اعتبار واحد
  const [credit, cEntries] = await Promise.all([
    unitCredit(c.env, unit.id),
    creditEntries(c.env, unit.id, 20)
  ]);
  return json({
    unit: {
      id: unit.id, number: unit.number, resident_name: unit.resident_name,
      area_m2: unit.area_m2, residents_count: unit.residents_count
    },
    debts,
    totals: { issued, paid, remaining: Math.max(0, issued - paid) },
    // اعتبار فعلی + ماندهٔ مؤثر پس از کسر اعتبار (برای ماه‌های بعدی)
    credit: {
      balance: credit,
      effective_remaining: Math.max(0, (issued - paid) - credit),
      entries: cEntries
    }
  });
}, 'user');

// A building manager can link their own account to their own unit so the
// «واحد من» tab appears next to the manager surface.
route('POST', '/my/unit', async (c) => {
  const b = c.body || {};
  const unitId = b.unit_id === null ? null : Number(b.unit_id) || 0;
  if (unitId) {
    const unit = await c.env.DB.prepare('SELECT id, number FROM units WHERE id = ?').bind(unitId).first();
    if (!unit) return fail('واحد پیدا نشد', 404);
  }
  await c.env.DB.prepare('UPDATE users SET unit_id = ? WHERE id = ?')
    .bind(unitId, c.auth.user.id).run();
  const unit = unitId
    ? await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(unitId).first()
    : null;
  return json({ ok: true, unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name } : null });
}, 'manager');

// ---------------------------------------------------------------------------
// PDF — unit statement (manager/admin: any unit; resident: own unit only)
// ---------------------------------------------------------------------------
route('GET', '/pdf/statement', async (c) => {
  let unitId = Number(c.query.get('unit_id') || 0);
  if (c.auth.user.role === 'resident') {
    unitId = c.auth.unit ? c.auth.unit.id : 0;
    if (!unitId) return fail('به هیچ واحدی متصل نیستید', 403, 'no_unit');
  } else if (!unitId) {
    return fail('واحد مشخص نشده است');
  }
  const unit = await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(unitId).first();
  if (!unit) return fail('واحد پیدا نشد', 404);
  const jy = c.query.get('jy');
  const { results } = jy
    ? await c.env.DB.prepare('SELECT * FROM debts WHERE unit_id = ? AND period LIKE ? ORDER BY period, id').bind(unitId, jy + '-%').all()
    : await c.env.DB.prepare('SELECT * FROM debts WHERE unit_id = ? ORDER BY period DESC, id').bind(unitId).all();
  const debts = results || [];
  const issued = debts.reduce((s, d) => s + d.amount, 0);
  const paid = debts.reduce((s, d) => s + d.paid_amount, 0);
  const credit = await unitCredit(c.env, unitId);
  const s = await getSettings(c.env);

  const pdfBytes = await buildStatementPdf(c.env, {
    building_name: s.building_name || 'ساختمان من',
    address: s.address || '',
    unit,
    debts,
    totals: {
      issued, paid,
      remaining: Math.max(0, issued - paid),
      // v2.21.0 — اعتبار اضافه‌پرداخت و ماندهٔ مؤثر پس از کسر آن
      credit,
      remaining_after_credit: Math.max(0, (issued - paid) - credit)
    },
    settings: { bank_card: s.bank_card, bank_owner: s.bank_owner, phone: s.phone },
    generated_at: now()
  });
  const fname = `statement-unit-${unit.id}.pdf`;
  return new Response(pdfBytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${fname}"`,
      'x-content-type-options': 'nosniff'
    }
  });
}, 'user');

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.slice(4) || '/';
  const method = request.method.toUpperCase();

  if (!env.DB) {
    return fail('دیتابیس D1 متصل نیست؛ database_id را در wrangler.jsonc تنظیم کنید', 500, 'no_db');
  }
  // v2.14.0 — runtime self-migration: new columns exist even on old databases
  // (deploy:auto only re-runs schema.sql, which never alters existing tables)
  try { await ensureSchema(env); } catch { /* never break the API on this */ }

  // v2.14.1 — دانلود در وب‌ویو تلگرام: anchor+blob در WebView اندروید/iOS کار
  // نمی‌کند؛ کلاینت فایل را با openLink به مرورگر بیرونی می‌سپارد. توکن نشست
  // فقط برای GET مسیرهای دانلودی از طریق ?t= پذیرفته می‌شود (هدر Authorization
  // در openLink قابل ست‌کردن نیست).
  let authReq = request;
  if (request.method === 'GET' && (path.startsWith('/pdf/') || path === '/export')) {
    const t = url.searchParams.get('t');
    const h = request.headers.get('authorization') || '';
    if (t && !h.toLowerCase().startsWith('bearer ')) {
      const headers = new Headers(request.headers);
      headers.set('authorization', 'Bearer ' + t);
      authReq = new Request(request.url, { method: 'GET', headers });
    }
  }

  const m = matchRoute(method, path);
  if (!m) return fail('مسیر پیدا نشد', 404, 'not_found');

  try {
    const { r, params } = m;

    if (r.access === 'public') {
      // try to resolve auth context anyway (needed for /auth/telegram)
      let auth = null;
      try { auth = await buildAuthContext(authReq, env); } catch { /* ignore */ }
      const body = await readBody(request);
      return await r.handler({ request, env, auth, params, query: url.searchParams, body, ctx });
    }

    const auth = await buildAuthContext(authReq, env);
    if (!auth) {
      return fail('ابتدا وارد شوید', 401, 'unauthorized');
    }
    const role = auth.user.role;

    const allow = {
      user: ['admin', 'manager', 'resident'],
      resident: ['resident'],
      manager: ['manager'],
      shared: ['admin', 'manager'],
      admin: ['admin']
    }[r.access];

    if (!allow || !allow.includes(role)) {
      return fail('شما به این بخش دسترسی ندارید', 403, 'forbidden');
    }

    const body = await readBody(request);
    return await r.handler({
      request, env, auth, user: auth.user, unit: auth.unit, role,
      params, query: url.searchParams, body, ctx
    });
  } catch (e) {
    console.error('API error:', path, e);
    return fail('خطای داخلی سرور: ' + String((e && e.message) || e), 500, 'server_error');
  }
}
