// Demo layer — runs the whole app in the browser with sample data (no server).
// Mirrors the v2 API surface: users/roles, install, admin panel (/a/*), resident
// accounts, PDF stubs. Data persists in localStorage.
import { currentPeriod, periodLabel, isPeriod, addPeriods, tehranDayStartSec, jalaaliMonthLength } from './jalali.js';

const KEY = 'bc_mock_db_v6';
const SCHEMA_V = 7; // v2.11.9: دمو جدول link_codes را هم می‌شناسد // ← با هر تغییر شکل داده‌ی دمو یک واحد اضافه شود
function seed() {
  const period = currentPeriod();
  const prev = addPeriods(period, -1);
  const users = [
    { id: 1, username: 'admin', password: 'Admin@1404', role: 'admin', full_name: 'مدیر اپ', phone: '', unit_id: null, is_active: true, telegram_linked: false, telegram_username: '' },
    { id: 2, username: 'manager', password: 'manager123', role: 'manager', full_name: 'حسین محمدی', phone: '09121234567', unit_id: 3, is_active: true, telegram_linked: false, telegram_username: '' },
    { id: 3, username: 'unit5', password: '1234', role: 'resident', full_name: 'رضا محمدی', phone: '09121110005', unit_id: 5, is_active: true, telegram_linked: true, telegram_username: 'reza_m' },
    { id: 4, username: 'unit1', password: '1234', role: 'resident', full_name: 'علی رضایی', phone: '09121110001', unit_id: 1, is_active: true, telegram_linked: false, telegram_username: 'ali_rezaei' }
  ];
  const units = [
    { id: 1, number: '1', resident_name: 'علی رضایی', phone: '09121110001', area_m2: 85, residents_count: 2, note: '' },
    { id: 2, number: '2', resident_name: 'مریم احمدی', phone: '09121110002', area_m2: 110, residents_count: 3, note: '' },
    { id: 3, number: '3', resident_name: 'حسین محمدی', phone: '09121110003', area_m2: 95, residents_count: 2, note: '' },
    { id: 4, number: '4', resident_name: 'زهرا موسوی', phone: '09121110004', area_m2: 120, residents_count: 4, note: '' },
    { id: 5, number: '5', resident_name: 'رضا محمدی', phone: '09121110005', area_m2: 75, residents_count: 1, note: '' },
    { id: 6, number: '6', resident_name: 'سارا حسینی', phone: '09121110006', area_m2: 130, residents_count: 3, note: '' },
    { id: 7, number: '7', resident_name: 'امیر نادری', phone: '09121110007', area_m2: 100, residents_count: 2, note: '' },
    { id: 8, number: '8', resident_name: 'نرگس صادقی', phone: '09121110008', area_m2: 105, residents_count: 3, note: '' }
  ];
  let debtId = 1;
  const debts = [];
  const paidSet = new Set([1, 2, 3, 4, 5]);
  const partialSet = new Set([6]);
  units.forEach(u => {
    debts.push({
      id: debtId++, unit_id: u.id, kind: 'monthly', expense_id: null, period,
      description: 'شارژ ماه ' + periodLabel(period), amount: 650000,
      paid_amount: paidSet.has(u.id) ? 650000 : (partialSet.has(u.id) ? 300000 : 0),
      status: paidSet.has(u.id) ? 'paid' : (partialSet.has(u.id) ? 'partial' : 'unpaid'),
      paid_at: paidSet.has(u.id) || partialSet.has(u.id) ? Math.floor(Date.now() / 1000) - 259200 : null,
      method: paidSet.has(u.id) ? 'کارت به کارت' : 'نقدی', note: '', created_at: Math.floor(Date.now() / 1000)
    });
  });
  const prevPaid = new Set([1, 2, 3, 4, 5, 6]);
  units.forEach(u => {
    const paid = prevPaid.has(u.id);
    debts.push({
      id: debtId++, unit_id: u.id, kind: 'monthly', expense_id: null, period: prev,
      description: 'شارژ ماه ' + periodLabel(prev), amount: 600000,
      paid_amount: paid ? 600000 : 0, status: paid ? 'paid' : 'unpaid',
      paid_at: paid ? Math.floor(Date.now() / 1000) - 2600000 : null,
      method: paid ? 'پایا' : '', note: '', created_at: Math.floor(Date.now() / 1000) - 2900000
    });
  });
  const expenses = [
    { id: 1, title: 'هزینه نظافت', category: 'نظافت', amount: 1200000, period, split_mode: 'equal', spent_at: Math.floor(Date.now() / 1000) - 432000, note: '' },
    { id: 2, title: 'قبض برق مشترک', category: 'برق', amount: 800000, period, split_mode: 'area', spent_at: Math.floor(Date.now() / 1000) - 172800, note: '' }
  ];
  const per = Math.round(1200000 / units.length);
  units.forEach(u => debts.push({
    id: debtId++, unit_id: u.id, kind: 'expense', expense_id: 1, period,
    description: 'سهم هزینه: هزینه نظافت', amount: per, paid_amount: 0, status: 'unpaid',
    paid_at: null, method: '', note: '', created_at: Math.floor(Date.now() / 1000) - 432000
  }));
  const totalArea = units.reduce((s, u) => s + u.area_m2, 0);
  units.forEach(u => {
    const share = Math.round(800000 * u.area_m2 / totalArea);
    debts.push({
      id: debtId++, unit_id: u.id, kind: 'expense', expense_id: 2, period,
      description: 'سهم هزینه: قبض برق مشترک', amount: share, paid_amount: 0, status: 'unpaid',
      paid_at: null, method: '', note: '', created_at: Math.floor(Date.now() / 1000) - 172800
    });
  });
  return {
    v: SCHEMA_V,
    seq: { users: 5, units: 9, debts: debtId, expenses: 3, polls: 2, poll_votes: 3, visits: 6, bot_messages: 8 },
    building_name: 'برج نگین (دمو)',
    settings: {
      address: 'اصفهان، خیابان سعادت‌آباد، پلاک ۱۲',
      phone: '09131234567',
      bank_card: '6037-9975-1234-5678',
      bank_owner: 'حسین محمدی (مدیر ساختمان)',
      default_monthly_amount: 650000
    },
    polls: [
      {
        id: 1, question: 'رنگ‌آمیزی راه‌پله‌ها چه رنگی باشد؟',
        options: JSON.stringify(['کرم', 'خاکستری', 'آبی']),
        status: 'open', created_by: 2,
        created_at: Math.floor(Date.now() / 1000) - 86400 * 2, closed_at: null
      }
    ],
    poll_votes: [
      { id: 1, poll_id: 1, unit_id: 1, user_id: 4, option_index: 0, created_at: Math.floor(Date.now() / 1000) - 86400 },
      { id: 2, poll_id: 1, unit_id: 5, user_id: 3, option_index: 2, created_at: Math.floor(Date.now() / 1000) - 43200 }
    ],
    // گزارش ورود به اپ (دمو): چند بازدید نمونه — امروز، دیروز و دو روز قبل
    visits: (() => {
      const t = Math.floor(Date.now() / 1000);
      return [
        { id: 1, user_id: 3, kind: 'open', via: 'telegram', created_at: t - 3600 },
        { id: 2, user_id: 3, kind: 'login', via: 'telegram', created_at: t - 3660 },
        { id: 3, user_id: 4, kind: 'login', via: 'web', created_at: t - 1800 },
        { id: 4, user_id: 2, kind: 'open', via: 'telegram', created_at: t - 86400 - 3600 },
        { id: 5, user_id: 4, kind: 'open', via: 'telegram', created_at: t - 86400 * 2 - 7200 }
      ];
    })(),
    // گزارش پیام‌های بات (دمو): پیام‌های چت خصوصی و دستورهای گروهی نمونه
    bot_messages: (() => {
      const t = Math.floor(Date.now() / 1000);
      return [
        { id: 1, chat_id: 9001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /start', text: '/start', created_at: t - 7200 },
        { id: 2, chat_id: 9002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'command', title: 'فرمان /start', text: '/start', created_at: t - 5400 },
        { id: 3, chat_id: 9002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'text', title: 'پیام متنی', text: 'سلام، شارژ این ماه چقدر شد؟', created_at: t - 5340 },
        { id: 4, chat_id: 9003, chat_type: 'private', tg_user_id: 7003, username: '', full_name: 'مریم احمدی', kind: 'text', title: 'پیام متنی', text: 'وقت بخیر، رسید پرداخت را کجا بفرستم؟', created_at: t - 43000 },
        { id: 5, chat_id: -1001200, chat_type: 'supergroup', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /app', text: '/app', created_at: t - 90000 },
        { id: 6, chat_id: 9004, chat_type: 'private', tg_user_id: 7004, username: 'sara_h', full_name: 'سارا حسینی', kind: 'other', title: 'رسانه یا سایر', text: '', created_at: t - 180000 },
        { id: 7, chat_id: 9001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /help', text: '/help', created_at: t - 260000 }
      ];
    })(),
    users, units, debts, expenses
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const db = JSON.parse(raw);
      // data from an older demo version (before polls, …) must not crash the app —
      // validate shape; otherwise re-seed fresh sample data
      const okShape = db && db.v === SCHEMA_V
        && Array.isArray(db.users) && Array.isArray(db.units)
        && Array.isArray(db.debts) && Array.isArray(db.expenses)
        && Array.isArray(db.polls) && Array.isArray(db.poll_votes)
        && Array.isArray(db.visits) && Array.isArray(db.bot_messages)
        && db.settings && typeof db.building_name === 'string';
      if (okShape) { db.sessions = db.sessions || {}; return db; }
    }
  } catch { /* ignore */ }
  const db = seed();
  save(db);
  return db;
}
function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* ignore */ }
}

export const MOCK_STATE = {
  // null → login screen is shown; otherwise a user object from db.users
  user: null
};

// v2.11.11 — demo mirror of the server-side session store: tokens issued by
// «login» stay valid across page reloads (like real D1-backed sessions), one
// entry per login, so the multi-account memory can be demonstrated for real.
function mockSessions(db) {
  db.sessions = db.sessions || {};
  return db.sessions;
}

export function mockReset() {
  localStorage.removeItem(KEY);
  MOCK_STATE.user = null;
}

const ok = data => ({ __ok: true, ...(data || {}) });
const err = (message, status = 400, code = 'error') => ({ __ok: false, error: message, status, code });
const pub = u => ({
  id: u.id, username: u.username, role: u.role, full_name: u.full_name || '',
  phone: u.phone || '', unit_id: u.unit_id || null,
  telegram_linked: Boolean(u.telegram_linked), telegram_username: u.telegram_username || '',
  is_active: Boolean(u.is_active), unit_number: u.unit_number || null
});
// store telegram usernames without the leading «@» (same as the server)
const normTg = v => String(v ?? '').trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@+/, '').trim().slice(0, 32);
const validTg = s => s === '' || /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s);
const num = v => Math.round(Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0);

// v2.11.9 — demo mirror of the one-time Telegram link code (کد اتصال)
// v2.11.10 — اعتبار قابل انتخاب (whitelist مشترک با سرور: ۱ ساعت تا ۳۰ روز)
const LINK_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const LINK_TTL_HOURS = [1, 6, 24, 72, 168, 360, 720];
const LINK_TTL_ERROR = 'اعتبار انتخابی معتبر نیست؛ گزینه‌های مجاز: ۱ ساعت، ۶ ساعت، ۱ روز، ۳ روز، ۷ روز، ۱۵ روز و ۳۰ روز';
function mockLinkCode(db, u, ttlHours) {
  const ttl = (ttlHours === undefined || ttlHours === null || ttlHours === '') ? 168
    : LINK_TTL_HOURS.includes(Math.round(Number(ttlHours))) ? Math.round(Number(ttlHours)) : null;
  if (ttl == null) return { __err: LINK_TTL_ERROR };
  const bytes = new Uint8Array(8);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  let code = '';
  for (let i = 0; i < 8; i++) code += LINK_ALPHABET[bytes[i] % LINK_ALPHABET.length];
  const expiresAt = Date.now() + ttl * 3600e3;
  db.link_codes = db.link_codes || [];
  // rotation: previous unused codes die (same rule as the server)
  db.link_codes.forEach(c => { if (c.user_id === u.id && !c.used_at) c.revoked_at = Date.now(); });
  db.link_codes.push({ code, user_id: u.id, created_at: Date.now(), expires_at: expiresAt });
  save(db);
  return { ok: true, code, link: 'https://t.me/DemoBuildingBot?start=' + code, expires_at: expiresAt, ttl_hours: ttl, telegram_linked: Boolean(u.telegram_linked) };
}

function unitDebt(db, unitId) {
  const items = db.debts.filter(d => d.unit_id === unitId);
  const issued = items.reduce((s, d) => s + d.amount, 0);
  const paid = items.reduce((s, d) => s + d.paid_amount, 0);
  return { issued, paid, debt: Math.max(0, issued - paid) };
}

function unitSummary(db, u) {
  const t = unitDebt(db, u.id);
  const acc = db.users.find(x => x.role === 'resident' && x.unit_id === u.id);
  return {
    ...u,
    issued: t.issued, paid: t.paid, debt: t.debt,
    has_account: Boolean(acc),
    account_id: acc ? acc.id : null,
    account_username: acc ? acc.username : null,
    account_active: acc ? Boolean(acc.is_active) : false,
    account_telegram: acc && acc.telegram_linked ? 1 : null
  };
}

function dashboardData(db, period) {
  const issued = db.debts.reduce((s, d) => s + d.amount, 0);
  const collected = db.debts.reduce((s, d) => s + d.paid_amount, 0);
  const mItems = db.debts.filter(d => d.period === period);
  const debtors = new Set(db.debts.filter(d => d.amount > d.paid_amount).map(d => d.unit_id)).size;
  const jy = period.slice(0, 4);
  const seriesMap = {};
  db.debts.forEach(d => {
    if (!d.period.startsWith(jy)) return;
    seriesMap[d.period] = seriesMap[d.period] || { period: d.period, issued: 0, collected: 0 };
    seriesMap[d.period].issued += d.amount;
    seriesMap[d.period].collected += d.paid_amount;
  });
  const recent = db.debts.filter(d => d.paid_amount > 0)
    .sort((a, b) => (b.paid_at || 0) - (a.paid_at || 0)).slice(0, 8)
    .map(d => {
      const u = db.units.find(x => x.id === d.unit_id);
      return { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' };
    });
  const top = db.units.map(u => ({ number: u.number, resident_name: u.resident_name, debt: unitDebt(db, u.id).debt }))
    .filter(x => x.debt > 0).sort((a, b) => b.debt - a.debt).slice(0, 5);
  return {
    period,
    totals: { issued, collected, outstanding: Math.max(0, issued - collected) },
    month: {
      issued: mItems.reduce((s, d) => s + d.amount, 0),
      collected: mItems.reduce((s, d) => s + d.paid_amount, 0)
    },
    units_count: db.units.length,
    debtors_count: debtors,
    series: Object.values(seriesMap).sort((a, b) => a.period.localeCompare(b.period)),
    recent, top
  };
}

export async function mockFetch(fullPath, method = 'GET', body = {}, token = '') {
  const [path, qsRaw] = String(fullPath).split('?');
  const q = new URLSearchParams(qsRaw || '');
  await new Promise(r => setTimeout(r, 120)); // simulate latency

  const db = load();
  const sessions = mockSessions(db);
  // restore a remembered session from the presented token (server-side validity)
  if (!MOCK_STATE.user && token && sessions[token] !== undefined) {
    MOCK_STATE.user = db.users.find(u => u.id === sessions[token]) || null;
  }
  const me = MOCK_STATE.user && db.users.find(u => u.id === MOCK_STATE.user.id);

  // ---------- public ----------
  if (path === '/auth/login' && method === 'POST') {
    const uname = String(body.username || '').trim().toLowerCase();
    const u = db.users.find(x => x.username.toLowerCase() === uname);
    // v2.11.8 mirror: failed attempts recorded (brute-force audit demo)
    db.login_attempts = db.login_attempts || [];
    if (!u || u.password !== body.password) {
      db.login_attempts.push({ id: db.seq.la || 1, username: uname || '—', ip: 'demo', ok: 0, created_at: Math.floor(Date.now() / 1000) });
      db.seq.la = (db.seq.la || 1) + 1;
      save(db);
      return err('نام کاربری یا رمز عبور اشتباه است', 401);
    }
    if (!u.is_active) return err('این حساب غیرفعال شده است', 403);
    db.login_attempts = db.login_attempts.filter(x => !(x.username === uname && x.ok === 0));
    MOCK_STATE.user = { ...u };
    sessions['mock-token-' + u.id] = u.id;
    // visit log (گزارش ورود) — same behavior as the server
    db.visits = db.visits || [];
    db.visits.push({ id: db.seq.visits || 1, user_id: u.id, kind: 'login', via: 'web', created_at: Math.floor(Date.now() / 1000) });
    db.seq.visits = (db.seq.visits || 1) + 1;
    save(db);
    return ok({ token: 'mock-token-' + u.id, user: pub(u), linked_telegram: false });
  }
  if (path === '/auth/telegram' && method === 'POST') return err('در حالت نمایشی، از فرم ورود استفاده کنید', 401, 'not_linked');
  if (path === '/install-status') return ok({ installed: true, version: '2.11.11' });
  if (path === '/health') return ok({ ok: true, version: '2.11.11' });

  // ---------- auth guard ----------
  const guard = () => (!me ? err('ابتدا وارد شوید', 401) : null);
  const roleGuard = (...roles) => (!me ? err('ابتدا وارد شوید', 401)
    : roles.includes(me.role) ? null : err('شما به این بخش دسترسی ندارید', 403));

  if (path === '/auth/me') {
    const g = guard(); if (g) return g;
    const unit = me.unit_id ? db.units.find(u => u.id === me.unit_id) : null;
    // v2.11.11 mirror: sliding session renewal — rotate the demo token on open
    // (and move the server-side session to it), like reissueSessionIfNeeded
    let refreshed = null;
    if (token) {
      refreshed = 'mock-token-' + me.id + '-r' + Math.floor(Date.now() / 60000);
      if (sessions[token] !== undefined) {
        // move the session to the rotated token — when the minute bucket has
        // not changed, refreshed === token and the entry must be kept as-is
        if (refreshed !== token) { sessions[refreshed] = me.id; delete sessions[token]; }
        save(db);
      }
    }
    return ok({
      user: pub(me), role: me.role,
      unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name, area_m2: unit.area_m2, residents_count: unit.residents_count } : null,
      settings: db.settings,
      current_period: currentPeriod(),
      bot_configured: false,
      app_url: location.origin,
      ...(refreshed ? { refreshed_token: refreshed } : {})
    });
  }
  if (path === '/auth/change-password' && method === 'POST') {
    const g = guard(); if (g) return g;
    if (me.password !== body.old_password) return err('رمز عبور فعلی اشتباه است', 403);
    if (String(body.new_password || '').length < 6) return err('رمز جدید باید حداقل ۶ کاراکتر باشد');
    me.password = body.new_password;
    // v2.11.11 mirror: fresh token for this device (session moves with it);
    // every OTHER session of this user dies (lock 4)
    const newTok = 'mock-token-' + me.id;
    if (token) delete sessions[token];
    for (const k of Object.keys(sessions)) if (sessions[k] === me.id) delete sessions[k];
    sessions[newTok] = me.id;
    save(db);
    return ok({ ok: true, token: newTok, revoked_old_sessions: true });
  }
  if (path === '/auth/logout') {
    if (token && sessions[token] !== undefined) { delete sessions[token]; save(db); }
    MOCK_STATE.user = null;
    return ok({ ok: true });
  }

  if (path === '/settings/public') return ok({ settings: db.settings });

  // ---------- manager-only finance (total debt is for the building manager) ----------
  if (path === '/dashboard') {
    const g = roleGuard('manager'); if (g) return g;
    const period = isPeriod(q.get('period')) ? q.get('period') : currentPeriod();
    return ok(dashboardData(db, period));
  }
  if (path === '/reports/year') {
    const g = roleGuard('manager'); if (g) return g;
    const jy = (q.get('jy') || currentPeriod()).slice(0, 4);
    const seriesMap = {};
    db.debts.forEach(d => {
      if (!d.period.startsWith(jy)) return;
      seriesMap[d.period] = seriesMap[d.period] || { period: d.period, issued: 0, collected: 0, items: 0 };
      seriesMap[d.period].issued += d.amount;
      seriesMap[d.period].collected += d.paid_amount;
      seriesMap[d.period].items++;
    });
    const by_unit = db.units.map(u => {
      const t = unitDebt(db, u.id);
      return { id: u.id, number: u.number, resident_name: u.resident_name, area_m2: u.area_m2, issued: t.issued, paid: t.paid };
    }).sort((a, b) => (b.issued - b.paid) - (a.issued - a.paid));
    return ok({ jy, series: Object.values(seriesMap).sort((a, b) => a.period.localeCompare(b.period)), by_unit });
  }
  if (path === '/export') {
    const g = roleGuard('manager'); if (g) return g;
    const type = q.get('type') || 'debtors';
    if (type === 'backup') {
      // full-fidelity JSON backup — same shape as the server (v2.11.0)
      const payload = {
        app: 'building-charges', version: '2.11.11',
        exported_at: new Date().toISOString(),
        units: db.units, debts: db.debts, expenses: db.expenses,
        users: db.users, polls: db.polls, poll_votes: db.poll_votes,
        settings: Object.entries(db.settings || {}).map(([key, value]) => ({ key, value }))
      };
      return ok({ __download: { content: JSON.stringify(payload, null, 2), mime: 'application/json', filename: 'building-backup-' + Date.now() + '.json' } });
    }
    let csv = '\uFEFF';
    if (type === 'debtors') {
      csv += 'شماره واحد,ساکن,تلفن,مانده بدهی\n';
      db.units.map(u => ({ ...u, debt: unitDebt(db, u.id).debt })).filter(u => u.debt > 0)
        .forEach(u => { csv += `${u.number},${u.resident_name || ''},${u.phone || ''},${u.debt}\n`; });
    } else {
      csv += 'نوع,مقدار\nنمونه,۱\n';
    }
    return ok({ __download: { content: csv, mime: 'text/csv', filename: type + '.csv' } });
  }

  // ---------- import backup (بازیابی) — v2.11.0 (demo mirror of the server) ----------
  if (path === '/import' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    if (!body || body.app !== 'building-charges' || !Array.isArray(body.units) || !Array.isArray(body.debts)
      || !Array.isArray(body.expenses) || !Array.isArray(body.users) || !Array.isArray(body.settings)) {
      return err('ساختار فایل پشتیبان کامل نیست');
    }
    // snapshot current passwords by username (fallback for old backups)
    const curPass = new Map(db.users.map(u => [u.username, u.password]));
    const admins = db.users.filter(u => u.role === 'admin');
    const skipKeys = new Set(['session_secret', 'bot_token']);
    const userRows = [];
    const seen = new Set();
    for (const u of body.users) {
      if (!u || u.role === 'admin') continue;
      const uname = String(u.username ?? '').trim().toLowerCase();
      if (!uname || seen.has(uname)) continue;
      seen.add(uname);
      userRows.push({
        id: Number(u.id) || 0, username: uname,
        password: String(u.password || u.password_hash || curPass.get(uname) || ('!' + Math.random().toString(36).slice(2))),
        role: u.role === 'manager' ? 'manager' : 'resident',
        full_name: String(u.full_name ?? ''), phone: String(u.phone ?? ''),
        unit_id: u.unit_id ? Number(u.unit_id) : null,
        telegram_linked: Boolean(u.telegram_linked),
        telegram_user_id: u.telegram_user_id ? Number(u.telegram_user_id) : null,
        telegram_username: String(u.telegram_username ?? ''),
        is_active: (u.is_active === 0 || u.is_active === false) ? 0 : 1,
        created_at: Number(u.created_at) || Math.floor(Date.now() / 1000)
      });
    }
    db.units = body.units.map(u => ({ ...u }));
    db.debts = body.debts.map(d => ({ ...d }));
    db.expenses = body.expenses.map(x => ({ ...x }));
    db.polls = Array.isArray(body.polls) ? body.polls.map(p => ({ ...p })) : [];
    db.poll_votes = Array.isArray(body.poll_votes) ? body.poll_votes.map(v => ({ ...v })) : [];
    db.users = [...admins, ...userRows];
    for (const s of body.settings) {
      if (!s || !s.key || skipKeys.has(String(s.key))) continue;
      db.settings = db.settings || {};
      db.settings[s.key] = s.value;
    }
    const maxId = rows => rows.reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0);
    db.seq = db.seq || {};
    db.seq.units = maxId(db.units);
    db.seq.debts = maxId(db.debts);
    db.seq.expenses = maxId(db.expenses);
    db.seq.users = maxId(db.users);
    db.seq.polls = maxId(db.polls);
    db.seq.poll_votes = maxId(db.poll_votes);
    save(db);
    return ok({ imported: { units: db.units.length, debts: db.debts.length, expenses: db.expenses.length, users: userRows.length, polls: db.polls.length, poll_votes: db.poll_votes.length, exported_at: body.exported_at || null } });
  }

  // ---------- manager ----------
  if (path === '/units' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    return ok({ units: db.units.map(u => unitSummary(db, u)) });
  }
  if (path === '/units' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const number = String(body.number || '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim();
    if (!number) return err('شماره واحد الزامی است');
    if (db.units.some(u => u.number === number)) return err('شماره واحد تکراری است', 409);
    const unit = {
      id: db.seq.units++, number,
      resident_name: String(body.resident_name || ''), phone: String(body.phone || ''),
      area_m2: num(body.area_m2), residents_count: Math.max(1, num(body.residents_count) || 1),
      note: String(body.note || '')
    };
    db.units.push(unit);
    save(db);
    return ok({ unit }, 201);
  }
  if (path.startsWith('/units/') && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const u = db.units.find(x => x.id === id);
    if (!u) return err('واحد پیدا نشد', 404);
    Object.assign(u, {
      number: body.number !== undefined ? String(body.number).trim().replace(/^واحد[\s._\-–—]*/u, '').trim() : u.number,
      resident_name: body.resident_name !== undefined ? String(body.resident_name) : u.resident_name,
      phone: body.phone !== undefined ? String(body.phone) : u.phone,
      area_m2: body.area_m2 !== undefined ? num(body.area_m2) : u.area_m2,
      residents_count: body.residents_count !== undefined ? Math.max(1, num(body.residents_count) || 1) : u.residents_count,
      note: body.note !== undefined ? String(body.note) : u.note
    });
    save(db);
    return ok({ unit: u });
  }
  if (path.startsWith('/units/') && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    db.units = db.units.filter(u => u.id !== id);
    db.debts = db.debts.filter(d => d.unit_id !== id);
    db.users = db.users.filter(u => u.unit_id !== id);
    save(db);
    return ok({ ok: true });
  }

  if (path === '/residents' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    const unitId = Number(q.get('unit_id') || 0);
    const list = db.users.filter(u => u.role === 'resident' && (!unitId || u.unit_id === unitId))
      .map(u => ({ ...pub(u), unit_number: (db.units.find(x => x.id === u.unit_id) || {}).number || null }));
    return ok({ residents: list });
  }
  if (path === '/residents' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const username = String(body.username || '').trim().toLowerCase();
    const unitId = num(body.unit_id);
    const tgU = normTg(body.telegram_username);
    if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) return err('نام کاربری نامعتبر است (۳ تا ۳۲ کاراکتر لاتین)');
    if (String(body.password || '').length < 6) return err('رمز عبور باید حداقل ۶ کاراکتر باشد');
    if (!validTg(tgU)) return err('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
    const unit = db.units.find(u => u.id === unitId);
    if (!unit) return err('واحد پیدا نشد', 404);
    if (db.users.some(u => u.role === 'resident' && u.unit_id === unitId)) return err('این واحد قبلاً حساب ساکن دارد', 409);
    if (db.users.some(u => u.username.toLowerCase() === username)) return err('این نام کاربری قبلاً استفاده شده است', 409);
    const user = {
      id: db.seq.users++, username, password: String(body.password),
      role: 'resident', full_name: String(body.full_name || unit.resident_name || ''),
      phone: String(body.phone || unit.phone || ''), unit_id: unitId,
      is_active: true, telegram_linked: false, telegram_username: tgU
    };
    db.users.push(user);
    save(db);
    return ok({ resident: pub(user) }, 201);
  }
  if (path.startsWith('/residents/') && path.endsWith('/message') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const u = db.users.find(x => x.id === id && x.role === 'resident');
    if (!u) return err('حساب ساکن پیدا نشد', 404);
    if (!String(body.text || '').trim()) return err('متن پیام خالی است', 400, 'empty_text');
    if (!u.telegram_linked) return err('این کاربر هنوز به تلگرام متصل نشده است؛ به‌محض اولین استارت ربات توسط او (یا ورودش به اپ داخل تلگرام با نام کاربری و رمز)، اتصال انجام می‌شود', 409, 'not_linked');
    save(db);
    return ok({ ok: true, user: { id: u.id, username: u.username, full_name: u.full_name } });
  }
  if (path.startsWith('/residents/') && path.endsWith('/linkcode') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const u = db.users.find(x => x.id === id && x.role === 'resident');
    if (!u) return err('حساب ساکن پیدا نشد', 404);
    if (!u.is_active) return err('این حساب کاربری غیرفعال است؛ ابتدا آن را فعال کنید', 409);
    const r = mockLinkCode(db, u, (body || {}).ttl_hours); // v2.11.10 — اعتبار قابل انتخاب
    if (r.__err) return err(r.__err, 400);
    return ok(r);
  }
  if (path.startsWith('/residents/') && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const u = db.users.find(x => x.id === id && x.role === 'resident');
    if (!u) return err('حساب ساکن پیدا نشد', 404);
    if (body.username !== undefined) {
      const un = String(body.username).trim().toLowerCase();
      if (!/^[a-zA-Z0-9_.]{3,32}$/.test(un)) return err('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
      if (un !== u.username && db.users.some(x => x.username.toLowerCase() === un)) return err('این نام کاربری قبلاً استفاده شده است', 409);
      u.username = un;
    }
    if (body.full_name !== undefined) u.full_name = String(body.full_name);
    if (body.phone !== undefined) u.phone = String(body.phone);
    if (body.telegram_username !== undefined) {
      const tgU = normTg(body.telegram_username);
      if (!validTg(tgU)) return err('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
      u.telegram_username = tgU;
    }
    if (body.is_active !== undefined) u.is_active = body.is_active ? 1 : 0;
    if (body.password) {
      if (String(body.password).length < 6) return err('رمز عبور باید حداقل ۶ کاراکتر باشد');
      u.password = String(body.password);
    }
    save(db);
    return ok({ resident: pub(u) });
  }
  if (path.startsWith('/residents/') && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    db.users = db.users.filter(u => !(u.id === id && u.role === 'resident'));
    save(db);
    return ok({ ok: true });
  }

  if (path === '/debts' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    let list = db.debts.slice();
    if (q.get('period')) list = list.filter(d => d.period === q.get('period'));
    if (q.get('unit_id')) list = list.filter(d => d.unit_id === Number(q.get('unit_id')));
    if (q.get('status') === 'unpaid') list = list.filter(d => d.status !== 'paid');
    if (q.get('status') === 'paid') list = list.filter(d => d.status === 'paid');
    list.sort((a, b) => b.period.localeCompare(a.period));
    return ok({
      debts: list.map(d => {
        const u = db.units.find(x => x.id === d.unit_id);
        return { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' };
      })
    });
  }
  if (path === '/debts' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const amount = num(body.amount);
    if (!isPeriod(body.period)) return err('ماه نامعتبر است');
    if (amount <= 0) return err('مبلغ باید بزرگ‌تر از صفر باشد');
    const debt = {
      id: db.seq.debts++, unit_id: num(body.unit_id), kind: 'custom', expense_id: null,
      period: body.period, description: String(body.description || 'قلم دستی'),
      amount, paid_amount: 0, status: 'unpaid', paid_at: null, method: '', note: '',
      created_at: Math.floor(Date.now() / 1000)
    };
    db.debts.push(debt);
    save(db);
    return ok({ debt }, 201);
  }
  if (path === '/charges/generate' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const period = String(body.period || '');
    const mode = body.mode || 'fixed';
    const amount = num(body.amount);
    if (!isPeriod(period)) return err('ماه نامعتبر است');
    if (amount <= 0) return err('مبلغ باید بزرگ‌تر از صفر باشد');
    // v2.11.3: صدور فقط برای یک یا چند واحد انتخابی (demo mirror of the server)
    let targetUnits = db.units;
    if (Array.isArray(body.unit_ids) && body.unit_ids.length) {
      const wanted = new Set(body.unit_ids.map(Number));
      const picked = db.units.filter(u => wanted.has(u.id));
      if (!picked.length) return err('هیچ‌کدام از واحدهای انتخاب‌شده پیدا نشد');
      targetUnits = picked;
    }
    let created = 0, skipped = 0;
    const noArea = [];
    targetUnits.forEach(u => {
      if (db.debts.some(d => d.unit_id === u.id && d.period === period && d.kind === 'monthly')) { skipped++; return; }
      let amt = 0;
      if (mode === 'fixed') amt = amount;
      else if (mode === 'person') amt = Math.round(amount * (u.residents_count || 1));
      else if (mode === 'area') {
        if (!u.area_m2) { noArea.push(u.number); return; }
        amt = Math.round(amount * u.area_m2);
      }
      if (amt > 0) {
        db.debts.push({
          id: db.seq.debts++, unit_id: u.id, kind: 'monthly', expense_id: null, period,
          description: 'شارژ ماه ' + periodLabel(period), amount, paid_amount: 0,
          status: 'unpaid', paid_at: null, method: '', note: '', created_at: Math.floor(Date.now() / 1000)
        });
        created++;
      }
    });
    save(db);
    return ok({ created, skipped, no_area: noArea });
  }
  if (path.endsWith('/pay') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const d = db.debts.find(x => x.id === id);
    if (!d) return err('قلم بدهی پیدا نشد', 404);
    const remaining = d.amount - d.paid_amount;
    const amt = body.amount == null ? remaining : num(body.amount);
    if (!(amt > 0)) return err('مبلغ نامعتبر است');
    if (amt > remaining) return err('مبلغ بیشتر از مانده بدهی است');
    d.paid_amount += amt;
    d.status = d.paid_amount >= d.amount ? 'paid' : 'partial';
    d.paid_at = body.date ? num(body.date) : Math.floor(Date.now() / 1000);
    d.method = String(body.method || '');
    if (body.note) d.note = String(body.note).slice(0, 200);
    save(db);
    const u = db.units.find(x => x.id === d.unit_id);
    return ok({ debt: { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' } });
  }
  if (path.endsWith('/unpay') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const d = db.debts.find(x => x.id === id);
    if (!d) return err('قلم بدهی پیدا نشد', 404);
    d.paid_amount = 0; d.status = 'unpaid'; d.paid_at = null; d.method = '';
    save(db);
    const u = db.units.find(x => x.id === d.unit_id);
    return ok({ debt: { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' } });
  }
  if (/^\/debts\/\d+$/.test(path) && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    db.debts = db.debts.filter(d => d.id !== id);
    save(db);
    return ok({ ok: true });
  }

  if (path === '/expenses' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    const period = q.get('period');
    const list = db.expenses.filter(e => !period || e.period === period).map(e => ({
      ...e,
      share_count: db.debts.filter(d => d.expense_id === e.id).length,
      collected: db.debts.filter(d => d.expense_id === e.id).reduce((s, d) => s + d.paid_amount, 0)
    }));
    return ok({ expenses: list });
  }
  if (path === '/expenses' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const amount = num(body.amount);
    if (!String(body.title || '').trim()) return err('عنوان هزینه الزامی است');
    if (!isPeriod(body.period)) return err('ماه نامعتبر است');
    if (amount <= 0) return err('مبلغ باید بزرگ‌تر از صفر باشد');
    const id = db.seq.expenses++;
    const splitMode = body.split_mode === 'area' ? 'area' : 'equal';
    db.expenses.push({
      id, title: String(body.title).trim(), category: String(body.category || 'سایر'),
      amount, period: body.period, split_mode: splitMode,
      spent_at: Math.floor(Date.now() / 1000), note: ''
    });
    const totalArea = db.units.reduce((s, u) => s + (u.area_m2 || 0), 0);
    let shareCount = 0;
    db.units.forEach(u => {
      const share = splitMode === 'area' && totalArea > 0
        ? Math.round(amount * u.area_m2 / totalArea)
        : Math.floor(amount / db.units.length);
      if (share > 0) {
        db.debts.push({
          id: db.seq.debts++, unit_id: u.id, kind: 'expense', expense_id: id,
          period: body.period, description: 'سهم هزینه: ' + String(body.title).trim(),
          amount: share, paid_amount: 0, status: 'unpaid', paid_at: null, method: '', note: '',
          created_at: Math.floor(Date.now() / 1000)
        });
        shareCount++;
      }
    });
    save(db);
    return ok({ expense_id: id, split_mode: splitMode, share_count: shareCount, distributed: amount }, 201);
  }
  if (/^\/expenses\/\d+$/.test(path) && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    if (db.debts.some(d => d.expense_id === id && d.paid_amount > 0)) {
      return err('برای حذف این هزینه، ابتدا پرداخت‌های مرتبط را لغو کنید', 409);
    }
    db.debts = db.debts.filter(d => d.expense_id !== id);
    db.expenses = db.expenses.filter(e => e.id !== id);
    save(db);
    return ok({ ok: true });
  }

  if (path === '/notify/preview') {
    const g = roleGuard('manager'); if (g) return g;
    const debtorUnits = new Set(db.debts.filter(d => d.amount > d.paid_amount).map(d => d.unit_id)).size;
    const linked = db.users.filter(u => u.is_active && u.telegram_linked);
    return ok({
      bot_configured: true,
      linked_users: linked.length,
      linked_residents: linked.filter(u => u.role === 'resident').length,
      debtor_units: debtorUnits
    });
  }
  if (path === '/notify/reminders' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    // demo: simulate sending to every linked user whose unit is in debt and
    // log the outgoing rows so the bot-messages report shows them (v2.11.6)
    const debtorUnits = new Set(db.debts.filter(d => d.amount > d.paid_amount).map(d => d.unit_id));
    const targets = db.users.filter(u => u.is_active && u.telegram_linked && debtorUnits.has(u.unit_id)).slice(0, 40);
    const t = Math.floor(Date.now() / 1000);
    let nextId = db.bot_messages.reduce((m, x) => Math.max(m, x.id), 0);
    for (const u of targets) {
      const unit = db.units.find(x => x.id === u.unit_id);
      const debt = db.debts.filter(d => d.unit_id === u.unit_id).reduce((s, d) => s + (d.amount - d.paid_amount), 0);
      db.bot_messages.push({
        id: ++nextId, chat_id: 9000 + (u.id || 0), chat_type: 'out', tg_user_id: 7000 + (u.id || 0),
        username: '', full_name: u.full_name || '', kind: 'out', title: 'یادآوری بدهی',
        text: `${db.settings.building_name || 'ساختمان'} — واحد ${unit ? unit.number : '—'}\nمانده بدهی شما ${debt.toLocaleString('fa-IR')} تومان است.`,
        created_at: t
      });
    }
    save(db);
    return ok({ sent: targets.length, failed: 0, targets: targets.length, demo: true });
  }
  if (path === '/notify/announce' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    if (!String(body.text || '').trim()) return err('متن اعلان را وارد کنید');
    const targets = db.users.filter(u => u.is_active && u.telegram_linked).slice(0, 40);
    const t = Math.floor(Date.now() / 1000);
    let nextId = db.bot_messages.reduce((m, x) => Math.max(m, x.id), 0);
    for (const u of targets) {
      db.bot_messages.push({
        id: ++nextId, chat_id: 9000 + (u.id || 0), chat_type: 'out', tg_user_id: 7000 + (u.id || 0),
        username: '', full_name: u.full_name || '', kind: 'out', title: 'اعلان همگانی',
        text: `${db.settings.building_name || 'ساختمان'}\n\n${String(body.text || '')}`,
        created_at: t
      });
    }
    save(db);
    return ok({ sent: targets.length, failed: 0, targets: targets.length, demo: true });
  }

  // ---------- automatic monthly reminder (یادآوری خودکار) ----------
  const AR_DEFAULT_TEXT =
    '{building}\n' +
    '{name} عزیز، مانده بدهی واحد {unit} مبلغ {amount} تومان است.\n' +
    'لطفاً تا پایان {month} نسبت به تسویه اقدام فرمایید.\n' +
    'با تشکر 🙏';
  const AR_MAX_SLOTS = 10;
  const arParseLast = v => {
    const m = /^(\d{4}-(?:0[1-9]|1[0-2]))(?:#(\d{1,2}))?$/.exec(String(v || ''));
    if (!m) return { period: '', k: 0 };
    return { period: m[1], k: m[2] !== undefined ? Number(m[2]) : 999 };
  };
  const arComputeDays = (count, day, monthLen) => {
    const n = Math.min(AR_MAX_SLOTS, Math.max(1, Math.round(Number(count) || 1)));
    const d0 = Math.min(29, Math.max(1, Math.round(Number(day) || 1)));
    const L = Math.min(31, Math.max(29, Math.round(Number(monthLen) || 30)));
    if (n === 1) return [d0];
    const set = new Set();
    for (let i = 0; i < n; i++) set.add(Math.min(L, Math.max(1, d0 + Math.round(i * (L - d0) / (n - 1)))));
    return [...set].sort((a, b) => a - b);
  };
  const arMonthLen = () => {
    const [y, m] = currentPeriod().split('-').map(Number);
    return jalaaliMonthLength(y, m);
  };
  const mockAutoCfg = () => {
    const mark = arParseLast(db.settings.auto_reminder_last || '');
    return {
      enabled: db.settings.auto_reminder_enabled === '1',
      day: Math.min(29, Math.max(1, Math.round(Number(db.settings.auto_reminder_day) || 1))),
      count: Math.min(AR_MAX_SLOTS, Math.max(1, Math.round(Number(db.settings.auto_reminder_count) || 1))),
      text: String(db.settings.auto_reminder_text || '').trim() || AR_DEFAULT_TEXT,
      last: mark.period ? String(db.settings.auto_reminder_last) : '',
      seq: mark.k
    };
  };
  const mockAutoStats = () => {
    // v2.11.6: any active user (resident, manager, admin) with a debtor unit
    const rows = db.users.filter(u => u.is_active && u.unit_id).map(u => {
      const debt = db.debts.filter(d => d.unit_id === u.unit_id)
        .reduce((s, d) => s + (d.amount - d.paid_amount), 0);
      return { debt: Math.max(0, debt), linked: Boolean(u.telegram_linked) };
    }).filter(r => r.debt > 0);
    return {
      debtor_users: rows.length,
      reachable_users: rows.filter(r => r.linked).length,
      unreachable_users: rows.filter(r => !r.linked).length,
      total_debt: rows.reduce((s, r) => s + r.debt, 0),
      capped: false,
      debtor_residents: rows.length,
      reachable_residents: rows.filter(r => r.linked).length,
      unreachable_residents: rows.filter(r => !r.linked).length
    };
  };
  if (path === '/autoremind' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    const cfg = mockAutoCfg();
    const L = arMonthLen();
    return ok({ cfg, month_len: L, days: arComputeDays(cfg.count, cfg.day, L), stats: mockAutoStats(), bot_configured: true, max_slots: AR_MAX_SLOTS, default_text: AR_DEFAULT_TEXT });
  }
  if (path === '/autoremind' && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    if (body.enabled !== undefined) db.settings.auto_reminder_enabled = body.enabled ? '1' : '0';
    if (body.day !== undefined) {
      const day = Math.round(num(body.day));
      if (!(day >= 1 && day <= 29)) return err('روز ارسال باید بین ۱ تا ۲۹ باشد');
      db.settings.auto_reminder_day = String(day);
    }
    if (body.count !== undefined) {
      const count = Math.round(num(body.count));
      if (!(count >= 1 && count <= AR_MAX_SLOTS)) return err('تعداد یادآوری باید بین ۱ تا ۱۰ باشد');
      db.settings.auto_reminder_count = String(count);
    }
    if (body.text !== undefined) {
      const text = String(body.text).trim();
      if (!text) return err('متن پیام الزامی است');
      if (text.length > 800) return err('متن پیام حداکثر ۸۰۰ کاراکتر است');
      if (!/\{(name|unit|amount)\}/.test(text)) return err('متن باید حداقل یکی از متغیرهای {name}، {unit} یا {amount} را داشته باشد');
      db.settings.auto_reminder_text = text;
    }
    save(db);
    const cfg = mockAutoCfg();
    const L = arMonthLen();
    return ok({ cfg, month_len: L, days: arComputeDays(cfg.count, cfg.day, L) });
  }
  if (path === '/autoremind/run' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const stats = mockAutoStats();
    // demo: simulate the same result shape the server returns — one slot per run
    const cfg = mockAutoCfg();
    const L = arMonthLen();
    const days = arComputeDays(cfg.count, cfg.day, L);
    const mark = arParseLast(db.settings.auto_reminder_last || '');
    const prevSeq = mark.period === currentPeriod() ? mark.k : 0;
    const slot = Math.min(prevSeq, days.length);
    db.settings.auto_reminder_last = `${currentPeriod()}#${Math.min(slot + 1, days.length)}`;
    save(db);
    return ok({
      result: {
        ran: true, period: currentPeriod(), demo: true,
        sent: stats.reachable_users, failed: 0,
        targets: stats.reachable_users, unreachable: stats.unreachable_users,
        total_debt: stats.total_debt, errors: [], capped: false,
        slot, slots: days.length
      }
    });
  }
  if (path === '/autoremind/test' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    return ok({ ok: true, demo: true });
  }

  // ---------- user-login report (گزارش ورود کاربران) — app-admin only (v2.9.1)
  const mockVisitsRow = x => {
    const u = db.users.find(z => z.id === x.user_id) || {};
    const unit = u.unit_id ? db.units.find(z => z.id === u.unit_id) : null;
    return {
      id: x.id, user_id: x.user_id, kind: x.kind, via: x.via, created_at: x.created_at,
      full_name: u.full_name || '', username: u.username || '', role: u.role || '',
      unit_number: unit ? unit.number : null
    };
  };
  const mockVisitStats = () => {
    const vs = db.visits || [];
    const t = Math.floor(Date.now() / 1000);
    const dayStart = tehranDayStartSec(t);
    const weekStart = t - 7 * 86400;
    const todayRows = vs.filter(x => x.created_at >= dayStart);
    return {
      today: todayRows.length,
      week: vs.filter(x => x.created_at >= weekStart).length,
      uniq_today: new Set(todayRows.map(x => x.user_id)).size
    };
  };
  const isoToTehranStart = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return 0;
    const TEHRAN = 12600; // UTC+3:30
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000) - TEHRAN;
  };
  if (path === '/a/visits' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    const kind = q.get('kind') === 'open' || q.get('kind') === 'login' ? q.get('kind') : '';
    const from = isoToTehranStart(q.get('from'));
    const toDay = isoToTehranStart(q.get('to'));
    const to = toDay ? toDay + 86399 : 0;
    let rows = (db.visits || []).slice().sort((a, b) => b.id - a.id)
      .filter(x => (!kind || x.kind === kind))
      .filter(x => (!from || x.created_at >= from))
      .filter(x => (!to || x.created_at <= to));
    const offset = Math.max(0, Number(q.get('offset')) || 0);
    const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 60));
    const hasMore = rows.length > offset + limit;
    rows = rows.slice(offset, offset + limit).map(mockVisitsRow);
    return ok({
      stats: mockVisitStats(),
      visits: rows,
      has_more: hasMore,
      failed_logins: (db.login_attempts || []).filter(x => x.ok === 0).slice(-20).reverse(),
      notify_enabled: db.settings.visit_notify_enabled !== '0',
      bot_configured: Boolean(db.bot),
      me_linked: Boolean(me && me.telegram_linked)
    });
  }
  if (path === '/a/visits/notify' && method === 'PUT') {
    const g = roleGuard('admin'); if (g) return g;
    db.settings.visit_notify_enabled = body.enabled ? '1' : '0';
    save(db);
    return ok({ ok: true, notify_enabled: Boolean(body.enabled) });
  }

  // ---------- admin: bot messages report (گزارش پیام‌های بات) ----------
  if (path === '/a/bot/messages' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    const isoStart = s => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
      return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000) - 12600 : 0;
    };
    const from = isoStart(q.get('from'));
    const to = isoStart(q.get('to')) ? isoStart(q.get('to')) + 86399 : 0;
    const title = String(q.get('title') || '').trim();
    const qy = String(q.get('q') || '').trim().toLowerCase();
    const dirRaw = String(q.get('dir') || '');
    const dir = dirRaw === 'out' || dirRaw === 'in' ? dirRaw : '';
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200));
    const offset = Math.max(0, Number(q.get('offset')) || 0);

    const rowsAll = (db.bot_messages || []).slice().sort((a, b) => b.id - a.id);
    const stats = (() => {
      const t = Math.floor(Date.now() / 1000);
      const dayStart = tehranDayStartSec(t);
      const weekStart = t - 7 * 86400;
      const todayRows = rowsAll.filter(x => x.created_at >= dayStart);
      return {
        total: rowsAll.length,
        today: todayRows.length,
        week: rowsAll.filter(x => x.created_at >= weekStart).length,
        senders_today: new Set(todayRows.map(x => x.tg_user_id)).size
      };
    })();
    const titles = Object.entries(rowsAll.reduce((acc, x) => { acc[x.title] = (acc[x.title] || 0) + 1; return acc; }, {}))
      .map(([t, n]) => ({ title: t, n })).sort((a, b) => b.n - a.n);

    const filtered = rowsAll.filter(x =>
      (!dir || (dir === 'out' ? x.chat_type === 'out' : x.chat_type !== 'out')) &&
      (!from || x.created_at >= from) &&
      (!to || x.created_at <= to) &&
      (!title || x.title === title) &&
      (!qy || String(x.text || '').toLowerCase().includes(qy)
        || String(x.full_name || '').toLowerCase().includes(qy)
        || String(x.username || '').toLowerCase().includes(qy))
    );
    const page = filtered.slice(offset, offset + limit);
    const rows = page.map(x => {
      const linked = db.users.find(u =>
        (x.chat_type === 'out' && u.id && (7000 + u.id) === x.tg_user_id)
        || (u.telegram_username && u.telegram_username.toLowerCase() === String(x.username || '').toLowerCase()));
      return {
        ...x,
        app_role: linked ? linked.role : null,
        app_name: linked ? linked.full_name : null,
        unit_number: linked && linked.unit_id ? (db.units.find(un => un.id === linked.unit_id) || {}).number : null
      };
    });
    return ok({
      stats, titles, messages: rows,
      matched: filtered.length,
      has_more: offset + limit < filtered.length,
      filters: { from, to, title, q: qy, dir, limit, offset },
      // demo is always healthy — the webhook banner stays hidden in demo mode
      diag: { token: true, webhook_url: location.origin + '/webhook/telegram', webhook_matches: true, pending: 0, last_error: null, last_error_at: 0 }
    });
  }

  // ---------- resident (and manager's own unit) ----------
  if (path === '/my/summary') {
    const g = roleGuard('resident', 'manager'); if (g) return g;
    const unit = db.units.find(u => u.id === me.unit_id);
    if (!unit) return err('به هیچ واحدی متصل نیستید', 403, 'no_unit');
    const debts = db.debts.filter(d => d.unit_id === unit.id)
      .sort((a, b) => b.period.localeCompare(a.period));
    const issued = debts.reduce((s, d) => s + d.amount, 0);
    const paid = debts.reduce((s, d) => s + d.paid_amount, 0);
    return ok({
      unit: { id: unit.id, number: unit.number, resident_name: unit.resident_name, area_m2: unit.area_m2, residents_count: unit.residents_count },
      debts, totals: { issued, paid, remaining: Math.max(0, issued - paid) }
    });
  }
  if (path === '/my/unit' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const unitId = body.unit_id ? num(body.unit_id) : null;
    const unit = unitId ? db.units.find(u => u.id === unitId) : null;
    if (unitId && !unit) return err('واحد پیدا نشد', 404);
    me.unit_id = unitId;
    save(db);
    return ok({ ok: true, unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name } : null });
  }

  // ---------- polls (نظرسنجی) ----------
  if (path === '/polls' && method === 'GET') {
    if (!me) return err('ابتدا وارد شوید', 401);
    const list = (db.polls || []).map(p => {
      const votes = (db.poll_votes || []).filter(v => v.poll_id === p.id);
      const opts = JSON.parse(p.options);
      const counts = opts.map((_, i) => votes.filter(v => v.option_index === i).length);
      const mine = me.unit_id ? ((votes.find(v => v.unit_id === me.unit_id) || {}).option_index ?? null) : null;
      return {
        id: p.id, question: p.question, options: opts, counts, status: p.status,
        total_votes: votes.length, created_at: p.created_at, closed_at: p.closed_at,
        my_vote: mine,
        voters: me.role === 'manager' ? votes.map(v => ({ unit_id: v.unit_id, option_index: v.option_index })) : undefined
      };
    }).sort((a, b) => ((a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)) || (b.id - a.id));
    return ok({ polls: list });
  }
  if (path === '/polls' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const question = String(body.question || '').trim().slice(0, 160);
    const options = (Array.isArray(body.options) ? body.options : [])
      .map(o => String(o || '').trim().slice(0, 80)).filter(Boolean);
    if (!question) return err('متن سؤال را وارد کنید');
    if (options.length < 2) return err('حداقل دو گزینه لازم است');
    if (new Set(options).size !== options.length) return err('گزینه‌های تکراری مجاز نیست');
    const poll = {
      id: db.seq.polls++, question, options: JSON.stringify(options),
      status: 'open', created_by: me.id,
      created_at: Math.floor(Date.now() / 1000), closed_at: null
    };
    db.polls.push(poll);
    save(db);
    return ok({ poll: { ...poll, options, counts: options.map(() => 0), total_votes: 0, my_vote: null } }, 201);
  }
  if (/^\/polls\/\d+\/(close|reopen)$/.test(path) && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const p = db.polls.find(x => x.id === id);
    if (!p) return err('نظرسنجی پیدا نشد', 404);
    p.status = path.endsWith('/close') ? 'closed' : 'open';
    p.closed_at = p.status === 'closed' ? Math.floor(Date.now() / 1000) : null;
    save(db);
    return ok({ ok: true });
  }
  if (/^\/polls\/\d+$/.test(path) && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    db.polls = db.polls.filter(x => x.id !== id);
    db.poll_votes = db.poll_votes.filter(v => v.poll_id !== id);
    save(db);
    return ok({ ok: true });
  }
  if (/^\/polls\/\d+\/vote$/.test(path) && method === 'POST') {
    if (!me) return err('ابتدا وارد شوید', 401);
    const id = Number(path.split('/')[2]);
    const p = db.polls.find(x => x.id === id);
    if (!p) return err('نظرسنجی پیدا نشد', 404);
    if (p.status !== 'open') return err('این نظرسنجی بسته شده است', 409);
    if (!me.unit_id) return err('حساب شما به واحدی متصل نیست', 403, 'no_unit');
    const opts = JSON.parse(p.options);
    const idx = Number(body.option_index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) return err('گزینه نامعتبر است');
    const existing = db.poll_votes.find(v => v.poll_id === id && v.unit_id === me.unit_id);
    if (existing) { existing.option_index = idx; existing.user_id = me.id; }
    else db.poll_votes.push({ id: db.seq.poll_votes++, poll_id: id, unit_id: me.unit_id, user_id: me.id, option_index: idx, created_at: Math.floor(Date.now() / 1000) });
    save(db);
    return ok({ ok: true });
  }

  // ---------- admin ----------
  if (path === '/a/overview') {
    const g = roleGuard('admin'); if (g) return g;
    const counts = {
      admin: db.users.filter(u => u.role === 'admin').length,
      manager: db.users.filter(u => u.role === 'manager' && u.is_active).length,
      resident: db.users.filter(u => u.role === 'resident' && u.is_active).length,
      units: db.units.length
    };
    return ok({
      installed: true, building_name: db.building_name,
      app_url: location.origin, version: '2.11.11', counts,
      visits: mockVisitStats(),
      bot: { configured: Boolean(db.bot), connected: Boolean(db.bot && db.bot.connected), username: db.bot ? db.bot.username : null },
      installed_at: Math.floor(Date.now() / 1000)
    });
  }
  if (path === '/a/managers' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    return ok({
      managers: db.users.filter(u => u.role === 'manager')
        .map(u => ({ ...pub(u), unit_number: (db.units.find(x => x.id === u.unit_id) || {}).number || null }))
    });
  }
  if (path === '/a/units' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    return ok({ units: db.units.map(u => ({ id: u.id, number: u.number, resident_name: u.resident_name })) });
  }
  if (path === '/a/managers' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) return err('نام کاربری نامعتبر است');
    if (String(body.password || '').length < 6) return err('رمز عبور باید حداقل ۶ کاراکتر باشد');
    if (!String(body.full_name || '').trim()) return err('نام مدیر را وارد کنید');
    const tgU = normTg(body.telegram_username);
    if (!validTg(tgU)) return err('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
    if (db.users.some(u => u.username.toLowerCase() === username)) return err('این نام کاربری قبلاً استفاده شده است', 409);
    const user = {
      id: db.seq.users++, username, password: String(body.password), role: 'manager',
      full_name: String(body.full_name).trim(), phone: String(body.phone || ''),
      unit_id: body.unit_id ? num(body.unit_id) : null, is_active: true,
      telegram_linked: false, telegram_username: tgU
    };
    db.users.push(user);
    save(db);
    return ok({ manager: pub(user) }, 201);
  }
  if (path === '/a/users' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const role = ['manager', 'resident'].includes(body.role) ? body.role : 'resident';
    const username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.]{3,32}$/.test(username)) return err('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
    if (String(body.password || '').length < 6) return err('رمز عبور باید حداقل ۶ کاراکتر باشد');
    if (!String(body.full_name || '').trim()) return err('نام و نام خانوادگی را وارد کنید');
    const tgU = normTg(body.telegram_username);
    if (!validTg(tgU)) return err('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
    const unitId = body.unit_id ? num(body.unit_id) : null;
    if (role === 'resident' && !unitId) return err('برای حساب ساکن، انتخاب واحد الزامی است');
    if (unitId && !db.units.some(x => x.id === unitId)) return err('واحد انتخاب‌شده پیدا نشد', 404);
    if (role === 'resident' && unitId && db.users.some(u => u.role === 'resident' && u.unit_id === unitId)) {
      return err('این واحد قبلاً حساب ساکن دارد؛ حساب قبلی را ویرایش یا حذف کنید', 409);
    }
    if (db.users.some(u => u.username.toLowerCase() === username)) return err('این نام کاربری قبلاً استفاده شده است', 409);
    const user = {
      id: db.seq.users++, username, password: String(body.password), role,
      full_name: String(body.full_name).trim(), phone: String(body.phone || ''),
      unit_id: unitId, is_active: true, telegram_linked: false, telegram_username: tgU
    };
    db.users.push(user);
    save(db);
    return ok({ user: pub(user) }, 201);
  }
  if (path === '/a/users' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    const role = q.get('role');
    const list = db.users.filter(u => !role || u.role === role)
      .map(u => ({ ...pub(u), unit_number: (db.units.find(x => x.id === u.unit_id) || {}).number || null }));
    return ok({ users: list });
  }
  if (path.startsWith('/a/users/') && path.endsWith('/message') && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const u = db.users.find(x => x.id === id);
    if (!u) return err('کاربر پیدا نشد', 404);
    if (!String(body.text || '').trim()) return err('متن پیام خالی است', 400, 'empty_text');
    if (!u.telegram_linked) return err('این کاربر هنوز به تلگرام متصل نشده است؛ به‌محض اولین استارت ربات توسط او (یا ورودش به اپ داخل تلگرام با نام کاربری و رمز)، اتصال انجام می‌شود', 409, 'not_linked');
    save(db);
    return ok({ ok: true, user: { id: u.id, username: u.username, full_name: u.full_name } });
  }
  if (path.startsWith('/a/users/') && path.endsWith('/linkcode') && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const u = db.users.find(x => x.id === id);
    if (!u) return err('کاربر پیدا نشد', 404);
    if (!u.is_active) return err('این حساب کاربری غیرفعال است؛ ابتدا آن را فعال کنید', 409);
    const r = mockLinkCode(db, u, (body || {}).ttl_hours); // v2.11.10 — اعتبار قابل انتخاب
    if (r.__err) return err(r.__err, 400);
    return ok(r);
  }
  if (path.startsWith('/a/users/') && method === 'PUT') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const u = db.users.find(x => x.id === id);
    if (!u) return err('کاربر پیدا نشد', 404);
    if (body.username !== undefined) {
      const un = String(body.username).trim().toLowerCase();
      if (!/^[a-zA-Z0-9_.]{3,32}$/.test(un)) return err('نام کاربری باید ۳ تا ۳۲ کاراکتر لاتین/رقم/نقطه/زیرخط باشد');
      if (un !== u.username && db.users.some(x => x.username.toLowerCase() === un)) return err('این نام کاربری قبلاً استفاده شده است', 409);
      u.username = un;
    }
    if (body.role !== undefined && body.role !== u.role) {
      if (!['manager', 'resident'].includes(body.role)) return err('تغییر نقش فقط بین «مدیر ساختمان» و «ساکن» امکان‌پذیر است');
      if (u.role === 'admin') return err('نقش مدیر اپ قابل تغییر نیست', 409);
      u.role = body.role;
    }
    if (body.full_name !== undefined) u.full_name = String(body.full_name);
    if (body.phone !== undefined) u.phone = String(body.phone);
    if (body.telegram_username !== undefined) {
      const tgU = normTg(body.telegram_username);
      if (!validTg(tgU)) return err('یوزرنیم تلگرام نامعتبر است — فقط حروف لاتین، رقم و زیرخط (بدون @)', 400, 'bad_tg_username');
      u.telegram_username = tgU;
    }
    if (body.is_active !== undefined) u.is_active = body.is_active ? 1 : 0;
    if (body.unit_id !== undefined) u.unit_id = body.unit_id ? num(body.unit_id) : null;
    if (body.password) u.password = String(body.password);
    save(db);
    return ok({ user: pub(u) });
  }
  if (path.startsWith('/a/users/') && method === 'DELETE') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const u = db.users.find(x => x.id === id);
    if (!u) return err('کاربر پیدا نشد', 404);
    if (u.role === 'admin') return err('حساب مدیر اپ قابل حذف نیست', 409);
    db.users = db.users.filter(x => x.id !== id);
    save(db);
    return ok({ ok: true });
  }
  if (path === '/a/settings' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    return ok({ settings: db.settings, bot_configured: false, app_url: location.origin });
  }
  if (path === '/a/settings' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    if (body.building_name !== undefined) {
      const name = String(body.building_name).trim();
      if (!name) return err('نام ساختمان نمی‌تواند خالی باشد');
      db.building_name = name;
    }
    ['address', 'phone', 'bank_card', 'bank_owner'].forEach(k => {
      if (body[k] !== undefined) db.settings[k] = String(body[k]);
    });
    if (body.default_monthly_amount !== undefined) {
      db.settings.default_monthly_amount = num(body.default_monthly_amount);
    }
    save(db);
    return ok({ ok: true, settings: db.settings });
  }
  if (path === '/a/dev/seed' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    return err('در حالت نمایشی داده نمونه از قبل بارگذاری شده است', 409);
  }
  if (path === '/a/dev/reset' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    mockReset();
    MOCK_STATE.user = null;
    return ok({ ok: true, demo_reset: true });
  }
  if (path === '/a/bot') {
    const g = roleGuard('admin'); if (g) return g;
    if (!db.bot) {
      return ok({ configured: false, source: null, hint: 'در حالت نمایشی ربات واقعی نیست؛ برای آزمایش فرم، توکنی با قالب معتبر وارد کنید — مثلاً 123456789:AAExampleTokenForDemoModeOnly12345' });
    }
    return ok({
      configured: true, source: 'settings',
      masked: db.bot.masked, connected: true,
      username: db.bot.username, bot_id: 123456789, error: null,
      webhook: { url: location.origin + '/webhook/telegram', matches_app: true, pending_updates: 0, last_error: null },
      expected_webhook_url: location.origin + '/webhook/telegram',
      menu_button: { ok: true, state: { type: 'web_app', text: 'open', web_app: { url: location.origin } } },
      links: {
        app: location.origin,
        bot: 'https://t.me/' + db.bot.username,
        add_to_group: 'https://t.me/' + db.bot.username + '?startgroup=true'
      }
    });
  }
  if (path === '/a/bot/token' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    let token = String(body.token || '').trim().replace(/[\s'"`]+/g, '');
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return err('قالب توکن معتبر نیست؛ توکن از @BotFather به شکل «123456789:AAEx…» است', 400, 'bad_token');
    }
    db.bot = {
      username: 'DemoBuildingBot',
      masked: token.split(':')[0] + ':••••••' + token.slice(-4)
    };
    save(db);
    return ok({
      ok: true, username: db.bot.username, bot_id: 123456789,
      webhook_ok: true, webhook_error: null, menu_ok: true, commands_ok: true,
      links: { app: location.origin, bot: 'https://t.me/DemoBuildingBot', add_to_group: 'https://t.me/DemoBuildingBot?startgroup=true' }
    });
  }
  if (path === '/a/bot/token' && method === 'DELETE') {
    const g = roleGuard('admin'); if (g) return g;
    db.bot = null;
    save(db);
    return ok({ ok: true });
  }
  if ((path === '/a/bot/webhook' || path === '/a/bot/menu') && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    if (!db.bot) return err('توکن ربات تنظیم نشده است', 409);
    return ok({ ok: true });
  }

  return err('مسیر پیدا نشد (دمو): ' + path, 404, 'not_found');
}

