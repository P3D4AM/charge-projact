// Demo layer — runs the whole app in the browser with sample data (no server).
// Mirrors the v2 API surface: users/roles, install, admin panel (/a/*), resident
// accounts, PDF stubs. Data persists in localStorage.
import { currentPeriod, periodLabel, isPeriod, addPeriods, tehranDayStartSec, toGregorian, tehranParts, toJalaaliFromParts, J_MONTHS, faNum } from './jalali.js';
import { buildZip } from './lib/zip.js';

const KEY = 'bc_mock_db_v6';
const SCHEMA_V = 12; // ← با هر تغییر شکل داده‌ی دمو یک واحد اضافه شود (v12: auto_charge + manager_reminders)

function seed() {
  const period = currentPeriod();
  const prev = addPeriods(period, -1);
  const users = [
    { id: 1, username: 'admin', password: 'Admin@1404', role: 'admin', full_name: 'مدیر اپ', phone: '', unit_id: null, is_active: true, telegram_linked: false, telegram_username: '' },
    { id: 2, username: 'manager', password: 'manager123', role: 'manager', full_name: 'حسین محمدی', phone: '09121234567', unit_id: 3, is_active: true, telegram_linked: false, telegram_username: '', is_resident: true, bound_tg: null },
    { id: 3, username: 'unit5', password: '1234', role: 'resident', full_name: 'رضا محمدی', phone: '09121110005', unit_id: 5, is_active: true, telegram_linked: true, telegram_username: 'reza_m' },
    { id: 4, username: 'unit1', password: '1234', role: 'resident', full_name: 'علی رضایی', phone: '09121110001', unit_id: 1, is_active: true, telegram_linked: false, telegram_username: 'ali_rezaei' }
  ];
  const units = [
    { id: 1, number: '1', resident_name: 'علی رضایی', phone: '09121110001', area_m2: 85, residents_count: 2, note: '', auto_charge: false },
    { id: 2, number: '2', resident_name: 'مریم احمدی', phone: '09121110002', area_m2: 110, residents_count: 3, note: '', auto_charge: true },
    { id: 3, number: '3', resident_name: 'حسین محمدی', phone: '09121110003', area_m2: 95, residents_count: 2, note: '', auto_charge: false },
    { id: 4, number: '4', resident_name: 'زهرا موسوی', phone: '09121110004', area_m2: 120, residents_count: 4, note: '', auto_charge: true },
    { id: 5, number: '5', resident_name: 'رضا محمدی', phone: '09121110005', area_m2: 75, residents_count: 1, note: '', auto_charge: false },
    { id: 6, number: '6', resident_name: 'سارا حسینی', phone: '09121110006', area_m2: 130, residents_count: 3, note: '', auto_charge: true },
    { id: 7, number: '7', resident_name: 'امیر نادری', phone: '09121110007', area_m2: 100, residents_count: 2, note: '', auto_charge: false },
    { id: 8, number: '8', resident_name: 'نرگس صادقی', phone: '09121110008', area_m2: 105, residents_count: 3, note: '', auto_charge: false }
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
  // v2.21.0 — دفتر اعتبار اضافه‌پرداخت (دمو): واحد ۵ ماه قبل ۸۰۰هزار اضافه پرداخت کرده،
  // ۶۵۰هزارش در صدور شارژ این ماه خودکار مصرف شده و ۱۵۰هزار اعتبار مانده؛ واحد ۳ هم ۱۲۰هزار اعتبار دارد
  const unit_credits = [
    { id: 1, unit_id: 5, amount: 800000, kind: 'add', debt_id: null, period: prev, note: 'اضافه‌پرداخت واریزی — بیشتر از شارژ پرداخت کرد', created_by: 2, created_at: Math.floor(Date.now() / 1000) - 2600000 },
    { id: 2, unit_id: 5, amount: -650000, kind: 'consume', debt_id: 5, period, note: 'مصرف خودکار در صدور شارژ — پیش‌پرداخت شارژ این ماه', created_at: Math.floor(Date.now() / 1000) - 2500000 },
    { id: 3, unit_id: 3, amount: 120000, kind: 'add', debt_id: null, period: prev, note: 'ثبت دستی اضافه‌پرداخت', created_by: 2, created_at: Math.floor(Date.now() / 1000) - 2400000 }
  ];
  // v2.13.0 — دفتر کارهای مدیر (دمو): چند کار نمونه با هزینه
  const periodTs = (p, day) => {
    const [jy, jm] = String(p).split('-').map(Number);
    const g = toGregorian(jy, jm, day);
    return Math.floor(Date.UTC(g.gy, g.gm - 1, g.gd, 8, 30) / 1000); // ظهر تهران
  };
  const tasks = [
    { id: 1, title: 'سرویس و شارژ کولرهای ساختمان', category: 'تعمیرات', description: 'تماس با تکنسین، شارژ گاز ۴ کولر تبدیلی راه‌پله و بررسی لوله‌کشی — فیش خدماتی پیوست است.', cost: 850000, done_at: periodTs(period, 12), created_by: 2, created_at: periodTs(period, 12), updated_at: null },
    { id: 2, title: 'شست‌وشوی کامل راه‌پله و پارکینگ', category: 'نظافت', description: 'قرارداد نظافتی برای یک نوبت شست‌وشوی کامل با دستگاه واترجت.', cost: 600000, done_at: periodTs(period, 6), created_by: 2, created_at: periodTs(period, 6), updated_at: null },
    { id: 3, title: 'بازدید دوره‌ای آسانسور', category: 'آسانسور', description: '', cost: 350000, done_at: periodTs(prev, 21), created_by: 2, created_at: periodTs(prev, 21), updated_at: null },
    { id: 4, title: 'پیگیری قرارداد نگهبانی شبانه', category: 'اداری و مالی', description: 'مذاکره با دو شرکت نگهبانی؛ هنوز هزینه‌ای نداشته است.', cost: 0, done_at: periodTs(prev, 9), created_by: 2, created_at: periodTs(prev, 9), updated_at: null }
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
  // v2.16.0 — رسیده‌های پرداخت شارژ (دمو): یکی در انتظار بررسی (واحد ۵) + یکی تأییدشده (واحد ۲)
  const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const t0 = Math.floor(Date.now() / 1000);
  const claims = [
    {
      id: 1, unit_id: 2, user_id: null, amount: 650000,
      note: 'شارژ این ماه کامل واریز شد.', status: 'confirmed',
      confirmed_amount: 650000, reject_note: '', confirmed_by: 2,
      created_at: t0 - 86400 * 2, confirmed_at: t0 - 86400
    },
    {
      id: 2, unit_id: 5, user_id: 3, amount: 350000,
      note: 'فعلاً ۳۵۰ هزار تومان پرداخت کردم؛ باقی را هفته بعد واریز می‌کنم.', status: 'pending',
      confirmed_amount: null, reject_note: '', confirmed_by: null,
      created_at: t0 - 3600 * 2, confirmed_at: null
    }
  ];
  const claim_files = [
    { id: 1, claim_id: 1, name: 'fish-unit2.png', mime: 'image/png', size: 70, created_at: t0 - 86400 * 2 },
    { id: 2, claim_id: 2, name: 'fish-varizi-unit5.png', mime: 'image/png', size: 70, created_at: t0 - 3600 * 2 }
  ];
  const claim_file_chunks = [
    { id: 1, file_id: 1, idx: 0, data: TINY_PNG },
    { id: 2, file_id: 2, idx: 0, data: TINY_PNG }
  ];
  return {
    v: SCHEMA_V,
    seq: { users: 5, units: 9, debts: debtId, expenses: 3, polls: 2, poll_votes: 3, visits: 6, bot_messages: 12, tasks: 5, task_files: 1, task_file_chunks: 1, claims: 3, claim_files: 3, claim_file_chunks: 3, invites: 1, credits: 4, admin_notifications: 3, manager_reminders: 2 },
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
    // v2.19.0 — پیام‌های «ارسالی» ربات هم (direction:'out') نمونه‌سازی شده‌اند
    bot_messages: (() => {
      const t = Math.floor(Date.now() / 1000);
      return [
        { id: 1, chat_id: 9001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /start', text: '/start', created_at: t - 7200 },
        { id: 2, chat_id: 9002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'command', title: 'فرمان /start', text: '/start', created_at: t - 5400 },
        { id: 3, chat_id: 9002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'text', title: 'پیام متنی', text: 'سلام، شارژ این ماه چقدر شد؟', created_at: t - 5340 },
        { id: 4, chat_id: 9003, chat_type: 'private', tg_user_id: 7003, username: '', full_name: 'مریم احمدی', kind: 'text', title: 'پیام متنی', text: 'وقت بخیر، رسید پرداخت را کجا بفرستم؟', created_at: t - 43000 },
        { id: 5, chat_id: -1001200, chat_type: 'supergroup', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /app', text: '/app', created_at: t - 90000 },
        { id: 6, chat_id: 9004, chat_type: 'private', tg_user_id: 7004, username: 'sara_h', full_name: 'سارا حسینی', kind: 'other', title: 'رسانه یا سایر', text: '', created_at: t - 180000 },
        { id: 7, chat_id: 9001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'command', title: 'فرمان /help', text: '/help', created_at: t - 260000 },
        { id: 8, chat_id: 7002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'out', title: 'یادآوری خودکار', direction: 'out', text: 'ساختمان نمونه — یادآوری خودکار ماهانه\nعلی رضایی عزیز، مانده بدهی واحد ۱ مبلغ ۱٬۰۵۰٬۰۰۰ تومان است. لطفاً نسبت به تسویه اقدام فرمایید.', created_at: t - 5100 },
        { id: 9, chat_id: 7001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'out', title: 'یادآوری دستی', direction: 'out', text: 'ساختمان نمونه — واحد ۵\nرضا محمدی عزیز، مانده بدهی شما بالغ بر ۷۵۰٬۰۰۰ تومان است.\nلطفاً نسبت به تسویه اقدام فرمایید. با تشکر', created_at: t - 4300 },
        { id: 10, chat_id: 7001, chat_type: 'private', tg_user_id: 7001, username: 'reza_m', full_name: 'رضا محمدی', kind: 'out', title: 'پیام شخصی', direction: 'out', text: 'سلام، لطفاً رسید واریزی این ماه را از بخش «واحد من» ثبت کنید. ممنون', created_at: t - 3600 },
        { id: 11, chat_id: 7002, chat_type: 'private', tg_user_id: 7002, username: 'ali_rezaei', full_name: 'علی رضایی', kind: 'out', title: 'پاسخ ربات', direction: 'out', text: 'سلام علی! 👋\nبه اپ ساختمان خوش آمدید. با دکمهٔ زیر اپ را باز کنید:', created_at: t - 5400 }
      ];
    })(),
    users, units, debts, expenses, tasks,
    task_files: [],
    task_file_chunks: [],
    payment_claims: claims, claim_files, claim_file_chunks,
    unit_credits,
    // v2.23.0 — یادآوری‌های دوره‌ای مدیر ساختمان (دمو): یک نمونهٔ ماهانه
    manager_reminders: [
      { id: 1, title: 'تسویه صندوق ماه و ثبت هزینه‌ها', text: 'لطفاً تا روز ۵ ماه جدید هزینه‌های مشترک را ثبت و صندوق را تسویه کنید.', freq: 'monthly', weekday: 6, month_day: 3, is_active: 1, last_sent_at: null, last_sent_day: '', last_sent_period: '', created_at: Math.floor(Date.now() / 1000) - 86400 }
    ],
    // v2.22.0 — گزارش اعلان‌های فعالیت مدیرکل (دمو): چند ردیف نمونه
    admin_notifications: [
      { id: 1, event: 'resident_login', title: 'ساکن وارد اپ شد (نام کاربری/تلگرام)', text: '🔔 ساختمان نمونه\nساکن وارد اپ شد (نام کاربری/تلگرام)\n\n• روش ورود: داخل تلگرام\n\nانجام‌دهنده: رضا محمدی (@reza_m) — ساکن', actor_user_id: 3, actor_username: 'unit5', actor_role: 'resident', unit_id: 5, unit_number: '5', ref_id: null, meta: '', sent: 1, send_error: '', created_at: Math.floor(Date.now() / 1000) - 5400 },
      { id: 2, event: 'payment', title: 'ثبت/ویرایش/لغو پرداخت و اعتبار اضافه‌پرداخت', text: '🔔 ساختمان نمونه\nثبت/ویرایش/لغو پرداخت و اعتبار اضافه‌پرداخت\n\n• اعتبار (اضافه‌پرداخت) ۱۲۰٬۰۰۰ تومانی برای واحد ۳ ثبت شد — مانده اعتبار: ۱۲۰٬۰۰۰\n\nانجام‌دهنده: حسین محمدی — مدیر ساختمان', actor_user_id: 2, actor_username: 'manager', actor_role: 'manager', unit_id: 3, unit_number: '3', ref_id: null, meta: '', sent: 1, send_error: '', created_at: Math.floor(Date.now() / 1000) - 3600 },
      { id: 3, event: 'export_import', title: 'خروجی/بکاپ/بازیابی داده', text: '🔔 ساختمان نمونه\nخروجی/بکاپ/بازیابی داده\n\n• خروجی بدهکاران (فرمت: xls) دریافت شد\n\nانجام‌دهنده: حسین محمدی — مدیر ساختمان', actor_user_id: 2, actor_username: 'manager', actor_role: 'manager', unit_id: null, unit_number: '', ref_id: null, meta: '', sent: 0, send_error: 'no_admin_telegram', created_at: Math.floor(Date.now() / 1000) - 1800 }
    ],
    invites: []
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
        && Array.isArray(db.tasks) && Array.isArray(db.task_files) && Array.isArray(db.task_file_chunks)
        && Array.isArray(db.payment_claims) && Array.isArray(db.claim_files) && Array.isArray(db.claim_file_chunks)
        && Array.isArray(db.unit_credits || [])
        && Array.isArray(db.admin_notifications || [])
        && Array.isArray(db.manager_reminders || [])
        && Array.isArray(db.invites || [])
        && db.settings && typeof db.building_name === 'string';
      if (okShape) { db.invites = db.invites || []; db.unit_credits = db.unit_credits || []; db.admin_notifications = db.admin_notifications || []; db.manager_reminders = db.manager_reminders || []; (db.units || []).forEach(u => { u.auto_charge = Boolean(u.auto_charge); }); return db; }
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

// v2.17.0 — در دمو کل این مرورگر یک «پروفایل تلگرام» شبیه‌سازی‌شده است؛ لینک
// دعوتِ مصرف‌شده توسط همین شناسه دوباره باز شود دوباره کار می‌کند (مثل تلگرام واقعی)
const MOCK_TG_PROFILE = 900001;
const mockBotUsername = db => (db.bot && db.bot.username) || 'DemoBuildingBot';
const mockInvitePub = (db, i) => ({
  id: i.id, user_id: i.user_id, token: i.token,
  url: 'https://t.me/' + mockBotUsername(db) + '?startapp=' + i.token,
  created_at: i.created_at, expires_at: i.expires_at,
  used_at: i.used_at || null, used_by_tg: i.used_by_tg || null
});

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
  is_active: Boolean(u.is_active), unit_number: u.unit_number || null,
  is_resident: u.role === 'resident' ? true : (u.is_resident === undefined ? true : Boolean(u.is_resident)),
  profile_locked: Boolean(u.bound_tg)
});
// store telegram usernames without the leading «@» (same as the server)
const normTg = v => String(v ?? '').trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@+/, '').trim().slice(0, 32);
const validTg = s => s === '' || /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s);
const num = v => Math.round(Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0);

function unitDebt(db, unitId) {
  const items = db.debts.filter(d => d.unit_id === unitId);
  const issued = items.reduce((s, d) => s + d.amount, 0);
  const paid = items.reduce((s, d) => s + d.paid_amount, 0);
  return { issued, paid, debt: Math.max(0, issued - paid) };
}

function unitSummary(db, u) {
  const t = unitDebt(db, u.id);
  const acc = db.users.find(x => x.role === 'resident' && x.unit_id === u.id);
  // v2.17.0 — حساب مدیرِ متصل به واحد (یوزر/پسورد پنل اصلی پوششش می‌دهد)
  const mgr = db.users.find(x => x.role === 'manager' && x.unit_id === u.id);
  const credit = db.unit_credits.filter(c => c.unit_id === u.id).reduce((s, c) => s + c.amount, 0);
  return {
    ...u,
    issued: t.issued, paid: t.paid, debt: t.debt,
    credit: Math.max(0, credit),
    has_account: Boolean(acc),
    account_id: acc ? acc.id : null,
    account_username: acc ? acc.username : null,
    account_active: acc ? Boolean(acc.is_active) : false,
    account_telegram: acc && acc.telegram_linked ? 1 : null,
    manager_account: mgr ? {
      username: mgr.username, full_name: mgr.full_name || '',
      telegram_linked: Boolean(mgr.telegram_linked), is_active: Boolean(mgr.is_active),
      is_resident: mgr.is_resident === undefined ? true : Boolean(mgr.is_resident)
    } : null
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
  const creditTotal = db.unit_credits.reduce((s, c) => s + c.amount, 0);
  return {
    period,
    totals: { issued, collected, outstanding: Math.max(0, issued - collected) },
    month: {
      issued: mItems.reduce((s, d) => s + d.amount, 0),
      collected: mItems.reduce((s, d) => s + d.paid_amount, 0)
    },
    credit_total: Math.max(0, creditTotal),
    units_count: db.units.length,
    debtors_count: debtors,
    series: Object.values(seriesMap).sort((a, b) => a.period.localeCompare(b.period)),
    recent, top
  };
}

export async function mockFetch(fullPath, method = 'GET', body = {}) {
  const [path, qsRaw] = String(fullPath).split('?');
  const q = new URLSearchParams(qsRaw || '');
  await new Promise(r => setTimeout(r, 120)); // simulate latency

  const db = load();
  const me = MOCK_STATE.user && db.users.find(u => u.id === MOCK_STATE.user.id);

  // ---------- public ----------
  if (path === '/auth/login' && method === 'POST') {
    const uname = String(body.username || '').trim().toLowerCase();
    const u = db.users.find(x => x.username.toLowerCase() === uname);
    if (!u || u.password !== body.password) return err('نام کاربری یا رمز عبور اشتباه است', 401);
    if (!u.is_active) return err('این حساب غیرفعال شده است', 403);
    MOCK_STATE.user = { ...u };
    // visit log (گزارش ورود) — same behavior as the server
    db.visits = db.visits || [];
    db.visits.push({ id: db.seq.visits || 1, user_id: u.id, kind: 'login', via: 'web', created_at: Math.floor(Date.now() / 1000) });
    db.seq.visits = (db.seq.visits || 1) + 1;
    save(db);
    return ok({ token: 'mock-token-' + u.id, user: pub(u), linked_telegram: false });
  }
  if (path === '/auth/telegram' && method === 'POST') return err('در حالت نمایشی، از فرم ورود استفاده کنید', 401, 'not_linked');
  // ---------- v2.17.0 — لینک دعوت یک‌بارمصرف (دمو: پروفایل شبیه‌سازی‌شده) ----------
  // v2.20.0 — پروتکل دومرحله‌ای مثل سرور واقعی: اول بدون اعتبارنامه →
  // invite_credentials_required؛ بعد یوزر/پسورد همان حساب → انتقال واقعی:
  // پروفایل از حساب‌های قبلی آزاد و به حساب هدف قفل می‌شود.
  if (path === '/auth/invite' && method === 'POST') {
    const token = String(body.token || '').trim();
    if (!token) return err('توکن دعوت پیدا نشد', 400, 'invite_missing');
    const inv = db.invites.find(x => x.token === token);
    if (!inv) return err('این لینک دعوت معتبر نیست', 404, 'invite_invalid');
    const t = Math.floor(Date.now() / 1000);
    const u = db.users.find(x => x.id === inv.user_id);
    if (!u || !u.is_active) return err('حساب هدف این لینک فعال نیست', 409, 'invite_target_inactive');
    // در دمو کل این مرورگر یک «پروفایل تلگرام» شبیه‌سازی‌شده است (MOCK_TG_PROFILE)
    const reopen = Boolean(inv.used_at) && Number(inv.used_by_tg || 0) === MOCK_TG_PROFILE;
    if (inv.used_at && !reopen) {
      return err('این لینک قبلاً توسط پروفایل دیگری مصرف شده است', 409, 'invite_used');
    }
    if (reopen && Number(u.bound_tg || 0) !== MOCK_TG_PROFILE) {
      return err('این لینک قبلاً مصرف شده و حساب بعد از آن به پروفایل دیگری منتقل شده است', 409, 'invite_used');
    }
    if (!reopen && inv.expires_at < t) {
      return err('این لینک دعوت منقضی شده است؛ از مدیر ساختمان لینک جدید بگیرید', 410, 'invite_expired');
    }
    if (!reopen) {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) {
        return err('برای اتصال حساب، نام کاربری و رمز عبور همان حساب را وارد کنید', 401, 'invite_credentials_required');
      }
      if (username.toLowerCase() !== String(u.username || '').toLowerCase() || u.password !== password) {
        return err('نام کاربری یا رمز عبور این حساب درست نیست', 401, 'invite_bad_credentials');
      }
      // آزادسازی پروفایل از حساب‌های قبلی (خروج اجباری — انتقال واقعی)
      for (const o of db.users) {
        if (o.id !== u.id && (Number(o.telegram_user_id) === MOCK_TG_PROFILE || Number(o.bound_tg) === MOCK_TG_PROFILE)) {
          o.telegram_linked = false;
          o.telegram_user_id = null;
          o.telegram_username = '';
          o.bound_tg = null;
        }
      }
    }
    u.telegram_linked = true;
    u.telegram_user_id = MOCK_TG_PROFILE;
    u.bound_tg = MOCK_TG_PROFILE;
    inv.used_at = t;
    inv.used_by_tg = MOCK_TG_PROFILE;
    MOCK_STATE.user = { ...u };
    db.visits = db.visits || [];
    db.visits.push({ id: db.seq.visits || 1, user_id: u.id, kind: 'open', via: 'telegram', created_at: t });
    db.seq.visits = (db.seq.visits || 1) + 1;
    save(db);
    return ok({ token: 'mock-token-' + u.id, linked: true, bound: true, user: pub(u) });
  }
  if (path === '/install-status') return ok({ installed: true, version: '2.23.2' });
  if (path === '/health') return ok({ ok: true, version: '2.23.2' });

  // ---------- auth guard ----------
  const guard = () => (!me ? err('ابتدا وارد شوید', 401) : null);
  const roleGuard = (...roles) => (!me ? err('ابتدا وارد شوید', 401)
    : roles.includes(me.role) ? null : err('شما به این بخش دسترسی ندارید', 403));

  if (path === '/auth/me') {
    const g = guard(); if (g) return g;
    const unit = me.unit_id ? db.units.find(u => u.id === me.unit_id) : null;
    return ok({
      user: pub(me), role: me.role,
      unit: unit ? { id: unit.id, number: unit.number, resident_name: unit.resident_name, area_m2: unit.area_m2, residents_count: unit.residents_count } : null,
      settings: db.settings,
      current_period: currentPeriod(),
      bot_configured: false,
      app_url: location.origin
    });
  }
  if (path === '/auth/change-password' && method === 'POST') {
    const g = guard(); if (g) return g;
    if (me.password !== body.old_password) return err('رمز عبور فعلی اشتباه است', 403);
    if (String(body.new_password || '').length < 6) return err('رمز جدید باید حداقل ۶ کاراکتر باشد');
    me.password = body.new_password;
    save(db);
    return ok({ ok: true });
  }
  if (path === '/auth/logout') { MOCK_STATE.user = null; return ok({ ok: true }); }

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
      const unpaid = db.debts.filter(d => d.unit_id === u.id && d.paid_amount < d.amount);
      return {
        id: u.id, number: u.number, resident_name: u.resident_name, area_m2: u.area_m2,
        issued: t.issued, paid: t.paid,
        credit: db.unit_credits.filter(c => c.unit_id === u.id).reduce((s, c) => s + c.amount, 0),
        remind_count: unpaid.reduce((s, d) => Math.max(s, d.remind_count || 0), 0),
        last_remind_at: unpaid.reduce((s, d) => Math.max(s, d.last_remind_at || 0), 0) || null
      };
    }).sort((a, b) => (b.issued - b.paid) - (a.issued - a.paid));
    const creditTotal = db.unit_credits.reduce((s, c) => s + c.amount, 0);
    return ok({ jy, series: Object.values(seriesMap).sort((a, b) => a.period.localeCompare(b.period)), by_unit, credit_total: Math.max(0, creditTotal) });
  }
  if (path === '/reports/month') {
    const g = roleGuard('manager'); if (g) return g;
    const period = isPeriod(q.get('period') || '') ? q.get('period') : currentPeriod();
    let issued = 0, collected = 0;
    const by_unit = db.units.map(u => {
      const items = db.debts.filter(d => d.unit_id === u.id && d.period === period);
      const issuedU = items.reduce((s, d) => s + d.amount, 0);
      const paidU = items.reduce((s, d) => s + d.paid_amount, 0);
      issued += issuedU; collected += paidU;
      const notes = items.filter(d => String(d.note || '').trim())
        .map(d => ({ description: d.description || '', note: String(d.note).trim() }));
      const creditU = db.unit_credits.filter(c => c.unit_id === u.id).reduce((s, c) => s + c.amount, 0);
      return { id: u.id, number: u.number, resident_name: u.resident_name, items: items.length, issued: issuedU, paid: paidU, credit: creditU, notes };
    });
    const creditTotal = db.unit_credits.reduce((s, c) => s + c.amount, 0);
    return ok({ period, totals: { issued, collected, remaining: Math.max(0, issued - collected), credit_total: Math.max(0, creditTotal) }, by_unit });
  }
  if (path === '/export') {
    const g = roleGuard('manager', 'admin'); if (g) return g; // v2.14: shared
    const type = q.get('type') || 'debtors';
    // v2.15.0 — zip برای بکاپ کنار xls/csv
    const fmtRaw = q.get('fmt') || '';
    const fmt = ['xls', 'zip'].includes(fmtRaw) ? fmtRaw : 'csv';
    const xls = (filename, rows) => {
      const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const tr = r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>';
      const body = '<html><head><meta charset="utf-8"></head><body>' +
        '<table dir="rtl" border="1" cellspacing="0" cellpadding="4">' + rows.map(tr).join('') + '</table></body></html>';
      return ok({ __download: { content: body, mime: 'application/vnd.ms-excel', filename } });
    };
    const periodLabelTs = ts => {
      if (!ts) return '-';
      try {
        const j = toJalaaliFromParts(new Date(ts * 1000).getUTCFullYear(), new Date(ts * 1000).getUTCMonth() + 1, new Date(ts * 1000).getUTCDate());
        return `${faNum(j.jd)} ${J_MONTHS[j.jm - 1]} ${faNum(j.jy)}`;
      } catch { return '-'; }
    };
    if (type === 'backup') {
      // full-fidelity JSON backup — same shape as the server (v2.11.0)
      const payload = {
        app: 'building-charges', version: '2.23.2',
        exported_at: new Date().toISOString(),
        units: db.units, debts: db.debts, expenses: db.expenses,
        users: db.users, polls: db.polls, poll_votes: db.poll_votes,
        tasks: db.tasks, task_files: db.task_files, task_file_chunks: db.task_file_chunks,
        payment_claims: db.payment_claims, claim_files: db.claim_files, claim_file_chunks: db.claim_file_chunks,
        unit_credits: db.unit_credits,
        settings: Object.entries(db.settings || {}).map(([key, value]) => ({ key, value }))
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      // v2.15.0 — بکاپ ZIP (با یا بدون مدارک) — آینهٔ سرور
      if (fmt === 'zip') {
        const wantFiles = q.get('files') === '1';
        const entries = [{ name: 'backup.json', data: new TextEncoder().encode(jsonStr) }];
        let skipped = 0;
        if (wantFiles) {
          // v2.16.0 — فیش‌های واریزی ساکنین هم با پیشوند claims/ داخل زیپ می‌آیند
          for (const f of db.claim_files || []) {
            try {
              const b64parts = (db.claim_file_chunks || []).filter(c => c.file_id === f.id)
                .sort((a, b) => (a.idx || 0) - (b.idx || 0)).map(c => c.data || '');
              const binStr = atob(b64parts.join(''));
              const bin = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) bin[i] = binStr.charCodeAt(i);
              const base = String(f.name || 'fish').replace(/[\\/]+/g, '_').replace(/\.\./g, '_').slice(0, 120) || 'fish';
              entries.push({ name: 'claims/' + f.id + '-' + base, data: bin });
            } catch { skipped++; }
          }
          for (const f of db.task_files || []) {
            try {
              const b64parts = (db.task_file_chunks || []).filter(c => c.file_id === f.id)
                .sort((a, b) => (a.idx || 0) - (b.idx || 0)).map(c => c.data || '');
              const binStr = atob(b64parts.join(''));
              const bin = new Uint8Array(binStr.length);
              for (let i = 0; i < binStr.length; i++) bin[i] = binStr.charCodeAt(i);
              const base = String(f.name || 'modrak').replace(/[\\/]+/g, '_').replace(/\.\./g, '_').slice(0, 120) || 'modrak';
              entries.push({ name: 'files/' + f.id + '-' + base, data: bin });
            } catch { skipped++; }
          }
        }
        if (skipped) entries.push({ name: 'FILES-SKIPPED.txt', data: new TextEncoder().encode(skipped + ' file(s) skipped (unreadable content).\n') });
        const zipBytes = buildZip(entries);
        return ok({ __download: { content: zipBytes, mime: 'application/zip', filename: 'building-backup-' + Date.now() + '.zip' } });
      }
      return ok({ __download: { content: jsonStr, mime: 'application/json', filename: 'building-backup-' + Date.now() + '.json' } });
    }
    if (type === 'debtors') {
      const rows = [['شماره واحد', 'ساکن', 'تلفن', 'مانده بدهی (تومان)', 'اعتبار واحد (تومان)', 'مانده پس از اعتبار (تومان)', 'تعداد یادآوری', 'آخرین یادآوری']];
      db.units.map(u => {
        const unpaid = db.debts.filter(d => d.unit_id === u.id && d.paid_amount < d.amount);
        const creditU = Math.max(0, db.unit_credits.filter(c => c.unit_id === u.id).reduce((s, c) => s + c.amount, 0));
        return {
          number: u.number, resident_name: u.resident_name, phone: u.phone,
          debt: unitDebt(db, u.id).debt,
          credit: creditU,
          rc: unpaid.reduce((s, d) => Math.max(s, d.remind_count || 0), 0),
          lr: unpaid.reduce((s, d) => Math.max(s, d.last_remind_at || 0), 0)
        };
      }).filter(u => u.debt > 0)
        .forEach(u => rows.push([u.number, u.resident_name || '', u.phone || '', u.debt, u.credit, Math.max(0, u.debt - u.credit), u.rc, u.lr ? periodLabelTs(u.lr) : '-']));
      return fmt === 'xls' ? xls('debtors.xls', rows)
        : ok({ __download: { content: '\uFEFF' + rows.map(r => r.join(',')).join('\n'), mime: 'text/csv', filename: 'debtors.csv' } });
    }
    if (type === 'year') {
      const jy = (q.get('jy') || currentPeriod()).slice(0, 4);
      const rows = [['ماه', 'صادرشده (تومان)', 'وصول\u200cشده (تومان)', 'مانده (تومان)']];
      const seriesMap = {};
      db.debts.forEach(d => {
        if (!d.period.startsWith(jy)) return;
        seriesMap[d.period] = seriesMap[d.period] || { period: d.period, issued: 0, collected: 0 };
        seriesMap[d.period].issued += d.amount;
        seriesMap[d.period].collected += d.paid_amount;
      });
      Object.values(seriesMap).sort((a, b) => a.period.localeCompare(b.period))
        .forEach(s => rows.push([periodLabel(s.period), s.issued, s.collected, s.issued - s.collected]));
      return fmt === 'xls' ? xls(`year-${jy}.xls`, rows)
        : ok({ __download: { content: '\uFEFF' + rows.map(r => r.join(',')).join('\n'), mime: 'text/csv', filename: `year-${jy}.csv` } });
    }
    return err('نوع خروجی نامعتبر است');
  }

  // ---------- import backup (بازیابی) — v2.11.0 (demo mirror of the server) ----------
  if (path === '/import' && method === 'POST') {
    const g = roleGuard('manager', 'admin'); if (g) return g; // v2.14: shared
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
    // v2.13.0: کارها و مدارک (پشتیبان‌های قدیمی این بخش‌ها را ندارند)
    db.tasks = Array.isArray(body.tasks) ? body.tasks.map(t => ({ ...t })) : [];
    db.task_files = Array.isArray(body.task_files) ? body.task_files.map(f => ({ ...f })) : [];
    db.task_file_chunks = Array.isArray(body.task_file_chunks) ? body.task_file_chunks.map(ch => ({ ...ch })) : [];
    db.users = [...admins, ...userRows];
    // v2.21.0 — دفتر اعتبار اضافه‌پرداخت (پشتیبان‌های قدیمی ندارند)
    db.unit_credits = Array.isArray(body.unit_credits) ? body.unit_credits.map(c => ({ ...c })) : [];
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
    db.seq.tasks = maxId(db.tasks);
    db.seq.task_files = maxId(db.task_files);
    db.seq.task_file_chunks = maxId(db.task_file_chunks);
    db.seq.credits = maxId(db.unit_credits);
    save(db);
    return ok({ imported: { units: db.units.length, debts: db.debts.length, expenses: db.expenses.length, users: userRows.length, polls: db.polls.length, poll_votes: db.poll_votes.length, tasks: db.tasks.length, task_files: db.task_files.length, unit_credits: db.unit_credits.length, exported_at: body.exported_at || null } });
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
    // v2.22.0 — اعلان دمویی ساخت واحد (اگر تیک خورده باشد)
    if (notifCfgOf(db).unit_change && me && me.role !== 'admin') {
      demoNotify('unit_change', 'افزودن/ویرایش/حذف واحد', '🔔 ' + ((db.settings || {}).building_name || 'ساختمان') + '\nافزودن/ویرایش/حذف واحد\n\n• واحد ' + unit.number + ' اضافه شد\n\nانجام‌دهنده: ' + (me.full_name || me.username) + ' — مدیر ساختمان', me, unit.id, unit.number, unit.id);
    }
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
    if (!u.telegram_linked) return err('این کاربر هنوز به تلگرام متصل نشده است؛ به‌محض اولین ورود او به اپ داخل تلگرام، اتصال خودکار انجام می‌شود', 409, 'not_linked');
    save(db);
    return ok({ ok: true, user: { id: u.id, username: u.username, full_name: u.full_name } });
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

  // ---------- v2.17.0 — لینک دعوت یک‌بارمصرف (مدیر ساختمان + از v2.18.0 مدیر اپ) ----------
  if (path === '/invites' && method === 'GET') {
    const g = roleGuard('manager', 'admin'); if (g) return g;
    const t = Math.floor(Date.now() / 1000);
    const list = (db.invites || [])
      .filter(i => !i.used_at && i.expires_at > t)
      .sort((a, b) => b.id - a.id)
      .slice(0, 50)
      .map(i => {
        const u = db.users.find(x => x.id === i.user_id) || {};
        return {
          ...mockInvitePub(db, i),
          username: u.username || '', full_name: u.full_name || '', role: u.role || 'resident',
          unit_number: (db.units.find(x => x.id === u.unit_id) || {}).number || null
        };
      });
    return ok({ invites: list });
  }
  if (path === '/invites' && method === 'POST') {
    const g = roleGuard('manager', 'admin'); if (g) return g;
    const u = db.users.find(x => x.id === num(body.user_id));
    if (!u) return err('کاربر پیدا نشد', 404);
    if (u.role === 'admin') return err('برای حساب مدیر اپ لینک دعوت ساخته نمی‌شود', 409);
    if (!u.is_active) return err('این حساب غیرفعال است؛ اول فعالش کنید', 409);
    const hours = Math.min(720, Math.max(1, Math.round(Number(body.hours) || 24)));
    const t = Math.floor(Date.now() / 1000);
    db.invites = (db.invites || []).filter(i => !(i.user_id === u.id && !i.used_at));
    const inv = {
      id: db.seq.invites++,
      token: Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join(''),
      user_id: u.id, created_by: me.id, created_at: t, expires_at: t + hours * 3600,
      used_at: null, used_by_tg: null
    };
    db.invites.push(inv);
    save(db);
    return ok({ invite: mockInvitePub(db, inv), user: pub(u) }, 201);
  }
  if (path.startsWith('/invites/') && method === 'DELETE') {
    const g = roleGuard('manager', 'admin'); if (g) return g;
    const id = Number(path.split('/')[2]);
    db.invites = (db.invites || []).filter(i => i.id !== id);
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
    // v2.15.0 — صدور برای همه یا چند واحد انتخابی (آینهٔ src/manager.js)
    let idFilter = null;
    if (Array.isArray(body.unit_ids) && body.unit_ids.length) {
      idFilter = new Set(body.unit_ids.map(x => Number(x) || 0).filter(Boolean));
      if (!idFilter.size) return err('واحدی برای صدور انتخاب نشده است');
    }
    const targets = idFilter ? db.units.filter(u => idFilter.has(u.id)) : db.units;
    if (idFilter && !targets.length) return err('هیچ‌کدام از واحدهای انتخابی پیدا نشد', 404);
    let created = 0, skipped = 0;
    const noArea = [];
    targets.forEach(u => {
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
    // v2.21.0 — مصرف خودکار اعتبار اضافه‌پرداخت (آینهٔ autoConsumeCredit سرور):
    // برای هر واحدی که قلم تازه صادر شد، اعتبارش FIFO روی اقلام باز همان واحد مصرف می‌شود
    let creditUsedTotal = 0, creditUnits = 0;
    targets.forEach(u => {
      const hasNew = db.debts.some(dd => dd.unit_id === u.id && dd.period === period && dd.kind === 'monthly' && dd.method === '');
      if (!hasNew) return;
      let balance = db.unit_credits.filter(c => c.unit_id === u.id).reduce((s, c) => s + c.amount, 0);
      if (balance <= 0) return;
      let usedU = 0;
      const open = db.debts.filter(dd => dd.unit_id === u.id && dd.paid_amount < dd.amount)
        .sort((a, b) => String(a.period).localeCompare(String(b.period)) || a.id - b.id);
      for (const d of open) {
        if (balance <= 0) break;
        const rem = d.amount - d.paid_amount;
        if (rem <= 0) continue;
        const take = Math.min(rem, balance);
        d.paid_amount += take;
        d.status = d.paid_amount >= d.amount ? 'paid' : 'partial';
        d.paid_at = Math.floor(Date.now() / 1000);
        d.method = 'اعتبار اضافه‌پرداخت';
        d.note = d.note ? (String(d.note).slice(0, 180) + ' | پیش‌پرداخت با اعتبار اضافه‌پرداخت') : 'پیش‌پرداخت با اعتبار اضافه‌پرداخت';
        db.unit_credits.push({ id: db.seq.credits++, unit_id: u.id, amount: -take, kind: 'consume', debt_id: d.id, period, note: 'مصرف خودکار در صدور شارژ', created_at: Math.floor(Date.now() / 1000) });
        balance -= take; usedU += take;
      }
      if (usedU > 0) { creditUsedTotal += usedU; creditUnits++; }
    });
    save(db);
    return ok({ created, skipped, no_area: noArea, credit_used_total: creditUsedTotal, credit_units: creditUnits });
  }
  if (path.endsWith('/pay') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const d = db.debts.find(x => x.id === id);
    if (!d) return err('قلم بدهی پیدا نشد', 404);
    const remaining = d.amount - d.paid_amount;
    const amt = body.amount == null ? remaining : num(body.amount);
    if (!(amt > 0)) return err('مبلغ نامعتبر است');
    // v2.21.0 — اضافه‌پرداخت: بدون تأیید صریح (overpay) رد می‌شود (آینهٔ سرور)
    if (amt > remaining && !body.overpay) return err('مبلغ بیشتر از مانده بدهی است؛ مابه‌التفاوت به‌عنوان اعتبار اضافه‌پرداخت ثبت شود؟', 400, 'overpay_possible');
    const applied = Math.min(amt, remaining);
    const excess = amt - applied;
    d.paid_amount += applied;
    d.status = d.paid_amount >= d.amount ? 'paid' : 'partial';
    d.paid_at = body.date ? num(body.date) : Math.floor(Date.now() / 1000);
    d.method = String(body.method || '');
    if (body.note) d.note = String(body.note).slice(0, 200);
    let credited = 0, creditBalance = null;
    if (excess > 0) {
      credited = excess;
      db.unit_credits.push({ id: db.seq.credits++, unit_id: d.unit_id, amount: excess, kind: 'add', debt_id: null, period: d.period, note: 'اضافه‌پرداخت هنگام ثبت پرداخت' + (body.note ? ' — ' + String(body.note).slice(0, 120) : ''), created_by: me.id, created_at: Math.floor(Date.now() / 1000) });
      creditBalance = db.unit_credits.filter(c => c.unit_id === d.unit_id).reduce((s, c) => s + c.amount, 0);
    }
    save(db);
    const u = db.units.find(x => x.id === d.unit_id);
    return ok({ debt: { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' }, applied, credited, credit_balance: creditBalance });
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
  // v2.12.0 — ویرایش پرداخت ثبت‌شده (آینه سرور)
  if (path.endsWith('/pay-edit') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const d = db.debts.find(x => x.id === id);
    if (!d) return err('قلم بدهی پیدا نشد', 404);
    const amt = Math.round(num(body.amount) || 0);
    if (!(amt > 0)) return err('مبلغ پرداخت باید بزرگ‌تر از صفر باشد');
    if (amt > d.amount) return err('مبلغ پرداخت نمی‌تواند از مبلغ کل بیشتر باشد');
    d.paid_amount = amt;
    d.status = amt >= d.amount ? 'paid' : 'partial';
    d.paid_at = body.date ? num(body.date) : (d.paid_at || Math.floor(Date.now() / 1000));
    if (body.method !== undefined) d.method = String(body.method).slice(0, 50);
    if (body.note !== undefined) d.note = String(body.note).trim().slice(0, 200);
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

  // ---------- tasks (کارهای مدیر ساختمان) — v2.13.0 ----------
  const TASK_CATEGORIES = ['نظافت', 'تعمیرات', 'آسانسور', 'برق', 'آب', 'گاز', 'نگهبانی', 'باغبانی', 'اداری و مالی', 'خرید و تدارکات', 'سایر'];
  const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);
  const jalaliYearRangeMock = jy => {
    const midnight = (yy, jm, jd) => {
      const g = toGregorian(yy, jm, jd);
      return Math.floor(Date.UTC(g.gy, g.gm - 1, g.gd) / 1000) - 12600;
    };
    return { start: midnight(jy, 1, 1), end: midnight(jy + 1, 1, 1) };
  };
  const tsJyMock = ts => {
    const p = tehranParts(ts * 1000);
    return toJalaaliFromParts(p.gy, p.gm, p.gd).jy;
  };
  void tsJyMock;
  const withFiles = t => ({
    ...t,
    files: db.task_files.filter(f => f.task_id === t.id).map(f => ({ id: f.id, task_id: f.task_id, name: f.name, mime: f.mime, size: f.size, created_at: f.created_at }))
  });
  const fundTotalsMock = (range, jy) => {
    const collected = db.debts.filter(d => !jy || String(d.period || '').startsWith(jy + '-')).reduce((s, d) => s + (d.paid_amount || 0), 0);
    const expenses = db.expenses.filter(e => !jy || String(e.period || '').startsWith(jy + '-')).reduce((s, e) => s + (e.amount || 0), 0);
    const tasksCost = db.tasks.filter(t => !range || (t.done_at >= range.start && t.done_at < range.end)).reduce((s, t) => s + (t.cost || 0), 0);
    // v2.14.1 — موجودی اولیه فقط در ماندهٔ کلی (بدون فیلتر سال) لحاظ می‌شود
    const opening = (!range && !jy) ? getFundOpeningMock() : { amount: 0, note: '', updated_at: null };
    return { collected, expenses, tasks_cost: tasksCost, opening: opening.amount || 0, balance: (opening.amount || 0) + collected - expenses - tasksCost };
  };
  const getFundOpeningMock = () => {
    const raw = (db.settings || {}).fund_opening;
    if (!raw) return { amount: 0, note: '', updated_at: null };
    try { const o = JSON.parse(raw); return { amount: Number(o && o.amount) || 0, note: String((o && o.note) || ''), updated_at: Number(o && o.updated_at) || null }; }
    catch { return { amount: 0, note: '', updated_at: null }; }
  };

  if (path === '/tasks' && method === 'GET') {
    if (guard()) return guard();
    const jy = q.get('jy');
    const range = /^\d{4}$/.test(jy || '') ? jalaliYearRangeMock(Number(jy)) : null;
    const rows = db.tasks.filter(t => !range || (t.done_at >= range.start && t.done_at < range.end))
      .sort((a, b) => (b.done_at || 0) - (a.done_at || 0) || b.id - a.id);
    return ok({ tasks: rows.map(withFiles), categories: TASK_CATEGORIES });
  }
  if (path === '/tasks' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return err('عنوان کار الزامی است');
    const cat = TASK_CATEGORIES.includes(body.category) ? body.category : 'سایر';
    const nowSec = Math.floor(Date.now() / 1000);
    const row = {
      id: db.seq.tasks++, title, category: cat,
      description: String(body.description || '').trim().slice(0, 2000),
      cost: Math.max(0, num(body.cost)),
      done_at: body.date ? (Number(body.date) || nowSec) : nowSec,
      created_by: me.id, created_at: nowSec, updated_at: null
    };
    db.tasks.push(row); save(db);
    // v2.14.2 — آینهٔ اعلام کار جدید: تعداد اعضای متصل دمو
    const notified = body.notify === false ? 0
      : (db.users || []).filter(u => u.telegram_user_id && u.id !== me.id).length;
    return ok({ task: withFiles(row), notified, notify_queued: body.notify !== false }, 201);
  }
  // v2.14.1 — تنظیم موجودی اولیهٔ صندوق (پول نزد مدیر قبلی) — باید قبل از
  // PUT /tasks/:id باشد وگرنه همان مسیر آن را می‌گیرد (آینهٔ src/tasks.js)
  if (path === '/tasks/fund' && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) return err('مبلغ موجودی اولیه را درست وارد کنید');
    if (Math.abs(amount) > 1e12) return err('مبلغ موجودی اولیه بیش از حد مجاز است');
    const note = String(body.note || '').trim().slice(0, 200);
    const payload = { amount: Math.round(amount), note, updated_at: Math.floor(Date.now() / 1000), updated_by: me.id };
    db.settings = db.settings || {};
    db.settings.fund_opening = JSON.stringify(payload);
    save(db);
    return ok({ ok: true, fund_opening: { amount: payload.amount, note: payload.note, updated_at: payload.updated_at } });
  }
  if (path.startsWith('/tasks/') && (method === 'PUT' || method === 'DELETE') && !path.endsWith('/files') && !path.startsWith('/tasks/files/')) {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const t = db.tasks.find(x => x.id === id);
    if (!t) return err('کار پیدا نشد', 404);
    if (method === 'DELETE') {
      const fids = db.task_files.filter(f => f.task_id === id).map(f => f.id);
      db.task_file_chunks = db.task_file_chunks.filter(c => !fids.includes(c.file_id));
      db.task_files = db.task_files.filter(f => f.task_id !== id);
      db.tasks = db.tasks.filter(x => x.id !== id);
      save(db);
      return ok({ ok: true });
    }
    const body0 = body || {};
    if (body0.title !== undefined) {
      const title = String(body0.title || '').trim().slice(0, 120);
      if (!title) return err('عنوان کار الزامی است');
      t.title = title;
    }
    if (body0.category !== undefined) t.category = TASK_CATEGORIES.includes(body0.category) ? body0.category : 'سایر';
    if (body0.description !== undefined) t.description = String(body0.description || '').trim().slice(0, 2000);
    if (body0.cost !== undefined) t.cost = Math.max(0, num(body0.cost));
    if (body0.date !== undefined) t.done_at = Number(body0.date) || t.done_at;
    t.updated_at = Math.floor(Date.now() / 1000);
    save(db);
    return ok({ task: withFiles(t) });
  }
  if (path.startsWith('/tasks/') && path.endsWith('/files') && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    if (!db.tasks.find(x => x.id === id)) return err('کار پیدا نشد', 404);
    const mime = String(body.mime || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return err('فقط تصویر (JPG/PNG/WebP/GIF) یا PDF پذیرفته می‌شود', 400, 'bad_mime');
    const cnt = db.task_files.filter(f => f.task_id === id).length;
    if (cnt >= 8) return err('حداکثر ۸ مدرک برای هر کار مجاز است', 409, 'too_many_files');
    const norm = String(body.data_b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    let binLen = 0;
    try { binLen = Math.floor((norm || '').length * 3 / 4); } catch { /* ignore */ }
    if (!binLen) return err('محتوای فایل خالی است');
    if (binLen > 6 * 1024 * 1024) return err('حجم مدرک بیش از حد مجاز است (حداکثر ۶ مگابایت)', 413, 'file_too_large');
    const nowSec = Math.floor(Date.now() / 1000);
    const file = { id: db.seq.task_files++, task_id: id, name: String(body.name || 'مدرک').slice(0, 120), mime, size: binLen, created_at: nowSec };
    db.task_files.push(file);
    // آینه سرور: ذخیره در قطعات ~۶۰ کیلوبایتی (base64 در دمو)
    const CHUNK_B64 = 80 * 1024;
    for (let off = 0, idx = 0; off < norm.length; off += CHUNK_B64, idx++) {
      db.task_file_chunks.push({ id: db.seq.task_file_chunks++, file_id: file.id, idx, data: norm.slice(off, off + CHUNK_B64) });
    }
    save(db);
    return ok({ file: { id: file.id, task_id: id, name: file.name, mime: file.mime, size: file.size, created_at: file.created_at } }, 201);
  }
  if (path.startsWith('/tasks/files/') && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[3]);
    if (!db.task_files.find(f => f.id === id)) return err('مدرک پیدا نشد', 404);
    db.task_file_chunks = db.task_file_chunks.filter(c => c.file_id !== id);
    db.task_files = db.task_files.filter(f => f.id !== id);
    save(db);
    return ok({ ok: true });
  }
  if (path.startsWith('/tasks/files/') && method === 'GET') {
    if (guard()) return guard();
    const id = Number(path.split('/')[3]);
    const f = db.task_files.find(x => x.id === id);
    if (!f) return err('مدرک پیدا نشد', 404);
    const data = db.task_file_chunks.filter(c => c.file_id === id).sort((a, b) => a.idx - b.idx).map(c => c.data).join('');
    return ok({ __file: { name: f.name, mime: f.mime, data_b64: data } });
  }

  // ---------- v2.21.0 — اعتبار اضافه‌پرداخت (آینهٔ src/credits.js) ----------
  // function declaration — hoisted؛ /my/summary که بالاتر در همین تابع است هم استفاده می‌کند
  function unitCreditOf(uid) { return Math.max(0, db.unit_credits.filter(c => c.unit_id === uid).reduce((s, c) => s + c.amount, 0)); }
  function creditEntry(e) {
    const u = db.units.find(x => x.id === e.unit_id);
    return { ...e, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' };
  }
  if (path === '/credits' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    const uid = Number(q.get('unit_id') || 0);
    const balances = db.units.map(u => ({ unit_id: u.id, unit_number: u.number, resident_name: u.resident_name, credit: unitCreditOf(u.id) }))
      .filter(b => b.credit !== 0);
    const entries = uid ? db.unit_credits.filter(c => c.unit_id === uid) : db.unit_credits;
    return ok({ balances, entries: entries.slice().sort((a, b) => b.id - a.id).slice(0, 200).map(creditEntry), total: balances.reduce((s, b) => s + b.credit, 0) });
  }
  if (path === '/credits' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const uid = num(body.unit_id);
    const amount = Math.round(num(body.amount) || 0);
    if (!uid) return err('واحد مشخص نشده است');
    if (!(amount > 0)) return err('مبلغ اضافه‌پرداخت باید بزرگ‌تر از صفر باشد');
    const unit = db.units.find(u => u.id === uid);
    if (!unit) return err('واحد پیدا نشد', 404);
    db.unit_credits.push({ id: db.seq.credits++, unit_id: uid, amount, kind: 'add', debt_id: null, period: String(body.period || '').slice(0, 10), note: String(body.note || 'ثبت دستی اضافه‌پرداخت').slice(0, 300), created_by: me.id, created_at: Math.floor(Date.now() / 1000) });
    save(db);
    return ok({ ok: true, unit_id: uid, registered: amount, credit_balance: unitCreditOf(uid) }, 201);
  }
  if (/^\/credits\/\d+$/.test(path) && method === 'DELETE') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const row = db.unit_credits.find(x => x.id === id);
    if (!row) return err('ردیف اعتبار پیدا نشد', 404);
    if (row.kind !== 'add') return err('ردیف‌های «مصرف اعتبار» قابل حذف نیستند — بدهی قلم مربوطه را لغو/اصلاح کنید', 409, 'consume_locked');
    const balance = unitCreditOf(row.unit_id);
    if (balance - row.amount < 0) return err('این اضافه‌پرداخت قبلاً مصرف شده است و قابل حذف نیست؛ ابتدا مصرف آن را از قلم مربوطه لغو کنید', 409, 'already_consumed');
    db.unit_credits = db.unit_credits.filter(x => x.id !== id);
    save(db);
    return ok({ ok: true, credit_balance: balance - row.amount });
  }
  if (path === '/credits/apply' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const debtId = num(body.debt_id);
    const d = db.debts.find(x => x.id === debtId);
    if (!d) return err('قلم بدهی پیدا نشد', 404);
    if (d.paid_amount >= d.amount) return err('این قلم قبلاً تسویه شده است', 409, 'already_paid');
    const balance = unitCreditOf(d.unit_id);
    if (balance <= 0) return err('این واحد اعتبار قابل مصرف ندارد', 409, 'no_credit');
    const used = Math.min(balance, d.amount - d.paid_amount);
    d.paid_amount += used;
    d.status = d.paid_amount >= d.amount ? 'paid' : 'partial';
    d.paid_at = d.paid_at || Math.floor(Date.now() / 1000);
    d.method = 'اعتبار اضافه‌پرداخت';
    d.note = d.note ? (String(d.note).slice(0, 180) + ' | اعمال دستی اعتبار توسط مدیر') : 'اعمال دستی اعتبار توسط مدیر';
    db.unit_credits.push({ id: db.seq.credits++, unit_id: d.unit_id, amount: -used, kind: 'consume', debt_id: d.id, period: d.period, note: 'اعمال دستی اعتبار توسط مدیر', created_at: Math.floor(Date.now() / 1000) });
    save(db);
    const u = db.units.find(x => x.id === d.unit_id);
    const after = Math.max(0, db.debts.filter(x => x.unit_id === d.unit_id).reduce((s, x) => s + (x.amount - x.paid_amount), 0));
    return ok({ ok: true, used, debt: { ...d, unit_number: u ? u.number : '', resident_name: u ? u.resident_name : '' }, credit_balance: unitCreditOf(d.unit_id), unit_remaining: after });
  }
  if (path === '/my/credit' && method === 'GET') {
    const g = roleGuard('resident', 'manager'); if (g) return g;
    const unit = db.units.find(u => u.id === me.unit_id);
    if (!unit) return err('به هیچ واحدی متصل نیستید', 403, 'no_unit');
    return ok({ unit_id: unit.id, balance: unitCreditOf(unit.id), entries: db.unit_credits.filter(c => c.unit_id === unit.id).sort((a, b) => b.id - a.id).slice(0, 50).map(creditEntry) });
  }

  // ---------- v2.16.0 — رسیده‌های پرداخت شارژ (آینهٔ src/claims.js) ----------
  // ترتیب مهم است: مسیر فایل‌ها قبل از مسیرهای id-محور
  if (path.startsWith('/claims/files/') && method === 'GET') {
    if (guard()) return guard();
    const id = Number(path.split('/')[3]);
    const f = db.claim_files.find(x => x.id === id);
    if (!f) return err('فیش پیدا نشد', 404);
    const claim = db.payment_claims.find(x => x.id === f.claim_id);
    if (!claim) return err('رسید پیدا نشد', 404);
    if (me.role !== 'manager' && me.role !== 'admin' && me.unit_id !== claim.unit_id) {
      return err('شما به این فیش دسترسی ندارید', 403, 'forbidden');
    }
    const data = db.claim_file_chunks.filter(c => c.file_id === id).sort((a, b) => a.idx - b.idx).map(c => c.data).join('');
    return ok({ __file: { name: f.name, mime: f.mime, data_b64: data } });
  }
  if (path === '/claims' && method === 'GET') {
    if (guard()) return guard();
    const isMgr = me.role === 'manager' || me.role === 'admin';
    const rows = db.payment_claims
      .filter(x => isMgr || x.unit_id === me.unit_id)
      .slice()
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || b.id - a.id)
      .slice(0, isMgr ? 200 : 50);
    const claimsOut = rows.map(x => {
      const u = db.units.find(un => un.id === x.unit_id) || {};
      // v2.23.0 — ماندهٔ کل بدهی واحد (فقط برای مدیر/ادمین — نمایش زیر «تأیید شد»)
      const remaining = db.debts
        .filter(d => d.unit_id === x.unit_id)
        .reduce((sum, d) => sum + Math.max(0, (d.amount || 0) - (d.paid_amount || 0)), 0);
      const out = {
        ...x,
        unit_number: u.number || '',
        unit_resident: u.resident_name || '',
        files: db.claim_files.filter(f => f.claim_id === x.id)
      };
      if (isMgr) out.unit_remaining = remaining;
      return out;
    });
    return ok({ claims: claimsOut });
  }
  if (path === '/claims' && method === 'POST') {
    const g = roleGuard('resident', 'manager'); if (g) return g;
    const unit = db.units.find(u => u.id === me.unit_id);
    if (!unit) return err('به هیچ واحدی متصل نیستید؛ با مدیر ساختمان تماس بگیرید', 403, 'no_unit');
    if (db.payment_claims.some(x => x.unit_id === unit.id && x.status === 'pending')) {
      return err('شما یک رسید در انتظار بررسی دارید؛ لطفاً منتظر تأیید مدیر ساختمان بمانید', 409, 'claim_pending');
    }
    const amount = num(body.amount);
    if (!(amount > 0)) return err('مبلغ پرداخت‌شده را وارد کنید');
    if (amount > 1e12) return err('مبلغ بیش از حد مجاز است');
    const note = String(body.note || '').trim().slice(0, 500);
    const f = body.file || {};
    const mime = String(f.mime || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return err('فیش واریزی الزامی است — فقط تصویر (JPG/PNG/WebP/GIF) یا PDF پذیرفته می‌شود', 400, 'bad_mime');
    const norm = String(f.data_b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
    if (!norm) return err('فایل فیش واریزی خالی است — دوباره انتخاب کنید');
    if (Math.floor(norm.length * 3 / 4) > 6 * 1024 * 1024) return err('حجم فیش بیش از حد مجاز است (حداکثر ۶ مگابایت)', 413, 'file_too_large');
    const nowSec = Math.floor(Date.now() / 1000);
    const claim = {
      id: db.seq.claims++, unit_id: unit.id, user_id: me.id, amount, note,
      status: 'pending', confirmed_amount: null, reject_note: '', confirmed_by: null,
      created_at: nowSec, confirmed_at: null
    };
    db.payment_claims.push(claim);
    const file = { id: db.seq.claim_files++, claim_id: claim.id, name: String(f.name || 'fish-varizi').slice(0, 120), mime, size: Math.floor(norm.length * 3 / 4), created_at: nowSec };
    db.claim_files.push(file);
    const CHUNK_B64 = 80 * 1024;
    for (let off = 0, idx = 0; off < norm.length; off += CHUNK_B64, idx++) {
      db.claim_file_chunks.push({ id: db.seq.claim_file_chunks++, file_id: file.id, idx, data: norm.slice(off, off + CHUNK_B64) });
    }
    save(db);
    return ok({ claim: { ...claim, files: [file] }, notify_queued: true }, 201);
  }
  if (/^\/claims\/\d+\/confirm$/.test(path) && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const claim = db.payment_claims.find(x => x.id === id);
    if (!claim) return err('رسید پیدا نشد', 404);
    if (claim.status !== 'pending') return err('این رسید قبلاً بررسی شده است', 409, 'already_reviewed');
    const unit = db.units.find(u => u.id === claim.unit_id);
    if (!unit) return err('واحد این رسید پیدا نشد', 404);
    const unitDebts = db.debts.filter(d => d.unit_id === unit.id);
    const remaining = Math.max(0, unitDebts.reduce((s, d) => s + (d.amount - d.paid_amount), 0));
    if (remaining <= 0) return err('بدهی این واحد تسویه شده است؛ رسید را رد کنید یا ابتدا بدهی را اصلاح کنید', 409, 'no_debt');
    let amt = (body.amount == null || body.amount === '') ? remaining : num(body.amount);
    if (!(amt > 0)) return err('مبلغ نامعتبر است');
    // v2.21.0 — اضافه‌پرداخت: بدون تأیید صریح رد می‌شود (آینهٔ سرور)
    if (amt > remaining && !body.overpay) return err('مبلغ بیشتر از مانده بدهی واحد است (' + remaining.toLocaleString('en-US') + ' تومان) — مابه‌التفاوت به‌عنوان اعتبار اضافه‌پرداخت ثبت شود؟', 400, 'overpay_possible');
    const appliedTotal = Math.min(amt, remaining);
    const excess = amt - appliedTotal;
    // FIFO — قدیمی‌ترین دوره اول (آینهٔ applyFifoPayment سرور)
    let left = appliedTotal;
    for (const d of unitDebts.slice().sort((a, b) => String(a.period).localeCompare(String(b.period)) || a.id - b.id)) {
      if (left <= 0) break;
      const rem = d.amount - d.paid_amount;
      if (rem <= 0) continue;
      const take = Math.min(rem, left);
      d.paid_amount += take;
      d.status = d.paid_amount >= d.amount ? 'paid' : 'partial';
      d.paid_at = Math.floor(Date.now() / 1000);
      d.method = 'رسید تأییدشده';
      const noteAdd = 'رسید پرداخت ساکن #' + claim.id + (claim.note ? ' — ' + claim.note.slice(0, 120) : '');
      d.note = d.note ? (String(d.note).slice(0, 180) + ' | ' + noteAdd) : noteAdd;
      left -= take;
    }
    const applied = appliedTotal - left;
    let credited = 0, creditBalance = null;
    if (excess > 0) {
      credited = excess;
      db.unit_credits.push({ id: db.seq.credits++, unit_id: unit.id, amount: excess, kind: 'add', debt_id: null, period: currentPeriod(), note: 'اضافه‌پرداخت رسید #' + claim.id, created_by: me.id, created_at: Math.floor(Date.now() / 1000) });
      creditBalance = db.unit_credits.filter(c => c.unit_id === unit.id).reduce((s, c) => s + c.amount, 0);
    }
    claim.status = 'confirmed';
    claim.confirmed_amount = applied + credited;
    claim.confirmed_by = me.id;
    claim.confirmed_at = Math.floor(Date.now() / 1000);
    save(db);
    const after = Math.max(0, db.debts.filter(d => d.unit_id === unit.id).reduce((s, d) => s + (d.amount - d.paid_amount), 0));
    return ok({ claim, applied, credited, credit_balance: creditBalance, unit_remaining: after });
  }
  if (/^\/claims\/\d+\/reject$/.test(path) && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const id = Number(path.split('/')[2]);
    const claim = db.payment_claims.find(x => x.id === id);
    if (!claim) return err('رسید پیدا نشد', 404);
    if (claim.status !== 'pending') return err('این رسید قبلاً بررسی شده است', 409, 'already_reviewed');
    claim.status = 'rejected';
    claim.reject_note = String(body.reason || '').trim().slice(0, 500);
    claim.confirmed_by = me.id;
    claim.confirmed_at = Math.floor(Date.now() / 1000);
    save(db);
    return ok({ claim });
  }
  if (path === '/reports/performance') {
    if (guard()) return guard();
    const jy = /^\d{4}$/.test(q.get('jy') || '') ? q.get('jy') : String(currentPeriod().slice(0, 4));
    const range = jalaliYearRangeMock(Number(jy));
    const yearTasks = db.tasks.filter(t => t.done_at >= range.start && t.done_at < range.end)
      .sort((a, b) => (b.done_at || 0) - (a.done_at || 0) || b.id - a.id);
    const yearExpenses = db.expenses.filter(e => String(e.period || '').startsWith(jy + '-'));
    const months = Array.from({ length: 12 }, (_, i) => ({ period: `${jy}-${String(i + 1).padStart(2, '0')}`, tasks: 0, cost: 0, expenses: 0, collected: 0 }));
    for (const t of yearTasks) {
      if (!t.done_at) continue;
      const p = tehranParts(t.done_at * 1000);
      const jm = toJalaaliFromParts(p.gy, p.gm, p.gd).jm;
      if (months[jm - 1]) { months[jm - 1].tasks++; months[jm - 1].cost += t.cost || 0; }
    }
    for (const e of yearExpenses) {
      const m = Number(String(e.period || '').slice(5, 7));
      if (m >= 1 && m <= 12) months[m - 1].expenses += e.amount || 0;
    }
    for (const d of db.debts) {
      if (!String(d.period || '').startsWith(jy + '-')) continue;
      const m = Number(String(d.period).slice(5, 7));
      if (m >= 1 && m <= 12) months[m - 1].collected += d.paid_amount || 0;
    }
    const catMap = new Map();
    for (const t of yearTasks) {
      const cat = t.category || 'سایر';
      const cur = catMap.get(cat) || { category: cat, count: 0, cost: 0 };
      cur.count++; cur.cost += t.cost || 0;
      catMap.set(cat, cur);
    }
    return ok({
      jy,
      fund: fundTotalsMock(range, jy),
      fund_all: fundTotalsMock(null, null),
      fund_opening: getFundOpeningMock(),
      totals: {
        tasks: yearTasks.length,
        cost: yearTasks.reduce((s, t) => s + (t.cost || 0), 0),
        expenses_count: yearExpenses.length,
        expenses_amount: yearExpenses.reduce((s, e) => s + (e.amount || 0), 0)
      },
      months,
      categories: [...catMap.values()].sort((a, b) => b.cost - a.cost || b.count - a.count),
      tasks: yearTasks.map(withFiles),
      expenses: yearExpenses
    });
  }

  if (path === '/notify/preview') {
    const g = roleGuard('manager'); if (g) return g;
    const debtorUnits = new Set(db.debts.filter(d => d.amount > d.paid_amount).map(d => d.unit_id)).size;
    // v2.17.0 — مدیرِ ساکن هم جزو گیرندگان است (مگر با تیک «ساکن نیست»)
    const linkedTargets = db.users.filter(u => u.is_active && u.telegram_linked && u.unit_id
      && (u.role === 'resident' || (u.role === 'manager' && u.is_resident !== false))).length;
    return ok({ bot_configured: true, linked_residents: linkedTargets, debtor_units: debtorUnits });
  }
  if (path === '/notify/reminders' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const stats = (() => {
      const cands = db.users.filter(u => u.is_active && u.telegram_linked && u.unit_id
        && (u.role === 'resident' || (u.role === 'manager' && u.is_resident !== false)))
        .sort((a, b) => (a.role === 'resident' ? 0 : 1) - (b.role === 'resident' ? 0 : 1));
      const seen = new Set();
      let targets = 0;
      for (const u of cands) {
        if (seen.has(u.unit_id)) continue;
        seen.add(u.unit_id);
        const debt = db.debts.filter(d => d.unit_id === u.unit_id)
          .reduce((s, d) => s + (d.amount - d.paid_amount), 0);
        if (debt > 0) targets++;
      }
      return targets;
    })();
    // demo: sending is simulated so the flow is visible end-to-end
    // v2.14.0 — تعداد یادآوری: unpaid items count the reminder like the server
    const ts = Math.floor(Date.now() / 1000);
    db.debts.forEach(d => {
      if (d.paid_amount < d.amount) { d.remind_count = (d.remind_count || 0) + 1; d.last_remind_at = ts; }
    });
    save(db);
    return ok({ sent: stats, failed: 0, targets: stats, demo: true });
  }
  if (path === '/notify/announce' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    if (!String(body.text || '').trim()) return err('متن اعلان را وارد کنید');
    return ok({ sent: 3, failed: 0, targets: 3, demo: true });
  }

  // ---------- automatic monthly reminder (یادآوری خودکار) ----------
  const AR_DEFAULT_TEXT =
    '{building}\n' +
    '{name} عزیز، مانده بدهی واحد {unit} مبلغ {amount} تومان است.\n' +
    'لطفاً تا پایان {month} نسبت به تسویه اقدام فرمایید.\n' +
    'با تشکر 🙏';
  const roundDays = (day, count) => {
    const d = Math.min(29, Math.max(1, Math.round(Number(day) || 1)));
    const c = Math.min(4, Math.max(1, Math.round(Number(count) || 1)));
    if (c === 1) return [d];
    const step = (29 - d) / (c - 1);
    return Array.from({ length: c }, (_, i) => Math.min(29, d + Math.round(i * step)));
  };
  const mockAutoCfg = () => {
    const day = Math.min(29, Math.max(1, Math.round(Number(db.settings.auto_reminder_day) || 1)));
    const count = Math.min(4, Math.max(1, Math.round(Number(db.settings.auto_reminder_count) || 1)));
    let done = [];
    try {
      const st = JSON.parse(db.settings.auto_reminder_rounds || '{}');
      if (st && Array.isArray(st.r)) done = st.r.map(Number).filter(Number.isFinite);
    } catch { /* ignore */ }
    return {
      enabled: db.settings.auto_reminder_enabled === '1',
      day, count, rounds: roundDays(day, count),
      text: String(db.settings.auto_reminder_text || '').trim() || AR_DEFAULT_TEXT,
      last: db.settings.auto_reminder_last || '',
      done
    };
  };
  const mockAutoStats = () => {
    // v2.17.0 — مدیرِ ساکن هم جزو بدهکاران است؛ اگر واحد هم حساب ساکن و هم مدیرِ
    // ساکن داشته باشد فقط یکی شمرده می‌شود (اولویت ساکن)
    const cands = db.users.filter(u => u.is_active && u.unit_id
      && (u.role === 'resident' || (u.role === 'manager' && u.is_resident !== false)))
      .sort((a, b) => (a.role === 'resident' ? 0 : 1) - (b.role === 'resident' ? 0 : 1));
    const seenUnits = new Set();
    const rows = [];
    for (const u of cands) {
      if (seenUnits.has(u.unit_id)) continue;
      seenUnits.add(u.unit_id);
      const debt = db.debts.filter(d => d.unit_id === u.unit_id)
        .reduce((s, d) => s + (d.amount - d.paid_amount), 0);
      rows.push({ debt: Math.max(0, debt), linked: Boolean(u.telegram_linked) });
    }
    const debtors = rows.filter(r => r.debt > 0);
    return {
      debtor_residents: debtors.length,
      reachable_residents: debtors.filter(r => r.linked).length,
      unreachable_residents: debtors.filter(r => !r.linked).length,
      total_debt: debtors.reduce((s, r) => s + r.debt, 0),
      capped: false
    };
  };
  if (path === '/autoremind' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    return ok({ cfg: mockAutoCfg(), stats: mockAutoStats(), bot_configured: true, default_text: AR_DEFAULT_TEXT });
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
      if (!(count >= 1 && count <= 4)) return err('تعداد یادآوری باید بین ۱ تا ۴ باشد');
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
    return ok({ cfg: mockAutoCfg() });
  }
  if (path === '/autoremind/run' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const stats = mockAutoStats();
    // demo: simulate the same result shape the server returns (rounds marked)
    const cfg = mockAutoCfg();
    db.settings.auto_reminder_rounds = JSON.stringify({ p: currentPeriod(), r: cfg.rounds.map((_, i) => i) });
    db.settings.auto_reminder_last = currentPeriod();
    save(db);
    return ok({
      result: {
        ran: true, period: currentPeriod(), demo: true,
        sent: stats.reachable_residents, failed: 0,
        targets: stats.reachable_residents, unreachable: stats.unreachable_residents,
        total_debt: stats.total_debt, errors: [], capped: false
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
  // ---------- v2.23.0 — صدور خودکار شارژ (آینهٔ manager.js /autocharge) ----------
  function acCfgOf(d) {
    let cfg = {};
    try { cfg = JSON.parse((d.settings || {}).auto_charge_cfg || '{}') || {}; } catch { /* fresh */ }
    return {
      enabled: (cfg.enabled === true || cfg.enabled === 1 || cfg.enabled === '1'),
      day: Math.min(28, Math.max(1, Math.round(Number(cfg.day) || 1))),
      amount: Math.max(0, Math.round(Number(cfg.amount) || 0)),
      mode: ['fixed', 'area', 'person'].includes(cfg.mode) ? cfg.mode : 'fixed',
      lastPeriod: (d.settings || {}).auto_charge_last || ''
    };
  }
  if (path === '/autocharge' && method === 'GET') {
    const g = roleGuard('manager'); if (g) return g;
    const cfg = acCfgOf(db);
    return ok({
      cfg: { enabled: cfg.enabled, day: cfg.day, amount: cfg.amount, mode: cfg.mode },
      last_period: cfg.lastPeriod,
      units: db.units.map(u => ({ id: u.id, number: u.number, resident_name: u.resident_name || '', area_m2: u.area_m2, residents_count: u.residents_count, auto_charge: Boolean(u.auto_charge) })),
      ticked: db.units.filter(u => u.auto_charge).length,
      bot_configured: Boolean((db.settings || {}).bot_token)
    });
  }
  if (path === '/autocharge' && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    const cur = acCfgOf(db);
    const cfg = {
      enabled: body.enabled === undefined ? cur.enabled : Boolean(body.enabled),
      day: body.day === undefined ? cur.day : Math.min(28, Math.max(1, Math.round(Number(body.day) || 1))),
      amount: body.amount === undefined ? cur.amount : Math.max(0, Math.round(Number(body.amount) || 0)),
      mode: ['fixed', 'area', 'person'].includes(body.mode) ? body.mode : cur.mode
    };
    if (cfg.enabled && cfg.amount <= 0) return err('برای صدور خودکار، مبلغ باید بزرگ‌تر از صفر باشد');
    db.settings = db.settings || {};
    db.settings.auto_charge_cfg = JSON.stringify({ enabled: cfg.enabled, day: cfg.day, amount: cfg.amount, mode: cfg.mode });
    save(db);
    return ok({ ok: true, cfg });
  }
  if (path === '/autocharge/unit' && method === 'PUT') {
    const g = roleGuard('manager'); if (g) return g;
    const u = db.units.find(x => x.id === Number((body || {}).unit_id));
    if (!u) return err('واحد پیدا نشد', 404);
    u.auto_charge = Boolean((body || {}).on);
    save(db);
    return ok({ ok: true, unit_id: u.id, on: u.auto_charge, ticked: db.units.filter(x => x.auto_charge).length });
  }
  if (path === '/autocharge/run' && method === 'POST') {
    const g = roleGuard('manager'); if (g) return g;
    const cfg = acCfgOf(db);
    const period = currentPeriod();
    const existing = new Set(db.debts.filter(d => d.period === period && d.kind === 'monthly').map(d => d.unit_id));
    const targets = db.units.filter(u => u.auto_charge && !existing.has(u.id));
    let created = 0, creditUsed = 0;
    const desc = 'شارژ ماه ' + periodLabel(period);
    for (const u of targets) {
      let amt = 0;
      if (cfg.mode === 'fixed') amt = cfg.amount;
      else if (cfg.mode === 'person') amt = Math.round(cfg.amount * (u.residents_count || 1));
      else if (cfg.mode === 'area') {
        if (!u.area_m2) continue;
        amt = Math.round(cfg.amount * u.area_m2);
      }
      if (amt > 0) {
        db.debts.push({ id: db.seq.debts++, unit_id: u.id, kind: 'monthly', expense_id: null, period, description: desc, amount: amt, paid_amount: 0, status: 'unpaid', paid_at: null, method: '', note: '', created_at: Math.floor(Date.now() / 1000) });
        created++;
      }
    }
    db.settings = db.settings || {};
    db.settings.auto_charge_last = period;
    if (notifCfgOf(db).charge_generate && me && me.role !== 'admin') {
      demoNotify('charge_generate', 'صدور شارژ ماه', '🔔 ' + ((db.settings || {}).building_name || 'ساختمان') + '\nصدور شارژ ماه\n\n• صدور خودکار — ماه ' + periodLabel(period) + ': ' + created + ' قلم تازه\n\nانجام‌دهنده: سیستم (خودکار)', null, null, '', null);
    }
    save(db);
    return ok({ result: { ran: true, period, created, skipped: db.units.filter(u => u.auto_charge).length - targets.length, no_area: [], notified: created, notify_failed: 0, credit_used_total: creditUsed, credit_units: 0 } });
  }

  // ---------- v2.23.0 — یادآوری دوره‌ای مدیر ساختمان (آینهٔ src/mreminders.js) ----------
  const FREQ_DEMO = ['daily', 'weekly', 'monthly'];
  const WEEK_DEMO = ['شنبه', 'یک‌شنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنج‌شنبه', 'جمعه'];
  const mreFreq = r => r.freq === 'daily' ? 'هر روز' : (r.freq === 'weekly' ? 'هر ' + (WEEK_DEMO[Number(r.weekday) || 0] || 'هفته') : 'ماهانه — روز ' + (r.month_day || 1) + ' شمسی');
  if (path === '/a/mreminders' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    return ok({
      items: db.manager_reminders.slice().sort((a, b) => b.id - a.id).map(r => ({ ...r, freq_label: mreFreq(r) })),
      manager_count: db.users.filter(u => u.role === 'manager' && u.is_active).length,
      reachable: db.users.filter(u => u.role === 'manager' && u.is_active && u.telegram_linked).length,
      today: {}
    });
  }
  if (path === '/a/mreminders' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const title = String((body || {}).title || '').trim().slice(0, 120);
    if (!title) return err('عنوان یادآوری را وارد کنید');
    const freq = FREQ_DEMO.includes((body || {}).freq) ? body.freq : 'monthly';
    const item = {
      id: db.seq.manager_reminders++, title, text: String((body || {}).text || '').trim().slice(0, 800), freq,
      weekday: freq === 'weekly' ? Math.min(6, Math.max(0, Math.round(Number((body || {}).weekday) || 0))) : null,
      month_day: freq === 'monthly' ? Math.min(28, Math.max(1, Math.round(Number((body || {}).month_day) || 1))) : null,
      is_active: 1, last_sent_at: null, last_sent_day: '', last_sent_period: '',
      created_at: Math.floor(Date.now() / 1000)
    };
    db.manager_reminders.push(item);
    save(db);
    return ok({ ok: true, item: { ...item, freq_label: mreFreq(item) } }, 201);
  }
  if (path.startsWith('/a/mreminders/') && method === 'PUT') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const r = db.manager_reminders.find(x => x.id === id);
    if (!r) return err('یادآوری پیدا نشد', 404);
    const b = body || {};
    if (b.title !== undefined) { const t = String(b.title).trim().slice(0, 120); if (!t) return err('عنوان یادآوری را وارد کنید'); r.title = t; }
    if (b.text !== undefined) r.text = String(b.text).trim().slice(0, 800);
    if (b.freq !== undefined && FREQ_DEMO.includes(b.freq)) {
      if (b.freq !== r.freq) { r.last_sent_day = ''; r.last_sent_period = ''; }
      r.freq = b.freq;
    }
    if (b.weekday !== undefined) r.weekday = Math.min(6, Math.max(0, Math.round(Number(b.weekday) || 0)));
    if (b.month_day !== undefined) r.month_day = Math.min(28, Math.max(1, Math.round(Number(b.month_day) || 1)));
    if (r.freq === 'monthly') r.weekday = null;
    else if (r.freq === 'daily') { r.weekday = null; r.month_day = null; }
    if (b.is_active !== undefined) r.is_active = b.is_active ? 1 : 0;
    save(db);
    return ok({ ok: true, item: { ...r, freq_label: mreFreq(r) } });
  }
  if (path.startsWith('/a/mreminders/') && path.endsWith('/send') && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const r = db.manager_reminders.find(x => x.id === id);
    if (!r) return err('یادآوری پیدا نشد', 404);
    const mgrs = db.users.filter(u => u.role === 'manager' && u.is_active && u.telegram_linked);
    return ok({ ok: true, ran: true, sent: (db.settings || {}).bot_token ? mgrs.length : 0, failed: 0, due: 1, unreachable: mgrs.length === 0 ? 1 : 0 });
  }
  if (path.startsWith('/a/mreminders/') && method === 'DELETE') {
    const g = roleGuard('admin'); if (g) return g;
    const id = Number(path.split('/')[3]);
    const i = db.manager_reminders.findIndex(x => x.id === id);
    if (i < 0) return err('یادآوری پیدا نشد', 404);
    db.manager_reminders.splice(i, 1);
    save(db);
    return ok({ ok: true });
  }

  // ---------- v2.22.0 — اعلان فعالیت‌ها (آینهٔ src/actnotifs.js) ----------
  function notifEventsDemo() { return [
    { key: 'resident_open', group: 'presence', label: 'ساکن اپ را باز کرد', legacy: 'visit_notify_enabled', def: '1' },
    { key: 'resident_login', group: 'presence', label: 'ساکن وارد اپ شد (نام کاربری/تلگرام)', def: '0' },
    { key: 'manager_login', group: 'presence', label: 'مدیر ساختمان وارد اپ شد', def: '0' },
    { key: 'claim_created', group: 'finance', label: 'ساکن رسید پرداخت ثبت کرد', def: '0' },
    { key: 'payment', group: 'finance', label: 'ثبت/ویرایش/لغو پرداخت و اعتبار اضافه‌پرداخت', def: '0' },
    { key: 'charge_generate', group: 'finance', label: 'صدور شارژ ماه', def: '0' },
    { key: 'expense_change', group: 'finance', label: 'ثبت/حذف هزینه مشاع', def: '0' },
    { key: 'unit_change', group: 'mgmt', label: 'افزودن/ویرایش/حذف واحد', def: '0' },
    { key: 'resident_change', group: 'mgmt', label: 'ساخت/ویرایش/حذف حساب ساکن', def: '0' },
    { key: 'poll_change', group: 'mgmt', label: 'نظرسنجی جدید/رأی/بستن نظرسنجی', def: '0' },
    { key: 'task_change', group: 'mgmt', label: 'کار جدید/انجام/حذف کار', def: '0' },
    { key: 'reminder', group: 'mgmt', label: 'ارسال یادآوری بدهی (دستی/خودکار)', def: '0' },
    { key: 'export_import', group: 'security', label: 'خروجی/بکاپ/بازیابی داده', def: '0' },
    { key: 'message_sent', group: 'security', label: 'پیام شخصی ربات به کاربر', def: '0' }
  ]; }
  function notifCfgOf(d) {
    let cfg = {};
    try { cfg = JSON.parse((d.settings || {}).admin_notif_cfg || '{}') || {}; } catch { /* fresh */ }
    const out = {};
    notifEventsDemo().forEach(e => {
      if (e.legacy) out[e.key] = (d.settings || {}).visit_notify_enabled !== '0';
      else out[e.key] = cfg[e.key] === undefined ? e.def === '1' : cfg[e.key] === '1';
    });
    return out;
  }
  // در دمو: اعلان فقط در گزارش ثبت می‌شود (تلگرام واقعی در کار نیست)
  function demoNotify(event, title, text, actor, unitId, unitNumber, refId) {
    db.admin_notifications.push({
      id: db.seq.admin_notifications++, event, title, text,
      actor_user_id: actor ? actor.id : null, actor_username: actor ? actor.username : '',
      actor_role: actor ? actor.role : '', unit_id: unitId || null, unit_number: unitNumber || '',
      ref_id: refId || null, meta: '', sent: 1, send_error: '',
      created_at: Math.floor(Date.now() / 1000)
    });
    save(db);
  }
  if (path === '/a/notifications/config' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    return ok({
      events: notifEventsDemo().map(e => ({
        key: e.key, label: e.label, group: e.group,
        enabled: notifCfgOf(db)[e.key],
        note: e.key === 'resident_open' ? 'همان اعلان تب «ورود کاربران»' : ''
      })),
      groups: [
        { key: 'presence', label: 'ورود و حضور' },
        { key: 'finance', label: 'مدیر ساختمان — مالی' },
        { key: 'mgmt', label: 'مدیر ساختمان — مدیریت' },
        { key: 'security', label: 'داده و امنیت' }
      ],
      admins: db.users.filter(u => u.role === 'admin').map(u => ({
        id: u.id, username: u.username, full_name: u.full_name || '',
        telegram_linked: Boolean(u.telegram_linked), telegram_username: u.telegram_username || ''
      })),
      bot_configured: Boolean((db.settings || {}).bot_token)
    });
  }
  if (path === '/a/notifications/config' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    const events = (body || {}).events || {};
    db.settings = db.settings || {};
    for (const [key, val] of Object.entries(events)) {
      const e = notifEventsDemo().find(x => x.key === key);
      if (!e) return err('رویداد ناشناس: ' + key);
      if (e.legacy) db.settings[e.legacy] = val ? '1' : '0';
      else {
        let cfg = {};
        try { cfg = JSON.parse(db.settings.admin_notif_cfg || '{}') || {}; } catch { /* fresh */ }
        cfg[key] = val ? '1' : '0';
        db.settings.admin_notif_cfg = JSON.stringify(cfg);
      }
    }
    save(db);
    return ok({ ok: true, events: notifCfgOf(db) });
  }
  if (path === '/a/notifications' && method === 'GET') {
    const g = roleGuard('admin'); if (g) return g;
    const ev = q.get('event') || '';
    const sent = q.get('sent');
    let rows = db.admin_notifications.slice().sort((a, b) => b.id - a.id)
      .filter(x => (!ev || x.event === ev))
      .filter(x => (sent !== '0' && sent !== '1' ? true : Number(x.sent) === Number(sent)));
    const total = rows.length;
    const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 50));
    rows = rows.slice(0, limit);
    return ok({
      items: rows,
      total,
      offset: 0,
      limit,
      stats: {
        sent_count: db.admin_notifications.filter(x => x.sent).length,
        failed_count: db.admin_notifications.filter(x => !x.sent).length,
        today_count: db.admin_notifications.filter(x => x.created_at >= Math.floor(Date.now() / 1000) - 86400).length
      }
    });
  }
  if (path === '/a/notifications/test' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    demoNotify('test', 'اعلان آزمایشی', '🔔 ساختمان نمونه\nاعلان آزمایشی\n\n• این یک اعلان آزمایشی است — اگر این پیام را می‌بینید، اتصال تلگرام مدیرکل درست است.\n\nانجام‌دهنده: سیستم (خودکار)', me, null, '', null);
    const row = db.admin_notifications.slice().sort((a, b) => b.id - a.id).find(x => x.event === 'test');
    return ok({ ok: true, sent: row ? Number(row.sent) : 0, send_error: row ? row.send_error : '' });
  }
  if (path === '/a/notifications/link' && method === 'POST') {
    const g = roleGuard('admin'); if (g) return g;
    if (!(db.settings || {}).bot_token) return err('ابتدا توکن ربات را در تب «تنظیمات اپ» ثبت کنید', 400, 'bot_token_missing');
    const token = 'demo' + Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 10);
    db.invites = db.invites || [];
    db.invites.push({ id: db.seq.invites++, token, user_id: me.id, created_by: me.id, created_at: Math.floor(Date.now() / 1000), expires_at: Math.floor(Date.now() / 1000) + 86400, used_at: null, used_by_tg: null });
    save(db);
    return ok({ ok: true, url: 'https://t.me/demo_bot?startapp=' + token, expires_at: Math.floor(Date.now() / 1000) + 86400 }, 201);
  }
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
    const dirRaw = String(q.get('dir') || '').trim().toLowerCase();
    const dir = dirRaw === 'in' || dirRaw === 'out' ? dirRaw : '';
    const qy = String(q.get('q') || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 200));
    const offset = Math.max(0, Number(q.get('offset')) || 0);

    // v2.19.0 — ردیف‌های قدیمی دمو بدون ستون direction به‌صورت دریافتی در نظر گرفته می‌شوند
    const rowsAll = (db.bot_messages || []).map(x => ({ ...x, direction: x.direction === 'out' ? 'out' : 'in' }))
      .sort((a, b) => b.id - a.id);
    const stats = (() => {
      const t = Math.floor(Date.now() / 1000);
      const dayStart = tehranDayStartSec(t);
      const weekStart = t - 7 * 86400;
      const todayRows = rowsAll.filter(x => x.created_at >= dayStart);
      return {
        total: rowsAll.length,
        today: todayRows.length,
        week: rowsAll.filter(x => x.created_at >= weekStart).length,
        senders_today: new Set(todayRows.filter(x => x.direction === 'in').map(x => x.tg_user_id)).size,
        out_total: rowsAll.filter(x => x.direction === 'out').length
      };
    })();
    const titles = Object.entries(rowsAll.reduce((acc, x) => { acc[x.title] = (acc[x.title] || 0) + 1; return acc; }, {}))
      .map(([t, n]) => ({ title: t, n })).sort((a, b) => b.n - a.n);

    const filtered = rowsAll.filter(x =>
      (!from || x.created_at >= from) &&
      (!to || x.created_at <= to) &&
      (!title || x.title === title) &&
      (!dir || x.direction === dir) &&
      (!qy || String(x.text || '').toLowerCase().includes(qy)
        || String(x.full_name || '').toLowerCase().includes(qy)
        || String(x.username || '').toLowerCase().includes(qy))
    );
    const page = filtered.slice(offset, offset + limit);
    const rows = page.map(x => {
      const linked = db.users.find(u => u.telegram_username
        && u.telegram_username.toLowerCase() === String(x.username || '').toLowerCase());
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
      filters: { from, to, title, dir, q: qy, limit, offset }
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
    // v2.21.0 — اعتبار اضافه‌پرداخت واحد (مانده + ماندهٔ مؤثر + تاریخچه)
    const cEntries = db.unit_credits.filter(c => c.unit_id === unit.id).sort((a, b) => b.id - a.id).slice(0, 20);
    const balance = Math.max(0, db.unit_credits.filter(c => c.unit_id === unit.id).reduce((s, c) => s + c.amount, 0));
    return ok({
      unit: { id: unit.id, number: unit.number, resident_name: unit.resident_name, area_m2: unit.area_m2, residents_count: unit.residents_count },
      debts, totals: { issued, paid, remaining: Math.max(0, issued - paid) },
      credit: {
        balance,
        effective_remaining: Math.max(0, (issued - paid) - balance),
        entries: cEntries.map(creditEntry)
      }
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
      app_url: location.origin, version: '2.23.2', counts,
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
      telegram_linked: false, telegram_username: tgU,
      is_resident: body.is_resident === undefined ? true : Boolean(body.is_resident), bound_tg: null
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
    if (!u.telegram_linked) return err('این کاربر هنوز به تلگرام متصل نشده است؛ به‌محض اولین ورود او به اپ داخل تلگرام، اتصال خودکار انجام می‌شود', 409, 'not_linked');
    save(db);
    return ok({ ok: true, user: { id: u.id, username: u.username, full_name: u.full_name } });
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
    if (body.is_resident !== undefined && u.role === 'manager') u.is_resident = Boolean(body.is_resident);
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

