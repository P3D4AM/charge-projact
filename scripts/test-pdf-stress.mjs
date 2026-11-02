// v2.14.0 — stress-test: all four PDFs with adversarially LONG texts
// (long building name/address/titles/notes/amounts) to prove nothing
// overflows its column or collides in the header band.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as jalali from '../public/js/jalali.js';
import {
  buildStatementPdf, buildYearReportPdf, buildMonthlyReportPdf, buildPerformanceReportPdf
} from '../public/js/lib/pdf-core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readFont = f => fs.readFileSync(path.join(root, 'public/fonts', f));
const fonts = { regular: readFont('Vazirmatn-Regular.ttf'), bold: readFont('Vazirmatn-Bold.ttf') };
const lib = { PDFDocument, rgb };
const out = path.join(root, 'out');

const LONG = {
  building: 'برج مسکونی لوکس نگین تهران واقع در خیابان ولیعصر',
  address: 'تهران، خیابان ولیعصر، بالاتر از پارک ساعی، پلاک ۱۲۰، برج نگین، ورودی شرقی طبقه همکف',
  resident: 'دکتر محمدحسین کریمیان مهرآبادی',
  taskTitle: 'بازسازی کامل موتورخانه آسانسور و تعویض تابلو برق و سیم‌کشی اصلی ساختمان',
  cat: 'تاسیسات و آسانسور',
  note: 'پرداخت قسط دوم با کارت بانکی در تاریخ دهم انجام شد؛ مابقی بنا بر هماهنگی مدیر ساختمان تا پایان ماه تسویه خواهد شد — توافق شفاهی در جلسه اتحادیه.',
  expenseTitle: 'قبض برق مشترک نوامبر به همراه هزینه تعمیر پمپ آب و شیرآلات lobby'
};

const j2 = jalali;
const generated_at = Math.floor(Date.now() / 1000);

const statement = await buildStatementPdf({
  lib, fontkit, fonts,
  data: {
    building_name: LONG.building, address: LONG.address,
    unit: { number: 'واحد 12', resident_name: LONG.resident, area_m2: 145, residents_count: 4 },
    debts: Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, kind: i % 2 ? 'expense' : 'monthly', period: `1404-0${(i % 6) + 1}`,
      description: i === 0 ? 'شارژ ماهانه به همراه بدهی قبلی و جریمه دیرکرد' : '',
      amount: 12345678, paid_amount: i < 3 ? 12345678 : 4000000, status: i < 3 ? 'paid' : 'partial',
      note: i % 3 === 0 ? LONG.note : ''
    })),
    totals: { issued: 98765424, paid: 49038234, remaining: 49727190 },
    settings: { bank_card: '6037997512345678', bank_owner: LONG.resident, phone: '021-88776655' },
    generated_at, jalali: j2
  }
});

const year = await buildYearReportPdf({
  lib, fontkit, fonts,
  data: {
    building_name: LONG.building, address: LONG.address, jy: '1404',
    series: Array.from({ length: 12 }, (_, i) => ({ period: `1404-${String(i + 1).padStart(2, '0')}`, issued: 123456789 + i * 1000, collected: 98765432 })),
    by_unit: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, number: String(i + 1), resident_name: LONG.resident, issued: 45678900, paid: i % 2 ? 45678900 : 12345000
    })),
    generated_at, jalali: j2
  }
});

const monthly = await buildMonthlyReportPdf({
  lib, fontkit, fonts,
  data: {
    building_name: LONG.building, address: LONG.address, period: '1404-07',
    totals: { issued: 234567890, collected: 111111111, remaining: 123456779 },
    by_unit: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, number: String(i + 1), resident_name: LONG.resident, items: 3,
      issued: 23456789, paid: i % 3 ? 23456789 : 5000000,
      notes: i % 2 ? [{ description: 'شارژ مهر', note: LONG.note }] : []
    })),
    generated_at, jalali: j2
  }
});

const performance = await buildPerformanceReportPdf({
  lib, fontkit, fonts,
  data: {
    building_name: LONG.building, address: LONG.address, jy: '1404',
    fund: { collected: 1234567890, expenses: 234567890, tasks_cost: 345678901, balance: 654321099 },
    // v2.14.1 — موجودی اولیه (پول نزد مدیر قبلی) + ماندهٔ کلی → کاشی‌های ۵تایی
    fund_opening: { amount: 4250000000, note: 'پول نقدی نزد مدیر قبلی' },
    fund_all: { collected: 2234567890, expenses: 834567890, tasks_cost: 645678901, opening: 4250000000, balance: 5004321099 },
    totals: { tasks: 3 },
    months: Array.from({ length: 12 }, (_, i) => ({ period: `1404-${String(i + 1).padStart(2, '0')}`, tasks: i % 3, cost: (i % 3) * 12500000, expenses: (i % 2) * 8000000, collected: 98765432 })),
    categories: [{ category: LONG.cat, count: 2, cost: 25000000 }, { category: 'نظافت و باغبانی و خدمات محیطی سالانه', count: 1, cost: 12000000 }],
    tasks: [
      { done_at: generated_at, title: LONG.taskTitle, category: LONG.cat, cost: 12500000, files_count: 2, description: LONG.note },
      { done_at: generated_at - 86400 * 20, title: 'شارژ باتری درب پارکینگ', category: 'برق', cost: 850000, files_count: 0, description: '' }
    ],
    expenses: [{ period: '1404-07', title: LONG.expenseTitle, category: 'برق و تاسیسات', amount: 8765432 }],
    generated_at, jalali: j2
  }
});

const files = { 'v2141-stress-statement.pdf': statement, 'v2141-stress-report.pdf': year, 'v2141-stress-monthly.pdf': monthly, 'v2141-stress-performance.pdf': performance };
for (const [name, bytes] of Object.entries(files)) {
  fs.writeFileSync(path.join(out, name), Buffer.from(bytes));
  console.log(name, bytes.length, 'bytes');
}
console.log('OK — render with pdftoppm to inspect');
