// PDF builders (صورت‌حساب + گزارش سالانه) — layout core with injected dependencies.
// Runs in three environments:
//   - Cloudflare Worker: src/pdf.js injects pdf-lib + fontkit (bundled by wrangler)
//   - Node tests: scripts/test-pdf.mjs imports pdf-lib + fontkit directly
//   - Browser demo: public/js/pdf-client.js loads pdf-lib UMD from CDN and injects it
import { shapeForPdf, faMoney, faDigits } from './reshaper.js';
import { periodLabel, J_MONTHS, faNum } from '../jalali.js';

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------
const C = {
  accent: [0.043, 0.34, 0.30],   // deep teal
  accentSoft: [0.906, 0.949, 0.937],
  ink: [0.12, 0.16, 0.22],
  muted: [0.42, 0.47, 0.53],
  line: [0.78, 0.82, 0.80],
  zebra: [0.955, 0.973, 0.965],
  white: [1, 1, 1],
  green: [0.08, 0.50, 0.24],
  amber: [0.71, 0.33, 0.04],
  red: [0.72, 0.11, 0.11]
};
// Accepts either an [r,g,b] array or a pdf-lib RGB object; always returns a pdf-lib RGB.
const rgbOf = (rgb, c) => (c && typeof c === 'object' && !Array.isArray(c)) ? c : rgb(c[0], c[1], c[2]);

const STATUS = {
  paid: { label: 'تسویه‌شده', color: C.green },
  partial: { label: 'پرداخت جزئی', color: C.amber },
  unpaid: { label: 'پرداخت‌نشده', color: C.red }
};
const KIND_LABEL = { monthly: 'شارژ ماهانه', expense: 'سهم هزینه', custom: 'متفرقه' };

const A4 = { w: 595.28, h: 841.89 };
const M = 40; // page margin
// Unit numbers may be stored as «واحد 2» (typed by the manager) — strip the word
// so PDF tiles don't render «واحد واحد 2».
const stripUnitWord = v => String(v ?? '').trim().replace(/^واحد[\s._\-–—]*/u, '').trim() || String(v ?? '').trim();

// ---------------------------------------------------------------------------
// low-level helpers
// ---------------------------------------------------------------------------
function tehranParts(ts) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts * 1000));
  const get = t => Number((parts.find(x => x.type === t) || {}).value || 0);
  return { gy: get('year'), gm: get('month'), gd: get('day') };
}

// "۲۵ شهریور ۱۴۰۴" from a unix timestamp
function jalaliDateStr(ts, j2) {
  const p = ts ? tehranParts(ts) : null;
  const { jy, jm, jd } = p
    ? j2.toJalaaliFromParts(p.gy, p.gm, p.gd)
    : j2.todayLocalJalaali();
  return `${faDigits(jd)} ${j2.J_MONTHS[jm - 1]} ${faDigits(jy)}`;
}

// Draws shaped RTL text. `x` is the anchor: right edge (align=right, RTL default),
// left edge (align=left) or center of the text block.
//
// v2.14.0 — bulletproof fitting whenever `maxWidth` is given:
//   1) optional auto-shrink: if `shrinkTo` < size, first try a smaller font
//      that fits exactly (so words stay readable instead of being cut),
//   2) ellipsis trim (visual-order safe, as before),
//   3) hard clamp: even "…"+1 glyph can overflow a narrow column → shrink
//      until it really fits. The caller's maxWidth is a HARD guarantee now:
//      nothing ever bleeds into the neighbouring column/page edge.
function drawRTL(page, text, { x, y, size, font, color, rgb, align = 'right', maxWidth = 0, shrinkTo = 0 }) {
  let shaped = shapeForPdf(text);
  let w = font.widthOfTextAtSize(shaped, size);
  // 1) auto-shrink to fit (only when the caller allows a smaller size)
  if (maxWidth && w > maxWidth && shrinkTo && shrinkTo < size) {
    const s2 = Math.max(shrinkTo, Math.floor((size * maxWidth / w) * 2) / 2);
    if (s2 < size) { size = s2; w = font.widthOfTextAtSize(shaped, size); }
  }
  if (maxWidth && w > maxWidth) {
    const dots = shapeForPdf('…');
    // shaped string is visual order: the logical beginning sits at its END,
    // so trim from the START (logical tail) and let the ellipsis mark the cut.
    let kept = shaped;
    while (kept.length > 1 && font.widthOfTextAtSize(dots + kept, size) > maxWidth) {
      kept = kept.slice(1);
    }
    shaped = dots + kept;
    w = font.widthOfTextAtSize(shaped, size);
  }
  // 2) hard clamp — shrink until it truly fits (narrow columns, tiny widths)
  if (maxWidth && w > maxWidth) {
    while (size > 5 && font.widthOfTextAtSize(shaped, size) > maxWidth) size -= 0.5;
    w = font.widthOfTextAtSize(shaped, size);
  }
  const dx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  page.drawText(shaped, { x: dx, y, size, font, color: rgbOf(rgb, color) });
  return w;
}

// v2.12.0 — Word-wrap LOGICAL text into lines that fit maxWidth.
// Width is measured on the SHAPED candidate line; wrapping happens on logical
// words so multi-line notes read correctly. Long words stay intact (single word
// wider than maxWidth is kept — drawRTL's ellipsis covers that case).
function wrapRTL(text, { font, size, maxWidth }) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (!cur || font.widthOfTextAtSize(shapeForPdf(cand), size) <= maxWidth) cur = cand;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function rect(page, rgb, { x, y, w, h, color, border, borderWidth = 0.8 }) {
  const opts = { x, y, width: w, height: h, color: color ? rgbOf(rgb, color) : undefined };
  if (border) {
    opts.borderColor = rgbOf(rgb, border);
    opts.borderWidth = borderWidth;
  }
  page.drawRectangle(opts);
}

function line(page, rgb, { x1, y1, x2, y2, color, thickness = 0.8 }) {
  page.drawLine({
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
    thickness, color: rgbOf(rgb, color || C.line)
  });
}

// ---------------------------------------------------------------------------
// header band
// v2.14.0 — every band text is width-limited + auto-shrinking so long building
// names / addresses / document titles can never collide with each other
// (the «کلمات بیرون می‌زنند» report bug).
// ---------------------------------------------------------------------------
function drawBand(page, rgb, { fonts, buildingName, subtitle, title, dateStr }) {
  const bh = 68;
  const top = A4.h - M;
  rect(page, rgb, { x: M, y: top - bh, w: A4.w - 2 * M, h: bh, color: C.accent });
  const inner = A4.w - 2 * M;
  const rightMax = inner * 0.55;  // right side: building name + address
  const leftMax = inner * 0.40;   // left side: doc title + date
  // right: building name + subtitle
  drawRTL(page, buildingName, { rgb, x: A4.w - M - 16, y: top - 30, size: 15, font: fonts.bold, color: C.white, maxWidth: rightMax, shrinkTo: 9 });
  if (subtitle) {
    drawRTL(page, subtitle, { rgb, x: A4.w - M - 16, y: top - 46, size: 8.5, font: fonts.regular, color: C.white, maxWidth: rightMax, shrinkTo: 7 });
  }
  // left: document title + date
  drawRTL(page, title, { rgb, x: M + 16, y: top - 30, size: 12.5, font: fonts.bold, color: C.white, align: 'left', maxWidth: leftMax, shrinkTo: 8.5 });
  drawRTL(page, dateStr, { rgb, x: M + 16, y: top - 46, size: 8.5, font: fonts.regular, color: C.white, align: 'left', maxWidth: leftMax, shrinkTo: 7 });
  return top - bh;
}

// info tiles row (rightmost tile = first in `tiles`)
function drawTiles(page, rgb, { fonts, y, tiles, highlightIndex = -1 }) {
  const gap = 8;
  const n = tiles.length;
  const w = (A4.w - 2 * M - gap * (n - 1)) / n;
  const h = 44;
  tiles.forEach((t, i) => {
    const x = A4.w - M - w - i * (w + gap); // RTL: first tile at the right
    const hi = i === highlightIndex;
    rect(page, rgb, {
      x, y: y - h, w, h,
      color: hi ? C.accent : C.accentSoft,
      border: C.line
    });
    drawRTL(page, t.label, {
      rgb, x: x + w - 8, y: y - 15, size: 7.5,
      font: fonts.regular, color: hi ? C.white : C.muted, maxWidth: w - 14, shrinkTo: 6
    });
    drawRTL(page, t.value, {
      rgb, x: x + w - 8, y: y - 33, size: t.valueSize || 10.5,
      font: fonts.bold, color: hi ? C.white : C.ink, maxWidth: w - 14
    });
  });
  return y - h - 14;
}

// ---------------------------------------------------------------------------
// table (RTL: first column is the rightmost)
// ---------------------------------------------------------------------------
function drawTable(page, rgb, { fonts, y, columns, rows, bottomLimit, rowH = 21, headerH = 24, onPage }) {
  const width = A4.w - 2 * M;
  const totalW = columns.reduce((s, c) => s + c.w, 0);
  const scale = width / totalW;
  const cols = columns.map(c => ({ ...c, w: c.w * scale }));

  const colX = i => {
    // right edge of column i
    let right = A4.w - M;
    for (let k = 0; k < i; k++) right -= cols[k].w;
    return right;
  };

  // v2.14.2 — anchor تصحیح شد: «center» باید مرکز ستون باشد نه right-edge−6؛
  // قبلاً متنِ center‌شده به‌اندازهٔ (w/2−6) به سمت راست شیفت می‌خورد و روی
  // ستون مجاور می‌افتاد (همان «جابجایی بین ستون‌ها»)
  const cellX = (c, i) => (c.align === 'center' ? colX(i) - c.w / 2 : colX(i) - 6);

  const drawHeader = (yy) => {
    rect(page, rgb, { x: M, y: yy - headerH, w: width, h: headerH, color: C.accentSoft, border: C.line });
    cols.forEach((c, i) => {
      drawRTL(page, c.title, {
        rgb, x: cellX(c, i), y: yy - headerH + 8, size: 8.5, font: fonts.bold,
        color: C.accent, align: c.align === 'center' ? 'center' : 'right', maxWidth: c.w - 10, shrinkTo: 6.5
      });
    });
    return yy - headerH;
  };

  let cy = drawHeader(y);
  let first = true;

  rows.forEach((row, ri) => {
    if (cy - rowH < bottomLimit) {
      page = onPage(); // new page
      cy = drawHeader(A4.h - M);
      first = true;
    }
    const zebra = ri % 2 === 1;
    if (zebra) rect(page, rgb, { x: M, y: cy - rowH, w: width, h: rowH, color: C.zebra });
    line(page, rgb, { x1: M, y1: cy - rowH, x2: A4.w - M, y2: cy - rowH, color: C.line, thickness: 0.6 });
    cols.forEach((c, i) => {
      const text = c.render ? c.render(row, ri) : String(row[c.key] ?? '');
      const color = c.color ? c.color(row) : C.ink;
      drawRTL(page, text, {
        rgb, x: cellX(c, i), y: cy - rowH + 6.5, size: 9,
        font: c.bold ? fonts.bold : fonts.regular, color,
        align: c.align === 'center' ? 'center' : 'right', maxWidth: c.w - 10, shrinkTo: 6.5
      });
    });
    if (first) first = false;
    cy -= rowH;
  });

  // outer + column separator lines
  line(page, rgb, { x1: M, y1: y - headerH, x2: A4.w - M, y2: y - headerH, color: C.line });
  line(page, rgb, { x1: M, y1: cy, x2: A4.w - M, y2: cy, color: C.line, thickness: 1.1 });
  line(page, rgb, { x1: M, y1: y, x2: M, y2: cy, color: C.line });
  line(page, rgb, { x1: A4.w - M, y1: y, x2: A4.w - M, y2: cy, color: C.line });
  let acc = 0;
  cols.forEach((c, i) => {
    acc += c.w;
    if (i < cols.length - 1) {
      const x = A4.w - M - acc;
      line(page, rgb, { x1: x, y1: y, x2: x, y2: cy, color: C.line, thickness: 0.5 });
    }
  });

  return { y: cy, page };
}

// ---------------------------------------------------------------------------
// payment box + footer
// ---------------------------------------------------------------------------
function drawPaymentBox(page, rgb, { fonts, y, settings, unitNumber }) {
  const h = 74;
  rect(page, rgb, { x: M, y: y - h, w: A4.w - 2 * M, h, color: C.accentSoft, border: C.accent, borderWidth: 1 });
  drawRTL(page, 'راه پرداخت', { rgb, x: A4.w - M - 12, y: y - 18, size: 10, font: fonts.bold, color: C.accent });
  const rows = [];
  if (settings.bank_card) rows.push(['شماره کارت:', faDigits(String(settings.bank_card))]);
  if (settings.bank_owner) rows.push(['به نام:', settings.bank_owner]);
  if (settings.phone) rows.push(['تماس با مدیریت:', faDigits(String(settings.phone))]);
  if (!rows.length) rows.push(['راه پرداخت توسط مدیر ساختمان اعلام می‌شود.', '']);
  let ry = y - 34;
  for (const [label, val] of rows) {
    drawRTL(page, label, { rgb, x: A4.w - M - 12, y: ry, size: 8.5, font: fonts.regular, color: C.ink });
    drawRTL(page, val, { rgb, x: M + 12, y: ry, size: 9, font: fonts.bold, color: C.accent, align: 'left', maxWidth: A4.w - 2 * M - 120 });
    ry -= 14;
  }
  return y - h - 10;
}

function drawFooter(page, rgb, { fonts, text }) {
  drawRTL(page, text, {
    rgb, x: A4.w / 2, y: M - 14, size: 7.5, font: fonts.regular,
    color: C.muted, align: 'center', maxWidth: A4.w - 2 * M
  });
}

// v2.12.0 — «یادداشت‌های پرداخت»: full (wrapped) notes below the table so long
// texts never break the table layout. Each note is capped at `maxLines` lines
// with an ellipsis; the section pages itself when space runs out.
function drawNotesSection(page, rgb, { fonts, y, bottom, notes, onPage, title = 'یادداشت‌های پرداخت' }) {
  if (!notes.length) return { y, page };
  const newPage = (t) => {
    page = onPage();
    y = A4.h - M;
    drawRTL(page, t, { rgb, x: A4.w - M, y: y - 12, size: 10.5, font: fonts.bold, color: C.accent });
    y -= 20;
  };
  if (y - 40 < bottom) newPage(title);
  else {
    drawRTL(page, title, { rgb, x: A4.w - M, y: y - 12, size: 10.5, font: fonts.bold, color: C.accent });
    y -= 20;
  }
  const maxLines = 4;
  for (const n of notes) {
    // v2.13.0: n.head override — «توضیحات کارها» از همین تابع برای سرصفحهٔ دلخواه استفاده می‌کند
    const head = n.head || `واحد ${faDigits(stripUnitWord(n.unit))}${n.description ? ' — ' + n.description : ''}`;
    let lines = wrapRTL(n.note, { font: fonts.regular, size: 8.5, maxWidth: A4.w - 2 * M - 8 });
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = lines[maxLines - 1] + ' …';
    }
    const blockH = 13 + lines.length * 11 + 6;
    if (y - blockH < bottom) newPage(title + ' (ادامه)');
    drawRTL(page, head, { rgb, x: A4.w - M, y: y - 9, size: 8, font: fonts.bold, color: C.muted, maxWidth: A4.w - 2 * M, shrinkTo: 6.5 });
    let ly = y - 9 - 11;
    for (const l of lines) {
      drawRTL(page, l, { rgb, x: A4.w - M, y: ly, size: 8.5, font: fonts.regular, color: C.ink });
      ly -= 11;
    }
    y = ly - 5;
  }
  return { y, page };
}

function drawPageNumbers(doc, rgb, { fonts }) {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `صفحه ${faDigits(i + 1)} از ${faDigits(pages.length)}`;
    drawRTL(p, label, { rgb, x: M + 4, y: M - 14, size: 7.5, font: fonts.regular, color: C.muted, align: 'left' });
  });
}

// ---------------------------------------------------------------------------
// helpers for document creation
// ---------------------------------------------------------------------------
// pdf-lib encodes every string through fontkit's layout engine. fontkit applies
// its own bidi pass and re-reverses RTL runs — which cancels the visual order
// our reshaper already produced and the page ends up mirrored (all letters
// reversed). Forcing direction='ltr' keeps glyph shaping/advances intact while
// disabling fontkit's reordering, so our visual-order glyphs draw as-is.
function ltrFontkit(fk) {
  if (!fk || fk.__bcForceLtr) return fk;
  const wrapFont = font => new Proxy(font, {
    get(t, prop) {
      if (prop === 'layout') {
        return (text, features, script, language, direction) =>
          t.layout(text, features, script, language, 'ltr');
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    }
  });
  const wrapped = Object.create(fk);
  wrapped.create = (...args) => wrapFont(fk.create(...args));
  Object.defineProperty(wrapped, '__bcForceLtr', { value: true });
  return wrapped;
}

async function newDoc(lib, fontkit, fonts) {
  const { PDFDocument, rgb } = lib;
  const doc = await PDFDocument.create();
  doc.registerFontkit(ltrFontkit(fontkit));
  const embed = async (bytes, name) => {
    try {
      return await doc.embedFont(bytes, { subset: true });
    } catch (e) {
      console.warn(`pdf: subset embed failed for ${name}, falling back to full embed:`, e && e.message);
      return await doc.embedFont(bytes, { subset: false });
    }
  };
  const [regular, bold] = await Promise.all([
    embed(fonts.regular, 'regular'),
    embed(fonts.bold, 'bold')
  ]);
  doc.setTitle('صورت‌حساب شارژ ساختمان');
  doc.setLanguage('fa');
  doc.setCreator('Building Charges App');
  return { doc, fonts: { regular, bold }, rgb };
}

// ---------------------------------------------------------------------------
// PUBLIC: unit statement (صورت‌حساب واحد)
// ---------------------------------------------------------------------------
export async function buildStatementPdf({ lib, fontkit, fonts, data }) {
  const j2 = data.jalali;
  const { doc, fonts: F, rgb } = await newDoc(lib, fontkit, fonts);
  let page = doc.addPage([A4.w, A4.h]);

  const dateStr = 'تاریخ صدور: ' + jalaliDateStr(data.generated_at, j2);
  let y = drawBand(page, rgb, {
    fonts: F,
    buildingName: data.building_name || 'ساختمان من',
    subtitle: data.address || '',
    title: 'صورت‌حساب شارژ',
    dateStr
  });

  const u = data.unit || {};
  y -= 18;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: [
      { label: 'واحد', value: faDigits(stripUnitWord(u.number) || '—') },
      { label: 'ساکن', value: u.resident_name || '—', valueSize: 9.5 },
      { label: 'متراژ (متر مربع)', value: u.area_m2 ? faDigits(u.area_m2) : '—' },
      { label: 'تعداد نفرات', value: faDigits(u.residents_count ?? '—') }
    ]
  });

  const bottom = M + 210; // reserve room for totals + payment box + footer
  const columns = [
    { title: '#', w: 24, align: 'center', render: (_r, i) => faDigits(i + 1) },
    { title: 'شرح', w: 132, render: r => r.description || KIND_LABEL[r.kind] || '' },
    { title: 'ماه', w: 54, align: 'center', render: r => periodLabel(r.period) },
    { title: 'مبلغ (تومان)', w: 72, align: 'center', render: r => faMoney(r.amount) },
    { title: 'پرداختی', w: 68, align: 'center', render: r => faMoney(r.paid_amount) },
    { title: 'مانده', w: 68, align: 'center', render: r => faMoney(Math.max(0, r.amount - r.paid_amount)) },
    { title: 'وضعیت', w: 58, align: 'center', render: r => (STATUS[r.status] || STATUS.unpaid).label, color: r => (STATUS[r.status] || STATUS.unpaid).color },
    // v2.12.0 (بند ۵): یادداشت هر قلم — متن بلند با «…» کوتاه می‌شود تا چیدمان به هم نخورد
    { title: 'یادداشت', w: 96, render: r => String(r.note || '').trim() }
  ];
  const rows = (data.debts || []).slice();
  const res = drawTable(page, rgb, {
    fonts: F, y, columns, rows, bottomLimit: bottom,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = res.y; page = res.page;

  if (!rows.length) {
    drawRTL(page, 'موردی برای این واحد ثبت نشده است.', {
      rgb, x: A4.w / 2, y: y - 26, size: 10, font: F.regular, color: C.muted, align: 'center'
    });
    y -= 40;
  }

  // v2.12.0 (بند ۵): متن کامل یادداشت‌ها به‌صورت multiline زیر جدول — با شکستن
  // صفحه امن تا هرگز روی جمع کل/باکس پرداخت نیفتد.
  const noteItems = (data.debts || [])
    .filter(d => String(d.note || '').trim())
    .map(d => ({ unit: data.unit && data.unit.number, description: d.description || KIND_LABEL[d.kind] || '', note: String(d.note).trim() }));
  if (noteItems.length) {
    const ns = drawNotesSection(page, rgb, {
      fonts: F, y, bottom, notes: noteItems,
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = ns.y; page = ns.page;
  }

  // totals tiles — اگر جا برای جمع کل + باکس پرداخت نیست، صفحه جدید
  // v2.21.0 — وقتی واحد اعتبار اضافه‌پرداخت دارد: کاشی «اعتبار» و «مانده پس از اعتبار»
  const t = data.totals || {};
  const hasCredit = Number(t.credit) > 0;
  if (y - (hasCredit ? 152 : 152) < M) { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; }
  y -= 8;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: hasCredit ? [
      { label: 'جمع صادرشده (تومان)', value: faMoney(t.issued || 0) },
      { label: 'جمع پرداختی (تومان)', value: faMoney(t.paid || 0) },
      { label: 'اعتبار اضافه‌پرداخت (تومان)', value: faMoney(t.credit || 0) },
      { label: 'مانده پس از اعتبار (تومان)', value: faMoney(Math.max(0, Number(t.remaining_after_credit ?? t.remaining) || 0)) }
    ] : [
      { label: 'جمع صادرشده (تومان)', value: faMoney(t.issued || 0) },
      { label: 'جمع پرداختی (تومان)', value: faMoney(t.paid || 0) },
      { label: 'مانده کل (تومان)', value: faMoney(t.remaining || 0) }
    ],
    highlightIndex: hasCredit ? 3 : 2
  });

  y -= 2;
  y = drawPaymentBox(page, rgb, { fonts: F, y, settings: data.settings || {}, unitNumber: u.number });

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این صورت‌حساب توسط اپ مدیریت شارژ ساختمان تولید شده است — ' + dateStr.replace('تاریخ صدور: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}

// ---------------------------------------------------------------------------
// PUBLIC: yearly building report (گزارش سالانه)
// ---------------------------------------------------------------------------
export async function buildYearReportPdf({ lib, fontkit, fonts, data }) {
  const j2 = data.jalali;
  const { doc, fonts: F, rgb } = await newDoc(lib, fontkit, fonts);
  let page = doc.addPage([A4.w, A4.h]);

  const dateStr = 'تاریخ گزارش: ' + jalaliDateStr(data.generated_at, j2);
  let y = drawBand(page, rgb, {
    fonts: F,
    buildingName: data.building_name || 'ساختمان من',
    subtitle: data.address || '',
    title: `گزارش سالانه شارژ — سال ${faDigits(data.jy)}`,
    dateStr
  });

  // --- monthly summary table
  y -= 20;
  drawRTL(page, 'خلاصه ماهانه', { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
  y -= 18;

  const months = data.series || [];
  const totalIssued = months.reduce((s, m) => s + m.issued, 0);
  const totalCollected = months.reduce((s, m) => s + m.collected, 0);

  const monthCols = [
    { title: 'ماه', w: 90, align: 'center', render: r => periodLabel(r.period) },
    { title: 'صادرشده (تومان)', w: 100, align: 'center', render: r => faMoney(r.issued) },
    { title: 'وصول‌شده', w: 100, align: 'center', render: r => faMoney(r.collected) },
    { title: 'مانده', w: 100, align: 'center', render: r => faMoney(r.issued - r.collected) },
    { title: 'درصد وصول', w: 70, align: 'center', render: r => (r.issued > 0 ? faDigits(Math.round((r.collected / r.issued) * 100)) + '٪' : '—') }
  ];
  const monthRows = months.map(m => ({ ...m }));
  let res = drawTable(page, rgb, {
    fonts: F, y, columns: monthCols, rows: monthRows, bottomLimit: M + 330,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = res.y; page = res.page;

  // totals row for months
  const rowH = 21;
  rect(page, rgb, { x: M, y: y - rowH, w: A4.w - 2 * M, h: rowH, color: C.accentSoft, border: C.line });
  const mCols2 = [
    { t: 'جمع کل', w: 90 }, { t: faMoney(totalIssued), w: 100 }, { t: faMoney(totalCollected), w: 100 },
    { t: faMoney(totalIssued - totalCollected), w: 100 },
    { t: totalIssued > 0 ? faDigits(Math.round((totalCollected / totalIssued) * 100)) + '٪' : '—', w: 70 }
  ];
  let right = A4.w - M;
  for (const c of mCols2) {
    const wScaled = c.w * (A4.w - 2 * M) / 460;
    drawRTL(page, c.t, { rgb, x: right - wScaled / 2, y: y - rowH + 6.5, size: 9, font: F.bold, color: C.accent, align: 'center', maxWidth: wScaled - 8 });
    right -= wScaled;
  }
  y -= rowH + 22;

  // --- per-unit table
  drawRTL(page, 'وضعیت واحدها', { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
  y -= 18;

  const unitCols = [
    { title: 'واحد', w: 46, align: 'center', render: r => faDigits(stripUnitWord(r.number)) },
    { title: 'ساکن', w: 96, render: r => r.resident_name || '—' },
    { title: 'صادرشده (تومان)', w: 90, align: 'center', render: r => faMoney(r.issued) },
    { title: 'پرداختی', w: 90, align: 'center', render: r => faMoney(r.paid) },
    { title: 'مانده', w: 90, align: 'center', render: r => faMoney(Math.max(0, r.issued - r.paid)) },
    // v2.21.0 — اعتبار اضافه‌پرداخت واحد (پیش‌پرداخت ماه‌های بعد)
    { title: 'اعتبار', w: 74, align: 'center', render: r => (r.credit > 0 ? faMoney(r.credit) : '—') },
    { title: 'وضعیت', w: 64, align: 'center',
      render: r => (r.issued - r.paid) <= 0 ? 'تسویه‌شده' : 'بدهکار',
      color: r => (r.issued - r.paid) <= 0 ? C.green : C.red }
  ];
  const unitRows = (data.by_unit || []).slice();
  res = drawTable(page, rgb, {
    fonts: F, y, columns: unitCols, rows: unitRows, bottomLimit: M + 110, rowH: 20,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = res.y; page = res.page;

  // unit totals
  const uIssued = unitRows.reduce((s, r) => s + (r.issued || 0), 0);
  const uPaid = unitRows.reduce((s, r) => s + (r.paid || 0), 0);
  const uCredit = unitRows.reduce((s, r) => s + (r.credit || 0), 0);
  rect(page, rgb, { x: M, y: y - rowH, w: A4.w - 2 * M, h: rowH, color: C.accentSoft, border: C.line });
  const uCols2 = [
    { t: 'جمع کل', w: 46 }, { t: '', w: 96 }, { t: faMoney(uIssued), w: 90 },
    { t: faMoney(uPaid), w: 90 }, { t: faMoney(uIssued - uPaid), w: 90 },
    { t: uCredit > 0 ? faMoney(uCredit) : '', w: 74 }, { t: '', w: 64 }
  ];
  right = A4.w - M;
  for (const c of uCols2) {
    const wScaled = c.w * (A4.w - 2 * M) / 490;
    if (c.t) drawRTL(page, c.t, { rgb, x: right - wScaled / 2, y: y - rowH + 6.5, size: 9, font: F.bold, color: C.accent, align: 'center', maxWidth: wScaled - 8 });
    right -= wScaled;
  }

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این گزارش توسط اپ مدیریت شارژ ساختمان تولید شده است — ' + dateStr.replace('تاریخ گزارش: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}

// ---------------------------------------------------------------------------
// PUBLIC (v2.12.0): monthly all-units report (گزارش ماهیانه همه واحدها)
// Per-unit aggregation of one month + payment notes, with long-note safety
// (truncated column cell + fully wrapped notes section that pages itself).
// ---------------------------------------------------------------------------
export async function buildMonthlyReportPdf({ lib, fontkit, fonts, data }) {
  const j2 = data.jalali;
  const { doc, fonts: F, rgb } = await newDoc(lib, fontkit, fonts);
  let page = doc.addPage([A4.w, A4.h]);

  const dateStr = 'تاریخ گزارش: ' + jalaliDateStr(data.generated_at, j2);
  let y = drawBand(page, rgb, {
    fonts: F,
    buildingName: data.building_name || 'ساختمان من',
    subtitle: data.address || '',
    title: `گزارش ماهانه شارژ — ${periodLabel(data.period)}`,
    dateStr
  });

  const t = data.totals || { issued: 0, collected: 0, remaining: 0, credit_total: 0 };
  y -= 18;
  // v2.21.0 — کاشی «اعتبار اضافه‌پرداخت» فقط وقتی اعتباری در کار است
  const hasCredit = Number(t.credit_total) > 0;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: hasCredit ? [
      { label: 'صادرشده ماه (تومان)', value: faMoney(t.issued || 0) },
      { label: 'وصول‌شده', value: faMoney(t.collected || 0) },
      { label: 'مانده', value: faMoney(t.remaining || 0) },
      { label: 'اعتبار واحدها (تومان)', value: faMoney(t.credit_total || 0) },
      { label: 'درصد وصول', value: t.issued > 0 ? faDigits(Math.round((t.collected / t.issued) * 100)) + '٪' : '—' }
    ] : [
      { label: 'صادرشده ماه (تومان)', value: faMoney(t.issued || 0) },
      { label: 'وصول‌شده', value: faMoney(t.collected || 0) },
      { label: 'مانده', value: faMoney(t.remaining || 0) },
      { label: 'درصد وصول', value: t.issued > 0 ? faDigits(Math.round((t.collected / t.issued) * 100)) + '٪' : '—' }
    ],
    highlightIndex: 2
  });

  // --- per-unit table
  drawRTL(page, 'وضعیت واحدها در ' + periodLabel(data.period), { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
  y -= 18;

  const unitCols = [
    { title: 'واحد', w: 42, align: 'center', render: r => faDigits(stripUnitWord(r.number)) },
    { title: 'ساکن', w: 80, render: r => r.resident_name || '—' },
    { title: 'اقلام', w: 34, align: 'center', render: r => faDigits(r.items || 0) },
    { title: 'صادرشده (تومان)', w: 76, align: 'center', render: r => faMoney(r.issued || 0) },
    { title: 'پرداختی', w: 76, align: 'center', render: r => faMoney(r.paid || 0) },
    { title: 'مانده', w: 76, align: 'center', render: r => faMoney(Math.max(0, (r.issued || 0) - (r.paid || 0))) },
    // v2.21.0 — اعتبار اضافه‌پرداخت واحد
    { title: 'اعتبار', w: 72, align: 'center', render: r => (r.credit > 0 ? faMoney(r.credit) : '—') },
    { title: 'وضعیت', w: 56, align: 'center',
      render: r => !(r.issued > 0) ? 'قلمی ندارد' : ((r.issued - r.paid) <= 0 ? 'تسویه‌شده' : 'بدهکار'),
      color: r => !(r.issued > 0) ? C.muted : ((r.issued - r.paid) <= 0 ? C.green : C.red) },
    // یادداشت‌های همان واحد (چند قلم با « | » جدا می‌شود) — متن بلند کوتاه می‌شود
    { title: 'یادداشت', w: 92, render: r => (r.notes || []).map(n => n.note).join(' | ') }
  ];
  const unitRows = (data.by_unit || []).slice();
  const bottom = M + 60; // below the table only the (self-paging) notes section lives
  let res = drawTable(page, rgb, {
    fonts: F, y, columns: unitCols, rows: unitRows, bottomLimit: bottom, rowH: 20,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = res.y; page = res.page;

  // unit totals row
  const rowH = 20;
  const uIssued = unitRows.reduce((s, r) => s + (r.issued || 0), 0);
  const uPaid = unitRows.reduce((s, r) => s + (r.paid || 0), 0);
  const uCredit = unitRows.reduce((s, r) => s + (r.credit || 0), 0);
  rect(page, rgb, { x: M, y: y - rowH, w: A4.w - 2 * M, h: rowH, color: C.accentSoft, border: C.line });
  const uCols2 = [
    { t: 'جمع کل', w: 42 }, { t: '', w: 80 }, { t: '', w: 34 },
    { t: faMoney(uIssued), w: 76 }, { t: faMoney(uPaid), w: 76 },
    { t: faMoney(Math.max(0, uIssued - uPaid)), w: 76 },
    { t: uCredit > 0 ? faMoney(uCredit) : '', w: 72 },
    { t: '', w: 56 }, { t: '', w: 92 }
  ];
  let right = A4.w - M;
  const scaleW = (A4.w - 2 * M) / unitCols.reduce((s, c) => s + c.w, 0);
  for (const c of uCols2) {
    const wScaled = c.w * scaleW;
    if (c.t) drawRTL(page, c.t, { rgb, x: right - wScaled / 2, y: y - rowH + 6.5, size: 9, font: F.bold, color: C.accent, align: 'center', maxWidth: wScaled - 8 });
    right -= wScaled;
  }
  y -= rowH + 16;

  // --- full notes section (wrapped, self-paging)
  const noteItems = [];
  for (const r of unitRows) {
    for (const n of (r.notes || [])) {
      noteItems.push({ unit: r.number, description: n.description, note: n.note });
    }
  }
  if (noteItems.length) {
    const ns = drawNotesSection(page, rgb, {
      fonts: F, y, bottom: M + 40, notes: noteItems,
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = ns.y; page = ns.page;
  }

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این گزارش توسط اپ مدیریت شارژ ساختمان تولید شده است — ' + dateStr.replace('تاریخ گزارش: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}

// ---------------------------------------------------------------------------
// PUBLIC (v2.13.0): گزارش عملکرد مدیر ساختمان
// کارهای ثبت‌شده + هزینهٔ آن‌ها (کسر از صندوق) + نمودار ماهانه + تفکیک دسته +
// هزینه‌های مشترک — همهٔ متن‌های بلند با wrapRTL/«…» مدیریت می‌شوند.
// ---------------------------------------------------------------------------

// نمودار میله‌ای دوقلوی ماهانه (RTL: فروردین سمت راست) — میلهٔ «هزینه کارها»
// و «هزینه‌های مشترک» هر ماه سال
function drawDualBarChart(page, rgb, { fonts, y, months, labelA, labelB, plotH = 92 }) {
  const width = A4.w - 2 * M;
  const max = Math.max(1, ...months.map(m => Math.max(m.cost || 0, m.expenses || 0)));

  // legend (RTL از راست)
  let lx = A4.w - M;
  rect(page, rgb, { x: lx - 8, y: y - 8, w: 8, h: 8, color: C.accent });
  lx -= 12;
  let w = drawRTL(page, labelA, { rgb, x: lx, y: y - 9, size: 7.5, font: fonts.regular, color: C.ink });
  lx -= w + 14;
  rect(page, rgb, { x: lx - 8, y: y - 8, w: 8, h: 8, color: C.amber });
  lx -= 12;
  drawRTL(page, labelB, { rgb, x: lx, y: y - 9, size: 7.5, font: fonts.regular, color: C.ink });
  y -= 14;

  const baseline = y - plotH;
  // خطوط راهنما (نصف و سقف) + برچسب سقف
  for (const f of [0.5, 1]) {
    line(page, rgb, { x1: M, y1: baseline + plotH * f, x2: A4.w - M, y2: baseline + plotH * f, color: C.zebra, thickness: 0.6 });
  }
  drawRTL(page, faMoney(max), { rgb, x: M + 2, y: baseline + plotH - 2, size: 6, font: fonts.regular, color: C.muted, align: 'left' });

  const groupW = width / 12;
  const barW = Math.min(13, groupW * 0.3);
  const gap = 3;
  months.forEach((m, i) => {
    const cx = A4.w - M - (i + 0.5) * groupW; // RTL: ماه ۱ سمت راست
    const hA = m.cost ? Math.max(1.5, (m.cost / max) * plotH) : 0;
    const hB = m.expenses ? Math.max(1.5, (m.expenses / max) * plotH) : 0;
    if (hA) rect(page, rgb, { x: cx + gap / 2, y: baseline, w: barW, h: hA, color: C.accent });
    if (hB) rect(page, rgb, { x: cx - gap / 2 - barW, y: baseline, w: barW, h: hB, color: C.amber });
    drawRTL(page, faDigits(i + 1), {
      rgb, x: cx, y: baseline - 4, size: 6.5, font: fonts.regular,
      color: C.muted, align: 'center'
    });
  });
  line(page, rgb, { x1: M, y1: baseline, x2: A4.w - M, y2: baseline, color: C.line, thickness: 1 });
  return baseline - 14;
}

export async function buildPerformanceReportPdf({ lib, fontkit, fonts, data }) {
  const j2 = data.jalali;
  const { doc, fonts: F, rgb } = await newDoc(lib, fontkit, fonts);
  let page = doc.addPage([A4.w, A4.h]);

  const dateStr = 'تاریخ گزارش: ' + jalaliDateStr(data.generated_at, j2);
  let y = drawBand(page, rgb, {
    fonts: F,
    buildingName: data.building_name || 'ساختمان من',
    subtitle: data.address || '',
    title: `گزارش عملکرد مدیر ساختمان — سال ${faDigits(data.jy)}`,
    dateStr
  });

  const fund = data.fund || {};
  // v2.14.1 — موجودی اولیهٔ صندوق (پول نزد مدیر قبلی) در صورت ثبت، خودش را
  // به‌عنوان کاشی جدا نشان می‌دهد تا فرمول مانده برای ساکنین شفاف بماند
  const opening = Math.abs(Number((data.fund_opening && data.fund_opening.amount) || 0)) > 0
    ? Number(data.fund_opening.amount) : 0;
  y -= 18;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: opening
      ? [
          { label: 'موجودی اولیه (تومان)', value: faMoney(opening) },
          { label: 'وصول‌شده از ساکنین', value: faMoney(fund.collected || 0) },
          { label: 'هزینه‌های مشترک', value: faMoney(fund.expenses || 0) },
          { label: 'هزینه کارهای ثبت‌شده', value: faMoney(fund.tasks_cost || 0) },
          { label: 'مانده صندوق (کل)', value: faMoney((data.fund_all && data.fund_all.balance) != null ? data.fund_all.balance : fund.balance || 0) }
        ]
      : [
          { label: 'وصول‌شده از ساکنین (تومان)', value: faMoney(fund.collected || 0) },
          { label: 'هزینه‌های مشترک', value: faMoney(fund.expenses || 0) },
          { label: 'هزینه کارهای ثبت‌شده', value: faMoney(fund.tasks_cost || 0) },
          { label: 'مانده صندوق ساختمان', value: faMoney(fund.balance || 0) }
        ],
    highlightIndex: opening ? 4 : 3
  });
  drawRTL(page, opening
    ? 'مانده صندوق (کل) = موجودی اولیه + پول وصول‌شده از ساکنین منهای هزینه‌های مشترک و هزینهٔ کارهای ثبت‌شدهٔ مدیر'
    : 'مانده صندوق = پول وصول‌شده از ساکنین (شارژ و سهم هزینه‌ها) منهای هزینه‌های مشترک و هزینهٔ کارهای ثبت‌شدهٔ مدیر', {
    rgb, x: A4.w / 2, y: y + 2, size: 7, font: F.regular, color: C.muted, align: 'center', maxWidth: A4.w - 2 * M
  });
  y -= 14;

  // --- نمودار ماهانه
  drawRTL(page, 'روند ماهانه هزینه‌ها', { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
  y -= 20;
  y = drawDualBarChart(page, rgb, {
    fonts: F, y, months: data.months || [],
    labelA: 'هزینه کارها', labelB: 'هزینه‌های مشترک'
  });
  y -= 8;

  // --- تفکیک دسته
  const cats = (data.categories || []).filter(c => c.count > 0);
  if (cats.length) {
    drawRTL(page, 'هزینه کارها به تفکیک دسته', { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
    y -= 18;
    const catCols = [
      { title: 'دسته', w: 130, render: r => r.category },
      { title: 'تعداد کار', w: 70, align: 'center', render: r => faDigits(r.count) },
      { title: 'هزینه (تومان)', w: 100, align: 'center', render: r => faMoney(r.cost) }
    ];
    const res = drawTable(page, rgb, {
      fonts: F, y, columns: catCols, rows: cats, bottomLimit: M + 200, rowH: 19,
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = res.y; page = res.page;
    const tCost = cats.reduce((s, c) => s + c.cost, 0);
    const tCount = cats.reduce((s, c) => s + c.count, 0);
    rect(page, rgb, { x: M, y: y - 19, w: A4.w - 2 * M, h: 19, color: C.accentSoft, border: C.line });
    drawRTL(page, 'جمع', { rgb, x: A4.w - M - 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, maxWidth: 120 });
    drawRTL(page, faDigits(tCount), { rgb, x: A4.w - M - 130 - (70 * (A4.w - 2 * M) / 300) / 2, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, align: 'center' });
    drawRTL(page, faMoney(tCost), { rgb, x: M + 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, align: 'left' });
    y -= 33;
  }

  // --- جدول کارها
  drawRTL(page, `کارهای ثبت‌شده (${faDigits((data.totals && data.totals.tasks) || 0)} کار)`, {
    rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent
  });
  y -= 18;
  const taskCols = [
    { title: '#', w: 22, align: 'center', render: (_r, i) => faDigits(i + 1) },
    { title: 'تاریخ', w: 62, align: 'center', render: r => jalaliDateStr(r.done_at, j2) },
    { title: 'عنوان کار', w: 168, render: r => String(r.title || '') },
    { title: 'دسته', w: 60, align: 'center', render: r => r.category || 'سایر' },
    { title: 'هزینه (تومان)', w: 72, align: 'center', render: r => (r.cost ? faMoney(r.cost) : '—') },
    { title: 'مدارک', w: 36, align: 'center', render: r => r.files_count ? faDigits(r.files_count) : '—' }
  ];
  const tRes = drawTable(page, rgb, {
    fonts: F, y, columns: taskCols, rows: (data.tasks || []), bottomLimit: M + 60, rowH: 20,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = tRes.y; page = tRes.page;
  if (!(data.tasks || []).length) {
    drawRTL(page, 'در این سال کاری ثبت نشده است.', {
      rgb, x: A4.w / 2, y: y - 24, size: 9.5, font: F.regular, color: C.muted, align: 'center'
    });
    y -= 36;
  }

  // --- توضیحات بلند کارها (خودکار صفحه‌بندی می‌شود؛ متن کامل چندسطری)
  const descItems = (data.tasks || [])
    .filter(t => String(t.description || '').trim())
    .map(t => ({
      head: `${jalaliDateStr(t.done_at, j2)} — ${String(t.title || '')}`,
      note: String(t.description).trim()
    }));
  if (descItems.length) {
    const ns = drawNotesSection(page, rgb, {
      fonts: F, y, bottom: M + 40, notes: descItems, title: 'توضیحات کارها',
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = ns.y; page = ns.page;
  }

  // --- هزینه‌های مشترک ثبت‌شده
  const exps = (data.expenses || []);
  if (exps.length) {
    if (y - 60 < M) { page = doc.addPage([A4.w, A4.h]); y = A4.h - M; }
    drawRTL(page, 'هزینه‌های مشترک ثبت‌شده (بخش ثبت هزینه‌ها)', {
      rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent
    });
    y -= 18;
    const expCols = [
      { title: 'ماه', w: 70, align: 'center', render: r => r.period ? periodLabel(r.period) : '—' },
      { title: 'عنوان', w: 180, render: r => String(r.title || '') },
      { title: 'دسته', w: 70, align: 'center', render: r => r.category || '—' },
      { title: 'مبلغ (تومان)', w: 80, align: 'center', render: r => faMoney(r.amount) }
    ];
    const eRes = drawTable(page, rgb, {
      fonts: F, y, columns: expCols, rows: exps, bottomLimit: M + 40, rowH: 19,
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = eRes.y; page = eRes.page;
    const expTotal = exps.reduce((s, e) => s + (e.amount || 0), 0);
    rect(page, rgb, { x: M, y: y - 19, w: A4.w - 2 * M, h: 19, color: C.accentSoft, border: C.line });
    drawRTL(page, 'جمع هزینه‌های مشترک', { rgb, x: A4.w - M - 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, maxWidth: 200 });
    drawRTL(page, faMoney(expTotal), { rgb, x: M + 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, align: 'left' });
  }

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این گزارش توسط اپ مدیریت شارژ ساختمان تولید شده است — ' + dateStr.replace('تاریخ گزارش: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}

// ---------------------------------------------------------------------------
// v2.15.0 — گزارش «کارهای مدیر ساختمان»: نسخهٔ متمرکز روی کارها برای ساکنین.
// همه‌جا متن‌ها maxWidth+shrink دارند (ضد سرریز/جابجایی) و جدول خودکار صفحه‌بندی
// می‌شود؛ فهرست مدارک پیوست هم با نام فایل‌ها می‌آید.
// ---------------------------------------------------------------------------
export async function buildTasksReportPdf({ lib, fontkit, fonts, data }) {
  const j2 = data.jalali;
  const { doc, fonts: F, rgb } = await newDoc(lib, fontkit, fonts);
  let page = doc.addPage([A4.w, A4.h]);

  const dateStr = 'تاریخ گزارش: ' + jalaliDateStr(data.generated_at, j2);
  let y = drawBand(page, rgb, {
    fonts: F,
    buildingName: data.building_name || 'ساختمان من',
    subtitle: data.address || '',
    title: `گزارش کارهای مدیر ساختمان — سال ${faDigits(data.jy)}`,
    dateStr
  });

  const tasks = data.tasks || [];
  const totalCost = (data.totals && data.totals.cost) != null
    ? Number(data.totals.cost)
    : tasks.reduce((s, t) => s + (t.cost || 0), 0);
  const fundAll = data.fund_all || {};
  const filesCount = tasks.reduce((s, t) => s + ((t.files || []).length), 0);

  y -= 18;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: [
      { label: 'تعداد کارهای این سال', value: faDigits(tasks.length) },
      { label: 'هزینهٔ کارهای این سال (تومان)', value: faMoney(totalCost) },
      { label: 'مدرک پیوست‌شده', value: faDigits(filesCount) },
      { label: 'مانده صندوق (کل)', value: faMoney(fundAll.balance != null ? fundAll.balance : 0) }
    ],
    highlightIndex: 3
  });
  drawRTL(page,
    'مانده صندوق (کل) = موجودی اولیه + پول وصول‌شده از ساکنین منهای هزینه‌های مشترک و هزینهٔ کارهای ثبت‌شدهٔ مدیر', {
    rgb, x: A4.w / 2, y: y + 2, size: 7, font: F.regular, color: C.muted, align: 'center', maxWidth: A4.w - 2 * M
  });
  y -= 14;

  // --- جدول کارها
  drawRTL(page, `فهرست کارهای انجام‌شده (${faDigits(tasks.length)} کار)`, {
    rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent
  });
  y -= 18;
  const taskCols = [
    { title: '#', w: 22, align: 'center', render: (_r, i) => faDigits(i + 1) },
    { title: 'تاریخ', w: 62, align: 'center', render: r => jalaliDateStr(r.done_at, j2) },
    { title: 'عنوان کار', w: 170, render: r => String(r.title || '') },
    { title: 'دسته', w: 60, align: 'center', render: r => r.category || 'سایر' },
    { title: 'هزینه (تومان)', w: 74, align: 'center', render: r => (r.cost ? faMoney(r.cost) : '—') },
    { title: 'مدارک', w: 36, align: 'center', render: r => ((r.files || []).length ? faDigits(r.files.length) : '—') }
  ];
  const tRes = drawTable(page, rgb, {
    fonts: F, y, columns: taskCols, rows: tasks, bottomLimit: M + 60, rowH: 20,
    onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
  });
  y = tRes.y; page = tRes.page;
  if (!tasks.length) {
    drawRTL(page, 'در این سال کاری ثبت نشده است.', {
      rgb, x: A4.w / 2, y: y - 24, size: 9.5, font: F.regular, color: C.muted, align: 'center'
    });
    y -= 36;
  } else {
    const tCost = tasks.reduce((s, t) => s + (t.cost || 0), 0);
    rect(page, rgb, { x: M, y: y - 19, w: A4.w - 2 * M, h: 19, color: C.accentSoft, border: C.line });
    drawRTL(page, 'جمع هزینهٔ کارها', { rgb, x: A4.w - M - 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, maxWidth: 160 });
    drawRTL(page, faMoney(tCost), { rgb, x: M + 6, y: y - 19 + 5.5, size: 9, font: F.bold, color: C.accent, align: 'left' });
    y -= 33;
  }

  // --- توضیحات بلند کارها (خودکار صفحه‌بندی می‌شود)
  const descItems = tasks
    .filter(t => String(t.description || '').trim())
    .map(t => ({
      head: `${jalaliDateStr(t.done_at, j2)} — ${String(t.title || '')}`,
      note: String(t.description).trim()
    }));
  if (descItems.length) {
    const ns = drawNotesSection(page, rgb, {
      fonts: F, y, bottom: M + 40, notes: descItems, title: 'توضیحات کارها',
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = ns.y; page = ns.page;
  }

  // --- فهرست مدارک پیوست هر کار (نام فایل‌ها)
  const fileItems = tasks
    .filter(t => (t.files || []).length)
    .map(t => ({
      head: `${jalaliDateStr(t.done_at, j2)} — ${String(t.title || '')}`,
      note: t.files.map(f => String(f.name || 'مدرک')).join('، ')
    }));
  if (fileItems.length) {
    const ns = drawNotesSection(page, rgb, {
      fonts: F, y, bottom: M + 40, notes: fileItems, title: 'مدارک پیوست کارها',
      onPage: () => { page = doc.addPage([A4.w, A4.h]); return page; }
    });
    y = ns.y; page = ns.page;
  }

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این گزارش برای شفافیت ساکنین تولید شده است — ' + dateStr.replace('تاریخ گزارش: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}
