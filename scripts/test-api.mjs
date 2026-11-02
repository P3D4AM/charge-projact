// Functional test of the full API surface with a D1-compatible mock (node:sqlite).
// Covers: install → login → RBAC (admin/manager/resident) → units → residents
// accounts → charges → payments → expenses → reports → PDF endpoints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { handleApi } from '../src/api.js';
import { currentPeriod, periodLabel } from '../src/jalali.js';
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken } from '../src/auth.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('test-api: node:sqlite unavailable — SKIPPED');
  process.exit(0);
}

// ---------- D1-compatible adapter over node:sqlite ----------
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: { last_row_id: Number(info.lastInsertRowid ?? 0), changes: Number(info.changes ?? 0) }
    };
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
  const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  raw.exec(schema);
  const fontsDir = new URL('../public/fonts/', import.meta.url);
  return {
    DB: new MockD1(raw),
    BOT_TOKEN: '',
    INITDATA_MAX_AGE: '86400',
    ASSETS: {
      fetch: async p => {
        const f = String(p).replace(/^\//, '').replace(/\?.*$/, '');
        try {
          return new Response(fs.readFileSync(new URL('../public/' + f, import.meta.url)));
        } catch {
          return new Response('not found', { status: 404 });
        }
      }
    }
  };
}

const req = (path, { method = 'GET', body, token } = {}) =>
  new Request('http://localhost/api' + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
const j = async r => { const s = r.status; let d = null; try { d = await r.json(); } catch { /* no body */ } return { s, d }; };

const isPeriodFmt = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// ---------- 1) health & install status ----------
{
  const env = makeEnv();
  const { s, d } = await j(await handleApi(req('/health'), env));
  assert.equal(s, 200); assert.equal(d.ok, true);

  const st = await j(await handleApi(req('/install-status'), env));
  assert.equal(st.d.installed, false, 'not installed yet');
}

// ---------- 2) install flow ----------
const env = makeEnv();
let adminToken, managerToken, residentToken;
{
  const bad = await j(await handleApi(req('/install', { method: 'POST', body: { building_name: 'برج تست', username: 'x', password: '123456' } }), env));
  assert.equal(bad.s, 400, 'short username rejected');

  const { s, d } = await j(await handleApi(req('/install', {
    method: 'POST',
    body: { building_name: 'برج تست', username: 'Admin', password: 'admin123', address: 'تهران' }
  }), env));
  assert.equal(s, 201, 'install ok');
  assert.equal(d.user.role, 'admin');
  assert.ok(d.token);
  adminToken = d.token;

  const again = await j(await handleApi(req('/install', { method: 'POST', body: { building_name: 'x', username: 'y', password: 'zzzzzz' } }), env));
  assert.equal(again.s, 409, 'second install rejected');

  const st = await j(await handleApi(req('/install-status'), env));
  assert.equal(st.d.installed, true);
}

// ---------- 3) login + wrong password ----------
{
  const bad = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } }), env));
  assert.equal(bad.s, 401);

  const ok = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'ADMIN', password: 'admin123' } }), env));
  assert.equal(ok.s, 200, 'login case-insensitive username');
  assert.equal(ok.d.user.role, 'admin');

  const me = await j(await handleApi(req('/auth/me', { token: adminToken }), env));
  assert.equal(me.s, 200);
  assert.equal(me.d.settings.building_name, 'برج تست');
  assert.ok(isPeriodFmt(me.d.current_period));
}

// ---------- 4) admin creates manager; RBAC ----------
{
  const { s, d } = await j(await handleApi(req('/a/managers', {
    method: 'POST',
    body: { username: 'manager1', password: 'manager123', full_name: 'حسین مدیر', phone: '09120000000' },
    token: adminToken
  }), env));
  assert.equal(s, 201, 'manager created');
  assert.equal(d.manager.role, 'manager');

  const login = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'manager1', password: 'manager123' } }), env));
  assert.equal(login.s, 200);
  managerToken = login.d.token;

  // manager cannot access admin routes
  const forbidden = await j(await handleApi(req('/a/overview', { token: managerToken }), env));
  assert.equal(forbidden.s, 403, 'manager blocked from /a/*');

  // manager CAN access the (now manager-only) dashboard
  const dash = await j(await handleApi(req('/dashboard', { token: managerToken }), env));
  assert.equal(dash.s, 200);

  // app-admin must NOT see residents' total debt (manager-only policy)
  const dashAdmin = await j(await handleApi(req('/dashboard', { token: adminToken }), env));
  assert.equal(dashAdmin.s, 403, 'admin blocked from residents-debt dashboard');

  // resident token does not exist yet; manager cannot create managers
  const noManager = await j(await handleApi(req('/a/managers', { method: 'POST', body: {} }), env));
  assert.equal(noManager.s, 401, 'anonymous blocked');

  // toggle manager inactive → access lost
  const mgrId = login.d.user.id;
  const off = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { is_active: false }, token: adminToken }), env));
  assert.equal(off.s, 200);
  const blocked = await j(await handleApi(req('/dashboard', { token: managerToken }), env));
  assert.equal(blocked.s, 401, 'deactivated manager locked out');
  const on = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { is_active: true }, token: adminToken }), env));
  assert.equal(on.s, 200);
  const unblocked = await j(await handleApi(req('/dashboard', { token: managerToken }), env));
  assert.equal(unblocked.s, 200, 'reactivated manager back in');

  // reset manager password
  const rp = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { password: 'newpass99' }, token: adminToken }), env));
  assert.equal(rp.s, 200);
  const relogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'manager1', password: 'newpass99' } }), env));
  assert.equal(relogin.s, 200);
  managerToken = relogin.d.token;

  // --- username change (v2.11.0): admin edits manager's login username ---
  const ren = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { username: 'manager1x' }, token: adminToken }), env));
  assert.equal(ren.s, 200, 'username changed by admin');
  assert.equal(ren.d.user.username, 'manager1x');
  const oldLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'manager1', password: 'newpass99' } }), env));
  assert.equal(oldLogin.s, 401, 'old username no longer logs in');
  const newLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'manager1x', password: 'newpass99' } }), env));
  assert.equal(newLogin.s, 200, 'new username logs in');
  managerToken = newLogin.d.token;
  // invalid + duplicate usernames rejected (no state change)
  const badU = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { username: 'ab' }, token: adminToken }), env));
  assert.equal(badU.s, 400, 'too-short username rejected');
  const meAdmin = await j(await handleApi(req('/auth/me', { token: adminToken }), env));
  const adminId = meAdmin.d.user.id;
  const dupU = await j(await handleApi(req(`/a/users/${adminId}`, { method: 'PUT', body: { username: 'manager1x' }, token: adminToken }), env));
  assert.equal(dupU.s, 409, 'duplicate username rejected');
  // rename back so later sections keep using manager1
  const renBack = await j(await handleApi(req(`/a/users/${mgrId}`, { method: 'PUT', body: { username: 'manager1' }, token: adminToken }), env));
  assert.equal(renBack.s, 200, 'username restored');
}

// ---------- 5) units + resident accounts ----------
let unit5;
{
  for (const [n, name, area] of [['1', 'علی رضایی', 85], ['2', 'مریم احمدی', 110], ['5', 'رضا محمدی', 75]]) {
    const { s, d } = await j(await handleApi(req('/units', {
      method: 'POST',
      body: { number: n, resident_name: name, area_m2: area, residents_count: 2, phone: '09121110' + n.padStart(3, '0') },
      token: managerToken
    }), env));
    assert.equal(s, 201, 'unit created ' + n);
    if (n === '5') unit5 = d.unit;
  }
  const dup = await j(await handleApi(req('/units', { method: 'POST', body: { number: '1' }, token: managerToken }), env));
  assert.equal(dup.s, 409, 'duplicate unit rejected');

  // resident account for unit 5
  const acc = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'reza5', password: 'reza1234', unit_id: unit5.id, full_name: 'رضا محمدی' },
    token: managerToken
  }), env));
  assert.equal(acc.s, 201, 'resident account created');
  assert.equal(acc.d.resident.role, 'resident');

  // second account for same unit rejected
  const acc2 = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'other5', password: 'reza1234', unit_id: unit5.id },
    token: managerToken
  }), env));
  assert.equal(acc2.s, 409, 'one account per unit enforced');

  // duplicate username rejected
  const acc3 = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'reza5', password: 'reza1234', unit_id: unit5.id },
    token: managerToken
  }), env));
  assert.equal(acc3.s, 409);

  const rlogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'reza5', password: 'reza1234' } }), env));
  assert.equal(rlogin.s, 200);
  residentToken = rlogin.d.token;
  assert.equal(rlogin.d.user.unit_id, unit5.id);

  // resident cannot access manager routes
  const rb = await j(await handleApi(req('/units', { token: residentToken }), env));
  assert.equal(rb.s, 403, 'resident blocked from manager routes');
  const rb2 = await j(await handleApi(req('/a/overview', { token: residentToken }), env));
  assert.equal(rb2.s, 403, 'resident blocked from admin routes');

  // admin sees users list
  const users = await j(await handleApi(req('/a/users', { token: adminToken }), env));
  assert.ok(users.d.users.length >= 3, 'admin sees all users');
}

// ---------- 6) charges + payments ----------
const period = currentPeriod();
{
  const gen = await j(await handleApi(req('/charges/generate', {
    method: 'POST', body: { period, mode: 'fixed', amount: 500000 }, token: managerToken
  }), env));
  assert.equal(gen.d.created, 3, '3 debts created');

  const regen = await j(await handleApi(req('/charges/generate', {
    method: 'POST', body: { period, mode: 'fixed', amount: 500000 }, token: managerToken
  }), env));
  assert.equal(regen.d.created, 0, 'no duplicates on regen');
  assert.equal(regen.d.skipped, 3);

  const debts = await j(await handleApi(req('/debts?period=' + period, { token: managerToken }), env));
  assert.equal(debts.d.debts.length, 3);
  assert.ok(debts.d.debts[0].description.includes(periodLabel(period).slice(0, 5)), 'description has month name');

  const p1 = await j(await handleApi(req('/debts/1/pay', { method: 'POST', body: { amount: 200000, method: 'نقدی' }, token: managerToken }), env));
  assert.equal(p1.d.debt.status, 'partial');
  assert.equal(p1.d.debt.paid_amount, 200000);

  const p2 = await j(await handleApi(req('/debts/1/pay', { method: 'POST', body: { method: 'نقدی' }, token: managerToken }), env));
  assert.equal(p2.d.debt.status, 'paid');

  // v2.12.0 — ویرایش پرداختِ ثبت‌شده بدون لغو: مبلغ/روش/تاریخ/یادداشت
  const pe = await j(await handleApi(req('/debts/1/pay-edit', {
    method: 'POST',
    body: { amount: 350000, method: 'کارت به کارت', note: 'اصلاح مبلغ — چک ۱۲۳', date: 1700000000 },
    token: managerToken
  }), env));
  assert.equal(pe.s, 200, 'pay-edit works');
  assert.equal(pe.d.debt.paid_amount, 350000, 'pay-edit replaced the paid amount');
  assert.equal(pe.d.debt.status, 'partial', 'status recomputed after edit');
  assert.equal(pe.d.debt.method, 'کارت به کارت', 'method edited');
  assert.equal(pe.d.debt.note, 'اصلاح مبلغ — چک ۱۲۳', 'note replaced (not appended)');
  assert.equal(pe.d.debt.paid_at, 1700000000, 'payment date edited');

  const peOver = await j(await handleApi(req('/debts/1/pay-edit', {
    method: 'POST', body: { amount: 999999999 }, token: managerToken
  }), env));
  assert.equal(peOver.s, 400, 'pay-edit rejects amount above the total');

  const peClear = await j(await handleApi(req('/debts/1/pay-edit', {
    method: 'POST', body: { amount: 350000, note: '' }, token: managerToken
  }), env));
  assert.equal(peClear.d.debt.note, '', 'empty note clears the note');

  const peResident = await j(await handleApi(req('/debts/1/pay-edit', {
    method: 'POST', body: { amount: 100 }, token: residentToken
  }), env));
  assert.equal(peResident.s, 403, 'resident blocked from pay-edit');

  const unpay = await j(await handleApi(req('/debts/1/unpay', { method: 'POST', body: {}, token: managerToken }), env));
  assert.equal(unpay.d.debt.status, 'unpaid');

  const custom = await j(await handleApi(req('/debts', {
    method: 'POST', body: { unit_id: unit5.id, period, description: 'شارژ پارکینگ', amount: 50000 }, token: managerToken
  }), env));
  assert.equal(custom.s, 201);
}

// ---------- 7) expenses ----------
{
  const exp = await j(await handleApi(req('/expenses', {
    method: 'POST',
    body: { title: 'قبض برق مشترک', category: 'برق', amount: 900000, period, split_mode: 'area' },
    token: managerToken
  }), env));
  assert.equal(exp.s, 201, 'expense created');
  assert.equal(exp.d.share_count, 3);

  const list = await j(await handleApi(req('/expenses?period=' + period, { token: managerToken }), env));
  assert.equal(list.d.expenses.length, 1);
}

// ---------- 8) resident self-service ----------
{
  const sum = await j(await handleApi(req('/my/summary', { token: residentToken }), env));
  assert.equal(sum.s, 200);
  assert.equal(sum.d.unit.number, '5');
  assert.ok(sum.d.debts.length >= 2, 'resident sees own debts');
  assert.ok(sum.d.totals.issued > 0);

  // resident PDF statement
  const pdf = await handleApi(req('/pdf/statement', { token: residentToken }), env);
  assert.equal(pdf.status, 200);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.ok(buf.length > 3000, 'statement PDF has content');
  assert.equal(buf.slice(0, 4).toString(), '%PDF');

  // resident cannot fetch another unit's statement
  const pdfOther = await j(await handleApi(req('/pdf/statement?unit_id=1', { token: residentToken }), env));
  assert.equal(pdfOther.s, 200, 'resident forced to own unit anyway');

  // resident change password
  const cp = await j(await handleApi(req('/auth/change-password', {
    method: 'POST', body: { old_password: 'reza1234', new_password: 'reza4321' }, token: residentToken
  }), env));
  assert.equal(cp.s, 200);
  const relogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'reza5', password: 'reza4321' } }), env));
  assert.equal(relogin.s, 200);
  residentToken = relogin.d.token;

  // --- manager edits resident's username (v2.11.0) ---
  const rid = relogin.d.user.id;
  const mren = await j(await handleApi(req(`/residents/${rid}`, { method: 'PUT', body: { username: 'reza5x' }, token: managerToken }), env));
  assert.equal(mren.s, 200, 'manager changed resident username');
  assert.equal(mren.d.resident.username, 'reza5x');
  const resOld = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'reza5', password: 'reza4321' } }), env));
  assert.equal(resOld.s, 401, 'old resident username rejected');
  const mrenBack = await j(await handleApi(req(`/residents/${rid}`, { method: 'PUT', body: { username: 'reza5' }, token: managerToken }), env));
  assert.equal(mrenBack.s, 200, 'resident username restored');
}

// ---------- 9) manager-only yearly report + year PDF ----------
{
  const year = await j(await handleApi(req('/reports/year', { token: managerToken }), env));
  assert.equal(year.s, 200);
  assert.ok(year.d.by_unit.length === 3);

  const yearAdmin = await j(await handleApi(req('/reports/year', { token: adminToken }), env));
  assert.equal(yearAdmin.s, 403, 'admin blocked from residents finance report');

  const yearRes = await j(await handleApi(req('/reports/year', { token: residentToken }), env));
  assert.equal(yearRes.s, 403, 'resident blocked from building-wide report');

  const pdfRes = await handleApi(req('/pdf/report', { token: managerToken }), env);
  assert.equal(pdfRes.status, 200);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(buf.length > 3000, 'report PDF has content');

  const pdfAdmin = await j(await handleApi(req('/pdf/report', { token: adminToken }), env));
  assert.equal(pdfAdmin.s, 403, 'admin blocked from report PDF');
}

// ---------- 9b) v2.12.0: monthly all-units report (گزارش ماهیانه) + PDF ----------
{
  // a partial payment with a note → must reach the monthly report
  const debtsNow = await j(await handleApi(req('/debts?period=' + period, { token: managerToken }), env));
  const d2 = debtsNow.d.debts.find(x => x.id === 2);
  assert.ok(d2, 'debt 2 exists');
  const payNote = await j(await handleApi(req('/debts/2/pay', {
    method: 'POST', body: { amount: 100000, note: 'پرداخت نیمه — تست یادداشت ماهانه' }, token: managerToken
  }), env));
  assert.equal(payNote.s, 200);

  const mon = await j(await handleApi(req('/reports/month?period=' + period, { token: managerToken }), env));
  assert.equal(mon.s, 200);
  assert.ok(Array.isArray(mon.d.by_unit) && mon.d.by_unit.length === 3, 'monthly report lists ALL units');
  assert.ok(mon.d.by_unit.every(u => Array.isArray(u.notes)), 'each unit row has a notes array');
  assert.ok(mon.d.by_unit.some(u => u.items > 0), 'at least one unit has items this month');
  const sumIssued = mon.d.by_unit.reduce((s, u) => s + u.issued, 0);
  assert.equal(sumIssued, mon.d.totals.issued, 'per-unit sums match the month total');
  const rowU = mon.d.by_unit.find(u => u.id === d2.unit_id);
  assert.ok(rowU.notes.some(n => n.note.includes('تست یادداشت ماهانه')), 'payment note reaches the monthly report');

  const monAdmin = await j(await handleApi(req('/reports/month', { token: adminToken }), env));
  assert.equal(monAdmin.s, 403, 'admin blocked from monthly finance report');
  const monRes = await j(await handleApi(req('/reports/month', { token: residentToken }), env));
  assert.equal(monRes.s, 403, 'resident blocked from monthly finance report');

  const pdfM = await handleApi(req('/pdf/monthly?period=' + period, { token: managerToken }), env);
  assert.equal(pdfM.status, 200, 'monthly PDF generated');
  const bufM = Buffer.from(await pdfM.arrayBuffer());
  assert.ok(bufM.length > 3000, 'monthly PDF has content');
  assert.equal(bufM.slice(0, 4).toString(), '%PDF');

  const pdfMRes = await j(await handleApi(req('/pdf/monthly', { token: residentToken }), env));
  assert.equal(pdfMRes.s, 403, 'resident blocked from monthly PDF');

  // restore state (debt 2 back to unpaid)
  await handleApi(req('/debts/2/unpay', { method: 'POST', body: {}, token: managerToken }), env);
}

// ---------- 10) export + settings ----------
{
  const csv = await handleApi(req('/export?type=debtors', { token: managerToken }), env);
  assert.equal(csv.status, 200);
  // text() strips the BOM byte, so inspect raw bytes (per WHATWG decode semantics)
  const csvBytes = Buffer.from(await csv.arrayBuffer());
  assert.ok(csvBytes.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF])), 'CSV has UTF-8 BOM');
  const text = csvBytes.slice(3).toString('utf8');
  assert.ok(text.includes('شماره واحد'), 'CSV header in Persian');

  // v2.14.0 — export/backup now 'shared' (manager + app-admin): the admin panel
  // downloads backups directly; residents stay blocked
  const backupAdmin = await handleApi(req('/export?type=backup', { token: adminToken }), env);
  assert.equal(backupAdmin.status, 200, 'app-admin can backup (shared access)');
  const xls = await handleApi(req('/export?type=debtors&fmt=xls', { token: managerToken }), env);
  assert.equal(xls.status, 200, 'excel export ok');
  assert.ok((xls.headers.get('content-type') || '').includes('vnd.ms-excel'), 'xls content-type');
  const xlsText = await xls.text();
  assert.ok(xlsText.includes('<table dir="rtl"') && xlsText.includes('شماره واحد'), 'xls is an RTL HTML table with Persian header');
  const residentXls = await handleApi(req('/export?type=debtors&fmt=xls', { token: residentToken }), env);
  assert.equal(residentXls.status, 403, 'resident blocked from exports');
  const backup = await handleApi(req('/export?type=backup', { token: managerToken }), env);
  assert.equal(backup.status, 200, 'manager can backup');
  const backupJson = JSON.parse(await backup.text());
  assert.ok(backupJson.users.length >= 3);
  // v2.14.0 — debts carry the reminder counters in backups
  assert.ok(Array.isArray(backupJson.debts), 'backup includes debts');

  const st = await j(await handleApi(req('/a/settings', {
    method: 'POST',
    body: { building_name: 'برج نگین', bank_card: '6037997512345678', address: 'اصفهان' },
    token: adminToken
  }), env));
  assert.equal(st.s, 200);
  assert.equal(st.d.settings.building_name, 'برج نگین');

  const denied = await j(await handleApi(req('/a/settings', {
    method: 'POST', body: { building_name: 'x' }, token: managerToken
  }), env));
  assert.equal(denied.s, 403, 'manager cannot change app settings');

  // ---------- import backup round-trip (v2.11.0) ----------
  const fresh = await handleApi(req('/export?type=backup', { token: managerToken }), env);
  assert.equal(fresh.status, 200);
  const payload = JSON.parse(await fresh.text());
  assert.ok(payload.users.every(u => typeof u.password_hash === 'string' && u.password_hash.length > 10), 'backup includes password hashes');
  assert.ok(Array.isArray(payload.polls) && Array.isArray(payload.poll_votes), 'backup includes polls');

  const badTag = await j(await handleApi(req('/import', { method: 'POST', body: { ...payload, app: 'other-app' }, token: managerToken }), env));
  assert.equal(badTag.s, 400, 'foreign backup rejected');
  // v2.14.0 — import is 'shared' now so the app-admin panel can restore backups
  const admImp = await j(await handleApi(req('/import', { method: 'POST', body: { ...payload, app: 'other-app' }, token: adminToken }), env));
  assert.equal(admImp.s, 400, 'app-admin can reach import (shared) — foreign tag still rejected');

  const imp = await j(await handleApi(req('/import', { method: 'POST', body: payload, token: managerToken }), env));
  assert.equal(imp.s, 200, 'import round-trip ok');
  assert.equal(imp.d.imported.units, payload.units.length, 'units restored');
  assert.equal(imp.d.imported.debts, payload.debts.length, 'debts restored');

  // logins survive the restore (password hashes were carried in the backup)
  const resAfter = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'reza5', password: 'reza4321' } }), env));
  assert.equal(resAfter.s, 200, 'resident login survives restore');
  const mgrAfter = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'manager1', password: 'newpass99' } }), env));
  assert.equal(mgrAfter.s, 200, 'manager login survives restore');
  managerToken = mgrAfter.d.token;
  const admAfter = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } }), env));
  assert.equal(admAfter.s, 200, 'app-admin account untouched by import');
  const stAfter = await j(await handleApi(req('/a/settings', { token: adminToken }), env));
  assert.equal(stAfter.d.settings.building_name, 'برج نگین', 'settings restored from backup');
}

// ---------- 11) seed + reset (admin tools) ----------
{
  const seed = await j(await handleApi(req('/a/dev/seed', { method: 'POST', body: {}, token: adminToken }), env));
  assert.equal(seed.s, 409, 'seed blocked while units exist (needs force)');

  const seedForce = await j(await handleApi(req('/a/dev/seed', { method: 'POST', body: { force: true }, token: adminToken }), env));
  assert.equal(seedForce.s, 200, 'seed with force wipes then re-seeds');
  assert.equal(seedForce.d.units, 8);
  assert.equal(seedForce.d.accounts, 8, '8 resident accounts seeded');

  const seededLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit3', password: '1234' } }), env));
  assert.equal(seededLogin.s, 200, 'seeded resident can login');

  const reset = await j(await handleApi(req('/a/dev/reset', { method: 'POST', body: {}, token: adminToken }), env));
  assert.equal(reset.s, 200);
  const unitsAfter = await j(await handleApi(req('/units', { token: managerToken }), env));
  assert.equal(unitsAfter.d.units.length, 0, 'units wiped');
  const usersAfter = await j(await handleApi(req('/a/users?role=resident', { token: adminToken }), env));
  assert.equal(usersAfter.d.users.length, 0, 'resident accounts wiped');
}

// ---------- 12) auth module unit checks ----------
{
  const h = await hashPassword('test123');
  assert.ok(h.startsWith('pbkdf2$'));
  assert.ok(await verifyPassword('test123', h));
  assert.ok(!(await verifyPassword('test124', h)));

  const t = await createSessionToken(env, 42, 'manager');
  const p = await verifySessionToken(env, t);
  assert.equal(p.uid, 42);
  assert.equal(p.role, 'manager');
  const bad = await verifySessionToken(env, t.slice(0, -2) + 'xx');
  assert.equal(bad, null, 'tampered token rejected');
}

// ---------- 13) polls (نظرسنجی) + manager own-unit ----------
{
  // fresh unit + resident account (units were wiped in section 11)
  const unit = await j(await handleApi(req('/units', { method: 'POST', body: { number: '101', resident_name: 'ساکن تست', area_m2: 90, residents_count: 2 }, token: managerToken }), env));
  assert.equal(unit.s, 201, 'unit created for poll tests');
  const unitId = unit.d.unit.id;

  const acc = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'pollresident', password: 'test1234', unit_id: unitId, full_name: 'ساکن نظرسنجی' },
    token: managerToken
  }), env));
  assert.equal(acc.s, 201, 'resident account created');
  const rlogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'pollresident', password: 'test1234' } }), env));
  assert.equal(rlogin.s, 200);
  const rToken = rlogin.d.token;

  // resident sees only their own unit via /my/summary
  const mySum = await j(await handleApi(req('/my/summary', { token: rToken }), env));
  assert.equal(mySum.s, 200);
  assert.equal(mySum.d.unit.id, unitId);

  // manager without unit → /my/summary 403, then self-link via /my/unit
  const mgrNoUnit = await j(await handleApi(req('/my/summary', { token: managerToken }), env));
  assert.equal(mgrNoUnit.s, 403, 'manager without unit has no own-unit view');
  const link = await j(await handleApi(req('/my/unit', { method: 'POST', body: { unit_id: unitId }, token: managerToken }), env));
  assert.equal(link.s, 200);
  const mgrWithUnit = await j(await handleApi(req('/my/summary', { token: managerToken }), env));
  assert.equal(mgrWithUnit.s, 200, 'manager sees own unit after linking');
  const unlink = await j(await handleApi(req('/my/unit', { method: 'POST', body: { unit_id: null }, token: managerToken }), env));
  assert.equal(unlink.s, 200, 'manager can unlink own unit');

  // create poll (manager only)
  const noAcc = await j(await handleApi(req('/polls', { method: 'POST', body: { question: 'x', options: ['a', 'b'] }, token: rToken }), env));
  assert.equal(noAcc.s, 403, 'resident cannot create poll');
  const badPoll = await j(await handleApi(req('/polls', { method: 'POST', body: { question: 'سؤال؟', options: ['فقط یکی'] }, token: managerToken }), env));
  assert.equal(badPoll.s, 400, 'poll needs two options');
  const created = await j(await handleApi(req('/polls', {
    method: 'POST',
    body: { question: 'رنگ راه‌پله؟', options: ['کرم', 'خاکستری'] },
    token: managerToken
  }), env));
  assert.equal(created.s, 201, 'poll created');
  const pollId = created.d.poll.id;

  // admin cannot vote (no unit) but can view
  const adminList = await j(await handleApi(req('/polls', { token: adminToken }), env));
  assert.equal(adminList.s, 200, 'admin can list polls');
  const adminVote = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 0 }, token: adminToken }), env));
  assert.equal(adminVote.s, 403, 'admin without unit cannot vote');

  // resident votes
  const v1 = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 1 }, token: rToken }), env));
  assert.equal(v1.s, 200);
  let list = await j(await handleApi(req('/polls', { token: rToken }), env));
  let p = list.d.polls.find(x => x.id === pollId);
  assert.equal(p.total_votes, 1);
  assert.equal(p.counts[1], 1);
  assert.equal(p.my_vote, 1, 'my_vote returned to resident');

  // change vote (upsert, still one vote per unit)
  const v2 = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 0 }, token: rToken }), env));
  assert.equal(v2.s, 200);
  list = await j(await handleApi(req('/polls', { token: rToken }), env));
  p = list.d.polls.find(x => x.id === pollId);
  assert.equal(p.total_votes, 1, 'still one vote per unit');
  assert.equal(p.counts[0], 1);
  assert.equal(p.counts[1], 0);

  // invalid option index rejected
  const badIdx = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 9 }, token: rToken }), env));
  assert.equal(badIdx.s, 400);

  // resident cannot close; manager closes; vote on closed poll rejected
  const rClose = await j(await handleApi(req(`/polls/${pollId}/close`, { method: 'POST', body: {}, token: rToken }), env));
  assert.equal(rClose.s, 403);
  const close = await j(await handleApi(req(`/polls/${pollId}/close`, { method: 'POST', body: {}, token: managerToken }), env));
  assert.equal(close.s, 200);
  const closedVote = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 0 }, token: rToken }), env));
  assert.equal(closedVote.s, 409, 'voting on closed poll rejected');
  const reopen = await j(await handleApi(req(`/polls/${pollId}/reopen`, { method: 'POST', body: {}, token: managerToken }), env));
  assert.equal(reopen.s, 200);
  const revote = await j(await handleApi(req(`/polls/${pollId}/vote`, { method: 'POST', body: { option_index: 1 }, token: rToken }), env));
  assert.equal(revote.s, 200, 'vote works again after reopen');

  // delete poll
  const del = await j(await handleApi(req(`/polls/${pollId}`, { method: 'DELETE', body: {}, token: managerToken }), env));
  assert.equal(del.s, 200);
  list = await j(await handleApi(req('/polls', { token: managerToken }), env));
  assert.equal(list.d.polls.find(x => x.id === pollId), undefined, 'poll deleted');

  // reminder preview endpoint works for manager
  const pv = await j(await handleApi(req('/notify/preview', { token: managerToken }), env));
  assert.equal(pv.s, 200);
  assert.equal(pv.d.bot_configured, false, 'no BOT_TOKEN in test env');
  assert.equal(typeof pv.d.debtor_units, 'number');
  const rPv = await j(await handleApi(req('/notify/preview', { token: rToken }), env));
  assert.equal(rPv.s, 403, 'resident cannot access reminder preview');

  // admin: GET /a/units + unit assignment on users
  const aUnits = await j(await handleApi(req('/a/units', { token: adminToken }), env));
  assert.equal(aUnits.s, 200, 'admin units list works');
  const setUnit = await j(await handleApi(req(`/a/users/${rlogin.d.user.id}`, { method: 'PUT', body: { unit_id: unitId }, token: adminToken }), env));
  assert.equal(setUnit.s, 200, 'admin can set user unit');
  const setUnitBad = await j(await handleApi(req(`/a/users/${rlogin.d.user.id}`, { method: 'PUT', body: { unit_id: 99999 }, token: adminToken }), env));
  assert.equal(setUnitBad.s, 404, 'invalid unit rejected');
}

// ---------- N) bot token management from the admin panel ----------
{
  const env = makeEnv();
  // install minimal admin
  const inst = await j(await handleApi(req('/install', {
    method: 'POST',
    body: { building_name: 'برج بات', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;

  // no token yet → configured:false with hint
  const b0 = await j(await handleApi(req('/a/bot', { token: adminToken }), env));
  assert.equal(b0.s, 200);
  assert.equal(b0.d.configured, false, 'bot not configured initially');
  assert.ok(b0.d.hint, 'hint present when unconfigured');

  // invalid formats rejected before any network call
  const bad1 = await j(await handleApi(req('/a/bot/token', { method: 'POST', body: { token: 'not-a-token' }, token: adminToken }), env));
  assert.equal(bad1.s, 400, 'garbage token rejected');
  assert.equal(bad1.d.code, 'bad_token');
  const bad2 = await j(await handleApi(req('/a/bot/token', { method: 'POST', body: { token: '' }, token: adminToken }), env));
  assert.equal(bad2.s, 400, 'empty token rejected');
  const bad3 = await j(await handleApi(req('/a/bot/token', { method: 'POST', body: { token: '123456789:short' }, token: adminToken }), env));
  assert.equal(bad3.s, 400, 'short secret part rejected');

  // well-formed but fake token → getMe fails offline/401 → not persisted
  const fake = await j(await handleApi(req('/a/bot/token', {
    method: 'POST', body: { token: '123456789:AAExampleTokenForTestsNotReal000000' }, token: adminToken
  }), env));
  assert.equal(fake.s, 502, 'fake token rejected by getMe');
  assert.equal(fake.d.code, 'token_invalid');
  const bAfter = await j(await handleApi(req('/a/bot', { token: adminToken }), env));
  assert.equal(bAfter.d.configured, false, 'failed token not persisted');

  // manager token must not access bot routes
  const mgr = await j(await handleApi(req('/a/managers', {
    method: 'POST',
    body: { username: 'mgr1', password: 'manager123', full_name: 'مدیر آزمون' },
    token: adminToken
  }), env));
  assert.equal(mgr.s, 201);
  const mgrLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mgr1', password: 'manager123' } }), env));
  const mgrToken = mgrLogin.d.token;
  const mgrBot = await j(await handleApi(req('/a/bot', { token: mgrToken }), env));
  assert.equal(mgrBot.s, 403, 'manager cannot read bot status');

  // disconnect endpoint: nothing stored from panel yet → not applicable
  const del = await j(await handleApi(req('/a/bot/token', { method: 'DELETE', body: {}, token: adminToken }), env));
  assert.equal(del.s, 409, 'DELETE without panel-stored token rejected');
}

// ---------- 14) admin-panel user management: create / edit / promote / demote ----
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST',
    body: { building_name: 'برج کاربران', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;

  // manager creates a unit; unit number typed with the «واحد» word → normalized
  const mgr = await j(await handleApi(req('/a/managers', {
    method: 'POST',
    body: { username: 'mgr1', password: 'manager123', full_name: 'مدیر آزمون' },
    token: adminToken
  }), env));
  assert.equal(mgr.s, 201);
  const mgrLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mgr1', password: 'manager123' } }), env));
  const mgrToken = mgrLogin.d.token;

  const unit = await j(await handleApi(req('/units', {
    method: 'POST',
    body: { number: 'واحد 12', resident_name: 'ساکن دوازده', area_m2: 100, residents_count: 2 },
    token: mgrToken
  }), env));
  assert.equal(unit.s, 201, 'unit created');
  assert.equal(unit.d.unit.number, '12', '«واحد» prefix stripped from unit number on create');

  const unitUpd = await j(await handleApi(req(`/units/${unit.d.unit.id}`, {
    method: 'PUT', body: { number: 'واحد ۱۳' }, token: mgrToken
  }), env));
  assert.equal(unitUpd.s, 200);
  assert.equal(unitUpd.d.unit.number, '۱۳', 'prefix stripped on update (persian digits kept)');

  // admin creates a resident for that unit from the panel
  const resNew = await j(await handleApi(req('/a/users', {
    method: 'POST',
    body: { role: 'resident', username: 'unit13', password: 'secret13', full_name: 'ساکن سیزده', unit_id: unit.d.unit.id },
    token: adminToken
  }), env));
  assert.equal(resNew.s, 201, 'admin panel can create a unit user');
  assert.equal(resNew.d.user.role, 'resident');

  // duplicate resident for same unit rejected
  const dupRes = await j(await handleApi(req('/a/users', {
    method: 'POST',
    body: { role: 'resident', username: 'unit13b', password: 'secret13', full_name: 'دومی', unit_id: unit.d.unit.id },
    token: adminToken
  }), env));
  assert.equal(dupRes.s, 409, 'one resident account per unit');

  // resident without unit rejected
  const noUnit = await j(await handleApi(req('/a/users', {
    method: 'POST',
    body: { role: 'resident', username: 'nounit', password: 'secret13', full_name: 'بی‌واحد' },
    token: adminToken
  }), env));
  assert.equal(noUnit.s, 400, 'resident requires a unit');

  // the new resident can log in and sees only their unit
  const rLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit13', password: 'secret13' } }), env));
  assert.equal(rLogin.s, 200);
  const rToken = rLogin.d.token;
  const mySum = await j(await handleApi(req('/my/summary', { token: rToken }), env));
  assert.equal(mySum.s, 200);
  assert.equal(mySum.d.unit.number, '۱۳');
  const unitsForRes = await j(await handleApi(req('/units', { token: rToken }), env));
  assert.equal(unitsForRes.s, 403, 'resident cannot list all units');

  // promote the resident to building manager from the users tab
  const promote = await j(await handleApi(req(`/a/users/${resNew.d.user.id}`, {
    method: 'PUT', body: { role: 'manager' }, token: adminToken
  }), env));
  assert.equal(promote.s, 200, 'resident promoted to manager');
  assert.equal(promote.d.user.role, 'manager');
  const mgrs = await j(await handleApi(req('/a/managers', { token: adminToken }), env));
  assert.ok(mgrs.d.managers.some(m => m.id === resNew.d.user.id), 'promoted user appears in managers tab');

  // promoted manager now has manager access
  const dash = await j(await handleApi(req('/dashboard', { token: rToken }), env));
  assert.equal(dash.s, 200, 'promoted manager can see the residents-debt dashboard');

  // demote back → loses manager access and leaves the managers tab
  const demote = await j(await handleApi(req(`/a/users/${resNew.d.user.id}`, {
    method: 'PUT', body: { role: 'resident' }, token: adminToken
  }), env));
  assert.equal(demote.s, 200);
  assert.equal(demote.d.user.role, 'resident');
  const mgrs2 = await j(await handleApi(req('/a/managers', { token: adminToken }), env));
  assert.ok(!mgrs2.d.managers.some(m => m.id === resNew.d.user.id), 'demoted user removed from managers tab');
  const dash2 = await j(await handleApi(req('/dashboard', { token: rToken }), env));
  assert.equal(dash2.s, 403, 'demoted user lost manager access');

  // role guards: admin account can't be changed, bad roles rejected
  const adminId = inst.d.user.id;
  const chAdmin = await j(await handleApi(req(`/a/users/${adminId}`, {
    method: 'PUT', body: { role: 'resident' }, token: adminToken
  }), env));
  assert.equal(chAdmin.s, 409, 'app-admin role is immutable');
  const badRole = await j(await handleApi(req(`/a/users/${resNew.d.user.id}`, {
    method: 'PUT', body: { role: 'admin' }, token: adminToken
  }), env));
  assert.equal(badRole.s, 400, 'cannot grant app-admin role');

  // manager cannot use admin user management
  const mgrTry = await j(await handleApi(req('/a/users', { method: 'POST', body: { username: 'x1', password: 'secret13', full_name: 'x' }, token: mgrToken }), env));
  assert.equal(mgrTry.s, 403, 'manager blocked from admin user management');
}

// ---------- 15) automatic monthly reminder: RBAC + config + run gate ----------
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST',
    body: { building_name: 'برج یادآور', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;

  const mgr = await j(await handleApi(req('/a/managers', {
    method: 'POST',
    body: { username: 'mgr2', password: 'manager123', full_name: 'مدیر دوم' },
    token: adminToken
  }), env));
  assert.equal(mgr.s, 201);
  const mgrToken = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mgr2', password: 'manager123' } }), env))).d.token;

  // a unit + resident account with real debt (no telegram link)
  const unit = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '7', resident_name: 'ساکن هفت' }, token: mgrToken
  }), env));
  assert.equal(unit.s, 201);
  const resAcc = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'unit7', password: 'secret13', full_name: 'ساکن هفت', unit_id: unit.d.unit.id }, token: mgrToken
  }), env));
  assert.equal(resAcc.s, 201);
  const rToken = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit7', password: 'secret13' } }), env))).d.token;
  const gen = await j(await handleApi(req('/charges/generate', {
    method: 'POST', body: { period: currentPeriod(), mode: 'fixed', amount: 500000 }, token: mgrToken
  }), env));
  assert.equal(gen.s, 200, 'monthly charges issued');

  // RBAC: resident and app-admin have no access (total debt is manager-only)
  assert.equal((await j(await handleApi(req('/autoremind', { token: rToken }), env))).s, 403, 'resident blocked from autoremind');
  assert.equal((await j(await handleApi(req('/autoremind', { token: adminToken }), env))).s, 403, 'app-admin blocked from autoremind (finance policy)');
  assert.equal((await j(await handleApi(req('/autoremind/run', { method: 'POST', body: {}, token: rToken }), env))).s, 403, 'resident cannot fire reminders');

  // defaults
  const g1 = await j(await handleApi(req('/autoremind', { token: mgrToken }), env));
  assert.equal(g1.s, 200);
  assert.equal(g1.d.cfg.enabled, false, 'disabled by default');
  assert.equal(g1.d.cfg.day, 1, 'day 1 by default');
  assert.ok(g1.d.cfg.text.length > 10, 'default template present');
  assert.equal(g1.d.bot_configured, false, 'no bot token configured');
  assert.equal(g1.d.stats.debtor_residents, 1, 'one debtor resident');
  assert.equal(g1.d.stats.reachable_residents, 0, 'no linked telegram residents');
  assert.ok(g1.d.stats.total_debt > 0, 'total debt computed');

  // validation
  assert.equal((await j(await handleApi(req('/autoremind', { method: 'PUT', body: { day: 0 }, token: mgrToken }), env))).s, 400, 'day 0 rejected');
  assert.equal((await j(await handleApi(req('/autoremind', { method: 'PUT', body: { day: 30 }, token: mgrToken }), env))).s, 400, 'day 30 rejected');
  assert.equal((await j(await handleApi(req('/autoremind', { method: 'PUT', body: { text: 'سلام مهمان عزیز' }, token: mgrToken }), env))).s, 400, 'template without vars rejected');

  // v2.14.0 — «تعداد یادآوری» count validation + round plan
  assert.equal((await j(await handleApi(req('/autoremind', { method: 'PUT', body: { count: 0 }, token: mgrToken }), env))).s, 400, 'count 0 rejected');
  assert.equal((await j(await handleApi(req('/autoremind', { method: 'PUT', body: { count: 5 }, token: mgrToken }), env))).s, 400, 'count 5 rejected');
  const put = await j(await handleApi(req('/autoremind', {
    method: 'PUT', body: { enabled: true, day: 5, count: 3, text: 'سلام {name}، واحد {unit}: {amount} تومان' }, token: mgrToken
  }), env));
  assert.equal(put.s, 200);
  assert.equal(put.d.cfg.enabled, true);
  assert.equal(put.d.cfg.day, 5);
  assert.equal(put.d.cfg.count, 3, 'reminder count persisted');
  assert.deepEqual(put.d.cfg.rounds, [5, 17, 29], 'round days spread to end of month');
  const g2 = await j(await handleApi(req('/autoremind', { token: mgrToken }), env));
  assert.equal(g2.d.cfg.enabled, true, 'enabled persisted');
  assert.equal(g2.d.cfg.count, 3, 'count read back');
  assert.ok(g2.d.cfg.text.includes('{amount}'), 'template persisted');

  // manual run: forced gate passes, but no linked telegram → no_targets (and no network call)
  const run = await j(await handleApi(req('/autoremind/run', { method: 'POST', body: {}, token: mgrToken }), env));
  assert.equal(run.s, 200);
  assert.equal(run.d.result.ran, false);
  assert.equal(run.d.result.reason, 'no_targets', 'no linked residents → no targets');
  assert.equal(run.d.result.unreachable, 1, 'debtor resident counted as unreachable');

  // test endpoint without a bot token → explicit error
  const tst = await j(await handleApi(req('/autoremind/test', { method: 'POST', body: {}, token: mgrToken }), env));
  assert.equal(tst.s, 400);
  assert.equal(tst.d.code, 'bot_token_missing');

  // skipped runs must NOT mark the month → cron retries later within the month
  const g3 = await j(await handleApi(req('/autoremind', { token: mgrToken }), env));
  assert.equal(g3.d.cfg.last, '', 'no last-sent marker on skipped run');
}

// ---------- 15b) v2.14.0 security: login throttle + session-epoch revocation ----
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج امن', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;

  // create a manager to attack
  const mgr = await j(await handleApi(req('/a/managers', {
    method: 'POST', body: { username: 'secmgr', password: 'manager123', full_name: 'مدیر امن' }, token: adminToken
  }), env));
  assert.equal(mgr.s, 201);

  // 5 wrong attempts → 6th is locked (429) even with the CORRECT password
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await j(await handleApi(req('/auth/login', {
      method: 'POST', body: { username: 'secmgr', password: 'wrong-' + i }
    }), env));
    assert.equal(last.s, 401, 'wrong password ' + i + ' rejected normally');
  }
  const locked = await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'secmgr', password: 'manager123' }
  }), env));
  assert.equal(locked.s, 429, 'locked after 5 failures even with correct password');
  assert.ok((locked.d.error || '').includes('قفل'), 'Persian lock message');

  // a different account is NOT locked
  const other = await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'Admin', password: 'admin123' }
  }), env));
  assert.equal(other.s, 200, 'other accounts unaffected by throttle');

  // epoch: change password → old sessions die, fresh token works
  const login1 = await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'Admin', password: 'admin123' }
  }), env));
  assert.equal(login1.s, 200);
  const t1 = login1.d.token;
  const me1 = await j(await handleApi(req('/auth/me', { token: t1 }), env));
  assert.equal(me1.s, 200, 'token valid before password change');

  const cp = await j(await handleApi(req('/auth/change-password', {
    method: 'POST', body: { old_password: 'admin123', new_password: 'admin456@' }, token: t1
  }), env));
  assert.equal(cp.s, 200, 'password change ok');
  assert.ok(cp.d.token, 'fresh token returned to current device');

  const meOld = await j(await handleApi(req('/auth/me', { token: t1 }), env));
  assert.equal(meOld.s, 401, 'OLD session token revoked after password change');
  const meNew = await j(await handleApi(req('/auth/me', { token: cp.d.token }), env));
  assert.equal(meNew.s, 200, 'fresh token (new epoch) works');

  // admin-panel password reset also kills sessions
  const reset = await j(await handleApi(req('/a/users/' + mgr.d.manager.id, {
    method: 'PUT', body: { password: 'newmgr123' }, token: cp.d.token
  }), env));
  assert.equal(reset.s, 200, 'admin reset manager password');
  // clear the throttle lock from earlier in this block so the login check is clean
  await env.DB.prepare("DELETE FROM settings WHERE key = 'login_fail:secmgr'").run();
  const mgrOldLogin = await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'secmgr', password: 'manager123' }
  }), env));
  assert.equal(mgrOldLogin.s, 401, 'old manager password rejected after reset');
  // lock from earlier may still be active for secmgr — wait not needed: lock is per failed logins window; login with wrong pass counts. Use direct epoch check instead:
  const secNow = await env.DB.prepare("SELECT token_epoch FROM users WHERE username = 'secmgr'").first();
  assert.ok(Number(secNow.token_epoch) >= 1, 'manager epoch bumped by admin reset');
}

// ---------- 15c) v2.14.0 «تعداد یادآوری»: counters on reminders + reports ----
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج یادآور', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;
  await j(await handleApi(req('/a/managers', {
    method: 'POST', body: { username: 'mgr1', password: 'manager123', full_name: 'مدیر' }, token: adminToken
  }), env));
  const mgrLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mgr1', password: 'manager123' } }), env));
  const mgrToken = mgrLogin.d.token;

  const unit = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '1', resident_name: 'ساکن یک', area_m2: 100, residents_count: 2 }, token: mgrToken
  }), env));
  assert.equal(unit.s, 201, 'unit created for reminder test: ' + JSON.stringify(unit.d));
  const ch = await j(await handleApi(req('/charges/generate', {
    method: 'POST', body: { period: '1404-07', method: 'equal', amount: 1000000, items: [{ title: 'شارژ', amount: 1000000 }] }, token: mgrToken
  }), env));
  assert.equal(ch.s, 200, 'charge issued: ' + JSON.stringify(ch.d));
  const debtsRes = await handleApi(req('/debts?unit_id=' + unit.d.unit.id, { token: mgrToken }), env);
  const debtsJson = JSON.parse(await debtsRes.text());
  const debtId = debtsJson.debts[0].id;

  // before any reminder
  const before = await env.DB.prepare('SELECT remind_count, last_remind_at FROM debts WHERE id = ?').bind(debtId).first();
  assert.equal(Number(before.remind_count), 0, 'no reminders initially');

  // manual reminder (no bot token → skipped, but counters must not move on skip)
  const rem0 = await j(await handleApi(req('/notify/reminders', { method: 'POST', body: {}, token: mgrToken }), env));
  assert.equal(rem0.s, 200, 'reminder endpoint reachable without bot token');
  const after0 = await env.DB.prepare('SELECT remind_count FROM debts WHERE id = ?').bind(debtId).first();
  assert.equal(Number(after0.remind_count), 0, 'skip does not bump counters');

  // reports carry remind fields
  const rep = await j(await handleApi(req('/reports/year?jy=1404', { token: mgrToken }), env));
  assert.equal(rep.s, 200);
  assert.ok('remind_count' in rep.d.by_unit[0], 'reports/year includes remind_count');
  assert.ok('last_remind_at' in rep.d.by_unit[0], 'reports/year includes last_remind_at');

  // debtors CSV/XLS include the columns
  const csvX = await handleApi(req('/export?type=debtors&fmt=xls', { token: mgrToken }), env);
  const xText = await csvX.text();
  assert.ok(xText.includes('تعداد یادآوری'), 'debtors xls includes remind column');
}

// ---------- 16) telegram username in profiles + personal message + auto-link ----
{
  const env = makeEnv();
  const BOT = '7000000000:TESTTOKEN';

  // initData signer (same algorithm as validateInitData expects)
  const makeInitData = userObj => {
    const p = new URLSearchParams();
    p.set('auth_date', String(Math.floor(Date.now() / 1000)));
    p.set('query_id', 'AAF_l0m2QAAAAAB_l0m2Q');
    p.set('user', JSON.stringify(userObj));
    const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };

  const inst = await j(await handleApi(req('/install', {
    method: 'POST',
    body: { building_name: 'برج یوزرنیم', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;

  const mgr = await j(await handleApi(req('/a/managers', {
    method: 'POST', body: { username: 'mgr3', password: 'manager123', full_name: 'مدیر سوم' }, token: adminToken
  }), env));
  assert.equal(mgr.s, 201);
  assert.equal(mgr.d.manager.telegram_username, '', 'telegram_username empty by default');
  const mgrToken = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mgr3', password: 'manager123' } }), env))).d.token;

  const unit = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '21', resident_name: 'ساکن ۲۱' }, token: mgrToken
  }), env));
  assert.equal(unit.s, 201);

  // manager creates a resident with a telegram username (with @ and mixed case)
  const res1 = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'unit21', password: 'secret13', full_name: 'ساکن بیست‌ویک', unit_id: unit.d.unit.id, telegram_username: '@Ali_Tg' },
    token: mgrToken
  }), env));
  assert.equal(res1.s, 201, 'resident with telegram_username created');
  assert.equal(res1.d.resident.telegram_username, 'Ali_Tg', '@ stripped on write');
  const resId = res1.d.resident.id;

  // invalid telegram username rejected
  const bad = await j(await handleApi(req('/residents/' + resId, {
    method: 'PUT', body: { telegram_username: 'ali reza!' }, token: mgrToken
  }), env));
  assert.equal(bad.s, 400, 'invalid tg username rejected');
  assert.equal(bad.d.code, 'bad_tg_username');

  // message before any bot token → explicit error (no network involved)
  const msgNoTok = await j(await handleApi(req(`/residents/${resId}/message`, {
    method: 'POST', body: { text: 'سلام' }, token: mgrToken
  }), env));
  assert.equal(msgNoTok.s, 400, 'personal message without bot token');
  assert.equal(msgNoTok.d.code, 'bot_token_missing');

  // RBAC: resident and app-admin cannot use the manager message endpoint
  const rToken = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'unit21', password: 'secret13' } }), env))).d.token;
  assert.equal((await j(await handleApi(req(`/residents/${resId}/message`, { method: 'POST', body: { text: 'x' }, token: rToken }), env))).s, 403, 'resident blocked from messaging');
  assert.equal((await j(await handleApi(req(`/residents/${resId}/message`, { method: 'POST', body: { text: 'x' }, token: adminToken }), env))).s, 403, 'app-admin blocked from manager message endpoint');
  assert.equal((await j(await handleApi(req(`/a/users/${resId}/message`, { method: 'POST', body: { text: 'x' }, token: mgrToken }), env))).s, 403, 'manager blocked from admin message endpoint');

  // admin panel: create a user with a username + update it
  const u2 = await j(await handleApi(req('/a/users', {
    method: 'POST',
    body: { role: 'resident', username: 'unit22', password: 'secret13', full_name: 'ساکن ۲۲', unit_id: unit.d.unit.id, telegram_username: '@Panel_User' },
    token: adminToken
  }), env));
  assert.equal(u2.s, 409, 'unit 21 already has a resident account');
  const unit2 = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '22', resident_name: 'ساکن ۲۲' }, token: mgrToken
  }), env));
  const u2ok = await j(await handleApi(req('/a/users', {
    method: 'POST',
    body: { role: 'resident', username: 'unit22', password: 'secret13', full_name: 'ساکن ۲۲', unit_id: unit2.d.unit.id, telegram_username: '@Panel_User' },
    token: adminToken
  }), env));
  assert.equal(u2ok.s, 201);
  assert.equal(u2ok.d.user.telegram_username, 'Panel_User');
  const u2id = u2ok.d.user.id;

  const u2upd = await j(await handleApi(req(`/a/users/${u2id}`, {
    method: 'PUT', body: { telegram_username: 'https://t.me/new_panel_user' }, token: adminToken
  }), env));
  assert.equal(u2upd.s, 200);
  assert.equal(u2upd.d.user.telegram_username, 'new_panel_user', 't.me link stripped');

  // store a (fake) bot token → auto-link path becomes reachable
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', ?)").bind(BOT).run();

  // the resident opens the mini app inside Telegram for the first time:
  // initData carries username 'ALI_tg' (different case than stored 'Ali_Tg')
  const tgAuth = new Request('http://localhost/api/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': makeInitData({ id: 4242, username: 'ALI_tg', first_name: 'علی' }) },
    body: '{}'
  });
  const linked = await j(await handleApi(tgAuth, env));
  assert.equal(linked.s, 200, 'auto-link by username succeeded → session issued');
  assert.equal(linked.d.user.id, resId, 'linked to the profile pre-filled with that username');
  assert.equal(linked.d.user.telegram_linked, true);
  assert.equal(linked.d.user.telegram_username, 'ALI_tg', 'canonical username saved from initData');

  // now the personal message reaches the send stage (fake token → Telegram rejects → send_failed)
  const msg = await j(await handleApi(req(`/residents/${resId}/message`, {
    method: 'POST', body: { text: 'لطفاً شارژ ماه را تسویه کنید.' }, token: mgrToken
  }), env));
  assert.equal(msg.s, 502, 'send attempted (token is fake → rejected by Telegram)');
  assert.equal(msg.d.code, 'send_failed');

  // the never-linked user still returns not_linked
  const msg2 = await j(await handleApi(req(`/a/users/${u2id}/message`, {
    method: 'POST', body: { text: 'سلام' }, token: adminToken
  }), env));
  assert.equal(msg2.s, 409, 'unlinked user cannot receive personal messages');
  assert.equal(msg2.d.code, 'not_linked');

  // /a/users still lists the linked state for the admin panel table
  const list = await j(await handleApi(req('/a/users', { token: adminToken }), env));
  const lu = list.d.users.find(x => x.id === resId);
  assert.equal(lu.telegram_linked, true, 'admin panel sees linked state');
  assert.equal(lu.telegram_username, 'ALI_tg');
}

// ---------- 17) user-login report (گزارش ورود کاربران) — app-admin only (v2.9.1) ----------
{
  const mgrLogin = await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'manager1', password: 'newpass99' }
  }), env));
  assert.equal(mgrLogin.s, 200, 'manager login ok');
  const mTok = mgrLogin.d.token;

  // a fresh resident (older resident accounts were wiped with their units)
  const unitC = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '90', resident_name: 'ساکن بازدید' }, token: mTok
  }), env));
  const resC = await j(await handleApi(req('/residents', {
    method: 'POST',
    body: { username: 'visit_res', password: 'visit123', full_name: 'ساکن بازدید', unit_id: unitC.d.unit.id },
    token: mTok
  }), env));
  assert.equal(resC.s, 201, 'resident created for visit tests');
  const resTok = (await j(await handleApi(req('/auth/login', {
    method: 'POST', body: { username: 'visit_res', password: 'visit123' }
  }), env))).d.token;
  assert.ok(resTok, 'resident logged in (this login itself is a visit)');

  // RBAC: resident AND manager are denied — the report belongs only to the app-admin
  const denied = await j(await handleApi(req('/a/visits', { token: resTok }), env));
  assert.equal(denied.s, 403, 'resident cannot open the visits report');
  const deniedMgr = await j(await handleApi(req('/a/visits', { token: mTok }), env));
  assert.equal(deniedMgr.s, 403, 'manager cannot open the visits report (v2.9.1: removed from manager)');

  const rep = await j(await handleApi(req('/a/visits', { token: adminToken }), env));
  assert.equal(rep.s, 200, 'admin opens the report');
  assert.ok(rep.d.stats && Array.isArray(rep.d.visits), 'report shape: stats + visits[]');
  assert.equal(rep.d.has_more, false, 'has_more flag present');
  assert.equal(rep.d.notify_enabled, true, 'notify is on by default');
  // all earlier logins in this suite (admin/manager/resident) plus the
  // section-16 /auth/telegram open must have been recorded
  assert.ok(rep.d.visits.length >= 4, 'logins and opens were logged: ' + rep.d.visits.length);
  assert.ok(rep.d.visits.some(v => v.kind === 'login'), 'login events recorded');
  const linkedRow = rep.d.visits.find(v => v.full_name || v.username);
  assert.ok(linkedRow, 'join with users works');
  assert.ok(rep.d.stats.today >= rep.d.visits.length, 'stats.today counts the rows');

  // kind filter
  const repLogin = await j(await handleApi(req('/a/visits?kind=login', { token: adminToken }), env));
  assert.ok(repLogin.d.visits.length >= 1, 'kind=login returns rows');
  assert.ok(repLogin.d.visits.every(v => v.kind === 'login'), 'kind=login filters correctly');
  const repOpen = await j(await handleApi(req('/a/visits?kind=open', { token: adminToken }), env));
  assert.ok(repOpen.d.visits.every(v => v.kind === 'open'), 'kind=open filters correctly');

  // from/to (ISO, Tehran-day bounds): 3 days ago → includes today's rows
  const iso3 = new Date(Date.now() - 3 * 86400000);
  const isoFrom = `${iso3.getFullYear()}-${String(iso3.getMonth() + 1).padStart(2, '0')}-${String(iso3.getDate()).padStart(2, '0')}`;
  const repRange = await j(await handleApi(req('/a/visits?from=' + isoFrom, { token: adminToken }), env));
  assert.ok(repRange.d.visits.length >= rep.d.visits.length, 'from=3 days ago keeps today rows');
  const iso5 = new Date(Date.now() + 3 * 86400000);
  const isoFut = `${iso5.getFullYear()}-${String(iso5.getMonth() + 1).padStart(2, '0')}-${String(iso5.getDate()).padStart(2, '0')}`;
  const repFut = await j(await handleApi(req('/a/visits?from=' + isoFut, { token: adminToken }), env));
  assert.equal(repFut.d.visits.length, 0, 'future from → empty list');

  // /auth/me right after a login is deduped (the login row is fresh)…
  const before = rep.d.visits.filter(v => v.user_id === mgrLogin.d.user.id).length;
  await handleApi(req('/auth/me', { token: mTok }), env);
  const repMid = await j(await handleApi(req('/a/visits', { token: adminToken }), env));
  const mid = repMid.d.visits.filter(v => v.user_id === mgrLogin.d.user.id).length;
  assert.equal(mid - before, 0, 'open right after a login is deduped');

  // …but once the last visit is older than 5 minutes, the next boot logs an
  // «open» and an immediate second boot is deduped again (OPEN_DEDUP_SECONDS = 300)
  await env.DB.prepare('UPDATE visits SET created_at = ? WHERE user_id = ?')
    .bind(Math.floor(Date.now() / 1000) - 301, mgrLogin.d.user.id).run();
  await handleApi(req('/auth/me', { token: mTok }), env);
  await handleApi(req('/auth/me', { token: mTok }), env);
  const rep2 = await j(await handleApi(req('/a/visits', { token: adminToken }), env));
  const after = rep2.d.visits.filter(v => v.user_id === mgrLogin.d.user.id).length;
  assert.equal(after - before, 1, 'two /auth/me calls after cooldown → exactly one new open row');
  const openRow = rep2.d.visits.find(v => v.user_id === mgrLogin.d.user.id && v.kind === 'open');
  assert.equal(openRow.via, 'session', 'session boot open recorded with via=session');

  // notify toggle: manager and resident denied, admin toggles + persists
  const offMgr = await j(await handleApi(req('/a/visits/notify', {
    method: 'PUT', body: { enabled: false }, token: mTok
  }), env));
  assert.equal(offMgr.s, 403, 'manager cannot toggle the notify switch (v2.9.1)');
  const off = await j(await handleApi(req('/a/visits/notify', {
    method: 'PUT', body: { enabled: false }, token: adminToken
  }), env));
  assert.equal(off.s, 200);
  assert.equal(off.d.notify_enabled, false);
  const rep3 = await j(await handleApi(req('/a/visits', { token: adminToken }), env));
  assert.equal(rep3.d.notify_enabled, false, 'toggle persisted');
  const on = await j(await handleApi(req('/a/visits/notify', {
    method: 'PUT', body: { enabled: true }, token: adminToken
  }), env));
  assert.equal(on.d.notify_enabled, true);

  const deniedTgl = await j(await handleApi(req('/a/visits/notify', {
    method: 'PUT', body: { enabled: false }, token: resTok
  }), env));
  assert.equal(deniedTgl.s, 403, 'resident cannot change notify toggle');

  // admin panel overview carries the visit counters ('?fast' skips the Telegram getMe call)
  const ov = await j(await handleApi(req('/a/overview?fast', { token: adminToken }), env));
  assert.ok(ov.d.visits && typeof ov.d.visits.today === 'number', 'overview includes visits stats');
}

// ---------- 18) v2.13.0: tasks + attachments + performance report + backup v2 ----
{
  const jyNow = period.slice(0, 4);
  const nowSec = Math.floor(Date.now() / 1000);

  // fresh resident for transparency checks (older resident accounts were wiped
  // by the section-11 reset tool, so the old token is intentionally stale)
  const unitT = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '77', resident_name: 'ساکن شفافیت', area_m2: 90, residents_count: 2 }, token: managerToken
  }), env));
  assert.equal(unitT.s, 201, 'unit for perf resident created');
  const resT = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'perf_res', password: 'perf1234', unit_id: unitT.d.unit.id, full_name: 'ساکن شفافیت' }, token: managerToken
  }), env));
  assert.equal(resT.s, 201, 'perf resident created');
  const resLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'perf_res', password: 'perf1234' } }), env));
  assert.equal(resLogin.s, 200, 'perf resident login');
  residentToken = resLogin.d.token;

  // RBAC: anonymous blocked; resident cannot create tasks
  const anon = await j(await handleApi(req('/tasks'), env));
  assert.equal(anon.s, 401, 'anonymous blocked from /tasks');
  const resForbidden = await j(await handleApi(req('/tasks', {
    method: 'POST', body: { title: 'کار ساکن' }, token: residentToken
  }), env));
  assert.equal(resForbidden.s, 403, 'resident cannot create tasks');

  // manager creates a task with cost
  const created = await j(await handleApi(req('/tasks', {
    method: 'POST',
    body: { title: 'سرویس و شارژ کولرها', category: 'تعمیرات', description: 'فیش خدماتی پیوست می‌شود.', cost: 850000, date: nowSec },
    token: managerToken
  }), env));
  assert.equal(created.s, 201, 'task created');
  const taskId = created.d.task.id;
  assert.equal(created.d.task.cost, 850000);
  assert.equal(created.d.task.category, 'تعمیرات');

  // invalid: empty title
  const badTask = await j(await handleApi(req('/tasks', {
    method: 'POST', body: { title: '  ' }, token: managerToken
  }), env));
  assert.equal(badTask.s, 400, 'empty title rejected');

  // residents/admin can read tasks (شفافیت)
  const listRes = await j(await handleApi(req('/tasks?jy=' + jyNow, { token: residentToken }), env));
  assert.equal(listRes.s, 200, 'resident can read tasks');
  assert.ok(listRes.d.tasks.some(t => t.id === taskId), 'new task listed for resident');
  const listAdmin = await j(await handleApi(req('/tasks?jy=' + jyNow, { token: adminToken }), env));
  assert.equal(listAdmin.s, 200, 'admin can read tasks');

  // edit task (cost + description)
  const edited = await j(await handleApi(req(`/tasks/${taskId}`, {
    method: 'PUT', body: { cost: 900000, description: 'توضیح ویرایش‌شده — '.repeat(30) }, token: managerToken
  }), env));
  assert.equal(edited.s, 200);
  assert.equal(edited.d.task.cost, 900000);
  assert.ok(edited.d.task.description.length > 100, 'long description saved');

  // file upload — bad mime first
  const badMime = await j(await handleApi(req(`/tasks/${taskId}/files`, {
    method: 'POST', body: { name: 'x.exe', mime: 'application/x-msdownload', data_b64: Buffer.from('MZ').toString('base64') }, token: managerToken
  }), env));
  assert.equal(badMime.s, 400, 'non image/pdf rejected');

  const pngBytes = new Uint8Array(4096);
  pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  crypto.getRandomValues(pngBytes.subarray(8));
  const up1 = await j(await handleApi(req(`/tasks/${taskId}/files`, {
    method: 'POST',
    body: { name: 'fish-khadamati.png', mime: 'image/png', size: pngBytes.length, data_b64: Buffer.from(pngBytes).toString('base64') },
    token: managerToken
  }), env));
  assert.equal(up1.s, 201, 'png uploaded');
  const fileId = up1.d.file.id;

  // multi-chunk reassembly: ~150KB pdf-ish blob → 3 chunks
  const bigBytes = new Uint8Array(150000);
  bigBytes.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
  for (let off = 5; off < bigBytes.length; off += 65536) {
    crypto.getRandomValues(bigBytes.subarray(off, Math.min(off + 65536, bigBytes.length)));
  }
  const up2 = await j(await handleApi(req(`/tasks/${taskId}/files`, {
    method: 'POST',
    body: { name: 'gharardad.pdf', mime: 'application/pdf', size: bigBytes.length, data_b64: Buffer.from(bigBytes).toString('base64') },
    token: managerToken
  }), env));
  assert.equal(up2.s, 201, 'pdf uploaded');
  const bigFileId = up2.d.file.id;

  // download as resident — bytes identical (chunked reassembly verified)
  const dlRes = await handleApi(req(`/tasks/files/${bigFileId}`, { token: residentToken }), env);
  assert.equal(dlRes.status, 200, 'resident downloads attachment');
  const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
  assert.equal(dlBytes.length, bigBytes.length, 'reassembled size matches');
  assert.deepEqual(Buffer.from(dlBytes.subarray(0, 5)).toString(), '%PDF-', 'content intact');
  assert.equal(dlRes.headers.get('content-type'), 'application/pdf');

  const dl404 = await j(await handleApi(req('/tasks/files/999999', { token: managerToken }), env));
  assert.equal(dl404.s, 404, 'missing file 404');

  // resident cannot upload/delete attachments
  const resUp = await j(await handleApi(req(`/tasks/${taskId}/files`, {
    method: 'POST', body: { name: 'a.png', mime: 'image/png', data_b64: 'AAAA' }, token: residentToken
  }), env));
  assert.equal(resUp.s, 403, 'resident cannot upload attachments');

  // delete one file, keep the other for the backup test
  const delFile = await j(await handleApi(req(`/tasks/files/${fileId}`, { method: 'DELETE', token: managerToken }), env));
  assert.equal(delFile.s, 200);
  const dlGone = await j(await handleApi(req(`/tasks/files/${fileId}`, { token: managerToken }), env));
  assert.equal(dlGone.s, 404, 'deleted file gone');

  // performance report — resident allowed; internal math consistent
  const perfRes = await j(await handleApi(req('/reports/performance?jy=' + jyNow, { token: residentToken }), env));
  assert.equal(perfRes.s, 200, 'resident reads performance');
  const perf = perfRes.d;
  assert.equal(perf.months.length, 12, '12 month buckets');
  assert.equal(perf.fund.balance, perf.fund.collected - perf.fund.expenses - perf.fund.tasks_cost, 'year fund math (no opening in year view)');
  assert.equal(perf.fund_all.balance, (perf.fund_all.opening || 0) + perf.fund_all.collected - perf.fund_all.expenses - perf.fund_all.tasks_cost, 'all-time fund math includes opening');
  assert.ok(perf.fund.tasks_cost >= 900000, 'task cost counted in fund');
  assert.ok(perf.categories.some(c => c.category === 'تعمیرات' && c.count >= 1), 'category breakdown includes تعمیرات');
  const perfPdf = await handleApi(req('/pdf/performance?jy=' + jyNow, { token: residentToken }), env);
  assert.equal(perfPdf.status, 200, 'performance PDF for resident');
  const pdfHead = Buffer.from(await perfPdf.arrayBuffer()).subarray(0, 5).toString();
  assert.equal(pdfHead, '%PDF-', 'performance PDF signature');

  // --- backup v2: tasks + attachments inside the JSON backup
  const rawBk = await handleApi(req('/export?type=backup', { token: managerToken }), env);
  assert.equal(rawBk.status, 200, 'backup export ok');
  const backup = JSON.parse(await rawBk.text());
  assert.ok(Array.isArray(backup.tasks) && backup.tasks.length >= 1, 'backup includes tasks');
  assert.ok(Array.isArray(backup.task_files) && backup.task_files.length >= 1, 'backup includes task_files');
  assert.ok(Array.isArray(backup.task_file_chunks) && backup.task_file_chunks.length >= 1, 'backup includes chunks');
  const chunkOfBig = backup.task_file_chunks.filter(ch => ch.file_id === bigFileId);
  assert.ok(chunkOfBig.length >= 3, 'big file stored in multiple chunks');
  const b64Len = chunkOfBig.reduce((s, c) => s + String(c.data || '').length, 0);
  assert.ok(Math.abs(b64Len - Math.ceil(bigBytes.length / 3) * 4) < 4096, 'chunk data is base64 of the file');

  // --- import round-trip: restore and verify the attachment still downloads
  const imp = await j(await handleApi(req('/import', { method: 'POST', body: backup, token: managerToken }), env));
  assert.equal(imp.s, 200, 'import ok');
  assert.ok(imp.d.imported.tasks >= 1, 'tasks imported');
  assert.ok(imp.d.imported.task_files >= 1, 'task_files imported');
  const afterImp = await j(await handleApi(req('/tasks?jy=' + jyNow, { token: managerToken }), env));
  assert.ok(afterImp.d.tasks.some(t => t.id === taskId), 'task survived import');
  const dlAfter = await handleApi(req(`/tasks/files/${bigFileId}`, { token: residentToken }), env);
  assert.equal(dlAfter.status, 200, 'attachment survives restore (resident token still valid)');
  const afterBytes = new Uint8Array(await dlAfter.arrayBuffer());
  assert.equal(afterBytes.length, bigBytes.length, 'restored content identical');
  const perfAfter = await j(await handleApi(req('/reports/performance?jy=' + jyNow, { token: managerToken }), env));
  assert.equal(perfAfter.d.fund.tasks_cost, perf.fund.tasks_cost, 'fund stable across restore');
}

// ---------- 18b) v2.14.1: fund opening balance + ?t= token download ----------
{
  // RBAC: resident cannot set the opening balance
  const resForbidden = await j(await handleApi(req('/tasks/fund', {
    method: 'PUT', body: { amount: 1000 }, token: residentToken
  }), env));
  assert.equal(resForbidden.s, 403, 'resident cannot set fund opening');

  const badAmt = await j(await handleApi(req('/tasks/fund', {
    method: 'PUT', body: { amount: 'abc' }, token: managerToken
  }), env));
  assert.equal(badAmt.s, 400, 'invalid opening amount rejected');

  // manager sets the money left from the previous building manager
  const set = await j(await handleApi(req('/tasks/fund', {
    method: 'PUT', body: { amount: 2500000, note: 'پول نقدی نزد مدیر قبلی' }, token: managerToken
  }), env));
  assert.equal(set.s, 200, 'manager sets fund opening');
  assert.equal(set.d.fund_opening.amount, 2500000);
  assert.equal(set.d.fund_opening.note, 'پول نقدی نزد مدیر قبلی');

  const perf = await j(await handleApi(req('/reports/performance', { token: residentToken }), env));
  assert.equal(perf.s, 200);
  assert.equal(perf.d.fund_opening.amount, 2500000, 'opening reported to residents (transparency)');
  assert.equal(perf.d.fund_all.opening, 2500000, 'opening included in all-time fund');
  assert.equal(
    perf.d.fund_all.balance,
    2500000 + perf.d.fund_all.collected - perf.d.fund_all.expenses - perf.d.fund_all.tasks_cost,
    'all-time balance = opening + collected - expenses - tasks'
  );
  assert.equal(perf.d.fund.opening, 0, 'year fund view has no opening');

  // reset to zero
  const zero = await j(await handleApi(req('/tasks/fund', { method: 'PUT', body: { amount: 0 }, token: managerToken }), env));
  assert.equal(zero.s, 200);
  const perfZero = await j(await handleApi(req('/reports/performance', { token: managerToken }), env));
  assert.equal(perfZero.d.fund_all.opening, 0, 'opening zeroed');

  // set again for the ?t= download test below (opening visible via token download too)
  await j(await handleApi(req('/tasks/fund', { method: 'PUT', body: { amount: 1800000, note: 'تنظیم دوباره' }, token: managerToken }), env));

  // --- v2.14.1: session token via ?t= for GET download routes (Telegram WebView)
  const noHeader = await j(await handleApi(req('/export?type=debtors&t=' + encodeURIComponent(managerToken)), env));
  assert.equal(noHeader.s, 200, 'export works with token in query (no auth header)');
  const wrongT = await j(await handleApi(req('/export?type=debtors&t=bogus.token.here'), env));
  assert.equal(wrongT.s, 401, 'wrong ?t= token rejected');
  const pdfT = await handleApi(req('/pdf/performance?t=' + encodeURIComponent(managerToken)), env);
  assert.equal(pdfT.status, 200, 'PDF download with ?t= token');
  const head = Buffer.from(await pdfT.arrayBuffer()).subarray(0, 5).toString();
  assert.equal(head, '%PDF-', 'PDF via ?t= is a real PDF');

  // non-download GET with ?t= must NOT authenticate (token stays header-only elsewhere)
  const notDl = await j(await handleApi(req('/tasks?t=' + encodeURIComponent(managerToken)), env));
  assert.equal(notDl.s, 401, '?t= is NOT accepted outside download routes');
}


// ---------- 17) v2.15.0 — نشست قفل‌شده به پروفایل تلگرام + ضدتزریق فرمول CSV ----------
{
  const env = makeEnv();
  const BOT = '7100000000:TESTTOKEN';
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', ?)").bind(BOT).run();

  const makeInitData = userObj => {
    const p = new URLSearchParams();
    p.set('auth_date', String(Math.floor(Date.now() / 1000)));
    p.set('query_id', 'AAF_l0m2QAAAAAB_l0m2Q');
    p.set('user', JSON.stringify(userObj));
    const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const postInit = (path, body, initData) => new Request('http://localhost/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-init-data': initData },
    body: JSON.stringify(body)
  });

  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج پروفایل', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken = inst.d.token;
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'pmgr', password: 'manager123', full_name: 'مدیر پروفایل' }, token: adminToken }), env));
  const mgrToken17 = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'pmgr', password: 'manager123' } }), env))).d.token;
  const unit = await j(await handleApi(req('/units', { method: 'POST', body: { number: '10', resident_name: 'ساکن ده' }, token: mgrToken17 }), env));
  assert.equal(unit.s, 201);
  const resAcc = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'pres', password: '123456', unit_id: unit.d.unit.id, telegram_username: 'pres_tg' }, token: mgrToken17
  }), env));
  assert.equal(resAcc.s, 201);

  // (الف) ورود ساکن از پروفایل تلگرام خودش (tg id = 1111) → اتصال + توکن با tg claim
  const tgA = { id: 1111, username: 'pres_tg', first_name: 'A' };
  const loginA = await j(await handleApi(postInit('/auth/login', { username: 'pres', password: '123456' }, makeInitData(tgA)), env));
  assert.equal(loginA.s, 200, 'login from own profile ok');
  assert.equal(loginA.d.linked_telegram, true, 'account linked to profile A');
  const payloadA = await verifySessionToken(env, loginA.d.token);
  assert.equal(Number(payloadA.tg || 0), 1111, 'tg claim signed into the token');

  // me با توکن + initData همان پروفایل → ۲۰۰
  const meA = new Request('http://localhost/api/auth/me', {
    headers: { authorization: 'Bearer ' + loginA.d.token, 'x-telegram-init-data': makeInitData(tgA) }
  });
  assert.equal((await j(await handleApi(meA, env))).s, 200, 'own profile keeps the session');

  // me با همان توکن ولی initData پروفایل دیگر (tg id = 2222) → ۴۰۱ (نشست قفل است)
  const meB = new Request('http://localhost/api/auth/me', {
    headers: { authorization: 'Bearer ' + loginA.d.token, 'x-telegram-init-data': makeInitData({ id: 2222, username: 'other_guy', first_name: 'B' }) }
  });
  assert.equal((await j(await handleApi(meB, env))).s, 401, 'token refused from ANOTHER telegram profile');

  // (ب) ورود با حساب دیگری از همان پروفایل A (که به حساب ساکن قفل شده) → ۴۰۳
  const mgr2 = await j(await handleApi(postInit('/auth/login', { username: 'pmgr', password: 'manager123' }, makeInitData(tgA)), env));
  assert.equal(mgr2.s, 403, 'cross-account login from a bound profile rejected');
  assert.equal(mgr2.d.code, 'telegram_profile_taken');

  // (ج) ضدتزریق فرمول CSV: تلفن واحد که با «=» شروع می‌شود در CSV خنثی می‌شود
  await j(await handleApi(req('/units/' + unit.d.unit.id, { method: 'PUT', body: { phone: '=1+1|cmd' }, token: mgrToken17 }), env));
  // واحد بدهکار شود تا ردیفش در CSV بدهکاران بیاید
  await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: unit.d.unit.id, period: currentPeriod(), amount: 100000, description: 'تست' }, token: mgrToken17 }), env));
  const csvRes = await handleApi(req('/export?type=debtors', { token: adminToken }), env);
  const csvText = await csvRes.text();
  assert.ok(csvRes.headers.get('x-content-type-options') === 'nosniff', 'csv nosniff');
  assert.ok(csvText.includes("'=1+1|cmd"), 'csv formula injection neutralized');
}

// ---------- 18) payment claims (رسید پرداخت شارژ) — v2.16.0 ----------
// این بلوک کاملاً مستقل است (بخش ۱۱ همهٔ واحدها را پاک کرده است)
{
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // واحد + ساکن اول (ثبت‌کنندهٔ رسید)
  const u50 = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '50', resident_name: 'ساکن پنجاه' }, token: managerToken
  }), env));
  assert.equal(u50.s, 201, 'claim unit created');
  const u50id = u50.d.unit.id;
  const acc1 = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'claimres', password: 'claim123', unit_id: u50id, full_name: 'ساکن پنجاه' }, token: managerToken
  }), env));
  assert.equal(acc1.s, 201, 'claim resident created');
  const claimToken = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'claimres', password: 'claim123' } }), env))).d.token;
  assert.ok(claimToken);

  // واحد + ساکن دوم برای تست دسترسی به فیش واحد دیگر
  const u51 = await j(await handleApi(req('/units', {
    method: 'POST', body: { number: '51', resident_name: 'ساکن پنجاه‌ویک' }, token: managerToken
  }), env));
  assert.equal(u51.s, 201);
  await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'claimres2', password: 'claim123', unit_id: u51.d.unit.id, full_name: 'ساکن پنجاه‌ویک' }, token: managerToken
  }), env));
  const resident2Token = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'claimres2', password: 'claim123' } }), env))).d.token;
  assert.ok(resident2Token);

  // (الف) دو بدهی قدیمی برای واحد ۵۰ تا FIFO قابل بررسی باشد
  const dA = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u50id, period: '1300-01', amount: 100000, description: 'قدیمی الف' }, token: managerToken }), env));
  const dB = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u50id, period: '1301-01', amount: 200000, description: 'قدیمی ب' }, token: managerToken }), env));
  assert.equal(dA.s, 201); assert.equal(dB.s, 201);

  // (ب) ثبت رسید بدون فایل → رد (فیش الزامی است)
  const noFile = await j(await handleApi(req('/claims', { method: 'POST', body: { amount: 150000, note: 'بدون فایل' }, token: claimToken }), env));
  assert.equal(noFile.s, 400, 'claim without file rejected');

  // (ج) ثبت رسید درست → ۲۰۱ + در انتظار بررسی + فایل ذخیره شده
  const claim = await j(await handleApi(req('/claims', {
    method: 'POST',
    body: { amount: 150000, note: 'فعلاً ۱۵۰ هزار پرداخت کردم', file: { name: 'fish.png', mime: 'image/png', size: 70, data_b64: TINY_PNG } },
    token: claimToken
  }), env));
  assert.equal(claim.s, 201, 'claim created');
  assert.equal(claim.d.claim.status, 'pending');
  assert.equal(claim.d.claim.unit_id, u50id);
  assert.equal(claim.d.notify_queued, true, 'bot notification queued for managers');
  assert.ok(claim.d.claim.files.length === 1 && claim.d.claim.files[0].name === 'fish.png', 'receipt file attached');
  const claimId = claim.d.claim.id;
  const fileId = claim.d.claim.files[0].id;

  // (د) تا بررسی رسید قبلی، رسید دوم رد می‌شود (ضد اسپم)
  const dup = await j(await handleApi(req('/claims', {
    method: 'POST',
    body: { amount: 1000, file: { name: 'x.png', mime: 'image/png', size: 70, data_b64: TINY_PNG } }, token: claimToken
  }), env));
  assert.equal(dup.s, 409); assert.equal(dup.d.code, 'claim_pending');

  // (ه) فهرست مدیر: در انتظار بررسی با شمارهٔ واحد + فایل
  const mgrList = await j(await handleApi(req('/claims?status=pending', { token: managerToken }), env));
  assert.ok(mgrList.d.claims.some(x => x.id === claimId && x.unit_number === '50'), 'manager sees pending claim with unit number');

  // (و) ساکن اجازهٔ تأیید ندارد
  const resConfirm = await j(await handleApi(req(`/claims/${claimId}/confirm`, { method: 'POST', body: {}, token: claimToken }), env));
  assert.equal(resConfirm.s, 403, 'resident cannot confirm claims');

  // (ز) ساکن واحد دیگر به فیش دسترسی ندارد؛ ساکنِ صاحبِ فیش دارد؛ مدیر هم دارد
  const otherRes = await j(await handleApi(req(`/claims/files/${fileId}`, { token: resident2Token }), env));
  assert.equal(otherRes.s, 403, 'other resident blocked from the receipt file');
  const ownRes = await handleApi(req(`/claims/files/${fileId}`, { token: claimToken }), env);
  assert.equal(ownRes.status, 200, 'owner resident can view the receipt');
  assert.equal(ownRes.headers.get('content-type'), 'image/png');
  assert.equal(ownRes.headers.get('x-content-type-options'), 'nosniff');
  const ownBytes = new Uint8Array(await ownRes.arrayBuffer());
  assert.ok(ownBytes.length > 0 && ownBytes[0] === 0x89, 'receipt bytes are PNG');
  const mgrFile = await handleApi(req(`/claims/files/${fileId}`, { token: managerToken }), env);
  assert.equal(mgrFile.status, 200, 'manager can view the receipt');

  // (ح) ثبت جزیی ۱۵۰٬۰۰۰: FIFO — قلم قدیمی «الف» (۱۰۰٬۰۰۰) کامل و «ب» ۵۰٬۰۰۰ partial
  const before = await j(await handleApi(req('/my/summary', { token: claimToken }), env));
  const remainingBefore = before.d.totals.remaining;
  const partial = await j(await handleApi(req(`/claims/${claimId}/confirm`, { method: 'POST', body: { amount: 150000 }, token: managerToken }), env));
  assert.equal(partial.s, 200, 'partial confirm ok');
  assert.equal(partial.d.applied, 150000);
  assert.equal(partial.d.unit_remaining, remainingBefore - 150000, 'remaining debt reduced exactly by applied amount');
  assert.equal(partial.d.claim.status, 'confirmed');
  assert.equal(partial.d.claim.confirmed_amount, 150000);
  const debtsAfter = await j(await handleApi(req('/debts', { token: managerToken }), env));
  const aAfter = debtsAfter.d.debts.find(x => x.id === dA.d.debt.id);
  const bAfter = debtsAfter.d.debts.find(x => x.id === dB.d.debt.id);
  assert.equal(aAfter.status, 'paid', 'oldest debt fully settled first');
  assert.equal(bAfter.paid_amount, 50000, 'second debt partially covered');
  assert.ok(String(bAfter.note || '').includes('رسید پرداخت ساکن #' + claimId), 'claim reference written into debt note');
  assert.equal(bAfter.method, 'رسید تأییدشده');

  // (ط) فهرست ساکن: رسید تأییدشده دیده می‌شود
  const myList = await j(await handleApi(req('/claims', { token: claimToken }), env));
  const myClaim = myList.d.claims.find(x => x.id === claimId);
  assert.ok(myClaim && myClaim.status === 'confirmed', 'resident sees confirmed status');

  // (ی) رسید دوم → ثبت کامل (کل ماندهٔ واحد صفر می‌شود)
  const claim2 = await j(await handleApi(req('/claims', {
    method: 'POST',
    body: { amount: 999999, note: 'بقیه را هم کامل پرداختم', file: { name: 'fish2.png', mime: 'image/png', size: 70, data_b64: TINY_PNG } },
    token: claimToken
  }), env));
  assert.equal(claim2.s, 201, 'second claim allowed after first reviewed');
  const before2 = await j(await handleApi(req('/my/summary', { token: claimToken }), env));
  const full = await j(await handleApi(req(`/claims/${claim2.d.claim.id}/confirm`, { method: 'POST', body: {}, token: managerToken }), env));
  assert.equal(full.s, 200, 'full confirm ok');
  assert.equal(full.d.applied, before2.d.totals.remaining, 'full confirm applies exactly the remaining debt');
  assert.equal(full.d.unit_remaining, 0, 'unit debt fully settled');

  // (ک) رسید سوم → رد با دلیل؛ دوباره بررسی‌کردن همان رسید → ۴۰۹
  const claim3 = await j(await handleApi(req('/claims', {
    method: 'POST',
    body: { amount: 50000, note: 'fish اشتباهی', file: { name: 'f3.png', mime: 'image/png', size: 70, data_b64: TINY_PNG } },
    token: claimToken
  }), env));
  assert.equal(claim3.s, 201);
  const reject = await j(await handleApi(req(`/claims/${claim3.d.claim.id}/reject`, { method: 'POST', body: { reason: 'فیش ناخوانا است' }, token: managerToken }), env));
  assert.equal(reject.s, 200);
  assert.equal(reject.d.claim.status, 'rejected');
  assert.equal(reject.d.claim.reject_note, 'فیش ناخوانا است');
  const again = await j(await handleApi(req(`/claims/${claim3.d.claim.id}/reject`, { method: 'POST', body: {}, token: managerToken }), env));
  assert.equal(again.s, 409, 'already reviewed');
  const myList2 = await j(await handleApi(req('/claims', { token: claimToken }), env));
  assert.ok(myList2.d.claims.find(x => x.id === claim3.d.claim.id && x.status === 'rejected'), 'resident sees rejected status');

  // (ل) پشتیبان JSON شامل رسیده‌هاست
  const bk = await j(await handleApi(req('/export?type=backup', { token: managerToken }), env));
  assert.ok(Array.isArray(bk.d.payment_claims) && bk.d.payment_claims.length >= 3, 'backup includes payment_claims');
  assert.ok(Array.isArray(bk.d.claim_files) && bk.d.claim_files.length >= 3, 'backup includes claim_files');
  assert.ok(Array.isArray(bk.d.claim_file_chunks) && bk.d.claim_file_chunks.length >= 3, 'backup includes claim_file_chunks');
}

// ---------- 19) v2.17.0 — لینک دعوت یک‌بارمصرف + قفل حساب به پروفایل ----------
// این بلوک مستقل است (env تازه) — جریان کامل: ساخت لینک → مصرف با initData →
// ابطال نشست قبلی → رد پروفایل دیگر (یوزر/پسورد و initData) → مصرف مجدد خودِ پروفایل.
{
  const env = makeEnv();
  const BOT = '7200000000:TESTTOKEN19';
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', ?)").bind(BOT).run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_username', 'testbot19')").run();

  const makeInitData = userObj => {
    const p = new URLSearchParams();
    p.set('auth_date', String(Math.floor(Date.now() / 1000)));
    p.set('query_id', 'AAF_l0m2QAAAAAB_l0m2Q');
    p.set('user', JSON.stringify(userObj));
    const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
    return p.toString();
  };
  const postInit = (path, body, initData) => new Request('http://localhost/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(initData ? { 'x-telegram-init-data': initData } : {}) },
    body: JSON.stringify(body)
  });

  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج دعوت', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken19 = inst.d.token;
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'imgr', password: 'manager123', full_name: 'مدیر دعوت' }, token: adminToken19 }), env));
  const mgrToken19 = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'imgr', password: 'manager123' } }), env))).d.token;
  const u19 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '19', resident_name: 'ساکن نوزده' }, token: mgrToken19 }), env));
  const acc19 = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'ires', password: '123456', unit_id: u19.d.unit.id, full_name: 'ساکن نوزده' }, token: mgrToken19
  }), env));
  const resId19 = acc19.d.resident.id;

  // ساکن اول با یوزر/پسورد وارد می‌شود (نشست قدیمی که بعداً باید باطل شود)
  const oldLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'ires', password: '123456' } }), env));
  assert.equal(oldLogin.s, 200);
  const oldToken = oldLogin.d.token;

  // (الف) ساخت لینک یک‌بارمصرف با انقضای ۶ ساعته
  const inv = await j(await handleApi(req('/invites', {
    method: 'POST', body: { user_id: resId19, hours: 6 }, token: mgrToken19
  }), env));
  assert.equal(inv.s, 201, 'invite created');
  assert.ok(inv.d.invite.token && inv.d.invite.token.length >= 24, 'random token generated');
  assert.equal(inv.d.invite.url, 'https://t.me/testbot19?startapp=' + inv.d.invite.token, 't.me startapp link built');
  const tok19 = inv.d.invite.token;

  // فهرست لینک‌های فعال برای مدیر
  const invList = await j(await handleApi(req('/invites', { token: mgrToken19 }), env));
  assert.ok(invList.d.invites.some(i => i.token === tok19), 'active invite listed');

  // (ب) مصرف بدون initData → رد (فقط از داخل تلگرام)
  const noInit = await j(await handleApi(req('/auth/invite', { method: 'POST', body: { token: tok19 } }), env));
  assert.equal(noInit.s, 400, 'invite requires telegram initData');

  // (ج) v2.20.0 — پروتکل دومرحله‌ای: اول بدون اعتبارنامه → ۴۰۱ invite_credentials_required
  const P1 = { id: 3101, username: 'owner19', first_name: 'A' };
  const P2 = { id: 3202, username: 'other19', first_name: 'B' };
  const needCred = await j(await handleApi(postInit('/auth/invite', { token: tok19 }, makeInitData(P1)), env));
  assert.equal(needCred.s, 401, 'fresh link asks for credentials first');
  assert.equal(needCred.d.code, 'invite_credentials_required', 'credentials-required code');

  // (ج۲) اعتبارنامهٔ نادرست → ۴۰۱ invite_bad_credentials (لینک هنوز مصرف نشده)
  const badCred = await j(await handleApi(postInit('/auth/invite', { token: tok19, username: 'ires', password: 'wrong' }, makeInitData(P1)), env));
  assert.equal(badCred.s, 401, 'wrong credentials refused');
  assert.equal(badCred.d.code, 'invite_bad_credentials', 'bad-credentials code');

  // (ج۳) یوزر/رمز درستِ همان حساب → ۲۰۰ + اتصال + قفل + توکن تازه
  const use1 = await j(await handleApi(postInit('/auth/invite', { token: tok19, username: 'ires', password: '123456' }, makeInitData(P1)), env));
  assert.equal(use1.s, 200, 'invite consumed with correct credentials');
  assert.equal(use1.d.bound, true, 'account bound to profile');
  const boundToken = use1.d.token;
  const payload19 = await verifySessionToken(env, boundToken);
  assert.equal(Number(payload19.tg || 0), 3101, 'session carries bound tg claim');

  // (د) نشستِ قدیمیِ قبل از لینک باطل شده (bump epoch)
  const meOld = await j(await handleApi(req('/auth/me', { token: oldToken }), env));
  assert.equal(meOld.s, 401, 'pre-invite session revoked');

  // (ه) ورود یوزر/پسورد از پروفایل دیگر داخل تلگرام → ۴۰۳ profile_locked
  const locked = await j(await handleApi(postInit('/auth/login', { username: 'ires', password: '123456' }, makeInitData(P2)), env));
  assert.equal(locked.s, 403, 'password login from ANOTHER profile rejected');
  assert.equal(locked.d.code, 'profile_locked');

  // (و) initData پروفایل دیگر برای ورود خودکار → ۴۰۱ (حساب دیگر پیدا نمی‌شود)
  const me2 = await j(await handleApi(postInit('/auth/telegram', {}, makeInitData(P2)), env));
  assert.equal(me2.s, 401, 'auto-login with other profile refused');

  // (ز) با توکنِ قفل‌شده + initData پروفایل دیگر → ۴۰۱؛ با پروفایل خودش → ۲۰۰
  const meCross = new Request('http://localhost/api/auth/me', {
    headers: { authorization: 'Bearer ' + boundToken, 'x-telegram-init-data': makeInitData(P2) }
  });
  assert.equal((await j(await handleApi(meCross, env))).s, 401, 'bound token refused from other profile');
  const meOwn = new Request('http://localhost/api/auth/me', {
    headers: { authorization: 'Bearer ' + boundToken, 'x-telegram-init-data': makeInitData(P1) }
  });
  assert.equal((await j(await handleApi(meOwn, env))).s, 200, 'bound token works from own profile');

  // (ح) مصرف مجدد همان لینک توسط پروفایل دیگر → ۴۰۹؛ توسط خودِ پروفایل → ۲۰۰ (بازکردن دوباره از چت)
  const reuseOther = await j(await handleApi(postInit('/auth/invite', { token: tok19 }, makeInitData(P2)), env));
  assert.equal(reuseOther.s, 409, 'used link rejected for another profile');
  const reuseSelf = await j(await handleApi(postInit('/auth/invite', { token: tok19 }, makeInitData(P1)), env));
  assert.equal(reuseSelf.s, 200, 're-opening own used link still logs the owner in');

  // (ط) لینک منقضی: دستی منقضی می‌شود — بازگشاییِ مالکِ همان پروفایل هنوز کار
  //     می‌کند (لینکِ مصرف‌شده فقط برای پروفایل‌های دیگر بی‌اعتبار است)
  await env.DB.prepare('UPDATE invite_tokens SET expires_at = 1 WHERE token = ?').bind(tok19).run();
  const expiredOwner = await j(await handleApi(postInit('/auth/invite', { token: tok19 }, makeInitData(P1)), env));
  assert.equal(expiredOwner.s, 200, 'owner re-entry works even if link expired');

  // (ی) لینک استفاده‌نشدهٔ منقضی برای هر کسی ۴۱۰ می‌دهد + ابطال دستی
  const inv2 = await j(await handleApi(req('/invites', { method: 'POST', body: { user_id: resId19, hours: 2 }, token: mgrToken19 }), env));
  assert.equal(inv2.s, 201, 'second invite created');
  await env.DB.prepare('UPDATE invite_tokens SET expires_at = 1 WHERE token = ?').bind(inv2.d.invite.token).run();
  const expired = await j(await handleApi(postInit('/auth/invite', { token: inv2.d.invite.token }, makeInitData(P1)), env));
  assert.equal(expired.s, 410, 'unused expired invite rejected');
  const del = await j(await handleApi(req('/invites/' + inv2.d.invite.id, { method: 'DELETE', body: {}, token: mgrToken19 }), env));
  assert.equal(del.s, 200, 'invite revoked');

  // (گ) v2.20.0 — سناریوی انتقال واقعی (رفع «قبلاً به حساب دیگری متصل شده است»):
  // P2 اول با حساب دیگری (ires2) وارد می‌شود (telegram_user_id = P2 روی آن حساب)،
  // بعد لینک حساب ires را با اعتبارنامهٔ درست همان حساب باز می‌کند → انتقال:
  // ires به P2 قفل می‌شود، حساب قبلی ires2 آزاد و نشست‌های قبلی هر دو باطل می‌شوند.
  const u19b = await j(await handleApi(req('/units', { method: 'POST', body: { number: '20', resident_name: 'ساکن بیست' }, token: mgrToken19 }), env));
  assert.equal(u19b.s, 201, 'second unit for takeover test');
  const acc19b = await j(await handleApi(req('/residents', {
    method: 'POST', body: { username: 'ires2', password: '654321', unit_id: u19b.d.unit.id, full_name: 'ساکن بیست' }, token: mgrToken19
  }), env));
  assert.equal(acc19b.s, 201, 'second resident created');
  const login2 = await j(await handleApi(postInit('/auth/login', { username: 'ires2', password: '654321' }, makeInitData(P2)), env));
  assert.equal(login2.s, 200, 'P2 first logs into its own other account');
  const old2 = login2.d.token;

  const inv4 = await j(await handleApi(req('/invites', { method: 'POST', body: { user_id: resId19, hours: 6 }, token: mgrToken19 }), env));
  assert.equal(inv4.s, 201, 'invite for takeover created');
  const ask1 = await j(await handleApi(postInit('/auth/invite', { token: inv4.d.invite.token }, makeInitData(P2)), env));
  assert.equal(ask1.s, 401, 'takeover also asks for credentials first');
  const ask2 = await j(await handleApi(postInit('/auth/invite', { token: inv4.d.invite.token, username: 'ires2', password: '654321' }, makeInitData(P2)), env));
  assert.equal(ask2.s, 401, 'credentials of ANOTHER account are not the proof for this link');
  assert.equal(ask2.d.code, 'invite_bad_credentials', 'cross-account credentials code');
  const take = await j(await handleApi(postInit('/auth/invite', { token: inv4.d.invite.token, username: 'ires', password: '123456' }, makeInitData(P2)), env));
  assert.equal(take.s, 200, 'profile held by another account CAN take over with correct credentials');
  assert.equal(take.d.user.id, resId19, 'session is for the invite target account');

  // حساب قبلیِ P2 آزاد شده و حساب هدف به P2 قفل شده است
  const rel = await env.DB.prepare('SELECT telegram_user_id, bound_tg_id FROM users WHERE id = ?').bind(acc19b.d.resident.id).first();
  assert.equal(Number(rel.telegram_user_id || 0), 0, 'previous account telegram_user_id cleared');
  assert.equal(Number(rel.bound_tg_id || 0), 0, 'previous account bound_tg_id cleared');
  const tgt = await env.DB.prepare('SELECT bound_tg_id FROM users WHERE id = ?').bind(resId19).first();
  assert.equal(Number(tgt.bound_tg_id || 0), 3202, 'target account now bound to P2');

  // نشست‌های قبلی: P2 روی حساب قبلی + P1 (مالک قبلی) روی حساب هدف — هر دو باطل
  assert.equal((await j(await handleApi(req('/auth/me', { token: old2 }), env))).s, 401, 'P2 old-account session revoked');
  assert.equal((await j(await handleApi(req('/auth/me', { token: boundToken }), env))).s, 401, 'P1 old-owner session revoked');

  // لینک قدیمی P1 دیگر نمی‌تواند حساب را پس بگیرد (بدون لینک جدید هیچ اتفاقی نمی‌افتد)
  const stealBack = await j(await handleApi(postInit('/auth/invite', { token: tok19 }, makeInitData(P1)), env));
  assert.equal(stealBack.s, 409, 'old owner cannot re-enter via old used link after transfer');

  // P2 حالا با initData خودش مستقیم وارد حساب هدف می‌شود
  const me2b = await j(await handleApi(postInit('/auth/telegram', {}, makeInitData(P2)), env));
  assert.equal(me2b.s, 200, 'auto-login now resolves to the transferred account');
  assert.equal(me2b.d.user.id, resId19, 'auto-login user is the invite target');

  // (ک) پشتیبان شامل ستون‌های جدید users است
  const bk19 = await j(await handleApi(req('/export?type=backup', { token: mgrToken19 }), env));
  const uRow = (bk19.d.users || []).find(x => x.id === resId19);
  assert.ok(uRow, 'backup has the resident');
  assert.ok('bound_tg_id' in uRow && 'is_resident' in uRow, 'backup carries v2.17 user columns');
}

// ---------- 20) v2.17.0 — مدیرِ ساکن جزو بدهکاران شارژ (+ واحد با حساب مدیر) ----------
{
  const env = makeEnv();
  const BOT = '7300000000:TESTTOKEN20';
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', ?)").bind(BOT).run();

  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج مدیرساکن', username: 'Admin', password: 'admin123' }
  }), env));
  const adminToken20 = inst.d.token;

  // مدیرِ ساکن با واحد خودش
  const mg = await j(await handleApi(req('/a/managers', {
    method: 'POST', body: { username: 'rmgr', password: 'manager123', full_name: 'مدیر ساکن', unit_id: null }, token: adminToken20
  }), env));
  assert.equal(mg.s, 201);
  assert.equal(mg.d.manager.is_resident, true, 'manager is resident by default');
  const mgrLogin = await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'rmgr', password: 'manager123' } }), env));
  const mgrToken20 = mgrLogin.d.token;

  // واحدِ خودش: در فهرست واحدها manager_account می‌آید و در مودال «ساخت حساب ساکن» پیشنهاد نمی‌شود
  const u20 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '20', resident_name: 'مدیر ساکن' }, token: mgrToken20 }), env));
  const u20id = u20.d.unit.id;
  await j(await handleApi(req('/my/unit', { method: 'POST', body: { unit_id: u20id }, token: mgrToken20 }), env));
  const units20 = await j(await handleApi(req('/units', { token: mgrToken20 }), env));
  const unit20 = units20.d.units.find(x => x.id === u20id);
  assert.ok(unit20, 'unit listed');
  assert.ok(unit20.manager_account && unit20.manager_account.username === 'rmgr', 'unit carries manager_account');
  assert.equal(unit20.has_account, false, 'no resident account on manager unit');

  // شارژ ماه → واحدِ مدیر هم بدهکار می‌شود
  const gen20 = await j(await handleApi(req('/charges/generate', {
    method: 'POST', body: { period: '1404-01', mode: 'fixed', amount: 500000 }, token: mgrToken20
  }), env));
  assert.ok(gen20.s === 200 || gen20.s === 201, 'charges generated');
  const debts20 = await j(await handleApi(req('/debts?unit_id=' + u20id, { token: mgrToken20 }), env));
  assert.ok(debts20.d.debts.length >= 1 && debts20.d.debts[0].status === 'unpaid', 'manager unit has unpaid charge');

  // بدون اتصال تلگرام: هدفی نیست؛ بعد از اتصال (تزریق telegram_user_id) هدف می‌شود
  let rem = await j(await handleApi(req('/notify/reminders', { method: 'POST', body: {}, token: mgrToken20 }), env));
  assert.equal(rem.d.skipped, 'no_targets', 'unlinked manager is not a target yet');
  await env.DB.prepare('UPDATE users SET telegram_user_id = 4404 WHERE username = ?').bind('rmgr').run();

  rem = await j(await handleApi(req('/notify/reminders', { method: 'POST', body: {}, token: mgrToken20 }), env));
  assert.equal(rem.d.targets, 1, 'resident manager is the single reminder target');
  assert.ok(rem.d.sent + rem.d.failed === 1, 'delivery attempted for the manager unit');
  assert.equal(rem.d.capped, false);

  const stats20 = await j(await handleApi(req('/autoremind', { token: mgrToken20 }), env));
  assert.equal(stats20.d.stats.debtor_residents, 1, 'auto-reminder stats count the resident manager');

  // تیک «مدیر، ساکن ساختمان نیست» → از هدف‌ها خارج می‌شود
  await env.DB.prepare('UPDATE users SET is_resident = 0 WHERE username = ?').bind('rmgr').run();
  rem = await j(await handleApi(req('/notify/reminders', { method: 'POST', body: {}, token: mgrToken20 }), env));
  assert.equal(rem.d.skipped, 'no_targets', 'non-resident manager excluded from reminders');
  const stats20b = await j(await handleApi(req('/autoremind', { token: mgrToken20 }), env));
  assert.equal(stats20b.d.stats.debtor_residents, 0, 'non-resident manager excluded from stats');

  // /my/summary برای مدیر همچنان کار می‌کند (نمای «واحد من»)
  const my20 = await j(await handleApi(req('/my/summary', { token: mgrToken20 }), env));
  assert.equal(my20.s, 200);
  assert.ok(my20.d.totals.remaining > 0, 'manager sees own unit debt');
}

// ---------- 21) v2.21.0 — اعتبار اضافه‌پرداخت (دفتر unit_credits) ----------
// بلوک مستقل با env تازه: ثبت دستی → پرداخت بیش از مانده (با/بدون overpay) →
// اعمال دستی → مصرف خودکار در صدور شارژ → رسید با اضافه‌پرداخت → گزارش‌ها و بکاپ
{
  const env = makeEnv();
  const TINY_PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج اعتبار', username: 'Admin', password: 'admin123' }
  }), env));
  assert.ok([200, 201].includes(inst.s), 'install ok');
  const adminT = inst.d.token;
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'cmgr', password: 'manager123', full_name: 'مدیر اعتبار' }, token: adminT }), env));
  const mT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'cmgr', password: 'manager123' } }), env))).d.token;
  assert.ok(mT);

  // واحد ۶۰ با ساکن + واحد ۶۱
  const u60 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '60', resident_name: 'ساکن شصت' }, token: mT }), env));
  const u60id = u60.d.unit.id;
  await j(await handleApi(req('/residents', { method: 'POST', body: { username: 'cres60', password: '123456', unit_id: u60id, full_name: 'ساکن شصت' }, token: mT }), env));
  const resT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'cres60', password: '123456' } }), env))).d.token;
  const u61 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '61', resident_name: 'ساکن شصت‌ویک' }, token: mT }), env));
  const u61id = u61.d.unit.id;

  // (الف) RBAC: ساکن اجازهٔ ثبت اعتبار ندارد؛ ورودی نامعتبر رد می‌شود
  const r403 = await j(await handleApi(req('/credits', { method: 'POST', body: { unit_id: u60id, amount: 1000 }, token: resT }), env));
  assert.equal(r403.s, 403, 'resident cannot register credit');
  const bad0 = await j(await handleApi(req('/credits', { method: 'POST', body: { unit_id: u60id, amount: 0 }, token: mT }), env));
  assert.equal(bad0.s, 400);
  const badUnit = await j(await handleApi(req('/credits', { method: 'POST', body: { unit_id: 999999, amount: 1000 }, token: mT }), env));
  assert.equal(badUnit.s, 404);

  // (ب) ثبت دستی اضافه‌پرداخت ۲۰۰٬۰۰۰ → ماندهٔ اعتبار واحد ۲۰۰٬۰۰۰
  const reg = await j(await handleApi(req('/credits', { method: 'POST', body: { unit_id: u60id, amount: 200000, note: 'واریزی اضافه' }, token: mT }), env));
  assert.equal(reg.s, 201, 'credit registered');
  assert.equal(reg.d.credit_balance, 200000);
  assert.equal(reg.d.registered, 200000);

  // (ج) قلم ۵۰۰٬۰۰۰؛ پرداخت ۶۰۰٬۰۰۰ بدون overpay → ۴۰۰ overpay_possible؛ با overpay → اعتبار ۱۰۰٬۰۰۰
  const d60 = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u60id, period: '1300-02', amount: 500000, description: 'شارژ اعتبار' }, token: mT }), env));
  assert.equal(d60.s, 201);
  const noOver = await j(await handleApi(req(`/debts/${d60.d.debt.id}/pay`, { method: 'POST', body: { amount: 600000 }, token: mT }), env));
  assert.equal(noOver.s, 400, 'overpay without flag rejected');
  assert.equal(noOver.d.code, 'overpay_possible');
  const over = await j(await handleApi(req(`/debts/${d60.d.debt.id}/pay`, { method: 'POST', body: { amount: 600000, overpay: true, method: 'کارت به کارت' }, token: mT }), env));
  assert.equal(over.s, 200, 'overpay accepted with flag');
  assert.equal(over.d.applied, 500000, 'debt capped at remaining');
  assert.equal(over.d.credited, 100000, 'excess became credit');
  assert.equal(over.d.debt.status, 'paid');
  assert.equal(over.d.credit_balance, 300000, 'balance 200k + 100k');

  // (د) ساکن اعتبار را می‌بیند: my/summary + my/credit با تاریخچهٔ ۲ ردیف
  const sum = await j(await handleApi(req('/my/summary', { token: resT }), env));
  assert.equal(sum.d.credit.balance, 300000);
  assert.equal(sum.d.credit.effective_remaining, 0, 'no debt left so effective = 0');
  assert.equal(sum.d.credit.entries.length, 2, 'ledger history visible to resident');
  const myc = await j(await handleApi(req('/my/credit', { token: resT }), env));
  assert.equal(myc.s, 200); assert.equal(myc.d.balance, 300000);

  // (هـ) حذف ردیف ثبت ۱۰۰هزار → مانده ۲۰۰هزار؛ دیتای دفتر سالم
  const listC = await j(await handleApi(req('/credits?unit_id=' + u60id, { token: mT }), env));
  assert.equal(listC.d.entries.length, 2);
  assert.ok(!listC.d.entries.some(e => e.kind === 'consume'), 'no consume row yet in this unit');
  const addRow = listC.d.entries.find(e => e.kind === 'add' && e.amount === 100000);
  const delAdd = await j(await handleApi(req('/credits/' + addRow.id, { method: 'DELETE', token: mT }), env));
  assert.equal(delAdd.s, 200);
  assert.equal(delAdd.d.credit_balance, 200000, 'balance back to first add row');

  // (و) قلم باز ۴۰۰٬۰۰۰ → اعمال دستی اعتبار: min(۲۰۰هزار، ۴۰۰هزار) = ۲۰۰هزار
  const d60b = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u60id, period: '1300-03', amount: 400000, description: 'قلم دوم' }, token: mT }), env));
  const apply = await j(await handleApi(req('/credits/apply', { method: 'POST', body: { debt_id: d60b.d.debt.id }, token: mT }), env));
  assert.equal(apply.s, 200, 'credit applied');
  assert.equal(apply.d.used, 200000);
  assert.equal(apply.d.debt.status, 'partial');
  assert.equal(apply.d.credit_balance, 0);
  const applyAgain = await j(await handleApi(req('/credits/apply', { method: 'POST', body: { debt_id: d60b.d.debt.id }, token: mT }), env));
  assert.equal(applyAgain.s, 409); assert.equal(applyAgain.d.code, 'no_credit');
  const consumeList = await j(await handleApi(req('/credits?unit_id=' + u60id, { token: mT }), env));
  const consumeRow = consumeList.d.entries.find(e => e.kind === 'consume');
  assert.ok(consumeRow && consumeRow.amount === -200000, 'consume row written to the ledger');
  const delConsume = await j(await handleApi(req('/credits/' + consumeRow.id, { method: 'DELETE', token: mT }), env));
  assert.equal(delConsume.s, 409); assert.equal(delConsume.d.code, 'consume_locked', 'consume rows are locked');
  const addRow2 = consumeList.d.entries.find(e => e.kind === 'add');
  const delAdd2 = await j(await handleApi(req('/credits/' + addRow2.id, { method: 'DELETE', token: mT }), env));
  assert.equal(delAdd2.s, 409); assert.equal(delAdd2.d.code, 'already_consumed', 'consumed add row is locked — ledger stays consistent');

  // (ز) مصرف خودکار در صدور شارژ: واحد ۶۱ اعتبار ۱۵۰هزار دارد؛ شارژ ۴۰۰هزار → پیش‌پرداخت کامل
  await j(await handleApi(req('/credits', { method: 'POST', body: { unit_id: u61id, amount: 400000, note: 'پیش‌پرداخت ۶۱' }, token: mT }), env));
  const gen = await j(await handleApi(req('/charges/generate', { method: 'POST', body: { period: '1300-04', mode: 'fixed', amount: 400000 }, token: mT }), env));
  assert.equal(gen.s, 200);
  assert.equal(gen.d.created, 2, 'both units got a charge');
  assert.equal(gen.d.credit_units, 1);
  assert.equal(gen.d.credit_used_total, 400000, 'credit auto-consumed on generation');
  const d61 = await j(await handleApi(req('/debts?unit_id=' + u61id + '&period=1300-04', { token: mT }), env));
  const d61row = d61.d.debts.find(x => x.kind === 'monthly');
  assert.equal(d61row.paid_amount, 400000);
  assert.equal(d61row.status, 'paid');
  assert.equal(d61row.method, 'اعتبار اضافه‌پرداخت', 'auto-consume marked on the debt');

  // (ح) رسید با مبلغ بیشتر از مانده → ۴۰۰ overpay_possible → با overpay → اعتبار
  await j(await handleApi(req('/residents', { method: 'POST', body: { username: 'cres61', password: '123456', unit_id: u61id, full_name: 'ساکن شصت‌ویک' }, token: mT }), env));
  const res61T = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'cres61', password: '123456' } }), env))).d.token;
  const d61c = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u61id, period: '1300-06', amount: 70000, description: 'قلم رسید' }, token: mT }), env));
  const claim61 = await j(await handleApi(req('/claims', {
    method: 'POST',
    body: { amount: 120000, note: '۱۲۰هزار پرداخت کردم', file: { name: 'f.png', mime: 'image/png', size: 70, data_b64: TINY_PNG_1PX } },
    token: res61T
  }), env));
  assert.equal(claim61.s, 201, 'claim 61 created');
  const confNo = await j(await handleApi(req(`/claims/${claim61.d.claim.id}/confirm`, { method: 'POST', body: { amount: 120000 }, token: mT }), env));
  assert.equal(confNo.s, 400); assert.equal(confNo.d.code, 'overpay_possible', 'claim overpay needs flag');
  const confYes = await j(await handleApi(req(`/claims/${claim61.d.claim.id}/confirm`, { method: 'POST', body: { amount: 120000, overpay: true }, token: mT }), env));
  assert.equal(confYes.s, 200);
  assert.equal(confYes.d.applied, 70000, 'FIFO applied exactly the remaining debt');
  assert.equal(confYes.d.credited, 50000, 'excess became credit');
  assert.equal(confYes.d.credit_balance, 50000, 'exhausted before, 50k excess now');

  // (ط) گزارش‌ها: /units credit، /dashboard، /reports/year، /reports/month
  const units = await j(await handleApi(req('/units', { token: mT }), env));
  const u61row = units.d.units.find(u => u.id === u61id);
  assert.equal(u61row.credit, 50000, 'units list carries credit');
  const dash = await j(await handleApi(req('/dashboard', { token: mT }), env));
  assert.equal(dash.d.credit_total, 50000, 'dashboard credit_total');
  const yr = await j(await handleApi(req('/reports/year?jy=1300', { token: mT }), env));
  const yr61 = yr.d.by_unit.find(u => u.id === u61id);
  assert.equal(yr61.credit, 50000);
  assert.equal(yr.d.credit_total, 50000);
  const mo = await j(await handleApi(req('/reports/month?period=1300-04', { token: mT }), env));
  assert.equal(mo.d.totals.credit_total, 50000, 'monthly report credit_total');
  assert.equal(mo.d.by_unit.find(u => u.id === u61id).credit, 50000);

  // (ی) خروجی بدهکاران: ستون اعتبار + مانده پس از اعتبار (CSV)
  const exp = await handleApi(req('/export?type=debtors', { token: mT }), env);
  const expText = await exp.text();
  assert.ok(expText.includes('اعتبار واحد'), 'debtors export has credit column');
  assert.ok(expText.includes('مانده پس از اعتبار'), 'debtors export has effective column');

  // (ک) پشتیبان JSON شامل unit_credits + بازیابی round-trip
  const bk = await j(await handleApi(req('/export?type=backup', { token: mT }), env));
  assert.ok(Array.isArray(bk.d.unit_credits) && bk.d.unit_credits.length >= 4, 'backup includes unit_credits');
  const imp = await j(await handleApi(req('/import', { method: 'POST', body: bk.d, token: mT }), env));
  assert.equal(imp.s, 200, 'import ok');
  assert.ok(imp.d.imported.unit_credits >= 4, 'import restores unit_credits');
  const unitsAfter = await j(await handleApi(req('/units', { token: mT }), env));
  assert.equal(unitsAfter.d.units.find(u => u.id === u61id).credit, 50000, 'credit survives restore');
}

// ---------- 22) v2.22.0 — اعلان فعالیت‌ها برای مدیرکل (admin_notifications) ----------
// بلوک مستقل: RBAC → تیک‌ها → رویداد فعال/غیرفعال → گزارش کامل → لینک اتصال → تست
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج اعلان', username: 'Admin', password: 'admin123' }
  }), env));
  assert.ok([200, 201].includes(inst.s));
  const adminT = inst.d.token;

  // (الف) RBAC: مدیر ساختمان به پیکربندی/گزارش اعلان‌ها دسترسی ندارد
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'nmgr', password: 'manager123', full_name: 'مدیر اعلان' }, token: adminT }), env));
  const mT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'nmgr', password: 'manager123' } }), env))).d.token;
  assert.ok(mT);
  const r403a = await j(await handleApi(req('/a/notifications/config', { token: mT }), env));
  assert.equal(r403a.s, 403, 'manager cannot read notif config');
  const r403b = await j(await handleApi(req('/a/notifications', { token: mT }), env));
  assert.equal(r403b.s, 403, 'manager cannot read notif report');

  // (ب) پیش‌فرض: همه رویدادها خاموش (به‌جز resident_open قدیمی) → رویدادی ثبت نمی‌شود
  const cfg0 = await j(await handleApi(req('/a/notifications/config', { token: adminT }), env));
  assert.equal(cfg0.s, 200);
  assert.equal(cfg0.d.events.length, 14, 'catalog has 14 events');
  assert.equal(cfg0.d.events.find(e => e.key === 'resident_open').enabled, true, 'resident_open inherits legacy toggle');
  assert.equal(cfg0.d.events.find(e => e.key === 'payment').enabled, false, 'payment default off');
  const u0 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '10', resident_name: 'ساکن ده' }, token: mT }), env));
  assert.equal(u0.s, 201);
  const rep0 = await j(await handleApi(req('/a/notifications', { token: adminT }), env));
  assert.equal(rep0.d.total, 0, 'disabled event writes nothing');

  // (ج) تیک unit_change + payment → رویداد ثبت و در گزارش می‌آید
  const save = await j(await handleApi(req('/a/notifications/config', {
    method: 'POST', body: { events: { unit_change: true, payment: true, resident_open: false } }, token: adminT
  }), env));
  assert.equal(save.s, 200);
  assert.equal(save.d.events.unit_change, true);
  // resident_open روی کلید قدیمی می‌نویسد (تب ورود کاربران)
  const vs = await j(await handleApi(req('/a/visits', { token: adminT }), env));
  assert.equal(vs.d.notify_enabled, false, 'resident_open tick maps to legacy visit toggle');

  const u1 = await j(await handleApi(req('/units', { method: 'POST', body: { number: '11', resident_name: 'ساکن یازده' }, token: mT }), env));
  assert.equal(u1.s, 201);
  const d1 = await j(await handleApi(req('/debts', { method: 'POST', body: { unit_id: u1.d.unit.id, period: '1300-10', amount: 250000, description: 'شارژ اعلان' }, token: mT }), env));
  assert.equal(d1.s, 201);
  const pay1 = await j(await handleApi(req(`/debts/${d1.d.debt.id}/pay`, { method: 'POST', body: { amount: 250000, method: 'نقدی' }, token: mT }), env));
  assert.equal(pay1.s, 200);

  const rep1 = await j(await handleApi(req('/a/notifications', { token: adminT }), env));
  assert.ok(rep1.d.total >= 2, 'enabled events recorded');
  const unitRow = rep1.d.items.find(n => n.event === 'unit_change');
  assert.ok(unitRow, 'unit_change row exists');
  assert.equal(unitRow.actor_username, 'nmgr', 'actor recorded');
  assert.equal(unitRow.actor_role, 'manager');
  assert.ok(unitRow.text.includes('واحد 11'), 'full message text stored');
  const payRow = rep1.d.items.find(n => n.event === 'payment');
  assert.ok(payRow && payRow.text.includes('پرداخت'), 'payment row stored');
  // ارسال: ربات تنظیم نیست ولی ردیف گزارش هست (گزارش کامل مستقل از ارسال)
  assert.equal(payRow.sent, 0);
  assert.equal(payRow.send_error, 'bot_not_configured');
  assert.ok(rep1.d.stats.failed_count >= 2, 'failures counted in stats');

  // (د) فیلتر گزارش بر اساس رویداد
  const repF = await j(await handleApi(req('/a/notifications?event=unit_change', { token: adminT }), env));
  assert.ok(repF.d.items.every(n => n.event === 'unit_change'));

  // (هـ) ورود مدیر با تیک manager_login → ردیف ورود
  const save2 = await j(await handleApi(req('/a/notifications/config', { method: 'POST', body: { events: { manager_login: true } }, token: adminT }), env));
  assert.equal(save2.s, 200);
  await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'nmgr', password: 'manager123' } }), env));
  const rep2 = await j(await handleApi(req('/a/notifications?event=manager_login', { token: adminT }), env));
  assert.ok(rep2.d.items.length >= 1, 'manager login recorded');
  const loginRow = rep2.d.items[0];
  assert.ok(loginRow.text.includes('روش ورود'), 'login message includes method');
  // ادمین خودش اعلان نمی‌گیرد (خود-حذفی)
  const adminLogins = rep2.d.items.filter(n => n.actor_role === 'admin');
  assert.equal(adminLogins.length, 0, 'admin actions are never notified');

  // (و) لینک اتصال تلگرام مدیرکل — بدون توکن ربات ۴۰۰؛ با توکن ساختگی لینک می‌سازد
  const noBot = await j(await handleApi(req('/a/notifications/link', { method: 'POST', body: {} },), env));
  // توجه: بدون token در req → 401
  assert.equal(noBot.s, 401);
  const noBotTok = await j(await handleApi(req('/a/notifications/link', { method: 'POST', body: {}, token: adminT }), env));
  assert.equal(noBotTok.s, 400); assert.equal(noBotTok.d.code, 'bot_token_missing');
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_token', '1000000000:TESTTOKEN')").run();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_username', 'notifbot')").run();
  const link = await j(await handleApi(req('/a/notifications/link', { method: 'POST', body: {}, token: adminT }), env));
  assert.equal(link.s, 201);
  assert.ok(link.d.url.startsWith('https://t.me/notifbot?startapp='), 't.me invite link built');

  // (ز) اعلان آزمایشی — مستقل از تیک‌ها ثبت می‌شود
  const tst = await j(await handleApi(req('/a/notifications/test', { method: 'POST', body: {}, token: adminT }), env));
  assert.equal(tst.s, 200);
  assert.equal(tst.d.sent, 0, 'no real telegram in tests');
  const rep3 = await j(await handleApi(req('/a/notifications?event=test', { token: adminT }), env));
  assert.equal(rep3.d.items.length, 1, 'test event recorded in report');
  assert.ok(rep3.d.items[0].text.includes('آزمایشی'));
}

// ---------- 23) v2.23.0 — صدور خودکار شارژ ماهانه ----------
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج خودکار', username: 'Admin', password: 'admin123' }
  }), env));
  const adminT = inst.d.token;
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'acmgr', password: 'manager123', full_name: 'مدیر خودکار' }, token: adminT }), env));
  const mT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'acmgr', password: 'manager123' } }), env))).d.token;
  assert.ok(mT);

  // RBAC: ساکن/ادمین به مسیرهای مدیر ساختمان دسترسی ندارند
  await j(await handleApi(req('/units', { method: 'POST', body: { number: '1', resident_name: 'ساکن یک' }, token: mT }), env));
  await j(await handleApi(req('/units', { method: 'POST', body: { number: '2', resident_name: 'ساکن دو' }, token: mT }), env));
  await j(await handleApi(req('/residents', { method: 'POST', body: { unit_id: 1, username: 'ac_res1', password: '123456' }, token: mT }), env));
  const rT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'ac_res1', password: '123456' } }), env))).d.token;
  const r403 = await j(await handleApi(req('/autocharge', { token: rT }), env));
  assert.equal(r403.s, 403, 'resident cannot read autocharge config');
  const a403 = await j(await handleApi(req('/autocharge/run', { method: 'POST', body: {}, token: adminT }), env));
  assert.equal(a403.s, 403, 'admin cannot run manager autocharge');

  // پیش‌فرض خاموش
  const g0 = await j(await handleApi(req('/autocharge', { token: mT }), env));
  assert.equal(g0.s, 200);
  assert.equal(g0.d.cfg.enabled, false, 'autocharge default off');
  assert.equal(g0.d.ticked, 0, 'no units ticked initially');

  // ذخیرهٔ پیکربندی + اعتبارسنجی مبلغ
  const bad = await j(await handleApi(req('/autocharge', { method: 'PUT', body: { enabled: true, day: 3, amount: 0, mode: 'fixed' }, token: mT }), env));
  assert.equal(bad.s, 400, 'enabled without amount rejected');
  const put = await j(await handleApi(req('/autocharge', { method: 'PUT', body: { enabled: true, day: 3, amount: 500000, mode: 'fixed' }, token: mT }), env));
  assert.equal(put.s, 200); assert.equal(put.d.cfg.enabled, true); assert.equal(put.d.cfg.day, 3);

  // تیک واحدها — فقط تیک‌خورده‌ها صادر می‌شوند
  const t1 = await j(await handleApi(req('/autocharge/unit', { method: 'PUT', body: { unit_id: 1, on: true }, token: mT }), env));
  assert.equal(t1.d.on, true); assert.equal(t1.d.ticked, 1);
  await j(await handleApi(req('/autocharge/unit', { method: 'PUT', body: { unit_id: 2, on: true }, token: mT }), env));

  // اجرای دستی: هر دو واحد تیک‌خورده صادر می‌شوند
  const run = await j(await handleApi(req('/autocharge/run', { method: 'POST', body: {}, token: mT }), env));
  assert.equal(run.s, 200);
  const r1 = run.d.result;
  assert.equal(r1.ran, true);
  assert.equal(r1.created, 2, 'created for both ticked units');
  assert.ok(r1.period && /-\d{2}$/.test(r1.period), 'current jalali period');

  // اجرای دوم: اقلام تکراری رد می‌شوند
  const run2 = await j(await handleApi(req('/autocharge/run', { method: 'POST', body: {}, token: mT }), env));
  assert.equal(run2.d.result.created, 0, 'second run issues nothing (dedup)');
  assert.equal(run2.d.result.skipped, 2);

  // ردیف‌های صادرشده فقط برای واحدهای تیک‌خورده + مبلغ درست
  const debts = (await j(await handleApi(req('/debts?period=' + r1.period, { token: mT }), env))).d.debts;
  const monthly = debts.filter(d => d.kind === 'monthly');
  assert.equal(monthly.length, 2, 'only ticked units got items');
  assert.ok(monthly.every(d => d.amount === 500000), 'fixed amount applied');

  // مُهر ماه: خواندن پیکربندی نشان می‌دهد ماه جاری اجرا شده
  const g1 = await j(await handleApi(req('/autocharge', { token: mT }), env));
  assert.equal(g1.d.last_period, r1.period, 'month marker set');

  // اعلان فعالیت مدیرکل (v2.22 hooks) — صدور خودکار با بازیگر سیستم ثبت می‌شود
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('admin_notif_cfg', '{\"charge_generate\":\"1\"}')").run();
  const run3 = await j(await handleApi(req('/autocharge/run', { method: 'POST', body: {}, token: mT }), env));
  assert.equal(run3.s, 200);
  const rep = await j(await handleApi(req('/a/notifications?event=charge_generate', { token: adminT }), env));
  const sysRow = rep.d.items.find(n => n.text.includes('صدور خودکار'));
  assert.ok(sysRow, 'system actor row recorded for auto-charge');
  assert.equal(sysRow.actor_role, '', 'actor is system (no user)');
}

// ---------- 24) v2.23.0 — یادآوری دوره‌ای مدیر ساختمان (فقط مدیرکل) ----------
{
  const env = makeEnv();
  const inst = await j(await handleApi(req('/install', {
    method: 'POST', body: { building_name: 'برج یادآور', username: 'Admin', password: 'admin123' }
  }), env));
  const adminT = inst.d.token;
  await j(await handleApi(req('/a/managers', { method: 'POST', body: { username: 'mrmgr', password: 'manager123', full_name: 'مدیر یادآور' }, token: adminT }), env));
  const mT = (await j(await handleApi(req('/auth/login', { method: 'POST', body: { username: 'mrmgr', password: 'manager123' } }), env))).d.token;

  // RBAC
  const m403 = await j(await handleApi(req('/a/mreminders', { token: mT }), env));
  assert.equal(m403.s, 403, 'manager cannot list periodic reminders');

  // ساخت ماهانه + هفتگی + اعتبارسنجی
  const bad0 = await j(await handleApi(req('/a/mreminders', { method: 'POST', body: { title: '', freq: 'monthly' }, token: adminT }), env));
  assert.equal(bad0.s, 400, 'empty title rejected');
  const mk1 = await j(await handleApi(req('/a/mreminders', { method: 'POST', body: { title: 'تسویه صندوق ماه', text: 'لطفاً صندوق را تسویه کنید', freq: 'monthly', month_day: 3 }, token: adminT }), env));
  assert.equal(mk1.s, 201);
  assert.equal(mk1.d.item.freq_label.includes('ماهانه'), true, 'monthly label');
  const mk2 = await j(await handleApi(req('/a/mreminders', { method: 'POST', body: { title: 'تماس با انجمن', freq: 'weekly', weekday: 6 }, token: adminT }), env));
  assert.ok(mk2.d.item.freq_label.includes('جمعه'), 'weekly label shows weekday');
  const mk3 = await j(await handleApi(req('/a/mreminders', { method: 'POST', body: { title: 'بررسی صندوق', freq: 'daily' }, token: adminT }), env));
  assert.equal(mk3.d.item.freq_label, 'هر روز', 'daily label');

  // فهرست + شمار مدیران
  const list = await j(await handleApi(req('/a/mreminders', { token: adminT }), env));
  assert.equal(list.d.items.length, 3);
  assert.equal(list.d.manager_count, 1, 'one active manager');
  assert.equal(list.d.reachable, 0, 'manager has no telegram yet');

  // ارسال آزمایشی — بدون توکن ربات خطای روشن می‌دهد
  const noBot = await j(await handleApi(req(`/a/mreminders/${mk1.d.item.id}/send`, { method: 'POST', body: {}, token: adminT }), env));
  assert.equal(noBot.s, 200);
  assert.equal(noBot.d.reason, 'bot_token_missing', 'clear reason without bot token');

  // ویرایش (تغییر دوره مُهر را پاک می‌کند) + خاموش/روشن + حذف
  const up = await j(await handleApi(req(`/a/mreminders/${mk2.d.item.id}`, { method: 'PUT', body: { freq: 'daily' }, token: adminT }), env));
  assert.equal(up.s, 200); assert.equal(up.d.item.freq, 'daily');
  const tgl = await j(await handleApi(req(`/a/mreminders/${mk3.d.item.id}`, { method: 'PUT', body: { is_active: false }, token: adminT }), env));
  assert.equal(tgl.d.item.is_active, 0, 'deactivated');
  const list2 = await j(await handleApi(req('/a/mreminders', { token: adminT }), env));
  assert.equal(list2.d.items.filter(x => x.is_active).length, 2, 'only active ones counted');
  const del = await j(await handleApi(req(`/a/mreminders/${mk3.d.item.id}`, { method: 'DELETE', body: {}, token: adminT }), env));
  assert.equal(del.s, 200);
  const gone = await j(await handleApi(req(`/a/mreminders/${mk3.d.item.id}`, { method: 'PUT', body: { is_active: true }, token: adminT }), env));
  assert.equal(gone.s, 404, 'deleted reminder is gone');
}

console.log('test-api: ALL PASSED ✓');
