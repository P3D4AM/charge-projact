// ---------------------------------------------------------------------------
// Telegram WebApp initData validation + Bot API helpers (Cloudflare Workers compatible).
// v2.19.0 — outgoing messages are logged to bot_messages (گزارش پیام‌های ربات).
// ---------------------------------------------------------------------------
import { logOutgoingBotMessage } from './botmessages.js';

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// bot token resolution — admin-panel setting (D1) first, then env var
// ---------------------------------------------------------------------------
/**
 * Resolves the active bot token.
 * Priority: 1) settings table (set from the app-admin panel, no redeploy needed)
 *           2) env.BOT_TOKEN (wrangler secret / vars)
 * Returns the token string or null when not configured.
 */
export async function getBotToken(env) {
  try {
    if (env && env.DB) {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_token'").first();
      if (row && row.value) return String(row.value);
    }
  } catch { /* settings table may not exist before install */ }
  const envToken = (env && env.BOT_TOKEN) || '';
  return envToken || null;
}

/** True when the token was saved from the admin panel (vs. deployment env). */
export async function botTokenSource(env) {
  try {
    if (env && env.DB) {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_token'").first();
      if (row && row.value) return 'settings';
    }
  } catch { /* ignore */ }
  return (env && env.BOT_TOKEN) ? 'env' : null;
}

/**
 * Validates Telegram Mini App initData (HMAC-SHA256 with the bot token).
 * Returns the user object or null when invalid/expired.
 */
export async function validateInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  const webAppDataKey = await crypto.subtle.importKey(
    'raw', enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const rawSecret = await crypto.subtle.sign('HMAC', webAppDataKey, enc.encode(botToken));
  const secretKey = await crypto.subtle.importKey(
    'raw', rawSecret,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  // hash = HMAC_SHA256(key=secret_key, data=data_check_string)
  const sig = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) return null;

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return user;
}

/** Sends a text message through the Telegram Bot API. Returns {ok, error?}. */
export async function sendTelegramMessage(botToken, chatId, text, replyMarkup) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) return { ok: true };
    return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Calls getMe to verify the bot token. Returns {ok, id?, username?} or {ok:false, error}. */
export async function getBotInfo(botToken) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) {
      return { ok: true, id: data.result.id, username: data.result.username };
    }
    return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * v2.17.0 — bot username with a settings cache (needed for building
 * «https://t.me/<bot>?startapp=<token>» invite links without calling getMe
 * on every request). The cache is invalidated in POST /a/bot/token when the
 * token changes, and DELETE /a/bot/token.
 */
export async function getBotUsernameCached(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'bot_username'").first();
    if (row && row.value) return row.value;
  } catch { /* settings table missing → fall through to getMe */ }
  const token = await getBotToken(env);
  if (!token) return null;
  const info = await getBotInfo(token);
  if (!info.ok || !info.username) return null;
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('bot_username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(info.username).run();
  } catch { /* cache write is best-effort */ }
  return info.username;
}

/** Registers the bot webhook. Returns {ok} or {ok:false, error}. */
export async function setWebhook(botToken, url, secretToken = '') {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url,
        secret_token: secretToken || undefined,
        allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member'],
        drop_pending_updates: true
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) return { ok: true };
    return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// generic Bot API caller
// ---------------------------------------------------------------------------
async function botApiCall(botToken, method, payload) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok) return { ok: true, result: data.result };
    return { ok: false, error: (data && data.description) || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** Reads current webhook status (url, last error, pending updates). */
export async function getWebhookInfo(botToken) {
  const r = await botApiCall(botToken, 'getWebhookInfo');
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, info: r.result || {} };
}

/** Removes the webhook (used when disconnecting the bot). */
export async function deleteWebhook(botToken) {
  return botApiCall(botToken, 'deleteWebhook', { drop_pending_updates: false });
}

const BOT_COMMANDS = [
  { command: 'start', description: 'شروع ربات و باز کردن اپ' },
  { command: 'app', description: 'نمایش دکمه باز کردن اپ ساختمان' },
  { command: 'help', description: 'راهنمای استفاده و رفع مشکلات' }
];

/** Registers the bot slash-commands (shown in the commands menu). */
export async function setMyCommands(botToken) {
  return botApiCall(botToken, 'setMyCommands', { commands: BOT_COMMANDS });
}

/**
 * Sets the default menu button (the button next to the input field in private
 * chats) to launch the mini app. Note: Telegram shows the menu button only in
 * private chats — in groups, residents use the pinned web-app message instead.
 */
export async function setChatMenuButton(botToken, webAppUrl) {
  return botApiCall(botToken, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'اپ ساختمان', web_app: { url: webAppUrl } }
  });
}

// ---------------------------------------------------------------------------
// Personal message (پیام شخصی) — shared by the app-admin and building-manager
// panels. Telegram bots cannot DM a raw @username: the recipient must have
// contacted the bot once (opened the mini app or /start). Profiles pre-filled
// with a username get linked automatically on that first contact, after which
// personal messages go through.
// Returns {ok} or {ok:false, status, code, error}.
// ---------------------------------------------------------------------------
export async function sendPersonalToUser(env, userId, text, ctx) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, status: 400, code: 'empty_text', error: 'متن پیام خالی است' };
  if (body.length > 3500) return { ok: false, status: 400, code: 'too_long', error: 'متن پیام حداکثر ۳۵۰۰ کاراکتر است' };

  const token = await getBotToken(env);
  if (!token) {
    return {
      ok: false, status: 400, code: 'bot_token_missing',
      error: 'توکن ربات تنظیم نشده است؛ از پنل مدیریت اپ ← تب «تنظیمات اپ» ← «ربات تلگرام» ثبت کنید'
    };
  }

  let row = null;
  try {
    row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(userId)).first();
  } catch { /* db issue handled below */ }
  if (!row) return { ok: false, status: 404, code: 'not_found', error: 'کاربر پیدا نشد' };
  if (!row.telegram_user_id) {
    return {
      ok: false, status: 409, code: 'not_linked',
      error: 'این کاربر هنوز به تلگرام متصل نشده است. ربات نمی‌تواند به یک یوزرنیم پیام بدهد؛ با ثبت یوزرنیم در پروفایل، به محض اولین ورود او به اپ داخل تلگرام (یا استارت ربات) اتصال خودکار انجام می‌شود و پس از آن پیام‌ها می‌رسد.'
    };
  }

  let buildingName = '';
  try {
    const s = await env.DB.prepare("SELECT value FROM settings WHERE key = 'building_name'").first();
    buildingName = (s && s.value) || '';
  } catch { /* optional prefix */ }

  const fullBody = (buildingName ? buildingName + '\n\n' : '') + body;
  const res = await sendTelegramMessage(token, row.telegram_user_id, fullBody);
  if (!res.ok) {
    return { ok: false, status: 502, code: 'send_failed', error: 'ارسال پیام ناموفق بود: ' + (res.error || 'نامشخص') };
  }
  // v2.19.0 — «گزارش پیام‌های ربات»: ثبت پیام شخصی ارسالی (از پنل مدیر یا مدیریت)
  try { await logOutgoingBotMessage(env, { chatId: row.telegram_user_id, text: fullBody, title: 'پیام شخصی' }, ctx); } catch { /* never break */ }
  return { ok: true, user: { id: row.id, username: row.username, full_name: row.full_name } };
}
