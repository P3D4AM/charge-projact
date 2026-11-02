// v2.17.0 — لینک دعوت یک‌بارمصرف اتصال تلگرام (invite links)
//
// مدیر ساختمان برای هر حساب (ساکن/مدیر) یک لینک «t.me/<bot>?startapp=<token>»
// با زمان انقضای انتخابی می‌سازد. شخص لینک را فقط با پروفایل خودش داخل تلگرام
// باز می‌کند → اپ با start_param باز می‌شود → POST /auth/invite:
//   • اثبات مالکیت با یوزرنیم/رمز عبور همان حساب (v2.20.0)
//   • حساب به «همان پروفایل» قفل می‌شود (users.bound_tg_id)
//   • اتصال قبلی (telegram_user_id) جایگزین می‌شود — و پروفایل از حساب‌های
//     قبلی‌اش آزاد می‌شود (انتقال واقعی، نه رد شدن — v2.20.0)
//   • همهٔ نشست‌های قبلی با bump token_epoch باطل می‌شوند
// از این لحظه ورود با یوزر/پسورد از داخل تلگرامِ پروفایل دیگر، و ورود خودکار
// با initDataِ پروفایل دیگر رد می‌شود — فقط پروفایلِ کلیک‌کننده وارد می‌شود.
import { route } from './router.js';
import { json, fail, now } from './helpers.js';
import {
  publicUser, bumpTokenEpoch, createSessionToken, verifyPassword,
  loginThrottleCheck, loginThrottleFail, loginThrottleClear
} from './auth.js';
import { validateInitData, getBotToken, getBotUsernameCached } from './telegram.js';

const MIN_HOURS = 1;
const MAX_HOURS = 24 * 30; // یک ماه

function tokenGen() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function inviteUrl(username, token) {
  return username ? `https://t.me/${username}?startapp=${token}` : null;
}

function publicInvite(i, botUsername) {
  return {
    id: i.id,
    user_id: i.user_id,
    token: i.token,
    url: inviteUrl(botUsername, i.token),
    created_at: i.created_at,
    expires_at: i.expires_at,
    used_at: i.used_at || null,
    used_by_tg: i.used_by_tg || null
  };
}

async function loadUser(env, id) {
  if (!id) return null;
  return env.DB.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(Number(id)).first();
}

// ---------------------------------------------------------------------------
// manager+admin routes (v2.18.0: پنل مدیر ساختمان و پنل مدیریت هر دو)
// — در پنل مدیریت، تب «کاربران» همین مکانیزم را برای هر حساب غیرادمین دارد.
// ---------------------------------------------------------------------------
route('GET', '/invites', async (c) => {
  const t = Math.floor(Date.now() / 1000);
  const { results } = await c.env.DB.prepare(`
    SELECT i.*, u.username, u.full_name, u.role, un.number AS unit_number
    FROM invite_tokens i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN units un ON un.id = u.unit_id
    WHERE i.used_at IS NULL AND i.expires_at > ?
    ORDER BY i.id DESC
    LIMIT 50
  `).bind(t).all();
  const botUsername = await getBotUsernameCached(c.env);
  return json({ invites: (results || []).map(r => ({
    ...publicInvite(r, botUsername),
    username: r.username,
    full_name: r.full_name || '',
    role: r.role,
    unit_number: r.unit_number || null
  })) });
}, 'shared');

route('POST', '/invites', async (c) => {
  const b = c.body || {};
  const user = await loadUser(c.env, b.user_id);
  if (!user) return fail('کاربر پیدا نشد', 404);
  if (user.role === 'admin') return fail('برای حساب مدیر اپ لینک دعوت ساخته نمی‌شود', 409);
  if (!user.is_active) return fail('این حساب غیرفعال است؛ اول فعالش کنید', 409);

  const hours = Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.round(Number(b.hours) || 24)));
  const token = tokenGen();
  const t = now();

  // هر حساب در هر لحظه فقط یک لینک فعال داشته باشد — لینک‌های استفاده‌نشدهٔ
  // قبلی همان حساب باطل می‌شوند تا همیشه آخرین لینک معتبر باشد.
  await c.env.DB.prepare(
    'DELETE FROM invite_tokens WHERE user_id = ? AND used_at IS NULL'
  ).bind(user.id).run();

  const res = await c.env.DB.prepare(`
    INSERT INTO invite_tokens (token, user_id, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(token, user.id, c.user.id, t, t + hours * 3600).run();
  const row = await c.env.DB.prepare('SELECT * FROM invite_tokens WHERE id = ?')
    .bind(res.meta.last_row_id).first();

  const botUsername = await getBotUsernameCached(c.env);
  if (!botUsername) {
    return fail('ربات هنوز تنظیم نشده است؛ ابتدا توکن ربات را در پنل مدیریت اپ ثبت کنید', 400, 'bot_token_missing');
  }
  return json({ invite: publicInvite(row, botUsername), user: publicUser(user) }, 201);
}, 'shared');

route('DELETE', '/invites/:id', async (c) => {
  const id = Number(c.params.id);
  const row = await c.env.DB.prepare('SELECT id FROM invite_tokens WHERE id = ?').bind(id).first();
  if (!row) return fail('لینک پیدا نشد', 404);
  await c.env.DB.prepare('DELETE FROM invite_tokens WHERE id = ?').bind(id).run();
  return json({ ok: true });
}, 'shared');

// ---------------------------------------------------------------------------
// PUBLIC — مصرف لینک از داخل اپ تلگرام (start_param)
// کلاینت با initDataِ پروفایل فعلی می‌آید؛ سرور امضا را کامل بررسی می‌کند.
//
// v2.20.0 — چرخهٔ «انتقال حساب به پروفایل» (رفع اشکال «قبلاً به حساب دیگری
// متصل شده است»):
//   ۱) درخواست اول بدون اعتبارنامه → ۴۰۱ invite_credentials_required
//      (فقط بازگشاییِ لینک مصرف‌شدهٔ خودِ پروفایل بدون رمز وارد می‌شود)
//   ۲) اثبات مالکیت با یوزرنیم/رمز عبور همان حساب هدف لینک (+ throttle مشترک ورود)
//   ۳) انتقال واقعی: پروفایل کلیک‌کننده از هر حساب دیگری که در آن ثبت است
//      آزاد می‌شود (telegram_user_id/username/bound_tg_id پاک + ابطال نشست‌هایش)
//      و حساب هدف به همین پروفایل قفل می‌شود — پروفایل قبلی با bump epoch بیرون می‌افتد.
//   بدون لینکِ معتبر هیچ انتقالی رخ نمی‌دهد (قفل‌ها سر جایشان هستند).
// ---------------------------------------------------------------------------
route('POST', '/auth/invite', async (c) => {
  const token = String((c.body || {}).token || '').trim();
  if (!token) return fail('توکن دعوت پیدا نشد', 400, 'invite_missing');

  const initData = c.request.headers.get('x-telegram-init-data') || '';
  const botToken = await getBotToken(c.env);
  if (!initData || !botToken) {
    return fail('اتصال با لینک دعوت فقط از داخل تلگرام انجام می‌شود؛ لینک را همان‌جا باز کنید', 400, 'telegram_required');
  }
  const maxAge = Number(c.env.INITDATA_MAX_AGE || 86400);
  const tgUser = await validateInitData(initData, botToken, maxAge);
  if (!tgUser || !tgUser.id) {
    return fail('اعتبارسنجی تلگرام ناموفق بود؛ یک‌بار دیگر از تلگرام وارد شوید', 401, 'bad_initdata');
  }
  const tgId = Number(tgUser.id);

  const invite = await c.env.DB.prepare(
    'SELECT * FROM invite_tokens WHERE token = ? LIMIT 1'
  ).bind(token).first();
  if (!invite) return fail('این لینک دعوت معتبر نیست', 404, 'invite_invalid');

  const user = await loadUser(c.env, invite.user_id);
  if (!user || !user.is_active) return fail('حساب هدف این لینک فعال نیست', 409, 'invite_target_inactive');

  // بازگشاییِ همان لینک توسط همان پروفایل — فقط تا وقتی حساب هنوز به همین
  // پروفایل قفل است؛ اگر بعداً حساب با لینک تازه‌ای به پروفایل دیگری رفته باشد،
  // لینک قدیمی دیگر هیچ اثری ندارد (بدون لینک جدید هیچ اتفاقی نمی‌افتد).
  const reopen = Boolean(invite.used_at) && Number(invite.used_by_tg || 0) === tgId;
  if (invite.used_at && !reopen) {
    return fail('این لینک قبلاً توسط پروفایل دیگری مصرف شده است', 409, 'invite_used');
  }
  if (reopen && Number(user.bound_tg_id || 0) !== tgId) {
    return fail('این لینک قبلاً مصرف شده و حساب بعد از آن به پروفایل دیگری منتقل شده است', 409, 'invite_used');
  }
  if (!reopen && invite.expires_at < now()) {
    return fail('این لینک دعوت منقضی شده است؛ از مدیر ساختمان لینک جدید بگیرید', 410, 'invite_expired');
  }

  if (!reopen) {
    // ---- گام اعتبارنامه: اثبات مالکیت حساب هدف ----
    const username = String((c.body || {}).username || '').trim();
    const password = String((c.body || {}).password || '');
    if (!username || !password) {
      return fail('برای اتصال حساب، نام کاربری و رمز عبور همان حساب را وارد کنید', 401, 'invite_credentials_required');
    }
    const unameL = username.toLowerCase();
    const locked = await loginThrottleCheck(c.env, unameL);
    if (locked) {
      const mins = Math.max(1, Math.ceil((locked.until - Math.floor(Date.now() / 1000)) / 60));
      return fail('به‌خاطر تلاش‌های ناموفق زیاد، این حساب تا ' + mins + ' دقیقه قفل است؛ بعداً دوباره تلاش کنید', 429);
    }
    const credOk = unameL === String(user.username || '').toLowerCase()
      && await verifyPassword(password, user.password_hash);
    if (!credOk) {
      const st = await loginThrottleFail(c.env, unameL);
      if (st && st.locked) {
        const mins = Math.max(1, Math.ceil((st.until - Math.floor(Date.now() / 1000)) / 60));
        return fail('به‌خاطر تلاش‌های ناموفق زیاد، این حساب تا ' + mins + ' دقیقه قفل است؛ بعداً دوباره تلاش کنید', 429);
      }
      return fail('نام کاربری یا رمز عبور این حساب درست نیست', 401, 'invite_bad_credentials');
    }
    await loginThrottleClear(c.env, unameL);

    // ---- انتقال: آزادسازی پروفایل از حساب‌های قبلی (خروج اجباری) ----
    // تا دیروز این‌جا ۴۰۳ telegram_profile_taken برمی‌گشت و انتقال مسدود بود؛
    // لینک دعوت یعنی «مالکیت تلگرامِ حساب به این پروفایل منتقل شود» — پس
    // پروفایل از هر حساب دیگری که در آن ثبت است آزاد و به حساب هدف منتقل می‌شود.
    const heldBy = await c.env.DB.prepare(
      'SELECT id FROM users WHERE id != ? AND (telegram_user_id = ? OR bound_tg_id = ?)'
    ).bind(user.id, tgId, tgId).all();
    for (const row of (heldBy.results || [])) {
      await c.env.DB.prepare(`
        UPDATE users SET telegram_user_id = NULL, telegram_username = NULL, bound_tg_id = NULL
        WHERE id = ?
      `).bind(row.id).run();
      await bumpTokenEpoch(c.env, row.id);
    }
  }

  // اتصال + قفل دائمی به همین پروفایل + ابطال همهٔ نشست‌های قبلی
  const tgUname = tgUser.username || user.telegram_username || '';
  await c.env.DB.prepare(`
    UPDATE users SET telegram_user_id = ?, telegram_username = ?, bound_tg_id = ?
    WHERE id = ?
  `).bind(tgId, tgUname, tgId, user.id).run();
  await c.env.DB.prepare(
    'UPDATE invite_tokens SET used_at = ?, used_by_tg = ? WHERE id = ?'
  ).bind(now(), tgId, invite.id).run();
  await bumpTokenEpoch(c.env, user.id);

  const fresh = await loadUser(c.env, user.id);
  const unit = fresh.unit_id
    ? await c.env.DB.prepare('SELECT * FROM units WHERE id = ?').bind(fresh.unit_id).first()
    : null;
  const tokenOut = await createSessionToken(c.env, fresh.id, fresh.role, fresh.token_epoch, tgId);
  return json({
    token: tokenOut,
    linked: true,
    bound: true,
    user: publicUser(fresh),
    unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name } : null
  });
}, 'public');
