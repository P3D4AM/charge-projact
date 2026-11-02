// Core unit tests: Jalali calendar + Telegram initData validation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  toJalaali, toGregorian, jalaaliMonthLength, isLeapJalaali,
  currentPeriod, periodLabel, addPeriods, isPeriod, localPeriod
} from '../src/jalali.js';
import { validateInitData } from '../src/telegram.js';

// ---------- Jalali calendar ----------
assert.deepEqual(toJalaali(new Date(2024, 2, 20)), { jy: 1403, jm: 1, jd: 1 }, '1 Farvardin 1403');
assert.deepEqual(toGregorian(1403, 12, 30), { gy: 2025, gm: 3, gd: 20 }, '30 Esfand 1403 (leap)');
assert.equal(jalaaliMonthLength(1403, 12), 30, '1403 is leap -> Esfand 30');
assert.equal(jalaaliMonthLength(1404, 12), 29, '1404 not leap -> Esfand 29');
assert.equal(isLeapJalaali(1403), true);
assert.equal(isLeapJalaali(1404), false);
assert.deepEqual(toJalaali(new Date(2025, 2, 21)), { jy: 1404, jm: 1, jd: 1 }, '1 Farvardin 1404');
assert.deepEqual(toJalaali(new Date(2025, 8, 23)), { jy: 1404, jm: 7, jd: 1 }, '1 Mehr 1404');

// round-trips across all months of a leap and a normal year
for (const jy of [1398, 1399, 1403, 1404]) {
  for (let jm = 1; jm <= 12; jm++) {
    const len = jalaaliMonthLength(jy, jm);
    for (const jd of [1, Math.floor(len / 2), len]) {
      const g = toGregorian(jy, jm, jd);
      const back = toJalaali(new Date(g.gy, g.gm - 1, g.gd));
      assert.deepEqual(back, { jy, jm, jd }, `round trip ${jy}-${jm}-${jd}`);
    }
  }
}

assert.ok(isPeriod(currentPeriod()), 'currentPeriod format');
assert.ok(isPeriod(localPeriod()));
assert.equal(periodLabel('1404-07'), 'مهر ۱۴۰۴');
assert.equal(addPeriods('1404-01', -1), '1403-12');
assert.equal(addPeriods('1404-12', 1), '1405-01');
assert.equal(addPeriods('1404-07', 0), '1404-07');

// ---------- Telegram initData validation ----------
const BOT = '7000000000:TESTTOKEN';

function makeInitData(userObj, authDate) {
  const p = new URLSearchParams();
  p.set('auth_date', String(authDate ?? Math.floor(Date.now() / 1000)));
  p.set('query_id', 'AAF_l0m2QAAAAAB_l0m2Q');
  p.set('user', JSON.stringify(userObj));
  p.set('signature', 'test-signature-value');
  const dcs = [...p.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  p.set('hash', hash);
  return p.toString();
}

const valid = await validateInitData(makeInitData({ id: 111, first_name: 'تست' }), BOT);
assert.ok(valid && valid.id === 111, 'valid initData accepted');
assert.equal(valid.first_name, 'تست');

assert.equal(
  await validateInitData(makeInitData({ id: 1 }, Math.floor(Date.now() / 1000) - 100000), BOT),
  null, 'expired initData rejected'
);
assert.equal(
  await validateInitData(makeInitData({ id: 222 }) + 'x', BOT),
  null, 'tampered initData rejected'
);
assert.equal(
  await validateInitData('user=%7B%22id%22%3A1%7D&auth_date=1&hash=deadbeef', BOT),
  null, 'wrong token rejected'
);
assert.equal(await validateInitData('', BOT), null, 'empty rejected');
assert.equal(await validateInitData(makeInitData({ id: 1 }), ''), null, 'missing token rejected');

console.log('test-core: all assertions passed');

// ---------- Persian reshaper (PDF text shaping) ----------
const { shapeForPdf, faMoney, faDigits } = await import('../public/js/lib/reshaper.js');

// joining: س connects to ا (initial), ا ends the connection (final), ر isolated
{
  const out = shapeForPdf('شارژ');
  const cps = [...out].map(c => c.codePointAt(0));
  assert.deepEqual(cps, [0xFB8A, 0xFEAD, 0xFE8E, 0xFEB7], 'شارژ -> ژ iso, ر iso, ا final, ش initial');
}
// lam-alef mandatory ligature
{
  const out = shapeForPdf('لازم');
  const cps = [...out].map(c => c.codePointAt(0));
  // visual order: م isolated, ز isolated, لا ligature
  assert.deepEqual(cps, [0xFEE1, 0xFEAF, 0xFEFB], 'لازم -> م iso, ز iso, لا ligature');
}
// ZWNJ breaks joining without changing letters
{
  const out = shapeForPdf('می‌شود');
  // د isolated (end), و final, ش initial, ی final (ZWNJ before it), م initial
  assert.ok(out.includes(String.fromCharCode(0xFEA9)), 'د isolated at word end');
  assert.ok(out.includes(String.fromCharCode(0xFBFD)), 'ی final (ZWNJ blocks its start)');
  assert.ok(out.includes(String.fromCharCode(0xFEE3)), 'م initial (joins to ی)');
  assert.ok(!out.includes('\u200C'), 'ZWNJ removed from output');
}
// digit/Latin runs keep LTR order inside RTL text
{
  const card = '6037-9975';
  const out = shapeForPdf('کارت: ' + faDigits(card));
  assert.ok(out.includes('۶۰۳۷-۹۹۷۵'), 'digit run kept intact and LTR');
}
// ---------------------------------------------------------------------------
// POSITIONAL FORMS — hard-coded Unicode ground truth (regression test for the
// «پ» bug: FB-range rows must never drift again; values verified against UCD).
// For each letter: [isolated, final, initial, medial] (initial/medial only if
// dual-joining). Contexts: X / Xب / بX / بXب.
{
  const D = { // dual-joining — حروف فارسی + نمایش کدپوینت‌های چهار موضع
    'ب': [0xFE8F, 0xFE90, 0xFE91, 0xFE92],
    'پ': [0xFB56, 0xFB57, 0xFB58, 0xFB59],
    'ت': [0xFE95, 0xFE96, 0xFE97, 0xFE98],
    'ث': [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],
    'ج': [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
    'چ': [0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D],
    'خ': [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8],
    'س': [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4],
    'ش': [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
    'ک': [0xFB8E, 0xFB8F, 0xFB90, 0xFB91],
    'گ': [0xFB92, 0xFB93, 0xFB94, 0xFB95],
    'ل': [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0],
    'م': [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4],
    'ن': [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
    'ه': [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC],
    'ی': [0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF],
  };
  const R = { // right-joining — [isolated, final]
    'ا': [0xFE8D, 0xFE8E],
    'آ': [0xFE81, 0xFE82],
    'د': [0xFEA9, 0xFEAA],
    'ر': [0xFEAD, 0xFEAE],
    'ز': [0xFEAF, 0xFEB0],
    'ژ': [0xFB8A, 0xFB8B],
    'و': [0xFEED, 0xFEEE],
  };
  const cp = s => [...s].map(c => c.codePointAt(0));
  // Arabic yeh normalizes to Farsi yeh before shaping
  assert.deepEqual(cp(shapeForPdf('ي')), cp(shapeForPdf('ی')), 'ي normalizes to ی');
  for (const [ch, f] of Object.entries(D)) {
    assert.deepEqual(cp(shapeForPdf(ch)), [f[0]], `${ch} isolated`);
    assert.deepEqual(cp(shapeForPdf(ch + 'ب')), [0xFE90, f[2]], `${ch} initial + ب final (visual)`);
    assert.deepEqual(cp(shapeForPdf('ب' + ch)), [f[1], 0xFE91], `ب initial + ${ch} final (visual)`);
    assert.deepEqual(cp(shapeForPdf('ب' + ch + 'ب')), [0xFE90, f[3], 0xFE91], `ب + ${ch} medial + ب (visual)`);
  }
  for (const [ch, f] of Object.entries(R)) {
    assert.deepEqual(cp(shapeForPdf(ch)), [f[0]], `${ch} isolated`);
    assert.deepEqual(cp(shapeForPdf(ch + 'ب')), [0xFE8F, f[0]], `${ch} iso + ب iso (R never joins forward; visual)`);
    assert.deepEqual(cp(shapeForPdf('ب' + ch)), [f[1], 0xFE91], `ب initial + ${ch} final (visual)`);
  }
  // «پارکینگ» — پ must be PEH INITIAL (0xFB58), never BEHEH/missing glyph
  const park = shapeForPdf('پارکینگ');
  assert.ok(park.includes(String.fromCharCode(0xFB58)), 'پارکینگ -> پ initial form');
  assert.ok(!park.includes(String.fromCharCode(0xFB5A)) && !park.includes(String.fromCharCode(0xFB5B)), 'no BEHEH codepoints for پ');
  // full word sanity (visual order): گ final, ن medial (joins گ), ی medial, ک initial, ر iso, ا final, پ initial
  assert.deepEqual(cp(park), [0xFB93, 0xFEE8, 0xFBFF, 0xFB90, 0xFEAD, 0xFE8E, 0xFB58], 'پارکینگ exact glyph sequence');
  // «حساب و پرداخت» — پ medial via و boundary: پرداخت -> پ initial
  assert.ok(shapeForPdf('پرداخت').includes(String.fromCharCode(0xFB58)), 'پرداخت -> پ initial form');
}
// faMoney thousands separator
assert.equal(faMoney(12500000), '۱۲٬۵۰۰٬۰۰۰', 'faMoney format');
assert.equal(faMoney(0), '۰', 'faMoney zero');
assert.equal(faDigits('0913'), '۰۹۱۳', 'faDigits');

console.log('test-core: reshaper assertions passed');
