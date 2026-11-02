// Tests for the visit & login report (گزارش ورود به اپ) — v2.8
// Pure helpers (cooldown/labels/text/time formatting) + the logVisit DB flow
// (dedup, notify skip without bot token, report shape) on a node:sqlite mock.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('test-visits: node:sqlite unavailable — SKIPPED');
  process.exit(0);
}

import {
  withinCooldown, buildVisitText, visitKindLabel, visitViaLabel,
  OPEN_DEDUP_SECONDS, NOTIFY_COOLDOWN_SECONDS, logVisit, visitsReport
} from '../src/visits.js';
import { formatJalaliDateTime, tehranDayStartSec, tehranParts, FA_WEEKDAYS } from '../src/jalali.js';

// ---------- D1-compatible adapter over node:sqlite (same as test-api) ----------
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  run() { const info = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(info.changes ?? 0) } }; }
  first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
class MockD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new MockStmt(this.db, sql); }
}
function makeEnv() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return { DB: new MockD1(raw), BOT_TOKEN: '' };
}

const user = {
  id: 1, username: 'ali', role: 'resident', full_name: 'علی رضایی',
  unit_id: null, telegram_user_id: null, telegram_username: ''
};

// ---------- 1) cooldown helper ----------
{
  assert.equal(withinCooldown(0, 1000, OPEN_DEDUP_SECONDS), false, 'no previous visit → no cooldown');
  assert.equal(withinCooldown(999, 1000, OPEN_DEDUP_SECONDS), true, '1s ago → inside cooldown');
  assert.equal(withinCooldown(1000, 1000 + OPEN_DEDUP_SECONDS + 1, OPEN_DEDUP_SECONDS), false, 'past cooldown');
  assert.equal(withinCooldown(undefined, 1000, 60), false);
}

// ---------- 2) labels & message text ----------
{
  assert.equal(visitKindLabel('open'), 'اپ را باز کرد');
  assert.equal(visitKindLabel('login'), 'وارد اپ شد (نام کاربری/رمز)');
  assert.equal(visitViaLabel('telegram'), 'داخل تلگرام');
  assert.equal(visitViaLabel('web'), 'از مرورگر');
  assert.equal(visitViaLabel('session'), '');

  const t = Math.floor(Date.now() / 1000);
  const txt = buildVisitText({ name: 'علی رضایی', unit: '5', kind: 'open', via: 'telegram', ts: t });
  assert.ok(txt.includes('👁'), 'message has the eye header');
  assert.ok(txt.includes('علی رضایی'), 'message has the name');
  assert.ok(txt.includes('واحد ۵'), 'unit rendered with Persian digits (prefix stripped)');
  assert.ok(txt.includes(visitKindLabel('open')), 'kind label included');
  assert.ok(txt.includes('داخل تلگرام'), 'via label included');
  assert.ok(txt.includes('ساعت'), 'formatted Jalali time included');

  // unit typed as «واحد 12» must not double the word
  const txt2 = buildVisitText({ name: 'x', unit: 'واحد 12', kind: 'login', via: 'web', ts: t });
  assert.ok(txt2.includes('واحد ۱۲') && !txt2.includes('واحد واحد'), 'no «واحد واحد» in the message');
}

// ---------- 3) Jalali time formatting & Tehran day start ----------
{
  const s = tehranDayStartSec();
  const p = tehranParts(s * 1000);
  assert.equal(p.hh, 0, 'day start is 00:xx in Tehran');
  assert.ok(p.mm <= 1, 'minute is 00 (or 01 for edge rounding)');
  assert.ok(s <= Math.floor(Date.now() / 1000) && Math.floor(Date.now() / 1000) - s < 86400, 'day start is within today');

  const txt = formatJalaliDateTime(Date.now());
  assert.ok(FA_WEEKDAYS.some(w => txt.includes(w)), 'weekday name present');
  assert.ok(txt.includes('ساعت'), 'time part present');
  const dateOnly = formatJalaliDateTime(Date.now(), { time: false });
  assert.ok(!dateOnly.includes('ساعت'), 'time=false omits the clock');
}

// ---------- 4) logVisit DB flow ----------
{
  const env = makeEnv();
  const t = Math.floor(Date.now() / 1000);

  // first open → logged
  const r1 = await logVisit(env, user, 'open', 'telegram');
  assert.equal(r1.logged, true, 'first open is logged');
  // immediate second open → deduped
  const r2 = await logVisit(env, user, 'open', 'telegram');
  assert.equal(r2.logged, false, 'second open within 5 min is deduped');
  assert.equal(r2.reason, 'dedup');
  // login always logs (even inside the open-dedup window)
  const r3 = await logVisit(env, user, 'login', 'web');
  assert.equal(r3.logged, true, 'login is always logged');
  // a third open after a login: last row is the login (fresh) → still deduped for 'open'
  const r4 = await logVisit(env, user, 'open', 'telegram');
  assert.equal(r4.logged, false, 'open right after a login is deduped too');

  const rep = await visitsReport(env);
  assert.equal(rep.visits.length, 2, 'two rows stored (open + login)');
  assert.equal(rep.visits[0].kind, 'login', 'newest row first (id DESC)');
  assert.equal(rep.visits[1].kind, 'open', 'older row second');
  assert.equal(rep.visits[0].user_id, user.id, 'rows belong to the visitor');
  assert.equal(rep.stats.today, 2, 'both rows are today');
  assert.equal(rep.stats.uniq_today, 1, 'one distinct user');
  assert.ok(rep.stats.week >= 2, 'week counter covers both');

  // no bot token → notify path skipped silently (no crash), rows intact
  const r5 = await logVisit(env, { ...user, id: 2, username: 'reza' }, 'open', 'telegram');
  assert.equal(r5.logged, true, 'visit logged without bot token too');

  // notify disabled explicitly → still fine
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('visit_notify_enabled', '0')").run();
  const r6 = await logVisit(env, { ...user, id: 3, username: 'maryam' }, 'open', 'web');
  assert.equal(r6.logged, true, 'disabled notify does not break logging');

  // missing table must never break the caller (simulate by dropping it)
  env.DB.db.exec('DROP TABLE visits');
  const r7 = await logVisit(env, { ...user, id: 4 }, 'open', 'telegram');
  assert.equal(r7.logged, false, 'missing table → logged:false, no throw');
  const rep2 = await visitsReport(env);
  assert.deepEqual(rep2.visits, [], 'report on missing table → empty list, no throw');
  assert.deepEqual(rep2.stats, { today: 0, week: 0, uniq_today: 0 });
}

// ---------- 5) waitUntil-style deferred notify (ctx) ----------
{
  const env = makeEnv();
  const deferred = [];
  const ctx = { waitUntil: p => deferred.push(Promise.resolve(p)) };
  const r = await logVisit(env, { ...user, id: 9 }, 'open', 'telegram', ctx);
  assert.equal(r.logged, true, 'logged with ctx');
  assert.equal(deferred.length, 1, 'notify deferred through ctx.waitUntil');
}

// ---------- 6) v2.9.1: the visit notification goes ONLY to the app-admin ----------
{
  const env = makeEnv();
  // an admin, a manager and TWO residents, ALL telegram-linked — only the admin
  // may ever receive the visit message: not the manager, not the visitor themself,
  // not any other member (v2.9.2 double-check)
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, is_active, created_at) VALUES ('boss', 'x', 'admin', 'مدیر اپ', 111, 1, 0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, is_active, created_at) VALUES ('mgr', 'x', 'manager', 'مدیر ساختمان', 222, 1, 0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, is_active, created_at) VALUES ('member2', 'x', 'resident', 'عضو دوم', 777, 1, 0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, is_active, created_at) VALUES ('member3', 'x', 'resident', 'عضو سوم', 888, 1, 0)"
  ).run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', '123:ABC')").run();

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      sent.push({ url: String(url), body: (opts && opts.body) ? String(opts.body) : '' });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    return realFetch(url, opts);
  };
  try {
    const r = await logVisit(env, { ...user, id: 5, username: 'saeed' }, 'open', 'telegram');
    assert.equal(r.logged, true, 'resident visit logged');
    assert.equal(sent.length, 1, 'exactly ONE telegram message sent');
    assert.ok(sent[0].url.includes('/bot123:ABC/'), 'configured bot token used');
    assert.ok(sent[0].body.includes('"chat_id":111'), 'message addressed to the ADMIN chat_id only');
    assert.ok(!sent[0].body.includes('222'), 'manager chat_id NEVER receives the visit message');
    assert.ok(!sent[0].body.includes('777'), 'the VISITOR member (saeed, linked) never receives the message');
    assert.ok(!sent[0].body.includes('888'), 'other linked members never receive the message');
    assert.ok(sent[0].body.includes('\\u0639\\u0644\\u06cc') || sent[0].body.includes('علی'), 'message carries the visitor name');
  } finally {
    globalThis.fetch = realFetch;
  }

  // same flow with NO admin linked → zero sends (manager alone gets nothing)
  const env2 = makeEnv();
  await env2.DB.prepare(
    "INSERT INTO users (username, password_hash, role, full_name, telegram_user_id, is_active, created_at) VALUES ('mgr2', 'x', 'manager', 'مدیر ساختمان', 333, 1, 0)"
  ).run();
  await env2.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', '123:ABC')").run();
  const sent2 = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      sent2.push({ url: String(url), body: (opts && opts.body) ? String(opts.body) : '' });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    return realFetch(url, opts);
  };
  try {
    await logVisit(env2, { ...user, id: 6, username: 'kaveh' }, 'open', 'telegram');
    assert.equal(sent2.length, 0, 'no admin linked → nothing is sent (not even to the manager)');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------- 7) report filters (kind / from / to / offset) ----------
{
  const env = makeEnv();
  const t = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO visits (user_id, kind, via, created_at) VALUES (1, ?, ?, ?)')
    .bind('open', 'telegram', t).run();
  await env.DB.prepare('INSERT INTO visits (user_id, kind, via, created_at) VALUES (1, ?, ?, ?)')
    .bind('login', 'web', t - 86400).run();

  const all = await visitsReport(env);
  assert.equal(all.visits.length, 2);
  assert.equal(all.has_more, false, 'no has_more under the limit');

  const logins = await visitsReport(env, { kind: 'login' });
  assert.equal(logins.visits.length, 1, 'kind=login → one row');
  assert.equal(logins.visits[0].kind, 'login');

  // «today» must be TODAY IN TEHRAN — visitsReport interprets from/to as
  // Tehran calendar days (isoDateToTehranDayStart). Using the UTC date made
  // this check fail every night between 20:30–24:00 UTC (00:00–03:30 Tehran),
  // where the UTC date is still "yesterday" and the 24h-old row is (correctly)
  // included by the product filter. UTC+03:30 fixed offset (no DST in Iran).
  const tehranToday = new Date(Date.now() + 12600e3).toISOString().slice(0, 10);
  const todayOnly = await visitsReport(env, {
    from: tehranToday
  });
  assert.equal(todayOnly.visits.length, 1, 'from=today keeps only the fresh row');

  const paged = await visitsReport(env, { limit: 1 });
  assert.equal(paged.visits.length, 1, 'limit=1 → one row');
  assert.equal(paged.has_more, true, 'has_more true with more rows');

  const skipped = await visitsReport(env, { limit: 1, offset: 1 });
  assert.equal(skipped.visits.length, 1, 'offset=1 → second row');
  assert.equal(skipped.has_more, false, 'offset exhausted → no has_more');
}

console.log('test-visits: ALL PASSED ✓ (' +
  `cooldown=${OPEN_DEDUP_SECONDS}s notify_cooldown=${NOTIFY_COOLDOWN_SECONDS}s)`);
