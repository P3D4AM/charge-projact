// Visual regression for «پ» + Persian letters in PDF output (uses src/pdf.js harness).
import fs from 'node:fs';
import { buildStatementPdf } from '../src/pdf.js';
import { currentPeriod } from '../src/jalali.js';

const readFont = f => fs.readFileSync(new URL(`../public/fonts/${f}`, import.meta.url));
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
const sampleDebts = [
  { kind: 'monthly', period, description: 'شارژ ماهانه + پارکینگ', amount: 1250000, paid_amount: 1250000, status: 'paid', paid_at: Math.floor(Date.now() / 1000) - 86400 * 3 },
  { kind: 'expense', period, description: 'سهم هزینه: پلمپ استخر و پرداخت پیمانکار', amount: 480000, paid_amount: 200000, status: 'partial' },
  { kind: 'expense', period, description: 'پرداخت قبض برق مشترک راه‌پله', amount: 320000, paid_amount: 0, status: 'unpaid' },
  { kind: 'custom', period, description: 'شارژ پارکینگ مهمان — پلاک پ', amount: 50000, paid_amount: 0, status: 'unpaid' }
];
const totals = {
  issued: sampleDebts.reduce((s, d) => s + d.amount, 0),
  paid: sampleDebts.reduce((s, d) => s + d.paid_amount, 0)
};
totals.remaining = totals.issued - totals.paid;

const statementData = {
  building_name: 'برج پارسیان (آزمون «پ»)',
  address: 'تهران، پونک، خیابان پژوهش، پلاک ۱۲',
  phone: '09131234567',
  bank_card: '6037-9975-1234-5678',
  bank_owner: 'حسین پناهی (مدیر پارسیان)',
  unit: { number: '5', resident_name: 'پریسا پناهی', area_m2: 75, residents_count: 3 },
  debts: sampleDebts,
  totals,
  settings: { bank_card: '6037-9975-1234-5678', bank_owner: 'حسین پناهی (مدیر پارسیان)', phone: '09131234567' },
  generated_at: Math.floor(Date.now() / 1000)
};

const outDir = new URL('../out/', import.meta.url).pathname;
fs.mkdirSync(outDir, { recursive: true });
const pdf = await buildStatementPdf(env, statementData);
fs.writeFileSync(outDir + 'peh-test.pdf', pdf);
console.log('peh-test.pdf', pdf.length, 'bytes — render with pdftoppm to review');
