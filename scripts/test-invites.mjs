// تست لینک دعوت واحد (v2.9.0) — ساخت/نمایش/باطل‌کردن لینک از API + جریان کامل
// وب‌هوک «/start <token>»: اتصال حساب موجود بدون اتصال، ساخت حساب تازه، استفاده
// مجدد، انقضا، توکن ناشناس. روی D1-mock (node:sqlite) با اسکیمای کامل.
import assert from 'node:assert/strict';
import fs from 'node:fs';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {
  console.log('test-invites: node:sqlite unavailable — SKIPPED');
  process.exit(0);
}

// ---------- stub شبکه تلگرام: getMe/sendMessage بدون اینترنت ----------
const sentMessages = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/getMe')) {
    return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'TestBuildingBot', first_name: 'Test' } }), { status: 200 });
  }
  if (u.includes('/sendMessage')) {
    const body = JSON.parse(init.body || '{}');
    sentMessages.push({ chat_id: body.chat_id, text: body.text, markup: body.reply_markup || null });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: false, description: 'unexpected ' + u }), { status: 404 });
};

// ---------- D1-compatible adapter ----------
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
  return {
    DB: new MockD1(raw),
    raw,
    BOT_TOKEN: '123456789:TEST_FAKE_TOKEN_xxxxxxxxxxxx',
    ASSETS: { fetch: async () => new Response('x') }
  };
}

const { handleApi } = await import('../src/api.js');
const worker = (await import('../src/worker.js')).default;
const { resetBotUsernameCache } = await import('../src/invites.js');

const req = (path, { method = 'GET', body, token } = {}) =>
  new Request('http://localhost/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
const j = async r => { const s = r.status; let d = null; try { d = await r.json(); } catch { /* no body */ } return { s, d }; };

// ---------- راه‌اندازی: نصب + مدیر ساختمان + دو واحد ----------
const env = makeEnv();
const inst = await j(await handleApi(req('/install', { method: 'POST', body: { building_name: 'برج دعوت', username: 'admin', password: 'admin123' } }), env));
assert.equal(inst.s, 201);
const adminToken = inst.d.token;

const mg = await j(await handleApi(req('/a/users', { method: 'POST', token: adminToken, body: { username: 'hossein', password: 'pass123', role: 'manager', full_name: 'حسین مدی' } }), env));
assert.equal(mg.s, 201, 'manager created: ' + JSON.stringify(mg.d));
const mgLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'hossein', password: 'pass123' } }), env));
assert.equal(mgLogin.s, 200, 'manager login');
const managerToken = mgLogin.d.token;

const u1 = await j(await handleApi(req('/units', { method: 'POST', token: managerToken, body: { number: '5', resident_name: 'علی رضایی', phone: '09121110001', area_m2: 85 } }), env));
assert.equal(u1.s, 201);
const unit5 = u1.d.unit;
const u2 = await j(await handleApi(req('/units', { method: 'POST', token: managerToken, body: { number: '7', resident_name: 'مریم احمدی' } }), env));
assert.equal(u2.s, 201);
const unit7 = u2.d.unit;

// حساب ساکن برای واحد ۵ (بدون اتصال تلگرام) — واحد ۷ بدون حساب
const res1 = await j(await handleApi(req('/residents', { method: 'POST', token: managerToken, body: { username: 'unit5', password: '123456', unit_id: unit5.id, full_name: 'علی رضایی' } }), env));
assert.equal(res1.s, 201, 'resident account for unit5');

// ---------- ۱) ساخت لینک دعوت ----------
resetBotUsernameCache();
const c1 = await j(await handleApi(req('/units/' + unit5.id + '/invite', { method: 'POST', token: managerToken, body: { days: 7 } }), env));
assert.equal(c1.s, 201, 'invite created: ' + JSON.stringify(c1.d));
assert.ok(c1.d.invite.token, 'token exists');
assert.match(c1.d.invite.token, /^[a-z0-9]{24}$/i, 'token shape (24 hex)');
assert.equal(c1.d.invite.url, 'https://t.me/TestBuildingBot?start=' + c1.d.invite.token, 'deep-link shape');
assert.equal(c1.d.invite.days, 7);

// مهلت نامعتبر → پیش‌فرض ۷ روز
const c2 = await j(await handleApi(req('/units/' + unit5.id + '/invite', { method: 'POST', token: managerToken, body: { days: 999 } }), env));
assert.equal(c2.d.invite.days, 7, 'invalid days → default 7');
assert.notEqual(c2.d.invite.token, c1.d.invite.token, 'new token on renewal');

// ---------- ۲) GET لینک فعال ----------
const g1 = await j(await handleApi(req('/units/' + unit5.id + '/invite', { token: managerToken }), env));
assert.equal(g1.s, 200);
assert.equal(g1.d.invite.token, c2.d.invite.token, 'active invite returned');

// ---------- ۳) دسترسی‌ها ----------
const gNo = await j(await handleApi(req('/units/' + unit5.id + '/invite'), env));
assert.equal(gNo.s, 401, 'no auth → 401');
const gRes = await j(await handleApi(req('/units/' + unit5.id + '/invite', { token: (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit5', password: '123456' } }), env))).d.token }), env));
assert.equal(gRes.s, 403, 'resident → 403');

// ---------- ۴) وب‌هوک: /start با توکن → اتصال حساب موجود (واحد ۵) ----------
sentMessages.length = 0;
const startWith = (chatId, tgId, text, username) => worker.fetch(new Request('https://app.example.com/webhook/telegram', {
  method: 'POST', body: JSON.stringify({ message: { chat: { id: chatId, type: 'private' }, from: { id: tgId, username, first_name: 'ساکن', last_name: 'تازه' }, text } }), headers: { 'content-type': 'application/json' }
}), env);

let wh = await startWith(9001, 777001, '/start ' + c2.d.invite.token, 'ali_rezaei');
assert.equal(await wh.text(), 'ok');
let row = env.raw.prepare('SELECT telegram_user_id, telegram_username FROM users WHERE username = \'unit5\'').get();
assert.equal(Number(row.telegram_user_id), 777001, 'existing account bound to chat id');
assert.equal(row.telegram_username, 'ali_rezaei', 'canonical tg username stored');
const usedInv = env.raw.prepare('SELECT used_at, used_by FROM unit_invites WHERE token = ?').get(c2.d.invite.token);
assert.ok(usedInv.used_at, 'invite marked used');
assert.equal(Number(usedInv.used_by), 777001, 'used_by = telegram id');
assert.ok(sentMessages.some(m => m.chat_id === 9001 && /اتصال انجام شد/.test(m.text) && /واحد 5/.test(m.text)), 'success message with unit number sent');
assert.ok(sentMessages.some(m => m.markup && m.markup.inline_keyboard && m.markup.inline_keyboard[0][0].web_app), 'app button present');

// ---------- ۵) استفاده دوباره از همان لینک → پیام «قبلاً استفاده شده» ----------
sentMessages.length = 0;
wh = await startWith(9002, 777002, '/start ' + c2.d.invite.token, 'someone_else');
assert.equal(await wh.text(), 'ok');
assert.ok(sentMessages.some(m => /قبلاً استفاده شده/.test(m.text)), 'used-invite message');
const dup = env.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_user_id = 777002').get();
assert.equal(Number(dup.n), 0, 'no account created for second user');

// ---------- ۶) توکن ناشناس → رفتار عادی /start (کارت اپ) ----------
sentMessages.length = 0;
wh = await startWith(9003, 777003, '/start aabbccddeeff112233445566', 'unknown_guy');
assert.equal(await wh.text(), 'ok');
assert.ok(sentMessages.some(m => /باز کردن اپ ساختمان/.test(m.text) && !/دعوت|لینک/.test(m.text)), 'fallback to normal /start card');
assert.equal(Number(env.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_user_id = 777003').get().n), 0, 'unknown token creates nothing');

// ---------- ۷) /start با توکن منقضی ----------
const expTok = 'expired0011223344556677a';
env.raw.prepare("INSERT INTO unit_invites (token, unit_id, created_by, created_at, expires_at) VALUES (?, ?, NULL, 0, 1)").run(expTok, unit7.id);
sentMessages.length = 0;
wh = await startWith(9004, 777004, '/start ' + expTok, 'late_guy');
assert.equal(await wh.text(), 'ok');
assert.ok(sentMessages.some(m => /مهلت این لینک/.test(m.text)), 'expired message');
assert.equal(Number(env.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_user_id = 777004').get().n), 0, 'expired → no account');

// ---------- ۸) /start با لینک معتبر واحد بدون حساب → ساخت خودکار حساب ----------
const c7 = await j(await handleApi(req('/units/' + unit7.id + '/invite', { method: 'POST', token: managerToken, body: { days: 1 } }), env));
assert.equal(c7.s, 201);
sentMessages.length = 0;
wh = await startWith(9005, 777005, '/start ' + c7.d.invite.token, 'maryam_a');
assert.equal(await wh.text(), 'ok');
row = env.raw.prepare("SELECT * FROM users WHERE telegram_user_id = 777005").get();
assert.ok(row, 'auto-created account');
assert.equal(row.role, 'resident', 'role resident');
assert.equal(Number(row.unit_id), unit7.id, 'bound to unit7');
assert.equal(row.username, 'unit7', 'auto username unit<number>');
assert.ok(row.password_hash.startsWith('pbkdf2$'), 'random password hashed');
assert.ok(/خوش آمدید/.test((sentMessages.find(m => m.chat_id === 9005) || {}).text || ''), 'welcome message');
assert.ok(/حساب شما ساخته شد/.test((sentMessages.find(m => m.chat_id === 9005) || {}).text || ''), 'created message mentions account');

// ساکن تازه می‌تواند وارد شود و فقط واحد خودش را می‌بیند
const newTok = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit7', password: row.password_hash.slice(0, 0) + 'x' } }), env)));
assert.equal(newTok.s, 401, 'random password not guessable');

// ---------- ۹) باطل‌کردن لینکِ در انتظار استفاده ----------
const c7b = await j(await handleApi(req('/units/' + unit7.id + '/invite', { method: 'POST', token: managerToken, body: { days: 7 } }), env));
assert.equal(c7b.s, 201);
const d1 = await j(await handleApi(req('/units/' + unit7.id + '/invite', { method: 'DELETE', token: managerToken }), env));
assert.equal(d1.s, 200);
sentMessages.length = 0;
wh = await startWith(9006, 777006, '/start ' + c7b.d.invite.token, 'revoke_check');
assert.equal(await wh.text(), 'ok');
assert.ok(sentMessages.some(m => /باطل شده/.test(m.text)), 'revoked message');
assert.equal(Number(env.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE telegram_user_id = 777006').get().n), 0, 'revoked → no account');

// ---------- ۱۰) حذف واحد → دعوت‌ها هم حذف ----------
const u3 = await j(await handleApi(req('/units', { method: 'POST', token: managerToken, body: { number: '9' } }), env));
await handleApi(req('/units/' + u3.d.unit.id + '/invite', { method: 'POST', token: managerToken, body: {} }), env);
await handleApi(req('/units/' + u3.d.unit.id, { method: 'DELETE', token: managerToken, body: {} }), env);
const left = env.raw.prepare('SELECT COUNT(*) AS n FROM unit_invites WHERE unit_id = ?').get(u3.d.unit.id);
assert.equal(Number(left.n), 0, 'invites cascade-deleted with unit');

console.log('✔ test-invites: all passed');
restoreFetch();
function restoreFetch() { globalThis.fetch = realFetch; }
