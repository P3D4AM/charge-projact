// Test: how does @pdf-lib/fontkit handle (a) raw logical Persian, (b) shaped
// presentation forms in logical order — for shaping, bidi order, brackets, digits.
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';

const font = fontkit.create(fs.readFileSync(new URL('../public/fonts/Vazirmatn-Regular.ttf', import.meta.url)));

const N = s => [...s].map(c => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const glyphsOf = s => font.layout(s).glyphs.map(g => (g.name || 'gid' + g.id));

const cases = {
  'simple word': 'برج',
  'zwnj word': 'صورت‌حساب',
  'lam-alef': 'لازم',
  'sentence': 'برج نگین اصفهان',
  'parens': '(مدیر ساختمان)',
  'latin digits': 'کارت: 6037-9975',
  'persian digits': '۱۲۰٬۵۰۰',
  'date': '۲۵ شهریور ۱۴۰۴',
  'mixed': 'مانده کل (تومان) ۵۷'
};

for (const [label, input] of Object.entries(cases)) {
  const glyphs = glyphsOf(input);
  console.log('== ' + label + ' :: ' + input);
  console.log('   in : ' + N(input));
  console.log('   out: ' + glyphs.join(' | '));
}
