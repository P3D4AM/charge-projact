// Cloudflare Worker entry — serves static assets, /api routes and the Telegram webhook.
// The «scheduled» handler runs the automatic monthly debt reminders (see
// wrangler.jsonc triggers.crons: checked daily 05:30 UTC = 09:00 Tehran).
import { handleApi } from './api.js';
import { sendTelegramMessage, getBotToken, getBotInfo } from './telegram.js';
import { runAutoReminder } from './scheduler.js';
import { runAutoCharge } from './scheduler.js';
import { runManagerReminders } from './mreminders.js';
import { logBotMessage, shouldLogUpdate, logOutgoingBotMessage } from './botmessages.js';
import { ensureSchema } from './migrate.js';

/**
 * Best-effort username-based linking: when someone /starts the bot in a private
 * chat and their @username was pre-filled by the manager on a profile, bind the
 * telegram_user_id so personal messages / monthly reminders can reach them.
 */
async function tryLinkByUsername(env, from) {
  try {
    if (!env.DB || !from || !from.id || !from.username) return;
    // v2.17.0 — حساب‌های قفل‌شده به لینک دعوت (bound_tg_id) دیگر با یوزرنیم
    // به پروفایل جدید وصل نمی‌شوند؛ فقط پروفایلِ قفل‌شده معتبر است.
    // v2.20.0 — اگر همین پروفایل قبلاً در حساب دیگری ثبت شده، اتصال یوزرنیمی
    // انجام نمی‌شود تا یک پروفایل روی دو حساب ثبت نماند (انتقال فقط با لینک دعوت).
    const held = await env.DB.prepare(
      'SELECT id FROM users WHERE telegram_user_id = ? LIMIT 1'
    ).bind(from.id).first();
    if (held) return;
    await env.DB.prepare(
      'UPDATE users SET telegram_user_id = ?, telegram_username = ? ' +
      'WHERE telegram_user_id IS NULL AND bound_tg_id IS NULL AND is_active = 1 AND lower(telegram_username) = ?'
    ).bind(from.id, String(from.username), String(from.username).toLowerCase()).run();
  } catch { /* never fail the webhook */ }
}

function appKeyboard(origin, label = 'باز کردن اپ ساختمان') {
  // web_app buttons are allowed in private chats only — used for the private path
  return { inline_keyboard: [[{ text: '🏢 ' + label, web_app: { url: origin } }]] };
}

function linkKeyboard(origin, botUsername) {
  // groups: Telegram rejects web_app buttons → link buttons that work everywhere
  const row = [{ text: '🌐 باز کردن اپ ساختمان', url: origin }];
  if (botUsername) row.push({ text: '🤖 چت با ربات', url: `https://t.me/${botUsername}` });
  return { inline_keyboard: [row] };
}

const WELCOME_PRIVATE = name =>
  (name ? `سلام ${name}! 👋\n\n` : '') +
  'برای باز کردن اپ ساختمان، دکمه «🏢 باز کردن اپ ساختمان» زیر همین پیام را بزنید 👇\n\n' +
  '💡 دکمه «اپ ساختمان» در نوار پایین (کنار کادر نوشتن) هم اپ را مستقیم باز می‌کند.\n' +
  '⚠️ توجه: انتخاب دستور از فهرست منو فقط متنش را در کادر می‌نویسد — برای اجرا باید دکمه ارسال (✈️) را بزنید.';

const HELP_PRIVATE =
  '📖 راهنمای سریع\n\n' +
  '• باز کردن اپ: دکمه «🏢 باز کردن اپ ساختمان» زیر همین پیام، یا دکمه «اپ ساختمان» کنار کادر نوشتن 👇\n' +
  '• انتخاب دستور از منو (start/app/help) فقط متن را در کادر می‌نویسد — باید دکمه ارسال را بزنید.\n' +
  '• در گروه: دستور /app را بفرستید تا دکمه اپ دوباره ارسال شود (ربات باید مدیر گروه باشد یا Privacy خاموش باشد).\n' +
  '• ورود به اپ با نام‌کاربری و رمزی که مدیر ساختمان به شما داده است.';

const GROUP_WELCOME =
  'سلام! 🏢 من ربات اپ شارژ ساختمان هستم.\n\n' +
  'همه ساکنین با دکمه «باز کردن اپ ساختمان» زیر می‌توانند اپ را باز کنند:\n' +
  '• شارژ و بدهی واحد خود را ببینید\n' +
  '• در نظرسنجی‌ها رأی بدهید\n' +
  '• صورت‌حساب PDF دریافت کنید\n\n' +
  '📌 این پیام را پین کنید تا همیشه در دسترس بماند.\n' +
  'اگر پیام پین حذف شد، کافی است دستور /app را در گروه بفرستید تا دوباره ارسال شود.';

const GROUP_PRIVACY_TIP =
  '\n\n⚠️ نکته مهم: برای اینکه ربات دستور /app را در گروه ببیند و جواب دهد، این ربات را «مدیر گروه» کنید ' +
  'یا در @BotFather بخش Bot Settings ← Group Privacy را برای این ربات خاموش کنید.';

// small per-isolate cache of the bot username (avoids getMe on every mention check)
let cachedBotUsername = null;

async function botUsername(token) {
  if (cachedBotUsername) return cachedBotUsername;
  const info = await getBotInfo(token);
  if (info.ok && info.username) {
    cachedBotUsername = info.username.toLowerCase();
    return cachedBotUsername;
  }
  return null;
}

async function safeSend(env, token, chatId, text, markup, chatType = 'private') {
  try {
    const r = await sendTelegramMessage(token, chatId, text, markup);
    // v2.19.0 — پاسخ‌های وب‌هوک (خوش‌آمد، راهنما، کارت اپ) هم ثبت می‌شوند
    if (r && r.ok) await logOutgoingBotMessage(env, { chatId, text, title: 'پاسخ ربات', chatType });
  } catch { /* never fail the webhook */ }
}

/**
 * Sends the app-opening card. Tries the web_app button first (works in private
 * chats); if Telegram rejects it (groups) or send fails, falls back to link
 * buttons so groups ALWAYS get the message.
 */
async function sendAppCard(env, token, chatId, text, origin, chatType = 'private') {
  const viaWebApp = await sendTelegramMessage(token, chatId, text, appKeyboard(origin));
  if (viaWebApp.ok) {
    await logOutgoingBotMessage(env, { chatId, text, title: 'پاسخ ربات', chatType });
    return;
  }
  const uname = await botUsername(token);
  try {
    const r2 = await sendTelegramMessage(token, chatId, text, linkKeyboard(origin, uname));
    if (r2 && r2.ok) await logOutgoingBotMessage(env, { chatId, text, title: 'پاسخ ربات', chatType });
  } catch { /* never fail */ }
}

async function handleTelegramWebhook(request, env, ctx) {
  // optional shared-secret check (set via setWebhook secret_token)
  if (env.WEBHOOK_SECRET) {
    const got = request.headers.get('x-telegram-bot-api-secret-token') || '';
    if (got !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  }
  let update = null;
  try { update = await request.json(); } catch { /* ignore */ }
  if (!update) return new Response('ok');

  const token = await getBotToken(env);
  if (!token) return new Response('ok');
  const origin = new URL(request.url).origin;

  // ---- bot added to a group → welcome message with the app button --------
  if (update.my_chat_member && update.my_chat_member.chat) {
    const m = update.my_chat_member;
    const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';
    const oldSt = m.old_chat_member && m.old_chat_member.status;
    const newSt = m.new_chat_member && m.new_chat_member.status;
    const joined = ['left', 'kicked'].includes(oldSt) && ['member', 'administrator'].includes(newSt);
    if (isGroup && joined) {
      // plain member (not admin): group privacy may hide /app from the bot → tip
      const tip = newSt === 'member' ? GROUP_PRIVACY_TIP : '';
      await sendAppCard(env, token, m.chat.id, GROUP_WELCOME + tip, origin, m.chat.type);
    }
    return new Response('ok');
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return new Response('ok');
  const chatType = msg.chat.type;
  const text = String(msg.text || '').trim();

  // «گزارش پیام‌های بات»: every private message + every group command the bot
  // reacts to is logged (best-effort, deferred — never breaks the webhook)
  if (shouldLogUpdate(update)) logBotMessage(env, msg, ctx);

  if (chatType === 'private') {
    // private chat: /help gets the usage guide; any other message gets the app card
    const isHelp = /^\/(help|راهنما)(@\w+)?$/i.test(text.split(/\s+/)[0] || '');
    const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name]
      .filter(Boolean).join(' ');
    const body = isHelp ? HELP_PRIVATE : WELCOME_PRIVATE(name);
    await safeSend(env, token, msg.chat.id, body, appKeyboard(origin), chatType);
    // profile pre-filled with this @username? bind it now (first contact)
    await tryLinkByUsername(env, msg.from);
    return new Response('ok');
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    // groups: answer commands only (/start, /app, /help) — no spam
    const first = text.split(/\s+/)[0] || '';
    const [rawCmd, mention] = first.toLowerCase().split('@');
    if (!['/start', '/app', '/help', '/اپ'].includes(rawCmd)) return new Response('ok');
    if (mention) {
      const myUname = await botUsername(token);
      if (myUname && mention !== myUname) return new Response('ok');
    }
    await sendAppCard(env, token, msg.chat.id, GROUP_WELCOME, origin, chatType);
  }
  return new Response('ok');
}

const worker = {
  // Cron Trigger — daily check; the gate inside decides whether the monthly
  // reminder actually fires (enabled + day reached + not sent this month).
  async scheduled(controller, env, ctx) {
    try {
      await ensureSchema(env);
      const r = await runAutoReminder(env, {});
      if (!r.ran) console.log(`[auto-reminder] skipped (${r.reason}) for ${r.period}`);
      else console.log(`[auto-reminder] ${r.period}: sent=${r.sent} failed=${r.failed} unreachable=${r.unreachable} of ${r.targets}`);
    } catch (e) {
      console.error('[auto-reminder] failed:', (e && e.message) || e);
    }
    // v2.23.0 — صدور خودکار شارژ ماهانه (تیک واحدها) + یادآوری‌های دوره‌ای مدیر ساختمان
    try {
      const ac = await runAutoCharge(env, {});
      if (!ac.ran) console.log(`[auto-charge] skipped (${ac.reason}) for ${ac.period}`);
      else console.log(`[auto-charge] ${ac.period}: created=${ac.created} skipped=${ac.skipped} notified=${ac.notified}`);
    } catch (e) {
      console.error('[auto-charge] failed:', (e && e.message) || e);
    }
    try {
      const mr = await runManagerReminders(env, {});
      if (!mr.ran) console.log(`[manager-reminders] skipped (${mr.reason})`);
      else console.log(`[manager-reminders]: due=${mr.due} sent=${mr.sent} failed=${mr.failed}`);
    } catch (e) {
      console.error('[manager-reminders] failed:', (e && e.message) || e);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhook/telegram') {
        return await handleTelegramWebhook(request, env, ctx);
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, ctx);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        // v2.23.1 — کپی قدیمی اپ (public/tgapp، از v2.16 عقب‌مانده و بدون تب‌های جدید)
        // حذف شد؛ بوکمارک/لینک‌های کهنهٔ /tgapp/* برای همیشه به نسخهٔ زنده در ریشه
        // هدایت می‌شوند تا هیچ‌وقت پنل یا اپ کهنه باز نشود.
        if (url.pathname === '/tgapp' || url.pathname.startsWith('/tgapp/')) {
          const rest = url.pathname.replace(/^\/tgapp/, '') || '/';
          return Response.redirect(new URL(rest + url.search, url.origin), 301);
        }
        return await env.ASSETS.fetch(request);
      }
      return new Response('Method Not Allowed', { status: 405 });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'server_error', detail: String((e && e.message) || e) }),
        { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
      );
    }
  }
};

export default worker;
