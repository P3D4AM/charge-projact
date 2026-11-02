// Tests for the bot messages report (گزارش پیام‌های بات) — v2.9
// Covers: pure helpers (derive/shouldLog/filters), webhook logging on a real
// sqlite DB (private text/command/media, group command only, no edits),
// the /a/bot/messages API (RBAC + title/date/search filters) and robustness
// (missing table must never break the webhook).
import assert from 'node:assert/strict';
import fs from 'node:fs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('test-botmessages: node:sqlite unavailable — SKIPPED');
  process.exit(0);
}

import {
  deriveBotTitle, shouldLogUpdate, parseFilters, filterSql,
  isoDateToTehranDayStart, chatTypeLabel, outgoingTitle,
  logBotMessage, logOutgoingBotMessage, botMessagesReport, botMessageStats
} from '../src/botmessages.js';
import { tehranDayStartSec, tehranParts } from '../src/jalali.js';
import worker from '../src/worker.js';
import { handleApi } from '../src/api.js';
import { hashPassword, createSessionToken } from '../src/auth.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✖ ${name}`); }
};

// ---------- D1 adapter over node:sqlite (same shape as test-api) ----------
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { last_row_id: Number(info.lastInsertRowid ?? 0), changes: Number(info.changes ?? 0) } };
  }
  first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
class MockD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new MockStmt(this.db, sql); }
  async batch(stmts) { for (const s of stmts) s.run(); return { success: true }; }
  async exec(sql) { this.db.exec(sql); }
}

function makeEnv() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  // BOT_TOKEN must be set — the webhook exits early without it (before logging)
  return { raw, env: { DB: new MockD1(raw), BOT_TOKEN: '123456789:TEST_FAKE_TOKEN_xxxxxxxxxxxx', ASSETS: { fetch: async () => new Response('x') } } };
}

// ---------------------------------------------------------------------------
console.log('\n— pure helpers —');

// deriveBotTitle
check('command /start', deriveBotTitle('private', { text: '/start' }).title === 'فرمان /start'
  && deriveBotTitle('private', { text: '/start' }).kind === 'command');
check('command with mention /app@my_bot', deriveBotTitle('group', { text: '/app@my_bot سلام' }).title === 'فرمان /app');
check('command case-insensitive', deriveBotTitle('private', { text: '/HELP' }).title === 'فرمان /help');
check('plain text', deriveBotTitle('private', { text: 'سلام شارژ چقدر شد؟' })
  .title === 'پیام متنی' && deriveBotTitle('private', { text: 'سلام' }).kind === 'text');
check('media/other (no text)', deriveBotTitle('private', { text: '' }).kind === 'other'
  && deriveBotTitle('private', {}).title === 'رسانه یا سایر');
check('persian command /اپ', deriveBotTitle('group', { text: '/اپ' }).title === 'فرمان /اپ');

// shouldLogUpdate
check('private message logged', shouldLogUpdate({ message: { chat: { type: 'private' }, text: 'سلام' } }));
check('edited_message NOT logged', !shouldLogUpdate({ edited_message: { chat: { type: 'private' }, text: 'ویرایش' } }));
check('group command logged', shouldLogUpdate({ message: { chat: { type: 'group' }, text: '/app' } }));
check('group command with mention logged', shouldLogUpdate({ message: { chat: { type: 'supergroup' }, text: '/start@mybot' } }));
check('group chatter NOT logged', !shouldLogUpdate({ message: { chat: { type: 'group' }, text: 'سلام بچه‌ها' } }));
check('channel post NOT logged', !shouldLogUpdate({ channel_post: { chat: { type: 'channel' }, text: '/app' } }));
check('no chat NOT logged', !shouldLogUpdate({ message: { text: 'x' } }));

// filters
const f1 = parseFilters(new URLSearchParams('from=2025-10-01&to=2025-10-03'));
const fromSec = isoDateToTehranDayStart('2025-10-01');
check('from = Tehran 00:00 of the date (UTC+3:30)',
  fromSec === Math.floor(Date.UTC(2025, 9, 1) / 1000) - 12600);
check('to = end of the to-date', f1.to === isoDateToTehranDayStart('2025-10-03') + 86399);
check('bad dates → 0 (no filter)', isoDateToTehranDayStart('garbage') === 0
  && isoDateToTehranDayStart('2025-13-40') === 0);
check('limit clamp 1..500', parseFilters(new URLSearchParams('limit=9999')).limit === 500
  && parseFilters(new URLSearchParams('limit=-3')).limit === 1);

const fs1 = filterSql({ from: 100, to: 200, title: 'فرمان /start', q: 'شارژ%' });
check('filterSql builds WHERE + args (b.-qualified)', fs1.where === 'WHERE b.created_at >= ? AND b.created_at <= ? AND b.title = ? AND (b.text LIKE ? OR b.full_name LIKE ? OR b.username LIKE ?)'
  && fs1.args[0] === 100 && fs1.args[3] === '%شارژ\\%%');
check('filterSql empty → no WHERE', filterSql({}).where === '');

check('chatTypeLabel', chatTypeLabel('private') === 'چت خصوصی' && chatTypeLabel('supergroup') === 'گروه');

// ---------------------------------------------------------------------------
console.log('\n— webhook logging (real sqlite) —');
{
  const { raw, env } = makeEnv();
  const jobs = [];
  const ctx = { waitUntil: p => jobs.push(p) }; // simulate Workers ctx
  const post = async body => {
    const r = await worker.fetch(new Request('https://app.example.com/webhook/telegram', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }
    }), env, ctx);
    await Promise.all(jobs.splice(0)); // run deferred waitUntil jobs
    return r;
  };

  const nowSec = Math.floor(Date.now() / 1000);
  await post({ message: { chat: { id: 10, type: 'private' }, from: { id: 7, username: 'Ali_M', first_name: 'علی', last_name: 'رضایی' }, text: '/start', date: nowSec - 400 } });
  await post({ message: { chat: { id: 10, type: 'private' }, from: { id: 7, username: 'Ali_M', first_name: 'علی' }, text: 'سلام شارژ چقدر است؟', date: nowSec - 340 } });
  await post({ message: { chat: { id: 10, type: 'private' }, from: { id: 7, username: 'Ali_M', first_name: 'علی' }, date: nowSec - 280 } }); // media, no text
  await post({ edited_message: { chat: { id: 10, type: 'private' }, from: { id: 7 }, text: 'edited', date: nowSec - 220 } }); // edit → no row
  await post({ message: { chat: { id: -100, type: 'group' }, from: { id: 8, first_name: 'س' }, text: 'گفتگوی عادی', date: nowSec - 160 } }); // group chatter → no row
  await post({ message: { chat: { id: -100, type: 'group' }, from: { id: 8, first_name: 'س' }, text: '/app', date: nowSec - 100 } }); // group command → row

  const rows = raw.prepare('SELECT * FROM bot_messages ORDER BY id').all();
  check('4 rows logged (3 private + 1 group command)', rows.length === 4);
  check('row fields snapshot (name/username/chat)',
    rows[0].full_name === 'علی رضایی' && rows[0].username === 'Ali_M' && rows[0].chat_id === 10
    && rows[0].tg_user_id === 7 && Number(rows[0].created_at) > nowSec - 600);
  check('titles: /start + text + media + group /app',
    rows[0].title === 'فرمان /start' && rows[1].title === 'پیام متنی'
    && rows[2].title === 'رسانه یا سایر' && rows[3].title === 'فرمان /app');
  check('group row chat_type + no username', rows[3].chat_type === 'group' && rows[3].username === '');

  const st = await botMessageStats(env);
  check('stats total=4', st.total === 4);

  // robustness: broken DB must not break the webhook
  const badEnv = { BOT_TOKEN: 'x', ASSETS: { fetch: async () => new Response('x') }, DB: { prepare: () => { throw new Error('boom'); } } };
  let r = await worker.fetch(new Request('https://app.example.com/webhook/telegram', {
    method: 'POST', body: JSON.stringify({ message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } }),
    headers: { 'content-type': 'application/json' }
  }), badEnv);
  check('webhook survives DB errors', (await r.text()) === 'ok');
}

// ---------------------------------------------------------------------------
console.log('\n— report filters on sqlite —');
{
  const { raw, env } = makeEnv();
  const mk = (chatId, chatType, tgId, uname, fname, kind, title, text, ts) =>
    logBotMessage(env, { chat: { id: chatId, type: chatType }, from: { id: tgId, username: uname, first_name: fname }, text, date: ts });

  // relative dates (Tehran midnights): two days ago / today — the 180-day
  // prune must never touch these rows
  const todayStart = tehranDayStartSec(Math.floor(Date.now() / 1000));
  const d0 = todayStart - 2 * 86400;
  const isoOf = ts => {
    const p = tehranParts(ts * 1000);
    return `${p.gy}-${String(p.gm).padStart(2, '0')}-${String(p.gd).padStart(2, '0')}`;
  };
  await mk(1, 'private', 100, 'u1', 'علی', 'command', 'فرمان /start', '/start', d0 + 3600);
  await mk(2, 'private', 200, 'u2', 'مریم', 'text', 'پیام متنی', 'شارژ چقدر شد؟', d0 + 7200);
  await mk(3, 'group', 100, 'u1', 'علی', 'command', 'فرمان /app', '/app', todayStart + 3600);
  await mk(4, 'private', 300, 'u3', 'سارا', 'text', 'پیام متنی', 'سلام', todayStart + 7200);

  // default: everything, newest first
  let rep = await botMessagesReport(env, parseFilters(new URLSearchParams('')));
  check('default report returns all (newest first)', rep.messages.length === 4 && rep.messages[0].text === 'سلام');
  check('stats total/today', rep.stats.total === 4 && rep.stats.today === 2);

  // title filter
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('title=' + encodeURIComponent('فرمان /start'))));
  check('title filter', rep.messages.length === 1 && rep.matched === 1 && rep.messages[0].text === '/start');

  // date range (from = yesterday → today's rows only)
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('from=' + isoOf(Date.now() / 1000 - 86400))));
  check('date from filter', rep.matched === 2);

  // date range (from+to = 2 days ago → that day's rows only)
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams(`from=${isoOf(d0)}&to=${isoOf(d0)}`)));
  check('single-day range', rep.matched === 2);

  // search q
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('q=' + encodeURIComponent('شارژ'))));
  check('text search', rep.matched === 1 && rep.messages[0].username === 'u2');

  // titles aggregation
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('')));
  const t = Object.fromEntries(rep.titles.map(x => [x.title, x.n]));
  check('titles aggregation', t['فرمان /start'] === 1 && t['پیام متنی'] === 2 && t['فرمان /app'] === 1);

  // has_more + offset pagination
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('limit=2')));
  check('pagination has_more', rep.has_more === true && rep.messages.length === 2);
  rep = await botMessagesReport(env, parseFilters(new URLSearchParams('limit=2&offset=2')));
  check('offset page 2', rep.messages.length === 2 && rep.has_more === false);
}

// ---------------------------------------------------------------------------
console.log('\n— API /a/bot/messages (RBAC + content) —');
{
  const { raw, env } = makeEnv();
  const [adminHash, mgrHash, resHash] = await Promise.all([
    hashPassword('Admin@1404'), hashPassword('manager123'), hashPassword('1234')
  ]);
  raw.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, telegram_username, is_active, created_at) VALUES " +
    "('admin', ?, 'admin', 'مدیر اپ', 1, 'admin_tg', 1, 0)," +
    "('manager', ?, 'manager', 'مدیر', 2, 'mgr_tg', 1, 0)," +
    "('unit1', ?, 'resident', 'ساکن', 3, 'res_tg', 1, 0)"
  ).run(adminHash, mgrHash, resHash);

  const login = async (username, password) => {
    const res = await handleApi(new Request('https://x.example.com/api/auth/login', {
      method: 'POST', body: JSON.stringify({ username, password }), headers: { 'content-type': 'application/json' }
    }), env);
    const d = await res.json();
    return d.token;
  };
  const adminTok = await login('admin', 'Admin@1404');
  const mgrTok = await login('manager', 'manager123');
  const resTok = await login('unit1', '1234');

  const call = (tok, qs = '') => handleApi(new Request('https://x.example.com/api/a/bot/messages' + qs, {
    headers: { authorization: 'Bearer ' + tok }
  }), env);

  let res = await call(resTok);
  check('resident → 403', res.status === 403);
  res = await call(mgrTok);
  check('manager → 403', res.status === 403);
  res = await call(adminTok);
  check('admin → 200', res.status === 200);
  const d = await res.json();
  check('response shape (stats/titles/messages)', Array.isArray(d.titles) && Array.isArray(d.messages) && d.stats && typeof d.has_more === 'boolean');

  // log two messages via webhook, then check the linked-app-user join
  const jobs2 = [];
  const ctx2 = { waitUntil: p => jobs2.push(p) };
  const post = async body => {
    const r = await worker.fetch(new Request('https://x.example.com/webhook/telegram', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }
    }), env, ctx2);
    await Promise.all(jobs2.splice(0));
    return r;
  };
  await post({ message: { chat: { id: 55, type: 'private' }, from: { id: 3, username: 'res_tg', first_name: 'ساکن' }, text: '/start', date: Math.floor(Date.now() / 1000) } });
  await post({ message: { chat: { id: 56, type: 'private' }, from: { id: 9, username: 'stranger', first_name: 'غریبه' }, text: 'سلام', date: Math.floor(Date.now() / 1000) } });

  res = await call(adminTok, '?q=' + encodeURIComponent('سلام'));
  const d2 = await res.json();
  check('search filter via API', d2.matched === 1 && d2.messages[0].username === 'stranger');

  res = await call(adminTok);
  const d3 = await res.json();
  const linkedRow = d3.messages.find(m => m.username === 'res_tg');
  check('linked app user join (role+unit resolve or null-safe)',
    linkedRow !== undefined && (linkedRow.app_role === 'resident' || linkedRow.app_role === null));

  // missing table → report still answers with zeros (not a crash) — direct call
  const rawNoTable = new DatabaseSync(':memory:');
  const envNoTable = { DB: new MockD1(rawNoTable), BOT_TOKEN: '', ASSETS: { fetch: async () => new Response('x') } };
  const repNoTable = await botMessagesReport(envNoTable, parseFilters(new URLSearchParams('')));
  check('missing table → graceful empty report', repNoTable.stats.total === 0
    && Array.isArray(repNoTable.messages) && repNoTable.messages.length === 0
    && Array.isArray(repNoTable.titles));
  const stNoTable = await botMessageStats(envNoTable);
  check('missing table → zero stats', stNoTable.total === 0 && stNoTable.today === 0);
}

// ---------------------------------------------------------------------------
// v2.19.0 — outgoing messages (پیام‌های ارسالی ربات)
// ---------------------------------------------------------------------------
console.log('\n— outgoing messages (v2.19.0) —');
{
  const { raw, env } = makeEnv();
  // recipient user for the name lookup + users join
  raw.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, telegram_username, is_active, created_at) " +
    "VALUES ('unit9', 'x', 'resident', 'ساکن نمونه', 777, 'res9_tg', 1, 0)"
  ).run();

  // pure helpers
  check('outgoingTitle keeps the given title', outgoingTitle('یادآوری خودکار') === 'یادآوری خودکار');
  check('outgoingTitle fallback', outgoingTitle('') === 'ارسال ربات' && outgoingTitle(null) === 'ارسال ربات');
  const pf = parseFilters(new URLSearchParams('dir=out&title=x'));
  check('parseFilters dir=out', pf.dir === 'out');
  check('parseFilters dir invalid → empty', parseFilters(new URLSearchParams('dir=both')).dir === '');
  const fsd = filterSql({ dir: 'out' });
  check('filterSql direction clause', fsd.where === 'WHERE b.direction = ?' && fsd.args[0] === 'out');

  // insert with recipient lookup
  await logOutgoingBotMessage(env, { chatId: 777, text: 'مانده بدهی شما …', title: 'یادآوری دستی' });
  let row = raw.prepare("SELECT * FROM bot_messages WHERE direction = 'out'").get();
  check('out row: direction/kind/title', !!row && row.direction === 'out' && row.kind === 'out' && row.title === 'یادآوری دستی');
  check('out row: recipient name lookup from users', row.username === 'unit9' && row.full_name === 'ساکن نمونه' && row.tg_user_id === 777);
  check('out row: chat_id mirrors recipient', row.chat_id === 777 && row.chat_type === 'private');

  // unknown recipient + group chat type passthrough
  await logOutgoingBotMessage(env, { chatId: -100, chatType: 'group', text: 'کارت اپ', title: 'پاسخ ربات' });
  row = raw.prepare("SELECT * FROM bot_messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1").get();
  check('out row: unknown recipient tolerated (group welcome)', row.username === '' && row.full_name === '' && row.chat_type === 'group');

  // deferral via ctx.waitUntil
  const jobs = [];
  const meta = await logOutgoingBotMessage(env, { chatId: 777, text: 'اعلان همگانی', title: 'اعلان همگانی' }, { waitUntil: p => jobs.push(p) });
  check('ctx.waitUntil → deferred flag + job registered', meta.deferred === true && jobs.length === 1);
  await Promise.all(jobs);
  check('deferred job writes after waitUntil resolves', raw.prepare("SELECT COUNT(*) AS n FROM bot_messages WHERE direction = 'out'").get().n === 3);

  // report: direction filter + out_total stat + newest-first
  const repOut = await botMessagesReport(env, parseFilters(new URLSearchParams('dir=out')));
  check('report dir=out → 3 rows, all out', repOut.matched === 3 && repOut.messages.every(m => m.direction === 'out'));
  const repIn = await botMessagesReport(env, parseFilters(new URLSearchParams('dir=in')));
  check('report dir=in → 0 rows (no incoming yet)', repIn.matched === 0);
  check('stats out_total=3', repOut.stats.out_total === 3 && repIn.stats.out_total === 3);

  // combined filters: dir + title
  const repT = await botMessagesReport(env, parseFilters(new URLSearchParams('dir=out&title=' + encodeURIComponent('یادآوری دستی'))));
  check('dir+title combined', repT.matched === 1 && repT.messages[0].title === 'یادآوری دستی');

  // robustness: broken env must never throw
  const bad = await logOutgoingBotMessage({ DB: { prepare: () => { throw new Error('boom'); } } }, { chatId: 1, text: 'x', title: 'y' });
  check('broken DB → {logged:false} (never throws)', bad.logged === false);
  check('invalid info → skipped', (await logOutgoingBotMessage(env, null)).logged === false
    && (await logOutgoingBotMessage(env, { chatId: 0, text: 'x' })).logged === false);
}

console.log(`\ntest-botmessages: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
