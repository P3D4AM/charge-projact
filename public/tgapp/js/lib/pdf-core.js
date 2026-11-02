// PDF builders (صورت‌حساب + گزارش سالانه) — layout core with injected dependencies.
// Runs in three environments:
//   - Cloudflare Worker: src/pdf.js injects pdf-lib + fontkit (bundled by wrangler)
//   - Node tests: scripts/test-pdf.mjs imports pdf-lib + fontkit directly
//   - Browser demo: public/js/pdf-client.js loads pdf-lib UMD from CDN and injects it
import { shapeForPdf, faMoney, faDigits } from './reshaper.js';
import { periodLabel } from '../jalali.js';

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
function drawRTL(page, text, { x, y, size, font, color, rgb, align = 'right', maxWidth = 0 }) {
  let shaped = shapeForPdf(text);
  let w = font.widthOfTextAtSize(shaped, size);
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
  const dx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  page.drawText(shaped, { x: dx, y, size, font, color: rgbOf(rgb, color) });
  return w;
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
// ---------------------------------------------------------------------------
function drawBand(page, rgb, { fonts, buildingName, subtitle, title, dateStr }) {
  const bh = 68;
  const top = A4.h - M;
  const bw = A4.w - 2 * M;
  rect(page, rgb, { x: M, y: top - bh, w: bw, h: bh, color: C.accent });
  // v2.11.5: truncation guards so a long building name / title can never
  // collide with the opposite side of the band (both truncate with «…»)
  // right: building name + subtitle
  drawRTL(page, buildingName, { rgb, x: A4.w - M - 16, y: top - 30, size: 15, font: fonts.bold, color: C.white, maxWidth: bw * 0.56 });
  if (subtitle) {
    drawRTL(page, subtitle, { rgb, x: A4.w - M - 16, y: top - 46, size: 8.5, font: fonts.regular, color: C.white, maxWidth: bw * 0.56 });
  }
  // left: document title + date
  drawRTL(page, title, { rgb, x: M + 16, y: top - 30, size: 12.5, font: fonts.bold, color: C.white, align: 'left', maxWidth: bw * 0.38 });
  drawRTL(page, dateStr, { rgb, x: M + 16, y: top - 46, size: 8.5, font: fonts.regular, color: C.white, align: 'left', maxWidth: bw * 0.38 });
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
      font: fonts.regular, color: hi ? C.white : C.muted
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
  // v2.11.5 fix: center-aligned cells were anchored at (right edge − 6px) and
  // then centered AROUND that x — pushing roughly half the text outside the
  // column into its left/right neighbour (the reported «بیرون زدگی»).
  // The anchor for centered text must be the column's own CENTER.
  const anchorX = (i, c) => (c.align === 'center' ? colX(i) - c.w / 2 : colX(i) - 6);

  const drawHeader = (yy) => {
    rect(page, rgb, { x: M, y: yy - headerH, w: width, h: headerH, color: C.accentSoft, border: C.line });
    cols.forEach((c, i) => {
      drawRTL(page, c.title, {
        rgb, x: anchorX(i, c), y: yy - headerH + 8, size: 8.5, font: fonts.bold,
        color: C.accent, align: c.align === 'center' ? 'center' : 'right', maxWidth: c.w - 10
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
        rgb, x: anchorX(i, c), y: cy - rowH + 6.5, size: 9,
        font: c.bold ? fonts.bold : fonts.regular, color,
        align: c.align === 'center' ? 'center' : 'right', maxWidth: c.w - 10
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
    { title: 'شرح', w: 150, render: r => r.description || KIND_LABEL[r.kind] || '' },
    { title: 'ماه', w: 58, align: 'center', render: r => periodLabel(r.period) },
    { title: 'مبلغ (تومان)', w: 76, align: 'center', render: r => faMoney(r.amount) },
    { title: 'پرداختی', w: 72, align: 'center', render: r => faMoney(r.paid_amount) },
    { title: 'مانده', w: 72, align: 'center', render: r => faMoney(Math.max(0, r.amount - r.paid_amount)) },
    { title: 'وضعیت', w: 62, align: 'center', render: r => (STATUS[r.status] || STATUS.unpaid).label, color: r => (STATUS[r.status] || STATUS.unpaid).color }
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

  // totals tiles
  const t = data.totals || {};
  y -= 8;
  y = drawTiles(page, rgb, {
    fonts: F, y,
    tiles: [
      { label: 'جمع صادرشده (تومان)', value: faMoney(t.issued || 0) },
      { label: 'جمع پرداختی (تومان)', value: faMoney(t.paid || 0) },
      { label: 'مانده کل (تومان)', value: faMoney(t.remaining || 0) }
    ],
    highlightIndex: 2
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

  // totals row for months (v2.11.5: same center-anchor fix as drawTable —
  // each cell is centered within its own scaled column, not at the right edge)
  const rowH = 21;
  rect(page, rgb, { x: M, y: y - rowH, w: A4.w - 2 * M, h: rowH, color: C.accentSoft, border: C.line });
  const mScale = (A4.w - 2 * M) / 460;
  const mCols2 = [
    { t: 'جمع کل', w: 90 }, { t: faMoney(totalIssued), w: 100 }, { t: faMoney(totalCollected), w: 100 },
    { t: faMoney(totalIssued - totalCollected), w: 100 },
    { t: totalIssued > 0 ? faDigits(Math.round((totalCollected / totalIssued) * 100)) + '٪' : '—', w: 70 }
  ];
  let right = A4.w - M;
  for (const c of mCols2) {
    const w = c.w * mScale;
    drawRTL(page, c.t, { rgb, x: right - w / 2, y: y - rowH + 6.5, size: 9, font: F.bold, color: C.accent, align: 'center', maxWidth: w - 8 });
    right -= w;
  }
  y -= rowH + 22;

  // --- per-unit table
  drawRTL(page, 'وضعیت واحدها', { rgb, x: A4.w - M, y: y - 12, size: 11, font: F.bold, color: C.accent });
  y -= 18;

  const unitCols = [
    { title: 'واحد', w: 46, align: 'center', render: r => faDigits(stripUnitWord(r.number)) },
    { title: 'ساکن', w: 110, render: r => r.resident_name || '—' },
    { title: 'صادرشده (تومان)', w: 90, align: 'center', render: r => faMoney(r.issued) },
    { title: 'پرداختی', w: 90, align: 'center', render: r => faMoney(r.paid) },
    { title: 'مانده', w: 90, align: 'center', render: r => faMoney(Math.max(0, r.issued - r.paid)) },
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

  // unit totals (v2.11.5: same center-anchor fix)
  const uIssued = unitRows.reduce((s, r) => s + (r.issued || 0), 0);
  const uPaid = unitRows.reduce((s, r) => s + (r.paid || 0), 0);
  rect(page, rgb, { x: M, y: y - rowH, w: A4.w - 2 * M, h: rowH, color: C.accentSoft, border: C.line });
  const uScale = (A4.w - 2 * M) / 490;
  const uCols2 = [
    { t: 'جمع کل', w: 46 }, { t: '', w: 110 }, { t: faMoney(uIssued), w: 90 },
    { t: faMoney(uPaid), w: 90 }, { t: faMoney(uIssued - uPaid), w: 90 }, { t: '', w: 64 }
  ];
  right = A4.w - M;
  for (const c of uCols2) {
    if (c.t) {
      const w = c.w * uScale;
      drawRTL(page, c.t, { rgb, x: right - w / 2, y: y - rowH + 6.5, size: 9, font: F.bold, color: C.accent, align: 'center', maxWidth: w - 8 });
    }
    right -= c.w * uScale;
  }

  drawFooter(page, rgb, {
    fonts: F,
    text: 'این گزارش توسط اپ مدیریت شارژ ساختمان تولید شده است — ' + dateStr.replace('تاریخ گزارش: ', 'تاریخ: ')
  });
  drawPageNumbers(doc, rgb, { fonts: F });

  return doc.save();
}
