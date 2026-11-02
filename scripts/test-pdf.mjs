// Visual test: build the statement + year report PDFs and save PNG previews.
import fs from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  buildStatementPdf, buildYearReportPdf
} from '../src/pdf.js';
import { currentPeriod } from '../src/jalali.js';

const readFont = f => fs.readFileSync(new URL(`../public/fonts/${f}`, import.meta.url));
const fonts = { regular: readFont('Vazirmatn-Regular.ttf'), bold: readFont('Vazirmatn-Bold.ttf') };

// Fake env with ASSETS reading from the filesystem (same shape as Cloudflare)
const env = {
  ASSETS: {
    fetch: async p => {
      const file = String(p).replace(/^\//, '');
      const data = fs.readFileSync(new URL(`../public/${file}`, import.meta.url));
      return new Response(data);
    }
  }
};

const period = currentPeriod();
const longNote = 'پرداخت از طریق پایا توسط ساکن انجام شد؛ شماره پیگیری ۹۸۷۶۵۴۳۲۱. ' +
  'ساکن اعلام کرد مبلغ باقی‌مانده را تا پایان ماه جاری همراه با شارژ پارکینگ تسویه می‌کند ' +
  'و درخواست فاکتور جداگانه برای سهم آسانسور داشته است. این یک یادداشت عمداً بلند برای آزمایش شکستن سطر است — ' +
  'متنی که نباید چیدمان گزارش را به هم بریزد و باید با سه‌نقطه کوتاه یا در بخش یادداشت‌ها چندسطری نمایش داده شود.';
const sampleDebts = [
  { kind: 'monthly', period, description: `شارژ ماه ${period.slice(0, 4)}`, amount: 650000, paid_amount: 650000, status: 'paid', paid_at: Math.floor(Date.now() / 1000) - 86400 * 3, method: 'کارت به کارت', note: longNote },
  { kind: 'monthly', period, description: 'شارژ ماه', amount: 650000, paid_amount: 300000, status: 'partial', method: 'نقدی', note: 'نیمه اول پرداخت شد' },
  { kind: 'expense', period, description: 'سهم هزینه: قبض برق مشترک', amount: 73000, paid_amount: 0, status: 'unpaid' },
  { kind: 'expense', period, description: 'سهم هزینه: هزینه نظافت و شست‌وشوی راه‌پله', amount: 120000, paid_amount: 0, status: 'unpaid' },
  { kind: 'custom', period, description: 'شارژ پارکینگ مهمان', amount: 50000, paid_amount: 0, status: 'unpaid' }
];
for (const d of sampleDebts) d.description = d.description.replace('شارژ ماه ' + period.slice(0, 4), 'شارژ ماه مهر');

const totals = {
  issued: sampleDebts.reduce((s, d) => s + d.amount, 0),
  paid: sampleDebts.reduce((s, d) => s + d.paid_amount, 0)
};
totals.remaining = totals.issued - totals.paid;

const statementData = {
  building_name: 'برج نگین اصفهان',
  address: 'اصفهان، خیابان سعادت‌آباد، کوچه گلستان، پلاک ۱۲',
  phone: '09131234567',
  bank_card: '6037-9975-1234-5678',
  bank_owner: 'حسین محمدی (مدیر ساختمان)',
  unit: { number: '5', resident_name: 'رضا محمدی', area_m2: 75, residents_count: 3 },
  debts: sampleDebts,
  totals,
  settings: { bank_card: '6037-9975-1234-5678', bank_owner: 'حسین محمدی (مدیر ساختمان)', phone: '09131234567' },
  generated_at: Math.floor(Date.now() / 1000)
};

const series = [];
for (let m = 1; m <= 7; m++) {
  const issued = 5200000 + m * 137000;
  series.push({ period: `1404-${String(m).padStart(2, '0')}`, issued, collected: Math.round(issued * (0.55 + (m % 4) * 0.1)) });
}
const reportData = {
  building_name: 'برج نگین اصفهان',
  address: 'اصفهان، خیابان سعادت‌آباد، کوچه گلستان، پلاک ۱۲',
  jy: '1404',
  series,
  by_unit: [
    { number: '1', resident_name: 'علی رضایی', issued: 823000, paid: 823000 },
    { number: '2', resident_name: 'مریم احمدی', issued: 1045000, paid: 700000 },
    { number: '3', resident_name: 'حسین کریمی', issued: 912000, paid: 912000 },
    { number: '4', resident_name: 'زهرا موسوی', issued: 1157000, paid: 0 },
    { number: '5', resident_name: 'رضا محمدی', issued: 893000, paid: 300000 }
  ],
  generated_at: Math.floor(Date.now() / 1000)
};

const outDir = new URL('../out/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });

const pdf1 = await buildStatementPdf(env, statementData);
fs.writeFileSync(outDir + 'statement.pdf', pdf1);

const pdf2 = await buildYearReportPdf(env, reportData);
fs.writeFileSync(outDir + 'report.pdf', pdf2);

// v2.12.0 — monthly all-units report with notes (long-note layout safety)
const { buildMonthlyReportPdf } = await import('../src/pdf.js');
const monthlyByUnit = [
  { id: 1, number: '1', resident_name: 'علی رضایی', items: 2, issued: 700000, paid: 700000, notes: [{ description: 'شارژ ماه مهر', note: longNote }] },
  { id: 2, number: '2', resident_name: 'مریم احمدی', items: 1, issued: 650000, paid: 300000, notes: [{ description: 'شارژ ماه مهر', note: 'نیمه اول پرداخت شد' }] },
  { id: 3, number: '3', resident_name: 'حسین کریمی', items: 1, issued: 650000, paid: 0, notes: [] },
  { id: 4, number: '4', resident_name: 'زهرا موسوی', items: 0, issued: 0, paid: 0, notes: [] }
];
const monthlyData = {
  building_name: 'برج نگین اصفهان',
  address: 'اصفهان، خیابان سعادت‌آباد، کوچه گلستان، پلاک ۱۲',
  period,
  totals: {
    issued: monthlyByUnit.reduce((s, u) => s + u.issued, 0),
    collected: monthlyByUnit.reduce((s, u) => s + u.paid, 0)
  },
  by_unit: monthlyByUnit,
  generated_at: Math.floor(Date.now() / 1000)
};
monthlyData.totals.remaining = monthlyData.totals.issued - monthlyData.totals.collected;

const pdf3 = await buildMonthlyReportPdf(env, monthlyData);
fs.writeFileSync(outDir + 'monthly.pdf', pdf3);

// sanity: notes of every debt appear truncated/wrapped without breaking pages
const { PDFDocument: PD } = await import('pdf-lib');
const docCheck = await PD.load(pdf3);
console.log('monthly.pdf pages:', docCheck.getPageCount());

// v2.13.0 — performance report (کارها + صندوق + نمودار) با متن‌های عمداً بلند
const { buildPerformanceReportPdf } = await import('../src/pdf.js');
const perfJy = period.slice(0, 4);
const midPeriodTs = Math.floor(Date.now() / 1000);
const perfTasks = [
  { id: 1, title: 'سرویس و شارژ کولرهای تبدیلی راه‌پله و بازدید کامل لوله‌کشی ساختمان (عنوان عمداً بلند برای آزمایش برش امن در ستون عنوان)', category: 'تعمیرات', description: longNote, cost: 850000, done_at: midPeriodTs, files_count: 2 },
  { id: 2, title: 'شست‌وشوی کامل راه‌پله و پارکینگ با دستگاه واترجت', category: 'نظافت', description: '', cost: 600000, done_at: midPeriodTs - 86400 * 6, files_count: 1 },
  { id: 3, title: 'بازدید دوره‌ای آسانسور با شرکت سرویس‌دهنده', category: 'آسانسور', description: '', cost: 350000, done_at: midPeriodTs - 86400 * 21, files_count: 0 },
  { id: 4, title: 'پیگیری قرارداد نگهبانی شبانه', category: 'اداری و مالی', description: '', cost: 0, done_at: midPeriodTs - 86400 * 40, files_count: 0 }
];
const perfMonths = Array.from({ length: 12 }, (_, i) => ({
  period: `${perfJy}-${String(i + 1).padStart(2, '0')}`,
  tasks: i === 6 ? 2 : (i === 5 ? 2 : 0),
  cost: i === 6 ? 1450000 : (i === 5 ? 950000 : 0),
  expenses: i === 6 ? 2000000 : (i % 3 === 0 ? 800000 : 0),
  collected: i <= 6 ? 6500000 : 0
}));
const perfData = {
  building_name: 'برج نگین اصفهان',
  address: 'اصفهان، خیابان سعادت‌آباد، کوچه گلستان، پلاک ۱۲',
  jy: perfJy,
  fund: { collected: 45500000, expenses: 12800000, tasks_cost: 1800000, balance: 30900000 },
  totals: { tasks: 4, cost: 1800000, expenses_count: 2, expenses_amount: 2000000 },
  months: perfMonths,
  categories: [
    { category: 'تعمیرات', count: 1, cost: 850000 },
    { category: 'نظافت', count: 1, cost: 600000 },
    { category: 'آسانسور', count: 1, cost: 350000 }
  ],
  tasks: perfTasks,
  expenses: [
    { id: 1, title: 'هزینه نظافت ماهانه', category: 'نظافت', amount: 1200000, period },
    { id: 2, title: 'قبض برق مشترک ساختمان', category: 'برق', amount: 800000, period }
  ],
  generated_at: midPeriodTs
};
const pdf4 = await buildPerformanceReportPdf(env, perfData);
fs.writeFileSync(outDir + 'performance.pdf', pdf4);
const docPerf = await PD.load(pdf4);
console.log('performance.pdf pages:', docPerf.getPageCount());

console.log('statement.pdf', pdf1.length, 'bytes');
console.log('report.pdf', pdf2.length, 'bytes');
console.log('monthly.pdf', pdf3.length, 'bytes');
console.log('performance.pdf', pdf4.length, 'bytes');
console.log('OK');
