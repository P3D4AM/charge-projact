#!/usr/bin/env node
// ---------------------------------------------------------------------------
// استقرار خودکار کامل روی Cloudflare — با یک دستور:
//   npm run deploy:auto        (یا: node scripts/deploy.mjs)
//
// کارهایی که خودکار انجام می‌دهد:
//   ۱) نصب وابستگی‌ها (اگر نباشد)          ۲) بررسی ورود به Cloudflare
//   ۳) ساخت دیتابیس D1 و ثبت id در wrangler.jsonc
//      - اگر دیتابیس از قبل در اکانت باشد (حتی با خطای «already exists») خودش id را
//        پیدا و متصل می‌کند (d1 list → d1 info → d1 create)
//      - در صورت خطا، خروجی واقعی wrangler + راه‌حل‌های پیشنهادی نمایش داده می‌شود
//   ۴) اجرای اسکیمای دیتابیس (idempotent — هر بار قابل اجرا)
//   ۵) دیپلوی Worker + فایل‌های استاتیک
//   ۶) تنظیم BOT_TOKEN و فعال‌سازی وب‌هوک ربات تلگرام (اختیاری)
//
// حالت غیرتعاملی (CI / اسکریپت):
//   DEPLOY_CI=1  CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...  [BOT_TOKEN=...]
//   node scripts/deploy.mjs
//
// زبان خروجی (v2.9.2):
//   در CMD ویندوز، فارسی به‌صورت «؟؟؟» نمایش داده می‌شود (فونت/کدپیج پیش‌فرض
//   فارسی ندارد). بنابراین روی ویندوز به‌طور پیش‌فرض خروجی «انگلیسی» چاپ می‌شود
//   تا همیشه خوانا باشد؛ برای دیدن فارسی (مثلاً در Windows Terminal):
//   DEPLOY_LANG=fa  npm run deploy:auto     (یا set DEPLOY_LANG=fa در cmd)
//
//   v2.17.1: همهٔ مراحل شبکه‌ای (whoami/d1/deploy/secret) اگر وسط کار اینترنت قطع شود
//   (fetch failed و امثال او) خودکار تا ۴ بار با فاصلهٔ ۵ تا ۴۰ ثانیه تلاش مجدد می‌کنند؛
//   تعداد تلاش با متغییر محیطی DEPLOY_ATTEMPTS قابل تغییر است (۲ تا ۸).
//
// گزینه‌ها:
//   --bot-token <token>      توکن ربات تلگرام (به‌جای env/prompt)
//   --webhook-secret <s>     توکن محرمانه وب‌هوک (پیش‌فرض: ساخته‌شدن خودکار)
//   --skip-schema            رد شدن از اجرای اسکیما
//   --skip-webhook           رد شدن از تنظیم ربات/وب‌هوک
//   --skip-deploy            فقط آماده‌سازی D1 و اسکیما (بدون دیپلوی)
//   --db-name <name>         نام دیتابیس D1 (پیش‌فرض: مقدار wrangler.jsonc)
//   --selftest               تست داخلی بخش تشخیص/تجزیه خروجی — بدون اتصال به Cloudflare
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getBotInfo, setWebhook, setMyCommands, setChatMenuButton } from '../src/telegram.js';
import {
  parseSchemaTables, buildProbeCommand, extractProbeRows, diffMissingColumns
} from './schema-reconcile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(name);
const CI = process.env.DEPLOY_CI === '1' || (!process.stdout.isTTY && process.env.DEPLOY_CI !== '0');
const SKIP_SCHEMA = flag('--skip-schema');
const SKIP_WEBHOOK = flag('--skip-webhook');
const SKIP_DEPLOY = flag('--skip-deploy');

// --- console language (v2.9.2) ----------------------------------------------
// Classic Windows CMD cannot render Persian (question marks instead). On win32
// we print ENGLISH by default; everywhere else Persian. DEPLOY_LANG=fa forces
// Persian (e.g. inside Windows Terminal). We also try to switch the console to
// UTF-8 so Persian never corrupts even when shown.
const ON_WIN = process.platform === 'win32';
const LANG = String(process.env.DEPLOY_LANG || (ON_WIN ? 'en' : 'fa')).toLowerCase().startsWith('fa') ? 'fa' : 'en';
const t = (fa, en) => (LANG === 'fa' ? fa : en);
if (ON_WIN) {
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore', timeout: 5000 }); } catch { /* best effort */ }
}

// --- pretty logging ---------------------------------------------------------
const step = (n, msg) => console.log(`\n\x1b[1;36m[${n}] ${msg}\x1b[0m`);
const info = (msg) => console.log(`  ${msg}`);
const okMark = LANG === 'fa' ? '\u2714' : '[ok]';
const badMark = LANG === 'fa' ? '\u2716' : '[x]';
const ok = (msg) => console.log(`  \x1b[32m${okMark}\x1b[0m ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const die = (msg) => { console.error(`\n\x1b[31m${badMark} ${msg}\x1b[0m`); process.exit(1); };

function run(args, { input, capture, timeout } = {}) {
  const r = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: process.env,
    shell: false,
    timeout: timeout || 0
  });
  if (capture) return r;
  if (r.status !== 0) {
    console.error(r.stdout || '');
    console.error(r.stderr || '');
    die(t(`اجرای دستور wrangler ${args.join(' ')} ناموفق بود.`,
      `wrangler ${args.join(' ')} failed.`));
  }
  return r;
}

const wrangler = (args, opts) => run(args, opts);

// --- خطای شبکه + تلاش مجدد خودکار (v2.17.1) ---------------------------------
// در شبکه‌های ناپایدار، درخواستِ وسطِ کار به api.cloudflare.com ممکن است با
// «fetch failed» قطع شود (مثلاً حین آپلود schema روی D1). همهٔ مراحل این
// اسکریپت idempotent هستند؛ پس به‌جای توقف، خودکار با فاصله دوباره تلاش می‌کنیم.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NET_FAIL_RE = /fetch failed|a fetch request failed|connectivity|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|timed out|network error|network connectivity|bad gateway|service unavailable|internal server error|\b5(02|03|04|22|23|24)\b/i;
const isNetFailText = (out) => NET_FAIL_RE.test(String(out || ''));
const _envAtt = Number(process.env.DEPLOY_ATTEMPTS);
const NET_ATTEMPTS = Math.min(8, Math.max(2, Number.isFinite(_envAtt) && _envAtt >= 1 ? Math.floor(_envAtt) : 4));
const NET_DELAYS = [5000, 12000, 25000, 40000, 40000, 40000, 40000];

const dieNet = (label) => die(t(
  `«${label}» به‌خاطر قطعی شبکه به api.cloudflare.com انجام نشد. VPN/پروکسی را روشن یا تغییر دهید و «npm run deploy:auto» را دوباره اجرا کنید — همهٔ مراحل idempotent هستند و اجرای مجدد بی‌خطر است.`,
  `"${label}" failed due to a network error reaching api.cloudflare.com. Turn on or change your VPN/proxy and re-run "npm run deploy:auto" - all steps are idempotent and safe to re-run.`));

// wrangler با تلاش مجدد خودکار روی خطای شبکه. soft=true → به‌جای die، آخرین نتیجه
// بدون چاپ برمی‌گردد تا caller خودش تصمیم بگیرد (مثلاً مسیر «ساخت دیتابیس»).
async function wranglerNet(args, opts = {}, { label = 'wrangler', attempts = NET_ATTEMPTS, soft = false, note = '' } = {}) {
  for (let i = 1; ; i++) {
    const r = wrangler(args, { ...opts, capture: true });
    if (r.status === 0) {
      if (i > 1) ok(t(`تلاش ${i} برای «${label}» موفق بود`, `Attempt ${i} for "${label}" succeeded`));
      return r;
    }
    const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
    if (!isNetFailText(out) || i >= attempts) {
      if (soft) return r; // بدون چاپ — تصمیم با caller
      console.error(r.stdout || ''); console.error(r.stderr || '');
      const hints = d1Hints(out);
      if (hints.length) {
        console.error(t('  💡 راه‌حل‌های پیشنهادی:', '  * Suggested fixes:'));
        for (const h of hints) console.error('     - ' + h);
      }
      die(t(`«${label}» پس از ${i} تلاش ناموفق ماند`, `"${label}" failed after ${i} attempt(s)`)
        + (isNetFailText(out) ? t(' (خطای شبکه به api.cloudflare.com)', ' (network error reaching api.cloudflare.com)') : '')
        + `. ${note}${t('این مرحله idempotent است — VPN/پروکسی را بررسی و «npm run deploy:auto» را دوباره اجرا کنید.',
                        'This step is idempotent - check your VPN/proxy and simply re-run "npm run deploy:auto".')}`);
    }
    const wait = NET_DELAYS[Math.min(i - 1, NET_DELAYS.length - 1)];
    warn(t(`تلاش ${i}/${attempts} برای «${label}» به خطای شبکه خورد — ${Math.round(wait / 1000)} ثانیه صبر و تلاش دوباره…`,
      `Attempt ${i}/${attempts} for "${label}" hit a network error - waiting ${Math.round(wait / 1000)}s, retrying...`));
    if (i === 2) info(t('اگر VPN/پروکسی دارید روشن نگهش دارید یا سرور آن را عوض کنید.',
      'Tip: keep your VPN/proxy on or switch its server.'));
    await sleep(wait);
  }
}

// --- تشخیص و عیب‌یابی خروجی wrangler ----------------------------------------
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const printTail = (out, n = 30) => {
  const lines = String(out || '').replace(ANSI_RE, '').split('\n').filter(l => l.trim());
  if (!lines.length) return;
  console.error(t('  ──── خروجی wrangler ────', '  ---- wrangler output ----'));
  for (const l of lines.slice(-n)) console.error('  | ' + l);
  console.error(t('  ────────────────────────', '  -------------------------'));
};

// JSON را از وسطِ متن‌های نویزدار (لاگ/هشدار قبل و بعد از JSON) بیرون می‌کشد
function parseLooseJson(text) {
  const t2 = String(text || '');
  if (!t2.trim()) return null;
  try { return JSON.parse(t2); } catch { /* ادامه */ }
  const lastClose = Math.max(t2.lastIndexOf(']'), t2.lastIndexOf('}'));
  if (lastClose < 0) return null;
  for (let i = 0; i < t2.length; i++) {
    if (t2[i] !== '[' && t2[i] !== '{') continue;
    if (i >= lastClose) break;
    try { return JSON.parse(t2.slice(i, lastClose + 1)); } catch { /* کاندید بعدی */ }
  }
  return null;
}

// uuid دیتابیسِ «name» را از خروجی JSON (list آرایه‌ای / info آبجکت تکی / result آرایه‌ای) می‌گیرد
function findUuidForName(parsed, name) {
  let items = [];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && Array.isArray(parsed.result)) items = parsed.result;
  else if (parsed && typeof parsed === 'object') items = [parsed];
  for (const it of items) {
    if (it && typeof it === 'object' && it.uuid && (it.name === name || it.database_name === name)) return it.uuid;
  }
  return null;
}

// بر اساس متن خطای wrangler، راه‌حل قابل‌اجرا پیشنهاد می‌دهد
function d1Hints(out) {
  const o = String(out || '');
  const hints = [];
  if (/already exists|\b7502\b/i.test(o))
    hints.push(t(
      'دیتابیس با همین نام از قبل در اکانت هست؛ این اسکریپت خودش id را پیدا و ثبت می‌کند. اگر باز هم نشد، دستی: «npx wrangler d1 list --json» و کپی‌کردن uuid در wrangler.jsonc',
      'A database with this name already exists in your account; this script finds and registers its id automatically. If it still fails, run: npx wrangler d1 list --json and copy the uuid into wrangler.jsonc'));
  if (/\b7406\b|maximum number of D1|limit reached/i.test(o))
    hints.push(t(
      'سقف تعداد دیتابیس‌های D1 پلن شما پر شده (پلن رایگان = ۱۰ دیتابیس). لیست: «npx wrangler d1 list» — حذف بلااستفاده‌ها: «npx wrangler d1 delete <name>» — یا ارتقای پلن در داشبورد.',
      'Your plan has reached the maximum number of D1 databases (free plan = 10). List: npx wrangler d1 list - delete unused ones with: npx wrangler d1 delete <name> - or upgrade your plan in the dashboard.'));
  if (/\b10000\b|not authorized|unauthorized|authentication error|does not have permission/i.test(o))
    hints.push(t(
      'لاگین/توکن شما به D1 دسترسی ندارد. راه ۱: «npx wrangler login» را دوباره اجرا کنید. راه ۲ (API Token): توکن باید دسترسی‌های «D1:Edit» + «Workers Scripts:Edit» + «Account Settings:Read» را داشته باشد.',
      'Your login/token has no D1 access. Option 1: run npx wrangler login again. Option 2 (API Token): the token needs "D1:Edit" + "Workers Scripts:Edit" + "Account Settings:Read" permissions.'));
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|timed out|network/i.test(o))
    hints.push(t(
      'اتصال به api.cloudflare.com برقرار نشد (اینترنت/فیلترینگ/پروکسی). VPN یا پروکسی را روشن یا تغییر دهید و دوباره اجرا کنید.',
      'Could not reach api.cloudflare.com (network/proxy/firewall). Turn on or change your VPN/proxy and try again.'));
  if (/not authenticated/i.test(o))
    hints.push(t(
      'وارد Cloudflare نیستید — ابتدا «npx wrangler login» را اجرا کنید (مرورگر باز می‌شود).',
      'You are not logged in to Cloudflare - run "npx wrangler login" first (a browser will open).'));
  return hints;
}

// --- تطبیق drift اسکیما (v2.20.1) ----------------------------------------------
// «CREATE TABLE IF NOT EXISTS» روی دیتابیس موجود ستون جدید اضافه نمی‌کند؛ اگر schema.sql
// روی ستونی که فقط با self-migration اضافه می‌شود ایندکس داشته باشد، گام ۳ با
// «no such column» می‌میرد و Worker هیچ‌وقت deploy نمی‌شود تا خودش ستون را بسازد.
// پس قبل از اعمال schema.sql، ستون‌های جاافتاده را از روی خود schema.sql شناسایی و
// با ALTER TABLE اضافه می‌کنیم. هر خطایی در این مسیر فقط warn می‌شود — هیچ‌وقت
// بدتر از رفتار قبلی نمی‌شود (fallback = همان اجرای schema.sql مثل قبل).
async function reconcileSchemaDrift(dbName) {
  const expected = parseSchemaTables(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
  if (!expected.size) return [];
  const probe = await wranglerNet(
    ['d1', 'execute', dbName, '--remote', '--json', '--command', buildProbeCommand(expected.keys()), '-y'],
    { capture: true, timeout: 120000 },
    { label: t('خواندن ستون‌های دیتابیس', 'Reading remote schema columns'), attempts: 2, soft: true });
  if (probe.status !== 0) {
    warn(t('خواندن ستون‌های دیتابیس ناموفق بود — تطبیق drift رد شد و مستقیم schema.sql اعمال می‌شود.',
      'Could not read remote columns - skipping drift reconcile, applying schema.sql directly.'));
    return [];
  }
  const parsed = parseLooseJson((probe.stdout || '') + '\n' + (probe.stderr || ''));
  const missing = diffMissingColumns(expected, extractProbeRows(parsed));
  for (const mcol of missing) {
    const note = mcol.notes.length ? ` (${mcol.notes.join('; ')})` : '';
    await wranglerNet(
      ['d1', 'execute', dbName, '--remote', '--json', '--command', mcol.ddl, '-y'],
      { capture: true, timeout: 120000 },
      { label: t(`افزودن ستون ${mcol.table}.${mcol.name}`, `Adding missing column ${mcol.table}.${mcol.name}`), attempts: 2 });
    ok(t(`ستون جاافتاده اضافه شد: ${mcol.table}.${mcol.name}${note}`, `Missing column added: ${mcol.table}.${mcol.name}${note}`));
  }
  return missing.map((mcol) => `${mcol.table}.${mcol.name}`);
}

// پیدا کردن id دیتابیس از اکانت: اول کل لیست، بعد info همین دیتابیس (v2.17.1: با تلاش مجدد شبکه)
async function discoverDbId(dbName) {
  const ls = await wranglerNet(['d1', 'list', '--json'], { capture: true, timeout: 120000 }, { label: 'd1 list', attempts: 3, soft: true });
  const txt1 = (ls.stdout || '') + (ls.stderr || '');
  let uuid = ls.status === 0 ? findUuidForName(parseLooseJson(txt1), dbName) : null;
  if (uuid) return { uuid, how: 'd1 list', raw: txt1 };
  if (ls.status !== 0 && isNetFailText(txt1)) dieNet(t('خواندن فهرست دیتابیس‌های D1', 'Listing D1 databases'));
  const inf = await wranglerNet(['d1', 'info', dbName, '--json'], { capture: true, timeout: 120000 }, { label: 'd1 info', attempts: 3, soft: true });
  const txt2 = (inf.stdout || '') + (inf.stderr || '');
  uuid = inf.status === 0 ? findUuidForName(parseLooseJson(txt2), dbName) : null;
  if (uuid) return { uuid, how: 'd1 info', raw: txt1 + '\n' + txt2 };
  if (inf.status !== 0 && isNetFailText(txt2)) dieNet(t('خواندن اطلاعات دیتابیس D1', 'Reading D1 database info'));
  return { uuid: null, raw: txt1 + '\n' + txt2 };
}

// --- selftest (بدون شبکه) ----------------------------------------------------
if (flag('--selftest')) {
  const asserts = [];
  const tt = (name, cond) => { asserts.push(cond); console.log(`  ${cond ? '\x1b[32m' + okMark + '\x1b[0m' : '\x1b[31m' + badMark + '\x1b[0m'} ${name}`); };
  const U = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const U2 = '11111111-2222-4333-8444-555555555555';

  const listJson = JSON.stringify([
    { uuid: U2, name: 'old-db', created_at: 'x' },
    { uuid: U, name: 'building-charges', created_at: 'y' }
  ]);
  tt(t('parseLooseJson روی JSON خالص (آرایه)', 'parseLooseJson on plain JSON (array)'), Array.isArray(parseLooseJson(listJson)));
  tt(t('findUuidForName روی d1 list', 'findUuidForName on d1 list'), findUuidForName(parseLooseJson(listJson), 'building-charges') === U);

  const noisy = '⚠ WARNING: something [ignored]\n' + listJson + '\nDone.';
  tt(t('تجزیه خروجی نویزدار', 'parse noisy output'), findUuidForName(parseLooseJson(noisy), 'building-charges') === U);

  const infoJson = JSON.stringify({ uuid: U, name: 'building-charges', version: 'beta', num_tables: 8 });
  tt(t('findUuidForName روی d1 info (آبجکت تکی)', 'findUuidForName on d1 info (single object)'), findUuidForName(parseLooseJson(infoJson), 'building-charges') === U);

  const createOut = `✅ Successfully created DB 'building-charges' in region APAC\nCreated your new D1 database.\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "building-charges"\ndatabase_id = "${U}"\n`;
  tt(t('استخراج uuid از خروجی موفق create', 'extract uuid from successful create output'), ((createOut.match(UUID_RE) || [])[0]) === U);

  tt(t('hint: سقف تعداد دیتابیس', 'hint: database limit'), d1Hints('You have reached the maximum number of D1 databases for your account.').length > 0);
  tt(t('hint: دسترسی توکن (10000)', 'hint: token permissions (10000)'), d1Hints('code: 10000, Authentication error').some(h => h.includes('D1:Edit')));
  tt(t('hint: خطای شبکه', 'hint: network error'), d1Hints('fetch failed').length > 0);
  tt(t('hint: already exists', 'hint: already exists'), d1Hints('A database with that name already exists').length > 0);
  tt(t('hint: خروجی بی‌خطا', 'hint: clean output'), d1Hints('all good').length === 0);

  // v2.17.1 — تشخیص خطای شبکه برای تلاش مجدد خودکار
  tt(t('تشخیص شبکه: fetch failed', 'net detect: fetch failed'), isNetFailText('X [ERROR] fetch failed'));
  tt(t('تشخیص شبکه: هشدار connectivity wrangler', 'net detect: wrangler connectivity warning'), isNetFailText('▲ [WARNING] A fetch request failed, likely due to a connectivity issue.'));
  tt(t('تشخیص شبکه: ETIMEDOUT/ECONNRESET', 'net detect: ETIMEDOUT/ECONNRESET'), isNetFailText('connect ETIMEDOUT 1.2.3.4:443') && isNetFailText('ECONNRESET'));
  tt(t('بدون مثبت کاذب: uuid و خطای منطقی', 'no false positive: uuid & logical error'), !isNetFailText('database_id = 42d171b6-43fb-4644-9b3e-afda069f4e85') && !isNetFailText('database "x" does not exist'));

  // v2.20.1 — تشخیص drift اسکیما (تجزیهٔ خود schema.sql واقعی + ساخت ALTER)
  const schemaSql = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const tables = parseSchemaTables(schemaSql);
  const colNames = (tName) => (tables.get(tName) || []).map((c) => c.name);
  tt(t('تجزیه: جدول bot_messages و ستون direction پیدا شد', 'parse: bot_messages.direction found'), colNames('bot_messages').includes('direction'));
  tt(t('تجزیه: ستون‌های v7/v9 کاربر پیدا شد', 'parse: users v7/v9 columns found'),
    ['token_epoch', 'bound_tg_id', 'is_resident'].every((c) => colNames('users').includes(c)));
  tt(t('تجزیه: محدودیت UNIQUE سطح جدول ستون حساب نشده', 'parse: table-level UNIQUE not a column'),
    colNames('poll_votes').includes('option_index') && !colNames('poll_votes').includes('UNIQUE'));
  tt(t('تجزیه: کلید PRIMARY ستون حساب نشده', 'parse: pk skipped in ADD COLUMN'),
    (tables.get('settings') || []).every((c) => c.name !== 'key' || c.pk === true));
  tt(t('probe: دستور یکجا pragma_table_info', 'probe: batched pragma command'),
    buildProbeCommand(['bot_messages', 'users']).includes("pragma_table_info('bot_messages')") && buildProbeCommand(['a', 'b']).includes(';'));
  tt(t('extract: ردیف‌های چندبلوکی wrangler', 'extract: multi-block wrangler rows'),
    extractProbeRows([{ results: [{ tbl: 'bot_messages', col: 'id' }] }, { results: [{ tbl: 'users', col: 'role' }] }]).length === 2);
  const oldBm = ['id', 'chat_id', 'chat_type', 'tg_user_id', 'username', 'full_name', 'kind', 'title', 'text', 'created_at']
    .map((c) => ({ tbl: 'bot_messages', col: c }));
  const drift = diffMissingColumns(tables, oldBm);
  tt(t('drift: دقیقاً یک ستون (direction) برای bot_messages', 'drift: exactly bot_messages.direction'),
    drift.length === 1 && drift[0].table === 'bot_messages' && drift[0].name === 'direction');
  tt(t('drift: DDL دقیقاً مثل migration داخلی Worker', 'drift: DDL matches runtime migration'),
    drift[0] && drift[0].ddl === "ALTER TABLE 'bot_messages' ADD COLUMN 'direction' TEXT NOT NULL DEFAULT 'in'");
  const usersDrift = diffMissingColumns(tables, colNames('users').filter((c) => c !== 'bound_tg_id' && c !== 'is_resident').map((c) => ({ tbl: 'users', col: c })));
  tt(t('drift: bound_tg_id بدون NOT NULL، is_resident با DEFAULT ۱', 'drift: bound_tg_id nullable, is_resident DEFAULT 1'),
    usersDrift.length === 2
    && usersDrift.some((d) => d.name === 'bound_tg_id' && d.ddl.includes("ADD COLUMN 'bound_tg_id' INTEGER") && !d.ddl.includes('NOT NULL'))
    && usersDrift.some((d) => d.name === 'is_resident' && d.ddl.includes('NOT NULL DEFAULT 1')));
  tt(t('drift: جدول ناموجود در ریموت رد می‌شود', 'drift: absent remote table skipped'),
    diffMissingColumns(tables, []).length === 0);
  tt(t('drift: دیتابیس کامل → هیچ ALTERی لازم نیست', 'drift: full db → nothing to do'),
    diffMissingColumns(tables, [...tables.entries()].flatMap(([tn, cols]) => cols.map((c) => ({ tbl: tn, col: c.name })))).length === 0);

  const tmp = path.join(ROOT, '.selftest-wrangler.jsonc');
  fs.writeFileSync(tmp, '{\n  "name": "x",\n  "d1_databases": [{ "binding": "DB", "database_name": "building-charges", "database_id": "REPLACE_ME_AFTER_d1_create" }]\n}\n');
  writeDbId(U, tmp);
  tt(t('writeDbId جایگزین placeholder', 'writeDbId replaces placeholder'), fs.readFileSync(tmp, 'utf8').includes(`"database_id": "${U}"`));
  fs.writeFileSync(tmp, '{\n  "d1_databases": [{ "binding": "DB", "database_name": "building-charges" }]\n}');
  writeDbId(U, tmp);
  tt(t('writeDbId وقتی کلید database_id ندارد', 'writeDbId when database_id key is missing'), fs.readFileSync(tmp, 'utf8').includes(U));
  fs.unlinkSync(tmp);

  const bad = asserts.filter(a => !a).length;
  console.log(bad
    ? t(`\n\x1b[31m${badMark} ${bad} تست شکست خورد\x1b[0m`, `\n\x1b[31m${badMark} ${bad} test(s) failed\x1b[0m`)
    : t(`\n\x1b[32m${okMark} همه‌ی ${asserts.length} تست پاس شد\x1b[0m`, `\n\x1b[32m${okMark} all ${asserts.length} tests passed\x1b[0m`));
  process.exit(bad ? 1 : 0);
}

async function prompt(q) {
  if (CI) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim() || null); }));
}

// --- 0) preflight -----------------------------------------------------------
step(0, t('بررسی پیش‌نیازها', 'Checking prerequisites'));
if (Number(process.versions.node.split('.')[0]) < 18)
  die(t('Node.js نسخه ۱۸ یا بالاتر لازم است.', 'Node.js 18 or higher is required.'));
if (!fs.existsSync(WRANGLER_BIN)) {
  info(t('wrangler نصب نیست — در حال نصب وابستگی‌ها…', 'wrangler not installed - installing dependencies...'));
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) die(t('npm install ناموفق بود.', 'npm install failed.'));
}
if (!fs.existsSync(CONFIG)) die(t('wrangler.jsonc پیدا نشد — از ریشه‌ی پروژه اجرا کنید.', 'wrangler.jsonc not found - run from the project root.'));
ok(t(`Node ${process.versions.node} — wrangler آماده است`, `Node ${process.versions.node} - wrangler is ready`));

// --- 1) auth ----------------------------------------------------------------
step(1, t('بررسی ورود به Cloudflare', 'Checking Cloudflare login'));
let who = wrangler(['whoami'], { capture: true });
let whoOut = (who.stdout || '') + (who.stderr || '');
if (who.status !== 0 && isNetFailText(whoOut)) // v2.17.1 — خطای شبکه ≠ «وارد نشده‌اید»؛ اول تلاش مجدد
  who = await wranglerNet(['whoami'], {}, { label: t('بررسی ورود به Cloudflare', 'Cloudflare login check'), attempts: NET_ATTEMPTS });
whoOut = (who.stdout || '') + (who.stderr || '');
const authed = who.status === 0 && !/not authenticated/i.test(whoOut);
if (!authed) {
  printTail(whoOut);
  const hints = d1Hints(whoOut);
  if (hints.length) for (const h of hints) console.error('  ' + t('💡', '*') + ' ' + h);
  if (CI) die(t('در CI باید CLOUDFLARE_API_TOKEN (با دسترسی D1:Edit + Workers Scripts:Edit) و CLOUDFLARE_ACCOUNT_ID را به‌عنوان Secret تنظیم کنید.',
    'In CI you must set CLOUDFLARE_API_TOKEN (with D1:Edit + Workers Scripts:Edit permissions) and CLOUDFLARE_ACCOUNT_ID as secrets.'));
  warn(t('وارد Cloudflare نیستید.', 'You are not logged in to Cloudflare.'));
  info(t('یکی از دو راه:', 'Choose one of these two options:'));
  info(t('  ۱) اجرای دستور  npx wrangler login  (مرورگر باز می‌شود) و سپس اجرای مجدد این اسکریپت',
    '  1) Run: npx wrangler login  (a browser opens), then re-run this script'));
  info(t('  ۲) تنظیم متغیرهای محیطی CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID',
    '  2) Or set the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID environment variables'));
  const tryLogin = await prompt(t('همین حالا «wrangler login» اجرا شود؟ [Y/n] ', 'Run "wrangler login" now? [Y/n] '));
  if (tryLogin && /^n/i.test(tryLogin)) die(t('ورود لازم است.', 'Login is required.'));
  const lg = spawnSync(process.execPath, [WRANGLER_BIN, 'login'], { cwd: ROOT, stdio: 'inherit' });
  if (lg.status !== 0) die(t('ورود به Cloudflare ناموفق بود.', 'Cloudflare login failed.'));
} else {
  const acct = (whoOut.match(/([a-f0-9]{32})/i) || [])[1];
  ok(t(`وارد شده‌اید${acct ? ` (account: ${acct})` : ''}`, `Logged in${acct ? ` (account: ${acct})` : ''}`));
}

// --- 2) D1 database ---------------------------------------------------------
step(2, t('آماده‌سازی دیتابیس D1', 'Preparing the D1 database'));
const confText = fs.readFileSync(CONFIG, 'utf8');
const dbName = argOf('--db-name') || (confText.match(/"database_name"\s*:\s*"([^"]+)"/) || [])[1] || 'building-charges';
let dbId = (confText.match(/"database_id"\s*:\s*"([^"]+)"/) || [])[1] || '';
const idValid = UUID_RE.test(dbId);

function writeDbId(id, cfgPath = CONFIG) {
  let text = fs.readFileSync(cfgPath, 'utf8');
  if (/"database_id"\s*:\s*"/.test(text)) {
    text = text.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
  } else {
    text = text.replace(/("database_name"\s*:\s*"[^"]+"\s*,?)/, `$1\n      "database_id": "${id}",`);
  }
  fs.writeFileSync(cfgPath, text);
}

if (idValid) {
  ok(t(`database_id از قبل ثبت شده: ${dbId}`, `database_id already registered: ${dbId}`));
} else {
  // آیا دیتابیس با همین نام از قبل در اکانت هست؟ (لیست کل دیتابیس‌ها → info همین دیتابیس)
  info(t(`بررسی دیتابیس «${dbName}» در اکانت Cloudflare…`, `Checking database "${dbName}" in your Cloudflare account...`));
  const found = await discoverDbId(dbName);
  let uuid = found.uuid;
  if (uuid) {
    info(t('دیتابیس موجود پیدا شد (' + found.how + ')؛ id آن به wrangler.jsonc متصل می‌شود.',
      'Existing database found (' + found.how + '); its id is now wired into wrangler.jsonc.'));
  } else {
    info(t(`دیتابیس «${dbName}» وجود ندارد — ساخته می‌شود…`, `Database "${dbName}" does not exist - creating it...`));
    const cr = await wranglerNet(['d1', 'create', dbName], { capture: true, timeout: 180000 }, { label: 'd1 create', attempts: 3, soft: true });
    const crOut = (cr.stdout || '') + (cr.stderr || '');
    if (cr.status !== 0 && isNetFailText(crOut)) { printTail(crOut); dieNet(t('ساخت دیتابیس D1', 'Creating the D1 database')); }
    uuid = (crOut.match(UUID_RE) || [])[0] || null;
    // خطای «از قبل وجود دارد» → دوباره از اکانت بخوان (سناریوی آپدیت/دیپلوی مجدد)
    if (!uuid && /already exists|\b7502\b/i.test(crOut)) {
      warn(t('دیتابیس از قبل ساخته شده بوده — id از اکانت خوانده می‌شود…',
        'The database was already created - reading its id from the account...'));
      const again = await discoverDbId(dbName);
      uuid = again.uuid || null;
      if (!uuid) {
        printTail(crOut + '\n' + again.raw);
        die(t('دیتابیس موجود است ولی id خوانده نشد — دستی: «npx wrangler d1 list --json» و کپی uuid در wrangler.jsonc',
          'The database exists but its id could not be read - manually: npx wrangler d1 list --json and copy the uuid into wrangler.jsonc'));
      }
    }
    if (!uuid) {
      // دیگر هیچ خطایی پنهان نمی‌شود: خروجی واقعی + راه‌حل پیشنهادی
      printTail(crOut);
      const hints = d1Hints(crOut);
      if (hints.length) {
        console.error(t('  💡 راه‌حل‌های پیشنهادی:', '  * Suggested fixes:'));
        for (const h of hints) console.error('     - ' + h);
      }
      die(t('ساخت دیتابیس D1 ناموفق بود — علت واقعی در «خروجی wrangler» بالا آمده است.',
        'Creating the D1 database failed - the real cause is in the "wrangler output" above.'));
    }
  }
  dbId = uuid;
  writeDbId(dbId);
  ok(t(`database_id = ${dbId} (در wrangler.jsonc ثبت شد)`, `database_id = ${dbId} (written to wrangler.jsonc)`));
}

// --- 3) schema --------------------------------------------------------------
if (!SKIP_SCHEMA) {
  step(3, t('اجرای اسکیمای دیتابیس (idempotent)', 'Applying the database schema (idempotent)'));
  // v2.20.1 — تطبیق drift ستون‌ها قبل از اعمال schema.sql (مثال واقعی: ستون direction
  // در v2.19.0 که ایندکسش روی دیتابیس‌های قدیمی با «no such column» دیپلوی را می‌کشت)
  try {
    const fixedCols = await reconcileSchemaDrift(dbName);
    if (fixedCols.length)
      ok(t(`Schema drift fixed: ${fixedCols.length} ستون جاافتاده اضافه شد (${fixedCols.join(', ')})`,
        `Schema drift fixed: ${fixedCols.length} missing column(s) added (${fixedCols.join(', ')})`));
  } catch (e) {
    warn(t(`تطبیق drift با خطا رد شد (${e && e.message ? e.message : e}) — ادامه با اجرای schema.sql`,
      `Drift reconcile skipped (${e && e.message ? e.message : e}) - continuing with schema.sql`));
  }
  // v2.17.1 — قطع‌شدن وسط آپلود/import دیگر کل دیپلوی را نمی‌کشد؛ خودکار تلاش مجدد می‌شود
  await wranglerNet(['d1', 'execute', dbName, '--remote', '--file=./schema.sql', '-y'], {},
    { label: t('اجرای schema.sql روی D1', 'Applying schema.sql to D1'), attempts: NET_ATTEMPTS });
  ok(t('جداول (units/users/expenses/debts/settings/polls) روی دیتابیس ابری اعمال شد',
    'Tables (units/users/expenses/debts/settings/polls) applied to the cloud database'));
} else {
  step(3, t('اجرای اسکیمای دیتابیس — رد شد (--skip-schema)', 'Database schema - skipped (--skip-schema)'));
}

// --- 4) deploy --------------------------------------------------------------
let appUrl = null;
if (!SKIP_DEPLOY) {
  step(4, t('دیپلوی Worker روی Cloudflare', 'Deploying the Worker to Cloudflare'));
  const r = await wranglerNet(['deploy'], {}, { label: t('دیپلوی Worker', 'wrangler deploy'), attempts: NET_ATTEMPTS,
    note: t('نسخهٔ قبلی همچنان فعال مانده است. ', 'The previous version is still live. ') });
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(out.split('\n').filter(Boolean).map(l => '  ' + l).join('\n'));
  appUrl = (out.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i) || [])[0] || null;
  ok(t(`منتشر شد: ${appUrl}`, `Deployed: ${appUrl}`));
} else {
  step(4, t('دیپلوی — رد شد (--skip-deploy)', 'Deploy - skipped (--skip-deploy)'));
}

// --- 5) bot token + webhook -------------------------------------------------
let botToken = argOf('--bot-token') || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || null;
let webhookSecret = argOf('--webhook-secret') || process.env.WEBHOOK_SECRET || null;

if (!SKIP_WEBHOOK) {
  step(5, t('ربات تلگرام و وب‌هوک', 'Telegram bot and webhook'));
  if (!botToken && !CI && !flag('--skip-webhook')) {
    botToken = await prompt(t('BOT_TOKEN ربات تلگرام (برای رد شدن، خالی بگذارید): ',
      'Telegram BOT_TOKEN (leave empty to skip): '));
  }
  if (!botToken) {
    warn(t('BOT_TOKEN داده نشد — ربات و یادآوری‌های تلگرامی غیرفعال می‌مانند.',
      'No BOT_TOKEN given - the bot and Telegram reminders stay disabled.'));
    info(t('بعداً:  npm run secret:bot  یا  wrangler secret put BOT_TOKEN',
      'Later: npm run secret:bot  or  wrangler secret put BOT_TOKEN'));
  } else {
    // اعتبار توکن
    let botName = null;
    try {
      const me = await getBotInfo(botToken);
      if (me.ok) { botName = me.username; ok(t(`توکن معتبر است — ربات: @${botName}`, `Token is valid - bot: @${botName}`)); }
      else warn(t(`توکن ربات تلگرام معتبر نیست (${me.error || '?'}) — ادامه می‌دهیم (وب‌هوک تنظیم نمی‌شود).`,
        `The Telegram bot token is not valid (${me.error || '?'}) - continuing (webhook will not be set).`));
    } catch { warn(t('بررسی توکن ممکن نبود (اینترنت/فیلترینگ) — ادامه می‌دهیم.',
      'Could not verify the token (network) - continuing.')); }

    if (botName) {
      const sp = await wranglerNet(['secret', 'put', 'BOT_TOKEN'], { capture: true, input: botToken + '\n' }, { label: 'secret BOT_TOKEN', attempts: 3 });
      if (sp.status !== 0) { console.error(sp.stderr || sp.stdout || ''); die(t('ثبت BOT_TOKEN ناموفق بود.', 'Saving BOT_TOKEN failed.')); }
      ok(t('BOT_TOKEN به‌عنوان Secret ثبت شد', 'BOT_TOKEN saved as a secret'));

      if (appUrl) {
        if (!webhookSecret) {
          webhookSecret = crypto.randomBytes(24).toString('hex');
          const sp2 = await wranglerNet(['secret', 'put', 'WEBHOOK_SECRET'], { capture: true, input: webhookSecret + '\n' }, { label: 'secret WEBHOOK_SECRET', attempts: 3 });
          if (sp2.status === 0) ok(t('WEBHOOK_SECRET ساخته و ثبت شد', 'WEBHOOK_SECRET created and saved'));
        }
        const hook = `${appUrl}/webhook/telegram`;
        // همان مسیر پنل ادمین: وب‌هوک با allowed_updates کامل (شامل my_chat_member برای گروه‌ها)
        try {
          const sw = await setWebhook(botToken, hook, webhookSecret || '');
          if (sw.ok) {
            ok(t(`وب‌هوک فعال شد: ${hook}`, `Webhook is live: ${hook}`));
            const mc = await setMyCommands(botToken);
            const mb = await setChatMenuButton(botToken, appUrl);
            if (mc.ok && mb.ok) ok(t('دستورات (/start /app /help) و دکمه منو اپ ثبت شد',
              'Commands (/start /app /help) and the app menu button were registered'));
            else warn(t('ثبت دستورات/دکمه منو ناموفق بود — از پنل ادمین (تنظیمات اپ) دوباره اعمال کنید.',
              'Registering commands/menu button failed - re-apply them from the admin panel (App settings).'));
          } else warn(t(`setWebhook ناموفق: ${sw.error || '?'}`, `setWebhook failed: ${sw.error || '?'}`));
        } catch { warn(t('setWebhook ممکن نشد — بعداً دستی تنظیم کنید (بخش راهنما).',
          'setWebhook did not complete - set it manually later (see the guide).')); }
      } else {
        warn(t('آدرس اپ پیدا نشد — وب‌هوک را بعد از دیپلوی دستی تنظیم کنید.',
          'App URL not found - set the webhook manually after deploying.'));
      }
    }
  }
} else {
  step(5, t('ربات تلگرام — رد شد (--skip-webhook)', 'Telegram bot - skipped (--skip-webhook)'));
}

// --- summary ----------------------------------------------------------------
if (LANG === 'fa') {
  console.log(`
\x1b[1;32m══════════════════════ استقرار کامل شد ══════════════════════\x1b[0m
  اپ تلگرام (Mini App):  ${appUrl || '—'}
  پنل مدیریت کل اپ:      ${appUrl ? appUrl + '/admin.html' : '— (appUrl/admin.html)'}
  وب‌هوک ربات:            ${botToken ? 'فعال' : 'غیرفعال (BOT_TOKEN تنظیم نشده)'}
  کران یادآوری خودکار:   روزانه ۰۹:۰۰ تهران — در پنل مدیر (گزارش‌ها) فعال/تنظیم کنید

  گام بعدی: پنل مدیریت (${appUrl ? appUrl + '/admin.html' : 'admin.html'}) را باز کنید،
  «نصب اولیه» را کامل کنید و مدیر ساختمان را با نام‌کاربری/رمز بسازید.
\x1b[1;32m═════════════════════════════════════════════════════════════\x1b[0m`);
} else {
  console.log(`
\x1b[1;32m====================== DEPLOYMENT COMPLETE ======================\x1b[0m
  Telegram Mini App:     ${appUrl || '-'}
  Admin panel:           ${appUrl ? appUrl + '/admin.html' : '- (appUrl/admin.html)'}
  Bot webhook:           ${botToken ? 'active' : 'inactive (BOT_TOKEN not set)'}
  Reminder cron:         daily 09:00 Tehran - enable/adjust in the manager panel

  Next step: open the admin panel (${appUrl ? appUrl + '/admin.html' : 'admin.html'}),
  finish the initial setup and create the building manager account.
  (Persian output: set DEPLOY_LANG=fa, e.g. in Windows Terminal)
\x1b[1;32m=================================================================\x1b[0m`);
}
