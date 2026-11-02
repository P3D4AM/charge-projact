// Check Arabic presentation forms glyph coverage in Vazirmatn TTF via fontkit.
import fs from 'node:fs';
import fontkit from '@pdf-lib/fontkit';

const font = fontkit.create(fs.readFileSync(new URL('../public/fonts/Vazirmatn-Regular.ttf', import.meta.url)));

const samples = {
  'Alef isolated (U+FE8D)': 0xFE8D,
  'Beh medial (U+FE8E is alef final; beh medial U+FE92)': 0xFE92,
  'Farsi Yeh initial (U+FBFE)': 0xFBFE,
  'Farsi Kaf initial (U+FB90)': 0xFB90,
  'Gaf isolated (U+FB92)': 0xFB92,
  'Pe isolated (U+FB56)': 0xFB56,
  'Che medial (U+FB7C)': 0xFB7C,
  'Je final (U+FB8B)': 0xFB8B,
  'Lam-Alef lig (U+FEFB)': 0xFEFB,
  'Teh marbuta (U+FE94)': 0xFE94,
  'ZWNJ (U+200C)': 0x200C,
  'Persian digit 5 (U+06F5)': 0x06F5,
  'Arabic thousands sep (U+066C)': 0x066C,
  'Percent (U+066A)': 0x066A,
  'Rial/Toman? Teh (U+062A)': 0x062A,
  'Space (U+0020)': 0x0020,
  'Latin A (U+0041)': 0x0041,
  'Tatweel (U+0640)': 0x0640,
};

let missing = [];
for (const [name, cp] of Object.entries(samples)) {
  const g = font.glyphForCodePoint(cp);
  const has = g && g.id !== 0 && g.advanceWidth !== undefined;
  console.log(`${has ? 'OK  ' : 'MISS'} ${name}`);
  if (!has) missing.push(name);
}

// try layout of a shaped Persian string
const shaped = 'ﺳﻼﺍﻡ ﺩﻧﯾﺎ ۱۲۳';
const run = font.layout(shaped);
console.log('layout glyphs:', run.glyphs.length, 'for string len', shaped.length);
console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'ALL PRESENT');
